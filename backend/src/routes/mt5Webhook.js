/**
 * MT5 real-time deal webhook — POST /api/mt5/webhook/deal
 *
 * The MT5 bridge subscribes to the broker's deal stream via DealSubscribe()
 * and POSTs every new deal to this endpoint within ~1 second of execution.
 * This is the real-time alternative to the 5-min hot-sweep polling.
 *
 * Security: shared-secret header `X-MT5-Webhook-Secret` must match the
 * portal's `MT5_WEBHOOK_SECRET` env var (same value the bridge has).
 *
 * Payload (from DealSink.PostAsync in the bridge):
 *   {
 *     dealId, login, time (unix seconds), symbol,
 *     action (0=buy, 1=sell, 2=balance, ...),
 *     entry  (0=in, 1=out, 2=inout, 3=outby),
 *     volume (uint64 — divide by mt5_volume_divisor to get lots),
 *     price, commission, profit, comment
 *   }
 *
 * What we do: idempotent INSERT into mt5_deal_cache. The commission engine
 * picks the deal up on its next cycle. We deliberately keep this endpoint
 * minimal and fast — the bridge's HTTP timeout is 5 seconds, and the deal
 * pump thread is shared across all events so any latency here serializes.
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { getMt5GateState } from '../services/mt5BridgeGate.js';
import {
  getMt5VolumeDivisor,
  getMt5ServerTzOffsetSec,
} from '../services/settingsCache.js';

const router = Router();

// ── Per-webhook commission trigger ──────────────────────────────────────
// When a deal lands via webhook we want the commission rows in the DB
// immediately — not 15 minutes later when the next scheduler cycle fires.
// We push the login onto an in-memory dedup'd Set; a single async worker
// drains the Set every WORKER_INTERVAL_MS by calling processLogin() for
// each. Bursts of deals on the same login coalesce into one DB pass.
//
// Failures are non-fatal: the standard cycle is still running on its
// configured interval (commissionEngine.startCommissionScheduler), so any
// missed login here will be caught on the next sweep.
const pendingCommissionLogins = new Set();
const WORKER_INTERVAL_MS = 1000;          // drain every 1s
const WORKER_MAX_PER_TICK = 50;           // bound burst size
let workerRunning = false;

async function drainCommissionQueue() {
  if (workerRunning) return;
  if (pendingCommissionLogins.size === 0) return;
  // Honor the kill switch — leave the queue intact while paused so we drain
  // it as soon as the admin un-pauses. Webhook receiver also drops new deals
  // while paused, so the queue stops growing.
  try {
    const gate = await getMt5GateState();
    if (gate?.paused) return;
  } catch { /* fail-open */ }
  workerRunning = true;
  try {
    // Snapshot + clear up to MAX_PER_TICK entries so new ones can accumulate
    const batch = [];
    for (const login of pendingCommissionLogins) {
      batch.push(login);
      pendingCommissionLogins.delete(login);
      if (batch.length >= WORKER_MAX_PER_TICK) break;
    }
    if (batch.length === 0) return;

    // Lazy import to avoid a circular dep (commissionEngine imports
    // mt5LoginResolver which is independent, but keeping this as a dynamic
    // import means the route file stays cheap to load at startup).
    const { processLogin } = await import('../services/commissionEngine.js');

    // Resolve each login's (client_id, product_id) from trading_accounts_meta
    // and process. Logins without a product mapping are skipped (the resolver
    // pre-pass on the next full cycle will pick them up).
    const { rows } = await pool.query(
      `SELECT tam.login,
              c.id AS client_id,
              p.id AS product_id
         FROM trading_accounts_meta tam
         JOIN clients c   ON c.id = tam.client_id
         JOIN products p  ON p.source_id = tam.product_source_id AND p.is_active = true
        WHERE tam.login = ANY($1::text[])
          AND tam.product_source_id IS NOT NULL
          AND c.agent_id IS NOT NULL
          AND tam.account_type IS DISTINCT FROM 'demo'`,
      [batch.map(String)]
    );

    // Use the same trigger config the scheduler uses
    const config = { trigger: 'on_open', volumeDivisor: 10_000 };
    try {
      const { rows: cfgRows } = await pool.query(
        `SELECT key, value FROM settings
         WHERE key IN ('commission_trigger', 'mt5_volume_divisor')`
      );
      for (const r of cfgRows) {
        if (r.key === 'commission_trigger') config.trigger = String(r.value).toLowerCase();
        if (r.key === 'mt5_volume_divisor') config.volumeDivisor = Number(r.value) || 10_000;
      }
    } catch { /* defaults */ }

    for (const r of rows) {
      try {
        await processLogin({
          login:      String(r.login),
          client_id:  r.client_id,
          product_id: r.product_id,
          config,
        });
      } catch (err) {
        console.warn('[mt5/webhook/commission-trigger] processLogin failed for',
          r.login, err.message);
      }
    }
  } finally {
    workerRunning = false;
  }
}

