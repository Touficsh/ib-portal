/**
 * CRM Gate — single checkpoint for every outbound call to x-dev's CRM.
 *
 * Every helper that talks to `${CRM_API_BASE_URL}` must funnel through
 * `crmRequest()` defined here. That gives us FIVE guardrails in one place:
 *
 *   1. **Kill switch** — reading `settings.crm_paused='true'` makes every
 *      call throw `CrmPausedError` immediately.
 *   2. **Token-bucket rate limit** — max `crm_rate_per_second` req/s globally.
 *   3. **Concurrency cap** — max `crm_max_concurrency` calls in flight.
 *   4. **Per-endpoint daily budget** — cap on total calls per endpoint-pattern
 *      per UTC day. Protects against any single endpoint eating the whole
 *      CRM's capacity.
 *   5. **Circuit breaker** — tracks consecutive errors; on threshold,
 *      auto-pauses either that endpoint or the whole CRM (configurable).
 *
 * Plus: optional response cache for read-only low-change endpoints (products,
 * branches) so repeated calls within a TTL window are served from memory.
 *
 * All config lives in `settings` (tunable live, no restart):
 *   crm_paused              'true' | 'false'
 *   crm_rate_per_second     integer (default 4)
 *   crm_max_concurrency     integer (default 4)
 *   crm_circuit_threshold   integer (default 5) — errors in a 60s window before tripping
 *   crm_budgets             JSON like {"trading-accounts": 2000, "contacts-detail": 500}
 */
import pool from '../db/pool.js';
import { getCrmConfig } from './crmConfig.js';

export class CrmPausedError extends Error {
  constructor(reason = 'paused') {
    super(`CRM is paused (${reason}) — outbound CRM calls disabled`);
    this.name = 'CrmPausedError';
    this.code = 'CRM_PAUSED';
    this.status = 503;
  }
}

