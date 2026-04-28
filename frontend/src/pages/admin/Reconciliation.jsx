import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useApi, useMutation } from '../../hooks/useApi.js';
import Button from '../../components/ui/Button.jsx';
import { toast, confirm } from '../../components/ui/toast.js';

/**
 * Admin — Reconciliation
 *
 * Compares our commission engine to MT5's raw deal.commission.
 *   • Top banner: engine total vs MT5 total for the period + drift
 *   • Per-agent table: each agent's engine-computed commission share
 *     alongside their clients' MT5-charged commission
 *   • Per-login drift table: logins where engine ≠ MT5 by more than threshold
 */

function fmt(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n) {
  if (n == null) return '—';
  return `${(Number(n) * 100).toFixed(2)}%`;
}

function driftClass(pct) {
  const a = Math.abs(pct || 0);
  if (a < 0.01) return 'recon-delta-ok';
  if (a < 0.05) return 'recon-delta-warn';
  return 'recon-delta-error';
}

function todayMinusDays(days) {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

export default function Reconciliation() {
  const [from, setFrom] = useState(todayMinusDays(30));
  const [to,   setTo]   = useState('');

  const query = useMemo(() => {
    const q = {};
    if (from) q.from = new Date(from + 'T00:00:00').toISOString();
    if (to)   q.to   = new Date(to   + 'T23:59:59').toISOString();
    return q;
  }, [from, to]);

  const { data: summary, loading: summaryLoading, refetch: refetchSummary } = useApi('/api/admin/reconciliation/summary', { query }, [JSON.stringify(query)]);
  const { data: perAgent, loading: agentLoading, refetch: refetchAgent } = useApi('/api/admin/reconciliation/per-agent', { query }, [JSON.stringify(query)]);
  const { data: perLogin, loading: loginLoading, refetch: refetchLogin } = useApi('/api/admin/reconciliation/per-login', { query: { ...query, threshold: 0.01 } }, [JSON.stringify(query)]);
  const { data: diag, refetch: refetchDiag } = useApi('/api/admin/reconciliation/diagnostics', {}, []);
  const [rebuild, { loading: rebuilding }] = useMutation();

  async function onRebuild() {
    const ok = await confirm(
      'Rebuild all commission rows? This wipes the commissions table and recomputes everything from the MT5 deal cache using current rates. Takes 30–60 seconds. No bridge calls.',
      { confirmLabel: 'Rebuild now', cancelLabel: 'Cancel', variant: 'danger' }
    );
    if (!ok) return;
    try {
      await rebuild('/api/commissions/engine/rebuild', { method: 'POST' });
      toast.success('Rebuild triggered — refresh in ~60 s to see the new totals');
      // Refetch after a delay to catch the updated numbers
      setTimeout(() => { refetchSummary(); refetchAgent(); refetchLogin(); }, 60_000);
    } catch (err) {
      toast.error(err.message || 'Rebuild failed');
    }
  }

  const items = perAgent?.items || [];
  const drifts = perLogin?.items || [];
  const engineTotal = summary?.engine_commission_total || 0;
  const mt5Total    = summary?.mt5_commission_total || 0;
  const drift       = summary?.drift || 0;
  const driftPct    = summary?.drift_pct;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Reconciliation</h1>
          <p className="muted">
            Compare our commission engine's output to MT5's raw per-deal charge.
            Engine total should equal MT5 total for the period (waterfall just redistributes across agents).
          </p>
        </div>
        <Button
          variant="primary"
          icon={<RefreshCw size={14} />}
          loading={rebuilding}
          onClick={onRebuild}
          title="Wipe commissions table and recompute every row from the MT5 deal cache using current rates"
        >
          Rebuild commissions
        </Button>
      </header>

      <div className="filter-bar">
        <label className="field inline">
          <span className="muted small">From</span>
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label className="field inline">
          <span className="muted small">To</span>
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <button className="btn ghost small" onClick={() => { setFrom(''); setTo(''); }}>All time</button>
      </div>

      {/* Pipeline diagnostics — one-glance answer to "why is the commissions
          table empty for branch X?" Chain-of-failure check across the whole
          pipeline (rates → mt5_logins → meta → cached deals → commission rows). */}
      {diag && (
        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card-header">
            <h2>Pipeline diagnostics</h2>
            <span className="muted small">
              Suspected bottleneck:
              {' '}
              <span className={`pill ${diag.suspected_bottleneck === 'healthy' ? 'stage-active' : 'stage-contacted'}`}>
                {diag.suspected_bottleneck.replaceAll('_', ' ')}
              </span>
            </span>
          </div>
          <div className="pad">
            <p style={{ marginTop: 0 }}>{diag.explanation}</p>
            <div className="stat-row" style={{ marginTop: 'var(--space-3)' }}>
              <div className="stat">
                <div className="stat-label">Agents with rates</div>
                <div className="stat-value">{diag.totals?.agents_with_rates}</div>
                <div className="stat-sub muted">of {diag.totals?.imported_agents} imported</div>
              </div>
              <div className="stat">
                <div className="stat-label">Clients w/ MT5 logins</div>
                <div className="stat-value">{diag.totals?.clients_with_mt5_logins?.toLocaleString()}</div>
                <div className="stat-sub muted">from CRM</div>
              </div>
              <div className="stat">
                <div className="stat-label">Clients w/ meta</div>
                <div className="stat-value">{diag.totals?.clients_with_meta?.toLocaleString()}</div>
                <div className="stat-sub muted">needed for MT5 sync</div>
              </div>
              <div className="stat">
                <div className="stat-label">Logins w/ deals cached</div>
                <div className="stat-value">{diag.totals?.logins_with_cached_deals?.toLocaleString()}</div>
                <div className="stat-sub muted">from MT5 bridge</div>
              </div>
              <div className="stat">
                <div className="stat-label">Agents earning</div>
                <div className="stat-value">{diag.totals?.agents_with_commissions}</div>
                <div className="stat-sub muted">in commissions table</div>
              </div>
            </div>

            <details style={{ marginTop: 'var(--space-3)' }}>
              <summary className="muted small" style={{ cursor: 'pointer' }}>Per-branch breakdown</summary>
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th className="num">Agents</th>
                    <th className="num">With rates</th>
                    <th className="num">Clients w/ logins</th>
                    <th className="num">Clients w/ meta</th>
                    <th className="num">Earning</th>
                  </tr>
                </thead>
                <tbody>
                  {(diag.per_branch || []).map(b => (
                    <tr key={b.branch}>
                      <td>{b.branch}</td>
                      <td className="num mono">{b.imported_agents}</td>
                      <td className="num mono">{b.agents_with_rates}</td>
                      <td className="num mono">{b.clients_with_logins}</td>
                      <td className="num mono">{b.clients_with_meta}</td>
                      <td className="num mono strong">{b.agents_earning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </section>
      )}

      {/* Top-line summary */}
      <section className="stat-row">
        <div className="stat">
          <div className="stat-label">Engine commission</div>
          <div className="stat-value">{fmt(engineTotal)}</div>
          <div className="stat-sub muted">{summary?.engine_deal_count || 0} deals</div>
        </div>
        <div className="stat">
          <div className="stat-label">MT5 commission</div>
          <div className="stat-value">{fmt(mt5Total)}</div>
          <div className="stat-sub muted">{summary?.mt5_deal_count || 0} deals</div>
        </div>
        <div className={`stat ${Math.abs(driftPct || 0) < 0.01 ? 'stat-success' : 'stat-warn'}`}>
          <div className="stat-label">Drift</div>
          <div className="stat-value">{fmt(drift)}</div>
          <div className={`stat-sub ${driftClass(driftPct)}`}>
            {fmtPct(driftPct)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Logins with drift &gt; $0.01</div>
          <div className="stat-value">{drifts.length}</div>
          <div className="stat-sub muted">of {summary?.mt5_deal_count || 0} deals</div>
        </div>
      </section>

      {summaryLoading && <div className="muted pad">Loading…</div>}

      {/* Per-agent rollup */}
      <section className="card">
        <div className="card-header">
          <h2>Per agent</h2>
          <span className="muted small">Engine commission is the slice of MT5 commission that this agent earned</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Engine deals</th>
              <th className="num">Engine commission</th>
              <th className="num">Engine rebate</th>
              <th className="num">Engine total</th>
              <th className="num">MT5 commission</th>
              <th className="num">Share %</th>
            </tr>
          </thead>
          <tbody>
            {agentLoading && <tr><td colSpan="7" className="muted pad">Loading…</td></tr>}
            {!agentLoading && items.length === 0 && (
              <tr><td colSpan="7" className="muted pad">No engine output in this range.</td></tr>
            )}
            {items.map(r => (
              <tr key={r.agent_id}>
                <td>
                  <Link to={`/admin/agents/${r.agent_id}`}>{r.agent_name}</Link>
                  <div className="muted small">{r.email}</div>
                </td>
                <td className="num mono">{r.engine_deals}</td>
                <td className="num mono">{fmt(r.engine_commission)}</td>
                <td className="num mono">{fmt(r.engine_rebate)}</td>
                <td className="num mono strong">{fmt(r.engine_total)}</td>
                <td className="num mono">{fmt(r.mt5_commission)}</td>
                <td className={`num recon-pct`}>{r.share_pct != null ? fmtPct(r.share_pct) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Per-login drift (the strongest signal) */}
      <section className="card">
        <div className="card-header">
          <h2>Login-level drift</h2>
          <span className="muted small">
            Logins where <b>Σ engine commission ≠ Σ MT5 commission</b> (by more than $0.01). In a healthy engine this list is empty.
          </span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th className="num">Login</th>
              <th>Client</th>
              <th className="num">Engine deals</th>
              <th className="num">MT5 deals</th>
              <th className="num">Engine commission</th>
              <th className="num">MT5 commission</th>
              <th className="num">Drift</th>
              <th className="num">Drift %</th>
            </tr>
          </thead>
          <tbody>
            {loginLoading && <tr><td colSpan="8" className="muted pad">Loading…</td></tr>}
            {!loginLoading && drifts.length === 0 && (
              <tr><td colSpan="8" className="muted pad recon-delta-ok">No drift — engine output matches MT5 exactly.</td></tr>
            )}
            {drifts.map(r => (
              <tr key={r.login}>
                <td className="num mono">{r.login}</td>
                <td>{r.client_name || '—'}</td>
                <td className="num mono">{r.engine_deals}</td>
                <td className="num mono">{r.mt5_deals}</td>
                <td className="num mono">{fmt(r.engine_commission)}</td>
                <td className="num mono">{fmt(r.mt5_commission)}</td>
                <td className={`num mono ${driftClass(r.drift_pct)}`}>{fmt(r.drift)}</td>
                <td className={`num recon-pct ${driftClass(r.drift_pct)}`}>{fmtPct(r.drift_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
