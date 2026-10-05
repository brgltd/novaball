import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { PAD_LAYOUT, SIM_HZ } from '../../src/sim/constants';
import { cloneSnapshot, copySnapshot, lerpSnapshot, makeSnapshot } from '../../src/sim/snapshot';
import { World } from '../../src/sim/world';
import { ChaseBots } from './bots';
import { config } from './helpers';

describe('snapshots', () => {
  it('createSnapshot fills every field from the world', () => {
    const w = new World(config({ teamSize: 2, seed: 3 }));
    const bots = new ChaseBots(4, 1);
    for (let i = 0; i < 5 * SIM_HZ; i++) w.step(bots.update(w));
    const s = w.createSnapshot();
    expect(s.tick).toBe(w.tick);
    expect(s.time).toBeCloseTo(w.time, 12);
    expect(s.phase).toBe(w.match.phase);
    expect(s.cars.length).toBe(4);
    expect(s.padsActive.length).toBe(PAD_LAYOUT.length);
    for (let i = 0; i < 4; i++) {
      const c = w.cars[i];
      const sc = s.cars[i];
      expect(sc.id).toBe(c.id);
      expect(sc.team).toBe(c.team);
      expect(sc.pos.equals(c.pos)).toBe(true);
      expect(sc.pos).not.toBe(c.pos); // copies, not aliases
      expect(sc.quat.equals(c.quat)).toBe(true);
      expect(sc.boost).toBe(c.boost);
      expect(sc.onGround).toBe(c.onGround);
      expect(sc.supersonic).toBe(c.supersonic);
      expect(sc.pulseReady01).toBeGreaterThanOrEqual(0);
      expect(sc.pulseReady01).toBeLessThanOrEqual(1);
    }
    expect(s.ball.pos.equals(w.ball.pos)).toBe(true);
    expect(s.ball.visible).toBe(!w.ball.exploded);
    expect(s.surge).toBe(w.match.surge.intensity);
  });

  it('lerpSnapshot interpolates positions, slerps rotations, takes discrete fields from b', () => {
    const w = new World(config({ teamSize: 1, seed: 3 }));
    const a = w.createSnapshot();
    const b = cloneSnapshot(a);
    b.tick = a.tick + 1;
    b.cars[0].pos.set(a.cars[0].pos.x + 1, a.cars[0].pos.y, a.cars[0].pos.z);
    b.cars[0].quat.setFromAxisAngle(new Vector3(0, 1, 0), 0.5).multiply(a.cars[0].quat);
    b.cars[0].boosting = true;
    b.cars[0].boost = a.cars[0].boost + 10;
    b.ball.pos.y = a.ball.pos.y + 2;
    b.ball.charge = 2;
    b.phase = 'playing';
    const out = makeSnapshot(0, 0);
    lerpSnapshot(a, b, 0.25, out);
    expect(out.cars.length).toBe(2);
    expect(out.padsActive.length).toBe(a.padsActive.length);
    expect(out.cars[0].pos.x).toBeCloseTo(a.cars[0].pos.x + 0.25, 9);
    expect(out.cars[0].boost).toBeCloseTo(a.cars[0].boost + 2.5, 9);
    expect(out.cars[0].boosting).toBe(true);
    expect(out.ball.pos.y).toBeCloseTo(a.ball.pos.y + 0.5, 9);
    expect(out.ball.charge).toBe(2);
    expect(out.phase).toBe('playing');
    expect(out.tick).toBe(b.tick);
    const expected = a.cars[0].quat.clone().slerp(b.cars[0].quat, 0.25);
    expect(Math.abs(out.cars[0].quat.dot(expected))).toBeCloseTo(1, 9);
    // aliasing: out === a and out === b both work
    const a2 = cloneSnapshot(a);
    lerpSnapshot(a2, b, 0.25, a2);
    expect(a2.cars[0].pos.x).toBeCloseTo(a.cars[0].pos.x + 0.25, 9);
    expect(Math.abs(a2.cars[0].quat.dot(expected))).toBeCloseTo(1, 9);
    const b2 = cloneSnapshot(b);
    lerpSnapshot(a, b2, 0.25, b2);
    expect(b2.cars[0].pos.x).toBeCloseTo(a.cars[0].pos.x + 0.25, 9);
    expect(Math.abs(b2.cars[0].quat.dot(expected))).toBeCloseTo(1, 9);
  });

  it('teleports (kickoff reset, respawn) snap instead of sweeping across the field', () => {
    const w = new World(config({ teamSize: 1, seed: 3 }));
    const a = w.createSnapshot();
    const b = cloneSnapshot(a);
    b.cars[0].pos.set(30, 0.45, 40);
    b.ball.pos.set(0, 1, 30);
    const out = lerpSnapshot(a, b, 0.5, makeSnapshot(2, a.padsActive.length));
    expect(out.cars[0].pos.equals(b.cars[0].pos)).toBe(true);
    expect(out.ball.pos.equals(b.ball.pos)).toBe(true);
  });

  it('copySnapshot / cloneSnapshot are deep', () => {
    const w = new World(config({ teamSize: 3 }));
    const s = w.createSnapshot();
    const c = cloneSnapshot(s);
    expect(c).toEqual(s);
    c.cars[0].pos.x += 5;
    c.ball.quat.copy(new Quaternion(0, 1, 0, 0));
    c.padsActive[0] = false;
    expect(s.cars[0].pos.x).not.toBe(c.cars[0].pos.x);
    expect(s.padsActive[0]).toBe(true);
    const d = makeSnapshot(1, 1);
    copySnapshot(s, d);
    expect(d).toEqual(s);
  });
});
