/**
 * Portal — Trading Accounts — /api/portal/trading-accounts
 *
 * Returns every MT5 login across the signed-in agent's subtree (or a filtered
 * slice). One row per (client, login) pair, enriched with where in the tree
 * the client sits so the UI can filter by source.
 *
 * `source` classifier on each row:
 *   mine             → the agent's own MT5 login (rare — most agents don't trade)
 *   direct_client    → referred_by_agent_id = agent.linked_client_id (and client-type 'individual')
 *   subagent         → a sub-agent in the tree who happens to have an MT5 login
 *   subagent_client  → end-client referred by someone in my subtree
 *
 * Query params:
 *   ?filter=mine|direct_client|subagent|subagent_client|all   (default all)
 *   ?q=<search>     name / email / login
 *   ?page= / ?pageSize=
 */
import { Router } from 'express';
import * as XLSX from 'xlsx';
import pool from '../../db/pool.js';
import { portalAuthenticate, requireAgentAccess, requirePortalAdmin } from '../../middleware/portalAuth.js';
import { syncForAgent } from '../../services/tradingAccountMetaSync.js';

const SOURCE_LABELS = {
  mine:            'Mine',
  direct_client:   'Direct client',
  subagent:        'Sub-agent',
  subagent_client: "Sub-agent's client",
};

const router = Router();
router.use(portalAuthenticate, requireAgentAccess);

// POST /api/portal/trading-accounts/sync-meta
// Refreshes product / type / created_at cache for every MT5 login in the
// agent's subtree from x-dev's /api/contacts/:id/trading-accounts.
// Admin-only: agents see cached metadata; only admins can force a CRM refresh.
router.post('/sync-meta', requirePortalAdmin, async (req, res, next) => {
  try {
    const maxAgeMinutes = Math.max(0, Number(req.query.maxAge) || 60);
    const summary = await syncForAgent(req.user.id, { maxAgeMinutes });
    res.json(summary);
  } catch (err) { next(err); }
});

