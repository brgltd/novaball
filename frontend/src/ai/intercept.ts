/**
 * NOVABALL AI — ball intercept search.
 *
 * For a car, scan the (perceived) ball path for the EARLIEST sample the car can reach in time, considering only
 * the heights its skill can play (ground / single jump / double jump / aerial / wall). Arrival times come from the
 * measured Driver travel-time table (speed × angle × distance × boost); the bots re-plan every tick, so estimation
 * errors self-correct as the car closes in.
 */
import { Vector3 } from 'three';
import { BALL, CAR, GRAVITY } from '../sim/constants';
import { clamp } from './math';
import type { BallPath } from './perception';
import { BOOST_ACCEL, BOOST_PER_SEC, jumpShotRise, jumpTiming, StraightProfile } from './physics';
import { TT_MAX_D } from './travel';
import { TT_A, TT_B, TT_D, TT_V } from './travelGrid';
import { TT_DATA } from './travelTable';
import type { CarInfo, HitKind, Intercept } from './types';

const NV = TT_V.length;
const NA = TT_A.length;
const ND = TT_D.length;
const A_STEP = TT_A[1] - TT_A[0];
const D_AX = Float64Array.from(TT_D);
const TT_D0 = TT_D[0];
const RAD2DEG = 180 / Math.PI;
const _p = new Vector3();

export interface InterceptCaps {
  /** Max ball-center height for a grounded touch. */
  groundMax: number;
  /** Max ball-center height for a single-jump touch (0 = no jump shots). */
  jumpMax: number;
  /** Max ball-center height for a double-jump touch (0 = none). */
  doubleMax: number;
  /** Max ball-center height for an aerial (0 = none). */
  aerialMax: number;
  aerialMinBoost: number;
  /** Max height of a wall ball the car drives up to (0 = no wall play). */
  wallMax: number;
  useBoost: boolean;
  speedCap: number;
  /** Seconds of slack added to the car's time budget (> 0 = optimistic). */
  slack: number;
  /** ZERO-G SURGE: DESCENDING balls count as jump / double-jump balls up to the car's real (low-gravity) reach. */
  surgeJump?: boolean;
}

/** Longest aerial flight the bots plan (s): longer flights are fragile (other touches, prediction drift). */
export const AERIAL_MAX_FLIGHT = 2.4;
/** Car-center to ball-center distance at a typical front touch. */
export const CONTACT_REACH = CAR.halfExtents.z + BALL.radius - 0.1;

/** Car-ball reach for a ground touch: the ball center must be this low (hits with the nose / roof edge). */
export const GROUND_MAX_DEFAULT = 1.75;
/** …and its vertical speed below this (a ball bouncing through the low zone is a timing gamble). */
export const GROUND_MAX_VY = 3.5;

/**
 * Per-car arrival-time model: the measured Driver travel-time table (travel.ts) for targets within its range, and a
 * straight-line acceleration profile to extrapolate beyond it. Updated once per tick per car: the table is sliced at
 * this tick's (speed, boost) — bilinear, as tableTravelTime — so each of the ~250 path samples scanned per tick costs
 * one angle × distance bilinear lookup, with no allocation (results go to fields, not boxed return values).
 */
export class CarMotionModel {
  readonly fast: StraightProfile;
  // (double-valued fields start as doubles: V8 then updates them in place instead of boxing every store)
  /** Forward speed used for the estimate. */
  v0 = 0.5;
  /** Boost the estimate may use. */
  boost = 0.5;
  /** Result of the last evalAt(): estimated travel time (s). */
  need = 0.5;
  private tFarBase = 0.5;
  /** Horizontal heading used for the angle to a target (velocity direction when the nose points up / down). */
  private hx = 0.5;
  private hz = 0.5;
  private hl = 0.5;
  private grounded = true;
  /** Travel-time table sliced at this tick's (speed, boost): [angle][distance]. */
  private readonly slice = new Float64Array(NA * ND);

  constructor(horizon: number, dt: number) {
    this.fast = new StraightProfile(horizon, dt);
  }

