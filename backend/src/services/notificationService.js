/**
 * Notification Service — Phase 5
 *
 * Central service for creating, deduplicating, and cleaning up in-app notifications.
 * Notifications are scoped per-user and rendered in the bell-icon dropdown panel.
 *
 * Supports 10 event types: deposit, withdrawal, first_deposit, task_due,
 * task_overdue, alert_new, assignment, stage_change, import_complete, merge_complete.
 *
 * Icon values are stored as text keys (e.g., 'stage', 'assign') and mapped to
 * emojis on the frontend to avoid PostgreSQL WIN1252 encoding issues.
 */
import pool from '../db/pool.js';

/**
 * Creates a notification for a specific user.
 * Fails silently (returns null) so notification errors never break main operations.
 *
 * @param {Object} params
 * @param {string} params.userId - Target user ID
 * @param {string} params.type - Event type (e.g., 'assignment', 'task_due')
 * @param {string} params.title - Short notification title
 * @param {string} params.message - Notification body text
 * @param {string} [params.icon] - Text key for frontend emoji mapping
 * @param {string} [params.color] - Left border color key (green, red, amber, blue)
 * @param {string} [params.link] - In-app navigation link
 * @param {string} [params.referenceId] - Related entity ID (for deduplication)
 * @param {string} [params.referenceType] - Entity type (client, task, import)
 * @returns {Object|null} Created notification row, or null on failure
 */
export async function createNotification({
  userId,
  type,
  title,
  message,
  icon,
  color,
  link,
  referenceId,
  referenceType,
}) {
  if (!userId) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, icon, color, link, reference_id, reference_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [userId, type, title, message, icon || null, color || null, link || null, referenceId || null, referenceType || null]
    );
    return rows[0];
  } catch (err) {
    // Don't let notification failures break main operations
    console.error('Failed to create notification:', err.message);
    return null;
  }
}

/**
 * Creates notifications for all active users whose role includes a specific permission.
 * Used for broadcasting admin-visible events (e.g., import_complete, sync errors).
 *
 * @param {string} permission - Permission key to filter users by (e.g., 'sync.run')
 * @param {Object} notificationData - Same shape as createNotification params (minus userId)
 */
export async function notifyUsersWithPermission(permission, notificationData) {
  try {
    // Query users whose role has the specified permission
    const { rows: users } = await pool.query(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = true AND $1 = ANY(r.permissions)`,
      [permission]
    );
    for (const user of users) {
      await createNotification({ userId: user.id, ...notificationData });
    }
  } catch (err) {
    console.error('Failed to notify users:', err.message);
  }
}

/**
 * Check if a notification already exists (deduplication).
 * Prevents spamming the same notification within a configurable time window.
 *
 * @param {string} userId - Target user
 * @param {string} type - Notification event type
 * @param {string} referenceId - Related entity ID
 * @param {number} [withinHours=1] - Deduplication window in hours (default 1h, task notifications use 24h)
 * @returns {boolean} True if a matching notification already exists within the window
 */
export async function isDuplicate(userId, type, referenceId, withinHours = 1) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM notifications
       WHERE user_id = $1 AND type = $2 AND reference_id = $3
       AND created_at > NOW() - INTERVAL '1 hour' * $4
       LIMIT 1`,
      [userId, type, referenceId, withinHours]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clean up old notifications.
 * Called periodically (e.g., during sync).
 */
export async function cleanupNotifications() {
  try {
    // Delete read notifications older than 30 days
    await pool.query(
      `DELETE FROM notifications WHERE is_read = true AND created_at < NOW() - INTERVAL '30 days'`
    );
    // Delete all notifications older than 90 days
    await pool.query(
      `DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`
    );
  } catch (err) {
    console.error('Notification cleanup failed:', err.message);
  }
}
