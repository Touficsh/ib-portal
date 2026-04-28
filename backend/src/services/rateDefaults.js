/**
 * Rate defaults — auto-populate sensible commission rates when an agent is
 * freshly imported (so admins don't have to manually edit 45 agents × 2
 * products just to get the engine working). Complements rateCascade.js,
 * which validates rates; this one chooses a default rate that's guaranteed
 * to pass cascade validation.
 *
 * Policy:
 *   Top-level agents (no parent_agent_id)
 *     → default rate = products.max_rate_per_lot (full cut; admin can tune)
 *
 *   Sub-agents (have parent_agent_id)
 *     → inherit parent's rate for the same product (capped to max; guaranteed
 *       ≤ parent so cascade validator approves). If the parent doesn't hold
 *       that product yet, the child row stays at 0 and will be healed whenever
 *       the parent's rates are fixed and we re-run.
 *
 * Design principles:
 *  - Idempotent: only touches rows with rate_per_lot = 0. Admin-adjusted
 *    non-zero rates are preserved.
 *  - Source-preserving: rewrites rate but leaves `source` unchanged so the
 *    provenance trail (where the link originally came from) isn't lost.
 *  - Audit-friendly: returns a summary of every row touched so callers can
 *    log / show the result.
 *
 * Exports:
 *   ensureSensibleRates(userId)        — heal one agent
 *   healRatesForBranch(branchName)     — bulk-heal every agent in a branch
 *   healRatesForSubtree(rootAgentId)   — bulk-heal an agent + every descendant
 */
import pool from '../db/pool.js';

/**
 * Walks one agent's agent_products rows. For each row with rate_per_lot=0,
 * writes a sensible default (parent's rate or product max). Idempotent.
 *
 * Returns { checked, updated, skippedNoSource, details: [{product_id, product_name, old_rate, new_rate, source}] }
 */
export async function ensureSensibleRates(userId, db = pool) {
  const summary = {
    checked: 0,
    updated: 0,
    skippedNoSource: 0,  // row is 0, parent lacks product, and no max set
    details: [],
  };

  // Load agent + products in one round trip
  const { rows: [agent] } = await db.query(
    `SELECT id, name, parent_agent_id FROM users WHERE id = $1 AND is_agent = true`,
    [userId]
  );
  if (!agent) return { ...summary, error: 'agent_not_found' };

  const { rows: links } = await db.query(
    `SELECT ap.id, ap.product_id, ap.rate_per_lot, ap.source,
            p.name AS product_name, p.max_rate_per_lot, p.is_active AS product_active
     FROM agent_products ap
     JOIN products p ON p.id = ap.product_id
     WHERE ap.agent_id = $1 AND ap.is_active = true`,
    [userId]
  );
  if (links.length === 0) return summary;

  // Pre-fetch parent's rates for every product in one query (if parent exists)
  const parentRatesByProduct = new Map();
  if (agent.parent_agent_id) {
    const productIds = links.map(l => l.product_id);
    const { rows: parentAp } = await db.query(
      `SELECT product_id, rate_per_lot FROM agent_products
       WHERE agent_id = $1 AND is_active = true AND product_id = ANY($2)`,
      [agent.parent_agent_id, productIds]
    );
    for (const p of parentAp) {
      parentRatesByProduct.set(p.product_id, Number(p.rate_per_lot));
    }
  }

  for (const link of links) {
    summary.checked++;
    // Never overwrite a manually-set non-zero rate. Admin's word is final.
    if (Number(link.rate_per_lot) > 0) continue;
    if (!link.product_active) continue;

    // Choose the default
    let newRate = null;
    let source = null;
    if (agent.parent_agent_id) {
      const parentRate = parentRatesByProduct.get(link.product_id);
      if (parentRate != null && parentRate > 0) {
        // Inherit parent's rate (capped to product max as a safety rail)
        newRate = Math.min(parentRate, Number(link.max_rate_per_lot) || parentRate);
        source = 'cascade_parent';
      }
    } else {
      // Top-level — use the product's admin-set max
      const max = Number(link.max_rate_per_lot);
      if (max > 0) {
        newRate = max;
        source = 'product_max';
      }
    }

    if (newRate == null || newRate === 0) {
      summary.skippedNoSource++;
      continue;
    }

    await db.query(
      `UPDATE agent_products
         SET rate_per_lot = $1, updated_at = NOW()
       WHERE id = $2`,
      [newRate, link.id]
    );
    summary.updated++;
    summary.details.push({
      product_id: link.product_id,
      product_name: link.product_name,
      old_rate: Number(link.rate_per_lot),
      new_rate: newRate,
      source,
    });
  }

  return summary;
}

