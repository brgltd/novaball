import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { updateAxes } from '../../src/sim/car';
import { CAR } from '../../src/sim/constants';
import type { ControlState } from '../../src/sim/types';
import { ctl, eventsOf, freePlayWorld, orient, place, run } from './helpers';

function jumpApex(controls: (t: number) => ControlState, seconds = 3): { rise: number; events: string[] } {
  const w = freePlayWorld();
  const car = place(w, 0, 0, 0, 0, 1);
  const y0 = car.pos.y;
  let apex = y0;
  const events: string[] = [];
  run(w, controls, seconds, () => {
    apex = Math.max(apex, car.pos.y);
    for (const e of w.drainEvents()) events.push(e.type + (e.type === 'jump' ? (e.double ? ':double' : ':first') : ''));
  });
  return { rise: apex - y0, events };
}

/** Jump, then dodge with (pitch, yaw) at 0.12 s. Returns Δv of the dodge tick and landing info. */
function dodge(pitch: number, yaw: number, speed = 0) {
  const w = freePlayWorld();
  const car = place(w, 0, 0, -20, 0, 1);
  car.vel.set(0, 0, speed);
  const before = new Vector3();
  const after = new Vector3();
  let dodged = false;
  let landT = -1;
  let upAtLand = 0;
  let rotated = 0;
  const qPrev = car.quat.clone();
  const evs: string[] = [];
  run(
    w,
    (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), pitch: t >= 0.1 ? pitch : 0, yaw: t >= 0.1 ? yaw : 0 }),
    2.5,
    (t) => {
      if (!dodged && !car.hasDodged) before.copy(car.vel);
      if (!dodged && car.hasDodged) {
        dodged = true;
        after.copy(car.vel);
      }
      // accumulate rotation angle between ticks (test-only trig is fine)
      const dq = car.quat.clone().multiply(qPrev.clone().invert());
      rotated += 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
      qPrev.copy(car.quat);
      for (const e of w.drainEvents()) evs.push(e.type);
      if (t > 0.3 && car.onGround && landT < 0) {
        landT = t;
        upAtLand = car.up.y;
      }
    },
  );
  return { car, dv: after.clone().sub(before), landT, upAtLand, rotated, evs };
}

