import { useState, useEffect } from 'react';
import { useApi, useMutation, useAutoRefresh } from '../../hooks/useApi.js';
import LastUpdated from '../../components/LastUpdated.jsx';
import {
  Database, Building2, CheckCircle2, XCircle, Loader2,
  Eye, EyeOff, Save, Wifi, RefreshCw, ShieldCheck, Server,
} from 'lucide-react';
import { toast } from '../../components/ui/toast.js';

/**
 * Admin — Settings
 *
 * Two sections:
 *   1. CRM Connection — base URL, API key, gate tuning, live test
 *   2. Company / Manager Details — name, email, phone, website, portal title
 */
export default function AdminSettings() {
  const { data: raw, loading, refetch, dataAt } = useApi('/api/admin/settings', {}, []);
  // Auto-refresh on tab refocus + every 60s. If another admin changes a
  // setting while this view is open, we pick it up automatically.
  useAutoRefresh(refetch, 60_000);
  const [save, { loading: saving }] = useMutation();
  const [test, { loading: testing }] = useMutation();

  // Local form state keyed by settings key
  const [form, setForm] = useState({});
  const [showKey, setShowKey] = useState(false);  // toggle API key visibility
  const [notice, setNotice]   = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Seed form from API response
  useEffect(() => {
    if (!raw) return;
    const initial = {};
    for (const entry of raw) {
      initial[entry.key] = entry.value ?? '';
    }
    setForm(initial);
  }, [raw]);

  // Group settings by section
  const bySection = (section) => (raw || []).filter(e => e.section === section);
  const crmFields    = bySection('crm');
  const companyFields = bySection('company');
  const mt5Fields     = bySection('mt5');

  // MT5 bridge state
  const [showPwd, setShowPwd] = useState(false);
  const [mt5TestResult, setMt5TestResult] = useState(null);
  const [testMt5, { loading: mt5Testing }] = useMutation();
  const [reconnectMt5, { loading: mt5Reconnecting }] = useMutation();

  async function onTestMt5() {
    setMt5TestResult(null);
    try {
      const r = await testMt5('/api/admin/settings/mt5/test');
      setMt5TestResult(r);
    } catch (err) {
      setMt5TestResult({ ok: false, error: err.message });
    }
  }

  async function onReconnectMt5() {
    setMt5TestResult(null);
    try {
      // Save current form values first so the bridge picks up the latest
      await save('/api/admin/settings', { method: 'PATCH', body: form });
      const r = await reconnectMt5('/api/admin/settings/mt5/reconnect', { method: 'POST' });
      if (r.ok) {
        toast.success('Connected to MT5');
      } else {
        toast.error(r.error || 'Reconnect failed — check credentials');
      }
      setMt5TestResult(r);
    } catch (err) {
      toast.error(err.message || 'Reconnect failed');
    }
  }

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setNotice(null);
    setTestResult(null);
  }

  async function onSave(e) {
    e.preventDefault();
    setNotice(null);
    try {
      const res = await save('/api/admin/settings', { method: 'PATCH', body: form });
      setNotice({ kind: 'success', text: `Saved ${res.updated?.length ?? 0} setting(s).` });
      refetch();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message || 'Save failed' });
    }
  }

  async function onTestCrm() {
    setTestResult(null);
    // Ensure latest URL + key are saved first
    try {
      await save('/api/admin/settings', {
        method: 'PATCH',
        body: { crm_base_url: form.crm_base_url, crm_api_key: form.crm_api_key },
      });
    } catch { /* ignore pre-save errors; test call will explain */ }

    try {
      const r = await test('/api/admin/settings/crm/test', { method: 'POST' });
      setTestResult(r);
    } catch (err) {
      setTestResult({ ok: false, error: err.message || 'Request failed' });
    }
  }

  if (loading) {
    return (
      <div className="page-loading">
        <Loader2 className="spin" size={20} />
        <span>Loading settings…</span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <header className="page-header" style={{ marginBottom: 'var(--space-6)' }}>
        <div>
          <h1>Settings</h1>
          <p className="muted">Configure CRM connection and company details.</p>
        </div>
        <div style={{ paddingTop: 6 }}>
          <LastUpdated dataAt={dataAt} loading={loading} />
        </div>
      </header>

      <form onSubmit={onSave}>
        {/* ── CRM Connection ─────────────────────────────── */}
        <Section icon={<Database size={16} />} title="CRM Connection" subtitle="x-dev CRM API credentials and rate limits">
          <Field label="CRM Base URL" hint="e.g. https://crm.bbcorp.trade">
            <input
              type="url"
              className="input"
              placeholder="https://crm.example.com"
              value={form.crm_base_url ?? ''}
              onChange={e => set('crm_base_url', e.target.value)}
            />
          </Field>

          <Field label="CRM API Key" hint="x-api-key sent on every outbound request">
            <div style={{ position: 'relative' }}>
              <input
                type={showKey ? 'text' : 'password'}
                className="input"
                placeholder="Enter API key…"
                value={form.crm_api_key ?? ''}
                onChange={e => set('crm_api_key', e.target.value)}
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                  display: 'flex', alignItems: 'center',
                }}
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
            <Field label="Rate limit (req/s)" hint="Max CRM calls per second (1–50)">
              <input
                type="number"
                className="input"
                min={1} max={50}
                value={form.crm_rate_per_second ?? '4'}
                onChange={e => set('crm_rate_per_second', e.target.value)}
              />
            </Field>
            <Field label="Max concurrency" hint="Parallel in-flight CRM calls (1–50)">
              <input
                type="number"
                className="input"
                min={1} max={50}
                value={form.crm_max_concurrency ?? '4'}
                onChange={e => set('crm_max_concurrency', e.target.value)}
              />
            </Field>
          </div>

          {/* Test connection */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onTestCrm}
              disabled={testing || !form.crm_base_url}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {testing
                ? <><Loader2 size={13} className="spin" /> Testing…</>
                : <><Wifi size={13} /> Test connection</>}
            </button>

            {testResult && (
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6,
                color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
                fontSize: 13,
              }}>
                {testResult.ok
                  ? <><CheckCircle2 size={14} /> Connected — {testResult.latency_ms}ms</>
                  : <><XCircle size={14} /> {testResult.error || `HTTP ${testResult.status}`}</>}
              </span>
            )}
          </div>
        </Section>

        {/* ── Company / Manager Details ───────────────────── */}
        <Section
          icon={<Building2 size={16} />}
          title="Company Details"
          subtitle="Shown in the portal header, PDF statements, and agent-facing emails"
          style={{ marginTop: 'var(--space-6)' }}
        >
          <Field label="Company Name">
            <input
              type="text"
              className="input"
              placeholder="BB Corp"
              value={form.company_name ?? ''}
              onChange={e => set('company_name', e.target.value)}
            />
          </Field>

          <Field label="Portal Title" hint="Displayed in the sidebar and browser tab">
            <input
              type="text"
              className="input"
              placeholder="Agent Portal"
              value={form.portal_title ?? ''}
              onChange={e => set('portal_title', e.target.value)}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
            <Field label="Support Email">
              <input
                type="email"
                className="input"
                placeholder="support@bbcorp.trade"
                value={form.company_email ?? ''}
                onChange={e => set('company_email', e.target.value)}
              />
            </Field>
            <Field label="Support Phone">
              <input
                type="tel"
                className="input"
                placeholder="+1 234 567 8900"
                value={form.company_phone ?? ''}
                onChange={e => set('company_phone', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Website URL">
            <input
              type="url"
              className="input"
              placeholder="https://bbcorp.trade"
              value={form.company_website ?? ''}
              onChange={e => set('company_website', e.target.value)}
            />
          </Field>
        </Section>

        {/* ── MT5 Bridge ──────────────────────────────────── */}
        <Section
          icon={<Server size={16} />}
          title="MT5 Manager API"
          subtitle="Credentials the MT5 bridge uses to connect to the broker. Save, then click Reconnect to apply."
          style={{ marginTop: 'var(--space-6)' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-4)' }}>
            <Field label="MT5 Server" hint="Manager-API host (e.g. mt5.bbcorp.trade)">
              <input
                type="text"
                className="input"
                placeholder="mt5.example.com"
                value={form.mt5_server ?? ''}
                onChange={e => set('mt5_server', e.target.value)}
              />
            </Field>
            <Field label="Port" hint="Usually 443">
              <input
                type="text"
                className="input"
                placeholder="443"
                value={form.mt5_port ?? ''}
                onChange={e => set('mt5_port', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Manager Login" hint="Numeric MT5 manager account ID">
            <input
              type="text"
              className="input"
              placeholder="1095"
              value={form.mt5_login ?? ''}
              onChange={e => set('mt5_login', e.target.value)}
            />
          </Field>

          <Field label="Manager Password" hint="Stored encrypted; only the bridge reads it">
            <div style={{ position: 'relative' }}>
              <input
                type={showPwd ? 'text' : 'password'}
                className="input"
                placeholder="Enter password…"
                value={form.mt5_password ?? ''}
                onChange={e => set('mt5_password', e.target.value)}
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                  display: 'flex', alignItems: 'center',
                }}
                aria-label={showPwd ? 'Hide password' : 'Show password'}
              >
                {showPwd ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onTestMt5}
              disabled={mt5Testing}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {mt5Testing
                ? <><Loader2 size={13} className="spin" /> Checking…</>
                : <><Wifi size={13} /> Check bridge status</>}
            </button>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onReconnectMt5}
              disabled={mt5Reconnecting || !form.mt5_server || !form.mt5_login}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {mt5Reconnecting
                ? <><Loader2 size={13} className="spin" /> Reconnecting…</>
                : <><RefreshCw size={13} /> Save &amp; reconnect</>}
            </button>

            {mt5TestResult && (
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6,
                color: mt5TestResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
                fontSize: 13,
              }}>
                {mt5TestResult.ok
                  ? <><CheckCircle2 size={14} /> {mt5TestResult.mt5_connected ? 'MT5 connected' : (mt5TestResult.message || 'OK')} {mt5TestResult.latency_ms != null && `(${mt5TestResult.latency_ms}ms)`}</>
                  : <><XCircle size={14} /> {mt5TestResult.error || mt5TestResult.init_error || (mt5TestResult.bridge_running === false ? 'Bridge unreachable' : 'Not connected')}</>}
              </span>
            )}
          </div>
        </Section>

        {/* ── Save bar ───────────────────────────────────── */}
        <div style={{
          marginTop: 'var(--space-6)',
          paddingTop: 'var(--space-4)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
        }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {saving
              ? <><Loader2 size={14} className="spin" /> Saving…</>
              : <><Save size={14} /> Save settings</>}
          </button>

          {notice && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6,
              color: notice.kind === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
              fontSize: 13,
            }}>
              {notice.kind === 'success'
                ? <CheckCircle2 size={14} />
                : <XCircle size={14} />}
              {notice.text}
            </span>
          )}
        </div>
      </form>

      {/* ── Agent Portal Access ───────────────────────────────────────────
          Global toggles for what every agent can see in their portal sidebar.
          Affects ALL users with role='agent'. Backend gates the routes too,
          so disabled pages return 403 even if a user knows the URL. */}
      <AgentPortalAccessCard />
    </div>
  );
}

