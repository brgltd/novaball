/**
 * NOVABALL audio — procedural buffers: noise colors, crackle, reverb impulse responses, wave-shaper curves.
 *
 * Synthesized by generator jobs on the idle queue (core/idle.ts) and cached per sample rate:
 *   - prebakeBuffers() runs before any AudioContext exists (loading screen / attract mode): it prepares the noise sets
 *     and reverb IRs for the common device rates as context-free AudioBuffers, so the audio unlock inside the first
 *     user gesture only has to create nodes;
 *   - getBuffers() / reverbIR() hand out (or finish synchronously) the data for a given context.
 * The DSP is unchanged (same math, same seeds, same order): a set is bit-identical however it was produced.
 * AudioBuffers may be shared between contexts, so building several graphs (e.g. offline render checks) is free.
 */
import { PRIO, idle, type IdleJob, type JobGen } from './idle';
import { Rng } from './util';

export type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle';
export type ReverbKind = 'stadium' | 'hall';

export interface BufferSet {
  /** Rate the noise was synthesized at (buffer sources resample when the context runs at another rate). */
  readonly sampleRate: number;
  /** Stereo, 2 s, decorrelated channels. */
  readonly white: AudioBuffer;
  /** Stereo, 3 s, -3 dB/oct. */
  readonly pink: AudioBuffer;
  /** Stereo, 3 s, -6 dB/oct (loop-seamless). */
  readonly brown: AudioBuffer;
  /** Mono, 2 s, sparse random clicks (flame crackle / debris / electric sizzle). */
  readonly crackle: AudioBuffer;
  /** Master soft clipper: use behind a 0.5 pre-gain; unity below |0.72|, saturates smoothly to ±0.95. */
  readonly curveSoftClip: Float32Array<ArrayBuffer>;
  /** tanh drive (grit / crunch). */
  readonly curveDrive: Float32Array<ArrayBuffer>;
  /** Hard-ish asymmetric fuzz for explosions and dodge crunch. */
  readonly curveFuzz: Float32Array<ArrayBuffer>;
}

/** Device rates prepared before the unlock (most common first). Other rates: IRs are made after the unlock. */
export const PREBAKE_RATES: readonly number[] = [48000, 44100];

/** Reverb impulse responses (stereo): stadium 2.6 s (pre-delay, early reflections, stand slap-backs, darkening tail); music hall/plate 2.4 s. */
const IR_OPTIONS: Record<ReverbKind, IROptions> = {
  stadium: {
    duration: 2.6,
    rt60: 2.3,
    preDelay: 0.018,
    earlyCount: 14,
    earlyGain: 0.55,
    earlySpan: 0.085,
    dampStart: 0.62,
    dampEnd: 0.07,
    hpHz: 110,
    slap: [
      { time: 0.19, gain: 0.22 },
      { time: 0.37, gain: 0.11 },
    ],
    seed: 0x57ad,
  },
  hall: {
    duration: 2.4,
    rt60: 2.1,
    preDelay: 0.024,
    earlyCount: 8,
    earlyGain: 0.25,
    earlySpan: 0.05,
    dampStart: 0.8,
    dampEnd: 0.22,
    hpHz: 160,
    slap: [],
    seed: 0x4a11,
  },
};

type Alloc = (channels: number, length: number, sampleRate: number) => AudioBuffer;

let standalone: Alloc | null | undefined;
/** `new AudioBuffer()` (no context needed) when supported — the prebake depends on it. */
function standaloneAlloc(): Alloc | null {
  if (standalone === undefined) {
    standalone = null;
    try {
      const AB = (globalThis as unknown as { AudioBuffer?: typeof AudioBuffer }).AudioBuffer;
      if (typeof AB === 'function' && new AB({ length: 1, numberOfChannels: 1, sampleRate: 44100 }).length === 1) {
        standalone = (numberOfChannels, length, sampleRate) => new AB({ length, numberOfChannels, sampleRate });
      }
    } catch {
      standalone = null;
    }
  }
  return standalone;
}

/** With a context at hand, allocate through it (always supported; the buffers still work with any context). */
function allocFor(ctx: BaseAudioContext): Alloc {
  return (c, l, sr) => ctx.createBuffer(c, l, sr);
}

const noiseJobs = new Map<number, IdleJob<BufferSet>>();
const irJobs = new Map<string, IdleJob<AudioBuffer>>();
let curves: { softClip: Float32Array<ArrayBuffer>; drive: Float32Array<ArrayBuffer>; fuzz: Float32Array<ArrayBuffer> } | null = null;

