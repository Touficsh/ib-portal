/**
 * User management routes — CRUD for users, rep workload stats,
 * per-user permission overrides, and branch scope restrictions.
 * Most endpoints require users.manage permission. Reps dropdown
 * (/reps) is open to all authenticated users for assignment UIs.
 * Mounted at /api/users.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { bustPermissionCache } from '../services/permissions.js';

const router = Router();
router.use(authenticate);

// GET /api/users — list all users with role info and branch scope counts
router.get('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.role_id, u.is_active, u.avatar_url, u.created_at,
              r.name AS role_name,
              COALESCE(bs.cnt, 0)::int AS branch_scope_count,
              (SELECT COUNT(*)::int FROM user_branch_scope ubs WHERE ubs.user_id = u.id) AS branch_count
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS cnt
         FROM user_branch_scope
         GROUP BY user_id
       ) bs ON bs.user_id = u.id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/reps — active reps with client counts (for assignment dropdowns, no admin gate)
router.get('/reps', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url,
              COUNT(c.id)::int AS client_count
       FROM users u
       LEFT JOIN clients c ON c.assigned_rep_id = u.id
       WHERE u.is_active = true
       GROUP BY u.id
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/workload — per-rep client counts broken down by pipeline stage
router.get('/workload', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url,
              COUNT(c.id)::int AS total_clients,
              COUNT(c.id) FILTER (WHERE c.pipeline_stage = 'Lead')::int AS lead_count,
              COUNT(c.id) FILTER (WHERE c.pipeline_stage = 'Contacted')::int AS contacted_count,
              COUNT(c.id) FILTER (WHERE c.pipeline_stage = 'Funded')::int AS funded_count,
              COUNT(c.id) FILTER (WHERE c.pipeline_stage = 'Active')::int AS active_count,
              COUNT(c.id) FILTER (WHERE c.pipeline_stage = 'Churned')::int AS churned_count
       FROM users u
       LEFT JOIN clients c ON c.assigned_rep_id = u.id
       WHERE u.is_active = true
       GROUP BY u.id
       ORDER BY total_clients DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/users — create user with role resolution (role_id preferred over role string)
router.post('/', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { name, email, password, role, role_id } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Resolve role_id and role name — prefer role_id (UUID) over role string
    let resolvedRoleId = role_id;
    let resolvedRoleName = role || 'rep';
    if (resolvedRoleId) {
      // Look up role name from role_id
      const { rows: roleRows } = await pool.query('SELECT name FROM roles WHERE id = $1', [resolvedRoleId]);
      if (roleRows[0]) resolvedRoleName = roleRows[0].name;
    } else if (resolvedRoleName) {
      // Fallback: resolve role_id from role name string
      const { rows: roleRows } = await pool.query('SELECT id FROM roles WHERE name = $1', [resolvedRoleName]);
      resolvedRoleId = roleRows[0]?.id || null;
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, role_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, role_id, is_active, created_at`,
      [name, email, hash, resolvedRoleName, resolvedRoleId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    next(err);
  }
});

// PATCH /api/users/:id — update user fields; syncs role string from role_id for backwards compat
router.patch('/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { name, email, role, role_id, is_active } = req.body;

    // If role_id is changing, also update the role string for backwards compat
    let roleStr = role;
    if (role_id && !role) {
      const { rows: roleRows } = await pool.query('SELECT name FROM roles WHERE id = $1', [role_id]);
      roleStr = roleRows[0]?.name || role;
    }

    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           role = COALESCE($3, role),
           role_id = COALESCE($4, role_id),
           is_active = COALESCE($5, is_active),
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, name, email, role, role_id, is_active, created_at`,
      [name, email, roleStr, role_id, is_active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    // Bust permission cache for the updated user
    bustPermissionCache(req.params.id);

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/reset-password — admin resets a team member's password
router.post('/:id/reset-password', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Validate user exists
    const { rows: [user] } = await pool.query('SELECT id, name FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.params.id]);

    res.json({ success: true, message: `Password reset for ${user.name}` });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/branches — Get user's branch scope restrictions
router.get('/:id/branches', requirePermission('users.manage'), async (req, res, next) => {
  try {
    // Validate user exists
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get user's restricted branches
    const { rows: userBranches } = await pool.query(
      `SELECT b.id, b.name, b.country
       FROM user_branch_scope ubs
       JOIN branches b ON ubs.branch_id = b.id
       WHERE ubs.user_id = $1 AND b.is_active = true
       ORDER BY b.name`,
      [req.params.id]
    );

    // Get all active branches for the dropdown
    const { rows: allBranches } = await pool.query(
      `SELECT id, name, country FROM branches WHERE is_active = true ORDER BY name`
    );

    res.json({
      branch_scope: userBranches.length > 0 ? 'restricted' : 'all',
      branches: userBranches,
      available_branches: allBranches,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/branches — replace branch scope (empty array = unrestricted)
router.put('/:id/branches', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { branch_ids } = req.body;
    if (!Array.isArray(branch_ids)) {
      return res.status(400).json({ error: 'branch_ids must be an array' });
    }

    // Validate user exists
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent admin lockout: cannot restrict own branches
    if (req.params.id === req.user.id && branch_ids.length > 0) {
      return res.status(400).json({ error: 'You cannot restrict your own branch access' });
    }

    // Validate all branch_ids exist and are active
    if (branch_ids.length > 0) {
      const { rows: validBranches } = await pool.query(
        `SELECT id FROM branches WHERE id = ANY($1) AND is_active = true`,
        [branch_ids]
      );
      if (validBranches.length !== branch_ids.length) {
        return res.status(400).json({ error: 'One or more branch IDs are invalid or inactive' });
      }
    }

    // Replace all existing entries in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_branch_scope WHERE user_id = $1', [req.params.id]);

      for (const branchId of branch_ids) {
        await client.query(
          `INSERT INTO user_branch_scope (user_id, branch_id) VALUES ($1, $2)
           ON CONFLICT (user_id, branch_id) DO NOTHING`,
          [req.params.id, branchId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Bust permission cache so branchScope is re-resolved
    bustPermissionCache(req.params.id);

    res.json({ success: true, branch_count: branch_ids.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/permissions — resolved permissions (role + overrides) for a user
router.get('/:id/permissions', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { resolvePermissions } = await import('../services/permissions.js');
    const resolved = await resolvePermissions(req.params.id);

    // Also fetch raw overrides
    const { rows: overrides } = await pool.query(
      'SELECT permission, granted FROM user_permission_overrides WHERE user_id = $1',
      [req.params.id]
    );

    res.json({
      permissions: resolved.permissions,
      clientScope: resolved.clientScope,
      roleName: resolved.roleName,
      roleId: resolved.roleId,
      overrides,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/permissions — replace all user-level permission overrides (clear + re-insert)
router.put('/:id/permissions', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { overrides } = req.body; // [{ permission: 'clients.edit', granted: true }, ...]
    if (!Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an array' });
    }

    // Validate user exists
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Clear existing overrides and insert new ones
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [req.params.id]);

      for (const { permission, granted } of overrides) {
        if (typeof permission !== 'string' || typeof granted !== 'boolean') continue;
        await client.query(
          `INSERT INTO user_permission_overrides (user_id, permission, granted)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, permission) DO UPDATE SET granted = $3`,
          [req.params.id, permission, granted]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Bust cache for this user
    bustPermissionCache(req.params.id);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/branch-scope — Get user's branch restrictions
router.get('/:id/branch-scope', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ubs.id, ubs.branch_id, b.name AS branch_name, b.country
       FROM user_branch_scope ubs
       JOIN branches b ON b.id = ubs.branch_id
       WHERE ubs.user_id = $1
       ORDER BY b.name`,
      [req.params.id]
    );
    res.json({ branches: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/branch-scope — replace branch restrictions (empty = unrestricted)
router.put('/:id/branch-scope', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { branch_ids } = req.body;
    if (!Array.isArray(branch_ids)) {
      return res.status(400).json({ error: 'branch_ids must be an array' });
    }

    // Validate user exists
    const { rows: [user] } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_branch_scope WHERE user_id = $1', [req.params.id]);

      for (const branchId of branch_ids) {
        await client.query(
          `INSERT INTO user_branch_scope (user_id, branch_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, branch_id) DO NOTHING`,
          [req.params.id, branchId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Bust permission cache (branch scope is cached with permissions)
    bustPermissionCache(req.params.id);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
