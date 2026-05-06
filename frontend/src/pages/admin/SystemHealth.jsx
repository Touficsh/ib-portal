import { useSearchParams } from 'react-router-dom';
import { Activity, ArrowLeftRight } from 'lucide-react';

import Mt5SyncHealth from './Mt5SyncHealth.jsx';
import Reconciliation from './Reconciliation.jsx';

/**
 * Admin — System Health (unified)
 *
 * Single page merging two admin tools that answer "is the data pipeline OK
 * and are its outputs correct?":
 *
 *   Pipeline       — MT5 bridge gate, engine cycles, deal cache, snapshot settings.
 *   Reconciliation — engine $ vs MT5 $ drift per agent / per login.
 *
 * The old "Docs" tab (DataFlowDocs.jsx) was redundant with the dedicated
 * /admin/docs page (which renders ARCHITECTURE.md, DATA_FLOW.md, etc. from
 * disk). Removed from the tab list; ?tab=docs URLs now redirect to /admin/docs
 * via App.jsx so old bookmarks still work.
 *
 * Tab state is kept in `?tab=...` so bookmarks survive and old URLs can
 * redirect cleanly (e.g. /admin/reconciliation → /admin/system-health?tab=reconciliation).
 */

const TABS = [
  { id: 'pipeline',       label: 'Pipeline',       icon: Activity,       Component: Mt5SyncHealth },
  { id: 'reconciliation', label: 'Reconciliation', icon: ArrowLeftRight, Component: Reconciliation },
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
