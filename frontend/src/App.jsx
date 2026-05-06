import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AuthProvider } from './auth/AuthContext.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import Login from './auth/Login.jsx';
import Layout from './layout/Layout.jsx';

// Eager: small + always-on-the-critical-path. Login + Layout + redirects
// must be in the initial bundle so the first paint isn't blocked on a
// lazy-load network round trip.
import NotFound from './pages/NotFound.jsx';

// Lazy: every route-level page is split into its own chunk and only fetched
// when an agent navigates to it. The combined admin bundle was ~400 KB
// gzipped before splitting; agents who only use the Dashboard page now load
// just the Dashboard chunk (~30 KB) on first visit. Admin pages stream in
// on first admin nav.
const Dashboard            = lazy(() => import('./pages/Dashboard.jsx'));
const TradingAccounts      = lazy(() => import('./pages/TradingAccounts.jsx'));
const Network              = lazy(() => import('./pages/Network.jsx'));
const SubAgentDetail       = lazy(() => import('./pages/SubAgentDetail.jsx'));
const CommissionTree       = lazy(() => import('./pages/CommissionTree.jsx'));
const Commissions          = lazy(() => import('./pages/Commissions.jsx'));
const Summary              = lazy(() => import('./pages/Summary.jsx'));
const AdminUsers           = lazy(() => import('./pages/admin/Users.jsx'));
const AdminProducts        = lazy(() => import('./pages/admin/Products.jsx'));
const AdminAgentNetwork    = lazy(() => import('./pages/admin/AgentNetwork.jsx'));
const AdminAgentDetail     = lazy(() => import('./pages/admin/AgentDetail.jsx'));
const AdminImportAgents    = lazy(() => import('./pages/admin/ImportAgents.jsx'));
const AdminAuditLog        = lazy(() => import('./pages/admin/AuditLog.jsx'));
const AdminCommissionTree  = lazy(() => import('./pages/admin/CommissionTree.jsx'));
const AdminSystemHealth    = lazy(() => import('./pages/admin/SystemHealth.jsx'));
const AdminAgentSummary    = lazy(() => import('./pages/admin/AgentSummary.jsx'));
const AdminDocs            = lazy(() => import('./pages/admin/Docs.jsx'));
const AdminSettings        = lazy(() => import('./pages/admin/Settings.jsx'));

// Tiny fallback while a chunk loads. Keeps the page from flashing blank.
function ChunkFallback() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: 240, color: 'var(--text-muted)', fontSize: 13,
    }}>
      Loading…
    </div>
  );
}

// Wrap a lazy component in <Suspense> at the route level so each route's
// chunk is fetched independently and other parts of the page (sidebar,
// header) remain interactive while it loads.
function lazyRoute(Component) {
  return <Suspense fallback={<ChunkFallback />}><Component /></Suspense>;
}

// Router is mounted under /portal/ (see vite.config.js `base`). React Router
// uses the <base href> implicitly via basename.
const router = createBrowserRouter(
  [
    { path: '/login', element: <Login /> },
    {
      path: '/',
      element: <RequireAuth><Layout /></RequireAuth>,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard',         element: lazyRoute(Dashboard) },
        { path: 'trading-accounts',  element: lazyRoute(TradingAccounts) },
        { path: 'network',           element: lazyRoute(Network) },
        // Backward-compat redirects — old URLs land on the right tab
        { path: 'clients',           element: <Navigate to="/network?tab=clients" replace /> },
        { path: 'sub-agents',        element: <Navigate to="/network?tab=subagents" replace /> },
        { path: 'sub-agents/:id',    element: lazyRoute(SubAgentDetail) },
        { path: 'commission-tree',   element: lazyRoute(CommissionTree) },
        { path: 'summary',           element: lazyRoute(Summary) },
        { path: 'commissions',       element: lazyRoute(Commissions) },
        // Admin routes — visible in sidebar only for users with portal.admin.
        // No extra route-level gate here; backend endpoints enforce the permission.
        { path: 'admin/users',          element: lazyRoute(AdminUsers) },
        { path: 'admin/products',       element: lazyRoute(AdminProducts) },
        { path: 'admin/agents',         element: lazyRoute(AdminAgentNetwork) },
        { path: 'admin/agents/:id',     element: lazyRoute(AdminAgentDetail) },
        // Backwards-compat redirect for the old /admin/hierarchy URL.
        // The Hierarchy page was merged into Agent Network (same route).
        { path: 'admin/hierarchy',      element: lazyRoute(AdminAgentNetwork) },
        { path: 'admin/import-agents',  element: lazyRoute(AdminImportAgents) },
        { path: 'admin/audit-log',      element: lazyRoute(AdminAuditLog) },
        { path: 'admin/commission-tree',    element: lazyRoute(AdminCommissionTree) },
        { path: 'admin/agent-summary',      element: lazyRoute(AdminAgentSummary) },
        // Unified System Health page — replaces the separate MT5 Sync Health,
        // Reconciliation, and Data Flow docs pages. Old URLs redirect to the
        // matching tab so bookmarks stay working.
        { path: 'admin/system-health',      element: lazyRoute(AdminSystemHealth) },
        // In-portal docs: renders OPERATIONS_GUIDE.md + DATA_FLOW.md +
        // ARCHITECTURE.md from disk so admins don't have to clone the repo.
        { path: 'admin/docs',               element: lazyRoute(AdminDocs) },
        { path: 'admin/settings',           element: lazyRoute(AdminSettings) },
        { path: 'admin/mt5-sync',           element: <Navigate to="/admin/system-health?tab=pipeline" replace /> },
        { path: 'admin/reconciliation',     element: <Navigate to="/admin/system-health?tab=reconciliation" replace /> },
        // /admin/data-flow → /admin/docs (Docs page now hosts data-flow content via markdown)
        { path: 'admin/data-flow',          element: <Navigate to="/admin/docs" replace /> },
        // Legacy URL redirect — Commission History was merged into Agent
        // Summary as a second tab. Preserves existing bookmarks.
        { path: 'admin/commission-history', element: <Navigate to="/admin/agent-summary?tab=commissions" replace /> },
      ],
    },
    { path: '*', element: <NotFound /> },
  ],
  { basename: '/portal' }
);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
