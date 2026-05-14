import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Search, RefreshCw, User, X, DollarSign, BookText, ExternalLink,
  Database, CheckCircle2, AlertTriangle, Clock, RotateCcw, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { toast } from '../../components/ui/toast.js';
import CommissionsSection from '../../components/CommissionsSection.jsx';
import JobProgressModal from '../../components/JobProgressModal.jsx';
import {
  fmt, NumCells, SubAgentRow, ClientRow, AccountRow,
} from '../Summary.jsx';

/**
 * MT5 freshness card — shows at a glance whether the selected agent's deal
 * data is actually in the local cache (= fetched from the MT5 bridge), how
 * deep the history goes, and when the last bridge call happened. Answers
 * the admin's #1 question when earnings look off: "have we pulled anything
 * for this agent yet?"
 *
 * Data: GET /api/admin/agent-summary/:userId/mt5-freshness
 */
function relTimeFull(iso) {
  if (!iso) return null;
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function Mt5FreshnessCard({ userId }) {
  const { data, loading, error, refetch } = useApi(
    userId ? `/api/admin/agent-summary/${userId}/mt5-freshness` : null,
    {},
    [userId]
  );
  const [syncMissing, { loading: syncingMissing }] = useMutation();

  // Per-agent "from date" for the targeted fetch. Defaults to the global
  // floor so the admin just clicks and gets everything allowed by policy.
  // Bounded below by the global floor (the backend re-enforces this — the
  // UI just constrains the picker so there's nothing to submit that would
  // silently get clamped).
  const floorDate = data?.earliest_deal_date || null;
  const [fromDateDraft, setFromDateDraft] = useState('');
  useEffect(() => {
    // Reset draft when the floor or selected agent changes
    setFromDateDraft(floorDate || '');
  }, [floorDate, userId]);

  async function handleSyncMissing() {
    if (!userId) return;

    // Belt-and-braces floor check. The date input has a `min` attribute so
    // normal clicking can't pick earlier, but some browsers let users type
    // a pre-floor date into the field. Stop it here before hitting the
    // network. (The backend also clamps to the floor, so this is defense
    // in depth — not the only line of protection.)
    if (floorDate && fromDateDraft && fromDateDraft < floorDate) {
      toast.error(`Earliest allowed date is ${floorDate} (set by admin policy). Pick that date or later.`);
      return;
    }

    const qs = new URLSearchParams({ onlyMissing: 'true' });
    if (fromDateDraft) qs.set('fromDate', fromDateDraft);
    const promise = syncMissing(
      `/api/admin/agent-summary/${userId}/sync-mt5?${qs.toString()}`,
      { method: 'POST' }
    ).then(async r => { await refetch(); return r; });
    toast.promise(promise, {
      loading: fromDateDraft
        ? `First-time sync from ${fromDateDraft} for never-contacted logins…`
        : 'First-time sync for never-contacted logins…',
      success: (r) => {
        if (r.logins_synced === 0 && r.logins_skipped_already_fetched > 0) {
          return `All ${r.logins_skipped_already_fetched} logins have already been contacted — none were skipped logins`;
        }
        if (r.logins_synced === 0 && r.logins_failed === 0) {
          return 'No unsynced logins found — all accounts have been contacted at least once';
        }
        const base = `Contacted ${r.logins_synced || 0} login${r.logins_synced === 1 ? '' : 's'} for the first time`
          + (r.logins_failed ? ` (${r.logins_failed} failed — bridge may be down)` : '');
        return r.engine_triggered
          ? `${base} · commissions populating in the background (≈ 1 min)`
          : base;
      },
      error: (err) => err.message || 'Sync failed',
    });
  }

  if (!userId) return null;
  if (loading && !data) {
    return (
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="pad muted small">
          <Database size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Checking MT5 data freshness…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="pad" style={{ color: 'var(--danger)' }}>
          Could not load MT5 freshness: {error.message}
        </div>
      </div>
    );
  }
  if (!data) return null;

  // Compute overall state of the subtree's MT5 data
  const subtreeLogins         = data.subtree_logins         || 0;
  const loginsEverSynced      = data.logins_ever_synced      || 0;
  const loginsNeverSynced     = data.logins_never_synced     || 0;
  const loginsWithDeals       = data.logins_with_cached_deals || 0;
  const cachedDealCount       = data.cached_deal_count       || 0;
  const staleLogins           = data.stale_logins            || [];

  // Health classification — three distinct cases:
  //   1. Unfetched logins exist (bridge hasn't been called) → really partial
  //   2. All fetched, some have deals, others are dormant → that's normal,
  //      a "dormant" account is a real MT5 account whose owner never traded
  //      (no deposit, no orders). Bridge correctly returns 0 deals — not a bug.
  //   3. All fetched, all have deals → green
  //   4. All fetched, none have deals → unusual but legit (entirely dormant subtree)
  const dormantCount = subtreeLogins - loginsWithDeals - loginsNeverSynced;
  let state, stateLabel, stateColor;
  if (subtreeLogins === 0) {
    state = 'empty';
    stateLabel = 'No MT5 logins in subtree';
    stateColor = 'var(--text-muted)';
  } else if (loginsNeverSynced > 0) {
    // Real "partial": there are logins we haven't asked the bridge about yet
    state = 'partial';
    stateLabel = `${loginsNeverSynced} login${loginsNeverSynced === 1 ? '' : 's'} not yet fetched — click Refresh MT5`;
    stateColor = 'var(--warn)';
  } else if (loginsWithDeals === 0) {
    // Fully synced but nobody traded — unusual
    state = 'all-dormant';
    stateLabel = `All ${subtreeLogins} logins fetched · none have traded yet`;
    stateColor = 'var(--text-muted)';
  } else if (dormantCount > 0) {
    // Healthy partial — fetched everyone, some haven't traded yet
    state = 'good';
    stateLabel = `All ${subtreeLogins} logins fetched · ${dormantCount} client${dormantCount === 1 ? '' : 's'} with no deals cached`;
    stateColor = 'var(--success)';
  } else {
    state = 'good';
    stateLabel = `All ${subtreeLogins} logins fetched and trading`;
    stateColor = 'var(--success)';
  }

  const StateIcon = state === 'good'         ? CheckCircle2
                  : state === 'not-fetched' ? AlertTriangle
                  : state === 'partial'     ? AlertTriangle
                  : Database;

  // "Never synced" = logins the bridge has never been called for at all
  // (mt5_synced_at IS NULL). This is the right metric for the targeted
  // first-time fetch button. Using (subtreeLogins - loginsWithDeals) was
  // wrong: accounts that ARE synced but have no trading activity yet would
  // always keep the count at the same value because `logins_with_cached_deals`
  // never increases for empty accounts — the button would appear to do nothing
  // even after a successful sync.
  const missingCount = loginsNeverSynced;

  return (
    <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
      <div className="card-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <Database size={15} style={{ color: 'var(--accent)' }} />
          MT5 data freshness
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            marginLeft: 10,
            padding: '2px 10px',
            borderRadius: 999,
            background: 'var(--bg-tertiary)',
            color: stateColor,
            fontSize: 11,
            fontWeight: 600,
          }}>
            <StateIcon size={11} />
            {stateLabel}
          </span>
        </h2>
        {/* Targeted "only missing" fetch — only shown when there's a gap
            to fill, so the button is never visually dead weight. Ignores
            the 15-min freshness threshold used by the top-bar "Refresh
            MT5" button — this one just bridges the gap.
            The inline date picker lets the admin choose the `from` date
            for this targeted fetch, bounded below by the global floor
            (enforced on the backend regardless of what the UI sends). */}
        {missingCount > 0 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
              <span className="muted">From</span>
              <input
                type="date"
                className="input"
                value={fromDateDraft}
                min={floorDate || undefined}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setFromDateDraft(e.target.value)}
                disabled={syncingMissing}
                style={{ padding: '4px 8px', fontSize: 12, width: 140 }}
                title={floorDate
                  ? `Admin policy: earliest allowed date is ${floorDate}. Dates before this are blocked.`
                  : 'No global floor set — any date allowed.'}
              />
            </label>
            <button
              type="button"
              className="btn small"
              onClick={handleSyncMissing}
              disabled={syncingMissing}
              title={`First-time bridge fetch from ${fromDateDraft || (floorDate || 'default lookback')} onward, for the ${missingCount} login${missingCount === 1 ? '' : 's'} that have never been contacted. Accounts already fetched (even if empty) are skipped.`}
            >
              <RefreshCw size={12} /> {syncingMissing ? 'Fetching…' : `First-time sync (${missingCount})`}
            </button>
          </div>
        )}
      </div>
      <div className="pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <div>
          <div className="muted small">Logins in subtree</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
            {subtreeLogins.toLocaleString()}
          </div>
          {loginsNeverSynced > 0 && (
            <div className="muted small" style={{ color: 'var(--warn)' }}>
              {loginsNeverSynced} never synced
            </div>
          )}
        </div>
        <div>
          <div className="muted small">Logins with cached deals</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
            {loginsWithDeals.toLocaleString()}
          </div>
          <div className="muted small">{cachedDealCount.toLocaleString()} deals total</div>
        </div>
        <div>
          <div className="muted small"><Clock size={10} style={{ verticalAlign: 0, marginRight: 2 }} />Latest deal</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {relTimeFull(data.latest_deal_time) || '—'}
          </div>
          <div className="muted small mono" title={fmtDate(data.latest_deal_time)}>
            {fmtDate(data.latest_deal_time)}
          </div>
        </div>
        <div>
          <div className="muted small"><RefreshCw size={10} style={{ verticalAlign: 0, marginRight: 2 }} />Last bridge sync</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {relTimeFull(data.latest_sync_at) || 'never'}
          </div>
          <div className="muted small mono" title={fmtDate(data.latest_sync_at)}>
            {fmtDate(data.latest_sync_at)}
          </div>
        </div>
        <div>
          <div className="muted small">Oldest cached deal</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {data.oldest_deal_time ? new Date(data.oldest_deal_time).toISOString().slice(0, 10) : '—'}
          </div>
          <div className="muted small">historical depth</div>
        </div>
      </div>

      {/* Staleness detail — only useful when something's wrong */}
      {staleLogins.length > 0 && state !== 'good' && (
        <div className="pad" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Logins most overdue for a sync (click "Refresh MT5" above to trigger):
          </div>
          <table className="table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Login</th>
                <th>Client</th>
                <th className="num">Deals cached</th>
                <th>Last synced</th>
                <th>Latest deal</th>
              </tr>
            </thead>
            <tbody>
              {staleLogins.map(r => (
                <tr key={r.login}>
                  <td className="mono">{r.login}</td>
                  <td>{r.client_name || '—'}</td>
                  <td className="num mono">{r.deal_count || 0}</td>
                  <td>{r.mt5_synced_at ? relTimeFull(r.mt5_synced_at) : <span style={{ color: 'var(--warn)' }}>never</span>}</td>
                  <td>{r.latest_deal_time ? relTimeFull(r.latest_deal_time) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * RecomputePanel — lets an admin re-run the commission waterfall math for
 * one agent over a date range. Two-step flow:
 *
 *   1. Pick fromDate / toDate → POST …/recompute-commissions (dry-run)
 *      Shows a preview: N rows, total old vs. new amounts, rate_source breakdown.
 *
 *   2. Confirm → POST …/recompute-commissions?confirm=true
 *      Deletes stale rows + re-inserts at current rates. Wrapped in a DB
 *      transaction so the window is never half-gone.
 *
 * Guards (also enforced server-side):
 *   - Both dates required
 *   - Max window 366 days
 *   - toDate clamped to yesterday (can't race the live engine)
 */
function RecomputePanel({ agentId, agentName }) {
  const today = new Date().toISOString().slice(0, 10);
  // Default: previous calendar month
  const defaultFrom = (() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const defaultTo = (() => {
    const d = new Date();
    d.setDate(0); // last day of previous month
    return d.toISOString().slice(0, 10);
  })();

  const [open, setOpen]       = useState(false);
  const [fromDate, setFrom]   = useState(defaultFrom);
  const [toDate, setTo]       = useState(defaultTo);
  const [step, setStep]       = useState('idle');  // 'idle' | 'previewing' | 'preview' | 'confirming' | 'done' | 'error'
  const [preview, setPreview] = useState(null);
  const [result, setResult]   = useState(null);
  const [errMsg, setErrMsg]   = useState('');
  const [, mutate]            = useMutation();

  function reset() {
    setStep('idle'); setPreview(null); setResult(null); setErrMsg('');
  }
  useEffect(() => { reset(); }, [agentId]);

  async function handlePreview() {
    setStep('previewing'); setErrMsg('');
    try {
      const qs = new URLSearchParams({ fromDate, toDate });
      const data = await mutate(
        `/api/admin/agent-summary/${agentId}/recompute-commissions?${qs}`,
        { method: 'POST' }
      );
      setPreview(data);
      setStep('preview');
    } catch (err) {
      setErrMsg(err.message || 'Preview failed');
      setStep('error');
    }
  }

  async function handleConfirm() {
    setStep('confirming'); setErrMsg('');
    try {
      const qs = new URLSearchParams({ fromDate, toDate, confirm: 'true' });
      const data = await mutate(
        `/api/admin/agent-summary/${agentId}/recompute-commissions?${qs}`,
        { method: 'POST' }
      );
      setResult(data);
      setStep('done');
    } catch (err) {
      setErrMsg(err.message || 'Recompute failed');
      setStep('error');
    }
  }

  if (!agentId) return null;

  // Summarise the preview for the confirm screen
  const previewStats = useMemo(() => {
    if (!preview?.preview) return null;
    const rows = preview.preview;
    const oldTotal = rows.reduce((s, r) => s + (r.old_amount ?? 0), 0);
    const newTotal = rows.reduce((s, r) => s + (r.new_amount ?? 0), 0);
    const changed  = rows.filter(r => r.old_amount !== null && Math.abs(r.delta) > 0.0001);
    const gained   = rows.filter(r => (r.delta ?? 0) > 0.0001);
    const lost     = rows.filter(r => (r.delta ?? 0) < -0.0001);
    const bySource = {};
    rows.forEach(r => { bySource[r.new_rate_source] = (bySource[r.new_rate_source] || 0) + 1; });
    return { rows, oldTotal, newTotal, delta: newTotal - oldTotal, changed, gained, lost, bySource };
  }, [preview]);

  return (
    <div className="card" style={{ marginBottom: 'var(--space-4)', border: '1px solid var(--border)' }}>
      <div className="card-header" style={{ cursor: 'pointer' }} onClick={() => { setOpen(v => !v); if (!open) reset(); }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, fontSize: 14 }}>
          <RotateCcw size={14} style={{ color: 'var(--accent)' }} />
          Recompute commission history
          <span className="muted small" style={{ fontWeight: 400, marginLeft: 4 }}>
            — apply updated rates to historical deals
          </span>
        </h2>
        {open ? <ChevronUp size={14} className="muted" /> : <ChevronDown size={14} className="muted" />}
      </div>

      {open && (
        <div className="pad">
          {/* Step 1 — date range picker */}
          {(step === 'idle' || step === 'error') && (
            <>
              <p className="muted small" style={{ marginBottom: 12 }}>
                Deletes and re-inserts commission rows for <strong>{agentName}</strong> in the
                selected window using the <em>current</em> rates from the CRM or manual overrides.
                Run a <strong>dry-run preview</strong> first — it shows what would change before
                writing anything.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="field" style={{ margin: 0 }}>
                  <span className="muted small">From</span>
                  <input type="date" className="input" value={fromDate} max={today}
                    onChange={e => setFrom(e.target.value)} style={{ width: 150 }} />
                </label>
                <label className="field" style={{ margin: 0 }}>
                  <span className="muted small">To</span>
                  <input type="date" className="input" value={toDate} max={today}
                    onChange={e => setTo(e.target.value)} style={{ width: 150 }} />
                </label>
                <button className="btn" onClick={handlePreview}
                  disabled={!fromDate || !toDate || step === 'previewing'}>
                  <RotateCcw size={12} /> {step === 'previewing' ? 'Previewing…' : 'Preview changes'}
                </button>
              </div>
              {step === 'error' && (
                <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 13 }}>
                  {errMsg}
                </div>
              )}
            </>
          )}

          {/* Step 2 — dry-run preview */}
          {step === 'preview' && preview && previewStats && (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div>
                    <div className="muted small">Rows affected</div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>
                      {previewStats.rows.length}
                    </div>
                  </div>
                  <div>
                    <div className="muted small">Old total</div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>
                      ${previewStats.oldTotal.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="muted small">New total</div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--success)' }}>
                      ${previewStats.newTotal.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="muted small">Net change</div>
                    <div className="mono" style={{
                      fontSize: 20, fontWeight: 700,
                      color: previewStats.delta >= 0 ? 'var(--success)' : 'var(--danger)',
                    }}>
                      {previewStats.delta >= 0 ? '+' : ''}{previewStats.delta.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="muted small">Rate sources</div>
                    <div style={{ fontSize: 13, marginTop: 2 }}>
                      {Object.entries(previewStats.bySource).map(([src, cnt]) => (
                        <span key={src} style={{ marginRight: 8 }}>
                          <span className="pill" style={{ fontSize: 10 }}>{src}</span> {cnt}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {previewStats.rows.length > 0 && (
                  <details style={{ marginBottom: 10 }}>
                    <summary className="muted small" style={{ cursor: 'pointer' }}>
                      Show row-level preview ({previewStats.rows.length} rows)
                    </summary>
                    <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
                      <table className="table" style={{ fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th>Deal ID</th>
                            <th>Login</th>
                            <th className="num">Old $</th>
                            <th className="num">New $</th>
                            <th className="num">Δ</th>
                            <th>Rate source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewStats.rows.slice(0, 200).map((r, i) => (
                            <tr key={i} style={{ color: r.delta > 0 ? 'var(--success)' : r.delta < 0 ? 'var(--danger)' : undefined }}>
                              <td className="mono">{r.deal_id}</td>
                              <td className="mono">{r.mt5_login}</td>
                              <td className="num mono">{r.old_amount != null ? `$${Number(r.old_amount).toFixed(2)}` : '—'}</td>
                              <td className="num mono">${Number(r.new_amount).toFixed(2)}</td>
                              <td className="num mono">{r.delta != null ? (r.delta >= 0 ? `+${r.delta.toFixed(2)}` : r.delta.toFixed(2)) : '—'}</td>
                              <td><span className="pill" style={{ fontSize: 10 }}>{r.new_rate_source || '—'}</span></td>
                            </tr>
                          ))}
                          {previewStats.rows.length > 200 && (
                            <tr><td colSpan={6} className="muted small">… {previewStats.rows.length - 200} more rows not shown</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

                {previewStats.rows.length === 0 && (
                  <div className="muted small" style={{ marginBottom: 8 }}>
                    No commission rows found for this agent in the selected window.
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost small" onClick={reset}>← Change dates</button>
                {previewStats.rows.length > 0 && (
                  <button className="btn small" style={{ background: 'var(--danger)', color: '#fff' }}
                    onClick={handleConfirm}>
                    <RotateCcw size={12} /> Confirm recompute ({previewStats.rows.length} rows)
                  </button>
                )}
              </div>
            </>
          )}

          {/* Step 3 — confirming spinner */}
          {step === 'confirming' && (
            <div className="muted small">Recomputing… deleting old rows and inserting new ones in a transaction.</div>
          )}

          {/* Step 4 — done */}
          {step === 'done' && result && (
            <>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
                <div>
                  <div className="muted small">Rows deleted</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--danger)' }}>
                    {result.rows_deleted}
                  </div>
                </div>
                <div>
                  <div className="muted small">Rows inserted</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--success)' }}>
                    {result.rows_inserted}
                  </div>
                </div>
                {result.errors > 0 && (
                  <div>
                    <div className="muted small">Errors</div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--danger)' }}>
                      {result.errors}
                    </div>
                  </div>
                )}
              </div>
              <div className="muted small" style={{ marginBottom: 8 }}>{result.message}</div>
              <button className="btn ghost small" onClick={reset}>Recompute another range</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Admin — Agent Summary (merged)
 *
 * Single page with a shared agent picker and two tabs:
 *   Summary     — same roll-up the agent sees in their own portal
 *                 (sub-agents, their clients, own-accounts, MT5 totals)
 *   Commissions — full commission ledger: stat tiles, source donut,
 *                 product breakdown, per-deal rows
 *
 * Replaces the previous two pages (Agent Summary + Commission History).
 * The agent picker is shared so admins don't have to re-pick when jumping
 * between the two views. `?agent=<id>&tab=summary|commissions` keeps the
 * URL bookmarkable and allows old /admin/commission-history?agent=X links
 * to redirect here with tab=commissions.
 *
 * Data path for Summary tab:
 *   GET /api/admin/agent-summary/agents       — picker feed
 *   GET /api/admin/agent-summary/:userId       — same shape as /api/portal/summary
 *   POST /api/admin/agent-summary/:userId/sync-mt5 — refresh MT5 snapshots
 *
 * Data path for Commissions tab:
 *   Rendered via <CommissionsSection agentId={...}/> — same component
 *   AgentDetail uses, so numbers stay in sync when either changes.
 */

function relativeTime(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const TABS = [
  { id: 'summary',     label: 'Summary',     icon: BookText  },
  { id: 'commissions', label: 'Commissions', icon: DollarSign },
];

export default function AgentSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentId = searchParams.get('agent') || '';
  const tab = TABS.some(t => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'summary';
  const [pickerOpen, setPickerOpen] = useState(!selectedAgentId);
  const [pickerQuery, setPickerQuery] = useState('');

  // Picker filters — none of these are URL-bookmarked because the picker is
  // ephemeral UI (once you've picked an agent, the filters don't matter).
  // Defaults: no branch filter, all hierarchy levels, all activity buckets,
  // active-only (hides disabled accounts by default).
  const [branchFilter, setBranchFilter]     = useState('');
  const [levelFilter, setLevelFilter]       = useState('all');     // all | top | sub
  const [activityFilter, setActivityFilter] = useState('all');     // all | has_clients | has_subs | empty
  const [statusFilter, setStatusFilter]     = useState('active');  // active | inactive | all

  // Full /api/... path because useApi prefixes '/api/portal/' for short paths
  // (meant for the agent portal). Admin endpoints live at /api/admin/* so we
  // pass the absolute URL.
  const { data: agents, loading: agentsLoading } = useApi('/api/admin/agent-summary/agents', {}, []);

  // Distinct branch list for the dropdown — derived from the agents feed so
  // we don't need a separate endpoint. Each option shows the agent count in
  // that branch for quick scanning.
  const branchOptions = useMemo(() => {
    if (!agents) return [];
    const counts = new Map();
    for (const a of agents) {
      const b = a.branch || '(no branch)';
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([branch, count]) => ({ branch, count }));
  }, [agents]);

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const q = pickerQuery.trim().toLowerCase();
    return agents.filter(a => {
      // Text search across name/email/branch
      if (q) {
        const hit =
          (a.name || '').toLowerCase().includes(q) ||
          (a.email || '').toLowerCase().includes(q) ||
          (a.branch || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      // Exact-match branch dropdown ('' = all; '(no branch)' = NULL branch)
      if (branchFilter) {
        const ab = a.branch || '(no branch)';
        if (ab !== branchFilter) return false;
      }
      // Hierarchy level
      if (levelFilter === 'top' && !a.is_top_level) return false;
      if (levelFilter === 'sub' &&  a.is_top_level) return false;
      // Activity bucket
      const clients = a.direct_clients_count || 0;
      const subs    = a.direct_sub_count     || 0;
      if (activityFilter === 'has_clients' && clients === 0) return false;
      if (activityFilter === 'has_subs'    && subs    === 0) return false;
      if (activityFilter === 'empty'       && (clients > 0 || subs > 0)) return false;
      // Active / inactive
      if (statusFilter === 'active'   && a.is_active === false) return false;
      if (statusFilter === 'inactive' && a.is_active !== false) return false;
      return true;
    });
  }, [agents, pickerQuery, branchFilter, levelFilter, activityFilter, statusFilter]);

  const hasActiveFilter =
    !!pickerQuery || !!branchFilter ||
    levelFilter !== 'all' || activityFilter !== 'all' || statusFilter !== 'active';

  function clearAllFilters() {
    setPickerQuery('');
    setBranchFilter('');
    setLevelFilter('all');
    setActivityFilter('all');
    setStatusFilter('active');
  }

  function pickAgent(id) {
    const next = new URLSearchParams(searchParams);
    next.set('agent', id);
    if (!next.get('tab')) next.set('tab', 'summary');
    setSearchParams(next, { replace: false });
    setPickerOpen(false);
    setPickerQuery('');
  }
  function clearAgent() {
    setSearchParams({}, { replace: false });
    setPickerOpen(true);
  }
  function setTab(next) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  }

  const selectedAgent = useMemo(
    () => (agents || []).find(a => a.id === selectedAgentId),
    [agents, selectedAgentId]
  );

  // Summary tab date range — defaults to "all time" (empty). The backend
  // accepts ?from=&to= and date-scopes the deal aggregates (lots, deposits,
  // withdrawals, commission). Balance/equity stay point-in-time regardless.
  // URL params keep the range bookmarkable.
  const fromYmd = searchParams.get('from') || '';
  const toYmd   = searchParams.get('to')   || '';
  function setDateRange(from, to) {
    const next = new URLSearchParams(searchParams);
    if (from) next.set('from', from); else next.delete('from');
    if (to)   next.set('to',   to);   else next.delete('to');
    setSearchParams(next, { replace: true });
  }
  function clearDateRange() { setDateRange('', ''); }

  // Quick-pick preset ranges. All boundaries are inclusive YYYY-MM-DD strings
  // in the user's local timezone — same shape the existing date inputs use.
  const datePresets = useMemo(() => {
    const ymd = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = ymd(today);

    // Week starts Monday (ISO). Adjust if your business prefers Sunday.
    const dow = today.getDay();              // 0=Sun, 1=Mon, ..., 6=Sat
    const daysFromMon = (dow + 6) % 7;       // Mon=0, Sun=6
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - daysFromMon);
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);
    lastWeekEnd.setDate(weekStart.getDate() - 1);

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

    const yearStart = new Date(today.getFullYear(), 0, 1);

    const last7 = new Date(today); last7.setDate(today.getDate() - 6);
    const last30 = new Date(today); last30.setDate(today.getDate() - 29);
    const last90 = new Date(today); last90.setDate(today.getDate() - 89);

    return [
      { key: 'today',     label: 'Today',         from: todayStr,           to: todayStr },
      { key: 'last7',     label: 'Last 7 days',   from: ymd(last7),         to: todayStr },
      { key: 'this_week', label: 'This week',     from: ymd(weekStart),     to: todayStr },
      { key: 'last_week', label: 'Last week',     from: ymd(lastWeekStart), to: ymd(lastWeekEnd) },
      { key: 'last30',    label: 'Last 30 days',  from: ymd(last30),        to: todayStr },
      { key: 'this_month',label: 'This month',    from: ymd(monthStart),    to: todayStr },
      { key: 'last_month',label: 'Last month',    from: ymd(lastMonthStart),to: ymd(lastMonthEnd) },
      { key: 'last90',    label: 'Last 90 days',  from: ymd(last90),        to: todayStr },
      { key: 'ytd',       label: 'Year to date',  from: ymd(yearStart),     to: todayStr },
    ];
  }, []);
  // Detect which preset (if any) matches the current range so we can highlight it.
  const activePreset = useMemo(() => {
    if (!fromYmd && !toYmd) return null;
    return datePresets.find(p => p.from === fromYmd && p.to === toYmd)?.key || null;
  }, [fromYmd, toYmd, datePresets]);

  // Summary tab payload — only fetch when the Summary tab is active and an
  // agent is selected. Tab switching between Summary and Commissions won't
  // re-fetch Summary data needlessly; React Query-style caching could
  // improve this further (noted for a future cleanup).
  const summaryUrl = selectedAgentId && tab === 'summary'
    ? (() => {
        const base = `/api/admin/agent-summary/${selectedAgentId}`;
        const qs = new URLSearchParams();
        if (fromYmd) qs.set('from', fromYmd);
        if (toYmd)   qs.set('to',   toYmd);
        return qs.toString() ? `${base}?${qs.toString()}` : base;
      })()
    : null;
  const {
    data: summary, loading: summaryLoading, error: summaryError, refetch,
  } = useApi(summaryUrl, {}, [selectedAgentId, tab, fromYmd, toYmd]);

  const [syncMt5, { loading: syncing }] = useMutation();
  // Live progress modal — opens during Refresh MT5
  const [progressJobId, setProgressJobId] = useState(null);
  const [progressTitle, setProgressTitle] = useState('Working…');

  async function handleSync() {
    if (!selectedAgentId) return;
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle('Refreshing MT5 snapshots');
    // Full /api/... path — api.js only treats paths starting with /api as
    // absolute; anything else gets prefixed with /api/portal, which would
    // 404 here silently.
    const promise = syncMt5(`/api/admin/agent-summary/${selectedAgentId}/sync-mt5`, { method: 'POST', headers: { 'X-Job-Id': jobId } })
      .then(async r => { await refetch(); return r; });
    toast.promise(promise, {
      loading: 'Refreshing MT5 snapshot…',
      success: (r) => {
        const base = `Synced ${r.logins_synced || 0} logins${r.logins_failed ? ` (${r.logins_failed} failed)` : ''}`;
        // The backend chains a commission engine cycle in the background
        // when at least one login was synced — surface that so the admin
        // knows commissions are populating without them having to also
        // click "Run cycle now" on System Health.
        return r.engine_triggered
          ? `${base} · commissions populating in the background (≈ 1 min)`
          : base;
      },
      error: (err) => err.message || 'Sync failed',
    });
  }

  // Expansion state per agent load (Summary tab only)
  const [expandedSubs, setExpandedSubs] = useState({});
  const [expandedClients, setExpandedClients] = useState({});
  const toggleSub = (id) => setExpandedSubs(m => ({ ...m, [id]: !m[id] }));
  const toggleClient = (id) => setExpandedClients(m => ({ ...m, [id]: !m[id] }));
  useEffect(() => { setExpandedSubs({}); setExpandedClients({}); }, [selectedAgentId]);

  const ownAccounts = summary?.ownAccounts || [];
  const ownAccountsTotals = summary?.ownAccountsTotals || { lots: 0, commission: 0, balance: 0, deposits: 0, withdrawals: 0, equity: 0 };
  const subagents = summary?.subagents || [];
  const directClients = summary?.directClients || [];
  const grandTotal = summary?.grandTotal || { lots: 0, commission: 0, balance: 0, deposits: 0, withdrawals: 0, equity: 0 };

  // Flatten summary into table rows (same structure as agent Summary.jsx)
  const rows = [];
  if (summary) {
    rows.push(
      <tr key="totals" className="sum-row-total">
        <td colSpan="2" className="bold">
          TOTAL · {subagents.length} sub-agent{subagents.length === 1 ? '' : 's'} · {directClients.length} direct client{directClients.length === 1 ? '' : 's'}
          {ownAccounts.length > 0 && <> · {ownAccounts.length} own account{ownAccounts.length === 1 ? '' : 's'}</>}
        </td>
        <NumCells row={grandTotal} />
      </tr>
    );

    // Agent's own MT5 accounts at the top — admin sees the same shape the
    // agent sees when they log in.
    if (ownAccounts.length > 0) {
      rows.push(
        <tr key="own-header" className="sum-row-section">
          <td colSpan="2" className="bold">★ Their accounts ({ownAccounts.length})</td>
          <NumCells row={ownAccountsTotals} />
        </tr>
      );
      ownAccounts.forEach((a) => {
        rows.push(<AccountRow key={`own-${a.login}`} a={a} depth={1} own />);
      });
    }

    subagents.forEach((sa) => {
      const isExpanded = !!expandedSubs[sa.id];
      rows.push(
        <SubAgentRow key={sa.id} sa={sa} expanded={isExpanded} onToggle={() => toggleSub(sa.id)} />
      );
      if (isExpanded) {
        (sa.ownAccounts || []).forEach((a) => {
          rows.push(<AccountRow key={`${sa.id}-own-${a.login}`} a={a} depth={1} own />);
        });
        (sa.clients || []).forEach((c) => {
          const cExp = !!expandedClients[c.id];
          rows.push(
            <ClientRow key={`${sa.id}-${c.id}`} c={c} depth={1} expanded={cExp} onToggle={() => toggleClient(c.id)} />
          );
          if (cExp) {
            (c.accounts || []).forEach((a) => {
              rows.push(<AccountRow key={`${sa.id}-${c.id}-${a.login}`} a={a} depth={2} />);
            });
          }
        });
      }
    });
    directClients.forEach((c) => {
      const cExp = !!expandedClients[c.id];
      rows.push(
        <ClientRow key={`direct-${c.id}`} c={c} depth={0} expanded={cExp} onToggle={() => toggleClient(c.id)} />
      );
      if (cExp) {
        (c.accounts || []).forEach((a) => {
          rows.push(<AccountRow key={`direct-${c.id}-${a.login}`} a={a} depth={1} />);
        });
      }
    });
  }

  function expandAll() {
    const s = {}, c = {};
    subagents.forEach((sa) => {
      s[sa.id] = true;
      (sa.clients || []).forEach((cl) => { c[cl.id] = true; });
    });
    directClients.forEach((cl) => { c[cl.id] = true; });
    setExpandedSubs(s);
    setExpandedClients(c);
  }
  function collapseAll() {
    setExpandedSubs({});
    setExpandedClients({});
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1><User size={18} style={{ verticalAlign: -3, marginRight: 8 }} />Agent Summary</h1>
          <p className="muted">
            Pick any imported agent to see their MT5 roll-up, their commission ledger, or both.
            Admins, ops, support, and BDs use this when answering "what is agent X seeing?" or
            "what did agent X earn?"
          </p>
        </div>
      </header>

      {/* Picker banner — always visible at the top */}
      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>Viewing as</div>
            {selectedAgent ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="sum-avatar sum-avatar-sub" aria-hidden>
                  {(selectedAgent.name || '?')[0].toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    <Link to={`/admin/agents/${selectedAgent.id}`}>{selectedAgent.name}</Link>
                    {!selectedAgent.is_active && <span className="pill" style={{ marginLeft: 8, background: 'var(--danger-soft)', color: 'var(--danger)' }}>inactive</span>}
                  </div>
                  <div className="muted small">
                    {selectedAgent.email || '—'}{selectedAgent.branch ? ` · ${selectedAgent.branch}` : ''}
                    {` · ${selectedAgent.direct_clients_count || 0} direct clients · ${selectedAgent.direct_sub_count || 0} sub-agents`}
                  </div>
                </div>
              </div>
            ) : (
              <div className="muted">Pick an agent below to see their data.</div>
            )}
          </div>

          {selectedAgentId && (
            <>
              <button className="btn ghost small" onClick={() => setPickerOpen(v => !v)}>
                <Search size={12} /> {pickerOpen ? 'Hide picker' : 'Change agent'}
              </button>
              {tab === 'summary' && (
                <button className="btn small" onClick={handleSync} disabled={syncing || summaryLoading}>
                  <RefreshCw size={12} /> {syncing ? 'Syncing…' : 'Refresh MT5'}
                </button>
              )}
              <Link
                to={`/admin/agents/${selectedAgentId}`}
                className="btn ghost small"
                title="Open the full agent detail page"
              >
                <ExternalLink size={12} /> Detail
              </Link>
              <button className="btn ghost small" onClick={clearAgent}>
                <X size={12} /> Clear
              </button>
            </>
          )}
        </div>

        {/* Inline agent picker — filterable list */}
        {pickerOpen && (
          <div className="pad" style={{ borderTop: '1px solid var(--border)' }}>
            {/* Row 1: text search + branch dropdown */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <input
                className="input"
                placeholder="Search agents by name, email, or branch…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                style={{ flex: '1 1 320px', minWidth: 240, maxWidth: 480 }}
                autoFocus
              />
              <select
                className="input"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                title="Filter agents by branch"
                style={{ minWidth: 220 }}
              >
                <option value="">All branches ({agents?.length || 0})</option>
                {branchOptions.map(b => (
                  <option key={b.branch} value={b.branch}>
                    {b.branch} — {b.count} agent{b.count === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </div>

            {/* Row 2: filter chips (hierarchy + activity + status) */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
              <span className="muted small" style={{ marginRight: 4 }}>Level:</span>
              {[
                { key: 'all', label: 'All' },
                { key: 'top', label: 'Top-level' },
                { key: 'sub', label: 'Sub-agents' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`btn ${levelFilter === opt.key ? '' : 'ghost'} small`}
                  onClick={() => setLevelFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}

              <span className="muted small" style={{ marginLeft: 12, marginRight: 4 }}>Activity:</span>
              {[
                { key: 'all',         label: 'All' },
                { key: 'has_clients', label: 'Has clients' },
                { key: 'has_subs',    label: 'Has sub-agents' },
                { key: 'empty',       label: 'Empty' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`btn ${activityFilter === opt.key ? '' : 'ghost'} small`}
                  onClick={() => setActivityFilter(opt.key)}
                  title={opt.key === 'empty' ? 'No direct clients and no sub-agents' : undefined}
                >
                  {opt.label}
                </button>
              ))}

              <span className="muted small" style={{ marginLeft: 12, marginRight: 4 }}>Status:</span>
              {[
                { key: 'active',   label: 'Active' },
                { key: 'inactive', label: 'Inactive' },
                { key: 'all',      label: 'All' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`btn ${statusFilter === opt.key ? '' : 'ghost'} small`}
                  onClick={() => setStatusFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}

              {hasActiveFilter && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={clearAllFilters}
                  style={{ marginLeft: 'auto' }}
                  title="Reset all picker filters"
                >
                  <X size={12} /> Clear filters
                </button>
              )}
            </div>

            {/* Result count */}
            {!agentsLoading && (
              <div className="muted small" style={{ marginBottom: 8 }}>
                {filteredAgents.length === (agents?.length || 0)
                  ? `${filteredAgents.length} agent${filteredAgents.length === 1 ? '' : 's'}`
                  : `${filteredAgents.length} of ${agents?.length || 0} agents shown`}
              </div>
            )}

            {agentsLoading && <div className="muted">Loading agents…</div>}
            {!agentsLoading && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
                {filteredAgents.slice(0, 100).map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => pickAgent(a.id)}
                    className={a.id === selectedAgentId ? 'btn' : 'btn ghost'}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start',
                      textAlign: 'left', padding: '6px 10px',
                    }}
                  >
                    <div className="sum-avatar sum-avatar-sub" aria-hidden style={{ flex: '0 0 auto' }}>
                      {(a.name || '?')[0].toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.name}
                      </div>
                      <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.branch || '—'}{a.direct_sub_count ? ` · ${a.direct_sub_count} subs` : ''}
                      </div>
                    </div>
                    {a.is_top_level && <span className="pill" style={{ fontSize: 10, flex: '0 0 auto' }}>top</span>}
                  </button>
                ))}
                {filteredAgents.length > 100 && (
                  <div className="muted small" style={{ gridColumn: '1 / -1' }}>
                    … {filteredAgents.length - 100} more match. Narrow your search.
                  </div>
                )}
                {filteredAgents.length === 0 && !agentsLoading && (
                  <div className="muted small">No agents match that search.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* MT5 data freshness — answers "is this agent's data actually
          fetched, and when?". Always visible when an agent is selected,
          regardless of which tab is active. */}
      {selectedAgentId && <Mt5FreshnessCard userId={selectedAgentId} />}

      {/* Tab bar — only shown once an agent is selected, to keep the empty
          state uncluttered */}
      {selectedAgentId && (
        <div className="tab-row" style={{ marginBottom: 'var(--space-3)' }}>
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                className={`tab-btn ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={12} style={{ verticalAlign: -1, marginRight: 6 }} />
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!selectedAgentId && (
        <div className="card">
          <div className="pad muted" style={{ textAlign: 'center' }}>
            Pick an agent above to view their Summary or Commissions.
          </div>
        </div>
      )}

      {/* Summary tab content */}
      {selectedAgentId && tab === 'summary' && summaryError && (
        <div className="card">
          <div className="pad" style={{ color: 'var(--danger)' }}>
            Failed to load summary: {summaryError.message || String(summaryError)}
          </div>
        </div>
      )}

      {selectedAgentId && tab === 'summary' && summaryLoading && !summary && (
        <div className="card">
          <div className="pad muted">Loading summary…</div>
        </div>
      )}

      {selectedAgentId && tab === 'summary' && summary && (
        <>
          {/* Date-range filter — affects deal-level aggregates (lots,
              commission, deposits, withdrawals). Balance and equity stay
              point-in-time. Empty fields = all time. */}
          <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="field inline">
              <span>From</span>
              <input
                type="date"
                className="input"
                value={fromYmd}
                onChange={e => setDateRange(e.target.value, toYmd)}
                style={{ minWidth: 140 }}
              />
            </label>
            <label className="field inline">
              <span>To</span>
              <input
                type="date"
                className="input"
                value={toYmd}
                onChange={e => setDateRange(fromYmd, e.target.value)}
                style={{ minWidth: 140 }}
              />
            </label>
            {(fromYmd || toYmd) && (
              <button className="btn ghost small" onClick={clearDateRange} title="Show all time">
                <X size={12} /> Clear
              </button>
            )}
            <span className="muted small" style={{ marginLeft: 'auto' }}>
              {fromYmd || toYmd
                ? <>Showing: <b>{fromYmd || '…'} → {toYmd || 'today'}</b></>
                : <>Showing: <b>all time</b></>}
            </span>
          </div>

          {/* Quick-pick presets. Click to set both dates instantly. The
              currently-active preset (if the date range matches one) is
              highlighted. */}
          <div className="filter-bar" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <span className="muted small" style={{ marginRight: 4 }}>Quick range:</span>
            {datePresets.map(p => {
              const isActive = activePreset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`btn small ${isActive ? '' : 'ghost'}`}
                  onClick={() => setDateRange(p.from, p.to)}
                  title={`${p.from} → ${p.to}`}
                  style={isActive ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : undefined}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="filter-bar">
            <div className="muted small">
              MT5 snapshot: {relativeTime(summary.mt5_synced_at)}
              {summary.mt5_pending > 0 && ` · ${summary.mt5_pending} logins never synced`}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn ghost small" onClick={expandAll}>Expand all</button>
              <button className="btn ghost small" onClick={collapseAll}>Collapse all</button>
            </div>
          </div>

          <div className="card">
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table sum-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th className="num">Lots</th>
                    <th className="num">Commission</th>
                    <th className="num">Deposit</th>
                    <th className="num">Withdrawal</th>
                    <th className="num">Balance</th>
                    <th className="num">Equity</th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Commissions tab content — reuses the same CommissionsSection
          component that AgentDetail renders, so numbers stay in sync.
          The RecomputePanel lives above it so admins can re-run the
          waterfall math then immediately see the updated ledger below. */}
      {selectedAgentId && tab === 'commissions' && (
        <>
          <RecomputePanel agentId={selectedAgentId} agentName={selectedAgent?.name || ''} />
          <CommissionsSection agentId={selectedAgentId} />
        </>
      )}

      {progressJobId && (
        <JobProgressModal
          jobId={progressJobId}
          title={progressTitle}
          onClose={() => setProgressJobId(null)}
        />
      )}
    </div>
  );
}
