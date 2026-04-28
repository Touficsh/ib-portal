/**
 * Permission Resolution Service — Custom RBAC
 *
 * Resolves a user's effective permissions by combining their role's permission
 * array with any user-level overrides (grants or revokes). Also resolves
 * client scope (all vs assigned) and branch scope (restricted branch list).
 *
 * Results are cached in-memory for 60 seconds per user. Cache is busted on
 * role changes, permission override updates, and branch scope modifications.
 *
 * Used by: auth middleware (every authenticated request), login/me endpoints.
 */
import pool from '../db/pool.js';

// All valid permission keys in the system (19 granular keys across 7 categories)
export const ALL_PERMISSIONS = [
  { key: 'clients.view', label: 'View clients', category: 'Clients' },
  { key: 'clients.edit', label: 'Edit clients', category: 'Clients' },
  { key: 'clients.create', label: 'Create manual leads', category: 'Clients' },
  { key: 'clients.import', label: 'Import leads (bulk)', category: 'Clients' },
  { key: 'clients.export', label: 'Export data', category: 'Clients' },
  { key: 'tasks.manage', label: 'Manage tasks', category: 'Tasks' },
  { key: 'mt5.view', label: 'View MT5 data', category: 'Trading' },
  { key: 'ai.access', label: 'Access AI suggestions', category: 'AI' },
  { key: 'branches.manage', label: 'Manage branches', category: 'Administration' },
  { key: 'users.manage', label: 'Manage users', category: 'Administration' },
  { key: 'sync.run', label: 'Run CRM sync', category: 'Administration' },
  { key: 'analytics.view', label: 'View analytics', category: 'Analytics' },
  { key: 'settings.access', label: 'Access settings', category: 'Administration' },
  { key: 'roles.manage', label: 'Manage roles & permissions', category: 'Administration' },
  // Agent Portal permissions
  { key: 'portal.access', label: 'Access the agent portal', category: 'Portal' },
  { key: 'portal.clients.view', label: 'View own referred clients', category: 'Portal' },
  { key: 'portal.commissions.view', label: 'View commission ledger', category: 'Portal' },
  { key: 'portal.subagents.view', label: 'View direct sub-agents', category: 'Portal' },
  { key: 'portal.products.manage', label: 'Assign products to sub-agents', category: 'Portal' },
  { key: 'portal.admin', label: 'Admin-side agent & product management', category: 'Portal' },
];

export const VALID_PERMISSION_KEYS = new Set(ALL_PERMISSIONS.map(p => p.key));

// In-memory cache: userId -> { permissions, clientScope, expiresAt }
const permissionCache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Resolves the effective permissions for a user.
 * Resolution order:
 *   1. Load the role's base permissions array from the roles table
 *   2. Apply user_permission_overrides (granted=true adds, granted=false removes)
 *   3. Load branch scope from user_branch_scope (empty = unrestricted)
 *
 * @param {string} userId - UUID of the user
 * @returns {{ permissions: string[], clientScope: string, branchScope: string[], roleName: string, roleId: string }}
 */
export async function resolvePermissions(userId) {
  // Check cache first
  const cached = permissionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // Fetch user's role + overrides
  const { rows: [user] } = await pool.query(
    `SELECT u.id, u.role_id, r.name AS role_name, r.permissions AS role_permissions, r.client_scope
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  if (!user || !user.role_permissions) {
    // Fallback: no role found — no permissions
    return { permissions: [], clientScope: 'assigned', roleName: 'unknown' };
  }

  const perms = new Set(user.role_permissions);

  // Apply user-level overrides
  const { rows: overrides } = await pool.query(
    'SELECT permission, granted FROM user_permission_overrides WHERE user_id = $1',
    [userId]
  );

  for (const override of overrides) {
    if (override.granted) {
      perms.add(override.permission);
    } else {
      perms.delete(override.permission);
    }
  }

  // Resolve branch scope — empty array means no restriction (all branches)
  let branchScope = [];
  try {
    const { rows: branchRows } = await pool.query(
      `SELECT b.name FROM user_branch_scope ubs
       JOIN branches b ON b.id = ubs.branch_id
       WHERE ubs.user_id = $1 AND b.is_active = true`,
      [userId]
    );
    branchScope = branchRows.map(r => r.name);
  } catch {
    // Table may not exist yet — no restriction
  }

  const result = {
    permissions: Array.from(perms),
    clientScope: user.client_scope,
    branchScope,
    roleName: user.role_name,
    roleId: user.role_id,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  permissionCache.set(userId, result);
  return result;
}

/**
 * Bust the permission cache for a specific user or all users.
 * Call after: role assignment changes, permission override updates, branch scope changes.
 *
 * @param {string} [userId] - Specific user to bust, or omit to clear entire cache
 */
export function bustPermissionCache(userId) {
  if (userId) {
    permissionCache.delete(userId);
  } else {
    permissionCache.clear();
  }
}

/**
 * Bust cache for all users with a specific role.
 * Call after: role permission changes (editing a role's permissions array).
 *
 * @param {string} roleId - UUID of the role that was modified
 */
export async function bustCacheForRole(roleId) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE role_id = $1',
    [roleId]
  );
  for (const user of rows) {
    permissionCache.delete(user.id);
  }
}
