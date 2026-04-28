import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, GitBranch, LineChart, Users, BookText, Package,
  DollarSign, UsersRound, Building2, FolderTree, UserCog, ScrollText,
  LogOut, Menu, X, Activity, ClipboardList, BookOpen,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import NotificationsBell from '../components/NotificationsBell.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Button from '../components/ui/Button.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import CrmGateStatus from '../components/admin/CrmGateStatus.jsx';

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

const AGENT_NAV = [
  { to: '/dashboard',        label: 'Dashboard',        icon: LayoutDashboard },
  { to: '/trading-accounts', label: 'Trading Accounts', icon: LineChart },
  { to: '/network',          label: 'My Network',       icon: Users },
  { to: '/summary',          label: 'Summary',          icon: BookText },
  { to: '/commission-tree',  label: 'Commission Tree',  icon: GitBranch },
  { to: '/commissions',      label: 'Commissions',      icon: DollarSign },
];

const ADMIN_NAV = [
  { to: '/admin/import-agents',  label: 'Import Agents',   icon: UsersRound },
  // Unified "Agent Network" page replaces the old Hierarchy + Agents Tree pages.
  // It has a Compact / Detailed view toggle at the top.
  { to: '/admin/agents',         label: 'Agent Network',   icon: FolderTree },
  { to: '/admin/commission-tree', label: 'Commission Tree', icon: GitBranch },
  // Agent Summary now has two tabs (Summary + Commissions) — the former
  // Commission History page was folded in.
  { to: '/admin/agent-summary',  label: 'Agent Summary',   icon: ClipboardList },
  { to: '/admin/products',       label: 'Products',        icon: Package },
  { to: '/admin/users',          label: 'Staff Users',     icon: UserCog },
  { to: '/admin/audit-log',      label: 'Audit Log',       icon: ScrollText },
  // System Health now owns three tabs (Pipeline / Reconciliation / Docs).
  // MT5 Sync Health, Reconciliation, and Data Flow are all reachable here.
  { to: '/admin/system-health',  label: 'System Health',   icon: Activity },
  // In-portal docs — Operations Guide + Data Flow + Architecture rendered
  // live from the project's markdown files. So an admin can read "what
  // does this button do" without leaving the portal.
  { to: '/admin/docs',           label: 'Docs',            icon: BookOpen },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const perms = user?.permissions || [];
  const isAgent = user?.is_agent;
  const isAdmin = perms.includes('portal.admin');

  const [drawerOpen, setDrawerOpen] = useState(false);

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
              {AGENT_NAV.map(({ to, label, icon: Icon }) => (
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

          {isAdmin && (
            <>
              <div className="nav-heading">Admin</div>
              {ADMIN_NAV.map(({ to, label, icon: Icon }) => (
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
        </nav>

        <div className="sidebar-footer">
          {isAdmin && <CrmGateStatus />}
          <div className="user-chip">
            <div className="user-initial">{(user?.name || '?')[0].toUpperCase()}</div>
            <div className="user-lines">
              <div className="user-name">{user?.name || '—'}</div>
              <div className="user-email muted">{user?.email}</div>
            </div>
            {isAgent && <NotificationsBell />}
          </div>
          <div className="sidebar-actions">
            <ThemeToggle />
            <Button variant="ghost" size="sm" icon={<LogOut size={14} />} onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
