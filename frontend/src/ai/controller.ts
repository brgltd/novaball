/**
 * NOVABALL AI — low-level driving primitives.
 *
 *  Driver.drive():  heading PD on the target angle in the car's local frame (works on walls too), speed control
 *                   (throttle / coast / brake / boost — never boosting when already at top speed), powerslide for
 *                   sharp turns, reverse for short targets behind, and a curvature speed limit so the car slows
 *                   down enough to actually pass through a close target instead of orbiting it.
 *  orientTo():      air orientation PD (pitch / yaw / roll) toward a desired forward + up.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { DT } from '../sim/constants';
import type { ControlState } from '../sim/types';
import type { SkillProfile } from './difficulty';
import { clamp, clamp1, wrapPi } from './math';
import { maxSpeedForCurvature, THROTTLE_MAX } from './physics';
import type { CarInfo } from './types';

export interface DriveOptions {
  /** Reverse to short targets behind the car. */
  reverse: boolean;
  /** Boost when useful (still subject to the skill's boost willingness). */
  boost: boolean;
  /** Powerslide through sharp turns. */
  slide: boolean;
  /** Slow down so the car can turn tightly enough to pass through the target (anti-orbit). */
  curvature: boolean;
  /** Minimum boost to keep (no boosting below). */
  reserve: number;
}

export const DRIVE_DEFAULT: Readonly<DriveOptions> = { reverse: true, boost: true, slide: true, curvature: true, reserve: 0 };

export function driveOpts(over: Partial<DriveOptions> = {}): DriveOptions {
  return { ...DRIVE_DEFAULT, ...over };
}

/** Neutral controls. */
export function neutral(out: ControlState): ControlState {
  out.throttle = 0;
  out.steer = 0;
  out.pitch = 0;
  out.yaw = 0;
  out.roll = 0;
  out.jump = false;
  out.boost = false;
  out.powerslide = false;
  out.pulse = false;
  return out;
}

/** Driver tuning (exported for calibration tools). */
export const DRIVER_TUNING = {
  /**
   * Enter a powerslide above this target angle (rad) … Measured over the travel-table grid (2808 cells) after the sim's
   * drift rework (powerslide yaw follows the planar speed: the nose comes round a U-turn in ≈ 0.9 s instead of 1.4 s):
   * a drift wins for CLOSE targets well behind (the car pivots onto them) but loses for far ones (the 9 m/s² slide grip
   * lets the momentum carry the car away while the nose turns, so the velocity reverses late). Sliding from > 109° at
   * ≥ 7 m/s for targets within 10 m: mean arrival −0.029 s overall, −0.084 s for ≥ 105° / ≥ 8 m/s targets (286 cells
   * faster, 45 slower) vs the old near-U-turn-only rule (> 149°, ≥ 12 m/s, any distance). Throttling through the slide
   * or leaving it on the planar speed measured slower.
   */
  slideIn: 1.9,
  /** … and leave it below this one. */
  slideOut: 0.6,
  /** Min forward speed to start a slide. */
  slideMinSpeed: 7,
  /** Max target distance (m) to start a slide (far targets: a grip turn is faster). */
  slideMaxDist: 10,
  /** Speed cap while the target is more than 90° off (fastest yaw rate region ≈ 8–10 m/s). */
  turnSpeed: 9,
  /** Reverse entry: max forward speed, min angle, max distance. */
  revSpeed: 6,
  revAngle: 2.25,
  revDist: 9,
  /** 3-point turn (back off with opposite lock) for close targets beside the car. */
  backoffDist: 3.2,
};

/** Stateful ground driver (one per bot). */
export class Driver {
  private prevAngle = 0;
  private hasPrev = false;
  private steerOut = 0;
  sliding = false;
  reversing = false;
  /** Seconds left in a 3-point-turn back-off. */
  private backoff = 0;
  /** Last target angle (rad, + = right) — for the brain. */
  angle = 0;
  /** Last target distance in the car's tangent plane. */
  dist = 0;
  /** Boost gate: re-rolled every so often from the skill's boost willingness. */
  boostGate = true;

  constructor(private readonly skill: SkillProfile) {}

  reset(): void {
    this.hasPrev = false;
    this.steerOut = 0;
    this.sliding = false;
    this.reversing = false;
    this.backoff = 0;
  }

