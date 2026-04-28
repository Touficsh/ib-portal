/**
 * Commission Engine — MT5 deals → waterfall ledger writes.
 *
 * Runs on a timer (started from server.js when ENABLE_COMMISSION_ENGINE=true).
 * For every client who has (agent_id, product_id, mt5_logins), it:
 *
 *   1. Looks up the last deal_time already processed for that login
 *      (MAX(deal_time) in the commissions table, falls back to 30 days ago).
 *   2. Fetches GET /history/{login}?from=<cursor> from the MT5 bridge.
 *   3. Filters deals by the configured commission_trigger setting:
 *        - on_open    (default): entry = 0 ("In" — position opened)
 *        - on_close           : entry = 1 ("Out")
 *        - round_turn         : entry IN (0, 1) — both sides count
 *   4. For each qualifying deal, walks the agent tree up from client.agent_id
 *      and writes one commission row per ancestor that holds this product,
 *      with amount = lots × (my_rate − child_rate).  (Waterfall.)
 *   5. Inserts are ON CONFLICT (deal_id, agent_id) DO NOTHING — safe to rerun.
 *
 * Volume → lots conversion:
 *   MT5 Manager API's deal.Volume() returns uint64 in units where
 *   1 lot = `mt5_volume_divisor` units (default 10000 per standard broker
 *   config). Override via the `mt5_volume_divisor` setting if your broker
 *   uses a different volume precision.
 *
 * Exports:
 *   runCommissionSync         — single cycle; safe to call manually (admin endpoint)
 *   processLogin              — process a single MT5 login (useful for targeted replays)
 *   computeWaterfallRows      — pure function; turns one deal into N commission rows
 *   startCommissionScheduler  — begin interval-driven cycles
 *   stopCommissionScheduler   — stop the scheduler (for tests/shutdown)
 */
import pool from '../db/pool.js';
import { createNotification, isDuplicate } from './notificationService.js';

const MT5_BRIDGE = process.env.MT5_BRIDGE_URL || 'http://localhost:5555';
const DEFAULT_VOLUME_DIVISOR = 10_000;
const MAX_TREE_DEPTH = 50;  // safety cap in recursive CTE

/**
 * Fetch a setting from the `settings` table with an in-memory fallback.
 * Returns the string value (or the default) — caller handles parsing.
 */
async function getSetting(key, defaultValue) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Read current commission_trigger + volume divisor from settings.
 * Cached per-cycle by `runCommissionSync`; pass through to `processLogin`.
 */
async function loadRuntimeConfig() {
  const trigger = (await getSetting('commission_trigger', 'on_open')).toLowerCase();
  const divisorRaw = await getSetting('mt5_volume_divisor', String(DEFAULT_VOLUME_DIVISOR));
  const divisor = Number(divisorRaw) || DEFAULT_VOLUME_DIVISOR;
  const validTriggers = new Set(['on_open', 'on_close', 'round_turn']);
  return {
    trigger: validTriggers.has(trigger) ? trigger : 'on_open',
    volumeDivisor: divisor,
  };
}

/**
 * Returns true if a deal's `entry` code (0=In, 1=Out, 2=InOut) qualifies
 * for commission given the current trigger mode.
 */
function dealQualifies(entry, trigger) {
  const e = Number(entry);
  if (trigger === 'on_open')    return e === 0;
  if (trigger === 'on_close')   return e === 1;
  if (trigger === 'round_turn') return e === 0 || e === 1;
  return false;
}

/**
 * Pure function: compute the commission rows for one deal.
 * Queries the DB to resolve the ancestor chain + per-ancestor product rate.
 * Returns an array (possibly empty) of rows ready to INSERT.
 *
 * @param {object} db    — a pool or connected client (supports .query)
 * @param {object} deal  — { deal_id, client_id, mt5_login, product_id, lots, deal_time, mt5_commission }
 *
 * The optional `mt5_commission` is the |deal.commission| from MT5 for this
 * specific deal. When provided, it's used as the commission bucket ceiling
 * — this ties our engine output exactly to MT5's per-deal charge and
 * eliminates reconciliation drift. If omitted, falls back to the product's
 * configured commission_per_lot × lots (legacy behaviour, kept for tests).
 */
