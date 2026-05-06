import { useMemo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Users, Target, Sparkles } from 'lucide-react';
import { useApi, useAutoRefresh } from '../hooks/useApi.js';
import LastUpdated from '../components/LastUpdated.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import EarningsChart from '../components/ui/EarningsChart.jsx';
import Sparkline from '../components/ui/Sparkline.jsx';
import AdminOverview from './admin/AdminOverview.jsx';

/**
 * Portal — Dashboard
 *
 * Agent landing page. Designed to feel like a trading-app home screen:
 *   • Hero card — this-month earnings + Δ vs last month (big numbers)
 *   • 14-day stacked daily earnings bar chart (commission + rebate)
 *   • Sub-agent leaderboard — who in the direct downline is producing
 *   • Top 5 clients (this month) by lots
 *   • YOUR PORTFOLIO stats (kept from the old dashboard)
 *   • FULL SUBTREE stats
 */

function Stat({ label, value, sub, accent, icon, sparkline, sparkColor }) {
  return (
    <div className={`stat ${accent ? 'stat-' + accent : ''}`}>
      <div className="stat-header-row">
        <div className="stat-label">{label}</div>
        {icon && <div className="stat-icon">{icon}</div>}
      </div>
      <div className="stat-value">{value ?? '—'}</div>
      {sub && <div className="stat-sub muted">{sub}</div>}
      {sparkline && sparkline.length > 0 && (
        <div className="stat-spark">
          <Sparkline data={sparkline} color={sparkColor || 'var(--accent)'} height={28} />
        </div>
      )}
    </div>
  );
}

