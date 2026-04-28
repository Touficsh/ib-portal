/**
 * One-shot migration: convert `mt5_deal_cache` from a plain heap table to
 * a RANGE-partitioned parent table with monthly partitions.
 *
 * Strategy:
 *   1. Guard: if the table is already partitioned, only ensure upcoming
 *      partitions exist and exit.
 *   2. Rename current table to `mt5_deal_cache_legacy`
 *   3. Create new partitioned parent with the same columns + PK
 *   4. Create monthly partitions covering MIN(deal_time) → now + 3 months
 *   5. Copy data across (INSERT ... SELECT — routed automatically by partition)
 *   6. Recreate indexes on each partition
 *   7. Drop the legacy table
 *
 * Entire migration runs in a single transaction so a failure leaves the
 * database unchanged. For Hadi's current ~250k rows this completes in under
 * a second. At 10M+ rows consider running off-hours.
 *
 * Also exposed as `ensureFuturePartitions()` — call periodically to
 * pre-create next month's partition so writes never trip over a missing
 * range. Idempotent, safe to call every minute.
 */
// Partition management = DDL — use the direct (non-pooled) connection so
// long-running ALTER/CREATE/INSERT statements don't rotate backends.
import { directPool as pool } from './pool.js';
import { logger } from '../services/logger.js';

const log = logger.child({ subsystem: 'mt5-partition' });

async function isPartitioned(dbClient) {
  const { rows } = await dbClient.query(
    `SELECT pt.partstrat
     FROM pg_class c
     JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
     WHERE c.relname = 'mt5_deal_cache'`
  );
  return rows.length > 0;
}

function monthKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}_${m}`;
}

function monthBoundary(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

/**
 * Create a single monthly partition if it doesn't exist.
 * Partition name: mt5_deal_cache_YYYY_MM
 */
async function createMonthlyPartition(dbClient, firstOfMonth) {
  const key = monthKey(firstOfMonth);
  const partitionName = `mt5_deal_cache_${key}`;
  const from = firstOfMonth.toISOString();
  const to   = addMonths(firstOfMonth, 1).toISOString();

  await dbClient.query(
    `CREATE TABLE IF NOT EXISTS ${partitionName}
       PARTITION OF mt5_deal_cache
       FOR VALUES FROM ('${from}') TO ('${to}')`
  );

  // Indexes are inherited from the parent in PG15+; in earlier versions we
  // have to create them per-partition. CREATE IF NOT EXISTS is safe either way.
  // synced_at index is critical for the admin /status dashboard which filters
  // by `synced_at > NOW() - INTERVAL ...` — without it, that query full-scans
  // every partition and hits Supabase's 60s statement timeout.
  await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_${partitionName}_login_time ON ${partitionName}(login, deal_time)`);
  await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_${partitionName}_time       ON ${partitionName}(deal_time)`);
  await dbClient.query(`CREATE INDEX IF NOT EXISTS idx_${partitionName}_synced_at  ON ${partitionName}(synced_at)`);

  return partitionName;
}

/**
 * Ensure partitions exist for the N months surrounding "now" (past + future).
 * Idempotent. Call on startup and on a daily interval.
 */
export async function ensureFuturePartitions({ monthsBack = 0, monthsForward = 3 } = {}) {
  const client = await pool.connect();
  try {
    if (!(await isPartitioned(client))) {
      log.debug('Table is not partitioned; skipping ensureFuturePartitions');
      return { ok: false, reason: 'not_partitioned' };
    }
    const now = monthBoundary(new Date());
    const created = [];
    for (let m = -monthsBack; m <= monthsForward; m++) {
      const boundary = addMonths(now, m);
      const name = await createMonthlyPartition(client, boundary);
      created.push(name);
    }
    return { ok: true, partitions: created };
  } finally {
    client.release();
  }
}

/**
 * Main migration. Call once to flip the table over.
 */
export async function migrateToPartitioned() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (await isPartitioned(client)) {
      log.info('Already partitioned — ensuring future partitions exist');
      await client.query('ROLLBACK');  // nothing to migrate
      return await ensureFuturePartitions();
    }

    log.info('Starting mt5_deal_cache partitioning migration');

    // 1. Find the date range that needs partitions
    const { rows: [range] } = await client.query(
      `SELECT MIN(deal_time) AS min_time, MAX(deal_time) AS max_time, COUNT(*)::bigint AS n
       FROM mt5_deal_cache`
    );
    const minTime = range.min_time ? new Date(range.min_time) : new Date();
    log.info({ rows: range.n, min: range.min_time, max: range.max_time }, 'Current table stats');

    // 2. Rename existing table out of the way
    await client.query(`ALTER TABLE mt5_deal_cache RENAME TO mt5_deal_cache_legacy`);
    // Also rename the indexes to avoid name collisions
    await client.query(`ALTER INDEX IF EXISTS mt5_deal_cache_pkey        RENAME TO mt5_deal_cache_legacy_pkey`);
    await client.query(`ALTER INDEX IF EXISTS idx_mt5_deal_login_time    RENAME TO idx_mt5_deal_legacy_login_time`);
    await client.query(`ALTER INDEX IF EXISTS idx_mt5_deal_time          RENAME TO idx_mt5_deal_legacy_time`);
    await client.query(`ALTER INDEX IF EXISTS idx_mt5_deal_time_brin     RENAME TO idx_mt5_deal_legacy_time_brin`);

    // 3. Create partitioned parent. PK includes deal_time because the
     // partition key must be part of any unique constraint.
    await client.query(`
      CREATE TABLE mt5_deal_cache (
        login          VARCHAR(50)   NOT NULL,
        deal_id        BIGINT        NOT NULL,
        deal_time      TIMESTAMPTZ   NOT NULL,
        entry          SMALLINT,
        volume         BIGINT,
        lots           NUMERIC(14,4),
        commission     NUMERIC(14,4),
        symbol         VARCHAR(50),
        balance_type   VARCHAR(20),
        balance_amount NUMERIC(14,2),
        synced_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (login, deal_id, deal_time)
      ) PARTITION BY RANGE (deal_time)
    `);

    // Indexes on the partitioned parent propagate to partitions (PG11+)
    await client.query(`CREATE INDEX idx_mt5_deal_login_time ON mt5_deal_cache(login, deal_time)`);
    await client.query(`CREATE INDEX idx_mt5_deal_time       ON mt5_deal_cache(deal_time)`);

    // 4. Create partitions covering the legacy data range + a few future months
    const startMonth = monthBoundary(minTime);
    const endMonth   = addMonths(monthBoundary(new Date()), 3);
    const partitions = [];
    let cursor = startMonth;
    while (cursor < endMonth) {
      const name = await createMonthlyPartition(client, cursor);
      partitions.push(name);
      cursor = addMonths(cursor, 1);
    }
    log.info({ partitions: partitions.length }, 'Partitions created');

    // 5. Copy data in — routed automatically by the partition key
    const { rowCount } = await client.query(
      `INSERT INTO mt5_deal_cache
         (login, deal_id, deal_time, entry, volume, lots, commission, symbol, balance_type, balance_amount, synced_at)
       SELECT login, deal_id, deal_time, entry, volume, lots, commission, symbol, balance_type, balance_amount, synced_at
       FROM mt5_deal_cache_legacy`
    );
    log.info({ copied: rowCount }, 'Data copied into partitions');

    // 6. Drop the legacy table
    await client.query(`DROP TABLE mt5_deal_cache_legacy CASCADE`);

    await client.query('COMMIT');
    log.info('Partitioning migration complete');
    return { ok: true, copied: rowCount, partitions };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err: err.message }, 'Partitioning migration failed — rolled back');
    throw err;
  } finally {
    client.release();
  }
}

// Standalone CLI: `node src/db/partitionMt5DealCache.js`
if (process.argv[1]?.endsWith('partitionMt5DealCache.js')) {
  (async () => {
    const { fileURLToPath } = await import('url');
    const { dirname, resolve } = await import('path');
    const dotenv = (await import('dotenv')).default;
    const __filename = fileURLToPath(import.meta.url);
    dotenv.config({ path: resolve(dirname(__filename), '../../../.env'), override: true });
    try {
      const result = await migrateToPartitioned();
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}
