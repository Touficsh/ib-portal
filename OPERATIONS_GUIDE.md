# Operations Guide — IB Agent Portal

_Last updated: 2026-05-05_

This is the **detailed**, page-by-page, button-by-button reference for the
portal. It assumes some technical comfort — you'll see references to env
vars, settings keys, and SQL snippets.

> **Looking for a plain-language overview?** Start with
> [OWNER_HANDBOOK.md](OWNER_HANDBOOK.md) instead. It's written for the
> business operator (no coding background needed) and will direct you back
> here if you want the deeper detail.
>
> Companion docs for developers: `DATA_FLOW.md` (where data comes from +
> flows to) · `ARCHITECTURE.md` (how components fit) · `CLAUDE.md` (project
> conventions).

---

## Mental model in one paragraph

The portal is a **read surface** over local Postgres. Every UI page reads
from local tables — never from xdev CRM or MT5 directly. Two integration
points pull data in: **CRM sync** (people, products, rates) and **MT5
snapshot sync** (trades, balances). Both are triggered manually by admin
buttons OR scheduled. The **commission engine** computes per-agent earnings
from the cached MT5 deals and writes them to a `commissions` table.
Dashboards aggregate from `commissions` and a `agent_earnings_summary`
rollup.

---

## Top-level navigation

### Agent sidebar (when logged in as an agent)

| Page | What it shows |
|---|---|
| **Dashboard** | Hero card (this-month earnings + Δ), 14-day chart, sub-agent leaderboard, top clients, pipeline funnel |
| **Trading Accounts** | Flat list of every MT5 login in the agent's subtree, filterable by source (mine/direct client/sub-agent/sub's client) |
| **My Network** | Tabbed: Clients (KYC verified) / Leads (unverified) / Sub-Agents (card grid) |
| **Summary** | Hierarchical roll-up table (★ My accounts → Sub-agents → their clients → accounts). Date-range scoped for deal aggregates. |
| **Commission Tree** | Read-only waterfall view of the agent's subtree with rates + earnings per agent |
| **Commissions** | Per-deal commission ledger with date filter, source/product breakdowns, downloadable PDF statement |

### Admin sidebar (when logged in as admin)

| Page | What it shows |
|---|---|
| **Import Agents** | Multi-step wizard to import client-agents from CRM into the portal |
| **Agent Network** | Tree visualization with compact/detailed modes + "needs setup" filters |
| **Commission Tree** | Tree with rates + earnings + waterfall analysis. **Inline rate editor** for legacy rates. CRM sync buttons in the header. |
| **Agent Summary** | Inspect any single agent. Two tabs: Summary (MT5 totals) + Commissions (ledger). Includes MT5 freshness card. |
| **Products** | Catalog management — add/edit/sync products from CRM |
| **Staff Users** | User & role management |
| **Audit Log** | Searchable history of every admin action |
| **System Health** | Pipeline / Reconciliation / Data Flow docs (3 tabs) |

---

## Admin Overview (the landing page)

What it does: situation room. Single page that answers "is the platform
healthy?" without scrolling.

| Section | Click action |
|---|---|
| **Hero — this-month commissions** | View only. Shows total $ + Δ vs last month. Read from `agent_earnings_summary`. |
| **Platform stats: Agents** | Click → `/admin/agents` (Agent Network) |
| **Platform stats: Clients** | Click → `/admin/agent-summary` (browse via picker) |
| **Platform stats: Trading accounts** | Click → System Health → Pipeline tab |
| **Platform stats: Products** | Click → `/admin/products`. Badge shows N if any product missing rate config. |
| **Health panel: Commission engine** | Click → System Health → Pipeline. Shows last cycle status, dead jobs (DLQ), insertion rate. |
| **Health panel: MT5 snapshots** | Click → System Health → Pipeline. Shows freshness, pending logins. |
| **Health panel: Reconciliation** | Click → System Health → Reconciliation tab. Engine-vs-MT5 drift % over the last 30d. |
| **30-day revenue chart** | View only. Daily commission + rebate stacked. |
| **Top agents · this month** | Each row links to `/admin/agents/<id>` (Agent Detail). |
| **Recent audit feed** | Click "Full audit log →" to drill in. |
| **Refresh button** | Force re-fetch of `/api/admin/dashboard`. |

---

## Commission Tree (the rates + earnings page)

The most-used admin page. Lists every agent in a branch as a tree, showing
their products + rates + total earnings.

### Header buttons

