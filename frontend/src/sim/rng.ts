/**
 * NOVABALL — seeded deterministic RNG (mulberry32).
 *
 * Only 32-bit integer ops (Math.imul, shifts, xor) and an exact division by 2^32 are used, so the
 * sequence is bit-identical on every JS engine. The whole generator state is one uint32 (`state`),
 * which World.hash() includes.
 */
export class Rng {
  /** Current 32-bit state (signed int32 representation). */
  state: number;

  constructor(seed: number) {
    // Normalize any number (float, negative, > 2^32) into a well-mixed int32 state.
    const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
    const lo = s % 4294967296;
    let h = (lo | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    this.state = h | 0;
  }

  /** Next uint32. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[this.int(arr.length)];
  }
}
