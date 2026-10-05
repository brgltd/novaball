/**
 * Mechanics in scripted scenarios (one bot, parked opponent): shooting accuracy scales with difficulty, aerials happen
 * for pro+, rookies never aerial, kickoffs reach the ball quickly.
 */
import { describe, expect, it } from 'vitest';
import { BotManager } from '../../src/ai/BotManager';
import { BotRng } from '../../src/ai/math';
import type { Difficulty, TeamSize } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { makeConfig } from './harness';
import { makeSetup, runLab, type ScenarioKind } from './lab';

function rate(kind: ScenarioKind, diff: Difficulty, n: number, pick: (r: ReturnType<typeof runLab>) => boolean): number {
  const rng = new BotRng(1234 + kind.length);
  let ok = 0;
  for (let i = 0; i < n; i++) if (pick(runLab(makeSetup(kind, rng), diff, 7, 100 + i))) ok++;
  return ok / n;
}

describe('mechanics (scenario lab)', () => {
  it('open-net shooting: legend ≥ 70 %, pro ≥ 60 %, rookie clearly worse than legend', () => {
    const legend = rate('openNet', 'legend', 30, (r) => r.scored);
    const pro = rate('openNet', 'pro', 30, (r) => r.scored);
    const rookie = rate('openNet', 'rookie', 30, (r) => r.scored);
    console.info(`[ai] open net: legend ${legend.toFixed(2)} pro ${pro.toFixed(2)} rookie ${rookie.toFixed(2)}`);
    expect(legend).toBeGreaterThanOrEqual(0.7);
    expect(pro).toBeGreaterThanOrEqual(0.6);
    expect(rookie).toBeLessThan(legend);
  });

  it('high balls: pro and legend go up and touch them in the air; rookies never aerial', () => {
    const pro = rate('high', 'pro', 24, (r) => r.aerialTouch);
    const legend = rate('high', 'legend', 24, (r) => r.aerialTouch);
    const rookieAerials = rate('high', 'rookie', 16, (r) => r.touchMode === 'aerial');
    console.info(`[ai] aerial touches: legend ${legend.toFixed(2)} pro ${pro.toFixed(2)} rookie-aerial ${rookieAerials.toFixed(2)}`);
    expect(pro).toBeGreaterThanOrEqual(0.4);
    expect(legend).toBeGreaterThanOrEqual(0.4);
    expect(rookieAerials).toBe(0);
  });

  it('kickoffs: first touch within 3.5 s of GO for every difficulty and team size', () => {
    for (const d of ['rookie', 'pro', 'legend'] as Difficulty[]) {
      for (const ts of [1, 2, 3] as TeamSize[]) {
        const w = new World(makeConfig({ teamSize: ts, diff: [d, d], seed: 7 + ts }));
        const bots = new BotManager(w, w.cars.map((c) => c.id), d, 5);
        const inputs = w.cars.map(() => makeControlState());
        let go = -1;
        let first = -1;
        for (let i = 0; i < 120 * 10 && first < 0; i++) {
          bots.update(w, inputs);
          w.step(inputs);
          for (const e of w.drainEvents()) {
            if (e.type === 'kickoff') go = w.time;
            if (e.type === 'ballHit' && go >= 0 && first < 0) first = w.time - go;
          }
        }
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(3.5);
      }
    }
  });
});
