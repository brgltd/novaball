/**
 * Recovery: turtled bots self-right, bots on a wall come back down to play, bots falling off the ceiling land
 * wheels-down.
 */
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BotManager } from '../../src/ai/BotManager';
import { BotRng } from '../../src/ai/math';
import { updateAxes } from '../../src/sim/car';
import type { SimMatchState } from '../../src/sim/match';
import type { Difficulty } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { config, place } from './helpers';

function world(): World {
  const w = new World(config({ teamSize: 1, seed: 3, mutators: { charge: true, pulse: false, surges: false, demolitions: false } }));
  while (w.match.phase !== 'playing') w.step([]);
  (w.match as SimMatchState).kickoffPending = false;
  // park the opponent
  const opp = w.cars[1];
  place(w, 1, 30, 45, 0, -1);
  opp.demolished = true;
  opp.respawnTimer = 1e9;
  w.drainEvents();
  return w;
}

function orient(car: World['cars'][number], up: Vector3, fwd: Vector3): void {
  const left = new Vector3().crossVectors(up, fwd).normalize();
  car.quat.setFromRotationMatrix(new Matrix4().makeBasis(left, up, fwd));
  updateAxes(car as never);
}

describe('recovery', () => {
  it('a turtled bot self-rights within 2 s', () => {
    const w = world();
    const car = place(w, 0, 0, -20, 0, 1);
    car.pos.y = 0.3;
    orient(car, new Vector3(0, -1, 0), new Vector3(0, 0, 1));
    car.onGround = false;
    w.ball.pos.set(0, 1, 20);
    const bots = new BotManager(w, [0], 'pro', 1);
    const inputs = [makeControlState(), makeControlState()];
    let upright = -1;
    for (let i = 0; i < 240; i++) {
      bots.update(w, inputs);
      w.step(inputs);
      if (car.onGround && car.up.y > 0.9) {
        upright = i / 120;
        break;
      }
    }
    expect(upright).toBeGreaterThan(0);
    expect(upright).toBeLessThan(2);
  });

  it('a bot parked on the side wall comes back down to play the ball', () => {
    const w = world();
    const car = place(w, 0, 0, 0, 0, 1);
    car.pos.set(-35.5, 8, -10);
    orient(car, new Vector3(1, 0, 0), new Vector3(0, 0, 1));
    car.vel.set(0, 0, 5);
    w.ball.pos.set(0, 1, 10);
    const bots = new BotManager(w, [0], 'pro', 1);
    const inputs = [makeControlState(), makeControlState()];
    let touched = -1;
    for (let i = 0; i < 120 * 8 && touched < 0; i++) {
      bots.update(w, inputs);
      w.step(inputs);
      for (const e of w.drainEvents()) if (e.type === 'ballHit' && e.carId === 0) touched = i / 120;
    }
    expect(touched).toBeGreaterThan(0);
  });

  it('a ball held at jump height (pinned on a ramp / resting on a car) never freezes a bot in its jump setup', () => {
    // livelock seen in real matches: planner and executor disagreed on the jump rise time, so the bot parked next to a
    // static ball at 2–3 m waiting for a jump that never came (and never moved: its speed target was 0)
    const rng = new BotRng(77);
    let touched = 0;
    let worst = 0;
    let n = 0;
    for (const diff of ['legend', 'pro', 'rookie'] as Difficulty[]) {
      for (let i = 0; i < 6; i++) {
        const w = world();
        const bx = rng.range(-15, 15);
        const bz = rng.range(-5, 25);
        const by = rng.range(1.9, 3.1);
        const a = rng.range(-Math.PI, Math.PI);
        const d = rng.range(1.5, 4);
        const hd = a + rng.range(-0.5, 0.5);
        place(w, 0, bx - Math.sin(a) * d, bz - Math.cos(a) * d, Math.sin(hd), Math.cos(hd), rng.range(0, 2), 60);
        const bots = new BotManager(w, [0], diff, 5 + i);
        const inputs = [makeControlState(), makeControlState()];
        let run = 0;
        let hit = false;
        for (let k = 0; k < 120 * 4 && !hit; k++) {
          w.ball.pos.set(bx, by, bz);
          w.ball.vel.set(0, 0, 0);
          w.ball.angVel.set(0, 0, 0);
          bots.update(w, inputs);
          w.step(inputs);
          for (const e of w.drainEvents()) if (e.type === 'ballHit' && e.carId === 0) hit = true;
          run = bots.botState(0)!.mode === 'jumpSetup' && w.cars[0].vel.length() < 0.5 ? run + 1 / 120 : 0;
          worst = Math.max(worst, run);
        }
        if (hit) touched++;
        n++;
      }
    }
    expect(worst, `longest still jumpSetup ${worst.toFixed(2)} s`).toBeLessThan(1.5);
    expect(touched / n, `touched ${touched}/${n}`).toBeGreaterThanOrEqual(0.25);
  });

  it('a bot dropping off the ceiling lands on its wheels', () => {
    const w = world();
    const car = place(w, 0, 0, 0, 0, 1);
    car.pos.set(5, 19, 0);
    orient(car, new Vector3(0, -1, 0), new Vector3(1, 0, 0));
    car.onGround = false;
    car.vel.set(3, -1, 0);
    w.ball.pos.set(0, 1, 25);
    const bots = new BotManager(w, [0], 'legend', 1);
    const inputs = [makeControlState(), makeControlState()];
    let landUp = -2;
    for (let i = 0; i < 120 * 5; i++) {
      bots.update(w, inputs);
      w.step(inputs);
      for (const e of w.drainEvents()) if (e.type === 'land' && e.carId === 0 && landUp === -2) landUp = car.up.y;
      if (landUp !== -2) break;
    }
    expect(landUp).toBeGreaterThan(0.8);
  });
});
