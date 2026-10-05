/**
 * AI primitives: travel-time model vs the real sim, driving (no orbiting), air orientation, cut model,
 * perception delay, curvature inversion.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { cutOffset } from '../../src/ai/bot';
import { Driver, DRIVE_DEFAULT, orientTo } from '../../src/ai/controller';
import { SKILLS } from '../../src/ai/difficulty';
import { CarMotionModel, CONTACT_REACH } from '../../src/ai/intercept';
import { BotRng } from '../../src/ai/math';
import { BallPerception } from '../../src/ai/perception';
import { DOUBLE_JUMP_AT, jumpApex, jumpTiming, maxSpeedForCurvature, steerCurvature, timeToRise } from '../../src/ai/physics';
import { tableTravelTime } from '../../src/ai/travel';
import { TT_A, TT_B, TT_D, TT_V } from '../../src/ai/travelGrid';
import { updateAxes } from '../../src/sim/car';
import { SURGE } from '../../src/sim/constants';
import { carGravityScaleFor } from '../../src/sim/match';
import { makeControlState } from '../../src/sim/types';
import { freePlayWorld, info, place } from './helpers';
import { measure } from './tools/gen-travel-table';

describe('AI primitives', () => {
  it('measured travel table still matches the sim + Driver (regenerate with tests/ai/tools/gen-travel-table.ts)', () => {
    const rng = new BotRng(3);
    let worst = 0;
    for (let i = 0; i < 24; i++) {
      const b = TT_B[rng.int(TT_B.length)];
      const v = TT_V[rng.int(TT_V.length)];
      const a = TT_A[rng.int(TT_A.length)];
      const d = TT_D[rng.int(TT_D.length)];
      const live = measure(v, a, d, b);
      const table = tableTravelTime(v, (a * Math.PI) / 180, d, b);
      worst = Math.max(worst, Math.abs(live - table));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('travel-time model predicts off-grid arrivals (median error < 0.05 s) and the Driver never orbits', () => {
    const rng = new BotRng(99);
    const caps = { groundMax: 1.75, jumpMax: 0, doubleMax: 0, aerialMax: 0, aerialMinBoost: 100, wallMax: 0, useBoost: true, speedCap: 23, slack: 0 };
    const errs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const w = freePlayWorld();
      const hd = rng.range(-Math.PI, Math.PI);
      const car = place(w, 0, rng.range(-10, 10), rng.range(-10, 10), Math.sin(hd), Math.cos(hd), rng.range(-6, 23), rng.chance(0.3) ? 0 : rng.range(0, 100));
      const tx = rng.range(-28, 28);
      const tz = rng.range(-40, 40);
      const ci = info(w, 0);
      const model = new CarMotionModel(4, 1 / 60);
      model.update(ci, caps);
      const est = model.travelTime(ci, tx, tz, 0);
      const drv = new Driver(SKILLS.legend);
      const c = makeControlState();
      let hit = -1;
      for (let k = 0; k < 1200; k++) {
        info(w, 0, ci);
        drv.drive(ci, tx, 0, tz, 23, c, { ...DRIVE_DEFAULT });
        w.step([c]);
        if (Math.hypot(car.pos.x - tx, car.pos.z - tz) < CONTACT_REACH) {
          hit = (k + 1) / 120;
          break;
        }
      }
      expect(hit).toBeGreaterThan(0); // always arrives (no orbiting / stuck)
      errs.push(Math.abs(est - hit));
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(0.05);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.4);
  });

  it('air orientation PD settles within 1 s from random tumbles (≥ 90 %)', () => {
    const rng = new BotRng(5);
    let ok = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const w = freePlayWorld();
      const car = w.cars[0];
      car.pos.set(0, 12, 0);
      car.onGround = false;
      car.quat.copy(new Quaternion(rng.gauss(1), rng.gauss(1), rng.gauss(1), rng.gauss(1)).normalize());
      car.angVel.set(rng.gauss(2), rng.gauss(2), rng.gauss(2));
      updateAxes(car);
      const th = rng.range(-Math.PI, Math.PI);
      const F = new Vector3(Math.sin(th), 0, Math.cos(th));
      const c = makeControlState();
      const ci = info(w, 0);
      let settled = false;
      for (let k = 0; k < 120; k++) {
        info(w, 0, ci);
        const ang = orientTo(ci, car.quat, F.x, F.y, F.z, 0, 1, 0, c);
        w.step([c]);
        car.pos.y = 12;
        car.vel.set(0, 0, 0);
        if (ang < 0.17) settled = true;
      }
      if (settled) ok++;
    }
    expect(ok / N).toBeGreaterThanOrEqual(0.9);
  });

  it('jump timing: the cached rise model matches the exact one (normal and surge car gravity)', () => {
    // planner (findIntercept) and executor (jump shots) share JumpTiming.riseTime: it must agree with the closed form
    for (const g of [1, carGravityScaleFor(SURGE.gravityScale)]) {
      const jt = jumpTiming(g);
      expect(Math.abs(jt.singleApex - jumpApex(g).rise)).toBeLessThan(1e-9);
      for (const dbl of [false, true]) {
        const apex = dbl ? jt.doubleApex : jt.singleApex;
        for (let r = 0.2; r < apex - 0.05; r += 0.1) {
          const exact = timeToRise(r, g, dbl ? DOUBLE_JUMP_AT : -1);
          expect(Math.abs(jt.riseTime(r, dbl) - exact)).toBeLessThan(0.015);
        }
        // at / above the apex: the apex time (roof / nose meets the ball at the top of the jump)
        expect(jt.riseTime(apex + 0.3, dbl)).toBe(dbl ? jt.doubleApexT : jt.singleApexT);
      }
    }
  });

  it('cut model is monotonic and bounded; curvature inversion is consistent', () => {
    let prev = -1;
    for (let c = 0; c <= 0.6; c += 0.05) {
      const d = cutOffset(c);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(1.25);
      prev = d;
    }
    expect(cutOffset(0)).toBe(0);
    for (const v of [2, 6, 10, 15, 20]) {
      const k = steerCurvature(v);
      expect(Math.abs(maxSpeedForCurvature(k) - v)).toBeLessThan(0.05);
    }
  });

  it('perception delay: the perceived ball is the true ball N ticks ago', () => {
    const w = freePlayWorld(false);
    w.ball.vel.set(5, 0, 3);
    const p = new BallPerception(18);
    const hist: Vector3[] = [];
    for (let i = 0; i < 60; i++) {
      p.push(w.ball);
      hist.push(w.ball.pos.clone());
      if (i >= 18) expect(p.perceived.pos.distanceTo(hist[i - 18])).toBeLessThan(1e-9);
      w.step([]);
    }
  });
});
