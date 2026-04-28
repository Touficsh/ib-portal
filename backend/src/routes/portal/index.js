/**
 * Agent Portal Router — /api/portal
 *
 * Entry point for the agent-facing portal. All sub-routers are gated behind
 * the ENABLE_PORTAL feature flag (checked in portalAuthenticate) and, where
 * applicable, the 'portal.access' RBAC permission.
 *
 * Layout:
 *   /api/portal/auth/login       — public (rate-limited agent login)
 *   /api/portal/me               — authenticated agent profile
 *   /api/portal/sub-agents       — direct downline + clients
 *   /api/portal/commission-tree  — subtree waterfall (rates + earnings)
 *   /api/portal/commissions      — commission ledger + summary for this agent
 *   /api/portal/clients          — direct referred clients (full detail)
 *   /api/portal/statements       — PDF commission statement downloads
 */
import { Router } from 'express';
import authRoutes from './auth.js';
import meRoutes from './me.js';
import subAgentsRoutes from './sub-agents.js';
import commissionsRoutes from './commissions.js';
import clientsRoutes from './clients.js';
import statementsRoutes from './statements.js';
import dashboardRoutes from './dashboard.js';
import tradingAccountsRoutes from './trading-accounts.js';
import summaryRoutes from './summary.js';
import commissionTreeRoutes from './commission-tree.js';
import { isPortalEnabled } from '../../middleware/portalAuth.js';

const router = Router();

// Global feature-flag gate — returns 404 when the portal is disabled so the
// surface area is invisible to unauthenticated probes.
router.use((req, res, next) => {
  if (!isPortalEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

router.use('/auth', authRoutes);
router.use(meRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/trading-accounts', tradingAccountsRoutes);
router.use('/summary', summaryRoutes);
router.use('/commission-tree', commissionTreeRoutes);
router.use('/sub-agents', subAgentsRoutes);
router.use('/commissions', commissionsRoutes);
router.use('/clients', clientsRoutes);
router.use('/statements', statementsRoutes);

export default router;
