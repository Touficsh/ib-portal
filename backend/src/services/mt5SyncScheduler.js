/**
 * MT5 Sync Scheduler — hourly sweep of recently-active logins.
 *
 * This is the safety-net layer that runs alongside the real-time webhook.
 * If the bridge is restarted, a deal notification is missed, or the webhook
 * POST fails, this sweep will catch any gap within one hour.
 *
 * What it syncs:
 *   "Active" logins = those with at least one deal in the last ACTIVE_DAYS days
 *   (default 7). With 21,000 total logins but only a fraction actively trading,
 *   this is typically 1,000–4,000 logins rather than the full set — keeping
 *   bridge load manageable even at the gate's 20 req/sec cap.
 *
 *   Logins never contacted (mt5_synced_at IS NULL) are also included so newly
 *   onboarded clients get picked up automatically without an admin clicking
 *   "First-time sync".
 *
 * After the sweep:
 *   If new deals were found, a commission engine cycle is triggered immediately
 *   so commission rows appear in minutes, not at the next scheduled cycle.
 *
 * Configuration (all via env vars or DB settings):
 *   MT5_SWEEP_INTERVAL_MIN   — how often to run (default 60 min)
 *   MT5_SWEEP_ACTIVE_DAYS    — "active" window in days (default 7)
 *   MT5_SWEEP_DELAY_MIN      — delay after boot before first run (default 5 min)
 *
 * Guards:
 *   - Only one sweep runs at a time (in-memory lock)
 *   - Bridge gate (20 req/sec, 16 concurrent) rate-limits bridge calls
 *   - If bridge is paused (kill switch), syncForLogin throws Mt5PausedError
 *     and the sweep aborts cleanly
 */
import pool from '../db/pool.js';
import { syncForLogin } from './mt5SnapshotSync.js';
import { runCommissionSync } from './commissionEngine.js';
import { Mt5PausedError } from './mt5BridgeGate.js';

const DEFAULT_INTERVAL_MIN  = 60;
const DEFAULT_ACTIVE_DAYS   = 7;
const DEFAULT_DELAY_MIN     = 5;
const CONCURRENCY           = 8;  // parallel syncForLogin calls

let sweepRunning = false;

/**
 * Run one sweep cycle.
 * Returns a summary object for logging / admin visibility.
 */
