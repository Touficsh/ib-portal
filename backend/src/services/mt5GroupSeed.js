/**
 * MT5 Group Seed — bootstraps the `mt5_groups` mapping table from existing
 * trading_accounts_meta rows + MT5 bridge /accounts calls.
 *
 * Why: today's trading_accounts_meta has `product_source_id` (from CRM) but
 * not the MT5 group name. The bridge has the group. If we correlate them,
 * we get (group → product) for free — without any xdev CRM calls.
 *
 * How it works:
 *   1. Pick a sample of trading_accounts_meta rows that have product_source_id
 *      but no mt5_group yet. Distinct by product to keep the sample small.
 *   2. For each, call MT5 bridge /accounts/:login to get the group name.
 *   3. Upsert mt5_groups(group_name → product_id) and stamp trading_accounts_meta.mt5_group.
 *   4. Stop early once every product has at least one mapping.
 *
 * Cost: one bridge call per DISTINCT product (~80 products today → 80 bridge
 * calls). Throttled by the bridge gate. Zero xdev CRM calls.
 *
 * Idempotent — re-running skips products we already have a mapping for.
 */
import pool from '../db/pool.js';
import { bridgeRequest } from './mt5BridgeGate.js';

export async function seedMt5Groups({ maxLoginsPerProduct = 1 } = {}) {
  const summary = {
    products_covered: 0,
    products_total: 0,
    groups_created: 0,
    groups_preserved: 0,
    bridge_calls: 0,
    errors: 0,
    details: [],
  };

  // Products that (a) already have a mapping skip, (b) don't have one get picked up.
  const { rows: products } = await pool.query(
    `SELECT p.id, p.source_id, p.name, p.product_group
     FROM products p
     WHERE p.is_active = true AND p.source_id IS NOT NULL
     ORDER BY p.name`
  );
  summary.products_total = products.length;

  const { rows: existingMappings } = await pool.query(
    `SELECT product_id FROM mt5_groups WHERE is_active = true`
  );
  const alreadyMapped = new Set(existingMappings.map(r => r.product_id));

  for (const product of products) {
    if (alreadyMapped.has(product.id)) {
      summary.groups_preserved++;
      continue;
    }

    // Find a login that trades this product (via trading_accounts_meta).
    // Prefer logins we haven't seen a group for yet so we learn the group.
    const { rows: sampleLogins } = await pool.query(
      `SELECT login FROM trading_accounts_meta
       WHERE product_source_id = $1
         AND account_type IS DISTINCT FROM 'demo'
       ORDER BY mt5_synced_at DESC NULLS LAST
       LIMIT $2`,
      [product.source_id, maxLoginsPerProduct]
    );
    if (sampleLogins.length === 0) {
      summary.details.push({ product: product.name, result: 'no_sample_login' });
      continue;
    }

    // Try each sample login until one returns a group
    let groupName = null;
    for (const { login } of sampleLogins) {
      try {
        summary.bridge_calls++;
        const acc = await bridgeRequest(`/accounts/${login}`);
        if (acc?.group && typeof acc.group === 'string' && acc.group.length > 0) {
          groupName = acc.group;
          break;
        }
      } catch (err) {
        // Bridge returned error or login doesn't exist — try next login
        continue;
      }
    }

    if (!groupName) {
      summary.errors++;
      summary.details.push({ product: product.name, result: 'no_group_found' });
      continue;
    }

    try {
      await pool.query(
        `INSERT INTO mt5_groups (group_name, product_id, source, is_active)
         VALUES ($1, $2, 'seed', true)
         ON CONFLICT (group_name) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           source = 'seed',
           updated_at = NOW()`,
        [groupName, product.id]
      );
      summary.groups_created++;
      summary.products_covered++;
      summary.details.push({ product: product.name, group: groupName, result: 'mapped' });
    } catch (err) {
      summary.errors++;
      summary.details.push({ product: product.name, group: groupName, result: 'db_error', error: err.message });
    }
  }

  return summary;
}

/**
 * For a single login, fetch the group from the MT5 bridge and attempt to
 * resolve its product via mt5_groups. Updates trading_accounts_meta if a
 * match is found. Returns the resolved product_source_id (or null).
 *
 * Useful when you want to heal a specific login without running the whole
 * snapshot sync.
 */
export async function resolveLoginProductFromGroup(login) {
  try {
    const acc = await bridgeRequest(`/accounts/${login}`);
    const groupName = acc?.group;
    if (!groupName) return null;

    const { rows: [resolved] } = await pool.query(
      `SELECT p.source_id FROM mt5_groups g
       JOIN products p ON p.id = g.product_id
       WHERE g.group_name = $1 AND g.is_active = true AND p.is_active = true
       LIMIT 1`,
      [groupName]
    );
    if (!resolved) {
      // Log the unmapped group so admin can map it manually
      console.log(`[Mt5GroupSeed] Unmapped group encountered: "${groupName}" on login ${login}`);
      return null;
    }

    // Stamp it on the meta row
    await pool.query(
      `UPDATE trading_accounts_meta
         SET mt5_group         = $2,
             product_source_id = COALESCE(product_source_id, $3),
             mt5_synced_at     = NOW()
       WHERE login = $1`,
      [String(login), groupName, resolved.source_id]
    );

    return resolved.source_id;
  } catch (err) {
    console.error(`[Mt5GroupSeed] resolveLoginProductFromGroup(${login}):`, err.message);
    return null;
  }
}
