/**
 * Admin — Reconciliation — /api/admin/reconciliation
 *
 * Compares three commission sources per agent/login/period:
 *   1. Our engine's commission_amount in `commissions` table
 *   2. MT5's raw deal.commission in `mt5_deal_cache` (authoritative broker charge)
 *   3. x-dev CRM's ibWallets.total_commissions (future — not wired yet)
 *
 * Shows per-agent rollups with % delta between the two and flags mismatches
 * above a configurable threshold.
 *
 * Query params: from, to (ISO date strings), agent_id (optional)
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { cacheMw } from '../../services/responseCache.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/reconciliation/diagnostics — chain-of-failure check across
// the commission pipeline (rates → mt5_logins → meta → cached deals → rows).
// Answers "why is the commissions table empty for branch X?" in one query
// instead of running forensic SQL by hand.
router.get('/diagnostics', async (req, res, next) => {
  try {
    const { rows: [totals] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_agent = true AND linked_client_id IS NOT NULL)::int AS imported_agents,
        (SELECT COUNT(DISTINCT agent_id) FROM agent_products WHERE rate_per_lot > 0 AND is_active = true)::int AS agents_with_rates,
        (SELECT COUNT(DISTINCT agent_id) FROM agent_products WHERE rate_per_lot = 0 AND is_active = true)::int AS agents_rate_zero,
        (SELECT COUNT(*) FROM clients WHERE contact_type = 'individual' AND array_length(mt5_logins, 1) > 0)::int AS clients_with_mt5_logins,
        (SELECT COUNT(DISTINCT client_id) FROM trading_accounts_meta)::int AS clients_with_meta,
        (SELECT COUNT(DISTINCT login) FROM mt5_deal_cache)::int AS logins_with_cached_deals,
        (SELECT COUNT(DISTINCT agent_id) FROM commissions)::int AS agents_with_commissions
    `);

    // Per-branch breakdown — which branches are blocked and where
    const { rows: perBranch } = await pool.query(`
      SELECT
        COALESCE(c.branch, '(none)') AS branch,
        COUNT(DISTINCT u.id)::int AS imported_agents,
        COUNT(DISTINCT u.id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM agent_products ap
            WHERE ap.agent_id = u.id AND ap.rate_per_lot > 0 AND ap.is_active = true
          )
        )::int AS agents_with_rates,
        COUNT(DISTINCT cl.id) FILTER (WHERE array_length(cl.mt5_logins, 1) > 0)::int AS clients_with_logins,
        COUNT(DISTINCT tam.client_id)::int AS clients_with_meta,
        COUNT(DISTINCT com.agent_id)::int AS agents_earning
      FROM users u
      LEFT JOIN clients c ON c.id = u.linked_client_id
      LEFT JOIN clients cl ON cl.agent_id = u.id
      LEFT JOIN trading_accounts_meta tam ON tam.client_id = cl.id
      LEFT JOIN commissions com ON com.agent_id = u.id
      WHERE u.is_agent = true AND u.linked_client_id IS NOT NULL
      GROUP BY c.branch
      ORDER BY imported_agents DESC
    `);

    // Pick the weakest link automatically
    let suspectedBottleneck = 'healthy';
    if (totals.agents_with_rates === 0) {
      suspectedBottleneck = 'no_rates_configured';
    } else if (totals.clients_with_mt5_logins < totals.imported_agents * 2) {
      suspectedBottleneck = 'missing_mt5_logins';
    } else if (totals.clients_with_meta < totals.clients_with_mt5_logins * 0.5) {
      suspectedBottleneck = 'missing_trading_accounts_meta';
    } else if (totals.logins_with_cached_deals < totals.clients_with_meta * 0.3) {
      suspectedBottleneck = 'missing_mt5_deals';
    } else if (totals.agents_with_commissions < totals.agents_with_rates * 0.5) {
      suspectedBottleneck = 'rates_or_hierarchy';
    }

    // Plain-English explanations for the UI
    const explanations = {
      no_rates_configured: 'No agent has a non-zero product rate. Go to Admin → Import Agents → Heal rates.',
      missing_mt5_logins: 'Most imported clients have no MT5 logins pulled yet. Run Admin → Import Agents → Sync MT5 logins per branch.',
      missing_trading_accounts_meta: 'MT5 logins exist but trading_accounts_meta is empty for most of them. Re-run the branch MT5 sync — it now fills both tables in one pass.',
      missing_mt5_deals: 'mt5_deal_cache is sparse. The MT5 bridge sync hasn\'t fetched history for most logins. Trigger a per-agent "Refresh MT5 snapshot" from Agent Detail.',
      rates_or_hierarchy: 'Rates + data look populated but few agents are earning. Check parent_agent_id chains are correct and that rates cascade properly.',
      healthy: 'Pipeline looks healthy.',
    };

    res.json({
      totals,
      per_branch: perBranch,
      suspected_bottleneck: suspectedBottleneck,
      explanation: explanations[suspectedBottleneck],
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

function parseDateParam(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// GET /api/admin/reconciliation/per-agent — per-agent rollup comparing our engine to MT5
router.get('/per-agent', cacheMw({ ttl: 180 }), async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);

    // Our engine total per agent — "engine_commission" is the commission_amount
    // portion only (what we claim corresponds to MT5's per-deal charge).
    // Since our agents get commission via the waterfall split, per-login per-agent
    // rollup is required; the agent's TOTAL engine_commission per login should,
    // in aggregate, sum with descendants to exactly what MT5 charged on that login.
    //
    // We compare at the LOGIN level: engine's total commission_amount across all
    // agents on a login should equal ABS(SUM(deal.commission)) on that login.
    // Then we roll up to agents for the admin view.
    const { rows } = await pool.query(
      `WITH engine_by_agent AS (
         SELECT c.agent_id,
                COUNT(DISTINCT c.deal_id)::int          AS engine_deals,
                SUM(c.commission_amount)::numeric(14,2) AS engine_commission,
                SUM(c.rebate_amount)::numeric(14,2)     AS engine_rebate,
                SUM(c.amount)::numeric(14,2)            AS engine_total,
                array_agg(DISTINCT c.mt5_login::text)   AS logins
         FROM commissions c
         WHERE ($1::timestamptz IS NULL OR c.deal_time >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR c.deal_time <= $2::timestamptz)
         GROUP BY c.agent_id
       ),
       mt5_by_agent AS (
         -- For each agent, sum MT5 deal.commission across all logins that
         -- produced commissions for them. This gives what MT5 actually charged
         -- on their book of trades.
         SELECT c.agent_id,
                SUM(ABS(d.commission))::numeric(14,2)  AS mt5_commission,
                COUNT(DISTINCT d.deal_id)::int         AS mt5_deals
         FROM commissions c
         JOIN mt5_deal_cache d ON d.login = c.mt5_login::text AND d.deal_id = c.deal_id
         WHERE ($1::timestamptz IS NULL OR c.deal_time >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR c.deal_time <= $2::timestamptz)
           AND d.commission IS NOT NULL
         GROUP BY c.agent_id
       )
       SELECT
         u.id AS agent_id, u.name AS agent_name, u.email,
         COALESCE(e.engine_deals,      0) AS engine_deals,
         COALESCE(e.engine_commission, 0) AS engine_commission,
         COALESCE(e.engine_rebate,     0) AS engine_rebate,
         COALESCE(e.engine_total,      0) AS engine_total,
         COALESCE(m.mt5_commission,    0) AS mt5_commission,
         COALESCE(m.mt5_deals,         0) AS mt5_deals,
         -- Drift: engine_commission should be a SHARE of the login's total
         -- MT5 commission (since it cascades up to multiple agents). The
         -- engine column can be legitimately less than MT5 — the ancestors
         -- together split the MT5 charge. For per-agent drift we compute
         -- share_pct = engine / mt5 (should be between 0 and 1).
         CASE WHEN COALESCE(m.mt5_commission, 0) = 0 THEN NULL
              ELSE (COALESCE(e.engine_commission, 0) / NULLIF(m.mt5_commission, 0))::numeric(8,4)
         END AS share_pct
       FROM users u
       JOIN engine_by_agent e ON e.agent_id = u.id
       LEFT JOIN mt5_by_agent m ON m.agent_id = u.id
       ORDER BY e.engine_total DESC`,
      [from, to]
    );

    res.json({ items: rows, range: { from, to } });
  } catch (err) { next(err); }
});

// GET /api/admin/reconciliation/per-login — drift at the login level (strongest signal)
// Per login: SUM(engine.commission_amount across all agents) vs ABS(SUM(deal.commission))
// If these don't match, the waterfall math is off for that login's deal(s).
router.get('/per-login', cacheMw({ ttl: 180 }), async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);
    const threshold = Math.max(0, Number(req.query.threshold) || 0.01); // 1 cent default

    const { rows } = await pool.query(
      `WITH engine_per_login AS (
         SELECT c.mt5_login::text AS login,
                SUM(c.commission_amount)::numeric(14,4) AS engine_commission,
                COUNT(DISTINCT c.deal_id)::int          AS engine_deals
         FROM commissions c
         WHERE ($1::timestamptz IS NULL OR c.deal_time >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR c.deal_time <= $2::timestamptz)
         GROUP BY c.mt5_login
       ),
       mt5_per_login AS (
         SELECT d.login,
                SUM(ABS(d.commission))::numeric(14,4) AS mt5_commission,
                COUNT(*)::int AS mt5_deals
         FROM mt5_deal_cache d
         WHERE ($1::timestamptz IS NULL OR d.deal_time >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR d.deal_time <= $2::timestamptz)
           AND d.commission IS NOT NULL
         GROUP BY d.login
       )
       SELECT
         COALESCE(e.login, m.login) AS login,
         (SELECT c.name FROM clients c JOIN trading_accounts_meta tam ON tam.client_id = c.id WHERE tam.login = COALESCE(e.login, m.login) LIMIT 1) AS client_name,
         COALESCE(e.engine_commission, 0) AS engine_commission,
         COALESCE(e.engine_deals, 0)      AS engine_deals,
         COALESCE(m.mt5_commission, 0)    AS mt5_commission,
         COALESCE(m.mt5_deals, 0)         AS mt5_deals,
         (COALESCE(e.engine_commission, 0) - COALESCE(m.mt5_commission, 0))::numeric(14,4) AS drift,
         CASE WHEN COALESCE(m.mt5_commission, 0) = 0 THEN NULL
              ELSE ABS(COALESCE(e.engine_commission, 0) - COALESCE(m.mt5_commission, 0)) / NULLIF(m.mt5_commission, 0)
         END::numeric(8,4) AS drift_pct
       FROM engine_per_login e
       FULL OUTER JOIN mt5_per_login m ON m.login = e.login
       WHERE ABS(COALESCE(e.engine_commission, 0) - COALESCE(m.mt5_commission, 0)) > $3
       ORDER BY ABS(COALESCE(e.engine_commission, 0) - COALESCE(m.mt5_commission, 0)) DESC
       LIMIT 500`,
      [from, to, threshold]
    );

    res.json({ items: rows, range: { from, to }, threshold });
  } catch (err) { next(err); }
});

// GET /api/admin/reconciliation/summary — one-shot top-line numbers
router.get('/summary', cacheMw({ ttl: 180 }), async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to   = parseDateParam(req.query.to);

    const { rows: [summary] } = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(commission_amount), 0)::numeric(14,2)
            FROM commissions
            WHERE ($1::timestamptz IS NULL OR deal_time >= $1::timestamptz)
              AND ($2::timestamptz IS NULL OR deal_time <= $2::timestamptz)
         ) AS engine_commission_total,
         (SELECT COALESCE(SUM(ABS(commission)), 0)::numeric(14,2)
            FROM mt5_deal_cache
            WHERE ($1::timestamptz IS NULL OR deal_time >= $1::timestamptz)
              AND ($2::timestamptz IS NULL OR deal_time <= $2::timestamptz)
              AND commission IS NOT NULL
         ) AS mt5_commission_total,
         (SELECT COUNT(DISTINCT deal_id)
            FROM commissions
            WHERE ($1::timestamptz IS NULL OR deal_time >= $1::timestamptz)
              AND ($2::timestamptz IS NULL OR deal_time <= $2::timestamptz)
         ) AS engine_deal_count,
         (SELECT COUNT(*)
            FROM mt5_deal_cache
            WHERE ($1::timestamptz IS NULL OR deal_time >= $1::timestamptz)
              AND ($2::timestamptz IS NULL OR deal_time <= $2::timestamptz)
              AND commission IS NOT NULL
         ) AS mt5_deal_count`,
      [from, to]
    );

    res.json({
      ...summary,
      engine_commission_total: Number(summary.engine_commission_total),
      mt5_commission_total:    Number(summary.mt5_commission_total),
      drift:                   Number(summary.engine_commission_total) - Number(summary.mt5_commission_total),
      drift_pct:               Number(summary.mt5_commission_total) > 0
        ? (Number(summary.engine_commission_total) - Number(summary.mt5_commission_total)) / Number(summary.mt5_commission_total)
        : null,
      range: { from, to },
    });
  } catch (err) { next(err); }
});

export default router;
