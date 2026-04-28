/**
 * Agent ↔ Product linkage sync from x-dev's CRM.
 *
 * Each product at x-dev carries an `agents[]` array of the agents authorized
 * to sell it. This service reads that array across all products and writes
 * the (agent, product) pairs into our local `agent_products` table so the
 * portal knows which agents hold which product.
 *
 * Rates: CRM doesn't expose commission rates, so new rows land with
 * `rate_per_lot = 0` and `source = 'crm'`. The cascade validator refuses to
 * grant a 0-rate product — admins must set a real rate in the portal first.
 *
 * Idempotent. Pre-existing manually-set rows (source='manual', non-zero rate)
 * are preserved on re-sync; only source='crm' rows are touched.
 *
 * Exports:
 *   scanCrmAgentProducts  — returns Map<agent_client_id, [{product_id, code, status, active}]>
 *   listCrmProductsForAgent — per-user helper (scans + filters to one user's linked_client_id)
 *   syncAgentProductsFromCRM — bulk populate agent_products for all imported agents
 */
import { getCrmConfig } from './crmConfig.js';
import { crmRequest } from './crmGate.js';
import pool from '../db/pool.js';

/**
 * Pulls every product from CRM and returns a Map keyed by agent's CRM client id
 * (e.g. "688a1dd6b63c1b45e24888b4") → array of product summaries.
 */
export async function scanCrmAgentProducts() {
  const pageSize = 100;
  const all = [];
  let page = 1;
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const data = await crmRequest(`/api/products?page=${page}&pageSize=${pageSize}`);
    const batch = Array.isArray(data?.products) ? data.products : [];
    all.push(...batch);
    const pg = data?.pagination;
    if (!pg || pg.isEnd || (pg.totalPages && page >= pg.totalPages) || batch.length < pageSize) break;
    page++;
  }

  // Build agent → [products] reverse map
  const byAgent = new Map();
  for (const p of all) {
    for (const a of p.agents || []) {
      const agentCid = typeof a === 'string' ? a : a?._id;
      if (!agentCid) continue;
      const entry = {
        source_id: p._id,
        name: p.name,
        code: p.code,
        group: p.group?.name,
        status: p.status,
        agentActive: typeof a === 'object' ? a.isActive : true,
      };
      const arr = byAgent.get(agentCid) || [];
      arr.push(entry);
      byAgent.set(agentCid, arr);
    }
  }
  return { byAgent, scannedProducts: all.length };
}

/**
 * Per-agent lookup: by default reads from LOCAL products + agent_products
 * tables (zero CRM calls). Pass `{ refresh: true }` to force a live CRM scan,
 * which pages through the whole product catalog — only use when the admin
 * explicitly asks to refresh (e.g., "Sync product links" button).
 *
 * This used to call scanCrmAgentProducts() on every Agent Detail page load,
 * paging through the entire product catalog each time. Now opening Agent
 * Detail hits zero external services.
 *
 * Returns { agent: {user_id, linked_client_id, name}, crm_products: [...] }
 * where each row is enriched with local_product_id / linked_rate / source.
 */
export async function listCrmProductsForAgent(userId, { refresh = false } = {}) {
  const { rows: [user] } = await pool.query(
    'SELECT id, name, email, linked_client_id FROM users WHERE id = $1 AND is_agent = true',
    [userId]
  );
  if (!user) return null;

  let crmRows;
  if (refresh) {
    // Explicit refresh — hit CRM and page through the whole catalog.
    const { byAgent } = await scanCrmAgentProducts();
    crmRows = byAgent.get(user.linked_client_id) || [];
  } else {
    // Default — answer from the local mirror (agent_products joined to products).
    // Previously imported agent_products rows with source='crm' carry the
    // full CRM-side snapshot we need.
    const { rows: local } = await pool.query(
      `SELECT ap.product_id, ap.source, ap.is_active AS link_active,
              p.source_id, p.name, p.code, p.product_group, p.currency
       FROM agent_products ap
       JOIN products p ON p.id = ap.product_id
       WHERE ap.agent_id = $1`,
      [userId]
    );
    crmRows = local.map(l => ({
      source_id: l.source_id,
      name: l.name,
      code: l.code,
      group: l.product_group,
      status: null,                  // CRM-side status not in local mirror; refresh if you need it
      agentActive: l.link_active !== false,
    }));
  }

  // Enrich with local product_id (if that CRM product has already been
  // imported into our products table via syncProductsFromCRM)
  const sourceIds = crmRows.map(r => r.source_id).filter(Boolean);
  const localMap = new Map();
  if (sourceIds.length > 0) {
    const { rows: local } = await pool.query(
      `SELECT id, source_id FROM products WHERE source_id = ANY($1)`,
      [sourceIds]
    );
    for (const l of local) localMap.set(l.source_id, l.id);
  }

  // Also fetch current agent_products for this user
  const { rows: existingAp } = await pool.query(
    `SELECT ap.product_id, p.source_id, ap.rate_per_lot, ap.source, ap.is_active
     FROM agent_products ap
     LEFT JOIN products p ON p.id = ap.product_id
     WHERE ap.agent_id = $1`,
    [userId]
  );
  const apByProductId = new Map(existingAp.map(a => [a.product_id, a]));

  return {
    agent: user,
    served_from: refresh ? 'crm_live' : 'local_mirror',
    crm_products: crmRows.map(r => {
      const local_product_id = localMap.get(r.source_id) || null;
      const existing = local_product_id ? apByProductId.get(local_product_id) : null;
      return {
        ...r,
        local_product_id,
        in_portal: !!local_product_id,
        linked_rate: existing ? Number(existing.rate_per_lot) : null,
        link_source: existing?.source || null,
        link_active: existing?.is_active ?? null,
      };
    }),
  };
}

