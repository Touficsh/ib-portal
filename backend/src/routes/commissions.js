/**
 * Commissions Admin — /api/commissions
 *
 * Staff-side view of the full commission ledger plus manual engine controls.
 * All routes require `portal.admin`.
 *
 *   GET  /                  — paginated, filterable across all agents
 *   GET  /summary           — grouped totals (day/week/month/agent/product)
 *   GET  /engine/status     — current scheduler state + last run summary
 *   POST /engine/run        — fire a one-shot sync now (non-blocking) — admin convenience
 */
import { Router } from 'express';
import pool from '../db/pool.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { runCommissionSync, getEngineStatus, retryDeadJobs } from '../services/commissionEngine.js';
import { audit } from '../services/auditLog.js';
import { cacheMw, invalidateCache } from '../services/responseCache.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

function parseDateParam(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// GET /api/commissions — paginated ledger (all agents)
router.get('/', async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    const productId = req.query.product_id || null;
    const agentId = req.query.agent_id || null;
    const clientId = req.query.client_id || null;
    const level = req.query.level != null ? Number(req.query.level) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];
    let i = 1;
    if (from)      { where.push(`c.deal_time >= $${i++}`); params.push(from); }
    if (to)        { where.push(`c.deal_time <  $${i++}`); params.push(to); }
    if (productId) { where.push(`c.product_id = $${i++}`);  params.push(productId); }
    if (agentId)   { where.push(`c.agent_id = $${i++}`);    params.push(agentId); }
    if (clientId)  { where.push(`c.client_id = $${i++}`);   params.push(clientId); }
    if (level != null && Number.isFinite(level)) { where.push(`c.level = $${i++}`); params.push(level); }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ rows: items }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT c.id, c.deal_id, c.deal_time, c.client_id, cl.name AS client_name,
                c.mt5_login, c.product_id, p.name AS product_name, p.currency,
                c.agent_id, u.name AS agent_name, u.email AS agent_email,
                c.lots, c.rate_per_lot, c.amount,
                c.commission_amount, c.rebate_amount,
                c.source_agent_id, sa.name AS source_agent_name,
                c.level, c.created_at
         FROM commissions c
         JOIN products p ON p.id = c.product_id
         JOIN users    u ON u.id = c.agent_id
         LEFT JOIN clients cl ON cl.id = c.client_id
         LEFT JOIN users sa ON sa.id = c.source_agent_id
         ${whereSQL}
         ORDER BY c.deal_time DESC, c.id DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c,
                COALESCE(SUM(c.amount),0)::numeric(14,2) AS total_amount,
                COALESCE(SUM(c.commission_amount),0)::numeric(14,2) AS total_commission,
                COALESCE(SUM(c.rebate_amount),0)::numeric(14,2) AS total_rebate,
                COALESCE(SUM(c.lots),0)::numeric(14,4) AS total_lots
         FROM commissions c ${whereSQL}`,
        params
      ),
    ]);

    res.json({
      items,
      pagination: {
        page, pageSize,
        total: countRows[0].c,
        totalAmount:     Number(countRows[0].total_amount),
        totalCommission: Number(countRows[0].total_commission),
        totalRebate:     Number(countRows[0].total_rebate),
        totalLots:       Number(countRows[0].total_lots),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/commissions/summary — grouped totals
// groupBy ∈ { day, week, month, agent, product, source_agent }
//   When scoping to a single agent (agent_id filter), the `source_agent`
//   grouping is what the agent's own portal uses: it buckets by which
//   direct descendant (or "self" for the agent's own direct clients)
//   sourced each deal. Admins use this same shape when drilling into an
//   agent from the Commission History page.
router.get('/summary', async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    const agentId = req.query.agent_id || null;
    const productId = req.query.product_id || null;
    const groupBy = (req.query.groupBy || 'day').toLowerCase();
    const allowedGroups = {
      day:          { expr: `date_trunc('day', c.deal_time)`,   key: 'bucket' },
      week:         { expr: `date_trunc('week', c.deal_time)`,  key: 'bucket' },
      month:        { expr: `date_trunc('month', c.deal_time)`, key: 'bucket' },
      agent:        { expr: 'c.agent_id',                        key: 'agent_id' },
      product:      { expr: 'c.product_id',                      key: 'bucket' },
      source_agent: { expr: 'c.source_agent_id',                 key: 'bucket' },
      client:       { expr: 'c.client_id',                       key: 'bucket' },
    };
    if (!allowedGroups[groupBy]) {
      return res.status(400).json({ error: `groupBy must be one of: ${Object.keys(allowedGroups).join(', ')}` });
    }
    const g = allowedGroups[groupBy];

    const where = [];
    const params = [];
    let i = 1;
    if (from)      { where.push(`c.deal_time >= $${i++}`); params.push(from); }
    if (to)        { where.push(`c.deal_time <  $${i++}`); params.push(to); }
    if (agentId)   { where.push(`c.agent_id = $${i++}`);    params.push(agentId); }
    if (productId) { where.push(`c.product_id = $${i++}`);  params.push(productId); }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Order: time-bucket groupings stay chronological; entity groupings sort
    // by total desc so the biggest producer is always at the top of the chart.
    const isTimeBucket = groupBy === 'day' || groupBy === 'week' || groupBy === 'month';
    const orderSQL = isTimeBucket
      ? `ORDER BY ${g.expr} ASC`
      : `ORDER BY SUM(c.amount) DESC NULLS LAST, ${g.expr} ASC`;

    const { rows } = await pool.query(
      `SELECT ${g.expr} AS ${g.key},
              COUNT(*)::int AS deal_count,
              SUM(c.lots)::numeric(14,4) AS total_lots,
              SUM(c.amount)::numeric(14,2) AS total_amount,
              SUM(c.commission_amount)::numeric(14,2) AS total_commission,
              SUM(c.rebate_amount)::numeric(14,2) AS total_rebate
       FROM commissions c ${whereSQL}
       GROUP BY ${g.expr}
       ${orderSQL}`,
      params
    );

    const base = rows.map(r => ({
      [g.key]: r[g.key],
      deal_count: r.deal_count,
      total_lots:       Number(r.total_lots || 0),
      total_amount:     Number(r.total_amount || 0),
      total_commission: Number(r.total_commission || 0),
      total_rebate:     Number(r.total_rebate || 0),
    }));

    // Enrich product rows with product metadata (name, currency, rates)
    if (groupBy === 'product') {
      const ids = base.map(r => r.bucket).filter(Boolean);
      if (ids.length > 0) {
        const { rows: names } = await pool.query(
          `SELECT id, name, currency, commission_per_lot, rebate_per_lot
           FROM products WHERE id = ANY($1)`,
          [ids]
        );
        const byId = Object.fromEntries(names.map(n => [n.id, n]));
        return res.json(base.map(r => ({
          ...r,
          product_name: byId[r.bucket]?.name || null,
          currency:     byId[r.bucket]?.currency || null,
          product_commission_per_lot: Number(byId[r.bucket]?.commission_per_lot || 0),
          product_rebate_per_lot:     Number(byId[r.bucket]?.rebate_per_lot || 0),
        })));
      }
    }

    // Enrich source-agent rows with the sub-agent's display name, and flag
    // the "self" row (source_agent_id === the scoped agent_id) so the UI
    // can label it "direct clients" rather than the agent's own name.
    if (groupBy === 'source_agent') {
      const ids = base.map(r => r.bucket).filter(Boolean);
      if (ids.length > 0) {
        const { rows: names } = await pool.query(
          `SELECT id, name, email FROM users WHERE id = ANY($1)`,
          [ids]
        );
        const byId = Object.fromEntries(names.map(n => [n.id, n]));
        return res.json(base.map(r => ({
          ...r,
          source_agent_id:   r.bucket,
          source_agent_name: byId[r.bucket]?.name || null,
          source_agent_email: byId[r.bucket]?.email || null,
          is_self: agentId != null && r.bucket === agentId,
        })));
      }
    }

    // Enrich client rows with the client's display name + email so the UI
    // can render a drill-down table ranking individual traders by revenue.
    if (groupBy === 'client') {
      const ids = base.map(r => r.bucket).filter(Boolean);
      if (ids.length > 0) {
        const { rows: names } = await pool.query(
          `SELECT id, name, email FROM clients WHERE id = ANY($1)`,
          [ids]
        );
        const byId = Object.fromEntries(names.map(n => [n.id, n]));
        return res.json(base.map(r => ({
          ...r,
          client_id:    r.bucket,
          client_name:  byId[r.bucket]?.name  || null,
          client_email: byId[r.bucket]?.email || null,
        })));
      }
    }

    // Enrich agent rows with the agent's name/email
    if (groupBy === 'agent') {
      const ids = base.map(r => r.agent_id).filter(Boolean);
      if (ids.length > 0) {
        const { rows: names } = await pool.query(
          `SELECT id, name, email FROM users WHERE id = ANY($1)`,
          [ids]
        );
        const byId = Object.fromEntries(names.map(n => [n.id, n]));
        return res.json(base.map(r => ({
          ...r,
          agent_name:  byId[r.agent_id]?.name || null,
          agent_email: byId[r.agent_id]?.email || null,
        })));
      }
    }

    res.json(base);
  } catch (err) { next(err); }
});

// GET /api/commissions/earners — every user who has commission rows
//   Returns { id, name, email, role, is_agent, branch, deal_count, total_amount }
//   Used by the Agent Summary picker to surface staff reps (role='rep',
//   is_agent=false) alongside imported agents, since both can receive commissions.
//
// Reads from agent_earnings_summary (the per-month rollup maintained by the
// commission engine after every cycle). This avoids scanning ~660K rows in
// `commissions` on every call — the rollup is ~few-hundred rows total.
router.get('/earners', cacheMw({ ttl: 90 }), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_agent,
              cl.branch,
              COALESCE(SUM(s.deal_count), 0)::int           AS deal_count,
              COALESCE(SUM(s.total_amount), 0)::numeric(14,2) AS total_amount
       FROM users u
       JOIN agent_earnings_summary s ON s.agent_id = u.id
       LEFT JOIN clients cl ON cl.id = u.linked_client_id
       GROUP BY u.id, u.name, u.email, u.role, u.is_agent, cl.branch
       ORDER BY total_amount DESC, u.name ASC`
    );
    res.json(rows.map(r => ({
      ...r,
      total_amount: Number(r.total_amount),
    })));
  } catch (err) { next(err); }
});

