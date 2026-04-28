/**
 * Portal — Dashboard — /api/portal/dashboard
 *
 * One endpoint returning everything the agent Dashboard needs in a single
 * round-trip: client/lead/sub-agent counts, trading-account rollup, and
 * commission totals for this week / this month.
 *
 * Requires the caller to be a fully-imported portal agent (has
 * linked_client_id). Admins without is_agent=true get an empty shape so the
 * page still renders but without counts.
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate, requireAgentAccess } from '../../middleware/portalAuth.js';

const router = Router();
router.use(portalAuthenticate, requireAgentAccess);

router.get('/', async (req, res, next) => {
  try {
    const { rows: [me] } = await pool.query(
      `SELECT u.id, u.linked_client_id, u.parent_agent_id,
              p.name AS parent_name
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_agent_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!me) return res.status(404).json({ error: 'Agent not found' });

    // All counts reference referred_by_agent_id = linked_client_id (the CRM
    // anchor point). Falls back to empty if the agent isn't CRM-linked.
    const lcid = me.linked_client_id;

    const [
      { rows: [downline] },
      { rows: [tradingRow] },
      { rows: [commW] },
      { rows: [commM] },
      { rows: [subTreeRow] },
      { rows: [commLastMonth] },
      { rows: earningsDaily },
      { rows: topClients },
      { rows: pipelineFunnel },
      { rows: subAgentLeaders },
    ] = await Promise.all([
      // Direct downline breakdown
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE c.contact_type = 'individual' AND c.crm_profile_type = 'client')::int AS clients_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'individual' AND c.crm_profile_type = 'lead')::int   AS leads_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'individual')::int                                   AS individuals_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'agent')::int                                        AS subagents_count
         FROM clients c
         WHERE c.referred_by_agent_id = $1`,
        [lcid]
      ),
      // Trading accounts across the agent's DIRECT individual clients
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE array_length(c.mt5_logins, 1) > 0)::int AS clients_with_mt5,
           COALESCE(SUM(COALESCE(array_length(c.mt5_logins, 1), 0)), 0)::int AS total_mt5_accounts,
           COUNT(*) FILTER (WHERE c.first_deposit_at IS NOT NULL)::int AS funded_clients_count
         FROM clients c
         WHERE c.referred_by_agent_id = $1 AND c.contact_type = 'individual'`,
        [lcid]
      ),
      // This-week commission total (ISO week starts Monday)
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS total,
                COUNT(*)::int AS deal_count
         FROM commissions
         WHERE agent_id = $1 AND deal_time >= date_trunc('week', NOW())`,
        [req.user.id]
      ),
      // This-month commission total — per-agent rollup (one row, not a scan).
      // SUM ensures a zero-row is returned even when the agent has no
      // summary entry for this month yet (same shape as the old query).
      pool.query(
        `SELECT COALESCE(SUM(total_amount), 0)::numeric(14,2) AS total,
                COALESCE(SUM(deal_count),   0)::int           AS deal_count
         FROM agent_earnings_summary
         WHERE agent_id = $1
           AND period_month = date_trunc('month', NOW())::date`,
        [req.user.id]
      ),
      // Recursive sub-tree totals — every agent under me (any depth) + their clients
      pool.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, linked_client_id FROM users WHERE id = $1
           UNION ALL
           SELECT u.id, u.linked_client_id
           FROM users u JOIN subtree s ON u.parent_agent_id = s.id
           WHERE u.is_agent = true
         )
         SELECT
           (SELECT COUNT(*)::int FROM subtree WHERE id <> $1)                             AS subtree_agent_count,
           (SELECT COUNT(*)::int FROM clients c
            WHERE c.referred_by_agent_id IN (SELECT linked_client_id FROM subtree)
              AND c.contact_type = 'individual')                                           AS subtree_clients_count,
           (SELECT COALESCE(SUM(COALESCE(array_length(c.mt5_logins, 1), 0)), 0)::int
            FROM clients c
            WHERE c.referred_by_agent_id IN (SELECT linked_client_id FROM subtree)
              AND c.contact_type = 'individual')                                           AS subtree_mt5_count`,
        [req.user.id]
      ),
      // Last month's commission — hits the per-month rollup, same shape as
      // the old aggregate query. Used for the hero-card delta calculation.
      pool.query(
        `SELECT COALESCE(SUM(total_amount),      0)::numeric(14,2) AS total,
                COALESCE(SUM(commission_amount), 0)::numeric(14,2) AS commission,
                COALESCE(SUM(rebate_amount),     0)::numeric(14,2) AS rebate,
                COALESCE(SUM(deal_count),        0)::int           AS deal_count
         FROM agent_earnings_summary
         WHERE agent_id = $1
           AND period_month = (date_trunc('month', NOW()) - interval '1 month')::date`,
        [req.user.id]
      ),
      // Daily earnings over the last 14 days — chart data
      pool.query(
        `SELECT date_trunc('day', deal_time)::date AS day,
                COALESCE(SUM(commission_amount), 0)::numeric(14,2) AS commission,
                COALESCE(SUM(rebate_amount),     0)::numeric(14,2) AS rebate,
                COALESCE(SUM(amount),            0)::numeric(14,2) AS total,
                COUNT(*)::int AS deal_count
         FROM commissions
         WHERE agent_id = $1 AND deal_time >= NOW() - interval '14 days'
         GROUP BY day ORDER BY day`,
        [req.user.id]
      ),
      // Top 5 clients by lots (viewer's direct + subtree clients)
      pool.query(
        `SELECT cl.id AS client_id, cl.name AS client_name,
                SUM(c.lots)::numeric(14,2)       AS lots,
                SUM(c.amount)::numeric(14,2)     AS earnings,
                COUNT(*)::int                     AS deal_count
         FROM commissions c
         JOIN clients cl ON cl.id = c.client_id
         WHERE c.agent_id = $1
           AND c.deal_time >= date_trunc('month', NOW())
         GROUP BY cl.id, cl.name
         ORDER BY lots DESC
         LIMIT 5`,
        [req.user.id]
      ),
      // Pipeline funnel — stage counts of direct-referral clients (excluding sub-agents)
      pool.query(
        `SELECT pipeline_stage, COUNT(*)::int AS n
         FROM clients
         WHERE referred_by_agent_id = $1
           AND contact_type = 'individual'
         GROUP BY pipeline_stage`,
        [lcid]
      ),
      // Sub-agent leaderboard — viewer's DIRECT sub-agents ranked by monthly earnings
      // (explicit ::uuid casts so Postgres can plan the LEFT JOIN ON clause correctly)
      pool.query(
        `SELECT sa.id AS agent_id, sa.name AS agent_name, sa.email,
                COALESCE(SUM(c.amount), 0)::numeric(14,2) AS monthly_total,
                COUNT(c.id)::int                           AS monthly_deals
         FROM users sa
         LEFT JOIN commissions c
           ON c.agent_id = $1::uuid
          AND c.source_agent_id = sa.id
          AND c.deal_time >= date_trunc('month', NOW())
         WHERE sa.parent_agent_id = $1::uuid AND sa.is_agent = true AND sa.is_active = true
         GROUP BY sa.id, sa.name, sa.email
         ORDER BY monthly_total DESC`,
        [req.user.id]
      ),
    ]);

    // Build a 14-day window filled with zeros for days with no deals (cleaner chart)
    const dailySeries = [];
    const byDay = new Map(earningsDaily.map(r => [new Date(r.day).toISOString().slice(0, 10), r]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      dailySeries.push({
        day: key,
        commission: Number(row?.commission || 0),
        rebate:     Number(row?.rebate || 0),
        total:      Number(row?.total || 0),
        deal_count: Number(row?.deal_count || 0),
      });
    }

    // Canonical funnel stages — always return all 5 even if some are zero
    const funnelMap = Object.fromEntries(pipelineFunnel.map(r => [r.pipeline_stage, r.n]));
    const funnel = ['Lead', 'Contacted', 'Funded', 'Active', 'Churned'].map(stage => ({
      stage, count: Number(funnelMap[stage] || 0),
    }));

    res.json({
      clients_count:           downline?.clients_count ?? 0,
      leads_count:             downline?.leads_count ?? 0,
      individuals_count:       downline?.individuals_count ?? 0,
      sub_agents_count:        downline?.subagents_count ?? 0,
      clients_with_mt5:        tradingRow?.clients_with_mt5 ?? 0,
      trading_accounts_count:  tradingRow?.total_mt5_accounts ?? 0,
      funded_clients_count:    tradingRow?.funded_clients_count ?? 0,
      commission_this_week: {
        amount:    Number(commW?.total ?? 0),
        deal_count: commW?.deal_count ?? 0,
      },
      commission_this_month: {
        amount:    Number(commM?.total ?? 0),
        deal_count: commM?.deal_count ?? 0,
      },
      commission_last_month: {
        amount:     Number(commLastMonth?.total ?? 0),
        commission: Number(commLastMonth?.commission ?? 0),
        rebate:     Number(commLastMonth?.rebate ?? 0),
        deal_count: commLastMonth?.deal_count ?? 0,
      },
      subtree_agent_count:   subTreeRow?.subtree_agent_count ?? 0,
      subtree_clients_count: subTreeRow?.subtree_clients_count ?? 0,
      subtree_mt5_count:     subTreeRow?.subtree_mt5_count ?? 0,
      parent_name: me.parent_name || null,
      // New sections — fuel the richer Dashboard
      earnings_daily: dailySeries,
      top_clients:    topClients.map(r => ({
        client_id: r.client_id,
        client_name: r.client_name,
        lots: Number(r.lots),
        earnings: Number(r.earnings),
        deal_count: r.deal_count,
      })),
      pipeline_funnel: funnel,
      sub_agent_leaderboard: subAgentLeaders.map(r => ({
        agent_id: r.agent_id,
        name: r.agent_name,
        email: r.email,
        monthly_total: Number(r.monthly_total),
        monthly_deals: r.monthly_deals,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
