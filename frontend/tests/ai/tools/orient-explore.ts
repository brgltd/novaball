/** Exploration: air orientation PD gains — time to settle within 10° from random tumbling states. */
import { Quaternion, Vector3 } from 'three';
import { orientTo, ORIENT_GAINS, type OrientGains } from '../../../src/ai/controller';
import { BotRng } from '../../../src/ai/math';
import { makeControlState } from '../../../src/sim/types';
import { freePlayWorld, info } from '../helpers';
import { updateAxes } from '../../../src/sim/car';

function trial(g: OrientGains, seed: number): { settle: number; over: number } {
  const rng = new BotRng(seed);
  let sumT = 0, n = 0, overs = 0;
  for (let i = 0; i < 150; i++) {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(0, 12, 0);
    car.vel.set(0, 0, 0);
    car.onGround = false;
    const q = new Quaternion(rng.gauss(1), rng.gauss(1), rng.gauss(1), rng.gauss(1)).normalize();
    car.quat.copy(q);
    car.angVel.set(rng.gauss(2), rng.gauss(2), rng.gauss(2));
    updateAxes(car);
    // target: random forward, up = world up (landing pose) or random
    const th = rng.range(-Math.PI, Math.PI);
    const F = new Vector3(Math.sin(th), 0, Math.cos(th));
    const U = new Vector3(0, 1, 0);
    if (i % 3 === 0) { F.set(rng.gauss(1), rng.gauss(1), rng.gauss(1)).normalize(); U.set(rng.gauss(1), rng.gauss(1), rng.gauss(1)); }
    const c = makeControlState();
    const ci = info(w, 0);
    let settled = -1;
    let within = 0;
    let wasIn = false, left = false;
    for (let k = 0; k < 240; k++) {
      info(w, 0, ci);
      const ang = orientTo(ci, car.quat, F.x, F.y, F.z, U.x, U.y, U.z, c, g);
      if (ang < 0.1745) { within++; if (!wasIn) wasIn = true; } else { if (wasIn && ang > 0.35) left = true; within = 0; }
      if (within >= 12 && settled < 0) settled = (k - 11) / 120;
      w.step([c]);
      car.pos.y = 12; car.vel.set(0, 0, 0); // hold in the air
    }
    if (settled < 0) settled = 2;
    if (left) overs++;
    sumT += settled; n++;
  }
  return { settle: sumT / n, over: overs };
}
const base = { ...ORIENT_GAINS };
const vs: Array<[string, Partial<OrientGains>]> = [];
for (const kp of [1.0, 1.2, 1.4])
  for (const kd of [0.5, 0.6, 0.7, 0.85])
    vs.push([`kp${kp} kd${kd}`, { pitchKp: base.pitchKp * kp, yawKp: base.yawKp * kp, rollKp: base.rollKp * kp, pitchKd: base.pitchKd * kd, yawKd: base.yawKd * kd, rollKd: base.rollKd * kd }]);
for (const [name, v] of vs) {
  const r = trial({ ...base, ...v }, 5);
  console.log(`${name.padEnd(14)} settle ${r.settle.toFixed(3)} s  overshoot-runs ${r.over}/150`);
}
