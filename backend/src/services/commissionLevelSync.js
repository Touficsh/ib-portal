/**
 * Commission Level Sync — pulls authoritative commission rates from xdev CRM.
 *
 * For each imported agent with an ibWallet, fetches
 *   GET /api/agent-commission-levels?ib_wallet_id=X
 * which returns `product_configs` — the per-(agent, product, MT5 group)
 * rates the CRM stores. Writes them into `crm_commission_levels`.
 *
 * Two CRM calls per agent:
 *   1. /api/contacts/:id  (to learn the agent's ibWallet _id)
 *   2. /api/agent-commission-levels?ib_wallet_id=X
 *
 * For ~543 agents that's ~1,086 calls total. Gate-throttled at 4/sec → ~5
 * minutes. Subsequent runs skip agents whose wallets haven't changed by
 * comparing the CRM's `updatedAt` against what we stored last time.
 *
 * This is the authoritative source. Once this is populated, the commission
 * engine stops reading agent_products.rate_per_lot and uses these rows.
 */
import pool from '../db/pool.js';
import { crmRequest, CrmPausedError } from './crmGate.js';

/**
 * Sync one agent's commission levels. Idempotent. Returns
 *   { agent_id, wallets_seen, configs_upserted, groups_upserted, skipped }
 */
export async function syncOneAgentCommissionLevels(agentUserId) {
  const summary = {
    agent_id: agentUserId,
    wallets_seen: 0,
    configs_upserted: 0,
    groups_upserted: 0,
    deactivated: 0,    // rows removed from CRM since last sync
    skipped: 0,
    errors: 0,
  };

  // Track every (product_id, group_name) we see in CRM during this sync so
  // the removal pass can find local rows that no longer exist upstream.
  // Same pattern as agentProductSync.js — without this, when a sales admin
  // removes a commission config from a product in CRM the local row would
  // survive forever and the engine would keep using stale rates.
  const seenInCrm = new Set();

  const { rows: [agent] } = await pool.query(
    `SELECT id, linked_client_id, name, crm_ib_wallet_id FROM users
     WHERE id = $1 AND is_agent = true AND linked_client_id IS NOT NULL`,
    [agentUserId]
  );
  if (!agent) { summary.skipped++; return summary; }

  // Step 1 — get the ibWallet id(s). If we've cached one from a previous
  // sync, use it directly (saves one CRM call per agent). Otherwise fetch
  // the contact to discover wallets, then stamp the first wallet id for
  // next time. In the common case (1 wallet per agent), re-syncs make only
  // ONE CRM call instead of two.
  let wallets;
  if (agent.crm_ib_wallet_id) {
    wallets = [{ _id: agent.crm_ib_wallet_id }];
  } else {
    let contact;
    try {
      contact = await crmRequest(`/api/contacts/${agent.linked_client_id}`);
    } catch (err) {
      if (err instanceof CrmPausedError) throw err;
      summary.errors++;
      return summary;
    }
    wallets = contact?.clientProfile?.basicInfo?.ibWallets
           || contact?.clientProfile?.ibWallets
           || contact?.ibWallets
           || [];
    // Cache the first wallet so subsequent syncs skip this round trip.
    if (wallets[0]?._id) {
      await pool.query(
        `UPDATE users SET crm_ib_wallet_id = $1 WHERE id = $2`,
        [wallets[0]._id, agentUserId]
      );
    }
  }

  for (const wallet of wallets) {
    if (!wallet?._id) continue;
    summary.wallets_seen++;

    // Step 2 — pull this wallet's commission levels
    let levels;
    try {
      const data = await crmRequest(
        `/api/agent-commission-levels?ib_wallet_id=${encodeURIComponent(wallet._id)}`
      );
      levels = Array.isArray(data) ? data : (data?.data || []);
    } catch (err) {
      if (err instanceof CrmPausedError) throw err;
      summary.errors++;
      continue;
    }
    if (levels.length === 0) continue;

    // Usually one entry per wallet, but handle defensively
    for (const level of levels) {
      const productConfigs = level.product_configs || {};
      for (const [configKey, config] of Object.entries(productConfigs)) {
        const productSourceId = config.product_id;
        if (!productSourceId) { summary.skipped++; continue; }

        // Resolve to local products.id
        const { rows: [product] } = await pool.query(
          `SELECT id FROM products WHERE source_id = $1`,
          [productSourceId]
        );
        if (!product) { summary.skipped++; continue; }

        summary.configs_upserted++;

        // CRM stores the REAL rates at the group level. If no groups, the
        // product-level fields are the fallback (treated as one synthetic "all" row).
        const groups = Array.isArray(config.groups) ? config.groups : [];

        if (groups.length === 0) {
          // Synthetic group_name=null row, using product-level values
          seenInCrm.add(`${product.id}|`);  // group=null sentinel
          await pool.query(
            `INSERT INTO crm_commission_levels
               (agent_user_id, product_id, mt5_group_name, mt5_group_source_id,
                commission_percentage, commission_per_lot,
                use_prefix, use_suffix, prefix, suffix,
                excluded_symbols, available_symbols, is_active,
                source_wallet_id, source_config_key, source_updated_at,
                synced_at)
             VALUES ($1, $2, NULL, NULL, $3, $4,
                     false, false, NULL, NULL, '{}', '{}', true,
                     $5, $6, $7, NOW())
             ON CONFLICT (agent_user_id, product_id, mt5_group_name) DO UPDATE SET
               commission_percentage = EXCLUDED.commission_percentage,
               commission_per_lot    = EXCLUDED.commission_per_lot,
               -- Re-activate the row if CRM re-adds a config that was previously
               -- deactivated (e.g. agent got rates removed then restored in CRM).
               is_active             = true,
               source_wallet_id      = EXCLUDED.source_wallet_id,
               source_config_key     = EXCLUDED.source_config_key,
               source_updated_at     = EXCLUDED.source_updated_at,
               synced_at             = NOW()`,
            [
              agentUserId, product.id,
              Number(config.commission_percentage || 0),
              Number(config.commission_per_lot || 0),
              wallet._id, configKey, level.updatedAt || null,
            ]
          );
          summary.groups_upserted++;
          continue;
        }

        for (const g of groups) {
          const groupName = g.group?.name || null;
          const groupSourceId = g.group?._id || g.group_id || null;
          seenInCrm.add(`${product.id}|${groupName || ''}`);
          const availSymbols = Array.isArray(g.available_symbols)
            ? g.available_symbols
                .map(s => typeof s === 'string' ? s : s?.symbol)
                .filter(Boolean)
            : [];
          const excluded = Array.isArray(g.excluded_symbols)
            ? g.excluded_symbols
                .map(s => typeof s === 'string' ? s : s?.symbol)
                .filter(Boolean)
            : [];

          await pool.query(
            `INSERT INTO crm_commission_levels
               (agent_user_id, product_id, mt5_group_name, mt5_group_source_id,
                commission_percentage, commission_per_lot,
                use_prefix, use_suffix, prefix, suffix,
                excluded_symbols, available_symbols, is_active,
                source_wallet_id, source_config_key, source_updated_at,
                synced_at)
             VALUES ($1, $2, $3, $4, $5, $6,
                     $7, $8, $9, $10, $11, $12, $13,
                     $14, $15, $16, NOW())
             ON CONFLICT (agent_user_id, product_id, mt5_group_name) DO UPDATE SET
               mt5_group_source_id   = EXCLUDED.mt5_group_source_id,
               commission_percentage = EXCLUDED.commission_percentage,
               commission_per_lot    = EXCLUDED.commission_per_lot,
               use_prefix            = EXCLUDED.use_prefix,
               use_suffix            = EXCLUDED.use_suffix,
               prefix                = EXCLUDED.prefix,
               suffix                = EXCLUDED.suffix,
               excluded_symbols      = EXCLUDED.excluded_symbols,
               available_symbols     = EXCLUDED.available_symbols,
               is_active             = EXCLUDED.is_active,
               source_wallet_id      = EXCLUDED.source_wallet_id,
               source_config_key     = EXCLUDED.source_config_key,
               source_updated_at     = EXCLUDED.source_updated_at,
               synced_at             = NOW()`,
            [
              agentUserId, product.id, groupName, groupSourceId,
              Number(g.commission_percentage || 0),
              Number(g.commission_per_lot || 0),
              Boolean(g.use_prefix), Boolean(g.use_suffix),
              g.prefix || null, g.suffix || null,
              excluded, availSymbols,
              g.is_active !== false,
              wallet._id, configKey, level.updatedAt || null,
            ]
          );
          summary.groups_upserted++;
        }
      }
    }
  }

  // ── Removal pass ─────────────────────────────────────────────────────
  // Find every active local row for this agent that we did NOT see during
  // the CRM call this run, and mark it inactive. This is the "Sophia's
  // commission config got removed from xdev" case — without this, that
  // stale row would survive and the engine would keep paying her based
  // on rates the CRM no longer says she has.
  //
  // Only runs when the CRM call succeeded for at least one wallet. If
  // wallets_seen is 0 (CRM error / no wallets / fetch failed), we skip
  // the removal pass — `seenInCrm` would be incomplete and we'd false-
  // positive deactivate rows.
  if (summary.wallets_seen > 0 && summary.errors === 0) {
    const { rows: localActive } = await pool.query(
      `SELECT id, product_id, mt5_group_name
       FROM crm_commission_levels
       WHERE agent_user_id = $1 AND is_active = true`,
      [agentUserId]
    );
    for (const row of localActive) {
      const key = `${row.product_id}|${row.mt5_group_name || ''}`;
      if (!seenInCrm.has(key)) {
        try {
          await pool.query(
            `UPDATE crm_commission_levels
             SET is_active = false, synced_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          summary.deactivated++;
        } catch (err) {
          console.error('[CommissionLevelSync] deactivate failed', row.id, '-', err.message);
          summary.errors++;
        }
      }
    }
  }

  // ── Push rates → agent_products ─────────────────────────────────────
  // After writing to crm_commission_levels, backfill agent_products.rate_per_lot
  // with the highest active commission_per_lot for each (agent, product).
  // This keeps the cascade validator and commission tree display in sync.
  // Zero CRM calls — pure DB.
  if (summary.wallets_seen > 0 && summary.errors === 0) {
    try {
      // Raise products.max_rate_per_lot ceiling first so cascade validates
      await pool.query(`
        UPDATE products p
        SET max_rate_per_lot = sub.max_rate, updated_at = NOW()
        FROM (
          SELECT product_id, MAX(commission_per_lot) AS max_rate
          FROM crm_commission_levels
          WHERE agent_user_id = $1 AND is_active = true AND commission_per_lot > 0
          GROUP BY product_id
        ) sub
        WHERE p.id = sub.product_id AND sub.max_rate > p.max_rate_per_lot
      `, [agentUserId]);

      // Update agent_products.rate_per_lot where CRM has a non-zero rate
      await pool.query(`
        UPDATE agent_products ap
        SET rate_per_lot = sub.best_rate, updated_at = NOW()
        FROM (
          SELECT product_id, MAX(commission_per_lot) AS best_rate
          FROM crm_commission_levels
          WHERE agent_user_id = $1 AND is_active = true AND commission_per_lot > 0
          GROUP BY product_id
        ) sub
        WHERE ap.agent_id = $1 AND ap.product_id = sub.product_id
      `, [agentUserId]);
    } catch (err) {
      console.warn('[CommissionLevelSync] agent_products push failed for', agentUserId, '-', err.message);
    }
  }

  return summary;
}

/**
 * Sync commission levels for every imported agent (or just the IDs passed in).
 *
 * Options:
 *   - agentIds: string[]      → only sync these specific user IDs (post-import use case)
 *   - maxAgents: number        → cap the total scope (useful for scheduled partial runs)
 *   - staleAfterHours: number  → skip agents whose last successful sync is more
 *                                recent than this. Default 24. Pass 0 to force a
 *                                full re-sync.
 *
 *   This is the main load-control knob. With a 24h stale window, repeatedly
 *   clicking "Sync commission rates" within a day fires 0 CRM calls — the
 *   skip pre-filter eliminates the 706-call hit. Use case: admin wants to
 *   re-confirm rates after a known CRM change → pass staleAfterHours=0.
 *
 *   - onlyChanged: bool        → DEPRECATED alias of staleAfterHours=24
 *
 * Returns an aggregate summary.
 */
export async function syncAllCommissionLevels({
  onlyChanged = false,
  maxAgents = null,
  agentIds = null,
  staleAfterHours = 24,
} = {}) {
  const start = Date.now();
  const summary = {
    agents_total: 0,
    agents_synced: 0,
    agents_skipped_recent: 0,  // skipped because synced within the freshness window
    agents_skipped: 0,           // skipped for other reasons (no wallet, etc.)
    wallets_seen: 0,
    configs_upserted: 0,
    groups_upserted: 0,
    deactivated: 0,            // commission rows removed from CRM since last sync
    errors: 0,
    stale_after_hours: staleAfterHours,
    per_agent: [],
  };

  // All imported agents, or just the ones the caller asked for.
  const useAgentIds = Array.isArray(agentIds) && agentIds.length > 0;
  const { rows: agents } = await pool.query(
    useAgentIds
      ? `SELECT id, name FROM users
         WHERE is_agent = true AND linked_client_id IS NOT NULL AND id = ANY($1::uuid[])
         ${maxAgents ? 'LIMIT ' + Number(maxAgents) : ''}`
      : `SELECT id, name FROM users
         WHERE is_agent = true AND linked_client_id IS NOT NULL
         ${maxAgents ? 'LIMIT ' + Number(maxAgents) : ''}`,
    useAgentIds ? [agentIds] : []
  );
  summary.agents_total = agents.length;

  // Build a freshness map: agent_id → MAX(synced_at) across their rows.
  // Used to skip agents whose data was refreshed inside the staleness window.
  // Single SQL trip up front avoids 706 individual lookup queries inline.
  let freshUntil = new Map();
  if (staleAfterHours > 0 && agents.length > 0) {
    const ids = agents.map(a => a.id);
    const { rows: freshness } = await pool.query(
      `SELECT agent_user_id::text AS id, MAX(synced_at) AS last_sync
       FROM crm_commission_levels
       WHERE agent_user_id = ANY($1::uuid[])
       GROUP BY agent_user_id`,
      [ids]
    );
    const cutoffMs = Date.now() - staleAfterHours * 60 * 60 * 1000;
    for (const r of freshness) {
      const t = r.last_sync ? new Date(r.last_sync).getTime() : 0;
      freshUntil.set(r.id, t);
    }
    // Skip-list: agent IDs whose last sync is newer than cutoff
    var freshSet = new Set(
      [...freshUntil.entries()]
        .filter(([, t]) => t >= cutoffMs)
        .map(([id]) => id)
    );
  } else {
    var freshSet = new Set();
  }

  for (const agent of agents) {
    if (freshSet.has(agent.id)) {
      summary.agents_skipped_recent++;
      continue;
    }
    try {
      const r = await syncOneAgentCommissionLevels(agent.id);
      summary.agents_synced++;
      summary.wallets_seen     += r.wallets_seen;
      summary.configs_upserted += r.configs_upserted;
      summary.groups_upserted  += r.groups_upserted;
      summary.deactivated      += r.deactivated || 0;
      summary.errors           += r.errors;
      if (r.groups_upserted > 0) {
        summary.per_agent.push({
          id: agent.id, name: agent.name,
          wallets: r.wallets_seen, configs: r.configs_upserted, groups: r.groups_upserted,
        });
      }
    } catch (err) {
      summary.errors++;
      if (err?.code === 'CRM_PAUSED') {
        summary.aborted_reason = 'CRM paused mid-sync';
        break;
      }
    }
  }

  summary.durationMs = Date.now() - start;
  console.log('[CommissionLevelSync] done:', {
    agents: summary.agents_synced + '/' + summary.agents_total,
    wallets: summary.wallets_seen,
    configs: summary.configs_upserted,
    groups: summary.groups_upserted,
    errors: summary.errors,
    ms: summary.durationMs,
  });
  return summary;
}
