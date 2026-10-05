/** update() cost for 6 bots (one manager, all bots), after warm-up. */
import { BotManager } from '../../../src/ai/BotManager';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { config } from '../helpers';
for (const diff of ['rookie', 'pro', 'legend'] as const) {
  const w = new World(config({ teamSize: 3, seed: 5, durationSec: 300 }));
  const bots = new BotManager(w, [0, 1, 2, 3, 4, 5], diff, 9);
  const inputs = w.cars.map(() => makeControlState());
  for (let i = 0; i < 120 * 20; i++) { bots.update(w, inputs); w.step(inputs); w.drainEvents(); }
  const samples: number[] = [];
  let worst = 0;
  for (let b = 0; b < 30; b++) {
    const t0 = performance.now();
    for (let i = 0; i < 240; i++) { bots.update(w, inputs); w.step(inputs); w.drainEvents(); }
    const t1 = performance.now();
    // subtract the sim step cost: re-time steps alone is not possible without inputs; measure update alone
    samples.push(t1 - t0);
  }
  // pure update cost: time update() alone on the same state repeatedly
  const u: number[] = [];
  for (let b = 0; b < 30; b++) {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) bots.update(w, inputs);
    u.push((performance.now() - t0) / 200);
    for (let i = 0; i < 60; i++) { bots.update(w, inputs); w.step(inputs); w.drainEvents(); }
  }
  u.sort((a, b) => a - b);
  let mx = 0;
  for (let i = 0; i < 2000; i++) { const t0 = performance.now(); bots.update(w, inputs); const d = performance.now() - t0; if (d > mx) mx = d; w.step(inputs); w.drainEvents(); }
  console.log(`${diff}: update() 6 bots: median ${u[15].toFixed(3)} ms, p90 ${u[27].toFixed(3)} ms, worst single call ${mx.toFixed(3)} ms; update+step per tick ${(samples.sort((a, b) => a - b)[15] / 240).toFixed(3)} ms`);
  void worst;
}