function fmtMoney(n, currency = 'USD') {
  if (n == null || !isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}
function fmt(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pctDelta(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 'new' : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Animated counter — tweens from 0 → `target` over `duration` ms. Runs once
 * per target value. Respects prefers-reduced-motion (jumps straight to final).
 */
function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target == null || !isFinite(target)) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setValue(target); return; }
    const start = performance.now();
    const from = 0;
    let raf;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out-expo so it decelerates into the final value
      const eased = 1 - Math.pow(2, -10 * t);
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data: me, loading } = useApi('/me', {}, []);
  // Only agents hit /dashboard — admin-only accounts would get a 403 (endpoint
  // is gated by requireAgentAccess). Passing null to useApi skips the request.
  const isAgentUser = me ? me.is_agent : user?.is_agent;
  const { data: stats, loading: statsLoading, refetch: refetchStats, dataAt: statsAt } = useApi(
    isAgentUser ? '/dashboard' : null,
    {},
    [isAgentUser]
  );
  // Real-time commissions write within ~1s of broker execution. Auto-refresh
  // every 30s so the agent sees new earnings without a manual reload. Paused
  // while the tab is hidden; refetches once on tab refocus.
  useAutoRefresh(isAgentUser ? refetchStats : null, 30_000);

  // NOTE: all remaining hooks must run on every render (even when we early-
  // return the admin pane below) to preserve hook-call order across renders.
  // So compute derived values here — they're cheap and safe when stats is null.
  const busy = loading || statsLoading;

  const chartSeries = useMemo(() => {
    const rows = stats?.earnings_daily || [];
    return rows.map(r => ({ label: r.day.slice(5), value: r.total, commission: r.commission, rebate: r.rebate }));
  }, [stats?.earnings_daily]);
  const total14d = chartSeries.reduce((s, r) => s + r.value, 0);
  const total14dCommission = chartSeries.reduce((s, r) => s + r.commission, 0);
  const total14dRebate = chartSeries.reduce((s, r) => s + r.rebate, 0);

  const thisMonth = stats?.commission_this_month?.amount || 0;
  const lastMonth = stats?.commission_last_month?.amount || 0;
  const delta = pctDelta(thisMonth, lastMonth);
  const deltaStr = delta === 'new' ? '+new' : (delta >= 0 ? `+${delta.toFixed(1)}%` : `${delta.toFixed(1)}%`);

  const animatedThisMonth = useCountUp(thisMonth);
  const heroSpark = chartSeries.map((r, i) => ({ i, v: r.value }));

  // Now the early return is safe — no more hooks are called after this.
  if (me && !me.is_agent && me.is_admin) {
    return <AdminOverview />;
  }


  const leaders = stats?.sub_agent_leaderboard || [];
  const leaderMax = Math.max(1, ...leaders.map(l => l.monthly_total));

  const topClients = stats?.top_clients || [];
  const topClientsMaxLots = Math.max(1, ...topClients.map(c => c.lots));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>{greeting()}, {user?.name?.split(' ')[0] || 'agent'}</h1>
          <p className="muted">Your earnings, your portfolio, and what's moving below you.</p>
        </div>
        <div style={{ paddingTop: 6 }}>
          <LastUpdated dataAt={statsAt} loading={statsLoading} />
        </div>
      </header>

      {/* Empty-state banner: brand-new agents with no clients/earnings yet
          get a friendly explanation instead of a wall of zeros. We trip the
          banner when the agent has no clients AND no commissions ever — i.e.
          they're set up but the data flywheel hasn't turned yet. */}
      {!busy && stats && (stats.totals?.clients ?? 0) === 0 && (stats.totals?.lifetime_commission ?? 0) === 0 && (
        <div
          style={{
            background: 'var(--accent-soft, color-mix(in srgb, var(--accent) 8%, transparent))',
            border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
            borderRadius: 8,
            padding: '14px 18px',
            marginBottom: 'var(--space-4)',
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
          }}
        >
          <div style={{
            width: 32, height: 32, borderRadius: 6,
            background: 'var(--accent)', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, fontSize: 18,
          }}>
            👋
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Welcome — your account is set up.
            </div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              You don't have any clients or earnings yet. As your referred clients sign up
              and start trading, their commissions will appear here automatically — usually
              within a second of each trade. Reach out to your administrator if you expected
              to see existing clients on this page.
            </div>
          </div>
        </div>
      )}

      {/* Hero earnings card — animated counter + trend sparkline */}
      <section className="dash-hero">
        <div className="dash-hero-main">
          <div className="dash-hero-label">EARNINGS THIS MONTH</div>
          <div className="dash-hero-value">
            {busy ? '…' : fmtMoney(animatedThisMonth)}
          </div>
          <div className={`dash-hero-delta ${delta === 'new' || delta >= 0 ? 'up' : 'down'}`}>
            {delta === 'new' || delta >= 0
              ? <TrendingUp   size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              : <TrendingDown size={14} style={{ marginRight: 4, verticalAlign: -2 }} />}
            {busy ? '' : deltaStr}
            <span className="muted"> vs last month ({fmtMoney(lastMonth)})</span>
          </div>
          {heroSpark.length > 0 && (
            <div style={{ marginTop: 14, maxWidth: 320 }}>
              <Sparkline data={heroSpark} color="var(--accent)" height={40} />
            </div>
          )}
        </div>
        <div className="dash-hero-side">
          <div className="dash-hero-split">
            <div>
              <div className="dash-hero-side-label">Commission</div>
              <div className="dash-hero-side-value">{fmtMoney(thisMonth)}</div>
            </div>
            <div>
              <div className="dash-hero-side-label">Deals</div>
              <div className="dash-hero-side-value">{(stats?.commission_this_month?.deal_count || 0).toLocaleString()}</div>
            </div>
            <div>
              <div className="dash-hero-side-label">This week</div>
              <div className="dash-hero-side-value">{fmtMoney(stats?.commission_this_week?.amount || 0)}</div>
            </div>
          </div>
        </div>
      </section>

      {/* 14-day stacked area chart */}
      <section className="card">
        <div className="card-header">
          <h2>Last 14 days</h2>
          <span className="muted small">
            {fmtMoney(total14d)} total
            {' · '}<span style={{ color: 'var(--accent)' }}>{fmtMoney(total14dCommission)} commission</span>
            {' · '}<span style={{ color: 'var(--success)' }}>{fmtMoney(total14dRebate)} rebate</span>
          </span>
        </div>
        <div className="pad">
          <EarningsChart data={chartSeries} height={220} />
        </div>
      </section>

      {/* Top clients — full width (Pipeline funnel removed; agents found
          the funnel noisy and not actionable). */}
      <section className="card">
        <div className="card-header"><h2>Top clients (this month)</h2><span className="muted small">By lots traded</span></div>
        <div className="pad">
          {topClients.length === 0 && <div className="muted">No trading activity yet this month.</div>}
          {topClients.map(c => (
            <div key={c.client_id} className="dash-top-row">
              <div className="dash-top-name">{c.client_name}</div>
              <div className="dash-top-bar-wrap">
                <div className="dash-top-bar" style={{ width: `${(c.lots / topClientsMaxLots) * 100}%` }} />
              </div>
              <div className="dash-top-value mono">{fmt(c.lots)} lots</div>
              <div className="dash-top-earnings muted small">{fmtMoney(c.earnings)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Sub-agent leaderboard */}
      {leaders.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2>Sub-agent leaderboard</h2>
            <span className="muted small">This month's earnings from each direct sub-agent's book</span>
          </div>
          <div className="pad">
            {leaders.map((l, idx) => (
              <div key={l.agent_id} className="dash-leader-row">
                <div className="dash-leader-rank">{idx + 1}</div>
                <div className="dash-leader-name">
                  <Link to={`/sub-agents/${l.agent_id}`}>{l.name}</Link>
                  <div className="muted small">{l.email}</div>
                </div>
                <div className="dash-leader-bar-wrap">
                  <div className="dash-leader-bar" style={{ width: `${(l.monthly_total / leaderMax) * 100}%` }} />
                </div>
                <div className="dash-leader-value mono">{fmtMoney(l.monthly_total)}</div>
                <div className="dash-leader-deals muted small">{l.monthly_deals} deals</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* YOUR PORTFOLIO stats — icons + optional trend sparklines */}
      <div className="stat-row-label">YOUR PORTFOLIO</div>
      <section className="stat-row">
        <Stat
          label="Clients"
          icon={<Users size={14} />}
          value={busy ? '…' : stats?.clients_count?.toLocaleString()}
          sub="KYC verified"
          accent="success"
        />
        <Stat
          label="Leads"
          icon={<Target size={14} />}
          value={busy ? '…' : stats?.leads_count?.toLocaleString()}
          sub="unverified"
          accent="warn"
        />
        <Stat
          label="Sub-agents"
          icon={<Sparkles size={14} />}
          value={busy ? '…' : stats?.sub_agents_count}
          sub="directly referred"
        />
        <Stat
          label="Trading accounts"
          value={busy ? '…' : stats?.trading_accounts_count?.toLocaleString()}
          sub={stats?.clients_with_mt5 != null ? `across ${stats.clients_with_mt5} clients` : ''}
          accent="accent"
          sparkline={heroSpark}
          sparkColor="var(--accent)"
        />
      </section>

      {/* FULL SUBTREE */}
      {stats && stats.subtree_agent_count > 0 && (
        <>
          <div className="stat-row-label">FULL SUBTREE</div>
          <section className="stat-row">
            <Stat label="Agents in subtree"          value={stats.subtree_agent_count}    sub="direct + indirect" accent="accent" />
            <Stat label="Clients in subtree"         value={stats.subtree_clients_count}  sub="everyone below you" />
            <Stat label="Trading accounts (subtree)" value={stats.subtree_mt5_count}      sub="MT5 logins total" />
          </section>
        </>
      )}
    </div>
  );
}
