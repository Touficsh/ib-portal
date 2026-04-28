/**
 * Prometheus-compatible metrics built on prom-client.
 *
 * All custom counters + histograms are registered on the default registry so
 * `/metrics` can expose them in one dump. Node-level metrics (event loop lag,
 * GC pauses, heap size, file descriptors) are collected automatically.
 *
 * Naming convention: `crm_<subsystem>_<thing>_<unit>`.
 * - _total suffix for counters
 * - _seconds for duration histograms (Prometheus convention)
 * - _bytes for size gauges
 *
 * Scrape config:
 *   - job_name: crm-backend
 *     static_configs: [{ targets: ['host:80'] }]
 *     metrics_path: /metrics
 */
import client from 'prom-client';

// Default Node metrics (event loop lag, memory, GC, fds, etc.)
client.collectDefaultMetrics({ prefix: 'crm_node_' });

// HTTP request metrics
export const httpDuration = new client.Histogram({
  name: 'crm_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestTotal = new client.Counter({
  name: 'crm_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Commission engine metrics
export const commissionCycleDuration = new client.Histogram({
  name: 'crm_commission_cycle_duration_seconds',
  help: 'Commission engine cycle duration in seconds',
  labelNames: ['triggered_by', 'status'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
});

export const commissionRowsInserted = new client.Counter({
  name: 'crm_commission_rows_inserted_total',
  help: 'Total commission rows inserted by the engine',
  labelNames: ['triggered_by'],
});

export const commissionJobStatus = new client.Counter({
  name: 'crm_commission_jobs_total',
  help: 'Commission engine jobs by final status',
  labelNames: ['status'],  // succeeded | failed | dead
});

// MT5 bridge metrics
export const mt5BridgeLatency = new client.Histogram({
  name: 'crm_mt5_bridge_latency_seconds',
  help: 'Latency of MT5 bridge calls',
  labelNames: ['endpoint', 'status'],  // endpoint: accounts | transactions | history, status: ok | error | timeout
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Cache metrics (populated by cache abstraction)
export const cacheHits = new client.Counter({
  name: 'crm_cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache'],
});
export const cacheMisses = new client.Counter({
  name: 'crm_cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache'],
});

// DB pool metrics (sampled by a periodic collector)
export const dbPoolActive = new client.Gauge({
  name: 'crm_db_pool_active_connections',
  help: 'Active Postgres pool connections',
});
export const dbPoolIdle = new client.Gauge({
  name: 'crm_db_pool_idle_connections',
  help: 'Idle Postgres pool connections',
});
export const dbPoolWaiting = new client.Gauge({
  name: 'crm_db_pool_waiting_connections',
  help: 'Connections waiting for a free client',
});

/**
 * Express middleware that times each request and records to the histogram.
 * Normalises dynamic paths (/clients/:id) to their route template so we don't
 * explode cardinality by emitting a metric per UUID.
 */
export function httpMetricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    // req.route only exists after Express matches — fall back to req.path so
    // 404s still get recorded
    const route = req.route?.path || req.baseUrl + (req.route?.path || req.path) || req.path;
    const labels = {
      method: req.method,
      route: String(route).slice(0, 120),  // cap length to avoid cardinality blowup on weird paths
      status_code: String(res.statusCode),
    };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
}

/**
 * Starts a background collector sampling DB pool state every 5s.
 * Call once at startup (after the pool is created).
 */
export function startDbPoolMetricsCollector(pool) {
  setInterval(() => {
    try {
      dbPoolActive.set(pool.totalCount - pool.idleCount);
      dbPoolIdle.set(pool.idleCount);
      dbPoolWaiting.set(pool.waitingCount);
    } catch { /* ignore */ }
  }, 5000).unref();  // don't keep the process alive just for metrics
}

/**
 * Expose the Prometheus registry via text format. Mount at GET /metrics.
 */
export async function metricsHandler(req, res) {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
}

export { client as registry };
