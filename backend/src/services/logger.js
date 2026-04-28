/**
 * Structured JSON logger built on pino.
 *
 * Every log line is one JSON object with timestamp, level, message, and
 * whatever context fields you pass in. In production this ships straight to
 * stdout where pm2 captures it; from there a sidecar (promtail, vector, etc.)
 * can forward to Loki / Elasticsearch / CloudWatch.
 *
 * Development mode uses pino-pretty for human-readable console output.
 * Production mode emits single-line JSON — parseable by any log pipeline.
 *
 * Usage:
 *   import { logger } from '../services/logger.js';
 *   logger.info({ userId, action: 'rate.change' }, 'Rate updated');
 *   logger.error({ err }, 'Commission engine failed');
 *
 * Request-scoped logger: pino-http middleware attaches `req.log` with a
 * request-id bound in — use that inside route handlers to correlate
 * multi-step operations back to a single HTTP request.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  // ISO 8601 timestamps are easier to grep/sort than epoch milliseconds
  timestamp: pino.stdTimeFunctions.isoTime,
  // Base fields stamped on every log line
  base: {
    service: 'crm-backend',
    env: process.env.NODE_ENV || 'development',
  },
  // Redact sensitive fields — auth headers, passwords, tokens
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password', 'password_hash',
      '*.password', '*.password_hash', '*.token',
    ],
    censor: '[REDACTED]',
  },
  // In dev, pipe to pino-pretty so stdout is readable. In prod, keep raw JSON.
  ...(process.env.NODE_ENV === 'production' ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
    },
  }),
});

// Helper for creating child loggers scoped to a subsystem
export function loggerFor(subsystem) {
  return logger.child({ subsystem });
}
