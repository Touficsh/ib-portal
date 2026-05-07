import { useState } from 'react';
import {
  Building2, Users, RefreshCw, CheckCircle2, Circle, ArrowRight,
  UserPlus, Link2, GitBranch, AlertCircle, ChevronDown, ChevronRight, KeyRound, Copy,
  Wand2, Zap, Activity, XCircle, AlertTriangle, RotateCcw, X,
} from 'lucide-react';
import { useApi, useMutation, useAutoRefresh } from '../../hooks/useApi.js';
import Button from '../../components/ui/Button.jsx';
import Skeleton, { SkeletonRow } from '../../components/ui/Skeleton.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { toast, confirm } from '../../components/ui/toast.js';
import JobProgressModal from '../../components/JobProgressModal.jsx';
import LastUpdated from '../../components/LastUpdated.jsx';

/**
 * Admin — Import Agents (by branch)
 *
 * Multi-step flow designed for rolling out the portal to one branch at a time
 * (so each branch can be commission-configured before the next goes live):
 *
 *   1. Left panel: branch list with counts (total / pending / imported).
 *      Click a branch to expand its agents on the right.
 *   2. Right panel: per-agent table for the selected branch. Select individual
 *      agents, or use "Import all pending" to bulk-import the whole branch.
 *   3. Toolbar: refresh from x-dev CRM, re-link products, backfill parents.
 *
 * After a branch's agents are imported, the admin can head to /admin/agents to
 * configure their commission rates (same flow we used for Hadi's tree).
 */

function fmt(n) { return (n ?? 0).toLocaleString(); }

