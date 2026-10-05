/**
 * Idle-time audio preparation (AU-1): the cooperative job queue, and bit-exactness of the block-wise synthesis
 * (noise sets, crackle, reverb IRs) against the original one-pass implementation, kept verbatim below as reference.
 */
import { describe, expect, it } from 'vitest';
import { getBuffers, genHighpass, genNormalizeRms, highpassInPlace, detrendLoop, normalizePeak, normalizeRms, reverbIR } from '../core/buffers';
import { IdleQueue, type JobGen } from '../core/idle';
import { Rng } from '../core/util';

// ---------------------------------------------------------------------------------------------
// Minimal AudioBuffer / context stand-ins (Node has no Web Audio)
// ---------------------------------------------------------------------------------------------

class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number): Float32Array {
    return this.data[c];
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
}
const fakeCtx = (sampleRate: number) => ({ sampleRate, createBuffer: (c: number, l: number, r: number) => new FakeBuffer(c, l, r) }) as unknown as BaseAudioContext;
const run = (gen: JobGen<void>) => {
  while (!gen.next().done) {
    /* drain */
  }
};

// ---------------------------------------------------------------------------------------------
// Reference: the pre-AU-1 one-pass synthesis (verbatim)
// ---------------------------------------------------------------------------------------------

function refNoise(sr: number, kind: 'white' | 'pink' | 'brown', seconds: number, channels: number, seed: number): FakeBuffer {
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = new FakeBuffer(channels, len, sr);
  for (let ch = 0; ch < channels; ch++) {
    const rng = new Rng(seed + ch * 7919);
    const d = buf.getChannelData(ch);
    if (kind === 'white') {
      for (let i = 0; i < len; i++) d[i] = rng.next() * 2 - 1;
    } else if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
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
      highpassInPlace(d, sr, 25);
      detrendLoop(d);
    } else {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = rng.next() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last;
      }
      highpassInPlace(d, sr, 18);
      detrendLoop(d);
    }
    normalizeRms(d, kind === 'white' ? 0.5 : 0.3, 0.999);
  }
  return buf;
}

