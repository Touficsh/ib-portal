/**
 * Agent Hierarchy Sync — single-call subtree ingest from xdev CRM.
 *
 * The /api/agent-hierarchy endpoint (admin x-api-key auth) returns a recursive
 * tree rooted at the requested agent (or branch), already containing:
 *   • agents + clients + leads in the subtree
 *   • each client's MT5 logins (clientLogins array)
 *   • parent/child relationships (implicit via tree position)
 *   • each agent's product list
 *
 * What it DOES NOT include:
 *   • per-login product mapping (login → product_source_id)
 *   • per-contact phone/country/KYC details
 *
 * So the flow is:
 *   1. ONE call to /api/agent-hierarchy?agentId=X&expandAll=true
 *   2. Walk the tree, upsert agents/clients/leads + create users rows
 *   3. Stub trading_accounts_meta rows (login, client_id) for each clientLogin
 *   4. Backfill product_source_id for the stubs that lack it via /trading-accounts
 *
 * This replaces the legacy 272-page /api/contacts sweep with 1 + N_new_clients
 * calls per Onboard, where N_new_clients is the count of clients we don't
 * already have full meta for.
 */
import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';
import { crmRequest, CrmPausedError } from './crmGate.js';
import { upsertTradingAccountMeta } from './tradingAccountMetaSync.js';
import { bustPermissionCache } from './permissions.js';

const HIERARCHY_LIMIT = 500;            // max nodes per page (CRM accepts up to a few hundred)
const TA_BACKFILL_CONCURRENCY = 4;      // /trading-accounts calls in parallel for product backfill
const TA_FRESHNESS_HOURS = 24;          // skip per-client trading-accounts call if synced within this window

// Feature flag for the "agent owns their own trading accounts" path. When
// true, every time we ingest an agent we also call
// /api/contacts/:agentId/trading-accounts and stub the agent's personal
// logins in trading_accounts_meta. This makes the commission engine credit
// the agent (and cascade up to his parents) for trades on his own accounts.
// Default: ON. Set ENABLE_AGENT_OWN_TA_FETCH=false to disable.
const AGENT_OWN_TA_ENABLED = () =>
  String(process.env.ENABLE_AGENT_OWN_TA_FETCH ?? 'true').toLowerCase() === 'true';

/**
 * Fetch the agent's OWN trading accounts (accounts attached directly to the
 * agent's CRM contact, NOT clients beneath him) and stub them so the
 * commission engine credits the agent for trades on them.
 *
 * Self-commission flow: by setting clients.agent_id on the agent's own row
 * to the agent's own user.id, the engine pays L1 to the agent himself.
 * L2/L3/... cascade up via users.parent_agent_id as usual.
 *
 * Idempotent. Best-effort: per-agent failures are logged but never abort the
 * overall hierarchy sync.
 */
export async function syncAgentOwnTradingAccounts({ agentCrmId, agentUserId, summary }) {
  if (!AGENT_OWN_TA_ENABLED()) {
    summary.agentOwnTaSkipped = (summary.agentOwnTaSkipped || 0) + 1;
    return;
  }
  if (!agentCrmId || !agentUserId) return;

  try {
    const resp = await crmRequest(
      `/api/contacts/${agentCrmId}/trading-accounts?page=1&limit=100&accountType=real`,
      { signal: AbortSignal.timeout(8000) }
    );
    const accounts = resp?.tradingAccounts?.data || [];
    summary.agentOwnTaFetched = (summary.agentOwnTaFetched || 0) + 1;
    if (accounts.length === 0) return;

    const logins = accounts.map(a => String(a.login)).filter(Boolean);
    if (logins.length === 0) return;

    // Point the agent's own clients row at himself so commissions flow back.
    // mt5_logins gets stored on the row too, mirroring how upsertClient
    // handles a downstream client.
    await pool.query(
      `UPDATE clients SET
         agent_id   = $1,
         mt5_logins = $2,
         is_trader  = true,
         updated_at = NOW()
       WHERE id = $3`,
      [agentUserId, logins, agentCrmId]
    );

    // Stub trading_accounts_meta — same shape as upsertClient's stub. Product
    // mapping (product_source_id) gets resolved lazily by the bridge-driven
    // mt5_groups resolver when the first deal arrives.
    for (const login of logins) {
      try {
        await pool.query(
          `INSERT INTO trading_accounts_meta
             (login, client_id, account_type, status, last_synced_at)
           VALUES ($1, $2, 'real', true, NOW())
           ON CONFLICT (login) DO UPDATE SET
             client_id      = EXCLUDED.client_id,
             last_synced_at = NOW()`,
          [login, agentCrmId]
        );
        summary.agentOwnLoginsStubbed = (summary.agentOwnLoginsStubbed || 0) + 1;
      } catch (rowErr) {
        console.error('[HierSync] agent-own login stub failed:', login, rowErr.message);
      }
    }
  } catch (err) {
    if (err instanceof CrmPausedError) throw err;
    // Per-agent failure is non-fatal — next sync will retry.
    summary.agentOwnTaErrors = (summary.agentOwnTaErrors || 0) + 1;
    console.error('[HierSync] agent-own TA fetch failed for', agentCrmId, '—', err?.message);
  }
}

