/**
 * NOVABALL — car–ball and car–car collision geometry + responses (deterministic).
 *
 * Car–ball: closest point on the car OBB to the ball center → physical impulse (masses 180 / 30, linear +
 * angular, restitution HIT.restitution, friction for spin) + positional separation (mostly the ball),
 * plus the "strike assist" extra impulse on contact START (see HIT in constants.ts).
 * Car–car: capsule vs capsule (segment along the car's forward axis), gated by a separating-axis test on both cars' up
 * axes (the capsule is 2× taller than the hitbox) — no ghost contacts / demolitions through clear air.
 */
import { Vector3 } from 'three';
import type { BallBody } from './ball';
import type { SimCar } from './car';
import { applyCarImpulse, carInvMassAt } from './car';
import { BALL, CAR, CAR_CAR, HIT } from './constants';
import { curve } from './vmath';

const R = BALL.radius;
const HX = CAR.halfExtents.x;
const HY = CAR.halfExtents.y;
const HZ = CAR.halfExtents.z;
const INV_MB = 1 / BALL.mass;
/** Solid sphere: R² / I = R² / (0.4 m R²) = 2.5 / m. */
const BALL_ROT_INV_MASS = 2.5 / BALL.mass;
const INV_IB = 1 / (0.4 * BALL.mass * R * R);
/** Car–ball tangential friction coefficient (puts spin on off-center hits). */
export const CAR_BALL_FRICTION = 0.5;
/** Contact-start hysteresis: "still touching" while the gap is below this. */
export const CAR_BALL_CONTACT_MARGIN = 0.06;
/** Share of the positional correction applied to the ball (the rest moves the car). */
const BALL_SEPARATION_SHARE = CAR.mass / (CAR.mass + BALL.mass);

/** Car collision capsule (segment along local +Z). */
export const CAR_CAPSULE_RADIUS = 0.42;
export const CAR_CAPSULE_HALF = HZ - CAR_CAPSULE_RADIUS;
/**
 * The capsule (radius 0.42) is twice as tall as the hitbox (half height 0.2): alone it made cars collide — and
 * supersonic cars demolish — through up to ~0.44 m of clear air. A capsule hit therefore also needs the two hitboxes to
 * overlap (within this margin, m) along BOTH cars' up axes (separating-axis test), and its depth is capped by that
 * overlap so a car landing on a roof rests on it instead of being catapulted off by the capsule's extra height.
 */
export const CAR_CAR_UP_MARGIN = 0.03;

export interface CarBallContact {
  /** Gap below CAR_BALL_CONTACT_MARGIN (used for contact-start detection). */
  near: boolean;
  /** Overlapping (ball surface inside the box). */
  penetrating: boolean;
  /** Distance from the box to the ball center (negative when the center is inside the box). */
  dist: number;
  /** Contact normal, car → ball (world). */
  nx: number;
  ny: number;
  nz: number;
  /** Closest point on the car box (world). */
  cx: number;
  cy: number;
  cz: number;
}

export function makeCarBallContact(): CarBallContact {
  return { near: false, penetrating: false, dist: 0, nx: 0, ny: 1, nz: 0, cx: 0, cy: 0, cz: 0 };
}

/** Geometry only (no state change). Returns contact.near. */
export function carBallContact(car: SimCar, ball: BallBody, out: CarBallContact): boolean {
  const L = car.left;
  const U = car.up;
  const F = car.fwd;
  const dx = ball.pos.x - car.pos.x;
  const dy = ball.pos.y - car.pos.y;
  const dz = ball.pos.z - car.pos.z;
  // quick reject with the bounding sphere
  const lim = R + 0.9;
  if (dx * dx + dy * dy + dz * dz > lim * lim) {
    out.near = false;
    out.penetrating = false;
    return false;
  }
  const lx = dx * L.x + dy * L.y + dz * L.z;
  const ly = dx * U.x + dy * U.y + dz * U.z;
  const lz = dx * F.x + dy * F.y + dz * F.z;
  let cx = lx < -HX ? -HX : lx > HX ? HX : lx;
  let cy = ly < -HY ? -HY : ly > HY ? HY : ly;
  let cz = lz < -HZ ? -HZ : lz > HZ ? HZ : lz;
  let nlx: number;
  let nly: number;
  let nlz: number;
  let dist: number;
  if (cx === lx && cy === ly && cz === lz) {
    // ball center inside the box: exit through the nearest face
    const px = HX - (lx < 0 ? -lx : lx);
    const py = HY - (ly < 0 ? -ly : ly);
    const pz = HZ - (lz < 0 ? -lz : lz);
    nlx = 0;
    nly = 0;
    nlz = 0;
    if (px <= py && px <= pz) {
      nlx = lx < 0 ? -1 : 1;
      cx = nlx * HX;
      dist = -px;
    } else if (py <= pz) {
      nly = ly < 0 ? -1 : 1;
      cy = nly * HY;
      dist = -py;
    } else {
      nlz = lz < 0 ? -1 : 1;
      cz = nlz * HZ;
      dist = -pz;
    }
  } else {
    const ex = lx - cx;
    const ey = ly - cy;
    const ez = lz - cz;
    dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (dist >= R + CAR_BALL_CONTACT_MARGIN) {
      out.near = false;
      out.penetrating = false;
      return false;
    }
    nlx = ex / dist;
    nly = ey / dist;
    nlz = ez / dist;
  }
  out.near = true;
  out.penetrating = dist < R;
  out.dist = dist;
  out.nx = L.x * nlx + U.x * nly + F.x * nlz;
  out.ny = L.y * nlx + U.y * nly + F.y * nlz;
  out.nz = L.z * nlx + U.z * nly + F.z * nlz;
  out.cx = car.pos.x + L.x * cx + U.x * cy + F.x * cz;
  out.cy = car.pos.y + L.y * cx + U.y * cy + F.y * cz;
  out.cz = car.pos.z + L.z * cx + U.z * cy + F.z * cz;
  return true;
}