function usable<T>(job: IdleJob<T> | undefined): job is IdleJob<T> {
  return !!job && (!job.done || job.ok);
}

function noiseJob(sr: number, alloc: Alloc, priority: number): IdleJob<BufferSet> {
  let job = noiseJobs.get(sr);
  if (!usable(job)) {
    job = idle.run(`noise@${sr}`, genNoiseSet(alloc, sr), priority);
    noiseJobs.set(sr, job);
  }
  return job;
}

function irJob(kind: ReverbKind, sr: number, alloc: Alloc, priority: number): IdleJob<AudioBuffer> {
  const key = `${kind}@${sr}`;
  let job = irJobs.get(key);
  if (!usable(job)) {
    job = idle.run(`ir:${key}`, genReverbIR(alloc, sr, IR_OPTIONS[kind]), priority);
    irJobs.set(key, job);
  } else if (job.priority < priority) job.priority = priority;
  return job;
}

/**
 * Start synthesizing, in idle time, what a live context will need: the noise sets and both reverb IRs for the common
 * device rates. Call before the audio unlock (safe to call repeatedly; a no-op without the AudioBuffer constructor —
 * the unlock then synthesizes inline as before).
 */
export function prebakeBuffers(): void {
  const alloc = standaloneAlloc();
  if (!alloc) return;
  PREBAKE_RATES.forEach((sr, i) => noiseJob(sr, alloc, PRIO.noise - i));
  PREBAKE_RATES.forEach((sr, i) => {
    irJob('stadium', sr, alloc, PRIO.reverb - 2 * i);
    irJob('hall', sr, alloc, PRIO.reverb - 2 * i - 1);
  });
}

/**
 * Noise + curves for `ctx`, finishing any pending synthesis synchronously. `exactRate` = false (live contexts): at an
 * uncommon device rate, reuse the prepared 48 kHz set (buffer sources resample) instead of synthesizing inline.
 */
export function getBuffers(ctx: BaseAudioContext, exactRate = true): BufferSet {
  const sr = ctx.sampleRate;
  let job = noiseJobs.get(sr);
  if (!usable(job) && !exactRate) {
    for (const r of PREBAKE_RATES) {
      const j = noiseJobs.get(r);
      if (usable(j)) {
        job = j;
        break;
      }
    }
  }
  if (!usable(job)) job = noiseJob(sr, allocFor(ctx), PRIO.live);
  return job.now();
}

/** The reverb IR at `ctx`'s exact rate (a ConvolverNode requirement) as an idle job — `.now()` for a synchronous result. */
export function reverbIR(kind: ReverbKind, ctx: BaseAudioContext, priority: number = PRIO.live): IdleJob<AudioBuffer> {
  return irJob(kind, ctx.sampleRate, allocFor(ctx), priority);
}

/** The live context runs at `sr`: drop prepared data for other rates (cancels their pending work, frees the memory). */
export function keepOnlyRate(sr: number): void {
  for (const [rate, job] of noiseJobs) {
    if (rate === sr) continue;
    job.cancel();
    noiseJobs.delete(rate);
  }
  for (const [key, job] of irJobs) {
    if (key.slice(key.indexOf('@') + 1) === String(sr)) continue;
    job.cancel();
    irJobs.delete(key);
  }
}

function getCurves(): NonNullable<typeof curves> {
  if (!curves) curves = { softClip: makeSoftClipCurve(4096, 0.72, 0.95), drive: makeDriveCurve(2048, 3.2), fuzz: makeFuzzCurve(2048) };
  return curves;
}

function* genNoiseSet(alloc: Alloc, sr: number): JobGen<BufferSet> {
  const white = yield* genNoise(alloc, sr, 'white', 2, 2, 0x51a7e);
  const pink = yield* genNoise(alloc, sr, 'pink', 3, 2, 0x9111c);
  const brown = yield* genNoise(alloc, sr, 'brown', 3, 2, 0xb40a1);
  const crackle = yield* genCrackle(alloc, sr, 2, 0xc4ac);
  const c = getCurves();
  return { sampleRate: sr, white, pink, brown, crackle, curveSoftClip: c.softClip, curveDrive: c.drive, curveFuzz: c.fuzz };
}

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------

