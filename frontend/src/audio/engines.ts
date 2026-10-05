/**
 * NOVABALL audio — continuous (long-lived) voices driven every frame by AudioSystem.update():
 *   PlayerEngine — layered hover-turbine: detuned saw hum + sub, throttle grit, mag-lev whine, hover rumble,
 *                  powerslide scrape, boost roar (band noise + rumble + sub + flame crackle), supersonic whistle, wind.
 *   NpcEngine    — lighter spatialized engine for the nearest other cars (+ boost), with Doppler.
 *   BallVoice    — the Nova Core: charge hum (throbbing SUPERNOVA) + crackle + fly-by whoosh, spatialized.
 *   SurgeHum     — the stadium-wide ZERO-G ambience while a surge is active.
 * All nodes are created once; per-frame work is only a handful of setTargetAtTime calls (deduplicated).
 */
import { BALL, CAR } from '../sim/constants';
import type { BallSnapshot, CarSnapshot } from '../sim/types';
import type { SpatialResult } from './core/spatial';
import { kRate, type Dest, type Synth } from './core/synth';
import { SmoothParam, clamp01, disconnect, stopSource } from './core/util';

/**
 * One pitch control for several oscillators: a ConstantSourceNode (the fundamental) feeds each oscillator's
 * frequency through a fixed-ratio gain, so a single automation call per frame retunes a whole engine
 * (main-thread automation calls cost ~1.5 µs each on a live context). Falls back to per-oscillator params.
 */
class PitchBus {
  private readonly param: SmoothParam | null = null;
  private readonly fallback: Array<[SmoothParam, number]> = [];

  constructor(s: Synth, targets: ReadonlyArray<readonly [OscillatorNode, number]>, tau: number, nodes: AudioNode[], sources: AudioScheduledSourceNode[]) {
    const ctx = s.ctx as BaseAudioContext & { createConstantSource?: () => ConstantSourceNode };
    if (typeof ctx.createConstantSource === 'function') {
      const cs = ctx.createConstantSource();
      kRate(cs.offset);
      cs.offset.value = 60;
      cs.start(s.now);
      sources.push(cs);
      for (const [osc, ratio] of targets) {
        osc.frequency.value = 0;
        if (ratio === 1) cs.connect(osc.frequency);
        else {
          const g = s.gain(ratio, osc.frequency);
          nodes.push(g);
          cs.connect(g);
        }
      }
      this.param = new SmoothParam(cs.offset, tau, 0.01, 0.003);
    } else {
      for (const [osc, ratio] of targets) this.fallback.push([new SmoothParam(osc.frequency, tau, 0.01, 0.003), ratio]);
    }
  }

  set(f0: number, now: number): void {
    if (this.param) this.param.set(f0, now);
    else for (const [p, r] of this.fallback) p.set(f0 * r, now);
  }
}

/** Connect/disconnect helper: idle voices are detached from the graph so they cost no DSP. */
abstract class PersistentVoice {
  protected readonly out: GainNode;
  protected readonly outGain: SmoothParam;
  protected readonly sources: AudioScheduledSourceNode[] = [];
  protected readonly nodes: AudioNode[] = [];
  private attached = false;
  private silentSince = -1;

  protected constructor(
    protected readonly s: Synth,
    protected readonly dest: AudioNode,
  ) {
    this.out = s.gain(0, null);
    this.outGain = new SmoothParam(this.out.gain, 0.06, 2e-4);
  }

  protected osc(type: OscillatorType, f: number, dest: Dest | null, detune = 0): OscillatorNode {
    const o = this.s.osc(type, f, this.s.now, 0, dest, detune);
    this.sources.push(o);
    return o;
  }

  protected loop(kind: 'white' | 'pink' | 'brown' | 'crackle', dest: Dest | null, rate = 1): AudioBufferSourceNode {
    const n = this.s.noise(kind, this.s.now, 0, dest, rate);
    this.sources.push(n);
    return n;
  }

