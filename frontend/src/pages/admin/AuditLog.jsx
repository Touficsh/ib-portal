import { useState, useMemo } from 'react';
import { useApi } from '../../hooks/useApi.js';

/**
 * Admin — Audit Log
 *
 * Read-only table of every tracked financial / admin action. Filterable by
 * actor, action verb, entity type, and date range. Click a row to expand
 * the before/after JSON diff.
 */

function fmtTs(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function JsonDiff({ before, after }) {
  if (!before && !after) return <span className="muted small">—</span>;
  return (
    <div className="audit-diff">
      {before && (
        <div className="audit-diff-side">
          <div className="audit-diff-label">Before</div>
          <pre>{JSON.stringify(before, null, 2)}</pre>
        </div>
      )}
      {after && (
        <div className="audit-diff-side">
          <div className="audit-diff-label">After</div>
          <pre>{JSON.stringify(after, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default function AuditLog() {
  const [filter, setFilter] = useState({
    from: '',
    to: '',
    actor: '',
    action: '',
    entityType: '',
  });
  const [page, setPage] = useState(1);
  const [openRow, setOpenRow] = useState(null);

  // Build the query the hook expects — only include non-empty keys so the
  // backend's WHERE clauses don't flip on empty strings.
  const query = useMemo(() => {
    const q = { page, pageSize: 50 };
    if (filter.from)       q.from       = new Date(filter.from + 'T00:00:00').toISOString();
    if (filter.to)         q.to         = new Date(filter.to + 'T23:59:59').toISOString();
    if (filter.actor)      q.actor      = filter.actor;
    if (filter.action)     q.action     = filter.action;
    if (filter.entityType) q.entityType = filter.entityType;
    return q;
  }, [filter, page]);

  const { data, loading, error } = useApi('/api/admin/audit-log', { query }, [JSON.stringify(query)]);
  const { data: distinct } = useApi('/api/admin/audit-log/distinct', {}, []);

  const items = data?.items || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  function update(key, val) {
    setFilter(f => ({ ...f, [key]: val }));
    setPage(1);
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Audit Log</h1>
          <p className="muted">
            Every tracked action: product changes, rate grants / changes / revocations, engine runs, auth events.
            Click a row to see the before/after snapshot.
          </p>
        </div>
      </header>

      <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label className="field inline">
          <span className="muted small">From</span>
          <input type="date" className="input" value={filter.from} onChange={e => update('from', e.target.value)} />
        </label>
        <label className="field inline">
          <span className="muted small">To</span>
          <input type="date" className="input" value={filter.to} onChange={e => update('to', e.target.value)} />
        </label>
        <label className="field inline">
          <span className="muted small">Actor</span>
          <select className="input" value={filter.actor} onChange={e => update('actor', e.target.value)}>
            <option value="">All actors</option>
            {(distinct?.actors || []).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span className="muted small">Action</span>
          <select className="input" value={filter.action} onChange={e => update('action', e.target.value)}>
            <option value="">All actions</option>
            {(distinct?.actions || []).map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="field inline">
          <span className="muted small">Entity</span>
          <select className="input" value={filter.entityType} onChange={e => update('entityType', e.target.value)}>
            <option value="">All entities</option>
            {(distinct?.entities || []).map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <button
          className="btn ghost small"
          onClick={() => { setFilter({ from: '', to: '', actor: '', action: '', entityType: '' }); setPage(1); }}
        >Clear</button>
        <div className="muted small" style={{ marginLeft: 'auto' }}>
          {total.toLocaleString()} events
        </div>
      </div>

      {error && <div className="alert error">{error.message}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="5" className="muted pad">Loading…</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan="5" className="muted pad">No audit events match these filters.</td></tr>
            )}
            {items.map(row => (
              <>
                <tr
                  key={row.id}
                  onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                  style={{ cursor: 'pointer' }}
                  className={openRow === row.id ? 'audit-row-open' : ''}
                >
                  <td className="mono small">{fmtTs(row.created_at)}</td>
                  <td>{row.actor_name || row.actor_email || <span className="muted">system</span>}</td>
                  <td><span className="pill audit-action">{row.action}</span></td>
                  <td className="mono small">
                    {row.entity_type ? `${row.entity_type}` : '—'}
                    {row.entity_id && <span className="muted"> · {row.entity_id.slice(0, 16)}</span>}
                  </td>
                  <td className="muted small">
                    {row.before && row.after ? `Changed — click to view diff`
                      : row.before ? `Removed — click to view previous`
                      : row.after ? `Created — click to view`
                      : row.metadata ? `See metadata`
                      : '—'}
                  </td>
                </tr>
                {openRow === row.id && (
                  <tr className="audit-row-expansion">
                    <td colSpan="5">
                      <div className="audit-detail">
                        {row.metadata && (
                          <div className="audit-meta">
                            <div className="audit-diff-label">Metadata</div>
                            <pre>{JSON.stringify(row.metadata, null, 2)}</pre>
                          </div>
                        )}
                        <JsonDiff before={row.before} after={row.after} />
                        <div className="muted small">
                          IP: <span className="mono">{row.ip_address || '—'}</span>
                          {row.user_agent && <span> · UA: <span className="mono">{row.user_agent.slice(0, 80)}</span></span>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted">Page {page} / {pages} · {total} events</span>
        <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
  );
}