/**
 * Pull the agent's CRM record into clients (in case Refresh from CRM hasn't
 * happened recently). Idempotent.
 */
async function ensureAgentInClients(crmId) {
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM clients WHERE id = $1`, [crmId]
  );
  if (existing) return;
  // Pull from CRM detail endpoint
  try {
    const det = await crmRequest(`/api/contacts/${crmId}`, { signal: AbortSignal.timeout(8000) });
    const bi = det?.clientProfile?.basicInfo;
    if (!bi) return;
    await pool.query(
      `INSERT INTO clients (id, contact_type, name, email, phone, branch,
         is_verified, is_trader, crm_profile_type, source, created_at, updated_at)
       VALUES ($1, 'agent', $2, $3, $4, $5, true, false, 'agent', 'crm', $6, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [crmId, bi.name || 'Agent', bi.emails?.[0]?.email || null,
       bi.phoneNumbers?.[0]?.number || null, bi.branch?.name || null,
       bi.registrationDate || new Date().toISOString()]
    );
  } catch (err) {
    if (err instanceof CrmPausedError) throw err;
    // Best-effort; tree-walk will still try the upsert.
  }
}

/**
 * Upsert one agent node into clients + users. Returns the user.id.
 */
async function upsertAgent({ node, parentAgentCrmId, parentAgentUserId, roleId, defaultPwHash, summary }) {
  // 1. Upsert into clients (contact_type='agent')
  await pool.query(
    `INSERT INTO clients
       (id, contact_type, name, email, branch, referred_by_agent_id,
        source, is_verified, is_trader, crm_profile_type, created_at, updated_at)
     VALUES ($1, 'agent', $2, $3, $4, $5, 'crm', true, false, 'agent', $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name                 = EXCLUDED.name,
       email                = COALESCE(EXCLUDED.email, clients.email),
       branch               = COALESCE(EXCLUDED.branch, clients.branch),
       referred_by_agent_id = COALESCE(EXCLUDED.referred_by_agent_id, clients.referred_by_agent_id),
       updated_at           = NOW()`,
    [node._id, node.name || `Agent ${node._id.slice(-6)}`, node.email || null,
     node.branchName || null, parentAgentCrmId,
     node.registrationDate || new Date().toISOString()]
  );

  // 2. Upsert into users — preserve password if user already exists
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM users WHERE linked_client_id = $1`, [node._id]
  );

  let userId;
  if (existing) {
    userId = existing.id;
    await pool.query(
      `UPDATE users SET
         name             = $1,
         is_agent         = true,
         is_active        = true,
         role             = 'agent',
         role_id          = $2,
         parent_agent_id  = $3,
         updated_at       = NOW()
       WHERE id = $4`,
      [node.name || existing.name, roleId, parentAgentUserId, userId]
    );
    summary.agentsUpdated++;
  } else {
    // Email may collide with another row — fall back to placeholder if so
    let safeEmail = node.email && node.email.trim() ? node.email.trim() : `agent-${node._id}@portal.local`;
    const { rows: [conflict] } = await pool.query(
      `SELECT id FROM users WHERE email = $1`, [safeEmail]
    );
    if (conflict) safeEmail = `agent-${node._id}@portal.local`;

    const { rows: [newUser] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, role_id,
                          is_agent, linked_client_id, parent_agent_id)
       VALUES ($1, $2, $3, 'agent', $4, true, $5, $6)
       RETURNING id`,
      [node.name || `Agent ${node._id.slice(-6)}`, safeEmail, defaultPwHash,
       roleId, node._id, parentAgentUserId]
    );
    userId = newUser.id;
    summary.agentsCreated++;
  }
  bustPermissionCache(userId);
  return userId;
}

