/**
 * Admin Agents — /api/agents
 *
 * Admin-facing management of the IB/agent tree. These endpoints live on the
 * staff CRM surface (NOT the portal) and require `portal.admin` permission.
 *
 * Endpoints:
 *   GET    /                       — list all agents (tree view with counts)
 *   GET    /:id                    — agent detail (parent, products, direct children, client count)
 *   POST   /:id/promote            — promote a user to agent, optionally set parent + initial products
 *   POST   /:id/demote             — demote back to prior role; reparent direct children up one level
 *   PATCH  /:id                    — update agent fields (parent_agent_id, is_active)
 *   POST   /:id/products           — assign/update a product rate (cascade-validated)
 *   DELETE /:id/products/:productId — revoke a product (soft via is_active = false)
 *
 * Cascade rules are enforced via services/rateCascade.js. Re-parenting checks
 * for cycles before committing.
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { bustPermissionCache } from '../services/permissions.js';
import { validateRate, wouldCreateCycle, findDescendantsExceeding } from '../services/rateCascade.js';
import { listImportableAgents, importAgents, listImportableBranches } from '../services/agentImport.js';
import { importBranchContacts } from '../services/contactImport.js';
import { syncAgentHierarchy } from '../services/agentHierarchySync.js';
import { createJob, updateJob, completeJob, failJob } from '../services/jobTracker.js';
import { listCrmProductsForAgent, syncAgentProductsFromCRM, scanCrmAgentProducts } from '../services/agentProductSync.js';
import { ensureSensibleRates, healRatesForBranch, healRatesForSubtree } from '../services/rateDefaults.js';
import { runCommissionSync } from '../services/commissionEngine.js';
import { syncForAgent as syncMt5ForAgent } from '../services/mt5SnapshotSync.js';
import { seedMt5Groups } from '../services/mt5GroupSeed.js';
import { syncOneAgentCommissionLevels, syncAllCommissionLevels } from '../services/commissionLevelSync.js';
import { backfillAgentParents } from '../services/agentParentBackfill.js';
import { checkCrmGateHealth } from '../services/crmGate.js';
import { syncBranchesFromCRM } from '../services/branchImport.js';
import { audit } from '../services/auditLog.js';
import { cacheMw, invalidateCache } from '../services/responseCache.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/agents/importable — preview top client-agents ordered by referral count.
// Optional filters:
//   ?branch=<name>     — only agents in this branch (or '(no branch)' for NULL)
//   ?onlyPending=true  — hide already-imported agents
router.get('/importable', async (req, res, next) => {
  try {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 100));
    const branch = req.query.branch || null;
    const onlyPending = String(req.query.onlyPending).toLowerCase() === 'true';
    const rows = await listImportableAgents({ limit, branch, onlyPending });
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/agents/importable/branches — one row per branch with counts
router.get('/importable/branches', async (req, res, next) => {
  try {
    const rows = await listImportableBranches();
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/agents/import — promote client-agents into portal users.
// Selection modes (checked in this order):
//   body `{ client_ids: ['...'] }` → import exactly these (per-row action)
//   body `{ branch: 'Main' }`      → import every PENDING agent in that branch
//   else `?limit=N` / body `{ limit: N }` → top-N by referral count (bulk)
//
// Idempotent; re-running grows the imported set and fills in deferred parent links.
//
// AUTO-FINISH chain (default on): After the import itself completes we also:
//   1. Preflight — verify the CRM gate is healthy (not paused, no circuits open).
//      If unhealthy, skip the chain and return a banner asking the admin to
//      resume the gate + click Finish Import manually.
//   2. Scoped parent backfill — only for agents whose parent link is NULL after
//      import (usually 0, but catches cases where a child was imported before
//      their parent). Costs 1 CRM call per orphan, not 280.
//   3. Scoped commission-level sync — pulls % + $/lot from CRM for ONLY the
//      newly imported agent IDs. Replaces manual rate_per_lot entry for any
//      branch whose CRM has commission configs.
//
// Response has per-agent arrays (ok/no_config/failed) so the UI can show a
// retry button per failed agent instead of a silent toast.
//
// Pass `?autoFinish=false` to skip the chain entirely (e.g. dry runs, or
// when you want to do the finish step manually after reviewing).
//
// Nothing emails agents — credentials are delivered out-of-band by the admin.
router.post('/import', async (req, res, next) => {
  // Job tracker — frontend can pass X-Job-Id to share the id with a parallel
  // progress modal it has already opened. If absent, we generate one and
  // surface it in the final response so the UI can attach a modal afterward.
  const providedJobId = req.headers['x-job-id'] && String(req.headers['x-job-id']);
  const jobId = providedJobId || createJob({
    type: 'agents.import',
    label: 'Onboarding agents',
    totalSteps: 4,
    userId: req.user?.id,
  });
  // If the frontend pre-created the job (passed header) we still need to
  // ensure the entry exists in our local in-memory tracker. createJob() with
  // a forced id isn't supported, so we just update the job that exists or
  // create a fresh one. Either way the frontend has the id.
  if (!providedJobId) {
    // local createJob already returned id; nothing else needed
  } else {
    // Ensure the job exists (frontend may have called createJob via header preflight in future).
    // For now, register in our tracker so updateJob calls work.
    try {
      updateJob(providedJobId, { type: 'agents.import', label: 'Onboarding agents', totalSteps: 4 });
    } catch { /* no-op */ }
  }
  updateJob(jobId, { step: 1, currentStepLabel: 'Validating + resolving pick list…' });

  try {
    const autoFinish = String(req.query.autoFinish ?? 'true').toLowerCase() !== 'false';
    const clientIds = Array.isArray(req.body?.client_ids) ? req.body.client_ids : null;

    // ─── Run the import itself ────────────────────────────────────────────
    let baseSummary;
    let mode = 'bulk';
    let branchLabel = null;

    if (clientIds && clientIds.length > 0) {
      updateJob(jobId, { step: 1, currentStepLabel: `Importing ${clientIds.length} agent${clientIds.length === 1 ? '' : 's'} + recursive subtree…`, details: { clientIds: clientIds.length } });
      baseSummary = await importAgents({ clientIds });
      mode = 'by-ids';
    } else if (req.body?.branch) {
      const branchAgents = await listImportableAgents({
        limit: 2000,
        branch: req.body.branch === '(no branch)' ? null : req.body.branch,
        onlyPending: true,
      });
      const ids = branchAgents
        .filter(a => req.body.branch === '(no branch)' ? !a.branch : a.branch === req.body.branch)
        .map(a => a.id);
      if (ids.length === 0) {
        return res.json({ mode: 'by-branch', branch: req.body.branch, requested: 0, created: 0, updated: 0, skipped: 0, auto_finish: { state: 'skipped_no_new_agents' } });
      }
      baseSummary = await importAgents({ clientIds: ids });
      mode = 'by-branch';
      branchLabel = req.body.branch;
    } else {
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || Number(req.body?.limit) || 50));
      baseSummary = await importAgents({ limit });
    }

    const response = { ...baseSummary, mode, branch: branchLabel };

    // ─── Early return: nothing to post-process ────────────────────────────
    if (!autoFinish) {
      response.auto_finish = { state: 'disabled_by_flag' };
      return res.json(response);
    }
    if (baseSummary.created === 0) {
      response.auto_finish = { state: 'skipped_no_new_agents', message: 'Re-import of already-imported agents — no rates to sync' };
      return res.json(response);
    }

    // ─── Resolve user IDs to scope downstream sync to ───────────────────
    // We want to cover the FULL recursively-imported subtree, not just the
    // originally clicked agent. agentImport now returns `processed_client_ids`
    // (every CRM agent ID in the resolved pick list — picked + descendants).
    // Map that to user.ids so contact sync at the end pulls clients for
    // ALL of them.
    let newUserIds = baseSummary.created_ids || baseSummary.user_ids || [];
    if (!Array.isArray(newUserIds) || newUserIds.length === 0) {
      // Determine which CRM client IDs were processed in this import call
      let clientIdsForLookup = [];
      if (Array.isArray(baseSummary.processed_client_ids) && baseSummary.processed_client_ids.length > 0) {
        // PREFERRED: the full recursive pick list (includes Hadi + Sophia + Fatima + …)
        clientIdsForLookup = baseSummary.processed_client_ids;
      } else if (Array.isArray(baseSummary.imported_client_ids) && baseSummary.imported_client_ids.length > 0) {
        clientIdsForLookup = baseSummary.imported_client_ids;
      } else if (clientIds && clientIds.length > 0) {
        clientIdsForLookup = clientIds;
      } else if (mode === 'by-branch' && branchLabel) {
        // For branch imports: look up all imported users in this branch
        const { rows } = await pool.query(
          `SELECT u.id FROM users u
           JOIN clients c ON c.id = u.linked_client_id
           WHERE u.is_agent = true AND c.branch IS NOT DISTINCT FROM $1`,
          [branchLabel === '(no branch)' ? null : branchLabel]
        );
        newUserIds = rows.map(r => r.id);
      }
      if (newUserIds.length === 0 && clientIdsForLookup.length > 0) {
        const { rows } = await pool.query(
          'SELECT id FROM users WHERE linked_client_id = ANY($1::varchar[])',
          [clientIdsForLookup]
        );
        newUserIds = rows.map(r => r.id);
      }
    }

    updateJob(jobId, {
      step: 2,
      currentStepLabel: `Auto-finish — wiring parent links, syncing commission rates for ${newUserIds.length} new user${newUserIds.length === 1 ? '' : 's'}…`,
      details: {
        agentsCreated: baseSummary.created,
        agentsUpdated: baseSummary.updated,
        newUserIds: newUserIds.length,
      },
    });

    const autoFinishResult = {
      state: 'running',
      new_user_count: newUserIds.length,
      preflight: null,
      parent_backfill: null,
      commission_levels: {
        ok: [],         // { agent_id, name, configs, groups }
        no_config: [],  // { agent_id, name }  — CRM has no level for this agent
        failed: [],     // { agent_id, name, error }
      },
      warnings: [],
    };

    // ─── Safety net 1: preflight gate check ───────────────────────────────
    const health = await checkCrmGateHealth({ requiredBuckets: ['contacts-detail', 'commission-levels'] });
    autoFinishResult.preflight = health;
    if (!health.healthy) {
      autoFinishResult.state = 'skipped_gate_unhealthy';
      autoFinishResult.warnings.push(
        health.paused
          ? 'CRM gate is paused. Resume it then click "Finish import" to sync rates for the newly imported agents.'
          : 'CRM gate has an open circuit breaker. Wait for cooldown or click "Finish import" later.'
      );
      response.auto_finish = autoFinishResult;
      await audit(req, {
        action: 'agents.import',
        entity_type: 'system',
        entity_id: branchLabel || 'multi',
        metadata: { mode, branch: branchLabel, created: baseSummary.created, auto_finish: 'skipped_gate_unhealthy' },
      });
      return res.json(response);
    }

    // ─── Safety net 2: scoped parent backfill (only if orphaned) ──────────
    // After import, check which new users still have NULL parent_agent_id
    // despite the underlying client having a referred_by_agent_id. That's
    // the exact set that needs backfill.
    try {
      const { rows: orphans } = await pool.query(
        `SELECT u.id FROM users u JOIN clients c ON c.id = u.linked_client_id
         WHERE u.id = ANY($1::uuid[]) AND u.parent_agent_id IS NULL
           AND c.referred_by_agent_id IS NOT NULL`,
        [newUserIds]
      );
      if (orphans.length > 0) {
        const backfillSummary = await backfillAgentParents({ agentIds: orphans.map(r => r.id) });
        autoFinishResult.parent_backfill = {
          ok: true,
          scoped_to: orphans.length,
          parents_set: backfillSummary.parents_set,
          portal_agents_rewired: backfillSummary.portal_agents_rewired,
          errors: backfillSummary.errors,
        };
      } else {
        autoFinishResult.parent_backfill = { ok: true, scoped_to: 0, skipped_reason: 'no_orphans' };
      }
    } catch (err) {
      autoFinishResult.parent_backfill = { ok: false, error: err.message };
      autoFinishResult.warnings.push('Parent backfill failed — re-run "Backfill parents" if hierarchy looks wrong.');
    }

    // ─── Safety net 3: per-agent commission-level sync ────────────────────
    // Loop agents one-by-one instead of using syncAllCommissionLevels so we
    // can capture per-agent outcome into ok/no_config/failed arrays. This is
    // what the UI uses to render the result card with per-agent retry buttons.
    for (const uid of newUserIds) {
      const { rows: nameRows } = await pool.query('SELECT name FROM users WHERE id = $1', [uid]);
      const name = nameRows[0]?.name || '(unknown)';
      try {
        const r = await syncOneAgentCommissionLevels(uid);
        if (r.groups_upserted > 0) {
          autoFinishResult.commission_levels.ok.push({
            agent_id: uid, name,
            configs: r.configs_upserted, groups: r.groups_upserted,
          });
        } else {
          // CRM call succeeded but the agent has no level configured there yet
          autoFinishResult.commission_levels.no_config.push({ agent_id: uid, name });
        }
      } catch (err) {
        autoFinishResult.commission_levels.failed.push({
          agent_id: uid, name,
          error: err.code === 'CRM_PAUSED' ? 'CRM paused mid-chain' : (err.message || 'sync failed'),
        });
        // If the gate got paused or a circuit tripped mid-loop, stop early —
        // remaining agents would also fail; surface that clearly instead of
        // filling the failed[] array with identical errors.
        if (err.code === 'CRM_PAUSED' || err.message?.includes('circuit')) {
          autoFinishResult.warnings.push('Aborted mid-sync: CRM gate became unavailable. Retry the failed agents once it\'s healthy.');
          break;
        }
      }
    }

    autoFinishResult.state = 'done';
    response.auto_finish = autoFinishResult;

    // ─── Step 5 (opt-in): pull individual contacts + trading accounts for the
    //     freshly imported agents only. Triggered by ?withContacts=1 or
    //     { withContacts: true } in the body. Scoped to newUserIds, so it
    //     never re-touches already-synced agents from prior imports. The
    //     trading-account fetch has a 24h freshness guard.
    const withContacts = String(req.query.withContacts ?? req.body?.withContacts ?? 'false').toLowerCase() === 'true'
      || req.query.withContacts === '1';
    // Determine which CRM agent IDs to hierarchy-sync. For by-ids mode we use
    // the picked clientIds. For by-branch mode we use processed_client_ids
    // (the recursive pickList from importAgents — top-level agents in the
    // chosen branch). For top-N we hierarchy-sync only those that were just
    // created (not the existing ones, to keep cost bounded).
    let hierarchyAgentIds = [];
    if (Array.isArray(clientIds) && clientIds.length > 0) {
      hierarchyAgentIds = clientIds;
    } else if (Array.isArray(baseSummary.processed_client_ids) && baseSummary.processed_client_ids.length > 0) {
      hierarchyAgentIds = baseSummary.processed_client_ids;
    }

    if (withContacts && hierarchyAgentIds.length > 0) {
      // NEW (2026-05-04): replaced 272-page /api/contacts sweep with the
      // /api/agent-hierarchy endpoint, which returns the full subtree of an
      // agent (agents + clients + leads + MT5 logins) in a single call.
      // Per-client product mapping (via /trading-accounts) is still backfilled
      // for new logins — bounded and parallelized inside the service.
      try {
        updateJob(jobId, {
          step: 3,
          currentStepLabel: `Pulling hierarchy + clients + leads + MT5 logins from CRM (${hierarchyAgentIds.length} root${hierarchyAgentIds.length === 1 ? '' : 's'})…`,
        });
        const perAgentResults = [];
        let i = 0;
        for (const cid of hierarchyAgentIds) {
          i++;
          updateJob(jobId, {
            step: 3,
            currentStepLabel: `Pulling subtree ${i}/${hierarchyAgentIds.length}…`,
            details: { hierarchyProgress: { current: i, total: hierarchyAgentIds.length } },
          });
          const r = await syncAgentHierarchy({ agentId: cid });
          perAgentResults.push(r);
        }
        // Aggregate the per-agent summaries into a single response payload
        // shaped similarly to the legacy contact_sync result so the UI/audit
        // doesn't have to learn a new field name.
        const agg = perAgentResults.reduce((acc, r) => {
          acc.agentsCreated     += r.agentsCreated     || 0;
          acc.agentsUpdated     += r.agentsUpdated     || 0;
          acc.contactsInserted  += (r.clientsUpserted || 0) + (r.leadsUpserted || 0);
          acc.contactsUpdated   += 0;
          acc.tradingAccountsFetched += r.productMappingsFetched || 0;
          acc.loginsFound       += r.loginsStubbed || 0;
          if (r.aborted) {
            acc.aborted = true;
            acc.abortReason = r.abortReason || acc.abortReason;
          }
          return acc;
        }, {
          mode: 'agent-hierarchy',
          agentsCreated: 0,
          agentsUpdated: 0,
          contactsInserted: 0,
          contactsUpdated: 0,
          tradingAccountsFetched: 0,
          loginsFound: 0,
          aborted: false,
          abortReason: null,
          per_agent: perAgentResults,
        });
        response.contact_sync = agg;
      } catch (err) {
        response.contact_sync = {
          aborted: true,
          abortReason: err?.message || 'contact sync failed',
        };
      }
    }

    // ─── Self-healing second pass ────────────────────────────────────────
    // Some sub-agents may have had referred_by_agent_id = NULL during the
    // first importAgents() recursive CTE (transient prepass failures or CRM
    // returning empty connectedAgent for a moment). The contact sync above
    // would then UPSERT their referred_by_agent_id as a side effect of
    // matching their connectedAgent. By the time we get here, those parent
    // links may now be set — so re-running importAgents picks up the
    // stragglers. Idempotent: agents already imported are just touched
    // (UPDATE), parent backfill skips entries that are already correct.
    //
    // Only fires when:
    //   1. We did a by-ids import (so we have a known seed to expand)
    //   2. Contact sync ran (which is what fills the late-set parent links)
    //   3. Contact sync didn't abort (otherwise data may be inconsistent)
    if (
      mode === 'by-ids'
      && withContacts
      && response.contact_sync
      && !response.contact_sync.aborted
      && (response.contact_sync.contactsInserted > 0 || response.contact_sync.contactsUpdated > 0)
      && Array.isArray(clientIds)
      && clientIds.length > 0
    ) {
      try {
        const stragglerSummary = await importAgents({ clientIds });
        const newAgents = stragglerSummary.created;
        // Only attach to response if we actually found new agents — otherwise
        // it's noise (the second pass found nothing missed by the first).
        if (newAgents > 0) {
          response.straggler_pass = {
            ran: true,
            created: newAgents,
            updated: stragglerSummary.updated,
            note: 'Second pass picked up sub-agents whose parent links were finalized during contact sync',
          };
        } else {
          response.straggler_pass = { ran: true, created: 0 };
        }
      } catch (err) {
        // Non-fatal — the user got their primary import + contacts. The
        // stragglers can be picked up next time. Surface the error in the
        // response so it's visible.
        response.straggler_pass = {
          ran: true,
          error: err?.message || 'second-pass import failed',
        };
      }
    }

    await audit(req, {
      action: 'agents.import',
      entity_type: 'system',
      entity_id: branchLabel || 'multi',
      metadata: {
        mode, branch: branchLabel,
        created: baseSummary.created,
        updated: baseSummary.updated,
        auto_finish_state: autoFinishResult.state,
        levels_ok:        autoFinishResult.commission_levels.ok.length,
        levels_no_config: autoFinishResult.commission_levels.no_config.length,
        levels_failed:    autoFinishResult.commission_levels.failed.length,
        parent_orphans_fixed: autoFinishResult.parent_backfill?.parents_set ?? 0,
        contacts_synced: response.contact_sync?.contactsInserted ?? null,
      },
    });

    // Bust any cached agents/hierarchy/branches reads so the admin's next
    // page load reflects the new imports instead of serving up to 2 min of
    // stale cached data.
    invalidateCache('/api/agents');
    invalidateCache('/api/admin/dashboard');

    updateJob(jobId, { step: 4, currentStepLabel: 'Done — finalizing response' });
    response.jobId = jobId;
    completeJob(jobId, {
      created: response.created,
      updated: response.updated,
      contacts: response.contact_sync?.contactsInserted || 0,
      logins: response.contact_sync?.loginsFound || 0,
    });
    res.json(response);
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// POST /api/agents/:id/retry-post-import — re-run post-import chain for ONE
// user. Used by the UI's per-agent retry button after an auto-finish failure.
router.post('/:id/retry-post-import', async (req, res, next) => {
  try {
    const uid = req.params.id;
    const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id = $1 AND is_agent = true', [uid]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    const name = userRows[0].name;

    const health = await checkCrmGateHealth({ requiredBuckets: ['contacts-detail', 'commission-levels'] });
    if (!health.healthy) {
      return res.status(503).json({ error: 'CRM gate unhealthy', health });
    }

    const result = { agent_id: uid, name, commission_levels: null, parent_backfill: null };

    // Parent backfill for this one user if still orphaned
    const { rows: orphanCheck } = await pool.query(
      `SELECT u.id FROM users u JOIN clients c ON c.id = u.linked_client_id
       WHERE u.id = $1 AND u.parent_agent_id IS NULL AND c.referred_by_agent_id IS NOT NULL`,
      [uid]
    );
    if (orphanCheck.length > 0) {
      const bf = await backfillAgentParents({ agentIds: [uid] });
      result.parent_backfill = { parents_set: bf.parents_set };
    }

    // Commission level sync
    try {
      const r = await syncOneAgentCommissionLevels(uid);
      result.commission_levels = {
        ok: true,
        configs: r.configs_upserted, groups: r.groups_upserted,
        state: r.groups_upserted > 0 ? 'synced' : 'no_config',
      };
    } catch (err) {
      result.commission_levels = { ok: false, error: err.message };
    }

    await audit(req, {
      action: 'agents.post_import_retry',
      entity_type: 'user',
      entity_id: uid,
      metadata: result,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/agents/sync-products-from-crm — bulk-populate agent_products from
// x-dev's CRM product.agents[] linkage. Creates 0-rate placeholder rows
// (source='crm'); admins set real rates afterwards. Preserves existing
// manual rows (source='manual') untouched.
router.post('/sync-products-from-crm', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'agents.sync_products', label: 'Syncing agent products from CRM' });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'agents.sync_products', label: 'Syncing agent products from CRM' });
  updateJob(jobId, { currentStepLabel: 'Walking every imported agent\'s product list…' });
  try {
    const summary = await syncAgentProductsFromCRM();
    completeJob(jobId, summary);
    res.json({ ...summary, jobId });
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// POST /api/agents/:id/heal-rates — bump any rate=0 rows for this agent to
// parent's rate (or product max, for top-level). Idempotent — non-zero rates
// are preserved. Used retroactively to fix branches that were imported before
// the import-time rate cascade existed.
router.post('/:id/heal-rates', async (req, res, next) => {
  try {
    const result = await ensureSensibleRates(req.params.id);
    if (result.error) return res.status(404).json({ error: result.error });
    await audit(req, {
      action: 'agent.rates.heal',
      entity_type: 'user',
      entity_id: req.params.id,
      metadata: { updated: result.updated, checked: result.checked },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/agents/:id/heal-rates/subtree — same as above but cascades to every
// descendant (agent + all sub-agents), top-down so children inherit fresh parent rates.
router.post('/:id/heal-rates/subtree', async (req, res, next) => {
  try {
    const result = await healRatesForSubtree(req.params.id);
    await audit(req, {
      action: 'agent.rates.heal_subtree',
      entity_type: 'user',
      entity_id: req.params.id,
      metadata: { agents: result.agents, updated: result.totalUpdated },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/agents/:id/sync-commission-levels
// Pull commission rates from xdev CRM's /api/agent-commission-levels endpoint
// for one agent. Low CRM load (1-2 calls per agent — skips contact fetch if
// wallet_id already cached). Safe to run at any time; idempotent.
router.post('/:id/sync-commission-levels', async (req, res, next) => {
  try {
    const summary = await syncOneAgentCommissionLevels(req.params.id);
    await audit(req, {
      action: 'commission_levels.sync',
      entity_type: 'user',
      entity_id: req.params.id,
      metadata: summary,
    });
    res.json(summary);
  } catch (err) {
    if (err?.code === 'CRM_PAUSED') {
      return res.status(503).json({ error: 'CRM is paused — resume before syncing' });
    }
    next(err);
  }
});

// POST /api/agents/:id/sync-commission-levels-subtree
// Sync commission rates for ONE agent AND every descendant in their subtree.
// Cheaper than the global bulk sync — only walks the relevant slice. Useful
// when a manager hands an agent's "I lost a product" complaint up the chain
// and the admin wants to fix that whole branch without hitting unrelated
// agents.
//
// Honors `?staleAfterHours=N` (default 24) for the same skip-recent semantics
// as the global bulk endpoint. Pass `?staleAfterHours=0` for force-full.
//
// Fire-and-forget: returns 202 with the planned subtree size so the admin
// can see the intent before the work starts.
router.post('/:id/sync-commission-levels-subtree', async (req, res, next) => {
  try {
    const rootAgentId = req.params.id;
    const staleAfterHours = req.query.staleAfterHours != null
      ? Math.max(0, Number(req.query.staleAfterHours))
      : 24;

    // Walk the subtree to build an explicit list of agent IDs. Filter to
    // active imported agents only — never hit CRM for an agent we won't
    // also be reading from later.
    const { rows: subtree } = await pool.query(
      `WITH RECURSIVE st AS (
         SELECT id, name FROM users
          WHERE id = $1 AND is_agent = true AND is_active = true AND linked_client_id IS NOT NULL
         UNION ALL
         SELECT u.id, u.name
         FROM users u JOIN st s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true AND u.linked_client_id IS NOT NULL
       )
       SELECT id, name FROM st`,
      [rootAgentId]
    );

    if (subtree.length === 0) {
      return res.status(404).json({ error: 'Agent not found or not imported' });
    }

    const agentIds = subtree.map(s => s.id);
    const startedAt = new Date();
    const promise = syncAllCommissionLevels({ agentIds, staleAfterHours });
    promise.then(summary => {
      console.log(`[Admin] Subtree commission-level sync done for ${rootAgentId}:`, {
        scope: subtree.length,
        synced: summary.agents_synced,
        skipped_recent: summary.agents_skipped_recent,
        groups: summary.groups_upserted,
        errors: summary.errors,
      });
    }).catch(err => console.error('[Admin] Subtree commission-level sync failed:', err.message));

    await audit(req, {
      action: 'commission_levels.subtree_sync',
      entity_type: 'user',
      entity_id: rootAgentId,
      metadata: {
        subtree_size: subtree.length,
        staleAfterHours,
        startedAt: startedAt.toISOString(),
      },
    });

    res.status(202).json({
      accepted: true,
      root_agent_id: rootAgentId,
      subtree_size: subtree.length,
      stale_after_hours: staleAfterHours,
      started_at: startedAt.toISOString(),
      note: staleAfterHours > 0
        ? `Syncing ${subtree.length} agent${subtree.length === 1 ? '' : 's'} in this subtree — agents synced in the last ${staleAfterHours}h skipped.`
        : `FORCE-FULL syncing all ${subtree.length} agent${subtree.length === 1 ? '' : 's'} in this subtree.`,
    });
  } catch (err) {
    if (err?.code === 'CRM_PAUSED') {
      return res.status(503).json({ error: 'CRM is paused — resume before syncing' });
    }
    next(err);
  }
});

// POST /api/agents/sync-commission-levels
// BULK: pull commission rates for every imported agent (1-2 CRM calls each).
// For ~706 agents, ~1086 calls on first run → ~4-5 min at 4/s.
//
// Load control via `?staleAfterHours=N`:
//   - default 24: only re-sync agents whose data was synced > 24h ago.
//     Re-clicking the button within a day fires near-zero CRM calls.
//   - 0: force a full re-sync of every agent (use sparingly).
//
// Fire-and-forget: returns 202 immediately; poll /api/agents/commission-levels/status
// or just watch the chip for the commission-levels bucket usage. Accepts
// ?maxAgents=N to limit the scope (useful for per-branch partial runs).
router.post('/sync-commission-levels', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'commission_levels.bulk_sync', label: 'Syncing commission rates from CRM' });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'commission_levels.bulk_sync', label: 'Syncing commission rates from CRM' });
  try {
    const maxAgents = req.query.maxAgents ? Number(req.query.maxAgents) : null;
    const staleAfterHours = req.query.staleAfterHours != null
      ? Math.max(0, Number(req.query.staleAfterHours))
      : 24;
    const startedAt = new Date();
    updateJob(jobId, { currentStepLabel: `Pulling per-agent rate config from xdev (skipping if synced <${staleAfterHours}h)…` });
    const promise = syncAllCommissionLevels({ maxAgents, staleAfterHours });
    promise.then(summary => {
      console.log('[Admin] Bulk commission-level sync done:', {
        agents: summary.agents_synced + '/' + summary.agents_total,
        skipped_recent: summary.agents_skipped_recent,
        configs: summary.configs_upserted,
        groups: summary.groups_upserted,
        errors: summary.errors,
      });
      completeJob(jobId, summary);
    }).catch(err => {
      console.error('[Admin] Bulk commission-level sync failed:', err.message);
      failJob(jobId, err.message);
    });
    await audit(req, {
      action: 'commission_levels.bulk_sync',
      entity_type: 'system',
      entity_id: 'all',
      metadata: { maxAgents, staleAfterHours, startedAt: startedAt.toISOString() },
    });
    res.status(202).json({
      accepted: true,
      jobId,
      started_at: startedAt.toISOString(),
      stale_after_hours: staleAfterHours,
      note: staleAfterHours > 0
        ? `Bulk sync running. Will skip agents synced within last ${staleAfterHours}h to spare CRM. Pass ?staleAfterHours=0 for force-full.`
        : 'FULL re-sync running (staleAfterHours=0). Expect ~5 min for 706 agents at 4/s gate rate.',
    });
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// GET /api/agents/commission-levels?agent_id=X
// Read back the commission levels we've synced for an agent. Zero CRM calls
// — pure local DB read. Used by the Commission Tree UI.
router.get('/commission-levels', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.agent_id) { where.push(`ccl.agent_user_id = $${params.length + 1}`); params.push(req.query.agent_id); }
    if (req.query.product_id) { where.push(`ccl.product_id = $${params.length + 1}`); params.push(req.query.product_id); }
    const whereSQL = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT ccl.*, p.name AS product_name, u.name AS agent_name
       FROM crm_commission_levels ccl
       JOIN products p ON p.id = ccl.product_id
       JOIN users u ON u.id = ccl.agent_user_id
       ${whereSQL}
       ORDER BY u.name, p.name, ccl.mt5_group_name`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/agents/crm-raw/product-sample — fetch 1 product raw from xdev CRM
// for inspection. One gate-throttled call (bucket: products). Used to verify
// what fields CRM actually exposes on product payloads (e.g., commission /
// rate / rebate config that we may or may not be pulling today).
router.get('/crm-raw/product-sample', async (req, res, next) => {
  try {
    const { crmRequest } = await import('../services/crmGate.js');
    const data = await crmRequest('/api/products?page=1&pageSize=1');
    const products = Array.isArray(data?.products) ? data.products : [];
    res.json({
      fetched: products.length,
      // Return the whole first product verbatim so admin can see every field
      raw_product: products[0] || null,
      // Also return the keys present at the top level + inside nested agents[]
      top_level_keys: products[0] ? Object.keys(products[0]) : [],
      agent_link_keys: products[0]?.agents?.[0]
        ? Object.keys(typeof products[0].agents[0] === 'object' ? products[0].agents[0] : {})
        : [],
    });
  } catch (err) { next(err); }
});

// GET /api/agents/mt5-groups — list current mt5_group → product mappings
// + any unmapped groups we've seen in trading_accounts_meta. Admin UI uses
// this to show/edit the mapping table.
router.get('/mt5-groups', async (req, res, next) => {
  try {
    const { rows: mappings } = await pool.query(
      `SELECT g.group_name, g.product_id, g.source, g.is_active, g.updated_at,
              p.name AS product_name, p.code AS product_code
       FROM mt5_groups g
       LEFT JOIN products p ON p.id = g.product_id
       ORDER BY g.group_name`
    );
    const { rows: unmapped } = await pool.query(
      `SELECT tam.mt5_group AS group_name, COUNT(*)::int AS login_count
       FROM trading_accounts_meta tam
       WHERE tam.mt5_group IS NOT NULL
         AND tam.mt5_group NOT IN (SELECT group_name FROM mt5_groups WHERE is_active = true)
       GROUP BY tam.mt5_group
       ORDER BY login_count DESC`
    );
    res.json({ mappings, unmapped });
  } catch (err) { next(err); }
});

// POST /api/agents/mt5-groups — manually add / update a group → product mapping
router.post('/mt5-groups', async (req, res, next) => {
  try {
    const { group_name, product_id, is_active = true } = req.body || {};
    if (!group_name || !product_id) {
      return res.status(400).json({ error: 'group_name and product_id required' });
    }
    await pool.query(
      `INSERT INTO mt5_groups (group_name, product_id, source, is_active)
       VALUES ($1, $2, 'manual', $3)
       ON CONFLICT (group_name) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         source = 'manual',
         is_active = EXCLUDED.is_active,
         updated_at = NOW()`,
      [group_name, product_id, is_active]
    );
    await audit(req, {
      action: 'mt5_group.mapping.set',
      entity_type: 'mt5_group',
      entity_id: group_name,
      metadata: { product_id, is_active },
    });
    res.json({ ok: true, group_name, product_id });
  } catch (err) { next(err); }
});

// POST /api/agents/mt5-groups/seed — auto-bootstrap the mt5_groups table by
// correlating existing trading_accounts_meta rows (which have product_source_id
// from CRM) with live MT5 bridge /accounts calls (which return the group).
// One bridge call per unmapped product (~80 calls). Zero xdev CRM calls.
router.post('/mt5-groups/seed', async (req, res, next) => {
  try {
    const summary = await seedMt5Groups();
    await audit(req, {
      action: 'mt5_group.seed',
      entity_type: 'system',
      entity_id: 'mt5_groups',
      metadata: {
        groups_created: summary.groups_created,
        bridge_calls: summary.bridge_calls,
      },
    });
    res.json(summary);
  } catch (err) { next(err); }
});

// POST /api/agents/:id/sync-mt5-snapshot — trigger MT5 snapshot sync for the
// agent's subtree. Fetches deal history from the MT5 bridge for every login
// in the subtree (skipping logins already synced within maxAgeMinutes). All
// calls go through the MT5 bridge gate (rate-limit + concurrency + kill
// switch + 10s cache) — zero xdev CRM calls.
//
// Use this when commission history is empty for an agent and you want to
// populate the deal cache without waiting for the scheduled engine cycle.
router.post('/:id/sync-mt5-snapshot', async (req, res, next) => {
  try {
    const maxAgeMinutes = Number(req.query.maxAgeMinutes) || 60;
    // Default: chain an engine cycle AFTER the MT5 sync completes, so the
    // admin gets commission rows without a separate click/wait. Can be
    // disabled with `?runEngine=false` if you only want to populate the cache.
    const runEngine = String(req.query.runEngine || 'true').toLowerCase() !== 'false';

    const startedAt = new Date();

    // Fire-and-forget the chained work. Returns 202 immediately; the sync +
    // engine run each finish independently. Admin can watch Reconciliation
    // diagnostics (or the Commission History page) for the result.
    const promise = (async () => {
      const snapshot = await syncMt5ForAgent(req.params.id, { maxAgeMinutes });
      console.log(`[Admin] MT5 snapshot sync for ${req.params.id}: ${snapshot.logins_synced}/${snapshot.logins_scanned} synced, ${snapshot.logins_failed} failed`);
      if (runEngine) {
        // Don't await inside the outer promise chain — runCommissionSync
        // takes ~30-90s and we want the snapshot summary logged first.
        await runCommissionSync({ triggeredBy: 'admin-ui-sync' })
          .then(c => console.log(`[Admin] Engine cycle after MT5 sync: ${c.rowsInserted} rows inserted`))
          .catch(err => console.error(`[Admin] Engine cycle after MT5 sync failed:`, err.message));
      }
    })();
    promise.catch(err => console.error(`[Admin] MT5 snapshot sync chain for ${req.params.id} failed:`, err.message));

    await audit(req, {
      action: 'agent.mt5_snapshot.sync',
      entity_type: 'user',
      entity_id: req.params.id,
      metadata: { maxAgeMinutes, runEngine, startedAt: startedAt.toISOString() },
    });
    res.status(202).json({
      accepted: true,
      agent_id: req.params.id,
      started_at: startedAt.toISOString(),
      engine_chained: runEngine,
      note: runEngine
        ? 'Two steps running in background: (1) MT5 bridge sync fetches deal history, (2) commission engine cycle computes rows. No xdev CRM calls. Refresh Commission History in ~60-120 seconds to see results.'
        : 'MT5 bridge sync running. Engine cycle NOT chained — trigger manually or wait for the scheduled 15-min cycle.',
    });
  } catch (err) { next(err); }
});

// POST /api/agents/branch/:name/heal-rates — bulk-heal every imported agent in
// one branch. Processes root-down so children inherit parents' freshly-set
// rates in a single pass. Use this to repair Paul Matar / any branch whose
// agents were imported before the rate cascade landed in the import flow.
router.post('/branch/:name/heal-rates', async (req, res, next) => {
  try {
    const branchName = decodeURIComponent(req.params.name);
    const result = await healRatesForBranch(branchName);
    await audit(req, {
      action: 'agent.rates.heal_branch',
      entity_type: 'branch',
      entity_id: branchName,
      metadata: { agents: result.agents, updated: result.totalUpdated },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/agents/fix-all-imported — ONE-CLICK end-to-end fix for every
// already-imported agent. Wires up the full pipeline admins would otherwise
// click through individually:
//
//   1. syncAgentProductsFromCRM — make sure every agent has their CRM product
//      links in agent_products (at rate=0; heal-rates will bump them next)
//   2. Heal rates for every branch (top-down) — bumps 0 to parent's rate or
//      product max, so the engine can actually allocate
//   3. Rebuild commissions — DELETE all rows + re-run the engine so history
//      picks up the freshly-set rates and any newly-synced MT5 deals
//
// Trading-accounts (MT5 login) sync is NOT bundled here because it's slow
// (~1.5s per client × thousands of clients) and has its own dedicated
// endpoint per-branch. Admins should run that separately if needed. That
// said, the rebuild still benefits: any client that got MT5 logins since
// last rebuild will produce rows on this pass.
router.post('/fix-all-imported', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'agents.fix_all', label: 'Fix all imported (rates + rebuild)', totalSteps: 3 });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'agents.fix_all', label: 'Fix all imported (rates + rebuild)', totalSteps: 3 });
  const startedAt = new Date();
  const summary = { startedAt: startedAt.toISOString(), steps: [] };

  try {
    // Step 1 — ensure every imported agent has their CRM product links
    updateJob(jobId, { step: 1, currentStepLabel: 'Step 1/3 — Syncing agent product links from CRM…' });
    const t1 = Date.now();
    const productSync = await syncAgentProductsFromCRM();
    summary.steps.push({
      step: 'sync_agent_products',
      ms: Date.now() - t1,
      created: productSync.created,
      preserved: productSync.preserved,
      skippedMissingProduct: productSync.skippedMissingProduct,
      errors: productSync.errors,
    });

    // Step 2 — heal rates across every branch (top-down)
    updateJob(jobId, { step: 2, currentStepLabel: 'Step 2/3 — Healing rates per branch (top-down)…' });
    const { rows: branches } = await pool.query(
      `SELECT DISTINCT COALESCE(c.branch, '(no branch)') AS branch
       FROM users u
       LEFT JOIN clients c ON c.id = u.linked_client_id
       WHERE u.is_agent = true AND u.linked_client_id IS NOT NULL`
    );
    let totalChecked = 0, totalUpdated = 0, agentsTouched = 0;
    const perBranch = [];
    let bIdx = 0;
    for (const b of branches) {
      bIdx++;
      updateJob(jobId, { step: 2, currentStepLabel: `Step 2/3 — Healing rates · branch ${bIdx}/${branches.length} (${b.branch})…` });
      const bResult = await healRatesForBranch(b.branch === '(no branch)' ? null : b.branch);
      totalChecked += bResult.totalChecked;
      totalUpdated += bResult.totalUpdated;
      agentsTouched += bResult.agents;
      perBranch.push({ branch: b.branch, agents: bResult.agents, updated: bResult.totalUpdated });
    }
    summary.steps.push({
      step: 'heal_rates',
      branches: branches.length,
      agents: agentsTouched,
      checked: totalChecked,
      updated: totalUpdated,
      perBranch,
    });

    // Step 3 — trigger the commission rebuild (async, fire-and-forget)
    updateJob(jobId, { step: 3, currentStepLabel: 'Step 3/3 — Rebuilding commissions in background…' });
    await pool.query('DELETE FROM commissions');
    const cyclePromise = runCommissionSync({ triggeredBy: 'recovery', triggeredByUser: req.user.id })
      .catch(err => console.error('[fix-all-imported] rebuild error:', err.message));
    summary.steps.push({ step: 'commission_rebuild', status: 'running_async' });

    await audit(req, {
      action: 'agent.fix_all_imported',
      entity_type: 'system',
      entity_id: 'all',
      metadata: { agentsTouched, ratesUpdated: totalUpdated, productLinksCreated: productSync.created },
    });

    summary.finishedAt = new Date().toISOString();
    summary.totalMs = Date.now() - startedAt.getTime();
    summary.jobId = jobId;
    completeJob(jobId, { agentsTouched, ratesUpdated: totalUpdated, productLinksCreated: productSync.created });
    res.status(202).json(summary);
    cyclePromise; // keep lint happy
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// POST /api/agents/sync-branches-from-crm — pull all 18 branches from x-dev's
// /api/branches endpoint (with code/location/gateway metadata) and upsert into
// Supabase branches table. Adopts existing freeform name matches idempotently.
router.post('/sync-branches-from-crm', async (req, res, next) => {
  try {
    const summary = await syncBranchesFromCRM();
    res.json(summary);
  } catch (err) { next(err); }
});

// POST /api/agents/backfill-parents — one-shot repair for the ~1,003 agent
// rows that have missing referred_by_agent_id due to an old sync guard. Also
// rewires users.parent_agent_id for imported portal agents once the clients
// table is correct. Idempotent — running again just re-verifies.
router.post('/backfill-parents', async (req, res, next) => {
  const jobId = req.headers['x-job-id'] || createJob({ type: 'agents.backfill_parents', label: 'Backfill agent parent links from CRM' });
  if (req.headers['x-job-id']) updateJob(jobId, { type: 'agents.backfill_parents', label: 'Backfill agent parent links from CRM' });
  updateJob(jobId, { currentStepLabel: 'Walking agents with NULL referred_by_agent_id…' });
  try {
    const { agentIds, clientIds, maxPerCall } = req.body || {};
    const summary = await backfillAgentParents({
      agentIds: Array.isArray(agentIds) && agentIds.length > 0 ? agentIds : null,
      clientIds: Array.isArray(clientIds) && clientIds.length > 0 ? clientIds : null,
      maxPerCall: maxPerCall || 300,
    });
    completeJob(jobId, summary);
    res.json({ ...summary, jobId });
  } catch (err) {
    failJob(jobId, err.message);
    next(err);
  }
});

// GET /api/agents/:id/crm-products — show what products this agent holds.
// Default: reads local mirror (products + agent_products) — zero CRM calls.
// ?refresh=true: forces a live CRM scan (pages the full product catalog).
// Use refresh=true sparingly; normal page loads should use the default.
router.get('/:id/crm-products', async (req, res, next) => {
  try {
    const refresh = String(req.query.refresh).toLowerCase() === 'true';
    const payload = await listCrmProductsForAgent(req.params.id, { refresh });
    if (!payload) return res.status(404).json({ error: 'Agent not found or not imported' });
    res.json(payload);
  } catch (err) { next(err); }
});

// GET /api/agents/branches-with-counts — dropdown feed for the Hierarchy filter.
// Returns every branch that has at least one imported portal agent, plus its
// agent + client totals. Sorted by agent count desc so popular branches top.
router.get('/branches-with-counts', cacheMw({ ttl: 120 }), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(c.branch, '(no branch)') AS branch,
              COUNT(*)::int AS agent_count,
              SUM((SELECT COUNT(*)::int FROM clients cl WHERE cl.agent_id = u.id))::int AS client_count,
              MAX(b.code) AS code,
              MAX(b.location) AS location,
              BOOL_OR(COALESCE(b.is_active, true)) AS branch_is_active
       FROM users u
       JOIN clients c ON c.id = u.linked_client_id
       LEFT JOIN branches b ON b.name = c.branch
       WHERE u.is_agent = true AND u.linked_client_id IS NOT NULL
       GROUP BY c.branch
       ORDER BY agent_count DESC, branch`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/agents/hierarchy — nested tree of imported agents with products
// embedded. Accepts `?branch=<name>` to filter top-level roots to just that
// branch; children are always included regardless of their own branch (so a
// cross-branch parent→child still renders under its parent). Only includes users that were imported via the CRM bridge
// (linked_client_id IS NOT NULL). One query for the agents, one for the
// product links; tree is assembled in JS to avoid recursive SQL in the hot
// path. Sorted by direct_clients_count desc so top earners float up.
router.get('/hierarchy', cacheMw({ ttl: 60 }), async (req, res, next) => {
  try {
    const branchFilter = req.query.branch ? String(req.query.branch) : null;
    const [{ rows: agents }, { rows: links }] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.parent_agent_id, u.is_active,
                c.branch, c.country, c.phone, u.linked_client_id,
                (SELECT COUNT(*)::int FROM clients cl WHERE cl.agent_id = u.id) AS direct_clients_count,
                (SELECT COUNT(*)::int FROM users sub
                   WHERE sub.parent_agent_id = u.id AND sub.is_agent = true) AS direct_sub_count
         FROM users u
         LEFT JOIN clients c ON c.id = u.linked_client_id
         WHERE u.is_agent = true AND u.linked_client_id IS NOT NULL
         ORDER BY direct_clients_count DESC, u.name`
      ),
      pool.query(
        `SELECT ap.agent_id, ap.product_id, ap.rate_per_lot, ap.source,
                ap.is_active AS link_active,
                p.name AS product_name, p.code, p.product_group, p.currency,
                p.max_rate_per_lot, p.is_active AS product_active,
                -- Broker per-lot charge (for deriving effective rate from CRM pct+rebate)
                p.commission_per_lot AS broker_commission_per_lot
         FROM agent_products ap
         JOIN products p ON p.id = ap.product_id
         WHERE ap.is_active = true
         ORDER BY p.name`
      ),
    ]);

    // Pull CRM commission levels (from xdev CRM — authoritative when present).
    // We pick the "best" row per (agent, product) favoring rows with real
    // non-zero values over any "product-level fallback" zeros.
    const { rows: crmLevels } = await pool.query(
      `SELECT DISTINCT ON (agent_user_id, product_id)
              agent_user_id AS agent_id, product_id,
              commission_percentage, commission_per_lot,
              override_commission_percentage, override_commission_per_lot,
              mt5_group_name, synced_at
       FROM crm_commission_levels
       WHERE is_active = true
       ORDER BY agent_user_id, product_id,
                (commission_percentage > 0 OR commission_per_lot > 0) DESC,
                synced_at DESC`
    );
    const crmByAgentProduct = new Map();
    for (const cl of crmLevels) {
      crmByAgentProduct.set(`${cl.agent_id}:${cl.product_id}`, {
        commission_percentage: Number(cl.commission_percentage),
        commission_per_lot:    Number(cl.commission_per_lot),
        override_commission_percentage: cl.override_commission_percentage != null ? Number(cl.override_commission_percentage) : null,
        override_commission_per_lot:    cl.override_commission_per_lot    != null ? Number(cl.override_commission_per_lot)    : null,
        mt5_group_name: cl.mt5_group_name,
        synced_at: cl.synced_at,
      });
    }

    // Group products by agent_id, attaching CRM level data when we have it.
    const productsByAgent = new Map();
    for (const l of links) {
      const brokerPerLot = Number(l.broker_commission_per_lot || 0);
      const crmLevel = crmByAgentProduct.get(`${l.agent_id}:${l.product_id}`) || null;

      // If CRM has an override, it wins. Else use the synced CRM value.
      let effectivePct = null, effectivePerLot = null, effectiveRatePerLot = null;
      if (crmLevel) {
        effectivePct = crmLevel.override_commission_percentage != null
          ? crmLevel.override_commission_percentage
          : crmLevel.commission_percentage;
        effectivePerLot = crmLevel.override_commission_per_lot != null
          ? crmLevel.override_commission_per_lot
          : crmLevel.commission_per_lot;
        // Effective $/lot = (commission_percentage% of product base) + fixed rebate per lot
        // e.g. "PM Plus 10" base=$10: agent with 20%+$10 → 20%×$10 + $10 = $12/lot
        effectiveRatePerLot = Number((effectivePct * brokerPerLot / 100 + effectivePerLot).toFixed(4));
      }

      const arr = productsByAgent.get(l.agent_id) || [];
      arr.push({
        product_id: l.product_id,
        name: l.product_name,
        code: l.code,
        group: l.product_group,
        currency: l.currency,
        // Legacy single-rate value (still the source of truth for non-synced branches)
        rate_per_lot: Number(l.rate_per_lot),
        source: l.source,
        max_rate_per_lot: Number(l.max_rate_per_lot),
        product_active: l.product_active,
        // New CRM-sourced data — present when the agent's commission levels
        // have been synced. UI should prefer these over rate_per_lot when set.
        broker_commission_per_lot: brokerPerLot,
        crm_level: crmLevel,
        effective_pct:            effectivePct,
        effective_per_lot:        effectivePerLot,
        effective_rate_per_lot:   effectiveRatePerLot,
        has_crm_config:           !!crmLevel,
      });
      productsByAgent.set(l.agent_id, arr);
    }

    // Build id → node map, then stitch parent → children
    const byId = new Map();
    for (const a of agents) {
      byId.set(a.id, {
        ...a,
        products: productsByAgent.get(a.id) || [],
        children: [],
      });
    }
    const roots = [];
    for (const a of agents) {
      const node = byId.get(a.id);
      if (a.parent_agent_id && byId.has(a.parent_agent_id)) {
        byId.get(a.parent_agent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }

    // Apply branch filter to roots only. Children stay regardless so a parent
    // in "Main" keeps showing sub-agents in, say, "Ghazale" under them.
    const filteredRoots = branchFilter
      ? roots.filter(r => (r.branch || '') === branchFilter)
      : roots;

    // Compute subtree aggregates so a collapsed parent can still show totals
    function tally(node) {
      let subtreeProducts = node.products.length;
      let subtreeSubAgents = node.children.length;
      for (const c of node.children) {
        const r = tally(c);
        subtreeProducts += r.subtreeProducts;
        subtreeSubAgents += r.subtreeSubAgents;
      }
      node.subtree_product_count = subtreeProducts;
      node.subtree_sub_count = subtreeSubAgents;
      return { subtreeProducts, subtreeSubAgents };
    }
    roots.forEach(tally);

    res.json({
      roots: filteredRoots,
      total_agents: agents.length,
      total_roots: filteredRoots.length,
      total_roots_unfiltered: roots.length,
      total_links: links.length,
      branch_filter: branchFilter,
    });
  } catch (err) { next(err); }
});

// GET /api/agents — list all agents with parent name + direct counts + linked-product count
router.get('/', cacheMw({ ttl: 60 }), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_active, u.parent_agent_id, u.created_at,
              p.name AS parent_name,
              (SELECT COUNT(*)::int FROM users c
                 WHERE c.parent_agent_id = u.id AND c.is_agent = true AND c.is_active = true)
                AS direct_sub_count,
              (SELECT COUNT(*)::int FROM clients cl WHERE cl.agent_id = u.id)
                AS direct_clients_count,
              (SELECT COUNT(*)::int FROM agent_products ap
                 WHERE ap.agent_id = u.id AND ap.is_active = true)
                AS product_count
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_agent_id
       WHERE u.is_agent = true
       ORDER BY (u.parent_agent_id IS NOT NULL), u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/agents/:id — detail
// Adds breakdown of the agent's downline by contact_type so the UI can show
// "X individuals + Y sub-agents" without a second round-trip.
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [agent] } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_agent, u.is_active,
              u.parent_agent_id, u.created_at, u.linked_client_id,
              p.name AS parent_name, p.email AS parent_email
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_agent_id
       WHERE u.id = $1 AND u.is_agent = true`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const [{ rows: products }, { rows: children }, { rows: counts }] = await Promise.all([
      pool.query(
        `SELECT ap.product_id, p.name AS product_name, p.currency,
                p.max_rate_per_lot, ap.rate_per_lot, ap.granted_by, ap.is_active,
                g.name AS granted_by_name, ap.created_at, ap.updated_at
         FROM agent_products ap
         JOIN products p ON p.id = ap.product_id
         LEFT JOIN users g ON g.id = ap.granted_by
         WHERE ap.agent_id = $1
         ORDER BY p.name`,
        [req.params.id]
      ),
      pool.query(
        `SELECT id, name, email, is_active FROM users
         WHERE parent_agent_id = $1 AND is_agent = true
         ORDER BY name`,
        [req.params.id]
      ),
      // Downline breakdown uses clients.referred_by_agent_id (CRM linkage),
      // NOT users.parent_agent_id (portal linkage). referred_by_agent_id
      // references the AGENT'S client row, which we find via linked_client_id.
      //
      // Individuals are split into 'client' (KYC-complete) vs 'lead'
      // (unverified) via crm_profile_type, mirroring x-dev's CRM.
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE c.contact_type = 'individual' AND c.crm_profile_type = 'client')::int AS clients_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'individual' AND c.crm_profile_type = 'lead')::int   AS leads_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'individual')::int                                   AS individuals_count,
           COUNT(*) FILTER (WHERE c.contact_type = 'agent')::int                                        AS subagents_count,
           COUNT(*)::int AS total_downline
         FROM clients c
         WHERE c.referred_by_agent_id = $1`,
        [agent.linked_client_id]
      ),
    ]);

    res.json({
      ...agent,
      products,
      direct_sub_agents: children,
      direct_clients_count: counts[0].individuals_count,  // kept for backward compat
      clients_count: counts[0].clients_count,
      leads_count: counts[0].leads_count,
      individuals_count: counts[0].individuals_count,
      subagents_count: counts[0].subagents_count,
      total_downline: counts[0].total_downline,
    });
  } catch (err) { next(err); }
});

// GET /api/agents/:id/downline?type=individuals|agents&page=&pageSize=&q=
//
// Returns a paginated slice of this agent's CRM-referred downline.
// Rows come from the `clients` table (which is where both individuals and
// sub-agents live), filtered by referred_by_agent_id = agent.linked_client_id.
//
// For sub-agents, each row is enriched with the portal import state
// (portal_user_id + is_agent) so the admin can tell who still needs importing.
router.get('/:id/downline', async (req, res, next) => {
  try {
    const { rows: [agent] } = await pool.query(
      'SELECT id, linked_client_id FROM users WHERE id = $1 AND is_agent = true',
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.linked_client_id) return res.status(400).json({ error: 'Agent has no linked client id (not imported from CRM)' });

    const type = (req.query.type || 'individuals').toLowerCase();
    if (type !== 'individuals' && type !== 'agents') {
      return res.status(400).json({ error: "type must be 'individuals' or 'agents'" });
    }
    const contactType = type === 'individuals' ? 'individual' : 'agent';

    const q = req.query.q ? String(req.query.q).trim() : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const where = ['c.referred_by_agent_id = $1', 'c.contact_type = $2'];
    const params = [agent.linked_client_id, contactType];
    let i = 3;
    if (q) {
      where.push(`(LOWER(c.name) LIKE $${i} OR LOWER(c.email) LIKE $${i} OR c.phone LIKE $${i})`);
      params.push(`%${q.toLowerCase()}%`);
      i++;
    }
    const whereSQL = where.join(' AND ');

    if (contactType === 'individual') {
      const [{ rows: items }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT c.id, c.name, c.email, c.phone, c.country, c.branch,
                  c.pipeline_stage, c.is_verified, c.is_trader,
                  COALESCE(array_length(c.mt5_logins, 1), 0) AS mt5_login_count,
                  c.first_deposit_at, c.registration_date, c.updated_at
           FROM clients c
           WHERE ${whereSQL}
           ORDER BY
             CASE c.pipeline_stage
               WHEN 'Active'    THEN 1
               WHEN 'Funded'    THEN 2
               WHEN 'Contacted' THEN 3
               WHEN 'Lead'      THEN 4
               WHEN 'Churned'   THEN 5
               ELSE 6 END,
             c.updated_at DESC
           LIMIT $${i} OFFSET $${i + 1}`,
          [...params, pageSize, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS c FROM clients c WHERE ${whereSQL}`, params),
      ]);
      return res.json({ items, pagination: { page, pageSize, total: countRows[0].c } });
    }

    // type = agents → sub-agents. Enrich with portal import state.
    // their_individuals is split into their_clients (KYC verified, crm_profile_type=client)
    // and their_leads (unverified, crm_profile_type=lead) so the UI can show both.
    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.email, c.phone, c.country, c.branch,
                c.pipeline_stage, c.updated_at,
                COALESCE(array_length(c.mt5_logins, 1), 0) AS mt5_login_count,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id) AS their_downline_count,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual') AS their_individuals,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual' AND x.crm_profile_type = 'client') AS their_clients,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual' AND x.crm_profile_type = 'lead')   AS their_leads,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'agent') AS their_subagents,
                u.id AS portal_user_id, u.is_agent AS is_in_portal, u.is_active AS portal_active
         FROM clients c
         LEFT JOIN users u ON u.linked_client_id = c.id
         WHERE ${whereSQL}
         ORDER BY their_downline_count DESC, c.name
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS c FROM clients c WHERE ${whereSQL}`, params),
    ]);

    // Populate products per sub-agent — two parallel sources:
    //   (a) portal's agent_products (for imported sub-agents; carries the rate)
    //   (b) CRM's product.agents[] scan (for EVERYONE, whether imported or not)
    //
    // Non-imported sub-agents still have real CRM products — they just don't
    // have agent_products rows yet. We surface them with source='crm-only'.
    const importedUserIds = items.map(r => r.portal_user_id).filter(Boolean);
    const portalProductsByUser = new Map();
    if (importedUserIds.length > 0) {
      const { rows: prods } = await pool.query(
        `SELECT ap.agent_id, ap.product_id, ap.rate_per_lot, ap.source,
                p.name AS product_name, p.code, p.product_group,
                p.currency, p.max_rate_per_lot
         FROM agent_products ap
         JOIN products p ON p.id = ap.product_id
         WHERE ap.agent_id = ANY($1) AND ap.is_active = true
         ORDER BY p.name`,
        [importedUserIds]
      );
      for (const p of prods) {
        const arr = portalProductsByUser.get(p.agent_id) || [];
        arr.push({
          product_id: p.product_id,
          name: p.product_name,
          code: p.code,
          group: p.product_group,
          currency: p.currency,
          rate_per_lot: Number(p.rate_per_lot),
          source: p.source,
          max_rate_per_lot: Number(p.max_rate_per_lot),
          in_portal: true,
        });
        portalProductsByUser.set(p.agent_id, arr);
      }
    }

    // CRM scan keyed by client_id. Do it once for the whole response.
    let crmProductsByClient = new Map();
    try {
      const scan = await scanCrmAgentProducts();
      crmProductsByClient = scan.byAgent;
    } catch (scanErr) {
      console.error('[downline] CRM product scan failed:', scanErr.message);
    }

    for (const r of items) {
      const crmRows = crmProductsByClient.get(r.id) || [];
      if (r.portal_user_id) {
        // Imported — trust agent_products (they carry the rate + portal source)
        r.products = portalProductsByUser.get(r.portal_user_id) || [];
        // Advisory: flag any CRM-only products that haven't made it into
        // agent_products yet (e.g., product not imported locally)
        const portalSourceIds = new Set(
          (r.products || []).map(p => p.product_id)
        );
        r.crm_only_products = crmRows
          .filter(cp => !(cp && portalSourceIds.size > 0 && cp.source_id))
          .map(cp => ({
            name: cp.name, code: cp.code, group: cp.group,
            status: cp.status, source: 'crm-only',
          }));
      } else {
        // Not imported — surface products straight from the CRM scan
        r.products = crmRows.map(cp => ({
          name: cp.name,
          code: cp.code,
          group: cp.group,
          status: cp.status,
          source: 'crm-only',
          rate_per_lot: null,
          in_portal: false,
        }));
      }
    }

    res.json({ items, pagination: { page, pageSize, total: countRows[0].c } });
  } catch (err) { next(err); }
});

// GET /api/agents/by-client/:clientId/downline?type=...
// Same shape as /api/agents/:userId/downline but keyed by client_id. Used by
// the tree-expand action on non-imported sub-agents (they don't have a portal
// user row yet, but we still want to walk their CRM-side downline).
router.get('/by-client/:clientId/downline', async (req, res, next) => {
  try {
    const clientId = req.params.clientId;
    const type = (req.query.type || 'agents').toLowerCase();
    if (type !== 'individuals' && type !== 'agents') {
      return res.status(400).json({ error: "type must be 'individuals' or 'agents'" });
    }
    const contactType = type === 'individuals' ? 'individual' : 'agent';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    if (contactType === 'individual') {
      const [{ rows: items }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT c.id, c.name, c.email, c.phone, c.country, c.branch,
                  c.pipeline_stage, c.crm_profile_type, c.is_verified, c.is_trader,
                  COALESCE(array_length(c.mt5_logins, 1), 0) AS mt5_login_count,
                  c.first_deposit_at, c.updated_at
           FROM clients c
           WHERE c.referred_by_agent_id = $1 AND c.contact_type = 'individual'
           ORDER BY
             CASE c.pipeline_stage
               WHEN 'Active'    THEN 1 WHEN 'Funded' THEN 2
               WHEN 'Contacted' THEN 3 WHEN 'Lead'   THEN 4
               WHEN 'Churned'   THEN 5 ELSE 6 END,
             c.updated_at DESC
           LIMIT $2 OFFSET $3`,
          [clientId, pageSize, offset]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM clients WHERE referred_by_agent_id = $1 AND contact_type = 'individual'`,
          [clientId]
        ),
      ]);
      return res.json({ items, pagination: { page, pageSize, total: countRows[0].c } });
    }

    // Sub-agents — same enrichment as the user-keyed /downline endpoint
    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.email, c.phone, c.country, c.branch,
                c.pipeline_stage, c.updated_at,
                COALESCE(array_length(c.mt5_logins, 1), 0) AS mt5_login_count,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id) AS their_downline_count,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual') AS their_individuals,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual' AND x.crm_profile_type = 'client') AS their_clients,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'individual' AND x.crm_profile_type = 'lead')   AS their_leads,
                (SELECT COUNT(*)::int FROM clients x WHERE x.referred_by_agent_id = c.id AND x.contact_type = 'agent') AS their_subagents,
                u.id AS portal_user_id, u.is_agent AS is_in_portal
         FROM clients c
         LEFT JOIN users u ON u.linked_client_id = c.id
         WHERE c.referred_by_agent_id = $1 AND c.contact_type = 'agent'
         ORDER BY their_downline_count DESC, c.name
         LIMIT $2 OFFSET $3`,
        [clientId, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM clients WHERE referred_by_agent_id = $1 AND contact_type = 'agent'`,
        [clientId]
      ),
    ]);

    // Enrich sub-agent rows with products (same approach as the user-keyed endpoint)
    const importedUserIds = items.map(r => r.portal_user_id).filter(Boolean);
    const portalProductsByUser = new Map();
    if (importedUserIds.length > 0) {
      const { rows: prods } = await pool.query(
        `SELECT ap.agent_id, ap.product_id, ap.rate_per_lot, ap.source,
                p.name AS product_name, p.code, p.product_group, p.currency, p.max_rate_per_lot
         FROM agent_products ap JOIN products p ON p.id = ap.product_id
         WHERE ap.agent_id = ANY($1) AND ap.is_active = true`,
        [importedUserIds]
      );
      for (const p of prods) {
        const arr = portalProductsByUser.get(p.agent_id) || [];
        arr.push({
          product_id: p.product_id, name: p.product_name, code: p.code, group: p.product_group,
          currency: p.currency, rate_per_lot: Number(p.rate_per_lot), source: p.source,
          max_rate_per_lot: Number(p.max_rate_per_lot), in_portal: true,
        });
        portalProductsByUser.set(p.agent_id, arr);
      }
    }
    let crmProductsByClient = new Map();
    try {
      const scan = await scanCrmAgentProducts();
      crmProductsByClient = scan.byAgent;
    } catch { /* non-fatal */ }
    for (const r of items) {
      if (r.portal_user_id) {
        r.products = portalProductsByUser.get(r.portal_user_id) || [];
      } else {
        r.products = (crmProductsByClient.get(r.id) || []).map(cp => ({
          name: cp.name, code: cp.code, group: cp.group, status: cp.status,
          source: 'crm-only', rate_per_lot: null, in_portal: false,
        }));
      }
    }

    res.json({ items, pagination: { page, pageSize, total: countRows[0].c } });
  } catch (err) { next(err); }
});

