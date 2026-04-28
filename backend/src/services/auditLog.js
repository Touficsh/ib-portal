/**
 * Audit log — one-call helper for writing to the `audit_log` table.
 *
 * Call sites pass the Express request (so we can pick off actor + IP + UA
 * from middleware-populated fields) plus action + entity + optional before/after.
 * All fields except `action` are optional but the more you provide, the more
 * useful the audit trail is.
 *
 * Usage:
 *   import { audit } from '../services/auditLog.js';
 *   await audit(req, {
 *     action: 'rate.change',
 *     entity_type: 'agent_product',
 *     entity_id: `${agentId}:${productId}`,
 *     before: { rate_per_lot: 5 },
 *     after:  { rate_per_lot: 7 },
 *   });
 *
 * Intentionally non-throwing: audit failures should never break the business
 * operation. We log the failure and move on.
 */
import pool from '../db/pool.js';

const TRACKED_ACTIONS = new Set([
  // Products
  'product.create', 'product.update', 'product.archive',
  // Agent-product rates
  'rate.change',     // up/down of agent_products.rate_per_lot
  'rate.grant',      // new agent_products row
  'rate.revoke',     // agent_products row deactivated
  // Commission engine
  'engine.run.manual', 'engine.flag.change',
  // Commission adjustments
  'commission.adjust', 'commission.void',
  // Payout lifecycle (future)
  'payout.approve', 'payout.mark_paid',
  // User / permissions
  'user.create', 'user.role.change', 'user.archive',
  // Feature flags / settings
  'settings.update',
  // Auth
  'auth.login.success', 'auth.login.fail',
]);

export async function audit(req, { action, entity_type, entity_id, before, after, metadata }) {
  if (!action) return;  // guard — action is required
  try {
    const actorId    = req?.user?.id            || null;
    const actorEmail = req?.user?.email         || null;
    const actorRole  = req?.user?.role          || null;
    const ip         = req?.ip                  || req?.socket?.remoteAddress || null;
    const ua         = req?.get?.('user-agent') || null;

    await pool.query(
      `INSERT INTO audit_log
        (actor_user_id, actor_email, actor_role, action, entity_type, entity_id,
         before, after, metadata, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actorId, actorEmail, actorRole,
        action, entity_type || null, entity_id ? String(entity_id) : null,
        before ? JSON.stringify(before) : null,
        after  ? JSON.stringify(after)  : null,
        metadata ? JSON.stringify(metadata) : null,
        ip,
        ua,
      ]
    );

    if (!TRACKED_ACTIONS.has(action) && process.env.NODE_ENV !== 'production') {
      console.warn(`[audit] unknown action "${action}" — add to TRACKED_ACTIONS?`);
    }
  } catch (err) {
    // Never let audit failures break the actual operation
    console.error('[audit] failed to record event:', action, err.message);
  }
}

/**
 * Paginated query for the admin UI.
 */
export async function queryAuditLog({ from, to, actorUserId, action, entityType, entityId, page = 1, pageSize = 50 }) {
  const where = [];
  const params = [];
  let i = 1;
  if (from)        { where.push(`created_at >= $${i++}`); params.push(from); }
  if (to)          { where.push(`created_at <= $${i++}`); params.push(to); }
  if (actorUserId) { where.push(`actor_user_id = $${i++}`); params.push(actorUserId); }
  if (action)      { where.push(`action = $${i++}`);        params.push(action); }
  if (entityType)  { where.push(`entity_type = $${i++}`);   params.push(entityType); }
  if (entityId)    { where.push(`entity_id = $${i++}`);     params.push(String(entityId)); }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const offset = (Math.max(1, page) - 1) * pageSize;

  const [{ rows: items }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT a.*, u.name AS actor_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ${whereSQL}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, pageSize, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM audit_log ${whereSQL}`,
      params
    ),
  ]);

  return { items, total: countRows[0].c, page, pageSize };
}
