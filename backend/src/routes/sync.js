/**
 * IB Portal — Sync Routes — /api/sync
 *
 * Pulls data from x-dev CRM into the local DB.
 * All routes require portal.admin permission.
 *
 *   POST /agents    — page through /api/agents/query and upsert into clients
 *   POST /branches  — pull all branches from /api/branches
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { crmRequest } from '../services/crmGate.js';
import { syncBranchesFromCRM } from '../services/branchImport.js';
import {
  importBranchContacts,
  resetCheckpoint,
  pollNewContacts,
  resetPollCheckpoint,
} from '../services/contactImport.js';
import { audit } from '../services/auditLog.js';
import { createJob, updateJob, completeJob, failJob } from '../services/jobTracker.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// POST /api/sync/agents
// Pages through GET /api/agents/query/:page/:pageSize on the CRM and upserts
// every agent into the local `clients` table (contact_type = 'agent').
// This populates the pool that Import Agents reads from.
router.post('/agents', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'sync.agents', label: 'Refreshing agent list from CRM' });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'sync.agents', label: 'Refreshing agent list from CRM' });
  try {
    const pageSize = 100;
    let inserted = 0, updated = 0, errors = 0, totalFetched = 0;
    let page = 1;
    let totalPages = 1;

    console.log('[Sync] Pulling agents from CRM…');

    while (page <= totalPages) {
      updateJob(jobId, {
        currentStepLabel: `Fetching page ${page}${totalPages > 1 ? `/${totalPages}` : ''}…`,
        progress: totalPages > 1 ? Math.round((page / totalPages) * 100) : 0,
      });
      let data;
      try {
        data = await crmRequest(`/api/agents/query/${page}/${pageSize}`);
      } catch (err) {
        failJob(jobId, `CRM request failed: ${err.message}`);
        return res.status(502).json({ error: `CRM request failed: ${err.message}` });
      }

      if (!data?.agents || !Array.isArray(data.agents)) {
        if (page === 1) return res.status(400).json({ error: 'No agents returned from CRM' });
        break;
      }

      if (page === 1 && data.totalPages) {
        totalPages = data.totalPages;
        console.log(`[Sync] ${data.totalAgents ?? '?'} agents across ${totalPages} pages`);
      }

      for (const a of data.agents) {
        try {
          const email  = a.emails?.[0]?.email   || null;
          const phone  = a.phoneNumbers?.[0]?.number || null;
          const branch = a.branchNames || a.branch?.name || null;

          const { rows } = await pool.query(
            `INSERT INTO clients
               (id, contact_type, name, email, phone, pipeline_stage,
                branch, is_verified, is_trader, crm_profile_type,
                source, created_at, updated_at)
             VALUES ($1, 'agent', $2, $3, $4, 'Active', $5,
                     true, false, 'agent', 'crm', $6, NOW())
             ON CONFLICT (id) DO UPDATE SET
               name       = EXCLUDED.name,
               email      = EXCLUDED.email,
               phone      = EXCLUDED.phone,
               branch     = EXCLUDED.branch,
               updated_at = NOW()
             RETURNING (xmax = 0) AS is_insert`,
            [a._id, a.name, email, phone, branch, a.createdAt || new Date().toISOString()]
          );
          if (rows[0]?.is_insert) inserted++; else updated++;
        } catch (err) {
          console.error('[Sync] agent upsert error:', a._id, err.message);
          errors++;
        }
      }

      totalFetched += data.agents.length;
      page++;
    }

    await audit(req, {
      action: 'sync.agents',
      entity_type: 'clients',
      metadata: { inserted, updated, errors, total: totalFetched },
    });

    console.log(`[Sync] Agents done: ${inserted} new, ${updated} updated, ${errors} errors`);
    completeJob(jobId, { inserted, updated, errors, total: totalFetched });
    res.json({ status: 'done', inserted, updated, errors, total: totalFetched, pages: page - 1, jobId });
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// POST /api/sync/branches
// Pulls all branches from CRM and upserts into local `branches` table.
router.post('/branches', async (req, res, next) => {
  try {
    const result = await syncBranchesFromCRM();
    await audit(req, { action: 'sync.branches', entity_type: 'branches', metadata: result });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/sync/contacts/by-agent
// Pulls individual contacts (and their trading accounts) for clients referred
// by our imported agents. The CRM API ignores ?connectedAgent= filters, so
// we page through /api/contacts and filter in-memory.
//
// Body / query options:
//   branchName    — scope to one branch (e.g. 'Paul Matar') or omit for all imported agents
//   maxPages      — max pages to scan in this run (default 50, each page = 100 contacts)
//   maxTaCalls    — max trading-account fetches in this run (default 300)
//   dryRun        — preview only; no DB writes (default false)
//   resume        — start from checkpoint vs page 1 (default true)
//
// Hard kill switch: at any time, POST /api/admin/crm/pause stops everything
// within ~10 seconds. Re-run with the same params to continue from checkpoint.
router.post('/contacts/by-agent', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'sync.contacts', label: 'Syncing contacts from CRM' });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'sync.contacts', label: 'Syncing contacts from CRM' });
  try {
    const opts = {
      branchName: req.body?.branchName || req.query?.branchName || null,
      agentUserIds: Array.isArray(req.body?.agentUserIds) && req.body.agentUserIds.length > 0
        ? req.body.agentUserIds : null,
      maxPages: Math.min(300, Math.max(1, Number(req.body?.maxPages || req.query?.maxPages) || 50)),
      maxTaCalls: Math.min(1000, Math.max(0, Number(req.body?.maxTaCalls ?? req.query?.maxTaCalls) ?? 300)),
      dryRun: req.body?.dryRun === true || req.query?.dryRun === '1' || req.query?.dryRun === 'true',
      resume: req.body?.resume !== false && req.query?.resume !== 'false',
      taFreshnessHours: Number(req.body?.taFreshnessHours ?? 24),
      jobId,    // pass to service so it can update progress per-page
    };
    updateJob(jobId, { currentStepLabel: `Scoped to ${opts.agentUserIds ? opts.agentUserIds.length + ' agent(s)' : (opts.branchName ? 'branch ' + opts.branchName : 'all imported agents')}…` });
    const result = await importBranchContacts(opts);
    await audit(req, {
      action: 'sync.contacts_by_agent',
      entity_type: 'clients',
      metadata: { ...opts, result_summary: { ...result, _truncated: true } },
    });
    if (result.aborted) failJob(jobId, result.abortReason || 'Aborted');
    else completeJob(jobId, result);
    res.json({ ...result, jobId });
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// POST /api/sync/contacts/by-agent/reset
// Wipes the page-scan checkpoint so the next run starts from page 1.
router.post('/contacts/by-agent/reset', async (req, res, next) => {
  try {
    await resetCheckpoint();
    await audit(req, { action: 'sync.contacts_by_agent.reset', entity_type: 'settings' });
    res.json({ status: 'reset' });
  } catch (err) { next(err); }
});

// POST /api/sync/contacts/poll-new
// Cheap incremental detector. Reads page 1 of /api/contacts (newest-first),
// stops at the previous checkpoint, imports only matching new contacts plus
// their trading accounts. Run on a 15-min schedule for near-real-time
// detection of new clients under your imported agents.
//
// Body / query options:
//   branchName  — scope to one branch's agents (or omit for all imported)
//   maxPages    — pages to scan from page 1 (default 3, max 10)
//   dryRun      — preview only; no DB writes (default false)
//
// First run: sets the checkpoint to "newest seen now" and inserts nothing —
// so subsequent polls only see truly new arrivals.
router.post('/contacts/poll-new', async (req, res, next) => {
  try {
    const opts = {
      branchName: req.body?.branchName || req.query?.branchName || null,
      maxPages: Math.min(10, Math.max(1, Number(req.body?.maxPages || req.query?.maxPages) || 3)),
      dryRun: req.body?.dryRun === true || req.query?.dryRun === '1' || req.query?.dryRun === 'true',
    };
    const result = await pollNewContacts(opts);
    await audit(req, {
      action: 'sync.contacts.poll_new',
      entity_type: 'clients',
      metadata: { ...opts, result_summary: result },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/sync/contacts/poll-new/reset
// Clears the poll checkpoint. Next poll behaves like a first run again.
router.post('/contacts/poll-new/reset', async (req, res, next) => {
  try {
    await resetPollCheckpoint();
    await audit(req, { action: 'sync.contacts.poll_new.reset', entity_type: 'settings' });
    res.json({ status: 'reset' });
  } catch (err) { next(err); }
});

export default router;
