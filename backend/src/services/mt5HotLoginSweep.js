/**
 * MT5 Hot-Login Fast Sweep — every few minutes, refreshes ONLY the subset
 * of MT5 logins that have traded recently (last `activeHours`). Most deals
 * happen on a small set of "hot" accounts, so this gives near-real-time
 * commission updates for actively-trading clients without the cost of
 * sweeping every login on every cycle.
 *
 * Runs ALONGSIDE the regular MT5 sweep (services/mt5SyncScheduler.js):
 *   - Hot sweep: every 5 min, ~200 logins, ~15-20s per cycle
 *   - Regular sweep: every 30 min, all 1300 logins, ~80s per cycle
 *
 * Bridge-only — no CRM or Supabase load impact. The bridge is local and
 * has its own gate (16 concurrent, 20 req/s) so this scales cleanly.
 *
 * Configuration (env vars):
 *   ENABLE_MT5_HOT_SWEEP            'true' to enable (default true)
 *   MT5_HOT_SWEEP_INTERVAL_MIN      cadence (default 5)
 *   MT5_HOT_SWEEP_ACTIVE_HOURS      "hot" window (default 24)
 *   MT5_HOT_SWEEP_DELAY_MIN         boot warm-up (default 2)
 *
 * Guards:
 *   - Single in-flight tick (in-memory lock)
 *   - Bridge gate enforces rate limits
 *   - Mt5PausedError aborts cleanly
 */
import pool from '../db/pool.js';
import { syncForLogin } from './mt5SnapshotSync.js';
import { runCommissionSync } from './commissionEngine.js';
import { Mt5PausedError } from './mt5BridgeGate.js';

const DEFAULT_INTERVAL_MIN = 5;
const DEFAULT_ACTIVE_HOURS = 24;
const DEFAULT_DELAY_MIN    = 2;
const CONCURRENCY          = 8;

let hotRunning = false;

async function runOnce({ activeHours }) {
  if (hotRunning) {
    return { skipped: true, reason: 'previous tick still running' };
  }
  hotRunning = true;
  const start = Date.now();
  const summary = {
    logins_scanned: 0,
    logins_synced: 0,
    logins_failed: 0,
    new_deals: 0,
    engine_triggered: false,
    duration_ms: 0,
  };

  try {
    // Hot logins = traded within `activeHours`, excluding ones already
    // synced in the last 4 minutes (avoids redundant churn during overlapping
    // ticks if a previous sweep just ran).
    const { rows: logins } = await pool.query(
      `SELECT DISTINCT tam.login
       FROM trading_accounts_meta tam
       WHERE tam.account_type IS DISTINCT FROM 'demo'
         AND tam.product_source_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM mt5_deal_cache d
           WHERE d.login = tam.login
             AND d.entry IS NOT NULL
             AND d.deal_time > NOW() - ($1 || ' hours')::interval
         )
         AND (
           tam.mt5_synced_at IS NULL
           OR tam.mt5_synced_at < NOW() - INTERVAL '4 minutes'
         )`,
      [String(activeHours)]
    );
    summary.logins_scanned = logins.length;
    if (logins.length === 0) {
      summary.duration_ms = Date.now() - start;
      return summary;
    }

    let index = 0;
    let paused = false;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          if (paused) break;
          const i = index++;
          if (i >= logins.length) break;
          try {
            const r = await syncForLogin(logins[i].login);
            if (r.ok) {
              summary.logins_synced++;
              summary.new_deals += r.deals_cached || 0;
            } else {
              summary.logins_failed++;
            }
          } catch (err) {
            if (err instanceof Mt5PausedError) {
              paused = true;
              break;
            }
            summary.logins_failed++;
          }
        }
      })
    );

    if (summary.new_deals > 0) {
      summary.engine_triggered = true;
      runCommissionSync({ triggeredBy: 'mt5-hot-sweep' })
        .catch(err => console.error('[MT5HotSweep] engine cycle failed:', err.message));
    }
  } catch (err) {
    console.error('[MT5HotSweep] tick failed:', err.message);
  } finally {
    hotRunning = false;
    summary.duration_ms = Date.now() - start;
  }

  console.log('[MT5HotSweep] tick:', {
    scanned: summary.logins_scanned,
    synced: summary.logins_synced,
    new_deals: summary.new_deals,
    engine: summary.engine_triggered,
    ms: summary.duration_ms,
  });
  return summary;
}

// Scheduler-state for the admin UI's "next run in X min" display.
let _hotIntervalMs = null;
let _hotNextRunAt  = null;
let _hotLastRunAt  = null;
let _hotEnabled    = false;

export function getMt5HotSweepStatus() {
  return {
    enabled:    _hotEnabled,
    intervalMs: _hotIntervalMs,
    nextRunAt:  _hotNextRunAt,
    lastRunAt:  _hotLastRunAt,
  };
}

export function startMt5HotLoginSweep({
  intervalMin = DEFAULT_INTERVAL_MIN,
  activeHours = DEFAULT_ACTIVE_HOURS,
  delayMin    = DEFAULT_DELAY_MIN,
} = {}) {
  const enabled = String(process.env.ENABLE_MT5_HOT_SWEEP || 'true').toLowerCase() === 'true';
  _hotEnabled = enabled;
  if (!enabled) {
    console.log('[MT5HotSweep] disabled (set ENABLE_MT5_HOT_SWEEP=true to enable)');
    return;
  }

  const effectiveInterval = Math.max(2,
    Number(process.env.MT5_HOT_SWEEP_INTERVAL_MIN) || intervalMin
  );
  const effectiveActive = Math.max(1,
    Number(process.env.MT5_HOT_SWEEP_ACTIVE_HOURS) || activeHours
  );
  const effectiveDelay = Math.max(0,
    Number(process.env.MT5_HOT_SWEEP_DELAY_MIN) || delayMin
  );

  const intervalMs = effectiveInterval * 60 * 1000;
  const delayMs    = effectiveDelay    * 60 * 1000;

  _hotIntervalMs = intervalMs;
  _hotNextRunAt  = new Date(Date.now() + delayMs).toISOString();

  console.log(
    `[MT5HotSweep] Scheduler starting — interval=${effectiveInterval}min, ` +
    `activeHours=${effectiveActive}, first run in ${effectiveDelay}min`
  );

  function tick() {
    _hotLastRunAt = new Date().toISOString();
    _hotNextRunAt = new Date(Date.now() + intervalMs).toISOString();
    runOnce({ activeHours: effectiveActive })
      .catch(err => console.error('[MT5HotSweep] run failed:', err.message));
  }

  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs).unref();
  }, delayMs).unref();
}