export async function runMt5Sweep({ activeDays = DEFAULT_ACTIVE_DAYS } = {}) {
  if (sweepRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  sweepRunning = true;
  const start = Date.now();
  const summary = {
    logins_scanned: 0,
    logins_synced: 0,
    logins_failed: 0,
    new_deals: 0,
    engine_triggered: false,
    errors: 0,
    duration_ms: 0,
  };

  try {
    // Find logins to sweep this cycle. Three branches, OR'd together so the
    // sweep catches every legitimate state:
    //   1. Never contacted — first-time sync (mt5_synced_at IS NULL)
    //   2. Synced more than `STALE_THRESHOLD_MIN` ago — refresh, regardless of
    //      whether they've traded recently. This is the critical fix for
    //      "previously-dormant login suddenly trades": before, those were
    //      filtered out forever because their cache was empty AND they had
    //      mt5_synced_at set. Now they get re-checked every cycle.
    //   3. Had deal activity in the active window — kept as a safety net
    //      (matches the previous behavior).
    //
    // The threshold is set just under the sweep interval so each login is
    // re-fetched at most once per cycle. With interval=60min, threshold=50min:
    // a login synced 51 min ago is eligible; 49 min ago is skipped.
    //
    // The bridge call is essentially free (local, no CRM cost). With ~1,300
    // total non-demo logins, a full cycle takes ~80s at concurrency=8.
    const STALE_THRESHOLD_MIN = Math.max(5, Math.floor((Number(process.env.MT5_SWEEP_INTERVAL_MIN) || 60) * 0.85));

    const { rows: logins } = await pool.query(
      `SELECT DISTINCT tam.login
       FROM trading_accounts_meta tam
       WHERE tam.account_type IS DISTINCT FROM 'demo'
         AND tam.product_source_id IS NOT NULL
         AND (
           -- Never contacted (first-time sync)
           tam.mt5_synced_at IS NULL
           OR
           -- Stale — last fetched more than STALE_THRESHOLD_MIN ago
           tam.mt5_synced_at < NOW() - ($2 || ' minutes')::interval
           OR
           -- Had deal activity in the active window (legacy safety net)
           EXISTS (
             SELECT 1 FROM mt5_deal_cache d
             WHERE d.login = tam.login
               AND d.entry IS NOT NULL
               AND d.deal_time > NOW() - ($1 || ' days')::interval
           )
         )`,
      [String(activeDays), String(STALE_THRESHOLD_MIN)]
    );

    summary.logins_scanned = logins.length;
    if (logins.length === 0) {
      summary.duration_ms = Date.now() - start;
      return summary;
    }

    console.log(`[MT5Sweep] Starting sweep of ${logins.length} active/unsynced logins`);

    // Process in parallel with CONCURRENCY workers, respecting the bridge gate
    let index = 0;
    const loginList = logins.map(r => r.login);
    let paused = false;

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          if (paused) break;
          const i = index++;
          if (i >= loginList.length) break;
          const login = loginList[i];

          try {
            const result = await syncForLogin(login);
            if (result.ok) {
              summary.logins_synced++;
              summary.new_deals += result.deals_cached || 0;
            } else {
              summary.logins_failed++;
            }
          } catch (err) {
            if (err instanceof Mt5PausedError) {
              console.warn('[MT5Sweep] Bridge paused — aborting sweep');
              paused = true;
              break;
            }
            summary.errors++;
          }
        }
      })
    );

    // If we found new deals, kick off a commission engine cycle now so
    // agents see updated earnings without waiting for the next scheduled run.
    if (summary.new_deals > 0) {
      try {
        summary.engine_triggered = true;
        runCommissionSync({ triggeredBy: 'mt5-sweep' })
          .catch(err => console.error('[MT5Sweep] commission engine cycle failed:', err.message));
      } catch (err) {
        console.error('[MT5Sweep] could not trigger commission engine:', err.message);
      }
    }

  } catch (err) {
    console.error('[MT5Sweep] sweep failed:', err.message);
    summary.errors++;
  } finally {
    sweepRunning = false;
    summary.duration_ms = Date.now() - start;
  }

  console.log('[MT5Sweep] done:', {
    scanned: summary.logins_scanned,
    synced: summary.logins_synced,
    failed: summary.logins_failed,
    new_deals: summary.new_deals,
    engine: summary.engine_triggered,
    ms: summary.duration_ms,
  });

  return summary;
}

/**
 * Start the recurring sweep on a configurable interval.
 * Called once from server.js after the server is listening.
 *
 * First run is delayed by `delayMin` to let the server warm up and avoid
 * hammering the bridge immediately on every restart.
 */
// Scheduler-state for the admin UI's "next run in X min" display.
let _sweepIntervalMs = null;
let _sweepNextRunAt  = null;
let _sweepLastRunAt  = null;

export function getMt5SweepStatus() {
  return {
    intervalMs: _sweepIntervalMs,
    nextRunAt:  _sweepNextRunAt,
    lastRunAt:  _sweepLastRunAt,
  };
}

export function startMt5SyncScheduler({
  intervalMin = DEFAULT_INTERVAL_MIN,
  activeDays  = DEFAULT_ACTIVE_DAYS,
  delayMin    = DEFAULT_DELAY_MIN,
} = {}) {
  // Read overrides from env vars if set
  const effectiveInterval = Math.max(5,
    Number(process.env.MT5_SWEEP_INTERVAL_MIN) || intervalMin
  );
  const effectiveDelay = Math.max(0,
    Number(process.env.MT5_SWEEP_DELAY_MIN) || delayMin
  );
  const effectiveDays = Math.max(1,
    Number(process.env.MT5_SWEEP_ACTIVE_DAYS) || activeDays
  );

  const intervalMs = effectiveInterval * 60 * 1000;
  const delayMs    = effectiveDelay    * 60 * 1000;

  _sweepIntervalMs = intervalMs;
  _sweepNextRunAt  = new Date(Date.now() + delayMs).toISOString();

  console.log(
    `[MT5Sweep] Scheduler starting — interval=${effectiveInterval}min, ` +
    `activeDays=${effectiveDays}, first run in ${effectiveDelay}min`
  );

  function tick() {
    _sweepLastRunAt = new Date().toISOString();
    _sweepNextRunAt = new Date(Date.now() + intervalMs).toISOString();
    runMt5Sweep({ activeDays: effectiveDays })
      .catch(err => console.error('[MT5Sweep] run failed:', err.message));
  }

  // Delayed first run so the server has fully initialized
  const firstRun = setTimeout(() => {
    tick();
    setInterval(tick, intervalMs).unref();
  }, delayMs);

  firstRun.unref();
}