  update(car: CarInfo, caps: InterceptCaps): void {
    let v: number;
    if (car.onGround) v = car.fwdSpeed;
    else {
      // airborne: horizontal speed along the horizontal heading
      const fl = Math.sqrt(car.fwd.x * car.fwd.x + car.fwd.z * car.fwd.z);
      v = fl > 0.3 ? (car.vel.x * car.fwd.x + car.vel.z * car.fwd.z) / fl : Math.sqrt(car.vel.x * car.vel.x + car.vel.z * car.vel.z);
    }
    this.v0 = v;
    const boost = caps.useBoost ? car.boost : 0;
    this.boost = boost;
    this.grounded = car.onGround;
    this.fast.compute(v > 0 ? v : 0, boost, caps.useBoost, caps.speedCap);
    this.tFarBase = this.fast.timeTo(TT_MAX_D - CONTACT_REACH);
    // heading: horizontal projection of the car's forward (velocity direction when the nose points up / down)
    let fx = car.fwd.x;
    let fz = car.fwd.z;
    let fl = Math.sqrt(fx * fx + fz * fz);
    if (fl < 0.3) {
      const vl = Math.sqrt(car.vel.x * car.vel.x + car.vel.z * car.vel.z);
      if (vl > 2) {
        fx = car.vel.x;
        fz = car.vel.z;
        fl = vl;
      }
    }
    this.hx = fx;
    this.hz = fz;
    this.hl = fl;
    // bilinear weights over (boost, speed), as tableTravelTime's locate()
    let bi = 0;
    let bf = 0;
    if (boost >= TT_B[TT_B.length - 1]) {
      bi = TT_B.length - 2;
      bf = 1;
    } else if (boost > TT_B[0]) {
      while (bi < TT_B.length - 2 && boost > TT_B[bi + 1]) bi++;
      bf = (boost - TT_B[bi]) / (TT_B[bi + 1] - TT_B[bi]);
    }
    let vi = 0;
    let vf = 0;
    if (v >= TT_V[NV - 1]) {
      vi = NV - 2;
      vf = 1;
    } else if (v > TT_V[0]) {
      while (vi < NV - 2 && v > TT_V[vi + 1]) vi++;
      vf = (v - TT_V[vi]) / (TT_V[vi + 1] - TT_V[vi]);
    }
    const w00 = (1 - bf) * (1 - vf);
    const w01 = (1 - bf) * vf;
    const w10 = bf * (1 - vf);
    const w11 = bf * vf;
    const o00 = (bi * NV + vi) * NA * ND;
    const o01 = (bi * NV + vi + 1) * NA * ND;
    const o10 = ((bi + 1) * NV + vi) * NA * ND;
    const o11 = ((bi + 1) * NV + vi + 1) * NA * ND;
    const sl = this.slice;
    for (let j = 0; j < NA * ND; j++) sl[j] = w00 * TT_DATA[o00 + j] + w01 * TT_DATA[o01 + j] + w10 * TT_DATA[o10 + j] + w11 * TT_DATA[o11 + j];
  }

  /**
   * Estimated time (s) for `car` to bring its center within CONTACT_REACH of p (x, z) on the ground → this.need.
   * `extra` adds path length (e.g. driving up a wall). Takes the point as an object: doubles passed as call
   * arguments get boxed by V8 (one HeapNumber each, per path sample per car per tick).
   */
  evalAt(car: CarInfo, p: Vector3, extra: number): void {
    const dx = p.x - car.pos.x;
    const dz = p.z - car.pos.z;
    const dh = Math.sqrt(dx * dx + dz * dz);
    const d = dh + extra;
    if (d <= CONTACT_REACH) {
      this.need = this.grounded ? 0 : 0.2;
      return;
    }
    let aDeg = 68.75493541569878; // 1.2 rad
    const fl = this.hl;
    if (fl > 1e-3 && dh > 1e-3) {
      let c = (this.hx * dx + this.hz * dz) / (fl * dh);
      c = c > 1 ? 1 : c < -1 ? -1 : c;
      aDeg = Math.acos(c) * RAD2DEG;
      if (aDeg > 180) aDeg = 180;
    }
    let ai = Math.floor(aDeg / A_STEP);
    if (ai > NA - 2) ai = NA - 2;
    const af = (aDeg - ai * A_STEP) / A_STEP;
    const dq = d < TT_D0 ? TT_D0 : d > TT_MAX_D ? TT_MAX_D : d;
    let di = 0;
    while (di < ND - 2 && dq > D_AX[di + 1]) di++;
    const df = (dq - D_AX[di]) / (D_AX[di + 1] - D_AX[di]);
    const sl = this.slice;
    const r0 = ai * ND + di;
    const r1 = r0 + ND;
    const t0 = sl[r0] + (sl[r0 + 1] - sl[r0]) * df;
    const t1 = sl[r1] + (sl[r1 + 1] - sl[r1]) * df;
    let t = t0 + (t1 - t0) * af;
    if (d < TT_D0) t *= (d - CONTACT_REACH) / (TT_D0 - CONTACT_REACH);
    else if (d > TT_MAX_D) t += this.fast.timeTo(d - CONTACT_REACH) - this.tFarBase;
    // airborne cars first have to land / recover
    this.need = this.grounded ? t : t + 0.25;
  }

