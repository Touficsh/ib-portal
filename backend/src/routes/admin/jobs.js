/**
 * Admin — Jobs — /api/admin/jobs
 *
 * Exposes the in-memory job tracker so the UI can poll for progress on
 * long-running operations (Onboard, Sync contacts, etc.).
 *
 *   GET /                — list all jobs (optionally ?active=true)
 *   GET /:id             — single job's current state
 */
import { Router } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { getJob, listJobs } from '../../services/jobTracker.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

router.get('/', (req, res) => {
  const activeOnly = String(req.query.active || '').toLowerCase() === 'true';
  const type = req.query.type || null;
  res.json({ jobs: listJobs({ activeOnly, type }) });
});

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

export default router;
