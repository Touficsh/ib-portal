import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, TrendingUp, Gift, Calendar, X, Users, ChevronDown } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import EarningsChart from './ui/EarningsChart.jsx';
import DonutChart from './ui/DonutChart.jsx';
import EmptyState from './ui/EmptyState.jsx';

/**
 * Admin-facing, agent-scoped commission view. Used on both:
 *   - /admin/agents/:id         (embedded inside the agent detail page)
 *   - /admin/commission-history (dedicated page with an agent picker)
 *
 * Shows:
 *   - Quick-range chips (7/30/90 days, All time) + explicit From/To pickers
 *   - 4 stat tiles · daily stacked-area chart
 *   - Earnings-by-source (full-width donut + sub-agent breakdown table) —
 *     mirrors the agent portal's own Commissions page so admins see the same
 *     waterfall distribution the agent sees
 *   - Earnings by product (its own card below)
 *   - Per-deal ledger with pagination
 */

function todayMinusDaysISO(days) {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function ymdToISO(ymd) {
  if (!ymd) return null;
  return new Date(ymd + 'T00:00:00Z').toISOString();
}

export default function CommissionsSection({ agentId }) {
  // `range` drives the chips (for quick snapshots). Selecting a chip recomputes
  // `from` + `to`. Editing a date directly puts us into `custom` mode so the
  // user keeps their hand-picked range until they hit another chip.
  const [range, setRange] = useState('30');            // '7' | '30' | '90' | 'all' | 'custom'
  const [fromYmd, setFromYmd] = useState(todayMinusDaysISO(30));
  const [toYmd, setToYmd] = useState('');              // '' === today
  const [page, setPage] = useState(1);
  const [showAllClients, setShowAllClients] = useState(false);

  const pickRange = (v) => {
    setRange(v);
    setPage(1);
    if (v === 'all') {
      setFromYmd('');
      setToYmd('');
    } else if (v !== 'custom') {
      setFromYmd(todayMinusDaysISO(Number(v)));
      setToYmd('');
    }
  };

  // Reset paging whenever the agent changes so we don't land on an empty page 5
  useEffect(() => { setPage(1); }, [agentId]);

  const fromISO = useMemo(() => ymdToISO(fromYmd), [fromYmd]);
  const toISO   = useMemo(() => ymdToISO(toYmd),   [toYmd]);

  const listQuery = useMemo(() => {
    const q = { agent_id: agentId, page, pageSize: 25 };
    if (fromISO) q.from = fromISO;
    if (toISO)   q.to   = toISO;
    return q;
  }, [agentId, page, fromISO, toISO]);

  const { data: ledger, loading } = useApi(
    agentId ? '/api/commissions' : null,
    { query: listQuery },
    [JSON.stringify(listQuery)]
  );
  const { data: byDay } = useApi(
    agentId ? '/api/commissions/summary' : null,
    { query: { agent_id: agentId, from: fromISO, to: toISO, groupBy: 'day' } },
    [agentId, fromISO, toISO]
  );
  const { data: byProduct } = useApi(
    agentId ? '/api/commissions/summary' : null,
    { query: { agent_id: agentId, from: fromISO, to: toISO, groupBy: 'product' } },
    [agentId, fromISO, toISO]
  );
  const { data: bySource } = useApi(
    agentId ? '/api/commissions/summary' : null,
    { query: { agent_id: agentId, from: fromISO, to: toISO, groupBy: 'source_agent' } },
    [agentId, fromISO, toISO]
  );
  const { data: byClient } = useApi(
    agentId ? '/api/commissions/summary' : null,
    { query: { agent_id: agentId, from: fromISO, to: toISO, groupBy: 'client' } },
    [agentId, fromISO, toISO]
  );

  const fmt  = (n, d = 2) => n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (n) => '$' + fmt(n, 2);

  const items = ledger?.items || [];
  const pagination = ledger?.pagination || {};
  const totalAmount     = Number(pagination.totalAmount     || 0);
  const totalCommission = Number(pagination.totalCommission || 0);
  const totalRebate     = Number(pagination.totalRebate     || 0);
  const totalLots       = Number(pagination.totalLots       || 0);
  const totalDeals      = Number(pagination.total           || 0);
  const pages = Math.max(1, Math.ceil(totalDeals / 25));

  // The chart needs a dense day-by-day series (zero-fill gaps) so the stacked
  // area has no visual holes. Span = explicit range when set, else 90 days fallback.
  const chartData = useMemo(() => {
    let startMs, endMs;
    if (fromISO) {
      startMs = new Date(fromISO).getTime();
      endMs = toISO ? new Date(toISO).getTime() : Date.now();
    } else {
      // "All time" — fall back to last 90 days for the chart only
      startMs = Date.now() - 90 * 86400_000;
      endMs = Date.now();
    }
    const days = Math.max(1, Math.min(180, Math.ceil((endMs - startMs) / 86400_000)));
    const byDayMap = new Map((byDay || []).map(r => [new Date(r.bucket).toISOString().slice(0, 10), r]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(endMs - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const row = byDayMap.get(key);
      out.push({
        label: key.slice(5),
        commission: Number(row?.total_commission || 0),
        rebate:     Number(row?.total_rebate || 0),
        total:      Number(row?.total_amount || 0),
      });
    }
    return out;
  }, [byDay, fromISO, toISO]);

  // Human label for the "no data" empty states so admins see exactly what
  // range we're showing (and can tell if they need to widen it)
  const rangeLabel = useMemo(() => {
    if (!fromYmd && !toYmd) return 'all time';
    if (fromYmd && !toYmd)   return `${fromYmd} → today`;
    if (!fromYmd && toYmd)   return `→ ${toYmd}`;
    return `${fromYmd} → ${toYmd}`;
  }, [fromYmd, toYmd]);

  // Donut data for Top clients: top 10 explicitly, the rest collapsed into
  // "Others" so one client with 10k tiny deals doesn't blow up the legend.
  const clientDonutData = useMemo(() => {
    if (!Array.isArray(byClient) || byClient.length === 0) return [];
    const sorted = [...byClient].sort((a, b) => Number(b.total_amount) - Number(a.total_amount));
    const top = sorted.slice(0, 10);
    const rest = sorted.slice(10);
    const data = top.map(r => ({
      name: r.client_name || 'Unknown client',
      value: Number(r.total_amount || 0),
    }));
    if (rest.length > 0) {
      const othersTotal = rest.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
      if (othersTotal > 0) {
        data.push({ name: `Others (${rest.length})`, value: othersTotal });
      }
    }
    return data;
  }, [byClient]);

  // Paginate the Top-clients table: default to top 25, "Show all" reveals the rest.
  const clientRows = useMemo(() => {
    if (!Array.isArray(byClient)) return { rows: [], overflowCount: 0 };
    if (showAllClients) return { rows: byClient, overflowCount: 0 };
    return {
      rows: byClient.slice(0, 25),
      overflowCount: Math.max(0, byClient.length - 25),
    };
  }, [byClient, showAllClients]);

  return (
    <section className="card">
      <div className="card-header">
        <h2>
          <DollarSign size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />
          Commission history
        </h2>
        <div className="ch-range-chips">
          {[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']].map(([val, label]) => (
            <button
              key={val}
              type="button"
              className={`h-filter-chip ${range === val ? 'active' : ''}`}
              onClick={() => pickRange(val)}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Explicit From/To date pickers. Typing in either drops us into
          `custom` mode so the preset chip stays deselected. */}
      <div className="pad" style={{ paddingBottom: 0 }}>
        <div className="ch-date-row">
          <Calendar size={14} className="muted" />
          <label className="field inline">
            <span>From</span>
            <input
              type="date"
              className="input"
              value={fromYmd}
              onChange={e => { setPage(1); setFromYmd(e.target.value); setRange('custom'); }}
            />
          </label>
          <label className="field inline">
            <span>To</span>
            <input
              type="date"
              className="input"
              value={toYmd}
              onChange={e => { setPage(1); setToYmd(e.target.value); setRange('custom'); }}
            />
          </label>
          {(fromYmd || toYmd) && range === 'custom' && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => pickRange('30')}
              title="Reset to default 30-day window"
            >
              <X size={12} /> Reset
            </button>
          )}
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            Showing: <b style={{ color: 'var(--text)' }}>{rangeLabel}</b>
          </span>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="pad">
        <div className="stat-row" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="stat">
            <div className="stat-label">Total earnings</div>
            <div className="stat-value">{money(totalAmount)}</div>
            <div className="stat-sub muted">commission + rebate</div>
          </div>
          <div className="stat stat-accent">
            <div className="stat-header-row">
              <div className="stat-label">Commission</div>
              <div className="stat-icon"><DollarSign size={14} /></div>
            </div>
            <div className="stat-value">{money(totalCommission)}</div>
            <div className="stat-sub muted">mirrors MT5 charge</div>
          </div>
          <div className="stat stat-success">
            <div className="stat-header-row">
              <div className="stat-label">Rebate</div>
              <div className="stat-icon"><Gift size={14} /></div>
            </div>
            <div className="stat-value">{money(totalRebate)}</div>
            <div className="stat-sub muted">broker kickback</div>
          </div>
          <div className="stat">
            <div className="stat-header-row">
              <div className="stat-label">Lots</div>
              <div className="stat-icon"><TrendingUp size={14} /></div>
            </div>
            <div className="stat-value">{fmt(totalLots, 2)}</div>
            <div className="stat-sub muted">{totalDeals.toLocaleString()} deals</div>
          </div>
        </div>

        {totalAmount > 0 && (
          <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="card-header">
              <h2>Daily earnings</h2>
              <span className="muted small">{rangeLabel}</span>
            </div>
            <div className="pad"><EarningsChart data={chartData} height={200} /></div>
          </div>
        )}

        {/* Earnings by source — full-width donut + detailed breakdown table.
            Matches the layout the agent sees on their own Commissions page so
            admins review the same waterfall distribution. */}
        {bySource && bySource.length > 0 && (
          <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="card-header">
              <h2>Earnings by source</h2>
              <span className="muted small">Which sub-agent's book each dollar flowed through</span>
            </div>
            <div className="pad">
              <DonutChart
                data={bySource.map(r => ({
                  name: r.is_self ? 'Direct clients' : (r.source_agent_name || 'Unknown'),
                  value: Number(r.total_amount || 0),
                }))}
                centerLabel="Total earnings"
                centerValue={money(totalAmount)}
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
                {bySource.map((r, i) => (
                  <tr key={r.source_agent_id || `unknown-${i}`}>
                    <td>
                      {r.is_self ? (
                        <span><b>Direct clients</b> <span className="muted small">(level 0)</span></span>
                      ) : r.source_agent_id ? (
                        <Link to={`/admin/agents/${r.source_agent_id}`}>{r.source_agent_name}</Link>
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
          </div>
        )}

        {/* Top clients — which individual traders generate the most revenue.
            Donut is top-10 with an "Others" slice; the table defaults to top-25
            so the page doesn't explode for agents with thousands of clients. */}
        {byClient && byClient.length > 0 && (
          <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="card-header">
              <h2><Users size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />Top clients</h2>
              <span className="muted small">
                {byClient.length.toLocaleString()} trading client{byClient.length === 1 ? '' : 's'} generating earnings
              </span>
            </div>
            <div className="pad">
              <DonutChart
                data={clientDonutData}
                centerLabel="Total earnings"
                centerValue={money(totalAmount)}
                height={260}
              />
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">Deals</th>
                  <th className="num">Lots</th>
                  <th className="num">Commission</th>
                  <th className="num">Rebate</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {clientRows.rows.map((r, i) => (
                  <tr key={r.client_id || `unknown-${i}`}>
                    <td>
                      {r.client_name
                        ? <span>{r.client_name}{r.client_email ? <span className="muted small"> · {r.client_email}</span> : null}</span>
                        : <span className="muted">Unknown client</span>}
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
            {clientRows.overflowCount > 0 && (
              <div className="pad" style={{ display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowAllClients(true)}
                >
                  <ChevronDown size={12} /> Show all {byClient.length.toLocaleString()} clients
                </button>
              </div>
            )}
            {showAllClients && byClient.length > 25 && (
              <div className="pad" style={{ display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowAllClients(false)}
                >
                  Collapse to top 25
                </button>
              </div>
            )}
          </div>
        )}

        {/* Earnings by product — its own card */}
        {byProduct && byProduct.length > 0 && (
          <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="card-header">
              <h2>Earnings by product</h2>
              <span className="muted small">Per-product totals · rates × lots</span>
            </div>
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
                {byProduct.map((r, i) => (
                  <tr key={r.bucket || `unknown-${i}`}>
                    <td>{r.product_name || <span className="muted">(unknown product)</span>}</td>
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
          </div>
        )}
      </div>

      <div className="card-header">
        <h2>Ledger</h2>
        <span className="muted small">{totalDeals.toLocaleString()} deal{totalDeals === 1 ? '' : 's'} · page {page} / {pages}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Deal time</th>
            <th>Client</th>
            <th>Source</th>
            <th>Product</th>
            <th className="num">Login</th>
            <th className="num">Lots</th>
            <th>Level</th>
            <th className="num">Commission</th>
            <th className="num">Rebate</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan="10" className="muted pad">Loading…</td></tr>}
          {!loading && items.length === 0 && (
            <tr><td colSpan="10" style={{ padding: 0 }}>
              <EmptyState
                icon={<DollarSign size={24} />}
                title="No commissions in this range"
                description={`No rows for ${rangeLabel}. Widen the range above, or check that this agent's products have rates configured.`}
              />
            </td></tr>
          )}
          {items.map(r => (
            <tr key={r.id}>
              <td className="mono small">{new Date(r.deal_time).toLocaleString()}</td>
              <td className="small">{r.client_name || '—'}</td>
              <td className="small">{r.source_agent_name || '—'}</td>
              <td>{r.product_name}</td>
              <td className="num mono">{r.mt5_login}</td>
              <td className="num mono">{fmt(r.lots)}</td>
              <td><span className={`pill level-${r.level}`}>L{r.level}</span></td>
              <td className="num mono">{fmt(r.commission_amount)}</td>
              <td className="num mono">{fmt(r.rebate_amount)}</td>
              <td className="num mono strong">{fmt(r.amount)} {r.currency || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted small">Page {page} / {pages} · {totalDeals} rows</span>
        <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </section>
  );
}
