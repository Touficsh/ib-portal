/**
 * Portal — Summary — /api/portal/summary
 *
 * Hierarchical roll-up for the Summary page:
 *   {
 *     subagents:     [{ id, name, email, branch, lots, commission, balance,
 *                        deposits, withdrawals, equity,
 *                        ownAccounts: [...], clients: [{ id, name, ..., accounts: [...] }] }],
 *     directClients: [{ id, name, ..., accounts: [...] }],
 *     grandTotal:    { lots, commission, balance, deposits, withdrawals, equity },
 *     mt5_synced_at: <most recent snapshot sync in viewer's scope, ISO>,
 *     mt5_pending:   <count of logins never synced>
 *   }
 *
 * Data sources per column:
 *   balance    - trading_accounts_meta.balance_cached       (from x-dev CRM meta sync)
 *   equity     - trading_accounts_meta.equity_cached        (from MT5 snapshot sync)
 *   deposits   - trading_accounts_meta.deposits_total       (from MT5 snapshot sync)
 *   withdrawals- trading_accounts_meta.withdrawals_total    (from MT5 snapshot sync)
 *   lots       - trading_accounts_meta.lots_total           (from MT5 snapshot sync)
 *   commission - trading_accounts_meta.commission_total     (from MT5 snapshot sync)
 *                  = SUM(|deal.commission|) from MT5 history. This is the
 *                    broker's charge to the trader, NOT IB (portal) earnings.
 *                    Displayed as a positive number (raw MT5 values are
 *                    negative). When the waterfall engine is wired this will
 *                    switch to the IB earnings from the `commissions` table.
 *
 * All columns are "as of last MT5 snapshot sync" (point-in-time). The date
 * range picker on the UI is therefore informational only until the commission
 * engine is wired — the UI surfaces a freshness timestamp so the viewer knows
 * how stale the snapshot is.
 *
 * Side endpoints:
 *   POST /sync-mt5     — fire mt5SnapshotSync.syncForAgent for viewer's subtree
 *   GET  /mt5-status   — freshness indicator (oldest / newest sync + pending count)
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate, requireAgentAccess, requirePortalAdmin } from '../../middleware/portalAuth.js';
import { syncForAgent as syncSnapshotsForAgent } from '../../services/mt5SnapshotSync.js';
import { wrap as cacheWrap, invalidate as cacheInvalidate } from '../../services/cache.js';

const router = Router();
router.use(portalAuthenticate, requireAgentAccess);

// Cache TTL for the summary payload. 30s is short enough that the "freshness"
// stamp in the UI stays believable (MT5 snapshots are ~15 min old anyway) and
// long enough to absorb burst reloads during a session. Per-viewer, per-query.
const SUMMARY_TTL_MS = 30_000;

// GET /api/portal/summary
// Query params:
//   from=YYYY-MM-DD    (optional) — lower bound for commission period (forward-compat)
//   to=YYYY-MM-DD      (optional) — upper bound for commission period (forward-compat)
//   products=id1,id2   (optional) — filter to only these product_source_id values.
//                                    Empty / absent = no filter (all products).
router.get('/', async (req, res, next) => {
  try {
    const fromISO = req.query.from ? `${req.query.from} 00:00:00` : null;
    const toISO   = req.query.to   ? `${req.query.to} 23:59:59`   : null;
    // Parse products=id1,id2,id3 → array (empty array = no filter)
    const productIds = req.query.products
      ? String(req.query.products).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    // Cache key: viewer id + range + product filter. Short TTL so MT5 resyncs
    // show up quickly; busted explicitly after /sync-mt5.
    const cacheKey = `${req.user.id}|${fromISO || ''}|${toISO || ''}|${productIds.sort().join(',')}`;

    const payload = await cacheWrap('portal.summary', cacheKey, SUMMARY_TTL_MS, async () => {
      return await buildSummaryPayload(req.user.id, fromISO, toISO, productIds);
    });
    return res.json(payload);
  } catch (err) { next(err); }
});

// Extracted so cache-wrap and direct calls both run the same pipeline.
//
// Signature note: accepts `viewerUserId` directly (not `req`) so the admin
// console's /api/admin/agent-summary/:userId route can reuse the same pipeline
// for an arbitrary agent (the admin picks any agent and sees their summary).
// The agent-portal route wraps this with req.user.id; both share one code path.
export async function buildSummaryPayload(viewerUserId, fromISO, toISO, productIds) {
  const viewerId = viewerUserId;  // kept for readability below
  try {

    // Pull all accounts in viewer's scope in a single query. Classifier
    // columns tell us (a) which direct sub-agent each row belongs under (or
    // direct-client if NULL) and (b) whether this is the sub-agent's OWN
    // trading account (their linked client's MT5 logins).
    const { rows: accounts } = await pool.query(
      `WITH RECURSIVE subtree AS (
         -- Root: viewer
         SELECT id, name, email, parent_agent_id, linked_client_id,
                NULL::uuid AS direct_sub_id
         FROM users WHERE id = $1
         UNION ALL
         -- Descendants: each user's "direct_sub_id" is the sub-agent closest to
         -- the viewer in their ancestor chain. For the viewer's own direct
         -- children, direct_sub_id = themselves; for grandchildren and below
         -- it stays the same as their parent's direct_sub_id.
         SELECT u.id, u.name, u.email, u.parent_agent_id, u.linked_client_id,
                CASE WHEN s.id = $1 THEN u.id ELSE s.direct_sub_id END
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       own_map AS (
         -- Which user (viewer OR sub-agent) owns each linked_client. Used for
         -- the OWN-account flag and to surface the viewer's own personal
         -- trading accounts in their Summary view (they're an agent who also
         -- trades — they want to see their own book at the top).
         SELECT linked_client_id AS client_id, id AS owner_user_id, direct_sub_id
         FROM subtree
         WHERE linked_client_id IS NOT NULL
       ),
       cid_scope AS (
         -- Every client that contributes to viewer's Summary. Union of:
         --   (a) sub-agents' own client records
         --   (b) clients whose agent_id is anywhere in the subtree
         --   (c) clients whose referred_by_agent_id points at any subtree user's
         --       linked_client_id (back-compat with x-dev's CRM model)
         SELECT client_id AS id FROM own_map
         UNION
         SELECT c.id FROM clients c
           WHERE c.agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT c.id FROM clients c
           WHERE c.referred_by_agent_id IN (
             SELECT linked_client_id FROM subtree
             WHERE linked_client_id IS NOT NULL
           )
       )
       SELECT
         c.id AS client_id, c.name AS client_name, c.email AS client_email,
         c.crm_profile_type AS client_variant, c.pipeline_stage AS client_stage,
         c.agent_id AS client_agent_id,
         -- Classifier: which direct sub-agent this row groups under (NULL = direct client of viewer)
         COALESCE(
           (SELECT direct_sub_id FROM subtree su WHERE su.id = c.agent_id),
           (SELECT direct_sub_id FROM own_map om WHERE om.client_id = c.id LIMIT 1)
         ) AS direct_sub_id,
         -- Own-account flag: this is a sub-agent's personal MT5 book
         EXISTS (SELECT 1 FROM own_map om WHERE om.client_id = c.id) AS is_own_account,
         -- Account shell (current-state columns — not date-scoped)
         tam.login, tam.product_name, tam.account_type, tam.currency,
         tam.balance_cached, tam.equity_cached, tam.mt5_synced_at,
         -- Date-scoped aggregates from mt5_deal_cache. NULL date params
         -- mean "all time". Deposit/withdrawal come from balance_type rows,
         -- lots from entry=0 legs, commission from ABS of any commission.
         COALESCE(agg.period_lots,         0) AS lots_total,
         COALESCE(agg.period_commission,   0) AS commission_total,
         COALESCE(agg.period_deposits,     0) AS deposits_total,
         COALESCE(agg.period_withdrawals,  0) AS withdrawals_total,
         0 AS my_commission  -- legacy column (removed in UI mapping below)
       FROM clients c
       JOIN trading_accounts_meta tam ON tam.client_id = c.id
       LEFT JOIN (
         SELECT login,
                SUM(lots) FILTER (WHERE entry = 0)                       AS period_lots,
                SUM(ABS(commission)) FILTER (WHERE commission IS NOT NULL) AS period_commission,
                SUM(balance_amount) FILTER (WHERE balance_type = 'deposit')    AS period_deposits,
                SUM(balance_amount) FILTER (WHERE balance_type = 'withdrawal') AS period_withdrawals
         FROM mt5_deal_cache
         WHERE ($2::timestamptz IS NULL OR deal_time >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR deal_time <= $3::timestamptz)
         GROUP BY login
       ) agg ON agg.login = tam.login
       WHERE c.id IN (SELECT id FROM cid_scope)
         -- Demo accounts are excluded from the Summary: they have their own
         -- phoney balance / equity that would skew the totals. Using
         -- IS DISTINCT FROM so NULL account_type still shows (better to
         -- over-include an unknown row than silently drop it).
         AND tam.account_type IS DISTINCT FROM 'demo'
         -- Product filter. Empty array disables the filter (show everything);
         -- any non-empty array constrains to those product_source_ids.
         AND (cardinality($4::text[]) = 0 OR tam.product_source_id = ANY($4::text[]))
       ORDER BY client_name, tam.login`,
      // $1 = viewer user id, $2/$3 = date range (null = all time), $4 = product filter
      [viewerId, fromISO, toISO, productIds]
    );

    // Distinct products present in viewer's scope (for the filter chip row).
    // Always returns every product the viewer could filter by, regardless of
    // the currently-applied `products` param (so the UI can let them toggle
    // back on after narrowing).
    const { rows: availableProducts } = await pool.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, linked_client_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.linked_client_id
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       scope_cids AS (
         SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
         UNION
         SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT id FROM clients
           WHERE referred_by_agent_id IN (SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL)
       )
       SELECT tam.product_source_id AS id,
              tam.product_name      AS name,
              COUNT(*)::int         AS account_count
       FROM trading_accounts_meta tam
       WHERE tam.client_id IN (SELECT id FROM scope_cids)
         AND tam.account_type IS DISTINCT FROM 'demo'
         AND tam.product_source_id IS NOT NULL
       GROUP BY tam.product_source_id, tam.product_name
       ORDER BY account_count DESC, name`,
      [viewerId]
    );

    // Pull direct sub-agents + their metadata for the grouping shell
    const { rows: directSubs } = await pool.query(
      `SELECT u.id, u.name, u.email, u.linked_client_id, c.branch
       FROM users u
       LEFT JOIN clients c ON c.id = u.linked_client_id
       WHERE u.parent_agent_id = $1 AND u.is_agent = true AND u.is_active = true
       ORDER BY u.name`,
      [viewerId]
    );

    // Shape into nested structure
    const subMap = new Map(); // direct_sub_id → { ...meta, ownAccounts, clientsMap }
    for (const sa of directSubs) {
      subMap.set(sa.id, {
        id: sa.id,
        name: sa.name,
        email: sa.email,
        branch: sa.branch,
        ownAccounts: [],
        clientsMap: new Map(),
      });
    }
    const directClientsMap = new Map(); // client_id → { ...meta, accounts }
    // Viewer's own personal MT5 accounts — surfaced as a top-level section
    // so an agent who also trades sees their own book at the top of the
    // Summary alongside their downline. Populated from rows where
    // is_own_account=true AND direct_sub_id IS NULL (the CTE marks the
    // viewer's row that way — they're the root, not a sub).
    const ownAccounts = [];

    for (const r of accounts) {
      const account = {
        login: r.login,
        product: r.product_name,
        type: r.account_type,
        currency: r.currency,
        balance: Number(r.balance_cached) || 0,
        equity: Number(r.equity_cached) || 0,
        // The aggregates below are date-scoped per the ?from=&to= params
        // (empty range = all time) — computed by the LEFT JOIN against
        // mt5_deal_cache in the main CTE above.
        deposits: Number(r.deposits_total) || 0,
        withdrawals: Number(r.withdrawals_total) || 0,
        lots: Number(r.lots_total) || 0,
        commission: Number(r.commission_total) || 0,
        mt5_synced_at: r.mt5_synced_at,
      };

      if (r.is_own_account && !r.direct_sub_id) {
        // Viewer's own account — top-level, separate from sub-agents/clients
        ownAccounts.push(account);
      } else if (r.is_own_account && r.direct_sub_id && subMap.has(r.direct_sub_id)) {
        subMap.get(r.direct_sub_id).ownAccounts.push(account);
      } else if (r.direct_sub_id && subMap.has(r.direct_sub_id)) {
        // Client row under a sub-agent
        const sa = subMap.get(r.direct_sub_id);
        if (!sa.clientsMap.has(r.client_id)) {
          sa.clientsMap.set(r.client_id, {
            id: r.client_id,
            name: r.client_name,
            email: r.client_email,
            variant: r.client_variant === 'lead' ? 'lead' : 'client',
            stage: r.client_stage,
            accounts: [],
          });
        }
        sa.clientsMap.get(r.client_id).accounts.push(account);
      } else {
        // Direct client of viewer
        if (!directClientsMap.has(r.client_id)) {
          directClientsMap.set(r.client_id, {
            id: r.client_id,
            name: r.client_name,
            email: r.client_email,
            variant: r.client_variant === 'lead' ? 'lead' : 'client',
            stage: r.client_stage,
            accounts: [],
          });
        }
        directClientsMap.get(r.client_id).accounts.push(account);
      }
    }

    // Sum helpers
    const sumFields = ['lots', 'commission', 'balance', 'deposits', 'withdrawals', 'equity'];
    const sumOf = (items) => {
      const acc = { lots: 0, commission: 0, balance: 0, deposits: 0, withdrawals: 0, equity: 0 };
      for (const it of items) for (const f of sumFields) acc[f] += it[f] || 0;
      return acc;
    };

    // Finalise sub-agents: sum own-accounts + clients' accounts
    const subagents = [];
    for (const sa of subMap.values()) {
      const clients = [...sa.clientsMap.values()].map(c => ({
        ...c,
        ...sumOf(c.accounts),
      }));
      // Sub-agent's aggregate = sum of their own accounts + sum of all their clients' accounts
      const allAccountTotals = [
        ...sa.ownAccounts,
        ...clients.flatMap(c => c.accounts),
      ];
      subagents.push({
        id: sa.id,
        name: sa.name,
        email: sa.email,
        branch: sa.branch,
        ownAccounts: sa.ownAccounts,
        clients,
        ...sumOf(allAccountTotals),
      });
      delete sa.clientsMap; // cleanup
    }

    const directClients = [...directClientsMap.values()].map(c => ({
      ...c,
      ...sumOf(c.accounts),
    }));

    // Grand total = sum across own accounts + sub-agents (which already include
    // their own ownAccounts + clients) + direct clients. These three slices
    // are disjoint so summing is safe.
    const ownAccountsTotals = sumOf(ownAccounts);
    const grandTotal = sumOf([ownAccountsTotals, ...subagents, ...directClients]);

    // MT5 freshness summary
    let mt5_synced_at = null;
    let mt5_pending = 0;
    for (const r of accounts) {
      if (r.mt5_synced_at) {
        if (!mt5_synced_at || new Date(r.mt5_synced_at) > new Date(mt5_synced_at)) {
          mt5_synced_at = r.mt5_synced_at;
        }
      } else {
        mt5_pending++;
      }
    }

    // Strip the ISO-date suffixes we added (buildSummaryPayload receives the
    // already-suffixed strings). Format is "YYYY-MM-DD 00:00:00" / "YYYY-MM-DD 23:59:59".
    const fromOnly = fromISO ? fromISO.slice(0, 10) : null;
    const toOnly   = toISO   ? toISO.slice(0, 10)   : null;
    return {
      ownAccounts,                         // viewer's own personal MT5 accounts
      ownAccountsTotals,                   // pre-summed numbers for the row header
      subagents,
      directClients,
      grandTotal,
      range: { from: fromOnly, to: toOnly },
      filters: { products: productIds },
      availableProducts,
      mt5_synced_at,
      mt5_pending,
      total_logins: accounts.length,
    };
  } catch (err) { throw err; }
}

// POST /api/portal/summary/sync-mt5
// Triggers a snapshot refresh for every login in viewer's scope, skipping
// ones refreshed in the last `maxAge` minutes (default 15).
// Admin-only: agents see cached data; only admins can force a bridge refresh.
router.post('/sync-mt5', requirePortalAdmin, async (req, res, next) => {
  try {
    const maxAgeMinutes = Math.max(0, Number(req.query.maxAge) || 15);
    const summary = await syncSnapshotsForAgent(req.user.id, { maxAgeMinutes });
    // Invalidate the viewer's cached summary payloads so the next GET returns
    // fresh data instead of a (now stale) cached response.
    cacheInvalidate('portal.summary', `${req.user.id}|`);
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/portal/summary/mt5-status — freshness indicator for the UI
router.get('/mt5-status', async (req, res, next) => {
  try {
    const { rows: [row] } = await pool.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, linked_client_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.linked_client_id
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       scope_cids AS (
         SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
         UNION
         SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT id FROM clients
           WHERE referred_by_agent_id IN (SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL)
       )
       SELECT
         COUNT(*)::int AS total_logins,
         COUNT(*) FILTER (WHERE tam.mt5_synced_at IS NULL)::int AS pending,
         MIN(tam.mt5_synced_at) AS oldest_sync,
         MAX(tam.mt5_synced_at) AS newest_sync
       FROM trading_accounts_meta tam
       WHERE tam.client_id IN (SELECT id FROM scope_cids)
         AND tam.account_type IS DISTINCT FROM 'demo'`,
      [req.user.id]
    );
    res.json(row);
  } catch (err) { next(err); }
});

export default router;
