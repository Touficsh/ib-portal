# IB Portal — Owner Handbook

A plain-language guide for the people running this system day-to-day. No
coding required to understand any of it.

> If you're a developer, see [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md),
> [DATA_FLOW.md](DATA_FLOW.md), and [OPERATIONS_GUIDE.md](OPERATIONS_GUIDE.md)
> for the technical details.

---

## 1. What is this portal?

It's the place where your **Introducing Broker (IB) agents** can:

- Log in and see their own clients
- See the commissions they've earned
- See their sub-agents and what each is producing
- Download statements

And where **you (the admin)** can:

- Add new agents and assign them commission rates
- Watch the money flowing in real-time as clients trade
- Investigate problems when an agent says "my numbers look wrong"
- Check the system's health

Behind the scenes, the portal pulls data from two places:

1. **The CRM** (xdev) — knows who your agents are, who their clients are,
   and what the agreed commission rates are.
2. **The MT5 broker server** — knows every trade every client makes, how
   much commission the broker charged, etc.

The portal stitches both together to compute "agent X earned $Y this month".

---

## 2. The three programs that need to be running

Think of the portal as three pieces that need to be on at the same time:

| Piece | What it does | How to know it's running |
|---|---|---|
| **Portal** | The website itself + the math engine | You can open the site in a browser at `http://localhost:3001/portal/` |
| **MT5 Bridge** | A small connector that listens to the broker's trade server in real time | Admin → System Health → bridge status shows "Active" |
| **Database** | Stores everything (agents, clients, deals, commissions) | If the portal loads and shows data, this is fine |

If any of these stops, the portal stops working properly. They are all
**configured to start automatically when the server boots**, so a routine
restart should bring everything back without you doing anything.

If something doesn't come back: see [Section 7: When something looks wrong](#7-when-something-looks-wrong).

---

## 3. The pages an admin uses most

When you log in as admin, the left sidebar shows several pages. The four
that matter most:

### 3.1 Agent Network
*"Who works for me?"*

Shows your agents in a tree — top agent at the root, their sub-agents below,
and so on. Click any agent to see their details.

**Use this when**: someone asks "is X an agent? Who's their parent?"

### 3.2 Agent Summary
*"How is one specific agent doing?"*

Pick an agent. You'll see:

- Every client under them (and the clients of their sub-agents)
- Each client's MT5 trading account: balance, equity, volume traded,
  commission charged by the broker, deposits and withdrawals
- A date range filter so you can look at a specific month/week

**Use this when**: an agent calls and says "my March numbers look wrong" —
this is your forensics page.

The "Refresh MT5" button on this page tells the bridge to pull the very
latest trade data for everyone in this agent's downline. Use it when you
want to see numbers as of right now (bypassing any caches).

### 3.3 Commission Tree
*"What is each agent earning?"*

Same tree as Agent Network, but with money. Each agent's row shows what
they're earning at their configured rates, and how that flows up to their
parent.

