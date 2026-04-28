import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useMutation } from '../hooks/useApi.js';
import { getToken } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function relTime(iso) {
  if (!iso) return null;
  const diffMin = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${Math.round(diffMin)} min ago`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)} h ago`;
  return `${Math.round(diffMin / 1440)} d ago`;
}

/**
 * Portal — Trading Accounts (agent-scoped)
 *
 * Every MT5 login across the signed-in agent's subtree. Filter by source
 * (mine / direct clients / sub-agents / their clients / all). Balance/equity
 * are fetched on-demand per row via the MT5 bridge — one click per row to
 * avoid flooding the single-threaded bridge with 500+ calls.
 */
const FILTER_LABELS = {
  all:             'All',
  mine:            'My accounts',
  direct_client:   'Direct clients',
  subagent:        'Sub-agents',
  subagent_client: "Sub-agents' clients",
};

const SOURCE_PILL = {
  mine:            { cls: 'stage-active',    label: 'Mine' },
  direct_client:   { cls: 'stage-contacted', label: 'Direct' },
  subagent:        { cls: 'stage-lead',      label: 'Sub-agent' },
  subagent_client: { cls: 'stage-funded',    label: "Sub's client" },
};

export default function TradingAccounts() {
  const { user } = useAuth();
  const isAdmin = (user?.permissions || []).includes('portal.admin');
  const [filter, setFilter] = useState('all');
  const [agentFilter, setAgentFilter] = useState('');  // empty = all agents
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [syncTick, setSyncTick] = useState(0);

  const { data, loading, refetch } = useApi(
    '/trading-accounts',
    { query: { filter, agent_id: agentFilter || undefined, q: q || undefined, page, pageSize: 50 } },
    [filter, agentFilter, q, page, syncTick]
  );
  const { data: metaStatus, refetch: refetchStatus } =
    useApi('/trading-accounts/meta-status', {}, [syncTick]);
  const { data: agentsInScope } = useApi('/trading-accounts/agents-in-scope', {}, []);

  const [liveByLogin, setLiveByLogin] = useState({});
  const [loadingLogin, setLoadingLogin] = useState(null);
  const [runSync, { loading: syncing }] = useMutation();
  const [syncNotice, setSyncNotice] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Streams the .xlsx over fetch (so we can attach the Bearer header) then
  // triggers a browser download from the resulting blob. Respects the current
  // filter + search so the export matches what's visible.
  async function onExport() {
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      if (filter && filter !== 'all') qs.set('filter', filter);
      if (agentFilter) qs.set('agent_id', agentFilter);
      if (q) qs.set('q', q);
      const url = `/api/portal/trading-accounts/export.xlsx${qs.toString() ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rowCount = res.headers.get('x-row-count');
      const dispo = res.headers.get('content-disposition') || '';
      const m = /filename="([^"]+)"/.exec(dispo);
      const filename = m ? m[1] : 'trading-accounts.xlsx';
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setSyncNotice(`Downloaded ${rowCount || '?'} accounts as ${filename}`);
    } catch (err) {
      setSyncNotice('Export failed: ' + (err.message || 'unknown'));
    } finally {
      setExporting(false);
    }
  }

  async function onSyncMeta() {
    setSyncNotice(null);
    try {
      const r = await runSync('/trading-accounts/sync-meta?maxAge=60', { method: 'POST' });
      setSyncNotice(
        `Synced ${r.accounts_upserted} accounts across ${r.clients_scanned} clients`
        + (r.clients_skipped_fresh ? ` (skipped ${r.clients_skipped_fresh} fresh within 60 min)` : '')
        + (r.fetch_errors ? ` · ${r.fetch_errors} errors` : '')
      );
      setSyncTick(t => t + 1);
    } catch (err) {
      setSyncNotice('Sync failed: ' + (err.message || 'unknown'));
    }
  }

  async function loadBalance(login) {
    setLoadingLogin(login);
    try {
      const res = await fetch(`/api/mt5/accounts/${login}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const d = await res.json();
      setLiveByLogin(prev => ({ ...prev, [login]: d }));
    } catch (e) {
      setLiveByLogin(prev => ({ ...prev, [login]: { _error: e.message } }));
    } finally {
      setLoadingLogin(null);
    }
  }

  const items = data?.items || [];
  const counts = data?.counts || {};
  const total = data?.pagination?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Trading Accounts</h1>
          <p className="muted">Every MT5 account in your book, including sub-agents' clients.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={onExport} disabled={exporting || loading} title="Download all matching rows as .xlsx (respects current filter + search)">
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
          {isAdmin && (
            <button className="btn ghost" onClick={onSyncMeta} disabled={syncing} title="Refresh product / type / created dates from x-dev CRM">
              {syncing ? 'Syncing metadata…' : 'Sync metadata'}
            </button>
          )}
        </div>
      </header>

      {(syncNotice || metaStatus) && (
        <div className="meta-status">
          {metaStatus && (
            <span className="muted small">
              {metaStatus.logins_with_meta}/{metaStatus.total_clients_with_logins} clients have cached metadata
              {metaStatus.newest_meta && ` · last sync ${relTime(metaStatus.newest_meta)}`}
            </span>
          )}
          {syncNotice && <span className="meta-notice small">{syncNotice}</span>}
        </div>
      )}

      {/* Filter chip row */}
      <div className="filter-chip-row">
        {Object.keys(FILTER_LABELS).map(k => {
          const count = k === 'all' ? (counts.all ?? 0) : (counts[k] ?? 0);
          return (
            <button
              key={k}
              className={`filter-chip ${filter === k ? 'active' : ''}`}
              onClick={() => { setPage(1); setFilter(k); }}
            >
              {FILTER_LABELS[k]}
              <span className="filter-chip-n mono">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="filter-bar">
        <input
          className="input"
          placeholder="Search client name, email, or login…"
          value={q}
          onChange={e => { setPage(1); setQ(e.target.value); }}
          style={{ minWidth: 240 }}
        />
        <select
          className="input"
          value={agentFilter}
          onChange={e => { setPage(1); setAgentFilter(e.target.value); }}
          title="Filter by specific agent (self + sub-agents)"
          style={{ minWidth: 220 }}
        >
          <option value="">All agents ({(agentsInScope || []).reduce((s, a) => s + a.total_count, 0)})</option>
          {(agentsInScope || []).map(a => (
            <option key={a.user_id} value={a.user_id}>
              {a.is_self ? '★ ' : ''}{a.name} — {a.total_count}
            </option>
          ))}
        </select>
        {agentFilter && (
          <button className="btn ghost small" onClick={() => { setPage(1); setAgentFilter(''); }}>Clear agent</button>
        )}
        <div className="muted small" style={{ marginLeft: 'auto' }}>
          {loading ? 'loading…' : `${total} account${total === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Agent</th>
              <th>Client</th>
              <th className="num">MT5 login</th>
              <th>Product</th>
              <th>Type</th>
              <th>Created</th>
              <th>Stage</th>
              <th>FTD</th>
              <th className="num">Balance</th>
              <th className="num">Equity</th>
              <th className="num">Profit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="13" className="muted pad">Loading…</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan="13" className="muted pad">No accounts match the current filter.</td></tr>
            )}
            {items.map((r, idx) => {
              const live = liveByLogin[r.mt5_login];
              const hasLive = live && !live._error && !live._stub;
              const src = SOURCE_PILL[r.source] || { cls: '', label: r.source };
              const typeLower = (r.account_type || '').toLowerCase();
              return (
                <tr key={`${r.client_id}-${r.mt5_login}-${idx}`}>
                  <td><span className={`pill ${src.cls}`}>{src.label}</span></td>
                  <td>
                    {r.agent_user_id ? (
                      <Link to={`/sub-agents/${r.agent_user_id}`} className="ta-agent-link">{r.agent_name}</Link>
                    ) : (
                      <span>{r.agent_name || '—'}</span>
                    )}
                  </td>
                  <td>
                    <div>{r.client_name}</div>
                    <div className="muted small">{r.email || '—'}</div>
                  </td>
                  <td className="num mono">{r.mt5_login}</td>
                  <td>
                    {r.product_name
                      ? <span className="product-inline">{r.product_name}</span>
                      : <span className="muted small">not synced</span>}
                  </td>
                  <td>
                    {r.account_type
                      ? <span className={`pill ${typeLower === 'real' ? 'stage-active' : typeLower === 'demo' ? 'stage-contacted' : 'stage-lead'}`}>{r.account_type}</span>
                      : '—'}
                  </td>
                  <td className="small mono" title={r.created_at_source || ''}>{formatDate(r.created_at_source)}</td>
                  <td><span className={`pill stage-${(r.pipeline_stage || '').toLowerCase()}`}>{r.pipeline_stage}</span></td>
                  <td>{r.first_deposit_at ? '✓' : '—'}</td>
                  <td className="num mono">{hasLive ? Number(live.balance).toFixed(2) : '—'}</td>
                  <td className="num mono">{hasLive ? Number(live.equity).toFixed(2) : '—'}</td>
                  <td
                    className="num mono"
                    style={{
                      color: hasLive && live.profit < 0 ? 'var(--danger)'
                           : hasLive && live.profit > 0 ? 'var(--success)' : undefined,
                    }}
                  >
                    {hasLive ? Number(live.profit).toFixed(2) : '—'}
                  </td>
                  <td className="num">
                    {live?._stub ? <span className="muted small">bridge down</span>
                     : live?._error ? <span style={{ color: 'var(--danger)' }} className="small">err</span>
                     : live ? <button className="btn ghost small" onClick={() => loadBalance(r.mt5_login)}>Refresh</button>
                     : <button className="btn ghost small" disabled={loadingLogin === r.mt5_login} onClick={() => loadBalance(r.mt5_login)}>
                         {loadingLogin === r.mt5_login ? 'Loading…' : 'Load'}
                       </button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted small">Page {page} / {totalPages} · {total} total</span>
        <button className="btn ghost small" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
  );
}