  protected track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Set the output level; attaches when audible, detaches (disconnects `out`) after ~0.6 s of silence. */
  protected level(now: number, g: number, tau?: number): void {
    if (g > 1e-4) {
      if (!this.attached) {
        this.out.connect(this.dest);
        this.onAttach();
        this.attached = true;
      }
      this.silentSince = -1;
    } else if (this.attached) {
      if (this.silentSince < 0) this.silentSince = now;
      else if (now - this.silentSince > 0.6) {
        disconnect(this.out);
        this.attached = false;
      }
    }
    this.outGain.set(g, now, tau);
  }

  /** Extra outgoing connections from `out` (e.g. reverb sends), re-made on every attach. */
  protected onAttach(): void {}

  /** Fade to silence (and detach once silent for a while — call repeatedly). */
  silence(now: number): void {
    this.level(now, 0, 0.1);
  }

  get isAttached(): boolean {
    return this.attached;
  }

  dispose(): void {
    for (const src of this.sources) stopSource(src);
    disconnect(this.out, ...this.sources, ...this.nodes);
    this.sources.length = 0;
    this.nodes.length = 0;
    this.attached = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Player engine
// ---------------------------------------------------------------------------------------------

/** Overall player-engine level (idle ≈ -32 dBFS short-term at default volumes; boost ≈ -20). */
const PLAYER_ENGINE_LEVEL = 0.25;

export class PlayerEngine extends PersistentVoice {
  private readonly pitch: PitchBus;
  private readonly bodyLP: SmoothParam;
  private readonly bodyGain: SmoothParam;
  private readonly gritGain: SmoothParam;
  private readonly whineGain: SmoothParam;
  private readonly hoverGain: SmoothParam;
  private readonly slideGain: SmoothParam;
  private readonly slideBP: SmoothParam;
  private readonly boostBus: SmoothParam;
  private readonly boostBP: SmoothParam;
  private readonly boostSub: SmoothParam;
  private readonly ssTone: SmoothParam;
  private readonly ssNoise: SmoothParam;
  private readonly windBP: SmoothParam;
  private readonly windGain: SmoothParam;

  private speedSm = 0;

  constructor(s: Synth, dest: AudioNode) {
    super(s, dest);
    const out = this.out;
    const tr = <T extends AudioNode>(n: T) => this.track(n);

    // Core hum: two detuned saws (low-passed) + triangle sub.
    const bodyGain = tr(s.gain(0.16, out));
    const bodyLP = tr(s.filter('lowpass', 400, 1.3, bodyGain));
    const sawA = this.osc('sawtooth', 45, bodyLP, -8);
    const sawB = this.osc('sawtooth', 45, bodyLP, 8);
    const subG = tr(s.gain(0.55, bodyGain));
    const sub = this.osc('triangle', 22.5, subG);
    // Throttle grit: saw A → drive → high-pass → gain.
    const gritGain = tr(s.gain(0, out));
    const gritHP = tr(s.filter('highpass', 900, 0.7, gritGain));
    const gritSh = tr(s.shaper(s.buf.curveDrive, gritHP));
    const gritPre = tr(s.gain(2.4, gritSh));
    sawA.connect(gritPre);
    // Mag-lev whine: two sines a fifth apart with vibrato.
    const whineGain = tr(s.gain(0, out));
    const wA = this.osc('sine', 700, whineGain);
    const wB = this.osc('sine', 1050, whineGain);
    const vib = tr(s.gain(9, null));
    this.osc('sine', 5.7, vib);
    vib.connect(wA.detune);
    vib.connect(wB.detune);
    // Hover field rumble (brown noise, low-passed).
    const hoverGain = tr(s.gain(0, out));
    const hoverLP = tr(s.filter('lowpass', 210, 0.9, hoverGain));
    const brown = this.loop('brown', hoverLP);
    // Powerslide scrape (white noise band).
    const white = this.loop('white', null);
    const slideGain = tr(s.gain(0, out));
    const slideBP = tr(s.filter('bandpass', 2300, 1.4, slideGain));
    white.connect(slideBP);
    // Boost roar bus.
    const boostBus = tr(s.gain(0, out));
    const bpG = tr(s.gain(2.2, boostBus));
    const boostBP = tr(s.filter('bandpass', 900, 0.75, bpG));
    white.connect(boostBP);
    const hissG = tr(s.gain(0.2, boostBus));
    const hissHP = tr(s.filter('highpass', 4200, 0.7, hissG));
    white.connect(hissHP);
    const rumbleG = tr(s.gain(0.5, boostBus));
    const rumbleLP = tr(s.filter('lowpass', 170, 0.9, rumbleG));
    brown.connect(rumbleLP);
    const subBoostG = tr(s.gain(0.2, boostBus));
    const boostSub = this.osc('sine', 46, subBoostG);
    const crG = tr(s.gain(0.6, boostBus));
    const crBP = tr(s.filter('bandpass', 2600, 0.8, crG));
    this.loop('crackle', crBP, 0.8);
    // Supersonic: whistle + high air tear.
    const ssToneG = tr(s.gain(0, out));
    this.osc('sine', 2217.5, ssToneG);
    this.osc('sine', 3322.4, ssToneG);
    const ssNoiseG = tr(s.gain(0, out));
    const ssHP = tr(s.filter('highpass', 5500, 0.7, ssNoiseG));
    white.connect(ssHP);
    // Wind rush.
    const windGain = tr(s.gain(0, out));
    const windBP = tr(s.filter('bandpass', 500, 0.6, windGain));
    this.loop('pink', windBP);

    // Fundamental f0 drives: saws ×1, sub ×½, mag-lev whine ×14.5 and its fifth ×21.75.
    this.pitch = new PitchBus(s, [[sawA, 1], [sawB, 1], [sub, 0.5], [wA, 14.5], [wB, 21.75]], 0.07, this.nodes, this.sources);
    this.bodyLP = new SmoothParam(bodyLP.frequency, 0.06, 1, 0.015);
    this.bodyGain = new SmoothParam(bodyGain.gain, 0.08);
    this.gritGain = new SmoothParam(gritGain.gain, 0.06);
    this.whineGain = new SmoothParam(whineGain.gain, 0.1);
    this.hoverGain = new SmoothParam(hoverGain.gain, 0.08);
    this.slideGain = new SmoothParam(slideGain.gain, 0.05);
    this.slideBP = new SmoothParam(slideBP.frequency, 0.08, 1, 0.015);
    this.boostBus = new SmoothParam(boostBus.gain, 0.03);
    this.boostBP = new SmoothParam(boostBP.frequency, 0.08, 1, 0.015);
    this.boostSub = new SmoothParam(boostSub.frequency, 0.1, 0.05, 0.005);
    this.ssTone = new SmoothParam(ssToneG.gain, 0.12);
    this.ssNoise = new SmoothParam(ssNoiseG.gain, 0.1);
    this.windBP = new SmoothParam(windBP.frequency, 0.1, 1, 0.015);
    this.windGain = new SmoothParam(windGain.gain, 0.1);
  }

  /** car = null → silent. P: pitch scale (slow-mo). */
  update(now: number, dt: number, car: CarSnapshot | null, P: number): void {
    if (!car || car.demolished) {
      this.level(now, 0, 0.05);
      return;
    }
    const v = car.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.05) : 1;
    this.speedSm += (speed - this.speedSm) * k;
    const sp = clamp01(this.speedSm / CAR.maxSpeed);
    const thr = Math.min(1, Math.abs(car.throttle));
    const air = !car.onGround;
    const boost = car.boosting;
    const slide = car.powersliding && car.onGround;

    let f0 = 40 + 72 * Math.pow(sp, 0.9);
    f0 *= 1 + 0.08 * thr * (1 - sp) + (air ? 0.05 : 0) + (boost ? 0.05 : 0);
    f0 *= P;
    this.pitch.set(f0, now);
    const load = 0.25 + 0.55 * thr + (boost ? 0.35 : 0);
    this.bodyLP.set(Math.min(9000, f0 * (3.2 + 8 * load + 5 * sp)), now);
    this.bodyGain.set(0.15 + 0.09 * sp + 0.05 * thr, now);
    this.gritGain.set(0.05 * thr * (0.25 + sp) + (boost ? 0.025 : 0), now);
    this.whineGain.set(0.011 + 0.02 * sp + (air ? 0.008 : 0), now);
    this.hoverGain.set((air ? 0.025 : 0.11) * (0.75 + 0.25 * sp), now);
    this.slideGain.set(slide ? 0.06 + 0.1 * sp : 0, now, 0.04);
    this.slideBP.set((1800 + 1400 * sp) * P, now);
    this.boostBus.set(boost ? 1 : 0, now, boost ? 0.025 : 0.1);
    this.boostBP.set((650 + 750 * sp) * P, now);
    this.boostSub.set((44 + 14 * sp) * P, now);
    const ss = car.supersonic;
    this.ssTone.set(ss ? 0.03 : 0, now);
    this.ssNoise.set(ss ? 0.07 : 0, now);
    this.windBP.set((330 + 2700 * Math.pow(sp, 1.3)) * P, now);
    this.windGain.set(0.6 * sp * sp + (air ? 0.12 * sp : 0), now);
    this.level(now, PLAYER_ENGINE_LEVEL, 0.08);
  }
}

// ---------------------------------------------------------------------------------------------
// NPC engine (spatialized, lighter)
// ---------------------------------------------------------------------------------------------

export class NpcEngine extends PersistentVoice {
  carId = -1;
  private readonly pitch: PitchBus;
  private readonly lp: SmoothParam;
  private readonly whineGain: SmoothParam;
  private readonly boostGain: SmoothParam;
  private readonly boostBP: SmoothParam;
  private readonly airLP: SmoothParam;
  private readonly pan: SmoothParam;
  private readonly send: SmoothParam;
  private readonly sendNode: GainNode;