**Use this when**: setting or reviewing commission rates. You can see at a
glance whether the cascade math makes sense (parent earns the difference
between their rate and their child's).

### 3.4 System Health
*"Is everything running OK?"*

Three tabs:

- **Pipeline** — health of the MT5 connection and recent processing cycles.
  Look at the "Real-time deal stream" card: if "Last 5 min" is greater than
  zero during broker hours, the live feed is healthy.
- **Reconciliation** — compares what the portal computed to what the broker
  actually charged. If there's drift, this page shows it.
- **Docs** — opens this guide and the technical docs from inside the portal.

**Use this when**: anything feels off, OR as a daily/weekly sanity check.

---

## 4. The flow: how a real trade becomes a commission

The simplest way to understand the system is to follow a single trade:

```
1. A client opens a position on MT5
   ↓
2. The MT5 server tells our bridge instantly (within ~1 second)
   ↓
3. The bridge POSTs the trade to the portal
   ↓
4. The portal saves the trade to its database
   ↓
5. The portal looks up which agent owns this client
   ↓
6. The portal walks up the agent tree (sub-agent → parent → grandparent)
   ↓
7. For each agent in the chain, the portal applies their rate and writes
   a commission row
   ↓
8. The agent sees their new earnings in their portal within 1-2 seconds
```

**As a backup, the portal also asks the bridge once an hour** for the full
recent trade history. So even if the real-time path breaks for a while,
trades aren't lost — they just arrive a bit later.

---

## 5. Daily check-in (60 seconds)

Open Admin → System Health → Pipeline.

| Look at | Healthy looks like | Unhealthy looks like |
|---|---|---|
| Page badge at top | Green | "Warning" or "Error" badge with a message |
| Last deal cached | "X seconds ago" | "X hours ago" during broker hours |
| Real-time deal stream → Last 5 min | A number greater than 0 | "0" during a busy broker session |
| Bridge status | "Active" | "Paused" |
| Recent engine cycles | Mostly green "succeeded" | Several red "failed" or "abandoned" in a row |

If everything is green, you're done. The system is doing its job.

---

## 6. Common things you'll need to do

### 6.1 Add a new agent

Today (until the CRM auto-push is wired up), this is a manual step:

1. Make sure the agent already exists in the CRM (xdev).
2. In the portal: Admin → **Import Agents**.
3. Tick the agent (and their parent if they're a sub-agent of someone).
4. Click "Import".
5. The portal pulls their info from the CRM and creates their account.

The agent can now log in. Their commission rates flow in automatically. New
clients they refer will start counting toward their commissions immediately.

> **Heads up**: if a sub-agent gets created in the CRM **after** their
> parent is already imported, the sub-agent will NOT appear automatically.
> Re-run "Import Agents" on the parent to pull the new sub-agent in.

### 6.2 Change an agent's commission rate

Two ways:

- **From the CRM** (preferred): change the rate in xdev. The portal pulls
  it in within an hour. To force the update right now, click "Refresh MT5"
  on the agent's detail page (it pulls rates too).
- **Inside the portal** (override): Admin → **Commission Tree** → click
  the agent's row → adjust → save. This locally overrides what the CRM
  says. Use sparingly — it can drift from the CRM over time.

### 6.3 Investigate "my commission looks wrong"

Two-minute checklist:

1. Admin → **Agent Summary** → pick the agent → set the date range to the
   period in question.
2. Look at each client's row. Does the **Volume** + **Commission** column
   make sense? Compare against MT5.
3. If those numbers look right but the agent's earnings look wrong, the
   issue is in the rates — go to **Commission Tree** for that agent.
4. If those numbers look wrong, click "Refresh MT5" to force a fresh pull.
   If they're still wrong after refresh, the bridge or broker had an issue
   — see [Section 7](#7-when-something-looks-wrong).

### 6.4 Reset an agent's password

Admin → **Staff Users** → find the agent → "Reset password". A temporary
password is generated; share it with them.

---

## 7. When something looks wrong

### 7.1 "The portal won't open"

Try `http://localhost:3001/portal/` in a fresh browser tab.

- If the page never loads: the portal server is down. **Restart your
  computer** — the portal is configured to auto-start on login. If that
  doesn't bring it back, contact your developer.
- If you see a "Cannot connect" page: same as above.
- If you see the portal but it asks to log in again: your session expired.
  Log in normally.

### 7.2 "No new deals in the last 5 minutes" warning

This means the bridge thinks the broker isn't sending it any trades.
Possible causes, in order of likelihood:

1. **It's outside trading hours**. Friday after market close → Sunday
   evening, this is normal. The bridge will resume when the market
   reopens.
2. **The bridge can't reach the broker**. Admin → System Health →
   Pipeline. If the bridge status is red or grey, restart your computer
   (the bridge auto-starts on login). If after restart it's still red,
   contact your developer — most likely the broker rotated something
   on their end.
3. **The broker stopped allowing our IP**. Rare. Symptom: bridge says it's
   trying to connect but failing. The broker has an "allow list" of IPs
   that can connect to their MT5 manager API; if the server's IP changed
   for some reason, the broker has to update it. Contact them to verify.

### 7.3 "Numbers look stale on Agent Summary"

Click the **Refresh MT5** button on that page. It pulls the very latest
data from the broker. If it still looks stale after that, the bridge has
a real problem — see 7.2.

### 7.4 "Cycles are showing as 'failed' or 'running for hours'"

A "cycle" is the portal's regular job that turns trades into commission
records. A few orange/red entries in the Recent Cycles list are usually
**not a problem** — they get retried automatically and the next cycle
catches up. As long as the **most recent** cycle succeeded, you're fine.

If every cycle for the last hour has failed, contact your developer.

### 7.5 "I want to stop everything immediately"

There's a kill switch: Admin → System Health → Pipeline → **"Pause MT5"**
button (the red one).

This stops:

- The portal from accepting any new live trades from the bridge
- The portal from asking the bridge for any data
- New commission rows from being written

Trades happening on the broker keep happening — we just stop processing
them. When you click **"Resume MT5"**, the system will catch up
automatically (it goes back and pulls everything it missed).

Use this when:

- The broker is doing maintenance and is asking you to back off
- Something is wildly wrong and you want a moment to investigate without
  more data flowing in
- You're moving to a new server and want a clean cutover

---

## 8. What auto-starts when the server reboots

You don't need to do anything for these — they fire automatically:

| Service | When | Purpose |
|---|---|---|
| **Portal backend** | At your logon | The website + math engine |
| **MT5 bridge** | 90 seconds after your logon | The connector to the broker |

Both are registered in Windows Task Scheduler under your user account. To
view: Windows search → "Task Scheduler" → look for `IBPortalAutoStart` and
`MT5BridgeAutoStart`.

If your computer ever reboots **without** you logging in (e.g. from a
remote desktop disconnect), the services won't start until the next time
you log in. This is a quirk of how the auto-start works today; ask your
developer if you want a true "starts at boot regardless of login"
configuration.

---

## 9. Privacy — who sees which client names

This system has a privacy layer that protects sub-agents' clients from
being visible by name to the agent above them. It matters because
upstream agents in an IB tree should be able to see *what's flowing
through their book* (volumes, commissions, balances) without knowing
*every personal name* of someone else's clients.

### What's hidden by default

When an agent looks at their Summary / Commissions / Dashboard /
Trading Accounts page, here's what they see:

| What | Visible? |
|---|---|
| **Their own direct clients' names + emails** | ✅ always |
| **Their direct sub-agents' names** (the colleagues they imported) | ✅ always |
| **Clients whose owning agent is a sub-agent below them** | ❌ name + email hidden by default |
| **Volumes, commissions, balances, MT5 logins of those hidden clients** | ✅ always — only the name and email get hidden |

In the UI, a hidden row shows as `🔒 MT5 #57755` (the MT5 login as the
stable identifier) instead of the client's name.

### How a sub-agent grants visibility

A sub-agent who *wants* their parent to see their clients' names can
opt in:

1. Log in as that sub-agent.
2. Bottom-left sidebar → **Privacy** button.
3. Toggle on: *"Share client names with my parent agent."*

Once enabled, the parent immediately sees the full names + emails on
their next page refresh. The sub-agent can flip it off again any time.

### Admin views always see everything

The admin console (Agent Summary on the admin side, /admin/agents, etc.)
**bypasses the privacy gate**. Admins always see full names + emails
regardless of any sub-agent's setting. This is intentional — the admin
runs the system and needs full visibility for support, compliance, and
forensics.

### Common admin questions

**Q: An agent says they can see a client's name they shouldn't.**
Check whether the client's owning sub-agent has enabled name-sharing.
Admin → Audit Log → filter by `portal.me.privacy.update` — you can see
who turned it on and when.

**Q: An agent says they CAN'T see a client's name they expect to.**
The client is owned by a sub-agent who hasn't granted sharing.
That's working as designed. Tell the agent to ask their sub-agent
to enable the toggle, OR have the admin look it up on their behalf.

**Q: Can I override a sub-agent's privacy from the admin console?**
No — the toggle is the sub-agent's decision. Admins can see the names
themselves (the gate bypasses for admin views) but can't force the
parent agent to see them.

**Q: What about leads vs clients?**
Same treatment. Both are stored as individuals; the redaction applies
identically regardless of pipeline stage.

---

## 10. Things only your developer should touch

Don't try these yourself unless you're comfortable with computers and the
developer is unreachable:

- Editing any files inside `C:\ib-portal\backend\` or
  `C:\ib-portal\mt5-bridge\`
- The Settings page → "MT5 Server TZ Offset" or "MT5 Server" fields
- The Settings page → "CRM Base URL" or "CRM API Key" fields
- Anything labeled "advanced" or "DB-only"

If you have to: the system is forgiving. Wrong values usually just produce
visible errors on the System Health page. Worst case: contact developer,
restore from a recent backup.

---

## 11. Glossary

In case any term feels foreign:

- **Agent** — a person you pay commission to for bringing in clients.
- **Sub-agent** — an agent who works under another agent. Earns a portion;
  the parent earns the difference.
- **IB** — Introducing Broker. Same idea as agent.
- **MT5** — MetaTrader 5, the trading platform your broker runs.
- **Broker** — the company that runs the MT5 trading server (whoever your
  clients trade against).
- **Bridge** — a small program on this server that listens to the broker's
  MT5 server and tells the portal about each trade.
- **CRM** — Customer Relationship Management. Here it means the xdev
  system where contacts, agents, and rates live as the source of truth.
- **Deal** — one trade transaction recorded by MT5 (one buy, one sell, one
  deposit, etc.). A round-trip trade is two deals (open + close).
- **Cycle** — a periodic job the portal runs to turn deals into commission
  records.
- **Lot** — the standard unit of trading volume in MT5.
- **Pipeline** — the chain of: broker → bridge → portal → database →
  commission rows.

---

## 12. Who to contact

| Question | Contact |
|---|---|
| "An agent's commission is wrong" | Your developer (after Section 6.3 checks) |
| "The portal isn't loading" | Your developer (after Section 7.1 checks) |
| "The broker says we're hitting their server too hard" | Pause MT5 immediately (Section 7.5), then your developer |
| "I need to add a new agent" | You can do this yourself (Section 6.1) |
| "I need to change a commission rate" | You can do this yourself (Section 6.2) |
| "The broker said they need to whitelist a new IP" | Your developer |
| "I want to add another admin user" | Admin → Staff Users → Add |
