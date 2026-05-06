/**
 * IB Commission Level Sync
 *
 * Reads per-agent, per-product commission rates from x-dev CRM:
 *   GET /api/agent-commission-levels?ib_wallet_id=<id>
 *
 * Data shape from CRM:
 *   product_configs.<key>.product_id          — CRM product _id
 *   product_configs.<key>.commission_per_lot  — rebate per lot (agent earns this on top)
 *   product_configs.<key>.groups[].commission_per_lot  — primary rate agent earns per lot
 *   product_configs.<key>.groups[].commission_percentage — % of product max (100 = full)
 *   product_configs.<key>.groups[].is_active
 *
 * What we write locally:
 *   agent_products.rate_per_lot  — the highest active group commission_per_lot
 *                                  (represents what the agent earns per lot traded)
 *   products.max_rate_per_lot    — the maximum rate we've seen across all agents
 *                                  for that product (only raised, never lowered)
 *
 * Idempotent. Re-running updates stale rates without duplicating rows.
 */
import { crmRequest } from './crmGate.js';
import pool from '../db/pool.js';

/**
 * Fetch the IB wallet ID for a CRM contact (agent's linked_client_id).
 * Returns null if the contact has no IB wallet.
 */
async function fetchIbWalletId(crmContactId) {
  const data = await crmRequest(`/api/contacts/${crmContactId}`);
  const wallets = data?.clientProfile?.ibWallets;
  if (!Array.isArray(wallets) || wallets.length === 0) return null;
  return wallets[0]._id || null;
}

/**
 * Fetch commission level config for one IB wallet.
 * Returns array of commission level documents (usually 1).
 */
