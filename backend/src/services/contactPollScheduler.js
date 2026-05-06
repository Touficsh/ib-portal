/**
 * Contact Poll Scheduler — periodic page-1 scan for new CRM contacts.
 *
 * Every interval, calls `pollNewContacts` which:
 *   - Reads the first few pages of /api/contacts (newest-first)
 *   - Stops at the previous checkpoint (so each run only sees truly new arrivals)
 *   - Imports any whose `connectedAgent` matches one of our imported agents
 *   - Fetches trading accounts for each new contact
 *
 * Cost per tick: typically 1-3 contacts-list calls + N trading-account calls
 * where N = newly-arrived contacts since last poll (usually 0-5). Effectively
 * free vs. the daily budget.
 *
 * Configuration (env vars):
 *   ENABLE_CONTACT_POLL          'true' to enable (opt-in; default disabled)
 *   CONTACT_POLL_INTERVAL_MIN    minutes between polls (default 15)
 *   CONTACT_POLL_DELAY_MIN       boot warm-up delay (default 5)
 *   CONTACT_POLL_MAX_PAGES       max page-1 sweep pages per tick (default 3)
 *
 * Guards:
 *   - Single in-flight tick at a time (in-memory lock)
 *   - All calls flow through the CRM gate (pause / rate / budget / breaker)
 *   - First run delayed so we don't hammer CRM during a deploy storm
 *   - First-ever invocation in the DB just sets the checkpoint and imports
 *     nothing — full sweep was already done via Onboard / Sync contacts
 */
import { pollNewContacts } from './contactImport.js';

const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_DELAY_MIN    = 5;
const DEFAULT_MAX_PAGES    = 3;

let pollRunning = false;

async function runOnce({ maxPages }) {
  if (pollRunning) {
    console.log('[ContactPoll] tick skipped — previous tick still running');
    return;
  }
  pollRunning = true;
  try {
    const r = await pollNewContacts({
      branchName: null,         // all imported agents across all branches
      maxPages,
      dryRun: false,
    });
    console.log('[ContactPoll] tick done:', {
      firstRun: r.firstRun,
      contactsScanned: r.contactsScanned,
      contactsMatched: r.contactsMatched,
      contactsInserted: r.contactsInserted,
      tradingAccountsFetched: r.tradingAccountsFetched,
      loginsFound: r.loginsFound,
      aborted: r.aborted,
      abortReason: r.abortReason || null,
      durationMs: r.durationMs,
    });
  } catch (err) {
    // Non-fatal — the gate's kill switch / circuit breaker may have surfaced
    // an error. Log and continue; next tick will retry.
    console.error('[ContactPoll] tick failed:', err.message);
  } finally {
    pollRunning = false;
  }
}

export function startContactPollScheduler({
  intervalMin = DEFAULT_INTERVAL_MIN,
  delayMin    = DEFAULT_DELAY_MIN,
  maxPages    = DEFAULT_MAX_PAGES,
} = {}) {
  const enabled = String(process.env.ENABLE_CONTACT_POLL || '').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[ContactPoll] disabled (set ENABLE_CONTACT_POLL=true to enable)');
    return;
  }

  const effectiveInterval = Math.max(5,
    Number(process.env.CONTACT_POLL_INTERVAL_MIN) || intervalMin
  );
  const effectiveDelay = Math.max(0,
    Number(process.env.CONTACT_POLL_DELAY_MIN) || delayMin
  );
  const effectivePages = Math.max(1, Math.min(10,
    Number(process.env.CONTACT_POLL_MAX_PAGES) || maxPages
  ));

  const intervalMs = effectiveInterval * 60 * 1000;
  const delayMs    = effectiveDelay    * 60 * 1000;

  console.log(
    `[ContactPoll] Scheduler starting — interval=${effectiveInterval}min, ` +
    `maxPages=${effectivePages}, first run in ${effectiveDelay}min`
  );

  setTimeout(() => {
    runOnce({ maxPages: effectivePages })
      .catch(err => console.error('[ContactPoll] first run failed:', err.message));

    setInterval(() => {
      runOnce({ maxPages: effectivePages })
        .catch(err => console.error('[ContactPoll] scheduled run failed:', err.message));
    }, intervalMs).unref();
  }, delayMs).unref();
}
