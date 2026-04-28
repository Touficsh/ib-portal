/**
 * DB housekeeping — scheduled pruning of append-only tables.
 *
 * Why: commission_engine_jobs grows ~1,600 rows per cycle and cycles run every
 * 15 min when scheduled. After a week that's 100k+ rows. Queries that scan
 * this table (like the MT5 Sync Health page's "recent failures" lookup) slow
 * down proportionally, and the table contributes to Supabase egress and
 * storage usage.
 *
 * Strategy:
 *   - commission_engine_jobs: keep last 7 days of job rows. Older jobs are
 *     delete (their parent cycle row survives for cycle-level audit).
 *   - commission_engine_cycles: keep last 30 days.
 *   - activity_log: keep last 90 days (user-facing timeline past 3 months
 *     isn't useful in the portal UI).
 *   - audit_log: keep last 180 days (compliance-ish — keep longer).
 *
 * Cheap: just DELETE WHERE finished_at < NOW() - INTERVAL 'X days'. No joins.
 *
 * Runs once daily at boot + 5min, then every 24h. Also exposed as a one-shot
 * for admin-triggered cleanup.
 */
import pool from '../db/pool.js';

const DAILY_MS = 24 * 60 * 60 * 1000;

export async function runHousekeeping() {
  const start = Date.now();
  const summary = {};
  try {
    // Jobs older than 7 days — the main offender. Dead/failed jobs have
    // typically been investigated by then; succeeded jobs are never needed
    // again once their cycle has a summary row.
    const r1 = await pool.query(
      `DELETE FROM commission_engine_jobs
       WHERE cycle_id IN (
         SELECT id FROM commission_engine_cycles
         WHERE finished_at IS NOT NULL AND finished_at < NOW() - INTERVAL '7 days'
       )`
    );
    summary.engine_jobs_deleted = r1.rowCount;

    // Cycles older than 30 days
    const r2 = await pool.query(
      `DELETE FROM commission_engine_cycles
       WHERE finished_at IS NOT NULL AND finished_at < NOW() - INTERVAL '30 days'`
    );
    summary.engine_cycles_deleted = r2.rowCount;

    // Activity log older than 90 days (portal UI only shows "recent" anyway)
    const r3 = await pool.query(
      `DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    summary.activity_log_deleted = r3.rowCount;

    // Audit log older than 180 days (keep longer for compliance)
    const r4 = await pool.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '180 days'`
    );
    summary.audit_log_deleted = r4.rowCount;

    summary.duration_ms = Date.now() - start;
    summary.ok = true;
    console.log('[housekeeping] done:', summary);
  } catch (err) {
    summary.ok = false;
    summary.error = err.message;
    summary.duration_ms = Date.now() - start;
    console.error('[housekeeping] failed:', err.message);
  }
  return summary;
}

// setInterval handle so we can cancel cleanly on shutdown / tests
let intervalId = null;

/**
 * Start the daily housekeeping scheduler. First run happens 5 min after boot
 * (avoid racing with migrations / autosync), then every 24h.
 */
export function startHousekeepingScheduler() {
  if (intervalId) return;
  setTimeout(() => runHousekeeping(), 5 * 60 * 1000);
  intervalId = setInterval(() => runHousekeeping(), DAILY_MS);
  console.log('[housekeeping] scheduler started — first run in 5 min, then every 24h');
}

export function stopHousekeepingScheduler() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