function refCrackle(sr: number, seconds: number, seed: number): FakeBuffer {
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = new FakeBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rng = new Rng(seed);
  const p = 70 / sr;
  const clickLen = Math.max(8, Math.floor(sr * 0.0015));
  for (let i = 0; i < len; i++) {
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
  highpassInPlace(d, sr, 200);
  normalizePeak(d, 0.95);
  return buf;
}

interface IROpt {
  duration: number;
  rt60: number;
  preDelay: number;
  earlyCount: number;
  earlyGain: number;
  earlySpan: number;
  dampStart: number;
  dampEnd: number;
  hpHz: number;
  slap: ReadonlyArray<{ time: number; gain: number }>;
  seed: number;
}
const REF_IR: Record<'stadium' | 'hall', IROpt> = {
  stadium: { duration: 2.6, rt60: 2.3, preDelay: 0.018, earlyCount: 14, earlyGain: 0.55, earlySpan: 0.085, dampStart: 0.62, dampEnd: 0.07, hpHz: 110, slap: [{ time: 0.19, gain: 0.22 }, { time: 0.37, gain: 0.11 }], seed: 0x57ad },
  hall: { duration: 2.4, rt60: 2.1, preDelay: 0.024, earlyCount: 8, earlyGain: 0.25, earlySpan: 0.05, dampStart: 0.8, dampEnd: 0.22, hpHz: 160, slap: [], seed: 0x4a11 },
};

function refReverbIR(sr: number, o: IROpt): FakeBuffer {
  const len = Math.max(1, Math.floor(o.duration * sr));
  const buf = new FakeBuffer(2, len, sr);
  const pre = Math.floor(o.preDelay * sr);
  const fadeIn = Math.max(1, Math.floor(0.012 * sr));
  const fadeOutStart = Math.floor(len * 0.9);
  for (let ch = 0; ch < 2; ch++) {
    const rng = new Rng(o.seed + ch * 104729);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const u = (i - pre) / (len - pre);
      const env = Math.pow(10, (-3 * t) / o.rt60) * (i - pre < fadeIn ? (i - pre) / fadeIn : 1) * (i > fadeOutStart ? (len - i) / (len - fadeOutStart) : 1);
      const a = o.dampStart + (o.dampEnd - o.dampStart) * Math.pow(u, 0.6);
      lp += a * (rng.next() * 2 - 1 - lp);
      d[i] = lp * env * (1.2 - a * 0.4);
    }
    for (let k = 0; k < o.earlyCount; k++) {
      const tk = o.preDelay * 0.4 + rng.range(0.003, o.earlySpan);
      const idx = Math.floor(tk * sr);
      const g = o.earlyGain * (1 - (0.7 * k) / o.earlyCount) * rng.range(0.45, 1) * (rng.next() < 0.5 ? -1 : 1);
      for (let s = 0; s < 6 && idx + s < len; s++) d[idx + s] += g * (s === 0 ? 1 : 0.5 * (rng.next() * 2 - 1));
    }
    for (const sl of o.slap) {
      const off = Math.floor((sl.time + (ch === 0 ? 0 : 0.011)) * sr);
      const n = Math.floor(0.08 * sr);
      let e = 0;
      for (let i = 0; i < n && off + i < len && pre + i < len; i++) {
        e += 0.25 * (d[pre + i] - e);
        d[off + i] += e * sl.gain * 3;
      }
    }
    highpassInPlace(d, sr, o.hpHz);
  }
  const energy = (d: Float32Array) => {
    let e = 0;
    for (let i = 0; i < d.length; i++) e += d[i] * d[i];
    return e;
  };
  const e0 = energy(buf.getChannelData(0));
  const e1 = energy(buf.getChannelData(1));
  if (e0 > 0 && e1 > 0) {
    const k = Math.sqrt(e0 / e1);
    const d1 = buf.getChannelData(1);
    for (let i = 0; i < d1.length; i++) d1[i] *= k;
  }
  return buf;
}

