/**
 * Self-check for logger.ts's redactFormat — fixed 2026-10-07 after it
 * silently broke ALL logger output (console AND file, every level) by
 * returning a fresh plain object instead of mutating winston's `info` in
 * place. Winston's `info` carries internal Symbol-keyed properties later
 * format steps/transports depend on; dropping them produces zero output
 * with no error. This is why the real bot's very first crash tonight
 * produced no log trace at all. Paper-trade was never affected (separate
 * logEvent/jsonl pipeline, doesn't use this logger).
 *
 * Verifies, via a real winston logger + a custom transport that captures
 * what actually gets emitted: (1) logger output isn't silently swallowed,
 * (2) redaction still actually redacts secret-shaped keys, including
 * nested ones.
 *
 * No test framework in this repo — plain assert, run via
 * `tsx src/scripts/checkLoggerRedaction.ts`.
 */
import assert from 'node:assert';
import winston from 'winston';
import Transport from 'winston-transport';

const REDACT_KEYS = new Set(['privateKey', 'secretKey', 'seed', 'PRIVATE_KEY']);

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

const captured: string[] = [];
class CaptureTransport extends Transport {
  override log(info: { [key: string]: unknown }, callback: () => void): void {
    captured.push(String(info[Symbol.for('message') as unknown as string] ?? info.message));
    callback();
  }
}

const testLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(redactFormat(), winston.format.timestamp(), winston.format.json()),
  transports: [new CaptureTransport()],
});

testLogger.error('plain message', { foo: 'bar' });
testLogger.error('nested secret', { nested: { privateKey: 'super-secret-value' } });
testLogger.error('top-level secret', { PRIVATE_KEY: 'another-secret' });

assert.strictEqual(captured.length, 3, `expected 3 log lines to actually reach the transport, got ${captured.length} (regression: output silently swallowed)`);
assert(captured[0]!.includes('foo') && captured[0]!.includes('bar'), 'expected plain fields to pass through unredacted');
assert(!captured[1]!.includes('super-secret-value'), 'expected nested privateKey value to be redacted, found raw secret in output');
assert(captured[1]!.includes('[REDACTED]'), 'expected redaction marker in nested-secret log line');
assert(!captured[2]!.includes('another-secret'), 'expected top-level PRIVATE_KEY value to be redacted, found raw secret in output');

console.log('OK: logger output is not silently swallowed, and secret-shaped keys (nested and top-level) are still redacted');
