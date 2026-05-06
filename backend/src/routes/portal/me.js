/**
 * Agent Portal — /api/portal/me
 *
 * Returns the currently-authenticated agent's profile + a small set of
 * at-a-glance counters for the dashboard header. Heavier dashboard metrics
 * (volume, commission totals, etc.) will live in /api/portal/dashboard in Phase 2.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../db/pool.js';
import { portalAuthenticate } from '../../middleware/portalAuth.js';
import { audit } from '../../services/auditLog.js';

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

// POST /api/portal/me/change-password
// Lets the authenticated user change their own password. Requires the current
// password as a check (so a hijacked session can't lock the user out by
// flipping the password). All actions audit-logged.
//
// Body: { current_password: string, new_password: string }
router.post('/me/change-password', portalAuthenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password) return res.status(400).json({ error: 'current_password is required' });
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'new_password must be at least 8 characters' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'new_password must differ from current_password' });
    }

    const { rows: [user] } = await pool.query(
      `SELECT id, password_hash FROM users WHERE id = $1 AND is_active = true`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(current_password, user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, req.user.id]
    );

    await audit(req, {
      action: 'portal.me.change_password',
      entity_type: 'user',
      entity_id: req.user.id,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
