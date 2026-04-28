import { useEffect, useState, useCallback } from 'react';
import { Activity, PauseCircle, PlayCircle, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useMutation } from '../../hooks/useApi.js';
import { api } from '../../api.js';
import { toast, confirm } from '../ui/toast.js';

/**
 * Admin-only floating chip that shows the current CRM gate state and lets
 * admins hit a big Pause button to stop every outbound CRM call.
 *
 * Data source: GET /api/admin/crm/status — returns { paused, ratePerSecond,
 * maxConcurrency, inFlight, queuedForRate, queuedForConcurrency }.
 *
 * Adaptive polling — keeps per-admin API calls bounded:
 *   - Tab hidden          → no polling at all (visibilitychange listener)
 *   - Tab visible, idle   → poll every 30s (normal background heartbeat)
 *   - Tab visible, busy   → poll every 5s  (in-flight calls draining /
 *                           pausing — admin wants real-time feedback)
 *
 * Earlier this polled every 5s unconditionally → ~720 calls/hour per admin.
 * The new shape is closer to ~120/hour idle, ramping up only when state
 * actually moves.
 *
 * Actions:
 *   Pause  → POST /api/admin/crm/pause    (kill switch ON)
 *   Resume → POST /api/admin/crm/resume   (kill switch OFF)
 *
 * Designed to sit in the sidebar footer. Stays small when healthy, grows a
 * warning banner when paused so it's impossible to forget you've paused things.
 */
const POLL_IDLE_MS = 30_000;  // 30 s normal heartbeat
const POLL_BUSY_MS =  5_000;  // 5 s when there's gate activity to watch