/**
 * Bulk populate agent_products from CRM for every imported portal agent.
 *
 * For each (agent, product) pair the CRM reports:
 *   - if the product isn't in our products table yet → skip (sync products first)
 *   - if no agent_products row exists → INSERT with rate=0, source='crm', is_active=true
 *   - if an agent_products row exists:
 *       - source='crm' and still listed in CRM → keep in sync (touch is_active)
 *       - source='manual' → preserve (don't touch the admin's rate)
 *
 * Returns { scannedProducts, scannedLinks, created, preserved, skippedMissingProduct, skippedUnimportedAgent, errors }.
 */
export async function syncAgentProductsFromCRM() {
  const start = Date.now();
  const summary = {
    scannedProducts: 0,
    scannedLinks: 0,
    created: 0,
    preserved: 0,
    deactivated: 0,        // ← removed-from-CRM detection (NEW)
    skippedMissingProduct: 0,
    skippedUnimportedAgent: 0,
    errors: 0,
  };

  const { byAgent, scannedProducts } = await scanCrmAgentProducts();
  summary.scannedProducts = scannedProducts;

  // All imported portal agents (linked_client_id → user_id)
  const { rows: portalAgents } = await pool.query(
    'SELECT id, linked_client_id FROM users WHERE is_agent = true AND linked_client_id IS NOT NULL'
  );
  const userByCid = new Map(portalAgents.map(u => [u.linked_client_id, u.id]));

  // Look up local products by source_id
  const { rows: localProducts } = await pool.query(
    `SELECT id, source_id FROM products WHERE source_id IS NOT NULL`
  );
  const productBySourceId = new Map(localProducts.map(p => [p.source_id, p.id]));

  // Track every (user_id, product_id) we saw in this CRM scan so the
  // deactivation pass can find local rows that the CRM no longer lists
  // (e.g. admin removed a product from an agent in xdev — we need to
  //  flip our local row to is_active=false).
  const seenInCrm = new Set();

  for (const [agentCid, linkedProducts] of byAgent) {
    const userId = userByCid.get(agentCid);
    if (!userId) {
      summary.skippedUnimportedAgent += linkedProducts.length;
      continue;
    }
    for (const lp of linkedProducts) {
      summary.scannedLinks++;
      const productId = productBySourceId.get(lp.source_id);
      if (!productId) { summary.skippedMissingProduct++; continue; }
      seenInCrm.add(`${userId}:${productId}`);
      try {
        const { rows: [existing] } = await pool.query(
          'SELECT id, source FROM agent_products WHERE agent_id = $1 AND product_id = $2',
          [userId, productId]
        );
        if (!existing) {
          await pool.query(
            `INSERT INTO agent_products (agent_id, product_id, rate_per_lot, source, is_active)
             VALUES ($1, $2, 0, 'crm', $3)`,
            [userId, productId, lp.agentActive !== false]
          );
          summary.created++;
        } else if (existing.source === 'crm') {
          // Touch timestamp so we can tell it's still CRM-linked this cycle
          await pool.query(
            `UPDATE agent_products SET is_active = $1, updated_at = NOW()
             WHERE id = $2`,
            [lp.agentActive !== false, existing.id]
          );
          summary.preserved++;
        } else {
          // source='manual' — preserve admin-set rate as-is
          summary.preserved++;
        }
      } catch (err) {
        console.error('[AgentProductSync] failed', userId, productId, '-', err.message);
        summary.errors++;
      }
    }
  }

  // ── Removal pass ────────────────────────────────────────────────────
  // Find every local CRM-sourced active link that we did NOT see in this
  // CRM scan and mark it inactive. This is the "Sophia lost a product in
  // xdev" case — without this pass, that stale row would survive forever
  // and the agent would keep showing a product they no longer have access
  // to. We deliberately scope to source='crm' so admin-created manual
  // links are never auto-deactivated.
  //
  // Removal pass guards:
  //   1. seenInCrm.size > 0  — a fully-silent empty response (CRM outage
  //      returning 200 with no data) would otherwise deactivate every single
  //      source='crm' row in the DB. Block it with an explicit empty-scan check.
  //   2. errors === 0  — if any scan iteration threw, seenInCrm may be
  //      incomplete; skip deactivation and let the admin re-run.
  if (seenInCrm.size === 0) {
    console.warn('[AgentProductSync] skipped removal pass — CRM scan returned 0 agent-product links (possible outage or empty catalog). Re-run to verify.');
    summary.skipped_removal = true;
  } else if (summary.errors === 0) {
    const { rows: localCrmLinks } = await pool.query(
      `SELECT id, agent_id, product_id
       FROM agent_products
       WHERE source = 'crm' AND is_active = true`
    );
    for (const link of localCrmLinks) {
      if (!seenInCrm.has(`${link.agent_id}:${link.product_id}`)) {
        try {
          await pool.query(
            `UPDATE agent_products
             SET is_active = false, updated_at = NOW()
             WHERE id = $1`,
            [link.id]
          );
          summary.deactivated++;
        } catch (err) {
          console.error('[AgentProductSync] deactivate failed', link.id, '-', err.message);
          summary.errors++;
        }
      }
    }
  } else {
    console.warn('[AgentProductSync] skipped removal pass — scan had errors, retry needed for accurate deactivation');
  }

  summary.durationMs = Date.now() - start;
  console.log('[AgentProductSync] done:', summary);
  return summary;
}
