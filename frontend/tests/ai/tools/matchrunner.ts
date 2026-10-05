/**
 * AI tuning CLI: runs headless matches and prints one JSON line per match (+ a summary line).
 *
 *   npx rolldown tests/ai/tools/matchrunner.ts --file <tmp>/mr.mjs --format esm --platform node
 *   node <tmp>/mr.mjs <teamSize> <diff0> <diff1> <seed> [durationSec] [--single] [--trace file.json]
 */
import { writeFileSync } from 'node:fs';
import type { Difficulty, TeamSize } from '../../../src/sim/types';
import { runMatch, summarize } from '../harness';

const a = process.argv.slice(2);
const teamSize = Number(a[0] ?? 1) as TeamSize;
const d0 = (a[1] ?? 'pro') as Difficulty;
const d1 = (a[2] ?? 'pro') as Difficulty;
const seed = Number(a[3] ?? 1);
const dur = a[4] && !a[4].startsWith('--') ? Number(a[4]) : 180;
const single = a.includes('--single');
const ti = a.indexOf('--trace');
const oi = a.indexOf('--skill0');
const oj = a.indexOf('--skill1');
const sk0 = oi >= 0 ? JSON.parse(a[oi + 1]) : undefined;
const sk1 = oj >= 0 ? JSON.parse(a[oj + 1]) : undefined;
const mi = a.indexOf('--mut');
const mut = mi >= 0 ? JSON.parse(a[mi + 1]) : undefined;
const m = runMatch({
  teamSize,
  diff: [d0, d1],
  seed,
  durationSec: dur,
  singleManager: single,
  trace: ti >= 0,
  skill: [sk0, sk1],
  swapSeeds: a.includes('--swap'),
  mutators: mut,
});
if (ti >= 0 && m.trace) writeFileSync(a[ti + 1], JSON.stringify(m.trace));
const { trace: _t, ...rest } = m;
console.log(JSON.stringify(rest));
console.error(summarize(m));