  /**
   * Drive toward (tx, ty, tz) wanting forward speed `speed` there. Writes throttle / steer / boost / powerslide and
   * neutral air axes (jump untouched).
   */
  drive(me: CarInfo, tx: number, ty: number, tz: number, speed: number, out: ControlState, o: DriveOptions): void {
    const dx = tx - me.pos.x;
    const dy = ty - me.pos.y;
    const dz = tz - me.pos.z;
    const F = me.fwd;
    const Rt = me.right;
    const f = dx * F.x + dy * F.y + dz * F.z;
    const r = dx * Rt.x + dy * Rt.y + dz * Rt.z;
    const dist = Math.sqrt(f * f + r * r);
    const angle = Math.atan2(r, f);
    this.angle = angle;
    this.dist = dist;
    const aa = angle < 0 ? -angle : angle;
    const vF = me.fwdSpeed;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;

    // ---- reverse (short targets behind)
    if (o.reverse) {
      if (!this.reversing) {
        if (f < 0 && aa > DRIVER_TUNING.revAngle && dist < DRIVER_TUNING.revDist && vF < DRIVER_TUNING.revSpeed) this.reversing = true;
      } else if (aa < 1.3 || dist > DRIVER_TUNING.revDist + 5 || vF > DRIVER_TUNING.revSpeed + 0.5) this.reversing = false;
    } else this.reversing = false;

    // ---- 3-point turn: a close target beside the car (inside the turning circle) — back off with opposite lock
    if (this.backoff > 0) {
      this.backoff -= DT;
      if (aa < 0.5 || dist > DRIVER_TUNING.backoffDist + 2.5) this.backoff = 0;
    } else if (o.reverse && !this.reversing && dist < DRIVER_TUNING.backoffDist && aa > 0.9 && aa <= DRIVER_TUNING.revAngle && vF < 6 && me.onGround) {
      this.backoff = 1.0;
    }
    if (this.backoff > 0) {
      // reversing with steer s swings the NOSE toward −s: opposite lock turns the nose toward the target
      // (while still rolling forward during the brake phase, normal lock)
      out.steer = vF > 0.3 ? (r > 0 ? 1 : -1) : r > 0 ? -1 : 1;
      out.throttle = -1;
      out.boost = false;
      out.powerslide = false;
      this.steerOut = out.steer;
      this.sliding = false;
      this.hasPrev = false;
      return;
    }

    if (this.reversing) {
      const back = Math.atan2(r, -f); // + = target at the rear-right; steer +1 swings the rear right
      const steer = clamp1(3 * back);
      this.steerOut = steer;
      out.steer = steer;
      const vBack = -vF;
      let want = Math.sqrt(2 * 9 * dist);
      if (want > speed) want = speed;
      if (want > 12) want = 12;
      if (vBack < want - 0.5) out.throttle = -1;
      else if (vBack > want + 2.5) out.throttle = 1; // brake
      else out.throttle = 0;
      out.boost = false;
      out.powerslide = false;
      this.sliding = false;
      this.hasPrev = false;
      return;
    }

    // ---- heading PD
    let dAng = 0;
    if (this.hasPrev) dAng = wrapPi(angle - this.prevAngle) / DT;
    this.prevAngle = angle;
    this.hasPrev = true;
    let steer = clamp1(this.skill.steerKp * angle + this.skill.steerKd * dAng);
    const sm = this.skill.steerSmoothing;
    if (sm > 0) steer = this.steerOut + (steer - this.steerOut) * (1 - sm);
    const slew = this.skill.steerSlew;
    if (steer > this.steerOut + slew) steer = this.steerOut + slew;
    else if (steer < this.steerOut - slew) steer = this.steerOut - slew;
    this.steerOut = steer;

    // ---- powerslide (sharp turns at speed)
    if (o.slide && me.onGround) {
      if (!this.sliding) {
        if (aa > DRIVER_TUNING.slideIn && vF > DRIVER_TUNING.slideMinSpeed && dist > 2.5 && dist < DRIVER_TUNING.slideMaxDist) this.sliding = true;
      } else if (aa < DRIVER_TUNING.slideOut || vF < 3.5) this.sliding = false;
    } else this.sliding = false;

    // ---- curvature speed limit (anti-orbit); never faster than the skill allows
    let vt = speed < this.skill.speedCap ? speed : this.skill.speedCap;
    if (aa > 1.5708 && vt > DRIVER_TUNING.turnSpeed) vt = DRIVER_TUNING.turnSpeed;
    if (o.curvature && dist > 0.3) {
      let kReq: number;
      if (f > 0) kReq = (2 * (r < 0 ? -r : r)) / (dist * dist);
      else kReq = 2 / (dist > 1 ? dist : 1);
      if (this.sliding) kReq *= 0.75;
      const vMax = maxSpeedForCurvature(kReq);
      if (vt > vMax) vt = vMax > 2.5 ? vMax : 2.5;
    }

    // ---- speed control
    const dv = vt - vF;
    let thr: number;
    let bst = false;
    if (dv > 0.5) {
      thr = 1;
      bst =
        o.boost &&
        this.boostGate &&
        me.onGround &&
        !this.sliding &&
        aa < 0.3 &&
        vF < 22.6 &&
        me.boost > o.reserve &&
        (vt > THROTTLE_MAX + 0.4 || dv > 6);
    } else if (dv > -0.5) {
      thr = vt > THROTTLE_MAX ? 1 : clamp(0.08 + dv * 0.6, 0.02, 1);
      if (vt < 0.3 && vF < 0.6) thr = 0;
    } else if (dv > -4 || vF < 3) {
      thr = 0; // coast
    } else {
      thr = -1; // brake
    }
    out.throttle = thr;
    out.steer = steer;
    out.boost = bst;
    out.powerslide = this.sliding;
  }

