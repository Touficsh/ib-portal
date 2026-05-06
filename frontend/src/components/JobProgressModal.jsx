import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { api } from '../api.js';

/**
 * Live progress modal for long-running admin operations.
 *
 * Polls GET /api/admin/jobs/:jobId every second. Shows:
 *   - current step + step count
 *   - progress bar 0-100
 *   - inline log of recent step labels
 *   - final summary when completedAt is set
 *
 * Auto-closes 1.5s after success unless `keepOpenOnSuccess` is true.
 */
export default function JobProgressModal({
  jobId,
  title,
  onClose,
  keepOpenOnSuccess = false,
}) {
  const [job, setJob] = useState(null);
  const [err, setErr] = useState(null);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      try {
        const j = await api(`/api/admin/jobs/${jobId}`);
        if (cancelled) return;
        setJob(j);
        setErr(null);

        // Auto-close after success
        if (j.completedAt && !j.error && !keepOpenOnSuccess && !closedRef.current) {
          closedRef.current = true;
          setTimeout(() => { if (!cancelled) onClose?.(); }, 1500);
          return;  // stop polling
        }
        // Stop polling on error too (but keep modal open)
        if (j.completedAt) return;
      } catch (e) {
        if (cancelled) return;
        // 404 = job expired or never existed → stop polling, just close.
        if (e.status === 404) {
          if (!closedRef.current) onClose?.();
          return;
        }
        setErr(e.message || 'Polling failed');
      }
      timer = setTimeout(tick, 1000);
    }
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, onClose, keepOpenOnSuccess]);

  if (!jobId) return null;

  const finished = !!job?.completedAt;
  const failed = !!job?.error;
  const elapsed = job ? Math.round(((job.completedAt || Date.now()) - job.startedAt) / 1000) : 0;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && finished) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 480, margin: 0 }}>
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            {finished
              ? (failed ? <XCircle size={18} color="var(--danger)" /> : <CheckCircle2 size={18} color="var(--success)" />)
              : <Loader2 size={18} className="spin" />}
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title || job?.label || 'Working…'}</h2>
          </div>
          {finished && (
            <button type="button" className="btn ghost small" onClick={onClose}>Close</button>
          )}
        </div>
        <div className="pad">
          {!job && !err && <div className="muted">Starting…</div>}
          {err && !job && <div className="alert error">Could not load progress: {err}</div>}

          {job && (
            <>
              {/* Progress bar */}
              <div style={{
                width: '100%', height: 8, borderRadius: 4,
                background: 'var(--bg-elev-2)', overflow: 'hidden', marginBottom: 12,
              }}>
                <div style={{
                  width: `${job.progress || 0}%`,
                  height: '100%',
                  background: failed ? 'var(--danger)' : (finished ? 'var(--success)' : 'var(--accent)'),
                  transition: 'width 0.4s ease, background 0.4s ease',
                }} />
              </div>

              {/* Step + label */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                {job.totalSteps && (
                  <span className="mono small muted">Step {job.step || 0}/{job.totalSteps}</span>
                )}
                <span className="mono small muted">· {elapsed}s</span>
                <span className="mono small muted" style={{ marginLeft: 'auto' }}>{job.progress || 0}%</span>
              </div>
              <div style={{ fontWeight: 500, marginBottom: 10 }}>
                {job.currentStepLabel || '…'}
              </div>

              {/* Optional details (e.g., hierarchy progress) */}
              {job.details?.hierarchyProgress && (
                <div className="muted small" style={{ marginBottom: 10 }}>
                  Subtree {job.details.hierarchyProgress.current} of {job.details.hierarchyProgress.total}
                </div>
              )}

              {/* Recent log */}
              {job.log?.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted small" style={{ cursor: 'pointer' }}>
                    Show step history ({job.log.length})
                  </summary>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                    {job.log.slice().reverse().map((entry, i) => (
                      <li key={i} className="muted">
                        {new Date(entry.at).toLocaleTimeString()} — {entry.label}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* Summary on completion */}
              {finished && !failed && job.summary && (
                <div className="alert success" style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>Complete</div>
                  <div className="small">
                    {job.summary.created != null && `${job.summary.created} created`}
                    {job.summary.updated != null && ` · ${job.summary.updated} updated`}
                    {job.summary.contacts > 0 && ` · ${job.summary.contacts} contacts`}
                    {job.summary.logins > 0 && ` · ${job.summary.logins} MT5 logins`}
                  </div>
                </div>
              )}

              {failed && (
                <div className="alert error" style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 500 }}>Failed</div>
                  <div className="small">{job.error}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
