/**
 * NOVABALL — ball trajectory prediction (arena collisions only, no cars).
 *
 * Uses exactly the sim's ball step. When `dt` is a multiple of the sim DT (default 1/60 = 2 × 1/120),
 * the predictor sub-steps at DT, so with no car touches / gravity changes the prediction matches
 * the live simulation bit-for-bit.
 */
import { Vector3 } from 'three';
import type { BallPredictionSlice, IBallPredictor } from '../contracts';
import { goalScoredBy } from './arena';
import type { BallBody } from './ball';
import { collideBallArena, integrateBall } from './ball';
import { DT } from './constants';
import type { BallState, Team } from './types';

export class BallPredictor implements IBallPredictor {
  readonly slices: BallPredictionSlice[];
  /** Number of valid slices (always the full horizon). slices[i].t = (i + 1) · dt. */
  count: number;
  readonly dt: number;
  /** Index of the first slice where the ball is fully inside a goal (-1 = none within the horizon). */
  goalIndex = -1;
  /** Team that would score at goalIndex (-1 = none). */
  goalTeam: Team | -1 = -1;
  private readonly substeps: number;
  private readonly body: BallBody = { pos: new Vector3(), vel: new Vector3(), angVel: new Vector3() };

  constructor(horizonSec = 4, dt = 1 / 60) {
    this.dt = dt > 0 ? dt : 1 / 60;
    const n = Math.max(1, Math.round(horizonSec / this.dt));
    const ratio = this.dt / DT;
    const r = Math.round(ratio);
    this.substeps = r >= 1 && Math.abs(ratio - r) < 1e-6 ? r : Math.max(1, Math.ceil(ratio));
    this.slices = [];
    for (let i = 0; i < n; i++) this.slices.push({ t: (i + 1) * this.dt, pos: new Vector3(), vel: new Vector3() });
    this.count = n;
  }

  update(ball: BallState, gravityScale: number): void {
    const b = this.body;
    b.pos.copy(ball.pos);
    b.vel.copy(ball.vel);
    b.angVel.copy(ball.angVel);
    this.goalIndex = -1;
    this.goalTeam = -1;
    const n = this.count;
    if (ball.exploded) {
      for (let i = 0; i < n; i++) {
        this.slices[i].pos.copy(ball.pos);
        this.slices[i].vel.set(0, 0, 0);
      }
      return;
    }
    const h = this.dt / this.substeps;
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < this.substeps; s++) {
        integrateBall(b, h, gravityScale);
        collideBallArena(b, h, null);
      }
      const sl = this.slices[i];
      sl.pos.copy(b.pos);
      sl.vel.copy(b.vel);
      if (this.goalIndex < 0) {
        const g = goalScoredBy(b.pos);
        if (g !== -1) {
          this.goalIndex = i;
          this.goalTeam = g;
        }
      }
    }
  }
}

const _pb: BallBody = { pos: new Vector3(), vel: new Vector3(), angVel: new Vector3() };

/**
 * Cheap goal prediction: which team would score within `horizon` seconds if nothing touches the ball
 * (-1 = no goal). Deterministic (used by the sim's save / shot detection).
 */
export function predictGoal(
  pos: Vector3,
  vel: Vector3,
  angVel: Vector3,
  gravityScale: number,
  horizon = 2.5,
  dt = 1 / 60,
): Team | -1 {
  _pb.pos.copy(pos);
  _pb.vel.copy(vel);
  _pb.angVel.copy(angVel);
  const steps = Math.floor(horizon / dt + 0.5);
  for (let i = 0; i < steps; i++) {
    integrateBall(_pb, dt, gravityScale);
    collideBallArena(_pb, dt, null);
    const g = goalScoredBy(_pb.pos);
    if (g !== -1) return g;
  }
  return -1;
}
