/**
 * NOVABALL render-world — camera system (implements ICameraRig).
 *
 * Modes:
 *  - 'car'       chase cam behind the followed car (settings distance/height/stiffness/fov). Ball-cam keeps the ball
 *                in view while staying behind the car (clamped so the car never leaves the frame). Car-cam follows
 *                the heading on the ground and the velocity in the air. The chase offset lives in the car's SURFACE
 *                frame: on walls / the ceiling the camera sits "above" the car along the surface normal (inside the
 *                arena) instead of collapsing onto it; the view itself only partially rolls with the car.
 *                High balls: the camera backs off and drops and the look clamp relaxes so both the car and the ball
 *                stay framed. FOV kick when boosting / supersonic. Never leaves the arena (SDF clamp).
 *  - 'replay'    cinematic low ball follow with the goal in frame.
 *  - 'orbit'     slow high cinematic orbit around the ball's side of the pitch (menu attract mode), aimed at the ball.
 *  - 'broadcast' TV side camera tracking the ball.
 *  - 'goal'      hero shot near ctx.focus with a slow push-in.
 *  - 'endPodium' swing around ctx.focus on the arena side (never behind a wall).
 * shake(): trauma-based smooth noise shake. snap(): immediate placement. Mode switches blend over ~0.6 s.
 */