// GET /api/commissions/engine/status — current scheduler state
router.get('/engine/status', async (req, res, next) => {
  try {
    const mem = getEngineStatus();
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE key = 'commission_last_run_at'`
    );
    res.json({
      ...mem,
      enabled: process.env.ENABLE_COMMISSION_ENGINE === 'true',
      intervalMin: Number(process.env.COMMISSION_SYNC_INTERVAL_MIN) || 15,
      lastRunFromDB: rows[0]?.value || null,
    });
  } catch (err) { next(err); }
});

// POST /api/commissions/engine/run — fire a one-shot run (admin convenience)
// Accepts optional body `{ sinceISO: "<ISO timestamp>" }` to force a wider window.
router.post('/engine/run', async (req, res, next) => {
  try {
    const sinceISO = req.body?.sinceISO ? parseDateParam(req.body.sinceISO) : null;
    if (req.body?.sinceISO && !sinceISO) {
      return res.status(400).json({ error: 'sinceISO must be a valid ISO date' });
    }
    // Fire-and-forget so admin UI doesn't hang; status can be polled via engine/status
    runCommissionSync({ sinceISO })
      .catch(err => console.error('[Commissions] manual run error:', err.message));
    await audit(req, {
      action: 'engine.run.manual',
      entity_type: 'settings',
      entity_id: 'commission_engine',
      metadata: { sinceISO },
    });
    res.status(202).json({ accepted: true, sinceISO });
  } catch (err) { next(err); }
});

// GET /api/commissions/engine/cycles — recent cycle runs for admin dashboard
router.get('/engine/cycles', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.name AS triggered_by_name
       FROM commission_engine_cycles c
       LEFT JOIN users u ON u.id = c.triggered_by_user
       ORDER BY c.started_at DESC
       LIMIT 30`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/commissions/engine/cycle/:id/jobs — jobs for a specific cycle (with DLQ)
router.get('/engine/cycle/:id/jobs', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.*, c.name AS client_name
       FROM commission_engine_jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.cycle_id = $1
       ORDER BY
         CASE j.status
           WHEN 'dead'      THEN 1
           WHEN 'failed'    THEN 2
           WHEN 'running'   THEN 3
           WHEN 'queued'    THEN 4
           WHEN 'succeeded' THEN 5
         END,
         j.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/commissions/engine/rebuild
// Destructive: DELETEs the entire commissions table and fires a fresh cycle
// that re-reads every deal from mt5_deal_cache using the current rates +
// MT5 commission values. Use this after fixing rates or changing engine math
// (e.g., the Model C cutover to per-deal MT5 commission). The cache is not
// touched so no bridge calls are needed — this is pure local recompute.
router.post('/engine/rebuild', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM commissions');
    // Fire the cycle; it'll pick up every eligible (client, login, product)
    // triple and rewrite every commission row from the cache.
    const cyclePromise = runCommissionSync({ triggeredBy: 'recovery', triggeredByUser: req.user.id })
      .catch(err => console.error('[Commissions] rebuild error:', err.message));
    await audit(req, {
      action: 'engine.rebuild',
      entity_type: 'settings',
      entity_id: 'commission_engine',
      metadata: { triggeredBy: 'rebuild' },
    });
    // Return immediately — cycle runs async, frontend polls /engine/cycles
    res.status(202).json({ accepted: true });
    cyclePromise; // keep the lint happy — intentionally not awaited
  } catch (err) { next(err); }
});

// POST /api/commissions/engine/retry — re-run dead jobs
router.post('/engine/retry', async (req, res, next) => {
  try {
    const result = await retryDeadJobs({ cycleId: req.body?.cycleId || null });
    await audit(req, {
      action: 'engine.run.manual',
      entity_type: 'commission_engine_cycle',
      entity_id: result.cycleId || null,
      metadata: { retry: true, reset: result.reset },
    });
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
