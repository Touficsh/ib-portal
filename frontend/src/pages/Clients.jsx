import { useState } from 'react';
import { useApi } from '../hooks/useApi.js';

const STAGES = ['', 'Lead', 'Contacted', 'Funded', 'Active', 'Churned'];

export default function Clients() {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);

  const { data, loading, error } = useApi(
    '/clients',
    { query: { q, pipeline_stage: stage || undefined, page, pageSize: 25 } },
    [q, stage, page]
  );

  const items = data?.items || [];
  const total = data?.pagination?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>My Clients</h1>
          <p className="muted">Clients you personally referred. Full details visible.</p>
        </div>
      </header>

      <div className="filter-bar">
        <input
          className="input"
          placeholder="Search name / email / phone"
          value={q}
          onChange={e => { setPage(1); setQ(e.target.value); }}
        />
        <select
          className="input"
          value={stage}
          onChange={e => { setPage(1); setStage(e.target.value); }}
        >
          {STAGES.map(s => <option key={s} value={s}>{s || 'All stages'}</option>)}
        </select>
      </div>

      {error && <div className="alert error">{error.message}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Stage</th>
              <th>Product</th>
              <th className="num">MT5 logins</th>
              <th className="num">Total lots</th>
              <th className="num">My commission</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="8" className="muted pad">Loading…</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan="8" className="muted pad">No clients yet.</td></tr>
            )}
            {items.map(c => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.email || '—'}</td>
                <td className="mono">{c.phone || '—'}</td>
                <td><span className={`pill stage-${(c.pipeline_stage || '').toLowerCase()}`}>{c.pipeline_stage}</span></td>
                <td>{c.product_name || '—'}</td>
                <td className="num mono">{c.mt5_login_count}</td>
                <td className="num mono">{Number(c.total_lots || 0).toFixed(2)}</td>
                <td className="num mono">{Number(c.my_commission_earned || 0).toFixed(2)} {c.currency || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted">Page {page} / {pages} · {total} total</span>
        <button className="btn ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
  );
}