  constructor(s: Synth, dest: AudioNode, reverb: AudioNode, seed: number) {
    super(s, dest);
    const tr = <T extends AudioNode>(n: T) => this.track(n);
    // sources → vca → airLP → panner → out (distance level) → dest, and out → send → reverb.
    const vca = tr(s.gain(1, null));
    const airLP = tr(s.filter('lowpass', 12000, 0.5, null));
    const panner = tr(s.pan(0, this.out));
    vca.connect(airLP);
    airLP.connect(panner);
    this.sendNode = tr(s.gain(0.2, reverb));
    const bodyGain = tr(s.gain(0.2, vca));
    const lp = tr(s.filter('lowpass', 500, 1.2, bodyGain));
    const det = ((seed * 37) % 11) - 5;
    const saw = this.osc('sawtooth', 50, lp, det);
    const subG = tr(s.gain(0.5, bodyGain));
    const sub = this.osc('triangle', 25, subG);
    const whineGain = tr(s.gain(0, vca));
    const whine = this.osc('sine', 800, whineGain);
    const boostGain = tr(s.gain(0, vca));
    const boostBP = tr(s.filter('bandpass', 900, 0.8, boostGain));
    this.loop('white', boostBP);
    // Distant voices: one pitch control and coarser change thresholds (fewer automation calls).
    this.pitch = new PitchBus(s, [[saw, 1], [sub, 0.5], [whine, 15]], 0.06, this.nodes, this.sources);
    this.lp = new SmoothParam(lp.frequency, 0.06, 1, 0.04);
    this.whineGain = new SmoothParam(whineGain.gain, 0.1, 5e-4, 0.04);
    this.boostGain = new SmoothParam(boostGain.gain, 0.04);
    this.boostBP = new SmoothParam(boostBP.frequency, 0.08, 1, 0.04);
    this.airLP = new SmoothParam(airLP.frequency, 0.05, 1, 0.05);
    this.pan = new SmoothParam(panner.pan, 0.05, 0.03, 0);
    this.send = new SmoothParam(this.sendNode.gain, 0.1, 5e-3, 0.05);
  }

