/**
 * Rate Cascade Validation — business rules for agent-product rate hierarchies.
 *
 * The IB tree works like a waterfall: each agent's per-lot rate for a product
 * must be ≤ their parent's rate for that same product. Top-level agents are
 * capped by `products.max_rate_per_lot` (the admin-set ceiling).
 *
 * All query helpers accept an optional `db` param so they can participate in
 * a caller's transaction (pass the connected client from `pool.connect()`).
 * When omitted, they fall back to the default pool.
 *
 * Exports:
 *   validateRate              — check a proposed rate against the cascade ceiling
 *   wouldCreateCycle          — detect tree cycles before re-parenting
 *   findDescendantsExceeding  — after a rate decrease, find descendants now above it
 *   getEffectiveCeiling       — helper; the max rate an agent is allowed for a product
 */
import defaultPool from '../db/pool.js';

/**
 * Returns the maximum rate the given agent is allowed to hold for `productId`.
 *  - If the agent has a parent: parent's agent_products.rate_per_lot (active row)
 *  - If the agent is top-level: products.max_rate_per_lot
 *  - Returns null if the product is inactive/missing, or if the parent
 *    doesn't hold this product (in which case the child can't either).
 */
export async function getEffectiveCeiling(agentId, productId, db = defaultPool) {
  const { rows: [product] } = await db.query(
    'SELECT max_rate_per_lot, is_active FROM products WHERE id = $1',
    [productId]
  );
  if (!product || !product.is_active) return { ceiling: null, reason: 'product_not_found_or_inactive' };

  const { rows: [agent] } = await db.query(
    'SELECT parent_agent_id, is_agent FROM users WHERE id = $1',
    [agentId]
  );
  if (!agent) return { ceiling: null, reason: 'agent_not_found' };
  if (!agent.is_agent) return { ceiling: null, reason: 'not_an_agent' };

  if (!agent.parent_agent_id) {
    // Top-level: capped by product's admin-set max
    return { ceiling: Number(product.max_rate_per_lot), source: 'product_max' };
  }

  // Child: capped by parent's rate for this product
  const { rows: [parentAp] } = await db.query(
    `SELECT rate_per_lot FROM agent_products
     WHERE agent_id = $1 AND product_id = $2 AND is_active = true`,
    [agent.parent_agent_id, productId]
  );
  if (!parentAp) {
    return { ceiling: null, reason: 'parent_lacks_product' };
  }
  return { ceiling: Number(parentAp.rate_per_lot), source: 'parent_rate' };
}

/**
 * Validate that `proposedRate` is allowed for `agentId` + `productId`.
 *  - ok: true  → { ok, ceiling, source }
 *  - ok: false → { ok, reason, ceiling?, proposed? }
 */
export async function validateRate(agentId, productId, proposedRate, db = defaultPool) {
  const rate = Number(proposedRate);
  if (!Number.isFinite(rate) || rate < 0) {
    return { ok: false, reason: 'invalid_rate' };
  }
  const { ceiling, reason, source } = await getEffectiveCeiling(agentId, productId, db);
  if (ceiling == null) return { ok: false, reason };
  if (rate > ceiling) {
    return { ok: false, reason: 'exceeds_ceiling', ceiling, proposed: rate };
  }
  return { ok: true, ceiling, source };
}

/**
 * Returns true iff `possibleAncestorId` sits somewhere above `descendantId`
 * in the agent tree. Used by the shares endpoint to validate that a grant
 * goes upward (sub-agent → ancestor), never sideways or downward.
 */
export async function isAncestor(possibleAncestorId, descendantId, db = defaultPool) {
  if (!possibleAncestorId || !descendantId) return false;
  if (possibleAncestorId === descendantId) return false;

  const { rows } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_agent_id FROM users WHERE id = $1
       UNION ALL
       SELECT u.parent_agent_id
       FROM users u
       JOIN ancestors a ON u.id = a.parent_agent_id
       WHERE a.parent_agent_id IS NOT NULL
     )
     SELECT 1 FROM ancestors WHERE parent_agent_id = $2 LIMIT 1`,
    [descendantId, possibleAncestorId]
  );
  return rows.length > 0;
}

/**
 * Returns true if setting `agentId.parent_agent_id = proposedParentId` would
 * create a cycle (i.e., the proposed parent is `agentId` itself or one of its
 * descendants).
 */
export async function wouldCreateCycle(agentId, proposedParentId, db = defaultPool) {
  if (!proposedParentId) return false;
  if (agentId === proposedParentId) return true;

  // Walk up from the proposed parent — if we encounter agentId, it's a cycle.
  const { rows } = await db.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_agent_id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id, u.parent_agent_id
       FROM users u
       JOIN ancestors a ON a.parent_agent_id = u.id
     )
     SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
    [proposedParentId, agentId]
  );
  return rows.length > 0;
}

/**
 * After an agent's rate for a product is lowered, any descendant whose rate
 * is now > the new rate becomes invalid. Callers choose how to resolve:
 * reject the change, clamp descendants, or require explicit confirmation.
 *
 * Returns rows: [{ agent_id, agent_name, rate_per_lot }]
 */
export async function findDescendantsExceeding(agentId, productId, newRate, db = defaultPool) {
  const { rows } = await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM users WHERE parent_agent_id = $1 AND is_agent = true
       UNION ALL
       SELECT u.id FROM users u
       JOIN subtree s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true
     )
     SELECT ap.agent_id, u.name AS agent_name, ap.rate_per_lot
     FROM agent_products ap
     JOIN subtree s ON s.id = ap.agent_id
     JOIN users u ON u.id = ap.agent_id
     WHERE ap.product_id = $2 AND ap.is_active = true AND ap.rate_per_lot > $3
     ORDER BY ap.rate_per_lot DESC`,
    [agentId, productId, newRate]
  );
  return rows;
}
