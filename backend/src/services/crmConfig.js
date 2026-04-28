/**
 * CRM Config Service
 *
 * Centralized resolver for CRM API connection settings (base URL + API key).
 * Reads from the `settings` DB table first, falls back to environment variables.
 * Results are cached in-memory for 60 seconds to minimize DB round-trips.
 *
 * Used by: sync routes, AI suggestions, client routes, autoSync service.
 */
import pool from '../db/pool.js';

// Cache CRM settings for 60s to avoid DB lookups on every request
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

/**
 * Resolve CRM API base URL and key from settings table, falling back to env vars.
 * Returns { baseUrl, apiKey }
 */
export async function getCrmConfig() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('crm_base_url', 'crm_api_key')`
    );
    const map = {};
    for (const row of rows) map[row.key] = row.value;

    cache = {
      baseUrl: map.crm_base_url || process.env.CRM_API_BASE_URL || 'http://localhost:8000/api/crm',
      apiKey: map.crm_api_key || process.env.CRM_API_KEY || '',
    };
    cacheTime = now;
  } catch {
    // On DB error, fall back to env vars
    cache = {
      baseUrl: process.env.CRM_API_BASE_URL || 'http://localhost:8000/api/crm',
      apiKey: process.env.CRM_API_KEY || '',
    };
    cacheTime = now;
  }

  return cache;
}

/** Invalidate the cache (e.g. after saving new settings) */
export function clearCrmConfigCache() {
  cache = null;
  cacheTime = 0;
}