  /** evalAt() returning the estimate (tools / tests; the intercept scan reads `need`). */
  travelTime(car: CarInfo, x: number, z: number, extra: number): number {
    this.evalAt(car, _p.set(x, 0, z), extra);
    return this.need;
  }
}

/**
 * Aerial feasibility for reaching `target` (car center) at `t` seconds from now, jumping now from the ground
 * (or continuing from the current air state). `carGScale` is the CAR gravity multiplier (BotContext.carGScale).
 * Returns the required average boost acceleration fraction (0..1, lower = easier) or −1 if infeasible.
 */
export function aerialDifficulty(car: CarInfo, tx: number, ty: number, tz: number, t: number, carGScale: number): number {
  if (t < 0.35) return -1;
  const g = GRAVITY * carGScale;
  // from the ground: a full-hold jump adds ≈ 5.8 m/s over 0.2 s, and the car needs ~0.25 s to pitch up
  let vx = car.vel.x;
  let vy = car.vel.y;
  let vz = car.vel.z;
  let px = car.pos.x;
  let py = car.pos.y;
  let pz = car.pos.z;
  let T = t;
  if (car.onGround) {
    const tj = 0.2;
    const up = car.up;
    const vj = CAR.jumpImpulse + CAR.jumpHoldAccel * tj;
    vx += up.x * vj;
    vy += up.y * vj - g * tj;
    vz += up.z * vj;
    px += car.vel.x * tj + up.x * 0.75;
    py += car.vel.y * tj + up.y * 0.75;
    pz += car.vel.z * tj + up.z * 0.75;
    T -= tj;
  }
  if (T < 0.25) return -1;
  const dx = tx - (px + vx * T);
  const dy = ty - (py + vy * T - 0.5 * g * T * T);
  const dz = tz - (pz + vz * T);
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // effective boosting time: minus ~0.2 s of orientation at the start
  const Tb = T - 0.2;
  if (Tb < 0.15) return -1;
  const aReq = (2 * dl) / (Tb * Tb + 0.4 * Tb * 0.2);
  const frac = aReq / BOOST_ACCEL;
  // keep a margin for orientation / noise, and don't plan long, fragile flights
  if (frac > 0.72 || t > AERIAL_MAX_FLIGHT) return -1;
  // boost needed (boost time ≈ frac·T)
  const need = frac * T * BOOST_PER_SEC + 6;
  if (need > car.boost) return -1;
  // must not require flying downward hard (ball below the car's path)
  if (dy < -dl * 0.6 && dl > 2) return -1;
  return frac;
}

/**
 * Earliest reachable intercept for `car` on `path`. `model` must be updated for this car this tick. `carGScale` is the
 * CAR gravity multiplier (jump reach / aerial feasibility; the path already carries the ball's own gravity).
 * Writes `out` (found = false when nothing in the horizon is reachable).
 */
