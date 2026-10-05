/** Behaviour during ZERO-G SURGE vs normal gravity: touches/min, aerial touches, jumps, stuck. */
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { makeConfig } from '../harness';
const d = (process.argv[2] ?? 'pro') as Difficulty;
const acc = { surge: { t: 0, touch: 0, aer: 0, jumps: 0, goals: 0 }, normal: { t: 0, touch: 0, aer: 0, jumps: 0, goals: 0 } };
const modes: Record<string, number> = {};
for (let s = 1; s <= 6; s++) {
  const w = new World(makeConfig({ teamSize: 2, diff: [d, d], seed: s * 5, durationSec: 180 }));
  const bots = new BotManager(w, [0, 1, 2, 3], d, s);
  const inputs = w.cars.map(() => makeControlState());
  while (w.match.phase !== 'ended') {
    bots.update(w, inputs);
    w.step(inputs);
    const k = w.match.surge.state === 'active' ? 'surge' : 'normal';
    for (const e of w.drainEvents()) {
      if (e.type === 'ballHit') { acc[k].touch++; if (e.aerial) acc[k].aer++; }
      if (e.type === 'jump') acc[k].jumps++;
      if (e.type === 'goal') acc[k].goals++;
    }
    if (w.match.phase === 'playing') {
      acc[k].t += 1 / 120;
      if (k === 'surge') for (let i = 0; i < 4; i++) { const m = bots.botState(i)!.mode.split(':')[0]; modes[m] = (modes[m] ?? 0) + 1 / 120; }
    }
  }
}
for (const k of ['normal', 'surge'] as const) {
  const a = acc[k];
  console.log(`${d} ${k}: ${a.t.toFixed(0)} s | touches/min ${(a.touch * 60 / a.t).toFixed(1)} | aerial touches/min ${(a.aer * 60 / a.t).toFixed(1)} | jumps/min ${(a.jumps * 60 / a.t).toFixed(1)} | goals/min ${(a.goals * 60 / a.t).toFixed(2)}`);
}
const tot = Object.values(modes).reduce((a, b) => a + b, 0);
console.log('surge modes:', Object.entries(modes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${(100 * v / tot).toFixed(0)}%`).join(' '));