// GET /api/agents/:id/trading-accounts?page=&pageSize=&q=
//
// Lists every MT5 login across this agent's direct client book. Each row
// returns the client identity + the specific login (a client may have multiple).
// Balance / equity are NOT fetched live here — the UI calls /api/mt5/accounts/:login
// on demand so one admin click doesn't trigger hundreds of bridge calls.
router.get('/:id/trading-accounts', async (req, res, next) => {
  try {
    const { rows: [agent] } = await pool.query(
      'SELECT id, linked_client_id FROM users WHERE id = $1 AND is_agent = true',
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.linked_client_id) return res.status(400).json({ error: 'Agent has no linked client id' });

    const q = req.query.q ? String(req.query.q).trim() : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    // Flatten mt5_logins array into one row per (client, login) pair.
    // UNNEST preserves ordering and skips clients without logins automatically.
    const where = [
      `c.referred_by_agent_id = $1`,
      `c.contact_type = 'individual'`,
      `c.mt5_logins IS NOT NULL`,
      `array_length(c.mt5_logins, 1) > 0`,
    ];
    const params = [agent.linked_client_id];
    let i = 2;
    if (q) {
      where.push(`(LOWER(c.name) LIKE $${i} OR LOWER(c.email) LIKE $${i} OR UNNEST_LOGIN LIKE $${i})`.replace(
        'UNNEST_LOGIN', 'ta.login'
      ));
      params.push(`%${q.toLowerCase()}%`);
      i++;
    }
    const whereSQL = where.join(' AND ');

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT c.id AS client_id, c.name AS client_name, c.email, c.country,
                c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                ta.login AS mt5_login, ta.login_ordinal
         FROM clients c,
              LATERAL (SELECT UNNEST(c.mt5_logins) AS login, generate_subscripts(c.mt5_logins, 1) AS login_ordinal) ta
         WHERE ${whereSQL}
         ORDER BY c.first_deposit_at DESC NULLS LAST, c.name, ta.login_ordinal
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM clients c, LATERAL UNNEST(c.mt5_logins) AS login
         WHERE ${whereSQL.replace(/ta\.login/g, 'login')}`,
        params
      ),
    ]);

    res.json({ items, pagination: { page, pageSize, total: countRows[0].c } });
  } catch (err) { next(err); }
});

// POST /api/agents/:id/promote — promote user → agent; optional parent + initial products
router.post('/:id/promote', async (req, res, next) => {
  const dbClient = await pool.connect();
  try {
    const { parent_agent_id, products: initialProducts = [] } = req.body;

    await dbClient.query('BEGIN');

    // Validate user exists and is not already an agent
    const { rows: [user] } = await dbClient.query(
      'SELECT id, is_agent, is_active FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!user) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.is_agent) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ error: 'User is already an agent' });
    }

    // Validate parent (must be existing active agent)
    if (parent_agent_id) {
      const { rows: [parent] } = await dbClient.query(
        'SELECT is_agent, is_active FROM users WHERE id = $1',
        [parent_agent_id]
      );
      if (!parent || !parent.is_agent || !parent.is_active) {
        await dbClient.query('ROLLBACK');
        return res.status(400).json({ error: 'parent_agent_id must reference an existing active agent' });
      }
    }

    // Resolve 'agent' role id
    const { rows: [role] } = await dbClient.query(`SELECT id FROM roles WHERE name = 'agent'`);
    if (!role) {
      await dbClient.query('ROLLBACK');
      return res.status(500).json({ error: 'agent role not found — run db:migrate' });
    }

    // Flip user to agent
    const { rows: [promoted] } = await dbClient.query(
      `UPDATE users
       SET is_agent = true,
           role = 'agent',
           role_id = $1,
           parent_agent_id = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, role, role_id, is_agent, parent_agent_id`,
      [role.id, parent_agent_id || null, req.params.id]
    );

    // Optional: assign initial products (each cascade-validated within the txn)
    const assignments = [];
    for (const entry of Array.isArray(initialProducts) ? initialProducts : []) {
      const { product_id, rate_per_lot } = entry || {};
      if (!product_id || rate_per_lot == null) continue;

      const check = await validateRate(req.params.id, product_id, rate_per_lot, dbClient);
      if (!check.ok) {
        await dbClient.query('ROLLBACK');
        return res.status(400).json({
          error: 'Product rate validation failed',
          product_id,
          detail: check,
        });
      }
      const { rows: [ap] } = await dbClient.query(
        `INSERT INTO agent_products (agent_id, product_id, rate_per_lot, granted_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, product_id, Number(rate_per_lot), req.user.id]
      );
      assignments.push(ap);
    }

    await dbClient.query('COMMIT');
    bustPermissionCache(req.params.id);
    res.status(201).json({ agent: promoted, products: assignments });
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    dbClient.release();
  }
});

