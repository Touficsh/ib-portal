/**
 * Admin — MT5 Sync Health — /api/admin/mt5-sync
 *
 * Read-only health dashboard feed for the "MT5 Sync Health" admin page.
 * Aggregates everything an admin needs to answer:
 *   - "Is the MT5 bridge healthy right now?"
 *   - "When did we last pull a deal?"
 *   - "How often do cycles run and do they succeed?"
 *   - "Which branches are ingest-complete vs lagging?"
 *   - "Are any engine jobs stuck or failing?"
 *
 * All queries hit Postgres + in-process gate state. Zero MT5 or CRM calls.
 *
 * Endpoints:
 *   GET /status   — full dashboard feed (the main call)
 *   POST /run     — trigger a manual engine cycle (same as the Reconciliation page)
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { getMt5GateState, setMt5Paused } from '../../services/mt5BridgeGate.js';
import { audit } from '../../services/auditLog.js';
import { runCommissionSync } from '../../services/commissionEngine.js';
import { syncForLogin as syncMt5ForLogin } from '../../services/mt5SnapshotSync.js';
import { cacheMw, invalidateCache } from '../../services/responseCache.js';
import { getWebhookStats, getCommissionQueueDepth } from '../mt5Webhook.js';
import { getEngineStatus } from '../../services/commissionEngine.js';
import { getMt5SweepStatus } from '../../services/mt5SyncScheduler.js';
import { getMt5HotSweepStatus } from '../../services/mt5HotLoginSweep.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/mt5-sync/status
// 5s cache — the page auto-refreshes every 30s, but the real-time deal-stream
// counters update every second, so we want the dashboard to feel fresh.
// 5s is enough to absorb burst clicks (Refresh) without pummeling the DB.
// "Run cycle now" invalidates the cache below for instant feedback.
router.get('/status', cacheMw({ ttl: 5 }), async (req, res, next) => {
  try {
    // Run all independent queries in parallel — each one is a simple read
    const [
      gateState,
      cyclesRecent,
      cycleStats24h,
      cacheTotals,
      cacheWindow,
      tradingAccountState,
      recentJobFailures,
      branchFreshness,
    ] = await Promise.all([
      getMt5GateState(),

      // Last 20 cycles — for the cadence chart + "last succeeded"
      pool.query(`
        SELECT id, status, started_at, finished_at,
               EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int as duration_s,
               jobs_total, jobs_succeeded, jobs_failed, jobs_dead, deals_inserted, triggered_by
        FROM commission_engine_cycles
        ORDER BY started_at DESC LIMIT 20
      `),

      // Rollup over the last 24 h
      pool.query(`
        SELECT
          COUNT(*)::int as cycle_count,
          COUNT(*) FILTER (WHERE status='succeeded')::int as succeeded,
          COUNT(*) FILTER (WHERE status='failed')::int as failed,
          COUNT(*) FILTER (WHERE status='running')::int as running,
          COALESCE(SUM(deals_inserted), 0)::int as deals_inserted_24h,
          COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (WHERE finished_at IS NOT NULL), 0)::int as avg_duration_s
        FROM commission_engine_cycles
        WHERE started_at > NOW() - INTERVAL '24 hours'
      `),

      // Deal cache overall state
      pool.query(`
        SELECT
          COUNT(*)::bigint as total_rows,
          COUNT(DISTINCT login)::int as distinct_logins,
          MIN(deal_time) as oldest_deal,
          MAX(deal_time) as newest_deal
        FROM mt5_deal_cache
      `),

      // Deals inserted in different time windows (for the "activity" widget)
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE synced_at > NOW() - INTERVAL '1 hour')::int as last_hour,
          COUNT(*) FILTER (WHERE synced_at > NOW() - INTERVAL '24 hours')::int as last_day,
          COUNT(*) FILTER (WHERE synced_at > NOW() - INTERVAL '7 days')::int as last_week
        FROM mt5_deal_cache
      `),

      // Trading accounts ingest state — the upstream that feeds deals
      pool.query(`
        SELECT
          COUNT(*)::int as total_meta_rows,
          COUNT(DISTINCT client_id)::int as clients_with_accounts,
          COUNT(*) FILTER (WHERE mt5_group IS NULL)::int as missing_mt5_group,
          COUNT(*) FILTER (WHERE mt5_synced_at IS NULL)::int as never_mt5_synced,
          MAX(mt5_synced_at) as last_mt5_sync
        FROM trading_accounts_meta
      `),

      // Recent failed/dead jobs — what's actually failing
      pool.query(`
        SELECT last_error, COUNT(*)::int as n, MAX(finished_at) as most_recent
        FROM commission_engine_jobs
        WHERE finished_at > NOW() - INTERVAL '24 hours'
          AND last_error IS NOT NULL
        GROUP BY last_error
        ORDER BY n DESC
        LIMIT 10
      `),

      // Per-branch deal freshness — top 15 branches by deals cached, with newest-deal age
      pool.query(`
        SELECT
          COALESCE(cl.branch, '(no branch)') as branch,
          COUNT(DISTINCT d.login)::int as logins_with_deals,
          COUNT(d.deal_id)::bigint as deals_cached,
          MAX(d.deal_time) as newest_deal,
          EXTRACT(EPOCH FROM (NOW() - MAX(d.deal_time)))::int as newest_deal_age_s
        FROM mt5_deal_cache d
        JOIN trading_accounts_meta tam ON tam.login = d.login
        JOIN clients cl ON cl.id = tam.client_id
        GROUP BY cl.branch
        ORDER BY deals_cached DESC
        LIMIT 15
      `),
    ]);

    // Decide overall health — green/yellow/red
    const lastSucceeded = cyclesRecent.rows.find(c => c.status === 'succeeded');
    const minutesSinceLastDeal = cacheTotals.rows[0].newest_deal
      ? Math.round((Date.now() - new Date(cacheTotals.rows[0].newest_deal).getTime()) / 60000)
      : null;
    const failedCycles24h = cycleStats24h.rows[0].failed;
    let overallHealth = 'green';
    const healthReasons = [];
    if (gateState.paused) {
      overallHealth = 'red';
      healthReasons.push('MT5 bridge gate is paused');
    }
    if (failedCycles24h > 0) {
      overallHealth = overallHealth === 'red' ? 'red' : 'yellow';
      healthReasons.push(`${failedCycles24h} cycle(s) failed in last 24h`);
    }
    if (recentJobFailures.rows.length > 0) {
      const totalFails = recentJobFailures.rows.reduce((s, r) => s + r.n, 0);
      if (totalFails > 50) {
        overallHealth = overallHealth === 'red' ? 'red' : 'yellow';
        healthReasons.push(`${totalFails} job errors in last 24h`);
      }
    }

    // Snapshot sync config — exposed so the UI can render editable fields.
    // Two knobs:
    //   mt5_initial_lookback_days  — default "how far back" for first sync
    //   mt5_earliest_deal_date     — hard floor (YYYY-MM-DD); deals older
    //                                than this are NEVER fetched or stored,
    //                                regardless of lookback or per-agent
    //                                override. Caps ingress + storage.
    const { rows: settingsRows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('mt5_initial_lookback_days', 'mt5_earliest_deal_date')"
    );
    const settingsMap = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
    const initialLookbackDays = Number(settingsMap.mt5_initial_lookback_days) > 0
      ? Number(settingsMap.mt5_initial_lookback_days)
      : 60;
    const earliestDealDate = (settingsMap.mt5_earliest_deal_date || '').trim() || null;

    res.json({
      timestamp: new Date().toISOString(),
      overall_health: overallHealth,
      health_reasons: healthReasons,

      bridge_gate: gateState,

      snapshot_sync: {
        initial_lookback_days: initialLookbackDays,
        earliest_deal_date: earliestDealDate,
      },

      cycles: {
        recent: cyclesRecent.rows,
        last_succeeded_at: lastSucceeded?.started_at ?? null,
        stats_24h: cycleStats24h.rows[0],
      },

      // In-process scheduler timing — what's queued to run and when.
      // Each entry has: name, label, intervalMs, lastRunAt, nextRunAt.
      // Frontend renders a "Background schedulers" card showing countdown.
      schedulers: [
        {
          key:   'commission_engine',
          label: 'Commission engine cycle',
          purpose: 'Backstop for missed real-time deals; also handles brand-new logins.',
          ...getEngineStatus(),
        },
        {
          key:   'mt5_active_sweep',
          label: 'MT5 active-login sweep',
          purpose: 'Pulls fresh balance + history for every login active in the last 7 days.',
          ...getMt5SweepStatus(),
        },
        {
          key:   'mt5_hot_sweep',
          label: 'MT5 hot-login sweep',
          purpose: 'Faster sub-window for logins active in the last 24 h.',
          ...getMt5HotSweepStatus(),
        },
      ],

      deal_cache: {
        ...cacheTotals.rows[0],
        minutes_since_newest_deal: minutesSinceLastDeal,
        activity: cacheWindow.rows[0],
      },

      // Real-time webhook stream — populated by routes/mt5Webhook.js as
      // the bridge POSTs deals. In-memory counters since process start;
      // for absolute totals use deal_cache.activity above.
      webhook_stream: {
        ...getWebhookStats(),
        commission_queue_depth: getCommissionQueueDepth(),
      },

      trading_accounts: tradingAccountState.rows[0],

      recent_failures: recentJobFailures.rows,

      branch_freshness: branchFreshness.rows,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/mt5-sync/cycles/:cycleId
 *
 * Drill-down for one engine cycle. Surfaces:
 *   - cycle metadata (started/finished/status/triggered_by)
 *   - job-status histogram (queued/running/succeeded/failed/dead)
 *   - distinct error reasons across failed/dead jobs (top 10 by count)
 *   - up to 50 example failures (login + last_error)
 *
 * Used by the "click a cycle row to see what happened" UI on System Health.
 * One round-trip — three queries fired in parallel against the same cycle id.
 */