// Single shared worker — set up once at module load. setInterval is fine
// because drainCommissionQueue is no-op when the queue is empty.
const _commissionWorker = setInterval(() => {
  drainCommissionQueue().catch(err =>
    console.error('[mt5/webhook/commission-trigger] drain failed:', err.message)
  );
}, WORKER_INTERVAL_MS);
_commissionWorker.unref?.();   // don't hold the event loop open during shutdown

/** Test-only: force-drain the queue. */
export async function _drainCommissionQueueForTest() {
  await drainCommissionQueue();
}

/** Snapshot of the per-webhook commission trigger queue depth (for /status). */
export function getCommissionQueueDepth() {
  return pendingCommissionLogins.size;
}

// ── In-memory webhook counters ──────────────────────────────────────────
// Cheap visibility for "is the real-time deal stream actually flowing?".
// Reset on process restart — for absolute totals, query mt5_deal_cache.
//
// We keep a 60-min sliding window of timestamps so we can answer "deals in
// last N minutes" cheaply. Capped at 10k entries to bound memory.
const webhookStats = {
  total_received: 0,           // since process start
  total_inserted: 0,           // succeeded INSERT (excludes ON CONFLICT no-ops)
  total_rejected: 0,           // 401/400/etc — bad secret or malformed payload
  total_skipped_unknown: 0,    // 200 OK but login not attached to any imported client
  total_skipped_paused: 0,     // 200 OK but mt5_paused = true (kill switch)
  last_received_at: null,
  last_inserted_at: null,
  last_error: null,
  recent: [],                  // [{ts, action, login}] capped at 10k for window queries
  // Ring buffer of the last N rejected webhooks. Each entry is what an admin
  // needs to debug "why was this dropped?" — much more actionable than the
  // single `last_error` string. Capped to keep memory bounded.
  recent_errors: [],           // [{ ts, op, login, dealId, reason }] capped at RECENT_ERRORS_CAP
};
const RECENT_ERRORS_CAP = 25;
const RECENT_CAP = 10_000;

function pushRecent(action, login) {
  webhookStats.recent.push({ ts: Date.now(), action, login });
  if (webhookStats.recent.length > RECENT_CAP) {
    // Drop the oldest 1k in one shot — amortizes the trim cost
    webhookStats.recent.splice(0, webhookStats.recent.length - RECENT_CAP);
  }
}

/**
 * Record one rejected webhook in the recent_errors ring buffer.
 * `reason` is short — the kind of thing a human can read at a glance
 * (e.g. "invalid webhook secret", "dealId missing", "insert failed: ...").
 * Don't put stack traces here — keep it readable for the admin UI.
 */
function pushError(reason, { op, login, dealId } = {}) {
  webhookStats.recent_errors.push({
    ts:     new Date().toISOString(),
    op:     op    ?? null,
    login:  login ?? null,
    dealId: dealId != null ? Number(dealId) : null,
    reason,
  });
  if (webhookStats.recent_errors.length > RECENT_ERRORS_CAP) {
    webhookStats.recent_errors.splice(
      0,
      webhookStats.recent_errors.length - RECENT_ERRORS_CAP,
    );
  }
}

