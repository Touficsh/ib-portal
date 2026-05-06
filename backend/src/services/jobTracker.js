/**
 * Job Tracker — in-memory progress board for long-running operations.
 *
 * Use this whenever an admin action takes >2 seconds. The frontend polls
 * GET /api/admin/jobs/:id and renders a live progress modal.
 *
 * Lifecycle:
 *   const jobId = createJob({ type, label, totalSteps });
 *   updateJob(jobId, { step: 1, currentStepLabel: '...', details: {...} });
 *   completeJob(jobId, summary);  // sets progress=100, completedAt
 *
 * Cleanup: jobs auto-delete 10 minutes after completion (or 30 min if still
 * running) to keep the map bounded. No persistent storage — restarts wipe.
 */
import crypto from 'crypto';

const jobs = new Map();
const TTL_AFTER_COMPLETE_MS = 10 * 60 * 1000;
const TTL_RUNNING_MS        = 30 * 60 * 1000;

function pruneJob(jobId) {
  setTimeout(() => jobs.delete(jobId), TTL_AFTER_COMPLETE_MS).unref();
}

/**
 * Create a new job and return its id. Pass it back to the client so they
 * can poll for progress.
 *
 * @param {object} opts
 * @param {string} opts.type             machine-readable kind (e.g. 'onboard', 'contact-sync')
 * @param {string} opts.label            human-readable description (e.g. 'Onboarding Hadi Chkair')
 * @param {number} [opts.totalSteps]     known step count if discrete; otherwise null for percent-only
 * @param {string} [opts.userId]         actor for telemetry/audit
 */
export function createJob({ type, label, totalSteps = null, userId = null }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    label,
    userId,
    totalSteps,
    step: 0,
    progress: 0,
    currentStepLabel: 'Starting…',
    details: {},
    log: [],                 // most recent ~10 log entries
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    summary: null,
  };
  jobs.set(id, job);
  // Auto-prune even running jobs eventually so leaks don't accumulate.
  setTimeout(() => {
    const j = jobs.get(id);
    if (j && !j.completedAt) {
      jobs.delete(id);
    }
  }, TTL_RUNNING_MS).unref();
  return id;
}

/**
 * Update a job's progress. Only fields you provide are changed; others stay.
 * Also appends a log entry if `currentStepLabel` changed.
 */
export function updateJob(jobId, patch = {}) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (patch.currentStepLabel && patch.currentStepLabel !== job.currentStepLabel) {
    job.log.push({ at: Date.now(), label: patch.currentStepLabel });
    if (job.log.length > 20) job.log.shift();
  }
  Object.assign(job, patch);
  // Auto-derive progress from step/totalSteps if not explicitly set.
  if (job.totalSteps && patch.step != null && patch.progress == null) {
    job.progress = Math.min(99, Math.round((job.step / job.totalSteps) * 100));
  }
}

/** Mark a job successful and record its final summary payload. */
export function completeJob(jobId, summary = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.completedAt = Date.now();
  job.progress = 100;
  job.summary = summary;
  job.currentStepLabel = 'Done';
  pruneJob(jobId);
}

/** Mark a job failed. */
export function failJob(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.completedAt = Date.now();
  job.error = errorMessage || 'Failed';
  job.currentStepLabel = `Failed: ${job.error}`;
  pruneJob(jobId);
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function listJobs({ activeOnly = false, type = null } = {}) {
  const out = [];
  for (const job of jobs.values()) {
    if (activeOnly && job.completedAt) continue;
    if (type && job.type !== type) continue;
    out.push(job);
  }
  // newest first
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}
