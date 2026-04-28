import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Wand2, Activity, RefreshCw } from 'lucide-react';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { api, getToken } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import CommissionsSection from '../../components/CommissionsSection.jsx';
import { toast, confirm } from '../../components/ui/toast.js';

/**
 * TradingAccountsSection — lists every MT5 login across this agent's client book.
 * Balance/equity are fetched on-demand by clicking "Load balance" per row so one
 * expand doesn't trigger hundreds of bridge calls (each goes through a semaphore
 * in the .NET side).
 */
function TradingAccountsSection({ agentId }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, loading } = useApi(
    `/api/agents/${agentId}/trading-accounts`,
    { query: { page, pageSize: 25, q: q || undefined } },
    [agentId, page, q]
  );
  const [liveByLogin, setLiveByLogin] = useState({});
  const [loadingLogin, setLoadingLogin] = useState(null);

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
  const total = data?.pagination?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <section className="card">
      <div className="card-header">
        <h2>Trading accounts</h2>
        <span className="muted small">
          {loading ? 'loading…' : `${total} MT5 account${total === 1 ? '' : 's'} across this agent's clients`}
        </span>
      </div>
      <div className="filter-bar" style={{ padding: '10px 16px', margin: 0 }}>
        <input
          className="input"
          placeholder="Search client name, email, or login…"
          value={q}
          onChange={e => { setPage(1); setQ(e.target.value); }}
          style={{ minWidth: 280 }}
        />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Client</th>
            <th className="num">MT5 login</th>
            <th>Stage</th>
            <th>Type</th>
            <th>FTD</th>
            <th className="num">Balance</th>
            <th className="num">Equity</th>
            <th className="num">Profit</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan="9" className="muted pad">Loading…</td></tr>}
          {!loading && items.length === 0 && (
            <tr><td colSpan="9" className="muted pad">No trading accounts yet (no clients have MT5 logins).</td></tr>
          )}
          {items.map((r, idx) => {
            const live = liveByLogin[r.mt5_login];
            const hasLive = live && !live._error && !live._stub;
            return (
              <tr key={`${r.client_id}-${r.mt5_login}-${idx}`}>
                <td>
                  <div>{r.client_name}</div>
                  <div className="muted small">{r.email || '—'}</div>
                </td>
                <td className="num mono">{r.mt5_login}</td>
                <td><span className={`pill stage-${(r.pipeline_stage || '').toLowerCase()}`}>{r.pipeline_stage}</span></td>
                <td>{r.crm_profile_type || '—'}</td>
                <td>{r.first_deposit_at ? '✓' : '—'}</td>
                <td className="num mono">{hasLive ? Number(live.balance).toFixed(2) : '—'}</td>
                <td className="num mono">{hasLive ? Number(live.equity).toFixed(2) : '—'}</td>
                <td className="num mono" style={{ color: hasLive && live.profit < 0 ? 'var(--danger)' : hasLive && live.profit > 0 ? 'var(--success)' : undefined }}>
                  {hasLive ? Number(live.profit).toFixed(2) : '—'}
                </td>
                <td className="num">
                  {live?._stub ? (
                    <span className="muted small">bridge down</span>
                  ) : live?._error ? (
                    <span style={{ color: 'var(--danger)' }} className="small">err</span>
                  ) : live ? (
                    <button className="btn ghost small" onClick={() => loadBalance(r.mt5_login)}>Refresh</button>
                  ) : (
                    <button
                      className="btn ghost small"
                      disabled={loadingLogin === r.mt5_login}
                      onClick={() => loadBalance(r.mt5_login)}
                    >
                      {loadingLogin === r.mt5_login ? 'Loading…' : 'Load'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="pager">
        <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span className="muted small">Page {page} / {totalPages} · {total} total</span>
        <button className="btn ghost small" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </section>
  );
}

/**
 * SubAgentNode — one sub-agent row that can expand to reveal its own downline
 * (sub-sub-agents + individuals) inline. Recursive: each expanded sub-sub-agent
 * can itself be expanded. Uses /api/agents/by-client/:id/downline so the expand
 * works even when the sub-agent isn't imported into the portal yet.
 */
function SubAgentNode({ sub, depth = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState(null);
  const [indivs, setIndivs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showIndivs, setShowIndivs] = useState(false);

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      try {
        const res = await api(`/api/agents/by-client/${sub.id}/downline?type=agents&pageSize=50`);
        setChildren(res?.items || []);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }

  async function toggleIndivs() {
    const next = !showIndivs;
    setShowIndivs(next);
    if (next && indivs === null) {
      try {
        const res = await api(`/api/agents/by-client/${sub.id}/downline?type=individuals&pageSize=10`);
        setIndivs(res);
      } catch {
        setIndivs({ items: [], pagination: { total: 0 } });
      }
    }
  }

  const hasSubs = sub.their_subagents > 0;
  const hasIndivs = sub.their_individuals > 0;

  return (
    <div className={`subagent-row depth-${Math.min(depth, 4)}`} style={{ marginLeft: depth * 16 }}>
      <div className="subagent-head">
        <button
          className={`toggle ${expanded ? 'open' : ''}`}
          onClick={toggleExpand}
          disabled={!hasSubs && !hasIndivs}
          title={hasSubs || hasIndivs ? 'Expand downline' : 'No downline'}
          style={{ opacity: (hasSubs || hasIndivs) ? 1 : 0.3 }}
        >
          <span>▾</span>
        </button>
        <div className="agent-initial">{(sub.name || '?')[0].toUpperCase()}</div>
        <div className="subagent-main">
          {sub.is_in_portal && sub.portal_user_id ? (
            <Link to={`/admin/agents/${sub.portal_user_id}`} className="agent-name-link">{sub.name}</Link>
          ) : (
            <span className="agent-name-link" style={{ color: 'var(--text-dim)' }}>{sub.name}</span>
          )}
          <div className="muted small">
            {sub.email || '—'}
            {sub.branch && <span> · {sub.branch}</span>}
            {sub.country && <span> · {sub.country}</span>}
          </div>
        </div>
        <div className="subagent-stats">
          <div className="stat-chip" title="KYC-verified clients">
            <div className="stat-chip-val mono">{sub.their_clients ?? 0}</div>
            <div className="stat-chip-lbl">clients</div>
          </div>
          <div className="stat-chip" title="Unverified leads">
            <div className="stat-chip-val mono">{sub.their_leads ?? 0}</div>
            <div className="stat-chip-lbl">leads</div>
          </div>
          <div className="stat-chip" title="Sub-agents referred by this agent">
            <div className="stat-chip-val mono">{sub.their_subagents ?? 0}</div>
            <div className="stat-chip-lbl">subs</div>
          </div>
          <div className="stat-chip" title="Products linked in CRM / portal">
            <div className="stat-chip-val mono">{(sub.products || []).length}</div>
            <div className="stat-chip-lbl">products</div>
          </div>
          {sub.is_in_portal
            ? <span className="pill stage-contacted">In portal</span>
            : <span className="pill stage-lead">Not imported</span>}
        </div>
      </div>

      {(sub.products || []).length > 0 && (
        <div className="subagent-products">
          <div className="hierarchy-section-label muted small">
            PRODUCTS {!sub.is_in_portal && <span className="muted" style={{ fontWeight: 400 }}>(from x-dev CRM)</span>}
          </div>
          <div className="product-chip-row">
            {sub.products.map((p, idx) => {
              const isCrmOnly = p.source === 'crm-only' || p.in_portal === false;
              const hasRate = !isCrmOnly && p.rate_per_lot > 0;
              return (
                <div key={p.product_id || `${p.code}-${idx}`} className={`product-chip ${isCrmOnly ? 'crm-only' : ''}`}>
                  <span className="product-chip-name">{p.name}</span>
                  {p.code && <span className="product-chip-code mono muted">{p.code}</span>}
                  {isCrmOnly ? (
                    <span className="pill pill-outline">{p.status || 'crm-only'}</span>
                  ) : (
                    <span className={`pill ${hasRate ? 'stage-active' : 'stage-churned'}`}>
                      {hasRate ? `${p.rate_per_lot.toFixed(2)} ${p.currency || ''}/lot` : 'needs rate'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {expanded && (
        <div className="subagent-children">
          {loading && <div className="muted pad small">Loading downline…</div>}
          {!loading && hasIndivs && (
            <div className="subagent-indivs">
              <button className="indivs-toggle" onClick={toggleIndivs}>
                {showIndivs ? '▾' : '▸'} {sub.their_individuals} individual{sub.their_individuals === 1 ? '' : 's'}
                <span className="muted small"> ({sub.their_clients}c + {sub.their_leads}l)</span>
              </button>
              {showIndivs && indivs && (
                <div className="indivs-list">
                  {(indivs.items || []).map(c => (
                    <div key={c.id} className="indivs-row">
                      <span>{c.name}</span>
                      <span className="muted small">{c.email || '—'}</span>
                      <span className={`pill stage-${(c.pipeline_stage || '').toLowerCase()}`}>{c.pipeline_stage}</span>
                      <span className="muted small mono">mt5×{c.mt5_login_count}</span>
                    </div>
                  ))}
                  {indivs.pagination?.total > (indivs.items?.length || 0) && (
                    <div className="muted small" style={{ padding: '4px 8px' }}>
                      … and {indivs.pagination.total - indivs.items.length} more
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!loading && (children || []).length > 0 && (
            <div className="subagent-sub-tree">
              {children.map(ch => (
                <SubAgentNode key={ch.id} sub={ch} depth={depth + 1} />
              ))}
            </div>
          )}
          {!loading && !hasIndivs && (children || []).length === 0 && (
            <div className="muted pad small">No further downline.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Admin — Agent Detail
 *
 * Side-by-side view of:
 *   - Current `agent_products` rows (what the portal knows)
 *   - `/api/agents/:id/crm-products` (what x-dev's CRM says this agent holds)
 *
 * The detail comes from the agent's linked_client_id being looked up in every
 * product's agents[] array on CRM. Products with rate_per_lot=0 show a "needs
 * rate" pill — admin edits them inline via PATCH on agent_products rate.
 */
/* CommissionsSection lives in ../../components/CommissionsSection.jsx now. */

export default function AgentDetail() {
  const { id } = useParams();
  const { data: agent, loading: agentLoading } = useApi(`/api/agents/${id}`, {}, [id]);
  const { data: crm, loading: crmLoading, refetch } = useApi(`/api/agents/${id}/crm-products`, {}, [id]);

  // Downline: sub-agents (with products embedded) + individual clients (paginated)
  const { data: subAgents, loading: subAgentsLoading } =
    useApi(`/api/agents/${id}/downline`, { query: { type: 'agents', pageSize: 200 } }, [id]);
  const [clientsPage, setClientsPage] = useState(1);
  const [clientsQ, setClientsQ] = useState('');
  const { data: individuals, loading: individualsLoading } =
    useApi(
      `/api/agents/${id}/downline`,
      { query: { type: 'individuals', page: clientsPage, pageSize: 25, q: clientsQ || undefined } },
      [id, clientsPage, clientsQ]
    );

  const [setRate, { loading: savingRate }] = useMutation();
  const [healSelf, { loading: healingSelf }] = useMutation();
  const [healSubtree, { loading: healingSubtree }] = useMutation();
  const [syncMt5, { loading: syncingMt5 }] = useMutation();
  const [syncCommSelf,    { loading: syncingCommSelf }]    = useMutation();
  const [syncCommSubtree, { loading: syncingCommSubtree }] = useMutation();

  // Sync commission rates for THIS agent only — single CRM round-trip (or 2
  // if the wallet ID isn't cached yet). Best button for "I just told sales
  // to update Sophia's rate, pull it now."
  async function doSyncCommSelf() {
    const ok = await confirm(
      `Sync commission rates for this agent only?\n\n` +
      `Pulls % + $/lot config from xdev CRM into the engine's lookup table. ` +
      `1–2 CRM calls. Idempotent.`,
      { confirmLabel: 'Sync this agent', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await syncCommSelf(`/api/agents/${id}/sync-commission-levels`, { method: 'POST' });
      toast.success(
        `Synced — ${r.groups_upserted || 0} rate config${r.groups_upserted === 1 ? '' : 's'} updated.`,
        { duration: 6000 }
      );
    } catch (err) {
      toast.error(err.message || 'Sync failed');
    }
  }

  // Sync commission rates for this agent + every descendant. Walks the
  // subtree on the backend and only hits CRM for agents not synced in the
  // last 24h (configurable). Way cheaper than the global "Sync all rates"
  // button — only touches the slice you care about.
  async function doSyncCommSubtree({ force = false } = {}) {
    const ok = await confirm(
      force
        ? `FORCE-FULL sync of this agent's subtree (rates only)?\n\n` +
          `Walks every descendant regardless of last-sync time. Up to N CRM ` +
          `calls where N = subtree size × 1–2. Use only when rates definitely ` +
          `changed and you need them right now.`
        : `Sync commission rates for this agent + their entire subtree?\n\n` +
          `Smart mode: skips agents synced within the last 24h to spare CRM. ` +
          `Use Force Full only if rates definitely changed.`,
      {
        confirmLabel: force ? 'Force full subtree sync' : 'Sync subtree (smart)',
        cancelLabel: 'Cancel',
        variant: force ? 'danger' : undefined,
      }
    );
    if (!ok) return;
    try {
      const url = force
        ? `/api/agents/${id}/sync-commission-levels-subtree?staleAfterHours=0`
        : `/api/agents/${id}/sync-commission-levels-subtree`;
      const r = await syncCommSubtree(url, { method: 'POST' });
      toast.success(
        r.note || `Subtree sync started (${r.subtree_size || '?'} agents).`,
        { duration: 8000 }
      );
    } catch (err) {
      toast.error(err.message || 'Subtree sync failed');
    }
  }

  async function doSyncMt5Snapshot() {
    const ok = await confirm(
      `Sync MT5 deal history for this agent's entire subtree?\n\n` +
      `This calls the MT5 bridge (localhost) — NOT xdev CRM. It fetches deal history for every login in this agent's downline that hasn't been synced recently.\n\n` +
      `Throttled at 20/sec by the bridge gate. Typical agent with ~100 logins completes in ~10 seconds.\n\n` +
      `After this runs, the commission engine will produce commission rows on its next cycle (every 15 min) — or you can trigger it manually from Reconciliation.`,
      { confirmLabel: 'Sync MT5 snapshot', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      await syncMt5(`/api/agents/${id}/sync-mt5-snapshot`, { method: 'POST' });
      toast.success(
        'MT5 sync running in background. Watch the Reconciliation page — deals will start appearing in cache within seconds.',
        { duration: 10000 }
      );
    } catch (err) {
      toast.error(err.message || 'MT5 sync failed');
    }
  }
  const [editingProductId, setEditingProductId] = useState(null);
  const [newRate, setNewRate] = useState('');
  const [notice, setNotice] = useState(null);

  async function doHealSelf() {
    const ok = await confirm(
      `Heal this agent's rates?\n\nAny product at $0/lot will be set to the parent's rate (or the product's max for a top-level agent). Non-zero rates are preserved.`,
      { confirmLabel: 'Heal rates', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await healSelf(`/api/agents/${id}/heal-rates`, { method: 'POST' });
      toast.success(`Updated ${r.updated} rate${r.updated === 1 ? '' : 's'}.`);
      refetch();
    } catch (err) {
      toast.error(err.message || 'Heal failed');
    }
  }

  async function doHealSubtree() {
    const ok = await confirm(
      `Heal this agent AND every sub-agent below them?\n\nProcessed top-down so children inherit their parent's freshly-set rate. Existing non-zero rates are preserved. Rebuild commissions in Reconciliation afterwards so history populates.`,
      { confirmLabel: 'Heal tree', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await healSubtree(`/api/agents/${id}/heal-rates/subtree`, { method: 'POST' });
      toast.success(`Healed ${r.totalUpdated} rate${r.totalUpdated === 1 ? '' : 's'} across ${r.agents} agents.`, { duration: 8000 });
      refetch();
    } catch (err) {
      toast.error(err.message || 'Heal failed');
    }
  }

  async function saveRate(productId) {
    setNotice(null);
    try {
      await setRate(`/api/agents/${id}/products`, {
        method: 'POST',
        body: { product_id: productId, rate_per_lot: Number(newRate) },
      });
      setNotice({ kind: 'success', text: `Rate saved: ${Number(newRate).toFixed(2)} / lot` });
      setEditingProductId(null);
      setNewRate('');
      refetch();
    } catch (err) {
      if (err.status === 400 && err.body?.reason === 'exceeds_ceiling') {
        setNotice({ kind: 'error', text: `Exceeds ceiling of ${err.body.ceiling}` });
      } else {
        setNotice({ kind: 'error', text: err.message });
      }
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <Link to="/admin/agents" className="backlink">← Agents Tree</Link>
          <h1>{agentLoading ? 'Loading…' : agent?.name || 'Agent'}</h1>
          {agent && <p className="muted">{agent.email} · {agent.is_active ? 'active' : 'inactive'}</p>}
        </div>
      </header>

      {notice && <div className={`alert ${notice.kind}`}>{notice.text}</div>}

      <section className="stat-row">
        <div className="stat">
          <div className="stat-label">Clients</div>
          <div className="stat-value">{agent?.clients_count ?? '—'}</div>
          <div className="stat-sub muted">KYC verified</div>
        </div>
        <div className="stat">
          <div className="stat-label">Leads</div>
          <div className="stat-value">{agent?.leads_count ?? '—'}</div>
          <div className="stat-sub muted">unverified</div>
        </div>
        <div className="stat">
          <div className="stat-label">Sub-agents</div>
          <div className="stat-value">{agent?.subagents_count ?? '—'}</div>
          <div className="stat-sub muted">referred agents</div>
        </div>
        <div className="stat">
          <div className="stat-label">CRM products</div>
          <div className="stat-value">{crmLoading ? '…' : crm?.crm_products?.length ?? 0}</div>
          <div className="stat-sub muted">from product.agents[]</div>
        </div>
        <div className="stat">
          <div className="stat-label">Parent</div>
          <div className="stat-value" style={{ fontSize: 15 }}>{agent?.parent_name || '— (top-level)'}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Linked products — CRM → portal</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="muted small">source: {crm?.crm_products?.length || 0} rows from x-dev's CRM</span>
            <Button
              size="sm"
              variant="primary"
              icon={<Activity size={12} />}
              loading={syncingMt5}
              onClick={doSyncMt5Snapshot}
              title="One-click fix for empty commission history. Calls the MT5 bridge (your own infra, not xdev CRM) to fetch deal history for every login in this agent's subtree. After it completes, commission rows appear on the next engine cycle."
            >
              Sync MT5 &amp; Populate Commissions
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Wand2 size={12} />}
              loading={healingSelf}
              onClick={doHealSelf}
              title="Bump any product at $0/lot to parent's rate (or product max for top-level). Non-zero rates preserved."
            >
              Heal rates
            </Button>
            {(agent?.subagents_count ?? 0) > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Wand2 size={12} />}
                loading={healingSubtree}
                onClick={doHealSubtree}
                title={`Heal this agent AND all ${agent.subagents_count + ' sub-agent' + (agent.subagents_count === 1 ? '' : 's')} below. Processed top-down so children inherit.`}
              >
                Heal tree
              </Button>
            )}
            {/* Sync rates for THIS agent only — 1-2 CRM calls. Lightest possible. */}
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              loading={syncingCommSelf}
              onClick={doSyncCommSelf}
              title="Pull commission rates (% + $/lot) from CRM for this agent only. 1-2 CRM calls."
            >
              Sync rates (self)
            </Button>
            {/* Sync rates for this agent + every descendant. Cheaper than
                the global bulk sync — only touches the slice that matters. */}
            {(agent?.subagents_count ?? 0) > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw size={12} />}
                loading={syncingCommSubtree}
                onClick={() => doSyncCommSubtree({ force: false })}
                title={`Pull commission rates for this agent + all ${agent.subagents_count + ' sub-agent' + (agent.subagents_count === 1 ? '' : 's')} below. Smart mode skips agents synced in last 24h.`}
              >
                Sync rates (subtree)
              </Button>
            )}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Group</th>
              <th>CRM status</th>
              <th>In portal?</th>
              <th className="num">Rate / lot</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {crmLoading && <tr><td colSpan="7" className="muted pad">Loading…</td></tr>}
            {!crmLoading && (!crm || crm.crm_products.length === 0) && (
              <tr><td colSpan="7" className="muted pad">No CRM-linked products for this agent.</td></tr>
            )}
            {(crm?.crm_products || []).map(p => {
              const hasRate = p.linked_rate != null && p.linked_rate > 0;
              return (
                <tr key={p.source_id}>
                  <td>
                    <div>{p.name}</div>
                    {p.code && <div className="muted small mono">{p.code}</div>}
                  </td>
                  <td className="muted small">{p.group || '—'}</td>
                  <td><span className={`pill ${p.status === 'active' ? 'stage-active' : 'stage-churned'}`}>{p.status}</span></td>
                  <td>{p.in_portal ? <span className="pill stage-contacted">Yes</span> : <span className="pill stage-lead">Import product first</span>}</td>
                  <td className="num mono">
                    {editingProductId === p.local_product_id ? (
                      <input
                        type="number" min="0" step="0.01" autoFocus
                        className="input" style={{ width: 100, textAlign: 'right' }}
                        value={newRate} onChange={e => setNewRate(e.target.value)}
                      />
                    ) : (
                      hasRate
                        ? <span className="strong">{Number(p.linked_rate).toFixed(2)}</span>
                        : (p.linked_rate === 0 ? <span className="pill stage-churned">needs rate</span> : '—')
                    )}
                  </td>
                  <td>{p.link_source ? <span className="pill stage-contacted">{p.link_source}</span> : '—'}</td>
                  <td className="num">
                    {!p.in_portal ? null : editingProductId === p.local_product_id ? (
                      <>
                        <button className="btn primary small" disabled={savingRate} onClick={() => saveRate(p.local_product_id)}>Save</button>{' '}
                        <button className="btn ghost small" onClick={() => { setEditingProductId(null); setNewRate(''); }}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn ghost small" onClick={() => { setEditingProductId(p.local_product_id); setNewRate(String(p.linked_rate ?? '')); }}>
                        Set rate
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ── Sub-agents under this agent (with products inline, expandable tree) ── */}
      <section className="card">
        <div className="card-header">
          <h2>Sub-agents</h2>
          <span className="muted small">
            {subAgentsLoading ? 'loading…' : `${subAgents?.items?.length || 0} direct · click ▾ to expand downline`}
          </span>
        </div>
        {(!subAgentsLoading && (!subAgents || subAgents.items.length === 0)) ? (
          <div className="muted pad">No sub-agents referred by this agent.</div>
        ) : (
          <div className="subagent-list">
            {(subAgents?.items || []).map(s => (
              <SubAgentNode key={s.id} sub={s} depth={0} />
            ))}
          </div>
        )}
      </section>

      {/* ── Commission history for this agent (promoted above trading accounts
             so admins see the money numbers immediately on load) ── */}
      <CommissionsSection agentId={id} />

      {/* ── Trading accounts across this agent's client book ── */}
      <TradingAccountsSection agentId={id} />


      {/* ── Individual clients (end customers referred by this agent) ── */}
      <section className="card">
        <div className="card-header">
          <h2>Individual clients</h2>
          <span className="muted small">
            {individualsLoading
              ? 'loading…'
              : `page ${individuals?.pagination?.page || 1} of ${
                  Math.max(1, Math.ceil((individuals?.pagination?.total || 0) / 25))
                } · ${individuals?.pagination?.total || 0} total`}
          </span>
        </div>
        <div className="filter-bar" style={{ padding: '10px 16px', margin: 0 }}>
          <input
            className="input"
            placeholder="Search name / email / phone…"
            value={clientsQ}
            onChange={e => { setClientsPage(1); setClientsQ(e.target.value); }}
            style={{ minWidth: 280 }}
          />
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Stage</th>
              <th>Country</th>
              <th className="num">MT5</th>
              <th>FTD</th>
            </tr>
          </thead>
          <tbody>
            {individualsLoading && <tr><td colSpan="7" className="muted pad">Loading…</td></tr>}
            {!individualsLoading && (!individuals || individuals.items.length === 0) && (
              <tr><td colSpan="7" className="muted pad">No individual clients.</td></tr>
            )}
            {(individuals?.items || []).map(c => (
              <tr key={c.id}>
                <td>{c.name || '—'}</td>
                <td>{c.email || '—'}</td>
                <td className="mono small">{c.phone || '—'}</td>
                <td><span className={`pill stage-${(c.pipeline_stage || '').toLowerCase()}`}>{c.pipeline_stage}</span></td>
                <td>{c.country || '—'}</td>
                <td className="num mono">{c.mt5_login_count}</td>
                <td>{c.first_deposit_at ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          <button className="btn ghost small" disabled={clientsPage <= 1} onClick={() => setClientsPage(p => p - 1)}>Prev</button>
          <span className="muted small">Page {clientsPage}</span>
          <button
            className="btn ghost small"
            disabled={!individuals || clientsPage >= Math.ceil((individuals.pagination?.total || 0) / 25)}
            onClick={() => setClientsPage(p => p + 1)}
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}
