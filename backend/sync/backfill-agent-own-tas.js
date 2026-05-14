/**
 * One-time backfill: for every agent in the portal that has zero downline
 * clients, fetch their personal MT5 logins from xdev via
 * /api/contacts/:agentId/trading-accounts and stub them so commissions on
 * those logins flow back to the agent himself.
 *
 * Safe to re-run. Per-agent failures are non-fatal. All calls go through the
 * standard CRM gate (rate limit, daily budget, circuit breaker).
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { syncAgentOwnTradingAccounts } from '../src/services/agentHierarchySync.js';

const SCOPE = process.argv.includes('--all')            ? 'all'
            : process.argv.includes('--missing')        ? 'missing'
            : process.argv.includes('--with-downlines') ? 'with-downlines'
            : 'zero-downline';

async function main() {
  let sql;
  if (SCOPE === 'all') {
    sql = `SELECT u.id as user_id, u.linked_client_id as crm_id, u.name
             FROM users u
            WHERE u.is_agent = true
              AND u.linked_client_id IS NOT NULL
            ORDER BY u.name`;
  } else if (SCOPE === 'with-downlines') {
    // Agents who HAVE downline clients but were never probed for their own
    // personal trading accounts. The original "zero-downline" backfill
    // skipped these because the focus was empty agents.
    sql = `SELECT u.id as user_id, u.linked_client_id as crm_id, u.name
             FROM users u
            WHERE u.is_agent = true
              AND u.linked_client_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM clients c WHERE c.agent_id = u.id AND c.id <> u.linked_client_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM trading_accounts_meta tam WHERE tam.client_id = u.linked_client_id
              )
            ORDER BY u.name`;
  } else if (SCOPE === 'missing') {
    // Catch agents that should have been in a previous backfill but ended up
    // with zero trading_accounts_meta rows on their contact. Idempotent —
    // re-runs are protected by the 24h freshness window inside crmGate.
    sql = `SELECT u.id as user_id, u.linked_client_id as crm_id, u.name
             FROM users u
            WHERE u.is_agent = true
              AND u.linked_client_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM clients c WHERE c.agent_id = u.id AND c.id <> u.linked_client_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM trading_accounts_meta tam WHERE tam.client_id = u.linked_client_id
              )
            ORDER BY u.name`;
  } else {
    sql = `SELECT u.id as user_id, u.linked_client_id as crm_id, u.name
             FROM users u
            WHERE u.is_agent = true
              AND u.linked_client_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM clients c
                 WHERE c.agent_id = u.id
                   AND c.id <> u.linked_client_id
              )
            ORDER BY u.name`;
  }

  const { rows: agents } = await pool.query(sql);
  console.log(`[Backfill] Scope=${SCOPE}. Agents to process: ${agents.length}`);

  const summary = {
    agentOwnTaFetched:    0,
    agentOwnLoginsStubbed: 0,
    agentOwnTaErrors:     0,
    agentOwnTaSkipped:    0,
  };

  let i = 0;
  for (const a of agents) {
    i++;
    if (i % 25 === 0) {
      console.log(`[Backfill] ${i}/${agents.length} processed — running totals:`, summary);
    }
    try {
      await syncAgentOwnTradingAccounts({
        agentCrmId: a.crm_id,
        agentUserId: a.user_id,
        summary,
      });
    } catch (err) {
      console.error(`[Backfill] FAIL ${a.name} (${a.crm_id}):`, err?.message);
      summary.agentOwnTaErrors++;
    }
  }

  console.log('[Backfill] DONE. Final summary:', summary);
  await pool.end();
}

main().catch((err) => {
  console.error('[Backfill] FATAL:', err);
  process.exit(1);
});
