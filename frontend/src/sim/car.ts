/**
 * NOVABALL — hover-car physics (deterministic).
 *
 * Frames: car local +Z forward, +Y up, +X LEFT (right = forward × up = −X).
 *
 * Ground ("hover") model — single SDF probe at the car center:
 *   grounded ⇔ arenaSDF(pos) < rideHeight + hoverReach  ∧  up·n > 0.5  ∧  no jump lock-out.
 *   Along n: hover spring (only pushes while compressed) + damping (while compressed) + mag-grip pull −n·stickyAccel,
 *   plus full gravity — glued to floors & walls, but on the ceiling gravity beats the grip and the car drops off.
 *   Orientation follows the surface directly (curvature transport + fast lerp of up → n), yaw rate is SET from steering.
 *   Tangent plane: throttle / brake / coast / boost along the surface-projected forward, lateral grip on the side slip.
 * Air: gravity, jump hold, double jump, dodge (flip program), air control torques, free air roll, boost, air throttle,
 *   turtle self-right (see TURTLE_* / SELF_RIGHT_*).
 * Body: 26 OBB sample points (corners, edge midpoints, face centers) vs the arena SDF → push-out + rigid-body impulse.
 */
import { Quaternion, Vector3 } from 'three';
import { arenaNormal, arenaSDF } from './arena';
import { CAR, GRAVITY } from './constants';
import type { CarState, CarStyleId, ControlState, SimEvent, Team } from './types';
import { copyControlState, makeControlState, makePlayerStats } from './types';
import { clamp1, curve, integrateQuat, quatForward, quatLeft, quatUp, towardZero, TWO_PI } from './vmath';

// ---------------------------------------------------------------------------------------------
// Internal tuning (feel details that are not part of the shared constants contract)
// ---------------------------------------------------------------------------------------------

/** Per-tick fraction of the up→normal alignment while grounded (≈ 0.35 at 120 Hz: crisp, no visible lag). */
export const ALIGN_RATE = 0.35;
/** Softer alignment for the first LAND_SOFT_TIME seconds after landing. */
export const ALIGN_RATE_LANDING = 0.15;
export const LAND_SOFT_TIME = 0.1;
/**
 * Curvature transport is limited to this much rotation per tick (sin of the angle ≈ 4.6°): smooth fillets never
 * need more (≤ 3.5°/tick at max speed), while SDF creases (e.g. the ridge where the end-wall fillet meets the goal
 * box's front fillet) are absorbed by the alignment lerp instead of snapping the car.
 */
export const TRANSPORT_MAX_SIN = 0.08;
/**
 * Hover damping also acts on SEPARATING motion while uncompressed but in reach, on surfaces facing up/sideways
 * (n.y above this): cars stay planted over crests and don't bounce off landings. Ceilings (n.y below) are exempt
 * so gravity still peels cars off them.
 */
export const SEPARATION_DAMP_MIN_NY = -0.2;
/** Yaw-rate multiplier while powersliding (the tail steps out). */
export const POWERSLIDE_YAW_BOOST = 1.6;
/**
 * While powersliding the yaw rate follows the PLANAR speed vp, not just its forward part vF (which collapses as the
 * car slides sideways, so the drift used to stall and a drift U-turn was slower than a normal one):
 * vYaw = clamp(vp + POWERSLIDE_REVERSE_GAIN·vF, −vp, vp) — the forward steering convention through the drift, blending
 * continuously into the reverse convention once the car clearly moves backwards (fully reversed at vF ≤ −2·vp / GAIN).
 * Continuous on purpose: a hard switch on the sign of vF makes the yaw chatter when the slip hovers around 90°.
 */
export const POWERSLIDE_REVERSE_GAIN = 4;
/** Flip program: constant rotation rate, then an exponential ease-out onto exactly one full turn. */
export const FLIP_RATE = 7.4; // rad/s
export const FLIP_EASE = 13; // 1/s
/**
 * Flip cancel (half-flip): holding pitch AGAINST a front/back flip within FLIP_CANCEL_WINDOW seconds stops the
 * flip program and keeps only FLIP_CANCEL_KEEP of its rotation; air control returns immediately.
 */
export const FLIP_CANCEL_WINDOW = 0.45;
export const FLIP_CANCEL_KEEP = 0.15;
/** Fraction of downward velocity kept when a dodge starts (snappy flips). */
export const DODGE_VY_KEEP = 0.25;
/** Side dodges gain up to +35 % impulse at max speed; back dodges are a bit stronger. */
export const SIDE_DODGE_SPEED_BONUS = 0.35;
export const BACK_DODGE_SCALE = 1.1;
/**
 * Turtle / self-right. A car is TURTLED while it lies on its roof / side / nose against a floor, ramp or wall: surface
 * within reach, up·n < TURTLE_UP_DOT, body touched the arena within TURTLE_CONTACT_TIME — at ANY speed (a car sliding
 * on its roof must be able to recover). Ceilings (n.y ≤ TURTLE_MIN_NY) never count: gravity peels cars off them.
 * A jump press while turtled (always consumed: never a 2nd jump into the surface), or TURTLE_AUTO_TIME spent
 * upside-down near the surface (the count survives small bounces), starts the SELF-RIGHT: a hop off the surface
 * (CAR.selfRightImpulse × √(gravity scale), so surge hops stay short) plus a scripted roll-over whose rate ramps up at
 * SELF_RIGHT_ACCEL (an instant full-rate spin would lever the car's edge into the floor and pole-vault it up) to at most
 * SELF_RIGHT_MAX_RATE. The program owns the rotation until the car is back on its wheels (or SELF_RIGHT_TIME passed),
 * so a held air-roll / pitch input can't tip it over again, and the hop uses up the air jump (mashing jump does nothing
 * until touchdown).
 */