// POST /api/agents/:id/demote — demote back to rep; reparent direct sub-agents; deactivate products
router.post('/:id/demote', async (req, res, next) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const { rows: [agent] } = await dbClient.query(
      'SELECT parent_agent_id, is_agent FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!agent || !agent.is_agent) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Move direct sub-agents up one level (to the demoted agent's parent, or null for top)
    const { rowCount: moved } = await dbClient.query(
      `UPDATE users SET parent_agent_id = $1, updated_at = NOW()
       WHERE parent_agent_id = $2 AND is_agent = true`,
      [agent.parent_agent_id, req.params.id]
    );

    // Deactivate this agent's product assignments (preserve history; ledger FKs still resolve)
    await dbClient.query(
      `UPDATE agent_products SET is_active = false, updated_at = NOW()
       WHERE agent_id = $1 AND is_active = true`,
      [req.params.id]
    );

    // Flip user back to 'rep' role (default); admin can change afterwards
    const { rows: [repRole] } = await dbClient.query(`SELECT id FROM roles WHERE name = 'rep'`);
    const { rows: [demoted] } = await dbClient.query(
      `UPDATE users
       SET is_agent = false,
           role = 'rep',
           role_id = $1,
           parent_agent_id = NULL,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, role, is_agent`,
      [repRole?.id || null, req.params.id]
    );

    // Bust caches for the demoted agent AND any reparented sub-agents whose
    // effective ceilings may now change (their parent changed).
    bustPermissionCache(req.params.id);
    const { rows: reparented } = await dbClient.query(
      'SELECT id FROM users WHERE parent_agent_id IS NOT DISTINCT FROM $1',
      [agent.parent_agent_id]
    );
    for (const r of reparented) bustPermissionCache(r.id);

    await dbClient.query('COMMIT');
    res.json({ agent: demoted, sub_agents_reparented: moved });
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    dbClient.release();
  }
});