  protected override onAttach(): void {
    this.out.connect(this.sendNode);
  }

  /** level: extra linear gain (e.g. rank among the nearest cars). */
  update(now: number, car: CarSnapshot | null, sp: SpatialResult | null, doppler: number, P: number, level: number): void {
    if (!car || car.demolished || !sp) {
      this.level(now, 0, 0.05);
      return;
    }
    const v = car.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const s01 = clamp01(speed / CAR.maxSpeed);
    const thr = Math.min(1, Math.abs(car.throttle));
    const f0 = (40 + 72 * Math.pow(s01, 0.9)) * (1 + (car.onGround ? 0 : 0.05) + (car.boosting ? 0.05 : 0)) * doppler * P;
    this.pitch.set(f0, now);
    this.lp.set(Math.min(8000, f0 * (4 + 7 * thr + 4 * s01 + (car.boosting ? 3 : 0))), now);
    this.whineGain.set(0.012 + 0.02 * s01, now);
    this.boostGain.set(car.boosting ? 1.4 : 0, now, car.boosting ? 0.03 : 0.1);
    this.boostBP.set((650 + 750 * s01) * doppler * P, now);
    this.airLP.set(sp.cutoff, now);
    this.pan.set(sp.pan, now);
    this.send.set(sp.send * 0.6, now);
    this.level(now, sp.gain * level * (0.55 + 0.45 * s01), 0.05);
  }
}

// ---------------------------------------------------------------------------------------------
// Ball voice (Nova Core)
// ---------------------------------------------------------------------------------------------

const HUM_FREQ = [110, 110, 164.81, 220];
const HUM_GAIN = [0, 0.035, 0.05, 0.07];

export class BallVoice extends PersistentVoice {
  private readonly humA: SmoothParam;
  private readonly humB: SmoothParam;
  private readonly humLP: SmoothParam;
  private readonly humGain: SmoothParam;
  private readonly throb: SmoothParam;
  private readonly crackle: SmoothParam;
  private readonly whooshBP: SmoothParam;
  private readonly whooshGain: SmoothParam;
  private readonly airLP: SmoothParam;
  private readonly pan: SmoothParam;

