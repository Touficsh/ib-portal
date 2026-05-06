import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronsDown, ChevronsUp, RefreshCw, Download, Filter } from 'lucide-react';
import { useApi, useMutation, useAutoRefresh } from '../hooks/useApi.js';
import LastUpdated from '../components/LastUpdated.jsx';
import Button from '../components/ui/Button.jsx';
import { toast } from '../components/ui/toast.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * Portal — Summary
 *
 * Expandable hierarchical table sourced from `/api/portal/summary`:
 *   • Sub-agent rows        → sums across their entire subtree (deep)
 *     • Sub-agent own-accounts (their own MT5 books)
 *     • Client rows          → sums across that client's trading accounts
 *       • Account rows       → raw per-login numbers
 *   • Direct client rows     → sums across their accounts
 *     • Account rows
 *
 * Columns: Lots · Commission · Balance · Deposit · Withdrawal · Equity
 *
 * Data source map:
 *   balance / equity              — trading_accounts_meta (live via MT5 + x-dev syncs)
 *   deposits / withdrawals / lots — trading_accounts_meta (MT5 snapshot sync, all-time)
 *   commission                    — commissions table, date-scoped via ?from=&to=
 *
 * "Refresh MT5" button calls POST /summary/sync-mt5 which refreshes the
 * trading_accounts_meta snapshot for every login in viewer's scope (skipping
 * ones that were synced in the last 15 min to keep bridge load sane).
 */

