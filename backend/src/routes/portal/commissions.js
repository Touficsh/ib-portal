/**
 * Portal — Commissions — /api/portal/commissions
 *
 * Agent-facing view of the commission ledger. An agent sees only rows where
 * `agent_id = self` — waterfall shares earned as direct agent AND as ancestor.
 *
 * Endpoints:
 *   GET /                — paginated list with filters
 *   GET /summary         — totals (count, amount) grouped by period / product
 *
 * Filters (query string):
 *   from=<ISO date>      deals on or after this date
 *   to=<ISO date>        deals strictly before this date (end-exclusive)
 *   product_id=<uuid>
 *   level=<int>          0 = direct-agent earnings, 1+ = ancestor overrides
 *   page=<int>           1-based (default 1)
 *   pageSize=<int>       default 50, max 500
 */
import { Router } from 'express';
import pool from '../../db/pool.js';
import { portalAuthenticate, requirePortalPermission } from '../../middleware/portalAuth.js';

const router = Router();
// Whole router gated by 'portal.commissions.view'. Admins bypass via
// requirePortalPermission's built-in portal.admin shortcut.
router.use(portalAuthenticate, requirePortalPermission('portal.commissions.view'));

function parseDateParam(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// GET /api/portal/commissions — paginated ledger rows for current agent
router.get('/', async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    const productId = req.query.product_id || null;
    const level = req.query.level != null ? Number(req.query.level) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const where = ['c.agent_id = $1'];
    const params = [req.user.id];
    let i = 2;
    if (from)      { where.push(`c.deal_time >= $${i++}`); params.push(from); }
    if (to)        { where.push(`c.deal_time <  $${i++}`); params.push(to); }
    if (productId) { where.push(`c.product_id = $${i++}`);  params.push(productId); }
    if (level != null && Number.isFinite(level)) { where.push(`c.level = $${i++}`); params.push(level); }

    const whereSQL = where.join(' AND ');

    // Pre-fetch the privacy gate for this viewer:
    //   for each agent in the viewer's subtree, what's the direct-sub-agent
    //   between them and the viewer (i.e. which sub-agent "owns" this row's
    //   visibility decision), and has that sub-agent granted name-sharing?
    // Source-agents that ARE the viewer get direct_sub_id = null and always
    // show full names.
    const { rows: subtreeRows } = await pool.query(
      `WITH RECURSIVE st AS (
         SELECT u.id, u.parent_agent_id,
                CASE WHEN u.parent_agent_id = $1 THEN u.id ELSE NULL END AS direct_sub_id
         FROM users u
         WHERE u.parent_agent_id = $1 AND u.is_agent = true
         UNION ALL
         SELECT u.id, u.parent_agent_id, st.direct_sub_id
         FROM users u
         JOIN st ON u.parent_agent_id = st.id
         WHERE u.is_agent = true
       )
       SELECT st.id AS user_id, st.direct_sub_id,
              COALESCE(ds.share_client_names_with_parent, false) AS share_with_parent
       FROM st
       LEFT JOIN users ds ON ds.id = st.direct_sub_id`,
      [req.user.id]
    );
    // Map: source_agent_id -> { direct_sub_id, share_with_parent }
    const privacyByAgent = new Map(
      subtreeRows.map(r => [r.user_id, {
        direct_sub_id: r.direct_sub_id,
        share_with_parent: r.share_with_parent,
      }])
    );

    const [{ rows: itemsRaw }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT c.id, c.deal_id, c.deal_time, c.client_id, c.mt5_login,
                c.product_id, p.name AS product_name, p.currency,
                c.lots, c.rate_per_lot, c.amount,
                c.commission_amount, c.rebate_amount,
                c.source_agent_id, sa.name AS source_agent_name,
                cl.name AS client_name,
                c.level, c.created_at
         FROM commissions c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN users sa ON sa.id = c.source_agent_id
         LEFT JOIN clients cl ON cl.id = c.client_id
         WHERE ${whereSQL}
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
         FROM commissions c
         WHERE ${whereSQL}`,
        params
      ),
    ]);

    // Apply the privacy redaction. Each row's source_agent_id determines
    // which sub-agent's flag controls visibility. If source_agent IS viewer
    // (own direct client) — name visible. Else — the direct sub's flag
    // decides; redacted rows return name=null + name_redacted=true so the
    // UI can render "MT5 #<login>" instead of the client's name.
    const items = itemsRaw.map(row => {
      const isOwn = row.source_agent_id === req.user.id;
      const priv = privacyByAgent.get(row.source_agent_id);
      const canShowName = isOwn
        || (priv && priv.direct_sub_id === null)
        || (priv && priv.share_with_parent === true);
      if (canShowName) return row;
      return { ...row, client_name: null, name_redacted: true };
    });

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

// GET /api/portal/commissions/summary — grouped aggregates
// groupBy ∈ { day, week, month, product, source_agent }
//   source_agent groups by the "direct descendant who sourced the deal" — i.e.
//   earnings from each sub-agent, with self = the viewer's own direct clients.
router.get('/summary', async (req, res, next) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    const groupBy = (req.query.groupBy || 'day').toLowerCase();
    const allowedGroups = {
      day:          `date_trunc('day', c.deal_time)`,
      week:         `date_trunc('week', c.deal_time)`,
      month:        `date_trunc('month', c.deal_time)`,
      product:      'c.product_id',
      source_agent: 'c.source_agent_id',
    };
    if (!allowedGroups[groupBy]) {
      return res.status(400).json({ error: `groupBy must be one of: ${Object.keys(allowedGroups).join(', ')}` });
    }
    const groupExpr = allowedGroups[groupBy];

    const where = ['c.agent_id = $1'];
    const params = [req.user.id];
    let i = 2;
    if (from) { where.push(`c.deal_time >= $${i++}`); params.push(from); }
    if (to)   { where.push(`c.deal_time <  $${i++}`); params.push(to); }

    const { rows } = await pool.query(
      `SELECT ${groupExpr} AS bucket,
              COUNT(*)::int AS deal_count,
              SUM(c.lots)::numeric(14,4) AS total_lots,
              SUM(c.amount)::numeric(14,2) AS total_amount,
              SUM(c.commission_amount)::numeric(14,2) AS total_commission,
              SUM(c.rebate_amount)::numeric(14,2) AS total_rebate
       FROM commissions c
       WHERE ${where.join(' AND ')}
       GROUP BY bucket
       ORDER BY total_amount DESC NULLS LAST, bucket ASC`,
      params
    );

    const base = rows.map(r => ({
      bucket: r.bucket,
      deal_count: r.deal_count,
      total_lots:       Number(r.total_lots || 0),
      total_amount:     Number(r.total_amount || 0),
      total_commission: Number(r.total_commission || 0),
      total_rebate:     Number(r.total_rebate || 0),
    }));

    // For product / source_agent grouping, enrich with name
    if (groupBy === 'product') {
      const ids = rows.map(r => r.bucket).filter(Boolean);
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

    if (groupBy === 'source_agent') {
      const ids = rows.map(r => r.bucket).filter(Boolean);
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
          is_self: r.bucket === req.user.id,
        })));
      }
    }

    res.json(base);
  } catch (err) { next(err); }
});

// GET /api/portal/commissions/status
//
// Agent-facing "am I set up to earn commissions?" indicator. Answers the
// question that an agent asks when they see $0 earnings: "is this real, or
// is the system not processing my data yet?"
//
// Returns a status bucket + plain-English message + diagnostic counts the
// UI can render as a banner. All answers come from local tables — zero
// external calls.
router.get('/status', async (req, res, next) => {
  try {
    const viewerId = req.user.id;

    const { rows: [d] } = await pool.query(
      `WITH subtree AS (
         -- viewer + every descendant agent (rates can be set at any level)
         SELECT id, linked_client_id FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.linked_client_id
         FROM users u JOIN subtree s ON u.parent_agent_id = s.id
         WHERE u.is_agent = true AND u.is_active = true
       ),
       scope_cids AS (
         -- all clients whose deals flow through the viewer
         SELECT linked_client_id AS id FROM subtree WHERE linked_client_id IS NOT NULL
         UNION
         SELECT id FROM clients WHERE agent_id IN (SELECT id FROM subtree)
         UNION
         SELECT id FROM clients
           WHERE referred_by_agent_id IN (
             SELECT linked_client_id FROM subtree WHERE linked_client_id IS NOT NULL
           )
       )
       SELECT
         -- Viewer's OWN rate configuration (the viewer, not descendants)
         (SELECT COUNT(*) FROM crm_commission_levels
            WHERE agent_user_id = $1 AND is_active = true
              AND (commission_percentage > 0 OR commission_per_lot > 0))::int  AS crm_levels,
         (SELECT COUNT(*) FROM agent_products
            WHERE agent_id = $1 AND is_active = true AND rate_per_lot > 0)::int AS legacy_rates,
         (SELECT COUNT(*) FROM agent_products
            WHERE agent_id = $1 AND is_active = true)::int                     AS products_assigned,
         -- Viewer's earnings ledger
         (SELECT COUNT(*)   FROM commissions WHERE agent_id = $1)::int         AS commission_rows,
         (SELECT COALESCE(SUM(amount), 0)::numeric(14,2)
            FROM commissions WHERE agent_id = $1)                              AS total_earned,
         (SELECT MAX(deal_time) FROM commissions WHERE agent_id = $1)          AS latest_deal_time,
         -- Data pipeline readiness for the viewer's subtree
         (SELECT COUNT(*) FROM subtree WHERE id != $1)::int                    AS subtree_agents,
         (SELECT COUNT(DISTINCT cl.id) FROM clients cl
            WHERE cl.id IN (SELECT id FROM scope_cids)
              AND array_length(cl.mt5_logins, 1) > 0)::int                     AS clients_with_logins,
         (SELECT COUNT(DISTINCT tam.login) FROM trading_accounts_meta tam
            WHERE tam.client_id IN (SELECT id FROM scope_cids))::int           AS logins_mapped,
         (SELECT COUNT(DISTINCT d.login) FROM mt5_deal_cache d
            JOIN trading_accounts_meta tam ON tam.login = d.login
            WHERE tam.client_id IN (SELECT id FROM scope_cids))::int           AS logins_with_cached_deals,
         -- Latest engine cycle so the UI can say "last updated X ago"
         (SELECT value FROM settings WHERE key = 'commission_last_run_at')     AS last_cycle_at`,
      [viewerId]
    );

    const has_rates = d.crm_levels > 0 || d.legacy_rates > 0;
    const has_commissions = d.commission_rows > 0;
    const subtree_has_data = d.logins_with_cached_deals > 0;

    // Classify — order matters. Pick the first condition that explains the
    // observed state.
    let status, message;
    if (!has_rates && d.commission_rows === 0) {
      status = 'no_rates';
      message = 'Your commission rates haven\'t been configured yet. Your admin can set this up in xdev CRM, then sync commission levels. You can still see deals flow through your sub-agents — you just won\'t earn until rates are set.';
    } else if (has_rates && !has_commissions && !subtree_has_data) {
      status = 'awaiting_deals';
      message = 'Your rates are configured. Commissions will populate after your clients\' MT5 deals are pulled into the system — usually within the next engine cycle.';
    } else if (has_rates && !has_commissions && subtree_has_data) {
      status = 'awaiting_next_cycle';
      message = 'Your rates are set and your sub-agents\' deals are cached. Commissions will appear after the next engine cycle runs.';
    } else if (has_commissions && d.total_earned === '0.00') {
      status = 'zero_earnings';
      message = 'You have commission records but zero dollars earned — usually means your sub-agents are taking the full rate (no override left for you). Check the Commission Tree for the breakdown.';
    } else {
      status = 'healthy';
      message = d.last_cycle_at
        ? `Commission data is current. Last engine cycle: ${d.last_cycle_at}.`
        : 'Commission data is current.';
    }

    res.json({
      status,
      message,
      diagnostics: {
        crm_levels:              d.crm_levels,
        legacy_rates:            d.legacy_rates,
        products_assigned:       d.products_assigned,
        commission_rows:         d.commission_rows,
        total_earned:            Number(d.total_earned),
        latest_deal_time:        d.latest_deal_time,
        subtree_agents:          d.subtree_agents,
        clients_with_logins:     d.clients_with_logins,
        logins_mapped:           d.logins_mapped,
        logins_with_cached_deals: d.logins_with_cached_deals,
        last_cycle_at:           d.last_cycle_at,
      },
    });
  } catch (err) { next(err); }
});

export default router;