| Button | What it does | CRM cost |
|---|---|---|
| **Sync products** | Walks every imported agent's product list from xdev CRM. Adds new links. **Deactivates** links the CRM no longer lists (e.g. "Sophia lost product X"). Manual rate edits preserved. | ~5–15 calls (paginated `/api/products`, products carry agents inline). Bounded by # of products, not # of agents. **Light.** |
| **Sync rates (smart)** | Pulls each agent's `% + $/lot` config from CRM into `crm_commission_levels`. **Skips agents synced within the last 24h** to spare CRM. | First click after >24h: up to ~1,400 calls. Repeat clicks within 24h: near-zero. **Smart.** |
| **Force full** | Same as Sync rates but ignores the 24h skip — re-pulls every agent. Use when you know rates definitely changed and need them right now. | Always ~1,400 calls. **Heavy.** |
| Branch dropdown | Filter the tree to one branch. |
| Search box | Filter agents by name (matches on the tree). |

### Per-agent / per-product actions

| Button | What it does |
|---|---|
| Agent name (clickable) | → `/admin/agents/<id>` — full agent detail |
| Inline pencil on a legacy rate | Opens an editable rate input. Save validates against parent's ceiling; warns if descendants would exceed the new rate (cascade safety) |
| Expand/collapse caret | Show/hide the agent's sub-agents |

### Visual indicators on each row