/**
 * Upsert one client/lead node. Sets agent_id (the parent agent's user.id)
 * and copies clientLogins into clients.mt5_logins.
 */
async function upsertClient({ node, parentAgentCrmId, parentAgentUserId, summary }) {
  const isLead = node.profileType === 'lead';
  const stage = isLead ? 'Lead' : 'Contacted';
  const logins = Array.isArray(node.clientLogins)
    ? node.clientLogins.map(String).filter(Boolean)
    : [];
  const isTrader = logins.length > 0;

  await pool.query(
    `INSERT INTO clients
       (id, contact_type, name, email, branch, pipeline_stage,
        agent_id, referred_by_agent_id, source,
        is_verified, is_trader, crm_profile_type,
        mt5_logins, created_at, updated_at)
     VALUES ($1, 'individual', $2, $3, $4, $5,
             $6, $7, 'crm',
             $8, $9, $10,
             $11, $12, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name                 = EXCLUDED.name,
       email                = COALESCE(EXCLUDED.email, clients.email),
       branch               = COALESCE(EXCLUDED.branch, clients.branch),
       agent_id             = EXCLUDED.agent_id,
       referred_by_agent_id = EXCLUDED.referred_by_agent_id,
       crm_profile_type     = EXCLUDED.crm_profile_type,
       is_trader            = clients.is_trader OR EXCLUDED.is_trader,
       mt5_logins           = EXCLUDED.mt5_logins,
       pipeline_stage       = CASE
         WHEN clients.pipeline_stage = 'Churned' THEN clients.pipeline_stage
         WHEN clients.pipeline_stage = 'Lead' AND EXCLUDED.pipeline_stage IN ('Contacted','Funded','Active')
           THEN EXCLUDED.pipeline_stage
         ELSE clients.pipeline_stage
       END,
       updated_at = NOW()`,
    [node._id, node.name || `Client ${node._id.slice(-6)}`, node.email || null,
     node.branchName || null, stage,
     parentAgentUserId, parentAgentCrmId,
     false, isTrader, node.profileType || 'individual',
     logins, node.registrationDate || new Date().toISOString()]
  );

  if (isLead) summary.leadsUpserted++;
  else summary.clientsUpserted++;

  // Stub trading_accounts_meta rows (without product info — backfill happens later)
  for (const login of logins) {
    try {
      await pool.query(
        `INSERT INTO trading_accounts_meta
           (login, client_id, account_type, status, last_synced_at)
         VALUES ($1, $2, 'real', true, NOW())
         ON CONFLICT (login) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           last_synced_at = NOW()`,
        [login, node._id]
      );
      summary.loginsStubbed++;
    } catch (rowErr) {
      console.error('[HierSync] login stub failed:', login, rowErr.message);
    }
  }
}

/**
 * Recursively walk the response tree starting from a list of children of a
 * parent. The parent's CRM id and user.id are passed down.
 */
async function walkChildren({ children, parentAgentCrmId, parentAgentUserId, roleId, defaultPwHash, summary, clientsNeedingProductBackfill }) {
  for (const node of (children || [])) {
    if (!node?._id) continue;

    if (node.profileType === 'agent') {
      const userId = await upsertAgent({
        node, parentAgentCrmId, parentAgentUserId, roleId, defaultPwHash, summary,
      });
      // Pull this agent's own personal trading accounts (best-effort)
      await syncAgentOwnTradingAccounts({
        agentCrmId: node._id, agentUserId: userId, summary,
      });
      // Recurse with this agent as the new parent
      await walkChildren({
        children: node.children,
        parentAgentCrmId: node._id,
        parentAgentUserId: userId,
        roleId, defaultPwHash, summary, clientsNeedingProductBackfill,
      });
    } else if (node.profileType === 'client' || node.profileType === 'lead') {
      await upsertClient({ node, parentAgentCrmId, parentAgentUserId, summary });
      // Track for product backfill if this client has logins
      if (Array.isArray(node.clientLogins) && node.clientLogins.length > 0) {
        clientsNeedingProductBackfill.add(node._id);
      }
    } else {
      summary.unknownNodeTypes++;
    }
  }
}

/**
 * After the tree walk, for each client that has logins WITHOUT product
 * mapping in trading_accounts_meta (and wasn't synced within the freshness
 * window), call /api/contacts/:id/trading-accounts to enrich.
 */