export async function computeWaterfallRows(db, deal) {
  const { deal_id, client_id, mt5_login, product_id, lots, deal_time,
          mt5_commission, mt5_group, symbol } = deal;

  // Resolve the direct agent for this client
  const { rows: [client] } = await db.query(
    `SELECT agent_id FROM clients WHERE id = $1`,
    [client_id]
  );
  if (!client || !client.agent_id) return [];

  // Pull the product's config (fallback values when no CRM level exists)
  const { rows: [product] } = await db.query(
    `SELECT commission_per_lot, rebate_per_lot FROM products WHERE id = $1`,
    [product_id]
  );
  const configuredCommPerLot = Number(product?.commission_per_lot || 0);

  // Walk up the tree from the direct agent. For each ancestor, attach:
  //   - agent_products.rate_per_lot (legacy single-value rate)
  //   - crm_commission_levels rows matching (product, mt5_group) where
  //     mt5_group_name = this deal's group, or group is NULL (applies to all)
  //   - override fields on the CRM row take precedence when set
  //
  // The LEFT JOINs are needed because either source may be missing. The
  // WHERE clause keeps a row if AT LEAST ONE source exists (otherwise the
  // agent doesn't hold this product and earns nothing).
  const { rows: chain } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_agent_id, 0 AS level
       FROM users
       WHERE id = $1 AND is_agent = true AND is_active = true
       UNION ALL
       SELECT u.id, u.parent_agent_id, a.level + 1
       FROM users u
       JOIN ancestors a ON u.id = a.parent_agent_id
       WHERE u.is_agent = true AND u.is_active = true AND a.level < $3
     )
     SELECT a.id AS agent_id, a.level,
            ap.rate_per_lot,
            ccl.commission_percentage AS ccl_pct,
            ccl.commission_per_lot    AS ccl_per_lot,
            ccl.override_commission_percentage AS ov_pct,
            ccl.override_commission_per_lot    AS ov_per_lot
     FROM ancestors a
     LEFT JOIN agent_products ap
       ON ap.agent_id = a.id AND ap.product_id = $2 AND ap.is_active = true
     -- Pick the CRM commission-level row for (agent, product). The CRM's
     -- mt5_group_name field is a logical CRM grouping (e.g. "All Minus Crypto")
     -- — NOT the raw MT5 account group. For now we pick the first active
     -- row per (agent, product). Per-symbol / per-mt5-group refinement is a
     -- future step that'd require matching available_symbols against the
     -- traded symbol.
     LEFT JOIN LATERAL (
       SELECT commission_percentage, commission_per_lot,
              override_commission_percentage, override_commission_per_lot
       FROM crm_commission_levels
       WHERE agent_user_id = a.id
         AND product_id = $2
         AND is_active = true
       ORDER BY
         -- Prefer CRM rows that have non-default values — avoids picking
         -- a "product-level fallback" row (pct=0, per_lot=0) over a real config.
         (commission_percentage > 0 OR commission_per_lot > 0) DESC,
         synced_at DESC
       LIMIT 1
     ) ccl ON true
     -- Include every active ancestor regardless of whether they have a rate
     -- configured. Agents missing their CRM commission levels are treated as
     -- rate = 0 (pct=0, per_lot=0), which keeps the waterfall math correct:
     -- their parent's override is computed against the 0-rate child and the
     -- missing agent simply earns $0 on the deal. Previously these agents
     -- were dropped entirely, which caused the immediate parent to under-
     -- or over-earn depending on chain shape.
     ORDER BY a.level ASC`,
    [client.agent_id, product_id, MAX_TREE_DEPTH]
  );

  // source_agent_id = bottom-most (direct) agent of the client, used for the
  // "earnings by source sub-agent" breakdown in the UI.
  const sourceAgentId = chain[0]?.agent_id || client.agent_id;

  const brokerCommission = mt5_commission != null
    ? Math.abs(Number(mt5_commission) || 0)
    : configuredCommPerLot * lots;

  // Determine which math to use. If ANY ancestor has CRM-level config, use
  // the NEW model (pct + per_lot → commission + rebate). Otherwise fall
  // back to the LEGACY bucket-filling model. Scoping this way means Paul
  // Matar agents (who have synced crm_commission_levels rows) get the new
  // math while other branches keep the old behavior until they're synced.
  const hasCrmLevels = chain.some(c => c.ccl_pct !== null && c.ccl_pct !== undefined);

  const rows = [];

  if (hasCrmLevels) {
    // ─── NEW MATH — per CRM config ─────────────────────────────────────
    // For each ancestor:
    //   effective_pct     = override if set, else synced CRM pct (else 0)
    //   effective_per_lot = override if set, else synced CRM per_lot (else 0)
    //
    // This ancestor earns the DIFFERENCE between their rates and the
    // immediately-below ancestor's rates (waterfall override semantics).
    //   commission_amount = broker_commission × (my.pct - child.pct) / 100
    //   rebate_amount     = lots × (my.per_lot - child.per_lot)
    //
    // Matches user's model: e.g. parent 100% + $10, sub 50% + $3 →
    //   sub earns: 50% × broker + $3 × lots
    //   parent earns override: (100%-50%) × broker + ($10-$3) × lots
    const resolved = chain.map(c => {
      const hasOverride = c.ov_pct != null || c.ov_per_lot != null;
      const hasCrm      = c.ccl_pct != null;  // LATERAL found a live CRM row
      const pct = Number(c.ov_pct != null ? c.ov_pct : (c.ccl_pct || 0));
      // When this agent has no active CRM commission row at all (ccl_per_lot IS
      // NULL — the LATERAL found zero matching rows), fall back to their legacy
      // agent_products.rate_per_lot as the per-lot component. This handles the
      // mixed-mode case: an agent whose parent already synced CRM levels but who
      // lost their own CRM config (e.g. Sophia after CRM removed her rates).
      // Without the fallback they'd drop to $0 the moment the chain enters NEW
      // MATH, even though a manual $2/lot override is still set locally.
      // Note: ccl_per_lot=0 (CRM explicitly set 0) is kept as 0 — we only fall
      // back when ccl_per_lot is truly absent (NULL from the LEFT JOIN).
      const per_lot = Number(
        c.ov_per_lot  != null ? c.ov_per_lot  :
        c.ccl_per_lot != null ? c.ccl_per_lot :
        (c.rate_per_lot || 0)
      );
      // rate_source records which config path produced this row's rate:
      //   'crm_override' — override columns were set in the CRM level config
      //   'crm'          — standard synced CRM commission_percentage/per_lot
      //   'fallback'     — no active CRM row; used agent_products.rate_per_lot
      const rate_source = hasOverride ? 'crm_override' : hasCrm ? 'crm' : 'fallback';
      return { agent_id: c.agent_id, level: c.level, pct, per_lot, rate_source };
    });

    for (let i = 0; i < resolved.length; i++) {
      const my = resolved[i];
      const childPct     = i === 0 ? 0 : resolved[i - 1].pct;
      const childPerLot  = i === 0 ? 0 : resolved[i - 1].per_lot;
      const pctMargin    = my.pct - childPct;
      const perLotMargin = my.per_lot - childPerLot;

      // Cascade violation (sub has higher rate than parent) shouldn't happen
      // but we defensively clamp at 0 — the parent earns nothing on those
      // components rather than negative commissions.
      const effectivePctMargin    = Math.max(0, pctMargin);
      const effectivePerLotMargin = Math.max(0, perLotMargin);

      const commissionAmount = Number((brokerCommission * effectivePctMargin / 100).toFixed(2));
      const rebateAmount     = Number((effectivePerLotMargin * lots).toFixed(2));
      const amount           = Number((commissionAmount + rebateAmount).toFixed(2));
      if (amount <= 0) continue;

      rows.push({
        deal_id, client_id, mt5_login, product_id,
        agent_id: my.agent_id,
        lots,
        rate_per_lot: Number((amount / lots).toFixed(4)),  // implied blended rate
        amount,
        commission_amount: commissionAmount,
        rebate_amount: rebateAmount,
        level: my.level,
        deal_time,
        source_agent_id: sourceAgentId,
        // Rate-source audit trail (NEW MATH)
        ccl_pct:     my.pct,
        ccl_per_lot: my.per_lot,
        rate_source: my.rate_source,
      });
    }
  } else {
    // ─── LEGACY MATH — unchanged from before (for branches not yet synced)
    // Fills commission bucket FROM BOTTOM upward. Overflow goes to rebate.
    let commissionRemaining = brokerCommission;
    for (let i = 0; i < chain.length; i++) {
      const my = chain[i];
      const myRate = Number(my.rate_per_lot || 0);
      if (!myRate) continue;  // doesn't hold product
      const childRate = i === 0 ? 0 : Number(chain[i - 1].rate_per_lot || 0);
      const margin = myRate - childRate;
      if (margin <= 0) continue;

      const amount = Number((lots * margin).toFixed(2));
      const commissionTake = Math.min(amount, Math.max(0, commissionRemaining));
      const commissionAmount = Number(commissionTake.toFixed(2));
      const rebateAmount     = Number((amount - commissionAmount).toFixed(2));
      commissionRemaining = Math.max(0, commissionRemaining - commissionTake);

      rows.push({
        deal_id, client_id, mt5_login, product_id,
        agent_id: my.agent_id,
        lots,
        rate_per_lot: margin,
        amount,
        commission_amount: commissionAmount,
        rebate_amount: rebateAmount,
        level: my.level,
        deal_time,
        source_agent_id: sourceAgentId,
        // Rate-source audit trail (LEGACY MATH — CRM columns are null)
        ccl_pct:     null,
        ccl_per_lot: null,
        rate_source: 'legacy',
      });
    }
  }
  return rows;
}

/**
 * Process one MT5 login's deals → commission rows.
 *
 * Reads from the local mt5_deal_cache (populated by mt5SnapshotSync) rather
 * than hitting the MT5 bridge directly. This:
 *   - Eliminates per-cycle bridge load (the snapshot sync is the single source)
 *   - Gives us deal.commission as authoritative input → zero reconciliation drift
 *   - Makes cycles sub-second per login (pure SQL)
 *
 * Returns { fetched, qualified, inserted, skipped, errors }.
 */
export async function processLogin({ login, client_id, product_id, config, sinceISO }) {
  const summary = { fetched: 0, qualified: 0, inserted: 0, skipped: 0, errors: 0 };

  // Cursor: last deal_time we already wrote to commissions for this login,
  // overridden by sinceISO if the caller wants to reprocess a wider window.
  let cursor = sinceISO || null;
  if (!cursor) {
    const { rows } = await pool.query(
      `SELECT MAX(deal_time) AS max_time FROM commissions WHERE mt5_login = $1`,
      [login]
    );
    cursor = rows[0]?.max_time ? new Date(rows[0].max_time).toISOString() : null;
  }

  // Resolve the login's MT5 group once per call (needed by the new math to
  // pick the right commission_levels row per agent). Null-safe — if we have
  // no meta row, mt5Group stays null and the CRM-level lookup matches the
  // "group=NULL" fallback rows.
  let mt5Group = null;
  try {
    const { rows: [metaRow] } = await pool.query(
      `SELECT mt5_group FROM trading_accounts_meta WHERE login = $1`,
      [String(login)]
    );
    mt5Group = metaRow?.mt5_group || null;
  } catch { /* non-fatal — group stays null */ }

  // Read trade deals from the cache. Balance deals (deposits/withdrawals) are
  // excluded by entry IS NOT NULL — they shouldn't generate commission rows.
  let trades;
  try {
    const { rows } = await pool.query(
      `SELECT deal_id, deal_time, entry, lots, commission, symbol
       FROM mt5_deal_cache
       WHERE login = $1
         AND entry IS NOT NULL
         AND ($2::timestamptz IS NULL OR deal_time > $2::timestamptz)
       ORDER BY deal_time`,
      [String(login), cursor]
    );
    trades = rows;
  } catch (err) {
    summary.errors++;
    return summary;
  }

  summary.fetched = trades.length;

  for (const t of trades) {
    try {
      if (!dealQualifies(t.entry, config.trigger)) { summary.skipped++; continue; }
      const lots = Number(t.lots);
      if (!Number.isFinite(lots) || lots <= 0) { summary.skipped++; continue; }

      summary.qualified++;

      const deal = {
        deal_id: Number(t.deal_id),
        client_id,
        mt5_login: login,
        product_id,
        lots,
        deal_time: t.deal_time,
        // Authoritative commission from MT5 — becomes the bucket ceiling
        mt5_commission: Number(t.commission) || 0,
        // Used by new-model commission levels to pick the right group row
        mt5_group: mt5Group,
        symbol: t.symbol || null,
      };

      const rows = await computeWaterfallRows(pool, deal);
      if (rows.length === 0) continue;

      for (const r of rows) {
        try {
          const result = await pool.query(
            // Bare ON CONFLICT DO NOTHING — Postgres matches against any
            // unique constraint on the table. Works for both:
            //   - pre-partition shape: UNIQUE (deal_id, agent_id)
            //   - post-partition shape: UNIQUE (deal_id, agent_id, deal_time)
            //   (deal_time is functionally determined by deal_id anyway, so
            //    both shapes produce identical dedup behavior in practice.)
            `INSERT INTO commissions
               (deal_id, client_id, mt5_login, product_id, agent_id,
                lots, rate_per_lot, amount, commission_amount, rebate_amount,
                level, deal_time, source_agent_id,
                ccl_pct, ccl_per_lot, rate_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [r.deal_id, r.client_id, r.mt5_login, r.product_id, r.agent_id,
             r.lots, r.rate_per_lot, r.amount, r.commission_amount, r.rebate_amount,
             r.level, r.deal_time, r.source_agent_id,
             r.ccl_pct ?? null, r.ccl_per_lot ?? null, r.rate_source ?? null]
          );
          if (result.rowCount > 0) summary.inserted++;
        } catch (rowErr) {
          summary.errors++;
        }
      }
    } catch (dealErr) {
      summary.errors++;
    }
  }
  return summary;
}

