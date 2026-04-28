import pg from 'pg';
const { Pool } = pg;

/**
 * Two-pool setup for Supabase connection budget efficiency.
 *
 *   directPool  — classic 1 client = 1 Postgres backend. Required for
 *                 LISTEN/NOTIFY, session-level temp tables, advisory locks
 *                 outside transactions, and migrations.
 *                 Source: DATABASE_URL (port 5432 on Supabase).
 *
 *   default export (pooled) — PgBouncer transaction-mode pooling. One
 *                 backend handles many app connections by rotating through
 *                 them per-transaction. Lifts the effective connection
 *                 budget from ~60 to effectively unlimited.
 *                 Source: DATABASE_URL_POOLER (port 6543 on Supabase).
 *
 * If DATABASE_URL_POOLER is unset, the pooled pool falls back to the direct
 * URL so the app keeps working in local dev / pre-switch environments.
 *
 * Transactions via `pool.connect() + BEGIN + ... + COMMIT` work fine in
 * transaction-mode because the backend is held for the whole transaction.
 * What does NOT work through the pooler: named prepared statements
 * (`pool.query({ name: 'x', ... })`) and `LISTEN/NOTIFY`. A grep of the
 * codebase found zero of either — safe to swap.
 */

let directPoolInstance;
let pooledPoolInstance;

function isSupabaseUrl(url) {
  return typeof url === 'string' && url.includes('supabase');
}

function buildPool(connectionString) {
  return new Pool({
    connectionString,
    ...(isSupabaseUrl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
    // Keep the pool small so we never exhaust Supabase's ~60-connection budget.
    // pg default is 10 which is fine for direct connections, but on the free
    // tier we share that budget with migrations, studio, etc.
    max: 5,
    // Fail fast instead of queuing forever when all 5 connections are in use.
    // Callers get a clear error ("timeout acquiring connection") rather than
    // hanging the HTTP request indefinitely.
    connectionTimeoutMillis: 10_000,
    // Release idle connections after 30 s so we give Supabase slots back
    // quickly during quiet periods.
    idleTimeoutMillis: 30_000,
  });
}

function getDirectPool() {
  if (!directPoolInstance) {
    directPoolInstance = buildPool(process.env.DATABASE_URL);
  }
  return directPoolInstance;
}

function getPooledPool() {
  if (!pooledPoolInstance) {
    const pooledUrl = process.env.DATABASE_URL_POOLER;
    pooledPoolInstance = pooledUrl
      ? buildPool(pooledUrl)
      : getDirectPool();  // fallback when pooler URL not configured
  }
  return pooledPoolInstance;
}

// Named export for the direct (port 5432) pool. Import this for:
//   - LISTEN/NOTIFY (none today)
//   - Migrations (`db/migrate.js`, `db/partitionMt5DealCache.js`)
//   - Advisory-lock-outside-transaction scenarios (none today)
export const directPool = new Proxy({}, {
  get(_, prop) {
    const p = getDirectPool();
    const val = p[prop];
    return typeof val === 'function' ? val.bind(p) : val;
  }
});

// Default export: pooled pool (or direct if not configured). All existing
// `import pool from '../db/pool.js'` callers use this — zero code changes
// needed to benefit from pooling.
export default new Proxy({}, {
  get(_, prop) {
    const p = getPooledPool();
    const val = p[prop];
    return typeof val === 'function' ? val.bind(p) : val;
  }
});
