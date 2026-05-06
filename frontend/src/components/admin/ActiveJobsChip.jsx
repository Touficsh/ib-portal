import { useEffect, useState } from 'react';
import { Activity, ChevronUp, ChevronDown, X } from 'lucide-react';
import { api } from '../../api.js';
import JobProgressModal from '../JobProgressModal.jsx';

/**
 * Active jobs indicator for the admin sidebar footer.
 *
 * Polls GET /api/admin/jobs?active=true every 5s while there's at least one
 * active job, every 30s otherwise. Shows count + collapsible list of jobs.
 * Click any row → opens the JobProgressModal for that job.
 */
const POLL_BUSY_MS = 5_000;
const POLL_IDLE_MS = 30_000;

export default function ActiveJobsChip() {
  const [jobs, setJobs] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [openJobId, setOpenJobId] = useState(null);
  const [openTitle, setOpenTitle] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function tick() {
      if (cancelled || document.hidden) {
        timer = setTimeout(tick, 5000);
        return;
      }
      try {
        const r = await api('/api/admin/jobs?active=true');
        if (cancelled) return;
        setJobs(r.jobs || []);
        const next = (r.jobs?.length || 0) > 0 ? POLL_BUSY_MS : POLL_IDLE_MS;
        timer = setTimeout(tick, next);
      } catch {
        timer = setTimeout(tick, POLL_IDLE_MS);
      }
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  if (jobs.length === 0) return null;

  return (
    <>
      <div
        className="card"
        style={{
          margin: '8px 0',
          padding: '8px 10px',
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
          borderRadius: 6,
        }}
      >
        <div
          onClick={() => setExpanded(e => !e)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            cursor: 'pointer', userSelect: 'none',
          }}
          title="Click to expand/collapse"
        >
          <Activity size={13} className="spin" style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--accent)' }}>
            {jobs.length} active job{jobs.length === 1 ? '' : 's'}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </span>
        </div>
        {expanded && (
          <ul style={{ margin: '6px 0 0 0', padding: 0, listStyle: 'none' }}>
            {jobs.map(j => (
              <li
                key={j.id}
                onClick={() => { setOpenJobId(j.id); setOpenTitle(j.label); }}
                style={{
                  padding: '6px 4px',
                  borderTop: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
                title={j.currentStepLabel}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.label}
                  </span>
                  <span className="mono small muted" style={{ flexShrink: 0 }}>{j.progress || 0}%</span>
                </div>
                <div style={{ height: 3, background: 'var(--bg-elev-2)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${j.progress || 0}%`,
                    height: '100%',
                    background: 'var(--accent)',
                    transition: 'width 0.4s',
                  }} />
                </div>
                <div className="muted" style={{ marginTop: 2, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.currentStepLabel}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {openJobId && (
        <JobProgressModal
          jobId={openJobId}
          title={openTitle}
          onClose={() => { setOpenJobId(null); }}
          keepOpenOnSuccess
        />
      )}
    </>
  );
}
