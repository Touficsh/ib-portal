/**
 * MT5 Login → Product Resolver
 *
 * The new architecture (2026-05-04+) replaces CRM `/api/contacts/:id/trading-accounts`
 * with this bridge-driven resolver:
 *
 *   1. Engine sees a deal on a login whose `trading_accounts_meta.product_source_id`
 *      is NULL.
 *   2. We call this resolver: `resolveLoginToProduct(login)`.
 *   3. Resolver hits MT5 bridge /accounts/:login → returns the login's mt5_group
 *      (e.g., "real\BBCorp\PM Plus 10").
 *   4. Resolver looks up `mt5_groups` table: group_name → product_id.
 *   5. Writes `trading_accounts_meta.product_source_id` for permanent caching.
 *   6. Returns the product info to the caller.
 *
 * Result: zero xdev CRM calls in the deal pipeline. Every login resolves
 * via the local bridge + a local SQL JOIN.
 *
 * Failure modes:
 *   - Bridge unreachable → resolver returns null; engine skips this deal
 *     and retries on the next cycle.
 *   - mt5_group not in mt5_groups → resolver returns null AND records the
 *     unknown group (so admin can map it). Engine skips deal until mapped.
 */
import pool from '../db/pool.js';
import { bridgeRequest } from './mt5BridgeGate.js';

// In-memory negative-result cache so we don't hammer the bridge for logins
// whose group can't be mapped. 5 minute TTL — admin maps it, retry succeeds.
const unresolvedCache = new Map();   // login → { until, reason }
const NEG_CACHE_MS = 5 * 60 * 1000;

function cacheUnresolved(login, reason) {
  unresolvedCache.set(String(login), { until: Date.now() + NEG_CACHE_MS, reason });
}
function isNegativelyCached(login) {
  const e = unresolvedCache.get(String(login));
  if (!e) return false;
  if (Date.now() > e.until) { unresolvedCache.delete(String(login)); return false; }
  return true;
}
export function clearResolverCache() { unresolvedCache.clear(); }

/**
 * Resolve a login to its product. Returns null if it can't be resolved
 * (bridge down, unknown group, etc.). Side effect: writes product_source_id
 * to trading_accounts_meta on success.
 *
 * @param {string|number} login
 * @returns {Promise<{product_id: string, product_source_id: string, mt5_group: string} | null>}
 */
export async function resolveLoginToProduct(login) {
  const loginStr = String(login);
  if (isNegativelyCached(loginStr)) return null;

  // 1. Already resolved? Short-circuit. The engine usually checks this
  // upstream too, but this is a safety net.
  const { rows: [existing] } = await pool.query(
    `SELECT tam.product_source_id, tam.mt5_group, p.id AS product_id
       FROM trading_accounts_meta tam
       LEFT JOIN products p ON p.source_id = tam.product_source_id
      WHERE tam.login = $1`,
    [loginStr]
  );
  if (existing?.product_source_id && existing?.product_id) {
    return {
      product_id: existing.product_id,
      product_source_id: existing.product_source_id,
      mt5_group: existing.mt5_group || null,
    };
  }

  // 2. Ask the bridge for this login's MT5 group.
  let group = existing?.mt5_group || null;
  if (!group) {
    try {
      const account = await bridgeRequest(`/accounts/${loginStr}`, {
        signal: AbortSignal.timeout(8000),
      });
      group = account?.group || null;
    } catch (err) {
      cacheUnresolved(loginStr, `bridge fetch failed: ${err.message}`);
      return null;
    }
    if (!group) {
      cacheUnresolved(loginStr, 'bridge returned no group');
      return null;
    }
  }

  // 3. Look up mt5_groups → product
  const { rows: [mapping] } = await pool.query(
    `SELECT g.product_id, p.source_id AS product_source_id
       FROM mt5_groups g
       JOIN products p ON p.id = g.product_id
      WHERE g.group_name = $1 AND g.is_active = true
      LIMIT 1`,
    [group]
  );
  if (!mapping) {
    // Unknown group — record it so admin can see what's pending mapping.
    // We DON'T auto-create the row; admin must explicitly assign a product.
    try {
      await pool.query(
        `INSERT INTO mt5_groups (group_name, product_id, is_active)
         VALUES ($1, NULL, false)
         ON CONFLICT (group_name) DO NOTHING`,
        [group]
      );
    } catch { /* non-fatal */ }
    cacheUnresolved(loginStr, `mt5_group '${group}' is not mapped to a product`);
    return null;
  }

  // 4. Write back to trading_accounts_meta. This is the permanent cache —
  // next time the engine sees this login, the upstream check returns it
  // without any bridge call.
  try {
    await pool.query(
      `UPDATE trading_accounts_meta
          SET product_source_id = $1,
              mt5_group         = $2,
              last_synced_at    = NOW()
        WHERE login = $3`,
      [mapping.product_source_id, group, loginStr]
    );
  } catch (err) {
    console.error('[LoginResolver] failed to update trading_accounts_meta for', loginStr, err.message);
  }

  return {
    product_id: mapping.product_id,
    product_source_id: mapping.product_source_id,
    mt5_group: group,
  };
}

/**
 * Show admin which mt5 groups have been seen but not yet mapped to products.
 * Used by the admin UI to surface a "needs attention" list.
 */
export async function listUnmappedGroups() {
  const { rows } = await pool.query(
    `SELECT group_name, created_at
       FROM mt5_groups
      WHERE product_id IS NULL
      ORDER BY created_at DESC
      LIMIT 50`
  );
  return rows;
}
