/**
 * Branch Hierarchy Refresh Scheduler
 *
 * Periodically calls /api/agent-hierarchy for each branch we've imported
 * agents from, and walks the response tree to upsert any new agents,
 * clients, leads, and MT5 logins.
 *
 * This replaces the legacy /api/contacts page-1 poll for catching new
 * arrivals — the hierarchy endpoint is more comprehensive (also catches
 * new SUB-AGENTS and new MT5 logins on existing clients in one shot).
 *
 * Configuration (env vars):
 *   ENABLE_BRANCH_HIERARCHY_POLL   'true' to enable (default true)
 *   BRANCH_HIERARCHY_INTERVAL_MIN  minutes between full passes (default 30)
 *   BRANCH_HIERARCHY_DELAY_MIN     boot warm-up delay (default 7)
 *
 * Single in-flight tick guard. All calls funnel through the CRM gate
 * (kill switch / rate / budget / circuit breaker).
 */
import pool from '../db/pool.js';
import { syncBranchHierarchy } from './agentHierarchySync.js';
import { CrmPausedError, CrmBudgetExceededError } from './crmGate.js';

const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_DELAY_MIN    = 7;

let tickRunning = false;

async function getImportedBranches() {
  // Find every distinct branch represented by an imported agent (users.is_agent=true).
  // Includes the branch _id (CRM mongo id) so we can pass it to /api/agent-hierarchy.
  const { rows } = await pool.query(
    `SELECT DISTINCT b.source_id AS branch_id, c.branch AS branch_name
       FROM users u
       JOIN clients c ON c.id = u.linked_client_id
       JOIN branches b ON b.name = c.branch
      WHERE u.is_agent = true
        AND u.is_active = true
        AND b.source_id IS NOT NULL`
  );
  return rows;
}

async function runOnce() {
  if (tickRunning) {
    console.log('[BranchHierPoll] tick skipped — previous tick still running');
    return;
  }
  tickRunning = true;
  const start = Date.now();
  const summary = {
    branchesScanned: 0,
    agentsCreated: 0,
    agentsUpdated: 0,
    clientsUpserted: 0,
    leadsUpserted: 0,
    loginsStubbed: 0,
    productMappingsFetched: 0,
    aborted: false,
    abortReason: null,
  };

  try {
    const branches = await getImportedBranches();
    if (branches.length === 0) {
      console.log('[BranchHierPoll] no imported branches yet — nothing to refresh');
      return;
    }

    for (const b of branches) {
      try {
        const r = await syncBranchHierarchy({ branchId: b.branch_id, branchName: b.branch_name });
        summary.branchesScanned++;
        summary.agentsCreated     += r.agentsCreated     || 0;
        summary.agentsUpdated     += r.agentsUpdated     || 0;
        summary.clientsUpserted   += r.clientsUpserted   || 0;
        summary.leadsUpserted     += r.leadsUpserted     || 0;
        summary.loginsStubbed     += r.loginsStubbed     || 0;
        summary.productMappingsFetched += r.productMappingsFetched || 0;
        if (r.aborted) {
          summary.aborted = true;
          summary.abortReason = r.abortReason;
          // Don't continue scanning more branches if budget/kill triggered
          if (/budget|paused|circuit/i.test(r.abortReason || '')) {
            console.warn(`[BranchHierPoll] aborting tick — ${r.abortReason}`);
            break;
          }
        }
      } catch (err) {
        if (err instanceof CrmPausedError || err instanceof CrmBudgetExceededError) {
          summary.aborted = true;
          summary.abortReason = err.message;
          break;
        }
        console.error(`[BranchHierPoll] branch ${b.branch_name} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[BranchHierPoll] tick failed:', err.message);
  } finally {
    tickRunning = false;
    summary.durationMs = Date.now() - start;
    console.log('[BranchHierPoll] tick done:', summary);
  }
}

export function startBranchHierarchyScheduler({
  intervalMin = DEFAULT_INTERVAL_MIN,
  delayMin    = DEFAULT_DELAY_MIN,
} = {}) {
  const enabled = String(process.env.ENABLE_BRANCH_HIERARCHY_POLL || 'true').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[BranchHierPoll] disabled (set ENABLE_BRANCH_HIERARCHY_POLL=true to enable)');
    return;
  }

  const effectiveInterval = Math.max(5,
    Number(process.env.BRANCH_HIERARCHY_INTERVAL_MIN) || intervalMin
  );
  const effectiveDelay = Math.max(0,
    Number(process.env.BRANCH_HIERARCHY_DELAY_MIN) || delayMin
  );

  const intervalMs = effectiveInterval * 60 * 1000;
  const delayMs    = effectiveDelay    * 60 * 1000;

  console.log(
    `[BranchHierPoll] Scheduler starting — interval=${effectiveInterval}min, ` +
    `first run in ${effectiveDelay}min`
  );

  setTimeout(() => {
    runOnce().catch(err => console.error('[BranchHierPoll] first run failed:', err.message));
    setInterval(() => {
      runOnce().catch(err => console.error('[BranchHierPoll] scheduled run failed:', err.message));
    }, intervalMs).unref();
  }, delayMs).unref();
}