export const TURTLE_UP_DOT = 0.5;
export const TURTLE_CONTACT_TIME = 0.3;
export const TURTLE_MIN_NY = -0.5;
export const TURTLE_AUTO_TIME = 0.8;
/** Max duration of the self-right program (it normally ends at touchdown, ~0.5 s after the hop). */
export const SELF_RIGHT_TIME = 2;
export const SELF_RIGHT_ACCEL = 25; // rad/s²
export const SELF_RIGHT_MAX_RATE = 6.5; // rad/s
export const SELF_RIGHT_GAIN = 9; // 1/s
/** Body–arena contact. */
export const BODY_RESTITUTION = 0.2;
export const BODY_FRICTION = 0.5;
/** Impacts slower than this (normal speed) are resolved with zero restitution (resting contact). */
export const BODY_REST_SPEED = 2;
/** Emit 'carImpact' for arena hits at least this hard (normal speed, m/s). */
export const CAR_IMPACT_EVENT_SPEED = 5;
/** Inertia multiplier over a solid box (a bit heavier ⇒ less twitchy tumbling). */
export const INERTIA_SCALE = 1.5;
/** Minimum air time before touching down emits 'land'. */
export const LAND_EVENT_MIN_AIRTIME = 0.12;
/**
 * Slope grip: lateral grip = base × (rest + (1 − rest)·min(1, |vF| / WALL_GRIP_SPEED)), where the at-rest factor
 * `rest` falls from 1 on slopes gentler than WALL_GRIP_NY_FULL (n.y) to WALL_GRIP_MIN at WALL_GRIP_NY_ZERO and beyond.
 * Rolling cars keep full grip everywhere (crisp wall driving); a car that crawls/stops on a wall or steep ramp
 * slides down instead of parking there.
 */
export const WALL_GRIP_NY_FULL = 1.0;
export const WALL_GRIP_NY_ZERO = 0.75;
export const WALL_GRIP_SPEED = 6;
export const WALL_GRIP_MIN = 0.03;

const HX = CAR.halfExtents.x;
const HY = CAR.halfExtents.y;
const HZ = CAR.halfExtents.z;
/** Box inertia in the car's local frame (x = left, y = up, z = forward). */
const INV_I_X = 1 / ((INERTIA_SCALE * CAR.mass * (4 * HY * HY + 4 * HZ * HZ)) / 12);
const INV_I_Y = 1 / ((INERTIA_SCALE * CAR.mass * (4 * HX * HX + 4 * HZ * HZ)) / 12);
const INV_I_Z = 1 / ((INERTIA_SCALE * CAR.mass * (4 * HX * HX + 4 * HY * HY)) / 12);
const INV_MASS = 1 / CAR.mass;
/** Bounding-sphere radius of the hitbox (SDF is 1-Lipschitz ⇒ skip body tests beyond this). */
export const CAR_BOUND_RADIUS = Math.sqrt(HX * HX + HY * HY + HZ * HZ);

/** Body sample points in local space: 8 corners + 12 edge midpoints + 6 face centers. */
const SAMPLES: Float64Array = (() => {
  const out: number[] = [];
  for (let sx = -1; sx <= 1; sx++)
    for (let sy = -1; sy <= 1; sy++)
      for (let sz = -1; sz <= 1; sz++) {
        if (sx === 0 && sy === 0 && sz === 0) continue;
        out.push(sx * HX, sy * HY, sz * HZ);
      }
  return new Float64Array(out);
})();
const NUM_SAMPLES = SAMPLES.length / 3;
const _sd = new Float64Array(NUM_SAMPLES);
const _sp = new Float64Array(NUM_SAMPLES * 3);

// ---------------------------------------------------------------------------------------------
// Car state
// ---------------------------------------------------------------------------------------------