// PATCH /api/agents/:id — update agent (re-parent, flip is_active)
router.patch('/:id', async (req, res, next) => {
  try {
    const { parent_agent_id, is_active } = req.body;

    // Cycle check on re-parent
    if (parent_agent_id !== undefined && parent_agent_id !== null) {
      if (parent_agent_id === req.params.id) {
        return res.status(400).json({ error: 'Agent cannot be its own parent' });
      }
      if (await wouldCreateCycle(req.params.id, parent_agent_id)) {
        return res.status(400).json({ error: 'Re-parenting would create a cycle' });
      }
      // Validate parent is an active agent
      const { rows: [parent] } = await pool.query(
        'SELECT is_agent, is_active FROM users WHERE id = $1',
        [parent_agent_id]
      );
      if (!parent || !parent.is_agent || !parent.is_active) {
        return res.status(400).json({ error: 'parent_agent_id must reference an active agent' });
      }
    }

    const updates = [];
    const values = [];
    let i = 1;
    if (parent_agent_id !== undefined) { updates.push(`parent_agent_id = $${i++}`); values.push(parent_agent_id); }
    if (is_active !== undefined)       { updates.push(`is_active = $${i++}`);       values.push(Boolean(is_active)); }
    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields' });
    updates.push('updated_at = NOW()');
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} AND is_agent = true
       RETURNING id, name, email, parent_agent_id, is_active`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Agent not found' });

    bustPermissionCache(req.params.id);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/agents/:id/products — admin assigns/updates product rate for this agent
router.post('/:id/products', async (req, res, next) => {
  try {
    const { product_id, rate_per_lot } = req.body;
    if (!product_id || rate_per_lot == null) {
      return res.status(400).json({ error: 'product_id and rate_per_lot required' });
    }

    const check = await validateRate(req.params.id, product_id, rate_per_lot);
    if (!check.ok) {
      return res.status(400).json({ error: 'Rate validation failed', ...check });
    }

    // If lowering, warn/clamp descendants
    const { rows: existingRow } = await pool.query(
      `SELECT rate_per_lot FROM agent_products
       WHERE agent_id = $1 AND product_id = $2 AND is_active = true`,
      [req.params.id, product_id]
    );
    const existingRate = existingRow[0] ? Number(existingRow[0].rate_per_lot) : null;
    const newRate = Number(rate_per_lot);
    const force = req.query.force === 'true';

    if (existingRate !== null && newRate < existingRate) {
      const affected = await findDescendantsExceeding(req.params.id, product_id, newRate);
      if (affected.length > 0) {
        if (!force) {
          return res.status(409).json({
            error: 'Lowering this rate would orphan descendant rates',
            affected,
            hint: 'Retry with ?force=true to clamp descendants to the new rate',
          });
        }
        // force: clamp every descendant > newRate
        await pool.query(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM users WHERE parent_agent_id = $1 AND is_agent = true
             UNION ALL
             SELECT u.id FROM users u JOIN subtree s ON u.parent_agent_id = s.id WHERE u.is_agent = true
           )
           UPDATE agent_products ap SET rate_per_lot = $2, updated_at = NOW()
           FROM subtree s
           WHERE ap.agent_id = s.id AND ap.product_id = $3 AND ap.rate_per_lot > $2`,
          [req.params.id, newRate, product_id]
        );
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO agent_products (agent_id, product_id, rate_per_lot, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, product_id) DO UPDATE SET
         rate_per_lot = EXCLUDED.rate_per_lot,
         granted_by   = EXCLUDED.granted_by,
         is_active    = true,
         updated_at   = NOW()
       RETURNING *`,
      [req.params.id, product_id, newRate, req.user.id]
    );
    // Invalidate the hierarchy cache so the commission tree reflects the new
    // rate immediately on the next page fetch (without this the 60-second TTL
    // would serve the stale rate back after an onSaved refetch).
    invalidateCache('/api/agents/hierarchy');
    // Log as rate.change (if pre-existing) or rate.grant (first-time)
    await audit(req, {
      action: existingRate !== null ? 'rate.change' : 'rate.grant',
      entity_type: 'agent_product',
      entity_id: `${req.params.id}:${product_id}`,
      before: existingRate !== null ? { rate_per_lot: existingRate } : null,
      after:  { rate_per_lot: newRate },
      metadata: { agent_id: req.params.id, product_id, force: force || false },
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/agents/:id/products/:productId — revoke (soft)
router.delete('/:id/products/:productId', async (req, res, next) => {
  try {
    const { rows: before } = await pool.query(
      `SELECT rate_per_lot FROM agent_products
       WHERE agent_id = $1 AND product_id = $2 AND is_active = true`,
      [req.params.id, req.params.productId]
    );
    const { rows } = await pool.query(
      `UPDATE agent_products SET is_active = false, updated_at = NOW()
       WHERE agent_id = $1 AND product_id = $2
       RETURNING id`,
      [req.params.id, req.params.productId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
    await audit(req, {
      action: 'rate.revoke',
      entity_type: 'agent_product',
      entity_id: `${req.params.id}:${req.params.productId}`,
      before: before[0] || null,
      after: null,
      metadata: { agent_id: req.params.id, product_id: req.params.productId },
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
