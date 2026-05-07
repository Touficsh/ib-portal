/**
 * MT5 live-data routes — /api/mt5/*
 *
 * Endpoints:
 *   GET /api/mt5/accounts/:login   — live balance / equity / margin for a login
 *
 * The Trading Accounts page displays cached values from trading_accounts_meta
 * by default (set by the snapshot sync) but lets the user click "Refresh" on
 * a row to pull *live* values from the broker. That click hits this endpoint.
 *
 * Auth: caller must be authenticated AND the requested login must belong
 * to a client in their subtree. We don't expose arbitrary broker logins —
 * an agent should only be able to peek at logins they're entitled to see.
 *
 * The bridge's /accounts/:login response is reshaped here to a stable subset
 * the UI cares about.
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { portalAuthenticate } from '../middleware/portalAuth.js';
import { bridgeRequest, Mt5PausedError } from '../services/mt5BridgeGate.js';

const router = Router();
router.use(portalAuthenticate);

// GET /api/mt5/accounts/:login
router.get('/accounts/:login', async (req, res, next) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'login required' });

    // Authorization: confirm this login belongs to a client in the viewer's
    // subtree (or the viewer themselves). We re-use the same subtree-CTE
    // pattern other portal endpoints use. Admins bypass the scope check.
    const isAdmin = (req.user.permissions || []).includes('portal.admin');
    if (!isAdmin) {
      const { rows: scope } = await pool.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, linked_client_id FROM users WHERE id = $1
           UNION ALL
           SELECT u.id, u.linked_client_id
           FROM users u JOIN subtree s ON u.parent_agent_id = s.id
           WHERE u.is_agent = true
         ),
         scope_clients AS (
           SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
           UNION
           SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
           UNION
           SELECT id FROM clients
             WHERE referred_by_agent_id IN (
               SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL
             )
         )
         SELECT 1
         FROM trading_accounts_meta tam
         WHERE tam.login = $2
           AND tam.client_id IN (SELECT id FROM scope_clients)
         LIMIT 1`,
        [req.user.id, login]
      );
      if (scope.length === 0) {
        return res.status(403).json({ error: 'Login is not in your scope' });
      }
    }

    // Fetch live values from the bridge. Goes through the gate (rate-limit,
    // concurrency cap, kill switch). Short timeout — the user clicked
    // "Refresh" and is waiting at the screen.
    let live;
    try {
      live = await bridgeRequest(`/accounts/${login}`, {
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      if (err instanceof Mt5PausedError) {
        return res.status(503).json({ error: 'MT5 is paused' });
      }
      // Could be 4xx from the bridge (login not found, MT5 disconnected) or
      // a network error. Surface a friendly message.
      return res.status(502).json({ error: 'Bridge unavailable: ' + (err.message || 'unknown') });
    }

    if (!live || typeof live !== 'object') {
      return res.status(502).json({ error: 'Bridge returned no data' });
    }

    // Shape the response to a stable subset. The bridge's exact field names
    // could change; we centralize the contract here so the UI is decoupled.
    res.json({
      login,
      balance:    Number(live.balance)    || 0,
      equity:     Number(live.equity)     || 0,
      margin:     Number(live.margin)     || 0,
      // Profit = Equity - Balance, derived because the bridge doesn't always
      // emit it directly. Matches what most MT5 dashboards show.
      profit:     Number(live.equity || 0) - Number(live.balance || 0),
      margin_free: Number(live.marginFree) || 0,
      group:      live.group || null,
      currency:   live.currency || null,
      last_access: live.lastAccess || null,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