/** CarState + internal bookkeeping (all of it is part of World.hash()). */
export interface SimCar extends CarState {
  /** Cached world axes of `quat` (refreshed after every orientation change). Read-only outside the sim. */
  readonly fwd: Vector3;
  readonly up: Vector3;
  /** Local +X in world space (the car's LEFT; right = −left). */
  readonly left: Vector3;
  prevJump: boolean;
  prevPulse: boolean;
  /** Seconds since the first (ground) jump / self-right hop. */
  jumpTimer: number;
  /** First-jump hold force still active (jump held since the press, < jumpHoldTime). */
  jumpHolding: boolean;
  /** Hover disabled after a jump until jumpMinTime passed AND the car moves back toward the surface. */
  jumpLock: boolean;
  /** Seconds since the first jump or since leaving the ground without jumping (2nd-jump window). */
  airJumpTimer: number;
  /** Seconds since the dodge started. */
  dodgeTimer: number;
  /** Flip program active (can outlast the input lock-out `isDodging`). */
  flipActive: boolean;
  /** Flip axis in local terms: rotation = flipF about +left (nose down) + flipR about +forward (roll right). */
  flipF: number;
  flipR: number;
  /** Radians rotated by the flip program so far (target: one full turn). */
  flipAngle: number;
  /** Seconds since touching down (while grounded). */
  landTimer: number;
  /** Touched down, 'land' not emitted yet (emitted when the hover actually compresses). */
  landPending: boolean;
  /** Surface normal of the previous grounded tick (curvature transport). */
  readonly prevNormal: Vector3;
  /** Seconds spent upside-down near a surface (auto self-right at TURTLE_AUTO_TIME). */
  turtleTimer: number;
  /** > 0 while the self-right program rotates the car upright. */
  selfRightTimer: number;
  readonly selfRightTarget: Vector3;
  /** Seconds since the body last touched the arena. */
  bodyContactTimer: number;
  /** Touching the ball (with a small hysteresis margin) — for contact-start detection. */
  ballContact: boolean;
  /** Sim time of this car's last strike-assist impulse. */
  lastExtraHitTime: number;
  /** Sim time of this car's last ball touch (assists, goal credit). */
  lastTouchTime: number;
  /** Sim time of the last touch counted in stats. */
  lastStatTouchTime: number;
  lastImpactEventTime: number;
  /** Sim time of this car's last registered 'shot'. */
  lastShotTime: number;
  /** Sim time of this car's last contact start / pulse hit on the ball. */
  lastHitTime: number;
  /** Touch index (per kickoff) of this car's last touch — goal/assist credit ordering. */
  lastTouchSeq: number;
}

export function createCar(id: number, team: Team, name: string, isBot: boolean, style: CarStyleId): SimCar {
  const car: SimCar = {
    id,
    team,
    name,
    isBot,
    style,
    pos: new Vector3(0, CAR.rideHeight, 0),
    vel: new Vector3(),
    quat: new Quaternion(),
    angVel: new Vector3(),
    boost: CAR.boostStart,
    onGround: true,
    groundNormal: new Vector3(0, 1, 0),
    airTime: 0,
    hasJumped: false,
    hasDoubleJumped: false,
    hasDodged: false,
    isDodging: false,
    isBoosting: false,
    isPowersliding: false,
    supersonic: false,
    demolished: false,
    respawnTimer: 0,
    pulseCooldown: 0,
    lastControls: makeControlState(),
    stats: makePlayerStats(),
    fwd: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    left: new Vector3(1, 0, 0),
    prevJump: false,
    prevPulse: false,
    jumpTimer: 0,
    jumpHolding: false,
    jumpLock: false,
    airJumpTimer: 0,
    dodgeTimer: 0,
    flipActive: false,
    flipF: 0,
    flipR: 0,
    flipAngle: 0,
    landTimer: 1,
    landPending: false,
    prevNormal: new Vector3(0, 1, 0),
    turtleTimer: 0,
    selfRightTimer: 0,
    selfRightTarget: new Vector3(0, 1, 0),
    bodyContactTimer: 10,
    ballContact: false,
    lastExtraHitTime: -1e9,
    lastTouchTime: -1e9,
    lastStatTouchTime: -1e9,
    lastImpactEventTime: -1e9,
    lastShotTime: -1e9,
    lastHitTime: -1e9,
    lastTouchSeq: -1,
  };
  return car;
}

/** Refresh the cached axes from the quaternion. */
export function updateAxes(car: SimCar): void {
  quatForward(car.quat, car.fwd);
  quatUp(car.quat, car.up);
  quatLeft(car.quat, car.left);
}

/**
 * Teleport a car onto the floor at (x, z) facing `quat`, at rest, grounded, with all transient
 * state cleared (kickoffs, respawns, free-play reset). Stats and pulse cooldown are kept.
 */
export function resetCarKinematics(car: SimCar, x: number, z: number, quat: Quaternion, boost: number): void {
  car.pos.set(x, CAR.rideHeight, z);
  car.vel.set(0, 0, 0);
  car.angVel.set(0, 0, 0);
  car.quat.copy(quat);
  updateAxes(car);
  car.boost = boost;
  car.onGround = true;
  car.groundNormal.set(0, 1, 0);
  car.prevNormal.set(0, 1, 0);
  car.airTime = 0;
  car.hasJumped = false;
  car.hasDoubleJumped = false;
  car.hasDodged = false;
  car.isDodging = false;
  car.isBoosting = false;
  car.isPowersliding = false;
  car.supersonic = false;
  car.demolished = false;
  car.respawnTimer = 0;
  car.jumpTimer = 0;
  car.jumpHolding = false;
  car.jumpLock = false;
  car.airJumpTimer = 0;
  car.dodgeTimer = 0;
  car.flipActive = false;
  car.flipF = 0;
  car.flipR = 0;
  car.flipAngle = 0;
  car.landTimer = 1;
  car.landPending = false;
  car.turtleTimer = 0;
  car.selfRightTimer = 0;
  car.selfRightTarget.set(0, 1, 0);
  car.bodyContactTimer = 10;
  car.ballContact = false;
}

/**
 * External upward shove (bump, pulse): disengage the hover until the car falls back, so the pop is visible
 * instead of being absorbed by the hover damping. The car keeps its air jump (it left without jumping).
 */
export function popCar(car: SimCar): void {
  if (car.hasJumped) return; // mid-jump: already airborne, jump timers in use
  car.jumpLock = true;
  car.jumpTimer = 0;
}

/** True if the car could still double-jump / dodge right now (airborne, within the window, unused). */
export function carCanAirJump(car: CarState & { airJumpTimer: number }): boolean {
  return !car.onGround && !car.demolished && !car.hasDoubleJumped && !car.hasDodged && car.airJumpTimer <= CAR.doubleJumpWindow;
}