/**
 * Heal every imported agent inside one branch. Walks the tree top-down so
 * parent rates are set BEFORE children try to inherit them (otherwise the
 * first pass would leave children at 0 because the parent was also still at 0).
 *
 * Returns { agents, totalChecked, totalUpdated, perAgent: [{id, name, checked, updated}] }
 */
export async function healRatesForBranch(branchName, db = pool) {
  const summary = { agents: 0, totalChecked: 0, totalUpdated: 0, perAgent: [] };

  // Pull every imported agent in the branch, ordered root-first (nulls, then by depth)
  const { rows: agents } = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT u.id, u.name, u.parent_agent_id, 0 AS depth
       FROM users u
       JOIN clients c ON c.id = u.linked_client_id
       WHERE u.is_agent = true
         AND u.linked_client_id IS NOT NULL
         AND c.branch IS NOT DISTINCT FROM $1
         AND (u.parent_agent_id IS NULL OR u.parent_agent_id NOT IN (
           SELECT u2.id FROM users u2
           JOIN clients c2 ON c2.id = u2.linked_client_id
           WHERE u2.is_agent = true AND c2.branch IS NOT DISTINCT FROM $1
         ))
       UNION ALL
       SELECT u.id, u.name, u.parent_agent_id, t.depth + 1
       FROM users u
       JOIN tree t ON t.id = u.parent_agent_id
       WHERE u.is_agent = true
     )
     SELECT DISTINCT ON (id) id, name, depth
     FROM tree
     ORDER BY id, depth ASC`,
    [branchName === '(no branch)' ? null : branchName]
  );

  // Must re-sort by depth since DISTINCT ON disrupts ordering
  agents.sort((a, b) => a.depth - b.depth);

  for (const a of agents) {
    const r = await ensureSensibleRates(a.id, db);
    summary.agents++;
    summary.totalChecked += r.checked;
    summary.totalUpdated += r.updated;
    if (r.updated > 0) {
      summary.perAgent.push({ id: a.id, name: a.name, depth: a.depth, checked: r.checked, updated: r.updated });
    }
  }
  return summary;
}

/**
 * Heal an agent and every descendant beneath them. Used when admin fixes
 * one agent's rates and wants the change to propagate to all sub-agents.
 * Top-down ordering so children inherit the fresh parent rate on this pass.
 */
export async function healRatesForSubtree(rootAgentId, db = pool) {
  const summary = { agents: 0, totalChecked: 0, totalUpdated: 0, perAgent: [] };
  const { rows: agents } = await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, name, parent_agent_id, 0 AS depth
       FROM users WHERE id = $1 AND is_agent = true
       UNION ALL
       SELECT u.id, u.name, u.parent_agent_id, s.depth + 1
       FROM users u JOIN subtree s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true
     )
     SELECT id, name, depth FROM subtree ORDER BY depth ASC, name ASC`,
    [rootAgentId]
  );
  for (const a of agents) {
    const r = await ensureSensibleRates(a.id, db);
    summary.agents++;
    summary.totalChecked += r.checked;
    summary.totalUpdated += r.updated;
    if (r.updated > 0) {
      summary.perAgent.push({ id: a.id, name: a.name, depth: a.depth, checked: r.checked, updated: r.updated });
    }
  }
  return summary;
}
