import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, DollarSign, Gift, TrendingUp, CheckCircle2, Clock, AlertTriangle, HelpCircle } from 'lucide-react';
import { useApi, useAutoRefresh } from '../hooks/useApi.js';
import LastUpdated from '../components/LastUpdated.jsx';
import { getToken } from '../api.js';
import Button from '../components/ui/Button.jsx';
import DonutChart from '../components/ui/DonutChart.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import { toast } from '../components/ui/toast.js';

// Status → visual style for the readiness banner. Kept compact so the
// agent sees "what's going on" at a glance without reading the diagnostics.
const STATUS_STYLE = {
  healthy:              { icon: CheckCircle2, label: 'Commission data up to date', color: 'var(--success)', bg: 'var(--success-soft)' },
  awaiting_deals:       { icon: Clock,        label: 'Waiting for MT5 deals to be pulled', color: 'var(--accent)',  bg: 'var(--accent-soft)' },
  awaiting_next_cycle:  { icon: Clock,        label: 'Waiting for the next engine cycle', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  zero_earnings:        { icon: HelpCircle,   label: 'No earnings — see breakdown below', color: 'var(--warn)',    bg: 'var(--warn-soft)' },
  no_rates:             { icon: AlertTriangle, label: 'Commission rates not configured yet', color: 'var(--warn)',  bg: 'var(--warn-soft)' },
};

function ReadinessBanner({ status }) {
  if (!status) return null;
  const style = STATUS_STYLE[status.status] || STATUS_STYLE.healthy;
  const Icon = style.icon;
  const d = status.diagnostics || {};
  return (
    <div
      className="alert"
      style={{
        background: style.bg,
        borderLeft: `3px solid ${style.color}`,
        padding: '12px 16px',
        marginBottom: 'var(--space-4)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'start', gap: 10 }}>
        <Icon size={18} style={{ color: style.color, flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: style.color, marginBottom: 4 }}>{style.label}</div>
          <div style={{ color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5 }}>{status.message}</div>
          <div
            className="muted small mono"
            style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 14 }}
          >
            <span>Rates: {d.crm_levels > 0 ? `${d.crm_levels} CRM` : (d.legacy_rates > 0 ? `${d.legacy_rates} legacy` : 'none')}</span>
            <span>Commission rows: {d.commission_rows?.toLocaleString?.() ?? 0}</span>
            <span>Total earned: ${(d.total_earned ?? 0).toLocaleString()}</span>
            <span>Sub-agents: {d.subtree_agents ?? 0}</span>
            <span>Logins with deals: {d.logins_with_cached_deals ?? 0} / {d.logins_mapped ?? 0}</span>
            {d.last_cycle_at && (
              <span>Last cycle: {new Date(d.last_cycle_at).toLocaleString()}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Portal — Commissions
 *
 * The viewer's earnings ledger, split into commission vs rebate per Model C
 * (commission portion mirrors MT5's per-deal charge, rebate is the rest).
 *
 * Top of page: 4 stat tiles (Total, Commission, Rebate, Lots) for the range.
 * Middle: "By source agent" panel — each sub-agent (or self for direct clients)
 *         shows how much of the viewer's earnings flowed through them.
 * Below: "By product" aggregate with commission/rebate columns.
 * Bottom: Full ledger with per-deal breakdown.
 */

function todayMinusDaysISO(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function ymdToISO(ymd) {
  if (!ymd) return null;
  return new Date(ymd + 'T00:00:00Z').toISOString();
}

function fmt(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export default function Commissions() {
  const [from, setFrom] = useState(todayMinusDaysISO(30));
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  async function downloadStatement() {
    const qs = new URLSearchParams();
    if (from) qs.set('from', ymdToISO(from));
    if (to)   qs.set('to',   ymdToISO(to));
    try {
      const res = await fetch(`/api/portal/statements/commissions.pdf?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const msg = res.status === 401 ? 'Session expired — sign in again.' : `Failed: HTTP ${res.status}`;
        toast.error(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commission-statement-${from || 'all'}_to_${to || 'today'}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Statement downloaded');
    } catch (err) {
      toast.error(err.message || 'Download failed');
    }
  }

  const { data, loading, error, refetch: refetchCommissions, dataAt: commissionsAt } = useApi(
    '/commissions',
    {
      query: {
        from: ymdToISO(from),
        to: to ? ymdToISO(to) : null,
        page,
        pageSize: 50,
      },
    },
    [from, to, page]
  );
  // Real-time commission writes mean new rows can land any second. Refresh
  // the visible list every 30s; pauses while the tab is hidden.
  useAutoRefresh(refetchCommissions, 30_000);

  // Readiness status — answers "why am I seeing $0?" without the agent
  // having to ask. Fetched once on page load (not per-filter) since it
  // describes the account state, not the current date range.
  const { data: status } = useApi('/commissions/status', {}, []);

  const { data: byProduct } = useApi(
    '/commissions/summary',
    { query: { from: ymdToISO(from), to: to ? ymdToISO(to) : null, groupBy: 'product' } },
    [from, to]
  );

  const { data: bySource } = useApi(
    '/commissions/summary',
    { query: { from: ymdToISO(from), to: to ? ymdToISO(to) : null, groupBy: 'source_agent' } },
    [from, to]
  );

  const items = data?.items || [];
  const total = data?.pagination?.total || 0;
  const totalAmount     = data?.pagination?.totalAmount     || 0;
  const totalCommission = data?.pagination?.totalCommission || 0;
  const totalRebate     = data?.pagination?.totalRebate     || 0;
  const totalLots       = data?.pagination?.totalLots       || 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Commissions</h1>
          <p className="muted">
            Your earnings split into <b>Commission</b> (mirrors MT5's per-deal charge) and <b>Rebate</b> (broker kickback on top).
            Source-agent panel shows which sub-agent's book each dollar flowed through.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <Button variant="secondary" icon={<Download size={14} />} onClick={downloadStatement}>
            Download statement
          </Button>
          <LastUpdated dataAt={commissionsAt} loading={loading} />
        </div>
      </header>

      <ReadinessBanner status={status} />

      <div className="filter-bar">
        <label className="field inline">
          <span>From</span>
          <input type="date" className="input" value={from} onChange={e => { setPage(1); setFrom(e.target.value); }} />
        </label>
        <label className="field inline">
          <span>To</span>
          <input type="date" className="input" value={to} onChange={e => { setPage(1); setTo(e.target.value); }} />
        </label>
      </div>

      {/* 4-tile stat row summarising the current range */}
      <section className="stat-row">
        <div className="stat">
          <div className="stat-label">Total earnings</div>
          <div className="stat-value">{fmt(totalAmount)}</div>
          <div className="stat-sub muted">commission + rebate</div>
        </div>
        <div className="stat stat-accent">
          <div className="stat-label">Commission</div>
          <div className="stat-value">{fmt(totalCommission)}</div>
          <div className="stat-sub muted">mirrors MT5 charge</div>
        </div>
        <div className="stat stat-success">
          <div className="stat-label">Rebate</div>
          <div className="stat-value">{fmt(totalRebate)}</div>
          <div className="stat-sub muted">broker kickback</div>
        </div>
        <div className="stat">
          <div className="stat-label">Lots</div>
          <div className="stat-value">{fmt(totalLots, 2)}</div>
          <div className="stat-sub muted">generating deals</div>
        </div>
      </section>

      {error && <div className="alert error">{error.message}</div>}

      {/* By source agent — donut (left) + table (right) so the distribution is
          immediately visual while details stay one glance away */}
      {bySource && bySource.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2>Earnings by source</h2>
            <span className="muted small">Where your earnings are flowing from</span>
          </div>
          <div className="pad">
            <DonutChart
              data={bySource.map(r => ({
                name: r.is_self ? 'Your direct clients' : (r.source_agent_name || 'Unknown'),
                value: Number(r.total_amount || 0),
              }))}
              centerLabel="Total earnings"
              centerValue={new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalAmount)}
              height={260}
            />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Sub-agent / source</th>
                <th className="num">Deals</th>
                <th className="num">Lots</th>
                <th className="num">Commission</th>
                <th className="num">Rebate</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {bySource.map(r => (
                <tr key={r.source_agent_id || r.bucket}>
                  <td>
                    {r.is_self ? (
                      <span><b>Your direct clients</b> <span className="muted small">(level 0)</span></span>
                    ) : r.source_agent_id ? (
                      <Link to={`/sub-agents/${r.source_agent_id}`}>{r.source_agent_name}</Link>
                    ) : (
                      <span className="muted">Unknown source</span>
                    )}
                  </td>
                  <td className="num mono">{r.deal_count}</td>
                  <td className="num mono">{fmt(r.total_lots)}</td>
                  <td className="num mono">{fmt(r.total_commission)}</td>
                  <td className="num mono">{fmt(r.total_rebate)}</td>
                  <td className="num mono strong">{fmt(r.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* By product */}
      {byProduct && byProduct.length > 0 && (
        <section className="card">
          <div className="card-header"><h2>By product</h2></div>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Product rate</th>
                <th className="num">Deals</th>
                <th className="num">Lots</th>
                <th className="num">Commission</th>
                <th className="num">Rebate</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {byProduct.map(r => (
                <tr key={r.bucket}>
                  <td>{r.product_name || '—'}</td>
                  <td className="num mono muted small">
                    {fmt(r.product_commission_per_lot)} + {fmt(r.product_rebate_per_lot)}
                  </td>
                  <td className="num mono">{r.deal_count}</td>
                  <td className="num mono">{fmt(r.total_lots)}</td>
                  <td className="num mono">{fmt(r.total_commission)}</td>
                  <td className="num mono">{fmt(r.total_rebate)}</td>
                  <td className="num mono strong">{fmt(r.total_amount)} {r.currency || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <div className="card-header"><h2>Ledger</h2></div>
        <table className="table">
          <thead>
            <tr>
              <th>Deal time</th>
              <th>Deal ID</th>
              <th>Product</th>
              <th>Client</th>
              <th>Source</th>
              <th className="num">Login</th>
              <th className="num">Lots</th>
              <th>Level</th>
              <th className="num">Commission</th>
              <th className="num">Rebate</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="11" className="muted pad">Loading…</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan="11" style={{ padding: 0 }}>
                <EmptyState
                  icon={<DollarSign size={28} />}
                  title="No commissions in this range"
                  description="Commissions are generated when your clients (or your sub-agents' clients) trade on MT5. Try widening the date range, or check back after the next engine cycle runs."
                />
              </td></tr>
            )}
            {items.map(r => (
              <tr key={r.id}>
                <td className="mono small">{new Date(r.deal_time).toLocaleString()}</td>
                <td className="mono small">{r.deal_id}</td>
                <td>{r.product_name}</td>
                <td>{r.client_name || '—'}</td>
                <td className="small">{r.source_agent_name || '—'}</td>
                <td className="num mono">{r.mt5_login}</td>
                <td className="num mono">{fmt(r.lots)}</td>
                <td><span className={`pill level-${r.level}`}>L{r.level}</span></td>
                <td className="num mono">{fmt(r.commission_amount)}</td>
                <td className="num mono">{fmt(r.rebate_amount)}</td>
                <td className="num mono strong">{fmt(r.amount)} {r.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="pager">
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted">Page {page} / {pages} · {total} rows</span>
        <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
  );
}
