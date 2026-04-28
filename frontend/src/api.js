/**
 * Portal API client — thin wrapper around fetch.
 *
 * Responsibilities:
 *   - Prefix every path with `/api/portal` (or plain `/api/...` if absolute)
 *   - Attach `Authorization: Bearer <token>` from localStorage
 *   - Parse JSON errors and throw `ApiError` with `status` + `body` attached
 *   - 401 handling is done in AuthContext so it can redirect to login
 *
 * Tokens live in localStorage under PORTAL_TOKEN_KEY. Keep the key namespaced
 * so the staff CRM (if ever logged into on the same origin) doesn't collide.
 */

export const PORTAL_TOKEN_KEY = 'crm.portal.token';
export const PORTAL_USER_KEY = 'crm.portal.user';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getToken() {
  try { return localStorage.getItem(PORTAL_TOKEN_KEY); } catch { return null; }
}

export function setSession(token, user) {
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
  localStorage.setItem(PORTAL_USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(PORTAL_TOKEN_KEY);
  localStorage.removeItem(PORTAL_USER_KEY);
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(PORTAL_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Perform a fetch against the portal API.
 *  - `path` may be either a portal-relative path ("/me", "/clients") OR an
 *    absolute "/api/..." path (rare, but useful for shared endpoints).
 *  - Body (if provided as object) is JSON-stringified.
 *  - Returns parsed JSON, or null for 204.
 */
export async function api(path, { method = 'GET', body, headers = {}, query } = {}) {
  const token = getToken();
  const url = new URL(
    path.startsWith('/api') ? path : `/api/portal${path.startsWith('/') ? '' : '/'}${path}`,
    window.location.origin
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  let payload = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { payload = await res.json(); } catch { /* ignore */ }
  }

  if (!res.ok) {
    throw new ApiError(
      payload?.error || `${res.status} ${res.statusText}`,
      res.status,
      payload
    );
  }
  return payload;
}
