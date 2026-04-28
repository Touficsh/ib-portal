import { Link } from 'react-router-dom';
import {
  Users, UsersRound, LineChart, Package, TrendingUp, TrendingDown,
  Activity, AlertTriangle, CheckCircle2, Clock, ScrollText,
  ArrowLeftRight, ArrowRight, RefreshCw, AlertCircle,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import EarningsChart from '../../components/ui/EarningsChart.jsx';
import Sparkline from '../../components/ui/Sparkline.jsx';

/**
 * Admin — Overview / Dashboard
 *
 * One-page situation room for an admin. Top row: business KPIs. Second row:
 * system health (engine state, MT5 freshness, reconciliation drift). Below:
 * 30-day revenue chart, top agents, and recent audit trail.
 *
 * Designed for "eyeball the platform in 5 seconds" use:
 *   - Any health indicator turns amber/red when something needs attention
 *   - Each section has a link to its detail page for a deep dive
 */

function fmtMoney(n, currency = 'USD') {
  if (n == null || !isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}
function fmt(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function relTime(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function pctDelta(current, previous) {
  if (!previous || previous === 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

function StatCard({ icon: Icon, label, value, sub, href, accent = 'default', badge }) {
  const body = (
    <>
      <div className="admin-stat-header">
        <div className={`admin-stat-icon admin-stat-icon-${accent}`}><Icon size={15} /></div>
        <div className="admin-stat-label">{label}</div>
        {badge}
      </div>
      <div className="admin-stat-value">{value}</div>
      {sub && <div className="admin-stat-sub">{sub}</div>}
    </>
  );
  return href
    ? <Link to={href} className="admin-stat admin-stat-link">{body}<ArrowRight size={14} className="admin-stat-arrow" /></Link>
    : <div className="admin-stat">{body}</div>;
}

function HealthBadge({ ok, warn, error, label }) {
  const tone = error ? 'error' : warn ? 'warn' : 'ok';
  const Icon = tone === 'error' ? AlertCircle : tone === 'warn' ? AlertTriangle : CheckCircle2;
  return (
    <span className={`admin-health admin-health-${tone}`}>
      <Icon size={12} />{label}
    </span>
  );
}

export default function AdminOverview() {
  const { data, loading, error, refetch } = useApi('/api/admin/dashboard', {}, []);

  const counts = data?.counts || {};
  const comm = data?.commissions || {};
  const engine = data?.engine || {};
  const snap = data?.mt5_snapshots || {};
  const recon = data?.reconciliation || {};
  const top = data?.top_agents || [];
  const audit = data?.recent_audit || [];

  const chartData = (comm.daily_30d || []).map(r => ({
    label: r.day.slice(5), commission: r.commission, rebate: r.rebate, total: r.total,
  }));
  const total30d = chartData.reduce((s, r) => s + r.total, 0);
  const delta = pctDelta(comm.this_month, comm.last_month);
  const deltaStr = delta == null ? '' : (delta >= 0 ? `+${delta.toFixed(1)}%` : `${delta.toFixed(1)}%`);

  const heroSpark = chartData.map((r, i) => ({ i, v: r.total }));

  // Health flags
  const engineStatus = engine.last_cycle?.status;
  const engineWarn = engine.dead_jobs > 0 || engineStatus === 'partial' || engineStatus === 'failed';
  const engineError = engineStatus === 'failed';
  const snapWarn = snap.pending > 0;
  const driftWarn = recon.drift_pct != null && Math.abs(recon.drift_pct) > 0.01;
  const driftError = recon.drift_pct != null && Math.abs(recon.drift_pct) > 0.05;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Admin overview</h1>
          <p className="muted">Business KPIs, system health, and recent activity — all in one glance.</p>
        </div>
        <button className="btn" onClick={refetch} disabled={loading}>
          <RefreshCw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="alert error">Failed to load: {error.message}</div>}

      {/* Hero — total commissions paid this month across the whole platform */}
      <section className="dash-hero">
        <div className="dash-hero-main">
          <div className="dash-hero-label">PLATFORM COMMISSIONS · THIS MONTH</div>
          <div className="dash-hero-value">{fmtMoney(comm.this_month)}</div>
          {delta != null && (
            <div className={`dash-hero-delta ${delta >= 0 ? 'up' : 'down'}`}>
              {delta >= 0 ? <TrendingUp size={14} style={{ marginRight: 4, verticalAlign: -2 }} /> : <TrendingDown size={14} style={{ marginRight: 4, verticalAlign: -2 }} />}
              {deltaStr}
              <span className="muted"> vs last month ({fmtMoney(comm.last_month)})</span>
            </div>
          )}
          {heroSpark.length > 0 && (
            <div style={{ marginTop: 14, maxWidth: 360 }}>
              <Sparkline data={heroSpark} color="var(--accent)" height={40} />
            </div>
          )}
        </div>
        <div className="dash-hero-side">
          <div className="dash-hero-split">
            <div>
              <div className="dash-hero-side-label">Commission</div>
              <div className="dash-hero-side-value">{fmtMoney(comm.this_month_commission)}</div>
            </div>
            <div>
              <div className="dash-hero-side-label">Rebate</div>
              <div className="dash-hero-side-value">{fmtMoney(comm.this_month_rebate)}</div>
            </div>
            <div>
              <div className="dash-hero-side-label">Deals</div>
              <div className="dash-hero-side-value">{(comm.this_month_deal_count || 0).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Top counts row */}
      <div className="stat-row-label">PLATFORM</div>
      <section className="stat-row">
        <StatCard
          icon={UsersRound}
          label="Agents"
          value={(counts.agents_active || 0).toLocaleString()}
          sub={`${counts.sub_agents || 0} sub-agents in tree`}
          accent="accent"
          href="/admin/agents"
        />
        <StatCard
          icon={Users}
          label="Clients"
          value={(counts.clients_total || 0).toLocaleString()}
          sub="all individuals in CRM"
          accent="success"
          href="/admin/agent-summary"
        />
        <StatCard
          icon={LineChart}
          label="Trading accounts"
          value={(counts.trading_accounts || 0).toLocaleString()}
          sub="real accounts only"
          href="/admin/system-health?tab=pipeline"
        />
        <StatCard
          icon={Package}
          label="Products"
          value={(counts.products_active || 0).toLocaleString()}
          sub={counts.products_unconfigured > 0
            ? `${counts.products_unconfigured} missing rate`
            : 'all configured'}
          accent={counts.products_unconfigured > 0 ? 'warn' : 'default'}
          href="/admin/products"
          badge={counts.products_unconfigured > 0 && (
            <span className="admin-stat-badge admin-stat-badge-warn">{counts.products_unconfigured}</span>
          )}
        />
      </section>

      {/* System health row — 3 panels, each links to the matching tab on
          the unified System Health page */}
      <div className="stat-row-label">SYSTEM HEALTH</div>
      <div className="admin-health-row">
        {/* Commission engine */}
        <Link to="/admin/system-health?tab=pipeline" className="card admin-card-link" style={{ padding: 0 }}>
          <div className="card-header">
            <h2><Activity size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />Commission engine</h2>
            <HealthBadge
              ok={!engineWarn}
              warn={engineWarn && !engineError}
              error={engineError}
              label={engineError ? 'failed' : engineWarn ? 'attention' : 'healthy'}
            />
          </div>
          <div className="pad admin-health-body">
            <div className="admin-health-row-item">
              <span className="muted small">Last cycle</span>
              <b>{engine.last_cycle ? relTime(engine.last_cycle.finished_at || engine.last_cycle.started_at) : 'never'}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Status</span>
              <b style={{ textTransform: 'capitalize' }}>{engineStatus || '—'}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Rows inserted</span>
              <b className="mono">{(engine.last_cycle?.deals_inserted || 0).toLocaleString()}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Dead jobs (DLQ)</span>
              <b className={`mono ${engine.dead_jobs > 0 ? 'recon-delta-warn' : ''}`}>{engine.dead_jobs}</b>
            </div>
          </div>
        </Link>

        {/* MT5 snapshots */}
        <Link to="/admin/system-health?tab=pipeline" className="card admin-card-link" style={{ padding: 0 }}>
          <div className="card-header">
            <h2><RefreshCw size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />MT5 snapshots</h2>
            <HealthBadge
              ok={!snapWarn}
              warn={snapWarn}
              label={snapWarn ? `${snap.pending} pending` : 'fresh'}
            />
          </div>
          <div className="pad admin-health-body">
            <div className="admin-health-row-item">
              <span className="muted small">Total logins</span>
              <b className="mono">{(snap.total_logins || 0).toLocaleString()}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Newest sync</span>
              <b>{relTime(snap.newest)}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Oldest sync</span>
              <b>{relTime(snap.oldest)}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Pending</span>
              <b className={`mono ${snap.pending > 0 ? 'recon-delta-warn' : ''}`}>{snap.pending}</b>
            </div>
          </div>
        </Link>

        {/* Reconciliation — direct-link to that tab */}
        <Link to="/admin/system-health?tab=reconciliation" className="card admin-card-link" style={{ padding: 0 }}>
          <div className="card-header">
            <h2><ArrowLeftRight size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />Reconciliation · 30d</h2>
            <HealthBadge
              ok={!driftWarn}
              warn={driftWarn && !driftError}
              error={driftError}
              label={driftError ? 'high drift' : driftWarn ? 'minor drift' : 'in sync'}
            />
          </div>
          <div className="pad admin-health-body">
            <div className="admin-health-row-item">
              <span className="muted small">Engine commission</span>
              <b className="mono">{fmtMoney(recon.engine_commission)}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">MT5 commission</span>
              <b className="mono">{fmtMoney(recon.mt5_commission)}</b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Drift</span>
              <b className={`mono ${driftError ? 'recon-delta-error' : driftWarn ? 'recon-delta-warn' : 'recon-delta-ok'}`}>
                {recon.drift_pct == null ? '—' : `${(recon.drift_pct * 100).toFixed(2)}%`}
              </b>
            </div>
            <div className="admin-health-row-item">
              <span className="muted small">Logins w/ drift</span>
              <b className="mono">{recon.logins_with_drift || 0}</b>
            </div>
          </div>
        </Link>
      </div>

      {/* 30-day revenue chart */}
      <section className="card">
        <div className="card-header">
          <h2>Platform revenue · last 30 days</h2>
          <span className="muted small">
            {fmtMoney(total30d)} total
            {' · '}<span style={{ color: 'var(--accent)' }}>{fmtMoney(chartData.reduce((s,r) => s+r.commission, 0))} commission</span>
            {' · '}<span style={{ color: 'var(--success)' }}>{fmtMoney(chartData.reduce((s,r) => s+r.rebate, 0))} rebate</span>
          </span>
        </div>
        <div className="pad">
          <EarningsChart data={chartData} height={220} />
        </div>
      </section>

      {/* Top agents + recent audit side-by-side */}
      <div className="dash-two-col">
        <section className="card">
          <div className="card-header">
            <h2>Top agents · this month</h2>
            <Link to="/admin/agents" className="muted small">See all →</Link>
          </div>
          <div className="pad">
            {top.length === 0 && <div className="muted">No commissions this month yet.</div>}
            {top.map((a, idx) => (
              <div key={a.agent_id} className="dash-leader-row">
                <div className="dash-leader-rank">{idx + 1}</div>
                <div className="dash-leader-name">
                  <Link to={`/admin/agents/${a.agent_id}`}>{a.name}</Link>
                  <div className="muted small">{a.email}</div>
                </div>
                <div className="dash-leader-bar-wrap">
                  <div className="dash-leader-bar" style={{ width: `${(a.total_earnings / Math.max(1, top[0]?.total_earnings || 1)) * 100}%` }} />
                </div>
                <div className="dash-leader-value mono">{fmtMoney(a.total_earnings)}</div>
                <div className="dash-leader-deals muted small">{fmt(a.total_lots)} lots</div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2><ScrollText size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />Recent activity</h2>
            <Link to="/admin/audit-log" className="muted small">Full audit log →</Link>
          </div>
          <div className="pad" style={{ padding: 0 }}>
            {audit.length === 0 && <div className="muted pad">No audit events yet. Activity will appear here as admins make changes.</div>}
            <ul className="admin-activity">
              {audit.map(a => (
                <li key={a.id}>
                  <div className="admin-activity-head">
                    <span className="pill audit-action">{a.action}</span>
                    <span className="muted small"><Clock size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{relTime(a.created_at)}</span>
                  </div>
                  <div className="admin-activity-body muted small">
                    <b>{a.actor_name || a.actor_email || 'system'}</b>
                    {a.entity_type && <> on <span className="mono">{a.entity_type}{a.entity_id ? `:${a.entity_id.slice(0, 8)}` : ''}</span></>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