function AgentPortalAccessCard() {
  const { data, loading, refetch } = useApi('/api/admin/settings/agent-permissions', {}, []);
  const [save, { loading: saving }] = useMutation();
  const [draft, setDraft] = useState({});

  // Sync draft from server data when it loads / refetches.
  useEffect(() => {
    if (!data?.toggles) return;
    const next = {};
    for (const t of data.toggles) next[t.key] = t.enabled;
    setDraft(next);
  }, [data]);

  const dirty = data?.toggles?.some(t => draft[t.key] !== t.enabled);

  async function onSave() {
    try {
      await save('/api/admin/settings/agent-permissions', {
        method: 'PUT',
        body: { toggles: draft },
      });
      toast.success('Agent portal access updated. Changes apply on the agent\'s next page load.');
      refetch();
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    }
  }

  return (
    <section
      style={{
        marginTop: 'var(--space-6)',
        padding: 'var(--space-5)',
        background: 'var(--bg-elev-1)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <ShieldCheck size={16} />
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Agent portal access</h2>
      </header>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 'var(--space-4)' }}>
        Toggle which pages all agents see in their portal sidebar. Disabling a page hides the
        nav item AND blocks the underlying API route (403 for direct URL access). Disabling does
        NOT pause data collection — commissions, deals, and contacts keep flowing in the background.
        Re-enabling restores access with full history.
      </p>

      {loading || !data ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.toggles.map(t => {
              const enabled = draft[t.key] ?? t.enabled;
              return (
                <label
                  key={t.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 6,
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: enabled ? 'color-mix(in srgb, var(--success) 8%, transparent)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setDraft(d => ({ ...d, [t.key]: e.target.checked }))}
                    style={{ width: 18, height: 18 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{t.label}</div>
                    <div className="muted small">
                      {enabled ? 'Visible to all agents' : 'Hidden from sidebar · API route returns 403'}
                    </div>
                  </div>
                  <code className="mono small muted">{t.key}</code>
                </label>
              );
            })}
          </div>

          <div style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={saving || !dirty}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {saving
                ? <><Loader2 size={14} className="spin" /> Saving…</>
                : <><Save size={14} /> {dirty ? 'Save access toggles' : 'Saved'}</>}
            </button>
            {dirty && <span className="muted small">Unsaved changes</span>}
          </div>
        </>
      )}
    </section>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

function Section({ icon, title, subtitle, children, style }) {
  return (
    <div className="card" style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-4)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--space-1)' }}>
        <span style={{ color: 'var(--accent)' }}>{icon}</span>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
      </div>
      {subtitle && <p className="muted" style={{ fontSize: 13, marginBottom: 'var(--space-4)' }}>{subtitle}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
      {children}
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );
}
