import pool from '../db/pool.js';

/**
 * Response Time Tracker — Phase 3.5.5
 * Detects first rep contact after assignment and calculates response time.
 *
 * Called after: note_added, call_logged, task_completed events.
 * Only sets first_contact_at once per assignment cycle (reset on reassignment).
 */

/**
 * Detect the first rep-to-client contact after assignment and record response time.
 * Only fires once per assignment cycle: if first_contact_at is already set, it no-ops.
 * On reassignment, assigned_at is reset and first_contact_at is cleared, restarting the cycle.
 *
 * @param {string} clientId - The client being contacted
 * @param {string} repId - The rep who made the contact (must match assigned_rep_id)
 * @returns {number|null} Response time in seconds, or null if not applicable
 */
export async function detectFirstContact(clientId, repId) {
  if (!clientId || !repId) return null;

  try {
    // Check if client has assigned_at set and first_contact_at is still null
    const { rows } = await pool.query(
      `SELECT assigned_at, first_contact_at, assigned_rep_id
       FROM clients WHERE id = $1`,
      [clientId]
    );

    if (!rows[0]) return null;

    const client = rows[0];

    // Only track if:
    // 1. Client has an assigned_at timestamp
    // 2. first_contact_at is not already set (first contact not yet recorded)
    // 3. The rep making contact is the assigned rep
    if (!client.assigned_at || client.first_contact_at || client.assigned_rep_id !== repId) {
      return null;
    }

    const now = new Date();
    const assignedAt = new Date(client.assigned_at);
    const responseTimeSeconds = Math.floor((now - assignedAt) / 1000);

    // Set first_contact_at and response_time_seconds
    await pool.query(
      `UPDATE clients
       SET first_contact_at = NOW(),
           response_time_seconds = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [responseTimeSeconds, clientId]
    );

    console.log(`[ResponseTime] First contact for ${clientId} by rep ${repId}: ${responseTimeSeconds}s`);

    // Log to activity_log
    await pool.query(
      `INSERT INTO activity_log (client_id, event_type, payload, rep_id)
       VALUES ($1, 'first_contact', $2, $3)`,
      [clientId, JSON.stringify({
        response_time_seconds: responseTimeSeconds,
        assigned_at: client.assigned_at,
        first_contact_at: now.toISOString(),
      }), repId]
    );

    return responseTimeSeconds;
  } catch (err) {
    console.error('[ResponseTime] Error detecting first contact:', err.message);
    return null;
  }
}
