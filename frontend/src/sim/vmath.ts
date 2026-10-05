/**
 * NOVABALL — deterministic math helpers for the simulation.
 *
 * Only + - * / and Math.sqrt / abs / min / max / floor are used (bit-exact across JS engines).
 * No trigonometry, no Math.pow / exp / hypot / `**`.
 */
import type { Quaternion, Vector3 } from 'three';

export const TWO_PI = 6.283185307179586;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Clamp to [-1, 1]; NaN/undefined => 0 (defensive: controls come from outside the sim). */
export function clamp1(x: number): number {
  if (!(x === x)) return 0; // NaN
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/** Move `x` toward 0 by at most `amount` (amount >= 0), never overshooting. */
export function towardZero(x: number, amount: number): number {
  if (x > 0) return x > amount ? x - amount : 0;
  if (x < 0) return -x > amount ? x + amount : 0;
  return 0;
}

/** Piecewise-linear interpolation over [x, y] pairs sorted by x; clamps outside the range. */
export function curve(pairs: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = pairs.length;
  const first = pairs[0];
  if (x <= first[0]) return first[1];
  for (let i = 1; i < n; i++) {
    const p1 = pairs[i];
    if (x <= p1[0]) {
      const p0 = pairs[i - 1];
      const span = p1[0] - p0[0];
      const t = span > 0 ? (x - p0[0]) / span : 1;
      return p0[1] + (p1[1] - p0[1]) * t;
    }
  }
  return pairs[n - 1][1];
}

/**
 * Orientation integration: q ← normalize(q + ½·(ω ⊗ q)·dt), ω = world-space angular velocity.
 * (Left-multiplication because ω is expressed in world space.)
 */
export function integrateQuat(q: Quaternion, wx: number, wy: number, wz: number, dt: number): void {
  const h = 0.5 * dt;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  const nx = qx + h * (wx * qw + wy * qz - wz * qy);
  const ny = qy + h * (-wx * qz + wy * qw + wz * qx);
  const nz = qz + h * (wx * qy - wy * qx + wz * qw);
  const nw = qw + h * (-wx * qx - wy * qy - wz * qz);
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
  if (len > 1e-12) {
    const inv = 1 / len;
    q.set(nx * inv, ny * inv, nz * inv, nw * inv);
  } else {
    q.set(0, 0, 0, 1);
  }
}

/** Local +Z (forward) of `q` in world space. */
export function quatForward(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  return out.set(2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
}

/** Local +Y (up) of `q` in world space. */
export function quatUp(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  return out.set(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
}

/** Local +X (LEFT — the car frame's right is −X) of `q` in world space. */
export function quatLeft(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  return out.set(1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y));
}

/**
 * Quaternion that yaws the local +Z axis onto the horizontal direction (dx, dz) (keeps +Y up).
 * Arithmetic + sqrt only (half-angle formula), robust for the exactly-opposite case.
 */
export function quatFromHeading(dx: number, dz: number, out: Quaternion): Quaternion {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9) return out.set(0, 0, 0, 1);
  const cx = dx / len;
  const cz = dz / len;
  // rotation about +Y by θ maps +Z to (sin θ, 0, cos θ): sin θ = cx, cos θ = cz.
  // half angle: cos(θ/2) = sqrt((1 + cz)/2), sin(θ/2) = sign(cx)·sqrt((1 - cz)/2)
  const c = Math.sqrt(Math.max(0, (1 + cz) * 0.5));
  let s = Math.sqrt(Math.max(0, (1 - cz) * 0.5));
  if (cx < 0) s = -s;
  return out.set(0, s, 0, c);
}

/** Squared length helper for raw components. */
export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
