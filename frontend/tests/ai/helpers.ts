/**
 * Shared helpers for the AI tests (own copy — independent from tests/sim).
 */
import { Quaternion } from 'three';
import type { SimCar } from '../../src/sim/car';
import { resetCarKinematics } from '../../src/sim/car';
import type { ControlState, MatchConfig } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { quatFromHeading } from '../../src/sim/vmath';
import { World } from '../../src/sim/world';
import { readCar } from '../../src/ai/sense';
import type { CarInfo } from '../../src/ai/types';
import { makeCarInfo } from '../../src/ai/types';

export function config(over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    teamSize: 1,
    durationSec: 180,
    difficulty: 'pro',
    seed: 7,
    freePlay: false,
    mutators: { charge: true, pulse: true, surges: true, demolitions: true },
    player: null,
    ...over,
  };
}

/** Free-play world already in 'playing' (1 car). `hideBall` makes the ball non-colliding. */
export function freePlayWorld(hideBall = true): World {
  const w = new World(config({ freePlay: true, player: { name: 'T', style: 'striker', paint: '#fff' } }));
  while (w.match.phase !== 'playing') w.step([]);
  if (hideBall) w.ball.exploded = true;
  w.drainEvents();
  return w;
}

const _q = new Quaternion();
/** Car on the floor at (x, z) facing (hx, hz) with forward speed v. */
export function place(w: World, id: number, x: number, z: number, hx: number, hz: number, v = 0, boost = 100): SimCar {
  const car = w.cars[id];
  resetCarKinematics(car, x, z, quatFromHeading(hx, hz, _q), boost);
  const l = Math.hypot(hx, hz);
  car.vel.set((hx / l) * v, 0, (hz / l) * v);
  return car;
}

export function info(w: World, id: number, out: CarInfo = makeCarInfo()): CarInfo {
  return readCar(w.cars[id], true, 1 / 120, out);
}

export function inputsFor(w: World): ControlState[] {
  return w.cars.map(() => makeControlState());
}
