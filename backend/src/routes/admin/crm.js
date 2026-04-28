/**
 * Admin — CRM Gate — /api/admin/crm
 *
 * Exposes the CRM rate-limit / concurrency / kill-switch controls that live
 * in services/crmGate.js. All routes require `portal.admin`.
 *
 *   GET  /status     — current rate, concurrency, in-flight count, queue depths, paused flag
 *   POST /pause      — flip settings.crm_paused='true'. Every in-flight call still completes;
 *                      every NEW call throws CrmPausedError within 10s (settings cache TTL)
 *                      or instantly if /resume wasn't called (we bust the cache here).
 *   POST /resume     — flip settings.crm_paused='false'.
 *   PATCH /config    — update rate / concurrency. Body: { ratePerSecond?: int, maxConcurrency?: int }.
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/auditLog.js';
import { getCrmGateState, setCrmPaused, invalidateCrmGateCache } from '../../services/crmGate.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/crm/status
router.get('/status', async (req, res, next) => {
  try {
    const state = await getCrmGateState();
    res.json(state);
  } catch (err) { next(err); }
});

// POST /api/admin/crm/pause
router.post('/pause', async (req, res, next) => {
  try {
    const result = await setCrmPaused(true);
    await audit(req, {
      action: 'crm.gate.pause',
      entity_type: 'settings',
      entity_id: 'crm_paused',
      metadata: { reason: req.body?.reason || null },
    });
    res.json({ ...result, message: 'CRM calls paused. All new calls will throw CrmPausedError.' });
  } catch (err) { next(err); }
});

// POST /api/admin/crm/resume
router.post('/resume', async (req, res, next) => {
  try {
    const result = await setCrmPaused(false);
    await audit(req, {
      action: 'crm.gate.resume',
      entity_type: 'settings',
      entity_id: 'crm_paused',
    });
    res.json({ ...result, message: 'CRM calls resumed.' });
  } catch (err) { next(err); }
});

// PATCH /api/admin/crm/config
router.patch('/config', async (req, res, next) => {
  try {
    const ratePerSecond = req.body?.ratePerSecond != null ? Number(req.body.ratePerSecond) : null;
    const maxConcurrency = req.body?.maxConcurrency != null ? Number(req.body.maxConcurrency) : null;
    if (ratePerSecond != null && (!Number.isFinite(ratePerSecond) || ratePerSecond < 1 || ratePerSecond > 50)) {
      return res.status(400).json({ error: 'ratePerSecond must be 1-50' });
    }
    if (maxConcurrency != null && (!Number.isFinite(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 50)) {
      return res.status(400).json({ error: 'maxConcurrency must be 1-50' });
    }
    const updates = [];
    if (ratePerSecond != null) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('crm_rate_per_second', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(ratePerSecond)]
      );
      updates.push(`rate=${ratePerSecond}/s`);
    }
    if (maxConcurrency != null) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('crm_max_concurrency', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(maxConcurrency)]
      );
      updates.push(`concurrency=${maxConcurrency}`);
    }
    invalidateCrmGateCache();
    await audit(req, {
      action: 'crm.gate.config',
      entity_type: 'settings',
      entity_id: 'crm_gate',
      metadata: { ratePerSecond, maxConcurrency },
    });
    const state = await getCrmGateState();
    res.json({ ...state, updated: updates });
  } catch (err) { next(err); }
});

export default router;
