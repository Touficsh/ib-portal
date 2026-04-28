#!/usr/bin/env node
/**
 * sync/migrate-agents.js
 *
 * One-time migration: copy agent data from the monorepo CRM database into
 * the standalone IB Portal database.
 *
 * Usage:
 *   node sync/migrate-agents.js
 *
 * Required env vars (or pass as CLI args --src=<url> --dst=<url>):
 *   SOURCE_DATABASE_URL   — connection string for the CRM (source) database
 *   DATABASE_URL          — connection string for the IB Portal (dest) database
 *
 * Copy order respects FK constraints:
 *   1. roles
 *   2. users (is_agent=true)
 *   3. user_permission_overrides
 *   4. branches (referenced by agent users)
 *   5. products + agent_products
 *   6. crm_commission_levels
 *   7. clients (referred or contact_type=agent)
 *   8. trading_accounts_meta
 *   9. commissions
 *  10. agent_earnings_summary
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../backend/.env'), override: true });
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });

const { Pool } = pg;

// ----------------------------------------------------------------
// Parse CLI overrides: --src=<url>  --dst=<url>
// ----------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

const srcUrl = args.src || process.env.SOURCE_DATABASE_URL;
const dstUrl = args.dst || process.env.DATABASE_URL;

if (!srcUrl) {
  console.error('ERROR: SOURCE_DATABASE_URL not set (env) or --src=<url> not provided');
  process.exit(1);
}
if (!dstUrl) {
  console.error('ERROR: DATABASE_URL not set (env) or --dst=<url> not provided');
  process.exit(1);
}

function buildPool(url) {
  const isSupabase = url.includes('supabase');
  return new Pool({
    connectionString: url,
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 3,
  });
}

const src = buildPool(srcUrl);
const dst = buildPool(dstUrl);

function maskUrl(url) {
  return url.replace(/:([^:@]+)@/, ':****@');
}

async function count(pool, table, where = '') {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}${where ? ' WHERE ' + where : ''}`);
  return rows[0].n;
}

async function main() {
  console.log('Source:', maskUrl(srcUrl));
  console.log('Dest:  ', maskUrl(dstUrl));
  console.log('');

  // ----------------------------------------------------------------
  // 1. roles
  // ----------------------------------------------------------------
  console.log('--- 1. roles ---');
  const { rows: roles } = await src.query('SELECT * FROM roles');
  let rolesInserted = 0;
  for (const r of roles) {
    const res = await dst.query(
      `INSERT INTO roles (id, name, description, permissions, client_scope, is_system, is_protected, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name) DO NOTHING`,
      [r.id, r.name, r.description, r.permissions, r.client_scope, r.is_system, r.is_protected, r.created_at, r.updated_at]
    );
    rolesInserted += res.rowCount ?? 0;
  }
  console.log(`  Copied ${rolesInserted} / ${roles.length} roles (skipped existing)`);

  // ----------------------------------------------------------------
  // 2. users WHERE is_agent=true
  // ----------------------------------------------------------------
  console.log('--- 2. users (agents) ---');
  const { rows: agents } = await src.query(
    `SELECT * FROM users WHERE is_agent = true OR role = 'agent'`
  );
  const agentIds = agents.map(a => a.id);
  let usersInserted = 0;
  for (const u of agents) {
    const res = await dst.query(
      `INSERT INTO users
         (id, name, email, role, password_hash, is_active, is_agent, avatar_url,
          parent_agent_id, linked_client_id, crm_ib_wallet_id, role_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         name             = EXCLUDED.name,
         email            = EXCLUDED.email,
         role             = EXCLUDED.role,
         is_active        = EXCLUDED.is_active,
         is_agent         = EXCLUDED.is_agent,
         avatar_url       = EXCLUDED.avatar_url,
         parent_agent_id  = EXCLUDED.parent_agent_id,
         linked_client_id = EXCLUDED.linked_client_id,
         crm_ib_wallet_id = EXCLUDED.crm_ib_wallet_id,
         updated_at       = EXCLUDED.updated_at`,
      [
        u.id, u.name, u.email, u.role, u.password_hash ?? '',
        u.is_active, u.is_agent, u.avatar_url ?? null,
        u.parent_agent_id ?? null, u.linked_client_id ?? null,
        u.crm_ib_wallet_id ?? null, u.role_id ?? null,
        u.created_at, u.updated_at,
      ]
    );
    usersInserted += res.rowCount ?? 0;
  }
  console.log(`  Upserted ${usersInserted} / ${agents.length} agent users`);

  if (agentIds.length === 0) {
    console.log('No agent users found — nothing more to migrate.');
    return;
  }

  // ----------------------------------------------------------------
  // 3. user_permission_overrides
  // ----------------------------------------------------------------
  console.log('--- 3. user_permission_overrides ---');
  const { rows: overrides } = await src.query(
    `SELECT * FROM user_permission_overrides WHERE user_id = ANY($1)`,
    [agentIds]
  );
  let overridesInserted = 0;
  for (const o of overrides) {
    const res = await dst.query(
      `INSERT INTO user_permission_overrides (id, user_id, permission, granted, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, permission) DO NOTHING`,
      [o.id, o.user_id, o.permission, o.granted, o.created_at]
    );
    overridesInserted += res.rowCount ?? 0;
  }
  console.log(`  Copied ${overridesInserted} / ${overrides.length} permission overrides`);

  // ----------------------------------------------------------------
  // 4. branches referenced by those users
  // ----------------------------------------------------------------
  console.log('--- 4. branches ---');
  // Pull user_branch_scope entries + any branches by name from clients
  const { rows: userBranchScopes } = await src.query(
    `SELECT DISTINCT ubs.branch_id FROM user_branch_scope ubs WHERE ubs.user_id = ANY($1)`,
    [agentIds]
  ).catch(() => ({ rows: [] }));
  const branchIds = userBranchScopes.map(r => r.branch_id).filter(Boolean);

  let branchesInserted = 0;
  if (branchIds.length > 0) {
    const { rows: branches } = await src.query(
      `SELECT * FROM branches WHERE id = ANY($1)`,
      [branchIds]
    );
    for (const b of branches) {
      const res = await dst.query(
        `INSERT INTO branches (id, name, country, manager, source, source_id, code, location, gateway_code, is_default, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (name) DO NOTHING`,
        [b.id, b.name, b.country, b.manager, b.source, b.source_id, b.code, b.location, b.gateway_code, b.is_default, b.is_active, b.created_at, b.updated_at]
      );
      branchesInserted += res.rowCount ?? 0;
    }
    // user_branch_scope rows
    for (const ubs of userBranchScopes) {
      await dst.query(
        `INSERT INTO user_branch_scope (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [ubs.user_id, ubs.branch_id]
      ).catch(() => {});
    }
  }
  console.log(`  Copied ${branchesInserted} branches (+ ${userBranchScopes.length} scope rows)`);

  // ----------------------------------------------------------------
  // 5. products + agent_products
  // ----------------------------------------------------------------
  console.log('--- 5. products + agent_products ---');
  const { rows: agentProductRows } = await src.query(
    `SELECT * FROM agent_products WHERE agent_id = ANY($1)`,
    [agentIds]
  );
  const productIds = [...new Set(agentProductRows.map(r => r.product_id))];

  let productsInserted = 0;
  let agentProductsInserted = 0;

  if (productIds.length > 0) {
    const { rows: products } = await src.query(
      `SELECT * FROM products WHERE id = ANY($1)`,
      [productIds]
    );
    for (const p of products) {
      const res = await dst.query(
        `INSERT INTO products
           (id, name, description, max_rate_per_lot, currency, is_active, source_id, source, code, product_group, commission_per_lot, rebate_per_lot, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.description, p.max_rate_per_lot, p.currency, p.is_active, p.source_id, p.source ?? 'crm', p.code, p.product_group, p.commission_per_lot ?? 0, p.rebate_per_lot ?? 0, p.created_at, p.updated_at]
      );
      productsInserted += res.rowCount ?? 0;
    }
  }

  for (const ap of agentProductRows) {
    const res = await dst.query(
      `INSERT INTO agent_products (id, agent_id, product_id, rate_per_lot, granted_by, is_active, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (agent_id, product_id) DO NOTHING`,
      [ap.id, ap.agent_id, ap.product_id, ap.rate_per_lot, ap.granted_by, ap.is_active, ap.source ?? 'crm', ap.created_at, ap.updated_at]
    );
    agentProductsInserted += res.rowCount ?? 0;
  }
  console.log(`  Copied ${productsInserted} products, ${agentProductsInserted} agent_products`);

  // ----------------------------------------------------------------
  // 6. crm_commission_levels
  // ----------------------------------------------------------------
  console.log('--- 6. crm_commission_levels ---');
  const { rows: ccls } = await src.query(
    `SELECT * FROM crm_commission_levels WHERE agent_user_id = ANY($1)`,
    [agentIds]
  );
  let cclsInserted = 0;
  for (const c of ccls) {
    const res = await dst.query(
      `INSERT INTO crm_commission_levels
         (id, agent_user_id, product_id, mt5_group_name, mt5_group_source_id,
          commission_percentage, commission_per_lot, prefix, suffix, use_prefix, use_suffix,
          excluded_symbols, available_symbols, is_active, source_wallet_id, source_config_key,
          source_updated_at, override_commission_percentage, override_commission_per_lot,
          override_reason, override_by_user_id, override_set_at, synced_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (agent_user_id, product_id, mt5_group_name) DO NOTHING`,
      [
        c.id, c.agent_user_id, c.product_id, c.mt5_group_name, c.mt5_group_source_id,
        c.commission_percentage, c.commission_per_lot, c.prefix, c.suffix, c.use_prefix, c.use_suffix,
        c.excluded_symbols, c.available_symbols, c.is_active, c.source_wallet_id, c.source_config_key,
        c.source_updated_at, c.override_commission_percentage, c.override_commission_per_lot,
        c.override_reason, c.override_by_user_id, c.override_set_at, c.synced_at, c.created_at,
      ]
    );
    cclsInserted += res.rowCount ?? 0;
  }
  console.log(`  Copied ${cclsInserted} / ${ccls.length} crm_commission_levels`);

  // ----------------------------------------------------------------
  // 7. clients (referred by agents OR contact_type='agent')
  // ----------------------------------------------------------------
  console.log('--- 7. clients ---');
  const { rows: clients } = await src.query(
    `SELECT * FROM clients
     WHERE agent_id = ANY($1)
        OR referred_by_agent_id IN (
             SELECT linked_client_id::varchar FROM users WHERE id = ANY($1) AND linked_client_id IS NOT NULL
           )
        OR contact_type = 'agent'`,
    [agentIds]
  );
  let clientsInserted = 0;
  for (const c of clients) {
    const res = await dst.query(
      `INSERT INTO clients
         (id, contact_type, mt5_logins, referred_by_agent_id, assigned_rep_id, agent_id, product_id,
          pipeline_stage, tags, respond_contact_id, name, email, phone, country, date_of_birth,
          registration_date, detail_enriched_at, trading_accounts_synced_at, branch, is_verified,
          is_trader, crm_profile_type, source, lead_source, first_deposit_at, assigned_at,
          first_contact_at, response_time_seconds, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       ON CONFLICT (id) DO UPDATE SET
         name                       = EXCLUDED.name,
         email                      = EXCLUDED.email,
         phone                      = EXCLUDED.phone,
         country                    = EXCLUDED.country,
         pipeline_stage             = EXCLUDED.pipeline_stage,
         agent_id                   = EXCLUDED.agent_id,
         product_id                 = EXCLUDED.product_id,
         is_verified                = EXCLUDED.is_verified,
         is_trader                  = EXCLUDED.is_trader,
         first_deposit_at           = EXCLUDED.first_deposit_at,
         trading_accounts_synced_at = EXCLUDED.trading_accounts_synced_at,
         updated_at                 = EXCLUDED.updated_at`,
      [
        c.id, c.contact_type, c.mt5_logins, c.referred_by_agent_id, c.assigned_rep_id,
        c.agent_id, c.product_id, c.pipeline_stage, c.tags, c.respond_contact_id,
        c.name, c.email, c.phone, c.country, c.date_of_birth, c.registration_date,
        c.detail_enriched_at, c.trading_accounts_synced_at, c.branch, c.is_verified,
        c.is_trader, c.crm_profile_type, c.source, c.lead_source, c.first_deposit_at,
        c.assigned_at, c.first_contact_at, c.response_time_seconds, c.created_at, c.updated_at,
      ]
    );
    clientsInserted += res.rowCount ?? 0;
  }
  const clientIds = clients.map(c => c.id);
  console.log(`  Upserted ${clientsInserted} / ${clients.length} clients`);

  // ----------------------------------------------------------------
  // 8. trading_accounts_meta
  // ----------------------------------------------------------------
  console.log('--- 8. trading_accounts_meta ---');
  let tamInserted = 0;
  if (clientIds.length > 0) {
    const { rows: tams } = await src.query(
      `SELECT * FROM trading_accounts_meta WHERE client_id = ANY($1)`,
      [clientIds]
    );
    for (const t of tams) {
      const res = await dst.query(
        `INSERT INTO trading_accounts_meta
           (login, client_id, source_id, name, account_type, product_name, product_source_id,
            currency, balance_cached, equity_cached, deposits_total, withdrawals_total, lots_total,
            commission_total, status, mt5_group, created_at_source, last_synced_at, mt5_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (login) DO UPDATE SET
           client_id         = EXCLUDED.client_id,
           balance_cached    = EXCLUDED.balance_cached,
           equity_cached     = EXCLUDED.equity_cached,
           deposits_total    = EXCLUDED.deposits_total,
           withdrawals_total = EXCLUDED.withdrawals_total,
           lots_total        = EXCLUDED.lots_total,
           commission_total  = EXCLUDED.commission_total,
           mt5_group         = EXCLUDED.mt5_group,
           last_synced_at    = EXCLUDED.last_synced_at,
           mt5_synced_at     = EXCLUDED.mt5_synced_at`,
        [
          t.login, t.client_id, t.source_id, t.name, t.account_type, t.product_name,
          t.product_source_id, t.currency, t.balance_cached, t.equity_cached, t.deposits_total,
          t.withdrawals_total, t.lots_total, t.commission_total, t.status, t.mt5_group,
          t.created_at_source, t.last_synced_at, t.mt5_synced_at,
        ]
      );
      tamInserted += res.rowCount ?? 0;
    }
    console.log(`  Upserted ${tamInserted} / ${tams.length} trading_accounts_meta`);
  } else {
    console.log('  Skipped (no clients)');
  }

  // ----------------------------------------------------------------
  // 9. commissions
  // ----------------------------------------------------------------
  console.log('--- 9. commissions ---');
  let commissionsInserted = 0;
  if (agentIds.length > 0) {
    const { rows: comms } = await src.query(
      `SELECT * FROM commissions WHERE agent_id = ANY($1)`,
      [agentIds]
    );
    for (const c of comms) {
      const res = await dst.query(
        `INSERT INTO commissions
           (id, deal_id, client_id, mt5_login, product_id, agent_id, lots, rate_per_lot,
            amount, commission_amount, rebate_amount, source_agent_id, level, deal_time, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (deal_id, agent_id) DO NOTHING`,
        [
          c.id, c.deal_id, c.client_id, c.mt5_login, c.product_id, c.agent_id,
          c.lots, c.rate_per_lot, c.amount, c.commission_amount, c.rebate_amount,
          c.source_agent_id, c.level, c.deal_time, c.created_at,
        ]
      );
      commissionsInserted += res.rowCount ?? 0;
    }
    console.log(`  Copied ${commissionsInserted} / ${comms.length} commissions`);
  } else {
    console.log('  Skipped (no agents)');
  }

  // ----------------------------------------------------------------
  // 10. agent_earnings_summary
  // ----------------------------------------------------------------
  console.log('--- 10. agent_earnings_summary ---');
  let aesInserted = 0;
  if (agentIds.length > 0) {
    const { rows: aes } = await src.query(
      `SELECT * FROM agent_earnings_summary WHERE agent_id = ANY($1)`,
      [agentIds]
    );
    for (const a of aes) {
      const res = await dst.query(
        `INSERT INTO agent_earnings_summary
           (agent_id, period_month, commission_amount, rebate_amount, total_amount, deal_count, lots_total, client_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (agent_id, period_month) DO UPDATE SET
           commission_amount = EXCLUDED.commission_amount,
           rebate_amount     = EXCLUDED.rebate_amount,
           total_amount      = EXCLUDED.total_amount,
           deal_count        = EXCLUDED.deal_count,
           lots_total        = EXCLUDED.lots_total,
           client_count      = EXCLUDED.client_count,
           updated_at        = EXCLUDED.updated_at`,
        [a.agent_id, a.period_month, a.commission_amount, a.rebate_amount, a.total_amount, a.deal_count, a.lots_total, a.client_count, a.updated_at]
      );
      aesInserted += res.rowCount ?? 0;
    }
    console.log(`  Upserted ${aesInserted} / ${aes.length} agent_earnings_summary rows`);
  } else {
    console.log('  Skipped (no agents)');
  }

  console.log('');
  console.log('Migration complete.');
}

main()
  .catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  });
