# System Architecture — CRM / MT5 Bridge / Portal DB

_Last updated: 2026-04-22. Companion to `DATA_FLOW.md`._

This document is the architect's view: **what good looks like** for this
system as it scales. The short-term hardening already shipped today (gate
budgets, hard caps, circuit breaker) buys us safety. The proposals below
outline the medium-term refactor so CRM overload incidents are
**structurally impossible**, not just prevented by runtime guardrails.

---

## 1. What failed today

At ~19:01 UTC the scheduled Tier 3 rotating sync combined with my
manually-fired 8-branch parallel MT5-login sync to push **~1,000 calls** to
`GET /api/contacts/:id/trading-accounts`. x-dev's CRM started failing. Root
causes:

| Cause | Why it's a design smell, not just a bug |
|---|---|
| `?batch=N` had no upper bound | **Client-controlled blast radius** |
| `mode=full` iterated all 26,000 clients in one call | **No notion of chunking** |
| Scheduled autoSync + manual admin actions competed for the same CRM budget | **No fair-share / priority between user-triggered and scheduled work** |
| One endpoint (`/trading-accounts`) ate 100% of the CRM's capacity | **No per-endpoint isolation** |
| Trading-accounts payload was thrown away twice (stored as `mt5_logins` only, fetched again later for `trading_accounts_meta`) | **Same CRM read repeated** |
| `POST /agents/backfill-parents` did 1,528 `GET /api/contacts/:id` calls every time | **Re-fetches everything even if most didn't change** |
| Commission engine empty on all branches except Hadi's because `mt5_deal_cache` depends on `trading_accounts_meta` which is rarely populated | **Hidden chain of sync dependencies that silently don't fire** |

Each one is a symptom of a deeper issue: **the portal treats x-dev's CRM as
a live store, not as an event source.** Every read is a fresh API call
unless someone remembered to add caching. Every ingest is a polling loop
with manual knobs.

---

## 2. The target architecture in one diagram

```
                    EXTERNAL SOURCES OF TRUTH
 ┌────────────────────────────┐    ┌─────────────────────────────┐
 │   x-dev CRM                │    │   MT5 Manager server        │
 │   (identity, hierarchy,    │    │   (deals, balances, logins  │
 │    products, TA metadata)  │    │    groups, margin, equity)  │
 └──────────────┬─────────────┘    └──────────────┬──────────────┘
                │                                  │
                │ webhooks + incremental pull      │ bridge (streaming)
                ▼                                  ▼
        ┌────────────────────────────────────────────────┐
        │             INGEST LAYER                        │
        │  • CRM gate (rate-limit, budgets, circuit)     │
        │  • Bridge gate (same pattern, separate limits) │
        │  • Deduplication (in-flight + short TTL)       │
        │  • Change-detection (only persist diffs)       │
        └───────────────────────┬────────────────────────┘
                                ▼
        ┌────────────────────────────────────────────────┐
        │          LOCAL SOURCE-OF-TRUTH DB               │
        │  • `clients`, `users`, `products`, `branches`   │
        │  • `trading_accounts_meta` (single upsert path) │
        │  • `mt5_deal_cache` (partitioned, cursor-based) │
        │  • `commissions` (derived, rebuildable)         │
        │  • `sync_state` (per-entity freshness marker)   │
        └───────────────────────┬────────────────────────┘
                                ▼
        ┌────────────────────────────────────────────────┐
        │            READ SURFACE                         │
        │  • Portal API (reads DB only, never external)  │
        │  • Commission engine (reads DB only)           │
        │  • Reports, dashboards, agent portal           │
        └────────────────────────────────────────────────┘
```

Three hard rules for this architecture:

1. **Nothing in the read surface ever calls an external system live.**
   Every read answers from local Postgres. If the data isn't fresh enough,
   the ingest layer is what needs to change — not the read path.
2. **External-system reads are owned by the ingest layer alone.**
   No route handler, no service, no background worker makes external calls
   except through the ingest layer's gated interface.
3. **All external-fetched data is upserted to its canonical local table in
   one pass.** No "get the list now, get the details later" patterns that
   double the call count.

---

## 3. What each component owns

### 3.1 x-dev CRM (external)