/**
 * Recompute commission rows for one agent across a date window.
 *
 * This is a targeted re-run of the commission engine's waterfall math for
 * every (login, product) pair under the given agent, scoped to deals that
 * fall within [fromDate, toDate].  It is designed for the case where an
 * admin changed rates (manually or via CRM sync) and wants to know what
 * the commissions would look like at the new rates — or to back-fill the
 * rate_source audit columns on existing rows.
 *
 * Two modes:
 *
 *   dryRun = true  (default)
 *     Re-runs the math, returns a preview of what would change.
 *     Nothing is written to the DB.
 *     Response shape per deal:
 *       { deal_id, mt5_login, product_id, agent_id, old_amount, new_amount,
 *         old_rate_source, new_rate_source, delta }
 *
 *   dryRun = false
 *     Deletes existing commission rows for the agent in the window, then
 *     re-inserts using current rates.  Uses a DB transaction so the window
 *     is never partly deleted.
 *
 * Guards:
 *   - Both fromDate and toDate are required (guards against accidentally
 *     wiping all-time history).
 *   - toDate is clamped to yesterday server-time so we never touch rows
 *     that the live engine may be writing concurrently today.
 *   - Max window: 366 days (protects against runaway recomputes).
 *
 * Returns:
 *   { agent_id, from, to, deals_scanned, rows_previewed,
 *     rows_deleted, rows_inserted, errors, dry_run, preview[] }
 */
