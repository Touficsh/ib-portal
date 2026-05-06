/**
 * MT5 Snapshot Sync — caches live per-login numbers from the .NET MT5 bridge
 * into `trading_accounts_meta` so the portal's Summary page can aggregate
 * across hundreds of logins without fanning out live HTTP calls on every view.
 *
 * Columns populated: equity_cached, deposits_total, withdrawals_total,
 * lots_total, mt5_synced_at.
 *
 * Uses the same pattern as tradingAccountMetaSync.js:
 *   - concurrency capped (CONCURRENCY)
 *   - freshness skip: if a login's mt5_synced_at is newer than maxAgeMinutes,
 *     we skip its 3 bridge calls (acts as a cheap per-login TTL so reloading
 *     the Summary page doesn't re-hammer the bridge)
 *   - one bad login (bridge 500, timeout, etc.) logs + counts but doesn't
 *     stall the batch
 *
 * Entry points:
 *   syncForLogin(login)                    — single-login refresh
 *   syncForAgent(userId, { maxAgeMinutes }) — every MT5 login in viewer's subtree
 *
 * Source endpoints on the bridge (see backend/src/routes/mt5.js for proxy):
 *   GET /accounts/{login}       → { balance, equity, margin, ... }
 *   GET /transactions/{login}   → { totalDeposits, totalWithdrawals, transactions: [...] }
 *   GET /history/{login}?from=  → { trades: [...] }  — each trade has volume, entry
 */
import pool from '../db/pool.js';
import { bridgeRequest, Mt5PausedError } from './mt5BridgeGate.js';
import {
  getMt5VolumeDivisor as getVolumeDivisor,
  getMt5ServerTzOffsetSec as getTzOffsetSec,
  getMt5InitialLookbackMs as getInitialLookbackMs,
  getMt5EarliestDealDateMs as getEarliestDealDateMs,
} from './settingsCache.js';

const MT5_BRIDGE = process.env.MT5_BRIDGE_URL || 'http://localhost:5555';
const CONCURRENCY = 8;
const BRIDGE_TIMEOUT_MS = 8000;
const WIDE_FUTURE_MS = 1 * 365 * 24 * 60 * 60 * 1000;  // to= a bit in the future just in case