/**
 * Sample-loop work is cut into blocks of BLOCK samples per job step (≤ ~2 ms even while the code is still cold —
 * during loading V8's background tier-up is busy with the rest of the game). The loops live in plain functions: V8
 * cannot OSR a hot loop inside a generator. Block processing keeps every operation and its order (filter states and
 * sums carried across blocks), so the output is bit-identical to one-pass processing.
 */
const BLOCK = 16384;

function* genNoise(alloc: Alloc, sr: number, kind: 'white' | 'pink' | 'brown', seconds: number, channels: number, seed: number): JobGen<AudioBuffer> {
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = alloc(channels, len, sr);
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    const rng = new Rng(seed + ch * 7919);
    const st = new Float64Array(7); // pink b0..b6 / brown "last"
    for (let i = 0; i < len; i += BLOCK) {
      noiseBlock(d, i, Math.min(len, i + BLOCK), kind, rng, st);
      yield;
    }
    if (kind !== 'white') {
      yield* genHighpass(d, sr, kind === 'pink' ? 25 : 18);
      yield* genDetrend(d);
    }
    yield* genNormalizeRms(d, kind === 'white' ? 0.5 : 0.3, 0.999);
  }
  return buf;
}

function noiseBlock(d: Float32Array, from: number, to: number, kind: 'white' | 'pink' | 'brown', rng: Rng, st: Float64Array): void {
  if (kind === 'white') {
    for (let i = from; i < to; i++) d[i] = rng.next() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's refined pink filter.
    let b0 = st[0], b1 = st[1], b2 = st[2], b3 = st[3], b4 = st[4], b5 = st[5], b6 = st[6];
    for (let i = from; i < to; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    st[0] = b0;
    st[1] = b1;
    st[2] = b2;
    st[3] = b3;
    st[4] = b4;
    st[5] = b5;
    st[6] = b6;
  } else {
    let last = st[0];
    for (let i = from; i < to; i++) {
      const w = rng.next() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last;
    }
    st[0] = last;
  }
}

/** highpassInPlace, block by block. */
export function* genHighpass(d: Float32Array, sr: number, hz: number): JobGen<void> {
  const st = new Float64Array(2); // prevX, prevY
  for (let i = 0; i < d.length; i += BLOCK) {
    highpassBlock(d, i, Math.min(d.length, i + BLOCK), sr, hz, st);
    yield;
  }
}

function highpassBlock(d: Float32Array, from: number, to: number, sr: number, hz: number, st: Float64Array): void {
  const rc = 1 / (2 * Math.PI * hz);
  const dt = 1 / sr;
  const a = rc / (rc + dt);
  let prevX = st[0];
  let prevY = st[1];
  for (let i = from; i < to; i++) {
    const x = d[i];
    const y = a * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    d[i] = y;
  }
  st[0] = prevX;
  st[1] = prevY;
}

/** detrendLoop, block by block. */
function* genDetrend(d: Float32Array): JobGen<void> {
  const n = d.length;
  if (n < 2) return;
  const a = d[0];
  const slope = (d[n - 1] - a) / (n - 1);
  for (let i = 0; i < n; i += BLOCK) {
    detrendBlock(d, i, Math.min(n, i + BLOCK), a, slope);
    yield;
  }
}

function detrendBlock(d: Float32Array, from: number, to: number, a: number, slope: number): void {
  for (let i = from; i < to; i++) d[i] -= a + slope * i;
}

/** normalizeRms, block by block (same summation order, scale then clamp of the stored value). */
export function* genNormalizeRms(d: Float32Array, targetRms: number, maxPeak: number): JobGen<void> {
  const n = d.length;
  if (!n) return;
  let e = 0;
  for (let i = 0; i < n; i += BLOCK) {
    e = energyBlock(d, i, Math.min(n, i + BLOCK), e);
    yield;
  }
  const rms = Math.sqrt(e / n);
  if (rms <= 0) return;
  const k = targetRms / rms;
  for (let i = 0; i < n; i += BLOCK) {
    scaleClampBlock(d, i, Math.min(n, i + BLOCK), k, maxPeak);
    yield;
  }
}

function energyBlock(d: Float32Array, from: number, to: number, e: number): number {
  for (let i = from; i < to; i++) e += d[i] * d[i];
  return e;
}

function scaleClampBlock(d: Float32Array, from: number, to: number, k: number, maxPeak: number): void {
  for (let i = from; i < to; i++) {
    d[i] *= k;
    const x = d[i];
    if (x > maxPeak) d[i] = maxPeak;
    else if (x < -maxPeak) d[i] = -maxPeak;
  }
}

function* genCrackle(alloc: Alloc, sr: number, seconds: number, seed: number): JobGen<AudioBuffer> {
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = alloc(1, len, sr);
  const d = buf.getChannelData(0);
  const rng = new Rng(seed);
  const clickLen = Math.max(8, Math.floor(sr * 0.0015));
  for (let i = 0; i < len; i += BLOCK) {
    crackleBlock(d, i, Math.min(len, i + BLOCK), rng, 70 / sr, clickLen);
    yield;
  }
  yield* genHighpass(d, sr, 200);
  // normalizePeak(d, 0.95), block by block.
  let p = 0;
  for (let i = 0; i < len; i += BLOCK) {
    p = peakBlock(d, i, Math.min(len, i + BLOCK), p);
    yield;
  }
  if (p > 0) {
    const k = 0.95 / p;
    for (let i = 0; i < len; i += BLOCK) {
      scaleBlock(d, i, Math.min(len, i + BLOCK), k);
      yield;
    }
  }
  return buf;
}

/** Sparse random clicks (70 / s): each a short decaying burst (may spill into the next block, as in one pass). */
function crackleBlock(d: Float32Array, from: number, to: number, rng: Rng, p: number, clickLen: number): void {
  const len = d.length;
  for (let i = from; i < to; i++) {
    if (rng.next() < p) {
      const amp = (0.25 + 0.75 * Math.pow(rng.next(), 2)) * (rng.next() < 0.5 ? -1 : 1);
      const decay = 0.55 + rng.next() * 0.35;
      let a = amp;
      for (let k = 0; k < clickLen && i + k < len; k++) {
        d[i + k] += a * (rng.next() * 2 - 1 + (k === 0 ? 1.5 : 0));
        a *= decay;
      }
    }
  }
}

function peakBlock(d: Float32Array, from: number, to: number, p: number): number {
  for (let i = from; i < to; i++) {
    const a = Math.abs(d[i]);
    if (a > p) p = a;
  }
  return p;
}

function scaleBlock(d: Float32Array, from: number, to: number, k: number): void {
  for (let i = from; i < to; i++) d[i] *= k;
}

// ---------------------------------------------------------------------------------------------
// Reverb impulse responses
// ---------------------------------------------------------------------------------------------

interface IROptions {
  duration: number;
  rt60: number;
  preDelay: number;
  earlyCount: number;
  earlyGain: number;
  earlySpan: number;
  /** One-pole lowpass coefficient at the start / end of the tail (1 = bright, → 0 = dark). */
  dampStart: number;
  dampEnd: number;
  hpHz: number;
  slap: ReadonlyArray<{ time: number; gain: number }>;
  seed: number;
}

function* genReverbIR(alloc: Alloc, sr: number, o: IROptions): JobGen<AudioBuffer> {
  const len = Math.max(1, Math.floor(o.duration * sr));
  const buf = alloc(2, len, sr);
  const pre = Math.floor(o.preDelay * sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = new Rng(o.seed + ch * 104729);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let start = pre; start < len; start += BLOCK) {
      lp = irTail(d, rng, lp, start, Math.min(len, start + BLOCK), pre, sr, o);
      yield;
    }
    irReflections(d, rng, ch, pre, sr, o);
    yield;
    yield* genHighpass(d, sr, o.hpHz);
  }
  // Equalize both channels to the same energy (normalization itself is left to ConvolverNode).
  const e0 = energy(buf.getChannelData(0));
  const e1 = energy(buf.getChannelData(1));
  if (e0 > 0 && e1 > 0) scaleInPlace(buf.getChannelData(1), Math.sqrt(e0 / e1));
  return buf;
}