export async function recomputeForAgent(agentId, fromDate, toDate, { dryRun = true } = {}) {
  const summary = {
    agent_id: agentId,
    from: fromDate,
    to: toDate,
    dry_run: dryRun,
    deals_scanned: 0,
    rows_previewed: 0,
    rows_deleted: 0,
    rows_inserted: 0,
    errors: 0,
    preview: [],       // populated in dry-run mode
  };

  // --- Date validation ------------------------------------------------
  const fromTs = new Date(fromDate + 'T00:00:00Z');
  const toTs   = new Date(toDate   + 'T23:59:59Z');
  if (isNaN(fromTs) || isNaN(toTs) || fromTs > toTs) {
    throw new Error('fromDate and toDate must be valid ISO dates with fromDate ≤ toDate');
  }

  // Hard cap: clamp to yesterday so we don't touch today's live engine writes
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(23, 59, 59, 999);
  const effectiveTo = toTs > yesterday ? yesterday : toTs;
  summary.to = effectiveTo.toISOString().slice(0, 10);

  // Max window: 366 days
  const windowDays = (effectiveTo - fromTs) / (1000 * 60 * 60 * 24);
  if (windowDays > 366) {
    throw new Error('Date window exceeds 366 days. Split into smaller ranges.');
  }

  // --- Load runtime config (trigger mode, volume divisor) ------------
  const config = await loadRuntimeConfig();

  // --- Find all MT5 logins under this agent's subtree ----------------
  // "Under" = clients directly assigned to the agent, or to any sub-agent.
  // We need product_id too so we can scope to product.
  const { rows: loginRows } = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM users WHERE id = $1 AND is_agent = true
       UNION ALL
       SELECT u.id FROM users u
       JOIN subtree s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true AND u.is_active = true
     )
     SELECT tam.login, tam.client_id, cl.product_id
     FROM trading_accounts_meta tam
     JOIN clients cl ON cl.id = tam.client_id
     WHERE cl.agent_id IN (SELECT id FROM subtree)
       AND tam.account_type IS DISTINCT FROM 'demo'
       AND cl.product_id IS NOT NULL`,
    [agentId]
  );

  if (loginRows.length === 0) {
    return summary;  // no logins → nothing to recompute
  }

  // --- Gather all qualifying deals in the window ---------------------
  // We pull from mt5_deal_cache and run computeWaterfallRows for each deal.
  const dealRows = await pool.query(
    `SELECT d.deal_id, d.login, d.deal_time, d.entry, d.lots, d.commission, d.symbol
     FROM mt5_deal_cache d
     WHERE d.login = ANY($1::text[])
       AND d.entry IS NOT NULL
       AND d.deal_time >= $2::timestamptz
       AND d.deal_time <= $3::timestamptz
     ORDER BY d.deal_time`,
    [
      loginRows.map(l => String(l.login)),
      fromTs.toISOString(),
      effectiveTo.toISOString(),
    ]
  );

  // Build a quick map: login → { client_id, product_id }
  const loginMeta = new Map(loginRows.map(l => [String(l.login), l]));

  summary.deals_scanned = dealRows.rows.length;

  // Group deals we'll re-run so in non-dry-run we can batch-delete by deal_id
  const newRowsByDealId = new Map();  // deal_id → newRows[]
  const oldRowsByDealId = new Map();  // deal_id → existingRows[]

  for (const d of dealRows.rows) {
    const meta = loginMeta.get(String(d.login));
    if (!meta) continue;
    if (!dealQualifies(d.entry, config.trigger)) continue;
    const lots = Number(d.lots);
    if (!lots || lots <= 0) continue;

    // Fetch existing commission rows for this deal (for comparison / deletion)
    const { rows: existing } = await pool.query(
      `SELECT id, agent_id, amount, rate_per_lot, commission_amount, rebate_amount,
              ccl_pct, ccl_per_lot, rate_source
       FROM commissions
       WHERE deal_id = $1 AND agent_id = $2`,
      [Number(d.deal_id), agentId]
    );
    oldRowsByDealId.set(Number(d.deal_id), existing);

    // Re-run waterfall math
    let newRows;
    try {
      newRows = await computeWaterfallRows(pool, {
        deal_id:        Number(d.deal_id),
        client_id:      meta.client_id,
        mt5_login:      d.login,
        product_id:     meta.product_id,
        lots,
        deal_time:      d.deal_time,
        mt5_commission: Number(d.commission) || 0,
        symbol:         d.symbol || null,
      });
    } catch (err) {
      summary.errors++;
      continue;
    }

    // Filter to only the rows that belong to THIS agent
    const agentNewRows = newRows.filter(r => r.agent_id === agentId);
    newRowsByDealId.set(Number(d.deal_id), agentNewRows);

    // Build preview entries (dry-run or always, for the response payload)
    for (const nr of agentNewRows) {
      const old = existing.find(e => e.agent_id === agentId);
      summary.rows_previewed++;
      summary.preview.push({
        deal_id:          Number(d.deal_id),
        mt5_login:        d.login,
        product_id:       meta.product_id,
        agent_id:         agentId,
        old_amount:       old ? Number(old.amount) : null,
        new_amount:       nr.amount,
        delta:            old ? Number((nr.amount - Number(old.amount)).toFixed(4)) : null,
        old_rate_source:  old?.rate_source || null,
        new_rate_source:  nr.rate_source || null,
        old_rate_per_lot: old ? Number(old.rate_per_lot) : null,
        new_rate_per_lot: nr.rate_per_lot,
      });
    }
  }

  if (dryRun) {
    return summary;
  }

  // --- Live recompute: delete + re-insert inside a transaction --------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing rows for this agent in the window
    const dealIds = [...newRowsByDealId.keys()];
    if (dealIds.length > 0) {
      const { rowCount } = await client.query(
        `DELETE FROM commissions
         WHERE agent_id = $1
           AND deal_id = ANY($2::bigint[])`,
        [agentId, dealIds]
      );
      summary.rows_deleted = rowCount || 0;
    }

    // Re-insert using current rates (with audit columns)
    for (const [, newRows] of newRowsByDealId) {
      for (const r of newRows) {
        try {
          const res = await client.query(
            `INSERT INTO commissions
               (deal_id, client_id, mt5_login, product_id, agent_id,
                lots, rate_per_lot, amount, commission_amount, rebate_amount,
                level, deal_time, source_agent_id,
                ccl_pct, ccl_per_lot, rate_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [r.deal_id, r.client_id, r.mt5_login, r.product_id, r.agent_id,
             r.lots, r.rate_per_lot, r.amount, r.commission_amount, r.rebate_amount,
             r.level, r.deal_time, r.source_agent_id,
             r.ccl_pct ?? null, r.ccl_per_lot ?? null, r.rate_source ?? null]
          );
          if (res.rowCount > 0) summary.rows_inserted++;
        } catch (err) {
          summary.errors++;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return summary;
}