async function backfillProductMappings(clientIds, summary) {
  // Filter to clients that actually need it: at least one login lacking product_source_id
  // OR a stale last_synced_at.
  const { rows: needers } = await pool.query(
    `SELECT DISTINCT cl.id
       FROM clients cl
       JOIN trading_accounts_meta tam ON tam.client_id = cl.id
      WHERE cl.id = ANY($1::varchar[])
        AND (tam.product_source_id IS NULL
             OR tam.last_synced_at IS NULL
             OR tam.last_synced_at < NOW() - ($2 || ' hours')::interval)`,
    [Array.from(clientIds), String(TA_FRESHNESS_HOURS)]
  );
  const targets = needers.map(r => r.id);
  if (targets.length === 0) return;

  let next = 0;
  async function drain() {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      const cid = targets[i];
      try {
        const data = await crmRequest(
          `/api/contacts/${cid}/trading-accounts?page=1&limit=100&accountType=real`,
          { signal: AbortSignal.timeout(8000) }
        );
        const upserted = await upsertTradingAccountMeta(cid, data);
        summary.productMappingsFetched += upserted;
      } catch (err) {
        if (err instanceof CrmPausedError) throw err;
        // Per-client failure is non-fatal — the per-poll TA refresh will retry later.
      }
    }
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(TA_BACKFILL_CONCURRENCY, targets.length) }, drain)
    );
  } catch (err) {
    summary.productBackfillAborted = err?.message || 'budget/kill switch';
  }
}

/**
 * Main entry point — sync the full subtree of one agent into local DB.
 *
 * @param {object} opts
 * @param {string} opts.agentId      — CRM agent _id (required)
 * @param {string} [opts.parentAgentUserId=null]   — if known, sets parent_agent_id on the picked agent's user row
 * @returns summary object with counts + timings
 */
