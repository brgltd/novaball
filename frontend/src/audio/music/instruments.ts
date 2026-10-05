/**
 * NOVABALL music — the synth rig (all procedural):
 *
 *   drums ── kick (sine sweep + click → soft drive), 80s snare (body + noise + synthesized gated-reverb tail),
 *            clap, hats (with open-hat choke), crash, toms
 *   pump  ── sidechain-style gain dip on every kick, applied to bass / pad / arp / delay returns
 *   bass  ── persistent MONO synth voice (detuned saws + sub square → resonant enveloped low-pass), retriggered
 *            per note like a real analog mono synth: zero node churn; or a soft per-note sine sub (menu / defeat)
 *   pad   ── Juno-style: one saw per chord note (alternately panned, slightly detuned) → low-pass → stereo chorus
 *   arp   ── persistent MONO square+saw pluck voice → dotted-8th ping-pong delay → hall reverb
 *   lead  ── portamento saw lead with delayed vibrato (one voice per section), into the delay + hall
 *   fx    ── stingers (bypass the song gate so they play even when the music is off)
 *
 * When the music is off the whole song subgraph is detached (setActive(false)) so it costs no DSP.
 */
import type { AudioGraph } from '../core/graph';
import { holdParam } from '../core/graph';
import type { Synth } from '../core/synth';
import { disconnect, midiToFreq, stopSource } from '../core/util';
import { bell } from '../sfx/gameplay';

/** Relative instrument levels (tuned with the offline render check). */
export const MIX = {
  master: 0.5,
  kick: 1.0,
  kickClick: 0.2,
  snareBody: 0.32,
  snareNoise: 0.46,
  /** Synthesized gated-reverb tail (snare / clap / toms). */
  gated: 0.16,
  clap: 0.4,
  hat: 0.12,
  ohat: 0.1,
  crash: 0.2,
  tom: 0.45,
  bass: 0.3,
  sub: 0.42,
  pad: 0.11,
  arp: 0.075,
  lead: 0.085,
  bell: 0.06,
  stab: 0.18,
} as const;

export interface LongVoice {
  vca: GainNode;
  srcs: AudioScheduledSourceNode[];
  end: number;
}

export interface LeadVoice extends LongVoice {
  o1: OscillatorNode;
  o2: OscillatorNode;
  o3: OscillatorNode;
  vib: GainNode;
  level: number;
  prevEnd: number;
  prevMidi: number;
}

interface OscLayer {
  type: OscillatorType;
  detune: number;
  /** Frequency multiplier (0.5 = sub octave). */
  mult: number;
  gain: number;
}

/** A persistent monophonic synth voice: oscillators → resonant low-pass → VCA. Notes are pure automation. */
class MonoVoice {
  readonly vca: GainNode;
  readonly lp: BiquadFilterNode;
  private readonly oscs: OscillatorNode[] = [];
  private readonly mult: number[] = [];
  private readonly nodes: AudioNode[] = [];

  constructor(s: Synth, dest: AudioNode, layers: ReadonlyArray<OscLayer>, q: number) {
    this.vca = s.gain(0, dest);
    this.lp = s.filter('lowpass', 400, q, this.vca);
    for (const L of layers) {
      let target: AudioNode = this.lp;
      if (L.gain !== 1) {
        const g = s.gain(L.gain, this.lp);
        this.nodes.push(g);
        target = g;
      }
      this.oscs.push(s.osc(L.type, 110 * L.mult, s.now, 0, target, L.detune));
      this.mult.push(L.mult);
    }
  }

  setFreq(t: number, f: number): void {
    for (let i = 0; i < this.oscs.length; i++) this.oscs[i].frequency.setValueAtTime(f * this.mult[i], t);
  }

  silence(t: number): void {
    holdParam(this.vca.gain, t);
    this.vca.gain.setTargetAtTime(0, t, 0.03);
  }

  dispose(): void {
    for (const o of this.oscs) stopSource(o);
    disconnect(...this.oscs, ...this.nodes, this.lp, this.vca);
  }
}

