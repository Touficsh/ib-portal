# Data Flow — Plain-English Guide

_Last updated: 2026-04-25_

A simple explanation of where our data comes from, where it goes, and how the
pieces fit together. If you're not a database person, start here.

> **Looking for "what does this button do"?** See `OPERATIONS_GUIDE.md` —
> page-by-page button reference for every admin and agent surface.

---

## What changed since 2026-04-22

These are the operational knobs that landed during the recent optimization
sprint. If you remember the old behavior and something feels different, this
section explains why:

| Change | Where | Plain-English impact |
|---|---|---|
| **Earliest deal date floor** | `settings.mt5_earliest_deal_date` (currently `2026-03-01`) | No deal older than this is fetched from the MT5 bridge or written to `mt5_deal_cache`. Caps storage + ingress at the source. Configurable on **System Health → Pipeline → Snapshot sync settings**. |
| **`agent_earnings_summary` rollup** | New table | Pre-aggregated per-agent monthly earnings. Dashboards (Commission Tree, Top Earners, Admin Overview) read from this instead of scanning the 660K-row `commissions` table. Refreshed automatically by the engine after every cycle. |
| **`commissions` partitioned by month** | Same table, partitioned | Date-scoped reads now scan only the relevant monthly chunk (3–5× faster). `mt5_deal_cache` was already partitioned. |
| **`trading_accounts_meta` self-heal** | `mt5SnapshotSync.syncForLogin` | The MT5 sync now stamps `client_id` automatically on every login it touches — no need for a separate CRM `/trading-accounts` call to populate ownership. Coverage went from 8% → 100% after backfill. |
| **Engine cycle chains automatically** | After Refresh MT5 / Fetch missing | Clicking "Refresh MT5" on Agent Summary now also fires a commission engine cycle in the background — commissions populate without a second click. |
| **Smart sync for commission rates** | "Sync rates (smart)" button on Commission Tree | Default sync skips agents synced in the last 24h, dramatically cutting CRM load. "Force full" available for known rate changes. |
| **Subtree-scoped sync** | New on Agent Detail page | Sync rates for one agent + their downline only, instead of all 706 agents. ~10× cheaper than the bulk "Sync all rates" button. |
| **Removed: `agent_data_shares`** | Table dropped | Privacy-grants feature had 0 rows in production after 6 months. Removed entirely. Agents now see their downline's data unmasked (tree membership = visibility). |
| **Removed: agent-side Products + Referrals pages** | Portal navigation | Products are visible inside Commission Tree; referral-link generation never wired up. Less to maintain. |

---

## The big picture — three "filing cabinets"

```
  📋 xdev CRM              🔢 MT5 bridge              📘 Our database
  (who people are)         (what trades happen)       (our own notebook)
```

- **xdev CRM** — the sales team's master customer file. Knows who everyone is,
  which branch they belong to, who referred them, what MT5 account they opened.
  **Source of truth for people.**
- **MT5 bridge** — the trading server's logbook. Knows every trade made: who
  (by account number), when, how much volume, how much commission the broker
  charged. **Source of truth for trades.**
