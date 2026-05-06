import { useState } from 'react';
import { useApi, useMutation, useAutoRefresh } from '../../hooks/useApi.js';
import { toast, confirm } from '../../components/ui/toast.js';
import LastUpdated from '../../components/LastUpdated.jsx';

const CRM_SOURCE_BADGE = { crm: 'from x-dev CRM', manual: 'manual' };

/**
 * Admin — Products — full CRUD. Lowering max_rate_per_lot may orphan existing
 * agent rates; the backend returns 409 listing affected agents which we surface
 * and let the admin retry with ?force=true to clamp.
 */
export default function AdminProducts() {
  const { data: products, loading, refetch, dataAt } = useApi('/api/products', {}, []);
  // Auto-refresh on tab refocus + every 60s — picks up edits made by another
  // admin (rate ceilings, product activations) while this view is open.
  useAutoRefresh(refetch, 60_000);
  const [save, { loading: saving }] = useMutation();
  const [del] = useMutation();

  const [editing, setEditing] = useState(null); // product row or { id: null } for "new"
  // commission_per_lot and rebate_per_lot are the source of truth; max_rate is computed as their sum.
  const [form, setForm] = useState({ name: '', description: '', commission_per_lot: '', rebate_per_lot: '', currency: 'USD', is_active: true });
  const [notice, setNotice] = useState(null);

  const [runSync, { loading: syncing }] = useMutation();

  async function onSyncFromCRM() {
    setNotice(null);
    try {
      const r = await runSync('/api/products/sync-from-crm', { method: 'POST' });
      setNotice({
        kind: 'success',
        text: `Synced from x-dev: created ${r.created}, updated ${r.updated}, skipped ${r.skipped}${r.errors ? `, errors ${r.errors}` : ''}.`,
      });
      refetch();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message || 'CRM sync failed' });
    }
  }

  function openNew() {
    setEditing({ id: null });
    setForm({ name: '', description: '', commission_per_lot: '', rebate_per_lot: '', currency: 'USD', is_active: true });
    setNotice(null);
  }
  function openEdit(p) {
    setEditing(p);
    setForm({
      name: p.name || '',
      description: p.description || '',
      // Back-fill from max_rate_per_lot when commission/rebate haven't been split yet
      // (legacy rows pre-Model-C). Admin sees full max in the commission bucket
      // so nothing is "lost"; they can then split it however they want.
      commission_per_lot: p.commission_per_lot ?? p.max_rate_per_lot ?? '',
      rebate_per_lot: p.rebate_per_lot ?? 0,
      currency: p.currency || 'USD',
      is_active: !!p.is_active,
    });
    setNotice(null);
  }

  // Derived total shown live in the form as the admin edits the split.
  const derivedMax = Number(form.commission_per_lot || 0) + Number(form.rebate_per_lot || 0);

  async function onSubmit(e, force = false) {
    e?.preventDefault?.();
    setNotice(null);
    try {
      const body = {
        ...form,
        commission_per_lot: Number(form.commission_per_lot || 0),
        rebate_per_lot: Number(form.rebate_per_lot || 0),
      };
      if (editing.id) {
        await save(`/api/products/${editing.id}${force ? '?force=true' : ''}`, {
          method: 'PATCH',
          body,
        });
      } else {
        await save('/api/products', {
          method: 'POST',
          body,
        });
      }
      setEditing(null);
      refetch();
    } catch (err) {
      // Backend returns 409 with {affected:[...]} when lowering max orphans rates
      if (err.status === 409 && err.body?.affected) {
        setNotice({
          kind: 'error',
          text: `Lowering this rate will affect ${err.body.affected.length} agent assignment(s).`,
          showForce: true,
        });
      } else {
        setNotice({ kind: 'error', text: err.message });
      }
    }
  }

  async function onDelete(p) {
    const ok = await confirm(`Soft-delete "${p.name}"? This hides it from the active catalog.`, {
      confirmLabel: 'Archive', cancelLabel: 'Keep', variant: 'danger',
    });
    if (!ok) return;
    try {
      await del(`/api/products/${p.id}`, { method: 'DELETE' });
      refetch();
      toast.success(`"${p.name}" archived`);
    } catch (err) {
      toast.error(err.message || 'Archive failed');
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Admin · Products</h1>
          <p className="muted">Broker products + per-lot rate ceilings.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <LastUpdated dataAt={dataAt} loading={loading} />
          <button className="btn ghost" onClick={onSyncFromCRM} disabled={syncing} title="Pull /api/products from x-dev's CRM and upsert">
            {syncing ? 'Syncing…' : 'Sync from x-dev CRM'}
          </button>
          <button className="btn primary" onClick={openNew}>+ New product</button>
        </div>
      </header>

      {notice && <div className={`alert ${notice.kind}`}>{notice.text}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th className="num">Commission / lot</th>
              <th className="num">Rebate / lot</th>
              <th className="num">Max / lot</th>
              <th>Currency</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="8" className="muted pad">Loading…</td></tr>}
            {!loading && (!products || products.length === 0) && (
              <tr><td colSpan="8" className="muted pad">No products yet. Click "Sync from x-dev CRM" to pull the catalog.</td></tr>
            )}
            {(products || []).map(p => {
              const needsRate = Number(p.max_rate_per_lot) === 0;
              return (
                <tr key={p.id}>
                  <td>
                    <div>{p.name} {p.code && <span className="muted small mono">· {p.code}</span>}</div>
                    {(p.description || p.product_group) && (
                      <div className="muted small">
                        {p.product_group ? `Group: ${p.product_group}` : ''}
                        {p.description && p.product_group ? ' — ' : ''}
                        {p.description || ''}
                      </div>
                    )}
                  </td>
                  <td><span className={`pill ${p.source === 'crm' ? 'stage-contacted' : 'stage-lead'}`}>{CRM_SOURCE_BADGE[p.source] || p.source}</span></td>
                  <td className="num mono">{Number(p.commission_per_lot ?? 0).toFixed(2)}</td>
                  <td className="num mono">{Number(p.rebate_per_lot ?? 0).toFixed(2)}</td>
                  <td className="num mono">
                    {needsRate
                      ? <span className="pill stage-churned" title="Product won't be grantable until commission + rebate are set">needs rate</span>
                      : <b>{Number(p.max_rate_per_lot).toFixed(2)}</b>}
                  </td>
                  <td>{p.currency}</td>
                  <td>{p.is_active ? 'Active' : 'Archived'}</td>
                  <td className="num">
                    <button className="btn ghost small" onClick={() => openEdit(p)}>Edit</button>{' '}
                    {p.is_active && <button className="btn ghost small" onClick={() => onDelete(p)}>Archive</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <section className="card">
          <div className="card-header">
            <h2>{editing.id ? 'Edit product' : 'New product'}</h2>
            <button className="btn ghost small" onClick={() => setEditing(null)}>Cancel</button>
          </div>
          <form className="pad" onSubmit={onSubmit}>
            <div className="form-row">
              <label className="field">
                <span>Name</span>
                <input required className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Commission / lot <span className="muted small">(MT5 charge)</span></span>
                <input required type="number" step="0.01" min="0" className="input" value={form.commission_per_lot} onChange={e => setForm({ ...form, commission_per_lot: e.target.value })} />
              </label>
              <label className="field">
                <span>Rebate / lot <span className="muted small">(broker kickback)</span></span>
                <input required type="number" step="0.01" min="0" className="input" value={form.rebate_per_lot} onChange={e => setForm({ ...form, rebate_per_lot: e.target.value })} />
              </label>
              <label className="field">
                <span>Currency</span>
                <input className="input mono" maxLength="10" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
              </label>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>
              Max rate per lot (the ceiling any agent can receive) = Commission + Rebate =
              <b style={{ color: 'var(--accent)', marginLeft: 6 }}>{derivedMax.toFixed(2)} {form.currency}</b>
            </div>
            <label className="field" style={{ marginTop: 12 }}>
              <span>Description (optional)</span>
              <input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </label>
            <label style={{ marginTop: 12, display: 'flex', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              <span>Active</span>
            </label>

            {notice && <div className={`alert ${notice.kind}`} style={{ marginTop: 12 }}>
              {notice.text}
              {notice.showForce && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn primary small" onClick={e => onSubmit(e, true)}>
                    Clamp affected rates and save
                  </button>
                </div>
              )}
            </div>}

            <div style={{ marginTop: 14 }}>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? 'Saving…' : (editing.id ? 'Save changes' : 'Create')}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
