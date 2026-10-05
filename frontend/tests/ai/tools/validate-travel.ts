/** Validates CarMotionModel.travelTime against the real sim at random OFF-grid samples (prints error stats). */
import { Driver, DRIVE_DEFAULT } from '../../../src/ai/controller';
import { SKILLS } from '../../../src/ai/difficulty';
import { BotRng } from '../../../src/ai/math';
import { CarMotionModel, CONTACT_REACH } from '../../../src/ai/intercept';
import { makeControlState } from '../../../src/sim/types';
import { freePlayWorld, info, place } from '../helpers';

const caps = { groundMax: 1.75, jumpMax: 0, doubleMax: 0, aerialMax: 0, aerialMinBoost: 100, wallMax: 0, useBoost: true, speedCap: 23, slack: 0 };
const rng = new BotRng(99);
let sum = 0, n = 0, worst = 0;
const errs: number[] = [];
for (let i = 0; i < 600; i++) {
  const w = freePlayWorld();
  const x0 = rng.range(-10, 10), z0 = rng.range(-10, 10);
  const hd = rng.range(-Math.PI, Math.PI);
  const v0 = rng.range(-6, 23);
  const boost = rng.chance(0.3) ? 0 : rng.range(0, 100);
  const car = place(w, 0, x0, z0, Math.sin(hd), Math.cos(hd), v0, boost);
  const tx = rng.range(-28, 28), tz = rng.range(-40, 40);
  const ci = info(w, 0);
  const model = new CarMotionModel(4, 1 / 60);
  model.update(ci, caps);
  const est = model.travelTime(ci, tx, tz, 0);
  const drv = new Driver(SKILLS.legend);
  const c = makeControlState();
  let hit = 10;
  for (let k = 0; k < 1200; k++) {
    info(w, 0, ci);
    drv.drive(ci, tx, 0, tz, 23, c, { ...DRIVE_DEFAULT });
    w.step([c]);
    if (Math.hypot(car.pos.x - tx, car.pos.z - tz) < CONTACT_REACH) { hit = (k + 1) / 120; break; }
  }
  if (hit >= 10) console.log(`never arrived: start (${x0.toFixed(1)},${z0.toFixed(1)}) hd ${hd.toFixed(2)} v0 ${v0.toFixed(1)} target (${tx.toFixed(1)},${tz.toFixed(1)}) end (${car.pos.x.toFixed(1)},${car.pos.y.toFixed(1)},${car.pos.z.toFixed(1)}) v ${car.vel.length().toFixed(1)} est ${est.toFixed(2)}`);
  const e = est - hit;
  errs.push(e);
  sum += Math.abs(e); n++;
  if (Math.abs(e) > Math.abs(worst)) worst = e;
}
errs.sort((a, b) => a - b);
console.log(`travelTime vs sim: mean |err| ${(sum / n).toFixed(3)} s, median ${errs[n >> 1].toFixed(3)}, p5 ${errs[Math.floor(n * 0.05)].toFixed(2)}, p95 ${errs[Math.floor(n * 0.95)].toFixed(2)}, worst ${worst.toFixed(2)}`);
