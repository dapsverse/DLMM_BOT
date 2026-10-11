// Loads moonbot/data pools onto a regular hourly grid (gaps = zero-volume hours carry last close).
// Pools whose trades stop >12h before the end of the data get a x0.5 "dead" haircut on their final price (rug/abandon proxy).
import { readdirSync, readFileSync } from 'node:fs';
const dirOf = (d) => new URL(`./${d}/`, import.meta.url).pathname;
export function loadPools(minLen = 72, dataDir = process.env.DATA ?? 'data', perPoolOpt = !!process.env.PERPOOL) {
  const DIR = dirOf(dataDir);
  const raw = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(DIR + f))).filter((p) => p.candles?.length);
  const globalEnd = Math.max(...raw.map((p) => p.candles[p.candles.length - 1][0]));
  const out = [];
  for (const p of raw) {
    const byTs = new Map(p.candles.map((c) => [c[0], c]));
    const t0 = p.candles[0][0], lastTs = p.candles[p.candles.length - 1][0];
    const perPool = perPoolOpt; // data_old: each pool has its own fixed span, don't extend to a global end
    const poolEnd = perPool ? lastTs : globalEnd;
    const dead = !perPool && globalEnd - lastTs > 12 * 3600;
    const grid = []; let prev = p.candles[0][1];
    for (let t = t0; t <= poolEnd; t += 3600) {
      const c = byTs.get(t);
      if (c) { grid.push(c); prev = c[4]; } else grid.push([t, prev, prev, prev, prev, 0]);
    }
    if (dead) { const f = grid[grid.length - 1]; const px = f[4] * +(process.env.DEAD ?? 0.5); grid.push([f[0] + 3600, px, f[4], px, px, 0]); }
    const ageAtStart = p.created ? (t0 - p.created / 1000) / 3600 : null; // hours between creation and first candle
    if (grid.length >= minLen) out.push({ ...p, c: grid, dead, launchedInWindow: ageAtStart !== null && ageAtStart < 2 });
  }
  return out;
}

// Exit price multiplier: a position can't be sold at a stale price when the pool had no trades in the last 12h.
export const staleMult = (c, t) => (c.slice(Math.max(0, t - 11), t + 1).every((x) => x[5] === 0) ? +(process.env.DEAD ?? 0.5) : 1);
