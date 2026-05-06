/**
 * Product Import from x-dev CRM
 *
 * Source: GET /api/products on x-dev's CRM API.
 * Upserts into the local `products` table keyed by source_id = remote._id.
 *
 * max_rate_per_lot is NOT in the CRM — it is an IB-portal concept.
 * New rows land with 0 so the admin must set a ceiling before agents can earn.
 * Re-imports preserve whatever ceiling the admin already set.
 */
import { crmRequest } from './crmGate.js';
import pool from '../db/pool.js';

async function fetchAllCrmProducts() {
  const pageSize = 100;
  const all = [];
  let page = 1;
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const data = await crmRequest(`/api/products?page=${page}&pageSize=${pageSize}`);
    const batch = Array.isArray(data?.products) ? data.products
                : Array.isArray(data)           ? data
                : [];
    all.push(...batch);
    const pg = data?.pagination;
    if (!pg) break;
    if (pg.isEnd) break;
    if (pg.totalPages && page >= pg.totalPages) break;
    if (batch.length < pageSize) break;
    page++;
  }
  return all;
}

export async function syncProductsFromCRM() {
  const start = Date.now();
  const summary = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };

  let remote;
  try {
    remote = await fetchAllCrmProducts();
  } catch (err) {
    throw new Error(`Failed to fetch products from CRM: ${err.message}`);
  }

  summary.fetched = remote.length;

  for (const p of remote) {
    try {
      if (!p?._id || !p?.name) { summary.skipped++; continue; }

      const sourceId   = String(p._id);
      const name       = String(p.name).slice(0, 100);
      const code       = p.code        ? String(p.code).slice(0, 50)        : null;
      const description = p.description || null;
      const isActive   = p.status === 'active';
      const currency   = (p.currency?.name || 'USD').toUpperCase().slice(0, 10);
      const group      = p.group?.name  ? String(p.group.name).slice(0, 100) : null;

      const { rows: existing } = await pool.query(
        'SELECT id FROM products WHERE source_id = $1',
        [sourceId]
      );

      if (existing[0]) {
        await pool.query(
          `UPDATE products
              SET name         = $1,
                  description  = COALESCE($2, description),
                  currency     = $3,
                  is_active    = $4,
                  code         = $5,
                  product_group = $6,
                  source       = 'crm',
                  updated_at   = NOW()
            WHERE id = $7`,
          [name, description, currency, isActive, code, group, existing[0].id]
        );
        summary.updated++;
      } else {
        // Try to adopt a manual product with the same name (no source_id yet)
        const { rows: nameMatch } = await pool.query(
          'SELECT id FROM products WHERE name = $1 AND source_id IS NULL',
          [name]
        );
        if (nameMatch[0]) {
          await pool.query(
            `UPDATE products
                SET source_id    = $1, source = 'crm',
                    description  = COALESCE($2, description),
                    currency     = $3, is_active = $4,
                    code         = $5, product_group = $6,
                    updated_at   = NOW()
              WHERE id = $7`,
            [sourceId, description, currency, isActive, code, group, nameMatch[0].id]
          );
          summary.updated++;
        } else {
          await pool.query(
            `INSERT INTO products
               (name, description, max_rate_per_lot, currency, is_active,
                source_id, source, code, product_group)
             VALUES ($1, $2, 0, $3, $4, $5, 'crm', $6, $7)`,
            [name, description, currency, isActive, sourceId, code, group]
          );
          summary.created++;
        }
      }
    } catch (err) {
      console.error('[ProductImport] failed for', p?._id, '-', err.message);
      summary.errors++;
    }
  }

  summary.durationMs = Date.now() - start;
  console.log('[ProductImport] done:', summary);
  return summary;
}
