/**
 * Retroactive commission recompute for Paul Matar branch.
 *
 * Re-runs computeWaterfallRows for every deal under Paul Matar's subtree
 * (60 agents, 764 clients) over the full date range that has commissions
 * (2026-03-01 → yesterday, clamped by recomputeForAgent's safety net).
 *
 * Engine change being applied retroactively:
 *   - Removed the legacy `agent_products.rate_per_lot` fallback.
 *   - Agents with no CRM commission row now earn $0 instead of the
 *     fallback rate.
 *
 * Usage:
 *   node sync/recompute-paul-matar.js              → DRY RUN (preview only)
 *   node sync/recompute-paul-matar.js --commit     → LIVE (delete + reinsert)
 *
 * The dry-run prints aggregated deltas so the admin can see how much the
 * branch's commission total will shift before committing.
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { recomputeForAgent } from '../src/services/commissionEngine.js';

const PAUL_MATAR_USER_ID = '20dcdeb6-4c0d-46b1-8ce9-53ffc37ca1d4';
const DRY_RUN = !process.argv.includes('--commit');

async function main() {
  console.log(`[Recompute] Paul Matar branch — mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (WILL WRITE)'}`);

  // Date range — full history of commission rows in the branch
  const { rows: [range] } = await pool.query(`
    WITH RECURSIVE st AS (
      SELECT id FROM users WHERE id = $1
      UNION ALL
      SELECT u.id FROM users u JOIN st ON u.parent_agent_id = st.id WHERE u.is_agent = true
    )
    SELECT MIN(deal_time)::date AS earliest, MAX(deal_time)::date AS latest
      FROM commissions WHERE agent_id IN (SELECT id FROM st)
  `, [PAUL_MATAR_USER_ID]);

  const from = range.earliest ? range.earliest.toISOString().slice(0, 10) : '2026-01-01';
  const to   = (range.latest  ? range.latest  : new Date()).toISOString ? (range.latest || new Date()).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  console.log(`[Recompute] Window: ${from} → ${to}`);

  // recomputeForAgent's recursive subtree query covers Paul + all descendants
  // in one pass. computeWaterfallRows produces a row PER ancestor in the chain
  // and the function filters to "rows whose agent_id matches the caller" —
  // meaning each agent's L1/L2/L3+ commission rows are only re-written when
  // recomputeForAgent is called for THAT agent. So we still loop over all 60
  // agents, but each call should NOW return work (the schema bug is fixed).
  const { rows: agents } = await pool.query(`
    WITH RECURSIVE st AS (
      SELECT id, name FROM users WHERE id = $1
      UNION ALL
      SELECT u.id, u.name FROM users u JOIN st ON u.parent_agent_id = st.id WHERE u.is_agent = true
    )
    SELECT id, name FROM st ORDER BY name
  `, [PAUL_MATAR_USER_ID]);
  console.log(`[Recompute] Agents in subtree: ${agents.length}`);

  const totals = {
    agents_processed: 0,
    deals_scanned: 0,
    rows_previewed: 0,
    rows_deleted: 0,
    rows_inserted: 0,
    errors: 0,
    deltaSum: 0,
  };

  let i = 0;
  for (const a of agents) {
    i++;
    try {
      const s = await recomputeForAgent(a.id, from, to, { dryRun: DRY_RUN });
      totals.agents_processed++;
      totals.deals_scanned  += s.deals_scanned || 0;
      totals.rows_previewed += s.rows_previewed || 0;
      totals.rows_deleted   += s.rows_deleted || 0;
      totals.rows_inserted  += s.rows_inserted || 0;
      totals.errors         += s.errors || 0;
      // Sum the dollar delta from preview rows (dry-run only)
      if (DRY_RUN && Array.isArray(s.preview)) {
        for (const p of s.preview) {
          if (p.delta != null) totals.deltaSum += Number(p.delta);
        }
      }
      if (i % 10 === 0 || i === agents.length) {
        console.log(`[Recompute] ${i}/${agents.length} — ${a.name.padEnd(35)} totals:`, {
          ...totals,
          deltaSum: Number(totals.deltaSum.toFixed(2)),
        });
      }
    } catch (err) {
      totals.errors++;
      console.error(`[Recompute] FAIL ${a.name}:`, err?.message);
    }
  }

  console.log('');
  console.log('[Recompute] DONE. Final summary:', totals);

  // Quick before/after sanity sum
  const { rows: [after] } = await pool.query(`
    WITH RECURSIVE st AS (
      SELECT id FROM users WHERE id = $1
      UNION ALL
      SELECT u.id FROM users u JOIN st ON u.parent_agent_id = st.id WHERE u.is_agent = true
    )
    SELECT COUNT(*)::int AS rows, COALESCE(SUM(amount),0)::numeric(14,2) AS total
      FROM commissions WHERE agent_id IN (SELECT id FROM st)
  `, [PAUL_MATAR_USER_ID]);
  console.log(`[Recompute] DB state for Paul Matar subtree now: ${after.rows} rows, total $${after.total}`);

  await pool.end();
}

main().catch(err => {
  console.error('[Recompute] FATAL:', err);
  process.exit(1);
});
