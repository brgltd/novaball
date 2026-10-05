import { describe, expect, it } from 'vitest';
import { SIM_HZ } from '../../src/sim/constants';
import { BallPredictor } from '../../src/sim/predict';
import { World } from '../../src/sim/world';
import { ChaseBots } from './bots';
import { config } from './helpers';

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('performance', () => {
  it('World.step() for a 3v3 averages < 0.15 ms', () => {
    const w = new World(config({ teamSize: 3, durationSec: 300, seed: 11, player: null }));
    const bots = new ChaseBots(6, 3);
    // warm-up (JIT) + get into play
    for (let i = 0; i < 6 * SIM_HZ; i++) {
      w.step(bots.update(w));
      w.drainEvents();
    }
    const batches: number[] = [];
    const inputsPerBatch: Array<ReturnType<ChaseBots['update']>> = [];
    for (let b = 0; b < 9; b++) {
      // precompute inputs outside the timed region is impossible (they depend on state) — time bot + step,
      // then time the bots alone and subtract.
      const n = 600;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        w.step(bots.update(w));
        w.drainEvents();
      }
      const total = performance.now() - t0;
      const t1 = performance.now();
      for (let i = 0; i < n; i++) inputsPerBatch[0] = bots.update(w);
      const botsOnly = performance.now() - t1;
      batches.push((total - botsOnly) / n);
    }
    const ms = median(batches);
    console.info(`[perf] World.step 3v3: median ${ms.toFixed(4)} ms/step (batches ${batches.map((x) => x.toFixed(4)).join(', ')})`);
    expect(ms).toBeLessThan(0.15);
  });

  it('BallPredictor.update (240 slices @ 1/60, sub-stepped at 1/120) < 0.3 ms', () => {
    const w = new World(config({ teamSize: 1, freePlay: true }));
    const pred = new BallPredictor(4, 1 / 60);
    expect(pred.count).toBe(240);
    const b = w.ball;
    const batches: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) {
        b.pos.set(((i * 7) % 60) - 30, 2 + (i % 10), ((i * 13) % 90) - 45);
        b.vel.set(((i * 11) % 50) - 25, ((i * 3) % 30) - 5, ((i * 17) % 60) - 30);
        pred.update(b, 1);
      }
      batches.push((performance.now() - t0) / 200);
    }
    const ms = median(batches);
    console.info(`[perf] BallPredictor.update: median ${ms.toFixed(4)} ms (batches ${batches.map((x) => x.toFixed(4)).join(', ')})`);
    expect(ms).toBeLessThan(0.3);
  });

  it('writeSnapshot does not allocate new objects', () => {
    const w = new World(config({ teamSize: 3 }));
    const s = w.createSnapshot();
    const carRef = s.cars[2];
    const posRef = s.cars[2].pos;
    const ballPos = s.ball.pos;
    const pads = s.padsActive;
    w.step([]);
    w.writeSnapshot(s);
    expect(s.cars[2]).toBe(carRef);
    expect(s.cars[2].pos).toBe(posRef);
    expect(s.ball.pos).toBe(ballPos);
    expect(s.padsActive).toBe(pads);
  });
});