import { MathUtils, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { CameraContext, CameraMode, ICameraRig } from '../contracts';
import type { Settings } from '../settings';
import { arenaNormal, arenaSDF, targetGoalCenter } from '../sim/arena';
import { ARENA, CAR } from '../sim/constants';
import { gameplayVerticalFov } from './fov';

const WORLD_UP = new Vector3(0, 1, 0);
const ZERO = new Vector3();
const MIN_CLEARANCE = 0.6;
/** The chase camera never gets closer than this to the car (the hitbox is 0.92 × 0.4 × 1.32 m). */
const CHASE_MIN_DIST = 1.2;
/** A collision-slid chase position is only kept while it is at least this far from the car. */
const CHASE_SLIDE_MIN_DIST = 2.2;

interface Pose {
  pos: Vector3;
  look: Vector3;
  up: Vector3;
  /** horizontal fov (deg) */
  hfov: number;
}

function makePose(): Pose {
  return { pos: new Vector3(), look: new Vector3(), up: new Vector3(0, 1, 0), hfov: 90 };
}

function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export class CameraRig implements ICameraRig {
  private fov = 105;
  private distance = 3.4;
  private height = 1.25;
  private stiffness = 0.45;
  private shakeScale = 0.8;

  private mode: CameraMode | null = null;
  private modeTime = 0;
  // blend between modes
  private blendT = 1;
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private fromFov = 60;

  // current (smoothed) pose of the active mode
  private readonly pose = makePose();
  private readonly target = makePose(); // scratch desired pose
  // chase state
  private readonly chaseDir = new Vector3(0, 0, 1);
  /** View up (world up, partially rolled with the car on walls). */
  private readonly camUp = new Vector3(0, 1, 0);
  /** Surface frame up the chase offset is built in (world up on the floor / in the air, the car's up on walls). */
  private readonly frameUp = new Vector3(0, 1, 0);
  private readonly pivot = new Vector3();
  /** Followed car position at the previous chase update (start of the frame for the exact pivot lag). */
  private readonly prevCarPos = new Vector3();
  private readonly lookDir = new Vector3(0, 0, 1);
  private fovKick = 0;
  private stretch = 0;
  /** 0..1 "ball high above the car" framing factor (smoothed). */
  private high = 0;
  /** Same, for far balls only (allows an extra look-clamp relaxation). */
  private highFar = 0;
  /** Current extra look-clamp relaxation (radians, smoothed). */
  private relax = 0;
  // shake
  private trauma = 0;
  private shakeT = 0;
  // damping helper (no per-frame closure allocation)
  private kkDt = 0;
  private readonly kk = (rate: number): number => (this.kkDt < 0 ? 1 : damp(rate, this.kkDt));
  // scratch
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly v4 = new Vector3();
  private readonly v5 = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly m1 = new Matrix4();

  constructor(
    private readonly camera: PerspectiveCamera,
    settings: Settings,
  ) {
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.fov = s.fov;
    this.distance = s.cameraDistance;
    this.height = s.cameraHeight;
    this.stiffness = Math.max(0, Math.min(1, s.cameraStiffness));
    this.shakeScale = Math.max(0, Math.min(1, s.screenShake));
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  snap(ctx: CameraContext): void {
    this.mode = ctx.mode;
    this.modeTime = 0;
    this.blendT = 1;
    this.resetChase(ctx);
    this.computeTarget(0, ctx, true);
    this.pose.pos.copy(this.target.pos);
    this.pose.look.copy(this.target.look);
    this.pose.up.copy(this.target.up);
    this.pose.hfov = this.target.hfov;
    this.apply(0);
  }

  update(dt: number, ctx: CameraContext): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (this.mode === null) {
      this.snap(ctx);
      return;
    }
    if (ctx.mode !== this.mode) {
      // capture the current camera pose and blend to the new mode
      this.fromPos.copy(this.camera.position);
      this.fromQuat.copy(this.camera.quaternion);
      this.fromFov = this.camera.fov;
      this.blendT = 0;
      this.mode = ctx.mode;
      this.modeTime = 0;
      this.resetChase(ctx);
      this.computeTarget(0, ctx, true);
      this.pose.pos.copy(this.target.pos);
      this.pose.look.copy(this.target.look);
      this.pose.up.copy(this.target.up);
      this.pose.hfov = this.target.hfov;
    }
    this.modeTime += dt;
    this.computeTarget(dt, ctx, false);
    if (this.mode === 'car') {
      // the chase cam does its own smoothing inside computeTarget
      this.pose.pos.copy(this.target.pos);
      this.pose.look.copy(this.target.look);
      this.pose.up.copy(this.target.up);
      this.pose.hfov = this.target.hfov;
    } else {
      const rp = this.mode === 'replay' ? 2.4 : this.mode === 'broadcast' ? 1.6 : this.mode === 'orbit' ? 2.0 : 3.0;
      const rl = this.mode === 'replay' ? 5.0 : this.mode === 'broadcast' ? 3.5 : 3.0;
      this.pose.pos.lerp(this.target.pos, damp(rp, dt));
      this.pose.look.lerp(this.target.look, damp(rl, dt));
      this.pose.up.lerp(this.target.up, damp(3, dt)).normalize();
      this.pose.hfov += (this.target.hfov - this.pose.hfov) * damp(3, dt);
      this.keepInside(this.pose.pos, this.pose.look);
    }
    this.blendT = Math.min(1, this.blendT + dt / 0.6);
    this.apply(dt);
  }

  // ----------------------------------------------------------------------------------------------------------

  private resetChase(ctx: CameraContext): void {
    const car = ctx.target;
    this.fovKick = 0;
    this.stretch = 0;
    this.high = 0;
    this.highFar = 0;
    this.relax = 0;
    this.camUp.copy(WORLD_UP);
    this.frameUp.copy(WORLD_UP);
    if (car) {
      this.pivot.copy(car.pos);
      this.prevCarPos.copy(car.pos);
      // start in the car's surface frame (snapping onto a wall must not start from world up)
      this.surfaceFrameUp(ctx, this.frameUp);
      const fu = this.frameUp;
      const fwd = this.v1.set(0, 0, 1).applyQuaternion(car.quat);
      fwd.addScaledVector(fu, -fwd.dot(fu));
      if (ctx.ballCam && ctx.ball.visible) {
        const tb = this.v2.subVectors(ctx.ball.pos, car.pos);
        tb.addScaledVector(fu, -tb.dot(fu));
        if (tb.lengthSq() > 0.25) fwd.copy(tb);
      }
      if (fwd.lengthSq() > 1e-4) this.chaseDir.copy(fwd).normalize();
      this.lookDir.copy(this.chaseDir);
    }
  }

  /**
   * Target up of the chase frame: world up on the floor and in the air; on steep surfaces the car's up, blended in
   * as the surface tilts from 26° to 60° (no pop at a threshold). Written into `out`.
   */
  private surfaceFrameUp(ctx: CameraContext, out: Vector3): Vector3 {
    const car = ctx.target;
    out.copy(WORLD_UP);
    if (!car || !car.onGround || car.demolished) return out;
    const carUp = this.v5.set(0, 1, 0).applyQuaternion(car.quat);
    const w = 1 - MathUtils.smoothstep(carUp.y, 0.5, 0.9);
    if (w <= 0) return out;
    // (for carUp.y in (0.5, 0.9) carUp is within 60° of world up: the lerp cannot degenerate)
    return out.lerp(carUp, w).normalize();
  }

  private computeTarget(dt: number, ctx: CameraContext, snapping: boolean): void {
    const t = this.target;
    switch (this.mode) {
      case 'car':
        this.chase(dt, ctx, snapping);
        break;
      case 'replay':
        this.replay(ctx);
        break;
      case 'orbit':
        this.orbit(ctx);
        break;
      case 'broadcast':
        this.broadcast(ctx);
        break;
      case 'goal':
        this.goalShot(ctx);
        break;
      case 'endPodium':
        this.podium(ctx);
        break;
      default:
        this.orbit(ctx);
    }
    if (this.mode !== 'car') this.keepInside(t.pos, t.look);
  }

  private chase(dt: number, ctx: CameraContext, snapping: boolean): void {
    const t = this.target;
    const car = ctx.target;
    if (!car) {
      this.orbit(ctx);
      this.keepInside(t.pos, t.look);
      return;
    }
    const st = this.stiffness;
    this.kkDt = snapping ? -1 : dt;
    const kk = this.kk;
    // --- view up: world up, partially following the car's up on walls (not on the ceiling). Only the VIEW rolls
    // this little; the chase offset itself is built in the full surface frame below.
    const carUp = this.v1.set(0, 1, 0).applyQuaternion(car.quat);
    const upT = this.v2.copy(WORLD_UP);
    if (car.onGround && !car.demolished && carUp.y < 0.92) {
      const k = 0.55 * MathUtils.smoothstep(carUp.y, -0.25, 0.25);
      upT.lerp(carUp, k).normalize();
    }
    this.camUp.lerp(upT, kk(4.0)).normalize();
    const up = this.camUp;

    // --- surface frame (smoothed so floor <-> wall transitions and leaving a wall glide instead of popping).
    // A 180° flip (dropping off the ceiling) turns about the heading, i.e. the camera swings round the car's side:
    // turning about any other axis would carry the heading along and swing the camera to the front of the car.
    const fT = this.surfaceFrameUp(ctx, this.v2);
    rotateToward(this.frameUp, fT, kk(6.0), this.v4.crossVectors(this.chaseDir, this.frameUp));
    const fu = this.frameUp;

    // --- heading (in the plane of the surface frame)
    const dirT = this.v3.copy(this.chaseDir);
    if (car.demolished) {
      // hold; look at the ball
    } else if (ctx.ballCam && ctx.ball.visible) {
      const tb = this.v1.subVectors(ctx.ball.pos, car.pos);
      tb.addScaledVector(fu, -tb.dot(fu));
      if (tb.lengthSq() > 0.36) dirT.copy(tb).normalize();
    } else {
      const fwd = this.v1.set(0, 0, 1).applyQuaternion(car.quat);
      if (car.onGround) {
        fwd.addScaledVector(fu, -fwd.dot(fu));
        if (fwd.lengthSq() > 0.04) dirT.copy(fwd).normalize();
      } else {
        const vel = this.v2.copy(car.vel);
        vel.addScaledVector(fu, -vel.dot(fu));
        if (vel.lengthSq() > 16) dirT.copy(vel).normalize();
        else {
          fwd.addScaledVector(fu, -fwd.dot(fu));
          if (fwd.lengthSq() > 0.2) dirT.copy(fwd).normalize();
        }
      }
    }
    const dirRate = ctx.ballCam ? MathUtils.lerp(5, 18, st) : MathUtils.lerp(3.5, 14, st);
    slerpDir(this.chaseDir, dirT, kk(dirRate));
    this.chaseDir.addScaledVector(fu, -this.chaseDir.dot(fu));
    if (this.chaseDir.lengthSq() < 1e-6) {
      // degenerate (heading along the frame up): fall back to the target heading, then to any in-plane direction
      this.chaseDir.copy(dirT).addScaledVector(fu, -dirT.dot(fu));
      if (this.chaseDir.lengthSq() < 1e-6) this.chaseDir.set(0, 0, 1).addScaledVector(fu, -fu.z);
      if (this.chaseDir.lengthSq() < 1e-6) this.chaseDir.set(1, 0, 0);
    }
    this.chaseDir.normalize();

    // --- pivot: slight positional lag conveys speed. Exact first-order lag for a constant-velocity target, so the
    // lag is the same (v / k) at 60 fps, 30 fps or across a hitch (a dt-dependent lerp made the car jerk on screen
    // on every dropped frame). k ≈ 34 at the default stiffness = the previous steady lag at 60 fps.
    if (!car.demolished) {
      if (snapping) this.pivot.copy(car.pos);
      else {
        const k = MathUtils.lerp(20, 50, st);
        const e = Math.exp(-k * dt);
        // offset at the START of the frame (relative to where the car was then; a teleport keeps the offset)
        const off = this.v1.subVectors(this.pivot, this.prevCarPos);
        if (off.lengthSq() > 9) off.setLength(3);
        const vk = this.v2.copy(car.vel).multiplyScalar(1 / k);
        off.add(vk).multiplyScalar(e).sub(vk);
        this.pivot.copy(car.pos).add(off);
      }
      this.prevCarPos.copy(car.pos);
    }

    // --- high ball: back off, drop, and relax the look clamp (the ball can be well above the car on screen)
    const ballLook = (ctx.ballCam || car.demolished) && ctx.ball.visible;
    let hT = 0;
    let farT = 0;
    if (ballLook) {
      const d = this.v1.subVectors(ctx.ball.pos, this.pivot);
      const vUp = d.dot(fu);
      d.addScaledVector(fu, -vUp);
      const lat = d.length();
      hT = MathUtils.smoothstep(vUp / Math.max(1, lat), 0.45, 1.8);
      farT = MathUtils.smoothstep(Math.hypot(vUp, lat), 12, 30);
    }
    this.high += (hT - this.high) * kk(5);
    this.highFar += (hT * farT - this.highFar) * kk(5);
    const h = this.high;

    const speed = car.vel.length();
    const speed01 = Math.min(1, speed / CAR.maxSpeed);
    const stretchT = 0.05 * speed01 + (car.boosting ? 0.04 : 0);
    this.stretch += (stretchT - this.stretch) * kk(3);
    const dist = this.distance * (1 + this.stretch) * (1 + 0.6 * h);
    const height = this.height * (1 - 0.6 * h);
    t.pos.copy(this.pivot).addScaledVector(this.chaseDir, -dist).addScaledVector(fu, height);
    this.clampChase(t.pos, fu, height);

    // --- look
    const carAim = this.v2.copy(this.pivot).addScaledVector(fu, height * 0.72).addScaledVector(this.chaseDir, 4.0);
    const desired = this.v1.subVectors(carAim, t.pos).normalize();
    if (ballLook) desired.subVectors(ctx.ball.pos, t.pos).normalize();
    if (!car.demolished) {
      // keep the car on screen (both cameras): limit the angle between the view and the car direction.
      // 0.25·vfov keeps the whole car in the lower half of the frame; high balls relax it a little (the camera
      // has also backed off and dropped, so the car stays framed while the ball is still in view).
      const toCar = this.v3.copy(this.pivot).addScaledVector(fu, 0.3).sub(t.pos).normalize();
      const vfovR = MathUtils.degToRad(this.camera.fov);
      const base = vfovR * (0.25 + 0.1 * h);
      const ang = Math.acos(MathUtils.clamp(desired.dot(toCar), -1, 1));
      // A FAR ball high in the surface frame (typically out across the pitch from a car on a wall) may get up to
      // 0.12·vfov more — the car is small then and can sit lower — but only when that actually brings the ball into
      // view (checked by projecting it into the relaxed view); when nothing can (wall-ceiling junction), keep the car
      // nicely framed instead.
      let relaxT = 0;
      if (ballLook && ang > base && this.highFar > 0.01) {
        const cap = base + vfovR * 0.12 * this.highFar;
        if (cap < ang && this.ballFitsView(toCar, desired, ang, cap, up, vfovR)) relaxT = cap - base;
      }
      this.relax += (relaxT - this.relax) * kk(4);
      const maxA = base + this.relax;
      if (ang > maxA) {
        const target = this.v2.copy(desired);
        slerpDir(desired.copy(toCar), target, maxA / ang);
      }
    }
    // ball cam: bias slightly above the ball-car line so the car sits low in frame
    if (ballLook) desired.addScaledVector(up, 0.05).normalize();
    slerpDir(this.lookDir, desired, kk(MathUtils.lerp(8, 24, st)));
    t.look.copy(t.pos).addScaledVector(this.lookDir, 10);
    t.up.copy(up);

    // --- FOV kick
    const kickT = (car.boosting ? 7 : 0) + (car.supersonic ? 4 : 0);
    this.fovKick += (kickT - this.fovKick) * kk(car.boosting ? 3.5 : 2.2);
    t.hfov = this.fov + this.fovKick;
  }

  /**
   * Would the ball (unit direction `ballDir` from the camera, `ang` away from `toCar`) be on screen if the look were
   * clamped `maxA` from the car direction? Projects it into that view (same basis as Matrix4.lookAt with `up`).
   */
  private ballFitsView(toCar: Vector3, ballDir: Vector3, ang: number, maxA: number, up: Vector3, vfovR: number): boolean {
    const look = slerpDir(this.v4.copy(toCar), ballDir, maxA / ang);
    const x = this.v5.crossVectors(up, look).normalize(); // ± screen right (lookAt: x = up × z with z = -look)
    const f = ballDir.dot(look);
    if (f <= 0.05 || x.lengthSq() < 1e-8) return false;
    const bx = ballDir.dot(x) / f;
    const by = (ballDir.dot(up) - ballDir.dot(look) * look.dot(up)) / f / Math.max(1e-4, Math.sqrt(Math.max(0, 1 - look.dot(up) ** 2)));
    const tv = Math.tan(vfovR * 0.5);
    return Math.abs(by) / tv <= 0.92 && Math.abs(bx) / (tv * this.camera.aspect) <= 0.95;
  }

  /**
   * Chase-cam clearance: keep `p` inside the arena with MIN_CLEARANCE without collapsing onto the car.
   *  1. slide the point out along the SDF gradient: the camera rides along the wall / ceiling / fillet and keeps
   *     its boom length (accepted while it stays >= CHASE_SLIDE_MIN_DIST from the car with a clear line of sight);
   *  2. else pull it in toward an anchor above the car (in the surface frame), never closer than CHASE_MIN_DIST;
   *  3. else (the anchor itself is tight: car wedged in a crease) push it out along the frame up.
   */
  private clampChase(p: Vector3, fu: Vector3, height: number): void {
    if (arenaSDF(p.x, p.y, p.z) >= MIN_CLEARANCE) return;
    const pivot = this.pivot;
    // 1) slide along the surface
    const s = this.v4.copy(p);
    const n = this.v5;
    for (let i = 0; i < 4; i++) {
      const d = arenaSDF(s.x, s.y, s.z);
      if (d >= MIN_CLEARANCE) break;
      arenaNormal(s.x, s.y, s.z, n);
      s.addScaledVector(n, MIN_CLEARANCE - d + 0.02);
    }
    if (arenaSDF(s.x, s.y, s.z) >= MIN_CLEARANCE - 0.05 && s.distanceTo(pivot) >= CHASE_SLIDE_MIN_DIST && clearPath(s, pivot)) {
      p.copy(s);
      return;
    }
    // 2) pull in toward an anchor above the car
    const anchor = this.v4.copy(pivot).addScaledVector(fu, height + 0.45);
    if (arenaSDF(anchor.x, anchor.y, anchor.z) < MIN_CLEARANCE + 0.2) anchor.copy(pivot).addScaledVector(fu, 0.35);
    if (arenaSDF(anchor.x, anchor.y, anchor.z) >= MIN_CLEARANCE) {
      pullInside(p, anchor);
      if (p.distanceTo(pivot) >= CHASE_MIN_DIST) return;
    }
    // 3) push out along the frame up: the first point with some clearance, at least CHASE_MIN_DIST from the car
    let best = -1;
    let bestD = -Infinity;
    for (let i = 0; i <= 8; i++) {
      const k = CHASE_MIN_DIST + i * 0.25;
      const d = arenaSDF(pivot.x + fu.x * k, pivot.y + fu.y * k, pivot.z + fu.z * k);
      if (d >= 0.3) {
        best = k;
        break;
      }
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    p.copy(pivot).addScaledVector(fu, best);
  }

  private replay(ctx: CameraContext): void {
    const t = this.target;
    const ball = ctx.ball.pos;
    const goal = this.v1;
    if (ctx.focus) goal.set(ctx.focus.x, ctx.focus.y, ctx.focus.z);
    else if (ctx.team === 0 || ctx.team === 1) targetGoalCenter(ctx.team, goal);
    else goal.set(0, ARENA.goalHeight * 0.5, (ctx.ball.vel.z >= 0 ? 1 : -1) * ARENA.halfLength);
    const toGoal = this.v2.subVectors(goal, ball);
    toGoal.y = 0;
    const d = toGoal.length();
    if (d > 1e-3) toGoal.multiplyScalar(1 / d);
    else toGoal.set(0, 0, 1);
    const side = this.v3.set(-toGoal.z, 0, toGoal.x);
    // choose the side of the ball closer to the arena center so the camera stays inside
    if (side.dot(ball) > 0) side.negate();
    const near = MathUtils.clamp((32 - d) / 26, 0, 1);
    const back = MathUtils.lerp(13, 9, near);
    const lateral = MathUtils.lerp(5, 9, near);
    t.pos.copy(ball).addScaledVector(toGoal, -back).addScaledVector(side, lateral);
    t.pos.y = MathUtils.clamp(2.2 + ball.y * 0.35, 1.4, ARENA.height - 2);
    const lookBall = MathUtils.lerp(0.78, 0.55, near);
    t.look.copy(ball).multiplyScalar(lookBall).addScaledVector(goal, 1 - lookBall);
    if (ctx.target && !ctx.target.demolished && ctx.target.pos.distanceTo(ball) < 18 && near < 0.5) {
      t.look.lerp(ctx.target.pos, 0.25);
    }
    t.up.copy(WORLD_UP);
    t.hfov = Math.min(this.fov, 92) - 8 * near;
  }

  private orbit(ctx: CameraContext): void {
    const t = this.target;
    const th = ctx.time * 0.045 + 0.6;
    const visible = ctx.ball.visible;
    const b = visible ? ctx.ball.pos : this.v1.set(0, 2, 0);
    // slow high orbit around a centre biased toward the ball: the camera stays on the ball's side of the pitch
    const cx = b.x * 0.45;
    const cz = b.z * 0.45;
    t.pos.set(cx + Math.cos(th) * 21, 13.5 + 2.5 * Math.sin(th * 1.7), cz + Math.sin(th) * 30);
    // aim at the ball with a small lead (compensates the look smoothing, keeps the ball near the frame centre)
    const lead = this.v2.copy(visible ? ctx.ball.vel : ZERO).multiplyScalar(0.3);
    if (lead.lengthSq() > 64) lead.setLength(8);
    t.look.copy(b).add(lead);
    t.look.y = Math.max(0.8, t.look.y);
    t.up.copy(WORLD_UP);
    t.hfov = 88;
  }

  private broadcast(ctx: CameraContext): void {
    const t = this.target;
    const b = ctx.ball.visible ? ctx.ball.pos : this.v1.set(0, 1, 0);
    t.pos.set(-(ARENA.halfWidth - 2.5), 16.5, MathUtils.clamp(b.z * 0.72, -30, 30));
    t.look.set(b.x * 0.35 + 4, Math.max(1, b.y * 0.6), b.z * 0.92);
    t.up.copy(WORLD_UP);
    t.hfov = 74;
  }

  private goalShot(ctx: CameraContext): void {
    const t = this.target;
    const f = this.v1;
    if (ctx.focus) f.set(ctx.focus.x, ctx.focus.y, ctx.focus.z);
    else f.copy(ctx.ball.pos);
    const sign = f.z >= 0 ? 1 : -1; // which end
    const fieldDir = this.v2.set(0, 0, -sign);
    const side = this.v3.set(f.x >= 0 ? -1 : 1, 0, 0);
    const k = 1 - Math.exp(-this.modeTime / 1.6);
    // start wide enough that the goal explosion reads as a burst, not a white-out, then push in
    const d = 26 - 10 * k;
    t.pos.copy(f).addScaledVector(fieldDir, d).addScaledVector(side, 6 - 2.5 * k);
    t.pos.y = 3.4 + 0.4 * Math.sin(this.modeTime * 0.6);
    t.look.copy(f);
    t.look.y = Math.max(1.5, f.y);
    t.up.copy(WORLD_UP);
    t.hfov = Math.max(55, this.fov - 22);
  }

  private podium(ctx: CameraContext): void {
    const t = this.target;
    const f = this.v1;
    if (ctx.focus) f.set(ctx.focus.x, ctx.focus.y, ctx.focus.z);
    else f.set(0, 0.5, 0);
    // Swing (±70°) around the focus on the side facing the arena centre — a full orbit near a wall put half of
    // the circle outside the arena, and the clamp then dragged the camera away (MVP tiny over a black wall).
    const toC = this.v2.set(-f.x, 0, -f.z);
    const base = toC.lengthSq() > 1 ? Math.atan2(toC.z, toC.x) : -Math.PI / 2;
    if (toC.lengthSq() > 1e-6) toC.normalize();
    else toC.set(0, 0, -1);
    const a = base + MathUtils.degToRad(70) * Math.sin(ctx.time * 0.2);
    const R = 9.5;
    t.pos.set(f.x + Math.cos(a) * R, f.y + 2.6 + 0.4 * Math.sin(ctx.time * 0.3), f.z + Math.sin(a) * R);
    // wall clearance: slide toward the arena centre by the clearance deficit (continuous, no pops)
    for (let i = 0; i < 4; i++) {
      const d = arenaSDF(t.pos.x, t.pos.y, t.pos.z);
      if (d >= 1.5) break;
      t.pos.addScaledVector(toC, 1.5 - d + 0.05);
    }
    t.look.set(f.x, f.y + 1.1, f.z);
    t.up.copy(WORLD_UP);
    t.hfov = 70;
  }

  private keepInside(p: Vector3, look: Vector3): void {
    if (arenaSDF(p.x, p.y, p.z) >= MIN_CLEARANCE) return;
    // pull toward the arena center line (always deep inside)
    const anchor = this.v3.set(0, ARENA.height * 0.45, MathUtils.clamp(p.z, -ARENA.halfLength + 8, ARENA.halfLength - 8));
    if (look) {
      // prefer an anchor toward what we look at when it is inside
      if (arenaSDF(look.x, look.y, look.z) > 2) anchor.lerp(look, 0.3);
    }
    pullInside(p, anchor);
  }

  private apply(dt: number): void {
    const cam = this.camera;
    const p = this.pose;
    // orientation from pose
    this.m1.lookAt(p.pos, p.look, p.up);
    this.q1.setFromRotationMatrix(this.m1);
    let pos = p.pos;
    let fovDeg = gameplayVerticalFov(p.hfov, cam.aspect);
    if (this.blendT < 1) {
      const e = this.blendT * this.blendT * (3 - 2 * this.blendT);
      pos = this.v1.copy(this.fromPos).lerp(p.pos, e);
      this.q1.slerpQuaternions(this.fromQuat, this.q1, e);
      fovDeg = MathUtils.lerp(this.fromFov, fovDeg, e);
    }
    cam.position.copy(pos);
    cam.quaternion.copy(this.q1);
    // shake
    if (this.trauma > 0 && this.shakeScale > 0) {
      this.shakeT += dt;
      const amp = this.trauma * this.trauma * this.shakeScale;
      const s = this.shakeT * 22;
      const yaw = 0.05 * amp * noise1(s, 1.3);
      const pitch = 0.04 * amp * noise1(s, 7.1);
      const roll = 0.035 * amp * noise1(s, 13.7);
      this.q2.setFromAxisAngle(this.v2.set(0, 1, 0), yaw);
      cam.quaternion.multiply(this.q2);
      this.q2.setFromAxisAngle(this.v2.set(1, 0, 0), pitch);
      cam.quaternion.multiply(this.q2);
      this.q2.setFromAxisAngle(this.v2.set(0, 0, 1), roll);
      cam.quaternion.multiply(this.q2);
      this.v2.set(noise1(s, 21.1), noise1(s, 33.3), noise1(s, 47.9)).multiplyScalar(0.12 * amp).applyQuaternion(cam.quaternion);
      cam.position.add(this.v2);
      this.trauma = Math.max(0, this.trauma - dt * 1.25);
    }
    if (Math.abs(cam.fov - fovDeg) > 1e-4) {
      cam.fov = fovDeg;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  /** Current mode (debug). */
  get currentMode(): CameraMode | null {
    return this.mode;
  }
}

/**
 * Keep `p` inside the arena with clearance by pulling it toward `anchor` (a point known to be inside):
 * binary search along anchor -> p for the farthest point with MIN_CLEARANCE.
 */
function pullInside(p: Vector3, anchor: Vector3): void {
  if (arenaSDF(p.x, p.y, p.z) >= MIN_CLEARANCE) return;
  const a = anchor;
  const dx = p.x - a.x;
  const dy = p.y - a.y;
  const dz = p.z - a.z;
  if (arenaSDF(a.x, a.y, a.z) < MIN_CLEARANCE) {
    // anchor itself is tight: meet halfway (callers that care about the car distance handle this case themselves)
    p.set(a.x + dx * 0.5, a.y + dy * 0.5, a.z + dz * 0.5);
    return;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) * 0.5;
    if (arenaSDF(a.x + dx * m, a.y + dy * m, a.z + dz * m) >= MIN_CLEARANCE) lo = m;
    else hi = m;
  }
  p.set(a.x + dx * lo, a.y + dy * lo, a.z + dz * lo);
}

/** True when the segment a -> b stays in free space (the main volume is convex; this guards the goal pockets). */
function clearPath(a: Vector3, b: Vector3): boolean {
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    if (arenaSDF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t) < 0.05) return false;
  }
  return true;
}

/** Rotate unit vector `a` toward unit vector `b` by fraction t (spherical, in place). */
function slerpDir(a: Vector3, b: Vector3, t: number): Vector3 {
  const d = MathUtils.clamp(a.dot(b), -1, 1);
  if (d > 0.99999) return a.copy(b);
  const ang = Math.acos(d);
  if (ang < 1e-5) return a.copy(b);
  const s = Math.sin(ang);
  if (s < 1e-4) {
    // opposite: nudge through a perpendicular
    return a.lerp(b, t).normalize();
  }
  const wa = Math.sin((1 - t) * ang) / s;
  const wb = Math.sin(t * ang) / s;
  const x = a.x * wa + b.x * wb;
  const y = a.y * wa + b.y * wb;
  const z = a.z * wa + b.z * wb;
  return a.set(x, y, z).normalize();
}

/**
 * slerpDir that also handles (near-)antipodal vectors (car dropping off the ceiling: frame up flips from -Y to +Y):
 * the rotation is then nudged through `hint` (a unit vector perpendicular to `a`).
 */
function rotateToward(a: Vector3, b: Vector3, t: number, hint: Vector3): Vector3 {
  if (t >= 1) return a.copy(b);
  if (a.dot(b) < -0.995) {
    a.addScaledVector(hint, 0.2).addScaledVector(b, 0.05);
    if (a.lengthSq() < 1e-8) a.copy(b);
    a.normalize();
  }
  return slerpDir(a, b, t);
}

/** Smooth pseudo-noise in [-1, 1] (sum of incommensurate sines). */
function noise1(x: number, seed: number): number {
  return (
    Math.sin(x * 1.0 + seed) * 0.5 +
    Math.sin(x * 2.137 + seed * 1.7) * 0.3 +
    Math.sin(x * 4.591 + seed * 2.3) * 0.2
  );
}
