/**
 * Admin — Audit Log — /api/admin/audit-log
 *
 * Read-only query interface for the audit_log table. Admin-only.
 * Filter by actor, action, entity, and date range.
 */
import { Router } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { queryAuditLog } from '../../services/auditLog.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/audit-log
router.get('/', async (req, res, next) => {
  try {
    const result = await queryAuditLog({
      from:         req.query.from        || null,
      to:           req.query.to          || null,
      actorUserId:  req.query.actor       || null,
      action:       req.query.action      || null,
      entityType:   req.query.entityType  || null,
      entityId:     req.query.entityId    || null,
      page:         Math.max(1, Number(req.query.page) || 1),
      pageSize:     Math.min(200, Math.max(1, Number(req.query.pageSize) || 50)),
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/audit-log/distinct — values for filter dropdowns
router.get('/distinct', async (req, res, next) => {
  try {
    const pool = (await import('../../db/pool.js')).default;
    const [{ rows: actions }, { rows: entities }, { rows: actors }] = await Promise.all([
      pool.query(`SELECT DISTINCT action FROM audit_log ORDER BY action`),
      pool.query(`SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type`),
      pool.query(`
        SELECT DISTINCT a.actor_user_id AS id, COALESCE(u.name, a.actor_email) AS label
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.actor_user_id IS NOT NULL
        ORDER BY label`),
    ]);
    res.json({
      actions:  actions.map(r => r.action),
      entities: entities.map(r => r.entity_type),
      actors,
    });
  } catch (err) { next(err); }
});

export default router;
