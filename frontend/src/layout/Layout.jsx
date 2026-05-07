import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMutation } from '../hooks/useApi.js';
import { toast } from '../components/ui/toast.js';
import {
  LayoutDashboard, GitBranch, LineChart, Users, BookText, Package,
  DollarSign, UsersRound, Building2, FolderTree, UserCog, ScrollText,
  LogOut, Menu, X, Activity, ClipboardList, BookOpen, Settings, KeyRound,
  Shield,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import NotificationsBell from '../components/NotificationsBell.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Button from '../components/ui/Button.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import CrmGateStatus from '../components/admin/CrmGateStatus.jsx';
import ActiveJobsChip from '../components/admin/ActiveJobsChip.jsx';

/**
 * App shell — responsive.
 *   ≥ 1024px : left sidebar + main content (the classic dashboard layout)
 *   < 1024px : sidebar slides off-screen; a compact top bar shows with a
 *              hamburger toggle. Tapping hamburger slides the sidebar back in
 *              with a backdrop that dismisses on tap.
 *
 * The sidebar auto-closes whenever the route changes (so tapping a nav item
 * on mobile dismisses the drawer).
 */

// `requires` — permission key gating the nav item. Items without `requires`
// are visible to anyone with portal.access. The Layout filters based on the
// user's effective permissions (resolved server-side from role + overrides).
const AGENT_NAV = [
  { to: '/dashboard',        label: 'Dashboard',        icon: LayoutDashboard },
  { to: '/trading-accounts', label: 'Trading Accounts', icon: LineChart },
  { to: '/network',          label: 'My Network',       icon: Users },
  { to: '/summary',          label: 'Summary',          icon: BookText,    requires: 'portal.summary.view' },
  { to: '/commission-tree',  label: 'Commission Tree',  icon: GitBranch,   requires: 'portal.commission_tree.view' },
  { to: '/commissions',      label: 'Commissions',      icon: DollarSign,  requires: 'portal.commissions.view' },
];

// Admin nav — grouped into four sections so the relationship between pages
// is visible at a glance. Onboarding (set things up) → People (the day-to-day
// agent / commission work) → Operations (run / monitor) → System (config + audit).
const ADMIN_NAV_GROUPS = [
  {
    heading: 'Onboarding',
    items: [
      { to: '/admin/import-agents',   label: 'Import Agents',  icon: UsersRound },
      { to: '/admin/products',        label: 'Products',       icon: Package },
    ],
  },
  {
    heading: 'People',
    items: [
      { to: '/admin/agents',          label: 'Agent Network',  icon: FolderTree },
      { to: '/admin/commission-tree', label: 'Commission Tree', icon: GitBranch },
      { to: '/admin/agent-summary',   label: 'Agent Summary',  icon: ClipboardList },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { to: '/admin/users',           label: 'Staff Users',    icon: UserCog },
      { to: '/admin/system-health',   label: 'System Health',  icon: Activity },
    ],
  },
  {
    heading: 'System',
    items: [
      { to: '/admin/audit-log',       label: 'Audit Log',      icon: ScrollText },
      { to: '/admin/docs',            label: 'Docs',           icon: BookOpen },
      { to: '/admin/settings',        label: 'Settings',       icon: Settings },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const perms = user?.permissions || [];
  const isAgent = user?.is_agent;
  const isAdmin = perms.includes('portal.admin');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [showPrivacy, setShowPrivacy]   = useState(false);

  // Auto-close drawer on route change (so tapping a nav item dismisses it)
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Esc closes the drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    // Prevent body scroll while drawer is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <div className={`app-shell ${drawerOpen ? 'drawer-open' : ''}`}>
      {/* Mobile top bar — hidden at desktop via CSS */}
      <div className="mobile-topbar">
        <button
          type="button"
          className="mobile-topbar-btn"
          onClick={() => setDrawerOpen(v => !v)}
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <div className="mobile-topbar-brand">
          <div className="brand-mark" style={{ width: 28, height: 28, fontSize: 11 }}>AP</div>
          <span>Agent Portal</span>
        </div>
        {isAgent && <NotificationsBell />}
      </div>

      {/* Backdrop that appears on mobile when drawer is open. Clicking it closes. */}
      <div
        className="sidebar-backdrop"
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AP</div>
          <div className="brand-text">
            <div className="brand-title">Agent Portal</div>
            <div className="brand-sub muted">{isAdmin && !isAgent ? 'Admin console' : 'IB management'}</div>
          </div>
        </div>

        {/* Search / command palette trigger — Cmd/Ctrl+K opens it globally too */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <CommandPalette />
        </div>

        <nav className="nav">
          {isAgent && (
            <>
              <div className="nav-heading">Portal</div>
              {AGENT_NAV
                .filter(item => !item.requires || perms.includes(item.requires) || isAdmin)
                .map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <Icon size={16} strokeWidth={1.75} className="nav-icon" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </>
          )}

          {isAdmin && ADMIN_NAV_GROUPS.map(group => (
            <div key={group.heading} className="nav-group">
              <div className="nav-heading">{group.heading}</div>
              {group.items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <Icon size={16} strokeWidth={1.75} className="nav-icon" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {isAdmin && <ActiveJobsChip />}
          {isAdmin && <CrmGateStatus />}
          <div className="user-chip">
            <div className="user-initial">{(user?.name || '?')[0].toUpperCase()}</div>
            <div className="user-lines">
              <div className="user-name">{user?.name || '—'}</div>
              <div className="user-email muted">{user?.email}</div>
            </div>
            {isAgent && <NotificationsBell />}
          </div>
          <div className="sidebar-actions" style={{ flexWrap: 'wrap' }}>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              icon={<KeyRound size={14} />}
              onClick={() => setShowChangePw(true)}
              title="Change your password"
            >
              Password
            </Button>
            {isAgent && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Shield size={14} />}
                onClick={() => setShowPrivacy(true)}
                title="Control whether your parent agent can see your client names"
              >
                Privacy
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<LogOut size={14} />} onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </aside>
      {showChangePw && (
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      )}
      {showPrivacy && (
        <PrivacySettingsModal onClose={() => setShowPrivacy(false)} />
      )}

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Self-service password change modal. Opens from the sidebar footer "Password"
 * button. Calls POST /api/portal/me/change-password — the route validates the
 * current password before applying the new one and writes an audit log entry.
 */
function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [submit, { loading }] = useMutation();

  async function onSubmit(e) {
    e.preventDefault();
    if (next.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    if (next !== confirm) { toast.error('New passwords do not match'); return; }
    if (next === current) { toast.error('New password must differ from current'); return; }
    try {
      await submit('/api/portal/me/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      });
      toast.success('Password changed. Use it next time you sign in.');
      onClose();
    } catch (err) {
      if (err.status === 401) {
        toast.error('Current password is incorrect');
      } else {
        toast.error(err.message || 'Could not change password');
      }
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <form onSubmit={onSubmit} className="card" style={{ width: '100%', maxWidth: 400, margin: 0 }}>
        <div className="card-header">
          <h2 style={{ margin: 0 }}>Change password</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>Cancel</button>
        </div>
        <div className="pad">
          <label className="field">
            <span>Current password</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                autoFocus
                type={showCurrent ? 'text' : 'password'}
                className="input"
                value={current}
                onChange={e => setCurrent(e.target.value)}
                required
                style={{ flex: 1 }}
              />
              <button type="button" className="btn ghost small" onClick={() => setShowCurrent(s => !s)}>
                {showCurrent ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <label className="field">
            <span>New password (min 8 chars)</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showNext ? 'text' : 'password'}
                className="input"
                value={next}
                onChange={e => setNext(e.target.value)}
                minLength={8}
                required
                style={{ flex: 1 }}
              />
              <button type="button" className="btn ghost small" onClick={() => setShowNext(s => !s)}>
                {showNext ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <label className="field">
            <span>Confirm new password</span>
            <input
              type={showNext ? 'text' : 'password'}
              className="input"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              minLength={8}
              required
            />
          </label>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn primary"
              disabled={loading || next.length < 8 || next !== confirm || !current}
            >
              {loading ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * Privacy settings modal — single toggle for whether the agent's parent
 * (the agent directly above them in the hierarchy) can see the names of
 * their clients in views like Summary and Commissions.
 *
 * Default is OFF (private). Flipping it ON only affects the parent's
 * view; admin views always see full names. Audit-logged.
 */
function PrivacySettingsModal({ onClose }) {
  const [enabled, setEnabled] = useState(null);  // null while loading
  const [loading, setLoading] = useState(true);
  const [save, { loading: saving }] = useMutation();

  useEffect(() => {
    (async () => {
      try {
        const { api } = await import('../api.js');
        const me = await api('/api/portal/me');
        setEnabled(me?.share_client_names_with_parent === true);
      } catch (err) {
        toast.error(err.message || 'Failed to load privacy setting');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function commit(next) {
    setEnabled(next);  // optimistic
    try {
      await save('/api/portal/me/privacy', {
        method: 'PATCH',
        body: { share_client_names_with_parent: next },
      });
      toast.success(next ? 'Name-sharing enabled' : 'Name-sharing disabled');
    } catch (err) {
      setEnabled(!next);  // revert
      toast.error(err.message || 'Failed to update');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={18} /> Privacy
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="muted small" style={{ margin: 0 }}>
            By default, when your parent agent looks at their <b>Summary</b> or
            <b> Commissions</b> page, they see the <i>volumes</i>, <i>commissions</i>,
            and <i>MT5 login numbers</i> of your clients — but <b>not their names</b>.
            Their accounts are still counted in your parent's totals; only the
            personal identifying info (name, email) is hidden.
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            If you trust your parent agent enough to expose your clients'
            names to them too, enable the toggle below. You can flip it off
            again any time.
          </p>

          <label
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: 14, border: '1px solid var(--border)',
              borderRadius: 8, cursor: loading || saving ? 'wait' : 'pointer',
              background: enabled ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
            }}
          >
            <input
              type="checkbox"
              checked={enabled === true}
              disabled={loading || saving || enabled === null}
              onChange={(e) => commit(e.target.checked)}
              style={{ width: 18, height: 18, marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>
                Share my clients' names with my parent agent
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>
                Default: off. When off, your parent sees row labels like
                "MT5 #57755" instead of client names.
              </div>
            </div>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
