/** 3v3 team shape: exposure (nobody goal-side), last-man depth, support distance, time per third. */
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { makeConfig } from '../harness';
const d = (process.argv[2] ?? 'pro') as Difficulty;
let exposed = [0, 0], homeT = [0, 0], supD = [0, 0], supN = [0, 0], attD = [0, 0], play = 0, thirds = [0, 0, 0];
let goals = 0;
for (let s = 1; s <= 4; s++) {
  const w = new World(makeConfig({ teamSize: 3, diff: [d, d], seed: s * 3, durationSec: 180 }));
  const bots = new BotManager(w, [0, 1, 2, 3, 4, 5], d, s);
  const inputs = w.cars.map(() => makeControlState());
  while (w.match.phase !== 'ended') {
    bots.update(w, inputs);
    w.step(inputs);
    for (const e of w.drainEvents()) if (e.type === 'goal') goals++;
    if (w.match.phase !== 'playing') continue;
    play++;
    const b = w.ball.pos;
    thirds[b.z < -16.7 ? 0 : b.z > 16.7 ? 2 : 1]++;
    for (const team of [0, 1]) {
      const dir = team === 0 ? 1 : -1;
      const bzr = b.z * dir;
      let goalSide = 0;
      let deepest = Infinity;
      for (const c of w.cars) {
        if (c.team !== team || c.demolished) continue;
        const zr = c.pos.z * dir;
        if (zr < bzr - 1) goalSide++;
        deepest = Math.min(deepest, zr);
        const st = bots.botState(c.id)!;
        const dist = c.pos.distanceTo(b);
        if (st.role === 'support') { supD[team] += dist; supN[team]++; }
        if (st.role === 'attacker') attD[team] += dist;
      }
      if (goalSide === 0) exposed[team]++;
      if (deepest < -40) homeT[team]++;
    }
  }
}
console.log(`${d} 3v3 (4 matches, ${goals} goals): exposed (nobody goal-side) ${(100 * exposed[0] / play).toFixed(1)}% / ${(100 * exposed[1] / play).toFixed(1)}% | someone home (zr<-40) ${(100 * homeT[0] / play).toFixed(0)}% / ${(100 * homeT[1] / play).toFixed(0)}% | support↔ball ${(supD[0] / supN[0]).toFixed(1)} m | attacker↔ball ${(attD[0] / play).toFixed(1)} m | ball in thirds ${thirds.map((x) => (100 * x / play).toFixed(0)).join('/')}%`);
