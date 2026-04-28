/**
 * Lightweight cache abstraction.
 *
 * Currently backed by an in-process LRU (lru-cache). Designed so that the
 * entire surface area can be swapped for Redis (or any other KV store) by
 * replacing this one file — routes call `cache.wrap(key, ttl, fn)` without
 * needing to know the backend.
 *
 * Why in-process and not Redis right now:
 *   - Single Node backend, no horizontal scaling yet → extra hop isn't worth it
 *   - Zero operational overhead (no service to run, monitor, secure)
 *   - Lossy on restart — acceptable because our caches are warm-enough in
 *     60s and we always have the DB as source of truth
 *
 * Swap to Redis when:
 *   - You add a second backend instance (cache must be shared)
 *   - You want cache to survive restarts (warm cold-starts)
 *   - You want to invalidate cache from outside the Node process
 */
import { LRUCache } from 'lru-cache';
import { cacheHits, cacheMisses } from './metrics.js';

// Named caches — each with its own size + default TTL. Keep them separate so
// one hot subsystem can't evict another's entries.
const caches = new Map();

function getOrCreate(name, { max = 500, ttl = 30_000 } = {}) {
  let c = caches.get(name);
  if (!c) {
    c = new LRUCache({
      max,
      ttl,           // default TTL in ms
      updateAgeOnGet: false,  // don't extend TTL on read — keeps "how old is this" honest
    });
    caches.set(name, c);
  }
  return c;
}

/**
 * cache.wrap(cacheName, key, ttlMs, fn)
 * Returns the cached value if present, else calls fn(), stores the result,
 * and returns it. Metrics: hits/misses counted per cache name.
 */
export async function wrap(cacheName, key, ttlMs, fn) {
  const c = getOrCreate(cacheName, { max: 500, ttl: ttlMs });
  const hit = c.get(key);
  if (hit !== undefined) {
    cacheHits.labels(cacheName).inc();
    return hit;
  }
  cacheMisses.labels(cacheName).inc();
  const value = await fn();
  c.set(key, value, { ttl: ttlMs });
  return value;
}

/**
 * Invalidate a single key or prefix. Call this when a mutation changes data
 * the cache might serve stale.
 */
export function invalidate(cacheName, keyOrPrefix) {
  const c = caches.get(cacheName);
  if (!c) return 0;
  if (keyOrPrefix == null) {
    const n = c.size;
    c.clear();
    return n;
  }
  let removed = 0;
  for (const k of c.keys()) {
    if (k === keyOrPrefix || (typeof k === 'string' && k.startsWith(keyOrPrefix))) {
      c.delete(k);
      removed++;
    }
  }
  return removed;
}

/**
 * Inspect — for admin/debug UI to show cache state.
 */
export function stats() {
  const out = {};
  for (const [name, c] of caches.entries()) {
    out[name] = { size: c.size, max: c.max, calculatedSize: c.calculatedSize };
  }
  return out;
}
