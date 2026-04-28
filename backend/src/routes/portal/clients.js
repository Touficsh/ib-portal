/**
 * Portal — Clients — /api/portal/clients
 *
 * Agent-facing list of the current agent's DIRECT referred clients. Because
 * these belong to the viewing agent, no masking is applied — they see the
 * full record including email, phone, and name.
 *
 * Each row is enriched with the viewer's commission totals (level=0 direct
 * earnings) and total lots attributed to that client, to power the "My
 * Clients" page in the portal UI.
 *
 * Endpoints:
 *   GET /          — paginated list with filters (stage, country, product, search)
 *   GET /:id       — single client detail, 403 if not a direct referral
 *
 * Filters:
 *   pipeline_stage=Lead|Contacted|Funded|Active|Churned
 *   country=<string>
 *   product_id=<uuid>
 *   q=<string>          free-text search across name/email/phone
 *   page / pageSize
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate } from '../../middleware/portalAuth.js';

const router = Router();
router.use(portalAuthenticate);

// GET /api/portal/clients — current agent's direct clients (and/or leads).
// `type` controls the crm_profile_type filter so the Network page's tabs
// can reuse the same endpoint:
//   type=client (default) → KYC-verified retail
//   type=lead             → unverified contacts
//   type=all              → both
router.get('/', async (req, res, next) => {
  try {
    const stage = req.query.pipeline_stage || null;
    const country = req.query.country || null;
    const productId = req.query.product_id || null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const type = (req.query.type || 'client').toLowerCase();
    if (!['client', 'lead', 'all'].includes(type)) {
      return res.status(400).json({ error: "type must be 'client', 'lead' or 'all'" });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const where = ['cl.agent_id = $1'];
    const params = [req.user.id];
    let i = 2;
    if (type !== 'all') { where.push(`cl.crm_profile_type = $${i++}`); params.push(type); }
    if (stage)     { where.push(`cl.pipeline_stage = $${i++}`); params.push(stage); }
    if (country)   { where.push(`cl.country = $${i++}`);        params.push(country); }
    if (productId) { where.push(`cl.product_id = $${i++}`);      params.push(productId); }
    if (q) {
      where.push(`(LOWER(cl.name) LIKE $${i} OR LOWER(cl.email) LIKE $${i} OR cl.phone LIKE $${i})`);
      params.push(`%${q.toLowerCase()}%`);
      i++;
    }
    const whereSQL = where.join(' AND ');

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT cl.id, cl.name, cl.email, cl.phone, cl.country,
                cl.pipeline_stage, cl.branch, cl.is_verified, cl.is_trader,
                cl.mt5_logins, cl.first_deposit_at, cl.registration_date,
                cl.product_id, p.name AS product_name, p.currency,
                COALESCE(array_length(cl.mt5_logins, 1), 0) AS mt5_login_count,
                (SELECT COALESCE(SUM(c.amount), 0)::numeric(14,2)
                   FROM commissions c
                   WHERE c.client_id = cl.id AND c.agent_id = $1) AS my_commission_earned,
                (SELECT COALESCE(SUM(c.lots), 0)::numeric(14,4)
                   FROM commissions c
                   WHERE c.client_id = cl.id AND c.agent_id = $1 AND c.level = 0) AS total_lots
         FROM clients cl
         LEFT JOIN products p ON p.id = cl.product_id
         WHERE ${whereSQL}
         ORDER BY cl.updated_at DESC, cl.id DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM clients cl WHERE ${whereSQL}`,
        params
      ),
    ]);

    res.json({
      items: items.map(r => ({
        ...r,
        my_commission_earned: Number(r.my_commission_earned),
        total_lots: Number(r.total_lots),
      })),
      pagination: { page, pageSize, total: countRows[0].c },
    });
  } catch (err) { next(err); }
});

// GET /api/portal/clients/:id — detail for a single direct referral
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT cl.*,
              p.name AS product_name, p.currency,
              COALESCE(array_length(cl.mt5_logins, 1), 0) AS mt5_login_count,
              (SELECT COALESCE(SUM(c.amount), 0)::numeric(14,2)
                 FROM commissions c
                 WHERE c.client_id = cl.id AND c.agent_id = $1) AS my_commission_earned,
              (SELECT COALESCE(SUM(c.lots), 0)::numeric(14,4)
                 FROM commissions c
                 WHERE c.client_id = cl.id AND c.agent_id = $1 AND c.level = 0) AS total_lots
       FROM clients cl
       LEFT JOIN products p ON p.id = cl.product_id
       WHERE cl.id = $2 AND cl.agent_id = $1`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(403).json({ error: 'Not your direct client' });

    const row = rows[0];
    res.json({
      ...row,
      my_commission_earned: Number(row.my_commission_earned),
      total_lots: Number(row.total_lots),
    });
  } catch (err) { next(err); }
});

export default router;
