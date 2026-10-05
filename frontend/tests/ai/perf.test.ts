/**
 * BotManager.update() cost: 6 bots (one shared prediction + planning for every car).
 * Timing under a loaded machine (vitest runs files in parallel; other processes) is noisy, so the budget is checked on
 * the FASTEST 2-s batch (what the code costs when it gets the CPU) with a loose median guard for gross regressions.
 * Per-tick CPU time (process.cpuUsage) is reported alongside wall time.
 */
import { describe, expect, it } from 'vitest';
import { BotManager } from '../../src/ai/BotManager';
import type { Difficulty } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { makeConfig } from './harness';

describe('AI performance', () => {
  for (const diff of ['pro', 'legend'] as Difficulty[]) {
    it(`${diff}: update() for 6 bots — best batch < 0.6 ms, median < 1.5 ms`, () => {
      const w = new World(makeConfig({ teamSize: 3, diff: [diff, diff], seed: 11, durationSec: 300 }));
      const bots = new BotManager(w, [0, 1, 2, 3, 4, 5], diff, 3);
      const inputs = w.cars.map(() => makeControlState());
      // warm-up (JIT) and get into open play
      for (let i = 0; i < 120 * 12; i++) {
        bots.update(w, inputs);
        w.step(inputs);
        w.drainEvents();
      }
      const wall: number[] = [];
      const cpu: number[] = [];
      for (let b = 0; b < 12; b++) {
        let ms = 0;
        let us = 0;
        for (let i = 0; i < 240; i++) {
          const c0 = process.cpuUsage();
          const t0 = performance.now();
          bots.update(w, inputs);
          ms += performance.now() - t0;
          const c1 = process.cpuUsage(c0);
          us += c1.user + c1.system;
          w.step(inputs);
          w.drainEvents();
        }
        wall.push(ms / 240);
        cpu.push(us / 1000 / 240);
      }
      wall.sort((a, b) => a - b);
      cpu.sort((a, b) => a - b);
      const msg =
        `${diff} update() 6 bots, ms per tick over 12 × 2-s batches: wall best ${wall[0].toFixed(3)} median ${wall[6].toFixed(3)} worst ${wall[11].toFixed(3)} | ` +
        `cpu best ${cpu[0].toFixed(3)} median ${cpu[6].toFixed(3)}`;
      console.info(`[ai perf] ${msg}`);
      expect(wall[0], msg).toBeLessThan(0.6);
      expect(wall[6], msg).toBeLessThan(1.5);
    });
  }
});