  constructor(s: Synth, dest: AudioNode) {
    super(s, dest);
    const tr = <T extends AudioNode>(n: T) => this.track(n);
    const vca = tr(s.gain(1, null));
    const airLP = tr(s.filter('lowpass', 12000, 0.5, null));
    const panner = tr(s.pan(0, this.out));
    vca.connect(airLP);
    airLP.connect(panner);
    // Charge hum with a throb LFO (depth raised for SUPERNOVA).
    const humGain = tr(s.gain(0, vca));
    const trem = tr(s.gain(1, humGain));
    const throb = tr(s.gain(0, trem.gain));
    this.osc('sine', 4.2, throb);
    const humLP = tr(s.filter('lowpass', 600, 2.5, trem));
    const a = this.osc('sawtooth', 110, humLP, -6);
    const b = this.osc('sawtooth', 110 * 1.5, humLP, 6);
    // Electric crackle.
    const crG = tr(s.gain(0, vca));
    const crHP = tr(s.filter('highpass', 3000, 0.7, crG));
    this.loop('crackle', crHP, 1.3);
    // Fly-by whoosh.
    const whG = tr(s.gain(0, vca));
    const whBP = tr(s.filter('bandpass', 800, 0.9, whG));
    this.loop('pink', whBP);
    this.humA = new SmoothParam(a.frequency, 0.15, 0.05, 0.003);
    this.humB = new SmoothParam(b.frequency, 0.15, 0.05, 0.003);
    this.humLP = new SmoothParam(humLP.frequency, 0.2, 1, 0.015);
    this.humGain = new SmoothParam(humGain.gain, 0.25);
    this.throb = new SmoothParam(throb.gain, 0.3);
    this.crackle = new SmoothParam(crG.gain, 0.2);
    this.whooshBP = new SmoothParam(whBP.frequency, 0.05, 1, 0.015);
    this.whooshGain = new SmoothParam(whG.gain, 0.05);
    this.airLP = new SmoothParam(airLP.frequency, 0.05, 1, 0.03);
    this.pan = new SmoothParam(panner.pan, 0.04, 0.01, 0);
  }

