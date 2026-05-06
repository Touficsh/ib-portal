/**
 * Admin — Settings — /api/admin/settings
 *
 * Unified settings surface for admins. Reads/writes the `settings` KV table.
 *
 *   GET  /              — return all managed settings (crm_api_key masked)
 *   PATCH /             — update one or more settings keys
 *   POST /crm/test      — probe the CRM with a lightweight request; returns latency + status
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/auditLog.js';
import { clearCrmConfigCache } from '../../services/crmConfig.js';
import { invalidateCrmGateCache } from '../../services/crmGate.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// Keys that are exposed via the settings API and their types/defaults.
// Sensitive keys are redacted in GET responses.
const MANAGED_KEYS = [
  // CRM connection
  { key: 'crm_base_url',         label: 'CRM Base URL',         type: 'string',  sensitive: false, section: 'crm' },
  { key: 'crm_api_key',          label: 'CRM API Key',          type: 'string',  sensitive: true,  section: 'crm' },
  // CRM gate tuning (also editable via /api/admin/crm/config but surfaced here too)
  { key: 'crm_rate_per_second',  label: 'CRM Rate/s',           type: 'number',  sensitive: false, section: 'crm' },
  { key: 'crm_max_concurrency',  label: 'CRM Max Concurrency',  type: 'number',  sensitive: false, section: 'crm' },
  // Company / manager details shown in portal UI / PDF statements
  { key: 'company_name',         label: 'Company Name',         type: 'string',  sensitive: false, section: 'company' },
  { key: 'company_email',        label: 'Support Email',        type: 'string',  sensitive: false, section: 'company' },
  { key: 'company_phone',        label: 'Support Phone',        type: 'string',  sensitive: false, section: 'company' },
  { key: 'company_website',      label: 'Website URL',          type: 'string',  sensitive: false, section: 'company' },
  { key: 'portal_title',         label: 'Portal Title',         type: 'string',  sensitive: false, section: 'company' },
  // MT5 Manager API connection — read by the bridge via the unauthenticated
  // /api/settings/mt5/internal endpoint (localhost-only, in server.js).
  { key: 'mt5_server',           label: 'MT5 Server',           type: 'string',  sensitive: false, section: 'mt5' },
  { key: 'mt5_port',             label: 'MT5 Port',             type: 'string',  sensitive: false, section: 'mt5' },
  { key: 'mt5_login',            label: 'MT5 Manager Login',    type: 'string',  sensitive: false, section: 'mt5' },
  { key: 'mt5_password',         label: 'MT5 Manager Password', type: 'string',  sensitive: true,  section: 'mt5' },
  // Broker MT5 server timezone offset from UTC, in hours (e.g. "3" for UTC+3).
  // The MT5 Manager API's deal.Time() returns server-local seconds-since-epoch,
  // not UTC. The webhook receiver and snapshot sync subtract this offset
  // before storing, so deal_time in the DB is always real UTC.
  { key: 'mt5_server_tz_offset_hours', label: 'MT5 Server TZ Offset (hours)', type: 'number', sensitive: false, section: 'mt5' },
];

const KEY_SET = new Set(MANAGED_KEYS.map(m => m.key));

/**
 * GET /api/admin/settings
 * Returns all managed keys. Sensitive values are replaced with a mask
 * so the frontend can show "••••••••" without exposing the real value.
 * Includes a `has_value` boolean so the UI knows whether a key is set.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, updated_at FROM settings WHERE key = ANY($1)`,
      [MANAGED_KEYS.map(m => m.key)]
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r]));

    const result = MANAGED_KEYS.map(meta => {
      const row = map[meta.key];
      return {
        key: meta.key,
        label: meta.label,
        type: meta.type,
        sensitive: meta.sensitive,
        section: meta.section,
        has_value: !!row?.value,
        value: meta.sensitive ? (row?.value ? '••••••••' : '') : (row?.value ?? ''),
        updated_at: row?.updated_at ?? null,
      };
    });

    res.json(result);
  } catch (err) { next(err); }
});

/**
 * PATCH /api/admin/settings
 * Body: { key: value, ... } — only keys in MANAGED_KEYS are accepted.
 * Sensitive keys: if the body value is the mask string, skip (no-op).
 */
