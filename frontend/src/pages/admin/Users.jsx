import { useState } from 'react';
import { useApi, useMutation, useAutoRefresh } from '../../hooks/useApi.js';
import { toast, confirm } from '../../components/ui/toast.js';
import LastUpdated from '../../components/LastUpdated.jsx';

/**
 * Admin — Users — lists all CRM users and promotes them to agent.
 * Hits /api/users (admin route) and /api/agents/:id/promote.
 */
export default function AdminUsers() {
  const { data: users, loading, refetch, dataAt } = useApi('/api/users', {}, []);
  const { data: agents } = useApi('/api/agents', {}, []);
  const { data: products } = useApi('/api/products', {}, []);
  // Auto-refresh every 60s + on tab refocus. Picks up changes from another
  // admin granting a permission or promoting a user.
  useAutoRefresh(refetch, 60_000);

  const [pickedUser, setPickedUser] = useState(null);
  const [parentId, setParentId] = useState('');
  const [productAssignments, setProductAssignments] = useState([]); // [{product_id, rate_per_lot}]
  const [notice, setNotice] = useState(null);

  const [promote, { loading: promoting }] = useMutation();
  const [demote, { loading: demoting }] = useMutation();
  const [resetPw, { loading: resettingPw }] = useMutation();
  const [pwUserId, setPwUserId] = useState(null);   // null when modal closed
  const [pwValue, setPwValue] = useState('');
  const [pwShow, setPwShow] = useState(false);

  function openPwModal(user) {
    setPwUserId(user.id);
    setPwValue('');
    setPwShow(false);
  }
  function closePwModal() {
    setPwUserId(null);
    setPwValue('');
  }
  async function submitPwReset(e) {
    e?.preventDefault?.();
    if (pwValue.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    const user = (users || []).find(u => u.id === pwUserId);
    try {
      await resetPw(`/api/users/${pwUserId}/reset-password`, {
        method: 'POST',
        body: { password: pwValue },
      });
      toast.success(`Password reset for ${user?.name || 'user'}`);
      closePwModal();
    } catch (err) {
      toast.error(err.message || 'Reset failed');
    }
  }

  function addProductAssignment() {
    setProductAssignments(list => [...list, { product_id: '', rate_per_lot: '' }]);
  }
  function updateProductAssignment(i, patch) {
    setProductAssignments(list => list.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function removeProductAssignment(i) {
    setProductAssignments(list => list.filter((_, idx) => idx !== i));
  }

  async function onPromote(e) {
    e.preventDefault();
    setNotice(null);
    const cleanAssignments = productAssignments
      .filter(a => a.product_id && a.rate_per_lot !== '')
      .map(a => ({ product_id: a.product_id, rate_per_lot: Number(a.rate_per_lot) }));
    try {
      await promote(`/api/agents/${pickedUser.id}/promote`, {
        method: 'POST',
        body: {
          parent_agent_id: parentId || null,
          products: cleanAssignments,
        },
      });
      setNotice({ kind: 'success', text: `Promoted ${pickedUser.name} to agent.` });
      setPickedUser(null);
      setParentId('');
      setProductAssignments([]);
      refetch();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message || 'Promotion failed' });
    }
  }

  async function onDemote(user) {
    const ok = await confirm(
      `Demote ${user.name} and move their sub-agents up one level?`,
      { confirmLabel: 'Demote', cancelLabel: 'Cancel', variant: 'danger' }
    );
    if (!ok) return;
    try {
      await demote(`/api/agents/${user.id}/demote`, { method: 'POST' });
      refetch();
      toast.success(`${user.name} demoted`);
    } catch (err) {
      toast.error(err.message || 'Demote failed');
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Admin · Staff Users</h1>
          <p className="muted">
            Staff accounts (admins, reps). Real IB agents come from the synced CRM data —
            see <a href="/portal/admin/import-agents" className="link-accent">Import Agents</a>.
          </p>
        </div>
        <div style={{ paddingTop: 6 }}>
          <LastUpdated dataAt={dataAt} loading={loading} />
        </div>
      </header>

      {notice && <div className={`alert ${notice.kind}`}>{notice.text}</div>}

      <div className="card">
        <div className="card-header"><h2>Users</h2></div>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Agent?</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="6" className="muted pad">Loading…</td></tr>}
            {!loading && (!users || users.length === 0) && (
              <tr><td colSpan="6" className="muted pad">No users.</td></tr>
            )}
            {(users || []).map(u => {
              const isAgent = u.role === 'agent';
              return (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td>{isAgent ? <span className="pill stage-active">Agent</span> : '—'}</td>
                  <td>{u.is_active ? 'Active' : 'Inactive'}</td>
                  <td className="num" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      className="btn ghost small"
                      onClick={() => openPwModal(u)}
                      title="Set a new password for this user"
                    >
                      Reset password
                    </button>
                    {isAgent ? (
                      <button className="btn ghost small" disabled={demoting} onClick={() => onDemote(u)}>Demote</button>
                    ) : (
                      <button className="btn primary small" onClick={() => setPickedUser(u)}>Promote</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Password reset modal — opens when admin clicks "Reset password" on
          any row. Plain centered card overlay; closes on Cancel or success. */}
      {pwUserId && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closePwModal(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <form
            onSubmit={submitPwReset}
            className="card"
            style={{ width: '100%', maxWidth: 420, margin: 0 }}
          >
            <div className="card-header">
              <h2 style={{ margin: 0 }}>
                Reset password — {(users || []).find(u => u.id === pwUserId)?.name}
              </h2>
              <button type="button" className="btn ghost small" onClick={closePwModal}>Cancel</button>
            </div>
            <div className="pad">
              <label className="field">
                <span>New password (min 8 chars)</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    autoFocus
                    type={pwShow ? 'text' : 'password'}
                    className="input"
                    value={pwValue}
                    onChange={e => setPwValue(e.target.value)}
                    minLength={8}
                    required
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setPwShow(s => !s)}
                    title={pwShow ? 'Hide' : 'Show'}
                  >
                    {pwShow ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              <p className="muted small" style={{ marginTop: 8 }}>
                The user can sign in with this immediately. Hand it to them through a secure channel.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn ghost" onClick={closePwModal}>Cancel</button>
                <button type="submit" className="btn primary" disabled={resettingPw || pwValue.length < 8}>
                  {resettingPw ? 'Resetting…' : 'Set new password'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {pickedUser && (
        <section className="card">
          <div className="card-header">
            <h2>Promote {pickedUser.name}</h2>
            <button className="btn ghost small" onClick={() => setPickedUser(null)}>Cancel</button>
          </div>
          <form className="pad" onSubmit={onPromote}>
            <div className="form-row">
              <label className="field">
                <span>Parent agent (leave empty for top-level)</span>
                <select className="input" value={parentId} onChange={e => setParentId(e.target.value)}>
                  <option value="">— top-level agent —</option>
                  {(agents || []).map(a => (
                    <option key={a.id} value={a.id}>{a.name} ({a.email})</option>
                  ))}
                </select>
              </label>
            </div>

            <h3 style={{ marginTop: 18, fontSize: 14 }}>Initial products (optional)</h3>
            <p className="muted small">Rates must be ≤ the parent agent's rate (or ≤ product max for top-level).</p>

            {productAssignments.map((a, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <label className="field">
                  <span>Product</span>
                  <select className="input" value={a.product_id} onChange={e => updateProductAssignment(i, { product_id: e.target.value })}>
                    <option value="">— pick —</option>
                    {(products || []).filter(p => p.is_active).map(p => (
                      <option key={p.id} value={p.id}>{p.name} (max {p.max_rate_per_lot} {p.currency})</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Rate / lot</span>
                  <input type="number" step="0.01" min="0" className="input" value={a.rate_per_lot} onChange={e => updateProductAssignment(i, { rate_per_lot: e.target.value })} />
                </label>
                <button type="button" className="btn ghost small" onClick={() => removeProductAssignment(i)}>Remove</button>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="button" className="btn ghost" onClick={addProductAssignment}>+ Add product</button>
              <button type="submit" className="btn primary" disabled={promoting}>
                {promoting ? 'Promoting…' : 'Promote to agent'}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
