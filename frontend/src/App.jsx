import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import Login from './auth/Login.jsx';
import Layout from './layout/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TradingAccounts from './pages/TradingAccounts.jsx';
import Network from './pages/Network.jsx';
import Clients from './pages/Clients.jsx';
import SubAgents from './pages/SubAgents.jsx';
import SubAgentDetail from './pages/SubAgentDetail.jsx';
import CommissionTree from './pages/CommissionTree.jsx';
import Commissions from './pages/Commissions.jsx';
import Summary from './pages/Summary.jsx';
import NotFound from './pages/NotFound.jsx';
import AdminUsers from './pages/admin/Users.jsx';
import AdminProducts from './pages/admin/Products.jsx';
import AdminAgentNetwork from './pages/admin/AgentNetwork.jsx';
import AdminAgentDetail from './pages/admin/AgentDetail.jsx';
import AdminImportAgents from './pages/admin/ImportAgents.jsx';
import AdminAuditLog from './pages/admin/AuditLog.jsx';
import AdminCommissionTree from './pages/admin/CommissionTree.jsx';
import AdminSystemHealth from './pages/admin/SystemHealth.jsx';
import AdminAgentSummary from './pages/admin/AgentSummary.jsx';
import AdminDocs from './pages/admin/Docs.jsx';

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
        { path: 'dashboard',         element: <Dashboard /> },
        { path: 'trading-accounts',  element: <TradingAccounts /> },
        { path: 'network',           element: <Network /> },
        // Backward-compat redirects — old URLs land on the right tab
        { path: 'clients',           element: <Navigate to="/network?tab=clients" replace /> },
        { path: 'sub-agents',        element: <Navigate to="/network?tab=subagents" replace /> },
        { path: 'sub-agents/:id',    element: <SubAgentDetail /> },
        { path: 'commission-tree',   element: <CommissionTree /> },
        { path: 'summary',           element: <Summary /> },
        { path: 'commissions',       element: <Commissions /> },
        // Admin routes — visible in sidebar only for users with portal.admin.
        // No extra route-level gate here; backend endpoints enforce the permission.
        { path: 'admin/users',          element: <AdminUsers /> },
        { path: 'admin/products',       element: <AdminProducts /> },
        { path: 'admin/agents',         element: <AdminAgentNetwork /> },
        { path: 'admin/agents/:id',     element: <AdminAgentDetail /> },
        // Backwards-compat redirect for the old /admin/hierarchy URL.
        // The Hierarchy page was merged into Agent Network (same route).
        { path: 'admin/hierarchy',      element: <AdminAgentNetwork /> },
        { path: 'admin/import-agents',  element: <AdminImportAgents /> },
        { path: 'admin/audit-log',      element: <AdminAuditLog /> },
        { path: 'admin/commission-tree',    element: <AdminCommissionTree /> },
        { path: 'admin/agent-summary',      element: <AdminAgentSummary /> },
        // Unified System Health page — replaces the separate MT5 Sync Health,
        // Reconciliation, and Data Flow docs pages. Old URLs redirect to the
        // matching tab so bookmarks stay working.
        { path: 'admin/system-health',      element: <AdminSystemHealth /> },
        // In-portal docs: renders OPERATIONS_GUIDE.md + DATA_FLOW.md +
        // ARCHITECTURE.md from disk so admins don't have to clone the repo.
        { path: 'admin/docs',               element: <AdminDocs /> },
        { path: 'admin/mt5-sync',           element: <Navigate to="/admin/system-health?tab=pipeline" replace /> },
        { path: 'admin/reconciliation',     element: <Navigate to="/admin/system-health?tab=reconciliation" replace /> },
        { path: 'admin/data-flow',          element: <Navigate to="/admin/system-health?tab=docs" replace /> },
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
