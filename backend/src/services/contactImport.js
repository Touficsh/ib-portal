/**
 * Contact Import Service — pulls CRM individual contacts (and their trading
 * accounts) for clients referred by the agents we've already imported.
 *
 * Why this exists: the CRM API's `?connectedAgent=<id>`, `?branch=<name>`,
 * `?profileType=client` query params are SILENTLY IGNORED — every variant
 * returns the full 27K-contact firehose. So we page through the global list
 * and filter in-memory by `connectedAgent._id ∈ imported_agent_client_ids`.
 *
 * Safety posture (everything funnels through the existing CRM gate):
 *   • Kill switch (settings.crm_paused) — re-checked between every page
 *   • Token-bucket rate limit (4 req/s default)
 *   • Daily per-bucket budgets (contacts-list 500, trading-accounts 3000)
 *   • Circuit breaker (5 errors/60s → 5min cooldown)
 *   • Per-run hard cap on pages scanned + trading-account calls
 *   • Resumable via settings.contact_sync_checkpoint
 *   • All writes idempotent (ON CONFLICT DO UPDATE)
 *
 * One entry point: importBranchContacts({ branchName?, maxPages, maxTaCalls,
 *                                          dryRun }).
 */
import pool from '../db/pool.js';
import { crmRequest, CrmPausedError, CrmBudgetExceededError } from './crmGate.js';
import { upsertTradingAccountMeta } from './tradingAccountMetaSync.js';

const CHECKPOINT_KEY = 'contact_sync_checkpoint';
const POLL_CHECKPOINT_KEY = 'contact_poll_last_seen_iso';
const PENDING_RESUME_KEY = 'contact_sync_pending_resume';
const PAGE_SIZE = 100;            // CRM max
const TA_CONCURRENCY = 2;         // gate already caps to 4 globally

// ─────────────────────────────────────────────────────────────────────────
// Pending-resume helpers — when a sweep aborts mid-flight (budget hit, kill
// switch, etc.), persist the agentUserIds + endPage so the next contact poll
// tick can finish the job automatically. Eventual-consistency guarantee:
// even if a single Onboard's sweep is partial, the system catches up on its
// own without admin intervention.
// ─────────────────────────────────────────────────────────────────────────

async function readPendingResume() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = $1`,
    [PENDING_RESUME_KEY]
  );
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].value); }
  catch { return null; }
}

async function writePendingResume(state) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [PENDING_RESUME_KEY, JSON.stringify(state)]
  );
}

async function clearPendingResume() {
  await pool.query(`DELETE FROM settings WHERE key = $1`, [PENDING_RESUME_KEY]);
}

export { readPendingResume, clearPendingResume };

// ─────────────────────────────────────────────────────────────────────────
// Checkpoint helpers
// ─────────────────────────────────────────────────────────────────────────

async function readCheckpoint() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = $1`,
    [CHECKPOINT_KEY]
  );
  if (!rows[0]) return { lastCompletedPage: 0 };
  try { return JSON.parse(rows[0].value); }
  catch { return { lastCompletedPage: 0 }; }
}

async function writeCheckpoint(state) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [CHECKPOINT_KEY, JSON.stringify(state)]
  );
}

export async function resetCheckpoint() {
  await pool.query(`DELETE FROM settings WHERE key = $1`, [CHECKPOINT_KEY]);
}

// ─────────────────────────────────────────────────────────────────────────
// Build the membership set: for each imported agent (users.is_agent=true),
// pair their linked_client_id (CRM agent _id) → users.id. This is the only
// way we know "this contact belongs to one of our agents".
// ─────────────────────────────────────────────────────────────────────────

