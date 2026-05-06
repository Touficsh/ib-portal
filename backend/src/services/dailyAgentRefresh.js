/**
 * Daily CRM Agent Refresh — once per day at a configurable hour, runs the
 * same operation as the "Refresh from CRM" button on Import Agents:
 *   pages through /api/agents/query/N/100 and upserts every CRM agent into
 *   the local clients table.
 *
 * Purpose: any new agent or branch added in xdev becomes visible in the
 * Import Agents picker within ~24h without admin intervention. Cost is ~16
 * CRM calls per day (the agents-query bucket has 100/day budget).
 *
 * Configuration (env vars):
 *   ENABLE_DAILY_AGENT_REFRESH    'true' to enable (default true)
 *   DAILY_AGENT_REFRESH_HOUR_UTC  hour of day to run (default 4 = off-peak)
 *
 * Single in-flight guard. Aborts cleanly if CRM gate is paused.
 */
import pool from '../db/pool.js';
import { crmRequest, CrmPausedError } from './crmGate.js';

let refreshRunning = false;

async function runOnce() {
  if (refreshRunning) {
    console.log('[DailyAgentRefresh] skipped — previous run still in flight');
    return;
  }
  refreshRunning = true;
  const start = Date.now();
  const summary = { inserted: 0, updated: 0, errors: 0, totalFetched: 0, pages: 0 };

  try {
    const pageSize = 100;
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      let data;
      try {
        data = await crmRequest(`/api/agents/query/${page}/${pageSize}`);
      } catch (err) {
        if (err instanceof CrmPausedError) {
          console.warn('[DailyAgentRefresh] CRM gate paused — aborting');
          break;
        }
        throw err;
      }
      if (!data?.agents || !Array.isArray(data.agents)) break;
      if (page === 1 && data.totalPages) totalPages = data.totalPages;

      for (const a of data.agents) {
        try {
          const email  = a.emails?.[0]?.email   || null;
          const phone  = a.phoneNumbers?.[0]?.number || null;
          const branch = a.branchNames || a.branch?.name || null;
          const r = await pool.query(
            `INSERT INTO clients
               (id, contact_type, name, email, phone, pipeline_stage, branch,
                is_verified, is_trader, crm_profile_type,
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
          if (r.rows[0]?.is_insert) summary.inserted++;
          else summary.updated++;
        } catch (rowErr) {
          summary.errors++;
        }
      }
      summary.totalFetched += data.agents.length;
      summary.pages = page;
      page++;
    }
  } catch (err) {
    console.error('[DailyAgentRefresh] failed:', err.message);
    summary.errors++;
  } finally {
    refreshRunning = false;
    summary.durationMs = Date.now() - start;
    console.log('[DailyAgentRefresh] done:', summary);
  }
}

/**
 * Schedule a daily run at the configured UTC hour. We compute the time
 * until the next run and use one setTimeout, then chain a 24h setInterval
 * after the first fire. This avoids drift across days and makes the run
 * happen at a predictable wall-clock time.
 */
export function startDailyAgentRefresh({
  hourUTC = 4,
} = {}) {
  const enabled = String(process.env.ENABLE_DAILY_AGENT_REFRESH || 'true').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[DailyAgentRefresh] disabled (set ENABLE_DAILY_AGENT_REFRESH=true to enable)');
    return;
  }

  const effectiveHour = (() => {
    const v = Number(process.env.DAILY_AGENT_REFRESH_HOUR_UTC);
    if (Number.isFinite(v) && v >= 0 && v <= 23) return Math.floor(v);
    return hourUTC;
  })();

  function msUntilNextHour() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), effectiveHour, 0, 0));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  const wait = msUntilNextHour();
  const nextRunAt = new Date(Date.now() + wait).toISOString();
  console.log(`[DailyAgentRefresh] Scheduler armed — first run at ${nextRunAt} (UTC hour ${effectiveHour})`);

  setTimeout(() => {
    runOnce().catch(err => console.error('[DailyAgentRefresh] first run failed:', err.message));
    setInterval(() => {
      runOnce().catch(err => console.error('[DailyAgentRefresh] scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000).unref();
  }, wait).unref();
}