export class CrmBudgetExceededError extends Error {
  constructor(endpoint, budget, used) {
    super(`CRM daily budget exceeded for ${endpoint}: used ${used}/${budget}`);
    this.name = 'CrmBudgetExceededError';
    this.code = 'CRM_BUDGET_EXCEEDED';
    this.status = 429;
    this.endpoint = endpoint;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Endpoint classification — groups paths into budget buckets
// ────────────────────────────────────────────────────────────────────────
// Bucket names are stable identifiers used in settings.crm_budgets.
// Matching is done by substring/prefix; the first matching rule wins.
const ENDPOINT_BUCKETS = [
  { bucket: 'trading-accounts',  match: (p) => p.includes('/trading-accounts') },
  { bucket: 'commission-levels', match: (p) => p.startsWith('/api/agent-commission-levels') },
  { bucket: 'contacts-list',     match: (p) => /^\/api\/contacts(\?|$)/.test(p) },
  { bucket: 'contacts-detail',   match: (p) => /^\/api\/contacts\/[^/]+(\?|$)/.test(p) },
  { bucket: 'products',          match: (p) => p.startsWith('/api/products') },
  { bucket: 'branches',          match: (p) => p.startsWith('/api/branches') },
  { bucket: 'agents-query',      match: (p) => p.startsWith('/api/agents/query') },
  { bucket: 'money-report',      match: (p) => p.includes('money-report') },
  { bucket: 'other',             match: () => true },
];

// Default daily budgets per bucket. Sized to comfortably serve a full
// branch import + a day of scheduled autoSync without letting runaway code
// drown the CRM. Tune via settings.crm_budgets (merged with these).
const DEFAULT_BUDGETS = {
  'trading-accounts':  3000,  // covers Tier 3 hourly (24 × 200) + some headroom
  'commission-levels': 2000,  // one per agent for level sync; generous since incremental
  'contacts-list':     500,   // paginated list calls
  'contacts-detail':   1000,  // per-contact enrichment
  'products':          50,
  'branches':          50,
  'agents-query':      100,
  'money-report':      100,
  'other':             200,
};

function bucketForPath(path) {
  for (const { bucket, match } of ENDPOINT_BUCKETS) {
    if (match(path)) return bucket;
  }
  return 'other';
}

// ────────────────────────────────────────────────────────────────────────
// Settings cache (10s TTL — near-free reads)
// ────────────────────────────────────────────────────────────────────────
const SETTINGS_TTL_MS = 10_000;
let settingsCache = null;
let settingsCacheAt = 0;
const runtimeDefaults = {
  paused: false,
  ratePerSecond: 4,
  maxConcurrency: 4,
  circuitThreshold: 5,
  circuitWindowMs: 60_000,
  circuitCooldownMs: 300_000,  // 5 min endpoint cooldown after tripping
  budgets: { ...DEFAULT_BUDGETS },
};

async function getGateSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings
        WHERE key IN ('crm_paused', 'crm_rate_per_second', 'crm_max_concurrency',
                      'crm_circuit_threshold', 'crm_budgets')`
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    let budgets = { ...DEFAULT_BUDGETS };
    if (map.crm_budgets) {
      try { budgets = { ...budgets, ...JSON.parse(map.crm_budgets) }; } catch { /* keep defaults */ }
    }
    settingsCache = {
      paused: map.crm_paused === 'true',
      ratePerSecond: Number(map.crm_rate_per_second) || runtimeDefaults.ratePerSecond,
      maxConcurrency: Number(map.crm_max_concurrency) || runtimeDefaults.maxConcurrency,
      circuitThreshold: Number(map.crm_circuit_threshold) || runtimeDefaults.circuitThreshold,
      circuitWindowMs: runtimeDefaults.circuitWindowMs,
      circuitCooldownMs: runtimeDefaults.circuitCooldownMs,
      budgets,
    };
    settingsCacheAt = now;
  } catch {
    settingsCache = { ...runtimeDefaults };
    settingsCacheAt = now;
  }
  return settingsCache;
}

export function invalidateCrmGateCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

// ────────────────────────────────────────────────────────────────────────
// Per-endpoint usage counters — resets at UTC midnight
// ────────────────────────────────────────────────────────────────────────
let usageDay = new Date().toISOString().slice(0, 10);
const usage = new Map();  // bucket → count
function noteUsage(bucket) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usageDay) {
    usage.clear();
    usageDay = today;
  }
  usage.set(bucket, (usage.get(bucket) || 0) + 1);
}
function usageFor(bucket) {
  return usage.get(bucket) || 0;
}

// ────────────────────────────────────────────────────────────────────────
// Circuit breaker — per-endpoint error tracking
// ────────────────────────────────────────────────────────────────────────
const circuit = new Map();  // bucket → { errorsInWindow: [timestamps], trippedUntil: ms | null }
function recordError(bucket, settings) {
  const s = circuit.get(bucket) || { errorsInWindow: [], trippedUntil: null };
  const now = Date.now();
  s.errorsInWindow = [...s.errorsInWindow.filter(t => now - t < settings.circuitWindowMs), now];
  if (s.errorsInWindow.length >= settings.circuitThreshold) {
    s.trippedUntil = now + settings.circuitCooldownMs;
    console.warn(`[CRM gate] Circuit tripped on ${bucket}: ${s.errorsInWindow.length} errors in ${settings.circuitWindowMs}ms. Cooldown ${settings.circuitCooldownMs}ms.`);
  }
  circuit.set(bucket, s);
}
function recordSuccess(bucket) {
  const s = circuit.get(bucket);
  if (s) {
    s.errorsInWindow = [];
    s.trippedUntil = null;
  }
}
function isCircuitOpen(bucket) {
  const s = circuit.get(bucket);
  if (!s || !s.trippedUntil) return false;
  return Date.now() < s.trippedUntil;
}

// ────────────────────────────────────────────────────────────────────────
// Token bucket — smooth rate limiter
// ────────────────────────────────────────────────────────────────────────
let tokens = runtimeDefaults.ratePerSecond;
let lastRefillAt = Date.now();
const rateWaitQueue = [];

function refillTokens(ratePerSecond) {
  const now = Date.now();
  const elapsed = (now - lastRefillAt) / 1000;
  tokens = Math.min(ratePerSecond, tokens + elapsed * ratePerSecond);
  lastRefillAt = now;
}
function scheduleRateWakeup(ratePerSecond) {
  const msUntilNextToken = Math.max(10, (1000 / ratePerSecond) | 0);
  setTimeout(() => {
    refillTokens(ratePerSecond);
    while (tokens >= 1 && rateWaitQueue.length > 0) {
      tokens -= 1;
      rateWaitQueue.shift().resolve();
    }
    if (rateWaitQueue.length > 0) scheduleRateWakeup(ratePerSecond);
  }, msUntilNextToken).unref?.();
}
function waitForToken(ratePerSecond) {
  refillTokens(ratePerSecond);
  if (tokens >= 1) { tokens -= 1; return Promise.resolve(); }
  return new Promise(resolve => {
    rateWaitQueue.push({ resolve });
    if (rateWaitQueue.length === 1) scheduleRateWakeup(ratePerSecond);
  });
}

// ────────────────────────────────────────────────────────────────────────
// Concurrency semaphore
// ────────────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────────────
// Response cache — low-change endpoints (products, branches) served from
// memory within TTL. Avoids hammering the CRM when admin pages repeatedly
// fetch the same catalog data.
// ────────────────────────────────────────────────────────────────────────
const CACHEABLE_BUCKETS = new Set(['products', 'branches']);
const CACHE_TTL_MS = 15 * 60 * 1000;  // 15 minutes
const responseCache = new Map();  // path → { at, body }
function getCached(path, bucket) {
  if (!CACHEABLE_BUCKETS.has(bucket)) return null;
  const entry = responseCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { responseCache.delete(path); return null; }
  return entry.body;
}
function setCached(path, bucket, body) {
  if (!CACHEABLE_BUCKETS.has(bucket)) return;
  responseCache.set(path, { at: Date.now(), body });
}
export function clearCrmResponseCache() {
  responseCache.clear();
}

// ────────────────────────────────────────────────────────────────────────
// In-flight dedup — if caller A asks for GET /foo and caller B asks for
// the exact same path while A's request is still in flight, B piggybacks
// on A's Promise instead of starting a second HTTP call. This eliminates
// the "two code paths both wanted the same contact" waste without any
// persistent cache overhead. GET-only; keyed by method + path.
// ────────────────────────────────────────────────────────────────────────
const inFlightRequests = new Map();  // key → Promise<body>
function inFlightKey(method, path) { return `${method} ${path}`; }

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Throttled CRM request. Every call goes through:
 *   kill-switch → budget → circuit-breaker → response-cache →
 *   token-bucket → concurrency → fetch
 *
 * Throws:
 *   CrmPausedError           if crm_paused=true OR circuit breaker open
 *   CrmBudgetExceededError   if daily budget for this endpoint used up
 *
 * Arguments mirror `fetch`:
 *   path: string — path appended to CRM base URL (starts with "/")
 *   opts: { headers?, signal?, method?, body? } — x-api-key header added automatically
 */
export async function crmRequest(path, { headers = {}, signal, method = 'GET', body } = {}) {
  const gate = await getGateSettings();
  if (gate.paused) throw new CrmPausedError('admin-paused');

  const bucket = bucketForPath(path);
  if (isCircuitOpen(bucket)) throw new CrmPausedError(`circuit-${bucket}`);

  const budget = gate.budgets[bucket] ?? gate.budgets.other;
  if (budget != null && usageFor(bucket) >= budget) {
    throw new CrmBudgetExceededError(bucket, budget, usageFor(bucket));
  }

  // Response cache — GET only
  if (method === 'GET') {
    const cached = getCached(path, bucket);
    if (cached) return cached;
  }

  // In-flight dedup — GET only. If an identical request is already traveling
  // through the gate, piggyback on its Promise. Saves one full HTTP round
  // trip AND prevents duplicate budget consumption.
  if (method === 'GET') {
    const key = inFlightKey(method, path);
    const existing = inFlightRequests.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        return await crmRequestImpl(path, { headers, signal, method, body, gate, bucket });
      } finally {
        inFlightRequests.delete(key);
      }
    })();
    inFlightRequests.set(key, promise);
    return promise;
  }

  return crmRequestImpl(path, { headers, signal, method, body, gate, bucket });
}

/**
 * The actual fetch path. Extracted so the public crmRequest() can wrap it
 * with in-flight dedup without duplicating the throttle/fetch logic.
 */
async function crmRequestImpl(path, { headers, signal, method, body, gate, bucket }) {

  await waitForToken(gate.ratePerSecond);

  // Re-check pause + circuit AFTER we've waited — admin might have paused while queued
  const gate2 = await getGateSettings();
  if (gate2.paused) throw new CrmPausedError('admin-paused');
  if (isCircuitOpen(bucket)) throw new CrmPausedError(`circuit-${bucket}`);

  await acquireSlot(gate2.maxConcurrency);
  try {
    const gate3 = await getGateSettings();
    if (gate3.paused) throw new CrmPausedError('admin-paused');

    noteUsage(bucket);
    const { baseUrl, apiKey } = await getCrmConfig();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'x-api-key': apiKey, ...headers },
      body,
      signal,
    });

    // Track circuit breaker — 5xx and 429 count as errors
    if (res.status >= 500 || res.status === 429) {
      recordError(bucket, gate3);
      const text = await res.text().catch(() => '');
      const err = new Error(`CRM ${method} ${path} → ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      err.status = res.status;
      err.crmPath = path;
      throw err;
    }

