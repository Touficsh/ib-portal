/**
 * Agent Import Service
 *
 * The existing CRM sync (routes/sync.js) pulls agents from x-dev's CRM API
 * into the `clients` table as rows with contact_type='agent'. Those rows carry
 * the real-world agent identity (name, email, branch, referred_by_agent_id)
 * and drive 15K+ client → agent referral links via clients.referred_by_agent_id.
 *
 * The IB portal built in Phases 1-6 stores agents in the `users` table so they
 * can hold a password + JWT session. This service bridges the two models:
 *
 *   1. Picks the top N client-agents by referral count.
 *   2. Ensures a matching `users` row exists with is_agent=true + linked_client_id.
 *   3. Resolves users.parent_agent_id from the client-agent's referred_by_agent_id
 *      (by following the chain of already-imported parents).
 *   4. Backfills clients.agent_id on all the agent's referred clients so the
 *      portal's "My Clients" view lights up automatically.
 *
 * Idempotent — re-running with a larger limit expands the imported set without
 * duplicating anyone, and recomputes parent links / client backfills for
 * agents that were imported before their parent.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';
import { bustPermissionCache } from './permissions.js';
import { scanCrmAgentProducts } from './agentProductSync.js';
import { ensureSensibleRates } from './rateDefaults.js';
import { getCrmConfig } from './crmConfig.js';
import { crmRequest } from './crmGate.js';
import { upsertTradingAccountMeta } from './tradingAccountMetaSync.js';
import { backfillAgentParents } from './agentParentBackfill.js';

/**
 * Return the top N client-agents by referral count with their import status.
 * Useful for the admin "preview what would be imported" table.
 */
export async function listImportableAgents({ limit = 100, branch = null, onlyPending = false } = {}) {
  const where = [`a.contact_type = 'agent'`];
  const params = [];
  let i = 1;
  if (branch) { where.push(`a.branch = $${i++}`); params.push(branch); }
  if (onlyPending) { where.push(`u.id IS NULL`); }

  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.email, a.phone, a.branch, a.referred_by_agent_id,
            a.created_at,
            (SELECT COUNT(*)::int FROM clients c WHERE c.referred_by_agent_id = a.id) AS referral_count,
            u.id   AS user_id,
            u.is_agent,
            u.is_active AS user_is_active,
            p.name AS parent_agent_name
     FROM clients a
     LEFT JOIN users u ON u.linked_client_id = a.id
     LEFT JOIN clients p ON p.id = a.referred_by_agent_id
     WHERE ${where.join(' AND ')}
     ORDER BY referral_count DESC, a.created_at ASC
     LIMIT $${i}`,
    [...params, limit]
  );
  return rows;
}

/**
 * Branch roll-up — one row per branch with agent counts (total / pending /
 * imported) and top referrer in that branch. Powers the branch-selector
 * UI so admins can bulk-import a branch in one click.
 */
export async function listImportableBranches() {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(a.branch, '(no branch)') AS branch,
       COUNT(*)::int AS total_agents,
       COUNT(*) FILTER (WHERE u.id IS NOT NULL)::int AS imported,
       COUNT(*) FILTER (WHERE u.id IS NULL)::int      AS pending,
       COALESCE(SUM(
         (SELECT COUNT(*)::int FROM clients c WHERE c.referred_by_agent_id = a.id)
       ), 0)::int AS total_referrals
     FROM clients a
     LEFT JOIN users u ON u.linked_client_id = a.id
     WHERE a.contact_type = 'agent'
     GROUP BY a.branch
     ORDER BY total_agents DESC, branch ASC`
  );
  return rows;
}

/**
 * Generate a safe placeholder email for agents with NULL email in the clients
 * table. Uses the client ID so it's stable across re-imports.
 */
function fallbackEmail(clientId) {
  return `agent-${clientId}@portal.local`;
}

/**
 * Import client-agents into the users table. Returns a summary.
 *
 * Two selection modes:
 *  - Top N by referral count (default): `{ limit: 50 }`
 *  - Specific client-agent ids:         `{ clientIds: ['...'] }` (used by the
 *    per-row "Import" action on the AgentDetail Sub-agents section)
 *
 *   { requested, created, updated, parentsLinked, parentsPending,
 *     clientsReassigned, skipped, errors, durationMs }
 */
