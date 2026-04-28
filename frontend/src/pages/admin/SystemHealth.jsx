import { useSearchParams } from 'react-router-dom';
import { Activity, ArrowLeftRight, FileText } from 'lucide-react';

import Mt5SyncHealth from './Mt5SyncHealth.jsx';
import Reconciliation from './Reconciliation.jsx';
import DataFlowDocs from './DataFlowDocs.jsx';

/**
 * Admin — System Health (unified)
 *
 * Single page merging three previously-separate admin tools that all answered
 * variations of "is the data pipeline OK and are its outputs correct?":
 *
 *   Pipeline       — MT5 bridge gate, engine cycles, deal cache, snapshot settings
 *                    (the old /admin/mt5-sync page).
 *   Reconciliation — engine $ vs MT5 $ drift per agent / per login
 *                    (the old /admin/reconciliation page).
 *   Docs           — plain-English data-flow reference
 *                    (the old /admin/data-flow page).
 *
 * Each tab is rendered by the same component that used to live on its own
 * page — zero functional change, same URLs (via legacy redirects in App.jsx)
 * still reach the right content.
 *
 * Tab state is kept in `?tab=...` so bookmarks survive and old URLs can
 * redirect cleanly (e.g. /admin/reconciliation → /admin/system-health?tab=reconciliation).
 */

const TABS = [
  { id: 'pipeline',       label: 'Pipeline',       icon: Activity,       Component: Mt5SyncHealth },
  { id: 'reconciliation', label: 'Reconciliation', icon: ArrowLeftRight, Component: Reconciliation },
  { id: 'docs',           label: 'Docs',           icon: FileText,       Component: DataFlowDocs },
];

export default function SystemHealth() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = TABS.some(t => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'pipeline';

  function setTab(id) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  }

  const ActiveComponent = (TABS.find(t => t.id === active) || TABS[0]).Component;

  return (
    <div>
      <div className="tab-row" style={{ marginBottom: 'var(--space-3)' }}>
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              className={`tab-btn ${active === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={12} style={{ verticalAlign: -1, marginRight: 6 }} />
              {t.label}
            </button>
          );
        })}
      </div>

      <ActiveComponent />
    </div>
  );
}