// ---------------------------------------------------------------------------------------------
// Scratch (module-level, reused every tick — no per-step allocation)
// ---------------------------------------------------------------------------------------------
const _n = new Vector3();
const _fT = new Vector3();
const _rT = new Vector3();
const _newUp = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3();
const _r = new Vector3();
const _t = new Vector3();
const _t2 = new Vector3();
const _cn = new Vector3();

/** out = I⁻¹·v in world space for a car with cached axes. */
export function applyInvInertia(car: SimCar, v: Vector3, out: Vector3): Vector3 {
  const L = car.left;
  const U = car.up;
  const F = car.fwd;
  const lx = (v.x * L.x + v.y * L.y + v.z * L.z) * INV_I_X;
  const ly = (v.x * U.x + v.y * U.y + v.z * U.z) * INV_I_Y;
  const lz = (v.x * F.x + v.y * F.y + v.z * F.z) * INV_I_Z;
  return out.set(L.x * lx + U.x * ly + F.x * lz, L.y * lx + U.y * ly + F.y * lz, L.z * lx + U.z * ly + F.z * lz);
}

/** Effective inverse mass of the car at offset r along direction d: 1/m + d·((I⁻¹(r×d))×r). */
export function carInvMassAt(car: SimCar, r: Vector3, d: Vector3): number {
  _t.crossVectors(r, d);
  applyInvInertia(car, _t, _t2);
  // d·(I⁻¹(r×d) × r) = (r×d)·I⁻¹(r×d)
  return INV_MASS + _t.dot(_t2);
}

/**
 * Apply an impulse `j` (N·s, world) at offset r from the car center: v += j/m, ω += I⁻¹(r × j).
 */
export function applyCarImpulse(car: SimCar, r: Vector3, jx: number, jy: number, jz: number): void {
  car.vel.x += jx * INV_MASS;
  car.vel.y += jy * INV_MASS;
  car.vel.z += jz * INV_MASS;
  _t.set(r.y * jz - r.z * jy, r.z * jx - r.x * jz, r.x * jy - r.y * jx);
  applyInvInertia(car, _t, _t2);
  car.angVel.add(_t2);
}

// ---------------------------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------------------------

/**
 * Advance one car by dt. `gravity` is the downward acceleration (GRAVITY × carGravityScaleFor(surge ball scale)).
 * Pushes jump / dodge / land / carImpact events.
 */
export function stepCar(car: SimCar, c: ControlState, dt: number, gravity: number, time: number, events: SimEvent[]): void {
  const vel = car.vel;
  const pos = car.pos;

  // ---- controls
  copyControlState(c, car.lastControls);
  const jumpPressed = c.jump && !car.prevJump;
  car.prevJump = c.jump;
  if (!c.jump) car.jumpHolding = false;
  const boostHeld = c.boost;
  const boosting = boostHeld && car.boost > 0;

  // ---- timers
  if (car.hasJumped || car.jumpLock) car.jumpTimer += dt;
  car.bodyContactTimer += dt;

  // ---- surface probe
  const reach = CAR.rideHeight + CAR.hoverReach;
  const d = arenaSDF(pos.x, pos.y, pos.z);
  const near = d < reach + 0.15;
  if (near) arenaNormal(pos.x, pos.y, pos.z, _n);
  else _n.set(0, 1, 0);
  updateAxes(car);
  if (car.jumpLock && car.jumpTimer >= CAR.jumpMinTime && vel.dot(_n) <= 0) car.jumpLock = false;
  let grounded = d < reach && car.up.dot(_n) > 0.5 && !car.jumpLock;
  const wasGrounded = car.onGround;
  let jumpUsed = false;

  // ---- first jump (from any surface, along the car's up)
  if (grounded && jumpPressed) {
    vel.addScaledVector(car.up, CAR.jumpImpulse);
    car.hasJumped = true;
    car.hasDoubleJumped = false;
    car.hasDodged = false;
    car.jumpTimer = 0;
    car.jumpHolding = true;
    car.jumpLock = true;
    car.airJumpTimer = 0;
    grounded = false;
    jumpUsed = true;
    events.push({ type: 'jump', carId: car.id, double: false });
  }

  if (grounded) {
    groundStep(car, c, dt, gravity, d, wasGrounded, boosting, events);
  } else {
    airStep(car, c, dt, gravity, near, wasGrounded, jumpPressed && !jumpUsed, boosting, events);
  }

  // ---- speed clamp & supersonic (hysteresis)
  const sp2 = vel.lengthSq();
  if (sp2 > CAR.maxSpeed * CAR.maxSpeed) vel.multiplyScalar(CAR.maxSpeed / Math.sqrt(sp2));
  const sp = Math.sqrt(vel.lengthSq());
  car.supersonic = sp >= CAR.supersonicSpeed || (car.supersonic && sp >= CAR.supersonicHoldSpeed);

  // ---- boost tank
  car.isBoosting = boosting;
  if (boosting) {
    car.boost -= CAR.boostConsumption * dt;
    if (car.boost < 0) car.boost = 0;
  }

  // ---- integrate
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
  const w = car.angVel;
  integrateQuat(car.quat, w.x, w.y, w.z, dt);
  updateAxes(car);

  // ---- body vs arena
  collideCarArena(car, time, events);

  // ---- ground bookkeeping
  car.onGround = grounded;
  if (grounded) {
    car.groundNormal.copy(_n);
    car.prevNormal.copy(_n);
  } else {
    car.groundNormal.set(0, 1, 0);
  }
  car.isPowersliding = grounded && c.powerslide;
}

