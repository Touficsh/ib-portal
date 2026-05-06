/**
 * Admin — Manual Client Management — /api/admin/clients
 *
 * Lets admins create individual clients that aren't (yet) in xdev CRM, and
 * attach MT5 trading accounts to them. Useful when:
 *   - A client opened an MT5 account but isn't in CRM yet
 *   - A client should be tracked in the portal but won't be added to CRM
 *   - Quick test/fixture data during onboarding
 *
 * Records are flagged `clients.source = 'manual'` so:
 *   - The CRM contact-import + poll never touches them (skip predicate)
 *   - They show up cleanly in audit + filters as "added by hand"
 *
 * Endpoints:
 *   POST /             — create a manual client under an agent
 *   POST /:id/trading-accounts — add an MT5 login to an existing client
 *   DELETE /:id/trading-accounts/:login — remove an MT5 login
 */
import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../db/pool.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/auditLog.js';

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

const VALID_STAGES = new Set(['Lead', 'Contacted', 'Funded', 'Active', 'Churned']);

// POST /api/admin/clients
//
// Body:
//   agent_id       UUID of the user who owns this client (required)
//   name           string (required)
//   email          string (optional)
//   phone          string (optional)
//   country        string (optional)
//   pipeline_stage one of Lead|Contacted|Funded|Active (default 'Lead')
//   mt5_logins     string[] (optional — MT5 trader logins to attach)
//
// Generates a unique client.id with prefix `manual-` so it can never collide
// with a CRM Mongo ObjectId (24-char hex). Sets:
//   - source = 'manual'
//   - contact_type = 'individual'
//   - agent_id = <body.agent_id>
//   - referred_by_agent_id = the agent's linked_client_id
//   - is_trader = mt5_logins.length > 0
router.post('/', async (req, res, next) => {
  try {
    const {
      agent_id, name, email, phone, country,
      pipeline_stage = 'Lead', mt5_logins,
    } = req.body || {};

    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!VALID_STAGES.has(pipeline_stage)) {
      return res.status(400).json({ error: `pipeline_stage must be one of: ${[...VALID_STAGES].join(', ')}` });
    }

    // Resolve the agent — must exist and be is_agent=true
    const { rows: [agent] } = await pool.query(
      `SELECT u.id, u.linked_client_id, u.name FROM users u
       WHERE u.id = $1 AND u.is_agent = true AND u.is_active = true`,
      [agent_id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found or inactive' });

    // Validate optional MT5 logins — must be unique strings, not already used
    const cleanLogins = Array.isArray(mt5_logins)
      ? [...new Set(mt5_logins.map(l => String(l).trim()).filter(Boolean))]
      : [];
    if (cleanLogins.length > 0) {
      const { rows: dupes } = await pool.query(
        `SELECT login FROM trading_accounts_meta WHERE login = ANY($1::varchar[])`,
        [cleanLogins]
      );
      if (dupes.length > 0) {
        return res.status(409).json({
          error: 'One or more MT5 logins already exist',
          conflicting_logins: dupes.map(d => d.login),
        });
      }
    }

    // Generate a unique client id with prefix so it never collides with CRM
    const clientId = `manual-${crypto.randomBytes(12).toString('hex')}`;

    // Insert the client row
    const insertRes = await pool.query(
      `INSERT INTO clients
         (id, contact_type, name, email, phone, country, pipeline_stage,
          source, is_verified, is_trader,
          mt5_logins, agent_id, referred_by_agent_id,
          created_at, updated_at)
       VALUES ($1, 'individual', $2, $3, $4, $5, $6,
               'manual', false, $7,
               $8, $9, $10,
               NOW(), NOW())
       RETURNING id, name, email, agent_id`,
      [
        clientId,
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        country ? String(country).trim() : null,
        pipeline_stage,
        cleanLogins.length > 0,
        cleanLogins,
        agent_id,
        agent.linked_client_id || null,
      ]
    );

    // Insert trading_accounts_meta rows for each login
    for (const login of cleanLogins) {
      try {
        await pool.query(
          `INSERT INTO trading_accounts_meta
             (login, client_id, account_type, status, last_synced_at)
           VALUES ($1, $2, 'real', true, NOW())
           ON CONFLICT (login) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             last_synced_at = NOW()`,
          [login, clientId]
        );
      } catch (rowErr) {
        console.error('[ManualClient] login attach failed:', login, rowErr.message);
      }
    }

    await audit(req, {
      action: 'admin.client.create_manual',
      entity_type: 'client',
      entity_id: clientId,
      metadata: { agent_id, agent_name: agent.name, name, mt5_logins: cleanLogins },
    });

    res.status(201).json({
      id: clientId,
      name: insertRes.rows[0].name,
      mt5_logins_attached: cleanLogins.length,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/clients/:id/trading-accounts
// Body: { login: string, account_type?: 'real'|'demo' }
router.post('/:id/trading-accounts', async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const { login, account_type = 'real' } = req.body || {};
    if (!login) return res.status(400).json({ error: 'login is required' });
    const cleanLogin = String(login).trim();

    // Confirm client exists
    const { rows: [client] } = await pool.query(
      `SELECT id, name, mt5_logins FROM clients WHERE id = $1`,
      [clientId]
    );
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Confirm login isn't taken elsewhere
    const { rows: dupe } = await pool.query(
      `SELECT client_id FROM trading_accounts_meta WHERE login = $1`,
      [cleanLogin]
    );
    if (dupe.length > 0 && dupe[0].client_id !== clientId) {
      return res.status(409).json({
        error: 'MT5 login already attached to a different client',
        existing_client_id: dupe[0].client_id,
      });
    }

    // Append login to clients.mt5_logins (idempotent — no duplicates)
    const existingLogins = Array.isArray(client.mt5_logins) ? client.mt5_logins : [];
    const nextLogins = existingLogins.includes(cleanLogin)
      ? existingLogins
      : [...existingLogins, cleanLogin];

    await pool.query(
      `UPDATE clients SET mt5_logins = $1, is_trader = true, updated_at = NOW()
       WHERE id = $2`,
      [nextLogins, clientId]
    );

    await pool.query(
      `INSERT INTO trading_accounts_meta
         (login, client_id, account_type, status, last_synced_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (login) DO UPDATE SET
         client_id = EXCLUDED.client_id,
         account_type = EXCLUDED.account_type,
         last_synced_at = NOW()`,
      [cleanLogin, clientId, account_type]
    );

    await audit(req, {
      action: 'admin.client.add_trading_account',
      entity_type: 'client',
      entity_id: clientId,
      metadata: { login: cleanLogin, account_type, client_name: client.name },
    });

    res.json({ ok: true, login: cleanLogin, mt5_logins: nextLogins });
  } catch (err) { next(err); }
});

// DELETE /api/admin/clients/:id/trading-accounts/:login
// Detaches an MT5 login from a client. The trading_accounts_meta row is kept
// (sets client_id = NULL) so historical commission rows remain joinable.
router.delete('/:id/trading-accounts/:login', async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const login = String(req.params.login).trim();

    const { rows: [client] } = await pool.query(
      `SELECT id, mt5_logins FROM clients WHERE id = $1`,
      [clientId]
    );
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const existingLogins = Array.isArray(client.mt5_logins) ? client.mt5_logins : [];
    const nextLogins = existingLogins.filter(l => l !== login);

    await pool.query(
      `UPDATE clients SET mt5_logins = $1, is_trader = $2, updated_at = NOW()
       WHERE id = $3`,
      [nextLogins, nextLogins.length > 0, clientId]
    );

    await pool.query(
      `UPDATE trading_accounts_meta SET client_id = NULL, last_synced_at = NOW()
       WHERE login = $1 AND client_id = $2`,
      [login, clientId]
    );

    await audit(req, {
      action: 'admin.client.remove_trading_account',
      entity_type: 'client',
      entity_id: clientId,
      metadata: { login },
    });

    res.json({ ok: true, login, mt5_logins: nextLogins });
  } catch (err) { next(err); }
});

export default router;