// GET /api/portal/trading-accounts/export.xlsx
//   Returns an .xlsx file of every MT5 account matching the current filter+q
//   (no pagination). Uses the same base CTE as the list endpoint so exports
//   line up exactly with what the agent sees on the page.
//
//   Excel is generated with the `xlsx` dep already present in backend/package.json.
//   Hard-cap at 20,000 rows so a runaway tree doesn't OOM the Node process.
router.get('/export.xlsx', async (req, res, next) => {
  try {
    const { rows: [me] } = await pool.query(
      'SELECT id, linked_client_id, name FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!me) return res.status(404).json({ error: 'Agent not found' });

    const filter = (req.query.filter || 'all').toLowerCase();
    const validFilters = new Set(['all', 'mine', 'direct_client', 'subagent', 'subagent_client']);
    if (!validFilters.has(filter)) {
      return res.status(400).json({ error: `filter must be one of: ${[...validFilters].join(', ')}` });
    }
    const q = req.query.q ? String(req.query.q).trim() : '';
    const agentIdFilter = req.query.agent_id ? String(req.query.agent_id) : null;

    // Reuse the same CTE shape as the list endpoint
    const baseSql = `
      WITH RECURSIVE
        subtree_users AS (
          SELECT id, linked_client_id FROM users WHERE id = $1
          UNION ALL
          SELECT u.id, u.linked_client_id
          FROM users u JOIN subtree_users s ON u.parent_agent_id = s.id
          WHERE u.is_agent = true
        ),
        sub_users_only AS (
          SELECT id, linked_client_id FROM subtree_users WHERE id <> $1
        ),
        flattened AS (
          SELECT c.id AS client_id, c.name AS client_name, c.email, c.phone, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch,
                 COALESCE(m.product_name, p.name) AS product_name,
                 m.account_type, m.created_at_source, m.currency, m.balance_cached,
                 ta.login AS mt5_login, 'mine' AS source,
                 c.name AS agent_name,
                 $1::uuid AS agent_user_id
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (SELECT UNNEST(c.mt5_logins) AS login) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.id = $2 AND array_length(c.mt5_logins, 1) > 0

          UNION ALL

          SELECT c.id, c.name, c.email, c.phone, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch, COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.balance_cached,
                 ta.login, 'direct_client',
                 (SELECT name FROM clients WHERE id = $2),
                 $1::uuid
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (SELECT UNNEST(c.mt5_logins) AS login) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.referred_by_agent_id = $2
            AND c.contact_type = 'individual'
            AND array_length(c.mt5_logins, 1) > 0

          UNION ALL

          SELECT c.id, c.name, c.email, c.phone, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch, COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.balance_cached,
                 ta.login, 'subagent',
                 c.name, s.id
          FROM clients c
          JOIN sub_users_only s ON s.linked_client_id = c.id
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (SELECT UNNEST(c.mt5_logins) AS login) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE array_length(c.mt5_logins, 1) > 0

          UNION ALL

          -- parent_agent JOINs must come BEFORE the comma-LATERAL so c is still in scope
          SELECT c.id, c.name, c.email, c.phone, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch, COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.balance_cached,
                 ta.login, 'subagent_client',
                 parent_agent.name, parent_agent_user.id
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id
          LEFT JOIN clients parent_agent ON parent_agent.id = c.referred_by_agent_id
          LEFT JOIN users parent_agent_user ON parent_agent_user.linked_client_id = parent_agent.id,
               LATERAL (SELECT UNNEST(c.mt5_logins) AS login) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.referred_by_agent_id IN (SELECT linked_client_id FROM sub_users_only)
            AND c.contact_type = 'individual'
            AND array_length(c.mt5_logins, 1) > 0
        )
    `;

    const where = [];
    const params = [req.user.id, me.linked_client_id];
    let i = 3;
    if (filter !== 'all') { where.push(`source = $${i++}`); params.push(filter); }
    if (agentIdFilter) { where.push(`agent_user_id = $${i++}::uuid`); params.push(agentIdFilter); }
    if (q) {
      where.push(`(LOWER(client_name) LIKE $${i} OR LOWER(email) LIKE $${i} OR mt5_login LIKE $${i})`);
      params.push(`%${q.toLowerCase()}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `${baseSql}
       SELECT * FROM flattened ${whereSql}
       ORDER BY first_deposit_at DESC NULLS LAST, client_name, mt5_login
       LIMIT 20000`,
      params
    );

    // Shape human-friendly columns in stable order; ISO date for Excel sorting.
    const exportRows = rows.map(r => ({
      'Source':          SOURCE_LABELS[r.source] || r.source,
      'Agent':           r.agent_name || '',
      'Client Name':     r.client_name || '',
      'Email':           r.email || '',
      'Phone':           r.phone || '',
      'MT5 Login':       r.mt5_login ? Number(r.mt5_login) : '',
      'Product':         r.product_name || '',
      'Account Type':    r.account_type || '',
      'Created':         r.created_at_source
                            ? new Date(r.created_at_source).toISOString().slice(0, 10)
                            : '',
      'Currency':        r.currency || '',
      'Balance (cached)':r.balance_cached != null ? Number(r.balance_cached) : '',
      'Pipeline Stage':  r.pipeline_stage || '',
      'Profile Type':    r.crm_profile_type || '',
      'FTD':             r.first_deposit_at ? 'Yes' : 'No',
      'Branch':          r.branch || '',
      'Country':         r.country || '',
    }));

    const ws = XLSX.utils.json_to_sheet(exportRows, { dateNF: 'yyyy-mm-dd' });
    // Reasonable default column widths so it opens cleanly in Excel
    ws['!cols'] = [
      { wch: 18 }, { wch: 24 }, { wch: 26 }, { wch: 28 }, { wch: 18 },
      { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
      { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
      { wch:  6 }, { wch: 18 }, { wch: 14 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trading Accounts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const slug = (me.name || 'agent').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const filenameParts = ['trading-accounts', slug, today];
    if (filter !== 'all') filenameParts.push(filter);
    if (agentIdFilter) {
      // Append a short chunk of the agent's name to the filename for clarity
      try {
        const { rows: [a] } = await pool.query('SELECT name FROM users WHERE id = $1', [agentIdFilter]);
        if (a?.name) {
          filenameParts.push(a.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30));
        }
      } catch { /* non-fatal */ }
    }
    const filename = filenameParts.join('_') + '.xlsx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Row-Count', String(exportRows.length));
    res.send(buf);
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.end();
  }
});

// GET /api/portal/trading-accounts/agents-in-scope
// Feeds the "filter by agent" dropdown on the Trading Accounts page.
// Returns every agent in the signed-in user's subtree (including themselves)
// with a per-agent count of trading accounts. "Trading accounts for agent X"
// means rows whose agent_user_id == X in the main query — i.e., X's own MT5
// logins + X's direct clients' MT5 logins. It does NOT include X's
// sub-agents' books (those belong to the sub-agent).
router.get('/agents-in-scope', async (req, res, next) => {
  try {
    const { rows: [me] } = await pool.query(
      'SELECT id, linked_client_id FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!me) return res.status(404).json({ error: 'Agent not found' });

    const { rows } = await pool.query(
      `WITH RECURSIVE subtree_users AS (
         SELECT id, name, linked_client_id, parent_agent_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.name, u.linked_client_id, u.parent_agent_id
         FROM users u JOIN subtree_users s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       )
       SELECT s.id AS user_id,
              s.name,
              (s.id = $1) AS is_self,
              -- Own MT5 logins (agent has a client row with mt5_logins)
              COALESCE((SELECT COALESCE(array_length(c.mt5_logins, 1), 0)
                        FROM clients c WHERE c.id = s.linked_client_id), 0) AS own_mt5_count,
              -- Direct individual clients' MT5 logins
              COALESCE((SELECT SUM(COALESCE(array_length(c.mt5_logins, 1), 0))::int
                        FROM clients c
                        WHERE c.referred_by_agent_id = s.linked_client_id
                          AND c.contact_type = 'individual'), 0) AS client_mt5_count
       FROM subtree_users s
       ORDER BY is_self DESC, (
         COALESCE((SELECT COALESCE(array_length(c.mt5_logins, 1), 0)
                   FROM clients c WHERE c.id = s.linked_client_id), 0)
         +
         COALESCE((SELECT SUM(COALESCE(array_length(c.mt5_logins, 1), 0))::int
                   FROM clients c
                   WHERE c.referred_by_agent_id = s.linked_client_id
                     AND c.contact_type = 'individual'), 0)
       ) DESC, s.name`,
      [req.user.id]
    );

    res.json(rows.map(r => ({
      user_id: r.user_id,
      name: r.name,
      is_self: r.is_self,
      total_count: (r.own_mt5_count || 0) + (r.client_mt5_count || 0),
      own_mt5_count: r.own_mt5_count || 0,
      client_mt5_count: r.client_mt5_count || 0,
    })));
  } catch (err) { next(err); }
});

// GET /api/portal/trading-accounts/meta-status — freshness indicator for the UI
router.get('/meta-status', async (req, res, next) => {
  try {
    const { rows: [row] } = await pool.query(
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
       SELECT COUNT(*)::int                        AS total_clients_with_logins,
              COUNT(m.login)::int                  AS logins_with_meta,
              MIN(m.last_synced_at)                AS oldest_meta,
              MAX(m.last_synced_at)                AS newest_meta
       FROM clients c
       LEFT JOIN trading_accounts_meta m ON m.client_id = c.id
       WHERE c.id IN (SELECT id FROM subtree_client_ids)
         AND c.mt5_logins IS NOT NULL
         AND array_length(c.mt5_logins, 1) > 0`,
      [req.user.id]
    );
    res.json(row);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows: [me] } = await pool.query(
      'SELECT id, linked_client_id FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!me) return res.status(404).json({ error: 'Agent not found' });

    const filter = (req.query.filter || 'all').toLowerCase();
    const validFilters = new Set(['all', 'mine', 'direct_client', 'subagent', 'subagent_client']);
    if (!validFilters.has(filter)) {
      return res.status(400).json({ error: `filter must be one of: ${[...validFilters].join(', ')}` });
    }

    const q = req.query.q ? String(req.query.q).trim() : '';
    const agentIdFilter = req.query.agent_id ? String(req.query.agent_id) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    // Build per-source queries sharing a UNION ALL; apply filters and pagination
    // at the end. CTEs:
    //   me_client       → my own client row (if any — rare for agents to have MT5)
    //   subtree_clients → every client-id in my subtree (individuals + agents, recursive)
    //   direct_clients  → my direct individuals
    //   sub_agent_cids  → sub-agent client ids (their linked_client_id)
    //   subagent_client_clients → end-clients referred by anyone in my subtree except me
    //
    // Then UNNEST each set's mt5_logins into (client, login) rows with a source label.
    // The CTE unfurls (client, login) pairs per source segment. UNNEST happens
    // inside each branch to avoid a LATERAL that references a UNION ALL result
    // (Postgres errors with "invalid reference to FROM-clause entry" in that case).
    const baseSql = `
      WITH RECURSIVE
        subtree_users AS (
          SELECT id, linked_client_id FROM users WHERE id = $1
          UNION ALL
          SELECT u.id, u.linked_client_id
          FROM users u JOIN subtree_users s ON u.parent_agent_id = s.id
          WHERE u.is_agent = true
        ),
        sub_users_only AS (
          SELECT id, linked_client_id FROM subtree_users WHERE id <> $1
        ),
        flattened AS (
          -- MINE: the agent is the signed-in user themselves (c.name == my name).
          SELECT c.id AS client_id, c.name AS client_name, c.email, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch,
                 COALESCE(m.product_name, p.name) AS product_name,
                 m.account_type, m.created_at_source, m.currency, m.last_synced_at,
                 ta.login AS mt5_login, ta.login_ordinal,
                 'mine' AS source,
                 c.name AS agent_name,            -- self
                 c.id   AS agent_client_id,
                 $1::uuid AS agent_user_id
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (
                 SELECT UNNEST(c.mt5_logins) AS login,
                        generate_subscripts(c.mt5_logins, 1) AS login_ordinal
               ) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.id = $2 AND array_length(c.mt5_logins, 1) > 0

          UNION ALL

          -- DIRECT CLIENT: agent is me (signed-in user) via c.referred_by_agent_id = $2
          SELECT c.id, c.name, c.email, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch,
                 COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.last_synced_at,
                 ta.login, ta.login_ordinal,
                 'direct_client',
                 (SELECT name FROM clients WHERE id = $2) AS agent_name,
                 $2 AS agent_client_id,
                 $1::uuid AS agent_user_id
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (
                 SELECT UNNEST(c.mt5_logins) AS login,
                        generate_subscripts(c.mt5_logins, 1) AS login_ordinal
               ) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.referred_by_agent_id = $2
            AND c.contact_type = 'individual'
            AND array_length(c.mt5_logins, 1) > 0

          UNION ALL

          -- SUBAGENT: the client row IS the sub-agent, so c.name == agent.
          -- agent_user_id looked up via sub_users_only linkage so the UI can
          -- deep-link to that sub-agent's /admin/agents/:id (or /sub-agents/:id).
          SELECT c.id, c.name, c.email, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch,
                 COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.last_synced_at,
                 ta.login, ta.login_ordinal,
                 'subagent',
                 c.name AS agent_name,
                 c.id   AS agent_client_id,
                 s.id   AS agent_user_id
          FROM clients c
          JOIN sub_users_only s ON s.linked_client_id = c.id
          LEFT JOIN products p ON p.id = c.product_id,
               LATERAL (
                 SELECT UNNEST(c.mt5_logins) AS login,
                        generate_subscripts(c.mt5_logins, 1) AS login_ordinal
               ) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE array_length(c.mt5_logins, 1) > 0

          UNION ALL

          -- SUBAGENT CLIENT: agent is the sub-agent referenced by
          -- c.referred_by_agent_id. JOIN clients to get the name + JOIN users
          -- via linked_client_id to get the portal user_id (null if that
          -- sub-agent hasn't been imported into the portal yet).
          --
          -- Important: the parent_agent JOINs must come BEFORE the comma-LATERAL
          -- so \`c\` is still in scope for them. Otherwise Postgres reports
          -- "invalid reference to FROM-clause entry for table c".
          SELECT c.id, c.name, c.email, c.country,
                 c.pipeline_stage, c.crm_profile_type, c.is_trader, c.first_deposit_at,
                 c.branch,
                 COALESCE(m.product_name, p.name),
                 m.account_type, m.created_at_source, m.currency, m.last_synced_at,
                 ta.login, ta.login_ordinal,
                 'subagent_client',
                 parent_agent.name AS agent_name,
                 parent_agent.id   AS agent_client_id,
                 parent_agent_user.id AS agent_user_id
          FROM clients c
          LEFT JOIN products p ON p.id = c.product_id
          LEFT JOIN clients parent_agent ON parent_agent.id = c.referred_by_agent_id
          LEFT JOIN users parent_agent_user ON parent_agent_user.linked_client_id = parent_agent.id,
               LATERAL (
                 SELECT UNNEST(c.mt5_logins) AS login,
                        generate_subscripts(c.mt5_logins, 1) AS login_ordinal
               ) ta
          LEFT JOIN trading_accounts_meta m ON m.login = ta.login
          WHERE c.referred_by_agent_id IN (SELECT linked_client_id FROM sub_users_only)
            AND c.contact_type = 'individual'
            AND array_length(c.mt5_logins, 1) > 0
        )
    `;

    const where = [];
    const params = [req.user.id, me.linked_client_id];
    let i = 3;
    if (filter !== 'all') {
      where.push(`source = $${i++}`);
      params.push(filter);
    }
    if (agentIdFilter) {
      where.push(`agent_user_id = $${i++}::uuid`);
      params.push(agentIdFilter);
    }
    if (q) {
      where.push(`(LOWER(client_name) LIKE $${i} OR LOWER(email) LIKE $${i} OR mt5_login LIKE $${i})`);
      params.push(`%${q.toLowerCase()}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ rows: items }, { rows: [count] }, { rows: breakdown }] = await Promise.all([
      pool.query(
        `${baseSql}
         SELECT * FROM flattened ${whereSql}
         ORDER BY first_deposit_at DESC NULLS LAST, client_name, login_ordinal
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(
        `${baseSql} SELECT COUNT(*)::int AS c FROM flattened ${whereSql}`,
        params
      ),
      // Always return the full per-source breakdown so the filter dropdown
      // shows accurate counts regardless of current filter.
      pool.query(
        `${baseSql}
         SELECT source, COUNT(*)::int AS c FROM flattened GROUP BY source`,
        [req.user.id, me.linked_client_id]
      ),
    ]);

    const counts = { mine: 0, direct_client: 0, subagent: 0, subagent_client: 0 };
    for (const b of breakdown) counts[b.source] = b.c;
    counts.all = counts.mine + counts.direct_client + counts.subagent + counts.subagent_client;

    res.json({
      items,
      counts,
      pagination: { page, pageSize, total: count.c },
    });
  } catch (err) { next(err); }
});

export default router;
