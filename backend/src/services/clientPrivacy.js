/**
 * Client-name privacy gate.
 *
 * Centralizes the rule applied across portal endpoints that expose client
 * names from a viewer's subtree (Summary, Commissions, Dashboard top-clients,
 * Network, Sub-agent drill-down, Trading Accounts).
 *
 * Default rule: a client's name is visible to the viewer iff
 *   - the client is the viewer's own direct client (agent_id = viewerId), OR
 *   - the sub-agent between viewer and the client has flipped
 *     users.share_client_names_with_parent = true, OR
 *   - bypass is explicitly requested (admin context).
 *
 * Each agent in the subtree controls visibility of THEIR downline. So if
 * Alice is a direct sub of viewer and grants name-sharing, viewer sees the
 * names of all clients in Alice's downline (Alice's direct clients +
 * Alice's sub-agents' clients + ...). Granular per-level overrides are a
 * future feature.
 *
 * Admin views bypass entirely (admins see all PII by design).
 */
import pool from '../db/pool.js';

/**
 * Build a Map: agent_id -> { direct_sub_id, share_with_parent } for every
 * agent in the viewer's subtree (descendants, not viewer themselves).
 *
 * `direct_sub_id` is the sub-agent immediately below `viewer` that this
 * descendant flows through. For viewer's direct subs, direct_sub_id = self.
 * For grandchildren, direct_sub_id = parent's direct_sub_id. Etc.
 *
 * `share_with_parent` is the direct sub's `share_client_names_with_parent`
 * flag (the gate that decides visibility for everyone in their downline).
 *
 * Use as: const priv = privacyMap.get(client.agent_id) — if undefined,
 * the client's owning agent isn't in the viewer's subtree, which means
 * either viewer themselves (own direct client) or out-of-scope.
 */
export async function getClientPrivacyMap(viewerId) {
  if (!viewerId) return new Map();
  const { rows } = await pool.query(
    `WITH RECURSIVE st AS (
       SELECT u.id, u.parent_agent_id,
              CASE WHEN u.parent_agent_id = $1 THEN u.id ELSE NULL END AS direct_sub_id
       FROM users u
       WHERE u.parent_agent_id = $1 AND u.is_agent = true
       UNION ALL
       SELECT u.id, u.parent_agent_id, st.direct_sub_id
       FROM users u
       JOIN st ON u.parent_agent_id = st.id
       WHERE u.is_agent = true
     )
     SELECT st.id AS user_id, st.direct_sub_id,
            COALESCE(ds.share_client_names_with_parent, false) AS share_with_parent
     FROM st
     LEFT JOIN users ds ON ds.id = st.direct_sub_id`,
    [viewerId]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.user_id, {
      direct_sub_id: r.direct_sub_id,
      share_with_parent: r.share_with_parent === true,
    });
  }
  return map;
}

/**
 * Decide whether a viewer should see the name of a client owned by
 * `clientAgentId` (i.e. the agent the client is assigned to).
 *
 * - viewerId      — the agent whose view we're rendering
 * - clientAgentId — clients.agent_id of the client in question
 * - privacyMap    — pre-fetched map from getClientPrivacyMap(viewerId)
 * - opts.bypass   — true for admin context (always visible)
 *
 * Returns true (show name) or false (redact).
 */
export function canShowClientName(viewerId, clientAgentId, privacyMap, { bypass = false } = {}) {
  if (bypass) return true;
  if (!clientAgentId) return true;            // no agent attached → don't redact (likely already viewer's own)
  if (clientAgentId === viewerId) return true;
  const priv = privacyMap.get(clientAgentId);
  if (!priv) return true;                     // owning agent not in subtree — skip redaction (defensive)
  if (priv.direct_sub_id === null) return true; // weird path — show
  return priv.share_with_parent === true;
}

/**
 * Convenience: redact a row in-place by setting name=null + name_redacted=true.
 * Returns the row so it can be used in a .map() chain.
 */
export function applyRedaction(row, viewerId, clientAgentId, privacyMap, opts) {
  if (canShowClientName(viewerId, clientAgentId, privacyMap, opts)) return row;
  return {
    ...row,
    name: null,
    client_name: null,
    email: null,
    client_email: null,
    name_redacted: true,
  };
}
