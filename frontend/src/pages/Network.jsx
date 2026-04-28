import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, Target, UsersRound } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import EmptyState from '../components/ui/EmptyState.jsx';
import { SkeletonRow } from '../components/ui/Skeleton.jsx';

/**
 * Portal — My Network
 *
 * Combines the former "My Clients" and "Sub-Agents" pages into one tabbed
 * view. Tabs (kept in ?tab= query param for shareable links):
 *   clients   — KYC-verified retail clients the agent directly referred
 *   leads     — unverified contacts (same shape as clients, different filter)
 *   subagents — IB sub-agents directly under this agent (card grid)
 *
 * Stats row shows all three counts regardless of current tab so the agent
 * always has the big picture.
 */

const TABS = [
  { id: 'clients',   label: 'Clients',    apiType: 'client' },
  { id: 'leads',     label: 'Leads',      apiType: 'lead'   },
  { id: 'subagents', label: 'Sub-Agents', apiType: null     },
];

const STAGES_CLIENT = ['', 'Contacted', 'Funded', 'Active', 'Churned'];
const STAGES_LEAD = ['', 'Lead', 'Contacted'];

function ClientsTable({ type }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);
  const stages = type === 'lead' ? STAGES_LEAD : STAGES_CLIENT;

  const { data, loading, error } = useApi(
    '/clients',
    { query: { type, q: q || undefined, pipeline_stage: stage || undefined, page, pageSize: 25 } },
    [type, q, stage, page]
  );

  const items = data?.items || [];
  const total = data?.pagination?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <>
      <div className="filter-bar">
        <input
          className="input"
          placeholder={`Search ${type === 'lead' ? 'lead' : 'client'} name / email / phone`}
          value={q}
          onChange={e => { setPage(1); setQ(e.target.value); }}
          style={{ minWidth: 260 }}
        />
        <select
          className="input"
          value={stage}
          onChange={e => { setPage(1); setStage(e.target.value); }}
        >
          {stages.map(s => <option key={s} value={s}>{s || 'All stages'}</option>)}
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
            {loading && Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} cols={8} />)}
            {!loading && items.length === 0 && (
              <tr><td colSpan="8" style={{ padding: 0 }}>
                <EmptyState
                  icon={type === 'lead' ? <Target size={28} /> : <Users size={28} />}
                  title={type === 'lead' ? 'No leads yet' : 'No clients yet'}
                  description={type === 'lead'
                    ? "Unverified contacts show up here. When a prospect signs up but hasn't verified KYC yet, they'll land in this tab."
                    : "Direct clients appear here once they complete KYC."}
                />
              </td></tr>
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
    </>
  );
}

function SubAgentsGrid() {
  const { data, loading, error } = useApi('/sub-agents', {}, []);
  const items = data || [];

  return (
    <>
      {error && <div className="alert error">{error.message}</div>}

      <div className="grid-cards">
        {loading && <div className="muted">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <EmptyState
              icon={<UsersRound size={28} />}
              title="No sub-agents under you yet"
              description="When a client you referred is promoted to agent status, they'll show up here. Commissions from their downline will cascade up to you through the waterfall."
            />
          </div>
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
    </>
  );
}

export default function Network() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.some(t => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'clients';

  function setTab(id) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  }

  // Three parallel counts so the stat row is always accurate regardless of tab
  const { data: clientsData } = useApi('/clients', { query: { type: 'client', pageSize: 1 } }, []);
  const { data: leadsData }   = useApi('/clients', { query: { type: 'lead',   pageSize: 1 } }, []);
  const { data: subsData }    = useApi('/sub-agents', {}, []);

  const clientsCount = clientsData?.pagination?.total ?? 0;
  const leadsCount   = leadsData?.pagination?.total ?? 0;
  const subsCount    = Array.isArray(subsData) ? subsData.length : 0;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>My Network</h1>
          <p className="muted">Your direct downline — clients you referred, their stage in the pipeline, and the sub-agents who report to you.</p>
        </div>
      </header>

      <section className="stat-row">
        <div className={`stat stat-success ${tab === 'clients' ? 'stat-active' : ''}`}>
          <div className="stat-label">Clients</div>
          <div className="stat-value">{clientsCount}</div>
          <div className="stat-sub muted">KYC verified</div>
        </div>
        <div className={`stat stat-warn ${tab === 'leads' ? 'stat-active' : ''}`}>
          <div className="stat-label">Leads</div>
          <div className="stat-value">{leadsCount}</div>
          <div className="stat-sub muted">unverified</div>
        </div>
        <div className={`stat stat-accent ${tab === 'subagents' ? 'stat-active' : ''}`}>
          <div className="stat-label">Sub-agents</div>
          <div className="stat-value">{subsCount}</div>
          <div className="stat-sub muted">directly referred</div>
        </div>
      </section>

      <div className="tab-row">
        {TABS.map(t => {
          const count = t.id === 'clients' ? clientsCount
                      : t.id === 'leads'   ? leadsCount
                      : subsCount;
          return (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="tab-count mono">{count}</span>
            </button>
          );
        })}
      </div>

      {tab === 'clients'   && <ClientsTable type="client" />}
      {tab === 'leads'     && <ClientsTable type="lead" />}
      {tab === 'subagents' && <SubAgentsGrid />}
    </div>
  );
}