export async function syncAgentHierarchy({ agentId, parentAgentUserId = null } = {}) {
  if (!agentId) throw new Error('agentId is required');
  const start = Date.now();
  const summary = {
    agentId,
    pickedAgentUserId: null,
    agentsCreated: 0,
    agentsUpdated: 0,
    clientsUpserted: 0,
    leadsUpserted: 0,
    loginsStubbed: 0,
    productMappingsFetched: 0,
    productBackfillAborted: null,
    unknownNodeTypes: 0,
    aborted: false,
    abortReason: null,
    durationMs: 0,
  };

  try {
    // Resolve role id + default password hash once
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE name = 'agent'`);
    if (!role) throw new Error("'agent' role not found — run db:migrate first");
    const defaultPw = process.env.PORTAL_DEFAULT_AGENT_PASSWORD || 'Portal@2026';
    const defaultPwHash = await bcrypt.hash(defaultPw, 10);

    // Ensure the picked agent exists in clients (might not if Refresh from CRM is stale)
    await ensureAgentInClients(agentId);

    // Upsert the picked agent into users (no children info yet — that comes from the hierarchy call)
    const { rows: [pickedAgentRow] } = await pool.query(
      `SELECT id, name, email, branch FROM clients WHERE id = $1`, [agentId]
    );
    if (!pickedAgentRow) {
      summary.aborted = true;
      summary.abortReason = `Picked agent ${agentId} not found in CRM mirror — run Refresh from CRM first`;
      summary.durationMs = Date.now() - start;
      return summary;
    }
    const pickedNode = {
      _id: pickedAgentRow.id,
      name: pickedAgentRow.name,
      email: pickedAgentRow.email,
      branchName: pickedAgentRow.branch,
      profileType: 'agent',
    };
    summary.pickedAgentUserId = await upsertAgent({
      node: pickedNode,
      parentAgentCrmId: null,
      parentAgentUserId,
      roleId: role.id,
      defaultPwHash,
      summary,
    });

    // Pull the picked agent's OWN trading accounts before walking children.
    // This ensures even agents with empty downlines get their personal
    // logins ingested.
    await syncAgentOwnTradingAccounts({
      agentCrmId: agentId,
      agentUserId: summary.pickedAgentUserId,
      summary,
    });

    // ─── ONE CALL — fetch the full subtree ─────────────────────────────
    let response;
    try {
      response = await crmRequest(
        `/api/agent-hierarchy?agentId=${agentId}&expandAll=true&page=1&limit=${HIERARCHY_LIMIT}`,
        { signal: AbortSignal.timeout(30000) }
      );
    } catch (err) {
      summary.aborted = true;
      summary.abortReason = err instanceof CrmPausedError
        ? `Aborted by gate: ${err.message}`
        : `Hierarchy fetch failed: ${err.message}`;
      summary.durationMs = Date.now() - start;
      return summary;
    }

    const nodes = response?.data?.nodes || [];

    // Walk the tree — picked agent's children are the top-level nodes.
    const clientsNeedingProductBackfill = new Set();
    await walkChildren({
      children: nodes,
      parentAgentCrmId: agentId,
      parentAgentUserId: summary.pickedAgentUserId,
      roleId: role.id,
      defaultPwHash,
      summary,
      clientsNeedingProductBackfill,
    });

    // Backfill product mappings for clients with logins that lack them.
    // DISABLED 2026-05-04 after xdev reported high call rates on
    // /api/contacts/:id/trading-accounts. Product mapping is now backfilled
    // lazily on demand (admin clicks "Sync MT5 logins" or the commission
    // engine encounters an unmapped login). Set ENABLE_TA_BACKFILL=true to
    // re-enable the eager fetch during Onboard / branch hierarchy refresh.
    if (
      String(process.env.ENABLE_TA_BACKFILL || 'false').toLowerCase() === 'true'
      && clientsNeedingProductBackfill.size > 0
    ) {
      await backfillProductMappings(clientsNeedingProductBackfill, summary);
    } else {
      summary.productMappingsFetched = 0;
      summary.taBackfillSkipped = clientsNeedingProductBackfill.size;
    }
  } catch (err) {
    summary.aborted = true;
    summary.abortReason = err?.message || 'unknown error';
  }

  summary.durationMs = Date.now() - start;
  console.log('[HierSync] done:', summary);
  return summary;
}

/**
 * Branch-level variant — useful for the periodic refresh scheduler.
 * Walks every top-level agent in the branch.
 */
export async function syncBranchHierarchy({ branchId, branchName }) {
  if (!branchId) throw new Error('branchId is required');
  const start = Date.now();
  const summary = {
    branchId,
    branchName: branchName || null,
    rootAgentsProcessed: 0,
    agentsCreated: 0,
    agentsUpdated: 0,
    clientsUpserted: 0,
    leadsUpserted: 0,
    loginsStubbed: 0,
    productMappingsFetched: 0,
    aborted: false,
    abortReason: null,
    durationMs: 0,
  };

  try {
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE name = 'agent'`);
    if (!role) throw new Error("'agent' role not found");
    const defaultPw = process.env.PORTAL_DEFAULT_AGENT_PASSWORD || 'Portal@2026';
    const defaultPwHash = await bcrypt.hash(defaultPw, 10);

    let response;
    try {
      const branchIdsParam = encodeURIComponent(JSON.stringify([branchId]));
      response = await crmRequest(
        `/api/agent-hierarchy?branchIds=${branchIdsParam}&expandAll=true&page=1&limit=${HIERARCHY_LIMIT}`,
        { signal: AbortSignal.timeout(30000) }
      );
    } catch (err) {
      summary.aborted = true;
      summary.abortReason = err instanceof CrmPausedError
        ? `Aborted by gate: ${err.message}`
        : `Hierarchy fetch failed: ${err.message}`;
      summary.durationMs = Date.now() - start;
      return summary;
    }

    const rootNodes = response?.data?.nodes || [];

    const clientsNeedingProductBackfill = new Set();
    for (const root of rootNodes) {
      if (root.profileType !== 'agent') continue;
      summary.rootAgentsProcessed++;
      // Upsert the root agent itself (no parent — top-level)
      const userId = await upsertAgent({
        node: root,
        parentAgentCrmId: null,
        parentAgentUserId: null,
        roleId: role.id,
        defaultPwHash,
        summary,
      });
      // Pull the root agent's OWN trading accounts (best-effort)
      await syncAgentOwnTradingAccounts({
        agentCrmId: root._id, agentUserId: userId, summary,
      });
      await walkChildren({
        children: root.children,
        parentAgentCrmId: root._id,
        parentAgentUserId: userId,
        roleId: role.id,
        defaultPwHash,
        summary,
        clientsNeedingProductBackfill,
      });
    }

    if (clientsNeedingProductBackfill.size > 0) {
      await backfillProductMappings(clientsNeedingProductBackfill, summary);
    }
  } catch (err) {
    summary.aborted = true;
    summary.abortReason = err?.message || 'unknown error';
  }

  summary.durationMs = Date.now() - start;
  console.log('[HierSync:branch] done:', summary);
  return summary;
}