function landReset(car: SimCar): void {
  car.hasJumped = false;
  car.hasDoubleJumped = false;
  car.hasDodged = false;
  car.isDodging = false;
  car.flipActive = false;
  car.selfRightTimer = 0;
  car.jumpHolding = false;
  car.jumpTimer = 0;
  car.turtleTimer = 0;
}

function groundStep(
  car: SimCar,
  c: ControlState,
  dt: number,
  gravity: number,
  d: number,
  wasGrounded: boolean,
  boosting: boolean,
  events: SimEvent[],
): void {
  const vel = car.vel;
  const n = _n;
  if (!wasGrounded) {
    car.landPending = car.airTime >= LAND_EVENT_MIN_AIRTIME;
    car.landTimer = 0;
    landReset(car);
  } else {
    car.landTimer += dt;
  }
  if (car.landPending && (d <= CAR.rideHeight || car.landTimer > 0.2)) {
    // emitted at actual touchdown (hover compressing), not when the field first engages
    car.landPending = false;
    const vn = vel.dot(n);
    events.push({ type: 'land', carId: car.id, speed: vn < 0 ? -vn : 0 });
  }
  car.airTime = 0;
  car.airJumpTimer = 0;

  // ---- orientation: transport along the surface curvature (rate-limited), then pull up → n
  if (wasGrounded) {
    const pn = car.prevNormal;
    _newUp.crossVectors(pn, n);
    const sinA = _newUp.length();
    if (sinA > 1e-9) {
      if (sinA <= TRANSPORT_MAX_SIN || pn.dot(n) <= 0) {
        if (pn.dot(n) > 0) _q.setFromUnitVectors(pn, n);
        else _q.set(0, 0, 0, 1); // > 90° in one tick: a discontinuity, leave it to the lerp
      } else {
        // partial transport toward n (≈ TRANSPORT_MAX_SIN worth of rotation)
        _newUp.copy(pn).lerp(n, TRANSPORT_MAX_SIN / sinA).normalize();
        _q.setFromUnitVectors(pn, _newUp);
      }
      car.quat.premultiply(_q);
      updateAxes(car);
    }
  }
  const s = car.landTimer < LAND_SOFT_TIME ? ALIGN_RATE_LANDING : ALIGN_RATE;
  _newUp.copy(car.up).lerp(n, s);
  const nl = _newUp.length();
  if (nl > 1e-6) {
    _newUp.multiplyScalar(1 / nl);
    _q.setFromUnitVectors(car.up, _newUp);
    car.quat.premultiply(_q).normalize();
    updateAxes(car);
  }

  // ---- hover spring / damping / mag-grip + gravity
  const vn = vel.dot(n);
  const comp = CAR.rideHeight - d;
  let an = -CAR.stickyAccel;
  if (comp > 0) an += CAR.hoverStiffness * comp - CAR.hoverDamping * vn;
  else if (vn > 0 && n.y > SEPARATION_DAMP_MIN_NY) an -= CAR.hoverDamping * vn;
  vel.addScaledVector(n, an * dt);
  vel.y -= gravity * dt;

  // ---- tangent frame
  const fn = car.fwd.dot(n);
  _fT.copy(car.fwd).addScaledVector(n, -fn);
  let fl = _fT.length();
  if (fl < 1e-6) {
    // nose straight into / out of the surface (can't happen while aligned) — fall back to −up·…
    _fT.copy(car.up).addScaledVector(n, -car.up.dot(n));
    fl = _fT.length();
    if (fl < 1e-6) return;
  }
  _fT.multiplyScalar(1 / fl);
  _rT.crossVectors(_fT, n); // right = forward × up

  // ---- throttle / brake / coast / boost (along the surface forward)
  let vF = vel.dot(_fT);
  const thr = c.boost ? 1 : clamp1(c.throttle);
  let dvF: number;
  if ((thr > 0.01 && vF < -0.25) || (thr < -0.01 && vF > 0.25)) {
    dvF = towardZero(vF, CAR.brakeAccel * dt) - vF;
  } else if (thr > 0.01 || thr < -0.01) {
    const aspd = vF < 0 ? -vF : vF;
    dvF = thr * curve(CAR.throttleAccelCurve, aspd) * dt;
    if (thr < 0) {
      // reverse: never exceed reverseMaxSpeed
      const room = -CAR.reverseMaxSpeed - vF; // <= 0 while below the limit
      if (dvF < room) dvF = room < 0 ? room : 0;
    }
  } else {
    dvF = towardZero(vF, CAR.coastDecel * dt) - vF;
  }
  if (boosting) dvF += CAR.boostAccel * dt;
  vel.addScaledVector(_fT, dvF);

  // ---- lateral grip (drift while powersliding; weak when crawling on steep surfaces)
  const vR = vel.dot(_rT);
  let grip = c.powerslide ? CAR.powerslideGrip : CAR.lateralGrip;
  if (n.y < WALL_GRIP_NY_FULL) {
    let rest = (n.y - WALL_GRIP_NY_ZERO) / (WALL_GRIP_NY_FULL - WALL_GRIP_NY_ZERO);
    if (rest < WALL_GRIP_MIN) rest = WALL_GRIP_MIN;
    else if (rest > 1) rest = 1;
    const vFa = vF < 0 ? -vF : vF;
    let f = vFa / WALL_GRIP_SPEED;
    if (f > 1) f = 1;
    grip *= rest + (1 - rest) * f;
  }
  grip *= dt;
  vel.addScaledVector(_rT, towardZero(vR, grip) - vR);

  // ---- yaw rate about n, set from steering (reverse steers like a real car); powerslide: from the planar speed
  vF = vel.dot(_fT);
  let vYaw = vF;
  if (c.powerslide) {
    const vS = vel.dot(_rT);
    const vp = Math.sqrt(vF * vF + vS * vS);
    vYaw = vp + POWERSLIDE_REVERSE_GAIN * vF;
    if (vYaw > vp) vYaw = vp;
    else if (vYaw < -vp) vYaw = -vp;
  }
  const aY = vYaw < 0 ? -vYaw : vYaw;
  let yawRate = -clamp1(c.steer) * curve(CAR.steerCurvature, aY) * vYaw;
  if (c.powerslide) yawRate *= POWERSLIDE_YAW_BOOST;
  car.angVel.copy(n).multiplyScalar(yawRate);
}