export async function importAgents({ limit = 50, clientIds } = {}) {
  const start = Date.now();
  const mode = Array.isArray(clientIds) && clientIds.length > 0 ? 'by-ids' : 'top-n';
  const summary = {
    mode,
    requested: mode === 'by-ids' ? clientIds.length : limit,
    created: 0,
    updated: 0,
    parentsLinked: 0,
    parentsPending: 0,  // parent agent wasn't in the imported batch — relink on next run
    clientsReassigned: 0,
    skipped: 0,
    errors: 0,
    productsLinked: 0,        // CRM agent_products rows created for freshly imported users
    ratesAutoSet: 0,          // rate_per_lot bumped from 0 to parent/max default
    mt5LoginsSynced: 0,       // clients updated with mt5_logins during Pass 4
    mt5ClientsNoAccounts: 0,  // clients confirmed to have no MT5 accounts in CRM
  };

  // Look up the 'agent' role id once
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE name = 'agent'`);
  if (!role) throw new Error(`'agent' role not found — run db:migrate first`);

  // ─── Pre-Pass: ensure clients.referred_by_agent_id is populated ─────
  // The recursive CTE below walks parent→child via referred_by_agent_id, but
  // the /api/sync/agents endpoint that populates our mirror doesn't fill that
  // column (the CRM agents-list response omits connectedAgent). So agents in
  // a branch we've never backfilled show up as flat top-level rows, and the
  // CTE finds zero descendants — leaving the imported agent's downline behind.
  //
  // Fix: in by-ids mode, before the subtree walk, find any agent in the same
  // branches as the picked agents that's missing its parent link, and ask
  // backfillAgentParents to fill them by hitting CRM /api/contacts/:id.
  // Capped per call so a fresh branch (Main = 428 agents) doesn't blow the
  // contacts-detail daily budget on a single click — admin can re-Onboard
  // for the rest. Skipped for top-N mode since that scopes by referral count
  // independent of branch.
  let prePassSummary = null;
  if (mode === 'by-ids') {
    try {
      // Find branches represented in the picked clientIds
      const { rows: branchRows } = await pool.query(
        `SELECT DISTINCT branch FROM clients
          WHERE id = ANY($1) AND contact_type = 'agent'`,
        [clientIds]
      );
      const branches = branchRows.map(r => r.branch);
      if (branches.length > 0) {
        // Pick up to 500 agents in those branches whose parent link is NULL.
        // ORDER BY: bias toward the picked agents themselves first, then their
        // potential children (lowest depth = least likely to already be in
        // a chain). 500 is the per-call cap; for Main (~400) it covers the
        // whole branch in one shot.
        // PG `ANY` matches non-null only, so split the predicate to keep
        // both branch=X agents and (if a NULL branch was picked) branch=NULL.
        const hasNull = branches.includes(null);
        const namedBranches = branches.filter(b => b !== null);
        const { rows: needsBackfill } = await pool.query(
          `SELECT id FROM clients
            WHERE contact_type = 'agent'
              AND referred_by_agent_id IS NULL
              AND (branch = ANY($1) OR ($2::boolean AND branch IS NULL))
            ORDER BY (id = ANY($3)) DESC, created_at DESC
            LIMIT 500`,
          [namedBranches, hasNull, clientIds]
        );
        if (needsBackfill.length > 0) {
          prePassSummary = await backfillAgentParents({
            clientIds: needsBackfill.map(r => r.id),
            maxPerCall: 500,
          });
        }
      }
    } catch (err) {
      // Non-fatal — if backfill fails (e.g., CRM paused), the import still
      // works for the picked agents but won't include their downline.
      console.warn('[AgentImport] pre-pass parent backfill failed:', err.message);
      prePassSummary = { error: err.message };
    }
  }
  summary.parent_backfill_prepass = prePassSummary;

  // Resolve pick list either by explicit ids or top-N ranking.
  // For by-ids mode: expand the selection to include the full subtree so that
  // importing an agent also brings in all their descendants automatically.
  const { rows: pickListRaw } = mode === 'by-ids'
    ? await pool.query(
        // Recursive CTE walks the full agent subtree rooted at the requested IDs.
        // Includes agents that are not yet imported (users row missing) AND
        // already-imported agents (so Pass 2 re-evaluates parent links after the
        // new agents are inserted). The outer SELECT adds referral_count.
        `WITH RECURSIVE subtree AS (
           SELECT id, referred_by_agent_id
           FROM clients
           WHERE contact_type = 'agent' AND id = ANY($1)
           UNION ALL
           SELECT c.id, c.referred_by_agent_id
           FROM clients c
           JOIN subtree s ON c.referred_by_agent_id = s.id
           WHERE c.contact_type = 'agent'
         )
         SELECT a.id, a.name, a.email, a.phone, a.referred_by_agent_id,
                (SELECT COUNT(*)::int FROM clients c WHERE c.referred_by_agent_id = a.id) AS referral_count
         FROM clients a
         JOIN subtree st ON st.id = a.id
         ORDER BY referral_count DESC`,
        [clientIds]
      )
    : await pool.query(
    `SELECT a.id, a.name, a.email, a.phone, a.referred_by_agent_id,
            (SELECT COUNT(*)::int FROM clients c WHERE c.referred_by_agent_id = a.id) AS referral_count
     FROM clients a
     WHERE a.contact_type = 'agent'
     ORDER BY referral_count DESC, a.created_at ASC
     LIMIT $1`,
    [limit]
  );
  // Deduplicate (CTE might return duplicates if clientIds overlap in the tree)
  const seenIds = new Set();
  const pickList = pickListRaw.filter(r => { if (seenIds.has(r.id)) return false; seenIds.add(r.id); return true; });

  // Surface the full processed CRM ID set so callers (the /import route) can
  // resolve ALL relevant user.ids — not just the originally clicked agent's.
  // This is what lets the chained contact sync scope to every newly imported
  // agent in the subtree (Hadi + Sophia + Fatima + their kids…), so each
  // agent's referred clients get pulled, not just Hadi's.
  summary.processed_client_ids = pickList.map(r => r.id);

  // Pass 1: upsert each agent into users
  for (const ca of pickList) {
    try {
      const email = (ca.email && ca.email.trim()) || fallbackEmail(ca.id);
      const name = ca.name || `Agent ${ca.id.slice(0, 8)}`;

      // Check if we already imported this client-agent
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE linked_client_id = $1',
        [ca.id]
      );

      let userId;
      if (existing[0]) {
        await pool.query(
          `UPDATE users
             SET name = $1,
                 is_agent = true,
                 role = 'agent',
                 role_id = $2,
                 is_active = true,
                 updated_at = NOW()
           WHERE id = $3`,
          [name, role.id, existing[0].id]
        );
        userId = existing[0].id;
        summary.updated++;
      } else {
        // Avoid UNIQUE(email) collision — if another row (unrelated staff user)
        // already holds this email, fall back to the placeholder.
        const { rows: emailConflict } = await pool.query(
          'SELECT id, linked_client_id FROM users WHERE email = $1',
          [email]
        );
        let safeEmail = email;
        if (emailConflict[0] && emailConflict[0].linked_client_id !== ca.id) {
          safeEmail = fallbackEmail(ca.id);
        }

        // Default first-login password. Shared across all imported agents so
        // the admin has a single credential to hand out. Agents should change
        // it after first login (future enhancement: force-change-on-first-login
        // flag). Configurable via PORTAL_DEFAULT_AGENT_PASSWORD env var — falls
        // back to 'Portal@2026' for a consistent, memorable string.
        const defaultPw = process.env.PORTAL_DEFAULT_AGENT_PASSWORD || 'Portal@2026';
        const hash = await bcrypt.hash(defaultPw, 10);

        const { rows: inserted } = await pool.query(
          `INSERT INTO users (name, email, password_hash, role, role_id, is_agent, linked_client_id)
           VALUES ($1, $2, $3, 'agent', $4, true, $5)
           RETURNING id`,
          [name, safeEmail, hash, role.id, ca.id]
        );
        userId = inserted[0].id;
        summary.created++;
      }
      bustPermissionCache(userId);

      // Pass 1 also stamps clients.agent_id for this agent's referred clients.
      // (Pass 2 handles parent linking once all rows are in place.)
      const { rowCount } = await pool.query(
        `UPDATE clients
           SET agent_id = $1, updated_at = NOW()
           WHERE referred_by_agent_id = $2
             AND (agent_id IS NULL OR agent_id <> $1)`,
        [userId, ca.id]
      );
      summary.clientsReassigned += rowCount;
    } catch (err) {
      console.error('[AgentImport] failed for', ca.id, '-', err.message);
      summary.errors++;
    }
  }

  // Pass 2: resolve parent_agent_id across the full imported set.
  // Done after pass 1 so parent → child ordering doesn't matter.
  for (const ca of pickList) {
    if (!ca.referred_by_agent_id) continue;
    try {
      const { rows: self } = await pool.query(
        'SELECT id FROM users WHERE linked_client_id = $1',
        [ca.id]
      );
      if (!self[0]) continue;

      const { rows: parent } = await pool.query(
        'SELECT id FROM users WHERE linked_client_id = $1 AND is_agent = true',
        [ca.referred_by_agent_id]
      );
      if (parent[0]) {
        // Don't overwrite if already set to the same parent (avoid unnecessary write)
        await pool.query(
          `UPDATE users SET parent_agent_id = $1, updated_at = NOW()
           WHERE id = $2 AND parent_agent_id IS DISTINCT FROM $1`,
          [parent[0].id, self[0].id]
        );
        summary.parentsLinked++;
      } else {
        // Parent wasn't in this batch — they'll be linked when imported next
        summary.parentsPending++;
      }
    } catch (err) {
      console.error('[AgentImport] parent link failed for', ca.id, '-', err.message);
      summary.errors++;
    }
  }

  // Pass 3: link each freshly imported agent to their CRM products AND heal
  // any rate_per_lot=0 rows (set to parent's rate or product max). This
  // eliminates the old two-step flow where admins had to click Import → then
  // Sync Products → then manually edit every rate to something non-zero.
  // Done top-down so children inherit their parent's freshly-set rate in one pass.
  try {
    // Build CRM byAgent map once for the whole batch (single round-trip to CRM)
    const { byAgent } = await scanCrmAgentProducts();

    // Collect { userId, linked_client_id, depth } so we can process top-down.
    const importedUsers = [];
    for (const ca of pickList) {
      const { rows: [u] } = await pool.query(
        'SELECT id, linked_client_id, parent_agent_id FROM users WHERE linked_client_id = $1',
        [ca.id]
      );
      if (u) importedUsers.push(u);
    }

    // Compute each imported user's depth-from-root inside the imported set,
    // so we can process shallowest-first and cascade rates correctly.
    const idToUser = new Map(importedUsers.map(u => [u.id, u]));
    function depthOf(u, seen = new Set()) {
      if (!u || !u.parent_agent_id || seen.has(u.id)) return 0;
      const parent = idToUser.get(u.parent_agent_id);
      if (!parent) return 0;
      seen.add(u.id);
      return 1 + depthOf(parent, seen);
    }
    importedUsers.sort((a, b) => depthOf(a) - depthOf(b));

    // Resolve local products by source_id once
    const { rows: localProducts } = await pool.query(
      `SELECT id, source_id FROM products WHERE source_id IS NOT NULL`
    );
    const productBySourceId = new Map(localProducts.map(p => [p.source_id, p.id]));

    for (const u of importedUsers) {
      const crmLinks = byAgent.get(u.linked_client_id) || [];
      for (const lp of crmLinks) {
        const productId = productBySourceId.get(lp.source_id);
        if (!productId) continue;  // product not yet synced into portal; skip
        try {
          const { rows: [existing] } = await pool.query(
            'SELECT id, source FROM agent_products WHERE agent_id = $1 AND product_id = $2',
            [u.id, productId]
          );
          if (!existing) {
            await pool.query(
              `INSERT INTO agent_products (agent_id, product_id, rate_per_lot, source, is_active)
               VALUES ($1, $2, 0, 'crm', $3)`,
              [u.id, productId, lp.agentActive !== false]
            );
            summary.productsLinked++;
          }
        } catch (err) {
          console.error('[AgentImport] product link failed for', u.id, productId, '-', err.message);
          summary.errors++;
        }
      }

      // Heal rate_per_lot=0 rows now that the products are in place. Because
      // we process top-down, a child's ensureSensibleRates sees the fresh
      // parent rate and inherits it instead of staying at 0.
      try {
        const r = await ensureSensibleRates(u.id);
        summary.ratesAutoSet += r.updated;
      } catch (err) {
        console.error('[AgentImport] rate heal failed for', u.id, '-', err.message);
        summary.errors++;
      }
    }
  } catch (err) {
    console.error('[AgentImport] pass 3 (products + rates) failed:', err.message);
    summary.errors++;
  }

  // Pass 4: sync MT5 logins for every freshly-imported agent's downline. This
  // is what lets the commission engine actually produce rows — without logins,
  // there are no deals to allocate. Done concurrency-8 so a 656-client branch
  // finishes in ~90s instead of ~15min sequentially. Skips clients whose
  // trading_accounts_synced_at is already set (idempotent re-runs are cheap).
  try {
    // Sanity: is CRM configured at all? Gate will re-read per-call, but if
    // the key is missing there's no point entering the loop.
    const { apiKey } = await getCrmConfig();
    if (!apiKey) {
      console.log('[AgentImport] Pass 4 skipped — CRM API key not configured');
      return summary;
    }

    // Gather every client that was just (re)assigned to a freshly-imported
    // agent and hasn't had their trading accounts pulled from CRM yet.
    const freshUserIds = [];
    for (const ca of pickList) {
      const { rows: [u] } = await pool.query(
        'SELECT id FROM users WHERE linked_client_id = $1',
        [ca.id]
      );
      if (u) freshUserIds.push(u.id);
    }
    if (freshUserIds.length > 0) {
      // HARD CAP: even a single branch import might touch 3K+ clients.
      // Limit Pass 4 to 500 clients per import call. Admin can re-run the
      // import or use Sync MT5 logins / Fix all imported later to finish.
      const MAX_CLIENTS = 500;
      const { rows: clients } = await pool.query(
        `SELECT id FROM clients
           WHERE agent_id = ANY($1)
             AND source IS DISTINCT FROM 'manual'
             AND contact_type = 'individual'
             AND (trading_accounts_synced_at IS NULL
                  OR mt5_logins IS NULL
                  OR array_length(mt5_logins, 1) IS NULL)
           ORDER BY
             CASE pipeline_stage
               WHEN 'Active'    THEN 1
               WHEN 'Funded'    THEN 2
               WHEN 'Contacted' THEN 3
               ELSE 9
             END,
             created_at DESC
           LIMIT $2`,
        [freshUserIds, MAX_CLIENTS]
      );
      if (clients.length === MAX_CLIENTS) {
        summary.pass4_capped = true;
        summary.pass4_hint = `Pass 4 hit the ${MAX_CLIENTS}-client cap. Run Admin → Sync MT5 logins per branch to finish the rest.`;
      }

      // Concurrency is enforced by the CRM gate globally. We use 2 workers
      // here so Pass 4 doesn't monopolize the gate's budget if other admin
      // actions are also running.
      const CONCURRENCY = 2;
      let next = 0;
      async function drain() {
        while (true) {
          const i = next++;
          if (i >= clients.length) return;
          const clientId = clients[i].id;
          try {
            const data = await crmRequest(
              `/api/contacts/${clientId}/trading-accounts?page=1&limit=100&accountType=real`,
              { signal: AbortSignal.timeout(8000) }
            );
            const rows = data?.tradingAccounts?.data || data?.data || [];
            const logins = (rows || [])
              .filter(ta => ta && ta.login && ta.type === 'real')
              .map(ta => ta.login);
            if (logins.length > 0) {
              await pool.query(
                `UPDATE clients SET mt5_logins = $1, trading_accounts_synced_at = NOW(),
                                    updated_at = NOW()
                 WHERE id = $2`,
                [logins, clientId]
              );
              // Populate trading_accounts_meta from the same payload so the
              // MT5 deal sync can discover these logins. No extra CRM call.
              await upsertTradingAccountMeta(clientId, data);
              summary.mt5LoginsSynced++;
            } else {
              await pool.query(
                `UPDATE clients SET trading_accounts_synced_at = NOW() WHERE id = $1`,
                [clientId]
              );
              summary.mt5ClientsNoAccounts++;
            }
          } catch (err) {
            if (err?.code === 'CRM_PAUSED') throw err;  // abort the whole pass
            // otherwise swallow — one client's failure shouldn't kill the batch
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, clients.length) }, drain)
      );
    }
  } catch (err) {
    console.error('[AgentImport] pass 4 (MT5 logins) failed:', err.message);
    summary.errors++;
  }

  summary.durationMs = Date.now() - start;
  // Echo the default password back so the admin UI can display it once — this
  // is the only way they know what to tell a freshly-imported agent to use.
  summary.default_password = process.env.PORTAL_DEFAULT_AGENT_PASSWORD || 'Portal@2026';
  console.log('[AgentImport] done:', { ...summary, default_password: '[…]' });
  return summary;
}
