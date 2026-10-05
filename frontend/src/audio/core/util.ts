/**
 * NOVABALL audio — small math / scheduling helpers shared by every audio module.
 * Nothing in here allocates per call (except Rng construction).
 */

/** Clamp (NaN → a: garbage in never reaches an AudioParam, which would throw on non-finite values). */
export const clamp = (x: number, a: number, b: number): number => (x > a ? (x < b ? x : b) : a);
export const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** MIDI note number → Hz (A4 = 69 = 440 Hz). */
export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(g > 1e-12 ? g : 1e-12);
}

/** Perceptual volume taper for 0..1 settings sliders (≈ -12 dB at 0.5). */
export function volumeTaper(v: number): number {
  const x = clamp01(Number.isFinite(v) ? v : 0);
  return x * x;
}

/** Frame-rate independent exponential smoothing factor for a time constant (seconds). */
export function smoothK(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

/** mulberry32 — tiny, fast, deterministic PRNG (audio variation only; never used by the sim). */
export class Rng {
  private s: number;
  constructor(seed = 0x2f6b1d3) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Symmetric random in [-a, a]. */
  spread(a: number): number {
    return (this.next() * 2 - 1) * a;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * An AudioParam driven toward per-frame targets with setTargetAtTime, skipping redundant automation
 * events when the target barely changed (keeps the param timelines short and main-thread cost tiny).
 */
export class SmoothParam {
  private last = Number.NaN;
  constructor(
    readonly param: AudioParam,
    private tau: number,
    private absEps = 3e-4,
    private relEps = 0.012,
  ) {}

  set(value: number, time: number, tau: number = this.tau): void {
    if (!Number.isFinite(value)) return;
    const d = value - this.last;
    if ((d < 0 ? -d : d) <= this.absEps + this.relEps * (value < 0 ? -value : value)) return;
    this.last = value;
    this.param.setTargetAtTime(value, time, tau);
  }

  /** Hard set (cancels pending automation). */
  jump(value: number, time: number): void {
    if (!Number.isFinite(value)) return;
    this.last = value;
    this.param.cancelScheduledValues(time);
    this.param.setValueAtTime(value, time);
  }

  get target(): number {
    return this.last;
  }
}

/** Safe disconnect (never throws). */
export function disconnect(...nodes: Array<AudioNode | null | undefined>): void {
  for (const n of nodes) {
    if (!n) continue;
    try {
      n.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/** Safe stop for scheduled sources (never throws). */
export function stopSource(src: AudioScheduledSourceNode | null | undefined, when = 0): void {
  if (!src) return;
  try {
    src.stop(when);
  } catch {
    /* not started / already stopped */
  }
}