function airStep(
  car: SimCar,
  c: ControlState,
  dt: number,
  gravity: number,
  near: boolean,
  wasGrounded: boolean,
  jumpPressed: boolean,
  boosting: boolean,
  events: SimEvent[],
): void {
  const vel = car.vel;
  if (wasGrounded) {
    car.airTime = 0;
    if (!car.hasJumped) car.airJumpTimer = 0;
  }
  car.airTime += dt;
  car.airJumpTimer += dt;
  car.landTimer = 0;

  vel.y -= gravity * dt;

  // ---- first-jump hold force
  if (car.jumpHolding) {
    if (car.jumpTimer < CAR.jumpHoldTime) vel.addScaledVector(car.up, CAR.jumpHoldAccel * dt);
    else car.jumpHolding = false;
  }

  // ---- turtle detection / self-right hop (any speed; the press is consumed). The auto timer keeps counting through
  //      small bounces (upside-down near the surface); the hop itself needs recent body contact.
  let consumed = false;
  const upsideNear = near && car.selfRightTimer <= 0 && _n.y > TURTLE_MIN_NY && car.up.dot(_n) < TURTLE_UP_DOT;
  if (upsideNear) {
    car.turtleTimer += dt;
    if (car.bodyContactTimer < TURTLE_CONTACT_TIME && (jumpPressed || car.turtleTimer >= TURTLE_AUTO_TIME)) {
      selfRightHop(car, gravity, events);
      consumed = true;
    }
  } else {
    car.turtleTimer = 0;
  }

  // ---- second jump: dodge or double jump
  if (jumpPressed && !consumed && !car.hasDoubleJumped && !car.hasDodged && car.airJumpTimer <= CAR.doubleJumpWindow) {
    const pi = clamp1(c.pitch);
    const yi = clamp1(c.yaw);
    const mag = Math.sqrt(pi * pi + yi * yi);
    if (mag >= CAR.dodgeDeadzone) {
      startDodge(car, pi / mag, yi / mag, events);
    } else {
      vel.addScaledVector(car.up, CAR.jumpImpulse);
      car.hasDoubleJumped = true;
      car.jumpHolding = false;
      events.push({ type: 'jump', carId: car.id, double: true });
    }
  }

  // ---- rotation
  const w = car.angVel;
  if (car.selfRightTimer > 0) {
    selfRightControl(car, dt);
  } else if (car.flipActive && flipCancelled(car, c)) {
    car.dodgeTimer += dt;
    car.flipActive = false;
    car.isDodging = false;
    _axis.copy(car.left).multiplyScalar(car.flipF).addScaledVector(car.fwd, car.flipR);
    w.addScaledVector(_axis, (FLIP_CANCEL_KEEP - 1) * w.dot(_axis));
    airControl(car, c, dt);
  } else if (car.flipActive) {
    car.dodgeTimer += dt;
    if (car.isDodging && car.dodgeTimer >= CAR.dodgeDuration) car.isDodging = false;
    const remaining = TWO_PI - car.flipAngle;
    let rate = FLIP_EASE * remaining;
    if (rate > FLIP_RATE) rate = FLIP_RATE;
    if (remaining <= 0.015) {
      rate = 0;
      car.flipActive = false;
    }
    // world flip axis from the body-fixed local axis
    _axis.copy(car.left).multiplyScalar(car.flipF).addScaledVector(car.fwd, car.flipR);
    if (car.isDodging) {
      w.copy(_axis).multiplyScalar(rate);
    } else {
      // Control is back: air control acts on everything but the flip axis, which follows the program.
      airControl(car, c, dt);
      const along = w.dot(_axis);
      w.addScaledVector(_axis, rate - along);
    }
    car.flipAngle += rate * dt;
  } else {
    if (car.isDodging) car.isDodging = false;
    airControl(car, c, dt);
  }

  // ---- boost & air throttle
  if (boosting) vel.addScaledVector(car.fwd, CAR.boostAccel * dt);
  const thr = clamp1(c.throttle);
  if (thr !== 0) vel.addScaledVector(car.fwd, CAR.airThrottleAccel * thr * dt);
}

