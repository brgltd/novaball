/**
 * NOVABALL AI — multi-tick maneuvers (precisely timed button sequences) + landing orientation.
 *
 * A maneuver owns the controls until it reports `done`. Jump presses are edges in the sim, so every sequence
 * releases the button for at least one tick between presses.
 */
import { Vector3 } from 'three';
import { arenaNormal, arenaSDF } from '../sim/arena';
import { CAR, DT, GRAVITY } from '../sim/constants';
import type { ControlState } from '../sim/types';
import type { BotContext } from './context';
import { orientTo } from './controller';
import { clamp1 } from './math';
import { DOUBLE_JUMP_AT, JUMP_HOLD_TIME } from './physics';
import type { CarInfo } from './types';

export abstract class Maneuver {
  /** Seconds since start (advanced by the brain after each step). */
  t = 0;
  done = false;
  abstract readonly name: string;
  /** Write this tick's controls. */
  abstract step(ctx: BotContext, me: CarInfo, out: ControlState): void;
}

// ---------------------------------------------------------------------------------------------
// Landing orientation
// ---------------------------------------------------------------------------------------------

const _ln = new Vector3();
const _lf = new Vector3();

/**
 * Predict where an airborne car will touch down (ballistic, arena SDF) and write the surface normal into `outN`.
 * `carGScale` is the CAR gravity multiplier (BotContext.carGScale). Returns the time to touchdown (s), or −1 if nothing
 * within 3 s.
 */
export function predictLanding(me: CarInfo, carGScale: number, outN: Vector3): number {
  const g = GRAVITY * carGScale;
  let px = me.pos.x;
  let py = me.pos.y;
  let pz = me.pos.z;
  let vx = me.vel.x;
  let vy = me.vel.y;
  let vz = me.vel.z;
  const h = 1 / 30;
  const reach = CAR.rideHeight + 0.35;
  for (let i = 1; i <= 90; i++) {
    vy -= g * h;
    px += vx * h;
    py += vy * h;
    pz += vz * h;
    const d = arenaSDF(px, py, pz);
    if (d < reach) {
      arenaNormal(px, py, pz, outN);
      return i * h;
    }
  }
  outN.set(0, 1, 0);
  return -1;
}

/**
 * Air recovery: land wheels-down on the predicted surface, nose along the velocity (or toward (hx, hz) when
 * given and the car is slow). Writes pitch / yaw / roll; returns the time to touchdown (−1 unknown).
 */
export function recoverOrient(ctx: BotContext, me: CarInfo, out: ControlState, hx = NaN, hz = NaN): number {
  const tLand = predictLanding(me, ctx.carGScale, _ln);
  const n = _ln;
  // forward: velocity projected on the landing plane (keeps momentum), else the requested heading
  _lf.copy(me.vel).addScaledVector(n, -me.vel.dot(n));
  const hs = _lf.length();
  if (!Number.isNaN(hx) && (hs < 6 || n.y > 0.7)) {
    const tx = hx - me.pos.x;
    const tz = hz - me.pos.z;
    // blend toward the desired heading when landing on the floor
    const l = Math.sqrt(tx * tx + tz * tz);
    if (l > 1e-3) {
      const w = hs < 6 ? 1 : 0.5;
      // _lf = normalize(_lf)·(1 − w) + heading·w
      if (hs > 1e-3) _lf.multiplyScalar((1 - w) / hs);
      else _lf.set(0, 0, 0);
      _lf.x += (tx / l) * w;
      _lf.z += (tz / l) * w;
      _lf.addScaledVector(n, -_lf.dot(n));
    }
  }
  if (_lf.lengthSq() < 1e-6) _lf.copy(me.fwd).addScaledVector(n, -me.fwd.dot(n));
  if (_lf.lengthSq() < 1e-6) _lf.set(0, 0, 1);
  orientTo(me, me.quat, _lf.x, _lf.y, _lf.z, n.x, n.y, n.z, out);
  return tLand;
}

// ---------------------------------------------------------------------------------------------
// Flip (jump + dodge)
// ---------------------------------------------------------------------------------------------

