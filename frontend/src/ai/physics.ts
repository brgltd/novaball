/**
 * NOVABALL AI — car motion models used for planning (arrival-time estimates, turning limits, jump timing).
 * They mirror src/sim/car.ts closely enough for planning; the bots re-plan every tick so small errors self-correct.
 */
import { CAR, DT, GRAVITY } from '../sim/constants';
import { curve } from './math';

export const MAX_SPEED = CAR.maxSpeed;
export const THROTTLE_MAX = CAR.maxThrottleSpeed;
export const BOOST_ACCEL = CAR.boostAccel;
export const BOOST_PER_SEC = CAR.boostConsumption;

/** Ground throttle acceleration at |speed|. */
export function throttleAccel(speed: number): number {
  return curve(CAR.throttleAccelCurve, speed < 0 ? -speed : speed);
}

/** Turning curvature (1/m) at full steer for a forward speed. */
export function steerCurvature(speed: number): number {
  return curve(CAR.steerCurvature, speed < 0 ? -speed : speed);
}

/** Turning radius (m) at full steer. */
export function turnRadius(speed: number): number {
  return 1 / steerCurvature(speed);
}

/** Max yaw rate (rad/s) at full steer for a speed. */
export function maxYawRate(speed: number): number {
  const s = speed < 0 ? -speed : speed;
  return s * steerCurvature(s);
}

const KAPPA = CAR.steerCurvature;
/**
 * Highest speed whose full-steer curvature is at least `kappa` (inverse of the monotone steer curve).
 * Returns 0 if even a standstill can't turn that tight, MAX_SPEED if any speed can.
 */
export function maxSpeedForCurvature(kappa: number): number {
  if (kappa <= KAPPA[KAPPA.length - 1][1]) return MAX_SPEED;
  if (kappa >= KAPPA[0][1]) return 0;
  for (let i = 1; i < KAPPA.length; i++) {
    const p0 = KAPPA[i - 1];
    const p1 = KAPPA[i];
    if (kappa >= p1[1]) {
      // between p0 (higher curvature, lower speed) and p1
      const t = (p0[1] - kappa) / (p0[1] - p1[1]);
      return p0[0] + (p1[0] - p0[0]) * t;
    }
  }
  return MAX_SPEED;
}

/**
 * Straight-line acceleration profile: distance covered (and speed) at each time step from a start speed,
 * with full throttle and optional boost (limited by the tank). Used for arrival-time estimates.
 */
export class StraightProfile {
  readonly n: number;
  readonly dt: number;
  readonly dist: Float64Array;
  readonly speed: Float64Array;

  constructor(horizon: number, dt: number) {
    this.dt = dt;
    this.n = Math.max(1, Math.round(horizon / dt));
    this.dist = new Float64Array(this.n);
    this.speed = new Float64Array(this.n);
  }

  /**
   * @param v0 signed start speed along the travel direction (negative = moving away: brakes first)
   * @param boost boost in the tank (0..100)
   * @param useBoost allowed to boost
   * @param speedCap never plan faster than this (difficulty cap)
   */
  compute(v0: number, boost: number, useBoost: boolean, speedCap: number): void {
    const sub = 2;
    const h = this.dt / sub;
    let v = v0;
    let x = 0;
    let b = useBoost ? boost : 0;
    const cap = speedCap < MAX_SPEED ? speedCap : MAX_SPEED;
    // a car already faster than the cap keeps its speed (throttle held), it just doesn't accelerate further
    const limit = v0 > cap ? (v0 < MAX_SPEED ? v0 : MAX_SPEED) : cap;
    for (let k = 0; k < this.n; k++) {
      for (let s = 0; s < sub; s++) {
        let a: number;
        if (v < -0.25) {
          a = CAR.brakeAccel;
        } else {
          a = v < THROTTLE_MAX ? throttleAccel(v) : 0;
          if (b > 0 && v < limit - 0.05) {
            a += BOOST_ACCEL;
            b -= BOOST_PER_SEC * h;
          }
        }
        v += a * h;
        if (v > limit) v = limit;
        x += v * h;
      }
      this.dist[k] = x;
      this.speed[k] = v;
    }
  }