/** Late diffuse tail, samples [start, stop): decaying noise through a time-varying one-pole lowpass (air absorption). Returns the filter state. */
function irTail(d: Float32Array, rng: Rng, lp: number, start: number, stop: number, pre: number, sr: number, o: IROptions): number {
  const len = d.length;
  const fadeIn = Math.max(1, Math.floor(0.012 * sr));
  const fadeOutStart = Math.floor(len * 0.9);
  for (let i = start; i < stop; i++) {
    const t = (i - pre) / sr;
    const u = (i - pre) / (len - pre);
    const env = Math.pow(10, (-3 * t) / o.rt60) * (i - pre < fadeIn ? (i - pre) / fadeIn : 1) * (i > fadeOutStart ? (len - i) / (len - fadeOutStart) : 1);
    const a = o.dampStart + (o.dampEnd - o.dampStart) * Math.pow(u, 0.6);
    lp += a * (rng.next() * 2 - 1 - lp);
    d[i] = lp * env * (1.2 - a * 0.4);
  }
  return lp;
}

/** Early reflections (sparse, slightly smeared taps) and slap-back echoes off the stands. */
function irReflections(d: Float32Array, rng: Rng, ch: number, pre: number, sr: number, o: IROptions): void {
  const len = d.length;
  for (let k = 0; k < o.earlyCount; k++) {
    const tk = o.preDelay * 0.4 + rng.range(0.003, o.earlySpan);
    const idx = Math.floor(tk * sr);
    const g = o.earlyGain * (1 - (0.7 * k) / o.earlyCount) * rng.range(0.45, 1) * (rng.next() < 0.5 ? -1 : 1);
    for (let s = 0; s < 6 && idx + s < len; s++) d[idx + s] += g * (s === 0 ? 1 : 0.5 * (rng.next() * 2 - 1));
  }
  // Slap-back: a dark copy of the first 80 ms.
  for (const sl of o.slap) {
    const off = Math.floor((sl.time + (ch === 0 ? 0 : 0.011)) * sr);
    const n = Math.floor(0.08 * sr);
    let e = 0;
    for (let i = 0; i < n && off + i < len && pre + i < len; i++) {
      e += 0.25 * (d[pre + i] - e);
      d[off + i] += e * sl.gain * 3;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Wave-shaper curves
// ---------------------------------------------------------------------------------------------

/** Curve for a shaper placed after a ×0.5 pre-gain: maps signal s ∈ [-2, 2] → unity below `knee`, saturating to `ceil`. */
function makeSoftClipCurve(n: number, knee: number, ceil: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const w = ceil - knee;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    const s = u * 2;
    const a = Math.abs(s);
    const y = a <= knee ? a : knee + w * Math.tanh((a - knee) / w);
    c[i] = s < 0 ? -y : y;
  }
  return c;
}

function makeDriveCurve(n: number, k: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

function makeFuzzCurve(n: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Asymmetric soft fuzz (adds even harmonics = "crunch").
    const y = x >= 0 ? 1 - Math.exp(-4 * x) : -(1 - Math.exp(3 * x)) * 0.85;
    c[i] = y;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// DSP helpers (offline, on Float32Arrays). The one-pass versions double as references for the block-wise
// generators above (src/audio/__tests__ checks they are bit-identical).
// ---------------------------------------------------------------------------------------------

/** Remove the start/end step so a looped buffer has no click. */
export function detrendLoop(d: Float32Array): void {
  const n = d.length;
  if (n < 2) return;
  const a = d[0];
  const b = d[n - 1];
  const slope = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) d[i] -= a + slope * i;
}

export function highpassInPlace(d: Float32Array, sr: number, hz: number): void {
  const rc = 1 / (2 * Math.PI * hz);
  const dt = 1 / sr;
  const a = rc / (rc + dt);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = a * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    d[i] = y;
  }
}

export function lowpassInPlace(d: Float32Array, sr: number, hz: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y += a * (d[i] - y);
    d[i] = y;
  }
}

function energy(d: Float32Array): number {
  let e = 0;
  for (let i = 0; i < d.length; i++) e += d[i] * d[i];
  return e;
}

function scaleInPlace(d: Float32Array, k: number): void {
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

export function normalizePeak(d: Float32Array, target: number): void {
  let p = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > p) p = a;
  }
  if (p > 0) scaleInPlace(d, target / p);
}

export function normalizeRms(d: Float32Array, targetRms: number, maxPeak: number): void {
  const n = d.length;
  if (!n) return;
  const rms = Math.sqrt(energy(d) / n);
  if (rms <= 0) return;
  scaleInPlace(d, targetRms / rms);
  for (let i = 0; i < n; i++) {
    const x = d[i];
    if (x > maxPeak) d[i] = maxPeak;
    else if (x < -maxPeak) d[i] = -maxPeak;
  }
}

/** Equal-power crossfade of the tail [len, len+xf) into the head so the first `len` samples loop seamlessly. */
export function foldLoop(src: Float32Array, len: number, xf: number, out: Float32Array): void {
  for (let i = 0; i < len; i++) out[i] = src[i];
  for (let i = 0; i < xf && len + i < src.length; i++) {
    const t = i / xf;
    out[i] = src[i] * Math.sin(t * Math.PI * 0.5) + src[len + i] * Math.cos(t * Math.PI * 0.5);
  }
}