export interface CarBallResponse {
  /** Closing speed along the normal before the impulse (m/s, >= 0). */
  closing: number;
  /** |Δv| of the ball from this response (physical + extra). */
  dv: number;
  /** Strike-assist extra impulse was applied. */
  extraApplied: boolean;
}

export function makeCarBallResponse(): CarBallResponse {
  return { closing: 0, dv: 0, extraApplied: false };
}

const _r = new Vector3();
const _n = new Vector3();
const _t = new Vector3();

/**
 * Physical response + optional strike-assist extra impulse. The caller decides `allowExtra`
 * (contact start and HIT.minInterval since the car's last one). `dodgeBonus` / `chargeLevel` scale the extra.
 */
export function resolveCarBall(
  car: SimCar,
  ball: BallBody,
  ct: CarBallContact,
  allowExtra: boolean,
  chargeLevel: number,
  out: CarBallResponse,
): void {
  const bv = ball.vel;
  const bw = ball.angVel;
  const b0x = bv.x;
  const b0y = bv.y;
  const b0z = bv.z;
  // relative linear velocity before the response (for the strike assist)
  const relx = bv.x - car.vel.x;
  const rely = bv.y - car.vel.y;
  const relz = bv.z - car.vel.z;

  _n.set(ct.nx, ct.ny, ct.nz);
  _r.set(ct.cx - car.pos.x, ct.cy - car.pos.y, ct.cz - car.pos.z);
  const rbx = -ct.nx * R;
  const rby = -ct.ny * R;
  const rbz = -ct.nz * R;
  const cw = car.angVel;
  const cv = car.vel;
  // velocities at the contact point
  let vx = bv.x + (bw.y * rbz - bw.z * rby) - (cv.x + (cw.y * _r.z - cw.z * _r.y));
  let vy = bv.y + (bw.z * rbx - bw.x * rbz) - (cv.y + (cw.z * _r.x - cw.x * _r.z));
  let vz = bv.z + (bw.x * rby - bw.y * rbx) - (cv.z + (cw.x * _r.y - cw.y * _r.x));
  const vn = vx * _n.x + vy * _n.y + vz * _n.z;
  out.closing = vn < 0 ? -vn : 0;
  out.extraApplied = false;

  if (vn < 0 && ct.penetrating) {
    const k = INV_MB + carInvMassAt(car, _r, _n);
    const jn = (-(1 + HIT.restitution) * vn) / k;
    bv.x += _n.x * jn * INV_MB;
    bv.y += _n.y * jn * INV_MB;
    bv.z += _n.z * jn * INV_MB;
    applyCarImpulse(car, _r, -_n.x * jn, -_n.y * jn, -_n.z * jn);
    // friction (spin): recompute the relative contact velocity
    vx = bv.x + (bw.y * rbz - bw.z * rby) - (cv.x + (cw.y * _r.z - cw.z * _r.y));
    vy = bv.y + (bw.z * rbx - bw.x * rbz) - (cv.y + (cw.z * _r.x - cw.x * _r.z));
    vz = bv.z + (bw.x * rby - bw.y * rbx) - (cv.z + (cw.x * _r.y - cw.y * _r.x));
    const qn = vx * _n.x + vy * _n.y + vz * _n.z;
    let tx = vx - _n.x * qn;
    let ty = vy - _n.y * qn;
    let tz = vz - _n.z * qn;
    const ts = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (ts > 1e-6) {
      tx /= ts;
      ty /= ts;
      tz /= ts;
      _t.set(tx, ty, tz);
      const kt = INV_MB + BALL_ROT_INV_MASS + carInvMassAt(car, _r, _t);
      let jt = ts / kt;
      const cap = CAR_BALL_FRICTION * jn;
      if (jt > cap) jt = cap;
      // ball gets −t·jt at r_b, car gets +t·jt at r_c
      bv.x -= tx * jt * INV_MB;
      bv.y -= ty * jt * INV_MB;
      bv.z -= tz * jt * INV_MB;
      // Δω_b = I⁻¹ (r_b × (−t·jt))
      bw.x += (rby * -tz - rbz * -ty) * jt * INV_IB;
      bw.y += (rbz * -tx - rbx * -tz) * jt * INV_IB;
      bw.z += (rbx * -ty - rby * -tx) * jt * INV_IB;
      applyCarImpulse(car, _r, tx * jt, ty * jt, tz * jt);
    }
  }

  // positional separation (mostly the ball)
  if (ct.penetrating) {
    const pen = R - ct.dist;
    const pb = pen * BALL_SEPARATION_SHARE;
    const pc = pen - pb;
    ball.pos.x += _n.x * pb;
    ball.pos.y += _n.y * pb;
    ball.pos.z += _n.z * pb;
    car.pos.x -= _n.x * pc;
    car.pos.y -= _n.y * pc;
    car.pos.z -= _n.z * pc;
  }

  // strike assist
  if (allowExtra && vn < -0.1) {
    let relSpeed = Math.sqrt(relx * relx + rely * rely + relz * relz);
    if (relSpeed > HIT.maxRelSpeed) relSpeed = HIT.maxRelSpeed;
    let dx = ball.pos.x - car.pos.x;
    let dy = (ball.pos.y - car.pos.y) * HIT.verticalScale;
    let dz = ball.pos.z - car.pos.z;
    let dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl > 1e-6) {
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const fb = HIT.forwardBias;
      dx = dx * (1 - fb) + car.fwd.x * fb;
      dy = dy * (1 - fb) + car.fwd.y * fb;
      dz = dz * (1 - fb) + car.fwd.z * fb;
      dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl > 1e-6) {
        const mag =
          (relSpeed * curve(HIT.factorCurve, relSpeed) * (car.isDodging ? HIT.dodgeBonus : 1) * (1 + chargeLevel * HIT.chargeBonusPerLevel)) /
          dl;
        bv.x += dx * mag;
        bv.y += dy * mag;
        bv.z += dz * mag;
        out.extraApplied = true;
      }
    }
  }
  const ex = bv.x - b0x;
  const ey = bv.y - b0y;
  const ez = bv.z - b0z;
  out.dv = Math.sqrt(ex * ex + ey * ey + ez * ez);
}

