/**
 * Admin — Products — /api/admin/products
 *
 *   GET  /              — list all products
 *   POST /sync-from-crm — pull product catalog from x-dev CRM → upsert locally
 *   PATCH /:id          — update max_rate_per_lot / is_active
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/auditLog.js';
import { syncProductsFromCRM } from '../../services/productImport.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/products
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, code, product_group, currency,
              max_rate_per_lot, commission_per_lot, rebate_per_lot,
              is_active, source, source_id, created_at, updated_at
       FROM products
       ORDER BY is_active DESC, name ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/products/sync-from-crm
router.post('/sync-from-crm', async (req, res, next) => {
  try {
    const result = await syncProductsFromCRM();
    await audit(req, {
      action: 'products.sync_from_crm',
      entity_type: 'products',
      metadata: result,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/products — create new product manually
router.post('/', async (req, res, next) => {
  try {
    const { name, description, commission_per_lot = 0, rebate_per_lot = 0, currency = 'USD', is_active = true } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const max_rate_per_lot = Number(commission_per_lot) + Number(rebate_per_lot);
    const { rows } = await pool.query(
      `INSERT INTO products (name, description, commission_per_lot, rebate_per_lot, max_rate_per_lot, currency, is_active, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
       RETURNING *`,
      [name, description || null, Number(commission_per_lot), Number(rebate_per_lot), max_rate_per_lot, currency, is_active]
    );
    await audit(req, { action: 'products.create', entity_type: 'products', entity_id: rows[0].id, metadata: { name } });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/products/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, description, commission_per_lot, rebate_per_lot, currency, is_active } = req.body;
    // Recompute max from commission + rebate if either is provided
    const maxExpr = (commission_per_lot != null || rebate_per_lot != null)
      ? `COALESCE($1, commission_per_lot) + COALESCE($2, rebate_per_lot)`
      : `max_rate_per_lot`;

    const { rows } = await pool.query(
      `UPDATE products SET
         name               = COALESCE($3, name),
         description        = COALESCE($4, description),
         commission_per_lot = COALESCE($1, commission_per_lot),
         rebate_per_lot     = COALESCE($2, rebate_per_lot),
         max_rate_per_lot   = ${maxExpr},
         currency           = COALESCE($5, currency),
         is_active          = COALESCE($6, is_active),
         updated_at         = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        commission_per_lot != null ? Number(commission_per_lot) : null,
        rebate_per_lot     != null ? Number(rebate_per_lot)     : null,
        name         ?? null,
        description  ?? null,
        currency     ?? null,
        is_active    ?? null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    await audit(req, { action: 'products.update', entity_type: 'products', entity_id: req.params.id, metadata: req.body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/products/:id — soft-delete (archive)
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    await audit(req, { action: 'products.archive', entity_type: 'products', entity_id: req.params.id });
    res.json({ ok: true, archived: rows[0].name });
  } catch (err) { next(err); }
});

export default router;
