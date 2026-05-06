/**
 * Centralized cache for keys in the `settings` table.
 *
 * Why this exists: before this module, four different services each had their
 * own `getXxx()` getter with its own caching strategy (or no cache at all).
 * Editing a setting via the admin UI would clear ONE cache but not the others
 * — already caused a real bug today where `mt5_server_tz_offset_hours`
 * applied in the webhook receiver but not in the snapshot sync until restart.
 *
 * One cache, one TTL, one invalidator. All hot-path consumers route through
 * here. Admin PATCH handler calls `clearSettingsCache()` after every write,
 * so changes take effect within a few seconds.
 *
 * Pattern: lazy-load on first access, refresh on TTL expiry, single in-flight
 * refresh request via the `inflight` promise so a flurry of concurrent reads
 * don't all hit the DB.
 */
import pool from '../db/pool.js';

// Default TTL — long enough to be cheap on hot paths, short enough that a
// runtime edit (via admin UI) feels responsive without an explicit clear.
// Admin PATCH handlers call clearSettingsCache() so changes are immediate.
const TTL_MS = 30_000;

// Single source of truth: every key the system reads, plus a sane default.
// Defaults are used when the row is missing OR the stored value is invalid.
const DEFAULTS = Object.freeze({
  // MT5
  mt5_volume_divisor:         10_000,
  mt5_server_tz_offset_hours: 0,
  mt5_initial_lookback_days:  60,
  mt5_earliest_deal_date:     null,
  mt5_paused:                 'false',
  mt5_rate_per_second:        20,
  mt5_max_concurrency:        16,
  // Commission engine
  commission_trigger:         'on_open',
});

const KNOWN_KEYS = Object.keys(DEFAULTS);

let cache = null;
let cacheAt = 0;
let inflight = null;

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT key, value FROM settings WHERE key = ANY($1)`,
        [KNOWN_KEYS]
      );
      const next = { ...DEFAULTS };
      for (const r of rows) next[r.key] = r.value;
      cache = next;
      cacheAt = Date.now();
    } catch (err) {
      // Don't clobber an existing cache on transient DB errors — keep
      // serving the last-known values until the next refresh succeeds.
      if (!cache) cache = { ...DEFAULTS };
      console.warn('[settingsCache] refresh failed:', err.message);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function ensureFresh() {
  if (!cache || Date.now() - cacheAt > TTL_MS) {
    await refresh();
  }
  return cache;
}

/** Raw read of all known settings (debug / admin endpoints). */
export async function getAllSettings() {
  return { ...(await ensureFresh()) };
}

/** Returns the configured volume divisor, validated. */
export async function getMt5VolumeDivisor() {
  const s = await ensureFresh();
  const n = Number(s.mt5_volume_divisor);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS.mt5_volume_divisor;
}

/**
 * Returns the broker server's TZ offset, expressed in SECONDS, ready to
 * subtract from raw `deal.Time()` values. The setting is stored in hours
 * (a human-friendly UI value); we convert here so callers don't repeat
 * the multiplication.
 */
export async function getMt5ServerTzOffsetSec() {
  const s = await ensureFresh();
  const hours = Number(s.mt5_server_tz_offset_hours);
  return Number.isFinite(hours) ? hours * 3600 : 0;
}

/** Returns first-sync lookback as a millisecond duration. */
export async function getMt5InitialLookbackMs() {
  const s = await ensureFresh();
  const days = Number(s.mt5_initial_lookback_days);
  const valid = Number.isFinite(days) && days > 0 ? days : DEFAULTS.mt5_initial_lookback_days;
  return valid * 86_400_000;
}

/**
 * Returns the global "no deals before this date" hard floor as a ms timestamp,
 * or `null` if the setting is empty (meaning "no floor — only lookback applies").
 */
export async function getMt5EarliestDealDateMs() {
  const s = await ensureFresh();
  const raw = (s.mt5_earliest_deal_date || '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Returns one of: 'on_open' | 'on_close' | 'round_turn'. */
export async function getCommissionTrigger() {
  const s = await ensureFresh();
  const v = String(s.commission_trigger || '').toLowerCase();
  const valid = new Set(['on_open', 'on_close', 'round_turn']);
  return valid.has(v) ? v : DEFAULTS.commission_trigger;
}

/** Forget all cached values. Call after any write to `settings` table. */
export function clearSettingsCache() {
  cache = null;
  cacheAt = 0;
}
