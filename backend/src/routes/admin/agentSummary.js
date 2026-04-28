/**
 * Admin — Agent Summary — /api/admin/agent-summary
 *
 * Admin-console replica of the agent portal's Summary page, but scoped to
 * any agent the admin picks instead of the logged-in user. Gives ops / BDs
 * a view of "what does agent X see when they log in?" without needing to
 * impersonate them.
 *
 * Uses the exact same underlying payload builder as the agent route
 * (`buildSummaryPayload` exported from portal/summary.js) — single source
 * of truth, one code path, same shape response.
 *
 * Endpoints:
 *   GET  /agents              — list of agents the admin can select from (for the picker)
 *   GET  /:userId             — summary payload for that agent
 *   POST /:userId/sync-mt5    — refresh MT5 snapshots for that agent's subtree
 *
 * Requires portal.admin.
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { buildSummaryPayload } from '../portal/summary.js';
import { syncForAgent as syncSnapshotsForAgent } from '../../services/mt5SnapshotSync.js';
import { runCommissionSync, recomputeForAgent } from '../../services/commissionEngine.js';
import { cacheMw, invalidateCache } from '../../services/responseCache.js';
import { audit } from '../../services/auditLog.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/agent-summary/agents
// List of agents to populate the picker. Minimal columns, sorted for UX:
// top-level first (they're the branch roots admins usually pick), then
// alphabetical.
router.get('/agents', cacheMw({ ttl: 120 }), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active,
              c.branch,
              u.parent_agent_id IS NULL AS is_top_level,
              (SELECT COUNT(*)::int FROM users sub
                WHERE sub.parent_agent_id = u.id AND sub.is_agent = true) AS direct_sub_count,
              (SELECT COUNT(*)::int FROM clients cl
                WHERE cl.agent_id = u.id) AS direct_clients_count
       FROM users u
       LEFT JOIN clients c ON c.id = u.linked_client_id
       WHERE u.is_agent = true
       ORDER BY u.parent_agent_id IS NOT NULL, u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/admin/agent-summary/:userId
// Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, products=id1,id2 (same as portal)
router.get('/:userId', cacheMw({ ttl: 60 }), async (req, res, next) => {
  try {
    const userId = req.params.userId;
    // Quick sanity check so we return a clean 404 rather than a weird SQL plan
    const { rows } = await pool.query(
      `SELECT id, name, is_agent FROM users WHERE id = $1 AND is_agent = true LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found', userId });
    }

    const fromISO = req.query.from ? `${req.query.from} 00:00:00` : null;
    const toISO   = req.query.to   ? `${req.query.to} 23:59:59`   : null;
    const productIds = req.query.products
      ? String(req.query.products).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const payload = await buildSummaryPayload(userId, fromISO, toISO, productIds);

    // Expose who the admin is viewing as (nice for UI / debug)
    res.json({
      ...payload,
      viewing_as: { id: rows[0].id, name: rows[0].name },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/agent-summary/:userId/mt5-freshness
//
// "Is this agent's MT5 data actually fetched, and when?" — one card of
// diagnostics that answers both questions for a specific agent's subtree.
//
// Returns:
//   subtree_logins            total MT5 logins in the agent's subtree (own + referred clients)
//   logins_ever_synced        how many have been touched by the bridge at least once
//   logins_never_synced       subtree_logins - logins_ever_synced
//   logins_with_cached_deals  how many have at least one row in mt5_deal_cache
//   cached_deal_count         total deal rows for those logins
//   latest_deal_time          newest deal timestamp we have (= "as of when?")
//   oldest_deal_time          oldest cached deal (= historical depth)
//   latest_sync_at            most recent bridge call for any login in subtree
//   oldest_sync_at            staleness indicator for subtree-wide coverage
//   stale_logins              10 logins with the oldest (or NULL) mt5_synced_at
//                             — the ones the admin should refresh first
//
// All data comes from local tables (trading_accounts_meta + mt5_deal_cache).
// No bridge or CRM calls. Cached 30s because the data changes rarely during
// a support session and the stale_logins query is the heaviest bit.
router.get('/:userId/mt5-freshness', cacheMw({ ttl: 30 }), async (req, res, next) => {
  try {
    const userId = req.params.userId;

    // Quick sanity check — 404 early if the agent doesn't exist
    const { rows: agentRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND is_agent = true LIMIT 1`, [userId]
    );
    if (agentRows.length === 0) {
      return res.status(404).json({ error: 'Agent not found', userId });
    }

    // Subtree + scoped client ids. Same shape the portal/summary endpoint
    // uses so admins see the exact same universe of logins the agent sees.
    const { rows: [summary] } = await pool.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, linked_client_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.linked_client_id
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       scope_cids AS (
         SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
         UNION
         SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT id FROM clients
           WHERE referred_by_agent_id IN (
             SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL
           )
       ),
       scope_meta AS (
         SELECT tam.login, tam.mt5_synced_at
         FROM trading_accounts_meta tam
         WHERE tam.client_id IN (SELECT id FROM scope_cids)
           AND tam.account_type IS DISTINCT FROM 'demo'
       ),
       scope_deals AS (
         SELECT d.login, d.deal_time
         FROM mt5_deal_cache d
         WHERE d.login IN (SELECT login FROM scope_meta)
       )
       SELECT
         (SELECT COUNT(*)::int FROM scope_meta)                                   AS subtree_logins,
         (SELECT COUNT(*)::int FROM scope_meta WHERE mt5_synced_at IS NOT NULL)   AS logins_ever_synced,
         (SELECT COUNT(*)::int FROM scope_meta WHERE mt5_synced_at IS NULL)       AS logins_never_synced,
         (SELECT COUNT(DISTINCT login)::int FROM scope_deals)                     AS logins_with_cached_deals,
         (SELECT COUNT(*)::int FROM scope_deals)                                  AS cached_deal_count,
         (SELECT MIN(deal_time) FROM scope_deals)                                 AS oldest_deal_time,
         (SELECT MAX(deal_time) FROM scope_deals)                                 AS latest_deal_time,
         (SELECT MIN(mt5_synced_at) FROM scope_meta WHERE mt5_synced_at IS NOT NULL) AS oldest_sync_at,
         (SELECT MAX(mt5_synced_at) FROM scope_meta)                              AS latest_sync_at`,
      [userId]
    );

    // Top 10 staleness candidates — the admin's first click after seeing
    // "40 logins never synced" is usually "which ones?". Surfacing them up
    // front saves a second query.
    const { rows: staleLogins } = await pool.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, linked_client_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.linked_client_id
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       scope_cids AS (
         SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
         UNION
         SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT id FROM clients
           WHERE referred_by_agent_id IN (
             SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL
           )
       )
       SELECT tam.login,
              tam.client_id,
              cl.name        AS client_name,
              tam.mt5_synced_at,
              (SELECT MAX(deal_time) FROM mt5_deal_cache d WHERE d.login = tam.login) AS latest_deal_time,
              (SELECT COUNT(*)::int FROM mt5_deal_cache d WHERE d.login = tam.login)  AS deal_count
       FROM trading_accounts_meta tam
       LEFT JOIN clients cl ON cl.id = tam.client_id
       WHERE tam.client_id IN (SELECT id FROM scope_cids)
         AND tam.account_type IS DISTINCT FROM 'demo'
       ORDER BY tam.mt5_synced_at NULLS FIRST
       LIMIT 10`,
      [userId]
    );

    // Expose the global floor so the UI date picker can set its minimum
    // (admin can't pick a date earlier than the platform policy).
    const { rows: floorRows } = await pool.query(
      "SELECT value FROM settings WHERE key = 'mt5_earliest_deal_date'"
    );
    const earliest_deal_date = (floorRows[0]?.value || '').trim() || null;

    res.json({
      ...summary,
      earliest_deal_date,
      stale_logins: staleLogins,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/agent-summary/:userId/sync-mt5
// Refresh MT5 snapshots for the selected agent's subtree. Same behavior as
// the portal's /sync-mt5 route but with admin permission + per-agent scope.
// Modes:
//   default: refresh logins whose last sync is older than maxAge minutes
//   ?onlyMissing=true: narrow the work set to logins with no data yet
//     (never-synced OR zero cached deals). Ideal when admin sees "N never
//     synced" on the freshness card and wants to fill the gap without
//     re-hitting logins that already have data.
//   ?fromDate=YYYY-MM-DD: start the bridge `from` cursor at this date
//     (instead of cursor / default lookback). Bounded by the global floor
//     `settings.mt5_earliest_deal_date` — if fromDate is earlier than the
//     floor, the floor wins silently. Useful for backfilling a specific
//     agent when they say "I should have data from March 1".
router.post('/:userId/sync-mt5', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const maxAgeMinutes = Math.max(0, Number(req.query.maxAge) || 15);
    const onlyMissing = String(req.query.onlyMissing || '').toLowerCase() === 'true';
    const fromDate = req.query.fromDate ? String(req.query.fromDate).trim() : null;

    // Validate fromDate early so a typo'd value doesn't go to the bridge.
    if (fromDate) {
      const t = new Date(fromDate).getTime();
      if (!Number.isFinite(t)) {
        return res.status(400).json({ error: 'fromDate must be a valid ISO date (e.g. 2026-03-01)' });
      }
    }

    const summary = await syncSnapshotsForAgent(userId, {
      maxAgeMinutes,
      onlyMissing,
      overrideFromDate: fromDate,
    });

    // Chain a commission engine cycle so newly-fetched deals turn into
    // commission rows without the admin having to also click "Run cycle now"
    // on System Health. Fire-and-forget — the engine has its own concurrency
    // lock and is idempotent (ON CONFLICT DO NOTHING on commissions), so
    // double-firing across two refreshes is safe. We don't await because the
    // cycle can take 30–90s for big subtrees and we want the HTTP response
    // back to the admin in seconds. The freshness card + summary update via
    // the next page reload.
    let engineTriggered = false;
    if (summary.logins_synced > 0) {
      engineTriggered = true;
      runCommissionSync({
        triggeredBy: 'admin-agent-summary-refresh',
        triggeredByUser: req.user?.id,
      }).catch(err => console.error('[AgentSummary] post-refresh engine cycle failed:', err.message));
    }

    // Invalidate this agent's cached summary + freshness panel so the
    // fresh numbers show immediately after a manual sync.
    invalidateCache(`/api/admin/agent-summary/${userId}`);
    invalidateCache(`/api/admin/agent-summary/${userId}/mt5-freshness`);

    // Surface the engine kickoff in the response so the UI can update the
    // toast message ("commissions populating in the background…").
    summary.engine_triggered = engineTriggered;

    await audit(req, {
      action: onlyMissing ? 'admin.agent_summary.sync_mt5_missing' : 'admin.agent_summary.sync_mt5',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        mode: summary.mode,
        fromDate: fromDate || null,
        logins_synced: summary.logins_synced,
        engine_triggered: engineTriggered,
        logins_failed: summary.logins_failed,
      },
    });

    res.json(summary);
  } catch (err) { next(err); }
});

// POST /api/admin/agent-summary/:userId/recompute-commissions
//
// Recompute (or preview) commission rows for one agent over a date range.
//
// Query params:
//   fromDate  YYYY-MM-DD  (required)
//   toDate    YYYY-MM-DD  (required)
//   confirm   'true'      write to DB; omit or 'false' for dry-run preview
//
// Dry-run (default):
//   Re-runs the waterfall math, returns a preview of what would change.
//   Nothing is touched in the DB.
//
// Live (?confirm=true):
//   Deletes existing commission rows for this agent in the window, then
//   re-inserts using the current rates (CRM or legacy, whichever applies).
//   A transaction wraps the delete+insert so the window is never partly gone.
//
// Guards enforced by recomputeForAgent():
//   - Both fromDate and toDate required (no accidental all-time wipe)
//   - toDate clamped to yesterday (don't race the live engine)
//   - Max window 366 days (split large ranges)
router.post('/:userId/recompute-commissions', async (req, res, next) => {
  try {
    const userId   = req.params.userId;
    const fromDate = (req.query.fromDate || '').trim();
    const toDate   = (req.query.toDate   || '').trim();
    const confirm  = String(req.query.confirm || '').toLowerCase() === 'true';

    if (!fromDate || !toDate) {
      return res.status(400).json({
        error: 'fromDate and toDate are required (YYYY-MM-DD)',
      });
    }

    // Validate agent exists
    const { rows: agentRows } = await pool.query(
      `SELECT id, name FROM users WHERE id = $1 AND is_agent = true LIMIT 1`, [userId]
    );
    if (agentRows.length === 0) {
      return res.status(404).json({ error: 'Agent not found', userId });
    }

    const result = await recomputeForAgent(userId, fromDate, toDate, { dryRun: !confirm });

    if (!confirm) {
      return res.json({
        ...result,
        message: `Dry run — ${result.rows_previewed} row(s) would be recomputed for ${agentRows[0].name}. Pass ?confirm=true to apply.`,
      });
    }

    // Live run — audit + invalidate cache
    await audit(req, {
      action: 'admin.agent_summary.recompute_commissions',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        from: fromDate,
        to: result.to,   // may be clamped to yesterday
        rows_deleted: result.rows_deleted,
        rows_inserted: result.rows_inserted,
        errors: result.errors,
      },
    });

    invalidateCache(`/api/admin/agent-summary/${userId}`);

    res.json({
      ...result,
      message: `Recomputed ${result.rows_inserted} commission row(s) for ${agentRows[0].name} (${result.rows_deleted} old rows replaced).`,
    });
  } catch (err) {
    if (err.message?.includes('Date window exceeds') || err.message?.includes('fromDate and toDate')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

export default router;
