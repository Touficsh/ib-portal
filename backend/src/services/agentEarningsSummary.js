/**
 * Agent Earnings Summary — pre-aggregated per-(agent, month) rollup.
 *
 * The `commissions` table grows ~2K rows/day. Any view that aggregates
 * earnings by agent (Commission Tree, top-earner lists, Summary page, monthly
 * digest emails later) would scan the full table without this rollup.
 *
 * Maintenance strategy: refreshed incrementally by the commission engine
 * after each cycle, scoped to the (agent_id, period_month) pairs that the
 * cycle actually wrote new rows for. Full rebuild lives in
 * db/seedAgentEarningsSummary.mjs and only runs on initial setup or after
 * a historical commissions edit.
 *
 * Exports:
 *   refreshForAgentMonths(pairs)   — upsert N (agent_id, period_month) rollups
 *   refreshForAgents(agentIds)     — refresh all months for these agents
 *   reconcileRecent(monthsBack=3)  — full recompute over the last N months
 *                                     (safety net against drift)
 */
import pool from '../db/pool.js';

/**
 * Aggregate one (agent_id, period_month) pair from commissions → upsert the
 * rollup row. Called in bulk from refreshForAgentMonths so the overhead of
 * setup/round-trip happens once.
 *
 * `pairs` is an array of { agent_id, period_month } where period_month is a
 * Date or ISO string whose first-of-month we care about.
 */
export async function refreshForAgentMonths(pairs) {
  if (!pairs || pairs.length === 0) return { upserted: 0 };

  // Deduplicate — same (agent, month) should only be computed once even if
  // multiple deals in the same cycle contributed.
  const uniq = new Map();
  for (const p of pairs) {
    if (!p?.agent_id || !p?.period_month) continue;
    const monthStart = new Date(p.period_month);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const key = `${p.agent_id}|${monthStart.toISOString().slice(0, 10)}`;
    uniq.set(key, { agent_id: p.agent_id, period_month: monthStart });
  }
  const work = [...uniq.values()];

  // One multi-row aggregate query — Postgres groups per (agent, month)
  // internally, no loop needed on our side. The UNNEST builds the work set
  // as a CTE so the JOIN with commissions only scans the relevant slices.
  const agentIds  = work.map(w => w.agent_id);
  const monthISOs = work.map(w => w.period_month.toISOString().slice(0, 10));

  const { rowCount } = await pool.query(
    `WITH pairs AS (
       SELECT agent_id::uuid, period_month::date
       FROM UNNEST($1::uuid[], $2::date[]) AS t(agent_id, period_month)
     ),
     agg AS (
       SELECT
         p.agent_id,
         p.period_month,
         COALESCE(SUM(c.commission_amount), 0)::numeric(14,2)  AS commission_amount,
         COALESCE(SUM(c.rebate_amount),     0)::numeric(14,2)  AS rebate_amount,
         COALESCE(SUM(c.amount),            0)::numeric(14,2)  AS total_amount,
         COUNT(c.id)::int                                      AS deal_count,
         COALESCE(SUM(c.lots), 0)::numeric(14,4)               AS lots_total,
         COUNT(DISTINCT c.client_id)::int                      AS client_count
       FROM pairs p
       LEFT JOIN commissions c
         ON c.agent_id = p.agent_id
        AND date_trunc('month', c.deal_time)::date = p.period_month
       GROUP BY p.agent_id, p.period_month
     )
     INSERT INTO agent_earnings_summary
       (agent_id, period_month, commission_amount, rebate_amount, total_amount,
        deal_count, lots_total, client_count, updated_at)
     SELECT agent_id, period_month, commission_amount, rebate_amount, total_amount,
            deal_count, lots_total, client_count, NOW()
     FROM agg
     ON CONFLICT (agent_id, period_month) DO UPDATE SET
       commission_amount = EXCLUDED.commission_amount,
       rebate_amount     = EXCLUDED.rebate_amount,
       total_amount      = EXCLUDED.total_amount,
       deal_count        = EXCLUDED.deal_count,
       lots_total        = EXCLUDED.lots_total,
       client_count      = EXCLUDED.client_count,
       updated_at        = NOW()`,
    [agentIds, monthISOs]
  );

  return { upserted: rowCount };
}

/**
 * Refresh ALL months for a list of agents. Used when a rate change happens
 * retroactively and every historical month could be affected.
 */
export async function refreshForAgents(agentIds) {
  if (!agentIds || agentIds.length === 0) return { upserted: 0 };

  // Find every (agent, month) pair that has commission rows for these agents.
  const { rows: pairs } = await pool.query(
    `SELECT DISTINCT agent_id, date_trunc('month', deal_time)::date AS period_month
     FROM commissions
     WHERE agent_id = ANY($1)`,
    [agentIds]
  );
  return refreshForAgentMonths(pairs);
}

/**
 * Safety net — recompute the most recent N months (default 3) for every
 * agent that has commissions in that window. Catches drift caused by late
 * deal writes, manual SQL edits, or engine bugs. Cheap: ~706 agents × 3
 * months = 2,118 upserts.
 *
 * Recommend running nightly from housekeeping.
 */
export async function reconcileRecent(monthsBack = 3) {
  const { rows: pairs } = await pool.query(
    `SELECT DISTINCT agent_id, date_trunc('month', deal_time)::date AS period_month
     FROM commissions
     WHERE deal_time >= date_trunc('month', NOW() - ($1 || ' months')::interval)`,
    [String(monthsBack)]
  );
  return refreshForAgentMonths(pairs);
}
