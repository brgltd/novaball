import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { arenaSDF } from '../../src/sim/arena';
import { ARENA, CAR } from '../../src/sim/constants';
import { Rng } from '../../src/sim/rng';
import type { ControlState } from '../../src/sim/types';
import { ctl, eventsOf, freePlayWorld, minCornerSDF, orient, place, run } from './helpers';

describe('car — ground driving', () => {
  it('throttle only reaches ~14 m/s (and no more)', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, -45, 0, 1);
    let t14 = -1;
    run(w, ctl({ throttle: 1 }), 6, (t) => {
      if (t14 < 0 && car.vel.length() >= 13.9) t14 = t;
    });
    expect(t14).toBeGreaterThan(1.5);
    expect(t14).toBeLessThan(3);
    expect(car.vel.length()).toBeGreaterThan(14);
    expect(car.vel.length()).toBeLessThanOrEqual(CAR.maxThrottleSpeed + 1e-6);
    expect(car.supersonic).toBe(false);
    expect(car.onGround).toBe(true);
    expect(Math.abs(car.pos.x)).toBeLessThan(1e-6); // drives straight
  });

  it('boosting reaches 23 m/s, becomes supersonic, and consumes boost', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 5, -45, 0, 1, 100); // x = 5: a lane without boost pads
    let tSuper = -1;
    run(w, ctl({ throttle: 1, boost: true }), 2.5, (t) => {
      if (tSuper < 0 && car.supersonic) tSuper = t;
    });
    expect(tSuper).toBeGreaterThan(1);
    expect(tSuper).toBeLessThan(2);
    expect(car.vel.length()).toBeCloseTo(CAR.maxSpeed, 6);
    expect(car.boost).toBeLessThan(100 - 2.4 * CAR.boostConsumption + 1);
    // supersonic hysteresis: stays supersonic slightly below the threshold, drops below the hold speed
    let lostAt = -1;
    run(w, ctl({ throttle: 0 }), 2, (t) => {
      if (lostAt < 0 && !car.supersonic) lostAt = t;
    });
    expect(lostAt).toBeGreaterThan(0);
    expect(car.vel.length()).toBeLessThan(CAR.supersonicHoldSpeed);
  });

  it('boost runs dry and stops accelerating', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, -45, 0, 1, 10);
    run(w, ctl({ boost: true }), 1);
    expect(car.boost).toBe(0);
    expect(car.isBoosting).toBe(false);
  });

  it('braking stops the car quickly, then reverses up to reverseMaxSpeed', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, -45, 0, 1);
    run(w, ctl({ throttle: 1 }), 5);
    const z0 = car.pos.z;
    const tStop = run(w, ctl({ throttle: -1 }), 2, () => car.vel.dot(car.fwd) <= 0);
    expect(tStop).toBeLessThan(0.5);
    expect(car.pos.z - z0).toBeLessThan(4);
    run(w, ctl({ throttle: -1 }), 5);
    expect(car.vel.dot(car.fwd)).toBeLessThan(-12);
    expect(-car.vel.dot(car.fwd)).toBeLessThanOrEqual(CAR.reverseMaxSpeed + 1e-6);
  });

  it('coasts to a stop without throttle', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, -45, 0, 1);
    run(w, ctl({ throttle: 1 }), 5);
    const t = run(w, ctl(), 6, () => car.vel.length() < 1e-6);
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(3.5);
  });

  it('turns right on steer +1 with a sane radius (~4.3 m at 10 m/s)', () => {
    const w = freePlayWorld();
    const car = place(w, 0, -15, -20, 0, 1);
    car.vel.set(0, 0, 10);
    const pts: Vector3[] = [];
    run(
      w,
      () => ctl({ steer: 1, throttle: car.vel.length() < 10 ? 1 : 0 }),
      4,
      (t) => {
        if (t > 1) pts.push(car.pos.clone());
      },
    );
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / pts.length);
    const r = pts.reduce((a, p) => a + Math.sqrt((p.x - c.x) ** 2 + (p.z - c.z) ** 2), 0) / pts.length;
    expect(r).toBeGreaterThan(3.5);
    expect(r).toBeLessThan(5.2);
    expect(c.x).toBeLessThan(-15); // circle center on the car's right (−X when facing +Z)
  });

  it('reverse steering follows the real-car convention', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, 0, 0, 1);
    car.vel.set(0, 0, -6);
    run(w, ctl({ throttle: -1, steer: 1 }), 0.5);
    // reversing with steer right swings the nose to the LEFT (+X when facing +Z) … the tail goes right
    expect(car.fwd.x).toBeGreaterThan(0.05);
  });

  it('powerslide drifts: large side slip, tighter heading change', () => {
    const w1 = freePlayWorld();
    const a = place(w1, 0, 0, -20, 0, 1);
    a.vel.set(0, 0, 14);
    run(w1, ctl({ throttle: 1, steer: 1 }), 0.6);
    const w2 = freePlayWorld();
    const b = place(w2, 0, 0, -20, 0, 1);
    b.vel.set(0, 0, 14);
    let maxSlip = 0;
    run(w2, ctl({ throttle: 1, steer: 1, powerslide: true }), 0.6, () => {
      const right = new Vector3().crossVectors(b.fwd, b.up);
      maxSlip = Math.max(maxSlip, Math.abs(b.vel.dot(right)));
    });
    expect(b.isPowersliding).toBe(true);
    expect(maxSlip).toBeGreaterThan(3);
    // heading turned further while sliding (angle turned to the right; the slide passes 90° within the 0.6 s)
    const turned = (c: typeof a) => Math.atan2(-c.fwd.x, c.fwd.z);
    expect(turned(a)).toBeGreaterThan(0);
    expect(turned(b)).toBeGreaterThan(turned(a) + 0.5);
  });

  it('a powerslide U-turn beats a normal one (yaw follows the planar speed), without yaw chatter', () => {
    /** Full right steer + throttle from `speed` along +Z: time until the heading has turned 180°, speed then. */
    const uTurn = (speed: number, slide: boolean) => {
      const w = freePlayWorld();
      const car = place(w, 0, 0, -20, 0, 1);
      car.vel.set(0, 0, speed);
      let t180 = -1;
      let exit = 0;
      let flips = 0;
      let sign = 0;
      run(w, ctl({ steer: 1, throttle: 1, powerslide: slide }), 3, (t) => {
        const s = Math.sign(car.angVel.y);
        if (s !== 0 && sign !== 0 && s !== sign) flips++;
        if (s !== 0) sign = s;
        if (car.fwd.z < -0.999) {
          t180 = t;
          exit = car.vel.length();
          return true;
        }
      });
      return { t180, exit, flips };
    };
    const normal14 = uTurn(14, false);
    const slide14 = uTurn(14, true);
    expect(normal14.t180).toBeGreaterThanOrEqual(1.4);
    expect(slide14.t180).toBeGreaterThan(0);
    expect(slide14.t180).toBeLessThanOrEqual(1.1);
    expect(slide14.exit).toBeGreaterThanOrEqual(8);
    const slide20 = uTurn(20, true);
    expect(slide20.t180).toBeGreaterThan(0);
    expect(slide20.t180).toBeLessThanOrEqual(1.3);
    for (const r of [slide14, slide20, uTurn(8, true)]) expect(r.flips).toBe(0); // steer held right ⇒ never yaws left
  });
});

