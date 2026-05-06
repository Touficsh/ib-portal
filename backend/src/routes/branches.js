/**
 * Branch management routes — CRUD for office branches. Branches are linked
 * to clients by name (text match, no FK). Name changes cascade to clients.
 * Deletion: hard-delete for manual branches with 0 clients, otherwise soft-delete.
 * Write operations require branches.manage permission.
 * Mounted at /api/branches.
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/branches — list all branches with client counts
router.get('/', async (req, res, next) => {
  try {
    const activeOnly = req.query.active_only !== 'false'; // default true

    const condition = activeOnly ? 'WHERE b.is_active = true' : '';

    const { rows } = await pool.query(`
      SELECT b.*,
             COALESCE(cc.cnt, 0)::int AS client_count
      FROM branches b
      -- Client count via case-insensitive name match (no FK relationship)
      LEFT JOIN (
        SELECT LOWER(branch) AS branch_lower, COUNT(*)::int AS cnt
        FROM clients
        WHERE branch IS NOT NULL AND branch != ''
        GROUP BY LOWER(branch)
      ) cc ON LOWER(b.name) = cc.branch_lower
      ${condition}
      ORDER BY
        b.is_active DESC,
        b.name ASC
    `);

    res.json({ branches: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id — single branch with client count
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*,
              COALESCE(cc.cnt, 0)::int AS client_count
       FROM branches b
       LEFT JOIN (
         SELECT LOWER(branch) AS branch_lower, COUNT(*)::int AS cnt
         FROM clients
         WHERE branch IS NOT NULL AND branch != ''
         GROUP BY LOWER(branch)
       ) cc ON LOWER(b.name) = cc.branch_lower
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Branch not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/branches — create branch (admin only)
router.post('/', requirePermission('branches.manage'), async (req, res, next) => {
  try {
    const { name, country, manager } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    // Case-insensitive uniqueness check
    const { rows: existing } = await pool.query(
      'SELECT id FROM branches WHERE LOWER(name) = LOWER($1)',
      [name.trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A branch with this name already exists' });
    }

    const { rows } = await pool.query(
      `INSERT INTO branches (name, country, manager, source)
       VALUES ($1, $2, $3, 'manual')
       RETURNING *`,
      [name.trim(), country?.trim() || null, manager?.trim() || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists' });
    next(err);
  }
});

// PATCH /api/branches/:id — update branch (admin only)
router.patch('/:id', requirePermission('branches.manage'), async (req, res, next) => {
  try {
    const { name, country, manager, is_active } = req.body;

    // Fetch current branch
    const { rows: [current] } = await pool.query(
      'SELECT * FROM branches WHERE id = $1',
      [req.params.id]
    );
    if (!current) return res.status(404).json({ error: 'Branch not found' });

    const newName = name?.trim() || current.name;
    const newCountry = country !== undefined ? (country?.trim() || null) : current.country;
    const newManager = manager !== undefined ? (manager?.trim() || null) : current.manager;
    const newActive = is_active !== undefined ? is_active : current.is_active;

    // Name change: check uniqueness then cascade update to all matching clients
    if (newName.toLowerCase() !== current.name.toLowerCase()) {
      const { rows: dup } = await pool.query(
        'SELECT id FROM branches WHERE LOWER(name) = LOWER($1) AND id != $2',
        [newName, req.params.id]
      );
      if (dup.length > 0) {
        return res.status(409).json({ error: 'A branch with this name already exists' });
      }

      // Cascade name change to clients
      await pool.query(
        'UPDATE clients SET branch = $1, updated_at = NOW() WHERE LOWER(branch) = LOWER($2)',
        [newName, current.name]
      );
    }

    const { rows } = await pool.query(
      `UPDATE branches
       SET name = $1, country = $2, manager = $3, is_active = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [newName, newCountry, newManager, newActive, req.params.id]
    );

    // Get client count for response
    const { rows: [cc] } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM clients WHERE LOWER(branch) = LOWER($1)',
      [newName]
    );

    res.json({ ...rows[0], client_count: cc.cnt });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A branch with this name already exists' });
    next(err);
  }
});

// DELETE /api/branches/:id — soft-delete or hard-delete (admin only)
router.delete('/:id', requirePermission('branches.manage'), async (req, res, next) => {
  try {
    const { rows: [branch] } = await pool.query(
      'SELECT * FROM branches WHERE id = $1',
      [req.params.id]
    );
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    // Count clients referencing this branch
    const { rows: [cc] } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM clients WHERE LOWER(branch) = LOWER($1)',
      [branch.name]
    );

    // Hard-delete only manual branches with 0 clients; otherwise soft-delete (deactivate)
    if (cc.cnt === 0 && branch.source === 'manual') {
      await pool.query('DELETE FROM branches WHERE id = $1', [req.params.id]);
      return res.json({ success: true, deleted: true });
    }

    // Otherwise soft-delete (deactivate)
    await pool.query(
      'UPDATE branches SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true, deactivated: true });
  } catch (err) {
    next(err);
  }
});

export default router;
