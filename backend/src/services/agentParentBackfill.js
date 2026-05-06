/**
 * Agent Parent Backfill
 *
 * Reconciles the parent-link gap caused by an old guard in autoSync.js that
 * skipped setting referred_by_agent_id whenever the contact itself was an
 * agent. As of the patch the guard is removed, so going forward syncs will be
 * correct — but the 1,003 existing agent rows with NULL parents still need a
 * one-shot repair.
 *
 * For each agent-type clients row without a parent link:
 *   1. GET /api/contacts/:id from x-dev's CRM
 *   2. Read clientProfile.basicInfo.connectedAgent.id
 *   3. If the parent row exists in clients → UPDATE referred_by_agent_id
 *   4. If the parent row is missing → fetch and auto-create it, then link
 *   5. Skip self-reference (CRM sometimes points an agent at itself)
 *
 * After the referred_by_agent_id column is filled, re-wire the portal side:
 *   For every imported users row (is_agent=true, linked_client_id IS NOT NULL),
 *   set parent_agent_id = the users.id of the linked_client's parent, if any.
 *   This turns the flat top-level import into a real tree.
 *
 * Exports:
 *   backfillAgentParents()  — runs both steps, returns a summary
 */
import pool from '../db/pool.js';
import { getCrmConfig } from './crmConfig.js';
import { crmRequest, CrmPausedError } from './crmGate.js';
import { bustPermissionCache } from './permissions.js';

const CONCURRENCY = 10;

/**
 * Fetch one contact from x-dev and upsert into `clients` as a minimal agent row.
 * Only called when a parent referenced by another agent is missing locally.
 * Returns true if created/adopted, false on failure.
 */
