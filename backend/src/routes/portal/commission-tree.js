/**
 * Portal — Commission Tree — /api/portal/commission-tree
 *
 * Read-only, agent-scoped version of the admin Commission Tree.
 * Returns the viewer's own node as the root + every descendant agent in their
 * subtree, each with their products (rate_per_lot + CRM-synced pct/rebate/
 * effective $/lot when available), plus per-agent earnings totals for the
 * subtree. Shape matches the admin `/api/agents/hierarchy` + `/api/commissions/
 * earners` response so the portal Commission Tree component can render
 * identically (just without the edit UI and branch picker).
 *
 * Response:
 *   {
 *     root_id: <viewer's user_id>,
 *     roots:  [ {...viewer node with children } ],
 *     earnings: [ { id, name, email, deal_count, total_amount, is_agent, branch } ]
 *   }
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate, requireAgentAccess } from '../../middleware/portalAuth.js';
import { wrap as cacheWrap } from '../../services/cache.js';

const router = Router();
router.use(portalAuthenticate, requireAgentAccess);

// 60s per-viewer cache — same TTL as the admin /hierarchy endpoint so this
// doesn't become the bottleneck for repeated page loads.
const TREE_TTL_MS = 60_000;

router.get('/', async (req, res, next) => {
  try {
    const viewerId = req.user.id;
    const payload = await cacheWrap('portal.commission_tree', viewerId, TREE_TTL_MS, async () => {
      return await buildTreePayload(viewerId);
    });
    res.json(payload);
  } catch (err) { next(err); }
});

async function buildTreePayload(viewerId) {
  // 1. Pull every agent in the viewer's subtree (including themselves) in one
  //    recursive CTE. Same fields as /api/agents/hierarchy so the UI can reuse.
  const { rows: agents } = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT u.id, u.name, u.email, u.parent_agent_id, u.is_active,
              u.linked_client_id
       FROM users u
       WHERE u.id = $1
       UNION ALL
       SELECT u.id, u.name, u.email, u.parent_agent_id, u.is_active,
              u.linked_client_id
       FROM users u
       JOIN subtree s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true AND u.is_active = true
     )
     SELECT s.id, s.name, s.email, s.parent_agent_id, s.is_active,
            s.linked_client_id,
            c.branch, c.country, c.phone,
            (SELECT COUNT(*)::int FROM clients cl WHERE cl.agent_id = s.id) AS direct_clients_count,
            (SELECT COUNT(*)::int FROM users sub
               WHERE sub.parent_agent_id = s.id AND sub.is_agent = true) AS direct_sub_count
     FROM subtree s
     LEFT JOIN clients c ON c.id = s.linked_client_id
     ORDER BY direct_clients_count DESC, s.name`,
    [viewerId]
  );

  const agentIds = agents.map(a => a.id);
  if (agentIds.length === 0) {
    return { root_id: viewerId, roots: [], earnings: [] };
  }

  // 2. Product links (legacy rate_per_lot) for every agent in scope.
  const [{ rows: links }, { rows: crmLevels }, { rows: earningsRows }] = await Promise.all([
    pool.query(
      `SELECT ap.agent_id, ap.product_id, ap.rate_per_lot, ap.source,
              ap.is_active AS link_active,
              p.name AS product_name, p.code, p.product_group, p.currency,
              p.max_rate_per_lot, p.is_active AS product_active,
              p.commission_per_lot AS broker_commission_per_lot
       FROM agent_products ap
       JOIN products p ON p.id = ap.product_id
       WHERE ap.is_active = true AND ap.agent_id = ANY($1)
       ORDER BY p.name`,
      [agentIds]
    ),
    pool.query(
      `SELECT DISTINCT ON (agent_user_id, product_id)
              agent_user_id AS agent_id, product_id,
              commission_percentage, commission_per_lot,
              override_commission_percentage, override_commission_per_lot,
              mt5_group_name, synced_at
       FROM crm_commission_levels
       WHERE is_active = true AND agent_user_id = ANY($1)
       ORDER BY agent_user_id, product_id,
                (commission_percentage > 0 OR commission_per_lot > 0) DESC,
                synced_at DESC`,
      [agentIds]
    ),
    // Earnings totals — read from the per-month rollup rather than scanning
    // the full commissions table. Populated by the commission engine after
    // every cycle; see services/agentEarningsSummary.js for the refresh
    // logic. Falls back to 0 for agents with no rollup rows yet.
    pool.query(
      `SELECT u.id, u.name, u.email, u.is_agent, cl.branch,
              COALESCE(SUM(s.deal_count), 0)::int           AS deal_count,
              COALESCE(SUM(s.total_amount), 0)::numeric(14,2) AS total_amount
       FROM users u
       JOIN agent_earnings_summary s ON s.agent_id = u.id
       LEFT JOIN clients cl ON cl.id = u.linked_client_id
       WHERE u.id = ANY($1)
       GROUP BY u.id, u.name, u.email, u.is_agent, cl.branch`,
      [agentIds]
    ),
  ]);

  // 3. Index CRM levels by (agent, product) — same "best row wins" logic as /hierarchy
  const crmByAgentProduct = new Map();
  for (const cl of crmLevels) {
    crmByAgentProduct.set(`${cl.agent_id}:${cl.product_id}`, {
      commission_percentage: Number(cl.commission_percentage),
      commission_per_lot:    Number(cl.commission_per_lot),
      override_commission_percentage: cl.override_commission_percentage != null ? Number(cl.override_commission_percentage) : null,
      override_commission_per_lot:    cl.override_commission_per_lot    != null ? Number(cl.override_commission_per_lot)    : null,
      mt5_group_name: cl.mt5_group_name,
      synced_at: cl.synced_at,
    });
  }

  // 4. Group product links by agent, enriching each with CRM-derived fields
  const productsByAgent = new Map();
  for (const l of links) {
    const brokerPerLot = Number(l.broker_commission_per_lot || 0);
    const crmLevel = crmByAgentProduct.get(`${l.agent_id}:${l.product_id}`) || null;

    let effectivePct = null, effectivePerLot = null, effectiveRatePerLot = null;
    if (crmLevel) {
      effectivePct = crmLevel.override_commission_percentage != null
        ? crmLevel.override_commission_percentage
        : crmLevel.commission_percentage;
      effectivePerLot = crmLevel.override_commission_per_lot != null
        ? crmLevel.override_commission_per_lot
        : crmLevel.commission_per_lot;
      effectiveRatePerLot = Number((effectivePct * brokerPerLot / 100 + effectivePerLot).toFixed(4));
    }

    const arr = productsByAgent.get(l.agent_id) || [];
    arr.push({
      product_id: l.product_id,
      name: l.product_name,
      code: l.code,
      group: l.product_group,
      currency: l.currency,
      rate_per_lot: Number(l.rate_per_lot),
      source: l.source,
      max_rate_per_lot: Number(l.max_rate_per_lot),
      product_active: l.product_active,
      broker_commission_per_lot: brokerPerLot,
      crm_level: crmLevel,
      effective_pct:            effectivePct,
      effective_per_lot:        effectivePerLot,
      effective_rate_per_lot:   effectiveRatePerLot,
      has_crm_config:           !!crmLevel,
    });
    productsByAgent.set(l.agent_id, arr);
  }

  // 5. Build the viewer-rooted tree. parent_agent_id can point outside the
  //    subtree (the viewer's own parent, for example) — those become roots.
  //    Since we only fetched the viewer + descendants, there should be exactly
  //    one root (the viewer), unless data is inconsistent.
  const byId = new Map();
  for (const a of agents) {
    byId.set(a.id, { ...a, products: productsByAgent.get(a.id) || [], children: [] });
  }
  const roots = [];
  for (const a of agents) {
    const node = byId.get(a.id);
    if (a.parent_agent_id && byId.has(a.parent_agent_id)) {
      byId.get(a.parent_agent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // 6. Subtree aggregate counts so a collapsed node still shows meaningful totals
  function tally(node) {
    let subtreeProducts = node.products.length;
    let subtreeSubAgents = node.children.length;
    for (const c of node.children) {
      const r = tally(c);
      subtreeProducts += r.subtreeProducts;
      subtreeSubAgents += r.subtreeSubAgents;
    }
    node.subtree_product_count = subtreeProducts;
    node.subtree_sub_count = subtreeSubAgents;
    return { subtreeProducts, subtreeSubAgents };
  }
  roots.forEach(tally);

  const earnings = earningsRows.map(r => ({
    ...r,
    total_amount: Number(r.total_amount),
  }));

  return { root_id: viewerId, roots, earnings };
}

export default router;