  update(now: number, ball: BallSnapshot, sp: SpatialResult, doppler: number, P: number): void {
    if (!ball.visible) {
      this.level(now, 0, 0.05);
      return;
    }
    const lv = ball.charge < 0 ? 0 : ball.charge > 3 ? 3 : ball.charge | 0;
    const v = ball.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const hum = HUM_GAIN[lv];
    this.humA.set(HUM_FREQ[lv] * P, now);
    this.humB.set(HUM_FREQ[lv] * 1.5 * P, now);
    this.humLP.set((350 + 650 * lv) * P, now);
    this.humGain.set(hum, now);
    this.throb.set(lv >= 3 ? 0.6 : lv === 2 ? 0.25 : 0, now);
    this.crackle.set(lv >= 3 ? 0.16 : lv === 2 ? 0.05 : 0, now);
    const w = clamp01((speed - 10) / (BALL.maxSpeed - 15));
    this.whooshGain.set(0.5 * w * w, now);
    this.whooshBP.set((450 + speed * 38) * doppler * P, now);
    this.airLP.set(sp.cutoff, now);
    this.pan.set(sp.pan, now);
    // Only audible when there is something to hear.
    const audible = hum > 0 || w > 0.01;
    this.level(now, audible ? sp.gain : 0, 0.06);
  }
}

// ---------------------------------------------------------------------------------------------
// Surge ambience
// ---------------------------------------------------------------------------------------------

export class SurgeHum extends PersistentVoice {
  constructor(s: Synth, dest: AudioNode) {
    super(s, dest);
    const tr = <T extends AudioNode>(n: T) => this.track(n);
    // Low drone (A1 / E2 / A2) with slow tremolo.
    const humGain = tr(s.gain(0.5, this.out));
    const trem = tr(s.gain(0.7, humGain));
    const tremDepth = tr(s.gain(0.3, trem.gain));
    this.osc('sine', 0.5, tremDepth);
    const humLP = tr(s.filter('lowpass', 320, 0.8, trem));
    this.osc('sine', 55, humLP);
    this.osc('sine', 82.41, humLP);
    this.osc('triangle', 110.3, humLP);
    // "Space wind": pink noise through a slowly sweeping resonant band-pass.
    const windGain = tr(s.gain(0.35, this.out));
    const windBP = tr(s.filter('bandpass', 700, 3, windGain));
    const sweep = tr(s.gain(450, windBP.frequency));
    this.osc('sine', 0.09, sweep);
    this.loop('pink', windBP);
    // High shimmer (A6 / E7) with slow AM.
    const shG = tr(s.gain(0.03, this.out));
    const am = tr(s.gain(0.5, shG));
    const amDepth = tr(s.gain(0.5, am.gain));
    this.osc('sine', 0.23, amDepth);
    this.osc('sine', 1760, am);
    this.osc('sine', 2637, am);
  }

  update(now: number, intensity: number): void {
    const x = clamp01(intensity);
    this.level(now, x * x * (3 - 2 * x) * 0.9, 0.2);
  }
}
