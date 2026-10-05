/**
 * NOVABALL — ball physics (pure, deterministic). Shared by World and BallPredictor.
 *
 * Per step: gravity (× surge scale) → air drag → speed / spin clamp → integrate → arena collision
 * (SDF push-out, restitution, Coulomb friction at the contact point incl. spin, rolling drag).
 */
import { Vector3 } from 'three';
import { arenaNormal, arenaSDF } from './arena';
import { BALL, GRAVITY } from './constants';

/** Minimal rigid state the ball step needs (BallState satisfies it). */
export interface BallBody {
  pos: Vector3;
  vel: Vector3;
  angVel: Vector3;
}

/** Strongest arena impact of one ball step (written by collideBallArena). */
export interface BallContactInfo {
  /** Any arena contact this step (resting contacts included). */
  touching: boolean;
  /** Strongest impact normal speed this step (m/s, >= 0). */
  impactSpeed: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
}

export function makeBallContactInfo(): BallContactInfo {
  return { touching: false, impactSpeed: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 };
}

const R = BALL.radius;
/** Approach speeds below this bounce with zero restitution (kills micro-bounce jitter when resting). */
export const BALL_REST_SPEED = 0.4;
/** Emit 'ballBounce' for impacts at least this hard (m/s). */
export const BALL_BOUNCE_EVENT_SPEED = 2;
/** Solid-sphere inertia factor: I = 2/5 m R² ⇒ 1/I = 2.5 / (m R²). */
const INV_INERTIA_PER_MASS = 2.5 / (R * R);
/** Push-out passes for concave creases (e.g. goal frame tube meeting a wall). */
const COLLIDE_ITERATIONS = 3;

const _n = new Vector3();

/** Gravity, drag, clamps and position integration (no collisions, no orientation). */
export function integrateBall(b: BallBody, dt: number, gravityScale: number): void {
  const v = b.vel;
  v.y -= GRAVITY * gravityScale * dt;
  const drag = 1 - BALL.airDrag * dt;
  v.x *= drag;
  v.y *= drag;
  v.z *= drag;
  const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (sp2 > BALL.maxSpeed * BALL.maxSpeed) {
    const k = BALL.maxSpeed / Math.sqrt(sp2);
    v.x *= k;
    v.y *= k;
    v.z *= k;
  }
  clampBallSpin(b.angVel);
  const p = b.pos;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;
}

export function clampBallSpin(w: Vector3): void {
  const w2 = w.x * w.x + w.y * w.y + w.z * w.z;
  if (w2 > BALL.maxAngularSpeed * BALL.maxAngularSpeed) {
    const k = BALL.maxAngularSpeed / Math.sqrt(w2);
    w.x *= k;
    w.y *= k;
    w.z *= k;
  }
}

/**
 * Resolve ball–arena contact: push out along the SDF gradient, normal impulse with restitution,
 * tangential Coulomb friction at the contact point (spin-aware), rolling drag while touching.
 * Returns true when the ball touched the arena. `info` (optional) receives the strongest impact.
 */
