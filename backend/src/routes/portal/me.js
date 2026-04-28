/**
 * Agent Portal — /api/portal/me
 *
 * Returns the currently-authenticated agent's profile + a small set of
 * at-a-glance counters for the dashboard header. Heavier dashboard metrics
 * (volume, commission totals, etc.) will live in /api/portal/dashboard in Phase 2.
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate } from '../../middleware/portalAuth.js';

const router = Router();

// GET /api/portal/me — profile for the authenticated user (agent OR admin).
// Agents get direct-counts; admins get an `is_admin: true` flag and empty counts.
router.get('/me', portalAuthenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.role, u.role_id,
              u.parent_agent_id, u.is_agent, u.created_at,
              p.name AS parent_agent_name
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_agent_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const me = rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });

    const perms = req.user.permissions || [];
    const isAdmin = perms.includes('portal.admin');

    // Only fetch counts for true agents — admins without is_agent skip this.
    let directSubAgents = 0;
    let directClients = 0;
    if (me.is_agent) {
      const [{ rows: subRows }, { rows: clientRows }] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS c FROM users
           WHERE parent_agent_id = $1 AND is_agent = true AND is_active = true`,
          [req.user.id]
        ),
        pool.query(`SELECT COUNT(*)::int AS c FROM clients WHERE agent_id = $1`, [req.user.id]),
      ]);
      directSubAgents = subRows[0].c;
      directClients = clientRows[0].c;
    }

    res.json({
      id: me.id,
      name: me.name,
      email: me.email,
      avatar_url: me.avatar_url,
      role: me.role,
      role_id: me.role_id,
      parent_agent_id: me.parent_agent_id,
      parent_agent_name: me.parent_agent_name,
      is_agent: me.is_agent,
      is_admin: isAdmin,
      created_at: me.created_at,
      permissions: perms,
      directSubAgents,
      directClients,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
