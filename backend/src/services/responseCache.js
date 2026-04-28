/**
 * In-memory response cache for admin read endpoints.
 *
 * Built specifically to reduce Supabase egress (we blew past the 250 GB Pro
 * quota because every admin page load runs heavy aggregate queries that pull
 * large result sets from the DB). By caching the JSON response for 30-120s,
 * repeat page loads within that window skip the DB entirely.
 *
 * Design:
 *   - Single in-process Map (per backend worker). Good enough for one-process
 *     PM2 deploy. If we scale to multiple workers, move to Redis.
 *   - Cache key = URL + sorted-query-string + user.role + user.clientScope.
 *     We include role/scope so rep and admin never get each other's data.
 *   - TTL per-endpoint, set at mount time via `cacheMw({ ttl })`.
 *   - `Cache-Control: max-age=N, stale-while-revalidate=30` emitted so the
 *     frontend / browser can layer its own cache on top.
 *   - `X-Cache: HIT|MISS` header so you can inspect in DevTools.
 *   - Manual invalidation hook for write paths: `invalidateCache(pattern)`.
 *   - LRU-ish eviction at 500 entries to cap memory.
 *
 * Non-goals:
 *   - Distributed cache (one backend process is enough today)
 *   - Cache for write-side endpoints (they're a bug magnet)
 *   - Per-user caching for huge multi-tenant scenarios
 */

const cache = new Map(); // key -> { value, expiresAt, size }
const MAX_ENTRIES = 500;

function normaliseKey(req) {
  const base = req.originalUrl || req.url || '/';
  // Include user scope so admin and rep see different caches even for the same URL
  const role = req.user?.role || 'anon';
  const scope = req.user?.clientScope || 'all';
  const branchScope = Array.isArray(req.user?.branchScope)
    ? req.user.branchScope.slice().sort().join(',')
    : '';
  return `${role}|${scope}|${branchScope}|${base}`;
}

function evictIfFull() {
  if (cache.size < MAX_ENTRIES) return;
  // Evict the 20% oldest entries in insertion order. JS Map preserves insertion order.
  const toEvict = Math.ceil(MAX_ENTRIES * 0.2);
  let n = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (++n >= toEvict) break;
  }
}

/**
 * Express middleware.
 *   app.get('/api/admin/dashboard', cacheMw({ ttl: 60 }), handler)
 *
 * Only caches 200 responses (error responses pass through). Only GET.
 */
export function cacheMw({ ttl = 60 } = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = normaliseKey(req);
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && hit.expiresAt > now) {
      res.setHeader('Cache-Control', `private, max-age=${ttl}, stale-while-revalidate=30`);
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Age-Sec', Math.round((now - (hit.expiresAt - ttl * 1000)) / 1000));
      return res.status(200).json(hit.value);
    }
    // Miss — intercept res.json to capture the 200 body, then store it
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && body !== undefined) {
        evictIfFull();
        cache.set(key, { value: body, expiresAt: now + ttl * 1000 });
      }
      res.setHeader('Cache-Control', `private, max-age=${ttl}, stale-while-revalidate=30`);
      res.setHeader('X-Cache', 'MISS');
      return origJson(body);
    };
    next();
  };
}

/**
 * Purge entries whose key matches the given RegExp or substring. Call this
 * from write-path handlers (agent imports, rate edits, etc.) to invalidate
 * any cached reads that might be out of date.
 *
 * Examples:
 *   invalidateCache('/api/agents')           // any URL containing /api/agents
 *   invalidateCache(/^.*\/agents(\/|$)/)     // RegExp
 */
export function invalidateCache(pattern) {
  const re = pattern instanceof RegExp
    ? pattern
    : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let purged = 0;
  for (const k of cache.keys()) {
    if (re.test(k)) { cache.delete(k); purged++; }
  }
  return purged;
}

/** Drop everything — mostly useful for tests or admin-triggered nuke. */
export function clearCache() {
  const n = cache.size;
  cache.clear();
  return n;
}

/** Small diagnostic. */
export function getCacheStats() {
  const now = Date.now();
  let live = 0, expired = 0;
  for (const { expiresAt } of cache.values()) {
    if (expiresAt > now) live++; else expired++;
  }
  return { size: cache.size, live, expired, max_entries: MAX_ENTRIES };
}