**Source of truth for:**
- Agent identity (`_id`, name, email, branch, `connectedAgent`)
- Client/contact identity (name, email, stage, `referredByAgentId`)
- Product catalog (name, code, `max_rate_per_lot`, group)
- Trading-account metadata (login → client mapping, account type, product, status)
- Branch list

**Does NOT own:**
- Per-deal history (that's MT5)
- Live balance/equity (that's MT5)
- Commission rates per agent (portal-internal)
- Commission rows (portal-internal)

### 3.2 MT5 bridge (external)

**Source of truth for:**
- Per-deal history (login, time, volume, profit, commission, swap)
- Live balance & equity (real-time)
- Login-to-group mapping, volume divisor, etc.
- **Real-time deal stream** — every executed deal POSTed to the portal within ~1s

**Does NOT own:**
- Which client owns which login (that's CRM → stored in `trading_accounts_meta`)

**How the portal reaches it:**
- `GET /accounts/:login` — returns the login's MT5 group (used by the resolver)
- `GET /history/:login?from&to` — paginated deal history (used by the 5-min hot-sweep)
- `GET /transactions/:login?from&to` — deposits/withdrawals
- `GET /positions/:login` — open positions
- `POST /connect` — bridge re-auths to MT5 (called from `/api/admin/settings/mt5/reconnect`)
- `GET /health` — bridge liveness + MT5 connection status

**How it reaches the portal:**
- `POST /api/mt5/webhook/deal` (auth: `X-MT5-Webhook-Secret`) — fired from the bridge's `DealSubscribe` callback for every new deal. Idempotent insert into `mt5_deal_cache`.
- `GET /api/settings/mt5/internal` (localhost-only) — bridge fetches its MT5 manager credentials from the portal's `settings` table on startup/reconnect. No env vars required for credentials.

**Wiring rules (learned the hard way):**
- The C# wrapper's sinks (`CIMTManagerSink`, `CIMTDealSink`) must call `RegisterSink()` BEFORE being passed to `manager.Subscribe()` / `manager.DealSubscribe()`. Skipping this returns `MT_RET_ERR_PARAMS`.
- The manager-level `Subscribe()` must be called BEFORE per-event subscribes (`DealSubscribe`).
- All subscribes happen ONCE at startup, BEFORE the first `Connect()`. They persist across reconnects — do not re-subscribe.
- Broker-side: source-IP whitelist on the manager API endpoint is mandatory. There is **no** `RIGHT_PUMP_ACCESS` flag in the MT5 manager rights enum — the broker doesn't need to enable any specific permission for `DealSubscribe` beyond standard `RIGHT_TRADES_READ`.

**Server timezone:**
The MT5 Manager API's `IMTDeal.Time()` returns **broker-local seconds-since-epoch**, NOT UTC. Both the bridge's `/history` response and the `DealSink` callback hand us this raw value. The portal subtracts the configured `settings.mt5_server_tz_offset_hours` before storing, so `mt5_deal_cache.deal_time` is always real UTC. This setting is admin-editable; it must match the broker's MT5 server timezone. Default for our broker (BBCorp): `3` (UTC+3). If you switch broker, update the setting AND run the historical backfill (`UPDATE mt5_deal_cache SET deal_time = deal_time - INTERVAL 'N hours'` and same for `commissions`).

**Per-webhook commission trigger:**
On each successful insert into `mt5_deal_cache`, the webhook receiver pushes the affected `login` onto an in-memory `Set`. A worker drains the set every 1 second (max 50 logins per tick) and runs `processLogin()` for each — converting the new deals into commission rows immediately. Result: **commissions land in the DB within ~1 second of broker execution**, instead of waiting for the engine cycle. The standard cycle still runs as a safety net for missed deals (network blips, portal restarts, brand-new logins not yet mapped) — but at 60 min instead of 15 min because the webhook is now the hot path.

**Known-login filter:**
The bridge subscribes to ALL deals on the broker's MT5 manager — including thousands of retail accounts that have no relationship to our imported agents. We measured this at runtime: **~62% of unique logins streamed by the bridge had no imported owner; 97% of webhook POSTs in a sample window were for unrelated broker clients**. Storing those would mean unbounded `mt5_deal_cache` growth and wasted CPU.

The webhook receiver filters at ingress: it maintains a `Set` of "known" logins (every `trading_accounts_meta.login WHERE client_id IS NOT NULL`), refreshed every 60 s. Webhooks for logins not in the set return `200 OK { skipped: 'unknown_login' }` immediately — no DB write, no commission queue push. Stats are tracked separately as `total_skipped_unknown` and shown in the admin "Real-time deal stream" card.

If a brand-new client gets imported after the portal has been receiving deals, their pre-import deals are NOT in the cache. The snapshot sync (triggered by the import flow OR by the admin "Refresh MT5" button) backfills 60 days of history from the bridge's `/history` endpoint.

**Cycle frequency rationale (2026-05-04+):**
| Scheduler | Was | Now | Reason |
|---|---|---|---|
| Commission engine cycle | 15 min | 60 min | Webhook writes commissions in real-time; cycle is a backstop |
| MT5 active-login sweep  | 30 min | 60 min | Bridge POSTs deals real-time; sweep catches gaps |
| MT5 hot-login sweep     | 5 min  | 30 min | Same — webhook is the primary path |

**Orphaned-cycle cleanup:**
A cycle row stuck in `status='running'` after a portal restart is by definition orphaned — its in-memory lock and worker tasks died with the process. `commissionEngine.cleanupOrphanedCycles()` runs at portal startup and (a) marks every `running` cycle as `abandoned` and (b) resets every `running` job back to `queued` so the next cycle re-claims them. Without this, restarts left visual cruft in the admin "Recent engine cycles" panel and stranded jobs that no worker would ever pick up.

### 3.3 Portal DB (local, the hub)

**Source of truth for:**
- Portal logins (`users` with `linked_client_id` back-reference)
- Commission rates (`agent_products`)
- Computed commissions (`commissions` — derivable from CRM mirror + MT5 cache + rates)
- Notes, tasks, messages, notifications, alerts, audit trail
- Engine cycles + jobs
- Gate settings (`settings.crm_*`)

**Caches from external:**
- `clients` (mirror of CRM contacts + agents)
- `trading_accounts_meta` (rich per-login data from CRM)
- `mt5_deal_cache` (monthly-partitioned MT5 deal history)
- `products`, `branches` (slow-changing CRM catalog data)

---

## 4. The four refactors that kill this class of incident

### 4.1 Collapse `clients.mt5_logins` + `trading_accounts_meta` into a single sync path

**Today**:
```
  CRM /api/contacts/:id/trading-accounts
        ├── autoSync.syncTradingAccountsForClients → clients.mt5_logins[]    (loses rich payload)
        └── tradingAccountMetaSync.syncForClient   → trading_accounts_meta   (SAME CRM CALL AGAIN)
```

Two code paths, two CRM calls, for data that's in the same response.

**Target**: one ingest function `ingestTradingAccounts(clientId)` that
upserts both `clients.mt5_logins` AND `trading_accounts_meta` from a single
CRM response. Callers stop thinking about which table they need.

**Impact**: cuts trading-account CRM calls roughly in half over a full sync
cycle. Makes the MT5 deal pipeline automatic (no separate meta-sync step).

### 4.2 Introduce a `sync_state` table (per-entity freshness marker)

Today, every sync job scans `clients` by `trading_accounts_synced_at` and
makes its own decisions about staleness. There's no shared vocabulary.

Proposed:

```sql
CREATE TABLE sync_state (
  entity_type      TEXT    NOT NULL,      -- 'client' | 'agent' | 'product' | 'branch'
  entity_id        TEXT    NOT NULL,
  source           TEXT    NOT NULL,      -- 'crm' | 'mt5'
  field            TEXT,                  -- optional: 'trading_accounts', 'profile', etc.
  last_synced_at   TIMESTAMPTZ,
  last_changed_at  TIMESTAMPTZ,           -- only bumped when a real diff was applied
  source_etag      TEXT,                  -- if source supports ETag/version
  next_check_at    TIMESTAMPTZ,           -- when this entity is eligible for re-sync
  priority         SMALLINT DEFAULT 5,    -- 1=hot, 9=dormant
  error_count      INT DEFAULT 0,
  last_error_at    TIMESTAMPTZ,
  PRIMARY KEY (entity_type, entity_id, source, field)
);
```

Benefits:
- **Change detection** — if `source_etag` matches, skip the fetch entirely
- **Back-off on errors** — `error_count` + exponential `next_check_at`
- **Priority-aware scheduling** — hot entities sync 4× faster than dormant
- **One source of freshness truth** — replaces `trading_accounts_synced_at`,
  `mt5_synced_at`, `updated_at` comparisons scattered across services

### 4.3 Event-log ingest (if xdev supports webhooks)

Today we poll. If xdev exposes webhooks or an event stream, switch to **push**:

- xdev fires `contact.updated` → we mark `sync_state.next_check_at = NOW()`
- xdev fires `trading_accounts.updated` → same for that field
- Our polling loop becomes a backstop for missed events (once a day, not
  every 30 min)

**Impact**: ~95% reduction in steady-state CRM calls. What used to be a
500-call rotating sweep becomes a handful of targeted fetches triggered by
actual change events.

**If xdev doesn't support webhooks**: ask. Building a webhook receiver on
our side is a 1-day job.

### 4.4 Pre-warm cache + cache-aside for idempotent reads

Products, branches, and role definitions don't change often. Today every
admin page that opens Agent Detail triggers a full paginated `/api/products`
scan.

Apply cache-aside with:
- **L1 — in-process** (15–30s TTL). Already shipped in `crmGate.js` for
  `/products` + `/branches`. Extend to the bridge gate.
- **L2 — Postgres-backed**. If the same product catalog is served from
  `products` table in under 5ms, we don't need L1 for most views.
- **L3 — on-startup prefetch**. When backend boots, pre-fetch `/api/products`
  + `/api/branches` once and seed the L1 cache, so the first admin to open
  the portal doesn't wait on CRM.

---

## 5. How to prevent CRM overload (five layers)

| Layer | What it does | Where in the code |
|---|---|---|
| **L1: Structural (can't happen)** | No endpoint accepts unbounded batch params; "full-mode" scans are deleted; backfill runs in checkpointed chunks | `routes/sync.js`, `agentParentBackfill.js` |
| **L2: Budgeted (won't happen)** | Per-endpoint daily budget (`trading-accounts: 3000/day`, `contacts-detail: 1000/day`). When budget exhausted, calls throw `CrmBudgetExceededError` immediately | `services/crmGate.js` |
| **L3: Throttled (never in a burst)** | Token bucket @ N req/s + concurrency cap. Ensures even legitimate traffic never spikes above N | `services/crmGate.js` |
| **L4: Circuit-broken (auto-stops on errors)** | On 5+ 5xx/429 errors in 60s → trip endpoint breaker, 5-min cooldown. Stops cascading failures while CRM is recovering | `services/crmGate.js` |
| **L5: Human (kill switch)** | Admin can hit Pause on the chip in the sidebar footer → every call throws within 10s. Last line of defense | `services/crmGate.js` + `/api/admin/crm/pause` |

Each layer is independent. An overload has to get past all five to hit
x-dev. Today after this session, **L1 + L2 + L3 + L4 + L5 are all live**.

---

## 6. Applying the same pattern to MT5 bridge

The MT5 bridge has zero guardrails today. It's our own infrastructure so it
hasn't mattered — but if we ever onboard a broker with 20K logins, a naive
`syncForAgent` hitting the subtree would storm the bridge just like we did
to the CRM.

**Clone `crmGate.js` → `mt5BridgeGate.js`** with:
- `mt5_paused` setting (separate kill switch so CRM pause doesn't disable the portal's live MT5 reads)
- Rate + concurrency (probably more generous: 20/s, 16 concurrent — your own infra)
- Per-login in-flight dedup (if two flows both want `/balance?login=X`, one HTTP call)
- Circuit breaker on bridge 5xx

All MT5-hitting code (`mt5SnapshotSync.js`, `routes/mt5.js`, `routes/ai.js`)
gets refactored to funnel through one helper. Same pattern, smaller blast
radius because bridge is LAN-local.

---

## 7. Deriving commissions — making it bulletproof

Today: commission engine runs every 15 min, builds rows, silently produces
0 rows when upstream data is missing (empty `trading_accounts_meta` or
empty `mt5_deal_cache`). No alert. No explanation.

**Proposed change**: add a **health check** to each cycle output:

```js
// In commissionEngine after a cycle:
{
  cycle_id: '...',
  jobs_total: 506,
  jobs_succeeded: 506,
  commissions_written: 0,
  // NEW:
  diagnostics: {
    agents_without_products: 42,
    agents_with_rate_zero: 7,
    clients_without_mt5_logins: 3084,
    clients_without_meta: 2671,
    clients_without_deals_cached: 2494,
    suspected_bottleneck: 'missing_meta',   // ← name the gap
  }
}
```

Show this on `/admin/reconciliation`. An admin glances at it and sees
**why** numbers are off instead of doing the forensic SQL I ran today.

---

## 8. Prioritized roadmap

### Tier 0 — DONE TODAY
- [x] CRM gate with kill switch, rate limit, concurrency
- [x] Per-endpoint daily budgets
- [x] Circuit breaker on 5xx/429
- [x] Response cache for products + branches
- [x] Hard caps on `/sync/trading-accounts?batch=N` (max 500)
- [x] "full mode" disabled with 400 response explaining alternatives
- [x] `/trading-accounts/branch/:name?max=N` capped at 1000/call with `remaining` in response
- [x] `backfillAgentParents` capped at 300/call
- [x] Import Pass 4 capped at 500 clients
- [x] Tier 3 scheduled reduced from 500/hr → 100/hr
- [x] AutoSync respects `crm_paused` (no failed-call storms)
- [x] `/admin/data-flow` documentation page in portal

### Tier 1 — NEXT (1–2 days)
- [ ] Collapse `mt5_logins` + `trading_accounts_meta` into one ingest
- [ ] Add `sync_state` table + migrate all callers to use it
- [ ] Commission engine diagnostics output
- [ ] Admin UI: show per-endpoint budget usage + remaining + circuit state
- [ ] Pre-warm product + branch cache on startup

### Tier 2 — MEDIUM (1–2 weeks)
- [ ] Clone gate pattern for MT5 bridge (`mt5BridgeGate.js`)
- [ ] Webhook receiver endpoint (if xdev supports)
- [ ] Priority-aware Tier 2/3 scheduling based on `sync_state.priority`
- [ ] In-flight dedup in both gates
- [ ] Move backfill + bulk imports to a job queue (pg-boss / bull) with
      persistent progress + resumability

### Tier 3 — NICE-TO-HAVE
- [ ] Read-through cache for `/agents/:id/crm-products` from local `products` table (no CRM call at all)
- [ ] Per-IP rate limit on public-facing endpoints (separate from CRM load)
- [ ] Separate read replica for heavy analytics queries

---

## 9. Operational playbook

### When CRM is complaining

1. Click **Pause** on the sidebar chip.
2. Check `/admin/data-flow` → CRM gate section — which endpoint has high usage today?
3. If it's `trading-accounts`, check `sync_state` (once implemented) — which branch has the highest pending count?
4. When CRM recovers, either wait out the Tier 1+3 hourly cadence (at 100/hr load is minimal) or manually unpause with a tighter rate (`PATCH /admin/crm/config { ratePerSecond: 2 }`).

### When MT5 bridge is complaining

1. No gate yet (Tier 2 roadmap). For now: `pm2 stop crm-backend` → fix → restart.
2. Once bridge gate is shipped, same pattern as CRM.

### When commission history is empty

1. Run the triage query from `/admin/data-flow`.
2. If `cached_deals = 0` → MT5 pipeline issue (likely missing `trading_accounts_meta` today).
3. If `meta_rows > 0` but `cached_deals = 0` → MT5 bridge hasn't fetched yet; trigger a scoped sync.
4. If `clients_with_logins = 0` → CRM sync issue for this branch; run `/sync/trading-accounts/branch/:name`.

---

## 10. TL;DR for the team

| Thing | Before | After today | After Tier 1 roadmap |
|---|---|---|---|
| Can anyone accidentally call CRM 1000+ times? | Yes | **No — five independent safety layers** | No |
| Do we waste CRM calls re-fetching the same payload twice? | Yes | Yes (not yet fixed) | **No** |
| Does commission history silently stay empty for branches that are set up wrong? | Yes | Yes | **No — cycle output flags the bottleneck** |
| Does MT5 bridge have the same guardrails? | No | No | **Yes** |
| Do scheduled syncs re-fetch dormant clients every few days? | Yes | Yes (reduced to 100/hr) | **No — priority scheduling skips dormants** |
| Can admin see what's being called and cut it instantly? | No | **Yes — sidebar chip + pause** | Yes + per-endpoint live view |

The portal is now safe against the incident that happened. The roadmap above
is what removes this entire class of problem from the codebase.