/**
 * Snapshot of webhook counters for admin dashboards.
 * Computes "last N minutes" buckets from the in-memory recent[] window.
 */
export function getWebhookStats() {
  const now = Date.now();
  const buckets = { last_1min: 0, last_5min: 0, last_15min: 0, last_60min: 0 };
  for (const r of webhookStats.recent) {
    const ageMs = now - r.ts;
    if (ageMs <=     60_000) buckets.last_1min++;
    if (ageMs <=    300_000) buckets.last_5min++;
    if (ageMs <=    900_000) buckets.last_15min++;
    if (ageMs <=  3_600_000) buckets.last_60min++;
  }
  return {
    total_received:        webhookStats.total_received,
    total_inserted:        webhookStats.total_inserted,
    total_rejected:        webhookStats.total_rejected,
    total_skipped_unknown: webhookStats.total_skipped_unknown,
    total_skipped_paused:  webhookStats.total_skipped_paused,
    last_received_at:      webhookStats.last_received_at,
    last_inserted_at:      webhookStats.last_inserted_at,
    last_error:            webhookStats.last_error,
    // Most-recent first — easier to read in the admin UI.
    recent_errors:         webhookStats.recent_errors.slice().reverse(),
    ...buckets,
  };
}

// Settings (volume divisor, TZ offset) come from the centralized
// services/settingsCache.js — single 30s-TTL cache, invalidated by the
// admin PATCH handler. See ARCHITECTURE.md for the rationale.

// ── Known-login filter ──────────────────────────────────────────────────
// The MT5 bridge subscribes to ALL deals on the broker's manager — including
// thousands of retail accounts that have no relationship to our imported
// agents. Storing those wastes DB rows and CPU. We maintain an in-memory
// Set of "known" logins (logins that belong to an imported client) and
// drop deals for any login NOT in the set.
//
// Refreshed every 60s. The miss case (a brand-new login getting webhooks
// before the next refresh) is acceptable — the snapshot sync will catch
// any deals from before this login appeared in the Set, on the agent's
// next manual or scheduled sync.
const knownLogins = new Set();
let knownLoginsLoadedAt = 0;
const KNOWN_LOGINS_TTL_MS = 60_000;
let knownLoginsRefreshing = null;

