/** Aerial outcome analysis over a few matches. */
import { AERIAL_LOG } from '../../../src/ai/aerial';
import { AI_DEBUG } from '../../../src/ai/maneuvers';
import { runMatch } from '../harness';
AI_DEBUG.log = true;
const d = (process.argv[2] ?? 'pro') as 'pro' | 'legend';
for (let s = 1; s <= 4; s++) runMatch({ teamSize: 3, diff: [d, d], seed: s });
const by: Record<string, number> = {};
for (const e of AERIAL_LOG) by[e.reason] = (by[e.reason] ?? 0) + 1;
console.log(`${d}: aerials ${AERIAL_LOG.length}:`, JSON.stringify(by));
for (const r of ['late', 'infeasible', 'course', 'landed', 'noBoost']) {
  const L = AERIAL_LOG.filter((e) => e.reason === r).slice(0, 8);
  if (L.length) console.log(`  ${r}: ` + L.map((e) => `[rel ${e.rel.map((x) => x.toFixed(1)).join(',')} t ${e.t.toFixed(2)} T0 ${e.T0.toFixed(2)} h ${e.h.toFixed(1)}]`).join(' '));
}
