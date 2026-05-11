# IB Agent Portal

Standalone IB (Introducing Broker) Agent Portal extracted from the live-crm-sales monorepo. Agents log in, view their referred clients, commissions, sub-agent trees, and trading account snapshots. Admins manage rates, run MT5 syncs, and monitor the commission engine.

> **Operating this portal day-to-day?** Start with the
> [Owner Handbook](OWNER_HANDBOOK.md) — plain-language guide to what each
> page does, daily checks, and what to do when something looks wrong.
> No coding required.
>
> **Setting up or developing on it?** Continue reading.
>
> **Taking the portal live on the public internet?** See
> [DEPLOYMENT.md](DEPLOYMENT.md) — step-by-step runbook covering
> domain, HTTPS via Caddy, NSSM services, hardening, cutover, and
> rollback. ~3-4 hours start to finish.

## Architecture

```
C:\ib-portal\
├── backend\          Express API (Node.js ESM)
│   ├── src\
│   │   ├── server.js            Portal-only Express server
│   │   ├── routes\
│   │   │   ├── portal\          Agent-facing API  (/api/portal/*)
│   │   │   └── admin\           Admin API         (/api/admin/*)
│   │   ├── services\            Commission engine, MT5 sync, CRM gate, …
│   │   ├── middleware\          JWT auth, error handler
│   │   └── db\
│   │       ├── pool.js          Two-pool setup (direct + PgBouncer)
│   │       ├── migrate.js       Portal-only schema (idempotent)
│   │       └── partitionMt5DealCache.js
│   ├── package.json
│   └── .env.example
├── frontend\         Vite/React agent portal SPA
├── mt5-bridge\       .NET 8 service: MT5 Manager API → portal webhook
│   ├── Program.cs              DealSubscribe + reconnect loop + HTTP endpoints
│   ├── mt5-bridge.csproj       References MetaQuotes SDK at C:\MetaTrader5SDK\
│   ├── start-bridge.ps1        Launcher (reads MT5_WEBHOOK_SECRET from backend/.env)
│   └── README.md               Bridge-specific build + run instructions
├── sync\
│   └── migrate-agents.js   One-time agent data migration from CRM DB
├── .gitignore
└── README.md
```

## Setup

### 1. Create the Supabase project

Create a new Supabase project and grab the connection strings from **Settings → Database**.

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
# Fill in DATABASE_URL, DATABASE_URL_POOLER, JWT_SECRET, MT5_BRIDGE_URL, etc.
```

Key env vars (see `backend/.env` for the full list):

```
PORT                              # default 3001
JWT_SECRET                        # ≥16 chars
DATABASE_URL                      # Supabase Postgres (IB-Portal project)
MT5_BRIDGE_URL                    # default http://localhost:5555
MT5_WEBHOOK_SECRET                # shared with bridge — bridge POSTs deals with this in
                                  # X-MT5-Webhook-Secret header. Same value must be set as
                                  # an env var on the bridge process (use start-bridge.ps1).

# Schedulers
# Real-time deal flow now runs through the bridge → /api/mt5/webhook/deal
# pipeline (sub-second). The scheduler intervals below are BACKSTOPS — they
# catch missed deals from network blips / portal restarts. Don't crank them
# back up unless the webhook is broken; overlapping cycles produce no value
# now that the per-webhook commission trigger handles the hot path.
ENABLE_COMMISSION_ENGINE=true     # safety-net commission engine cycles
COMMISSION_SYNC_INTERVAL_MIN=60   # was 15; webhook handles real-time
ENABLE_CONTACT_POLL=true          # 15-min contact poll (page-1 detector)
CONTACT_POLL_INTERVAL_MIN=15
ENABLE_BRANCH_HIERARCHY_POLL=true # 30-min comprehensive branch refresh
BRANCH_HIERARCHY_INTERVAL_MIN=30
MT5_SWEEP_INTERVAL_MIN=60         # was 30; webhook is the primary path
ENABLE_MT5_HOT_SWEEP=true         # active-account backstop
MT5_HOT_SWEEP_INTERVAL_MIN=30     # was 5; bumped because webhook handles real-time
MT5_HOT_SWEEP_ACTIVE_HOURS=24
ENABLE_DAILY_AGENT_REFRESH=true   # daily CRM agent-list refresh
DAILY_AGENT_REFRESH_HOUR_UTC=4
```

### 3. Install dependencies

```bash
cd backend
npm install
```

### 4. Run database migration

```bash
npm run db:migrate
```

This is idempotent — safe to run on every deployment.

### 5. Start the server

```bash
npm run dev      # development (--watch)
npm start        # production
```

The server runs on `PORT` (default 3001).

### 6. Build and serve the frontend

```bash
cd ../frontend
npm install
npm run build
# Artifacts land in frontend/dist/ — served by the backend at /portal/
```

**Operating URL:** `http://localhost:3001/portal/` — the backend serves the
built frontend statically. **Don't** run the Vite dev server (`npm run dev`,
port 5201) in production: it's a separate process that doesn't auto-start at
logon, doesn't survive a broad `taskkill node.exe`, and serves un-bundled
source files (no code-splitting). Reach for it only when you're actively
editing frontend source and want HMR; rebuild + serve via 3001 when done.