export function fmt(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function ExpandBtn({ expanded, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`sum-expand ${expanded ? 'open' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={disabled ? 'Nothing to expand' : (expanded ? 'Collapse' : 'Expand')}
    >▸</button>
  );
}

export function NumCells({ row }) {
  // Column order matches the <thead>: Deposit/Withdrawal (period activity)
  // before Balance/Equity (point-in-time snapshots) — keeps the two "right now"
  // metrics visually adjacent at the right edge of the row.
  return (
    <>
      <td className="num mono">{fmt(row.lots, 2)}</td>
      <td className="num mono">{fmt(row.commission, 2)}</td>
      <td className="num mono">{fmt(row.deposits, 2)}</td>
      <td className="num mono">{fmt(row.withdrawals, 2)}</td>
      <td className="num mono">{fmt(row.balance, 2)}</td>
      <td className="num mono">{fmt(row.equity, 2)}</td>
    </>
  );
}

export function SubAgentRow({ sa, expanded, onToggle }) {
  const ownCount = sa.ownAccounts?.length || 0;
  const clientCount = sa.clients?.length || 0;
  const canExpand = ownCount + clientCount > 0;
  return (
    <tr className="sum-row sum-row-sub" onClick={onToggle}>
      <td>
        <div className="sum-name">
          <ExpandBtn expanded={expanded} onClick={onToggle} disabled={!canExpand} />
          <div className="sum-avatar sum-avatar-sub">{(sa.name || '?')[0].toUpperCase()}</div>
          <div className="sum-lines">
            <div className="sum-name-main">
              <Link to={`/sub-agents/${sa.id}`} onClick={(e) => e.stopPropagation()}>{sa.name}</Link>
            </div>
            <div className="muted small">
              {sa.email || '—'}{sa.branch ? ` · ${sa.branch}` : ''}
              {(ownCount || clientCount) && (
                <>
                  {' · '}
                  {ownCount > 0 && <span>{ownCount} own account{ownCount === 1 ? '' : 's'}</span>}
                  {ownCount > 0 && clientCount > 0 && ' · '}
                  {clientCount > 0 && <span>{clientCount} client{clientCount === 1 ? '' : 's'}</span>}
                </>
              )}
            </div>
          </div>
        </div>
      </td>
      <td><span className="pill level-1">Sub-agent</span></td>
      <NumCells row={sa} />
    </tr>
  );
}

export function ClientRow({ c, depth, expanded, onToggle }) {
  const pillClass = c.variant === 'lead' ? 'stage-lead' : 'stage-funded';
  const avatarClass = c.variant === 'lead' ? 'sum-avatar-lead' : 'sum-avatar-client';
  const label = c.variant === 'lead' ? 'Lead' : 'Client';
  return (
    <tr className="sum-row sum-row-client" onClick={onToggle}>
      <td>
        <div className="sum-name" style={{ paddingLeft: depth * 28 }}>
          <ExpandBtn expanded={expanded} onClick={onToggle} disabled={!c.accounts?.length} />
          <div className={`sum-avatar ${avatarClass}`}>{(c.name || '?')[0].toUpperCase()}</div>
          <div className="sum-lines">
            <div className="sum-name-main">{c.name}</div>
            <div className="muted small">{c.email || '—'}{c.stage ? ` · ${c.stage}` : ''}</div>
          </div>
        </div>
      </td>
      <td><span className={`pill ${pillClass}`}>{label}</span></td>
      <NumCells row={c} />
    </tr>
  );
}

export function AccountRow({ a, depth, own }) {
  return (
    <tr className={`sum-row sum-row-account ${own ? 'sum-row-account-own' : ''}`}>
      <td>
        <div className="sum-name" style={{ paddingLeft: depth * 28 + 8 }}>
          <span className="sum-spacer" />
          <span className="sum-bullet">•</span>
          <div className="sum-lines">
            <div className="sum-name-main mono">
              {a.login} · {a.product}
              {own && <span className="sum-own-badge" title="Sub-agent's own trading account">OWN</span>}
            </div>
            <div className="muted small">{a.type}{a.currency ? ` · ${a.currency}` : ''}</div>
          </div>
        </div>
      </td>
      <td><span className={`pill ${a.type === 'demo' ? 'level-2' : 'level-1'}`}>{a.type}</span></td>
      <NumCells row={a} />
    </tr>
  );
}

// Date helpers — ISO yyyy-mm-dd for <input type="date">
function toISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function startOfYear() {
  return new Date(new Date().getFullYear(), 0, 1);
}
function today() { return new Date(); }

const RANGE_PRESETS = [
  { id: 'mtd',    label: 'This month',    from: () => startOfMonth(),   to: () => today() },
  { id: '30d',    label: 'Last 30 days',  from: () => daysAgo(30),      to: () => today() },
  { id: '90d',    label: 'Last 90 days',  from: () => daysAgo(90),      to: () => today() },
  { id: 'ytd',    label: 'Year to date',  from: () => startOfYear(),    to: () => today() },
  { id: 'all',    label: 'All time',      from: () => null,             to: () => null },
];

// Parse "yyyy-mm-dd" as a LOCAL date (not UTC) so the label matches what the user picked
function parseLocal(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatRangeLabel(fromIso, toIso) {
  const fmt = (iso) => {
    const d = parseLocal(iso);
    return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  };
  if (!fromIso && !toIso) return 'all-time';
  if (!fromIso)           return `up to ${fmt(toIso)}`;
  if (!toIso)             return `from ${fmt(fromIso)}`;
  return `${fmt(fromIso)} → ${fmt(toIso)}`;
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export default function Summary() {
  const { user } = useAuth();
  const isAdmin = (user?.permissions || []).includes('portal.admin');
  const [expandedSubs, setExpandedSubs] = useState({});
  const [expandedClients, setExpandedClients] = useState({});
  const [q, setQ] = useState('');

  // Date range — defaults to month-to-date. Only affects the Commission column
  // (see SQL in /api/portal/summary — balance/equity/deposit/withdrawal/lots
  // are point-in-time snapshots from trading_accounts_meta regardless of range).
  const [rangePreset, setRangePreset] = useState('mtd');
  const [fromDate, setFromDate] = useState(toISODate(startOfMonth()));
  const [toDate,   setToDate]   = useState(toISODate(today()));

  function applyPreset(id) {
    const p = RANGE_PRESETS.find((r) => r.id === id);
    if (!p) return;
    setRangePreset(id);
    const f = p.from(), t = p.to();
    setFromDate(f ? toISODate(f) : '');
    setToDate(t ? toISODate(t) : '');
  }
  function onFromChange(v) { setFromDate(v); setRangePreset('custom'); }
  function onToChange(v)   { setToDate(v);   setRangePreset('custom'); }

  const rangeLabel = formatRangeLabel(fromDate || null, toDate || null);

  // Product filter — array of product_source_id strings. Empty = no filter.
  const [selectedProducts, setSelectedProducts] = useState([]);
  const productsQuery = selectedProducts.length > 0 ? selectedProducts.join(',') : undefined;

  function toggleProduct(id) {
    setSelectedProducts((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  // Server-backed fetch. Re-runs whenever the date range or product filter changes.
  const { data, loading, error, refetch, dataAt } = useApi(
    '/summary',
    { query: { from: fromDate || undefined, to: toDate || undefined, products: productsQuery } },
    [fromDate, toDate, productsQuery]
  );
  // Auto-refresh every 60s — Summary aggregates a lot of rows so we go a bit
  // less aggressive than Dashboard/Commissions. Real-time webhook deals will
  // surface within a minute without a manual reload.
  useAutoRefresh(refetch, 60_000);

  // Refresh MT5 snapshot button
  const [syncMt5, { loading: syncing, error: syncError }] = useMutation();
  async function handleSyncMt5() {
    const promise = syncMt5('/summary/sync-mt5', { method: 'POST' }).then(async (r) => {
      await refetch();
      return r;
    });
    toast.promise(promise, {
      loading: 'Refreshing snapshot from MT5…',
      success: (r) => `Synced ${r.logins_synced} logins${r.logins_failed ? ` (${r.logins_failed} failed)` : ''}`,
      error: (err) => err.message || 'MT5 sync failed',
    });
  }

  const ownAccounts = data?.ownAccounts || [];
  const ownAccountsTotals = data?.ownAccountsTotals || { lots: 0, commission: 0, balance: 0, deposits: 0, withdrawals: 0, equity: 0 };
  const subagents = data?.subagents || [];
  const directClients = data?.directClients || [];
  const grandTotal = data?.grandTotal || { lots: 0, commission: 0, balance: 0, deposits: 0, withdrawals: 0, equity: 0 };

  const toggleSub = (id) => setExpandedSubs((m) => ({ ...m, [id]: !m[id] }));
  const toggleClient = (id) => setExpandedClients((m) => ({ ...m, [id]: !m[id] }));

  // Filter (by name/email across sub-agents and their clients)
  const filterHit = (text) => !q.trim() || (text || '').toLowerCase().includes(q.trim().toLowerCase());

  // Flatten to row list — totals → MY accounts → sub-agents (→ own accts → clients → accts) → direct clients (→ accts)
  const rows = [];
  rows.push(
    <tr key="totals" className="sum-row-total">
      <td colSpan="2" className="bold">
        TOTAL · {subagents.length} sub-agent{subagents.length === 1 ? '' : 's'} · {directClients.length} direct client{directClients.length === 1 ? '' : 's'}
        {ownAccounts.length > 0 && <> · {ownAccounts.length} own account{ownAccounts.length === 1 ? '' : 's'}</>}
      </td>
      <NumCells row={grandTotal} />
    </tr>
  );

  // Viewer's own MT5 accounts go FIRST (before any sub-agent or client),
  // with a distinct header so they're visually separated. Only renders when
  // the viewer actually has personal accounts — most agents don't trade
  // themselves so this section is empty for them.
  if (ownAccounts.length > 0) {
    rows.push(
      <tr key="own-header" className="sum-row-section">
        <td colSpan="2" className="bold">
          ★ My accounts ({ownAccounts.length})
        </td>
        <NumCells row={ownAccountsTotals} />
      </tr>
    );
    ownAccounts.forEach((a) => {
      rows.push(<AccountRow key={`own-${a.login}`} a={a} depth={1} own />);
    });
  }

  subagents.forEach((sa) => {
    const subMatches = filterHit(sa.name) || filterHit(sa.email);
    const anyClientMatches = (sa.clients || []).some((c) => filterHit(c.name) || filterHit(c.email));
    if (!subMatches && !anyClientMatches) return;

    const isExpanded = !!expandedSubs[sa.id];
    rows.push(
      <SubAgentRow key={sa.id} sa={sa} expanded={isExpanded} onToggle={() => toggleSub(sa.id)} />
    );
    if (isExpanded) {
      // Sub-agent's OWN trading accounts render directly under them, before their clients
      (sa.ownAccounts || []).forEach((a) => {
        rows.push(<AccountRow key={`${sa.id}-own-${a.login}`} a={a} depth={1} own />);
      });
      (sa.clients || []).forEach((c) => {
        if (!subMatches && !(filterHit(c.name) || filterHit(c.email))) return;
        const cExp = !!expandedClients[c.id];
        rows.push(
          <ClientRow key={`${sa.id}-${c.id}`} c={c} depth={1} expanded={cExp} onToggle={() => toggleClient(c.id)} />
        );
        if (cExp) {
          (c.accounts || []).forEach((a) => {
            rows.push(<AccountRow key={`${sa.id}-${c.id}-${a.login}`} a={a} depth={2} />);
          });
        }
      });
    }
  });

  directClients.forEach((c) => {
    if (!filterHit(c.name) && !filterHit(c.email)) return;
    const cExp = !!expandedClients[c.id];
    rows.push(
      <ClientRow key={`direct-${c.id}`} c={c} depth={0} expanded={cExp} onToggle={() => toggleClient(c.id)} />
    );
    if (cExp) {
      (c.accounts || []).forEach((a) => {
        rows.push(<AccountRow key={`direct-${c.id}-${a.login}`} a={a} depth={1} />);
      });
    }
  });

  function expandAll() {
    const s = {}, c = {};
    subagents.forEach((sa) => {
      s[sa.id] = true;
      (sa.clients || []).forEach((cl) => { c[cl.id] = true; });
    });
    directClients.forEach((cl) => { c[cl.id] = true; });
    setExpandedSubs(s);
    setExpandedClients(c);
  }
  function collapseAll() {
    setExpandedSubs({});
    setExpandedClients({});
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Summary</h1>
          <p className="muted">
            Per-agent, per-client, per-account totals — lots, commissions, balance, deposits, withdrawals and equity.
            <br />
            <span className="sum-range-inline">
              Report period: <b>{rangeLabel}</b>
            </span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <LastUpdated dataAt={dataAt} loading={loading} />
          <Button size="sm" variant="ghost" icon={<ChevronsDown size={14} />} onClick={expandAll}>Expand all</Button>
          <Button size="sm" variant="ghost" icon={<ChevronsUp size={14} />} onClick={collapseAll}>Collapse all</Button>
          {isAdmin && (
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              loading={syncing}
              disabled={loading}
              onClick={handleSyncMt5}
              title="Re-fetch balance / equity / deposits / withdrawals / lots from the MT5 bridge"
            >Refresh MT5</Button>
          )}
          <Button size="sm" variant="ghost" icon={<Download size={14} />} disabled title="Export coming soon">Export</Button>
        </div>
      </header>

      {error && <div className="alert error">Failed to load summary: {error.message}</div>}
      {syncError && <div className="alert error">MT5 sync failed: {syncError.message}</div>}

      <div className="sum-range-bar">
        <div className="sum-range-presets">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sum-range-chip ${rangePreset === p.id ? 'active' : ''}`}
              onClick={() => applyPreset(p.id)}
            >{p.label}</button>
          ))}
          {rangePreset === 'custom' && (
            <button type="button" className="sum-range-chip active" disabled>Custom</button>
          )}
        </div>
        <div className="sum-range-inputs">
          <label className="sum-range-label">
            <span className="muted small">From</span>
            <input
              type="date"
              className="input"
              value={fromDate}
              onChange={(e) => onFromChange(e.target.value)}
              style={{ width: 150 }}
            />
          </label>
          <label className="sum-range-label">
            <span className="muted small">To</span>
            <input
              type="date"
              className="input"
              value={toDate}
              onChange={(e) => onToChange(e.target.value)}
              style={{ width: 150 }}
            />
          </label>
        </div>
      </div>

      {data?.availableProducts?.length > 0 && (
        <div className="sum-product-bar">
          <span className="sum-product-label">Products</span>
          <div className="sum-product-chips">
            <button
              type="button"
              className={`sum-range-chip ${selectedProducts.length === 0 ? 'active' : ''}`}
              onClick={() => setSelectedProducts([])}
              title="Show accounts from every product"
            >All <span className="sum-product-count">({data.availableProducts.reduce((s, p) => s + p.account_count, 0)})</span></button>
            {data.availableProducts.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`sum-range-chip ${selectedProducts.includes(p.id) ? 'active' : ''}`}
                onClick={() => toggleProduct(p.id)}
                title={`${p.account_count} account${p.account_count === 1 ? '' : 's'}`}
              >
                {p.name} <span className="sum-product-count">({p.account_count})</span>
              </button>
            ))}
          </div>
          {selectedProducts.length > 0 && (
            <button className="btn ghost small" onClick={() => setSelectedProducts([])} style={{ marginLeft: 'auto' }}>
              Clear filter
            </button>
          )}
        </div>
      )}

      <div className="filter-bar">
        <input
          className="input"
          placeholder="Search by name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 320 }}
        />
        {q && <button className="btn ghost small" onClick={() => setQ('')}>Clear</button>}
        <div className="muted small" style={{ marginLeft: 'auto' }}>
          {data?.mt5_pending > 0 && (
            <>
              <span className="sum-pending" title="Logins that have never been synced from the MT5 bridge">
                {data.mt5_pending} pending
              </span>
              {' · '}
            </>
          )}
          MT5 snapshot: <b>{relativeTime(data?.mt5_synced_at)}</b>
        </div>
      </div>

      <div className="card sum-card">
        <table className="table sum-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th className="num">Lots</th>
              <th className="num">Commission</th>
              <th className="num">Deposit</th>
              <th className="num">Withdrawal</th>
              <th className="num">Balance</th>
              <th className="num">Equity</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr><td colSpan="8" className="muted pad" style={{ textAlign: 'center' }}>Loading summary…</td></tr>
            )}
            {!loading && rows.length === 1 && (
              // rows.length === 1 means only the totals row → no subagents + no clients in scope
              <tr><td colSpan="8" className="muted pad" style={{ textAlign: 'center' }}>
                No sub-agents or clients in scope yet.
              </td></tr>
            )}
            {rows.map((row, i) => (
              <Fragment key={row.key ?? i}>{row}</Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
