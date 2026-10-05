import { describe, expect, it } from 'vitest';
import { BALL, CAR } from '../../src/sim/constants';
import { ctl, eventsOf, freePlayWorld, place, run } from './helpers';
import { dodgeHit, groundHit } from './scenarios';

describe('car–ball hits', () => {
  it('20 m/s head-on grounded hit sends the ball forward at 30–38 m/s', () => {
    const r = groundHit(20);
    expect(r.hit).not.toBeNull();
    const s = r.after.length();
    expect(s).toBeGreaterThan(30);
    expect(s).toBeLessThan(38);
    // direction: along the car's heading (+Z), mostly flat with a little lift
    expect(r.after.z / s).toBeGreaterThan(0.95);
    expect(Math.abs(r.after.x)).toBeLessThan(0.01);
    expect(r.after.y).toBeGreaterThan(0);
    expect(r.hit!.strength).toBeGreaterThan(29);
    expect(r.hit!.dodge).toBe(false);
    expect(r.hit!.aerial).toBe(false);
    expect(r.hits).toBe(1); // exactly one contact-start event
    expect(r.car.stats.touches).toBe(1);
    expect(r.car.stats.hardestHit).toBeGreaterThan(30);
  });

  it('hit strength grows with speed', () => {
    let prev = 0;
    for (const sp of [3, 6, 10, 14, 20, 23]) {
      const s = groundHit(sp).after.length();
      expect(s).toBeGreaterThan(prev);
      expect(s).toBeGreaterThan(sp); // the ball always leaves faster than the car
      prev = s;
    }
  });

  it('a dodge (flip) hit is stronger: 40–50 m/s at 20 m/s approach', () => {
    const d = dodgeHit(20);
    expect(d.dodge).toBe(true);
    expect(d.speed).toBeGreaterThan(40);
    expect(d.speed).toBeLessThan(50);
    expect(d.speed).toBeGreaterThan(groundHit(20).after.length() + 5);
    expect(d.after.z / d.after.length()).toBeGreaterThan(0.95);
  });

  it('off-center hits deflect the ball away from the car center (aimable)', () => {
    const left = groundHit(15, 0.6); // car to the +X side ⇒ ball goes toward −X
    const right = groundHit(15, -0.6);
    expect(left.after.x).toBeLessThan(-1);
    expect(right.after.x).toBeGreaterThan(1);
    expect(left.after.z).toBeGreaterThan(10);
  });

  it('car barely slows down on a hit (mass ratio 180 : 30)', () => {
    const w = freePlayWorld(false);
    const car = place(w, 0, 0, -3.2, 0, 1);
    w.ball.pos.set(0, BALL.radius, 0);
    car.vel.set(0, 0, 14);
    run(w, ctl({ throttle: 0 }), 0.15);
    expect(car.vel.z).toBeGreaterThan(10);
    expect(car.vel.z).toBeLessThan(14);
  });

  it('ball resting on the roof of a parked car settles calmly (no jitter, no launch)', () => {
    const w = freePlayWorld(false);
    const car = place(w, 0, 0, -30, 0, 1);
    const top = car.pos.y + CAR.halfExtents.y;
    w.ball.pos.set(0, top + BALL.radius + 0.3, -30);
    w.ball.vel.set(0, 0, 0);
    let maxBallY = 0;
    let hits = 0;
    run(w, ctl(), 2, (t) => {
      if (t > 0.5) maxBallY = Math.max(maxBallY, w.ball.pos.y);
      hits += eventsOf(w.drainEvents(), 'ballHit').length;
    });
    expect(maxBallY).toBeLessThan(top + BALL.radius + 0.1);
    expect(w.ball.vel.length()).toBeLessThan(0.5);
    expect(Math.abs(w.ball.pos.y - (top + BALL.radius))).toBeLessThan(0.1);
    expect(hits).toBeLessThanOrEqual(2);
    expect(car.onGround).toBe(true);
  });

  it('a perfectly mirrored 50/50 is fair: same-tick contacts resolve symmetrically', () => {
    const w = freePlayWorld(false, { freePlay: false, teamSize: 1 });
    // freePlayWorld with freePlay false: skip to playing
    while (w.match.phase !== 'playing') w.step([]);
    w.drainEvents();
    const a = place(w, 0, 0, -6, 0, 1);
    const b = place(w, 1, 0, 6, 0, -1);
    w.ball.pos.set(0, BALL.radius, 0);
    a.vel.set(0, 0, 18);
    b.vel.set(0, 0, -18);
    const inputs = [ctl({ throttle: 1 }), ctl({ throttle: 1 })];
    let hits = 0;
    for (let i = 0; i < 90; i++) {
      w.step(inputs);
      hits += eventsOf(w.drainEvents(), 'ballHit').length;
    }
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(Math.abs(w.ball.pos.z)).toBeLessThan(1e-6);
    expect(Math.abs(w.ball.pos.x)).toBeLessThan(1e-6);
    expect(w.ball.pos.y).toBeGreaterThan(2); // pinched up
  });
});
