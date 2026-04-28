/**
 * MT5 Bridge Gate — protection layer for outbound calls to the local MT5 bridge.
 *
 * Same pattern as services/crmGate.js but for the MT5 bridge. The bridge is
 * our own infrastructure so we're more generous with limits, but we still
 * want:
 *
 *   1. **Kill switch** — `settings.mt5_paused='true'` disables all bridge calls.
 *      Separate from CRM kill switch because you might want to stop one
 *      without stopping the other.
 *   2. **Rate limit + concurrency** — 20 req/sec, 16 concurrent (LAN-local
 *      so we can be bursty, but still capped so a buggy loop can't OOM the
 *      bridge).
 *   3. **Short-TTL balance cache** — `/balance?login=N` responses cached for
 *      10 seconds. Prevents the "open page with 50 accounts, click Load
 *      balance 3 times in a row" → 150 bridge calls anti-pattern.
 *   4. **In-flight dedup** — same as CRM gate; two callers of the same path
 *      share one HTTP call.
 *
 * Exports:
 *   bridgeRequest(path, opts)   — throttled fetch, returns parsed JSON
 *   bridgeRequestRaw(path, opts) — returns Response for streaming / custom parsing
 *   getMt5GateState()           — for admin status display
 *   setMt5Paused(bool)          — flip kill switch
 */
import pool from '../db/pool.js';

const BRIDGE_URL = process.env.MT5_BRIDGE_URL || 'http://localhost:5555';

export class Mt5PausedError extends Error {
  constructor() {
    super('MT5 bridge is paused by admin');
    this.name = 'Mt5PausedError';
    this.code = 'MT5_PAUSED';
    this.status = 503;
  }
}

// Settings cache
const SETTINGS_TTL_MS = 10_000;
let settingsCache = null;
let settingsCacheAt = 0;

async function getGateSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings
        WHERE key IN ('mt5_paused', 'mt5_rate_per_second', 'mt5_max_concurrency')`
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    settingsCache = {
      paused: map.mt5_paused === 'true',
      ratePerSecond: Number(map.mt5_rate_per_second) || 20,
      maxConcurrency: Number(map.mt5_max_concurrency) || 16,
    };
    settingsCacheAt = now;
  } catch {
    settingsCache = { paused: false, ratePerSecond: 20, maxConcurrency: 16 };
    settingsCacheAt = now;
  }
  return settingsCache;
}

export function invalidateMt5GateCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

// Token bucket
let tokens = 20;
let lastRefillAt = Date.now();
const rateWaitQueue = [];
function refillTokens(ratePerSecond) {
  const now = Date.now();
  const elapsed = (now - lastRefillAt) / 1000;
  tokens = Math.min(ratePerSecond, tokens + elapsed * ratePerSecond);
  lastRefillAt = now;
}
function scheduleRateWakeup(ratePerSecond) {
  const msUntilNext = Math.max(5, (1000 / ratePerSecond) | 0);
  setTimeout(() => {
    refillTokens(ratePerSecond);
    while (tokens >= 1 && rateWaitQueue.length > 0) {
      tokens -= 1;
      rateWaitQueue.shift().resolve();
    }
    if (rateWaitQueue.length > 0) scheduleRateWakeup(ratePerSecond);
  }, msUntilNext).unref?.();
}
function waitForToken(ratePerSecond) {
  refillTokens(ratePerSecond);
  if (tokens >= 1) { tokens -= 1; return Promise.resolve(); }
  return new Promise(resolve => {
    rateWaitQueue.push({ resolve });
    if (rateWaitQueue.length === 1) scheduleRateWakeup(ratePerSecond);
  });
}

// Concurrency
let inFlightCount = 0;
const concurrencyWaitQueue = [];
async function acquireSlot(maxConcurrency) {
  if (inFlightCount < maxConcurrency) { inFlightCount++; return; }
  await new Promise(resolve => concurrencyWaitQueue.push({ resolve }));
  inFlightCount++;
}
function releaseSlot() {
  inFlightCount--;
  if (concurrencyWaitQueue.length > 0) concurrencyWaitQueue.shift().resolve();
}

// Response cache (balance/equity — 10s TTL)
const BALANCE_CACHE_TTL_MS = 10_000;
const balanceCache = new Map();  // path → { at, body }
function isCacheablePath(path) {
  // /balance?login=N and /equity?login=N change by the second but within 10s
  // multiple clicks shouldn't each hit the bridge.
  return path.startsWith('/balance') || path.startsWith('/equity');
}
function getCached(path) {
  if (!isCacheablePath(path)) return null;
  const entry = balanceCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.at > BALANCE_CACHE_TTL_MS) { balanceCache.delete(path); return null; }
  return entry.body;
}
function setCached(path, body) {
  if (!isCacheablePath(path)) return;
  balanceCache.set(path, { at: Date.now(), body });
}

// In-flight dedup
const inFlightRequests = new Map();
function inFlightKey(method, path) { return `${method} ${path}`; }

/**
 * Throttled MT5 bridge request. Default returns parsed JSON; pass resolveJson:false
 * to get the raw Response object (for deal-history streams).
 */
export async function bridgeRequest(path, { method = 'GET', headers = {}, body, signal, resolveJson = true } = {}) {
  const gate = await getGateSettings();
  if (gate.paused) throw new Mt5PausedError();

  // Balance cache — GET only
  if (method === 'GET') {
    const cached = getCached(path);
    if (cached !== null) return cached;
  }

  // In-flight dedup — GET only
  if (method === 'GET' && resolveJson) {
    const key = inFlightKey(method, path);
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await bridgeRequestImpl(path, { method, headers, body, signal, resolveJson, gate });
      } finally {
        inFlightRequests.delete(key);
      }
    })();
    inFlightRequests.set(key, p);
    return p;
  }

  return bridgeRequestImpl(path, { method, headers, body, signal, resolveJson, gate });
}

async function bridgeRequestImpl(path, { method, headers, body, signal, resolveJson, gate }) {
  await waitForToken(gate.ratePerSecond);

  const gate2 = await getGateSettings();
  if (gate2.paused) throw new Mt5PausedError();

  await acquireSlot(gate2.maxConcurrency);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, { method, headers, body, signal });
    if (!resolveJson) return res;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`MT5 bridge ${method} ${path} → ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      err.status = res.status;
      throw err;
    }
    const parsed = await res.json();
    if (method === 'GET') setCached(path, parsed);
    return parsed;
  } finally {
    releaseSlot();
  }
}

export async function getMt5GateState() {
  const gate = await getGateSettings();
  return {
    paused: gate.paused,
    ratePerSecond: gate.ratePerSecond,
    maxConcurrency: gate.maxConcurrency,
    inFlight: inFlightCount,
    queuedForRate: rateWaitQueue.length,
    queuedForConcurrency: concurrencyWaitQueue.length,
    balanceCacheSize: balanceCache.size,
    inFlightDedupActive: inFlightRequests.size,
  };
}

export async function setMt5Paused(paused) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('mt5_paused', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [paused ? 'true' : 'false']
  );
  invalidateMt5GateCache();
  return { paused };
}
