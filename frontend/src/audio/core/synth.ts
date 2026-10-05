/**
 * NOVABALL audio — synthesis primitives (node factories + envelopes).
 * Used by SFX recipes, engines, crowd and music. All methods are thin and allocation-light.
 */
import type { BufferSet, NoiseKind } from './buffers';
import type { Rng } from './util';

/** A connection target: a node input or an AudioParam (modulation). */
export type Dest = AudioNode | AudioParam;

/**
 * Switch an AudioParam to k-rate (value computed once per 128-frame render quantum).
 * Critical for BiquadFilterNode: with a-rate automation (setTargetAtTime / ramps) Chrome recomputes the filter
 * coefficients (pow / sin / cos) for EVERY sample while the automation is active. k-rate makes filter envelopes and
 * per-frame engine smoothing ~free. Never use on params that receive audio-rate modulation (FM carriers).
 */
export function kRate(p: AudioParam): void {
  try {
    const pp = p as AudioParam & { automationRate?: AutomationRate };
    if (pp.automationRate !== undefined && pp.automationRate !== 'k-rate') pp.automationRate = 'k-rate';
  } catch {
    /* unsupported / constrained */
  }
}

/** Connect src → dest (node or param) without TypeScript overload friction. */
export function wire(src: AudioNode, dest: Dest | null | undefined): void {
  if (!dest) return;
  if (typeof (dest as AudioNode).connect === 'function') src.connect(dest as AudioNode);
  else src.connect(dest as AudioParam);
}

export class Synth {
  constructor(
    readonly ctx: BaseAudioContext,
    readonly buf: BufferSet,
    readonly rng: Rng,
  ) {}

  get now(): number {
    return this.ctx.currentTime;
  }

  gain(value = 1, dest?: Dest | null): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    wire(g, dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7071, dest?: Dest | null, gainDb = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    kRate(f.frequency);
    kRate(f.Q);
    kRate(f.gain);
    kRate(f.detune);
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    wire(f, dest);
    return f;
  }

  pan(value: number, dest?: Dest | null): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = value;
    wire(p, dest);
    return p;
  }

  shaper(curve: Float32Array<ArrayBuffer>, dest?: Dest | null, oversample: OverSampleType = 'none'): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = curve;
    s.oversample = oversample;
    wire(s, dest);
    return s;
  }

  /**
   * Oscillator started at t0 and stopped at t1 (t1 <= 0 → runs until stopped manually).
   * Pitch params are k-rate (cheap) unless `audioRatePitch` (FM carriers / audio-rate pitch modulation).
   */
  osc(type: OscillatorType, freq: number, t0: number, t1: number, dest: Dest | null, detune = 0, audioRatePitch = false): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (!audioRatePitch) {
      kRate(o.frequency);
      kRate(o.detune);
    }
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    wire(o, dest);
    o.start(t0);
    if (t1 > 0) o.stop(t1);
    return o;
  }

  noiseBuffer(kind: NoiseKind): AudioBuffer {
    switch (kind) {
      case 'white':
        return this.buf.white;
      case 'pink':
        return this.buf.pink;
      case 'brown':
        return this.buf.brown;
      default:
        return this.buf.crackle;
    }
  }

  /** Noise source from a random offset, playing [t0, t0+dur] (dur <= 0 → loop forever). */
  noise(kind: NoiseKind, t0: number, dur: number, dest: Dest | null, rate = 1): AudioBufferSourceNode {
    const b = this.noiseBuffer(kind);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    if (rate !== 1) s.playbackRate.value = rate;
    wire(s, dest);
    const D = b.duration;
    if (dur > 0 && dur * rate + 0.05 < D) {
      s.start(t0, this.rng.next() * (D - dur * rate - 0.05));
      s.stop(t0 + dur);
    } else {
      s.loop = true;
      s.start(t0, this.rng.next() * D * 0.9);
      if (dur > 0) s.stop(t0 + dur);
    }
    return s;
  }

  /** Percussive envelope: 0 → peak (linear, `attack` s) → exponential decay (time constant tau). Returns the ≈ -60 dB end time. */
  perc(p: AudioParam, t0: number, peak: number, attack: number, tau: number): number {
    const a = attack > 0.0005 ? attack : 0.0005;
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + a);
    p.setTargetAtTime(0, t0 + a, tau);
    return t0 + a + tau * 7;
  }

  /** Attack (linear) → hold → exponential release. Returns end time. */
  ahr(p: AudioParam, t0: number, peak: number, attack: number, hold: number, releaseTau: number): number {
    const a = attack > 0.0005 ? attack : 0.0005;
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + a);
    p.setValueAtTime(peak, t0 + a + hold);
    p.setTargetAtTime(0, t0 + a + hold, releaseTau);
    return t0 + a + hold + releaseTau * 7;
  }

  /** Swell: exponential-ish rise (setTarget) to peak over `rise` s, then release. Great for risers / reverse sounds. */
  swell(p: AudioParam, t0: number, peak: number, rise: number, releaseTau: number, cut = false): number {
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(peak, t0 + rise);
    if (cut) {
      p.linearRampToValueAtTime(0, t0 + rise + 0.012);
      return t0 + rise + 0.02;
    }
    p.setTargetAtTime(0, t0 + rise, releaseTau);
    return t0 + rise + releaseTau * 7;
  }

  /** Exponential sweep (both > 0). */
  sweep(p: AudioParam, t0: number, from: number, to: number, dur: number): void {
    p.setValueAtTime(from, t0);
    p.exponentialRampToValueAtTime(to, t0 + (dur > 0.001 ? dur : 0.001));
  }

  /** Exponential approach sweep from → to with time constant tau (never "arrives": natural pitch drops). */
  glide(p: AudioParam, t0: number, from: number, to: number, tau: number): void {
    p.setValueAtTime(from, t0);
    p.setTargetAtTime(to, t0, tau);
  }

  /**
   * Two-operator FM tone: carrier (sine) frequency-modulated by a sine at carrier×ratio.
   * The modulation index (in Hz of deviation = index × modFreq) decays with `indexTau`. Returns the carrier.
   */
  fm(freq: number, ratio: number, index: number, t0: number, t1: number, indexTau: number, dest: AudioNode): OscillatorNode {
    const car = this.osc('sine', freq, t0, t1, dest, 0, true);
    const modF = freq * ratio;
    const mod = this.osc('sine', modF, t0, t1, null);
    const mg = this.gain(0, car.frequency);
    mod.connect(mg);
    mg.gain.setValueAtTime(index * modF, t0);
    mg.gain.setTargetAtTime(0, t0 + 0.001, indexTau);
    return car;
  }
}