async function refreshKnownLogins() {
  // Coalesce concurrent refreshes — only one in flight at a time
  if (knownLoginsRefreshing) return knownLoginsRefreshing;
  knownLoginsRefreshing = (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT login::text AS login
           FROM trading_accounts_meta
          WHERE client_id IS NOT NULL`
      );
      knownLogins.clear();
      for (const r of rows) knownLogins.add(r.login);
      knownLoginsLoadedAt = Date.now();
    } catch (err) {
      console.warn('[mt5/webhook] refreshKnownLogins failed:', err.message);
    } finally {
      knownLoginsRefreshing = null;
    }
  })();
  return knownLoginsRefreshing;
}

async function isKnownLogin(login) {
  if (Date.now() - knownLoginsLoadedAt > KNOWN_LOGINS_TTL_MS) {
    await refreshKnownLogins();
  }
  return knownLogins.has(String(login));
}

/** Test-only: force the next webhook to refresh the known-login set */
export function _invalidateKnownLoginsForTest() {
  knownLoginsLoadedAt = 0;
}

router.post('/deal', async (req, res) => {
  webhookStats.total_received++;
  webhookStats.last_received_at = new Date().toISOString();

  // ── 1. Auth: shared-secret header (constant-time compare) ───────────────
  const expected = process.env.MT5_WEBHOOK_SECRET || '';
  const presented = req.get('X-MT5-Webhook-Secret') || '';
  if (!expected || presented.length !== expected.length) {
    webhookStats.total_rejected++;
    webhookStats.last_error = 'invalid webhook secret (length mismatch)';
    pushError('invalid webhook secret (length mismatch)');
    return res.status(401).json({ error: 'invalid webhook secret' });
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  if (mismatch !== 0) {
    webhookStats.total_rejected++;
    webhookStats.last_error = 'invalid webhook secret (value mismatch)';
    pushError('invalid webhook secret (value mismatch)');
    return res.status(401).json({ error: 'invalid webhook secret' });
  }

  // ── 1b. Kill switch: settings.mt5_paused ────────────────────────────────
  // The "Pause MT5" button on System Health → Pipeline flips mt5_paused.
  // When paused, both outbound bridge calls AND incoming webhook deals are
  // suspended. Cached in-process for 10s so this is essentially free.
  // Returns 200 (not 5xx) so the bridge doesn't loop on retries — we just
  // signal "received but ignored". The 5-min hot-sweep + scheduled cycle
  // will catch up missed deals once the admin un-pauses.
  try {
    const gate = await getMt5GateState();
    if (gate?.paused) {
      webhookStats.total_skipped_paused++;
      return res.status(200).json({ ok: true, skipped: 'mt5_paused' });
    }
  } catch { /* if gate state lookup fails, fail-open and continue */ }

  // ── 2. Parse + validate payload ─────────────────────────────────────────
  const p = req.body || {};
  // op = "add" | "update" | "delete" (default "add" for backward compat).
  // From bridge DealSink.OnDealAdd / OnDealUpdate / OnDealDelete.
  const op     = String(p.op || 'add').toLowerCase();
  const dealId = Number(p.dealId);
  const login  = p.login != null ? String(p.login) : null;
  const time   = Number(p.time);   // Unix seconds
  const action = Number(p.action);
  const entry  = Number(p.entry);

  if (!Number.isFinite(dealId) || dealId <= 0) {
    webhookStats.total_rejected++;
    webhookStats.last_error = 'dealId missing/invalid';
    pushError('dealId missing/invalid', { op, login });
    return res.status(400).json({ error: 'dealId required' });
  }
  if (!login || login === '0') {
    webhookStats.total_rejected++;
    webhookStats.last_error = 'login missing';
    pushError('login missing', { op, dealId });
    return res.status(400).json({ error: 'login required' });
  }
  if (!Number.isFinite(time) || time <= 0) {
    webhookStats.total_rejected++;
    webhookStats.last_error = 'time missing';
    pushError('time missing', { op, login, dealId });
    return res.status(400).json({ error: 'time required' });
  }

  // Drop deals for logins we don't care about (broker's other clients).
  // Cheap O(1) Set lookup; refreshed in the background every 60s.
  if (!(await isKnownLogin(login))) {
    webhookStats.total_skipped_unknown++;
    pushRecent(action, login);  // still count toward "last N min" — useful for "is the stream alive"
    return res.status(200).json({ ok: true, skipped: 'unknown_login' });
  }

  // Broker server's MT5 returns deal.Time() as broker-local seconds-since-epoch,
  // not UTC. Subtract the configured offset so what we store is real UTC.
  const tzOffsetSec = await getMt5ServerTzOffsetSec();
  const dealTimeIso = new Date((time - tzOffsetSec) * 1000).toISOString();
  const divisor     = await getMt5VolumeDivisor();
  const volume      = Number(p.volume) || 0;
  const commission  = Number.isFinite(Number(p.commission)) ? Number(p.commission) : null;
  const profit      = Number.isFinite(Number(p.profit))     ? Number(p.profit)     : 0;
  const symbol      = p.symbol ? String(p.symbol) : null;

  // Field shaping mirrors mt5SnapshotSync.js so the cache rows are
  // indistinguishable regardless of which path wrote them:
  //   - Trade deals (action 0/1): cache entry/volume/lots/commission/symbol;
  //     lots only on the open leg (entry === 0) to avoid double-counting.
  //   - Balance deals (action 2): cache balance_type/balance_amount, leave
  //     trade fields null. balance_type derived from sign of profit.
  //   - Other actions (credit, bonus, dividend, etc.): cache as-is with
  //     trade fields null and no balance_type.
  let entryDb        = null;
  let volumeDb       = null;
  let lotsDb         = null;
  let commissionDb   = null;
  let symbolDb       = null;
  let balanceType    = null;
  let balanceAmount  = null;

  if (action === 0 || action === 1) {
    // Trade
    entryDb      = Number.isFinite(entry) ? entry : null;
    volumeDb     = volume;
    lotsDb       = (entry === 0 && volume > 0) ? Number((volume / divisor).toFixed(4)) : null;
    commissionDb = commission;
    symbolDb     = symbol;
  } else if (action === 2) {
    // Balance — deposit (profit > 0) or withdrawal (profit < 0)
    balanceType   = profit > 0 ? 'deposit' : 'withdrawal';
    balanceAmount = Math.abs(profit);
  } else {
    // Credit / bonus / dividend / commission etc. — keep symbol if present
    symbolDb = symbol;
    commissionDb = commission;
  }

  // ── 3. Insert / update / delete based on op ─────────────────────────────
  // op="add"     — INSERT new row, NO update on conflict (preserve original
  //                fields if MT5 re-fires OnDealAdd for a duplicate)
  // op="update"  — INSERT with ON CONFLICT updating ONLY the mutable fields
  //                (commission, profit-derived balance_amount, comment).
  //                Structural fields (entry, volume, lots, deal_time) never
  //                change post-creation in MT5, so we leave them alone.
  // op="delete"  — DELETE the row outright. Phantom deals would otherwise
  //                keep affecting commission totals.
  try {
    let r;
    if (op === 'delete') {
      r = await pool.query(
        `DELETE FROM mt5_deal_cache WHERE login = $1 AND deal_id = $2`,
        [login, dealId]
      );
    } else if (op === 'update') {
      r = await pool.query(
        `INSERT INTO mt5_deal_cache
           (login, deal_id, deal_time, entry, volume, lots,
            commission, symbol, balance_type, balance_amount)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (login, deal_id) DO UPDATE SET
           commission     = EXCLUDED.commission,
           balance_amount = EXCLUDED.balance_amount`,
        [login, dealId, dealTimeIso, entryDb, volumeDb, lotsDb,
         commissionDb, symbolDb, balanceType, balanceAmount]
      );
    } else {
      // Default: op === 'add'
      r = await pool.query(
        `INSERT INTO mt5_deal_cache
           (login, deal_id, deal_time, entry, volume, lots,
            commission, symbol, balance_type, balance_amount)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [login, dealId, dealTimeIso, entryDb, volumeDb, lotsDb,
         commissionDb, symbolDb, balanceType, balanceAmount]
      );
    }
    if (r.rowCount > 0) {
      webhookStats.total_inserted++;
      webhookStats.last_inserted_at = new Date().toISOString();
      // Queue this login for an immediate commission pass (debounced by Set).
      // Skipped on duplicate inserts (ON CONFLICT DO NOTHING returned 0 rows)
      // because there's nothing new for the engine to process.
      pendingCommissionLogins.add(login);
    }
    pushRecent(action, login);
  } catch (err) {
    // Don't 5xx the bridge — log and ack. Worst case the hot-sweep
    // catches the deal in the next 5-min cycle.
    webhookStats.total_rejected++;
    webhookStats.last_error = `insert failed: ${err.message}`;
    pushError(`db ${op} failed: ${err.message}`, { op, login, dealId });
    console.error('[mt5/webhook/deal] insert failed:', err.message,
      { dealId, login, time: dealTimeIso });
    return res.status(202).json({ ok: false, error: 'insert failed (will retry via hot-sweep)' });
  }

  // ── 4. Self-heal: ensure trading_accounts_meta has a row for this login.
  // The webhook is often the FIRST time the portal sees a brand-new login —
  // before the hot-sweep gets to it. Stub the row so the commission engine's
  // resolver pre-pass can map it to a product on the next cycle. We don't
  // call the bridge from here (the webhook handler is a hot path); the
  // resolver pre-pass will do that.
  try {
    await pool.query(
      `INSERT INTO trading_accounts_meta (login, client_id, last_synced_at)
       VALUES ($1::varchar,
               (SELECT id FROM clients WHERE $1::varchar = ANY(mt5_logins) LIMIT 1),
               NOW())
       ON CONFLICT (login) DO NOTHING`,
      [login]
    );
  } catch { /* non-fatal */ }

  res.status(200).json({ ok: true, dealId });
});

export default router;