export function findIntercept(
  car: CarInfo,
  path: BallPath,
  model: CarMotionModel,
  caps: InterceptCaps,
  carGScale: number,
  out: Intercept,
): Intercept {
  out.found = false;
  out.k = -1;
  out.time = Infinity;
  out.need = Infinity;
  if (car.demolished || path.exploded) return out;
  const limit = path.scanLimit();
  const R = BALL.radius;
  const jt = jumpTiming(carGScale);
  const jumpReach = caps.jumpMax > 0 ? Math.min(caps.jumpMax, CAR.rideHeight + jt.singleApex + 0.55) : 0;
  const doubleReach = caps.doubleMax > 0 ? Math.min(caps.doubleMax, CAR.rideHeight + jt.doubleApex + 0.55) : 0;
  // ZERO-G SURGE: a descending ball may be met up to the real low-gravity jump reach (the skill caps assume 1 g)
  const jumpReachDesc = caps.surgeJump && caps.jumpMax > 0 ? Math.max(jumpReach, CAR.rideHeight + jt.singleApex + 0.55) : jumpReach;
  const doubleReachDesc = caps.surgeJump && caps.doubleMax > 0 ? Math.max(doubleReach, CAR.rideHeight + jt.doubleApex + 0.55) : doubleReach;
  const slack = caps.slack;
  const dtk = path.dt;
  for (let k = 0; k < limit; k++) {
    const p = path.pos(k);
    const t = (k + 1) * dtk;
    const h = p.y;
    let kind: HitKind;
    let extra = 0;
    // a ball only counts as a ground ball when it isn't passing through the low zone at bounce speed
    let vy = 0;
    if (h <= caps.groundMax) {
      vy = path.vel(k).y;
      if (vy < 0) vy = -vy;
    }
    const desc = h > jumpReach && jumpReachDesc > jumpReach && path.vel(k).y < 0;
    if (h <= caps.groundMax && (vy < GROUND_MAX_VY || h <= 1.25)) kind = 'ground';
    else if (h <= caps.groundMax && caps.jumpMax <= 0) continue;
    else if (caps.jumpMax > 0 && h <= (desc ? jumpReachDesc : jumpReach)) kind = 'jump';
    else if (caps.doubleMax > 0 && h <= (desc ? doubleReachDesc : doubleReach)) kind = 'double';
    else {
      const we = caps.wallMax > 0 && h <= caps.wallMax ? path.wallExtra(k) : -1;
      if (we >= 0) {
        kind = 'wall';
        extra = we;
      } else if (caps.aerialMax > 0 && h <= caps.aerialMax && car.boost >= caps.aerialMinBoost) {
        kind = 'aerial';
      } else continue;
    }
    if (kind === 'aerial') {
      if ((k & 1) === 1) continue; // half resolution is plenty for aerial planning
      // the car first turns toward the ball on the ground, then flies
      const tTurn = aerialTurnTime(car, p.x, p.z);
      if (aerialDifficulty(car, p.x, h - 0.2, p.z, t - tTurn, carGScale) < 0) continue;
      out.found = true;
      out.k = k;
      out.time = t;
      out.pos.copy(p);
      out.vel.copy(path.vel(k));
      out.kind = kind;
      out.need = t;
      return out;
    }
    model.evalAt(car, p, extra);
    const need = model.need;
    // jumps: the car must also be able to rise in time — the executor's own timing model (BotBrain.strike presses
    // jump once T ≤ riseTime), so an offered jump intercept is always one it can jump for
    if (need <= t + slack) {
      if ((kind === 'jump' || kind === 'double') && t < jt.riseTime(jumpShotRise(h), kind === 'double')) continue;
      out.found = true;
      out.k = k;
      out.time = t;
      out.pos.copy(p);
      out.vel.copy(path.vel(k));
      out.kind = kind;
      out.need = need;
      return out;
    }
  }
  return out;
}

/** Time to point the car at (x, z) before an aerial takeoff (0 if already facing it). */
function aerialTurnTime(car: CarInfo, x: number, z: number): number {
  if (!car.onGround) return 0;
  const dx = x - car.pos.x;
  const dz = z - car.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1) return 0;
  const fl = Math.sqrt(car.fwd.x * car.fwd.x + car.fwd.z * car.fwd.z);
  if (fl < 0.3) return 0.4;
  const c = clamp((car.fwd.x * dx + car.fwd.z * dz) / (fl * d), -1, 1);
  const th = Math.acos(c);
  return th < 0.25 ? 0 : th * 0.35;
}