    if (!res.ok) {
      // 4xx (not 429) — data issue not CRM health issue. Don't trip breaker.
      const text = await res.text().catch(() => '');
      const err = new Error(`CRM ${method} ${path} → ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      err.status = res.status;
      err.crmPath = path;
      throw err;
    }

    recordSuccess(bucket);
    const parsed = await res.json();
    if (method === 'GET') setCached(path, bucket, parsed);
    return parsed;
  } catch (err) {
    // Network errors trip the breaker too
    if (!err.status) recordError(bucket, gate);
    throw err;
  } finally {
    releaseSlot();
  }
}

/** Return current gate state for monitoring / admin UI. */
export async function getCrmGateState() {
  const gate = await getGateSettings();
  const endpointUsage = {};
  for (const [bucket, budget] of Object.entries(gate.budgets)) {
    endpointUsage[bucket] = { used: usageFor(bucket), budget };
  }
  const circuitState = {};
  for (const [bucket, s] of circuit.entries()) {
    circuitState[bucket] = {
      errors_in_window: s.errorsInWindow.length,
      tripped_until: s.trippedUntil ? new Date(s.trippedUntil).toISOString() : null,
      open: s.trippedUntil && Date.now() < s.trippedUntil,
    };
  }
  return {
    paused: gate.paused,
    ratePerSecond: gate.ratePerSecond,
    maxConcurrency: gate.maxConcurrency,
    inFlight: inFlightCount,
    queuedForRate: rateWaitQueue.length,
    queuedForConcurrency: concurrencyWaitQueue.length,
    tokensAvailable: Math.floor(tokens),
    endpointUsage,
    circuit: circuitState,
    usageDay,
    cacheSize: responseCache.size,
    inFlightDedupActive: inFlightRequests.size,
  };
}

export async function setCrmPaused(paused) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('crm_paused', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [paused ? 'true' : 'false']
  );
  invalidateCrmGateCache();
  // Reset circuit state so resume doesn't inherit stale breaker trips
  if (!paused) circuit.clear();
  return { paused };
}

/** Manually reset usage counters (e.g., after admin bumps a budget). */
export function resetCrmUsage(bucket = null) {
  if (bucket) usage.delete(bucket);
  else usage.clear();
}

/**
 * Preflight health check — lightweight gate status for code that's about to
 * make a chain of CRM calls (e.g., auto-finish after import). Returns a
 * plain object with a boolean `healthy` plus details. Callers should bail
 * out of multi-call flows when healthy=false, rather than racking up errors.
 *
 * Checks:
 *   - Gate paused?                        → unhealthy
 *   - Any circuit breaker currently open? → unhealthy (at least that bucket)
 *   - Kill switch setting?                → unhealthy
 *
 * Low cost: reads one settings row (cached for 5s in-process) + in-memory circuit state.
 */
export async function checkCrmGateHealth({ requiredBuckets = [] } = {}) {
  const gate = await getGateSettings();
  const issues = [];

  if (gate.paused) {
    issues.push({ reason: 'crm_paused', message: 'CRM gate is paused — resume before bulk operations' });
  }

  const now = Date.now();
  const openBuckets = [];
  for (const [bucket, s] of circuit.entries()) {
    if (s.trippedUntil && now < s.trippedUntil) {
      openBuckets.push({
        bucket,
        tripped_until: new Date(s.trippedUntil).toISOString(),
        errors_in_window: s.errorsInWindow.length,
      });
    }
  }

  if (openBuckets.length > 0) {
    issues.push({
      reason: 'circuit_open',
      message: `Circuit breaker open for bucket(s): ${openBuckets.map(b => b.bucket).join(', ')}`,
      buckets: openBuckets,
    });
  }

  // If the caller names specific buckets it needs, verify each is healthy.
  // Example: post-import needs 'contacts-detail' + 'commission-levels'.
  if (requiredBuckets.length > 0) {
    const unhealthyRequired = openBuckets.filter(b => requiredBuckets.includes(b.bucket));
    if (unhealthyRequired.length > 0) {
      issues.push({
        reason: 'required_bucket_open',
        buckets: unhealthyRequired.map(b => b.bucket),
      });
    }
  }

  return {
    healthy: issues.length === 0,
    paused: gate.paused,
    issues,
    checked_at: new Date().toISOString(),
  };
}