async function fetchCommissionLevels(ibWalletId) {
  const data = await crmRequest(`/api/agent-commission-levels?ib_wallet_id=${ibWalletId}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Extract a Map<product_source_id, { ratePerLot, rebatePerLot }> from one
 * commission level document.
 *
 * ratePerLot  = max active group commission_per_lot (what agent earns per lot)
 * rebatePerLot = product-level commission_per_lot  (bonus rebate on top)
 */
function extractProductRates(commissionLevel) {
  const configs = commissionLevel?.product_configs || {};
  const rates = new Map();

  for (const config of Object.values(configs)) {
    const productSourceId = config?.product_id;
    if (!productSourceId) continue;

    // Primary rate = highest active group commission_per_lot
    const activeGroups = (config.groups || []).filter(g => g.is_active !== false);
    const groupRates = activeGroups.map(g => Number(g.commission_per_lot) || 0).filter(r => r > 0);
    const ratePerLot = groupRates.length > 0 ? Math.max(...groupRates) : 0;

    // Rebate = product-level commission_per_lot
    const rebatePerLot = Number(config.commission_per_lot) || 0;

    rates.set(productSourceId, { ratePerLot, rebatePerLot });
  }
  return rates;
}

/**
 * Sync commission rates for a single imported portal agent.
 *
 * @param {string} userId — portal users.id
 * @returns summary object
 */
export async function syncCommissionLevelsForAgent(userId) {
  const summary = { userId, ratesSet: 0, productsUpdated: 0, skipped: 0, errors: 0, noWallet: false };

  // Resolve linked_client_id
  const { rows: [agent] } = await pool.query(
    'SELECT id, name, linked_client_id FROM users WHERE id = $1 AND is_agent = true',
    [userId]
  );
  if (!agent?.linked_client_id) { summary.skipped++; return summary; }

  // Fetch IB wallet ID from CRM contact profile
  let ibWalletId;
  try {
    ibWalletId = await fetchIbWalletId(agent.linked_client_id);
  } catch (err) {
    console.error(`[IBCommSync] fetchIbWalletId failed for ${agent.name}:`, err.message);
    summary.errors++;
    return summary;
  }

  if (!ibWalletId) {
    summary.noWallet = true;
    return summary;
  }

  // Fetch commission levels
  let levels;
  try {
    levels = await fetchCommissionLevels(ibWalletId);
  } catch (err) {
    console.error(`[IBCommSync] fetchCommissionLevels failed for ${agent.name}:`, err.message);
    summary.errors++;
    return summary;
  }

  if (!levels.length) { summary.skipped++; return summary; }

  // Collect all product rates across all level docs (usually just 1)
  const allRates = new Map();
  for (const level of levels) {
    for (const [sourceId, r] of extractProductRates(level)) {
      // If seen in multiple docs, take the max
      const existing = allRates.get(sourceId);
      if (!existing || r.ratePerLot > existing.ratePerLot) {
        allRates.set(sourceId, r);
      }
    }
  }

  if (allRates.size === 0) { summary.skipped++; return summary; }

  // Resolve local product IDs from source_ids
  const sourceIds = [...allRates.keys()];
  const { rows: localProducts } = await pool.query(
    'SELECT id, source_id, max_rate_per_lot FROM products WHERE source_id = ANY($1)',
    [sourceIds]
  );
  const productBySourceId = new Map(localProducts.map(p => [p.source_id, p]));

  for (const [sourceId, { ratePerLot, rebatePerLot }] of allRates) {
    const product = productBySourceId.get(sourceId);
    if (!product) continue; // product not yet synced — skip

    try {
      // Update agent_products.rate_per_lot for this (agent, product) pair.
      // Only updates rows that exist; doesn't create new links (that's agentProductSync's job).
      const { rowCount } = await pool.query(
        `UPDATE agent_products
            SET rate_per_lot = $1,
                updated_at   = NOW()
          WHERE agent_id  = $2
            AND product_id = $3`,
        [ratePerLot, userId, product.id]
      );

      if (rowCount > 0) {
        summary.ratesSet++;

        // Raise products.max_rate_per_lot if this agent's rate exceeds the current ceiling
        const currentMax = Number(product.max_rate_per_lot) || 0;
        if (ratePerLot > currentMax) {
          await pool.query(
            `UPDATE products SET max_rate_per_lot = $1, updated_at = NOW() WHERE id = $2`,
            [ratePerLot, product.id]
          );
          // Update local mirror so sibling agents in same batch get correct max
          product.max_rate_per_lot = ratePerLot;
          summary.productsUpdated++;
        }
      }
    } catch (err) {
      console.error(`[IBCommSync] rate update failed for agent=${userId} product=${product.id}:`, err.message);
      summary.errors++;
    }
  }

  return summary;
}

/**
 * Sync commission rates for ALL imported portal agents.
 * Runs agents in serial to respect CRM gate rate limits.
 *
 * @returns aggregate summary
 */
export async function syncCommissionLevelsForAll() {
  const start = Date.now();
  const agg = {
    agents: 0,
    agentsWithRates: 0,
    agentsNoWallet: 0,
    totalRatesSet: 0,
    totalProductsUpdated: 0,
    errors: 0,
    durationMs: 0,
  };

  const { rows: agents } = await pool.query(
    'SELECT id FROM users WHERE is_agent = true AND linked_client_id IS NOT NULL'
  );

  console.log(`[IBCommSync] Starting commission level sync for ${agents.length} agents…`);

  for (const { id } of agents) {
    try {
      const s = await syncCommissionLevelsForAgent(id);
      agg.agents++;
      if (s.noWallet) { agg.agentsNoWallet++; continue; }
      if (s.ratesSet > 0) agg.agentsWithRates++;
      agg.totalRatesSet      += s.ratesSet;
      agg.totalProductsUpdated += s.productsUpdated;
      agg.errors             += s.errors;
    } catch (err) {
      console.error(`[IBCommSync] agent ${id} failed:`, err.message);
      agg.errors++;
    }
  }

  agg.durationMs = Date.now() - start;
  console.log('[IBCommSync] done:', agg);
  return agg;
}
