/**
 * Admin — Dashboard — /api/admin/dashboard
 *
 * One-shot aggregate for the admin console landing page. Pulls from 6+
 * sources in parallel (counts, commission totals, engine state, MT5 freshness,
 * reconciliation drift, top agents, recent audit, products needing rates)
 * so the admin sees the whole system at a glance.
 *
 * Requires portal.admin.
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { cacheMw } from '../../services/responseCache.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// 60s cache: dashboard aggregates are OK to be a minute stale, and this is
// the single heaviest read endpoint in the whole system (11 parallel
// aggregates per call). Cutting it to "once per minute per role" is the
// single biggest egress reduction we can make on reads.
router.get('/', cacheMw({ ttl: 60 }), async (req, res, next) => {
  try {
    const [
      { rows: [counts] },
      { rows: [commThisMonth] },
      { rows: [commLastMonth] },
      { rows: daily30d },
      { rows: [lastCycle] },
      { rows: [engineHealth] },
      { rows: [snapshotFreshness] },
      { rows: [reconSummary] },
      { rows: topAgents },
      { rows: recentAudit },
      { rows: [productsUnconfig] },
    ] = await Promise.all([
      // High-level counts
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE is_agent = true AND is_active = true) AS agents_active,
          (SELECT COUNT(*)::int FROM clients WHERE contact_type = 'individual') AS clients_total,
          (SELECT COUNT(*)::int FROM trading_accounts_meta WHERE account_type = 'real') AS trading_accounts,
          (SELECT COUNT(*)::int FROM users WHERE is_agent = true AND is_active = true AND parent_agent_id IS NOT NULL) AS sub_agents,
          (SELECT COUNT(*)::int FROM products WHERE is_active = true) AS products_active
      `),
      // This month commission totals — read from the per-month rollup
      // (agent_earnings_summary, one row per agent per month) instead of
      // scanning every commission row. One-line summary vs ~10K-row scan.
      pool.query(`
        SELECT COALESCE(SUM(total_amount),      0)::numeric(14,2) AS total,
               COALESCE(SUM(commission_amount), 0)::numeric(14,2) AS commission,
               COALESCE(SUM(rebate_amount),     0)::numeric(14,2) AS rebate,
               COALESCE(SUM(deal_count),        0)::int           AS deal_count
        FROM agent_earnings_summary
        WHERE period_month = date_trunc('month', NOW())::date
      `),
      // Last month (for delta) — same rollup, previous month's row
      pool.query(`
        SELECT COALESCE(SUM(total_amount), 0)::numeric(14,2) AS total
        FROM agent_earnings_summary
        WHERE period_month = (date_trunc('month', NOW()) - interval '1 month')::date
      `),
      // Daily series for the last 30 days
      pool.query(`
        SELECT date_trunc('day', deal_time)::date AS day,
               COALESCE(SUM(commission_amount), 0)::numeric(14,2) AS commission,
               COALESCE(SUM(rebate_amount),     0)::numeric(14,2) AS rebate,
               COALESCE(SUM(amount),            0)::numeric(14,2) AS total
        FROM commissions
        WHERE deal_time >= NOW() - interval '30 days'
        GROUP BY day ORDER BY day
      `),
      // Last commission engine cycle
      pool.query(`
        SELECT c.*, u.name AS triggered_by_name
        FROM commission_engine_cycles c
        LEFT JOIN users u ON u.id = c.triggered_by_user
        ORDER BY c.started_at DESC LIMIT 1
      `),
      // Dead-jobs count across all cycles (DLQ health)
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM commission_engine_jobs WHERE status = 'dead') AS dead_jobs,
          (SELECT COUNT(*)::int FROM commission_engine_jobs WHERE status = 'failed') AS failed_jobs
      `),
      // MT5 snapshot freshness
      pool.query(`
        SELECT
          COUNT(*)::int AS total_logins,
          COUNT(*) FILTER (WHERE mt5_synced_at IS NULL)::int AS pending,
          MIN(mt5_synced_at) AS oldest,
          MAX(mt5_synced_at) AS newest
        FROM trading_accounts_meta
        WHERE account_type = 'real'
      `),
      // Reconciliation: engine vs MT5 for last 30 days
      pool.query(`
        SELECT
          (SELECT COALESCE(SUM(commission_amount), 0)::numeric(14,2)
             FROM commissions WHERE deal_time >= NOW() - interval '30 days') AS engine_commission,
          (SELECT COALESCE(SUM(ABS(commission)), 0)::numeric(14,2)
             FROM mt5_deal_cache WHERE deal_time >= NOW() - interval '30 days'
             AND commission IS NOT NULL) AS mt5_commission,
          (SELECT COUNT(*)::int FROM (
             SELECT mt5_login::text AS login, SUM(commission_amount)::numeric(14,4) AS e_c
             FROM commissions
             WHERE deal_time >= NOW() - interval '30 days'
             GROUP BY mt5_login
           ) e
           JOIN (
             SELECT login, SUM(ABS(commission))::numeric(14,4) AS m_c
             FROM mt5_deal_cache
             WHERE deal_time >= NOW() - interval '30 days' AND commission IS NOT NULL
             GROUP BY login
           ) m ON m.login = e.login
           WHERE ABS(e.e_c - m.m_c) > 0.01) AS logins_with_drift
      `),
      // Top 5 agents by this-month earnings — hits the per-month rollup.
      // LEFT JOIN is preserved so zero-earner agents still show up (the UI
      // wants a consistent 5-row list even if some agents didn't trade).
      pool.query(`
        SELECT u.id, u.name, u.email,
               COALESCE(s.total_amount, 0)::numeric(14,2) AS total_earnings,
               COALESCE(s.deal_count,   0)::int           AS deal_count,
               COALESCE(s.lots_total,   0)::numeric(14,2) AS total_lots
        FROM users u
        LEFT JOIN agent_earnings_summary s
          ON s.agent_id = u.id
         AND s.period_month = date_trunc('month', NOW())::date
        WHERE u.is_agent = true AND u.is_active = true
        ORDER BY total_earnings DESC
        LIMIT 5
      `),
      // Recent audit trail
      pool.query(`
        SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
               a.actor_email, u.name AS actor_name
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC LIMIT 10
      `),
      // Products needing a rate
      pool.query(`
        SELECT COUNT(*)::int AS n
        FROM products WHERE is_active = true AND max_rate_per_lot = 0
      `),
    ]);

    // Build a zero-filled 30-day series (chart looks cleaner this way)
    const byDay = new Map(daily30d.map(r => [new Date(r.day).toISOString().slice(0, 10), r]));
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      daily.push({
        day: key,
        commission: Number(row?.commission || 0),
        rebate:     Number(row?.rebate || 0),
        total:      Number(row?.total || 0),
      });
    }

    const thisMonthTotal = Number(commThisMonth?.total || 0);
    const lastMonthTotal = Number(commLastMonth?.total || 0);
    const driftPct = reconSummary?.mt5_commission > 0
      ? ((Number(reconSummary.engine_commission) - Number(reconSummary.mt5_commission)) / Number(reconSummary.mt5_commission))
      : null;

    res.json({
      counts: {
        agents_active:    counts?.agents_active ?? 0,
        clients_total:    counts?.clients_total ?? 0,
        trading_accounts: counts?.trading_accounts ?? 0,
        sub_agents:       counts?.sub_agents ?? 0,
        products_active:  counts?.products_active ?? 0,
        products_unconfigured: productsUnconfig?.n ?? 0,
      },
      commissions: {
        this_month:       thisMonthTotal,
        last_month:       lastMonthTotal,
        this_month_commission: Number(commThisMonth?.commission || 0),
        this_month_rebate:     Number(commThisMonth?.rebate || 0),
        this_month_deal_count: commThisMonth?.deal_count ?? 0,
        daily_30d: daily,
      },
      engine: {
        last_cycle: lastCycle || null,
        dead_jobs:   engineHealth?.dead_jobs ?? 0,
        failed_jobs: engineHealth?.failed_jobs ?? 0,
      },
      mt5_snapshots: {
        total_logins: snapshotFreshness?.total_logins ?? 0,
        pending:      snapshotFreshness?.pending ?? 0,
        oldest:       snapshotFreshness?.oldest ?? null,
        newest:       snapshotFreshness?.newest ?? null,
      },
      reconciliation: {
        engine_commission: Number(reconSummary?.engine_commission || 0),
        mt5_commission:    Number(reconSummary?.mt5_commission || 0),
        drift_pct:         driftPct,
        logins_with_drift: reconSummary?.logins_with_drift ?? 0,
      },
      top_agents: topAgents.map(r => ({
        agent_id: r.id,
        name: r.name,
        email: r.email,
        total_earnings: Number(r.total_earnings),
        deal_count: r.deal_count,
        total_lots: Number(r.total_lots),
      })),
      recent_audit: recentAudit,
    });
  } catch (err) { next(err); }
});

export default router;