| Indicator | What it means | Action |
|---|---|---|
| `≈ $X/lot` in **red** (with ⚠) on a child rate | Cascade violation — sub-agent's rate is higher than parent's on the same product (or parent doesn't hold the product). The CRM data needs fixing. | Edit `crm_commission_levels` in xdev so the child's rate ≤ parent's |
| `⚠ No CRM config` chip on a product | The product has a local rate (often product max as default) but no `crm_commission_levels` entry for this (agent, product). The engine math joins commission_levels directly so it earns $0 from this product. | Configure the agent's rate for this product in xdev → Sync rates |
| Collapsible banner at top: "N products need CRM commission configuration" | Summary of all No-CRM-config rows in the branch. Click to expand the full list. | Work through them in xdev |

---

## Agent Detail (`/admin/agents/<id>`)

Drill-down on one specific agent. Shows their products, sub-agents, clients,
and provides per-agent + per-subtree action buttons.

### Action buttons (in order on the page)

| Button | Scope | What it does | CRM cost |
|---|---|---|---|
| **Sync MT5 & Populate Commissions** | This agent's subtree | Calls MT5 bridge for every login in the subtree → fetches deals → updates `mt5_deal_cache`. Then chains a commission engine cycle. | 0 CRM calls. Bridge-only. |
| **Heal rates** | This agent only | For any product where this agent has `rate_per_lot = 0`, sets a sensible default (parent's rate or product max). Non-zero rates preserved. | 0 CRM calls. Local-only. |
| **Heal tree** | This agent + descendants | Same as Heal rates but walks the subtree top-down so children inherit fresh parent rates. | 0 CRM calls. |
| **Sync rates (self)** | This agent only | Pulls `% + $/lot` from CRM for just this agent. | 1–2 CRM calls. **Lightest CRM action.** |
| **Sync rates (subtree)** | This agent + descendants | Pulls rates from CRM for the agent + every sub-agent below. Smart mode skips agents synced in last 24h. | Subtree-size × 1-2 calls (typically ~10–50 calls for one branch). |

> **For "I just changed Sophia's rate in xdev, pull it now" workflows:**
> 1. Open Sophia's Agent Detail page
> 2. Click **Sync rates (self)** — 1-2 CRM calls
> 3. Done in ~2 seconds. Numbers update on next page refresh.

> **For "I just changed Hadi's whole branch's rates" workflows:**
> 1. Open Hadi's Agent Detail page
> 2. Click **Sync rates (subtree)** — covers Hadi + everyone under him only
> 3. Way cheaper than the global "Sync rates" on Commission Tree

### Other panels on Agent Detail

- **Linked products — CRM → portal** — table of products + rates
- **Sub-agents** — direct downline with quick links
- **Clients** — paginated list of agents' direct referrals
- **Commissions** — embedded `<CommissionsSection>` with date filter, charts, ledger

---

## Agent Summary (`/admin/agent-summary`)

Admin's "view as agent" tool. Pick any agent, see exactly what they see in
their portal — Summary view + Commissions view.

### Picker

Top of page. Searchable by name / email / branch. URL-bookmarkable as
`?agent=<id>`.

### Tabs (after picking)

| Tab | What it shows |
|---|---|
| **Summary** | Hierarchical roll-up: ★ Their accounts → Sub-agents → Clients. Lots, commission, deposits, withdrawals (date-scoped) + balance, equity (point-in-time). |
| **Commissions** | Same `<CommissionsSection>` as Agent Detail — full deal ledger, by-source/product/client breakdowns. |

### Buttons (always visible after picking)

| Button | What it does |
|---|---|
| **Change agent** | Toggles the picker dropdown |
| **Refresh MT5** | Calls bridge → updates `mt5_deal_cache` for this agent's subtree → chains commission engine. Toast shows "synced N · commissions populating in background". |
| **Detail** | → `/admin/agents/<id>` (full agent detail) |
| **Clear** | Reset picker |

### MT5 data freshness card (top of Summary tab)

Always visible when an agent is picked. Color-coded badge:
- 🟢 **Good** — most logins have cached deals
- 🟡 **Partial** — fewer than half have cached deals
- 🔴 **No deals fetched yet** — nothing in cache

Stats shown:
- Logins in subtree
- Logins with cached deals
- Latest deal timestamp (relative + absolute)
- Last bridge sync (relative + absolute)
- Oldest cached deal (historical depth)

#### "Fetch N missing" button (only shows when there's a gap)

| Field | What it does |
|---|---|
| **From** date picker | Choose start date for the fetch. **Bounded below by the global floor** (`settings.mt5_earliest_deal_date`). UI prevents picking earlier dates; backend re-enforces. |
| **Fetch N missing** button | Fires `POST /api/admin/agent-summary/<id>/sync-mt5?onlyMissing=true&fromDate=<date>` — pulls deals only for logins that have no cached data yet (skips already-fetched). Engine cycle chains automatically. |

### Date-range filter on the Summary tab

Inputs: **From** + **To** (YYYY-MM-DD). Empty = all time.

Affects: lots, commission, deposits, withdrawals (deal-aggregates).
Doesn't affect: balance, equity (those are MT5 "right now" snapshots).

URL-bookmarkable as `?agent=<id>&tab=summary&from=...&to=...`.

---

## System Health (`/admin/system-health`)

3-tab page. Replaces the old separate MT5 Sync Health, Reconciliation, and
Data Flow Docs pages.

### Pipeline tab

#### Real-time deal stream

Top card on the page. Shows webhook deals received from the MT5 bridge:

| Stat | Meaning |
|---|---|
| **Last 1 / 5 / 15 / 60 min** | Sliding-window counts of incoming webhook POSTs |
| **Since portal restart** | Total received / inserted (new) / rejected since last process start |
| **Last received** | Time of the most recent successful POST |
| **Last error** | If non-empty, the last reason a POST was rejected (bad secret, malformed, etc.) |

How to read it:
- **Healthy**: Last 5 min > 0 during broker hours, Last error = "No errors since restart" (green)
- **Stream broken**: Last 5 min = 0 during broker hours → bridge is dead, MT5 disconnected, or webhook secret mismatch
- **Auth issue**: Last error contains "invalid webhook secret" → bridge is running with a stale `MT5_WEBHOOK_SECRET` env var; restart the bridge with the launcher script

If the stream is broken but the cache is still filling (Deals · last hour > 0), the 5-min hot-sweep is doing the work — fix the stream when convenient, no immediate user-facing impact.

#### MT5 bridge gate

| Indicator | Meaning |
|---|---|
| Status (Active/Paused) | The kill switch state. Paused = no bridge calls fire. |
| Rate limit | Max requests/sec (default 20) |
| Concurrency | Max in-flight calls (default 16) |
| Balance cache | # of cached `/balance` responses (10s TTL) |

#### Engine cycles

Last 20 commission engine cycles. For each: started time, status, jobs/deals
inserted, duration, trigger source (scheduled / admin manual / agent refresh).

#### Buttons

| Button | What it does |
|---|---|
| **Run cycle now** | Fires a global commission engine cycle (`POST /api/admin/mt5-sync/run`). Disabled when bridge is paused. |
| **Pause bridge** / **Resume bridge** | Flips `settings.mt5_paused`. When paused, every bridge call throws `Mt5PausedError` immediately. |
| **Refresh** | Re-fetches the dashboard data. |

#### Snapshot sync settings

| Field | What it controls |
|---|---|
| **First-sync lookback (days)** | When a login is synced for the first time, how far back do we pull deals from. Default 60. After that, the cursor is incremental. |
| **Earliest deal date (global floor)** | **Hard cap.** No deal older than this is fetched OR stored — even if a per-agent backfill asks for earlier data. Currently `2026-03-01`. |

### Reconciliation tab

Compares engine-computed totals to MT5's raw `deal.commission`. Flags drift.

- Top banner: engine total vs MT5 total for the period + drift %
- Per-agent table: each agent's engine-computed share vs their clients' MT5-charged commission
- Per-login table: logins where engine ≠ MT5 by more than threshold

### Docs tab

Embedded view of `DATA_FLOW.md`. Plain-English data-flow reference.

---

## Live progress for long operations

Since 2026-05-04, every long-running admin action shows live progress.

### Where you'll see it

- **The action button itself** — clicking opens a modal that polls
  `/api/admin/jobs/:id` every second.
- **Sidebar footer** — an "Active jobs" chip appears whenever there's at
  least one running job. Click to expand the list of in-flight jobs; click
  any row to open the same progress modal.

### What the modal shows

- Current step + step count (e.g. `Step 2/4 · 8s · 32%`)
- Animated progress bar
- Live current-step label (updates as the operation moves through phases)
- Optional sub-progress (e.g. `Subtree 3 of 5`)
- Click "Show step history" to see the running timestamped log
- On success: a green summary card with `created · updated · contacts · MT5 logins`
- On failure: a red error message; modal stays open for inspection

### Operations instrumented

| Operation | Page | What you'll see |
|---|---|---|
| Onboard / Import selected / Import all pending | Import Agents | 4 steps: validate → import agents → auto-finish → hierarchy ingest |
| Sync contacts from CRM | Tools ▾ | Page-by-page progress + match counts |
| Fix all imported | Tools ▾ | 3 steps: products → rates → rebuild commissions |
| Refresh from CRM | Tools ▾ | Page-by-page progress over 16 pages |
| Sync product links | Tools ▾ | Single step with completion summary |
| Backfill parents | Tools ▾ | Per-agent progress |
| Sync products / rates / Force full | Commission Tree header | Per-agent progress |
| Refresh MT5 | Agent Summary | Login-by-login sync count |

### How it works

In-memory `services/jobTracker.js` keeps a `Map<jobId, jobState>`. The
frontend pre-generates a UUID, sends it as `X-Job-Id` header, and opens the
modal. The backend updates the same id at each milestone. Auto-cleanup
removes jobs 10 minutes after completion. No persistent storage — restarts
wipe the active list (any in-flight modals will gracefully close on 404).

---

## CRM Gate chip (bottom-left sidebar, admin only)

Floating chip showing the gate state. Polls adaptively:
- Tab hidden → no polling
- Tab visible, idle → 30s
- Tab visible, busy → 5s

| Section | What it shows |
|---|---|
| Status | Active / Paused |
| Rate limit | Current setting (default 4 req/s) |
| In-flight / queued counts | Live |
| Daily budgets (expanded) | Per-endpoint usage today vs daily cap |
| Circuit breakers (expanded) | Any tripped endpoints |

| Button | What it does |
|---|---|
| **Pause** (when active) | Confirms then sets `settings.crm_paused = true`. Every new CRM call throws `CrmPausedError` until you resume. |
| **Resume** (when paused) | Sets `settings.crm_paused = false`. |
| **Chevron** | Expand/collapse details |

---

## Worst-case latency (how long until things show up)

After 2026-05-04 improvements:

| Event | Time to appear in portal |
|---|---|
| New deal on actively-trading login | **≤ 5 min** (MT5 hot-login sweep) |
| New deal on dormant login | ≤ 30 min (regular MT5 sweep) |
| New trading account on existing client | ≤ 30 min (branch hierarchy refresh) |
| New client added to CRM | ≤ 15 min (contact poll page-1) |
| New sub-agent under an imported agent | ≤ 30 min (branch hierarchy refresh) |
| New agent in a brand-new branch | ≤ 24 h (daily CRM agent refresh @ 04:00 UTC) |
| Manual admin action via UI | Real-time (live progress modal) |

The remaining gap (sub-second deal latency) is closed by the optional
real-time MT5 webhook — requires the broker to grant deal-stream permission
to the manager login. See `ARCHITECTURE.md` § MT5 Bridge.

---

## Background schedulers (run automatically)

The backend runs **seven** schedulers in-process. All controlled via env vars;
no manual triggers needed for daily operations.

| Scheduler | Interval | Env var | What it does |
|---|---|---|---|
| **Commission engine** | 15 min | `ENABLE_COMMISSION_ENGINE=true` | Reads `mt5_deal_cache` → walks the agent waterfall → inserts `commissions` rows. Idempotent. |
| **MT5 active-login sweep** | 30 min | (same) | Pulls fresh deals from the bridge for any login active in last 7 days OR synced >50 min ago. Triggers a commission cycle if new deals arrive. |
| **MT5 hot-login fast sweep** | 5 min | `ENABLE_MT5_HOT_SWEEP=true` | Sweeps ONLY logins active in last 24h. Sub-5-min latency for actively-trading accounts. Bridge-only — no CRM/Supabase load. |
| **Contact poll** | 15 min | `ENABLE_CONTACT_POLL=true` | Reads page 1 of `/api/contacts` (newest-first), stops at checkpoint, imports any new contact whose `connectedAgent` matches an imported agent. Cost per tick: 1-3 CRM calls. |
| **Branch hierarchy refresh** | 30 min | `ENABLE_BRANCH_HIERARCHY_POLL=true` | Calls `/api/agent-hierarchy?branchIds=…` per imported branch — single call returns full subtree (agents + clients + leads + MT5 logins). Catches new sub-agents and new TAs on existing clients. |
| **Daily CRM agent refresh** | 24 h at 04:00 UTC | `ENABLE_DAILY_AGENT_REFRESH=true` | Pulls `/api/agents/query` so new agents/branches in xdev appear in the Import Agents picker without admin clicks. ~16 CRM calls/day. |
| **Housekeeping** | 24 h | always on | Trims old `engine_jobs`, retired cycles, and `audit_log` rows. |

### Contact poll + auto-resume

- **First-ever tick:** establishes the checkpoint at "newest seen now" and
  imports nothing. The full sweep is done via Onboard.
- **Subsequent ticks:** stop at the boundary, only insert true new arrivals.
- **Auto-resume aborted sweeps** (since 2026-05-04): if a manual sweep aborts
  mid-flight (budget hit, kill switch), the resume state is persisted in
  `settings.contact_sync_pending_resume`. The next contact poll tick continues
  from the saved page.
- **Phase 3 stale-TA refresh:** each tick refreshes trading accounts for up
  to 20 clients whose `trading_accounts_synced_at` is older than 6 hours.
- **Tunables:** `CONTACT_POLL_INTERVAL_MIN` (default 15), `CONTACT_POLL_DELAY_MIN`
  (default 5), `CONTACT_POLL_MAX_PAGES` (default 3, capped at 10).

---

## Settings page (`/settings`)

Stored in `settings` DB table — runtime-editable, no redeploy needed:

| Setting key | Where it's edited | What it controls |
|---|---|---|
| `crm_base_url` | Settings → Integrations | xdev CRM API base URL |
| `crm_api_key` | Settings → Integrations | xdev CRM auth key |
| `crm_paused` | Sidebar chip | Kill switch for all CRM calls |
| `mt5_paused` | System Health → Pipeline | Kill switch for all MT5 bridge calls |
| `mt5_server` / `mt5_port` / `mt5_login` / `mt5_password` | Settings → MT5 Manager API | MT5 Manager API connection. Bridge fetches these via `GET /api/settings/mt5/internal` on startup/reconnect. After saving, click "Save & reconnect" to apply without a bridge restart. |
| `mt5_server_tz_offset_hours` | Settings → MT5 Manager API | Broker MT5 server's timezone offset from UTC, in hours. Required because `IMTDeal.Time()` returns broker-local seconds, not UTC. **Default 3** (UTC+3 — BBCorp). If you change this, restart the portal AND run the historical backfill SQL (see below). |
| `mt5_initial_lookback_days` | System Health → Pipeline → Snapshot sync settings | First-sync lookback window. Default 60. |
| `mt5_earliest_deal_date` | System Health → Pipeline → Snapshot sync settings | **Hard floor on deal ingest.** No deal older than this gets fetched/stored. |
| `mt5_volume_divisor` | DB-only (advanced) | MT5 volume → lots conversion (default 10000) |
| `mt5_rate_per_second` / `mt5_max_concurrency` | DB-only (advanced) | Bridge gate tuning |

---

## Common admin workflows

### "I want to add a new agent and start tracking their commissions"

The **one-click Onboard** flow does the whole chain automatically. Since
2026-05-04 it's powered by the new `/api/agent-hierarchy` CRM endpoint, which
returns an agent's full subtree (agents + clients + leads + MT5 logins) in
ONE call instead of 272 paginated `/api/contacts` calls.

1. **Onboarding → Import Agents** → click the branch on the left
2. Tick the agent's row (or search by name/email/ID first)
3. Click **Onboard selected** (or **Import all pending** for the whole branch)
4. **A live progress modal opens** showing each step in real time:
   - Step 1/4: Validating + resolving pick list…
   - Step 2/4: Importing N agents + recursive subtree…
   - Step 3/4: Pulling subtree N/M from CRM hierarchy…
   - Step 4/4: Done

5. Behind the scenes the chain runs:
   - **Pre-pass parent backfill** for the branch (so sub-agents get correct `referred_by`)
   - **Recursive subtree expansion** — the picked agent + every descendant in our local mirror
   - **Passes 1-3:** insert into `users`, wire parent links, sync products + rates
   - **Pass 4:** trading-accounts for any clients already in our DB
   - **Auto-finish:** commission-level sync for each new agent
   - **NEW: agent-hierarchy ingest:** one CRM call per picked agent returns the full subtree; walked and upserted as agents + clients + leads + MT5 logins
   - **Self-healing straggler pass:** re-runs Pass 1-3 to catch sub-agents whose parent links were finalized during contact sync

6. Result: agent + sub-agents + their clients + leads + trading accounts all
   imported. Default password for new `users` rows: `Portal@2026` (configurable
   via `PORTAL_DEFAULT_AGENT_PASSWORD` env).

7. **Time:** ~5 seconds per agent (was ~5 minutes pre-2026-05-04).

8. New clients added to xdev after this point are picked up automatically:
   - **Within ≤ 15 min** by the contact poll (cheap page-1 detector)
   - **Within ≤ 30 min** by the branch hierarchy refresh (comprehensive)
   - **Within ≤ 5 min for actively-trading accounts** by the MT5 hot-login sweep

### "Reset a user's password"

1. **Operations → Staff Users**
2. Find the user, click **Reset password** in the row
3. Enter new password (min 8 chars) → Set new password
4. Hand the new password to the user through a secure channel

This works for admins, agents, and demoted reps. Idempotent.

### "Sales team changed Sophia's commission rate in CRM, pull it now"

1. **Agent Detail** for Sophia → **Sync rates (self)**
2. ~2 seconds, 1–2 CRM calls
3. Reload to see updated rates in Commission Tree

### "I removed product X from agent Y in xdev. Why is it still showing in the portal?"

1. **Commission Tree** → header → **Sync products**
2. The removal pass deactivates products no longer in CRM (since 2026-04-25)
3. Sophia's stale product disappears

### "Refresh deals for one specific agent"

1. **Agent Summary** → pick agent → **Refresh MT5** (top right)
2. OR if you only want to fetch deals for unfetched logins (more targeted): **Fetch N missing** in the freshness card with optional date picker

### "An agent's commissions look wrong — investigate"

1. **Reconciliation** tab on System Health → check drift per-agent
2. **Agent Detail** for that agent → review the **Linked products** rates
3. **Commissions** tab on Agent Summary → check the per-deal ledger
4. If MT5 numbers don't match: sales team needs to verify in xdev. If portal shows wrong total: rate may need re-sync.

### "Bridge crashed and we missed N hours of deals"

1. Bring bridge back online — **always use the launcher**:
   ```powershell
   pwsh C:\live-crm-sales\mt5-bridge\start-bridge.ps1
   ```
   Do NOT double-click `mt5-bridge.exe` — without env vars set, every webhook POST will 401 and you'll lose the real-time stream.
2. **System Health → Pipeline → Resume bridge** (if the gate was paused)
3. Wait for the next scheduled snapshot sync (5-min hot-sweep) OR
4. **Agent Summary** → pick affected agent → **Refresh MT5** to pull immediately
5. Verify on **System Health → Real-time deal stream** card that "Last 1 min" goes back above 0

### "What happens to deals from broker clients we haven't imported?"

**Dropped at the door, not stored.**

The MT5 bridge subscribes to ALL deals on the broker's manager — that includes thousands of retail accounts unrelated to our IB agents. The portal webhook receiver filters at ingress: it keeps an in-memory `Set` of logins that belong to imported clients (`trading_accounts_meta.login WHERE client_id IS NOT NULL`), refreshed every 60 s. Webhooks for logins NOT in the set return `200 OK { skipped: 'unknown_login' }` immediately and write nothing.

Where to see this on the System Health page → "Real-time deal stream" card:
> *Since portal restart: 245 received · 8 new · 237 skipped (other broker clients)*

Typical ratio is ~95% skipped. That's expected — most of the broker's MT5 server is retail accounts.

**What if a client gets imported AFTER deals have been flowing?**

Their pre-import deals are NOT in the cache. To backfill:
1. Wait for the snapshot sync to run (every 60 min by default) — it'll pull 60 days of history for newly-attached logins, OR
2. Click **Agent Detail → Refresh MT5** to pull immediately, OR
3. Run **Agent Summary → Refresh MT5** for the agent's full subtree

The 60-day window is governed by `settings.mt5_initial_lookback_days` (admin → System Health → Snapshot sync settings), bounded above by `settings.mt5_earliest_deal_date` (the global hard floor).

### "Real-time deal stream shows 0 in Last 5 min"

Diagnose top-down:

1. **Bridge alive?** → admin Settings page → "MT5 Manager API" section → click "Check bridge status". Should show MT5 connected (green).
2. **Bridge auth OK?** If "Check bridge status" says not connected, click "Save & reconnect". Watch `C:\live-crm-sales\mt5-bridge\bridge-run.log` for the connection result.
3. **Webhook secret matches?** → "Real-time deal stream" card → "Last error" field. If it says "invalid webhook secret", the bridge process was started without `MT5_WEBHOOK_SECRET` env var. Restart with the launcher script (see above).
4. **Broker market hours?** Outside trading hours, deal flow is naturally 0. Check during a known-active session.
5. **Source IP whitelist?** If `mt5Connected: true` but `[DealSink] Subscribed: MT5_RET_ERR_NETWORK` appears in the bridge log, ask the broker to whitelist this server's outbound IP at the manager-API endpoint.

### "Last deal cached" shows a negative time / future timestamp

Cause: `settings.mt5_server_tz_offset_hours` is wrong (or unset) for this broker. The MT5 Manager API returns deal times as **broker-local seconds**, not UTC — the portal subtracts this setting before storing.

Fix:
1. Set the correct offset in admin Settings → MT5 Manager API → "MT5 Server TZ Offset (hours)". For BBCorp it's `3`. Confirm with the broker if unsure.
2. Restart the portal (the value is cached at startup).
3. Run a one-time backfill against the historical data:
   ```sql
   -- Replace 3 with whatever offset you set
   BEGIN;
   UPDATE mt5_deal_cache SET deal_time = deal_time - INTERVAL '3 hours';
   UPDATE commissions    SET deal_time = deal_time - INTERVAL '3 hours';
   COMMIT;
   ```
   Note: only run this ONCE. The two `UPDATE`s should run in a single transaction so they stay consistent. After this the in-memory cache picks up the new offset for going-forward writes.

### "Some engine cycles show 'running' for hours with 0 jobs done"

These are **orphans** — cycles that were in flight when the portal process exited (restart, crash, kill). The in-memory `isRunning` lock and the worker tasks died with the process, but the DB row stayed `status='running'` because the cleanup code never got to commit a final state.

**No fix needed at runtime** — on every portal startup, `cleanupOrphanedCycles()` runs automatically and:
1. Marks every `running` cycle as `abandoned` (with `finished_at = NOW()`)
2. Resets every `running` job back to `queued` so the next cycle re-claims them

If you ever want to clean them up manually outside of a restart, run:
```sql
UPDATE commission_engine_cycles
   SET status='abandoned', finished_at=NOW()
 WHERE status='running';
UPDATE commission_engine_jobs
   SET status='queued', started_at=NULL, next_retry_at=NULL
 WHERE status='running';
```

**Why does this happen?** The portal's commission-engine cycle takes ~13 minutes for ~1700 logins. Any restart that lands inside that window leaves the cycle row stuck. Pre-2026-05-04 this was rarer because cycles were the primary path; now with real-time webhook the cycles are mostly idle backstops, so the visual cruft was more noticeable.

**Safe to clear during a real cycle?** No — only abandon a `running` row if you're sure no portal process is actually working on it. The auto-cleanup at startup is safe because by definition a fresh process can't have inherited an old in-memory lock.

### "Why are cycles running every 60 minutes now instead of every 15?"

Because the **per-webhook commission trigger** writes commission rows to the DB within ~1 second of each deal. The scheduled cycle is now a backstop — it catches anything the webhook missed (network blip, portal restart, brand-new login awaiting product mapping). 60 min is plenty for that role; 15 min was overkill and produced overlapping cycles that were 95% no-ops.

If you need faster scheduled cycles for any reason (e.g. testing rate changes), edit `COMMISSION_SYNC_INTERVAL_MIN` in `backend/.env` and restart.

### "Commissions are appearing 1 second after the deal — is this expected?"

Yes — that's the **per-webhook commission trigger** working as designed.

Each deal that lands via `POST /api/mt5/webhook/deal` is added to an in-memory queue (deduped by `login`). A worker drains the queue every 1 second and runs `processLogin()` for each — writing commission rows to the DB right then.

The 15-minute engine cycle still runs as a backstop. If real-time write fails for any reason (DB blip, portal restart mid-handler), the cycle catches the missed deal on its next pass.

If you want to disable real-time and rely only on cycles (e.g. for load testing): comment out the `pendingCommissionLogins.add(login)` call in `routes/mt5Webhook.js`. The cycle handles everything from there.

---

## Common agent workflows (what an agent sees)

### "Why am I seeing $0 earnings?"

The agent's **Commissions** page shows a banner at the top with one of:
- 🟢 **Healthy** — data is current
- 🟡 **Awaiting deals** — rates set, waiting for MT5 sync
- 🟡 **Awaiting next cycle** — deals cached, engine just hasn't run yet
- 🟠 **Zero earnings** — sub-agents are absorbing the full rate (no override left)
- 🔴 **No rates** — admin hasn't configured rates yet

The banner explains exactly what's missing in plain English.

### Agent has their own personal MT5 accounts

These show up at the **top of the Summary** under "★ My accounts" with their
own subtotal row. Personal accounts + downline are summed into the grand total.

---

## Troubleshooting reference

| Symptom | First thing to check |
|---|---|
| Refresh MT5 fails with "bridge unreachable" | Bridge process down → `pm2 restart mt5-bridge` (prod) or `dotnet run` (dev) |
| Refresh MT5 fails with "MT5 bridge is paused" | System Health → Resume bridge |
| Sync products / rates fails with "CRM is paused" | Sidebar chip → Resume CRM |
| Commission History shows old data | Engine cycle hasn't run for new deals → click "Run cycle now" on System Health |
| Date picker won't accept a pre-March-1 date | Global floor is enforced. Edit on System Health → Pipeline → Earliest deal date if business policy changed. |
| Agent's freshness shows ❌ "No deals fetched" | Click "Fetch N missing" on the freshness card |
| Sophia still shows a product CRM removed | Commission Tree → Sync products (now does deactivation pass) |

---

## API reference (admin endpoints, abbreviated)

For full route inventory see `CLAUDE.md` and the source code.

| Endpoint | What it does | Cost |
|---|---|---|
| `POST /api/agents/sync-products-from-crm` | Bulk product list + deactivation pass | ~10 CRM calls |
| `POST /api/agents/sync-commission-levels` | Bulk rates, smart-skip 24h | up to ~1,400 (first run), 0 (within 24h) |
| `POST /api/agents/sync-commission-levels?staleAfterHours=0` | Force-full bulk rates | ~1,400 every time |
| `POST /api/agents/:id/sync-commission-levels` | One-agent rates | 1–2 |
| `POST /api/agents/:id/sync-commission-levels-subtree` | Agent + downline rates, 24h skip | subtree-size × 1–2 |
| `POST /api/agents/:id/sync-mt5-snapshot` | One-agent MT5 deals (chains engine) | 0 CRM, ~3 bridge per login |
| `POST /api/admin/agent-summary/:id/sync-mt5` | Same, exposed under agent-summary route | Same |
| `POST /api/admin/agent-summary/:id/sync-mt5?onlyMissing=true&fromDate=YYYY-MM-DD` | Targeted: only logins with no cached data, optional start date | Same, narrower scope |
| `POST /api/admin/mt5-sync/run` | Run a global commission engine cycle now | 0 CRM, 0 bridge |
| `POST /api/admin/mt5-sync/pause` / `resume` | Flip MT5 gate | 0 |
| `POST /api/admin/crm/pause` / `resume` | Flip CRM gate | 0 |
| `PUT  /api/admin/mt5-sync/settings/lookback-days` | Set first-sync lookback days | 0 |
| `PUT  /api/admin/mt5-sync/settings/earliest-deal-date` | Set the global deal floor | 0 |

---

## When to call which Sync button (quick decision tree)

```
"I need fresh CRM data for one agent"
  → Agent Detail → Sync rates (self)         [1-2 CRM calls]

"I need fresh CRM data for one agent + their downline"
  → Agent Detail → Sync rates (subtree)       [subtree × 1-2, 24h skip]

"I need fresh CRM data for everyone"
  → Commission Tree → Sync rates (smart)      [up to ~1,400, 24h skip]

"I need EVERYONE re-pulled regardless of when last synced"
  → Commission Tree → Force full              [~1,400 always]

"A product got added/removed in CRM"
  → Commission Tree → Sync products           [~10 calls]

"I need fresh MT5 deals for one agent"
  → Agent Summary (pick agent) → Refresh MT5  [0 CRM, bridge calls per login]

"I need fresh MT5 deals only for logins that have NEVER been fetched"
  → Agent Summary → Fetch N missing            [Same, only un-fetched logins]
```