let isRunning = false;
let lastRunAt = null;
let lastRunSummary = null;

const JOB_CONCURRENCY   = 8;
const RETRY_BACKOFF_SEC = [30, 120, 600];  // attempt 1 → 30s, attempt 2 → 2m, attempt 3 → 10m
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Single worker: pick one queued/retry-ready job, run processLogin, mark the
 * job succeeded/failed/dead based on result + retry policy. Bridge outages
 * result in `failed` with next_retry_at set; successive failures eventually
 * mark the job 'dead' and it lands on the DLQ for admin review.
 */
async function processJob(cycleId, config, sinceISO) {
  // Atomically claim the next job so parallel workers don't fight over it.
  // UPDATE ... RETURNING is the standard Postgres queue-claim pattern.
  const { rows } = await pool.query(
    `UPDATE commission_engine_jobs j
     SET status = 'running', started_at = NOW(), attempt = attempt + 1
     WHERE j.id = (
       SELECT id FROM commission_engine_jobs
       WHERE cycle_id = $1
         AND status IN ('queued', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         AND attempt < max_attempts
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING j.*`,
    [cycleId]
  );
  if (!rows[0]) return null; // no more jobs
  const job = rows[0];

  try {
    const r = await processLogin({
      login: job.login,
      client_id: job.client_id,
      product_id: job.product_id,
      config,
      sinceISO,
    });

    await pool.query(
      `UPDATE commission_engine_jobs
       SET status = 'succeeded',
           finished_at = NOW(),
           result_summary = $2,
           last_error = NULL
       WHERE id = $1`,
      [job.id, JSON.stringify(r)]
    );
    return { ok: true, inserted: r.inserted };
  } catch (err) {
    const isDead = job.attempt >= job.max_attempts;
    const backoff = RETRY_BACKOFF_SEC[Math.min(job.attempt - 1, RETRY_BACKOFF_SEC.length - 1)] || 600;
    await pool.query(
      `UPDATE commission_engine_jobs
       SET status         = $2,
           finished_at    = CASE WHEN $2 = 'dead' THEN NOW() ELSE NULL END,
           last_error     = $3,
           next_retry_at  = CASE WHEN $2 = 'dead' THEN NULL ELSE NOW() + ($4 || ' seconds')::interval END
       WHERE id = $1`,
      [job.id, isDead ? 'dead' : 'failed', String(err.message || err), String(backoff)]
    );
    return { ok: false, dead: isDead, error: err.message };
  }
}