  /** Time (s) to cover `d` metres (linear interpolation; beyond the horizon: extrapolated at the final speed). */
  timeTo(d: number): number {
    const dist = this.dist;
    if (d <= 0) return 0;
    const last = dist[this.n - 1];
    if (d > last) {
      const v = this.speed[this.n - 1];
      return this.n * this.dt + (d - last) / (v > 1 ? v : 1);
    }
    // binary search for the first k with dist[k] >= d
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    const d1 = dist[lo];
    const d0 = lo > 0 ? dist[lo - 1] : 0;
    const f = d1 > d0 ? (d - d0) / (d1 - d0) : 1;
    return (lo + f) * this.dt;
  }

  /** Speed reached after covering `d` metres (clamped to the horizon). */
  speedAt(d: number): number {
    const t = this.timeTo(d);
    if (!Number.isFinite(t)) return this.speed[this.n - 1];
    let k = Math.round(t / this.dt) - 1;
    if (k < 0) k = 0;
    if (k >= this.n) k = this.n - 1;
    return this.speed[k];
  }
}

// ---------------------------------------------------------------------------------------------
// Jumps (vertical motion of a level car, closed form). `gScale` here is always the CAR gravity multiplier
// (BotContext.carGScale — in a ZERO-G SURGE cars fall faster than the ball).
// ---------------------------------------------------------------------------------------------

export const JUMP_V0 = CAR.jumpImpulse;
export const JUMP_HOLD_ACCEL = CAR.jumpHoldAccel;
export const JUMP_HOLD_TIME = CAR.jumpHoldTime;

/**
 * Rise of the car origin above its start height at time t after a jump press, for a hold of `hold`
 * seconds (≤ jumpHoldTime) and an optional second (double) jump at `doubleAt` (< 0 = none).
 */
export function jumpRise(t: number, gScale: number, hold = JUMP_HOLD_TIME, doubleAt = -1): number {
  const g = GRAVITY * gScale;
  const H = hold < JUMP_HOLD_TIME ? hold : JUMP_HOLD_TIME;
  const a1 = JUMP_HOLD_ACCEL - g;
  // (double jumps always come after the hold in the bots' maneuvers: doubleAt >= H)
  if (t <= H) return JUMP_V0 * t + 0.5 * a1 * t * t;
  const yH = JUMP_V0 * H + 0.5 * a1 * H * H;
  const vH = JUMP_V0 + a1 * H;
  if (doubleAt < 0 || t <= doubleAt) {
    const tau = t - H;
    return yH + vH * tau - 0.5 * g * tau * tau;
  }
  const tD = doubleAt - H;
  const yD = yH + vH * tD - 0.5 * g * tD * tD;
  const vD = vH - g * tD + JUMP_V0;
  const tau = t - doubleAt;
  return yD + vD * tau - 0.5 * g * tau * tau;
}

/** Vertical speed at time t for the same jump model. */
export function jumpVel(t: number, gScale: number, hold = JUMP_HOLD_TIME, doubleAt = -1): number {
  const g = GRAVITY * gScale;
  const H = hold < JUMP_HOLD_TIME ? hold : JUMP_HOLD_TIME;
  const a1 = JUMP_HOLD_ACCEL - g;
  if (t <= H) return JUMP_V0 + a1 * t;
  let v = JUMP_V0 + a1 * H - g * (t - H);
  if (doubleAt >= 0 && t > doubleAt) v += JUMP_V0;
  return v;
}

/** Apex rise (and its time) of a jump. */
export function jumpApex(gScale: number, doubleAt = -1): { rise: number; time: number } {
  const g = GRAVITY * gScale;
  const H = JUMP_HOLD_TIME;
  const vAfter = doubleAt >= 0 ? jumpVel(doubleAt + 1e-6, gScale, H, doubleAt) : JUMP_V0 + (JUMP_HOLD_ACCEL - g) * H;
  const t0 = doubleAt >= 0 ? doubleAt : H;
  const tApex = t0 + vAfter / g;
  return { rise: jumpRise(tApex, gScale, H, doubleAt), time: tApex };
}

/**
 * Earliest time (s after the press) at which the car origin has risen by `rise` metres on the way up,
 * or -1 if the jump never gets that high. Numeric (cheap: ≤ 2.5 s at 1/240 s).
 */
export function timeToRise(rise: number, gScale: number, doubleAt = -1): number {
  if (rise <= 0) return 0;
  const step = 1 / 240;
  let prev = 0;
  for (let t = step; t < 2.5; t += step) {
    const y = jumpRise(t, gScale, JUMP_HOLD_TIME, doubleAt);
    if (y >= rise) {
      // interpolate
      const f = (rise - prev) / (y - prev);
      return t - step + f * step;
    }
    if (y < prev) return -1; // past the apex
    prev = y;
  }
  return -1;
}

