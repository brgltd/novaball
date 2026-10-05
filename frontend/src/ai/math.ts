/**
 * NOVABALL AI — small math helpers (not bound by the sim determinism rules, but allocation-free).
 */
import type { Quaternion, Vector3 } from 'three';

export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sign that never returns 0 (0 ⇒ +1). */
export function sgn(x: number): number {
  return x < 0 ? -1 : 1;
}

/** Wrap an angle into (-π, π]. */
export function wrapPi(a: number): number {
  while (a > PI) a -= TWO_PI;
  while (a <= -PI) a += TWO_PI;
  return a;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** √(x² + z²) — Math.hypot is slower and allocates (it takes varargs). */
export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Local +Z (forward) of `q`. */
export function quatFwd(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return out.set(2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
}

/** Local +Y (up) of `q`. */
export function quatUp(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return out.set(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
}

/** Local −X (the car's RIGHT; car +X is left) of `q`. */
export function quatRight(q: Quaternion, out: Vector3): Vector3 {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return out.set(-(1 - 2 * (y * y + z * z)), -(2 * (x * y + w * z)), -(2 * (x * z - w * y)));
}

/** Piecewise-linear interpolation over sorted [x, y] pairs (clamped). */
export function curve(pairs: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = pairs.length;
  if (x <= pairs[0][0]) return pairs[0][1];
  for (let i = 1; i < n; i++) {
    const p1 = pairs[i];
    if (x <= p1[0]) {
      const p0 = pairs[i - 1];
      const span = p1[0] - p0[0];
      return p0[1] + ((p1[1] - p0[1]) * (span > 0 ? (x - p0[0]) / span : 1));
    }
  }
  return pairs[n - 1][1];
}

/** Small deterministic PRNG (mulberry32) for bot noise — independent from the sim's stream. */
export class BotRng {
  private s: number;
  constructor(seed: number) {
    const v = Number.isFinite(seed) ? Math.floor(seed) : 0;
    let h = (v % 4294967296 | 0) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    this.s = (h ^ (h >>> 15)) | 0;
  }
  /** Uniform [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Approximately normal (sum of 3 uniforms), mean 0, std ≈ sigma. */
  gauss(sigma: number): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2 * sigma;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}
