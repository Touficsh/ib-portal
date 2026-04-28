/**
 * Trading Account Meta Sync — caches per-login metadata from x-dev's CRM.
 *
 * x-dev's /api/contacts/:id/trading-accounts returns rich per-account data
 * (product name + id, type real|demo, currency, createdAt, status, balance)
 * that our mirror didn't persist — we only kept the login numbers in
 * clients.mt5_logins. This service fetches per-client and upserts a row per
 * login into `trading_accounts_meta`, which the portal then JOINs for display.
 *
 * Two entry points:
 *   syncForAgent(userId, { maxAgeMinutes })
 *     Syncs meta for every MT5 login in the agent's subtree. Skips clients
 *     whose meta was already refreshed within `maxAgeMinutes` (default 60).
 *
 *   syncForClient(clientId)
 *     Single-client refresh. Used internally + available as an admin helper.
 *
 * Concurrency is capped so we don't hammer x-dev. Errors on individual
 * contacts are logged and counted but don't stop the batch.
 */
import pool from '../db/pool.js';
import { getCrmConfig } from './crmConfig.js';
import { crmRequest, CrmPausedError } from './crmGate.js';

const CONCURRENCY = 8;

/**
 * Pure upsert — takes a CRM `/trading-accounts` response payload and writes
 * every row to `trading_accounts_meta`. No CRM calls here. Any sync function
 * that already has the payload (autoSync, branch sync, import Pass 4) should
 * call this so we don't re-fetch the same data a second time.
 *
 * Accepts either the full response object or the `.tradingAccounts.data`
 * array directly. Returns the number of rows upserted.
 */
export async function upsertTradingAccountMeta(clientId, payloadOrRows) {
  const rows = Array.isArray(payloadOrRows)
    ? payloadOrRows
    : (payloadOrRows?.tradingAccounts?.data || payloadOrRows?.data || []);
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let upserts = 0;
  for (const r of rows) {
    if (!r?.login) continue;
    try {
      await pool.query(
        `INSERT INTO trading_accounts_meta
           (login, client_id, source_id, name, account_type,
            product_name, product_source_id, currency, balance_cached,
            status, created_at_source, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (login) DO UPDATE SET
           client_id         = EXCLUDED.client_id,
           source_id         = EXCLUDED.source_id,
           name              = EXCLUDED.name,
           account_type      = EXCLUDED.account_type,
           product_name      = EXCLUDED.product_name,
           product_source_id = EXCLUDED.product_source_id,
           currency          = EXCLUDED.currency,
           balance_cached    = EXCLUDED.balance_cached,
           status            = EXCLUDED.status,
           created_at_source = EXCLUDED.created_at_source,
           last_synced_at    = NOW()`,
        [
          String(r.login),
          clientId,
          r.id || null,
          r.name || null,
          r.type || null,
          r.product || null,
          r.productId || null,
          r.currency || null,
          r.balance != null ? Number(r.balance) : null,
          typeof r.status === 'boolean' ? r.status : null,
          r.createdAt || null,
        ]
      );
      upserts++;
    } catch (rowErr) {
      console.error('[TAMetaSync] row failed', r.login, '-', rowErr.message);
    }
  }
  return upserts;
}

/**
 * Fetch + upsert meta for one client. Returns the number of login rows upserted.
 * Funnels through the CRM gate (rate-limit + concurrency cap + kill switch).
 * The `{ baseUrl, apiKey }` arg is kept for signature compat but ignored —
 * the gate reads config from settings itself.
 */
export async function syncForClient(clientId, { baseUrl, apiKey } = {}) {
  try {
    let data;
    try {
      data = await crmRequest(`/api/contacts/${clientId}/trading-accounts?page=1&limit=200`, {
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      if (err instanceof CrmPausedError) throw err; // surface to caller
      return 0;
    }
    const rows = data?.tradingAccounts?.data || data?.data || [];
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    let upserts = 0;
    for (const r of rows) {
      if (!r?.login) continue;
      try {
        await pool.query(
          `INSERT INTO trading_accounts_meta
             (login, client_id, source_id, name, account_type,
              product_name, product_source_id, currency, balance_cached,
              status, created_at_source, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
           ON CONFLICT (login) DO UPDATE SET
             client_id         = EXCLUDED.client_id,
             source_id         = EXCLUDED.source_id,
             name              = EXCLUDED.name,
             account_type      = EXCLUDED.account_type,
             product_name      = EXCLUDED.product_name,
             product_source_id = EXCLUDED.product_source_id,
             currency          = EXCLUDED.currency,
             balance_cached    = EXCLUDED.balance_cached,
             status            = EXCLUDED.status,
             created_at_source = EXCLUDED.created_at_source,
             last_synced_at    = NOW()`,
          [
            String(r.login),
            clientId,
            r.id || null,
            r.name || null,
            r.type || null,
            r.product || null,
            r.productId || null,
            r.currency || null,
            r.balance != null ? Number(r.balance) : null,
            typeof r.status === 'boolean' ? r.status : null,
            r.createdAt || null,
          ]
        );
        upserts++;
      } catch (rowErr) {
        // Unique conflict already handled; row-level errors just log & skip
        console.error('[TAMetaSync] row failed', r.login, '-', rowErr.message);
      }
    }
    return upserts;
  } catch (err) {
    console.error('[TAMetaSync] client fetch failed', clientId, '-', err.message);
    return 0;
  }
}

/**
 * Sync meta for every MT5-holding client in the agent's full subtree.
 * Skips clients whose meta is already fresh (any row in meta updated within
 * `maxAgeMinutes`). That gives each client one group-skip decision to keep
 * the batch cheap when re-opened.
 */
export async function syncForAgent(userId, { maxAgeMinutes = 60 } = {}) {
  const start = Date.now();
  const summary = {
    clients_scanned: 0,
    clients_skipped_fresh: 0,
    accounts_upserted: 0,
    fetch_errors: 0,
  };
  const { baseUrl, apiKey } = await getCrmConfig();

  // Pull every client in the agent's subtree that has at least one MT5 login
  const { rows: clients } = await pool.query(
    `WITH RECURSIVE subtree_users AS (
       SELECT id, linked_client_id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id, u.linked_client_id
       FROM users u JOIN subtree_users s ON u.parent_agent_id = s.id
       WHERE u.is_agent = true
     ),
     subtree_client_ids AS (
       SELECT linked_client_id AS id FROM subtree_users WHERE linked_client_id IS NOT NULL
       UNION
       SELECT c.id FROM clients c
       WHERE c.referred_by_agent_id IN (SELECT linked_client_id FROM subtree_users)
     )
     SELECT c.id, c.name,
            (SELECT MAX(m.last_synced_at) FROM trading_accounts_meta m WHERE m.client_id = c.id) AS last_synced
     FROM clients c
     WHERE c.id IN (SELECT id FROM subtree_client_ids)
       AND c.mt5_logins IS NOT NULL
       AND array_length(c.mt5_logins, 1) > 0`,
    [userId]
  );

  summary.clients_scanned = clients.length;
  const staleThreshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

  const work = clients.filter(c => !c.last_synced || new Date(c.last_synced) < staleThreshold);
  summary.clients_skipped_fresh = clients.length - work.length;

  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = idx++;
        if (i >= work.length) break;
        const n = await syncForClient(work[i].id, { baseUrl, apiKey });
        if (n === 0) summary.fetch_errors++; else summary.accounts_upserted += n;
      }
    })
  );

  summary.durationMs = Date.now() - start;
  console.log('[TAMetaSync] agent done:', summary);
  return summary;
}
