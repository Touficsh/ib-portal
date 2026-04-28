import { FileText, Database, CloudDownload, Activity, PauseCircle, AlertTriangle, Wrench, Link2, Gauge, RefreshCw } from 'lucide-react';

/**
 * Admin — Data Flow (plain-English reference)
 *
 * Mirrors /DATA_FLOW.md at repo root. Single-source-of-truth is the markdown
 * file; this component is a formatted, read-only in-portal view for anyone
 * (technical or not) who wants to understand where our data comes from.
 *
 * Sections (top → bottom):
 *   1. The three "filing cabinets" — CRM, MT5 bridge, our notebook
 *   2. The common data — how CRM and MT5 connect via MT5 login number
 *   3. What we copy from each source
 *   4. The full flow in one picture
 *   5. A concrete example (one trade, end to end)
 *   6. Freshness of each view
 *   7. What happens on server restart
 *   8. The CRM gate (what protects us)
 *   9. Deeper reference — tables, schedules, triage query
 */

function Pill({ children, tone = 'muted' }) {
  const toneMap = {
    muted:   { bg: 'var(--bg-elev-2)',     color: 'var(--text-muted)' },
    accent:  { bg: 'var(--accent-soft)',   color: 'var(--accent)' },
    warn:    { bg: 'var(--warn-soft)',     color: 'var(--warn)' },
    danger:  { bg: 'var(--danger-soft)',   color: 'var(--danger)' },
    success: { bg: 'var(--success-soft)',  color: 'var(--success)' },
  };
  const t = toneMap[tone] || toneMap.muted;
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 8px',
      borderRadius: 999,
      background: t.bg,
      color: t.color,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Card({ title, icon, subtitle, children }) {
  return (
    <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
      <div className="card-header">
        <h2>
          {icon && <span style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }}>{icon}</span>}
          {title}
        </h2>
        {subtitle && <span className="muted small">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function SourceCabinet({ emoji, name, owns, url }) {
  return (
    <div style={{
      flex: 1,
      minWidth: 220,
      padding: 16,
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--bg-elev-1)',
    }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>{emoji}</div>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{name}</div>
      <div className="muted small" style={{ marginBottom: 8 }}>{owns}</div>
      {url && <div className="mono small muted">{url}</div>}
    </div>
  );
}

export default function DataFlowDocs() {
  return (
    <div>
      <header className="page-header">
        <div>
          <h1><FileText size={18} style={{ verticalAlign: -3, marginRight: 8 }} />Data flow</h1>
          <p className="muted">
            Where our data comes from, where it lands, and how the pieces fit
            together. Written for anyone — no database experience required.
          </p>
        </div>
      </header>

      {/* 1. THE THREE CABINETS */}
      <Card title="The big picture — three filing cabinets" icon={<Database size={15} />}>
        <div className="pad">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <SourceCabinet
              emoji="📋"
              name="xdev CRM"
              owns="Source of truth for people. Knows who everyone is, which branch they're in, who referred them, what MT5 account they opened."
              url="https://crm-api.bbcorp.trade"
            />
            <SourceCabinet
              emoji="🔢"
              name="MT5 bridge"
              owns="Source of truth for trades. Knows every deal made — who (by account number), when, how much volume, how much commission."
              url="localhost (our own infra)"
            />
            <SourceCabinet
              emoji="📘"
              name="Our database"
              owns="Our own working copy. We don't invent data — we copy bits we need from CRM and MT5 and keep them organized."
              url="Postgres (Supabase)"
            />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            <b>Nothing in the portal UI talks to CRM or MT5 directly.</b> Every
            page reads from Postgres. External calls only happen in the
            background — scheduled syncs, admin clicks, and commission engine
            runs.
          </p>
        </div>
      </Card>

      {/* 2. THE COMMON DATA */}
      <Card title="The common data — how CRM and MT5 connect" icon={<Link2 size={15} />}>
        <div className="pad">
          <p style={{ marginTop: 0 }}>
            The CRM and MT5 are <b>completely separate systems</b>. They don't
            talk to each other. Our portal is the thing that stitches them
            together.
          </p>
          <p>The glue is a single number: <b>the MT5 login</b>.</p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 20,
            alignItems: 'center',
            padding: 20,
            background: 'var(--bg-elev-1)',
            borderRadius: 'var(--radius)',
            marginBottom: 16,
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>📋</div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>CRM knows</div>
              <div className="muted small">Customer "Ahmad" has login <span className="mono" style={{ color: 'var(--accent)' }}>12345</span></div>
            </div>
            <div style={{ fontSize: 28, color: 'var(--accent)', fontWeight: 700 }}>↔</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>🔢</div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>MT5 knows</div>
              <div className="muted small">Login <span className="mono" style={{ color: 'var(--accent)' }}>12345</span> made a 0.5 lot trade</div>
            </div>
          </div>
          <p style={{ marginBottom: 0 }}>Neither side knows both halves. So our portal's job is:</p>
          <ol style={{ lineHeight: 1.7 }}>
            <li>Ask CRM: <i>"Who owns login 12345?"</i> → store in <span className="mono small">trading_accounts_meta</span></li>
            <li>Ask MT5: <i>"What trades did login 12345 make?"</i> → store in <span className="mono small">mt5_deal_cache</span></li>
            <li>Join them: trade on login 12345 → Ahmad → Ahmad's agent → agent's rate → pay</li>
          </ol>
          <p className="muted small" style={{ marginBottom: 0 }}>
            <b>Everything else</b> (products, branches, rates, agent relationships)
            lives only in CRM. Trades live only in MT5. The login number is
            literally the only field that exists in both worlds.
          </p>
        </div>
      </Card>

      {/* 3. WHAT WE COPY */}
      <Card title="What we copy from xdev CRM" icon={<CloudDownload size={15} />}>
        <table className="table">
          <thead>
            <tr>
              <th>What we copy</th>
              <th>Lands in table</th>
              <th>Why we need it</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Product catalog (e.g. "Plus 10", "Real 10")</td><td className="mono small">products</td><td>To know what an agent is selling</td></tr>
            <tr><td>Branches (offices)</td><td className="mono small">branches</td><td>To group agents by office</td></tr>
            <tr><td>Customers (contacts)</td><td className="mono small">clients</td><td>To know whose trades we're counting</td></tr>
            <tr><td>Agents</td><td className="mono small">users</td><td>To know who earns commissions</td></tr>
            <tr><td>Agent parent/child relationships</td><td className="mono small">users.parent_agent_id</td><td>To walk the waterfall up to top agents</td></tr>
            <tr><td>Customer → agent referral</td><td className="mono small">clients.referred_by_agent_id</td><td>To know which agent gets credit</td></tr>
            <tr><td>Commission rates per agent/product</td><td className="mono small">crm_commission_levels</td><td>The % and $/lot each agent earns</td></tr>
            <tr><td>IB wallet ID per agent (cached)</td><td className="mono small">users.crm_ib_wallet_id</td><td>Avoids re-fetching profile to find wallet ID</td></tr>
            <tr style={{ background: 'var(--accent-soft)' }}>
              <td><b>Which MT5 accounts belong to which customer</b></td>
              <td className="mono small"><b>trading_accounts_meta</b></td>
              <td><b>The bridge between CRM and MT5</b></td>
            </tr>
            <tr><td>MT5 group per login</td><td className="mono small">trading_accounts_meta.mt5_group</td><td>Ties a login to the right product</td></tr>
            <tr><td>Product-to-MT5-group map</td><td className="mono small">mt5_groups</td><td>Lookup for deals that don't know their product yet</td></tr>
          </tbody>
        </table>
      </Card>

      <Card title="What we copy from MT5 bridge" icon={<Activity size={15} />}>
        <table className="table">
          <thead>
            <tr>
              <th>What we copy</th>
              <th>Lands in table</th>
              <th>Why we need it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Every deal (trade)</td>
              <td className="mono small">mt5_deal_cache</td>
              <td>Raw earnings data — the engine does math on this</td>
            </tr>
          </tbody>
        </table>
        <div className="pad">
          <p className="muted small" style={{ margin: 0 }}>
            That's the only thing we copy from MT5 — but it's the critical one.
            Balance and equity are <b>never cached</b>; every "Load balance"
            click hits the bridge live because balance changes by the second.
          </p>
        </div>
      </Card>

      <Card title="What we compute ourselves (not copied from anywhere)">
        <table className="table">
          <thead>
            <tr><th>Table</th><th>What it is</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono small">commissions</td><td>Output of the waterfall math. One row per deal × agent-in-chain</td></tr>
            <tr><td className="mono small">commission_engine_cycles / jobs</td><td>Log of every engine run (started/finished, counts, errors)</td></tr>
            <tr><td className="mono small">audit_log</td><td>Admin actions: pause CRM, edit rates, run engine, etc.</td></tr>
            <tr><td className="mono small">notifications</td><td>Bell-icon feed items</td></tr>
            <tr><td className="mono small">activity_log, alerts, tasks, notes, messages</td><td>Portal workflow state</td></tr>
            <tr><td className="mono small">users.role_id, user_branch_scope</td><td>RBAC permissions</td></tr>
            <tr><td className="mono small">settings</td><td>Gate config, engine toggles, sync watermarks</td></tr>
          </tbody>
        </table>
      </Card>

      {/* 4. THE FULL FLOW */}
      <Card title="The full flow in one picture">
        <div className="pad">
          <pre style={{
            background: 'var(--bg-elev-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 18,
            fontSize: 12,
            lineHeight: 1.35,
            overflow: 'auto',
            margin: 0,
          }}>{`            ┌─────────────────┐               ┌─────────────────┐
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
                Commission History, etc.)`}</pre>
        </div>
      </Card>

      {/* 5. CONCRETE EXAMPLE */}
      <Card title="A concrete example — one trade, end to end">
        <div className="pad">
          <p style={{ marginTop: 0 }}>
            Customer <b>Ahmad</b> trades <b>0.5 lots</b> on login <span className="mono">12345</span>:
          </p>
          <ol style={{ lineHeight: 1.75 }}>
            <li><b>Sales rep</b> adds Ahmad to CRM, assigns him to agent Mikel, opens MT5 login <span className="mono">12345</span>.</li>
            <li><b>Our auto-sync</b> (every 10 min) notices a new customer → pulls Ahmad's record → writes him to <span className="mono small">clients</span>. Notices his trading account → writes login <span className="mono">12345</span> linked to Ahmad in <span className="mono small">trading_accounts_meta</span>. <i>This is where we "learn" the common glue.</i></li>
            <li><b>Ahmad trades 0.5 lots</b> in MT5. MT5 logs the deal with login <span className="mono">12345</span>, broker commission of $5.</li>
            <li><b>Our engine</b> (runs periodically) asks MT5: <i>"What's new for login 12345?"</i> → writes the deal to <span className="mono small">mt5_deal_cache</span>.</li>
            <li><b>Engine does the math:</b>
              <ul style={{ marginTop: 4 }}>
                <li>Deal is for login <span className="mono">12345</span> → owned by Ahmad</li>
                <li>Ahmad was referred by Mikel → walk up: Mikel → Paul Matar</li>
                <li>Mikel's rate on this product = 80% + $0</li>
                <li>Paul's rate = 100% + $0</li>
                <li>Mikel earns 80% × $5 = <b style={{ color: 'var(--success)' }}>$4.00</b></li>
                <li>Paul earns override (100% − 80%) × $5 = <b style={{ color: 'var(--success)' }}>$1.00</b></li>
                <li>Both rows written to <span className="mono small">commissions</span>.</li>
              </ul>
            </li>
            <li><b>Mikel and Paul</b> see their new earnings in the portal — next page load, no CRM or MT5 call involved.</li>
          </ol>
        </div>
      </Card>

      {/* 6. FRESHNESS */}
      <Card title="How fresh is the data the portal shows?" icon={<RefreshCw size={15} />}>
        <table className="table">
          <thead>
            <tr><th>What you see</th><th>How fresh</th></tr>
          </thead>
          <tbody>
            <tr><td>Agents, clients, hierarchy</td><td>Up to 10 min stale (auto-sync cadence)</td></tr>
            <tr><td>MT5 login → client mapping</td><td>Filled once per client; refreshes on manual "Sync MT5 logins"</td></tr>
            <tr><td>Trading account metadata</td><td>Same as above</td></tr>
            <tr><td>MT5 deals</td><td>As fresh as the last engine cycle (~15 min)</td></tr>
            <tr><td>Live balance / equity</td><td><Pill tone="danger">Live — never cached</Pill></td></tr>
            <tr><td>Product catalog</td><td>Changes rarely; cached 15 min in RAM after first fetch</td></tr>
            <tr><td>Branch list</td><td>Same as products</td></tr>
            <tr><td>Commissions</td><td>Computed when the engine cycle runs</td></tr>
          </tbody>
        </table>
      </Card>

      {/* 7. RESTART IMPACT */}
      <Card title="What happens when the server restarts?">
        <div className="pad">
          <p style={{ marginTop: 0 }}>
            Nothing dramatic. All the important data is in Postgres and
            survives restart. The only things lost are:
          </p>
          <table className="table">
            <thead>
              <tr><th>Lost on restart</th><th>Impact</th></tr>
            </thead>
            <tbody>
              <tr><td>15-min response cache (products / branches)</td><td><b>2 CRM calls</b> on next page load to re-fill, then cached again</td></tr>
              <tr><td>In-flight dedup map</td><td>None — only matters during the exact moment duplicate parallel calls happen</td></tr>
              <tr><td>Token bucket / circuit state</td><td>None — clean slate means no stale penalties</td></tr>
            </tbody>
          </table>
          <p style={{ marginBottom: 0 }}>
            <b>TL;DR:</b> restart cost = 2 CRM calls. Everything else is in the database.
          </p>
        </div>
      </Card>

      {/* 8. CRM GATE */}
      <Card title="What protects the CRM from overload?" icon={<PauseCircle size={15} />} subtitle="services/crmGate.js">
        <div className="pad">
          <p style={{ marginTop: 0 }}>
            We built a "gate" that every CRM call goes through. Think of it as
            a doorman with five rules:
          </p>
          <table className="table">
            <thead>
              <tr><th>Rule</th><th>What it does</th></tr>
            </thead>
            <tbody>
              <tr><td><b>Rate limit</b></td><td>No more than 4 calls per second leave our backend</td></tr>
              <tr><td><b>Concurrency cap</b></td><td>No more than 4 calls in-flight at the same time</td></tr>
              <tr><td><b>Circuit breaker</b></td><td>If 5 errors hit in 60s, stop calling for 5 min</td></tr>
              <tr><td><b>Kill switch</b></td><td>One-click pause (sidebar chip)</td></tr>
              <tr><td><b>Response cache</b></td><td>Products & branches cached for 15 min after first fetch</td></tr>
            </tbody>
          </table>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Status is in the admin sidebar (the "CRM Gate" chip), or via <span className="mono">GET /api/admin/crm/status</span>. The MT5 bridge has its own similar gate.
          </p>
        </div>
      </Card>

      {/* 9. DEEPER REFERENCE */}
      <Card title="Deeper reference — schedules, manual buttons, triage" icon={<Gauge size={15} />}>
        <div className="pad">
          <h3 style={{ marginTop: 0, fontSize: 14 }}>When external calls fire (scheduled)</h3>
          <table className="table" style={{ marginBottom: 16 }}>
            <thead>
              <tr><th>Cadence</th><th>Purpose</th><th>Endpoints</th></tr>
            </thead>
            <tbody>
              <tr><td><Pill tone="accent">Every 10m</Pill></td><td>Incremental contact discovery (checkpointed)</td><td className="mono small">GET /api/contacts?page=N until checkpoint</td></tr>
              <tr><td><Pill tone="accent">Every 30m</Pill></td><td>Activity-driven account refresh (from money-report)</td><td className="mono small">GET /api/money-report-enhanced + /api/contacts/:id/trading-accounts</td></tr>
              <tr><td><Pill tone="accent">Every 1h</Pill></td><td>Tier-3 rotating refresh (200 oldest-synced)</td><td className="mono small">GET /api/contacts/:id/trading-accounts × 200</td></tr>
            </tbody>
          </table>

          <h3 style={{ fontSize: 14 }}>Manual admin buttons</h3>
          <table className="table" style={{ marginBottom: 16 }}>
            <thead>
              <tr><th>Action</th><th>Typical call count</th></tr>
            </thead>
            <tbody>
              <tr><td>Fix all imported</td><td><Pill tone="success">1–2</Pill></td></tr>
              <tr><td>Sync product links</td><td><Pill tone="success">1</Pill></td></tr>
              <tr><td>Per-agent commission-level sync</td><td><Pill tone="success">2</Pill></td></tr>
              <tr><td>Sync MT5 logins (per branch)</td><td><Pill tone="warn">Variable (0 if already synced)</Pill></td></tr>
              <tr><td>Backfill parents</td><td><Pill tone="danger">up to 1,500 (heavy)</Pill></td></tr>
              <tr><td>Settings → Test CRM connection</td><td><Pill tone="success">1 (bypasses gate)</Pill></td></tr>
            </tbody>
          </table>

          <h3 style={{ fontSize: 14 }}>Quick triage — empty commission history</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Run this SQL against the portal DB to diagnose why a specific agent
            shows $0. If <span className="mono">cached_deals = 0</span> but
            <span className="mono"> direct_clients &gt; 0</span>, their MT5
            pipeline hasn't been reached yet. If <span className="mono">crm_levels = 0</span>,
            their rates haven't been synced — click "Sync commission levels".
          </p>
          <pre style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: 12,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.5,
          }}><code>{`SELECT
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
WHERE u.id = '<agent-uuid>';`}</code></pre>
        </div>
      </Card>

      {/* GLOSSARY */}
      <Card title="Glossary — words that come up often">
        <table className="table">
          <tbody>
            <tr><td><b>Agent</b></td><td>A person who earns commission. Lives in <span className="mono">users</span>, linked to a <span className="mono">clients</span> row.</td></tr>
            <tr><td><b>Waterfall</b></td><td>When an agent earns on their own clients' trades <i>plus</i> an override on sub-agents' trades. Our engine walks up the tree.</td></tr>
            <tr><td><b>CRM-synced rates</b></td><td>The "% + $/lot" two-part model pulled from xdev. Stored in <span className="mono">crm_commission_levels</span>.</td></tr>
            <tr><td><b>Legacy rates</b></td><td>A single $/lot number in <span className="mono">agent_products</span>. Used for branches not yet synced to CRM levels.</td></tr>
            <tr><td><b>The gate</b></td><td><span className="mono">services/crmGate.js</span> — the doorman with 5 rules. Every CRM call goes through it.</td></tr>
            <tr><td><b>The engine</b></td><td><span className="mono">services/commissionEngine.js</span> — reads <span className="mono">mt5_deal_cache</span>, walks the tree, writes <span className="mono">commissions</span>.</td></tr>
            <tr><td><b>MT5 login</b></td><td>The trading account number. The only ID shared between CRM and MT5 — our "common data".</td></tr>
          </tbody>
        </table>
      </Card>

      <div className="muted small" style={{ textAlign: 'center', padding: 'var(--space-4) 0' }}>
        Single-source-of-truth: <span className="mono">DATA_FLOW.md</span> at repo root.
        Last updated 2026-04-22.
      </div>
    </div>
  );
}