async function bridgeFetch(path) {
  // Routed through mt5BridgeGate (rate-limit, concurrency cap, kill switch,
  // in-flight dedup, 10s balance cache). Emits a latency histogram per
  // endpoint (accounts/transactions/history) for /metrics alerts. Endpoint
  // label is stripped of login id to keep Prom cardinality bounded.
  const endpointLabel = (path.match(/^\/([a-z-]+)/)?.[1]) || 'unknown';
  const start = Date.now();
  let status = 'ok';
  try {
    return await bridgeRequest(path, { signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Mt5PausedError) status = 'paused';
    else if (err.name === 'AbortError') status = 'timeout';
    else status = 'error';
    throw err;
  } finally {
    try {
      const { mt5BridgeLatency } = await import('./metrics.js');
      mt5BridgeLatency.labels(endpointLabel, status).observe((Date.now() - start) / 1000);
    } catch { /* metrics optional */ }
  }
}

/**
 * Fetch + upsert MT5 snapshot for one login. Returns
 *   { ok: true,  upserted: 1 } on success
 *   { ok: false, reason }      on failure (bridge down, login not found, etc.)
 *
 * The three bridge calls run in parallel — we don't need them serially.
 * On any individual call failure we still store what we got (e.g. if
 * /history is flaky but /accounts + /transactions worked).
 */
export async function syncForLogin(login, { volumeDivisor, overrideLookbackDays, overrideFromDate } = {}) {
  if (!login) return { ok: false, reason: 'no-login' };
  const divisor = volumeDivisor || (await getVolumeDivisor());
  const tzOffsetSec = await getTzOffsetSec();

  // Decide the effective `from` timestamp in this order:
  //   1. overrideFromDate      — admin chose an explicit start date in the UI
  //   2. overrideLookbackDays  — admin backfill endpoint (relative days back)
  //   3. cursor (MAX deal_time) — normal incremental sync
  //   4. default lookback window — first-ever sync for this login
  //
  // Then CLAMP against the global floor (settings.mt5_earliest_deal_date).
  // The floor always wins — it's the hard boundary on what we're willing
  // to store. This keeps Supabase storage + ingress bounded by policy.
  const { rows: [cursorRow] } = await pool.query(
    `SELECT MAX(deal_time) AS t FROM mt5_deal_cache WHERE login = $1`,
    [String(login)]
  );

  let fromMs;
  if (overrideFromDate) {
    const t = new Date(overrideFromDate).getTime();
    if (!Number.isFinite(t)) return { ok: false, reason: 'invalid overrideFromDate' };
    fromMs = t;
  } else if (overrideLookbackDays && overrideLookbackDays > 0) {
    fromMs = Date.now() - overrideLookbackDays * 24 * 60 * 60 * 1000;
  } else if (cursorRow?.t) {
    fromMs = new Date(cursorRow.t).getTime() - 1000;  // 1s buffer for race conditions
  } else {
    fromMs = Date.now() - (await getInitialLookbackMs());
  }

  // Enforce the global floor. Even if a caller asked for older data, we
  // never go before this date.
  const floorMs = await getEarliestDealDateMs();
  if (floorMs != null && fromMs < floorMs) {
    fromMs = floorMs;
  }
  const fromISO = encodeURIComponent(new Date(fromMs).toISOString());
  const toISO   = encodeURIComponent(new Date(Date.now() + WIDE_FUTURE_MS).toISOString());

  const [acc, tx, hist] = await Promise.allSettled([
    bridgeFetch(`/accounts/${login}`),
    // MT5 /transactions and /history require from&to or they default to ~30
    // days, which silently misses older deposits/trades on first sync.
    bridgeFetch(`/transactions/${login}?from=${fromISO}&to=${toISO}`),
    bridgeFetch(`/history/${login}?from=${fromISO}&to=${toISO}`),
  ]);

  // If every single call failed, don't touch the row — keep the stale value.
  if (acc.status === 'rejected' && tx.status === 'rejected' && hist.status === 'rejected') {
    return { ok: false, reason: acc.reason?.message || 'bridge unreachable' };
  }

  const equity = acc.status === 'fulfilled' ? toNumOrNull(acc.value?.equity) : null;
  const deposits = tx.status === 'fulfilled' ? toNumOrNull(tx.value?.totalDeposits) : null;
  const withdrawals = tx.status === 'fulfilled' ? toNumOrNull(tx.value?.totalWithdrawals) : null;

  // Collect deals to insert into mt5_deal_cache. Trade deals from /history,
  // balance deals (deposits/withdrawals) from /transactions.
  const dealRows = [];

  if (hist.status === 'fulfilled') {
    const trades = Array.isArray(hist.value?.trades) ? hist.value.trades : [];
    for (const t of trades) {
      if (!t?.dealId || !t?.time) continue;
      // Convert broker-local time to UTC by subtracting the configured
      // tzOffsetSec. Then floor-check the converted UTC time, so the floor
      // is interpreted in real UTC (consistent with the user-facing setting).
      const utcTimeMs = (Number(t.time) - tzOffsetSec) * 1000;
      if (floorMs != null && utcTimeMs < floorMs) continue;
      const entry = Number(t.entry);
      const volume = Number(t.volume) || 0;
      // Only entry=0 (open leg) contributes to "lots traded" — avoids
      // double-counting open+close. For close legs we leave lots=null.
      const lots = entry === 0 && volume > 0 ? Number((volume / divisor).toFixed(4)) : null;
      dealRows.push({
        deal_id: Number(t.dealId),
        deal_time: new Date(utcTimeMs).toISOString(),
        entry: Number.isFinite(entry) ? entry : null,
        volume,
        lots,
        commission: Number.isFinite(Number(t.commission)) ? Number(t.commission) : null,
        symbol: t.symbol || null,
        balance_type: null,
        balance_amount: null,
      });
    }
  }

  if (tx.status === 'fulfilled') {
    const txs = Array.isArray(tx.value?.transactions) ? tx.value.transactions : [];
    for (const x of txs) {
      if (!x?.dealId || !x?.time) continue;
      const utcTimeMs = (Number(x.time) - tzOffsetSec) * 1000;
      // Same floor check for balance transactions (deposits/withdrawals).
      if (floorMs != null && utcTimeMs < floorMs) continue;
      const t = String(x.type || '').toLowerCase();
      if (t !== 'deposit' && t !== 'withdrawal') continue;
      dealRows.push({
        deal_id: Number(x.dealId),
        deal_time: new Date(utcTimeMs).toISOString(),
        entry: null,
        volume: null,
        lots: null,
        commission: null,
        symbol: null,
        balance_type: t,
        balance_amount: Math.abs(Number(x.amount) || 0),
      });
    }
  }

  try {
    // Grab the MT5 group name from the bridge response — used below for both
    // the mt5_group column and product resolution via mt5_groups lookup.
    const mt5Group = acc.status === 'fulfilled' ? (acc.value?.group || null) : null;

    // If we have a group and the mt5_groups table knows which product that
    // maps to, resolve it now. This is the magic that lets trading_accounts_meta
    // self-heal from bridge data alone (no CRM call required).
    let resolvedProductSourceId = null;
    if (mt5Group) {
      const { rows: [resolved] } = await pool.query(
        `SELECT p.source_id FROM mt5_groups g
         JOIN products p ON p.id = g.product_id
         WHERE g.group_name = $1 AND g.is_active = true AND p.is_active = true
         LIMIT 1`,
        [mt5Group]
      );
      resolvedProductSourceId = resolved?.source_id || null;
    }

    // Upsert the trading_accounts_meta current-state columns. If a row doesn't
    // exist yet for this login (happens when a client has mt5_logins but
    // hasn't been through tradingAccountMetaSync), INSERT so subsequent reads
    // find the product mapping. This is the self-heal — without it, the
    // commission engine can't process deals for branches that never had their
    // meta populated via CRM.
    //
    // `client_id` self-heal: also look up the owner from clients.mt5_logins[]
    // during the upsert so the row is never stranded without an owner. This
    // closes the biggest gap in our commission pipeline — previously the CRM
    // `/trading-accounts` sync was the ONLY path that populated client_id,
    // and it had only run for ~8% of clients. Now any deal that flows through
    // the MT5 bridge also stamps the ownership link automatically.
    await pool.query(
      // Explicit ::varchar cast on $1 — it's used in two different contexts
      // (as the `login` value and as an `ANY(mt5_logins)` element) so without
      // a cast Postgres reports "inconsistent types deduced for parameter $1".
      `INSERT INTO trading_accounts_meta
          (login, client_id, equity_cached, balance_cached, mt5_group, product_source_id,
           mt5_synced_at, last_synced_at)
       VALUES (
         $1::varchar,
         (SELECT id FROM clients WHERE $1::varchar = ANY(mt5_logins) LIMIT 1),
         $2, $3, $4, $5, NOW(), NOW()
       )
       ON CONFLICT (login) DO UPDATE SET
         -- Only backfill client_id when the row doesn't have one; never clobber.
         client_id         = COALESCE(trading_accounts_meta.client_id, EXCLUDED.client_id),
         equity_cached     = COALESCE(EXCLUDED.equity_cached,     trading_accounts_meta.equity_cached),
         balance_cached    = COALESCE(EXCLUDED.balance_cached,    trading_accounts_meta.balance_cached),
         mt5_group         = COALESCE(EXCLUDED.mt5_group,         trading_accounts_meta.mt5_group),
         -- Only overwrite product_source_id when we successfully resolved
         -- from mt5_groups AND the current value is NULL. Never clobber a
         -- CRM-provided product_source_id with a fallback-derived one.
         product_source_id = COALESCE(trading_accounts_meta.product_source_id, EXCLUDED.product_source_id),
         mt5_synced_at     = NOW()`,
      [
        String(login),
        equity,
        toNumOrNull(acc.status === 'fulfilled' ? acc.value?.balance : null),
        mt5Group,
        resolvedProductSourceId,
      ]
    );

    // Bulk-insert deal rows, chunked. ON CONFLICT DO NOTHING makes re-syncs
    // idempotent (and the ON CONFLICT target is implicit — matches any unique
    // constraint, which includes the partitioned-table PK (login, deal_id,
    // deal_time) as well as the legacy (login, deal_id) shape).
    //
    // Postgres's wire protocol caps each query at 65,535 bind parameters. With
    // 10 columns per row that's a hard ceiling of ~6,500 rows per INSERT —
    // high-volume accounts have more. Chunking into 500 rows per batch
    // (5,000 params) stays well inside the limit and only adds a few
    // round-trips for large histories.
    const BATCH_SIZE = 500;
    for (let batchStart = 0; batchStart < dealRows.length; batchStart += BATCH_SIZE) {
      const batch = dealRows.slice(batchStart, batchStart + BATCH_SIZE);
      const values = [];
      const params = [String(login)];
      batch.forEach((d) => {
        const base = params.length + 1;
        values.push(`($1, $${base}, $${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8})`);
        params.push(d.deal_id, d.deal_time, d.entry, d.volume, d.lots, d.commission, d.symbol, d.balance_type, d.balance_amount);
      });
      await pool.query(
        `INSERT INTO mt5_deal_cache
           (login, deal_id, deal_time, entry, volume, lots, commission, symbol, balance_type, balance_amount)
         VALUES ${values.join(', ')}
         ON CONFLICT DO NOTHING`,
        params
      );
    }

    return { ok: true, upserted: 1, equity, deals_cached: dealRows.length };
  } catch (err) {
    return { ok: false, reason: `db: ${err.message}` };
  }
}

function toNumOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sync every MT5 login in the agent's full subtree, skipping ones refreshed
 * within `maxAgeMinutes` so repeated page opens don't re-hammer the bridge.
 *
 * Options:
 *   maxAgeMinutes  Freshness skip — don't re-hit a login synced this recently.
 *                  Default 15.
 *   onlyMissing    When true, narrows the work set to logins that have no
 *                  data yet (mt5_synced_at IS NULL OR zero rows in
 *                  mt5_deal_cache). Ignores the maxAgeMinutes threshold —
 *                  we only want to fill gaps, not refresh already-fetched
 *                  logins. Great for a "fetch missing only" admin action
 *                  that minimizes bridge load.
 *
 * Same subtree shape as tradingAccountMetaSync.syncForAgent — uses
 * linked_client_id to find sub-agents' own accounts AND referred_by_agent_id
 * to find their clients.
 */
export async function syncForAgent(userId, { maxAgeMinutes = 15, onlyMissing = false, overrideFromDate = null } = {}) {
  const start = Date.now();
  const summary = {
    logins_scanned: 0,
    logins_skipped_fresh: 0,
    logins_skipped_already_fetched: 0,
    logins_synced: 0,
    logins_failed: 0,
    mode: onlyMissing ? 'only-missing' : 'stale-refresh',
    overrideFromDate: overrideFromDate || null,
    durationMs: 0,
  };

  // Find every login under the viewer: own accounts + referred clients' accounts,
  // recursively through sub-agents.
  const { rows: logins } = await pool.query(
    `WITH RECURSIVE subtree_users AS (
       SELECT id, linked_client_id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id, u.linked_client_id
       FROM users u JOIN subtree_users s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true AND u.is_active = true
     ),
     scope_client_ids AS (
       -- Sub-agents' own client records (their own MT5 books)
       SELECT linked_client_id AS id FROM subtree_users
         WHERE linked_client_id IS NOT NULL
       UNION
       -- Clients referred by anyone in the subtree (via agent_id)
       SELECT c.id FROM clients c
         WHERE c.agent_id IN (SELECT id FROM subtree_users)
       UNION
       -- Clients referred by the linked-client of someone in the subtree (via referred_by_agent_id)
       SELECT c.id FROM clients c
         WHERE c.referred_by_agent_id IN (
           SELECT linked_client_id FROM subtree_users WHERE linked_client_id IS NOT NULL
         )
     )
     -- Union of two discovery paths:
     --   (a) trading_accounts_meta rows — the rich path, includes account_type
     --       filter so demo accounts are excluded
     --   (b) clients.mt5_logins — the fallback path for clients whose meta
     --       hasn't been populated yet. Logins here are ALREADY real-only
     --       (we fetched with ?accountType=real at ingest). This covers
     --       Paul Matar + every other branch that hasn't been through
     --       tradingAccountMetaSync yet.
     -- LEFT JOIN to trading_accounts_meta on login so we can still carry
     -- mt5_synced_at for freshness checks when meta exists.
     SELECT login, mt5_synced_at FROM (
       SELECT tam.login::text AS login, tam.mt5_synced_at
       FROM trading_accounts_meta tam
       WHERE tam.client_id IN (SELECT id FROM scope_client_ids)
         AND tam.account_type IS DISTINCT FROM 'demo'
       UNION
       SELECT ml::text AS login, tam.mt5_synced_at
       FROM clients cl
       CROSS JOIN LATERAL unnest(cl.mt5_logins) AS ml
       LEFT JOIN trading_accounts_meta tam
         ON tam.login = ml::text
        AND tam.client_id = cl.id
       WHERE cl.id IN (SELECT id FROM scope_client_ids)
         AND cl.mt5_logins IS NOT NULL
         AND array_length(cl.mt5_logins, 1) > 0
         -- If meta EXISTS and says demo, skip. If meta doesn't exist, trust
         -- the clients.mt5_logins which is real-only at fetch time.
         AND (tam.account_type IS NULL OR tam.account_type != 'demo')
     ) AS combined
     WHERE login IS NOT NULL`,
    [userId]
  );

  summary.logins_scanned = logins.length;

  let work;
  if (onlyMissing) {
    // "First-time sync" — only contact the bridge for logins whose
    // mt5_synced_at is NULL (we have never made a bridge call for them).
    //
    // Previously this also included "synced but no cached deals", which
    // caused the admin button to always show the same count even after a
    // successful sync: accounts with no trading history will never have
    // cached deals, so they'd remain in the "missing" bucket forever and
    // the button appeared to do nothing. Now we stamp mt5_synced_at on
    // every bridge call (even for empty accounts), so a first-time sync
    // drops the login out of this filter and the count correctly decreases.
    //
    // Accounts that ARE synced (even if empty) will still be re-fetched
    // by the normal stale-refresh path (the "Refresh MT5" button) using
    // the maxAgeMinutes freshness window — they just don't appear here.
    work = logins.filter(l => !l.mt5_synced_at);
    summary.logins_skipped_already_fetched = logins.length - work.length;
  } else {
    // Default: refresh logins whose last sync is older than the freshness
    // threshold. Never-synced logins are always in scope.
    const staleThreshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    work = logins.filter(l => !l.mt5_synced_at || new Date(l.mt5_synced_at) < staleThreshold);
    summary.logins_skipped_fresh = logins.length - work.length;
  }

  // Cache the volume divisor once for the whole batch
  const volumeDivisor = await getVolumeDivisor();

  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = idx++;
        if (i >= work.length) break;
        const result = await syncForLogin(work[i].login, { volumeDivisor, overrideFromDate });
        if (result.ok) summary.logins_synced++;
        else {
          summary.logins_failed++;
          console.warn('[MT5Snap] login', work[i].login, 'failed:', result.reason);
        }
      }
    })
  );

  summary.durationMs = Date.now() - start;
  console.log('[MT5Snap] agent done:', summary);
  return summary;
}
