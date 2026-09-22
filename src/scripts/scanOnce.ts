/**
 * Dry-run: runs the scanner once and prints candidate pools. No wallet, no
 * RPC writes, no position opened — read-only against Meteora/DexScreener.
 * Usage: npm run scan
 */
import { scanPools, defaultScannerConfig } from '../services/meteoraScanner.js';
import { WSOL_MINT } from '../config/constants.js';

const blacklist = new Map<string, number>();
const candidates = await scanPools(defaultScannerConfig(blacklist));

if (!candidates.length) {
  console.log('No pool passes the current filters (TVL/volume/ratio/memecoin screen/crash-guard).');
} else {
  console.log(`\n${candidates.length} pool(s) pass filters. Top ${Math.min(candidates.length, 10)} (bot would enter #1):\n`);
  candidates.slice(0, 10).forEach((p, i) => {
    const tvl = Number(p.liquidity);
    const vol = Number(p.trade_volume_24h);
    const memecoin = p.mint_x === WSOL_MINT ? p.tokenY : p.tokenX;
    const ageHours = (Date.now() - p.createdAtMs) / 3_600_000;
    console.log(`${i + 1}. ${p.name}`);
    console.log(`   pool=${p.address}`);
    console.log(`   memecoin mint=${memecoin.address}`);
    console.log(`   binStep=${p.bin_step}  TVL=$${tvl.toLocaleString()}  Vol24h=$${vol.toLocaleString()}  Vol/TVL=${(vol / tvl).toFixed(2)}x  age=${ageHours.toFixed(1)}h`);
    console.log(`   marketCap=$${memecoin.marketCapUsd.toLocaleString()}  holders=${memecoin.holders}  freezeAuthorityDisabled=${memecoin.freezeAuthorityDisabled}  mintAuthorityRevoked=${memecoin.mintAuthorityRevoked}`);
    if (p.priceChange1hPct !== undefined) console.log(`   priceChange1h=${p.priceChange1hPct}%`);
    console.log('');
  });
}
