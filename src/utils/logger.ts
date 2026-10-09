import winston from 'winston';
import { env } from '../config/env.js';

/**
 * Redacts anything that looks like a secret key/seed before it hits any
 * transport (console or file). Belt-and-suspenders on top of "never pass
 * the raw key to logger.log" — logger call sites can still be wrong.
 */
const REDACT_KEYS = new Set(['privateKey', 'secretKey', 'seed', 'PRIVATE_KEY']);

/**
 * Mutates in place, deep, recursing into nested objects/arrays. Must NOT
 * return a new object — winston's `info` carries internal Symbol-keyed
 * properties (e.g. Symbol.for('message')) that later format steps and
 * transports depend on to render the final log line. A format function
 * that returns a fresh plain object (as this used to) silently drops those
 * symbols, and every downstream format/transport then emits nothing at
 * all — no error, no console output, no file output. Found live
 * 2026-10-07: this broke 100% of logger.error/info/warn output for the
 * real bot (index.ts) since the file was written; paper-trade.ts was never
 * affected since it uses its own separate logEvent/fs.createWriteStream
 * JSONL pipeline, not this logger.
 */
function redactInPlace(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (REDACT_KEYS.has(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key] as unknown[]) {
        if (item && typeof item === 'object') redactInPlace(item as Record<string, unknown>);
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      redactInPlace(obj[key] as Record<string, unknown>);
    }
  }
}

const redactFormat = winston.format((info) => {
  redactInPlace(info as unknown as Record<string, unknown>);
  return info;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${String(timestamp)} [${level}] ${String(message)}${extra}`;
        }),
      ),
    }),
    new winston.transports.File({ filename: `${env.LOG_DIR}/error.log`, level: 'error' }),
    new winston.transports.File({ filename: `${env.LOG_DIR}/combined.log` }),
  ],
});
