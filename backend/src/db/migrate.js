export const migration = `
-- ============================================================
-- IB Agent Portal — standalone schema
-- All statements are idempotent (CREATE/ALTER IF NOT EXISTS).
-- ============================================================

-- Users table (agents, admins)
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) UNIQUE NOT NULL,
  role             VARCHAR(20) NOT NULL DEFAULT 'agent'
                   CHECK (role IN ('admin', 'agent', 'readonly')),
  password_hash    VARCHAR(255) NOT NULL DEFAULT '',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  is_agent         BOOLEAN NOT NULL DEFAULT false,
  avatar_url       VARCHAR(500),
  parent_agent_id  UUID REFERENCES users(id),
  linked_client_id VARCHAR(255),
  crm_ib_wallet_id VARCHAR(100),
  role_id          UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_parent_agent    ON users(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_users_is_agent        ON users(is_agent) WHERE is_agent = true;
CREATE INDEX IF NOT EXISTS idx_users_linked_client   ON users(linked_client_id);
CREATE INDEX IF NOT EXISTS idx_users_crm_ib_wallet_id ON users(crm_ib_wallet_id) WHERE crm_ib_wallet_id IS NOT NULL;

-- Privacy opt-in: when a sub-agent sets this to true, the agent directly
-- above them can see their full client names in views like Agent Summary
-- and Commissions. Default false (private). Read by buildSummaryPayload
-- and the portal commission list endpoint to redact client_name on rows
-- that fall under a sub-agent who hasn't granted permission. Admin views
-- bypass this entirely (admins see all PII). See OWNER_HANDBOOK §Privacy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_client_names_with_parent
  BOOLEAN NOT NULL DEFAULT false;

-- Roles table (RBAC)
CREATE TABLE IF NOT EXISTS roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(50) NOT NULL UNIQUE,
  description   TEXT,
  permissions   TEXT[] NOT NULL DEFAULT '{}',
  client_scope  VARCHAR(20) NOT NULL DEFAULT 'assigned'
                CHECK (client_scope IN ('all', 'assigned')),
  is_system     BOOLEAN NOT NULL DEFAULT false,
  is_protected  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add role_id FK on users now that roles exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_id_fkey'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES roles(id);
  END IF;
END $$;

-- User-level permission overrides
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission    VARCHAR(50) NOT NULL,
  granted       BOOLEAN NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_user_overrides_user ON user_permission_overrides(user_id);

-- User branch scope (restricts user visibility to specific branches)
CREATE TABLE IF NOT EXISTS user_branch_scope (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id   UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_user_branch_scope_user   ON user_branch_scope(user_id);
CREATE INDEX IF NOT EXISTS idx_user_branch_scope_branch ON user_branch_scope(branch_id);

-- Settings key-value store
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- System-wide audit log for financial + admin actions.
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email     VARCHAR(255),
  actor_role      VARCHAR(50),
  action          VARCHAR(80) NOT NULL,
  entity_type     VARCHAR(50),
  entity_id       VARCHAR(255),
  before          JSONB,
  after           JSONB,
  metadata        JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity      ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time        ON audit_log(created_at DESC);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(50) NOT NULL,
  title           VARCHAR(255) NOT NULL,
  message         TEXT NOT NULL,
  icon            VARCHAR(20),
  color           VARCHAR(20),
  link            VARCHAR(255),
  reference_id    VARCHAR(255),
  reference_type  VARCHAR(50),
  is_read         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread  ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(user_id, created_at DESC);

-- Branches table
CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  country     VARCHAR(100),
  manager     VARCHAR(200),
  source      VARCHAR(20) NOT NULL DEFAULT 'manual'
              CHECK (source IN ('crm', 'manual')),
  source_id   VARCHAR(255),
  code        VARCHAR(50),
  location    VARCHAR(255),
  gateway_code VARCHAR(100),
  is_default  BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_name      ON branches(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_branches_active    ON branches(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_source_id ON branches(source_id) WHERE source_id IS NOT NULL;

-- Now add the FK on user_branch_scope.branch_id
ALTER TABLE user_branch_scope ADD COLUMN IF NOT EXISTS branch_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_branch_scope_branch_id_fkey'
  ) THEN
    ALTER TABLE user_branch_scope ADD CONSTRAINT user_branch_scope_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Products (admin-defined rate ceilings per tradable product)
CREATE TABLE IF NOT EXISTS products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(100) NOT NULL,
  description         TEXT,
  max_rate_per_lot    DECIMAL(10,2) NOT NULL CHECK (max_rate_per_lot >= 0),
  currency            VARCHAR(10) NOT NULL DEFAULT 'USD',
  is_active           BOOLEAN NOT NULL DEFAULT true,
  source_id           VARCHAR(255),
  source              VARCHAR(20) NOT NULL DEFAULT 'manual',
  code                VARCHAR(50),
  product_group       VARCHAR(100),
  commission_per_lot  DECIMAL(10,2) DEFAULT 0 CHECK (commission_per_lot >= 0),
  rebate_per_lot      DECIMAL(10,2) DEFAULT 0 CHECK (rebate_per_lot >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_source_id ON products(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id                          VARCHAR(255) PRIMARY KEY,
  contact_type                VARCHAR(20) NOT NULL DEFAULT 'individual'
                              CHECK (contact_type IN ('individual', 'agent')),
  mt5_logins                  VARCHAR[] DEFAULT '{}',
  referred_by_agent_id        VARCHAR(255) REFERENCES clients(id),
  assigned_rep_id             UUID REFERENCES users(id),
  agent_id                    UUID REFERENCES users(id),
  product_id                  UUID REFERENCES products(id),
  pipeline_stage              VARCHAR(50) NOT NULL DEFAULT 'Lead'
                              CHECK (pipeline_stage IN ('Lead', 'Contacted', 'Funded', 'Active', 'Churned')),
  tags                        TEXT[] DEFAULT '{}',
  respond_contact_id          VARCHAR(255),
  name                        VARCHAR(255) NOT NULL,
  email                       VARCHAR(255),
  phone                       VARCHAR(100),
  country                     VARCHAR(100),
  date_of_birth               DATE,
  registration_date           TIMESTAMPTZ,
  detail_enriched_at          TIMESTAMPTZ,
  trading_accounts_synced_at  TIMESTAMPTZ,
  branch                      VARCHAR(255),
  is_verified                 BOOLEAN DEFAULT false,
  is_trader                   BOOLEAN DEFAULT false,
  crm_profile_type            VARCHAR(50),
  source                      VARCHAR(20) NOT NULL DEFAULT 'crm'
                              CHECK (source IN ('crm', 'manual', 'merged')),
  lead_source                 VARCHAR(30),
  first_deposit_at            TIMESTAMPTZ,
  assigned_at                 TIMESTAMPTZ,
  first_contact_at            TIMESTAMPTZ,
  response_time_seconds       INTEGER,
  referral_link_id            UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Also add linked_client_id FK on users now that clients table exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_linked_client_id_fkey'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_linked_client_id_fkey
      FOREIGN KEY (linked_client_id) REFERENCES clients(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clients_rep          ON clients(assigned_rep_id);
CREATE INDEX IF NOT EXISTS idx_clients_stage        ON clients(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_clients_type         ON clients(contact_type);
CREATE INDEX IF NOT EXISTS idx_clients_agent_ref    ON clients(referred_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_clients_agent_id     ON clients(agent_id);
CREATE INDEX IF NOT EXISTS idx_clients_product_id   ON clients(product_id);
CREATE INDEX IF NOT EXISTS idx_clients_email        ON clients(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_clients_source       ON clients(source);
CREATE INDEX IF NOT EXISTS idx_clients_name_lower   ON clients(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_clients_phone        ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_country      ON clients(country);
CREATE INDEX IF NOT EXISTS idx_clients_branch       ON clients(branch);
CREATE INDEX IF NOT EXISTS idx_clients_updated_at   ON clients(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_created_at   ON clients(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_first_deposit_at ON clients(first_deposit_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clients_ta_synced    ON clients(trading_accounts_synced_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_clients_referral_link ON clients(referral_link_id) WHERE referral_link_id IS NOT NULL;

-- Agent ↔ product rate assignments
CREATE TABLE IF NOT EXISTS agent_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rate_per_lot  DECIMAL(10,2) NOT NULL CHECK (rate_per_lot >= 0),
  granted_by    UUID REFERENCES users(id),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  source        VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_products_agent   ON agent_products(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_products_product ON agent_products(product_id);

-- CRM commission levels (authoritative per-agent per-product per-group config)
CREATE TABLE IF NOT EXISTS crm_commission_levels (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id                     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  mt5_group_name                 VARCHAR(200),
  mt5_group_source_id            VARCHAR(100),
  commission_percentage          NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_per_lot             NUMERIC(10,4) NOT NULL DEFAULT 0,
  prefix                         VARCHAR(50),
  suffix                         VARCHAR(50),
  use_prefix                     BOOLEAN DEFAULT false,
  use_suffix                     BOOLEAN DEFAULT false,
  excluded_symbols               TEXT[] DEFAULT '{}',
  available_symbols              TEXT[] DEFAULT '{}',
  is_active                      BOOLEAN DEFAULT true,
  source_wallet_id               VARCHAR(100),
  source_config_key              TEXT,
  source_updated_at              TIMESTAMPTZ,
  override_commission_percentage NUMERIC(5,2),
  override_commission_per_lot    NUMERIC(10,4),
  override_reason                TEXT,
  override_by_user_id            UUID REFERENCES users(id),
  override_set_at                TIMESTAMPTZ,
  synced_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_user_id, product_id, mt5_group_name)
);

CREATE INDEX IF NOT EXISTS idx_ccl_agent_product ON crm_commission_levels(agent_user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_ccl_product_group ON crm_commission_levels(product_id, mt5_group_name);
CREATE INDEX IF NOT EXISTS idx_ccl_wallet        ON crm_commission_levels(source_wallet_id);

-- Per-trading-account metadata
CREATE TABLE IF NOT EXISTS trading_accounts_meta (
  login               VARCHAR(50) PRIMARY KEY,
  client_id           VARCHAR(255) REFERENCES clients(id) ON DELETE SET NULL,
  source_id           VARCHAR(255),
  name                VARCHAR(255),
  account_type        VARCHAR(20),
  product_name        VARCHAR(100),
  product_source_id   VARCHAR(255),
  currency            VARCHAR(10),
  balance_cached      DECIMAL(14,2),
  equity_cached       DECIMAL(14,2),
  deposits_total      DECIMAL(14,2),
  withdrawals_total   DECIMAL(14,2),
  lots_total          DECIMAL(14,4),
  commission_total    DECIMAL(14,2),
  status              BOOLEAN,
  mt5_group           VARCHAR(200),
  created_at_source   TIMESTAMPTZ,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mt5_synced_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ta_meta_client    ON trading_accounts_meta(client_id);
CREATE INDEX IF NOT EXISTS idx_ta_meta_synced    ON trading_accounts_meta(last_synced_at);
CREATE INDEX IF NOT EXISTS idx_ta_meta_product   ON trading_accounts_meta(product_source_id);
CREATE INDEX IF NOT EXISTS idx_ta_meta_mt5_synced ON trading_accounts_meta(mt5_synced_at);
CREATE INDEX IF NOT EXISTS idx_ta_meta_mt5_group ON trading_accounts_meta(mt5_group);

-- MT5 group-name → local product mapping
CREATE TABLE IF NOT EXISTS mt5_groups (
  group_name  VARCHAR(200) PRIMARY KEY,
  product_id  UUID REFERENCES products(id) ON DELETE CASCADE,
  source      VARCHAR(20) DEFAULT 'manual',
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mt5_groups_product ON mt5_groups(product_id);

-- Raw per-deal cache from the MT5 Manager bridge.
CREATE TABLE IF NOT EXISTS mt5_deal_cache (
  login          VARCHAR(50)   NOT NULL,
  deal_id        BIGINT        NOT NULL,
  deal_time      TIMESTAMPTZ   NOT NULL,
  entry          SMALLINT,
  volume         BIGINT,
  lots           NUMERIC(14,4),
  commission     NUMERIC(14,4),
  symbol         VARCHAR(50),
  balance_type   VARCHAR(20),
  balance_amount NUMERIC(14,2),
  synced_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (login, deal_id)
);

CREATE INDEX IF NOT EXISTS idx_mt5_deal_login_time ON mt5_deal_cache(login, deal_time);
CREATE INDEX IF NOT EXISTS idx_mt5_deal_time       ON mt5_deal_cache(deal_time);
CREATE INDEX IF NOT EXISTS idx_mt5_deal_time_brin  ON mt5_deal_cache USING BRIN (deal_time) WITH (pages_per_range = 32);

-- Commission engine job queue
CREATE TABLE IF NOT EXISTS commission_engine_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       UUID NOT NULL,
  login          VARCHAR(50) NOT NULL,
  client_id      VARCHAR(255) REFERENCES clients(id) ON DELETE CASCADE,
  product_id     UUID REFERENCES products(id),
  status         VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempt        INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 3,
  last_error     TEXT,
  result_summary JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_engine_jobs_cycle  ON commission_engine_jobs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_engine_jobs_status ON commission_engine_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_engine_jobs_login  ON commission_engine_jobs(login, cycle_id);

-- Per-cycle metadata for the admin dashboard
CREATE TABLE IF NOT EXISTS commission_engine_cycles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  triggered_by      VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  triggered_by_user UUID REFERENCES users(id),
  since_iso         TIMESTAMPTZ,
  status            VARCHAR(20) NOT NULL DEFAULT 'running',
  jobs_total        INT DEFAULT 0,
  jobs_succeeded    INT DEFAULT 0,
  jobs_failed       INT DEFAULT 0,
  jobs_dead         INT DEFAULT 0,
  deals_inserted    INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_engine_cycles_started ON commission_engine_cycles(started_at DESC);

-- Commissions ledger
CREATE TABLE IF NOT EXISTS commissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           BIGINT NOT NULL,
  client_id         VARCHAR(255) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mt5_login         BIGINT NOT NULL,
  product_id        UUID NOT NULL REFERENCES products(id),
  agent_id          UUID NOT NULL REFERENCES users(id),
  lots              DECIMAL(10,4) NOT NULL,
  rate_per_lot      DECIMAL(10,2) NOT NULL,
  amount            DECIMAL(12,2) NOT NULL,
  commission_amount DECIMAL(12,2),
  rebate_amount     DECIMAL(12,2),
  source_agent_id   UUID REFERENCES users(id),
  level             INTEGER NOT NULL DEFAULT 0,
  deal_time         TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(deal_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_commissions_agent_time  ON commissions(agent_id, deal_time DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_client      ON commissions(client_id);
CREATE INDEX IF NOT EXISTS idx_commissions_deal        ON commissions(deal_id);
CREATE INDEX IF NOT EXISTS idx_commissions_deal_time   ON commissions(deal_time);
CREATE INDEX IF NOT EXISTS idx_commissions_source_agent ON commissions(source_agent_id);

-- Pre-aggregated per-agent monthly earnings rollup
CREATE TABLE IF NOT EXISTS agent_earnings_summary (
  agent_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_month       DATE NOT NULL,
  commission_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  rebate_amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  deal_count         INTEGER NOT NULL DEFAULT 0,
  lots_total         DECIMAL(14,4) NOT NULL DEFAULT 0,
  client_count       INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, period_month)
);

CREATE INDEX IF NOT EXISTS idx_aes_agent_month ON agent_earnings_summary(agent_id, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_aes_period_month ON agent_earnings_summary(period_month);

-- Referral links
CREATE TABLE IF NOT EXISTS referral_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug            VARCHAR(50) NOT NULL UNIQUE,
  label           VARCHAR(100),
  destination_url TEXT NOT NULL DEFAULT 'https://bbcorp.trade/signup',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_links_agent ON referral_links(agent_id);

CREATE TABLE IF NOT EXISTS referral_visits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id              UUID NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
  agent_id             UUID NOT NULL REFERENCES users(id),
  ip_address           INET,
  user_agent           TEXT,
  referrer             TEXT,
  visited_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_client_id  VARCHAR(255) REFERENCES clients(id),
  converted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referral_visits_agent_time ON referral_visits(agent_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_visits_link       ON referral_visits(link_id);
CREATE INDEX IF NOT EXISTS idx_referral_visits_converted  ON referral_visits(converted_client_id) WHERE converted_client_id IS NOT NULL;

-- Add referral_link_id FK on clients now that referral_links exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_referral_link_id_fkey'
  ) THEN
    ALTER TABLE clients ADD CONSTRAINT clients_referral_link_id_fkey
      FOREIGN KEY (referral_link_id) REFERENCES referral_links(id);
  END IF;
END $$;

-- ----------------------------------------------------------------
-- Seed default roles
-- ----------------------------------------------------------------
INSERT INTO roles (name, description, permissions, client_scope, is_system, is_protected)
VALUES
  ('admin', 'Full access to all features',
   ARRAY['portal.admin','portal.access','portal.clients.view','portal.commissions.view',
         'portal.subagents.view','portal.products.manage',
         'users.manage','settings.access','roles.manage','sync.run','analytics.view'],
   'all', true, true),
  ('agent', 'IB/Agent — portal access, own referred clients + downline aggregates',
   ARRAY['portal.access','portal.clients.view','portal.commissions.view',
         'portal.summary.view','portal.commission_tree.view',
         'portal.subagents.view','portal.products.manage'],
   'assigned', true, false),
  ('readonly', 'View-only access',
   ARRAY['portal.access','portal.clients.view','portal.commissions.view',
         'portal.summary.view','portal.commission_tree.view'],
   'all', true, false)
ON CONFLICT (name) DO NOTHING;

-- Existing roles created before 2026-05-01 won't have the new portal permission
-- keys (portal.summary.view, portal.commission_tree.view) because the
-- INSERT above is ON CONFLICT DO NOTHING. Top them up here so existing
-- agent / readonly roles include the new keys without admins manually editing.
UPDATE roles SET permissions = ARRAY(
  SELECT DISTINCT unnest(permissions || ARRAY['portal.summary.view','portal.commission_tree.view'])
)
WHERE name IN ('agent','readonly')
  AND NOT (
    permissions @> ARRAY['portal.summary.view']
    AND permissions @> ARRAY['portal.commission_tree.view']
  );

-- ============================================================
-- Hardening migrations (2026-04-30)
-- ============================================================

-- Engine's rate-source audit columns. The engine writes ccl_pct/ccl_per_lot/
-- rate_source on every commission row so we can answer "which CRM-level row
-- produced this amount" without re-deriving. Without these the engine's
-- INSERT fails silently and every cycle reports succeeded with 0 inserts.
ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS ccl_pct       NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS ccl_per_lot   NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS rate_source   VARCHAR(20);


-- Flip the two CASCADE FKs that would wipe historical financial rows on a
-- client hard-delete. Now NO ACTION — caller must explicitly reassign or
-- soft-delete before removing a client. Idempotent: drops by name, re-adds
-- with the new ON DELETE rule.
DO $hardening_fks$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commissions_client_id_fkey') THEN
    ALTER TABLE commissions DROP CONSTRAINT commissions_client_id_fkey;
  END IF;
  ALTER TABLE commissions
    ADD CONSTRAINT commissions_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE NO ACTION;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_engine_jobs_client_id_fkey') THEN
    ALTER TABLE commission_engine_jobs DROP CONSTRAINT commission_engine_jobs_client_id_fkey;
  END IF;
  ALTER TABLE commission_engine_jobs
    ADD CONSTRAINT commission_engine_jobs_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE NO ACTION;
END $hardening_fks$;

-- Auto-stamp updated_at on every UPDATE so app code can never forget. One
-- shared trigger function, applied to every table that carries updated_at.
CREATE OR REPLACE FUNCTION tg_set_updated_at() RETURNS TRIGGER AS $tgu$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$tgu$ LANGUAGE plpgsql;

DO $tg_attach$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tt
      ON tt.table_schema = c.table_schema AND tt.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'updated_at'
      AND tt.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I;', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();', t);
  END LOOP;
END $tg_attach$;

-- Refresh planner statistics on hottest tables
ANALYZE commissions;
ANALYZE mt5_deal_cache;
ANALYZE trading_accounts_meta;
ANALYZE clients;
ANALYZE users;
ANALYZE crm_commission_levels;
`;

// Run standalone: `npm run db:migrate`
if (process.argv[1]?.endsWith('migrate.js')) {
  (async () => {
    const { fileURLToPath } = await import('url');
    const { dirname, resolve } = await import('path');
    const dotenv = (await import('dotenv')).default;
    const __filename = fileURLToPath(import.meta.url);
    dotenv.config({ path: resolve(dirname(__filename), '../../../.env'), override: true });
    if (!process.env.DATABASE_URL) {
      console.error('FATAL: DATABASE_URL not set — is .env at project root?');
      process.exit(1);
    }
    const { directPool: pool } = await import('./pool.js');
    try {
      console.log('Connecting to:', process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@'));
      await pool.query(migration);
      console.log('Migration complete');
    } catch (err) {
      console.error('Migration failed:', err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
