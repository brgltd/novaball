/** Steering smoothness: sign flips of |steer| > 0.3 per second, mean |Δsteer| per tick (grounded, playing). */
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { makeConfig } from '../harness';
for (const d of ['rookie', 'pro', 'legend'] as Difficulty[]) {
  const w = new World(makeConfig({ teamSize: 2, diff: [d, d], seed: 3, durationSec: 120 }));
  const bots = new BotManager(w, [0, 1, 2, 3], d, 4);
  const inputs = w.cars.map(() => makeControlState());
  const prev = [0, 0, 0, 0];
  let flips = 0, dsum = 0, n = 0, t = 0, fullLock = 0, slide = 0, thrFlip = 0;
  const byMode: Record<string, number> = {};
  const timeMode: Record<string, number> = {};
  const prevThr = [0, 0, 0, 0];
  while (w.match.phase !== 'ended' && t < 150 * 120) {
    bots.update(w, inputs);
    w.step(inputs);
    w.drainEvents();
    t++;
    if (w.match.phase !== 'playing') continue;
    for (let i = 0; i < 4; i++) {
      const c = w.cars[i];
      if (!c.onGround || c.demolished) continue;
      const s = inputs[i].steer;
      const mode = bots.botState(i)!.mode.split(':')[0];
      timeMode[mode] = (timeMode[mode] ?? 0) + 1 / 120;
      if (Math.abs(s) > 0.3 && Math.abs(prev[i]) > 0.3 && Math.sign(s) !== Math.sign(prev[i])) {
        flips++;
        byMode[mode] = (byMode[mode] ?? 0) + 1;
      }
      if (Math.abs(s) > 0.99) fullLock++;
      if (inputs[i].powerslide) slide++;
      if (Math.sign(inputs[i].throttle) * Math.sign(prevThr[i]) < 0) thrFlip++;
      dsum += Math.abs(s - prev[i]);
      prev[i] = s;
      prevThr[i] = inputs[i].throttle;
      n++;
    }
  }
  const secs = n / 120;
  console.log('   flips/s by mode: ' + Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${(v / timeMode[k]).toFixed(1)}/s(${timeMode[k].toFixed(0)}s)`).join(' '));
  console.log(`${d}: steer sign flips ${(flips / secs).toFixed(2)}/s, mean |Δsteer| ${(dsum / n).toFixed(3)}/tick, full lock ${(100 * fullLock / n).toFixed(0)}%, powerslide ${(100 * slide / n).toFixed(1)}%, throttle reversals ${(thrFlip / secs).toFixed(2)}/s`);
}