export default function ImportAgents() {
  const { data: branches, loading: branchesLoading, refetch: refetchBranches, dataAt: branchesAt } =
    useApi('/api/agents/importable/branches', {}, []);

  const [selectedBranch, setSelectedBranch] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showOnlyPending, setShowOnlyPending] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const { data: agents, loading: agentsLoading, refetch: refetchAgents } = useApi(
    selectedBranch
      ? `/api/agents/importable?branch=${encodeURIComponent(selectedBranch)}&limit=2000${showOnlyPending ? '&onlyPending=true' : ''}`
      : null,
    {},
    [selectedBranch, showOnlyPending]
  );

  // Auto-refresh both data sources on tab refocus + every 90s. The branch list
  // changes whenever someone imports a new agent (count goes up); the agents
  // list changes when imports complete in the background. 90s is fine here —
  // imports are rare events compared to commission/rate edits elsewhere.
  useAutoRefresh(refetchBranches, 90_000);
  useAutoRefresh(refetchAgents,   90_000);

  const [runImport,  { loading: importing }]   = useMutation();
  const [runSync,    { loading: syncing }]     = useMutation();
  const [runLinks,   { loading: linking }]     = useMutation();
  const [runBackfill,{ loading: backfilling }] = useMutation();
  const [runHeal,    { loading: healing }]     = useMutation();
  const [runFixAll,  { loading: fixingAll }]   = useMutation();
  const [runMt5Sync, { loading: mt5Syncing }]  = useMutation();
  const [runRetry,   { loading: retrying }]    = useMutation();
  const [runContactSync, { loading: contactSyncing }] = useMutation();

  // Latest import result — drives the post-import result card (green/yellow/red).
  // Holds the full response from /api/agents/import including auto_finish payload.
  const [lastImport, setLastImport] = useState(null);
  // Live progress modal — shown while an import is in flight, polls /api/admin/jobs/:id
  const [progressJobId, setProgressJobId] = useState(null);
  const [progressTitle, setProgressTitle] = useState('Working…');
  // Track per-agent retry states: { [agentId]: 'retrying' | 'ok' | 'no_config' | 'failed' }
  const [retryState, setRetryState] = useState({});

  function pickBranch(b) {
    setSelectedBranch(b);
    setSelectedIds(new Set());
  }

  function toggleId(id) {
    setSelectedIds(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  function toggleAllVisible() {
    if (!agents) return;
    const pending = agents.filter(a => !a.user_id).map(a => a.id);
    const allSelected = pending.length > 0 && pending.every(id => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(pending));
  }

  async function importBranch() {
    const branchSummary = branches.find(b => b.branch === selectedBranch);
    const pending = branchSummary?.pending || 0;
    if (pending === 0) {
      toast.info('No pending agents in this branch.');
      return;
    }
    const ok = await confirm(
      `Import all ${pending} pending agents in "${selectedBranch}"?\n\n` +
      `Step 1 — Create their portal logins\n` +
      `Step 2 — Sync their commission rates from CRM\n` +
      `Step 3 — Pull each agent's referred clients + leads + MT5 logins`,
      { confirmLabel: `Import ${pending}`, cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    // Pre-generate a jobId so the progress modal can poll it BEFORE the
    // request returns. Backend uses the same id (X-Job-Id header) so both
    // sides reference the same in-memory job state.
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle(`Importing "${selectedBranch}" branch (${pending} agents)…`);
    try {
      const r = await runImport('/api/agents/import', {
        method: 'POST',
        headers: { 'X-Job-Id': jobId },
        body: { branch: selectedBranch },
      });
      setLastImport(r);
      setRetryState({});
      // Keep the password toast for the rare first-import case, but the
      // result card below now carries all the other info.
      if (r.created > 0 && r.default_password) {
        toast.success(
          `Imported ${r.created} · default password: ${r.default_password}`,
          { duration: 15000 }
        );
      } else if (r.created > 0) {
        toast.success(`Imported ${r.created} · see details below`);
      } else {
        toast.info('No new agents — re-import of already-imported set');
      }
      refetchBranches();
      refetchAgents();
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(err.message || 'Import failed');
      setProgressJobId(null);  // close modal on error
    }
  }

  async function importSelected() {
    if (selectedIds.size === 0) return;
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle(`Onboarding ${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'}…`);
    try {
      const r = await runImport('/api/agents/import', {
        method: 'POST',
        headers: { 'X-Job-Id': jobId },
        body: { client_ids: Array.from(selectedIds) },
      });
      setLastImport(r);
      setRetryState({});
      if (r.created > 0) {
        toast.success(`Imported ${r.created} · see details below`);
      } else {
        toast.info('No new agents — those were already imported');
      }
      refetchBranches();
      refetchAgents();
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(err.message || 'Import failed');
      setProgressJobId(null);
    }
  }

  // Onboard = import the selected agent(s) + pull their referred contacts +
  // trading accounts in one shot. Scoped to JUST the newly imported agents
  // (server uses agentUserIds for the contact sync). Skips the contact-side
  // CRM call entirely if the import didn't create any new users.
  async function onboardSelected() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    const ok = await confirm(
      `Onboard ${count} agent${count === 1 ? '' : 's'}?\n\n` +
      `Step 1 — Import agent record(s) (~2 sec each)\n` +
      `Step 2 — Pull their referred contacts from CRM (~5 min, one-time scan)\n` +
      `Step 3 — Fetch each new contact's trading accounts (skips fresh ones)\n\n` +
      `All steps go through the CRM gate. Hit the Pause chip in the sidebar to stop within 10s.`,
      { confirmLabel: `Onboard ${count}`, cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle(`Onboarding ${count} agent${count === 1 ? '' : 's'} (with contacts)…`);
    try {
      const r = await runImport('/api/agents/import?withContacts=1', {
        method: 'POST',
        headers: { 'X-Job-Id': jobId },
        body: { client_ids: Array.from(selectedIds) },
      });
      setLastImport(r);
      setRetryState({});
      const cs = r.contact_sync;
      const csLine = cs
        ? cs.aborted
          ? ` · contact sync aborted: ${cs.abortReason}`
          : ` · pulled ${cs.contactsInserted ?? 0} new clients, ${cs.loginsFound ?? 0} MT5 logins`
        : '';
      if (r.created > 0) {
        toast.success(
          `Onboarded ${r.created} agent${r.created === 1 ? '' : 's'}${csLine} · default password: ${r.default_password || 'Portal@2026'}`,
          { duration: 15000 }
        );
      } else {
        toast.info(`No new agents — those were already imported${csLine}`);
      }
      refetchBranches();
      refetchAgents();
      setSelectedIds(new Set());
    } catch (err) {
      toast.error(err.message || 'Onboard failed');
      setProgressJobId(null);
    }
  }

  // Per-agent retry — called from the result card for any row in failed[].
  async function retryAgent(agentId, agentName) {
    setRetryState(s => ({ ...s, [agentId]: 'retrying' }));
    try {
      const r = await runRetry(`/api/agents/${agentId}/retry-post-import`, { method: 'POST' });
      const state = r.commission_levels?.ok
        ? (r.commission_levels.state === 'synced' ? 'ok' : 'no_config')
        : 'failed';
      setRetryState(s => ({ ...s, [agentId]: state }));
      if (state === 'ok')       toast.success(`${agentName} — synced (${r.commission_levels.groups} rate rows)`);
      else if (state === 'no_config') toast.info(`${agentName} — still no CRM config for this agent`);
      else                       toast.error(`${agentName} — ${r.commission_levels?.error || 'retry failed'}`);
    } catch (err) {
      setRetryState(s => ({ ...s, [agentId]: 'failed' }));
      toast.error(err.message || 'Retry failed');
    }
  }

  async function healBranchRates() {
    if (!selectedBranch) return;
    const ok = await confirm(
      `Heal commission rates for every imported agent in "${selectedBranch}"?\n\n` +
      `Any agent_product link currently at $0/lot will be bumped to:\n` +
      `  · the parent agent's rate (for sub-agents)\n` +
      `  · the product's max rate (for top-level agents)\n\n` +
      `Existing non-zero rates are preserved. You should then rebuild commissions in Reconciliation for the change to populate history.`,
      { confirmLabel: 'Heal rates', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await runHeal(
        `/api/agents/branch/${encodeURIComponent(selectedBranch)}/heal-rates`,
        { method: 'POST' }
      );
      toast.success(
        `Healed ${r.totalUpdated} rate${r.totalUpdated === 1 ? '' : 's'} across ${r.agents} agents in "${selectedBranch}".`,
        { duration: 8000 }
      );
      refetchBranches();
      if (selectedBranch) refetchAgents();
    } catch (err) {
      toast.error(err.message || 'Heal failed');
    }
  }

  // Pull individual contacts (and their MT5 trading accounts) from CRM.
  // Scope: if a branch is selected on the left, narrows to agents in that
  // branch; otherwise covers every imported agent across all branches.
  // Phase 2 (trading-accounts fetch) skips contacts synced within last 24h
  // so re-runs are cheap — only stale rows incur a CRM call.
  async function syncContactsFromCRM() {
    const scope = selectedBranch
      ? `agents in "${selectedBranch}" branch only`
      : `EVERY imported agent across all branches`;
    const ok = await confirm(
      `Pull individual contacts + their trading accounts from CRM for ${scope}?\n\n` +
      `What it does:\n` +
      `  · Pages through CRM /api/contacts (~272 pages, one full sweep)\n` +
      `  · Keeps only contacts whose connectedAgent matches your scoped imported agents\n` +
      `  · Inserts/updates them as clients (contact_type='individual')\n` +
      `  · Fetches trading accounts for any contact whose data is older than 24h\n\n` +
      `Cost: ~272 contacts-list calls + N trading-account calls (skips fresh ones).\n` +
      `Time: ~5 minutes.\n` +
      `Stop anytime: hit the CRM Pause chip in the sidebar — everything halts within ~10 seconds.`,
      { confirmLabel: selectedBranch ? `Sync "${selectedBranch}" contacts` : 'Sync all contacts', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle(selectedBranch ? `Syncing "${selectedBranch}" contacts…` : 'Syncing all contacts…');
    try {
      const r = await runContactSync('/api/sync/contacts/by-agent', {
        method: 'POST',
        headers: { 'X-Job-Id': jobId },
        body: {
          branchName: selectedBranch || null,
          maxPages: 300,
          maxTaCalls: 500,
          resume: true,
          taFreshnessHours: 24,
        },
      });
      if (r.aborted) {
        toast.error(
          `Contact sync aborted: ${r.abortReason}\n` +
          `Pages scanned: ${r.pagesScanned}, contacts inserted so far: ${r.contactsInserted}`,
          { duration: 12000 }
        );
      } else {
        toast.success(
          `Contact sync done — scope: ${r.scope} (${r.agentCount} agents).\n` +
          `Inserted: ${r.contactsInserted}, updated: ${r.contactsUpdated}\n` +
          `Trading accounts: ${r.tradingAccountsFetched} fetched, ${r.tradingAccountsSkippedFresh || 0} skipped (still fresh), ${r.loginsFound} MT5 logins found\n` +
          `${r.finalPage ? '✓ Full sweep complete' : `Stopped at page ${r.endPage} — re-run to continue from checkpoint`}`,
          { duration: 15000 }
        );
      }
      refetchBranches();
      if (selectedBranch) refetchAgents();
    } catch (err) {
      toast.error(err.message || 'Contact sync failed');
    }
  }

  async function fixAllImported() {
    const ok = await confirm(
      `Run the full healing pipeline across EVERY imported agent?\n\n` +
      `1. Sync product links from CRM\n` +
      `2. Heal rates on every branch (fills $0/lot slots with parent's rate or product max)\n` +
      `3. Rebuild ALL commissions (DELETE + recompute)\n\n` +
      `Takes a minute or two. Commission history will briefly show $0 while the rebuild runs, then repopulates. This does NOT sync MT5 logins — use "Sync MT5 logins" per-branch below if needed first.`,
      { confirmLabel: 'Fix all imported', cancelLabel: 'Cancel', variant: 'warning' }
    );
    if (!ok) return;
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle('Fix all imported — products + rates + rebuild commissions');
    try {
      const r = await runFixAll('/api/agents/fix-all-imported', { method: 'POST', headers: { 'X-Job-Id': jobId } });
      const rates = r.steps?.find(s => s.step === 'heal_rates');
      const prods = r.steps?.find(s => s.step === 'sync_agent_products');
      toast.success(
        `Healing started. Products linked: ${prods?.created ?? 0}, rates updated: ${rates?.updated ?? 0} across ${rates?.agents ?? 0} agents. Commission rebuild running in background.`,
        { duration: 12000 }
      );
      refetchBranches();
      if (selectedBranch) refetchAgents();
    } catch (err) {
      toast.error(err.message || 'Fix-all failed');
    }
  }

  async function syncMt5LoginsForBranch() {
    if (!selectedBranch) return;
    const ok = await confirm(
      `Sync MT5 login numbers for every client in "${selectedBranch}" from x-dev's CRM?\n\n` +
      `Pulls trading-account records for each never-synced client. ` +
      `Runs with 8 concurrent CRM calls so a 500-client branch finishes in ~90 seconds.\n\n` +
      `After this completes, run "Fix all imported" to heal rates and rebuild commissions.`,
      { confirmLabel: 'Sync MT5 logins', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await runMt5Sync(
        `/api/sync/trading-accounts/branch/${encodeURIComponent(selectedBranch)}`,
        { method: 'POST' }
      );
      toast.success(
        `"${selectedBranch}": ${r.withLogins} clients with logins · ${r.withoutLogins} without · ${r.errors} errors (of ${r.eligible} eligible)`,
        { duration: 10000 }
      );
      refetchBranches();
      if (selectedBranch) refetchAgents();
    } catch (err) {
      toast.error(err.message || 'MT5 sync failed');
    }
  }

  async function runPostImport(kind) {
    const actions = {
      sync:     { label: 'Refresh agents from x-dev CRM',    mutator: runSync,    url: '/api/sync/agents' },
      links:    { label: 'Sync product links from CRM',      mutator: runLinks,   url: '/api/agents/sync-products-from-crm' },
      backfill: { label: 'Backfill parent links from CRM',   mutator: runBackfill, url: '/api/agents/backfill-parents' },
    };
    const a = actions[kind];
    const jobId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
    setProgressJobId(jobId);
    setProgressTitle(a.label);
    try {
      const r = await a.mutator(a.url, { method: 'POST', headers: { 'X-Job-Id': jobId } });
      toast.success(`${a.label} — done.${r.created ? ` created ${r.created}` : ''}${r.updated ? ` · updated ${r.updated}` : ''}`);
      refetchBranches();
      if (selectedBranch) refetchAgents();
    } catch (err) {
      toast.error(err.message || `${a.label} failed`);
      setProgressJobId(null);
    }
  }

  const totalAgents   = (branches || []).reduce((s, b) => s + b.total_agents, 0);
  const totalImported = (branches || []).reduce((s, b) => s + b.imported, 0);
  const totalPending  = (branches || []).reduce((s, b) => s + b.pending, 0);

  const selectedBranchSummary = branches?.find(b => b.branch === selectedBranch);

  // Apply client-side search filter on top of the server-side onlyPending filter.
  // Search matches name OR email (case-insensitive). Empty query → no filtering.
  const allAgents = agents || [];
  const q = searchQuery.trim().toLowerCase();
  const visibleAgents = q.length === 0
    ? allAgents
    : allAgents.filter(a =>
        (a.name || '').toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        (a.id || '').toLowerCase().includes(q)
      );
  const pendingInView = visibleAgents.filter(a => !a.user_id).length;
  const selectedPendingInView = visibleAgents
    .filter(a => !a.user_id && selectedIds.has(a.id))
    .length;
  const allVisibleSelected = pendingInView > 0 && selectedPendingInView === pendingInView;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Import agents</h1>
          <p className="muted">
            Roll out the portal branch-by-branch. Click a branch on the left, review its
            agents, then import the whole branch or just the ones you pick.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <LastUpdated dataAt={branchesAt} loading={branchesLoading} />
          {/* Primary daily action — pulls newly added CRM agents into the
              importable pool. Stays at top level because every fresh admin
              clicks this first to populate the page. */}
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={syncing}
                  onClick={() => runPostImport('sync')}
                  title="Pull the latest agent list from x-dev CRM into the local mirror. Run this if you can't find a newly added CRM agent in the list below.">
            Refresh from CRM
          </Button>

          {/* Maintenance / recovery actions — collapsed into a dropdown so
              they don't clutter the daily flow. Native <details> for zero deps. */}
          <details className="tools-menu">
            <summary className="btn ghost small" title="Recovery & bulk maintenance actions">
              Tools ▾
            </summary>
            <div className="tools-menu-panel">
              <button type="button" className="tools-menu-item"
                      disabled={contactSyncing}
                      onClick={(e) => { e.target.closest('details').open = false; syncContactsFromCRM(); }}
                      title={selectedBranch
                        ? `Pull contacts + trading accounts for agents in "${selectedBranch}" only.`
                        : 'Pull contacts + trading accounts for ALL imported agents.'}>
                <Users size={14} />
                <div>
                  <div className="tools-menu-title">{selectedBranch ? `Sync "${selectedBranch}" contacts` : 'Sync all contacts'}</div>
                  <div className="tools-menu-desc muted small">{contactSyncing ? 'Running…' : 'Pull contacts + trading accounts. Skips fresh.'}</div>
                </div>
              </button>
              <button type="button" className="tools-menu-item"
                      disabled={fixingAll}
                      onClick={(e) => { e.target.closest('details').open = false; fixAllImported(); }}
                      title="Heal commission rates and rebuild all commission history. Use if amounts look wrong.">
                <Zap size={14} />
                <div>
                  <div className="tools-menu-title">Fix all imported</div>
                  <div className="tools-menu-desc muted small">{fixingAll ? 'Running…' : 'Heal rates + rebuild commissions.'}</div>
                </div>
              </button>
              <button type="button" className="tools-menu-item"
                      disabled={linking}
                      onClick={(e) => { e.target.closest('details').open = false; runPostImport('links'); }}
                      title="Re-read CRM product.agents[] and refresh agent_products links">
                <Link2 size={14} />
                <div>
                  <div className="tools-menu-title">Sync product links</div>
                  <div className="tools-menu-desc muted small">{linking ? 'Running…' : 'Refresh which agents hold which products.'}</div>
                </div>
              </button>
              <button type="button" className="tools-menu-item"
                      disabled={backfilling}
                      onClick={(e) => { e.target.closest('details').open = false; runPostImport('backfill'); }}
                      title="Scan agents and fill missing parent links from CRM (takes 3–8 min)">
                <GitBranch size={14} />
                <div>
                  <div className="tools-menu-title">Backfill parents</div>
                  <div className="tools-menu-desc muted small">{backfilling ? 'Running…' : 'Fix missing parent_agent_id links.'}</div>
                </div>
              </button>
            </div>
          </details>
        </div>
      </header>

      {/* Persistent banner: tells admins the default password every agent gets on import */}
      <div className="import-pw-banner">
        <div className="import-pw-icon"><KeyRound size={18} /></div>
        <div className="import-pw-body">
          <div className="import-pw-title">Default login for imported agents</div>
          <div className="import-pw-desc muted small">
            Every agent imported through this page gets the same starter password. Share it with them; they should change it after first login.
          </div>
        </div>
        <div className="import-pw-chip">
          <span className="mono">Portal@2026</span>
          <button
            type="button"
            className="import-pw-copy"
            title="Copy"
            onClick={async () => {
              await navigator.clipboard.writeText('Portal@2026');
              toast.success('Default password copied');
            }}
          ><Copy size={13} /></button>
        </div>
      </div>

      {/* Top-line counts across all branches */}
      <section className="stat-row">
        <div className="stat stat-accent">
          <div className="stat-header-row">
            <div className="stat-label">Agents in CRM</div>
            <div className="stat-icon"><Users size={14} /></div>
          </div>
          <div className="stat-value">{fmt(totalAgents)}</div>
          <div className="stat-sub muted">across {branches?.length || 0} branches</div>
        </div>
        <div className="stat stat-success">
          <div className="stat-header-row">
            <div className="stat-label">Already imported</div>
            <div className="stat-icon"><CheckCircle2 size={14} /></div>
          </div>
          <div className="stat-value">{fmt(totalImported)}</div>
          <div className="stat-sub muted">have a portal login</div>
        </div>
        <div className="stat stat-warn">
          <div className="stat-header-row">
            <div className="stat-label">Pending</div>
            <div className="stat-icon"><Circle size={14} /></div>
          </div>
          <div className="stat-value">{fmt(totalPending)}</div>
          <div className="stat-sub muted">ready to import</div>
        </div>
      </section>

      {/* 2-column layout: branches list on the left, selected-branch agents on the right */}
      <div className="import-grid">
        {/* Left: branch cards */}
        <aside className="import-branches">
          <div className="import-branches-header">
            <h2>Branches</h2>
            <span className="muted small">{branches?.length || 0} total</span>
          </div>

          {branchesLoading && (
            <div className="pad"><Skeleton lines={4} height={40} /></div>
          )}

          {!branchesLoading && branches?.length === 0 && (
            <EmptyState
              size="sm"
              icon={<Building2 size={24} />}
              title="No agents in CRM yet"
              description="Click Refresh from CRM above to pull them in."
            />
          )}

          <ul className="import-branch-list">
            {(branches || []).map(b => {
              const isSelected = selectedBranch === b.branch;
              const fullyImported = b.pending === 0 && b.total_agents > 0;
              return (
                <li key={b.branch}>
                  <button
                    type="button"
                    className={`import-branch-btn ${isSelected ? 'active' : ''}`}
                    onClick={() => pickBranch(b.branch)}
                  >
                    <div className="import-branch-icon">
                      {fullyImported ? <CheckCircle2 size={15} /> : <Building2 size={15} />}
                    </div>
                    <div className="import-branch-body">
                      <div className="import-branch-name">{b.branch}</div>
                      <div className="import-branch-counts">
                        <span className="muted small">{fmt(b.total_agents)} agents</span>
                        {b.pending > 0 && (
                          <span className="pill stage-lead import-branch-pill">{b.pending} pending</span>
                        )}
                        {fullyImported && (
                          <span className="pill stage-active import-branch-pill">done</span>
                        )}
                      </div>
                    </div>
                    {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Right: selected-branch agent list with bulk actions */}
        <main className="import-detail">
          {!selectedBranch && (
            <div className="card">
              <EmptyState
                icon={<Building2 size={28} />}
                title="Pick a branch to start"
                description="Select a branch from the list. You'll see its agents and can import them all at once or one at a time."
              />
            </div>
          )}

          {selectedBranch && (
            <div className="card">
              <div className="card-header">
                <div>
                  <h2>
                    <Building2 size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />
                    {selectedBranch}
                  </h2>
                  <p className="muted small">
                    {fmt(selectedBranchSummary?.total_agents)} agents ·
                    {' '}{fmt(selectedBranchSummary?.imported)} imported ·
                    <b style={{ color: 'var(--warn)' }}> {fmt(selectedBranchSummary?.pending)} pending</b>
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(selectedBranchSummary?.imported || 0) > 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Activity size={14} />}
                        loading={mt5Syncing}
                        onClick={syncMt5LoginsForBranch}
                        title="Pull MT5 login numbers for every never-synced client in this branch from x-dev's CRM. Runs 8 concurrent CRM calls — a 500-client branch finishes in ~90s. Required before commissions can be computed for this branch."
                      >
                        Sync MT5 logins
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Wand2 size={14} />}
                        loading={healing}
                        onClick={healBranchRates}
                        title="For every imported agent in this branch, any product currently at $0/lot is bumped to the parent's rate (or product max for top-level). Existing non-zero rates are preserved."
                      >
                        Heal rates
                      </Button>
                    </>
                  )}
                  {selectedIds.size > 0 && (
                    <>
                      <Button size="sm" variant="primary" icon={<Zap size={14} />} loading={importing}
                              onClick={onboardSelected}
                              title="Import the selected agents AND pull their referred contacts + MT5 trading accounts in one shot. ~5 min total. Stoppable via the CRM Pause chip.">
                        Onboard {selectedIds.size} selected
                      </Button>
                      <Button size="sm" variant="ghost" icon={<UserPlus size={14} />} loading={importing}
                              onClick={importSelected}
                              title="Import only the agent record (fast, no contacts). Use Onboard if you want their clients too.">
                        Import only
                      </Button>
                    </>
                  )}
                  {selectedIds.size === 0 && (
                    <Button size="sm" variant="ghost" icon={<ArrowRight size={14} />} loading={importing}
                            disabled={(selectedBranchSummary?.pending || 0) === 0}
                            onClick={importBranch}
                            title="Import all pending agents in this branch (no contact sync). For bulk branch onboarding use the Tools menu.">
                      Import all pending ({selectedBranchSummary?.pending || 0})
                    </Button>
                  )}
                </div>
              </div>

              <div className="pad" style={{ paddingBottom: 'var(--space-3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={showOnlyPending} onChange={e => setShowOnlyPending(e.target.checked)} />
                    <span>Only show pending</span>
                  </label>
                  <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Search by name, email, or ID…"
                      className="input"
                      style={{ width: '100%', padding: '6px 28px 6px 10px', fontSize: 13 }}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        title="Clear search"
                        style={{
                          position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--muted)', padding: 2, display: 'flex', alignItems: 'center',
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {q.length > 0 && (
                    <span className="muted small">
                      {visibleAgents.length} of {allAgents.length} match
                    </span>
                  )}
                </div>
                <button type="button" className="btn ghost small" onClick={toggleAllVisible} disabled={pendingInView === 0}>
                  {allVisibleSelected ? 'Clear selection' : `Select all ${pendingInView} pending`}
                </button>
              </div>

              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Name</th>
                    <th>Email</th>
                    <th className="num">Referrals</th>
                    <th>Parent agent</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {agentsLoading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}
                  {!agentsLoading && visibleAgents.length === 0 && (
                    <tr><td colSpan="6" style={{ padding: 0 }}>
                      <EmptyState
                        size="sm"
                        icon={<CheckCircle2 size={22} />}
                        title={showOnlyPending ? 'No pending agents in this branch' : 'No agents in this branch'}
                        description={showOnlyPending ? 'Everyone here has been imported.' : 'Try Refresh from CRM.'}
                      />
                    </td></tr>
                  )}
                  {!agentsLoading && visibleAgents.map(a => {
                    const already = !!a.user_id;
                    return (
                      <tr key={a.id} style={already ? { opacity: 0.55 } : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            disabled={already}
                            checked={selectedIds.has(a.id)}
                            onChange={() => toggleId(a.id)}
                            aria-label={`Select ${a.name}`}
                          />
                        </td>
                        <td><b>{a.name}</b></td>
                        <td className="muted small">{a.email || <span className="muted">(no email — fallback used on import)</span>}</td>
                        <td className="num mono">{a.referral_count}</td>
                        <td className="small">{a.parent_agent_name || <span className="muted">top-level</span>}</td>
                        <td>
                          {already
                            ? <span className="pill stage-active"><CheckCircle2 size={10} style={{ verticalAlign: -1, marginRight: 3 }} />Imported</span>
                            : <span className="pill stage-lead">Pending</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Auto-finish result card — shows after an import with per-agent outcomes */}
          {lastImport && lastImport.created > 0 && lastImport.auto_finish && (
            <ImportResultCard
              result={lastImport}
              retryState={retryState}
              onRetry={retryAgent}
              onDismiss={() => setLastImport(null)}
              retrying={retrying}
            />
          )}

          {/* Post-import reference card — kept as a light footer so admins know
              these actions exist if the auto-finish chain couldn't complete. */}
          {selectedBranch && selectedBranchSummary?.imported > 0 && !lastImport && (
            <div className="card">
              <div className="card-header">
                <h2><AlertCircle size={15} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />After importing</h2>
                <span className="muted small">These steps run automatically; use the buttons only if auto-finish is skipped</span>
              </div>
              <div className="pad">
                <ol className="import-checklist">
                  <li>
                    <b>Commission rates</b> — <i>auto-pulled from xdev CRM</i> for every imported agent right after import.
                    Nothing to do manually if the CRM gate was healthy at import time.
                    If the chain was skipped (CRM paused), click <a href="/portal/admin/agents">Agents Tree</a> to
                    set rates manually or run <i>Sync commission levels</i>.
                  </li>
                  <li>
                    <b>Parent hierarchy</b> — <i>auto-verified</i> for newly imported agents.
                    Only run <i>Backfill parents</i> above if an agent was imported before their parent existed in the mirror.
                  </li>
                  <li>
                    <b>Product links</b> — only re-run if a new product was added to the CRM catalog after import.
                  </li>
                  <li>
                    <b>Agent login</b> — imported agents can sign in at <span className="mono">/portal/login</span> with their CRM email.
                    Share credentials with them out-of-band; the portal does not email them.
                  </li>
                </ol>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Live progress modal — opens during long imports/onboards. Polls
          /api/admin/jobs/:id every second and auto-closes 1.5s after success. */}
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

/**
 * Result card shown right under the agents table after a successful import.
 * Renders one of three visual tones:
 *   🟢 green  — every step succeeded
 *   🟡 yellow — succeeded but some agents have no CRM config (benign)
 *   🔴 red    — preflight skipped OR at least one agent failed to sync
 * Per-agent retry buttons live in the "failed" group.
 */
function ImportResultCard({ result, retryState, onRetry, onDismiss, retrying }) {
  const af = result.auto_finish;
  const ok        = af?.commission_levels?.ok        || [];
  const noConfig  = af?.commission_levels?.no_config || [];
  const failed    = af?.commission_levels?.failed    || [];
  const warnings  = af?.warnings                     || [];

  // Compute tone: red beats yellow beats green
  let tone = 'success';
  if (af?.state === 'skipped_gate_unhealthy' || failed.length > 0) tone = 'danger';
  else if (noConfig.length > 0 || warnings.length > 0)              tone = 'warn';

  const toneColors = {
    success: { border: 'var(--success)', bg: 'var(--success-soft)', icon: <CheckCircle2 size={16} color="var(--success)" /> },
    warn:    { border: 'var(--warn)',    bg: 'var(--warn-soft)',    icon: <AlertTriangle size={16} color="var(--warn)" /> },
    danger:  { border: 'var(--danger)',  bg: 'var(--danger-soft)',  icon: <XCircle size={16} color="var(--danger)" /> },
  }[tone];

  const headline = af?.state === 'skipped_gate_unhealthy'
    ? `Imported ${result.created} agents, but the auto-finish was skipped`
    : failed.length > 0
      ? `Imported ${result.created} agents — ${failed.length} need attention`
      : noConfig.length > 0
        ? `Imported ${result.created} agents — ${ok.length} synced, ${noConfig.length} have no CRM config`
        : `Imported ${result.created} agents — all rates synced`;

  return (
    <div className="card" style={{ borderLeft: `4px solid ${toneColors.border}`, background: toneColors.bg }}>
      <div className="card-header" style={{ background: 'transparent' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {toneColors.icon}
          <span>{headline}</span>
        </h2>
        <button
          type="button"
          className="btn ghost small"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <X size={12} /> Dismiss
        </button>
      </div>
      <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Summary line */}
        <div className="muted small">
          {result.branch && <><b>{result.branch}</b> · </>}
          Mode: <span className="mono">{result.mode || 'bulk'}</span> ·
          {' '}Created <b>{result.created}</b>, updated <b>{result.updated || 0}</b>, errors <b>{result.errors || 0}</b>
        </div>

        {/* Gate skipped banner */}
        {af.state === 'skipped_gate_unhealthy' && (
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--bg-elev-1)', border: '1px solid var(--border)' }}>
            <b>CRM gate not healthy — auto-finish skipped.</b>
            <div className="muted small" style={{ marginTop: 4 }}>
              The import itself succeeded, but commission-level sync was not run.
              Resume the CRM gate (sidebar chip), then re-click <i>Import</i> or
              click the individual agents' <i>Sync commission levels</i> button.
            </div>
            {af.preflight?.issues?.length > 0 && (
              <ul className="small muted" style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
                {af.preflight.issues.map((i, idx) => (
                  <li key={idx}>{i.message || i.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Parent backfill result — only show if we actually did anything */}
        {af.parent_backfill?.parents_set > 0 && (
          <div className="muted small">
            <GitBranch size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Hierarchy: fixed parent links for <b>{af.parent_backfill.parents_set}</b> agent(s) whose CRM referrer wasn't wired yet.
          </div>
        )}

        {/* OK agents */}
        {ok.length > 0 && (
          <ResultGroup
            tone="success"
            icon={<CheckCircle2 size={12} color="var(--success)" />}
            title={`${ok.length} agent${ok.length === 1 ? '' : 's'} synced with rates`}
            rows={ok.map(a => ({ key: a.agent_id, name: a.name, detail: `${a.groups} rate row${a.groups === 1 ? '' : 's'}` }))}
          />
        )}

        {/* No-config agents (benign info) */}
        {noConfig.length > 0 && (
          <ResultGroup
            tone="muted"
            icon={<AlertCircle size={12} color="var(--text-muted)" />}
            title={`${noConfig.length} agent${noConfig.length === 1 ? '' : 's'} have no CRM commission config`}
            hint="Not an error — these agents need someone to configure their commission levels in xdev first, then click Sync commission levels."
            rows={noConfig.map(a => ({ key: a.agent_id, name: a.name, detail: 'no config in CRM yet' }))}
          />
        )}

        {/* Failed agents with retry buttons */}
        {failed.length > 0 && (
          <ResultGroup
            tone="danger"
            icon={<XCircle size={12} color="var(--danger)" />}
            title={`${failed.length} agent${failed.length === 1 ? '' : 's'} failed to sync`}
            hint="Click Retry to re-run the sync for each agent. The original import is unaffected."
            rows={failed.map(a => {
              const rs = retryState[a.agent_id];
              const rowDetail =
                rs === 'retrying' ? <span className="muted">retrying…</span>
                : rs === 'ok'        ? <span style={{ color: 'var(--success)' }}><CheckCircle2 size={11} style={{ verticalAlign: -1 }} /> synced</span>
                : rs === 'no_config' ? <span className="muted">no CRM config</span>
                : rs === 'failed'    ? <span style={{ color: 'var(--danger)' }}>still failing</span>
                : <span className="muted small">{a.error || 'sync failed'}</span>;
              const rowAction = !rs || rs === 'failed' ? (
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={retrying}
                  onClick={() => onRetry(a.agent_id, a.name)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <RotateCcw size={11} /> Retry
                </button>
              ) : null;
              return { key: a.agent_id, name: a.name, detail: rowDetail, action: rowAction };
            })}
          />
        )}

        {/* Free-form warnings */}
        {warnings.length > 0 && (
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        {/* Default password surface — only on the very first import of a branch */}
        {result.default_password && (
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--bg-elev-2)', border: '1px dashed var(--border)' }}>
            <KeyRound size={12} style={{ verticalAlign: -1, marginRight: 6 }} />
            Default password for new agents: <span className="mono" style={{ fontWeight: 600 }}>{result.default_password}</span>
            <span className="muted small"> — share with each agent out-of-band.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultGroup({ title, hint, icon, tone, rows }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
        {icon} {title}
      </div>
      {hint && <div className="muted small" style={{ marginBottom: 6 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(r => (
          <div
            key={r.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 10px',
              borderRadius: 4,
              background: 'var(--bg-elev-1)',
              fontSize: 13,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.name}
            </span>
            <span className="small" style={{ flex: '0 0 auto' }}>{r.detail}</span>
            {r.action && <div style={{ flex: '0 0 auto' }}>{r.action}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
