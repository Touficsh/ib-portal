import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });
import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { errorHandler } from './middleware/errorHandler.js';
import { migration } from './db/migrate.js';
import { logger } from './services/logger.js';
import { httpMetricsMiddleware, metricsHandler, startDbPoolMetricsCollector } from './services/metrics.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5201', credentials: true }));
app.use(express.json());

// Request-scoped structured logger with auto request-id correlation.
// Use `req.log.info(...)` inside route handlers to get request-id binding.
app.use(pinoHttp({
  logger,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400)         return 'warn';
    if (req.url === '/api/health' || req.url === '/metrics') return 'silent';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`,
  serializers: {
    req: (r) => ({ method: r.method, url: r.url, id: r.id }),
    res: (r) => ({ statusCode: r.statusCode }),
  },
}));

// Prometheus request histogram/counter
app.use(httpMetricsMiddleware);

// Prom metrics endpoint — public so Prometheus can scrape without auth header.
app.get('/metrics', metricsHandler);

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    throw new Error('FATAL: JWT_SECRET must be set and at least 16 characters');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('FATAL: DATABASE_URL must be set');
  }

  // Dynamically import pool after DATABASE_URL is set
  const { default: pool } = await import('./db/pool.js');

  // Background DB pool state collector (exposed via /metrics)
  startDbPoolMetricsCollector(pool);

  // Run schema migration on startup (idempotent — all CREATE IF NOT EXISTS)
  await pool.query(migration);
  console.log('Migration applied');

  // If mt5_deal_cache has been partitioned, make sure next month's partition exists.
  try {
    const { ensureFuturePartitions } = await import('./db/partitionMt5DealCache.js');
    await ensureFuturePartitions().catch(err => logger.warn({ err: err.message }, 'ensureFuturePartitions failed'));
    setInterval(() => {
      ensureFuturePartitions().catch(err => logger.warn({ err: err.message }, 'ensureFuturePartitions interval failed'));
    }, 24 * 60 * 60 * 1000).unref();
  } catch { /* partitioning module optional */ }

  // ----------------------------------------------------------------
  // Sync webhook — CRM pushes agent data here after import/update.
  // Verifies SYNC_WEBHOOK_SECRET header, upserts the user row.
  // ----------------------------------------------------------------
  app.post('/api/sync/agent-imported', async (req, res) => {
    try {
      const secret = req.headers['x-sync-webhook-secret'];
      if (!secret || secret !== process.env.SYNC_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { id, name, email, role, is_agent, parent_agent_id, linked_client_id, crm_ib_wallet_id } = req.body;
      if (!id || !email) {
        return res.status(400).json({ error: 'id and email are required' });
      }

      const { default: pool } = await import('./db/pool.js');
      await pool.query(
        `INSERT INTO users (id, name, email, role, is_agent, parent_agent_id, linked_client_id, crm_ib_wallet_id, password_hash, updated_at)
         VALUES ($1, $2, $3, COALESCE($4, 'agent'), COALESCE($5, true), $6, $7, $8, '', NOW())
         ON CONFLICT (id) DO UPDATE SET
           name              = EXCLUDED.name,
           email             = EXCLUDED.email,
           role              = COALESCE(EXCLUDED.role, users.role),
           is_agent          = COALESCE(EXCLUDED.is_agent, users.is_agent),
           parent_agent_id   = COALESCE(EXCLUDED.parent_agent_id, users.parent_agent_id),
           linked_client_id  = COALESCE(EXCLUDED.linked_client_id, users.linked_client_id),
           crm_ib_wallet_id  = COALESCE(EXCLUDED.crm_ib_wallet_id, users.crm_ib_wallet_id),
           updated_at        = NOW()`,
        [id, name, email, role, is_agent, parent_agent_id ?? null, linked_client_id ?? null, crm_ib_wallet_id ?? null]
      );

      logger.info({ userId: id, email }, '[Sync] agent-imported upserted');
      res.json({ ok: true });

      // Fire-and-forget post-webhook sync — only runs when data is actually
      // stale. Both checks are pure DB reads (zero CRM calls) before deciding
      // whether to hit CRM, so repeated webhook events are nearly free.
      const { rows: [importedUser] } = await pool.query(
        `SELECT u.id, u.parent_agent_id, c.referred_by_agent_id,
                MAX(cl.synced_at) AS last_comm_sync
         FROM users u
         LEFT JOIN clients c ON c.id = u.linked_client_id
         LEFT JOIN crm_commission_levels cl ON cl.agent_user_id = u.id
         WHERE u.id = $1 AND u.is_agent = true
         GROUP BY u.id, u.parent_agent_id, c.referred_by_agent_id`,
        [id]
      );
      if (importedUser) {
        (async () => {
          // Commission sync: skip if synced within the last 24 h (same window
          // as the admin "smart sync"). Prevents repeated CRM calls on retried
          // or duplicate webhook deliveries.
          const syncedRecently = importedUser.last_comm_sync &&
            (Date.now() - new Date(importedUser.last_comm_sync).getTime()) < 24 * 60 * 60 * 1000;
          if (!syncedRecently) {
            try {
              const { syncOneAgentCommissionLevels } = await import('./services/commissionLevelSync.js');
              await syncOneAgentCommissionLevels(importedUser.id);
            } catch (e) { logger.warn({ err: e.message }, '[Sync] post-webhook commission sync failed'); }
          }

          // Parent backfill: skip if parent link is already set in both tables.
          const parentAlreadySet = importedUser.parent_agent_id && importedUser.referred_by_agent_id;
          if (!parentAlreadySet) {
            try {
              const { backfillAgentParents } = await import('./services/agentParentBackfill.js');
              await backfillAgentParents({ agentIds: [importedUser.id] });
            } catch (e) { logger.warn({ err: e.message }, '[Sync] post-webhook parent backfill failed'); }
          }
        })();
      }
    } catch (err) {
      logger.error({ err: err.message }, '[Sync] agent-imported failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Portal routes
  const { default: portalRoutes } = await import('./routes/portal/index.js');
  app.use('/api/portal', portalRoutes);
  if (process.env.ENABLE_PORTAL === 'true') {
    console.log('[Portal] Agent portal routes enabled at /api/portal');
  }

  // Admin routes
  const { default: auditRoutes } = await import('./routes/admin/audit.js');
  app.use('/api/admin/audit-log', auditRoutes);

  const { default: reconRoutes } = await import('./routes/admin/reconciliation.js');
  app.use('/api/admin/reconciliation', reconRoutes);

  const { default: adminDashRoutes } = await import('./routes/admin/dashboard.js');
  app.use('/api/admin/dashboard', adminDashRoutes);

  const { default: adminCrmRoutes } = await import('./routes/admin/crm.js');
  app.use('/api/admin/crm', adminCrmRoutes);

  const { default: adminMt5SyncRoutes } = await import('./routes/admin/mt5Sync.js');
  app.use('/api/admin/mt5-sync', adminMt5SyncRoutes);

  const { default: adminAgentSummaryRoutes } = await import('./routes/admin/agentSummary.js');
  app.use('/api/admin/agent-summary', adminAgentSummaryRoutes);

  const { default: adminSettingsRoutes } = await import('./routes/admin/settings.js');
  app.use('/api/admin/settings', adminSettingsRoutes);

  const { default: adminProductsRoutes } = await import('./routes/admin/products.js');
  app.use('/api/admin/products', adminProductsRoutes);
  app.use('/api/products', adminProductsRoutes);

  const { default: adminClientsRoutes } = await import('./routes/admin/clients.js');
  app.use('/api/admin/clients', adminClientsRoutes);

  const { default: adminJobsRoutes } = await import('./routes/admin/jobs.js');
  app.use('/api/admin/jobs', adminJobsRoutes);

  const { default: agentsRoutes } = await import('./routes/agents.js');
  app.use('/api/agents', agentsRoutes);

  const { default: usersRoutes } = await import('./routes/users.js');
  app.use('/api/users', usersRoutes);

  const { default: commissionsRoutes } = await import('./routes/commissions.js');
  app.use('/api/commissions', commissionsRoutes);

  const { default: branchesRoutes } = await import('./routes/branches.js');
  app.use('/api/branches', branchesRoutes);

  const { default: adminDocsRoutes } = await import('./routes/admin/docs.js');
  app.use('/api/admin/docs', adminDocsRoutes);

  const { default: syncRoutes } = await import('./routes/sync.js');
  app.use('/api/sync', syncRoutes);

  // ── MT5 real-time deal webhook ─────────────────────────────────────
  // The bridge POSTs every new deal here within ~1 second of execution
  // (via DealSubscribe → DealSink.OnDealAdd → fire-and-forget HTTP POST).
  // Auth is by shared secret in X-MT5-Webhook-Secret header (matches
  // bridge's MT5_WEBHOOK_SECRET env). Mounted BEFORE the auth-protected
  // routes so it doesn't require a Bearer token.
  const { default: mt5WebhookRoutes } = await import('./routes/mt5Webhook.js');
  app.use('/api/mt5/webhook', mt5WebhookRoutes);

  // ── MT5 live data routes (auth-protected) ──────────────────────────
  // GET /api/mt5/accounts/:login — live balance/equity for a single login.
  // Used by the Trading Accounts page's "Refresh" button. Bridge-backed
  // through mt5BridgeGate so it respects the kill switch + rate limits.
  const { default: mt5Routes } = await import('./routes/mt5.js');
  app.use('/api/mt5', mt5Routes);

  // ── Internal endpoint for the MT5 bridge ───────────────────────────
  // Localhost-only, no auth — the bridge polls this on startup / reconnect
  // to fetch its MT5 manager credentials from the portal's `settings` table.
  // This replaces the old live-crm-sales endpoint of the same path so the
  // bridge keeps working with `CRM_BACKEND_URL=http://localhost:3001`.
  app.get('/api/settings/mt5/internal', async (req, res) => {
    try {
      const ip = req.ip || req.connection?.remoteAddress || '';
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocal) return res.status(403).json({ error: 'Forbidden' });
      const { rows } = await pool.query(
        `SELECT key, value FROM settings WHERE key LIKE 'mt5\\_%' ESCAPE '\\'`
      );
      const mt5 = {};
      for (const row of rows) mt5[row.key.replace('mt5_', '')] = row.value;
      res.json(mt5);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'ib-portal' }));

  app.use(errorHandler);

  // Serve frontend/dist at /portal/
  const portalDist = resolve(__dirname, '../../frontend/dist');
  import('fs').then(({ existsSync }) => {
    if (existsSync(portalDist)) {
      app.use('/portal', express.static(portalDist));
      // SPA fallback — serve index.html for any deep-link under /portal
      app.get(/^\/portal(\/.*)?$/, (req, res) => {
        res.sendFile(resolve(portalDist, 'index.html'));
      });
      console.log('Serving portal from', portalDist);
    }
  });

  app.listen(PORT, () => {
    console.log(`IB Agent Portal server running on port ${PORT}`);

    // Daily DB housekeeping — trims old engine_jobs, cycles, audit_log.
    import('./services/dbHousekeeping.js').then(({ startHousekeepingScheduler }) => {
      startHousekeepingScheduler();
    }).catch(err => console.error('[Housekeeping] Failed to initialize:', err.message));

    // Start Commission Engine scheduler if enabled.
    if (process.env.ENABLE_COMMISSION_ENGINE === 'true') {
      import('./services/commissionEngine.js').then(async ({ startCommissionScheduler, cleanupOrphanedCycles }) => {
        // Reclaim any cycles left "running" by a previous process death.
        // Their in-memory locks died with that process; the DB rows stayed
        // status='running' indefinitely and clutter the admin dashboard.
        await cleanupOrphanedCycles().catch(() => {});
        startCommissionScheduler();
      }).catch(err => console.error('[Commissions] Failed to initialize:', err.message));
    }

    // Start MT5 active-login sweep scheduler (safety net for missed webhook deals).
    if (process.env.ENABLE_COMMISSION_ENGINE === 'true') {
      import('./services/mt5SyncScheduler.js').then(({ startMt5SyncScheduler }) => {
        startMt5SyncScheduler();
      }).catch(err => console.error('[MT5Sweep] Failed to initialize:', err.message));
    }

    // Start CRM contact poll scheduler — picks up new clients added to xdev
    // since the last tick. Opt-in via ENABLE_CONTACT_POLL=true (env). Reads
    // first 1-3 pages of /api/contacts (newest-first), stops at checkpoint,
    // imports any whose connectedAgent matches an imported agent.
    import('./services/contactPollScheduler.js').then(({ startContactPollScheduler }) => {
      startContactPollScheduler();
    }).catch(err => console.error('[ContactPoll] Failed to initialize:', err.message));

    // Start branch hierarchy refresh scheduler — every 30 min, walks each
    // imported branch via /api/agent-hierarchy. Catches new sub-agents,
    // new clients, new leads, and new MT5 logins in one call per branch.
    // Replaces the old contact-list page-1 trick with a more comprehensive
    // refresh. Opt-in via ENABLE_BRANCH_HIERARCHY_POLL (default: true).
    import('./services/branchHierarchyScheduler.js').then(({ startBranchHierarchyScheduler }) => {
      startBranchHierarchyScheduler();
    }).catch(err => console.error('[BranchHierPoll] Failed to initialize:', err.message));

    // Start MT5 hot-login fast sweep — every 5 min, only logins active in
    // last 24h. Catches deals on currently-trading accounts within minutes.
    // Bridge-only — no CRM/Supabase load. Runs alongside the regular sweep.
    if (process.env.ENABLE_COMMISSION_ENGINE === 'true') {
      import('./services/mt5HotLoginSweep.js').then(({ startMt5HotLoginSweep }) => {
        startMt5HotLoginSweep();
      }).catch(err => console.error('[MT5HotSweep] Failed to initialize:', err.message));
    }

    // Start daily CRM agent refresh — once per day at configurable UTC hour
    // (default 4 AM). Pulls /api/agents/query so new agents/branches added
    // to xdev appear in the Import Agents picker without admin clicks.
    import('./services/dailyAgentRefresh.js').then(({ startDailyAgentRefresh }) => {
      startDailyAgentRefresh();
    }).catch(err => console.error('[DailyAgentRefresh] Failed to initialize:', err.message));

  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
