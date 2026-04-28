/**
 * Agent Portal Auth — /api/portal/auth
 *
 * Dedicated login endpoint for the portal surface. Accepts:
 *   - Agents (users.is_agent = true) — standard portal users
 *   - Admins (have the 'portal.admin' RBAC permission) — get the admin pages
 *
 * Reps without either flag are rejected here so the UX stays clean.
 *
 * Issues the same JWT shape used by the staff app, plus a `scope: 'portal'`
 * claim so downstream services can tell which surface the token was minted for.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import pool from '../../db/pool.js';
import { resolvePermissions } from '../../services/permissions.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 20 per 15 min per IP. Generous enough for legit users who fat-finger a
  // password several times + normal dev/test cycles; still rejects anything
  // that looks like brute-forcing. Tune via PORTAL_LOGIN_RATE_LIMIT env var.
  max: Math.max(1, Number(process.env.PORTAL_LOGIN_RATE_LIMIT) || 20),
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Only count FAILED attempts — successful logins shouldn't eat quota. This
  // means a user who logs in cleanly can reconnect on a different device
  // immediately without being told they're being rate-limited.
  skipSuccessfulRequests: true,
});

// POST /api/portal/auth/login — Agent login, returns JWT scoped to portal
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, email, role, role_id, password_hash, is_active, is_agent
       FROM users WHERE email = $1`,
      [email]
    );

    const user = rows[0];
    // Uniform 401 for invalid creds / inactive / non-agent to avoid user enumeration
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Resolve RBAC-derived permissions; fall back to empty on failure
    let permissions = [];
    let roleName = user.role;
    try {
      const resolved = await resolvePermissions(user.id);
      permissions = resolved.permissions;
      roleName = resolved.roleName || user.role;
    } catch { /* fallback */ }

    // Accept if user is a portal-accessing agent OR holds the admin gate.
    const hasPortalAccess = permissions.includes('portal.access') && user.is_agent;
    const hasAdminAccess  = permissions.includes('portal.admin');
    if (!hasPortalAccess && !hasAdminAccess) {
      return res.status(403).json({ error: 'This account does not have portal access' });
    }

    const isAdminOnly = hasAdminAccess && !hasPortalAccess;
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: roleName,
        roleId: user.role_id,
        name: user.name,
        scope: isAdminOnly ? 'portal-admin' : 'portal',
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.PORTAL_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: roleName,
        is_agent: !!user.is_agent,
        permissions,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