router.get('/cycles/:cycleId', async (req, res, next) => {
  try {
    const cycleId = req.params.cycleId;
    if (!cycleId) return res.status(400).json({ error: 'cycleId required' });

    const [cycle, jobStats, errorGroups, sampleFailures] = await Promise.all([
      pool.query(
        `SELECT id, status, started_at, finished_at,
                jobs_total, jobs_succeeded, jobs_failed, jobs_dead, deals_inserted,
                triggered_by, triggered_by_user, since_iso,
                EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int AS duration_s
           FROM commission_engine_cycles WHERE id = $1`,
        [cycleId]
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS n
           FROM commission_engine_jobs
          WHERE cycle_id = $1
          GROUP BY status`,
        [cycleId]
      ),
      pool.query(
        `SELECT COALESCE(last_error, '(no error recorded)') AS reason,
                COUNT(*)::int AS n
           FROM commission_engine_jobs
          WHERE cycle_id = $1 AND status IN ('failed', 'dead')
          GROUP BY reason
          ORDER BY n DESC
          LIMIT 10`,
        [cycleId]
      ),
      pool.query(
        `SELECT j.login, j.client_id, j.product_id, j.status, j.attempt,
                j.last_error, j.started_at, j.finished_at,
                cl.name AS client_name
           FROM commission_engine_jobs j
           LEFT JOIN clients cl ON cl.id = j.client_id
          WHERE j.cycle_id = $1 AND j.status IN ('failed', 'dead')
          ORDER BY j.finished_at DESC NULLS LAST
          LIMIT 50`,
        [cycleId]
      ),
    ]);

    if (cycle.rows.length === 0) {
      return res.status(404).json({ error: 'cycle not found', cycleId });
    }

    res.json({
      cycle: cycle.rows[0],
      job_stats: jobStats.rows,
      error_groups: errorGroups.rows,
      sample_failures: sampleFailures.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/mt5-sync/pending
// Returns logins that have never been synced (mt5_synced_at IS NULL) with
// client + assigned rep info. Used by the dashboard "Sync needed" widget.
router.get('/pending', async (req, res, next) => {
  try {
    // No join — hits only the indexed column on one table. Fast even at 21k rows.
    const { rows } = await pool.query(`
      SELECT login::text, client_id, product_source_id
      FROM trading_accounts_meta
      WHERE mt5_synced_at IS NULL
        AND account_type IS DISTINCT FROM 'demo'
        AND product_source_id IS NOT NULL
      LIMIT 200
    `);
    res.json({ count: rows.length, logins: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/mt5-sync/run — kick off a manual commission engine cycle.
// Returns 202 immediately; admin polls /status to watch the cycle progress.
router.post('/run', async (req, res, next) => {
  try {
    const since = req.body?.since || null; // ISO string, or null for "default incremental"
    // Fire-and-forget — the engine logs progress into commission_engine_cycles.
    runCommissionSync({ since, triggeredBy: 'admin_manual', triggeredByUser: req.user?.id })
      .catch(err => console.error('[admin/mt5-sync/run] cycle failed:', err.message));
    await audit(req, {
      action: 'mt5_sync.cycle.manual',
      entity_type: 'system',
      entity_id: 'commission_engine',
      metadata: { since },
    });
    // Invalidate cached status so the Health page shows the new "running" cycle immediately
    invalidateCache('/api/admin/mt5-sync/status');
    res.status(202).json({ accepted: true, triggered_at: new Date().toISOString() });
  } catch (err) { next(err); }
});

// POST /api/admin/mt5-sync/pause  (and /resume)
// Same pattern as the CRM gate — lets the admin kill the bridge if it's
// misbehaving without restarting the backend.
router.post('/pause', async (req, res, next) => {
  try {
    const r = await setMt5Paused(true);
    await audit(req, { action: 'mt5_gate.pause', entity_type: 'settings', entity_id: 'mt5_paused' });
    res.json({ ...r, message: 'MT5 bridge calls paused.' });
  } catch (err) { next(err); }
});

router.post('/resume', async (req, res, next) => {
  try {
    const r = await setMt5Paused(false);
    await audit(req, { action: 'mt5_gate.resume', entity_type: 'settings', entity_id: 'mt5_paused' });
    res.json({ ...r, message: 'MT5 bridge calls resumed.' });
  } catch (err) { next(err); }
});

// PUT /api/admin/mt5-sync/settings/lookback-days
// Body: { days: number }
// Updates settings.mt5_initial_lookback_days — the window used by the first
// MT5 snapshot sync for a login with no cached deals. Capped [1, 3650].
router.put('/settings/lookback-days', async (req, res, next) => {
  try {
    const requested = Number(req.body?.days);
    if (!Number.isFinite(requested) || requested < 1) {
      return res.status(400).json({ error: 'days must be a positive number' });
    }
    const days = Math.min(3650, Math.floor(requested));
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('mt5_initial_lookback_days', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(days)]
    );
    await audit(req, {
      action: 'mt5_sync.settings.lookback_days',
      entity_type: 'settings',
      entity_id: 'mt5_initial_lookback_days',
      metadata: { days },
    });
    invalidateCache('/api/admin/mt5-sync/status');
    res.json({ ok: true, mt5_initial_lookback_days: days });
  } catch (err) { next(err); }
});

// PUT /api/admin/mt5-sync/settings/earliest-deal-date
// Body: { date: "YYYY-MM-DD" | null }
// Hard floor — no deal older than this is fetched from the bridge or
// written to mt5_deal_cache. Pass null / empty string to clear the floor.
// This caps ingress + storage at the source: existing data before the new
// floor stays (see future purge job), but no new data will go below it.
router.put('/settings/earliest-deal-date', async (req, res, next) => {
  try {
    const raw = req.body?.date;
    // null / empty string → clear the floor. Any other value must parse as
    // a real date and can't be in the future (nonsense).
    if (raw == null || raw === '') {
      await pool.query(`DELETE FROM settings WHERE key = 'mt5_earliest_deal_date'`);
      await audit(req, {
        action: 'mt5_sync.settings.earliest_deal_date',
        entity_type: 'settings',
        entity_id: 'mt5_earliest_deal_date',
        metadata: { date: null, cleared: true },
      });
      invalidateCache('/api/admin/mt5-sync/status');
      return res.json({ ok: true, mt5_earliest_deal_date: null });
    }
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) {
      return res.status(400).json({ error: 'date must be a valid ISO date (e.g. 2026-03-01)' });
    }
    if (t > Date.now()) {
      return res.status(400).json({ error: 'date cannot be in the future' });
    }
    const iso = new Date(t).toISOString().slice(0, 10);  // normalize to YYYY-MM-DD
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('mt5_earliest_deal_date', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [iso]
    );
    await audit(req, {
      action: 'mt5_sync.settings.earliest_deal_date',
      entity_type: 'settings',
      entity_id: 'mt5_earliest_deal_date',
      metadata: { date: iso },
    });
    invalidateCache('/api/admin/mt5-sync/status');
    res.json({ ok: true, mt5_earliest_deal_date: iso });
  } catch (err) { next(err); }
});

// POST /api/admin/mt5-sync/backfill/:login?days=N
// One-shot deep-history pull for a single MT5 login. The default first-sync
// lookback is 60 days (setting `mt5_initial_lookback_days`); once the cursor
// advances, older deals are never fetched again by normal syncs. This endpoint
// forces a pull going back N days regardless of the current cursor.
//
// Typical use: an agent says "my commissions for March are missing" after the
// default window slid past March. Admin calls this with days=120 on each of
// that agent's logins to backfill. Idempotent — ON CONFLICT DO NOTHING in the
// deal cache prevents duplicates.
//
// `days` is capped at 3650 (10 years) to protect the bridge; below 1 or
// missing falls back to 365.
router.post('/backfill/:login', async (req, res, next) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'login is required' });
    const requestedDays = Number(req.query.days);
    const days = Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(3650, Math.floor(requestedDays))
      : 365;

    const startedAt = new Date();
    const result = await syncMt5ForLogin(login, { overrideLookbackDays: days });

    await audit(req, {
      action: 'mt5_sync.backfill',
      entity_type: 'mt5_login',
      entity_id: login,
      metadata: { days, result, startedAt: startedAt.toISOString() },
    });
    invalidateCache('/api/admin/mt5-sync/status');
    res.json({ login, days, ...result });
  } catch (err) { next(err); }
});

export default router;
