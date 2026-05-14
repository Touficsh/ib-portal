/**
 * Sequential MT5 deal-data backfill — for every agent in the portal that has
 * trading_accounts_meta rows lacking mt5_synced_at (i.e. logins we know about
 * but have never pulled deals for), fetch their deals from the local MT5
 * bridge.
 *
 * IMPORTANT: this script talks to the LOCAL MT5 bridge (and the broker's MT5
 * server). It does NOT call xdev CRM. Zero CRM impact.
 *
 * Sequential: one agent at a time, awaits each before starting the next, so
 * the bridge isn't asked to multiplex requests on top of its real-time deal
 * stream.
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { syncForAgent as syncSnapshotsForAgent } from '../src/services/mt5SnapshotSync.js';

async function main() {
  const { rows: agents } = await pool.query(`
    SELECT DISTINCT u.id as user_id, u.name,
           COUNT(tam.login)::int as pending_logins
      FROM users u
      JOIN clients c ON c.agent_id = u.id
      JOIN trading_accounts_meta tam ON tam.client_id = c.id
     WHERE u.is_agent = true
       AND tam.mt5_synced_at IS NULL
     GROUP BY u.id, u.name
     ORDER BY u.name
  `);
  console.log(`[MT5 Backfill] Agents needing first-time MT5 sync: ${agents.length}`);
  console.log(`[MT5 Backfill] Total logins to fetch: ${agents.reduce((s, a) => s + a.pending_logins, 0)}`);

  const total = {
    agentsProcessed: 0,
    loginsSynced:    0,
    loginsFailed:    0,
    enginesTriggered: 0,
    errors:          0,
  };

  let i = 0;
  for (const a of agents) {
    i++;
    try {
      const s = await syncSnapshotsForAgent(a.user_id, {
        maxAgeMinutes: 0,        // ignored when onlyMissing=true
        onlyMissing:   true,     // only fetch logins with mt5_synced_at IS NULL
      });
      total.agentsProcessed++;
      total.loginsSynced += (s.logins_synced || 0);
      total.loginsFailed += (s.logins_failed || 0);
      if (i % 10 === 0) {
        console.log(`[MT5 Backfill] ${i}/${agents.length} — ${a.name} +${s.logins_synced || 0} logins · running totals:`, total);
      }
    } catch (err) {
      total.errors++;
      console.error(`[MT5 Backfill] FAIL ${a.name} (${a.user_id}):`, err?.message);
    }
  }

  console.log('[MT5 Backfill] DONE. Final:', total);
  await pool.end();
}

main().catch((err) => {
  console.error('[MT5 Backfill] FATAL:', err);
  process.exit(1);
});
