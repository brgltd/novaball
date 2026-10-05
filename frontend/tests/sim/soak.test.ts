import { describe, expect, it } from 'vitest';
import { arenaSDF } from '../../src/sim/arena';
import { BALL, SIM_HZ } from '../../src/sim/constants';
import type { TeamSize } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { ChaseBots } from './bots';
import { config, minCornerSDF } from './helpers';

describe('soak', () => {
  it('full bot matches (1v1, 2v2, 3v3): ball & cars stay inside, no NaNs, match flow completes', () => {
    const totals: Record<string, number> = {};
    for (const [teamSize, seed] of [
      [1, 11],
      [2, 22],
      [3, 33],
      [3, 44],
    ] as Array<[TeamSize, number]>) {
      const w = new World(config({ teamSize, seed, durationSec: 120, player: null }));
      const bots = new ChaseBots(teamSize * 2, seed);
      let worstBall = Infinity;
      let worstCar = Infinity;
      let steps = 0;
      // 120 s regulation + goal phases + countdowns + possible overtime; cap at 6 sim-minutes
      while (w.match.phase !== 'ended' && steps < 360 * SIM_HZ) {
        w.step(bots.update(w));
        steps++;
        for (const e of w.drainEvents()) totals[e.type] = (totals[e.type] ?? 0) + 1;
        if (!w.ball.exploded) worstBall = Math.min(worstBall, arenaSDF(w.ball.pos.x, w.ball.pos.y, w.ball.pos.z));
        for (const c of w.cars) {
          if (c.demolished) continue;
          worstCar = Math.min(worstCar, minCornerSDF(c));
          if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.x + c.vel.y + c.vel.z + c.quat.x + c.angVel.y)) {
            throw new Error(`NaN car ${c.id} at tick ${w.tick}`);
          }
        }
        if (!Number.isFinite(w.ball.pos.x + w.ball.pos.y + w.ball.pos.z + w.ball.vel.length())) throw new Error(`NaN ball at tick ${w.tick}`);
      }
      console.info(
        `[soak] ${teamSize}v${teamSize} seed ${seed}: ${(steps / SIM_HZ).toFixed(0)} s, score ${w.match.score.join('-')}, phase ${w.match.phase}` +
          `${w.match.overtime ? ' (OT)' : ''}, worst ball SDF ${worstBall.toFixed(4)}, worst car corner SDF ${worstCar.toFixed(4)}`,
      );
      expect(worstBall).toBeGreaterThanOrEqual(BALL.radius - 0.05);
      expect(worstCar).toBeGreaterThan(-0.08);
      if (w.match.phase === 'ended') {
        expect(w.match.winner === -1 ? w.match.score[0] === w.match.score[1] : true).toBe(true);
      }
    }
    console.info(`[soak] events: ${JSON.stringify(totals)}`);
    // across all matches the bots must have produced real games
    expect(totals.goal ?? 0).toBeGreaterThan(0);
    expect(totals.ballHit ?? 0).toBeGreaterThan(50);
    expect(totals.matchEnd ?? 0).toBeGreaterThan(0);
  });
});