- **Our notebook** (the portal's database) — our own working copy. We don't
  invent data; we copy the bits we need from the other two and keep them
  organized so the portal can calculate agent commissions and render pages
  fast. Nothing else in the portal touches the outside world when you browse.

---

## The "common data" — the bridge between CRM and MT5

The CRM and MT5 are **completely separate systems**. They don't talk to each
other. Our portal is the thing that stitches them together.

The glue is a single number: **the MT5 login**.

```
CRM knows:                              MT5 knows:
  Customer "Ahmad" has login 12345        Login 12345 made a 0.5 lot trade
```

Neither side knows both halves. So our portal's job is:
1. Ask CRM: _"Who owns login 12345?"_ → store in `trading_accounts_meta`
2. Ask MT5: _"What trades did login 12345 make?"_ → store in `mt5_deal_cache`
3. Join them: trade on login 12345 → Ahmad → Ahmad's agent → agent's rate → pay

**Everything else** (products, branches, commission rates, agent relationships)
lives only in CRM. Trades live only in MT5. The login number is literally the
only shared field that exists in both worlds.

---

## What we copy from each source

### From xdev CRM → our notebook

| What we copy | Lands in table | Why we need it |
|---|---|---|
| Product catalog (e.g. "Plus 10", "Real 10") | `products` | To know what an agent is selling |
| Branches (offices) | `branches` | To group agents by office |
| Customers (contacts) | `clients` | To know whose trades we're counting |
| Agents | `users` | To know who earns commissions |
| Agent → agent parent/child | `users.parent_agent_id` | To walk the waterfall up to top agents |
| Customer → agent referral | `clients.referred_by_agent_id` | To know which agent gets credit |
| Commission rates per agent/product | `crm_commission_levels` | The actual % and $/lot each agent earns |
| Cached IB wallet ID per agent | `users.crm_ib_wallet_id` | Avoids re-fetching the agent's profile to find their wallet ID every time we sync commission levels |
| **Which MT5 accounts belong to which customer** | `trading_accounts_meta` | **The bridge between CRM and MT5** |
| Which MT5 group a login belongs to | `trading_accounts_meta.mt5_group` | Ties a login to the right product when deals arrive |
| Product-to-MT5-group map | `mt5_groups` | Looks up product for deal rows that don't know their product yet |

### From MT5 bridge → our notebook

| What we copy | Lands in table | Why we need it |
|---|---|---|
| Every deal (trade) | `mt5_deal_cache` | The raw earnings data. This is what the commission engine does math on |

That's the only thing we copy from MT5 — but it's the critical one.

### Things we compute ourselves (not copied from anywhere)

| Table | What it is |
|---|---|
| `commissions` | The output of the waterfall math. One row per deal-per-agent-in-chain. **Partitioned by month** since 2026-04-24 — date-scoped queries scan only relevant chunks. |
| `agent_earnings_summary` | Pre-aggregated per-(agent, month) rollup. Refreshed by the engine after every cycle. Dashboards read from this instead of scanning `commissions`. |
| `commission_engine_cycles` / `commission_engine_jobs` | Log of every engine run |
| `audit_log` | Admin actions (pause CRM, edit rates, run engine, etc.) |
| `notifications` | Bell-icon feed items |
| `activity_log`, `alerts`, `tasks`, `notes`, `messages` | Portal workflow state |
| `users.role_id`, `user_branch_scope` | RBAC permissions |
| `settings` | Gate config, engine toggles, watermarks, **earliest deal date floor** |

---

## The full flow in one picture

```
            ┌─────────────────┐               ┌─────────────────┐
            │   xdev CRM      │               │  MT5 bridge     │
            │                 │               │                 │
            │ people, rates,  │               │ trades (deals)  │
            │ products,       │               │                 │
            │ account-owner   │               │                 │
            │ links           │               │                 │
            └────────┬────────┘               └────────┬────────┘
                     │                                 │
                     │  via CRM gate                   │  via MT5 bridge gate
                     │  (rate-limited)                 │  (planned)
                     ▼                                 ▼
         ┌─────────────────────────────────────────────────────────┐
         │               Our database (the notebook)               │
         │                                                         │
         │   products, branches, clients, users,                   │
         │   trading_accounts_meta  ← the glue                     │
         │   mt5_deal_cache         ← MT5 copy                     │
         │   crm_commission_levels  ← rates from CRM               │
         │                                                         │
         │   👇 commission engine reads all of the above           │
         │                                                         │
         │   commissions table     ← computed earnings             │
         └─────────────────────────────────────────────────────────┘
                              │
                              ▼
                      Your portal UI
               (Commission Tree, Agent Detail,
                Commission History, etc.)
```

Nothing on the UI side talks to CRM or MT5 directly. Pages read from Postgres
only. External calls only fire when:
1. A scheduled sync runs (autoSync, every 10 min for contacts)
2. An admin clicks a button (Import, Sync, Heal, Refresh)
3. The commission engine cycle runs (reads `mt5_deal_cache`, doesn't hit CRM)

---

## A concrete example — one trade, end to end

Customer **Ahmad** trades **0.5 lots** on login `12345`:

1. **Sales rep** adds Ahmad to CRM, assigns him to agent Mikel, opens MT5
   login `12345`.

2. **Our auto-sync** (every 10 min) notices a new customer → pulls Ahmad's
   record → writes him to `clients`. Notices his trading account → writes
   login `12345` linked to Ahmad in `trading_accounts_meta`. (This is where
   we "learn" the common glue.)

3. **Ahmad trades** 0.5 lots in MT5. MT5 logs the deal with login `12345`,
   broker commission of $5.

4. **Our engine** (runs periodically) asks MT5: _"What's new for login 12345?"_
   → writes the deal to `mt5_deal_cache`.

5. **Engine does the math:**
   - Deal is for login `12345` → owned by Ahmad (from `trading_accounts_meta`)
   - Ahmad was referred by Mikel → walk up: Mikel → Paul Matar
   - Mikel's rate on this product = 80% + $0 (from `crm_commission_levels`)
   - Paul's rate = 100% + $0
   - Mikel earns 80% × $5 = **$4.00**
   - Paul earns override (100% − 80%) × $5 = **$1.00**
   - Both rows written to `commissions`.

6. **Mikel and Paul** see their new earnings in the portal — next page load,
   no CRM or MT5 call involved.

---

## How "fresh" is the data the portal shows?

| What you see | How fresh |
|---|---|
| Agents, clients, hierarchy | Up to 10 min stale (autoSync cadence) |
| MT5 login-to-client mapping | Filled once per client; refreshes on manual "Sync MT5 logins" |
| Trading account metadata | Same as above (refreshed with logins) |
| MT5 deals | As fresh as the last engine cycle (default ~15 min) |
| Live balance / equity | **Live** — never cached, queried on each click |
| Product catalog | Changes rarely; cached 15 min in RAM after first fetch |
| Branch list | Same as products |
| Commissions | Computed when the engine cycle runs |

---

## What happens when the server restarts?

Nothing dramatic. All the important data is in Postgres and survives restart.
The only things lost are:

| Lost on restart | Impact |
|---|---|
| 15-min response cache for products/branches | **2 CRM calls** on next page load to re-fill, then cached again |
| In-flight dedup map | None — only matters during the exact moment duplicate parallel calls happen |
| Token bucket / circuit state | None — clean slate means no stale penalties |

**TL;DR**: restart cost = 2 CRM calls. Everything else is in the database.

---

## What protects the CRM from overload?

We built a "gate" (`services/crmGate.js`) that every CRM call goes through.
Think of it as a doorman with five rules:

| Rule | What it does |
|---|---|
| **Rate limit** | No more than 4 calls per second leave our backend |
| **Concurrency cap** | No more than 4 calls in-flight at the same time |
| **Circuit breaker** | If 5 errors hit in 60 seconds, stop calling for 5 minutes |
| **Kill switch** | You can pause all CRM calls with one click (sidebar chip) |
| **Response cache** | Products & branches are cached for 15 minutes after first fetch |

You can check its status in the admin sidebar (the "CRM Gate" chip), or via
`GET /api/admin/crm/status`.

The MT5 bridge has its own similar gate (`services/mt5BridgeGate.js`).

---

## "How do I know everything is synced?"

We have a coverage report built into the admin tools. It answers:
- How many agents still need their CRM commission levels pulled?
- Which branches have gaps?
- Are there hierarchy issues (agents with no parent set)?
- Are there "stale-typed" contacts (flagged as individual but actually agents)?

Today this is a diagnostic SQL query; we're planning an admin page for it.

---

## For deeper detail

The rest of this section is the technical inventory, kept here for developers
and anyone doing DB work. If you just wanted the plain-English picture, you
can stop reading above.

### Local DB inventory (as of today)

#### Tables that store CRM data

| Table | Fills from | Refresh trigger |
|---|---|---|
| `clients` | `GET /api/contacts` (list) + `GET /api/contacts/:id` (detail) | autoSync every 10 min + manual "Refresh from CRM" |
| `clients.mt5_logins` (array) | `GET /api/contacts/:id/trading-accounts?accountType=real` | Tier 2/3 autoSync + manual "Sync MT5 logins" |
| `branches` | `GET /api/branches` | "Sync branches from CRM" button + startup warmup |
| `products` | `GET /api/products` (paginated) | "Sync products" button + startup warmup |
| `trading_accounts_meta` | Same endpoint as logins, richer payload | `tradingAccountMetaSync.syncForAgent()` or lazy on first MT5 deal |
| `crm_commission_levels` | `GET /api/agent-commission-levels?ib_wallet_id=X` | `commissionLevelSync.syncOneAgentCommissionLevels()` |
| `mt5_groups` | Derived from `products.product_configs[].groups[]` | Seed job (`mt5GroupSeed.js`) |

#### Tables that store MT5 data

| Table | Fills from | Refresh trigger |
|---|---|---|
| `mt5_deal_cache` | MT5 bridge `/deals?login=N&since=T` | `mt5SnapshotSync.syncForAgent()` / `.syncForLogin()` — incremental cursor per login |
| `mt5_deal_cache_YYYY_MM` | Monthly RANGE partitions of the above | Auto-inherits |

**MT5 balance/equity is NOT cached.** Every "Load balance" click fetches live.
Intentional — balance changes by the second.

#### Portal-internal tables

See the main table in the "What we compute ourselves" section above.

### When external calls fire

#### xdev CRM — scheduled (`services/autoSync.js`)

| Cadence | Purpose | Endpoints hit |
|---|---|---|
| Every 10 min | Incremental contact discovery (checkpointed by `latest_crm_created_at`) | `GET /api/contacts?page=N` until the checkpoint |
| Every 30 min | Activity-driven account refresh (from money-report) | `GET /api/money-report-enhanced` + `GET /api/contacts/:id/trading-accounts` × active count |
| Every hour | Tier-3 rotating refresh (oldest-synced 200 clients) | `GET /api/contacts/:id/trading-accounts` × 200 |

Total scheduled load: ~400–600 calls/hour, all capped at 4/sec by the gate.

#### xdev CRM — manual buttons

| Action | Typical call count |
|---|---|
| Admin → "Fix all imported" | 1–2 calls |
| Sync product links | 1 call |
| Backfill parents | up to 1,500 calls (heavy — rarely used) |
| Sync MT5 logins for a branch | Variable (0 if already synced) |
| Per-agent commission-level sync | 2 calls (contact detail + commission levels) |
| Settings → Test CRM connection | 1 call (bypasses gate intentionally) |

#### MT5 bridge — manual + scheduled

| Trigger | What it does |
|---|---|
| Admin clicks "Sync MT5 snapshot" | Pulls incremental deals for every login in the agent's subtree |
| Summary page "Refresh MT5" | Same, scoped to current agent |
| Commission engine cycle | Reads `mt5_deal_cache` only — **does not call the bridge** |

### Triage query — empty commission history

```sql
SELECT
  u.name AS agent,
  c_self.branch,
  (SELECT COUNT(*) FROM crm_commission_levels WHERE agent_user_id = u.id) AS crm_levels,
  (SELECT COUNT(*) FROM clients WHERE referred_by_agent_id = u.id) AS direct_clients,
  (SELECT COUNT(*) FROM trading_accounts_meta tam
     JOIN clients cl ON cl.id = tam.client_id
     WHERE cl.referred_by_agent_id = u.id) AS meta_rows,
  (SELECT COUNT(*) FROM mt5_deal_cache d
     JOIN trading_accounts_meta tam ON tam.login = d.login
     JOIN clients cl ON cl.id = tam.client_id
     WHERE cl.referred_by_agent_id = u.id) AS cached_deals,
  (SELECT COUNT(*) FROM commissions WHERE agent_id = u.id) AS commission_rows
FROM users u
LEFT JOIN clients c_self ON c_self.id = u.linked_client_id
WHERE u.id = '<agent-uuid>';
```

If `cached_deals = 0` but `direct_clients > 0`, the MT5 pipeline hasn't reached
this agent's subtree yet. First step: verify `meta_rows > 0` (trading accounts
synced), then trigger an MT5 snapshot sync.

If `crm_levels = 0`, their rates haven't been synced yet — click "Sync
commission levels" for this agent.

### Quick-reference: what to do if something's on fire

| Symptom | First action |
|---|---|
| Portal slow | Backend logs (`pm2 logs crm-backend`) for long queries |
| CRM complains about load | Click **Pause** on the sidebar chip — instant stop |
| MT5 bridge complains | No gate yet — stop backend temporarily |
| One agent's commission history is empty | Run the triage query above |
| Commission Tree shows legacy rates instead of CRM `%+$` | Their CRM commission levels haven't been synced — click "Sync commission levels" |
| Engine runs forever | Check `commission_engine_cycles` + `commission_engine_jobs` for stuck rows |

---

## Glossary

- **Agent** — a person who earns commission. Lives in `users` table, linked to a `clients` row via `linked_client_id`.
- **Waterfall** — when an agent earns commission on their own clients' trades _plus_ an override when a sub-agent of theirs closes a trade. Our engine walks up the tree computing each level's cut.
- **CRM-synced rates** — the `%+$` two-part commission model pulled from xdev (via `/api/agent-commission-levels`). Stored in `crm_commission_levels`. Replaces the older single-rate model.
- **Legacy rates** — a single `$/lot` number stored in `agent_products`. Used for branches where we haven't yet pulled CRM levels.
- **The gate** — `services/crmGate.js` (and its twin `mt5BridgeGate.js`). All external calls funnel through it for rate-limiting, dedup, and safety.
- **The engine** — `services/commissionEngine.js`. Runs on a cycle, reads `mt5_deal_cache`, walks the tree, writes `commissions`.
- **MT5 login** — the 4–8 digit number identifying a trading account. The only ID that exists in both CRM and MT5 — our "common data".