export function collideBallArena(b: BallBody, dt: number, info: BallContactInfo | null): boolean {
  const p = b.pos;
  const v = b.vel;
  const w = b.angVel;
  let touched = false;
  if (info) {
    info.touching = false;
    info.impactSpeed = 0;
  }
  for (let iter = 0; iter < COLLIDE_ITERATIONS; iter++) {
    const d = arenaSDF(p.x, p.y, p.z);
    if (d >= R) break;
    touched = true;
    arenaNormal(p.x, p.y, p.z, _n);
    const nx = _n.x;
    const ny = _n.y;
    const nz = _n.z;
    const push = R - d;
    p.x += nx * push;
    p.y += ny * push;
    p.z += nz * push;
    const vn = v.x * nx + v.y * ny + v.z * nz;
    if (vn < 0) {
      const e = -vn < BALL_REST_SPEED ? 0 : BALL.restitution;
      const jn = -(1 + e) * vn; // Δv along n (per unit mass)
      v.x += nx * jn;
      v.y += ny * jn;
      v.z += nz * jn;
      // --- friction at the contact point r = -n·R: v_c = v + ω × r
      const rx = -nx * R;
      const ry = -ny * R;
      const rz = -nz * R;
      const cx = v.x + (w.y * rz - w.z * ry);
      const cy = v.y + (w.z * rx - w.x * rz);
      const cz = v.z + (w.x * ry - w.y * rx);
      const cn = cx * nx + cy * ny + cz * nz;
      const sx = cx - nx * cn;
      const sy = cy - ny * cn;
      const sz = cz - nz * cn;
      const slip = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (slip > 1e-9) {
        // Δv to cancel the slip at the contact: -slip / (1 + mR²/I) = -slip / 3.5; Coulomb cap μ·|Jn|.
        let mag = slip / 3.5;
        const cap = BALL.surfaceFriction * jn;
        if (mag > cap) mag = cap;
        const k = -mag / slip;
        const dvx = sx * k;
        const dvy = sy * k;
        const dvz = sz * k;
        v.x += dvx;
        v.y += dvy;
        v.z += dvz;
        // Δω = (r × Δv) · m / I
        w.x += (ry * dvz - rz * dvy) * INV_INERTIA_PER_MASS;
        w.y += (rz * dvx - rx * dvz) * INV_INERTIA_PER_MASS;
        w.z += (rx * dvy - ry * dvx) * INV_INERTIA_PER_MASS;
      }
      if (info && -vn > info.impactSpeed) {
        info.impactSpeed = -vn;
        info.px = p.x - nx * R;
        info.py = p.y - ny * R;
        info.pz = p.z - nz * R;
        info.nx = nx;
        info.ny = ny;
        info.nz = nz;
      }
    }
    if (info && !info.touching) {
      info.touching = true;
      if (info.impactSpeed === 0) {
        info.px = p.x - nx * R;
        info.py = p.y - ny * R;
        info.pz = p.z - nz * R;
        info.nx = nx;
        info.ny = ny;
        info.nz = nz;
      }
    }
    if (iter === 0) {
      // Rolling drag on the tangential velocity (never overshoots).
      const vn2 = v.x * nx + v.y * ny + v.z * nz;
      const tx = v.x - nx * vn2;
      const ty = v.y - ny * vn2;
      const tz = v.z - nz * vn2;
      const ts = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (ts > 1e-9) {
        const dec = BALL.rollingDrag * dt;
        const k = ts > dec ? -dec / ts : -1;
        v.x += tx * k;
        v.y += ty * k;
        v.z += tz * k;
      }
    }
  }
  if (touched) clampBallSpin(w);
  return touched;
}

/** Full ball step without orientation (the predictor uses this; World adds orientation). */
export function stepBall(b: BallBody, dt: number, gravityScale: number, info: BallContactInfo | null): boolean {
  integrateBall(b, dt, gravityScale);
  return collideBallArena(b, dt, info);
}

/**
 * Position-only safety net: guarantees arenaSDF(ball) >= R after other systems (cars) moved the ball.
 * Also removes any velocity component into the surface (no bounce, no events).
 */
export function enforceBallInside(b: BallBody): void {
  const p = b.pos;
  const v = b.vel;
  for (let iter = 0; iter < COLLIDE_ITERATIONS; iter++) {
    const d = arenaSDF(p.x, p.y, p.z);
    if (d >= R) return;
    arenaNormal(p.x, p.y, p.z, _n);
    const push = R - d;
    p.x += _n.x * push;
    p.y += _n.y * push;
    p.z += _n.z * push;
    const vn = v.x * _n.x + v.y * _n.y + v.z * _n.z;
    if (vn < 0) {
      v.x -= _n.x * vn;
      v.y -= _n.y * vn;
      v.z -= _n.z * vn;
    }
  }
}
