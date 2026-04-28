import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi.js';

export default function SubAgents() {
  const { data, loading, error } = useApi('/sub-agents', {}, []);
  const items = data || [];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Sub-Agents</h1>
          <p className="muted">Your direct downline. Sensitive info masked unless they've granted data sharing.</p>
        </div>
      </header>

      {error && <div className="alert error">{error.message}</div>}

      <div className="grid-cards">
        {loading && <div className="muted">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="muted">No sub-agents under you yet.</div>
        )}
        {items.map(a => (
          <Link key={a.id} to={`/sub-agents/${a.id}`} className="card agent-card">
            <div className="agent-head">
              <div className="user-initial big">{(a.name || '?')[0].toUpperCase()}</div>
              <div>
                <div className="agent-name">{a.name}</div>
                <div className="muted small">{a.email || '—'}</div>
              </div>
            </div>
            <div className="agent-stats">
              <div>
                <div className="muted small">Their sub-agents</div>
                <div className="mono big">{a.direct_sub_count}</div>
              </div>
              <div>
                <div className="muted small">Their clients</div>
                <div className="mono big">{a.direct_clients_count}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