/** Ground jump then dodge in local direction (f = forward, r = right). */
export class Flip extends Maneuver {
  readonly name = 'flip';
  constructor(
    private f: number,
    private r: number,
    /** Seconds the first jump is held. */
    private hold = 0.06,
    /** Seconds after the first press the dodge is pressed. */
    private dodgeAt = 0.12,
    /** Keep boosting until the dodge. */
    private boostBefore = false,
    /** Heading to recover toward after the flip. */
    private hx = NaN,
    private hz = NaN,
  ) {
    super();
    const m = Math.max(Math.abs(f), Math.abs(r));
    if (m > 1e-6) {
      this.f = f / m;
      this.r = r / m;
    } else {
      this.f = 1;
      this.r = 0;
    }
  }

  /** Re-aim the dodge direction before it is pressed. */
  aim(f: number, r: number): void {
    const m = Math.max(Math.abs(f), Math.abs(r));
    if (m > 1e-6) {
      this.f = f / m;
      this.r = r / m;
    }
  }

  get dodged(): boolean {
    return this.t >= this.dodgeAt + 3 * DT;
  }

  step(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const t = this.t;
    out.throttle = 1;
    out.steer = 0;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    out.powerslide = false;
    out.boost = false;
    out.jump = false;
    if (t < this.hold) {
      out.jump = true;
      out.boost = this.boostBefore;
    } else if (t < this.dodgeAt) {
      out.boost = this.boostBefore;
    } else if (t < this.dodgeAt + 3 * DT) {
      out.jump = true;
      out.pitch = this.f;
      out.yaw = this.r;
    } else if (t < this.dodgeAt + 0.47) {
      // flip in progress: keep the stick neutral (pitch against a flip in the first 0.45 s cancels it)
    } else if (!me.onGround) {
      recoverOrient(ctx, me, out, this.hx, this.hz);
    }
    if ((t > this.dodgeAt + 0.3 && me.onGround) || t > 2.4) this.done = true;
    // the first press must lift off: if we're still grounded after the hold, abort
    if (t > this.hold + 3 * DT && t < this.dodgeAt && me.onGround) this.done = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Jump shot (single / double jump, optional dodge into the ball)
// ---------------------------------------------------------------------------------------------

const _bp = new Vector3();

/** Debug switches (tuning tools only; keep false in the game). */
export const AI_DEBUG = { log: false };

/** Debug: ball position relative to the car (forward, right, up) at a jump shot's planned contact time. */
export const JUMPSHOT_MISS_LOG: Array<[number, number, number, number]> = [];

export class JumpShot extends Maneuver {
  readonly name = 'jumpShot';
  private readonly startTime: number;
  private dodged = false;
  private logged = false;
  constructor(
    ctx: BotContext,
    /** Absolute sim time of the planned contact. */
    private readonly tc: number,
    private readonly double: boolean,
    private readonly dodge: boolean,
  ) {
    super();
    this.startTime = ctx.time;
  }

  step(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const t = this.t;
    const T = this.tc - ctx.time;
    out.throttle = 1;
    out.steer = 0;
    out.boost = false;
    out.powerslide = false;
    out.jump = false;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    // current belief of the ball at contact
    const path = ctx.path;
    if (T > 0) _bp.copy(path.pos(path.indexAt(T)));
    else _bp.copy(path.nowPos);
    const touched = me.lastTouchTime >= this.startTime;
    if (AI_DEBUG.log && !this.logged && T <= 0 && JUMPSHOT_MISS_LOG.length < 5000) {
      this.logged = true;
      const B = path.nowPos;
      const rx = B.x - me.pos.x;
      const ry = B.y - me.pos.y;
      const rz = B.z - me.pos.z;
      JUMPSHOT_MISS_LOG.push([
        rx * me.fwd.x + ry * me.fwd.y + rz * me.fwd.z,
        rx * me.right.x + ry * me.right.y + rz * me.right.z,
        ry,
        touched ? 1 : 0,
      ]);
    }
    // --- jump buttons
    let pressTick = false;
    if (t < JUMP_HOLD_TIME) out.jump = true;
    else if (this.double && t >= DOUBLE_JUMP_AT && t < DOUBLE_JUMP_AT + 3 * DT) {
      out.jump = true;
      pressTick = t < DOUBLE_JUMP_AT + DT;
    }
    // --- orientation: nose toward the ball (level before the double jump so its impulse goes up)
    if (!pressTick && !this.dodged) {
      const dx = _bp.x - me.pos.x;
      const dz = _bp.z - me.pos.z;
      let dy = _bp.y - me.pos.y;
      if (this.double && t < DOUBLE_JUMP_AT + 3 * DT) dy = 0;
      else dy = dy * 0.5;
      orientTo(me, me.quat, dx, dy, dz, 0, 1, 0, out);
    }
    // --- catch up in the air: boost while we'd arrive short of the contact spot (nose roughly level)
    if (!pressTick && !this.dodged && !touched && T > 0.05 && me.boost > 0) {
      const hx = _bp.x - me.pos.x;
      const hz = _bp.z - me.pos.z;
      const hd = Math.sqrt(hx * hx + hz * hz);
      const vAlong = hd > 1e-3 ? (me.vel.x * hx + me.vel.z * hz) / hd : 0;
      const short = hd - 1.4 - vAlong * T;
      const level = me.fwd.y < 0.45 && me.fwd.y > -0.3;
      const facing = hd > 1e-3 ? (me.fwd.x * hx + me.fwd.z * hz) / hd > 0.8 : false;
      if (short > 0.25 && level && facing) out.boost = true;
    }
    // --- dodge into the ball
    if (this.dodge && !this.dodged && !this.double && t > JUMP_HOLD_TIME + DT && me.canAirJump && !touched) {
      const dx = _bp.x - me.pos.x;
      const dy = _bp.y - me.pos.y;
      const dz = _bp.z - me.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (T < 0.12 || dist < 2.3) {
        const f = dx * me.fwd.x + dz * me.fwd.z;
        const r = dx * me.right.x + dz * me.right.z;
        const m = Math.max(Math.abs(f), Math.abs(r), 1e-6);
        out.jump = true;
        out.pitch = clamp1(f / m);
        out.yaw = clamp1(r / m);
        out.roll = 0;
        this.dodged = true;
      }
    } else if (this.dodged && t < 3) {
      // keep the stick neutral during the flip
      if (me.isDodging) {
        out.pitch = 0;
        out.yaw = 0;
        out.roll = 0;
      }
    }
    if (touched && !this.dodged) {
      // contact made: follow through briefly then hand back
      if (T < -0.05) this.done = true;
    }
    if (T < -0.35 || t > 3.2) this.done = true;
    if (me.onGround && t > 0.3) this.done = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Small utility maneuvers
// ---------------------------------------------------------------------------------------------

/** Stuck (against a wall / goal post / another car): reverse with lock for a moment. */
export class Unstick extends Maneuver {
  readonly name = 'unstick';
  constructor(private readonly steer: number, private readonly duration = 0.7) {
    super();
  }
  step(_ctx: BotContext, me: CarInfo, out: ControlState): void {
    out.throttle = -1;
    out.steer = this.steer;
    out.boost = false;
    out.jump = this.t > 0.45 && this.t < 0.5 && me.speed < 0.5; // hop if still pinned
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    out.powerslide = false;
    if (this.t >= this.duration) this.done = true;
  }
}

/** Goal celebration: hop, spin with air roll, land. */
export class Celebrate extends Maneuver {
  readonly name = 'celebrate';
  constructor(private readonly style: number) {
    super();
  }
  step(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const t = this.t;
    out.throttle = 0.4;
    out.steer = 0;
    out.boost = false;
    out.powerslide = false;
    out.jump = false;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    if (t < 0.2) out.jump = true;
    else if (this.style === 0) {
      // barrel roll
      if (t < 1.0) out.roll = 1;
      else if (!me.onGround) recoverOrient(ctx, me, out);
    } else if (this.style === 1) {
      // double jump + spin
      if (t > 0.25 && t < 0.28) out.jump = true;
      if (t > 0.3 && t < 1.1) out.yaw = 1;
      else if (!me.onGround && t >= 1.1) recoverOrient(ctx, me, out);
    } else {
      // backflip
      if (t > 0.26 && t < 0.3) {
        out.jump = true;
        out.pitch = -1;
      } else if (t > 1.2 && !me.onGround) recoverOrient(ctx, me, out);
    }
    if ((t > 0.5 && me.onGround) || t > 3) this.done = true;
  }
}
