import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi.js';

export default function SubAgentDetail() {
  const { id } = useParams();
  const { data: sub, loading: subLoading } = useApi(`/sub-agents/${id}`, {}, [id]);
  const { data: clientsPayload, loading: clientsLoading } = useApi(
    `/sub-agents/${id}/clients`,
    { query: { page: 1, pageSize: 50 } },
    [id]
  );

  const clients = clientsPayload?.items || [];

  return (
    <div>
      <header className="page-header">
        <div>
          <Link to="/sub-agents" className="backlink">← Sub-agents</Link>
          <h1>{subLoading ? 'Loading…' : sub?.name || 'Sub-agent'}</h1>
          {sub && <p className="muted">{sub.email || '—'}</p>}
        </div>
      </header>

      <section className="stat-row">
        <div className="stat"><div className="stat-label">Their sub-agents</div><div className="stat-value">{sub?.direct_sub_count ?? '—'}</div></div>
        <div className="stat"><div className="stat-label">Their clients</div><div className="stat-value">{sub?.direct_clients_count ?? '—'}</div></div>
        <div className="stat"><div className="stat-label">Products held</div><div className="stat-value">{sub?.products?.length ?? '—'}</div></div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Their products &amp; rates</h2>
          <span className="muted small">Read-only · admins manage rate assignments</span>
        </div>
        <table className="table">
          <thead><tr><th>Product</th><th className="num">Their rate / lot</th><th>Status</th></tr></thead>
          <tbody>
            {(sub?.products || []).length === 0 && (
              <tr><td colSpan="3" className="muted pad">No products assigned to this sub-agent yet.</td></tr>
            )}
            {(sub?.products || []).map(p => (
              <tr key={p.product_id}>
                <td>{p.product_name}</td>
                <td className="num mono">{Number(p.rate_per_lot).toFixed(2)} {p.currency}</td>
                <td>{p.is_active ? 'Active' : 'Revoked'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Their clients</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Phone</th><th>Stage</th>
              <th className="num">MT5 logins</th><th className="num">Total lots</th><th className="num">My override</th>
            </tr>
          </thead>
          <tbody>
            {clientsLoading && <tr><td colSpan="7" className="muted pad">Loading…</td></tr>}
            {!clientsLoading && clients.length === 0 && (
              <tr><td colSpan="7" className="muted pad">No clients under this sub-agent.</td></tr>
            )}
            {clients.map(c => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.email || '—'}</td>
                <td className="mono">{c.phone || '—'}</td>
                <td><span className={`pill stage-${(c.pipeline_stage || '').toLowerCase()}`}>{c.pipeline_stage}</span></td>
                <td className="num mono">{c.mt5_login_count}</td>
                <td className="num mono">{Number(c.total_lots || 0).toFixed(2)}</td>
                <td className="num mono">{Number(c.my_override_earned || 0).toFixed(2)} {c.currency || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
