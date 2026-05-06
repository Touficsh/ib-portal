/**
 * Portal-specific authentication & authorization middleware.
 *
 * Exports:
 *   isPortalEnabled()      — Returns true if ENABLE_PORTAL env var is 'true'
 *   portalAuthenticate     — Verify JWT scoped to portal, resolve RBAC permissions
 *   requireAgentAccess     — Require the 'portal.access' permission
 *   requirePortalAdmin     — Require the 'portal.admin' permission
 */
import jwt from 'jsonwebtoken';
import { resolvePermissions } from '../services/permissions.js';

/**
 * Returns true if the portal feature flag is enabled.
 */
export function isPortalEnabled() {
  return process.env.ENABLE_PORTAL === 'true';
}

/**
 * JWT authentication middleware for the portal surface.
 * Verifies the Bearer token, resolves RBAC permissions, and attaches
 * the enriched user object to req.user.
 *
 * Accepts tokens with scope 'portal' or 'portal-admin'.
 */
export function portalAuthenticate(req, res, next) {
  if (!isPortalEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Ensure this token was minted for the portal surface
    if (decoded.scope !== 'portal' && decoded.scope !== 'portal-admin') {
      return res.status(403).json({ error: 'Token not valid for portal' });
    }

    req.user = decoded;

    // Resolve RBAC permissions and attach to req.user
    resolvePermissions(decoded.id)
      .then(({ permissions, clientScope, branchScope, roleName, roleId }) => {
        req.user.permissions  = permissions;
        req.user.clientScope  = clientScope;
        req.user.branchScope  = branchScope || [];
        req.user.role         = roleName || decoded.role;
        req.user.roleId       = roleId   || decoded.roleId;
        next();
      })
      .catch(() => {
        // Fallback — keep JWT claims but attach empty permissions
        req.user.permissions = [];
        req.user.clientScope = 'assigned';
        req.user.branchScope = [];
        next();
      });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Requires the authenticated user to have the 'portal.access' permission.
 * Use after portalAuthenticate.
 */
export function requireAgentAccess(req, res, next) {
  const perms = new Set(req.user?.permissions || []);
  if (!perms.has('portal.access') && !perms.has('portal.admin')) {
    return res.status(403).json({ error: 'Portal access required' });
  }
  next();
}

/**
 * Requires the authenticated user to have the 'portal.admin' permission.
 * Use after portalAuthenticate.
 */
export function requirePortalAdmin(req, res, next) {
  const perms = new Set(req.user?.permissions || []);
  if (!perms.has('portal.admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Requires a specific portal permission key. Admins (portal.admin) bypass.
 * Use after portalAuthenticate. Pass the permission string, e.g.:
 *   requirePortalPermission('portal.summary.view')
 */
export function requirePortalPermission(permission) {
  return function (req, res, next) {
    const perms = new Set(req.user?.permissions || []);
    if (perms.has('portal.admin') || perms.has(permission)) return next();
    return res.status(403).json({ error: `Permission '${permission}' required` });
  };
}
