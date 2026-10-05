/**
 * Reusable scenarios for the sim tests (hit tuning, feel metrics).
 */
import { Vector3 } from 'three';
import { BALL, CAR } from '../../src/sim/constants';
import type { SimEvent } from '../../src/sim/types';
import { ctl, eventsOf, freePlayWorld, place, run } from './helpers';

/** Car driving at constant `speed` along +Z into a resting ball. */
export function groundHit(speed: number, offsetX = 0) {
  const w = freePlayWorld(false);
  const car = place(w, 0, offsetX, -3.2, 0, 1);
  w.ball.pos.set(0, BALL.radius, 0);
  let hit: Extract<SimEvent, { type: 'ballHit' }> | null = null;
  const after = new Vector3();
  let tHit = 0;
  let hits = 0;
  run(
    w,
    () => {
      if (!hit) car.vel.set(0, 0, speed);
      return ctl({ throttle: 1 });
    },
    0.6,
    (t) => {
      for (const e of eventsOf(w.drainEvents(), 'ballHit')) {
        hits++;
        if (!hit) {
          hit = e;
          tHit = t;
        }
      }
      if (hit && t - tHit > 0.03 && after.lengthSq() === 0) after.copy(w.ball.vel);
    },
  );
  return { w, car, hit: hit as Extract<SimEvent, { type: 'ballHit' }> | null, after, hits };
}

/** Car at `speed` jumps and front-flips into a resting ball; returns the best (strongest) timing. */
export function dodgeHit(speed: number) {
  let best = { speed: 0, after: new Vector3(), dodge: false };
  for (let lead = 0; lead <= 0.3; lead += 0.01) {
    const w = freePlayWorld(false);
    const z0 = -(CAR.halfExtents.z + 0.94 + speed * (0.1 + lead));
    const car = place(w, 0, 0, z0, 0, 1);
    car.vel.set(0, 0, speed);
    w.ball.pos.set(0, BALL.radius, 0);
    let hit: Extract<SimEvent, { type: 'ballHit' }> | null = null;
    const after = new Vector3();
    let tHit = 0;
    run(w, (t) => ctl({ throttle: 1, jump: t < 0.03 || (t > 0.06 && t < 0.1), pitch: t > 0.05 ? 1 : 0 }), 0.8, (t) => {
      for (const e of eventsOf(w.drainEvents(), 'ballHit')) if (!hit) {
        hit = e;
        tHit = t;
      }
      if (hit && t - tHit > 0.03 && after.lengthSq() === 0) after.copy(w.ball.vel);
    });
    const h = hit as Extract<SimEvent, { type: 'ballHit' }> | null;
    if (h && h.dodge && after.length() > best.speed) best = { speed: after.length(), after, dodge: true };
  }
  return best;
}
