/**
 * Branch sync from x-dev's CRM.
 *
 * Pulls all pages of GET /api/branches (default pageSize=10 but x-dev has
 * 18 branches total, so we request pageSize=200 to grab the lot in one call).
 * Upserts into the Supabase `branches` table keyed by `source_id = remote._id`.
 *
 * Enriches the existing freeform branch rows:
 *  - `code`         from remote.code        (e.g. "HTK99")
 *  - `location`     from remote.location    (e.g. "Kinshasa")
 *  - `gateway_code` from remote.gatewayCode
 *  - `is_default`   from remote.isDefault
 *  - `is_active`    from remote.status
 *  - `source`       set to 'crm'
 *
 * Branches already in Supabase as freeform text (from prior contact syncs) are
 * adopted via a name match — same pattern as `productImport.js`.
 */
import { crmRequest } from './crmGate.js';
import pool from '../db/pool.js';

async function fetchAllBranches() {
  const all = [];
  const pageSize = 200;
  let page = 1;
  const MAX_PAGES = 10;
  while (page <= MAX_PAGES) {
    const data = await crmRequest(`/api/branches?page=${page}&pageSize=${pageSize}`);
    const batch = Array.isArray(data?.branches) ? data.branches : Array.isArray(data) ? data : [];
    all.push(...batch);
    const pg = data?.pagination;
    if (!pg || !pg.hasNextPage) break;
    if (pg.totalPages && page >= pg.totalPages) break;
    if (batch.length < pageSize) break;
    page++;
  }
  return all;
}

export async function syncBranchesFromCRM() {
  const start = Date.now();
  const summary = { fetched: 0, created: 0, updated: 0, adopted: 0, skipped: 0, errors: 0 };

  const remote = await fetchAllBranches();
  summary.fetched = remote.length;

  for (const b of remote) {
    try {
      if (!b?._id || !b?.name) { summary.skipped++; continue; }
      const sourceId = String(b._id);
      const name = String(b.name).slice(0, 100);
      const code = b.code ? String(b.code).slice(0, 50) : null;
      const location = b.location ? String(b.location).slice(0, 255) : null;
      const gatewayCode = b.gatewayCode ? String(b.gatewayCode).slice(0, 100) : null;
      const isActive = b.status === true;
      const isDefault = b.isDefault === true;

      const { rows: existing } = await pool.query(
        'SELECT id FROM branches WHERE source_id = $1',
        [sourceId]
      );

      if (existing[0]) {
        await pool.query(
          `UPDATE branches
             SET name = $1, code = $2, location = $3, gateway_code = $4,
                 is_active = $5, is_default = $6, source = 'crm', updated_at = NOW()
           WHERE id = $7`,
          [name, code, location, gatewayCode, isActive, isDefault, existing[0].id]
        );
        summary.updated++;
      } else {
        // Adopt any pre-existing freeform row that matches by name and has no source_id
        const { rows: nameMatch } = await pool.query(
          `SELECT id FROM branches WHERE name = $1 AND source_id IS NULL LIMIT 1`,
          [name]
        );
        if (nameMatch[0]) {
          await pool.query(
            `UPDATE branches
               SET source_id = $1, code = $2, location = $3, gateway_code = $4,
                   is_active = $5, is_default = $6, source = 'crm', updated_at = NOW()
             WHERE id = $7`,
            [sourceId, code, location, gatewayCode, isActive, isDefault, nameMatch[0].id]
          );
          summary.adopted++;
        } else {
          await pool.query(
            `INSERT INTO branches
               (name, code, location, gateway_code, is_active, is_default, source, source_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'crm', $7, NOW(), NOW())`,
            [name, code, location, gatewayCode, isActive, isDefault, sourceId]
          );
          summary.created++;
        }
      }
    } catch (err) {
      console.error('[BranchImport] failed for', b?._id, '-', err.message);
      summary.errors++;
    }
  }

  summary.durationMs = Date.now() - start;
  console.log('[BranchImport] done:', summary);
  return summary;
}