// ---------------------------------------------------------------------------------------------
// Car–car (capsules)
// ---------------------------------------------------------------------------------------------

export interface CarCarContact {
  hit: boolean;
  /** Normal from A to B. */
  nx: number;
  ny: number;
  nz: number;
  pen: number;
  /** Contact midpoint. */
  px: number;
  py: number;
  pz: number;
}

export function makeCarCarContact(): CarCarContact {
  return { hit: false, nx: 1, ny: 0, nz: 0, pen: 0, px: 0, py: 0, pz: 0 };
}

/** Capsule–capsule overlap test. Returns out.hit. */
export function carCarContact(a: SimCar, b: SimCar, out: CarCarContact): boolean {
  const pa = a.pos;
  const pb = b.pos;
  const ddx = pb.x - pa.x;
  const ddy = pb.y - pa.y;
  const ddz = pb.z - pa.z;
  const reach = 2 * (CAR_CAPSULE_HALF + CAR_CAPSULE_RADIUS);
  if (ddx * ddx + ddy * ddy + ddz * ddz > reach * reach) {
    out.hit = false;
    return false;
  }
  const h = CAR_CAPSULE_HALF;
  // segment A: p1 → q1, segment B: p2 → q2
  const p1x = pa.x - a.fwd.x * h;
  const p1y = pa.y - a.fwd.y * h;
  const p1z = pa.z - a.fwd.z * h;
  const d1x = a.fwd.x * 2 * h;
  const d1y = a.fwd.y * 2 * h;
  const d1z = a.fwd.z * 2 * h;
  const p2x = pb.x - b.fwd.x * h;
  const p2y = pb.y - b.fwd.y * h;
  const p2z = pb.z - b.fwd.z * h;
  const d2x = b.fwd.x * 2 * h;
  const d2y = b.fwd.y * 2 * h;
  const d2z = b.fwd.z * 2 * h;
  const rx = p1x - p2x;
  const ry = p1y - p2y;
  const rz = p1z - p2z;
  const A = d1x * d1x + d1y * d1y + d1z * d1z;
  const E = d2x * d2x + d2y * d2y + d2z * d2z;
  const Fv = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  const EPS = 1e-9;
  if (A <= EPS && E <= EPS) {
    s = 0;
    t = 0;
  } else if (A <= EPS) {
    s = 0;
    t = clamp01(Fv / E);
  } else {
    const C = d1x * rx + d1y * ry + d1z * rz;
    if (E <= EPS) {
      t = 0;
      s = clamp01(-C / A);
    } else {
      const B = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = A * E - B * B;
      s = denom > EPS ? clamp01((B * Fv - C * E) / denom) : 0;
      t = (B * s + Fv) / E;
      if (t < 0) {
        t = 0;
        s = clamp01(-C / A);
      } else if (t > 1) {
        t = 1;
        s = clamp01((B - C) / A);
      }
    }
  }
  const c1x = p1x + d1x * s;
  const c1y = p1y + d1y * s;
  const c1z = p1z + d1z * s;
  const c2x = p2x + d2x * t;
  const c2y = p2y + d2y * t;
  const c2z = p2z + d2z * t;
  let nx = c2x - c1x;
  let ny = c2y - c1y;
  let nz = c2z - c1z;
  const dist = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const rr = 2 * CAR_CAPSULE_RADIUS;
  if (dist >= rr) {
    out.hit = false;
    return false;
  }
  // separating-axis test on A's up and B's up (box half-extent projections, see CAR_CAR_UP_MARGIN)
  const ua = a.up;
  const ub = b.up;
  const la = a.left;
  const lb = b.left;
  const fa = a.fwd;
  const fb = b.fwd;
  const dA = ddx * ua.x + ddy * ua.y + ddz * ua.z;
  const extB =
    abs(ua.x * lb.x + ua.y * lb.y + ua.z * lb.z) * HX +
    abs(ua.x * ub.x + ua.y * ub.y + ua.z * ub.z) * HY +
    abs(ua.x * fb.x + ua.y * fb.y + ua.z * fb.z) * HZ;
  const overA = HY + extB - abs(dA);
  if (overA < -CAR_CAR_UP_MARGIN) {
    out.hit = false;
    return false;
  }
  const dB = ddx * ub.x + ddy * ub.y + ddz * ub.z;
  const extA =
    abs(ub.x * la.x + ub.y * la.y + ub.z * la.z) * HX +
    abs(ub.x * ua.x + ub.y * ua.y + ub.z * ua.z) * HY +
    abs(ub.x * fa.x + ub.y * fa.y + ub.z * fa.z) * HZ;
  const overB = HY + extA - abs(dB);
  if (overB < -CAR_CAR_UP_MARGIN) {
    out.hit = false;
    return false;
  }
  let pen = rr - dist;
  const over = overA < overB ? overA : overB;
  if (over < pen) pen = over > 0 ? over : 0;
  if (dist > 1e-6) {
    nx /= dist;
    ny /= dist;
    nz /= dist;
  } else {
    const dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (dl > 1e-6) {
      nx = ddx / dl;
      ny = ddy / dl;
      nz = ddz / dl;
    } else {
      nx = 1;
      ny = 0;
      nz = 0;
    }
  }
  out.hit = true;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.pen = pen;
  out.px = (c1x + c2x) * 0.5;
  out.py = (c1y + c2y) * 0.5;
  out.pz = (c1z + c2z) * 0.5;
  return true;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function abs(x: number): number {
  return x < 0 ? -x : x;
}

/**
 * Physical car–car response (equal masses, linear only) + positional split.
 * Returns the closing speed along the normal (>= 0; 0 when separating).
 */
export function resolveCarCar(a: SimCar, b: SimCar, ct: CarCarContact): number {
  const half = ct.pen * 0.5;
  a.pos.x -= ct.nx * half;
  a.pos.y -= ct.ny * half;
  a.pos.z -= ct.nz * half;
  b.pos.x += ct.nx * half;
  b.pos.y += ct.ny * half;
  b.pos.z += ct.nz * half;
  const vn = (b.vel.x - a.vel.x) * ct.nx + (b.vel.y - a.vel.y) * ct.ny + (b.vel.z - a.vel.z) * ct.nz;
  if (vn >= 0) return 0;
  const j = ((1 + CAR_CAR.restitution) * -vn) * 0.5;
  a.vel.x -= ct.nx * j;
  a.vel.y -= ct.ny * j;
  a.vel.z -= ct.nz * j;
  b.vel.x += ct.nx * j;
  b.vel.y += ct.ny * j;
  b.vel.z += ct.nz * j;
  return -vn;
}
