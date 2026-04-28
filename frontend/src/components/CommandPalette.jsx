import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  LayoutDashboard, LineChart, Users, BookText, Package,
  DollarSign, UsersRound, Building2, FolderTree, UserCog, ScrollText,
  ArrowLeftRight, RefreshCw, Moon, Sun, LogOut, Search, History, FileText,
  GitBranch, Activity,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * Command palette (Cmd+K / Ctrl+K).
 *
 * Spotlight-style search over every page in the app, plus common actions.
 * Use-cases:
 *   - Jump to a page without touching the sidebar
 *   - Fire an action (Refresh MT5, Toggle theme, Sign out)
 *
 * Extensible: to add a new command, append to COMMANDS (or push dynamic
 * entries via the commands prop — future use for searching clients/agents).
 */

const KEY_OPENERS = (e) => (
  (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
);

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const perms = user?.permissions || [];
  const isAgent = user?.is_agent;
  const isAdmin = perms.includes('portal.admin');

  // Global Cmd/Ctrl+K shortcut
  useEffect(() => {
    const onKey = (e) => {
      if (KEY_OPENERS(e)) {
        e.preventDefault();
        setOpen(v => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function run(fn) {
    setOpen(false);
    setTimeout(fn, 80); // let the modal close before firing
  }

  const go = (to) => () => run(() => navigate(to));

  const PAGES_AGENT = [
    { label: 'Dashboard',        icon: LayoutDashboard, action: go('/dashboard') },
    { label: 'Trading Accounts', icon: LineChart,       action: go('/trading-accounts') },
    { label: 'My Network',       icon: Users,           action: go('/network') },
    { label: 'Summary',          icon: BookText,        action: go('/summary') },
    { label: 'Commissions',      icon: DollarSign,      action: go('/commissions') },
  ];

  const PAGES_ADMIN = [
    { label: 'Admin · Import Agents',  icon: UsersRound,    action: go('/admin/import-agents') },
    { label: 'Admin · Agent Network',  icon: FolderTree,    action: go('/admin/agents') },
    { label: 'Admin · Agent Summary',  icon: UsersRound,    action: go('/admin/agent-summary') },
    { label: 'Admin · Agent Commissions', icon: History,    action: go('/admin/agent-summary?tab=commissions') },
    { label: 'Admin · Commission Tree', icon: GitBranch,    action: go('/admin/commission-tree') },
    { label: 'Admin · Products',       icon: Package,       action: go('/admin/products') },
    { label: 'Admin · Staff Users',    icon: UserCog,       action: go('/admin/users') },
    { label: 'Admin · Audit Log',      icon: ScrollText,    action: go('/admin/audit-log') },
    { label: 'Admin · System Health',  icon: Activity,      action: go('/admin/system-health') },
    { label: 'Admin · Reconciliation', icon: ArrowLeftRight, action: go('/admin/system-health?tab=reconciliation') },
    { label: 'Admin · Data Flow docs', icon: FileText,       action: go('/admin/system-health?tab=docs') },
  ];

  // Action entries — each `action` must be a FUNCTION (a callback), not the
  // result of calling `run(...)`, or we'll infinite-loop during render.
  // "Refresh MT5 snapshot" is admin-only — agents see cached data and cannot
  // trigger a bridge refresh (the Refresh button on Summary is likewise hidden).
  const ACTIONS = [
    ...(isAdmin ? [{
      label: 'Refresh MT5 snapshot',
      icon: RefreshCw,
      action: () => run(() => navigate('/summary')),
      hint: 'Opens Summary · click Refresh MT5',
    }] : []),
    {
      label: 'Toggle theme',
      icon: document.documentElement.getAttribute('data-theme') === 'light' ? Moon : Sun,
      action: () => run(() => {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', cur);
        localStorage.setItem('crm.portal.theme', cur);
      }),
    },
    { label: 'Sign out', icon: LogOut, action: () => run(() => logout()) },
  ];

  if (!open) {
    return (
      <button
        type="button"
        className="cmd-trigger"
        onClick={() => setOpen(true)}
        title="Command menu (Ctrl+K)"
        aria-label="Open command menu"
      >
        <Search size={13} />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
    );
  }

  return (
    <>
      <div className="cmd-backdrop" onClick={() => setOpen(false)} />
      <Command
        label="Command menu"
        className="cmd-panel"
        shouldFilter
        loop
      >
        <div className="cmd-input-wrap">
          <Search size={16} className="cmd-input-icon" />
          <Command.Input placeholder="Search for a page or an action…" className="cmd-input" autoFocus />
          <kbd className="cmd-esc">Esc</kbd>
        </div>
        <Command.List className="cmd-list">
          <Command.Empty className="cmd-empty">No results.</Command.Empty>

          {isAgent && (
            <Command.Group heading="Portal" className="cmd-group">
              {PAGES_AGENT.map((c) => (
                <Command.Item key={c.label} value={c.label} onSelect={c.action} className="cmd-item">
                  <c.icon size={15} className="cmd-item-icon" />
                  <span>{c.label}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {isAdmin && (
            <Command.Group heading="Admin" className="cmd-group">
              {PAGES_ADMIN.map((c) => (
                <Command.Item key={c.label} value={c.label} onSelect={c.action} className="cmd-item">
                  <c.icon size={15} className="cmd-item-icon" />
                  <span>{c.label}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Actions" className="cmd-group">
            {ACTIONS.map((c) => (
              <Command.Item key={c.label} value={c.label} onSelect={c.action} className="cmd-item">
                <c.icon size={15} className="cmd-item-icon" />
                <span>{c.label}</span>
                {c.hint && <span className="cmd-item-hint">{c.hint}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </>
  );
}
