import winston from 'winston';
import { env } from '../config/env.js';

/**
 * Redacts anything that looks like a secret key/seed before it hits any
 * transport (console or file). Belt-and-suspenders on top of "never pass
 * the raw key to logger.log" — logger call sites can still be wrong.
 */
const REDACT_KEYS = new Set(['privateKey', 'secretKey', 'seed', 'PRIVATE_KEY']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

const redactFormat = winston.format((info) => {
  const { level, message, timestamp, ...rest } = info;
  return { level, message, timestamp, ...(redact(rest) as object) };
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
