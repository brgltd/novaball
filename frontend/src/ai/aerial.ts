/**
 * NOVABALL AI — aerial controller.
 *
 * Classic "required acceleration" aerial: every tick compute where ballistic motion alone would leave the car at the
 * contact time, Δ = X − (p + v·T + ½·g·T²), point the nose along Δ (air roll left free) and boost while aligned and
 * while one more tick of boost doesn't overshoot (|Δ| > a·dt·T). Starts with a held jump (+ optional double jump)
 * from the ground; aborts to recovery when the target becomes infeasible or the ball changed course.
 */
import { Vector3 } from 'three';
import { DT, GRAVITY } from '../sim/constants';
import type { ControlState } from '../sim/types';
import type { BotContext } from './context';
import { orientTo } from './controller';
import { AI_DEBUG, Maneuver } from './maneuvers';
import { clamp1 } from './math';
import { BOOST_ACCEL, DOUBLE_JUMP_AT, JUMP_HOLD_TIME } from './physics';
import type { CarInfo } from './types';

const _P = new Vector3();
const _X = new Vector3();
const _D = new Vector3();

/** Debug log of aerial outcomes: reason, and ball position relative to the car at the end (fwd, right, up). */
export const AERIAL_LOG: Array<{ reason: string; rel: [number, number, number]; t: number; T0: number; h: number }> = [];

export class Aerial extends Maneuver {
  readonly name = 'aerial';
  private readonly startTime: number;
  private readonly fromGround: boolean;
  private readonly aim = new Vector3();
  private dodged = false;
  /** Ball-target drift (m) since the start — large changes (someone touched it) abort. */
  private readonly firstTarget = new Vector3();
  private hasFirst = false;

  constructor(
    ctx: BotContext,
    me: CarInfo,
    /** Absolute sim time of the planned contact. */
    readonly tc: number,
    /** Desired hit direction (unit; the car center aims at the ball's opposite side). */
    aim: Vector3,
    private readonly useDouble: boolean,
    private readonly dodgeAtEnd: boolean,
  ) {
    super();
    this.startTime = ctx.time;
    this.fromGround = me.onGround;
    this.aim.copy(aim);
    if (this.aim.lengthSq() < 1e-6) this.aim.set(0, 0, me.dir);
    this.aim.normalize();
  }

  step(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const t = this.t;
    const T = this.tc - ctx.time;
    const path = ctx.path;
    out.throttle = 1;
    out.steer = 0;
    out.powerslide = false;
    out.boost = false;
    out.jump = false;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    if (T > 0) _P.copy(path.pos(path.indexAt(T)));
    else _P.copy(path.nowPos);
    if (!this.hasFirst) {
      this.firstTarget.copy(_P);
      this.hasFirst = true;
    }
    const touched = me.lastTouchTime >= this.startTime;

    // --- jump buttons (from the ground)
    let pressTick = false;
    if (this.fromGround) {
      if (t < JUMP_HOLD_TIME) out.jump = true;
      else if (this.useDouble && t >= DOUBLE_JUMP_AT && t < DOUBLE_JUMP_AT + 3 * DT) {
        out.jump = true;
        pressTick = t < DOUBLE_JUMP_AT + DT;
      }
    }

    // --- targeting: car center aims slightly behind the ball along the hit direction
    _X.copy(_P).addScaledVector(this.aim, -1.3);
    const Tc = T > 0.03 ? T : 0.03;
    const g = GRAVITY * ctx.carGScale; // the CAR's gravity (a ZERO-G SURGE lowers it less than the ball's)
    _D.set(
      _X.x - (me.pos.x + me.vel.x * Tc),
      _X.y - (me.pos.y + me.vel.y * Tc - 0.5 * g * Tc * Tc),
      _X.z - (me.pos.z + me.vel.z * Tc),
    );
    const dl = _D.length();
    let fx: number;
    let fy: number;
    let fz: number;
    if (dl > 0.6) {
      fx = _D.x / dl;
      fy = _D.y / dl;
      fz = _D.z / dl;
    } else {
      // on course: point the nose at the ball
      fx = _P.x - me.pos.x;
      fy = _P.y - me.pos.y;
      fz = _P.z - me.pos.z;
      const l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      fx /= l;
      fy /= l;
      fz /= l;
    }
    if (!pressTick && !me.isDodging) orientTo(me, me.quat, fx, fy, fz, me.up.x, me.up.y, me.up.z, out);

    // --- boost: aligned, and one more tick of thrust doesn't overshoot
    const align = me.fwd.x * fx + me.fwd.y * fy + me.fwd.z * fz;
    if (!pressTick && dl > 0.6 && align > 0.82 && me.boost > 0 && dl > BOOST_ACCEL * DT * Tc * 0.9 && !me.isDodging) out.boost = true;

    // --- dodge into the ball at the end (legend)
    if (this.dodgeAtEnd && !this.dodged && !touched && me.canAirJump && T < 0.1 && T > -0.05) {
      const bx = _P.x - me.pos.x;
      const by = _P.y - me.pos.y;
      const bz = _P.z - me.pos.z;
      if (bx * bx + by * by + bz * bz < 3.2 * 3.2) {
        const f = bx * me.fwd.x + by * me.fwd.y + bz * me.fwd.z;
        const r = bx * me.right.x + by * me.right.y + bz * me.right.z;
        const m = Math.max(Math.abs(f), Math.abs(r), 1e-6);
        out.jump = true;
        out.pitch = clamp1(f / m);
        out.yaw = clamp1(r / m);
        out.roll = 0;
        out.boost = false;
        this.dodged = true;
      }
    }

    // --- termination
    let reason = '';
    if (touched && (T < 0.05 || this.dodged)) reason = 'touch';
    else if (T < -0.25) reason = 'late';
    else if (t > 0.45 && me.onGround) reason = 'landed';
    else if (t > JUMP_HOLD_TIME + 0.15 && Tc > 0.55 && dl > 1.5) {
      // infeasible now? (needs more than the boost can give, or out of boost)
      const aReq = (2 * dl) / (Tc * Tc);
      if (aReq > BOOST_ACCEL * 1.3) reason = 'infeasible';
      else if (me.boost <= 0 && dl > 2.5) reason = 'noBoost';
    }
    // the ball changed course (someone touched it): bail out
    if (!reason && _P.distanceToSquared(this.firstTarget) > 16 && T > 0.2) reason = 'course';
    if (!reason && t > 4.5) reason = 'timeout';
    if (reason) {
      this.done = true;
      if (AI_DEBUG.log && AERIAL_LOG.length < 5000) {
        const B = path.nowPos;
        const rx = B.x - me.pos.x;
        const ry = B.y - me.pos.y;
        const rz = B.z - me.pos.z;
        AERIAL_LOG.push({
          reason: touched ? 'touch' : reason,
          rel: [rx * me.fwd.x + ry * me.fwd.y + rz * me.fwd.z, rx * me.right.x + ry * me.right.y + rz * me.right.z, rx * me.up.x + ry * me.up.y + rz * me.up.z],
          t,
          T0: this.tc - this.startTime,
          h: this.firstTarget.y,
        });
      }
    }
  }
}
