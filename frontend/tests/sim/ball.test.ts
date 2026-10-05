import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { arenaSDF } from '../../src/sim/arena';
import type { BallBody } from '../../src/sim/ball';
import { enforceBallInside, makeBallContactInfo, stepBall } from '../../src/sim/ball';
import { BALL, DT } from '../../src/sim/constants';
import { BallPredictor } from '../../src/sim/predict';
import { Rng } from '../../src/sim/rng';
import { eventsOf, freePlayWorld, place } from './helpers';

const R = BALL.radius;

function body(p: Vector3, v = new Vector3(), w = new Vector3()): BallBody {
  return { pos: p.clone(), vel: v.clone(), angVel: w.clone() };
}

describe('ball physics', () => {
  it('dropped from 10 m: bounces, loses energy, comes to rest at y = R', () => {
    const w = freePlayWorld(false);
    place(w, 0, 30, -40, 0, 1); // car out of the way
    w.ball.pos.set(0, 10, 0);
    w.ball.vel.set(0, 0, 0);
    const peaks: number[] = [];
    let prevVy = 0;
    let bounces = 0;
    for (let i = 0; i < 12 * 120; i++) {
      w.step([]);
      bounces += eventsOf(w.drainEvents(), 'ballBounce').length;
      if (prevVy > 0 && w.ball.vel.y <= 0) peaks.push(w.ball.pos.y);
      prevVy = w.ball.vel.y;
    }
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    // restitution 0.6 ⇒ each bounce keeps ~36 % of the drop height
    expect(peaks[0]).toBeGreaterThan(3.5);
    expect(peaks[0]).toBeLessThan(4.4);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThan(peaks[i - 1]);
    expect(bounces).toBeGreaterThanOrEqual(3);
    expect(Math.abs(w.ball.pos.y - R)).toBeLessThan(1e-3);
    expect(w.ball.vel.length()).toBeLessThan(1e-3);
    expect(w.ball.onSurface).toBe(true);
  });

  it('never leaves the arena or NaNs: 2000 seeded random shots up to 60 m/s, 5 s each', () => {
    const rng = new Rng(20260928);
    const info = makeBallContactInfo();
    let worst = Infinity;
    let bad = 0;
    let shots = 0;
    for (let k = 0; shots < 2000; k++) {
      const b = body(
        new Vector3(rng.range(-33, 33), rng.range(1.1, 18.9), rng.range(-54, 54)),
        new Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize().multiplyScalar(rng.range(2, 60)),
        new Vector3(rng.range(-6, 6), rng.range(-6, 6), rng.range(-6, 6)),
      );
      // start positions must be valid (some random points are inside walls / goal frame / behind the end walls)
      enforceBallInside(b);
      if (arenaSDF(b.pos.x, b.pos.y, b.pos.z) < R - 1e-6) continue;
      shots++;
      const g = k % 3 === 0 ? 0.3 : 1; // include zero-G surge gravity
      for (let i = 0; i < 600; i++) {
        stepBall(b, DT, g, info);
        const d = arenaSDF(b.pos.x, b.pos.y, b.pos.z);
        if (d < worst) worst = d;
        if (!Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.vel.x + b.vel.y + b.vel.z + b.angVel.x + b.angVel.y + b.angVel.z)) bad++;
      }
      expect(b.vel.length()).toBeLessThanOrEqual(BALL.maxSpeed + 1e-9);
      expect(b.angVel.length()).toBeLessThanOrEqual(BALL.maxAngularSpeed + 1e-9);
    }
    expect(shots).toBe(2000);
    expect(bad).toBe(0);
    expect(worst).toBeGreaterThanOrEqual(R - 0.05);
  });

  it('floor friction turns sliding into rolling spin (right-hand rule) and rolling drag stops it', () => {
    const b = body(new Vector3(0, R, -40), new Vector3(0, 0, 5));
    for (let i = 0; i < 120; i++) stepBall(b, DT, 1, null);
    // rolling along +Z on the floor ⇒ spin about +X with ω·R ≈ v
    expect(b.angVel.x).toBeGreaterThan(0);
    expect(Math.abs(b.angVel.x * R - b.vel.z)).toBeLessThan(0.3);
    for (let i = 0; i < 120 * 40; i++) stepBall(b, DT, 1, null);
    expect(b.vel.length()).toBeLessThan(0.05);
  });

  it('spin changes the bounce: backspin kicks back off the floor', () => {
    const plain = body(new Vector3(0, 3, 0), new Vector3(0, -8, 5));
    const back = body(new Vector3(0, 3, 0), new Vector3(0, -8, 5), new Vector3(-6, 0, 0));
    for (let i = 0; i < 60; i++) {
      stepBall(plain, DT, 1, null);
      stepBall(back, DT, 1, null);
    }
    expect(back.vel.z).toBeLessThan(plain.vel.z - 1);
  });

  it('BallPredictor matches the live sim trajectory exactly (no cars)', () => {
    const w = freePlayWorld(false);
    place(w, 0, 30, -40, 0, 1);
    w.ball.pos.set(-5, 6, 10);
    w.ball.vel.set(18, 9, 25);
    w.ball.angVel.set(1, -2, 3);
    const pred = new BallPredictor(4, 1 / 60);
    pred.update(w.ball, 1);
    expect(pred.count).toBe(240);
    expect(pred.slices[0].t).toBeCloseTo(1 / 60, 12);
    for (let i = 0; i < pred.count; i++) {
      w.step([]);
      w.step([]);
      if (w.match.phase !== 'playing') break; // a goal would explode the ball
      const s = pred.slices[i];
      expect(s.pos.distanceTo(w.ball.pos)).toBeLessThan(1e-9);
      expect(s.vel.distanceTo(w.ball.vel)).toBeLessThan(1e-9);
    }
  });

  it('BallPredictor reports goals within the horizon', () => {
    const pred = new BallPredictor();
    const w = freePlayWorld(false);
    w.ball.pos.set(0, 2, 30);
    w.ball.vel.set(0, 2, 30);
    pred.update(w.ball, 1);
    expect(pred.goalTeam).toBe(0);
    expect(pred.goalIndex).toBeGreaterThan(0);
    w.ball.pos.set(0, 2, -30);
    w.ball.vel.set(0, 2, -30);
    pred.update(w.ball, 1);
    expect(pred.goalTeam).toBe(1);
  });
});
