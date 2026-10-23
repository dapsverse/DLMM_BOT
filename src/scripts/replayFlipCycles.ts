/**
 * Read-only replay of every past bid-ask flip cycle found in logs/live-*.log: what the old rules did vs what the new flip rules
 * (flip only below the lowest bin; no AI exit / trailing / TP in the flip phase; exits = cycle stop loss, OOR-above N min) would have done.
 * Run: npx tsx src/scripts/replayFlipCycles.ts [--ticks]   (prints no secrets; touches nothing)
 *
 * Limits (printed too): the logs hold one health-check tick (~15 s) per position, so the replay uses the REAL post-flip value path of the
 * flip position as it was placed under the old rules; it does not re-simulate a different ask placement or a later flip, and there is no
 * price data after the position was closed, so what happened after the actual exit cannot be replayed.
 */
import { readdirSync, readFileSync } from 'node:fs';

const SL_PCT = 25;
const OOR_ABOVE_MIN = 10;
const EXIT_COST_PCT = 1;
const EXIT_COST_GAS_SOL = 0.0005;

interface Ev { ts: number; iso: string; text: string }
const ANSI = /\u001b\[[0-9;]*m/g;
const files = readdirSync('logs').filter((f) => /^live-.*\.log$/.test(f)).sort();
const evs: Ev[] = [];
for (const f of files) {
  for (const raw of readFileSync('logs/' + f, 'utf8').split('\n')) {
    const line = raw.replace(ANSI, '');
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (m) evs.push({ ts: Date.parse(m[1]!), iso: m[1]!, text: m[2]! });
  }
}
evs.sort((a, b) => a.ts - b.ts);

const json = (t: string): Record<string, unknown> | null => {
  const i = t.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(t.slice(i)) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
const hhmm = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ');

interface Tick { ts: number; value: number; fees: number; bin: number; oor: boolean }
const flips = evs.map((e, i) => ({ e, i })).filter(({ e }) => e.text.includes('FLIP complete'));
console.log(`logs: ${files.length} files, ${evs.length} lines; flip cycles found: ${flips.length}`);

let n = 0;
for (const { e: done, i: doneIdx } of flips) {
  n++;
  const d = json(done.text)!;
  const pool = String(d.pool);
  const banked = num(d.bankedSol);
  const center = num(d.centerBinId);
  // entry: last "opening SOL-only ladder" + "ladder position opened" of this pool before the flip
  let open: Record<string, unknown> | null = null;
  let opened: Record<string, unknown> | null = null;
  let openTs = 0;
  let flipConfirm: Record<string, unknown> | null = null;
  let flipConfirmTs = 0;
  for (let i = doneIdx; i >= 0; i--) {
    const t = evs[i]!.text;
    if (!flipConfirm && t.includes('flip confirmed') && t.includes(pool)) {
      flipConfirm = json(t);
      flipConfirmTs = evs[i]!.ts;
    }
    if (!open && t.includes('opening SOL-only ladder') && t.includes(pool)) {
      open = json(t);
      openTs = evs[i]!.ts;
    }
    if (open) break;
  }
  // the FIRST "ladder position opened" after the entry call is the SOL ladder (the flip logs another one later)
  for (let i = 0; i < evs.length && evs[i]!.ts <= done.ts; i++) {
    if (evs[i]!.ts >= openTs && evs[i]!.text.includes('ladder position opened')) {
      opened = json(evs[i]!.text);
      break;
    }
  }
  const deposit = num(open?.capitalSol);
  const bins = num(open?.bins);
  const minBin = num(opened?.minBinId);
  const maxBin = num(opened?.maxBinId);
  const activeAtOpen = num(opened?.activeBinId);
  const solIsY = activeAtOpen === maxBin; // SOL-only ladder sits at/below the active bin when SOL is Y (token is X)
  const lo = minBin;
  const hi = maxBin;
  // flip-ladder range (token side): starts at the anchor edge `center`, `bins` wide
  const tokLo = solIsY ? center : center - (bins - 1);
  const tokHi = solIsY ? center + (bins - 1) : center;

  // ticks of this pool from entry to the end of the cycle
  const ticks: Tick[] = [];
  let exit: { ts: number; kind: string; text: string } | null = null;
  let outcome: Record<string, unknown> | null = null;
  let exitPriceUsd = NaN;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]!;
    if (ev.ts < openTs || !ev.text.includes(pool)) continue;
    if (ev.ts > done.ts && !exit) {
      const m = /\] (AI_EXIT|TAKE_PROFIT|STOP_LOSS|HARD_EXIT|FLOW_EXIT|SWITCH): closing position/.exec(ev.text);
      if (m) exit = { ts: ev.ts, kind: m[1]!, text: ev.text };
    }
    if (ev.text.includes('health check')) {
      const j = json(ev.text);
      if (j && Number.isFinite(num(j.currentValueSol)) && Number.isFinite(num(j.currentBinId))) ticks.push({ ts: ev.ts, value: num(j.currentValueSol), fees: num(j.unclaimedFeesSol) || 0, bin: num(j.currentBinId), oor: j.isOutOfRange === true });
    }
    if (exit && ev.ts >= exit.ts) {
      if (ev.text.includes('exit price') && Number.isNaN(exitPriceUsd)) exitPriceUsd = num(json(ev.text)?.exitPriceUsd);
      if (ev.text.includes('[index] outcome') && !outcome) outcome = json(ev.text);
      if (outcome) break;
    }
  }
  const endTs = exit?.ts ?? Infinity;
  const cyclePnl = (t: Tick, withBanked: boolean) => {
    const cost = (t.value * EXIT_COST_PCT) / 100 + EXIT_COST_GAS_SOL;
    return ((t.value + t.fees + (withBanked ? banked : 0) - cost - deposit) / deposit) * 100;
  };
  const post = ticks.filter((t) => t.ts > done.ts && t.ts <= endTs);
  const pre = ticks.filter((t) => t.ts <= done.ts);

  console.log(`\n=== cycle ${n}: pool ${pool.slice(0, 6)}  ladder ${bins} bins [${minBin}..${maxBin}] deposit ${deposit.toFixed(4)} SOL, SOL is ${solIsY ? 'Y' : 'X'}`);
  console.log(`entry ${hhmm(openTs)} | old flip ${hhmm(flipConfirmTs || done.ts)} at token share ${flipConfirm ? num(flipConfirm.tokenSharePct) : '?'}% , banked ${banked.toFixed(4)} SOL, flip ladder start bin ${center}`);
  // old exit
  const realized = outcome ? `${num(outcome.realizedPnlPct)}% (${num(outcome.realizedPnlSol)} SOL)` : 'n/a (no outcome line)';
  console.log(`OLD rules: exit ${exit ? `${hhmm(exit.ts)} ${exit.kind}` : 'none found (log ended / bot stopped)'}, exit price ${Number.isNaN(exitPriceUsd) ? 'n/a' : '$' + exitPriceUsd.toPrecision(4)}, realized ${realized}`);
  const last = post[post.length - 1];
  if (last) console.log(`  at the actual exit tick: bin ${last.bin} (flip ladder ${tokLo}..${tokHi}, ${last.oor ? 'out of range' : 'in range'}), cycle PnL ${cyclePnl(last, true).toFixed(2)}% (value+fees+banked-1%-gas vs deposit)`);

  // new flip trigger: first tick below the lowest bin of the SOL ladder (SOL=Y: bin < lo; SOL=X: bin > hi)
  const below = (t: Tick) => (solIsY ? t.bin < lo : t.bin > hi);
  const trig = [...pre, ...post].find((t) => t.ts > openTs && below(t));
  const flipTs = flipConfirmTs || done.ts;
  if (!trig) console.log('NEW flip trigger: price never went below the lowest bin in the logged window (no flip would have happened yet)');
  else {
    const dMin = (trig.ts - flipTs) / 60_000;
    const binsFromOld = solIsY ? trig.bin - lo : hi - trig.bin; // negative = further below the bottom
    console.log(`NEW flip trigger: first tick below the lowest bin ${hhmm(trig.ts)} (${dMin >= 0 ? '+' : ''}${dMin.toFixed(0)} min vs the old flip), bin ${trig.bin} = ${binsFromOld} bins vs the old bottom ${solIsY ? lo : hi}${trig.ts > endTs ? ' — AFTER the actual exit' : ''}`);
  }

  // new exit rules on the real post-flip value path
  let slAt: Tick | null = null;
  let oorStart = 0;
  let oorAt: Tick | null = null;
  let minPnl = Infinity;
  let maxPnl = -Infinity;
  for (const t of post) {
    const p = cyclePnl(t, true);
    minPnl = Math.min(minPnl, p);
    maxPnl = Math.max(maxPnl, p);
    if (!slAt && p <= -SL_PCT) slAt = t;
    const above = t.oor && (solIsY ? t.bin > tokHi : t.bin < tokLo);
    if (above) {
      if (!oorStart) oorStart = t.ts;
      if (!oorAt && t.ts - oorStart >= OOR_ABOVE_MIN * 60_000) oorAt = t;
    } else oorStart = 0;
  }
  const first = [slAt && { t: slAt, why: `stop loss (cycle PnL ${cyclePnl(slAt, true).toFixed(2)}% <= -${SL_PCT}%)` }, oorAt && { t: oorAt, why: `ladder sold out above range ${OOR_ABOVE_MIN}m (cycle PnL ${cyclePnl(oorAt, true).toFixed(2)}%)` }]
    .filter((x): x is { t: Tick; why: string } => !!x)
    .sort((a, b) => a.t.ts - b.t.ts)[0];
  console.log(`NEW rules on the real post-flip path (${post.length} ticks): cycle PnL min ${Number.isFinite(minPnl) ? minPnl.toFixed(2) : 'n/a'}%, max ${Number.isFinite(maxPnl) ? maxPnl.toFixed(2) : 'n/a'}%`);
  if (first) console.log(`  first allowed exit: ${hhmm(first.t.ts)} ${first.why}${exit && first.t.ts > exit.ts ? ' (after the old exit)' : ''}`);
  else console.log(`  no allowed exit before the old exit${exit ? `: the ${exit.kind} at ${hhmm(exit.ts)} would have been BLOCKED${exit.kind === 'AI_EXIT' ? ' (AI_EXIT)' : ''}; the position would still be open there, outcome after that is unknown (no post-exit price in the logs)` : ''}`);
  if (process.argv.includes('--ticks')) for (const t of post) console.log(`    ${hhmm(t.ts)} bin ${t.bin} ${t.oor ? 'OOR' : 'in '} value ${t.value.toFixed(4)} pnl ${cyclePnl(t, true).toFixed(2)}%`);
}
if (!flips.length) console.log('no flip cycles in the logs: nothing to replay');
console.log('\nSample size: ' + flips.length + ' flip cycles. The replay uses the old-placement value path; a later flip / different ask placement is not re-simulated; nothing after the actual exit is known.');