async function buildMembershipMap({ branchName, agentUserIds }) {
  const params = [];
  const conditions = [`u.is_agent = true`, `u.linked_client_id IS NOT NULL`];
  if (Array.isArray(agentUserIds) && agentUserIds.length > 0) {
    params.push(agentUserIds);
    conditions.push(`u.id = ANY($${params.length})`);
  }
  if (branchName) {
    params.push(branchName);
    conditions.push(`c.branch = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.linked_client_id, c.branch
       FROM users u
       JOIN clients c ON c.id = u.linked_client_id
      WHERE ${conditions.join(' AND ')}`,
    params
  );
  const map = new Map();
  for (const r of rows) map.set(r.linked_client_id, r.user_id);
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// Insert one CRM contact as an individual client. Idempotent — re-runs
// touch only changed fields and don't downgrade pipeline_stage.
// ─────────────────────────────────────────────────────────────────────────

async function upsertContact(crmContact, agentUserId) {
  const id = crmContact._id;
  if (!id) return false;

  const name = crmContact.name || `Contact ${id.slice(-6)}`;
  const email = crmContact.emails?.[0]?.email || null;
  const phone = crmContact.phoneNumbers?.[0]?.number || null;
  const branch = crmContact.user?.branches?.[0]?.name || null;
  const isVerified = !!(crmContact.user?.isVerified);
  const profileType = crmContact.profileType || crmContact.user?.type || 'lead';
  const referredById = crmContact.connectedAgent?._id || null;
  const createdAt = crmContact.createdAt || new Date().toISOString();

  // Pipeline stage — derive a sensible default. CRM doesn't expose stage
  // directly on the contacts list; treat verified/trader as 'Contacted',
  // otherwise 'Lead'. Existing rows never get downgraded.
  const newStage = isVerified ? 'Contacted' : 'Lead';

  await pool.query(
    `INSERT INTO clients
       (id, contact_type, name, email, phone, pipeline_stage, branch,
        is_verified, is_trader, crm_profile_type, source,
        referred_by_agent_id, agent_id, created_at, updated_at)
     VALUES ($1, 'individual', $2, $3, $4, $5, $6,
             $7, false, $8, 'crm',
             $9, $10, $11, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name                 = EXCLUDED.name,
       email                = EXCLUDED.email,
       phone                = EXCLUDED.phone,
       branch               = EXCLUDED.branch,
       is_verified          = EXCLUDED.is_verified,
       crm_profile_type     = EXCLUDED.crm_profile_type,
       referred_by_agent_id = EXCLUDED.referred_by_agent_id,
       agent_id             = EXCLUDED.agent_id,
       pipeline_stage       = CASE
         WHEN clients.pipeline_stage = 'Churned' THEN clients.pipeline_stage
         WHEN clients.pipeline_stage IN ('Lead') AND EXCLUDED.pipeline_stage = 'Contacted'
           THEN EXCLUDED.pipeline_stage
         ELSE clients.pipeline_stage
       END,
       updated_at = NOW()`,
    [id, name, email, phone, newStage, branch,
     isVerified, profileType,
     referredById, agentUserId, createdAt]
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Pull one contact's trading accounts and sync mt5_logins + meta.
// Throws CrmPausedError on kill switch / circuit / budget so the caller
// can stop the whole batch immediately.
// ─────────────────────────────────────────────────────────────────────────

async function syncOneContactsTradingAccounts(clientId) {
  const data = await crmRequest(
    `/api/contacts/${clientId}/trading-accounts?page=1&limit=100&accountType=real`,
    { signal: AbortSignal.timeout(8000) }
  );
  const rows = data?.tradingAccounts?.data || data?.data || [];
  const realLogins = (rows || [])
    .filter(ta => ta && ta.login && ta.type === 'real')
    .map(ta => String(ta.login));

  if (realLogins.length > 0) {
    await pool.query(
      `UPDATE clients
          SET mt5_logins = $1,
              trading_accounts_synced_at = NOW(),
              is_trader = true,
              updated_at = NOW()
        WHERE id = $2`,
      [realLogins, clientId]
    );
    await upsertTradingAccountMeta(clientId, data);
    return { logins: realLogins.length };
  } else {
    await pool.query(
      `UPDATE clients SET trading_accounts_synced_at = NOW() WHERE id = $1`,
      [clientId]
    );
    return { logins: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the import.
 *
 * @param {object} opts
 * @param {string} [opts.branchName]      — if set, scope membership to agents
 *                                          whose clients.branch matches.
 *                                          Use null to include ALL imported agents.
 * @param {number} [opts.maxPages=50]     — pages to scan in this run (each = 100 contacts)
 * @param {number} [opts.maxTaCalls=300]  — max trading-account fetches in this run
 * @param {boolean} [opts.dryRun=false]   — if true, no DB writes (read-only preview)
 * @param {boolean} [opts.resume=true]    — start from checkpoint vs. page 1
 */
export async function importBranchContacts({
  branchName = null,
  agentUserIds = null,
  maxPages = 50,
  maxTaCalls = 300,
  dryRun = false,
  resume = true,
  taFreshnessHours = 24,
  startPageOverride = null,    // if set, ignores `resume` and starts at this page (used by resume-aborted-sweep path)
} = {}) {
  const start = Date.now();
  const scopeLabel = Array.isArray(agentUserIds) && agentUserIds.length > 0
    ? `${agentUserIds.length} specific agent${agentUserIds.length === 1 ? '' : 's'}`
    : (branchName || '(all imported agents)');

  const summary = {
    scope: scopeLabel,
    branchName: branchName || null,
    agentCount: 0,                     // populated after membership build
    dryRun,
    pagesScanned: 0,
    contactsScanned: 0,
    contactsMatched: 0,
    contactsInserted: 0,
    contactsUpdated: 0,
    tradingAccountsFetched: 0,
    tradingAccountsSkippedFresh: 0,
    loginsFound: 0,
    aborted: false,
    abortReason: null,
    startPage: null,
    endPage: null,
    finalPage: false,
    durationMs: 0,
  };

  const membership = await buildMembershipMap({ branchName, agentUserIds });
  summary.agentCount = membership.size;
  if (membership.size === 0) {
    summary.aborted = true;
    summary.abortReason = `No imported agents found${branchName ? ` for branch '${branchName}'` : ''}`;
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Phase 1 — page scan
  const checkpoint = resume ? await readCheckpoint() : { lastCompletedPage: 0 };
  let page = startPageOverride && startPageOverride > 0
    ? startPageOverride
    : (checkpoint.lastCompletedPage || 0) + 1;
  summary.startPage = page;

  const matchedClientIds = [];

  try {
    while (summary.pagesScanned < maxPages) {
      const data = await crmRequest(
        `/api/contacts?page=${page}&pageSize=${PAGE_SIZE}`
      );
      summary.pagesScanned++;
      summary.endPage = page;

      const contacts = data?.contacts || data?.data || [];
      summary.contactsScanned += contacts.length;

      for (const c of contacts) {
        const agentCrmId = c?.connectedAgent?._id;
        if (!agentCrmId) continue;
        const agentUserId = membership.get(agentCrmId);
        if (!agentUserId) continue;

        summary.contactsMatched++;
        if (dryRun) continue;

        // Detect insert vs. update for the summary counters
        const before = await pool.query(
          `SELECT 1 FROM clients WHERE id = $1`, [c._id]
        );
        const wasNew = before.rowCount === 0;
        const ok = await upsertContact(c, agentUserId);
        if (ok) {
          if (wasNew) summary.contactsInserted++;
          else summary.contactsUpdated++;
          matchedClientIds.push(c._id);
        }
      }

      // Persist checkpoint after every successful page so a kill mid-run
      // doesn't lose progress.
      if (!dryRun) {
        await writeCheckpoint({ lastCompletedPage: page });
      }

      // End of pagination?
      const totalPages = data?.pagination?.totalPages;
      if (totalPages && page >= totalPages) {
        // Sweep completed cleanly — clear any stale resume marker so the
        // poll doesn't try to "continue" something that's already done.
        if (!dryRun) {
          try { await clearPendingResume(); } catch { /* non-fatal */ }
        }
        summary.finalPage = true;
        if (!dryRun) await resetCheckpoint(); // full sweep done — start fresh next time
        break;
      }
      if (data?.pagination?.isEnd) {
        summary.finalPage = true;
        if (!dryRun) await resetCheckpoint();
        break;
      }
      page++;
    }
  } catch (err) {
    summary.aborted = true;
    summary.abortReason = err?.code === 'CRM_PAUSED'
      ? `Aborted by kill switch (${err.message})`
      : err?.code === 'CRM_BUDGET_EXCEEDED'
      ? `Aborted by daily budget (${err.message})`
      : `Page scan error: ${err.message}`;

    // Persist resume-state so the next contact poll tick can continue from
    // here automatically. The eventual-consistency guarantee: even if a
    // single Onboard's sweep is partial, the system catches up overnight
    // (CRM budget resets at UTC midnight; the contact poll runs every 15min).
    if (!dryRun) {
      try {
        await writePendingResume({
          agentUserIds: agentUserIds || null,
          branchName: branchName || null,
          fromPage: page,             // resume at the page that was about to run
          maxTaCalls,
          taFreshnessHours,
          aborted_at: new Date().toISOString(),
          abort_reason: summary.abortReason,
        });
      } catch (writeErr) {
        console.error('[ContactImport] failed to persist resume state:', writeErr.message);
      }
    }
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Phase 2 — per-contact trading accounts (skipped on dryRun)
  // DISABLED-BY-DEFAULT 2026-05-04. xdev reported excessive
  // /api/contacts/:id/trading-accounts traffic. Product mapping is now
  // populated lazily (admin button or engine on-demand). Set
  // ENABLE_TA_BACKFILL=true to re-enable Phase 2 here.
  const taBackfillEnabled = String(process.env.ENABLE_TA_BACKFILL || 'false').toLowerCase() === 'true';
  if (!dryRun && taBackfillEnabled && matchedClientIds.length > 0) {
    let targets = matchedClientIds;
    if (taFreshnessHours > 0) {
      const { rows: stale } = await pool.query(
        `SELECT id FROM clients
          WHERE id = ANY($1)
            AND (trading_accounts_synced_at IS NULL
                 OR trading_accounts_synced_at < NOW() - ($2 || ' hours')::interval)`,
        [matchedClientIds, String(taFreshnessHours)]
      );
      const staleSet = new Set(stale.map(r => r.id));
      const before = targets.length;
      targets = targets.filter(id => staleSet.has(id));
      summary.tradingAccountsSkippedFresh = before - targets.length;
    }
    targets = targets.slice(0, maxTaCalls);
    let next = 0;

    async function drain() {
      while (true) {
        const i = next++;
        if (i >= targets.length) return;
        try {
          const r = await syncOneContactsTradingAccounts(targets[i]);
          summary.tradingAccountsFetched++;
          summary.loginsFound += r.logins;
        } catch (err) {
          if (err?.code === 'CRM_PAUSED' || err?.code === 'CRM_BUDGET_EXCEEDED') {
            // surface to outer catch via re-throw; abort whole worker pool
            throw err;
          }
          // single-contact error — log and skip, don't kill the batch
          console.error('[ContactImport] TA fetch failed for', targets[i], '-', err.message);
        }
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(TA_CONCURRENCY, targets.length) }, drain)
      );
    } catch (err) {
      summary.aborted = true;
      summary.abortReason = err?.code === 'CRM_PAUSED'
        ? `Aborted by kill switch during trading-accounts (${err.message})`
        : `Aborted by daily budget during trading-accounts (${err.message})`;
    }
  }

  summary.durationMs = Date.now() - start;
  console.log('[ContactImport] done:', summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────
// Page-1 poll for new contacts
// ─────────────────────────────────────────────────────────────────────────
// CRM returns /api/contacts sorted newest-first by default. We fetch a small
// number of pages (default 3 = 300 contacts), stop the moment we hit a row
// older-or-equal to our last checkpoint, and import only the matching new
// contacts (filtered by connectedAgent membership in our imported agents).
//
// First-ever run (no checkpoint): we set the checkpoint to the newest seen
// createdAt and import nothing. This avoids re-importing contacts the full
// sweep already covered. Subsequent runs only see truly new arrivals.
//
// Cost per run: 1-3 contacts-list calls + N trading-account calls (where N
// is the count of matching new contacts since last poll, usually 0-5).

async function readPollCheckpoint() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = $1`,
    [POLL_CHECKPOINT_KEY]
  );
  return rows[0]?.value || null;
}

async function writePollCheckpoint(iso) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [POLL_CHECKPOINT_KEY, iso]
  );
}

export async function resetPollCheckpoint() {
  await pool.query(`DELETE FROM settings WHERE key = $1`, [POLL_CHECKPOINT_KEY]);
}

/**
 * Poll for new contacts. Cheap to run frequently.
 *
 * @param {object} opts
 * @param {string} [opts.branchName]    — if set, scope to one branch's agents
 * @param {number} [opts.maxPages=3]    — pages to scan from page 1 (each = 100 contacts)
 * @param {boolean} [opts.dryRun=false] — preview only; no DB writes
 */
export async function pollNewContacts({
  branchName = null,
  agentUserIds = null,
  maxPages = 3,
  dryRun = false,
} = {}) {
  const start = Date.now();
  const summary = {
    branchName: branchName || '(all imported agents)',
    dryRun,
    pagesScanned: 0,
    contactsScanned: 0,
    contactsMatched: 0,
    contactsInserted: 0,
    contactsUpdated: 0,
    tradingAccountsFetched: 0,
    loginsFound: 0,
    aborted: false,
    abortReason: null,
    lastSeenAt: null,
    newCheckpointAt: null,
    firstRun: false,
    hitBoundary: false,
    resumed_aborted_sweep: false,
    durationMs: 0,
  };

  // ─── Resume-aborted-sweep priority ─────────────────────────────────────
  // If a previous full sweep aborted (e.g., daily budget exhausted), pick up
  // where it left off BEFORE doing the standard page-1 incremental poll.
  // Each tick advances the resume by `maxPages` pages (or whatever the
  // budget allows). Cleared automatically when finalPage is reached.
  if (!dryRun) {
    const pending = await readPendingResume();
    if (pending && pending.fromPage > 1) {
      console.log(`[ContactPoll] continuing aborted sweep from page ${pending.fromPage} (${pending.abort_reason || 'prior abort'})`);
      try {
        const cont = await importBranchContacts({
          agentUserIds: pending.agentUserIds,
          branchName: pending.branchName,
          maxPages: 50,                    // conservative — don't burn the budget in one tick
          maxTaCalls: pending.maxTaCalls || 500,
          resume: false,                   // we use our own pending-resume state below
          taFreshnessHours: pending.taFreshnessHours ?? 24,
          startPageOverride: pending.fromPage,
        });
        summary.resumed_aborted_sweep = {
          startedFromPage: pending.fromPage,
          pagesScanned: cont.pagesScanned,
          contactsInserted: cont.contactsInserted,
          contactsUpdated: cont.contactsUpdated,
          finalPage: cont.finalPage,
          aborted: cont.aborted,
        };
        // If the continuation finished, the sweep cleared the pending key
        // itself. If it aborted again, it overwrote the key with the new
        // resume position. Either way no extra cleanup needed.
      } catch (err) {
        console.error('[ContactPoll] resume-aborted-sweep error:', err.message);
      }
    }
  }

  const lastSeen = await readPollCheckpoint();
  summary.lastSeenAt = lastSeen;
  summary.firstRun = !lastSeen;

  const membership = await buildMembershipMap({ branchName, agentUserIds });
  if (membership.size === 0) {
    summary.aborted = true;
    summary.abortReason = `No imported agents found${branchName ? ` for branch '${branchName}'` : ''}`;
    summary.durationMs = Date.now() - start;
    return summary;
  }

  let newestSeen = null;
  const matchedToFetch = [];

  try {
    for (let page = 1; page <= maxPages; page++) {
      const data = await crmRequest(
        `/api/contacts?page=${page}&pageSize=${PAGE_SIZE}`
      );
      summary.pagesScanned++;
      const contacts = data?.contacts || data?.data || [];
      summary.contactsScanned += contacts.length;

      let stopAtBoundary = false;
      for (const c of contacts) {
        // Track newest createdAt as our next checkpoint.
        if (c.createdAt && (!newestSeen || c.createdAt > newestSeen)) {
          newestSeen = c.createdAt;
        }
        // Boundary: contact at-or-older than last checkpoint → done scanning.
        if (lastSeen && c.createdAt && c.createdAt <= lastSeen) {
          stopAtBoundary = true;
          continue;
        }
        // First run: don't import; just establish the checkpoint.
        if (!lastSeen) continue;

        const agentCrmId = c?.connectedAgent?._id;
        if (!agentCrmId) continue;
        const agentUserId = membership.get(agentCrmId);
        if (!agentUserId) continue;

        summary.contactsMatched++;
        if (dryRun) continue;

        const before = await pool.query(`SELECT 1 FROM clients WHERE id = $1`, [c._id]);
        const wasNew = before.rowCount === 0;
        await upsertContact(c, agentUserId);
        if (wasNew) summary.contactsInserted++;
        else summary.contactsUpdated++;
        matchedToFetch.push(c._id);
      }
      if (stopAtBoundary) {
        summary.hitBoundary = true;
        break;
      }
    }
  } catch (err) {
    summary.aborted = true;
    summary.abortReason = err?.code === 'CRM_PAUSED'
      ? `Aborted by kill switch (${err.message})`
      : err?.code === 'CRM_BUDGET_EXCEEDED'
      ? `Aborted by daily budget (${err.message})`
      : `Page scan error: ${err.message}`;
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Phase 2 — TA fetch for the new matches
  if (!dryRun && matchedToFetch.length > 0) {
    let next = 0;
    async function drain() {
      while (true) {
        const i = next++;
        if (i >= matchedToFetch.length) return;
        try {
          const r = await syncOneContactsTradingAccounts(matchedToFetch[i]);
          summary.tradingAccountsFetched++;
          summary.loginsFound += r.logins;
        } catch (err) {
          if (err?.code === 'CRM_PAUSED' || err?.code === 'CRM_BUDGET_EXCEEDED') throw err;
          console.error('[ContactPoll] TA fetch failed for', matchedToFetch[i], '-', err.message);
        }
      }
    }
    try {
      await Promise.all(
        Array.from({ length: Math.min(TA_CONCURRENCY, matchedToFetch.length) }, drain)
      );
    } catch (err) {
      summary.aborted = true;
      summary.abortReason = err?.code === 'CRM_PAUSED'
        ? `Aborted by kill switch during trading-accounts (${err.message})`
        : `Aborted by daily budget during trading-accounts (${err.message})`;
    }
  }

  // Phase 3 — Stale-TA refresh for EXISTING clients
  // DISABLED-BY-DEFAULT 2026-05-04. xdev reported excessive
  // /api/contacts/:id/trading-accounts traffic. This phase was firing
  // ~1,920 calls/day (20 clients per tick × 96 ticks/day). Set
  // ENABLE_TA_BACKFILL=true to re-enable.
  const phase3Enabled = String(process.env.ENABLE_TA_BACKFILL || 'false').toLowerCase() === 'true';
  if (!dryRun && !summary.aborted && phase3Enabled) {
    const STALE_HOURS = 6;
    const STALE_TA_BATCH = 20;  // up to 20 stale clients per tick = ~5s extra at 4 req/s
    try {
      const { rows: stale } = await pool.query(
        `SELECT c.id
           FROM clients c
           JOIN users u ON u.id = c.agent_id
          WHERE c.contact_type = 'individual'
            AND c.source = 'crm'
            AND u.is_agent = true
            ${Array.isArray(agentUserIds) && agentUserIds.length > 0 ? 'AND u.id = ANY($2::uuid[])' : ''}
            AND (c.trading_accounts_synced_at IS NULL
                 OR c.trading_accounts_synced_at < NOW() - ($1 || ' hours')::interval)
          ORDER BY c.trading_accounts_synced_at ASC NULLS FIRST
          LIMIT ${STALE_TA_BATCH}`,
        Array.isArray(agentUserIds) && agentUserIds.length > 0
          ? [String(STALE_HOURS), agentUserIds]
          : [String(STALE_HOURS)]
      );
      if (stale.length > 0) {
        let next = 0;
        async function drain() {
          while (true) {
            const i = next++;
            if (i >= stale.length) return;
            try {
              const r = await syncOneContactsTradingAccounts(stale[i].id);
              summary.tradingAccountsFetched++;
              summary.loginsFound += r.logins;
            } catch (err) {
              if (err?.code === 'CRM_PAUSED' || err?.code === 'CRM_BUDGET_EXCEEDED') throw err;
              console.error('[ContactPoll] stale TA refresh failed for', stale[i].id, '-', err.message);
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(TA_CONCURRENCY, stale.length) }, drain)
        );
        summary.staleTaRefreshed = stale.length;
      }
    } catch (err) {
      // Non-fatal — Phase 1 + 2 still committed. Don't lose the checkpoint
      // because of a Phase 3 failure.
      if (err?.code === 'CRM_PAUSED' || err?.code === 'CRM_BUDGET_EXCEEDED') {
        summary.aborted = true;
        summary.abortReason = err?.message || 'aborted during stale-TA refresh';
      } else {
        console.error('[ContactPoll] Phase 3 (stale TA) failed:', err.message);
      }
    }
  }

  // Advance checkpoint only if scan completed cleanly. Otherwise we risk
  // skipping past contacts we never imported.
  if (!dryRun && !summary.aborted && newestSeen) {
    await writePollCheckpoint(newestSeen);
    summary.newCheckpointAt = newestSeen;
  }

  summary.durationMs = Date.now() - start;
  console.log('[ContactPoll] done:', summary);
  return summary;
}