router.patch('/', async (req, res, next) => {
  try {
    const updates = req.body || {};
    const touched = [];
    const rejected = [];

    for (const [key, rawValue] of Object.entries(updates)) {
      if (!KEY_SET.has(key)) {
        rejected.push(key);
        continue;
      }

      const meta = MANAGED_KEYS.find(m => m.key === key);

      // Skip the mask placeholder — means "don't change the current value"
      if (meta.sensitive && rawValue === '••••••••') continue;

      const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();

      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );
      touched.push(key);
    }

    // Bust caches for CRM-related keys
    const crmTouched = touched.some(k => k.startsWith('crm_'));
    if (crmTouched) {
      clearCrmConfigCache();
      invalidateCrmGateCache();
    }

    // Bust the centralized settings cache so the new value takes effect on
    // the next read across all consumers (webhook receiver, snapshot sync,
    // commission engine). Without this, changes wouldn't apply until restart.
    if (touched.length > 0) {
      try {
        const { clearSettingsCache } = await import('../../services/settingsCache.js');
        clearSettingsCache();
      } catch { /* settingsCache always loadable — log if it ever isn't */ }
    }

    // Audit non-sensitive changes
    const auditKeys = touched.filter(k => {
      const m = MANAGED_KEYS.find(x => x.key === k);
      return !m?.sensitive;
    });
    if (auditKeys.length > 0) {
      await audit(req, {
        action: 'settings.update',
        entity_type: 'settings',
        metadata: {
          updated_keys: auditKeys,
          sensitive_keys_updated: touched.filter(k => !auditKeys.includes(k)),
        },
      });
    }

    res.json({
      ok: true,
      updated: touched,
      ...(rejected.length > 0 ? { rejected } : {}),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/settings/crm/test
 * Fires a lightweight GET /api/branches?page=1&pageSize=1 to the CRM and
 * returns the status code + latency. Does NOT go through the gate's budget/
 * rate-limiter so it never burns a slot from the daily budget.
 */
router.post('/crm/test', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('crm_base_url', 'crm_api_key')`
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const baseUrl = map.crm_base_url || process.env.CRM_API_BASE_URL || '';
    const apiKey  = map.crm_api_key  || process.env.CRM_API_KEY || '';

    if (!baseUrl) {
      return res.status(400).json({ ok: false, error: 'CRM Base URL is not configured' });
    }

    const start = Date.now();
    let status, text;
    try {
      const testRes = await fetch(`${baseUrl}/api/branches?page=1&pageSize=1`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(8000),
      });
      status = testRes.status;
      text = await testRes.text().catch(() => '');
    } catch (fetchErr) {
      return res.json({
        ok: false,
        latency_ms: Date.now() - start,
        error: fetchErr.message || 'Network error',
      });
    }

    const latency_ms = Date.now() - start;
    const ok = status >= 200 && status < 300;
    res.json({
      ok,
      status,
      latency_ms,
      ...(!ok ? { error: text?.slice(0, 200) || `HTTP ${status}` } : {}),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/settings/mt5/test
 * Hits the MT5 bridge /health endpoint to confirm:
 *   - bridge is running
 *   - bridge has authenticated to MT5 successfully
 * Does NOT trigger a reconnect; use /mt5/reconnect for that.
 */
router.get('/mt5/test', async (req, res, next) => {
  try {
    const bridgeUrl = process.env.MT5_BRIDGE_URL || 'http://localhost:5555';
    const start = Date.now();
    try {
      const r = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await r.json().catch(() => ({}));
      return res.json({
        ok: !!body.mt5Connected,
        bridge_running: true,
        mt5_connected: !!body.mt5Connected,
        init_error: body.initError || null,
        latency_ms: Date.now() - start,
        bridge_url: bridgeUrl,
      });
    } catch (fetchErr) {
      return res.json({
        ok: false,
        bridge_running: false,
        latency_ms: Date.now() - start,
        error: fetchErr.message || 'Bridge unreachable',
        bridge_url: bridgeUrl,
      });
    }
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/settings/mt5/reconnect
 * Tells the bridge to reload credentials and re-authenticate to MT5.
 * Use after saving a new password / server. Bridge calls back to
 * /api/settings/mt5/internal so the new values take effect.
 */
router.post('/mt5/reconnect', async (req, res, next) => {
  try {
    const bridgeUrl = process.env.MT5_BRIDGE_URL || 'http://localhost:5555';
    const start = Date.now();
    try {
      // /connect on the bridge actually does the full reload + login flow.
      // /reconnect just disconnects, which doesn't help us.
      const r = await fetch(`${bridgeUrl}/connect`, {
        method: 'POST',
        signal: AbortSignal.timeout(45000),  // MT5 login can take 30s
      });
      const body = await r.json().catch(() => ({}));
      await audit(req, {
        action: 'mt5.bridge.reconnect',
        entity_type: 'mt5_bridge',
        metadata: { success: !!body.success, error: body.error || null },
      });
      return res.json({
        ok: !!body.success,
        latency_ms: Date.now() - start,
        ...body,
      });
    } catch (fetchErr) {
      return res.json({
        ok: false,
        latency_ms: Date.now() - start,
        error: fetchErr.message || 'Reconnect failed',
      });
    }
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// Agent portal access — globally toggleable per-page visibility.
//
// These endpoints read/write the `agent` role's permissions array directly,
// so every user with role='agent' is affected uniformly. No per-user
// overrides involved — this is the global default.
//
// Toggle keys (the only ones surfaced as global toggles for now):
//   portal.summary.view        — Summary page in agent sidebar
//   portal.commission_tree.view — Commission Tree page
//   portal.commissions.view    — Commissions page (and PDF download)
// ─────────────────────────────────────────────────────────────────────────

const TOGGLEABLE_AGENT_PERMS = [
  { key: 'portal.summary.view',         label: 'Summary page' },
  { key: 'portal.commission_tree.view', label: 'Commission Tree page' },
  { key: 'portal.commissions.view',     label: 'Commissions page (and PDF download)' },
];

// GET /api/admin/settings/agent-permissions
router.get('/agent-permissions', async (req, res, next) => {
  try {
    const { rows: [role] } = await pool.query(
      `SELECT id, permissions FROM roles WHERE name = 'agent'`
    );
    if (!role) return res.status(404).json({ error: "'agent' role not found" });
    const set = new Set(role.permissions || []);
    res.json({
      role_id: role.id,
      toggles: TOGGLEABLE_AGENT_PERMS.map(p => ({
        key: p.key, label: p.label, enabled: set.has(p.key),
      })),
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/settings/agent-permissions
// Body: { toggles: { 'portal.summary.view': true, 'portal.commissions.view': false, ... } }
router.put('/agent-permissions', async (req, res, next) => {
  try {
    const requested = req.body?.toggles;
    if (!requested || typeof requested !== 'object') {
      return res.status(400).json({ error: 'toggles object is required' });
    }
    // Validate keys — only allow the toggleable set
    const validKeys = new Set(TOGGLEABLE_AGENT_PERMS.map(p => p.key));
    for (const k of Object.keys(requested)) {
      if (!validKeys.has(k)) return res.status(400).json({ error: `Unknown permission key: ${k}` });
    }

    // Apply atomically: read current, mutate, write back, bust cache
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const { rows: [role] } = await dbClient.query(
        `SELECT id, permissions FROM roles WHERE name = 'agent' FOR UPDATE`
      );
      if (!role) {
        await dbClient.query('ROLLBACK');
        return res.status(404).json({ error: "'agent' role not found" });
      }
      const current = new Set(role.permissions || []);
      for (const [k, v] of Object.entries(requested)) {
        if (v) current.add(k); else current.delete(k);
      }
      const next = [...current];
      await dbClient.query(
        `UPDATE roles SET permissions = $1, updated_at = NOW() WHERE id = $2`,
        [next, role.id]
      );
      await dbClient.query('COMMIT');

      // Bust caches for every user with this role so the next request reflects the change
      const { bustCacheForRole } = await import('../../services/permissions.js');
      await bustCacheForRole(role.id);

      await audit(req, {
        action: 'admin.settings.agent_permissions',
        entity_type: 'role',
        entity_id: role.id,
        metadata: { toggles: requested },
      });

      res.json({
        role_id: role.id,
        toggles: TOGGLEABLE_AGENT_PERMS.map(p => ({
          key: p.key, label: p.label, enabled: current.has(p.key),
        })),
      });
    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (err) { next(err); }
});

export default router;
