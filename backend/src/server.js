import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env'), override: true });
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
      import('./services/commissionEngine.js').then(({ startCommissionScheduler }) => {
        startCommissionScheduler();
      }).catch(err => console.error('[Commissions] Failed to initialize:', err.message));
    }

    // Start MT5 active-login sweep scheduler (safety net for missed webhook deals).
    if (process.env.ENABLE_COMMISSION_ENGINE === 'true') {
      import('./services/mt5SyncScheduler.js').then(({ startMt5SyncScheduler }) => {
        startMt5SyncScheduler();
      }).catch(err => console.error('[MT5Sweep] Failed to initialize:', err.message));
    }
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