/** Index of the first differing sample (bitwise, NaN-safe), or -1. */
function firstDiff(a: { numberOfChannels: number; getChannelData(c: number): Float32Array }, b: { numberOfChannels: number; getChannelData(c: number): Float32Array }): number {
  if (a.numberOfChannels !== b.numberOfChannels) return 0;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = new Uint32Array(a.getChannelData(c).buffer);
    const y = new Uint32Array(b.getChannelData(c).buffer);
    if (x.length !== y.length) return 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return c * 1e9 + i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('IdleQueue', () => {
  function* counter(log: string[], name: string, steps: number): JobGen<string> {
    for (let i = 0; i < steps; i++) {
      log.push(`${name}${i}`);
      yield;
    }
    return name;
  }

  it('runs jobs by priority (FIFO within a priority) and resolves their promises', async () => {
    const q = new IdleQueue();
    const log: string[] = [];
    const a = q.run('a', counter(log, 'a', 2), 1);
    const b = q.run('b', counter(log, 'b', 2), 5);
    const c = q.run('c', counter(log, 'c', 1), 5);
    await expect(Promise.all([a.promise, b.promise, c.promise])).resolves.toEqual(['a', 'b', 'c']);
    // b and c (priority 5) complete before a starts; b before c (FIFO).
    expect(log.indexOf('b1')).toBeLessThan(log.indexOf('c0'));
    expect(log.indexOf('c0')).toBeLessThan(log.indexOf('a0'));
    expect(q.pending).toBe(0);
    expect(q.stats.slices).toBeGreaterThan(0);
  });

  it('now() finishes a job synchronously; cancel() and failures reject without throwing elsewhere', async () => {
    const q = new IdleQueue();
    const log: string[] = [];
    const j = q.run('j', counter(log, 'j', 5), 0);
    expect(j.now()).toBe('j');
    expect(log).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
    expect(j.done && j.ok).toBe(true);
    expect(q.pending).toBe(0);
    expect(q.stats.syncMs).toBeGreaterThanOrEqual(0);

    const k = q.run('k', counter([], 'k', 100), 0);
    k.cancel();
    await expect(k.promise).rejects.toThrow(/cancelled/);
    expect(q.pending).toBe(0);

    function* boom(): JobGen<number> {
      yield;
      throw new Error('boom');
    }
    const f = q.run('f', boom(), 0);
    await expect(f.promise).rejects.toThrow('boom');
    expect(() => f.now()).toThrow('boom');
  });

  it('flush() drains everything', () => {
    const q = new IdleQueue();
    const log: string[] = [];
    q.run('x', counter(log, 'x', 3), 0);
    q.run('y', counter(log, 'y', 3), 9);
    q.flush();
    expect(q.pending).toBe(0);
    expect(log).toEqual(['y0', 'y1', 'y2', 'x0', 'x1', 'x2']);
  });
});

describe('block-wise DSP is bit-identical to one-pass', () => {
  const rnd = (n: number, seed: number) => {
    const r = new Rng(seed);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = (r.next() * 2 - 1) * 0.7 + 0.1;
    return d;
  };
  it('high-pass and RMS normalization (length not a multiple of the block)', () => {
    for (const n of [1, 100, 16384, 50001]) {
      const a = rnd(n, n);
      const b = a.slice();
      highpassInPlace(a, 44100, 120);
      run(genHighpass(b, 44100, 120));
      expect(firstDiff({ numberOfChannels: 1, getChannelData: () => a }, { numberOfChannels: 1, getChannelData: () => b })).toBe(-1);
      normalizeRms(a, 0.2, 0.3);
      run(genNormalizeRms(b, 0.2, 0.3));
      expect(firstDiff({ numberOfChannels: 1, getChannelData: () => a }, { numberOfChannels: 1, getChannelData: () => b })).toBe(-1);
    }
  });

  for (const sr of [48000, 44100]) {
    it(`noise set, crackle and reverb IRs @ ${sr} Hz match the one-pass reference`, () => {
      const ctx = fakeCtx(sr);
      const set = getBuffers(ctx);
      expect(set.sampleRate).toBe(sr);
      expect(firstDiff(set.white as unknown as FakeBuffer, refNoise(sr, 'white', 2, 2, 0x51a7e))).toBe(-1);
      expect(firstDiff(set.pink as unknown as FakeBuffer, refNoise(sr, 'pink', 3, 2, 0x9111c))).toBe(-1);
      expect(firstDiff(set.brown as unknown as FakeBuffer, refNoise(sr, 'brown', 3, 2, 0xb40a1))).toBe(-1);
      expect(firstDiff(set.crackle as unknown as FakeBuffer, refCrackle(sr, 2, 0xc4ac))).toBe(-1);
      expect(firstDiff(reverbIR('stadium', ctx).now() as unknown as FakeBuffer, refReverbIR(sr, REF_IR.stadium))).toBe(-1);
      expect(firstDiff(reverbIR('hall', ctx).now() as unknown as FakeBuffer, refReverbIR(sr, REF_IR.hall))).toBe(-1);
      // Cached: the same objects on the next request.
      expect(getBuffers(ctx)).toBe(set);
    });
  }

  it('a live context at an uncommon rate reuses a prepared set instead of synthesizing inline', () => {
    getBuffers(fakeCtx(48000)); // prepared (above or here)
    const set = getBuffers(fakeCtx(96000), false);
    expect(set.sampleRate).toBe(48000);
    // Offline / exact requests still get their own rate.
    expect(getBuffers(fakeCtx(22050)).sampleRate).toBe(22050);
  });
});
