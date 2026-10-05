import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { arenaNormal, arenaSDF, goalScoredBy, projectToArenaSurface } from '../src/sim/arena';
import { ARENA } from '../src/sim/constants';

const close = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('arena SDF', () => {
  it('floor, ceiling and walls', () => {
    close(arenaSDF(0, 1, 0), 1);
    close(arenaSDF(0, 10, 0), 10);
    close(arenaSDF(0, 19, 0), 1);
    close(arenaSDF(35, 10, 0), 1);
    close(arenaSDF(-35, 10, 0), 1);
    close(arenaSDF(0, 10, 49), 1); // end wall above the goal
    expect(arenaSDF(0, -0.5, 0)).toBeLessThan(0);
    expect(arenaSDF(37, 10, 0)).toBeLessThan(0);
  });

  it('edge fillet (drive-up ramp)', () => {
    // fillet arc center at (x = 32, y = 4) with radius 4
    const expected = 4 - Math.hypot(34 - 32, 1 - 4);
    close(arenaSDF(34, 1, 0), expected);
  });

  it('goal interior and mouth', () => {
    close(arenaSDF(0, 1, 55), 1); // goal floor
    close(arenaSDF(0, 1, -55), 1);
    close(arenaSDF(0, 1, 48), 1); // flat floor in front of the goal mouth (ramp carved away)
    expect(arenaSDF(0, 3, ARENA.halfLength + ARENA.goalDepth + 0.5)).toBeLessThan(0); // behind the back of the goal
    expect(arenaSDF(0, ARENA.goalHeight + 1, 52)).toBeLessThan(0); // above the goal box, behind the end wall
  });

  it('floor into the goal mouth is perfectly flat (no fillet crease)', () => {
    for (const x of [0, 4, 7]) {
      for (let z = 40; z <= 56.5; z += 0.05) {
        close(arenaSDF(x, 0.3, z), 0.3, 1e-9);
        close(arenaSDF(-x, 0.3, -z), 0.3, 1e-9);
      }
    }
  });

  it('goal frame tubes', () => {
    // just in front of the crossbar center
    const d = arenaSDF(0, ARENA.goalHeight, ARENA.halfLength - 1);
    close(d, 1 - ARENA.goalFrameRadius, 1e-2);
    // tapered arc: no bump on the floor at the arc's floor end
    expect(arenaSDF(ARENA.goalHalfWidth, 0.5, ARENA.halfLength - ARENA.edgeRadius)).toBeGreaterThan(0.45);
  });

  it('normals point into free space', () => {
    const n = new Vector3();
    arenaNormal(0, 1, 0, n);
    close(n.y, 1);
    arenaNormal(35, 10, 0, n);
    close(n.x, -1);
    arenaNormal(0, 19, 0, n);
    close(n.y, -1);
    arenaNormal(34, 1, 0, n);
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0);
  });

  it('projection lands on the surface', () => {
    const p = projectToArenaSurface(new Vector3(33, 2, 10));
    close(arenaSDF(p.x, p.y, p.z), 0, 1e-4);
  });

  it('goal detection', () => {
    expect(goalScoredBy(new Vector3(0, 1, 51.5))).toBe(0);
    expect(goalScoredBy(new Vector3(0, 1, -51.5))).toBe(1);
    expect(goalScoredBy(new Vector3(0, 1, 49))).toBe(-1);
  });

  it('is fast enough', () => {
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 200_000; i++) s += arenaSDF((i % 71) - 35, (i % 19) + 0.5, (i % 113) - 56);
    const ms = performance.now() - t0;
    expect(Number.isFinite(s)).toBe(true);
    expect(ms).toBeLessThan(500);
  });
});