/**
 * Main orchestrator, rewritten around a persisted job queue.
 * Protects against overlapping runs via in-memory lock.
 *
 * Flow:
 *   1. Create a cycle row
 *   2. Enqueue one job per (client, login, product) triple
 *   3. Spawn N workers that pull jobs atomically (FOR UPDATE SKIP LOCKED)
 *   4. On failure, schedule retry with exponential backoff
 *   5. After max_attempts, mark job `dead` (visible to admin for manual retry)
 *   6. Update cycle row with final status + counts
 */
export async function runCommissionSync({ sinceISO, triggeredBy = 'scheduled', triggeredByUser = null } = {}) {
  if (isRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;
  const start = Date.now();

  // Create the cycle metadata row upfront
  const { rows: [cycle] } = await pool.query(
    `INSERT INTO commission_engine_cycles (triggered_by, triggered_by_user, since_iso)
     VALUES ($1, $2, $3) RETURNING id`,
    [triggeredBy, triggeredByUser, sinceISO || null]
  );
  const cycleId = cycle.id;

  const summary = {
    cycleId,
    clientsProcessed: 0, loginsProcessed: 0,
    dealsFetched: 0, dealsQualified: 0, rowsInserted: 0, skipped: 0, errors: 0,
    jobsSucceeded: 0, jobsFailed: 0, jobsDead: 0,
  };

  try {
    const config = await loadRuntimeConfig();

    // Enqueue jobs (same eligibility query as before — demo-excluded
    // (client, login, product) triples from trading_accounts_meta).
    const { rows: pairs } = await pool.query(
      `SELECT c.id AS client_id, c.agent_id,
              tam.login, p.id AS product_id
       FROM clients c
       JOIN trading_accounts_meta tam ON tam.client_id = c.id
       JOIN products p ON p.source_id = tam.product_source_id AND p.is_active = true
       WHERE c.agent_id IS NOT NULL
         AND tam.account_type IS DISTINCT FROM 'demo'
         AND tam.product_source_id IS NOT NULL`
    );
    summary.loginsProcessed = pairs.length;

    if (pairs.length > 0) {
      // Multi-row insert keeps it to one round-trip
      const values = [];
      const params = [cycleId];
      pairs.forEach((p, idx) => {
        const base = params.length + 1;
        values.push(`($1, $${base}, $${base+1}, $${base+2}, $${base+3})`);
        params.push(p.login, p.client_id, p.product_id, DEFAULT_MAX_ATTEMPTS);
      });
      await pool.query(
        `INSERT INTO commission_engine_jobs
           (cycle_id, login, client_id, product_id, max_attempts)
         VALUES ${values.join(', ')}`,
        params
      );
    }

    // Set jobs_total on the cycle so the admin UI can show progress
    await pool.query(
      `UPDATE commission_engine_cycles SET jobs_total = $2 WHERE id = $1`,
      [cycleId, pairs.length]
    );

    // Spawn worker loop(s)
    await Promise.all(
      Array.from({ length: JOB_CONCURRENCY }, async () => {
        while (true) {
          const r = await processJob(cycleId, config, sinceISO);
          if (!r) break; // no more jobs to claim
          if (r.ok) {
            summary.jobsSucceeded++;
            summary.rowsInserted += r.inserted || 0;
          } else if (r.dead) {
            summary.jobsDead++;
          } else {
            summary.jobsFailed++;
          }
        }
      })
    );

    // Count unique clients for back-compat summary shape
    const seenClients = new Set(pairs.map(p => p.client_id));
    summary.clientsProcessed = seenClients.size;
    summary.elapsedMs = Date.now() - start;
    lastRunAt = new Date().toISOString();
    lastRunSummary = summary;

    // Refresh the per-agent monthly earnings rollup. We identify every
    // (agent_id, period_month) pair touched by this cycle via
    // commissions.created_at >= cycle_start, then upsert one aggregate row
    // per pair into agent_earnings_summary. This keeps dashboard-facing
    // earnings views at O(1) per read instead of aggregating the commissions
    // table on every page load. Failure is non-fatal — next cycle will catch
    // up, and the nightly reconcileRecent backstop fills any gaps.
    if (summary.rowsInserted > 0) {
      try {
        const cycleStartISO = new Date(start).toISOString();
        const { rows: touched } = await pool.query(
          `SELECT DISTINCT agent_id,
                  date_trunc('month', deal_time)::date AS period_month
           FROM commissions
           WHERE created_at >= $1::timestamptz`,
          [cycleStartISO]
        );
        if (touched.length > 0) {
          const { refreshForAgentMonths } = await import('./agentEarningsSummary.js');
          const aesResult = await refreshForAgentMonths(touched);
          summary.earnings_summary_upserted = aesResult.upserted;
        }
      } catch (aesErr) {
        console.warn('[Commissions] agent_earnings_summary refresh failed:', aesErr.message);
      }
    }

    // Final cycle update
    const finalStatus = summary.jobsDead > 0
      ? 'partial'
      : summary.jobsFailed > 0
        ? 'partial'
        : 'succeeded';
    await pool.query(
      `UPDATE commission_engine_cycles
       SET finished_at = NOW(), status = $2,
           jobs_succeeded = $3, jobs_failed = $4, jobs_dead = $5, deals_inserted = $6
       WHERE id = $1`,
      [cycleId, finalStatus, summary.jobsSucceeded, summary.jobsFailed, summary.jobsDead, summary.rowsInserted]
    );

    // Persist the last run timestamp so admin UIs can show it
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('commission_last_run_at', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [lastRunAt]
    );

    // Notify agents who earned new commissions in this cycle. One digest row
    // per agent (dedup window = 1 hour) so bursty syncs don't flood the bell.
    if (summary.rowsInserted > 0) {
      try {
        const cycleStartISO = new Date(start).toISOString();
        const { rows: winners } = await pool.query(
          `SELECT agent_id, COUNT(*)::int AS new_rows,
                  SUM(amount)::numeric(14,2) AS new_amount,
                  MAX(deal_time) AS latest_deal_time
           FROM commissions
           WHERE created_at >= $1
           GROUP BY agent_id`,
          [cycleStartISO]
        );
        for (const w of winners) {
          const refId = `cycle-${cycleStartISO}`;
          if (await isDuplicate(w.agent_id, 'commission_earned', refId, 1)) continue;
          await createNotification({
            userId: w.agent_id,
            type: 'commission_earned',
            title: `New commissions: ${Number(w.new_amount).toFixed(2)}`,
            message: `${w.new_rows} commission ${w.new_rows === 1 ? 'row' : 'rows'} added in the latest sync cycle.`,
            icon: 'deposit',
            color: 'green',
            link: '/portal/commissions',
            referenceId: refId,
            referenceType: 'commission_cycle',
          });
        }
      } catch (notifyErr) {
        // Never let notification failures break the engine cycle
        console.error('[Commissions] notification dispatch failed:', notifyErr.message);
      }
    }

    // Emit metrics so Prometheus/Grafana can alert on slow cycles or DLQ growth
    try {
      const { commissionCycleDuration, commissionRowsInserted, commissionJobStatus } =
        await import('./metrics.js');
      commissionCycleDuration.labels(triggeredBy, finalStatus).observe(summary.elapsedMs / 1000);
      commissionRowsInserted.labels(triggeredBy).inc(summary.rowsInserted);
      commissionJobStatus.labels('succeeded').inc(summary.jobsSucceeded);
      commissionJobStatus.labels('failed').inc(summary.jobsFailed);
      commissionJobStatus.labels('dead').inc(summary.jobsDead);
    } catch { /* metrics optional — never break engine */ }

    // Diagnostics — when a cycle succeeds but produced few rows, compute WHY.
    // Helps admins see "oh Paul Matar has 413 clients with logins but 0 in
    // meta" without having to run forensic SQL by hand.
    let diagnostics = null;
    try {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE is_agent = true AND linked_client_id IS NOT NULL) AS imported_agents,
          (SELECT COUNT(DISTINCT agent_id) FROM agent_products WHERE rate_per_lot > 0 AND is_active = true) AS agents_with_rates,
          (SELECT COUNT(DISTINCT agent_id) FROM agent_products WHERE rate_per_lot = 0 AND is_active = true) AS agents_rate_zero,
          (SELECT COUNT(*) FROM clients WHERE contact_type = 'individual' AND array_length(mt5_logins, 1) > 0) AS clients_with_mt5_logins,
          (SELECT COUNT(DISTINCT client_id) FROM trading_accounts_meta) AS clients_with_meta,
          (SELECT COUNT(DISTINCT login) FROM mt5_deal_cache) AS logins_with_cached_deals,
          (SELECT COUNT(DISTINCT agent_id) FROM commissions) AS agents_with_commissions
      `);
      const d = rows[0];
      diagnostics = {
        imported_agents: Number(d.imported_agents),
        agents_with_rates: Number(d.agents_with_rates),
        agents_rate_zero: Number(d.agents_rate_zero),
        clients_with_mt5_logins: Number(d.clients_with_mt5_logins),
        clients_with_meta: Number(d.clients_with_meta),
        logins_with_cached_deals: Number(d.logins_with_cached_deals),
        agents_with_commissions: Number(d.agents_with_commissions),
      };
      // Suspected bottleneck: pick the weakest link in the chain
      if (diagnostics.agents_with_rates === 0) {
        diagnostics.suspected_bottleneck = 'no_rates_configured';
      } else if (diagnostics.clients_with_mt5_logins < diagnostics.imported_agents * 2) {
        diagnostics.suspected_bottleneck = 'missing_mt5_logins';
      } else if (diagnostics.clients_with_meta < diagnostics.clients_with_mt5_logins * 0.5) {
        diagnostics.suspected_bottleneck = 'missing_trading_accounts_meta';
      } else if (diagnostics.logins_with_cached_deals < diagnostics.clients_with_meta * 0.3) {
        diagnostics.suspected_bottleneck = 'missing_mt5_deals';
      } else if (diagnostics.agents_with_commissions < diagnostics.agents_with_rates * 0.5) {
        diagnostics.suspected_bottleneck = 'rates_or_hierarchy';
      } else {
        diagnostics.suspected_bottleneck = 'healthy';
      }
      summary.diagnostics = diagnostics;
    } catch (diagErr) {
      console.warn('[Commissions] diagnostics query failed:', diagErr.message);
    }

    const { logger } = await import('./logger.js');
    logger.info({
      cycleId,
      elapsedMs: summary.elapsedMs,
      jobsQueued: summary.loginsProcessed,
      jobsSucceeded: summary.jobsSucceeded,
      jobsFailed: summary.jobsFailed,
      jobsDead: summary.jobsDead,
      rowsInserted: summary.rowsInserted,
      triggeredBy,
      status: finalStatus,
      diagnostics,
    }, '[Commissions] cycle done');
    return summary;
  } catch (err) {
    const { logger } = await import('./logger.js');
    logger.error({ err: err.message, cycleId }, '[Commissions] fatal cycle error');
    summary.errors = (summary.errors || 0) + 1;
    await pool.query(
      `UPDATE commission_engine_cycles SET finished_at = NOW(), status = 'failed' WHERE id = $1`,
      [cycleId]
    ).catch(() => {});
    return summary;
  } finally {
    isRunning = false;
  }
}

/**
 * Retry all dead jobs from a specific cycle (or the latest cycle if no id).
 * Resets them to 'queued' with attempt = 0 and re-runs the worker pool.
 * Surfaces to admins via POST /api/commissions/engine/retry.
 */
export async function retryDeadJobs({ cycleId } = {}) {
  // If no cycleId, use the latest cycle that had dead jobs
  let target = cycleId;
  if (!target) {
    const { rows } = await pool.query(
      `SELECT id FROM commission_engine_cycles WHERE jobs_dead > 0 ORDER BY started_at DESC LIMIT 1`
    );
    target = rows[0]?.id;
  }
  if (!target) return { reset: 0, reason: 'no cycles with dead jobs' };

  const { rows } = await pool.query(
    `UPDATE commission_engine_jobs
     SET status = 'queued', attempt = 0, last_error = NULL, next_retry_at = NULL,
         finished_at = NULL, started_at = NULL
     WHERE cycle_id = $1 AND status = 'dead'
     RETURNING id`,
    [target]
  );

  if (rows.length === 0) return { reset: 0, cycleId: target };

  // Re-run the worker loop for this cycle. We don't create a new cycle
  // because we want to track the retry within the same cycle's counters.
  const config = await loadRuntimeConfig();
  await Promise.all(
    Array.from({ length: JOB_CONCURRENCY }, async () => {
      while (true) {
        const r = await processJob(target, config, null);
        if (!r) break;
      }
    })
  );

  // Refresh the cycle's counters from the jobs table
  await pool.query(
    `UPDATE commission_engine_cycles c
     SET jobs_succeeded = (SELECT COUNT(*) FROM commission_engine_jobs WHERE cycle_id = c.id AND status = 'succeeded'),
         jobs_failed    = (SELECT COUNT(*) FROM commission_engine_jobs WHERE cycle_id = c.id AND status = 'failed'),
         jobs_dead      = (SELECT COUNT(*) FROM commission_engine_jobs WHERE cycle_id = c.id AND status = 'dead'),
         deals_inserted = (SELECT COALESCE(SUM((result_summary->>'inserted')::int), 0)
                           FROM commission_engine_jobs WHERE cycle_id = c.id AND status = 'succeeded')
     WHERE c.id = $1`,
    [target]
  );

  return { reset: rows.length, cycleId: target };
}

export function getEngineStatus() {
  return { isRunning, lastRunAt, lastRunSummary };
}

let intervalId = null;

/**
 * Start the interval-driven scheduler. `intervalMin` defaults to
 * COMMISSION_SYNC_INTERVAL_MIN env var, else 15 minutes. First run
 * occurs `delayMin` minutes after startup to let the app warm up.
 */
export function startCommissionScheduler({ intervalMin, delayMin = 3 } = {}) {
  if (intervalId) return;
  const min = Number(intervalMin ?? process.env.COMMISSION_SYNC_INTERVAL_MIN ?? 15);
  const intervalMs = Math.max(1, min) * 60 * 1000;
  const delayMs = Math.max(0, delayMin) * 60 * 1000;

  console.log(`[Commissions] scheduler armed — interval ${min}min, first run in ${delayMin}min`);

  setTimeout(() => {
    runCommissionSync().catch(err => console.error('[Commissions] first run error:', err.message));
    intervalId = setInterval(() => {
      runCommissionSync().catch(err => console.error('[Commissions] interval error:', err.message));
    }, intervalMs);
  }, delayMs);
}

export function stopCommissionScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