export class MusicRig {
  /** Song gate (fade in/out, state changes). */
  readonly gate: GainNode;
  private readonly master: GainNode;
  /** All song hall-reverb sends gather here (so the song subgraph can be detached as a whole). */
  private readonly hallIn: GainNode;
  private readonly hallSend: AudioNode;
  readonly drums: GainNode;
  private readonly kickBus: GainNode;
  private readonly hatBus: GainNode;
  private readonly drumHall: GainNode;
  readonly pump: GainNode;
  readonly bassBus: GainNode;
  readonly padIn: GainNode;
  readonly arpBus: GainNode;
  readonly leadBus: GainNode;
  readonly fx: GainNode;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly bassVoice: MonoVoice;
  private readonly arpVoice: MonoVoice;
  private readonly nodes: AudioNode[] = [];
  private readonly lfos: OscillatorNode[] = [];
  /** Persistent hat voices (looping noise → high-pass → VCA): the most frequent drum hits create no nodes. */
  private readonly closedHat: GainNode;
  private readonly openHat: GainNode;
  private readonly hatSrcs: AudioBufferSourceNode[] = [];
  private active = false;

  constructor(
    private readonly s: Synth,
    graph: AudioGraph,
  ) {
    const ctx = s.ctx;
    const t = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n);
      return n;
    };
    this.master = t(s.gain(MIX.master, graph.music));
    this.gate = t(s.gain(0, null));
    this.hallSend = graph.hallSend;
    this.hallIn = t(s.gain(1, null));
    this.fx = t(s.gain(1.8, this.master));
    const fxHall = t(s.gain(0.25, graph.hallSend));
    this.fx.connect(fxHall);

    // ---- drums ----
    this.drums = t(s.gain(1, this.gate));
    const kickPost = t(s.gain(0.85, this.drums));
    const kickDrive = t(s.shaper(s.buf.curveDrive, kickPost, 'none'));
    this.kickBus = t(s.gain(0.75, kickDrive));
    const hatPan = t(s.pan(0.18, this.drums));
    this.hatBus = t(s.gain(1, hatPan));
    this.drumHall = t(s.gain(0.12, this.hallIn));
    this.closedHat = t(s.gain(0, this.hatBus));
    this.openHat = t(s.gain(0, this.hatBus));
    const chp = t(s.filter('highpass', 7600, 0.7, this.closedHat));
    const ohp = t(s.filter('highpass', 6800, 0.7, this.openHat));
    this.hatSrcs.push(s.noise('white', s.now, 0, chp), s.noise('white', s.now, 0, ohp));

    // ---- pump (sidechain) ----
    this.pump = t(s.gain(1, this.gate));
    this.bassBus = t(s.gain(1, this.pump));

    // ---- pad: dry + stereo chorus (the Juno recipe: one oscillator per voice + chorus) ----
    this.padIn = t(s.gain(1, null));
    const padDry = t(s.gain(0.75, this.pump));
    this.padIn.connect(padDry);
    const chL = t(ctx.createDelay(0.05));
    const chR = t(ctx.createDelay(0.05));
    chL.delayTime.value = 0.012;
    chR.delayTime.value = 0.017;
    this.padIn.connect(chL);
    this.padIn.connect(chR);
    const merger = t(ctx.createChannelMerger(2));
    chL.connect(merger, 0, 0);
    chR.connect(merger, 0, 1);
    const chWet = t(s.gain(0.62, this.pump));
    merger.connect(chWet);
    const lfoA = s.osc('sine', 0.31, s.now, 0, t(s.gain(0.0028, chL.delayTime)));
    const lfoB = s.osc('sine', 0.37, s.now, 0, t(s.gain(0.0034, chR.delayTime)));
    this.lfos.push(lfoA, lfoB);
    const padHall = t(s.gain(0.42, this.hallIn));
    this.padIn.connect(padHall);

    // ---- arp + lead → ping-pong delay ----
    this.arpBus = t(s.gain(1, this.pump));
    this.leadBus = t(s.gain(1, this.gate));
    const dIn = t(s.gain(1, null));
    dIn.channelCount = 1;
    dIn.channelCountMode = 'explicit';
    dIn.channelInterpretation = 'speakers';
    const arpDelay = t(s.gain(0.34, dIn));
    this.arpBus.connect(arpDelay);
    const leadDelay = t(s.gain(0.24, dIn));
    this.leadBus.connect(leadDelay);
    this.delayL = t(ctx.createDelay(2));
    this.delayR = t(ctx.createDelay(2));
    this.delayL.delayTime.value = 0.38;
    this.delayR.delayTime.value = 0.38;
    dIn.connect(this.delayL);
    const lpA = t(s.filter('lowpass', 3400, 0.5, null));
    const fbA = t(s.gain(0.42, this.delayR));
    this.delayL.connect(lpA);
    lpA.connect(fbA);
    const lpB = t(s.filter('lowpass', 3400, 0.5, null));
    const fbB = t(s.gain(0.42, this.delayL));
    this.delayR.connect(lpB);
    lpB.connect(fbB);
    const dMerge = t(ctx.createChannelMerger(2));
    const hpL = t(s.filter('highpass', 280, 0.5, null));
    const hpR = t(s.filter('highpass', 280, 0.5, null));
    this.delayL.connect(hpL);
    this.delayR.connect(hpR);
    hpL.connect(dMerge, 0, 0);
    hpR.connect(dMerge, 0, 1);
    const dWet = t(s.gain(0.55, this.pump));
    dMerge.connect(dWet);
    const arpHall = t(s.gain(0.3, this.hallIn));
    this.arpBus.connect(arpHall);
    const leadHall = t(s.gain(0.34, this.hallIn));
    this.leadBus.connect(leadHall);

    // ---- persistent mono voices ----
    this.bassVoice = new MonoVoice(
      s,
      this.bassBus,
      [
        { type: 'sawtooth', detune: -5, mult: 1, gain: 1 },
        { type: 'sawtooth', detune: 5, mult: 1, gain: 1 },
        { type: 'square', detune: 0, mult: 0.5, gain: 0.3 },
      ],
      5,
    );
    this.arpVoice = new MonoVoice(
      s,
      this.arpBus,
      [
        { type: 'square', detune: 0, mult: 1, gain: 1 },
        { type: 'sawtooth', detune: 7, mult: 1, gain: 1 },
      ],
      4,
    );
  }

  /** Attach / detach the song subgraph (drums, pump, pads, arp, lead, delays, hall sends). fx stays attached. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.gate.connect(this.master);
      this.hallIn.connect(this.hallSend);
    } else {
      disconnect(this.gate, this.hallIn);
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Dotted-8th delay for the tempo. */
  setTempo(bpm: number, at: number): void {
    const dt = (0.75 * 60) / bpm;
    this.delayL.delayTime.setTargetAtTime(dt, at, 0.05);
    this.delayR.delayTime.setTargetAtTime(dt, at, 0.05);
  }

  /** Fade the song gate to `target` (song level, or 0). */
  fadeGate(target: number, at: number, tau: number): void {
    const p = this.gate.gain;
    p.cancelScheduledValues(at);
    p.setTargetAtTime(target, at, tau);
  }

  /** Sidechain dip at a kick. */
  pumpAt(t: number, depth: number): void {
    if (depth <= 0) return;
    const p = this.pump.gain;
    p.setTargetAtTime(1 - depth, t, 0.005);
    p.setTargetAtTime(1, t + 0.035, 0.085);
  }

  /** Silence the mono voices from time t (song change / stop). */
  silenceMono(t: number): void {
    this.bassVoice.silence(t);
    this.arpVoice.silence(t);
    holdParam(this.openHat.gain, t);
    this.openHat.gain.setTargetAtTime(0, t, 0.03);
  }

  // ---------------------------------------------------------------------------------------------
  // Drums
  // ---------------------------------------------------------------------------------------------

  kick(t: number, vel: number): void {
    const s = this.s;
    const g = s.gain(0, this.kickBus);
    const o = s.osc('sine', 160, t, t + 0.7, g);
    o.frequency.setValueAtTime(162, t);
    o.frequency.exponentialRampToValueAtTime(56, t + 0.055);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.4);
    s.perc(g.gain, t, MIX.kick * vel, 0.0015, 0.13);
    const cg = s.gain(0, this.kickBus);
    s.noise('white', t, 0.025, cg);
    s.perc(cg.gain, t, MIX.kickClick * vel, 0.0005, 0.0035);
  }

  snare(t: number, vel: number): void {
    const s = this.s;
    const bg = s.gain(0, this.drums);
    const o = s.osc('triangle', 190, t, t + 0.3, bg);
    s.glide(o.frequency, t, 195, 168, 0.03);
    s.perc(bg.gain, t, MIX.snareBody * vel, 0.001, 0.045);
    const ng = s.gain(0, this.drums);
    ng.connect(this.drumHall);
    const pk = s.filter('peaking', 4800, 0.8, ng, 5);
    const hp = s.filter('highpass', 1200, 0.7, pk);
    s.noise('white', t, 0.4, hp);
    s.perc(ng.gain, t, MIX.snareNoise * vel, 0.001, 0.07);
    this.gatedTail(t + 0.004, MIX.gated * vel, 7000);
  }

  /**
   * The 80s "gated reverb": a dense, flat burst of room noise that is abruptly cut ~0.22 s later.
   * Synthesized per hit (stereo-decorrelated noise, band-limited) instead of a convolver — same character, ~free.
   */
  private gatedTail(t: number, peak: number, lpHz: number): void {
    const s = this.s;
    const g = s.gain(0, this.drums);
    // One wide band-pass (≈ 380 Hz … lpHz) instead of a high-pass + low-pass pair.
    const bp = s.filter('bandpass', Math.sqrt(380 * lpHz), 0.45, g);
    s.noise('white', t, 0.26, bp);
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + 0.006);
    p.linearRampToValueAtTime(peak * 0.72, t + 0.2);
    p.linearRampToValueAtTime(0, t + 0.235);
  }

  clap(t: number, vel: number): void {
    const s = this.s;
    const g = s.gain(0, this.drums);
    const bp = s.filter('bandpass', 1150, 1.3, g);
    s.noise('white', t, 0.35, bp);
    this.gatedTail(t + 0.03, MIX.gated * 0.6 * vel, 5500);
    const p = g.gain;
    const pk = MIX.clap * vel;
    p.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const ti = t + i * 0.0105;
      p.setValueAtTime(pk, ti);
      p.setTargetAtTime(0, ti + 0.0004, 0.0035);
    }
    p.setValueAtTime(pk * 0.9, t + 0.032);
    p.setTargetAtTime(0, t + 0.0325, 0.055);
  }

  hat(t: number, vel: number, open: boolean): void {
    // Any hat hit chokes a ringing open hat (like a real hi-hat pedal).
    const op = this.openHat.gain;
    if (open) {
      op.setTargetAtTime(MIX.ohat * vel, t, 0.0008);
      op.setTargetAtTime(0, t + 0.002, 0.11);
    } else {
      op.setTargetAtTime(0, t, 0.008);
      const cp = this.closedHat.gain;
      cp.setTargetAtTime(MIX.hat * vel, t, 0.0008);
      cp.setTargetAtTime(0, t + 0.002, 0.016);
    }
  }

  crash(t: number, vel: number): void {
    const s = this.s;
    const g = s.gain(0, this.drums);
    g.connect(this.drumHall);
    const hp = s.filter('highpass', 4200, 0.7, g);
    s.noise('white', t, 2.8, hp);
    s.perc(g.gain, t, MIX.crash * vel, 0.002, 0.5);
    const mg = s.gain(0, this.drums);
    const bp = s.filter('bandpass', 7500, 0.5, mg);
    for (const f of [540, 806, 1273]) s.osc('square', f, t, t + 1.7, bp);
    s.perc(mg.gain, t, 0.04 * vel, 0.002, 0.3);
  }

  tom(t: number, vel: number, f: number): void {
    const s = this.s;
    const g = s.gain(0, this.drums);
    const o = s.osc('sine', f * 1.6, t, t + 0.75, g);
    s.glide(o.frequency, t, f * 1.6, f, 0.04);
    s.perc(g.gain, t, MIX.tom * vel, 0.002, 0.12);
    this.gatedTail(t + 0.004, MIX.gated * 0.7 * vel, 2600);
  }

  // ---------------------------------------------------------------------------------------------
  // Tonal instruments
  // ---------------------------------------------------------------------------------------------

  /** Plucky mono bass note (retriggers the persistent voice). */
  bass(t: number, midi: number, vel: number, dur: number, bright: number): void {
    const v = this.bassVoice;
    v.setFreq(t, midiToFreq(midi));
    const lf = v.lp.frequency;
    lf.setValueAtTime(260 + 2600 * bright * vel, t);
    lf.setTargetAtTime(170 + 520 * bright, t + 0.004, 0.075);
    const pk = MIX.bass * vel;
    const p = v.vca.gain;
    p.setTargetAtTime(pk, t, 0.0015);
    p.setTargetAtTime(pk * 0.7, t + 0.006, 0.09);
    p.setTargetAtTime(0, t + dur, 0.025);
  }

  /** Soft sine sub note (menu / defeat); per-note nodes (at most a couple per bar). */
  subBass(t: number, midi: number, vel: number, dur: number): void {
    const s = this.s;
    const f = midiToFreq(midi);
    const vca = s.gain(0, this.bassBus);
    const stop = t + dur + 1.5;
    s.osc('sine', f, t, stop, vca);
    const hg = s.gain(0.18, vca);
    s.osc('triangle', f * 2, t, stop, hg);
    s.ahr(vca.gain, t, MIX.sub * vel, 0.12, Math.max(0.05, dur - 0.12), 0.25);
  }

  pad(t: number, notes: ReadonlyArray<number>, dur: number, bright: number, attack: number, release: number, level: number): LongVoice {
    const s = this.s;
    const vca = s.gain(0, this.padIn);
    const cutoff = 450 + 3600 * Math.pow(bright, 1.4);
    const lp = s.filter('lowpass', cutoff, 1.5, vca);
    const pl = s.pan(-0.55, lp);
    const pr = s.pan(0.55, lp);
    const stop = t + dur + release * 3;
    const srcs: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < notes.length; i++) {
      const odd = (i & 1) === 1;
      srcs.push(s.osc('sawtooth', midiToFreq(notes[i]), t, stop, odd ? pr : pl, (odd ? 7 : -7) + s.rng.spread(2)));
    }
    const warm = s.gain(0.5, lp);
    srcs.push(s.osc('triangle', midiToFreq(notes[0] - 12), t, stop, warm));
    lp.frequency.setValueAtTime(cutoff * 0.45, t);
    lp.frequency.setTargetAtTime(cutoff, t, Math.max(0.05, attack * 0.6));
    const pk = (MIX.pad * level) / Math.sqrt(notes.length);
    const p = vca.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(pk, t + attack);
    p.setValueAtTime(pk, t + Math.max(attack, dur));
    p.setTargetAtTime(0, t + Math.max(attack, dur), release / 3);
    return { vca, srcs, end: stop };
  }

  /** Arp pluck (retriggers the persistent mono voice; the ping-pong delay supplies the overlap). */
  arp(t: number, midi: number, vel: number, bright: number): void {
    const v = this.arpVoice;
    v.setFreq(t, midiToFreq(midi));
    const lf = v.lp.frequency;
    lf.setValueAtTime(1000 + 5200 * bright, t);
    lf.setTargetAtTime(600 + 1800 * bright, t + 0.002, 0.06);
    const p = v.vca.gain;
    p.setTargetAtTime(MIX.arp * vel, t, 0.0012);
    p.setTargetAtTime(0, t + 0.004, 0.05 + 0.055 * bright);
  }

  twinkle(t: number, midi: number, vel: number): void {
    bell(this.s, t, this.arpBus, midiToFreq(midi), MIX.bell * vel, 0.35, 3.5, 1.1);
  }

  /** Portamento saw lead spanning a section; notes are added per step with leadNote(). */
  leadVoice(t0: number, firstMidi: number, end: number, level: number): LeadVoice {
    const s = this.s;
    const vca = s.gain(0, this.leadBus);
    const lp = s.filter('lowpass', 2900, 2, vca);
    const stop = end + 0.8;
    const f0 = midiToFreq(firstMidi);
    const o1 = s.osc('sawtooth', f0, t0, stop, lp, -9);
    const o2 = s.osc('sawtooth', f0, t0, stop, lp, 9);
    const g3 = s.gain(0.28, lp);
    const o3 = s.osc('square', f0 * 0.5, t0, stop, g3);
    const vib = s.gain(0, null);
    vib.connect(o1.detune);
    vib.connect(o2.detune);
    vib.connect(o3.detune);
    const lfo = s.osc('sine', 5.4, t0, stop, vib);
    vca.gain.setValueAtTime(0, t0);
    return { vca, srcs: [o1, o2, o3, lfo], end: stop, o1, o2, o3, vib, level, prevEnd: -1, prevMidi: -1 };
  }

  /** Schedule one lead note. nextStart: start time of the following note (-1 = none) for legato decisions. */
  leadNote(v: LeadVoice, t: number, midi: number, dur: number, vel: number, nextStart: number): void {
    const f = midiToFreq(midi);
    const p = v.vca.gain;
    const legato = v.prevEnd > 0 && t - v.prevEnd < 0.02;
    const pk = MIX.lead * v.level * vel;
    if (legato) {
      // Re-articulate (short dip) and glide (portamento) into the new pitch.
      const same = v.prevMidi === midi;
      p.setTargetAtTime(pk * (same ? 0.2 : 0.55), t - 0.03, 0.01);
      v.o1.frequency.setTargetAtTime(f, t, 0.016);
      v.o2.frequency.setTargetAtTime(f, t, 0.016);
      v.o3.frequency.setTargetAtTime(f * 0.5, t, 0.016);
      p.setTargetAtTime(pk, t, 0.012);
    } else {
      v.o1.frequency.setValueAtTime(f, t);
      v.o2.frequency.setValueAtTime(f, t);
      v.o3.frequency.setValueAtTime(f * 0.5, t);
      p.setTargetAtTime(pk, t, 0.007);
    }
    v.vib.gain.setTargetAtTime(0, t, 0.02);
    v.vib.gain.setTargetAtTime(dur > 0.3 ? 16 : 6, t + 0.16, 0.12);
    const nEnd = t + dur;
    if (nextStart < 0 || nextStart - nEnd > 0.02) p.setTargetAtTime(0, nEnd - 0.015, 0.035);
    v.prevEnd = nEnd;
    v.prevMidi = midi;
  }

  /** Brassy chord stab (stingers). */
  stab(t: number, notes: ReadonlyArray<number>, hold: number, level: number, dest: AudioNode = this.fx): number {
    const s = this.s;
    const vca = s.gain(0, dest);
    const lp = s.filter('lowpass', 800, 2.5, vca);
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(5200, t + 0.06);
    lp.frequency.setTargetAtTime(2400, t + 0.06, 0.3);
    const stop = t + hold + 2.5;
    for (const n of notes) {
      const f = midiToFreq(n);
      s.osc('sawtooth', f, t, stop, lp, -9);
      s.osc('sawtooth', f, t, stop, lp, 9);
    }
    return s.ahr(vca.gain, t, (MIX.stab * level) / Math.sqrt(notes.length / 2), 0.008, hold, 0.28);
  }

  /** Noise + saw riser into time t + dur. */
  riser(t: number, dur: number, level: number): number {
    const s = this.s;
    const bp = s.filter('bandpass', 1000, 2.5, this.fx);
    s.sweep(bp.frequency, t, 500, 8000, dur);
    const g = s.gain(0, bp);
    s.noise('white', t, dur + 0.1, g);
    s.swell(g.gain, t, 0.3 * level, dur, 0.01, true);
    const lp = s.filter('lowpass', 1800, 1, this.fx);
    const g2 = s.gain(0, lp);
    const o = s.osc('sawtooth', 110, t, t + dur + 0.1, g2);
    s.sweep(o.frequency, t, 110, 880, dur);
    return s.swell(g2.gain, t, 0.06 * level, dur, 0.01, true);
  }

  /** Release long voices (pads / lead) early, from time t. */
  release(v: LongVoice, t: number, tau = 0.25): void {
    try {
      holdParam(v.vca.gain, t);
      v.vca.gain.setTargetAtTime(0, t, tau);
      const stop = t + tau * 8;
      for (const src of v.srcs) stopSource(src, stop);
      v.end = Math.min(v.end, stop);
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    for (const l of this.lfos) stopSource(l);
    for (const h of this.hatSrcs) stopSource(h);
    this.bassVoice.dispose();
    this.arpVoice.dispose();
    disconnect(...this.lfos, ...this.hatSrcs, ...this.nodes);
  }
}