---

## Sync webhook

The CRM pushes agent data to this endpoint whenever an agent is created or updated:

```
POST /api/sync/agent-imported
Header: x-sync-webhook-secret: <SYNC_WEBHOOK_SECRET>
Body: { id, name, email, role?, is_agent?, parent_agent_id?, linked_client_id?, crm_ib_wallet_id? }
```

Set `SYNC_WEBHOOK_SECRET` in both the CRM and this project's `.env`.

---

## One-time agent migration

To seed the portal database from the existing CRM database:

```bash
SOURCE_DATABASE_URL="postgresql://..." DATABASE_URL="postgresql://..." node sync/migrate-agents.js
# or
node sync/migrate-agents.js --src="postgresql://..." --dst="postgresql://..."
```

This copies (in FK-safe order): roles, agent users, permission overrides, branches, products, agent_products, crm_commission_levels, clients, trading_accounts_meta, commissions, agent_earnings_summary.

---

## Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/portal/auth/login | Agent login |
| GET | /api/portal/me | Current agent profile |
| GET | /api/portal/dashboard | Earnings summary + stats |
| GET | /api/portal/clients | Agent's referred clients |
| GET | /api/portal/commissions | Commission history |
| GET | /api/portal/sub-agents | Sub-agent tree |
| GET | /api/admin/dashboard | Admin overview |
| GET | /api/admin/agent-summary | Per-agent earnings table |
| GET | /api/admin/mt5-sync/status | MT5 bridge + cycle health (incl. webhook stream stats) |
| POST | /api/admin/mt5-sync/run | Manual commission engine cycle |
| GET | /api/admin/settings/mt5/test | Probe bridge `/health` |
| POST | /api/admin/settings/mt5/reconnect | Tell the bridge to reload credentials + re-auth |
| GET | /api/admin/audit-log | Financial audit log |
| GET | /api/health | Health check |
| POST | /api/sync/agent-imported | CRM webhook (agent upsert) |
| **POST** | **/api/mt5/webhook/deal** | **Real-time deal stream from the MT5 bridge.** Auth: `X-MT5-Webhook-Secret` header. Idempotent. |
| GET | /api/settings/mt5/internal | Localhost-only — the MT5 bridge polls this on startup to fetch its MT5 manager credentials from the `settings` table. |

---

## MT5 architecture (2026-05-04+)

The portal is the **owner of MT5 manager credentials** — they live in the `settings` table (admin → Settings → "MT5 Manager API"). The bridge fetches them via `GET /api/settings/mt5/internal` on startup/reconnect; no env vars required for credentials.

**Login → product resolution** is bridge-driven. When the commission engine sees a deal on a login with no `product_source_id`, the resolver pre-pass:
1. Calls bridge `GET /accounts/:login` to get the login's MT5 group
2. Looks up `mt5_groups.group_name → product_id`
3. Writes `product_source_id` back into `trading_accounts_meta` for permanent caching

This replaces the old `GET /api/contacts/:id/trading-accounts` calls into the CRM (which were causing excessive load).

**Real-time deal stream**: the bridge subscribes to MT5's deal pump via `DealSubscribe()` and POSTs every executed deal to `POST /api/mt5/webhook/deal` within ~1 second. The webhook receiver inserts into `mt5_deal_cache` (idempotent). The 5-min hot-sweep remains as a safety net — if the bridge or portal goes down, the sweep fills the gap on the next cycle.

**Per-webhook commission trigger**: every successful webhook insert also queues the login for a single-pass run of `processLogin()` (debounced; drained every 1 second). This means **commission rows land within ~1 second** of the deal — agents see real-time earnings without waiting for the 15-min engine cycle. The cycle still runs as a backstop for missed deals.

**Server timezone**: the MT5 Manager API returns deal times as broker-local seconds (NOT UTC). The portal subtracts `settings.mt5_server_tz_offset_hours` before storing. Default `3` for BBCorp's UTC+3 server. Editable in admin Settings → MT5 Manager API. Changing it requires a portal restart (cached in-memory) AND a one-time SQL backfill of `mt5_deal_cache.deal_time` and `commissions.deal_time` to shift existing rows.

**Track deal flow**: admin → MT5 Sync Health page → "Real-time deal stream" card shows webhook deals received in the last 1/5/15/60 minutes, plus total counters since process restart.

**Bridge launcher**: use `C:\ib-portal\mt5-bridge\start-bridge.ps1` (reads `MT5_WEBHOOK_SECRET` from `backend/.env`, sets `CRM_BACKEND_URL`, kills any running bridge, starts a fresh one, verifies `/health`). Do NOT launch `mt5-bridge.exe` directly — it'll start with an empty webhook secret and every webhook POST will 401. The bridge source + build config live under `mt5-bridge/`; see [`mt5-bridge/README.md`](mt5-bridge/README.md) for build prerequisites.

---

## GitHub

Remote: https://github.com/Touficsh/ib-portal.git
