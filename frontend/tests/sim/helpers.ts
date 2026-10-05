/**
 * Shared helpers for the sim acceptance tests.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { arenaSDF } from '../../src/sim/arena';
import type { SimCar } from '../../src/sim/car';
import { resetCarKinematics, updateAxes } from '../../src/sim/car';
import { CAR, SIM_HZ } from '../../src/sim/constants';
import type { ControlState, MatchConfig, SimEvent, SimEventType } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { quatFromHeading } from '../../src/sim/vmath';
import { World } from '../../src/sim/world';

export function config(over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    teamSize: 1,
    durationSec: 180,
    difficulty: 'pro',
    seed: 7,
    freePlay: false,
    mutators: { charge: true, pulse: true, surges: true, demolitions: true },
    player: { name: 'TESTER', style: 'striker', paint: '#e8eef7' },
    ...over,
  };
}

/** Free-play world already in 'playing'. `hideBall` makes the ball non-colliding (car-only tests). */
export function freePlayWorld(hideBall = true, over: Partial<MatchConfig> = {}): World {
  const w = new World(config({ freePlay: true, ...over }));
  while (w.match.phase !== 'playing') w.step([]);
  if (hideBall) w.ball.exploded = true;
  w.drainEvents();
  return w;
}

/** Step until the phase is 'playing' (skips the kickoff countdown). */
export function skipCountdown(w: World, inputs: ControlState[] = []): void {
  let guard = 0;
  while (w.match.phase === 'countdown' && guard++ < 100000) w.step(inputs);
}

export function ctl(p: Partial<ControlState> = {}): ControlState {
  return { ...makeControlState(), ...p };
}

const _q = new Quaternion();
/** Car on the floor at (x, z) facing (hx, hz), at rest. */
export function place(w: World, id: number, x: number, z: number, hx: number, hz: number, boost = 100): SimCar {
  const car = w.cars[id];
  resetCarKinematics(car, x, z, quatFromHeading(hx, hz, _q), boost);
  return car;
}

/** Orient a car so its local up/forward match the given world directions (orthonormal). */
export function orient(car: SimCar, up: Vector3, fwd: Vector3): void {
  const left = new Vector3().crossVectors(up, fwd).normalize();
  car.quat.setFromRotationMatrix(new Matrix4().makeBasis(left, up, fwd));
  updateAxes(car);
}

/**
 * Run `seconds` of sim with a control function for car 0 (other cars neutral unless `others` given).
 * `each` is called after every step with the elapsed time; return true to stop early. Returns elapsed time.
 */
export function run(
  w: World,
  c: ControlState | ((t: number) => ControlState),
  seconds: number,
  each?: (t: number) => boolean | void,
  others?: (t: number, inputs: ControlState[]) => void,
): number {
  const n = Math.round(seconds * SIM_HZ);
  const inputs: ControlState[] = [];
  for (let i = 0; i < w.cars.length; i++) inputs.push(makeControlState());
  for (let i = 0; i < n; i++) {
    const t = i / SIM_HZ;
    inputs[0] = typeof c === 'function' ? c(t) : c;
    if (others) others(t, inputs);
    w.step(inputs);
    if (each && each((i + 1) / SIM_HZ) === true) return (i + 1) / SIM_HZ;
  }
  return seconds;
}

export function eventsOf<T extends SimEventType>(evs: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return evs.filter((e) => e.type === type) as Extract<SimEvent, { type: T }>[];
}

const HX = CAR.halfExtents.x;
const HY = CAR.halfExtents.y;
const HZ = CAR.halfExtents.z;
const _p = new Vector3();
/** Min arena SDF over the 8 hitbox corners (negative = penetrating). */
export function minCornerSDF(car: SimCar): number {
  let m = Infinity;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        _p.copy(car.pos).addScaledVector(car.left, sx * HX).addScaledVector(car.up, sy * HY).addScaledVector(car.fwd, sz * HZ);
        const d = arenaSDF(_p.x, _p.y, _p.z);
        if (d < m) m = d;
      }
  return m;
}
