import { useEffect, useState, useMemo } from 'react';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, Pause, Play, RefreshCw,
  Database, Clock, TrendingUp, Zap, AlertCircle, Server, ChevronRight, Radio,
} from 'lucide-react';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { toast } from '../../components/ui/toast.js';

/**
 * Admin — MT5 Sync Health
 *
 * Live dashboard of the MT5 ingest pipeline. Answers:
 *   - Is the MT5 bridge gate healthy?
 *   - When did we last pull a deal?
 *   - How are commission engine cycles running?
 *   - Which branches are ingest-complete vs lagging?
 *   - What jobs are failing?
 *
 * Auto-refreshes every 30 s. Zero MT5 / CRM load.
 */

// ───────────────────────── helpers ─────────────────────────
function fmt(n) { return (n ?? 0).toLocaleString(); }

function humanizeAgo(isoOrDate) {
  if (!isoOrDate) return 'never';
  const then = new Date(isoOrDate).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60)      return `${secs}s ago`;
  if (secs < 3600)    return `${Math.round(secs/60)}m ago`;
  if (secs < 86400)   return `${Math.round(secs/3600)}h ago`;
  return `${Math.round(secs/86400)}d ago`;
}

// Per-cycle drill-down loader. Returns [data, loading, error, open(id), close()].
// Lives outside the main component so it stays self-contained and reusable.
function useCycleDetail() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const open = async (cycleId) => {
    if (!cycleId) return;
    setLoading(true); setError(null);
    try {
      const { api } = await import('../../api.js');
      const res = await api(`/api/admin/mt5-sync/cycles/${cycleId}`);
      setData(res);
    } catch (e) {
      setError(e.message || 'failed to load cycle');
    } finally {
      setLoading(false);
    }
  };
  const close = () => { setData(null); setError(null); };
  return [data, loading, error, open, close];
}

// Future-looking variant of humanizeAgo. "in 23m", "in 1h", "any moment", etc.
function humanizeIn(isoOrDate) {
  if (!isoOrDate) return '—';
  const then = new Date(isoOrDate).getTime();
  const secs = Math.round((then - Date.now()) / 1000);
  if (secs <= 0)      return 'any moment';
  if (secs < 60)      return `in ${secs}s`;
  if (secs < 3600)    return `in ${Math.round(secs/60)}m`;
  if (secs < 86400)   return `in ${Math.round(secs/3600)}h`;
  return `in ${Math.round(secs/86400)}d`;
}