/** Default double-jump timing: right after the first jump's hold ends. */
export const DOUBLE_JUMP_AT = JUMP_HOLD_TIME + 2 * DT;

/**
 * Rise (m) the car origin needs so the nose meets a ball whose center is at height `ballY` (jump shots hit the ball
 * slightly above the car's center line).
 */
export function jumpShotRise(ballY: number): number {
  const r = ballY - CAR.rideHeight - 0.35;
  return r > 0.1 ? r : 0.1;
}

const RISE_STEP = 0.02;
const RISE_DT = 1 / 480;

/**
 * Jump timing for one CAR gravity scale: apex of a full-hold single jump and of the bots' double jump, and the inverse
 * of the rise curve on a fine grid. riseTime(rise) = seconds after the press at which the car origin has risen `rise`
 * metres on the way up — the APEX time when `rise` is at / above the apex (the car then meets the ball with its roof /
 * nose at the top of the jump). The intercept planner and the jump-shot executor both use this one model: a jump
 * intercept is only offered at T ≥ riseTime, and the executor presses jump once T ≤ riseTime (+ a tick), so a ball
 * held at jump height (pinned on a ramp / resting on a car) can never freeze a bot in a jump setup that never jumps.
 */
export class JumpTiming {
  readonly gScale: number;
  readonly singleApex: number;
  readonly singleApexT: number;
  readonly doubleApex: number;
  readonly doubleApexT: number;
  private readonly single: Float64Array;
  private readonly dbl: Float64Array;

  constructor(gScale: number) {
    this.gScale = gScale;
    const a1 = jumpApex(gScale);
    const a2 = jumpApex(gScale, DOUBLE_JUMP_AT);
    this.singleApex = a1.rise;
    this.singleApexT = a1.time;
    this.doubleApex = a2.rise;
    this.doubleApexT = a2.time;
    this.single = JumpTiming.invert(gScale, -1, a1.rise, a1.time);
    this.dbl = JumpTiming.invert(gScale, DOUBLE_JUMP_AT, a2.rise, a2.time);
  }

  /** t(rise) on the grid rise = i · RISE_STEP (monotone sweep of the rising part of the curve). */
  private static invert(gScale: number, doubleAt: number, apex: number, tApex: number): Float64Array {
    const n = Math.max(2, Math.floor(apex / RISE_STEP) + 1);
    const out = new Float64Array(n);
    let prevT = 0;
    let prevY = 0;
    let i = 1;
    for (let t = RISE_DT; i < n && t < tApex + RISE_DT; t += RISE_DT) {
      const y = jumpRise(t, gScale, JUMP_HOLD_TIME, doubleAt);
      while (i < n && y >= i * RISE_STEP) {
        const f = y > prevY ? (i * RISE_STEP - prevY) / (y - prevY) : 1;
        out[i] = prevT + f * (t - prevT);
        i++;
      }
      prevT = t;
      prevY = y;
    }
    for (; i < n; i++) out[i] = tApex;
    return out;
  }

  /** Seconds after the press to rise `rise` metres (single or the bots' double jump); the apex time above the apex. */
  riseTime(rise: number, double: boolean): number {
    const apex = double ? this.doubleApex : this.singleApex;
    if (rise >= apex) return double ? this.doubleApexT : this.singleApexT;
    if (rise <= 0) return 0;
    const tab = double ? this.dbl : this.single;
    const x = rise / RISE_STEP;
    const i = Math.floor(x);
    if (i >= tab.length - 1) {
      // between the last grid point and the apex
      const t0 = tab[tab.length - 1];
      const r0 = (tab.length - 1) * RISE_STEP;
      const tA = double ? this.doubleApexT : this.singleApexT;
      return apex > r0 ? t0 + ((tA - t0) * (rise - r0)) / (apex - r0) : tA;
    }
    return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
  }
}

const _timings: JumpTiming[] = [];
/** Cached JumpTiming for a car gravity scale (a match only ever uses 1 and the surge scale). */
export function jumpTiming(carGScale: number): JumpTiming {
  for (let i = 0; i < _timings.length; i++) if (_timings[i].gScale === carGScale) return _timings[i];
  const jt = new JumpTiming(carGScale);
  if (_timings.length >= 8) _timings.shift();
  _timings.push(jt);
  return jt;
}