function flipCancelled(car: SimCar, c: ControlState): boolean {
  if (car.dodgeTimer >= FLIP_CANCEL_WINDOW) return false;
  const p = clamp1(c.pitch);
  return (car.flipF > 0.5 && p < -0.5) || (car.flipF < -0.5 && p > 0.5);
}

function airControl(car: SimCar, c: ControlState, dt: number): void {
  let pitchIn = clamp1(c.pitch);
  let yawIn = clamp1(c.yaw);
  let rollIn = clamp1(c.roll);
  if (c.powerslide) {
    // free air roll: the yaw axis drives roll instead
    rollIn = clamp1(rollIn + yawIn);
    yawIn = 0;
  }
  const w = car.angVel;
  const L = car.left;
  const U = car.up;
  const F = car.fwd;
  let wl = w.dot(L); // + = nose down
  let wu = w.dot(U); // − = nose right
  let wf = w.dot(F); // + = roll right
  const ap = pitchIn < 0 ? -pitchIn : pitchIn;
  const ay = yawIn < 0 ? -yawIn : yawIn;
  wl += (pitchIn * CAR.airPitchTorque - CAR.airPitchDamp * wl * (1 - ap)) * dt;
  wu += (-yawIn * CAR.airYawTorque - CAR.airYawDamp * wu * (1 - ay)) * dt;
  wf += (rollIn * CAR.airRollTorque - CAR.airRollDamp * wf) * dt;
  w.set(L.x * wl + U.x * wu + F.x * wf, L.y * wl + U.y * wu + F.y * wf, L.z * wl + U.z * wu + F.z * wf);
  const w2 = w.lengthSq();
  if (w2 > CAR.maxAngularSpeed * CAR.maxAngularSpeed) w.multiplyScalar(CAR.maxAngularSpeed / Math.sqrt(w2));
}

function startDodge(car: SimCar, f: number, r: number, events: SimEvent[]): void {
  const vel = car.vel;
  const F = car.fwd;
  const U = car.up;
  const L = car.left;
  // Horizontal dodge frame from the car's own axes (works when pitched / rolled).
  // forward_h = horizontal(fwd − up·fwd.y): nose-down car → its roof direction, etc.
  let fx = F.x - U.x * F.y;
  let fz = F.z - U.z * F.y;
  let fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-4) {
    fx = F.x;
    fz = F.z;
    fl = Math.sqrt(fx * fx + fz * fz);
    if (fl < 1e-4) {
      fx = 0;
      fz = 1;
      fl = 1;
    }
  }
  fx /= fl;
  fz /= fl;
  // right = −left; right_h = horizontal(right − up·right.y)
  const Rx = -L.x;
  const Ry = -L.y;
  const Rz = -L.z;
  let rx = Rx - U.x * Ry;
  let rz = Rz - U.z * Ry;
  let rl = Math.sqrt(rx * rx + rz * rz);
  if (rl < 1e-4) {
    rx = -fz; // forward × +Y
    rz = fx;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const fImp = f * CAR.dodgeImpulse * (f < 0 ? BACK_DODGE_SCALE : 1);
  const rImp = r * CAR.dodgeImpulse * (1 + (SIDE_DODGE_SPEED_BONUS * (hs > CAR.maxSpeed ? CAR.maxSpeed : hs)) / CAR.maxSpeed);
  vel.x += fx * fImp + rx * rImp;
  vel.z += fz * fImp + rz * rImp;
  if (vel.y < 0) vel.y *= DODGE_VY_KEEP;

  car.hasDodged = true;
  car.isDodging = true;
  car.flipActive = true;
  car.dodgeTimer = 0;
  car.flipF = f;
  car.flipR = r;
  car.flipAngle = 0;
  car.jumpHolding = false;
  car.selfRightTimer = 0;
  _axis.copy(L).multiplyScalar(f).addScaledVector(F, r);
  car.angVel.copy(_axis).multiplyScalar(FLIP_RATE);
  events.push({ type: 'dodge', carId: car.id, fx: f, rx: r });
}

function selfRightHop(car: SimCar, gravity: number, events: SimEvent[]): void {
  // Leave the surface at (at least) the hop speed whatever the bounce state: a consistent, short hop.
  const hop = CAR.selfRightImpulse * Math.sqrt(gravity / GRAVITY);
  const vn = car.vel.dot(_n);
  if (vn < hop) car.vel.addScaledVector(_n, hop - vn);
  car.selfRightTimer = SELF_RIGHT_TIME;
  car.selfRightTarget.copy(_n);
  car.jumpLock = true;
  car.jumpTimer = 0;
  car.hasJumped = true;
  car.hasDoubleJumped = true; // the hop is this car's jump: no double jump / dodge until it lands
  car.jumpHolding = false;
  car.airJumpTimer = 0;
  car.turtleTimer = 0;
  car.flipActive = false;
  car.isDodging = false;
  events.push({ type: 'jump', carId: car.id, double: false });
}

/**
 * Self-right program (every airborne tick while selfRightTimer > 0; touchdown ends it): rotate up toward the nearest
 * non-ceiling surface normal (world up when no surface is in reach), proportional with a capped, ramped rate; once
 * aligned, hold the orientation until the car lands.
 */