async function ensureAgentExists(clientId, _baseUrl, _apiKey) {
  try {
    // Already exists? nothing to do.
    const existing = await pool.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (existing.rows.length > 0) return true;

    let d;
    try {
      d = await crmRequest(`/api/contacts/${clientId}`, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      if (err instanceof CrmPausedError) throw err;
      return false;
    }
    const bi = d?.clientProfile?.basicInfo;
    if (!bi || !bi.profileId) return false;

    const email = bi.emails?.[0]?.email || bi.email || null;
    const phone = bi.phoneNumbers?.[0]?.number || null;
    const branch = bi.branch?.name || null;

    await pool.query(
      `INSERT INTO clients (id, contact_type, name, email, phone, pipeline_stage,
         branch, is_verified, is_trader, crm_profile_type, created_at, updated_at)
       VALUES ($1, 'agent', $2, $3, $4, 'Active', $5, true, false, 'agent', $6, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        bi.profileId,
        bi.name || 'Agent',
        email,
        phone,
        branch,
        bi.registrationDate || new Date().toISOString(),
      ]
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Main backfill operation. Idempotent; safe to run multiple times.
 */
/**
 * Options:
 *   - agentIds: string[]  → only backfill these portal user IDs (post-import
 *                            use case). Scoped mode — costs 1 CRM call per ID,
 *                            not the full 300-agent broad sweep.
 *   - clientIds: string[] → alternate scope: CRM contact (client) IDs to check
 *   - maxPerCall: number  → cap in broad-sweep mode (default 300)
 *
 * With no options: broad sweep mode — picks up to 300 agents prioritized by
 * missing parent link. Use this for the "Backfill parents" admin button or
 * scheduled health-check runs.
 */
export async function backfillAgentParents({ agentIds = null, clientIds = null, maxPerCall = 300 } = {}) {
  const start = Date.now();
  const summary = {
    agents_scanned: 0,
    crm_hits: 0,
    already_correct: 0,
    parents_set: 0,
    self_refs_skipped: 0,
    parent_auto_created: 0,
    parent_missing: 0,
    errors: 0,
    portal_agents_rewired: 0,
    scope: agentIds ? 'scoped_by_user_ids' : clientIds ? 'scoped_by_client_ids' : 'broad_sweep',
  };

  // Sanity-check CRM is configured before firing thousands of calls through
  // the gate. Gate itself reads config each request so we don't pass these
  // values through anymore.
  const { apiKey } = await getCrmConfig();
  if (!apiKey) throw new Error('CRM API key not configured');

  // Resolve the set of CRM contact IDs we need to query.
  // Three modes:
  //   1. agentIds (portal user IDs)  → resolve to linked_client_id, then query CRM per client
  //   2. clientIds (CRM contact IDs) → use directly
  //   3. default                      → broad sweep of all agent-type contacts, prioritized
  let agents;
  if (Array.isArray(agentIds) && agentIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT c.id, c.referred_by_agent_id
       FROM users u JOIN clients c ON c.id = u.linked_client_id
       WHERE u.id = ANY($1::uuid[]) AND u.is_agent = true`,
      [agentIds]
    );
    agents = rows;
  } else if (Array.isArray(clientIds) && clientIds.length > 0) {
    // clients.id is VARCHAR (CRM Mongo IDs), not UUID — cast accordingly.
    const { rows } = await pool.query(
      `SELECT id, referred_by_agent_id FROM clients
       WHERE id = ANY($1::varchar[]) AND contact_type = 'agent'`,
      [clientIds]
    );
    agents = rows;
  } else {
    // Broad sweep — existing behavior (capped, prioritized by missing parent)
    const { rows } = await pool.query(
      `SELECT id, referred_by_agent_id FROM clients WHERE contact_type = 'agent'
       ORDER BY
         CASE WHEN referred_by_agent_id IS NULL THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT $1`,
      [maxPerCall]
    );
    agents = rows;
    summary.capped_at = maxPerCall;
  }
  summary.agents_scanned = agents.length;

  async function fixOne(a) {
    try {
      let d;
      try {
        d = await crmRequest(`/api/contacts/${a.id}`, { signal: AbortSignal.timeout(8000) });
      } catch (err) {
        if (err instanceof CrmPausedError) throw err;
        return;
      }
      const ca = d?.clientProfile?.basicInfo?.connectedAgent;
      const parentId = ca?.id || ca?._id;
      summary.crm_hits++;

      if (!parentId) return;                                  // CRM says no parent
      if (parentId === a.id) { summary.self_refs_skipped++; return; }
      if (parentId === a.referred_by_agent_id) { summary.already_correct++; return; }

      // Ensure parent exists in our mirror (auto-create if missing)
      const parentOk = await ensureAgentExists(parentId);
      if (!parentOk) { summary.parent_missing++; return; }
      if (!a.referred_by_agent_id) {
        // Track whether we just fetched + inserted the parent fresh
        const { rows: [chk] } = await pool.query(
          'SELECT created_at, updated_at FROM clients WHERE id = $1',
          [parentId]
        );
        if (chk && chk.created_at && (Date.now() - new Date(chk.created_at).getTime() < 60_000)) {
          summary.parent_auto_created++;
        }
      }

      await pool.query(
        `UPDATE clients SET referred_by_agent_id = $1, updated_at = NOW() WHERE id = $2`,
        [parentId, a.id]
      );
      summary.parents_set++;
    } catch (err) {
      summary.errors++;
    }
  }

  // Worker pool
  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = idx++;
        if (i >= agents.length) break;
        await fixOne(agents[i]);
      }
    })
  );

  // ── Portal side: rewire users.parent_agent_id now that referred_by is correct ──
  const { rows: importedAgents } = await pool.query(
    `SELECT u.id AS user_id, u.linked_client_id, u.parent_agent_id,
            c.referred_by_agent_id
     FROM users u
     JOIN clients c ON c.id = u.linked_client_id
     WHERE u.is_agent = true AND u.linked_client_id IS NOT NULL`
  );
  // Build lookup: client_id → imported user_id
  const userByClient = new Map(
    importedAgents.map(r => [r.linked_client_id, r.user_id])
  );

  for (const ia of importedAgents) {
    const crmParentClientId = ia.referred_by_agent_id;
    const targetUserId = crmParentClientId ? userByClient.get(crmParentClientId) || null : null;

    if ((targetUserId || null) !== (ia.parent_agent_id || null)) {
      await pool.query(
        `UPDATE users SET parent_agent_id = $1, updated_at = NOW() WHERE id = $2`,
        [targetUserId, ia.user_id]
      );
      bustPermissionCache(ia.user_id);
      summary.portal_agents_rewired++;
    }
  }

  summary.durationMs = Date.now() - start;
  console.log('[AgentParentBackfill] done:', summary);
  return summary;
}
