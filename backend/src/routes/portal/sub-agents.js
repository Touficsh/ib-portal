/**
 * Portal — Sub-Agents — /api/portal/sub-agents
 *
 * Agent-facing view of the current agent's direct downline (one level deep).
 * Read-only: agents can view their sub-agents and the products/rates those
 * sub-agents hold, but cannot assign, modify, or revoke rates themselves.
 * All rate changes go through admin (via /api/agents).
 *
 * Endpoints:
 *   GET    /          — list direct sub-agents + aggregates
 *   GET    /:id       — single sub-agent summary (only if direct child)
 *   GET    /:id/clients — direct clients of a sub-agent
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate } from '../../middleware/portalAuth.js';

const router = Router();
router.use(portalAuthenticate);

/**
 * Helper: verify that `subAgentId` is a direct child of the authenticated agent.
 * Returns the sub-agent row or null.
 */
async function getDirectSubAgent(parentAgentId, subAgentId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, is_active, created_at
     FROM users
     WHERE id = $1 AND parent_agent_id = $2 AND is_agent = true`,
    [subAgentId, parentAgentId]
  );
  return rows[0] || null;
}

// GET /api/portal/sub-agents — direct downline with aggregated counts
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.created_at,
              (SELECT COUNT(*)::int FROM users c
                 WHERE c.parent_agent_id = u.id AND c.is_agent = true AND c.is_active = true)
                AS direct_sub_count,
              (SELECT COUNT(*)::int FROM clients cl WHERE cl.agent_id = u.id)
                AS direct_clients_count
       FROM users u
       WHERE u.parent_agent_id = $1 AND u.is_agent = true AND u.is_active = true
       ORDER BY u.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/portal/sub-agents/:id — single sub-agent summary (direct only)
router.get('/:id', async (req, res, next) => {
  try {
    const sub = await getDirectSubAgent(req.user.id, req.params.id);
    if (!sub) return res.status(403).json({ error: 'Not your direct sub-agent' });

    const [{ rows: products }, { rows: sub2 }, { rows: clientCountRow }] = await Promise.all([
      pool.query(
        `SELECT ap.product_id, p.name AS product_name, p.currency,
                ap.rate_per_lot, ap.is_active, ap.created_at, ap.updated_at
         FROM agent_products ap
         JOIN products p ON p.id = ap.product_id
         WHERE ap.agent_id = $1 AND ap.is_active = true
         ORDER BY p.name`,
        [req.params.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM users
         WHERE parent_agent_id = $1 AND is_agent = true AND is_active = true`,
        [req.params.id]
      ),
      pool.query(`SELECT COUNT(*)::int AS c FROM clients WHERE agent_id = $1`, [req.params.id]),
    ]);

    res.json({
      ...sub,
      products,
      direct_sub_count: sub2[0].c,
      direct_clients_count: clientCountRow[0].c,
    });
  } catch (err) { next(err); }
});

// GET /api/portal/sub-agents/:id/clients — sub-agent's direct clients
router.get('/:id/clients', async (req, res, next) => {
  try {
    const sub = await getDirectSubAgent(req.user.id, req.params.id);
    if (!sub) return res.status(403).json({ error: 'Not your direct sub-agent' });

    const stage = req.query.pipeline_stage || null;
    const productId = req.query.product_id || null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const where = ['cl.agent_id = $1'];
    const params = [req.params.id];
    let i = 2;
    if (stage)     { where.push(`cl.pipeline_stage = $${i++}`); params.push(stage); }
    if (productId) { where.push(`cl.product_id = $${i++}`);      params.push(productId); }
    const whereSQL = where.join(' AND ');

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT cl.id, cl.name, cl.email, cl.phone, cl.country,
                cl.pipeline_stage, cl.is_verified, cl.is_trader,
                cl.mt5_logins, cl.product_id, p.name AS product_name, p.currency,
                COALESCE(array_length(cl.mt5_logins, 1), 0) AS mt5_login_count,
                (SELECT COALESCE(SUM(c.amount), 0)::numeric(14,2)
                   FROM commissions c
                   WHERE c.client_id = cl.id AND c.agent_id = $2) AS my_override_earned,
                (SELECT COALESCE(SUM(c.lots), 0)::numeric(14,4)
                   FROM commissions c
                   WHERE c.client_id = cl.id AND c.agent_id = $1 AND c.level = 0) AS total_lots
         FROM clients cl
         LEFT JOIN products p ON p.id = cl.product_id
         WHERE ${whereSQL}
         ORDER BY cl.updated_at DESC, cl.id DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, req.user.id, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM clients cl WHERE ${whereSQL}`,
        params
      ),
    ]);

    res.json({
      items: items.map(row => ({
        ...row,
        my_override_earned: Number(row.my_override_earned),
        total_lots: Number(row.total_lots),
      })),
      pagination: { page, pageSize, total: countRows[0].c },
    });
  } catch (err) { next(err); }
});

export default router;
