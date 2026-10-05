/** Exploration: ball direction vs lateral offset of a straight-driving car (ground hit, and front-flip hit). */
import { makeControlState } from '../../../src/sim/types';
import { freePlayWorld, place } from '../helpers';
import { FLIP_TTC } from '../../../src/ai/bot';

function hit(v: number, off: number, flip: boolean, ttc = FLIP_TTC): { ang: number; sp: number } {
  const w = freePlayWorld(false);
  const car = place(w, 0, off, -12, 0, 1, v, 100);
  w.ball.pos.set(0, 1, 0);
  w.ball.vel.set(0, 0, 0);
  const c = makeControlState();
  let t0 = -1;
  for (let i = 0; i < 300; i++) {
    c.throttle = 1;
    c.boost = false;
    c.jump = false;
    c.pitch = 0;
    if (!flip && i < 200) car.vel.set(0, car.vel.y, v); // hold speed until contact
    if (flip) {
      const gap = -car.pos.z - 1.56;
      if (t0 < 0 && gap / Math.max(car.vel.z, 1) < ttc) t0 = i;
      if (t0 < 0) car.vel.set(0, car.vel.y, v);
      if (t0 >= 0) {
        const k = i - t0;
        if (k < 6) c.jump = true;
        else if (k >= 12 && k < 15) {
          c.jump = true;
          c.pitch = 1;
        }
      }
    }
    w.step([c]);
    if (w.ball.vel.lengthSq() > 1) {
      for (let j = 0; j < 3; j++) w.step([c]);
      const b = w.ball.vel;
      return { ang: (Math.atan2(-b.x, b.z) * 180) / Math.PI, sp: b.length() };
    }
  }
  return { ang: NaN, sp: 0 };
}
for (const flip of [false, true]) {
  console.log(flip ? 'FRONT FLIP' : 'GROUND');
  for (const v of [8, 14, 20, 23]) {
    const row: string[] = [];
    for (const off of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4]) {
      const r = hit(v, -off, flip); // car at -x offset (its right side is -x? car faces +z: right = -x)
      row.push(`${off.toFixed(1)}:${r.ang.toFixed(0)}°/${r.sp.toFixed(0)}`);
    }
    console.log(`  v${v}  ${row.join('  ')}`);
  }
}
