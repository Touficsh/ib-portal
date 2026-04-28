# IB Agent Portal

Standalone IB (Introducing Broker) Agent Portal extracted from the live-crm-sales monorepo. Agents log in, view their referred clients, commissions, sub-agent trees, and trading account snapshots. Admins manage rates, run MT5 syncs, and monitor the commission engine.

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
| POST | /api/admin/mt5-sync | Manual MT5 sweep trigger |
| GET | /api/admin/audit-log | Financial audit log |
| GET | /api/health | Health check |
| POST | /api/sync/agent-imported | CRM webhook (agent upsert) |

---

## GitHub

Remote: https://github.com/Touficsh/ib-portal.git
