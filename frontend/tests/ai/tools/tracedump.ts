/** Dump a lab run's trace numerically: node <bundle> <diff> <kind> <index> [from] [to] */
import { BotRng } from '../../../src/ai/math';
import type { Difficulty } from '../../../src/sim/types';
import { makeSetup, runLab, type ScenarioKind } from '../lab';
const a = process.argv.slice(2);
const kind = a[1] as ScenarioKind;
const idx = Number(a[2]);
const from = Number(a[3] ?? 0), to = Number(a[4] ?? 99);
const rng = new BotRng(1234 + kind.length);
let s = makeSetup(kind, rng);
for (let i = 1; i <= idx; i++) s = makeSetup(kind, rng);
console.log('setup', JSON.stringify(s));
const r = runLab(s, a[0] as Difficulty, 7, 100 + idx, false, true);
for (const p of r.trace!) if (p.t >= from && p.t <= to)
  console.log(`${p.t.toFixed(3)} ball (${p.b.map((x) => x.toFixed(2)).join(',')}) car (${p.c.map((x) => x.toFixed(2)).join(',')}) fwd (${p.f.map((x) => x.toFixed(2)).join(',')}) ${p.mode} tgt(${p.tgt.map((x) => x.toFixed(1)).join(',')}) ${p.ctl}`);
console.log('result', JSON.stringify({ ...r, trace: undefined }));