  /** Stop (brake to zero) while turning toward a point. */
  stopFacing(me: CarInfo, tx: number, tz: number, out: ControlState): void {
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const f = dx * me.fwd.x + dz * me.fwd.z;
    const r = dx * me.right.x + dz * me.right.z;
    const angle = Math.atan2(r, f);
    this.angle = angle;
    const vF = me.fwdSpeed;
    out.steer = clamp1(3 * angle) * (vF < -0.5 ? -1 : 1);
    out.throttle = vF > 1 ? -1 : vF < -1 ? 1 : 0;
    out.boost = false;
    out.powerslide = false;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Air orientation
// ---------------------------------------------------------------------------------------------

export interface OrientGains {
  pitchKp: number;
  pitchKd: number;
  yawKp: number;
  yawKd: number;
  rollKp: number;
  rollKd: number;
}

/** Tuned by tests/ai/tools/orient-explore.ts: ≈ 0.6 s to settle within 10° from random tumbles, no overshoot. */
export const ORIENT_GAINS: Readonly<OrientGains> = {
  pitchKp: 4.2,
  pitchKd: 0.75,
  yawKp: 4.2,
  yawKd: 0.9,
  rollKp: 3.2,
  rollKd: 0.4,
};

const _F = new Vector3();
const _U = new Vector3();
const _L = new Vector3();
const _m = new Matrix4();
const _qt = new Quaternion();
const _qc = new Quaternion();
const _qe = new Quaternion();

/**
 * Air orientation PD: rotate the car so its nose points along F* = (fx, fy, fz) and its roof toward U* (made
 * orthogonal to F*; pass the car's current up to leave the roll free). Writes pitch / yaw / roll.
 * Returns the remaining rotation angle (rad).
 */
export function orientTo(
  me: CarInfo,
  quat: Quaternion,
  fx: number,
  fy: number,
  fz: number,
  ux: number,
  uy: number,
  uz: number,
  out: ControlState,
  g: Readonly<OrientGains> = ORIENT_GAINS,
): number {
  _F.set(fx, fy, fz);
  if (_F.lengthSq() < 1e-9) _F.copy(me.fwd);
  _F.normalize();
  _U.set(ux, uy, uz);
  _U.addScaledVector(_F, -_U.dot(_F));
  if (_U.lengthSq() < 1e-6) {
    _U.copy(me.up).addScaledVector(_F, -me.up.dot(_F));
    if (_U.lengthSq() < 1e-6) _U.set(0, 1, 0).addScaledVector(_F, -_F.y);
  }
  _U.normalize();
  _L.crossVectors(_U, _F);
  _m.makeBasis(_L, _U, _F);
  _qt.setFromRotationMatrix(_m);
  _qc.copy(quat).invert();
  _qe.multiplyQuaternions(_qt, _qc);
  if (_qe.w < 0) {
    _qe.x = -_qe.x;
    _qe.y = -_qe.y;
    _qe.z = -_qe.z;
    _qe.w = -_qe.w;
  }
  const s = Math.sqrt(_qe.x * _qe.x + _qe.y * _qe.y + _qe.z * _qe.z);
  const angle = 2 * Math.atan2(s, _qe.w);
  let ex = 0;
  let ey = 0;
  let ez = 0;
  if (s > 1e-7) {
    const k = angle / s;
    ex = _qe.x * k;
    ey = _qe.y * k;
    ez = _qe.z * k;
  }
  const Rt = me.right;
  const U = me.up;
  const Fw = me.fwd;
  const w = me.angVel;
  // local components (left = −right)
  const el = -(ex * Rt.x + ey * Rt.y + ez * Rt.z);
  const eu = ex * U.x + ey * U.y + ez * U.z;
  const ef = ex * Fw.x + ey * Fw.y + ez * Fw.z;
  const wl = -(w.x * Rt.x + w.y * Rt.y + w.z * Rt.z);
  const wu = w.x * U.x + w.y * U.y + w.z * U.z;
  const wf = w.x * Fw.x + w.y * Fw.y + w.z * Fw.z;
  out.pitch = clamp1(g.pitchKp * el - g.pitchKd * wl);
  out.yaw = clamp1(-(g.yawKp * eu - g.yawKd * wu));
  out.roll = clamp1(g.rollKp * ef - g.rollKd * wf);
  return angle;
}