function humanizeDuration(secs) {
  if (secs == null) return '—';
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs/60)}m ${secs%60}s`;
  return `${Math.round(secs/3600)}h`;
}

function HealthBadge({ state }) {
  const map = {
    green:  { color: 'var(--success)', bg: 'var(--success-soft)', icon: <CheckCircle2 size={14} />, label: 'Healthy' },
    yellow: { color: 'var(--warn)',    bg: 'var(--warn-soft)',    icon: <AlertTriangle size={14} />, label: 'Warning' },
    red:    { color: 'var(--danger)',  bg: 'var(--danger-soft)',  icon: <XCircle size={14} />,       label: 'Unhealthy' },
  };
  const s = map[state] || map.green;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 999,
      background: s.bg, color: s.color,
      fontWeight: 600, fontSize: 12,
    }}>
      {s.icon} {s.label}
    </span>
  );
}

function StatusDot({ state }) {
  const color = state === 'succeeded' ? 'var(--success)'
              : state === 'failed'    ? 'var(--danger)'
              : state === 'running'   ? 'var(--accent)'
              : 'var(--text-muted)';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 6 }} />;
}

// ───────────────────────── main page ─────────────────────────
export default function Mt5SyncHealth() {
  const { data, loading, refetch } = useApi('/api/admin/mt5-sync/status', {}, []);
  const [runCycle,  { loading: running }] = useMutation();
  const [setPause,  { loading: togglingPause }] = useMutation();
  const [saveLookback, { loading: savingLookback }] = useMutation();
  const [saveFloor,    { loading: savingFloor }]    = useMutation();
  const [lookbackDraft, setLookbackDraft] = useState('');
  const [floorDraft,    setFloorDraft]    = useState('');  // YYYY-MM-DD or ''

  // Per-cycle drill-down: must live ABOVE any conditional early-returns
  // (e.g. `if (!data) return null` later in this component) — Rules of Hooks
  // require hook calls in the same order on every render.
  const [cycleDetail, cycleDetailLoading, cycleDetailError, openCycle, closeCycle] = useCycleDetail();

  // Sync the drafts with server-known values whenever /status refreshes
  useEffect(() => {
    const days = data?.snapshot_sync?.initial_lookback_days;
    if (days != null) setLookbackDraft(String(days));
  }, [data?.snapshot_sync?.initial_lookback_days]);
  useEffect(() => {
    // Empty string = no floor (all history allowed, bounded only by lookback)
    setFloorDraft(data?.snapshot_sync?.earliest_deal_date || '');
  }, [data?.snapshot_sync?.earliest_deal_date]);

  async function submitLookback(e) {
    e?.preventDefault?.();
    const days = Number(lookbackDraft);
    if (!Number.isFinite(days) || days < 1) {
      toast.error('Enter a whole number of days (1 or more)');
      return;
    }
    try {
      await saveLookback('/api/admin/mt5-sync/settings/lookback-days', {
        method: 'PUT',
        body: { days },
      });
      toast.success(`First-sync lookback set to ${Math.min(3650, Math.floor(days))} days`);
      refetch();
    } catch (err) {
      toast.error(err.message || 'Could not save lookback window');
    }
  }

  async function submitFloor(e) {
    e?.preventDefault?.();
    try {
      // Empty draft = clear the floor (no lower bound on fetched data).
      const payload = floorDraft ? { date: floorDraft } : { date: null };
      await saveFloor('/api/admin/mt5-sync/settings/earliest-deal-date', {
        method: 'PUT',
        body: payload,
      });
      toast.success(floorDraft
        ? `Earliest deal date set to ${floorDraft}`
        : 'Earliest-deal-date floor cleared');
      refetch();
    } catch (err) {
      toast.error(err.message || 'Could not save earliest-deal-date');
    }
  }

  // Poll every 30s so the page stays fresh without reload
  useEffect(() => {
    const id = setInterval(() => refetch(), 30_000);
    return () => clearInterval(id);
  }, [refetch]);

  async function triggerCycle() {
    try {
      await runCycle('/api/admin/mt5-sync/run', { method: 'POST' });
      toast.success('Cycle started — refresh to watch progress');
      setTimeout(refetch, 1500);
    } catch (err) {
      toast.error(err.message || 'Trigger failed');
    }
  }

  async function togglePause() {
    const paused = data?.bridge_gate?.paused;
    try {
      await setPause(`/api/admin/mt5-sync/${paused ? 'resume' : 'pause'}`, { method: 'POST' });
      toast.success(paused ? 'MT5 bridge resumed' : 'MT5 bridge paused');
      refetch();
    } catch (err) {
      toast.error(err.message || 'Toggle failed');
    }
  }

  if (loading && !data) return (
    <div>
      <header className="page-header">
        <div><h1><Activity size={18} style={{ verticalAlign: -3, marginRight: 8 }} />MT5 Sync Health</h1></div>
      </header>
      <div className="muted pad">Loading…</div>
    </div>
  );

  if (!data) return null;

  const dc = data.deal_cache || {};
  const act = dc.activity || {};
  const cycles = data.cycles?.recent || [];
  const stats = data.cycles?.stats_24h || {};
  const ws = data.webhook_stream || {};

  return (
    <div>
      <header className="page-header" style={{ display: 'flex', alignItems: 'start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Activity size={18} />
            MT5 Sync Health
            <HealthBadge state={data.overall_health} />
          </h1>
          <p className="muted">
            Live view of the commission engine's MT5 pipeline. Auto-refreshes every 30 s.
            {data.health_reasons.length > 0 && (
              <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
                · {data.health_reasons.join(' · ')}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost small" onClick={refetch} disabled={loading}>
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            className="btn small"
            onClick={triggerCycle}
            disabled={running || data.bridge_gate?.paused}
            title={data.bridge_gate?.paused ? 'Bridge paused' : 'Run an engine cycle now'}
          >
            <Zap size={12} /> {running ? 'Starting…' : 'Run cycle now'}
          </button>
          <button
            className={`btn small ${data.bridge_gate?.paused ? '' : 'ghost'}`}
            onClick={togglePause}
            disabled={togglingPause}
            title={data.bridge_gate?.paused
              ? 'Resume MT5 activity — outbound bridge calls + incoming webhook deals + per-deal commission writes will all start flowing again'
              : 'Stop ALL MT5 activity — outbound bridge calls (snapshot sync, /accounts, /history), incoming webhook deals, and per-deal commission writes. Bridge process keeps running but the portal ignores it.'
            }
          >
            {data.bridge_gate?.paused
              ? <><Play size={12} /> Resume MT5</>
              : <><Pause size={12} /> Pause MT5 (kill switch)</>
            }
          </button>
        </div>
      </header>

      {/* ── Top-line stat row ───────────────────────────────────────────── */}
      <section className="stat-row" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="stat">
          <div className="stat-label">Last deal cached</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {humanizeAgo(dc.newest_deal)}
          </div>
          <div className="stat-sub muted">
            {dc.newest_deal ? new Date(dc.newest_deal).toLocaleString() : 'No deals yet'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Deals · last hour</div>
          <div className="stat-value">{fmt(act.last_hour)}</div>
          <div className="stat-sub muted">{fmt(act.last_day)} in 24h · {fmt(act.last_week)} in 7d</div>
        </div>
        <div className="stat">
          <div className="stat-label">Cycles · 24h</div>
          <div className="stat-value">
            <span style={{ color: 'var(--success)' }}>{stats.succeeded || 0}</span>
            {(stats.failed > 0) && (
              <>
                <span className="muted" style={{ fontSize: 14 }}> / </span>
                <span style={{ color: 'var(--danger)' }}>{stats.failed}</span>
              </>
            )}
          </div>
          <div className="stat-sub muted">avg {humanizeDuration(stats.avg_duration_s)} · {fmt(stats.deals_inserted_24h)} deals</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total deals cached</div>
          <div className="stat-value">{fmt(dc.total_rows)}</div>
          <div className="stat-sub muted">{fmt(dc.distinct_logins)} distinct logins</div>
        </div>
      </section>

      {/* ── Real-time deal stream ───────────────────────────────────────── */}
      {/*
       * In-memory webhook counters from routes/mt5Webhook.js. Resets on
       * portal restart, so "since restart" totals can be small even when
       * the cache has millions of rows. The "last N min" buckets are the
       * real signal — if `last 5 min` is 0 while the broker is open, the
       * stream is broken (bridge dead, secret mismatch, network blocked).
       */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2>
            <Radio size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            Real-time deal stream
          </h2>
          <span className="muted small">
            via MT5 bridge → POST /api/mt5/webhook/deal
          </span>
        </div>
        <div
          className="pad"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 24,
          }}
        >
          {[
            { label: 'Last 1 min',  value: ws.last_1min  },
            { label: 'Last 5 min',  value: ws.last_5min  },
            { label: 'Last 15 min', value: ws.last_15min },
            { label: 'Last 60 min', value: ws.last_60min },
          ].map(b => (
            <div key={b.label}>
              <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {b.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, lineHeight: 1.1 }}>
                {fmt(b.value)}
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>deals received</div>
            </div>
          ))}
        </div>
        <div
          className="pad"
          style={{
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 16,
            fontSize: 12,
            alignItems: 'center',
          }}
        >
          <div className="muted">
            <span style={{ fontWeight: 500, color: 'var(--text)' }}>Since portal restart: </span>
            {fmt(ws.total_received)} received · {fmt(ws.total_inserted)} new
            {ws.total_skipped_unknown ? ` · ${fmt(ws.total_skipped_unknown)} skipped (other broker clients)` : ''}
            {ws.total_skipped_paused ? ` · ${fmt(ws.total_skipped_paused)} skipped (paused)` : ''}
            {ws.total_rejected ? ` · ${fmt(ws.total_rejected)} rejected` : ''}
          </div>
          <div className="muted">
            <span style={{ fontWeight: 500, color: 'var(--text)' }}>Last received: </span>
            {ws.last_received_at ? humanizeAgo(ws.last_received_at) : '—'}
          </div>
          <div style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {ws.last_error ? (
              <span style={{ color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    title={ws.last_error}>
                <AlertTriangle size={12} style={{ flexShrink: 0 }} /> {ws.last_error}
              </span>
            ) : (
              <span style={{ color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={12} style={{ flexShrink: 0 }} /> No errors since restart
              </span>
            )}
          </div>
        </div>

        {/* ── Recent webhook errors — last N rejected POSTs ──────────── */}
        {ws.recent_errors && ws.recent_errors.length > 0 && (
          <div className="pad" style={{
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
            marginTop: 12,
          }}>
            <div className="muted small" style={{ fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Recent errors (last {ws.recent_errors.length})
            </div>
            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: '13%' }}>When</th>
                  <th style={{ width: '7%' }}>Op</th>
                  <th style={{ width: '12%' }}>Login</th>
                  <th style={{ width: '13%' }}>Deal ID</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {ws.recent_errors.slice(0, 10).map((e, i) => (
                  <tr key={`${e.ts}-${i}`}>
                    <td className="muted">{humanizeAgo(e.ts)}</td>
                    <td className="mono small">{e.op || '—'}</td>
                    <td className="mono small">{e.login || '—'}</td>
                    <td className="mono small">{e.dealId ?? '—'}</td>
                    <td style={{ color: 'var(--danger)' }}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Bridge gate card ────────────────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2><Server size={14} style={{ verticalAlign: -2, marginRight: 6 }} />MT5 bridge gate</h2>
          <span className="muted small">In-process guardrails for bridge calls</span>
        </div>
        <div className="pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          <div>
            <div className="muted small">Status</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>
              {data.bridge_gate.paused
                ? <span style={{ color: 'var(--danger)' }}>Paused</span>
                : <span style={{ color: 'var(--success)' }}>Active</span>}
            </div>
          </div>
          <div>
            <div className="muted small">MT5 session</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>
              {data.bridge_gate.mt5_connected === true ? (
                <span style={{ color: 'var(--success)' }}>
                  Connected
                </span>
              ) : data.bridge_gate.mt5_connected === false ? (
                <span style={{ color: 'var(--danger)' }}>Disconnected</span>
              ) : (
                <span className="muted">Bridge unreachable</span>
              )}
            </div>
            <div className="muted small" style={{ marginTop: 2 }}>
              {data.bridge_gate.connected_since
                ? `since ${humanizeAgo(data.bridge_gate.connected_since)}`
                : ''}
            </div>
          </div>
          <div>
            <div className="muted small">Rate limit</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>{data.bridge_gate.ratePerSecond}/s</div>
          </div>
          <div>
            <div className="muted small">Concurrency</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>
              {data.bridge_gate.inFlight} / {data.bridge_gate.maxConcurrency}
            </div>
          </div>
          <div>
            <div className="muted small">Balance cache</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 4 }}>{data.bridge_gate.balanceCacheSize} entries</div>
          </div>
        </div>
      </section>

      {/* ── Snapshot sync settings ──────────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2><Clock size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Snapshot sync settings</h2>
          <span className="muted small">Data-retention policy for MT5 ingest</span>
        </div>

        {/* First-sync lookback window */}
        <form
          className="pad"
          onSubmit={submitLookback}
          style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap' }}
        >
          <div style={{ flex: '0 0 auto', minWidth: 220 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>First-sync lookback (days)</div>
            <input
              type="number"
              min="1"
              max="3650"
              step="1"
              className="input"
              value={lookbackDraft}
              onChange={(e) => setLookbackDraft(e.target.value)}
              style={{ width: 140 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 260, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            How far back the MT5 snapshot sync pulls deals the first time a
            login is synced. Subsequent syncs use an incremental cursor, so
            this only affects logins with no cached deals yet. Default 60.
            Always bounded by the Earliest deal date below.
          </div>
          <button
            type="submit"
            className="btn small"
            disabled={savingLookback || Number(lookbackDraft) === Number(data.snapshot_sync?.initial_lookback_days)}
          >
            {savingLookback ? 'Saving…' : 'Save'}
          </button>
        </form>

        {/* Hard floor — never fetch deals older than this */}
        <form
          className="pad"
          onSubmit={submitFloor}
          style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border)' }}
        >
          <div style={{ flex: '0 0 auto', minWidth: 220 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>Earliest deal date (global floor)</div>
            <input
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              className="input"
              value={floorDraft}
              onChange={(e) => setFloorDraft(e.target.value)}
              style={{ width: 180 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 260, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            <b style={{ color: 'var(--warn)' }}>Hard limit.</b> No deal from before this date
            will ever be fetched from the MT5 bridge or stored in the deal cache — even if
            a per-agent backfill asks for earlier data. Leave blank to allow any history
            (only the lookback window constrains).
            {data.snapshot_sync?.earliest_deal_date
              ? <> Currently: <b className="mono">{data.snapshot_sync.earliest_deal_date}</b>.</>
              : <> Currently: <b>no floor set</b>.</>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
            {floorDraft && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setFloorDraft('')}
                disabled={savingFloor}
                title="Clear the floor (pending Save)"
              >Clear</button>
            )}
            <button
              type="submit"
              className="btn small"
              disabled={savingFloor || (floorDraft || '') === (data.snapshot_sync?.earliest_deal_date || '')}
            >
              {savingFloor ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      {/* ── Background schedulers (next-run countdown) ───────────────────── */}
      {/*
       * Live state of each in-process scheduler. Lets an admin see at a
       * glance "when will the next thing fire?" without reading the .env.
       * Driven by getEngineStatus / getMt5SweepStatus / getMt5HotSweepStatus
       * exported from each scheduler module.
       */}
      {data.schedulers && data.schedulers.length > 0 && (
        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card-header">
            <h2><Clock size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Background schedulers</h2>
            <span className="muted small">Next-run countdown for periodic jobs</span>
          </div>
          <table className="table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th style={{ width: '24%' }}>Job</th>
                <th style={{ width: '12%' }}>Frequency</th>
                <th style={{ width: '14%' }}>Last run</th>
                <th style={{ width: '14%' }}>Next run</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {data.schedulers.map(s => {
                const minutes = s.intervalMs ? Math.round(s.intervalMs / 60000) : null;
                const disabled = s.enabled === false || s.intervalMs == null;
                return (
                  <tr key={s.key}>
                    <td style={{ fontWeight: 500 }}>{s.label}</td>
                    <td className="muted">{minutes ? `every ${minutes} min` : '—'}</td>
                    <td className="muted">{s.lastRunAt ? humanizeAgo(s.lastRunAt) : '—'}</td>
                    <td>
                      {disabled
                        ? <span className="muted">disabled</span>
                        : s.isRunning
                          ? <span style={{ color: 'var(--accent)' }}>running now</span>
                          : <span style={{ fontWeight: 500 }}>{humanizeIn(s.nextRunAt)}</span>
                      }
                    </td>
                    <td className="muted small">{s.purpose}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Engine cycles table ─────────────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2><Clock size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Recent engine cycles</h2>
          <span className="muted small">Last 20 runs · backstop for missed real-time webhook deals (every 60 min by default)</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th className="num">Jobs</th>
              <th className="num">Deals</th>
              <th className="num">Duration</th>
              <th>Trigger</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map(c => (
              <tr
                key={c.id}
                onClick={() => openCycle(c.id)}
                style={{
                  cursor: 'pointer',
                  background: cycleDetail?.cycle?.id === c.id ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
                }}
                title="Click to inspect this cycle's jobs + errors"
              >
                <td>
                  <span className="mono small">{new Date(c.started_at).toLocaleString()}</span>
                  <span className="muted small" style={{ marginLeft: 6 }}>
                    ({humanizeAgo(c.started_at)})
                  </span>
                </td>
                <td><StatusDot state={c.status} /><span className="small">{c.status}</span></td>
                <td className="num mono small">
                  {c.jobs_succeeded}/{c.jobs_total}
                  {c.jobs_failed > 0 && (
                    <span style={{ color: 'var(--danger)' }}> · {c.jobs_failed} failed</span>
                  )}
                </td>
                <td className="num mono small">{fmt(c.deals_inserted)}</td>
                <td className="num mono small">{humanizeDuration(c.duration_s)}</td>
                <td className="small muted">{c.triggered_by}</td>
              </tr>
            ))}
            {cycles.length === 0 && (
              <tr><td colSpan={6} className="muted small pad">No cycles run yet.</td></tr>
            )}
          </tbody>
        </table>

        {/* ── Inline cycle drill-down ──────────────────────────────────── */}
        {(cycleDetail || cycleDetailLoading || cycleDetailError) && (
          <div className="pad" style={{
            borderTop: '1px solid var(--border)',
            marginTop: 12,
            paddingTop: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Cycle drill-down
              </h3>
              {cycleDetail?.cycle && (
                <span className="muted small mono">
                  {cycleDetail.cycle.id.slice(0, 8)} · started {humanizeAgo(cycleDetail.cycle.started_at)} · {cycleDetail.cycle.status}
                </span>
              )}
              <button
                type="button"
                className="btn ghost small"
                onClick={closeCycle}
                style={{ marginLeft: 'auto' }}
              >
                Close
              </button>
            </div>

            {cycleDetailLoading && (
              <div className="muted small">Loading cycle details…</div>
            )}
            {cycleDetailError && (
              <div style={{ color: 'var(--danger)' }} className="small">
                Failed to load: {cycleDetailError}
              </div>
            )}

            {cycleDetail && !cycleDetailLoading && !cycleDetailError && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Job-status histogram */}
                <div>
                  <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                    Job status
                  </div>
                  {cycleDetail.job_stats.length === 0 ? (
                    <div className="muted small">No jobs recorded.</div>
                  ) : (
                    <table className="table" style={{ fontSize: 12 }}>
                      <tbody>
                        {cycleDetail.job_stats.map(s => (
                          <tr key={s.status}>
                            <td><StatusDot state={s.status} /> {s.status}</td>
                            <td className="num mono">{fmt(s.n)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Error groups (failed + dead jobs) */}
                <div>
                  <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                    Top error reasons
                  </div>
                  {cycleDetail.error_groups.length === 0 ? (
                    <div className="muted small">No errors in this cycle.</div>
                  ) : (
                    <table className="table" style={{ fontSize: 12 }}>
                      <tbody>
                        {cycleDetail.error_groups.map((g, i) => (
                          <tr key={i}>
                            <td style={{ color: 'var(--danger)' }}>{g.reason}</td>
                            <td className="num mono">{fmt(g.n)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Sample failures */}
                {cycleDetail.sample_failures.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 6 }}>
                      Sample failed jobs (last {cycleDetail.sample_failures.length})
                    </div>
                    <table className="table" style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ width: '12%' }}>Login</th>
                          <th style={{ width: '20%' }}>Client</th>
                          <th style={{ width: '8%' }}>Status</th>
                          <th style={{ width: '8%' }}>Attempt</th>
                          <th>Last error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cycleDetail.sample_failures.map((j, i) => (
                          <tr key={i}>
                            <td className="mono small">{j.login}</td>
                            <td className="small">{j.client_name || j.client_id?.slice(0, 8) || '—'}</td>
                            <td><StatusDot state={j.status} /> {j.status}</td>
                            <td className="num mono small">{j.attempt}</td>
                            <td style={{ color: 'var(--danger)' }} className="small">{j.last_error || '(no error recorded)'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Per-branch deal freshness ───────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2><TrendingUp size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Branch deal freshness</h2>
          <span className="muted small">Top 15 branches by cached deals</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th className="num">Logins w/ deals</th>
              <th className="num">Deals cached</th>
              <th>Newest deal</th>
            </tr>
          </thead>
          <tbody>
            {(data.branch_freshness || []).map(b => (
              <tr key={b.branch}>
                <td><b>{b.branch}</b></td>
                <td className="num mono small">{fmt(b.logins_with_deals)}</td>
                <td className="num mono small">{fmt(b.deals_cached)}</td>
                <td className="small">
                  <span className="mono">{new Date(b.newest_deal).toLocaleString()}</span>
                  <span className="muted" style={{ marginLeft: 6 }}>({humanizeAgo(b.newest_deal)})</span>
                </td>
              </tr>
            ))}
            {(!data.branch_freshness || data.branch_freshness.length === 0) && (
              <tr><td colSpan={4} className="muted small pad">No branches have cached deals yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ── Trading accounts ingest state ───────────────────────────────── */}
      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-header">
          <h2><Database size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Trading accounts · upstream</h2>
          <span className="muted small">The bridge between CRM and MT5 — fed by contact trading-accounts sync</span>
        </div>
        <div className="pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div>
            <div className="muted small">Total meta rows</div>
            <div style={{ fontWeight: 600, fontSize: 18, marginTop: 4 }}>{fmt(data.trading_accounts.total_meta_rows)}</div>
          </div>
          <div>
            <div className="muted small">Clients with accounts</div>
            <div style={{ fontWeight: 600, fontSize: 18, marginTop: 4 }}>{fmt(data.trading_accounts.clients_with_accounts)}</div>
          </div>
          <div>
            <div className="muted small">Missing MT5 group</div>
            <div style={{ fontWeight: 600, fontSize: 18, marginTop: 4, color: data.trading_accounts.missing_mt5_group > 0 ? 'var(--warn)' : 'var(--text)' }}>
              {fmt(data.trading_accounts.missing_mt5_group)}
            </div>
          </div>
          <div>
            <div className="muted small">Never MT5-synced</div>
            <div style={{ fontWeight: 600, fontSize: 18, marginTop: 4, color: data.trading_accounts.never_mt5_synced > 0 ? 'var(--warn)' : 'var(--text)' }}>
              {fmt(data.trading_accounts.never_mt5_synced)}
            </div>
          </div>
        </div>
        <div className="pad muted small" style={{ borderTop: '1px solid var(--border)' }}>
          Last successful MT5 sync: {data.trading_accounts.last_mt5_sync
            ? <>{new Date(data.trading_accounts.last_mt5_sync).toLocaleString()} <i>({humanizeAgo(data.trading_accounts.last_mt5_sync)})</i></>
            : <i>never</i>
          }
        </div>
      </section>

      {/* ── Recent failures ─────────────────────────────────────────────── */}
      {data.recent_failures && data.recent_failures.length > 0 && (
        <section className="card" style={{ marginBottom: 'var(--space-4)', borderLeft: '4px solid var(--warn)' }}>
          <div className="card-header">
            <h2><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--warn)' }} />Recent job failures</h2>
            <span className="muted small">Engine-job errors in the last 24h</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th className="num">Count</th>
                <th>Error</th>
                <th>Most recent</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_failures.map((f, i) => (
                <tr key={i}>
                  <td className="num mono">{f.n}</td>
                  <td className="small mono" style={{ maxWidth: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(f.last_error || '').slice(0, 200)}
                  </td>
                  <td className="small">{humanizeAgo(f.most_recent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="muted small" style={{ textAlign: 'center', padding: 'var(--space-3) 0' }}>
        Snapshot taken {new Date(data.timestamp).toLocaleTimeString()} · auto-refreshing every 30 s
      </div>
    </div>
  );
}