export default function CrmGateStatus() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [pause, { loading: pausing }] = useMutation();
  const [resume, { loading: resuming }] = useMutation();

  const refresh = useCallback(async () => {
    try {
      // Absolute /api path — bypasses api()'s /api/portal prefix since this
      // is the staff-side admin route, not a portal route.
      const s = await api('/api/admin/crm/status');
      setState(s);
      setErr(null);
      return s;
    } catch (e) {
      setErr(e.message || 'Failed to load CRM status');
      return null;
    }
  }, []);

  // Adaptive polling. Re-evaluate cadence after every poll based on the
  // returned state. Pause entirely when the tab is hidden so background
  // tabs don't keep hammering the backend.
  useEffect(() => {
    let timer = null;
    let cancelled = false;

    const cadenceFor = (s) => {
      if (!s || s.paused) return POLL_IDLE_MS;
      const busy = s.inFlight > 0
        || s.queuedForRate > 0
        || s.queuedForConcurrency > 0;
      return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        // Don't refresh while the tab is hidden — but check back in 5s in
        // case the tab becomes visible without firing visibilitychange
        // (some browsers throttle setInterval but not setTimeout).
        timer = setTimeout(tick, 5_000);
        return;
      }
      const s = await refresh();
      if (cancelled) return;
      timer = setTimeout(tick, cadenceFor(s));
    };

    // Refresh immediately when the tab becomes visible after being hidden
    const onVisibility = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  async function doPause() {
    const ok = await confirm(
      `Pause ALL outbound calls to x-dev's CRM?\n\n` +
      `Every new CRM call throws CrmPausedError immediately. ` +
      `Scheduled auto-syncs still try but fail fast. In-flight calls finish; no new ones start until you resume.`,
      { confirmLabel: 'Pause CRM', cancelLabel: 'Cancel', variant: 'danger' }
    );
    if (!ok) return;
    try {
      await pause('/api/admin/crm/pause', { method: 'POST' });
      toast.warning('CRM paused — no new outbound calls will fire.', { duration: 10000 });
      refresh();
    } catch (e) {
      toast.error(e.message || 'Pause failed');
    }
  }

  async function doResume() {
    try {
      await resume('/api/admin/crm/resume', { method: 'POST' });
      toast.success('CRM resumed.');
      refresh();
    } catch (e) {
      toast.error(e.message || 'Resume failed');
    }
  }

  if (err) {
    return (
      <div className="crm-gate-chip crm-gate-error" title={err}>
        <AlertTriangle size={12} />
        <span className="small">CRM: {err.slice(0, 40)}</span>
      </div>
    );
  }
  if (!state) {
    // Before first fetch resolves — show a placeholder so admins know the
    // component exists, not just a silent gap above the user chip.
    return (
      <div className="crm-gate-chip crm-gate-idle">
        <Activity size={12} />
        <span className="small muted">CRM gate · loading…</span>
      </div>
    );
  }

  if (state.paused) {
    return (
      <div className="crm-gate-chip crm-gate-paused">
        <PauseCircle size={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="crm-gate-title">CRM paused</div>
          <div className="crm-gate-sub muted small">
            {state.inFlight > 0 ? `${state.inFlight} in-flight · all new calls blocked` : 'All CRM calls blocked'}
          </div>
        </div>
        <button
          type="button"
          className="btn primary sm"
          onClick={doResume}
          disabled={resuming}
          style={{ padding: '4px 8px', fontSize: 11 }}
        >
          <PlayCircle size={11} /> Resume
        </button>
      </div>
    );
  }

  const busy = state.inFlight > 0 || state.queuedForRate > 0 || state.queuedForConcurrency > 0;
  const openCircuits = Object.entries(state.circuit || {}).filter(([, s]) => s.open);
  const totalUsed = Object.values(state.endpointUsage || {}).reduce((sum, e) => sum + (e.used || 0), 0);
  const totalBudget = Object.values(state.endpointUsage || {}).reduce((sum, e) => sum + (e.budget || 0), 0);

  return (
    <div>
      <div className={`crm-gate-chip ${busy ? 'crm-gate-busy' : 'crm-gate-idle'}`}>
        <Activity size={13} className={busy ? 'pulse' : ''} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="crm-gate-title">CRM gate · {state.ratePerSecond}/s</div>
          <div className="crm-gate-sub muted small">
            {busy
              ? `${state.inFlight} in-flight · ${state.queuedForRate + state.queuedForConcurrency} queued`
              : `${totalUsed}/${totalBudget} calls today · ${openCircuits.length > 0 ? openCircuits.length + ' circuits open' : 'all healthy'}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Hide details' : 'Show budgets + circuits'}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={doPause}
          disabled={pausing}
          title="Pause every outbound CRM call"
          style={{ padding: '4px 8px', fontSize: 11 }}
        >
          <PauseCircle size={11} /> Pause
        </button>
      </div>
      {expanded && (
        <div className="crm-gate-details">
          <div className="crm-gate-section-title">Daily budgets (resets 00:00 UTC)</div>
          {Object.entries(state.endpointUsage || {}).map(([bucket, e]) => {
            const pct = e.budget > 0 ? Math.min(100, (e.used / e.budget) * 100) : 0;
            const tone = pct >= 90 ? 'danger' : pct >= 60 ? 'warn' : 'ok';
            return (
              <div key={bucket} className="crm-gate-budget-row">
                <span className="crm-gate-bucket-name">{bucket}</span>
                <div className="crm-gate-budget-bar">
                  <div className={`crm-gate-budget-fill tone-${tone}`} style={{ width: pct + '%' }} />
                </div>
                <span className="crm-gate-budget-count mono small">{e.used}/{e.budget}</span>
              </div>
            );
          })}
          {Object.keys(state.circuit || {}).length > 0 && (
            <>
              <div className="crm-gate-section-title" style={{ marginTop: 8 }}>Circuits</div>
              {Object.entries(state.circuit).map(([bucket, s]) => (
                <div key={bucket} className="crm-gate-circuit-row">
                  <span className="crm-gate-bucket-name">{bucket}</span>
                  {s.open ? (
                    <span className="pill stage-active" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
                      tripped until {s.tripped_until?.slice(11, 16)}
                    </span>
                  ) : (
                    <span className="muted small">{s.errors_in_window} errors in window</span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