function selfRightControl(car: SimCar, dt: number): void {
  car.selfRightTimer -= dt;
  const T = car.selfRightTarget;
  if (_n.y > TURTLE_MIN_NY) T.copy(_n); // _n is world up when nothing is in reach
  else T.set(0, 1, 0);
  const U = car.up;
  const cosA = U.dot(T);
  _axis.crossVectors(U, T);
  let s = _axis.length();
  if (s < 1e-4) {
    if (cosA > 0) {
      car.angVel.set(0, 0, 0);
      return;
    }
    _axis.copy(car.fwd); // upside down: roll over
    s = 0;
  } else {
    _axis.multiplyScalar(1 / s);
  }
  // Monotonic angle proxy in [0, 2] (no trig): sinθ for θ ≤ 90°, 2 − sinθ beyond.
  const proxy = cosA >= 0 ? s : 2 - s;
  let rate = SELF_RIGHT_GAIN * proxy;
  if (rate > SELF_RIGHT_MAX_RATE) rate = SELF_RIGHT_MAX_RATE;
  const ramp = SELF_RIGHT_ACCEL * (SELF_RIGHT_TIME - car.selfRightTimer);
  if (rate > ramp) rate = ramp;
  car.angVel.copy(_axis).multiplyScalar(rate);
}

// ---------------------------------------------------------------------------------------------
// Body vs arena
// ---------------------------------------------------------------------------------------------

/**
 * Resolve hitbox penetration with the arena: deepest sample point (+ centroid of equally deep points
 * for flat contacts) → positional push-out along the SDF normal + rigid-body impulse with friction.
 * Returns true if the body touched the arena.
 */
export function collideCarArena(car: SimCar, time: number, events: SimEvent[] | null): boolean {
  const p = car.pos;
  const dc = arenaSDF(p.x, p.y, p.z);
  if (dc > CAR_BOUND_RADIUS + 0.02) return false;
  const L = car.left;
  const U = car.up;
  const F = car.fwd;
  let touched = false;
  for (let iter = 0; iter < 2; iter++) {
    let minD = 0;
    let best = -1;
    for (let i = 0; i < NUM_SAMPLES; i++) {
      const lx = SAMPLES[i * 3];
      const ly = SAMPLES[i * 3 + 1];
      const lz = SAMPLES[i * 3 + 2];
      const wx = p.x + L.x * lx + U.x * ly + F.x * lz;
      const wy = p.y + L.y * lx + U.y * ly + F.y * lz;
      const wz = p.z + L.z * lx + U.z * ly + F.z * lz;
      const d = arenaSDF(wx, wy, wz);
      _sd[i] = d;
      _sp[i * 3] = wx;
      _sp[i * 3 + 1] = wy;
      _sp[i * 3 + 2] = wz;
      if (d < minD) {
        minD = d;
        best = i;
      }
    }
    if (best < 0) break;
    touched = true;
    // contact point: centroid of the samples within a small band of the deepest one
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cnt = 0;
    const band = minD + 0.03;
    for (let i = 0; i < NUM_SAMPLES; i++) {
      if (_sd[i] <= band && _sd[i] < 0) {
        cx += _sp[i * 3];
        cy += _sp[i * 3 + 1];
        cz += _sp[i * 3 + 2];
        cnt++;
      }
    }
    cx /= cnt;
    cy /= cnt;
    cz /= cnt;
    arenaNormal(_sp[best * 3], _sp[best * 3 + 1], _sp[best * 3 + 2], _cn);
    _r.set(cx - p.x, cy - p.y, cz - p.z);
    // push out
    p.addScaledVector(_cn, -minD);
    // impulse
    const w = car.angVel;
    const v = car.vel;
    const vpx = v.x + (w.y * _r.z - w.z * _r.y);
    const vpy = v.y + (w.z * _r.x - w.x * _r.z);
    const vpz = v.z + (w.x * _r.y - w.y * _r.x);
    const vn = vpx * _cn.x + vpy * _cn.y + vpz * _cn.z;
    if (vn < 0) {
      const e = -vn > BODY_REST_SPEED ? BODY_RESTITUTION : 0;
      const k = carInvMassAt(car, _r, _cn);
      const jn = (-(1 + e) * vn) / k;
      applyCarImpulse(car, _r, _cn.x * jn, _cn.y * jn, _cn.z * jn);
      // friction
      const qx = v.x + (w.y * _r.z - w.z * _r.y);
      const qy = v.y + (w.z * _r.x - w.x * _r.z);
      const qz = v.z + (w.x * _r.y - w.y * _r.x);
      const qn = qx * _cn.x + qy * _cn.y + qz * _cn.z;
      let tx = qx - _cn.x * qn;
      let ty = qy - _cn.y * qn;
      let tz = qz - _cn.z * qn;
      const ts = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (ts > 1e-6) {
        tx /= ts;
        ty /= ts;
        tz /= ts;
        _axis.set(tx, ty, tz);
        const kt = carInvMassAt(car, _r, _axis);
        let jt = ts / kt;
        const cap = BODY_FRICTION * jn;
        if (jt > cap) jt = cap;
        applyCarImpulse(car, _r, -tx * jt, -ty * jt, -tz * jt);
      }
      if (events && -vn >= CAR_IMPACT_EVENT_SPEED && time - car.lastImpactEventTime > 0.25) {
        car.lastImpactEventTime = time;
        events.push({
          type: 'carImpact',
          carId: car.id,
          pos: { x: cx, y: cy, z: cz },
          normal: { x: _cn.x, y: _cn.y, z: _cn.z },
          speed: -vn,
        });
      }
    }
  }
  if (touched) car.bodyContactTimer = 0;
  return touched;
}