describe('car — jumps, dodges, air control', () => {
  it('single jump apex ≈ 2.4 m (full hold), short tap lower', () => {
    const full = jumpApex((t) => ctl({ jump: t < 0.3 }));
    expect(full.rise).toBeGreaterThan(2.1);
    expect(full.rise).toBeLessThan(2.7);
    expect(full.events.filter((e) => e === 'jump:first').length).toBe(1);
    const tap = jumpApex((t) => ctl({ jump: t < 0.01 }));
    expect(tap.rise).toBeGreaterThan(0.5);
    expect(tap.rise).toBeLessThan(full.rise * 0.5);
  });

  it('double jump goes much higher (≈ 4.5–5.2 m)', () => {
    const dbl = jumpApex((t) => ctl({ jump: t < 0.2 || (t > 0.25 && t < 0.35) }), 4);
    expect(dbl.rise).toBeGreaterThan(4.3);
    expect(dbl.rise).toBeLessThan(5.4);
    expect(dbl.events).toContain('jump:double');
  });

  it('no second jump after the double-jump window', () => {
    const late = jumpApex((t) => ctl({ jump: t < 0.2 || (t > CAR.doubleJumpWindow + 0.1 && t < CAR.doubleJumpWindow + 0.2) }), 4);
    expect(late.events).not.toContain('jump:double');
  });

  it('front dodge: +5 m/s forward, one full flip, lands on its wheels', () => {
    const d = dodge(1, 0);
    expect(d.evs).toContain('dodge');
    expect(Math.hypot(d.dv.x, d.dv.z)).toBeCloseTo(CAR.dodgeImpulse, 3);
    expect(d.dv.z).toBeGreaterThan(4.9); // forward = +Z
    expect(d.landT).toBeGreaterThan(0.8);
    expect(d.landT).toBeLessThan(1.3);
    expect(d.upAtLand).toBeGreaterThan(0.95);
    // ~360° of pitch before landing (+ small settle), measured from the orientation itself
    expect(d.rotated).toBeGreaterThan(Math.PI * 1.85);
    expect(d.rotated).toBeLessThan(Math.PI * 2.15);
  });

  it('side dodge goes right, back dodge goes back; side dodges gain a bit at speed', () => {
    const r = dodge(0, 1);
    expect(r.dv.x).toBeLessThan(-4.9); // right = −X when facing +Z
    expect(r.upAtLand).toBeGreaterThan(0.95);
    const b = dodge(-1, 0);
    expect(b.dv.z).toBeLessThan(-4.9);
    const fast = dodge(0, 1, 20);
    expect(Math.abs(fast.dv.x)).toBeGreaterThan(Math.abs(r.dv.x) + 0.5);
  });

  it('flip direction: front flip pitches nose-down first, side flip rolls right first', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, 0, 0, 1);
    run(w, (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), pitch: t >= 0.1 ? 1 : 0 }), 0.3);
    expect(car.isDodging).toBe(true);
    expect(car.fwd.y).toBeLessThan(-0.3); // nose went down
    const w2 = freePlayWorld();
    const car2 = place(w2, 0, 0, 0, 0, 1);
    run(w2, (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), yaw: t >= 0.1 ? 1 : 0 }), 0.3);
    expect(car2.up.x).toBeLessThan(-0.3); // roof tilts toward the right (−X)
  });

  it('driving off without jumping keeps one air jump', () => {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(0, 6, 0);
    car.onGround = true; // pretend it just left a surface without jumping
    car.hasJumped = false;
    let doubles = 0;
    run(w, (t) => ctl({ jump: t > 0.3 && t < 0.4 }), 0.6, () => {
      doubles += eventsOf(w.drainEvents(), 'jump').filter((e) => e.double).length;
    });
    expect(doubles).toBe(1);
    expect(car.hasDoubleJumped).toBe(true);
  });

  it('air control: pitch/yaw/roll rotate about the right axes; free air roll converts yaw to roll', () => {
    const cases: Array<[Partial<ControlState>, (c: ReturnType<typeof freePlayWorld>['cars'][0]) => boolean]> = [
      [{ pitch: 1 }, (c) => c.fwd.y < -0.2], // nose down
      [{ pitch: -1 }, (c) => c.fwd.y > 0.2], // nose up
      [{ yaw: 1 }, (c) => c.fwd.x < -0.2], // nose right (−X)
      [{ roll: 1 }, (c) => c.up.x < -0.2], // roll right
      [{ yaw: 1, powerslide: true }, (c) => c.up.x < -0.2 && Math.abs(c.fwd.x) < 0.05], // free air roll
    ];
    for (const [input, check] of cases) {
      const w = freePlayWorld();
      const car = w.cars[0];
      car.pos.set(0, 10, 0);
      car.quat.identity();
      updateAxes(car);
      car.onGround = false;
      run(w, ctl(input), 0.25);
      expect(check(car)).toBe(true);
      expect(car.angVel.length()).toBeLessThanOrEqual(CAR.maxAngularSpeed + 1e-9);
    }
  });

  it('turtled car self-rights: automatically, and sooner on jump press', () => {
    for (const press of [false, true]) {
      const w = freePlayWorld();
      const car = place(w, 0, 0, 0, 0, 1);
      car.quat.copy(new Quaternion(0, 0, 1, 0)); // on its roof
      updateAxes(car);
      car.pos.y = CAR.halfExtents.y + 0.02;
      car.onGround = false;
      let upright = -1;
      run(w, (t) => ctl({ jump: press && t > 0.3 && t < 0.4 }), 4, (t) => {
        if (upright < 0 && car.onGround && car.up.y > 0.95) upright = t;
      });
      expect(upright).toBeGreaterThan(0);
      if (press) expect(upright).toBeLessThan(1.6);
      else expect(upright).toBeLessThan(3.2);
    }
  });

  /** A car that jumped lands on its roof while sliding at `v` along +Z (`airJumpLeft`: its double jump is still unused). */
  function roofLanding(v: number, airJumpLeft = false) {
    const w = freePlayWorld();
    const car = place(w, 0, -20, -35, 0, 1);
    orient(car, new Vector3(0, -1, 0), new Vector3(0, 0, 1));
    car.pos.y = 2;
    car.vel.set(0, -2, v);
    car.onGround = false;
    car.hasJumped = true;
    car.hasDoubleJumped = !airJumpLeft;
    car.airJumpTimer = airJumpLeft ? 0.3 : 2;
    return { w, car };
  }

  type TestWorld = ReturnType<typeof freePlayWorld>;
  /**
   * Runs until the car is back on its wheels (onGround ∧ up.y > 0.95). `jumpAt(dt)` / `roll` give the inputs, dt =
   * seconds since the first roof contact. Returns that recovery time (-1 = never) and the jump events seen.
   */
  function recover(w: TestWorld, jumpAt: (dt: number, car: TestWorld['cars'][0]) => boolean, roll = 0, seconds = 5) {
    const car = w.cars[0];
    let touch = -1;
    let down = -1;
    let doubles = 0;
    let firsts = 0;
    run(w, (t) => ctl({ jump: touch >= 0 && jumpAt(t - touch, car), roll: touch >= 0 ? roll : 0 }), seconds, (t) => {
      for (const e of eventsOf(w.drainEvents(), 'jump')) {
        if (e.double) doubles++;
        else firsts++;
      }
      if (touch < 0 && car.bodyContactTimer === 0) touch = t;
      if (touch >= 0 && car.onGround && car.up.y > 0.95) {
        down = t - touch;
        return true;
      }
    });
    return { down, doubles, firsts };
  }

  it('a car landing on its roof while sliding fast self-rights at any speed (one press, or hands-off)', () => {
    for (const v of [10, 15]) {
      const press = recover(roofLanding(v).w, (dt) => dt >= 0.3 && dt < 0.35);
      expect(press.firsts).toBe(1); // the self-right hop
      expect(press.down).toBeGreaterThan(0.3);
      expect(press.down).toBeLessThan(1.6);
      const auto = recover(roofLanding(v).w, () => false);
      expect(auto.down).toBeGreaterThan(0);
      expect(auto.down).toBeLessThan(2.2);
    }
  });

  it('jump presses while upside-down near the floor never fire a double jump into it (any speed / timing)', () => {
    for (const v of [0, 5, 12, 18]) {
      for (const at of [0, 0.1, 0.2, 0.4, 0.7]) {
        const r = recover(roofLanding(v, true).w, (dt) => dt >= at && dt < at + 0.05);
        expect(r.doubles).toBe(0);
        expect(r.down).toBeGreaterThan(0);
        expect(r.down).toBeLessThan(1.6);
      }
      // mashing (20 presses/s) for as long as the car is still upside-down
      const m = recover(roofLanding(v, true).w, (dt, car) => car.up.y < 0.5 && Math.floor(dt / 0.05) % 2 === 1);
      expect(m.doubles).toBe(0);
      expect(m.down).toBeGreaterThan(0);
      expect(m.down).toBeLessThan(1.6);
    }
  });

  it('holding air roll while mashing jump still recovers (the self-right owns the rotation until touchdown)', () => {
    for (const v of [2, 10, 15]) {
      const r = recover(roofLanding(v).w, (dt) => Math.floor(dt / 0.125) % 2 === 1, 1);
      expect(r.down).toBeGreaterThan(0);
      expect(r.down).toBeLessThan(1.6);
    }
  });

  it('car on its side against a wall recovers too', () => {
    const w = freePlayWorld();
    const car = w.cars[0];
    car.pos.set(34.5, 1.5, 0);
    orient(car, new Vector3(0, 0, 1), new Vector3(1, 0, 0)); // nose into the wall, roof facing +Z
    car.onGround = false;
    let upright = -1;
    run(w, ctl(), 5, (t) => {
      if (upright < 0 && car.onGround && car.up.dot(car.groundNormal) > 0.95 && car.vel.length() < 3) upright = t;
    });
    expect(upright).toBeGreaterThan(0);
  });

  it('flip cancel: a back flip cancelled with forward pitch stops rotating (half-flip)', () => {
    const w = freePlayWorld();
    const car = place(w, 0, 0, 0, 0, 1);
    // back dodge at 0.12 s, then push forward at 0.3 s (car roughly vertical)
    run(w, (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), pitch: t >= 0.1 && t < 0.3 ? -1 : t >= 0.3 && t < 0.45 ? 1 : 0 }), 0.45);
    expect(car.hasDodged).toBe(true);
    expect(car.flipActive).toBe(false);
    expect(car.fwd.y).toBeGreaterThan(0.5); // nose up, not flipped over
    expect(car.angVel.length()).toBeLessThan(3);
    expect(car.vel.z).toBeLessThan(-4); // travelling backwards from the back dodge
    // holding the SAME direction never cancels
    const w2 = freePlayWorld();
    const c2 = place(w2, 0, 0, 0, 0, 1);
    run(w2, (t) => ctl({ jump: t < 0.05 || (t >= 0.12 && t < 0.2), pitch: t >= 0.1 ? 1 : 0 }), 0.9);
    expect(c2.flipAngle).toBeGreaterThan(5.5);
  });
});
