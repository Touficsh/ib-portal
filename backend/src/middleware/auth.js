/**
 * Authentication & Authorization Middleware
 *
 * Provides JWT-based authentication and permission-based access control.
 *
 * Exports:
 *   authenticate()        — Verify JWT, resolve permissions from RBAC, attach to req.user
 *   requireRole()         — Legacy role-name check (deprecated, use requirePermission)
 *   requirePermission()   — Require ALL specified permissions (AND logic)
 *   requireAnyPermission() — Require at least ONE permission (OR logic)
 *   enforceClientScope()  — Enforce client visibility (assigned vs all) + branch restrictions
 */
import jwt from 'jsonwebtoken';
import { resolvePermissions } from '../services/permissions.js';

/**
 * JWT authentication middleware. Verifies the Bearer token, decodes the user,
 * then asynchronously resolves their RBAC permissions (role + overrides + branch scope).
 * Falls back to JWT-embedded role if permission resolution fails (backwards compat).
 */
export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Resolve permissions asynchronously and attach to req.user
    resolvePermissions(decoded.id)
      .then(({ permissions, clientScope, branchScope, roleName, roleId }) => {
        req.user.permissions = permissions;
        req.user.clientScope = clientScope;
        req.user.branchScope = branchScope || []; // array of branch names, empty = no restriction
        // Keep role as display name (backwards compat)
        req.user.role = roleName || decoded.role;
        req.user.roleId = roleId || decoded.roleId;
        next();
      })
      .catch(() => {
        // Fallback: use JWT role for backwards compat during migration
        req.user.permissions = [];
        req.user.clientScope = decoded.role === 'rep' ? 'assigned' : 'all';
        req.user.branchScope = [];
        next();
      });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Legacy role check — kept for backwards compatibility during migration.
 * New code should use requirePermission() instead.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Permission-based middleware. Checks that the user has ALL specified permissions.
 * Usage: requirePermission('clients.edit', 'clients.view')
 */
export function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    const userPerms = new Set(req.user.permissions || []);
    const missing = requiredPermissions.filter(p => !userPerms.has(p));
    if (missing.length > 0) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: missing,
      });
    }
    next();
  };
}

/**
 * Checks that the user has at least ONE of the specified permissions.
 */
export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    const userPerms = new Set(req.user.permissions || []);
    const hasAny = permissions.some(p => userPerms.has(p));
    if (!hasAny) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
      });
    }
    next();
  };
}

/**
 * Client access enforcement middleware (replaces legacy ensureClientAccess).
 * Combines client scope (assigned vs all) with branch scope restrictions.
 *
 * For single-client routes (req.params.id): verifies ownership and branch access.
 * For list routes: attaches req.clientScopeFilter and req.branchScopeFilter for
 * downstream query builders to apply.
 *
 * @param {Object} [options]
 * @param {boolean} [options.write=false] - If true, also check the write permission
 * @param {string} [options.permission] - Permission key required for write access
 * @returns {Function} Express middleware
 */
export function enforceClientScope({ write = false, permission } = {}) {
  return async (req, res, next) => {
    try {
      // Check write permission if specified
      if (write && permission) {
        const userPerms = new Set(req.user.permissions || []);
        if (!userPerms.has(permission)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      const { default: pool } = await import('../db/pool.js');

      if (req.user.clientScope === 'assigned') {
        // For single-client routes, verify ownership
        if (req.params.id) {
          const { rows } = await pool.query(
            'SELECT assigned_rep_id, branch FROM clients WHERE id = $1',
            [req.params.id]
          );
          if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
          if (rows[0].assigned_rep_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
          }
          // Also enforce branch scope if set
          const bs = req.user.branchScope || [];
          if (bs.length > 0 && rows[0].branch && !bs.some(b => b.toLowerCase() === rows[0].branch.toLowerCase())) {
            return res.status(403).json({ error: 'Access denied' });
          }
        }
        // For list routes, attach scope filter
        req.clientScopeFilter = { assigned_rep_id: req.user.id };
      } else {
        req.clientScopeFilter = {};
        // For 'all' scope + single-client routes, still check branch scope
        if (req.params.id && req.user.branchScope && req.user.branchScope.length > 0) {
          const { default: pool } = await import('../db/pool.js');
          const { rows } = await pool.query(
            'SELECT branch FROM clients WHERE id = $1',
            [req.params.id]
          );
          if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
          const clientBranch = (rows[0].branch || '').toLowerCase();
          const allowed = req.user.branchScope.map(b => b.toLowerCase());
          if (!allowed.includes(clientBranch)) {
            return res.status(403).json({ error: 'Access denied' });
          }
        }
      }

      // Attach branch scope filter for list routes
      if (req.user.branchScope && req.user.branchScope.length > 0) {
        req.clientScopeFilter.branches = req.user.branchScope;
      }

      // Attach branch scope for list queries (applies to all client_scope types)
      req.branchScopeFilter = req.user.branchScope || [];
      next();
    } catch (err) {
      next(err);
    }
  };
}