describe('car — walls and ceiling', () => {
  it('drives up the side wall and stays attached while moving', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, 0, 1, 0); // facing +X, wall at x = +36 (normal −X)
    let maxUp = -1;
    let attachedTicks = 0;
    let detachedOnWall = 0;
    run(w, ctl({ throttle: 1, boost: true }), 2.8, () => {
      const upWall = -car.up.x;
      maxUp = Math.max(maxUp, upWall);
      if (car.pos.y > 5 && car.pos.y < 14) {
        if (car.onGround && upWall > 0.9) attachedTicks++;
        else detachedOnWall++;
      }
    });
    expect(maxUp).toBeGreaterThan(0.99);
    expect(attachedTicks).toBeGreaterThan(30);
    expect(detachedOnWall).toBe(0);
  });

  it('drives from the wall onto the ceiling, hangs briefly, then drops off', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, 0, 1, 0);
    let onCeil = -1;
    let offCeil = -1;
    run(w, ctl({ throttle: 1, boost: true }), 6, (t) => {
      if (onCeil < 0 && car.onGround && car.up.y < -0.9) onCeil = t;
      if (onCeil > 0 && offCeil < 0 && !car.onGround) offCeil = t;
      return offCeil > 0 && t > offCeil + 0.5;
    });
    expect(onCeil).toBeGreaterThan(0);
    expect(offCeil).toBeGreaterThan(onCeil);
    const hang = offCeil - onCeil;
    expect(hang).toBeGreaterThan(0.3);
    expect(hang).toBeLessThan(1.2);
    expect(car.vel.y).toBeLessThan(0); // falling
  });

  it('a car that stops on a wall slides back down instead of parking there', () => {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(ARENA.halfWidth - CAR.rideHeight, 8, 0);
    orient(car, new Vector3(-1, 0, 0), new Vector3(0, 0, 1));
    car.prevNormal.set(-1, 0, 0);
    car.vel.set(0, 0, 2);
    run(w, ctl(), 4);
    expect(car.pos.y).toBeLessThan(2);
    expect(car.onGround).toBe(true);
  });

  it('jumping off a wall pushes away from it', () => {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(ARENA.halfWidth - CAR.rideHeight, 8, 0);
    orient(car, new Vector3(-1, 0, 0), new Vector3(0, 0, 1));
    car.prevNormal.set(-1, 0, 0);
    car.vel.set(0, 0, 10);
    run(w, (t) => ctl({ throttle: 1, jump: t > 0.05 && t < 0.2 }), 0.6);
    expect(car.onGround).toBe(false);
    expect(car.vel.x).toBeLessThan(-2);
    expect(car.pos.x).toBeLessThan(ARENA.halfWidth - 1.5);
  });

  it('never tunnels: full-speed runs into corners, end walls, goal posts and goal interiors', () => {
    const targets = [
      [ARENA.halfWidth, ARENA.halfLength],
      [-ARENA.halfWidth, ARENA.halfLength],
      [ARENA.halfWidth, -ARENA.halfLength],
      [-ARENA.halfWidth, -ARENA.halfLength],
      [0, ARENA.halfLength + ARENA.goalDepth],
      [0, -ARENA.halfLength - ARENA.goalDepth],
      [ARENA.goalHalfWidth, ARENA.halfLength],
      [-ARENA.goalHalfWidth, -ARENA.halfLength],
      [ARENA.goalHalfWidth + 3, ARENA.halfLength],
      [20, ARENA.halfLength],
    ];
    for (const [tx, tz] of targets) {
      for (const jumpy of [false, true]) {
        const w = freePlayWorld();
        const sx = tx * 0.2;
        const sz = tz * 0.2;
        const car = place(w, 0, sx, sz, tx - sx, tz - sz);
        let worst = Infinity;
        run(w, (t) => ctl({ throttle: 1, boost: true, jump: jumpy && t % 1 < 0.15, pitch: jumpy ? 0.3 : 0 }), 6, () => {
          worst = Math.min(worst, minCornerSDF(car));
          expect(arenaSDF(car.pos.x, car.pos.y, car.pos.z)).toBeGreaterThan(0);
        });
        expect(worst).toBeGreaterThan(-0.05);
      }
    }
  });

  it('survives 120 chaotic random-input runs without tunneling, NaNs or getting stuck', () => {
    const rng = new Rng(4242);
    let worst = Infinity;
    for (let k = 0; k < 120; k++) {
      const w = freePlayWorld();
      const a = rng.range(0, 6.283);
      const car = place(w, 0, rng.range(-30, 30), rng.range(-45, 45), Math.sin(a), Math.cos(a));
      let c: ControlState = ctl();
      let still = 0;
      let maxStill = 0;
      for (let i = 0; i < 960; i++) {
        if (i % 60 === 0) {
          c = ctl({
            throttle: rng.next() < 0.75 ? 1 : -1,
            steer: rng.range(-1, 1),
            boost: rng.next() < 0.6,
            jump: rng.next() < 0.3,
            pitch: rng.range(-1, 1),
            yaw: rng.range(-1, 1),
            roll: rng.next() < 0.3 ? rng.range(-1, 1) : 0,
            powerslide: rng.next() < 0.2,
          });
        } else if (i % 60 === 8) c = { ...c, jump: false };
        else if (i % 60 === 14 && rng.next() < 0.5) c = { ...c, jump: true };
        w.step([c]);
        worst = Math.min(worst, minCornerSDF(car));
        expect(Number.isFinite(car.pos.x + car.pos.y + car.pos.z + car.vel.x + car.vel.y + car.vel.z + car.quat.w)).toBe(true);
        still = car.vel.length() < 0.2 ? still + 1 : 0;
        maxStill = Math.max(maxStill, still);
      }
      // with random throttle every 0.5 s a car may never be motionless for > 3 s (turtle / wedge = stuck)
      expect(maxStill).toBeLessThan(360);
    }
    expect(worst).toBeGreaterThan(-0.05);
  });

  it('emits carImpact on hard wall hits', () => {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(0, 10, 30);
    orient(car, new Vector3(0, 1, 0), new Vector3(0, 0, 1));
    car.vel.set(0, 0, 20); // flying nose-first into the end wall above the goal
    car.onGround = false;
    let impacts = 0;
    run(w, ctl(), 2, () => {
      impacts += eventsOf(w.drainEvents(), 'carImpact').length;
    });
    expect(impacts).toBeGreaterThan(0);
  });
});
