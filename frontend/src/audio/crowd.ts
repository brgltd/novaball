/**
 * NOVABALL audio — stadium crowd.
 *
 * Instead of plain filtered noise, the crowd is a procedural *choir of voices*: dozens of sawtooth "glottal" sources
 * with vibrato and pitch contours, shaped by vowel formant filters (a / e / o / u ...), panned across the stands and
 * rendered once with OfflineAudioContexts (off the main thread) into textures:
 *   murmur (loopable chatter), cheer (loopable roar), ooh, aww, applause (JS-generated claps).
 * The choir graphs are built voice by voice on the idle queue (core/idle.ts) and the textures post-processed there too,
 * starting before the first user gesture (offline contexts make no sound, so no autoplay restriction applies): the
 * unlock normally finds them ready. Until they are, a filtered-noise fallback is used.
 *
 * Runtime: a looping murmur bed + a looping "excitement" cheer layer whose level and brightness follow the action,
 * plus one-shot reactions (goal roar, save cheer, ooh, aww, applause) layered from the textures.
 */
import { kRate, type Synth } from './core/synth';
import { foldLoop, genHighpass, genNormalizeRms } from './core/buffers';
import { PRIO, idle, type JobGen } from './core/idle';
import { Rng, SmoothParam, clamp01, disconnect, stopSource } from './core/util';

export interface CrowdTextures {
  murmur: AudioBuffer;
  cheer: AudioBuffer;
  ooh: AudioBuffer;
  aww: AudioBuffer;
  applause: AudioBuffer;
}

export type CrowdReaction = 'roar' | 'cheer' | 'ooh' | 'aww' | 'applause';

// ---------------------------------------------------------------------------------------------
// Texture rendering
// ---------------------------------------------------------------------------------------------

type Vowel = readonly [number, number, number];
const VOWELS: Record<string, Vowel> = {
  a: [730, 1090, 2440],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  ae: [660, 1720, 2410],
  uh: [640, 1190, 2390],
};
const FORMANT_AMP = [1, 0.6, 0.3];
const FORMANT_BW = [90, 120, 180];

type TextureKind = 'murmur' | 'cheer' | 'ooh' | 'aww';

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

let texturePromise: Promise<CrowdTextures | null> | null = null;

/**
 * Render (once per page) the crowd textures. Safe to call before any user gesture; resolves null when offline
 * rendering is unavailable. Main-thread work happens in small idle-queue steps (a choir voice, a few clappers, one
 * block of post-processing: ≈ 0.1–2 ms, a few ms while the code is still cold); the offline renders themselves run on
 * the audio render thread.
 */
export function renderCrowdTextures(): Promise<CrowdTextures | null> {
  if (!texturePromise) texturePromise = renderAll();
  return texturePromise;
}

async function renderAll(): Promise<CrowdTextures | null> {
  const OAC = offlineCtor();
  if (!OAC) return null;
  try {
    const sr = 22050;
    const choir = (kind: TextureKind, seconds: number, voices: number, seed: number): Promise<AudioBuffer> =>
      idle
        .run(`crowd:${kind}`, genChoir(OAC, sr, kind, seconds, voices, seed), PRIO.crowd)
        .promise.then((g) => g.oc.startRendering().then((rendered) => idle.run(`crowd:${kind}:post`, genChoirPost(g, rendered), PRIO.crowdPost).promise));
    const parts = [choir('murmur', 8, 30, 0xa11), choir('cheer', 6, 34, 0xc4e), choir('ooh', 2.6, 26, 0x00f), choir('aww', 2.6, 26, 0xa33)];
    const applause = idle.run('crowd:applause', genApplause(OAC, sr, 6, 0x5a1), PRIO.crowd).promise;
    const [murmur, cheer, ooh, aww] = await Promise.all(parts);
    return { murmur, cheer, ooh, aww, applause: await applause };
  } catch {
    return null;
  }
}

interface ChoirGraph {
  oc: OfflineAudioContext;
  kind: TextureKind;
  sr: number;
  seconds: number;
  len: number;
  loopable: boolean;
  xf: number;
}

/**
 * Build one choir's offline graph, one job step per voice (≈ 0.1–0.3 ms); rendering is started by the caller.
 * Per-voice work lives in plain functions (V8 cannot OSR loops inside a generator). Same RNG order as a one-shot build.
 */
function* genChoir(OAC: OfflineCtor, sr: number, kind: TextureKind, seconds: number, voices: number, seed: number): JobGen<ChoirGraph> {
  const loopable = kind === 'murmur' || kind === 'cheer';
  const xf = loopable ? 0.6 : 0;
  const total = seconds + xf;
  const len = Math.ceil(total * sr);
  const oc = new OAC(2, len, sr);
  const rng = new Rng(seed);
  const master = oc.createGain();
  master.gain.value = 1 / Math.sqrt(voices);
  master.connect(oc.destination);

  // Shared noise buffer for breathiness.
  const nb = oc.createBuffer(1, Math.floor(sr * 1.5), sr);
  fillWhite(nb.getChannelData(0), rng);

  const vowelKeys = kind === 'murmur' ? ['a', 'o', 'e', 'i', 'uh', 'ae', 'u'] : kind === 'cheer' ? ['a', 'e', 'ae', 'o', 'uh'] : kind === 'ooh' ? ['u', 'o'] : ['o', 'a'];
  for (let v = 0; v < voices; v++) {
    yield;
    addVoice(oc, rng, kind, total, vowelKeys, nb, master);
  }
  // Whistles in the roar.
  if (kind === 'cheer') addWhistles(oc, rng, total, master);
  return { oc, kind, sr, seconds, len, loopable, xf };
}

function fillWhite(d: Float32Array, rng: Rng): void {
  for (let i = 0; i < d.length; i++) d[i] = rng.next() * 2 - 1;
}

/** One singer: sawtooth "glottis" + breath noise → 3 vowel formants → envelope → pan, with the kind's pitch/vowel contour. */
function addVoice(oc: OfflineAudioContext, rng: Rng, kind: TextureKind, total: number, vowelKeys: ReadonlyArray<string>, nb: AudioBuffer, master: AudioNode): void {
  const female = rng.next() < 0.42;
  const f0 = female ? rng.range(185, 290) : rng.range(92, 165);
  const fScale = female ? 1.17 : 1;
  const osc = oc.createOscillator();
  osc.type = 'sawtooth';
  kRate(osc.frequency);
  kRate(osc.detune);
  osc.frequency.value = f0;
  const vib = oc.createOscillator();
  vib.frequency.value = rng.range(4.2, 6.8);
  const vibG = oc.createGain();
  vibG.gain.value = rng.range(10, 28);
  vib.connect(vibG);
  vibG.connect(osc.detune);
  const src = oc.createGain();
  src.gain.value = 1;
  osc.connect(src);
  // Breath / aspiration noise into the same formants.
  const ns = oc.createBufferSource();
  ns.buffer = nb;
  ns.loop = true;
  const nsG = oc.createGain();
  nsG.gain.value = kind === 'cheer' ? 0.45 : 0.25;
  ns.connect(nsG);
  nsG.connect(src);

  const env = oc.createGain();
  env.gain.value = 0;
  const pan = oc.createStereoPanner();
  pan.pan.value = rng.range(-0.95, 0.95);
  env.connect(pan);
  pan.connect(master);
  const fx: BiquadFilterNode[] = [];
  const first = VOWELS[rng.pick(vowelKeys)];
  for (let k = 0; k < 3; k++) {
    const bp = oc.createBiquadFilter();
    kRate(bp.frequency);
    kRate(bp.Q);
    bp.type = 'bandpass';
    bp.frequency.value = first[k] * fScale;
    bp.Q.value = (first[k] * fScale) / FORMANT_BW[k];
    const g = oc.createGain();
    g.gain.value = FORMANT_AMP[k] * 4;
    src.connect(bp);
    bp.connect(g);
    g.connect(env);
    fx.push(bp);
  }
  const setVowel = (vw: Vowel, t: number, tau: number) => {
    for (let k = 0; k < 3; k++) fx[k].frequency.setTargetAtTime(vw[k] * fScale * rng.range(0.95, 1.05), t, tau);
  };
  const e = env.gain;
  const pf = osc.frequency;

  if (kind === 'murmur') {
    let t = rng.range(0, 1.2);
    while (t < total) {
      if (rng.chance(0.22)) {
        t += rng.range(0.3, 1.4);
        continue;
      }
      const syl = rng.range(0.09, 0.26);
      const amp = rng.range(0.25, 0.8);
      e.setTargetAtTime(amp, t, 0.015);
      e.setTargetAtTime(0, t + syl, 0.03);
      setVowel(VOWELS[rng.pick(vowelKeys)], t, 0.02);
      pf.setTargetAtTime(f0 * rng.range(0.9, 1.14), t, 0.04);
      t += syl + rng.range(0.03, 0.14);
    }
  } else if (kind === 'cheer') {
    let t = rng.range(0, 0.4);
    while (t < total) {
      const dur = rng.range(0.45, 1.8);
      const amp = rng.range(0.5, 1);
      e.setTargetAtTime(amp, t, 0.03);
      e.setTargetAtTime(amp * 0.8, t + dur * 0.6, dur * 0.3);
      e.setTargetAtTime(0, t + dur, 0.1);
      setVowel(VOWELS[rng.pick(vowelKeys)], t, 0.02);
      if (rng.chance(0.4)) setVowel(VOWELS[rng.pick(vowelKeys)], t + dur * 0.35, 0.06);
      pf.setValueAtTime(f0 * 1.05, t);
      pf.setTargetAtTime(f0 * rng.range(1.25, 1.45), t, 0.06);
      pf.setTargetAtTime(f0 * rng.range(1.0, 1.1), t + dur * 0.5, dur * 0.35);
      t += dur + rng.range(0.05, 0.35);
    }
  } else {
    const t0 = rng.range(0, 0.2);
    const dur = rng.range(1.3, 1.95);
    const amp = rng.range(0.55, 1);
    e.setTargetAtTime(amp, t0, 0.12);
    e.setTargetAtTime(0, t0 + dur, 0.22);
    if (kind === 'ooh') {
      setVowel(VOWELS.u, 0, 0.01);
      setVowel(VOWELS.o, t0 + 0.55, 0.3);
      pf.setValueAtTime(f0 * 0.95, t0);
      pf.setTargetAtTime(f0 * 1.28, t0, 0.15);
      pf.setTargetAtTime(f0 * 0.84, t0 + 0.5, 0.45);
    } else {
      setVowel(VOWELS.o, 0, 0.01);
      setVowel(VOWELS.a, t0 + 0.3, 0.4);
      pf.setValueAtTime(f0 * 1.3, t0);
      pf.setTargetAtTime(f0 * 0.78, t0 + 0.15, 0.6);
    }
  }
  osc.start(0);
  vib.start(0);
  ns.start(0, rng.range(0, 1.4));
}

function addWhistles(oc: OfflineAudioContext, rng: Rng, total: number, master: AudioNode): void {
  for (let w = 0; w < 5; w++) {
    const o = oc.createOscillator();
    o.type = 'sine';
    const g = oc.createGain();
    g.gain.value = 0;
    const pn = oc.createStereoPanner();
    pn.pan.value = rng.range(-0.8, 0.8);
    o.connect(g);
    g.connect(pn);
    pn.connect(master);
    let t = rng.range(0, 2);
    while (t < total) {
      const base = rng.range(1700, 2600);
      const d = rng.range(0.25, 0.7);
      o.frequency.setValueAtTime(base * 0.8, t);
      o.frequency.linearRampToValueAtTime(base * 1.15, t + d * 0.4);
      o.frequency.linearRampToValueAtTime(base * 0.75, t + d);
      g.gain.setTargetAtTime(rng.range(0.2, 0.45), t, 0.02);
      g.gain.setTargetAtTime(0, t + d, 0.04);
      t += d + rng.range(0.8, 3);
    }
    o.start(0);
  }
}

/** Post: loop folding, high-pass (no rumble), RMS normalization — in bounded job steps. */
function* genChoirPost(g: ChoirGraph, rendered: AudioBuffer): JobGen<AudioBuffer> {
  const { oc, sr, loopable, xf } = g;
  const outLen = Math.ceil(g.seconds * sr);
  const out = oc.createBuffer(2, loopable ? outLen : g.len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch);
    const dst = out.getChannelData(ch);
    if (loopable) foldLoop(src, outLen, Math.floor(xf * sr), dst);
    else dst.set(src.subarray(0, dst.length));
    yield;
    yield* genHighpass(dst, sr, 120);
    yield* genNormalizeRms(dst, g.kind === 'murmur' ? 0.2 : 0.22, 0.98);
  }
  return out;
}

/** JS-generated applause: a job step per 5 clappers, then the band-pass / normalization in bounded blocks. */
function* genApplause(OAC: OfflineCtor, sr: number, seconds: number, seed: number): JobGen<AudioBuffer> {
  const oc = new OAC(2, 1, sr);
  const len = Math.floor(seconds * sr);
  const buf = oc.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const rng = new Rng(seed);
  const clappers = 70;
  const clapLen = Math.floor(0.014 * sr);
  const tau = 0.0032 * sr;
  // Clap decay table (exactly the values Math.exp(-k / tau) gives inline).
  const decay = new Float64Array(clapLen);
  for (let k = 0; k < clapLen; k++) decay[k] = Math.exp(-k / tau);
  for (let c = 0; c < clappers; c++) {
    if (c % 5 === 4) yield;
    addClapper(L, R, rng, seconds, sr, decay);
  }
  for (const d of [L, R]) {
    const st = new Float64Array(4); // x1, x2, y1, y2
    for (let i = 0; i < len; i += 16384) {
      yield;
      bandpassBlock(d, i, Math.min(len, i + 16384), sr, 1900, 0.7, st);
    }
    yield* genNormalizeRms(d, 0.2, 0.98);
  }
  return buf;
}

/** One person clapping at their own rate and stereo position for the whole texture. */
function addClapper(L: Float32Array, R: Float32Array, rng: Rng, seconds: number, sr: number, decay: Float64Array): void {
  const len = L.length;
  const clapLen = decay.length;
  const rate = rng.range(3.2, 5.8);
  const pan = rng.range(-1, 1);
  const gl = Math.cos((pan + 1) * Math.PI * 0.25);
  const gr = Math.sin((pan + 1) * Math.PI * 0.25);
  const amp = rng.range(0.3, 1);
  let t = rng.range(0, 1 / rate);
  while (t < seconds) {
    const i0 = Math.floor((t + rng.spread(0.008)) * sr);
    const a = amp * rng.range(0.6, 1);
    for (let k = 0; k < clapLen; k++) {
      const i = i0 + k;
      if (i < 0 || i >= len) continue;
      const x = (rng.next() * 2 - 1) * a * decay[k];
      L[i] += x * gl;
      R[i] += x * gr;
    }
    t += 1 / (rate * rng.range(0.92, 1.08));
  }
}

/** RBJ band-pass biquad (constant 0 dB peak) in place over [from, to); state (x1, x2, y1, y2) carried in `st`. */
function bandpassBlock(d: Float32Array, from: number, to: number, sr: number, f: number, q: number, st: Float64Array): void {
  const w = (2 * Math.PI * f) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3];
  for (let i = from; i < to; i++) {
    const x = d[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
  st[0] = x1;
  st[1] = x2;
  st[2] = y1;
  st[3] = y2;
}

// ---------------------------------------------------------------------------------------------
// Runtime crowd
// ---------------------------------------------------------------------------------------------

export class Crowd {
  private readonly out: GainNode;
  private readonly send: GainNode;
  // Fallback noise bed.
  private readonly noiseBed: GainNode;
  private readonly pNoiseBed: SmoothParam;
  private readonly pNoiseLP: SmoothParam;
  private noiseSrc: AudioBufferSourceNode | null = null;
  // Texture layers.
  private textures: CrowdTextures | null = null;
  private murmurSrc: AudioBufferSourceNode | null = null;
  private exciteSrc: AudioBufferSourceNode | null = null;
  private murmurGain: GainNode | null = null;
  private exciteGain: GainNode | null = null;
  private exciteLP: BiquadFilterNode | null = null;
  private pMurmur: SmoothParam | null = null;
  private pExcite: SmoothParam | null = null;
  private pExciteLP: SmoothParam | null = null;

  private excitement = 0.2;
  private wander = 0;
  private wanderTarget = 0;
  private wanderTimer = 0;
  private boost = 0;
  private disposed = false;
  private readonly rng = new Rng(0xc20d);
  private readonly oneShots: Array<{ src: AudioScheduledSourceNode; g: GainNode; end: number }> = [];
  private readonly lastReact: Record<CrowdReaction, { t: number; a: number }> = {
    roar: { t: -9, a: 0 },
    cheer: { t: -9, a: 0 },
    ooh: { t: -9, a: 0 },
    aww: { t: -9, a: 0 },
    applause: { t: -9, a: 0 },
  };

  constructor(
    private readonly s: Synth,
    dest: AudioNode,
    reverb: AudioNode,
  ) {
    this.out = s.gain(1, dest);
    this.send = s.gain(0.35, reverb);
    this.out.connect(this.send);
    // Fallback: pink noise in the voice band with slow swells.
    this.noiseBed = s.gain(0, this.out);
    const lp = s.filter('lowpass', 1800, 0.6, this.noiseBed);
    const bp = s.filter('bandpass', 850, 0.45, lp);
    this.noiseSrc = s.noise('pink', s.now, 0, bp);
    this.pNoiseBed = new SmoothParam(this.noiseBed.gain, 0.4);
    this.pNoiseLP = new SmoothParam(lp.frequency, 0.5, 1, 0.01);
  }

  /** Debug / test: silence the whole crowd (dry + reverb send). */
  setMuted(on: boolean): void {
    this.out.gain.cancelScheduledValues(0);
    this.out.gain.setValueAtTime(on ? 0 : 1, this.s.now);
  }

  get hasTextures(): boolean {
    return this.textures !== null;
  }

  /** Start rendering the choir textures and crossfade to them when ready. */
  async load(): Promise<void> {
    const tex = await renderCrowdTextures();
    if (!tex || this.disposed) return;
    this.useTextures(tex);
  }

  useTextures(tex: CrowdTextures): void {
    if (this.textures || this.disposed) return;
    this.textures = tex;
    const s = this.s;
    const now = s.now;
    this.murmurGain = s.gain(0, this.out);
    this.murmurSrc = this.loopSrc(tex.murmur, this.murmurGain, now);
    this.exciteGain = s.gain(0, this.out);
    this.exciteLP = s.filter('lowpass', 2000, 0.6, this.exciteGain);
    this.exciteSrc = this.loopSrc(tex.cheer, this.exciteLP, now, 0.985);
    this.pMurmur = new SmoothParam(this.murmurGain.gain, 0.5);
    this.pExcite = new SmoothParam(this.exciteGain.gain, 0.35);
    this.pExciteLP = new SmoothParam(this.exciteLP.frequency, 0.4, 1, 0.01);
    // Fade the noise fallback out, then stop it (no DSP for a silent layer).
    this.pNoiseBed.set(0, now, 0.4);
    stopSource(this.noiseSrc, now + 3);
  }

  private loopSrc(b: AudioBuffer, dest: AudioNode, t: number, rate = 1): AudioBufferSourceNode {
    const src = this.s.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(t, this.rng.next() * b.duration);
    return src;
  }

  /**
   * Per-frame. target: 0..1 desired excitement from the action. active=false → quiet bed (menus, no match).
   */
  update(now: number, dt: number, target: number, active: boolean): void {
    const tgt = clamp01(target + this.boost);
    const k = 1 - Math.exp(-dt / (tgt > this.excitement ? 0.9 : 2.6));
    this.excitement += (tgt - this.excitement) * k;
    this.boost *= Math.exp(-dt / 2.5);
    // Slow random "swells" of the bed.
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = this.rng.range(1.2, 3.2);
      this.wanderTarget = this.rng.spread(1);
    }
    this.wander += (this.wanderTarget - this.wander) * (1 - Math.exp(-dt / 1.2));
    const x = this.excitement;
    const act = active ? 1 : 0.55;
    const bed = act * (0.1 + 0.06 * x) * (1 + 0.18 * this.wander);
    if (this.textures) {
      this.pMurmur?.set(bed, now);
      this.pExcite?.set(act * 0.5 * Math.pow(x, 1.6), now);
      this.pExciteLP?.set(1400 + 4200 * x, now);
    } else {
      this.pNoiseBed.set(bed * 0.5, now);
      this.pNoiseLP.set(1300 + 2200 * x, now);
    }
    // Retire finished one-shots.
    for (let i = this.oneShots.length - 1; i >= 0; i--) {
      const o = this.oneShots[i];
      if (o.end < now) {
        disconnect(o.g, o.src);
        this.oneShots.splice(i, 1);
      }
    }
  }

  /** Temporary excitement bump (shots on goal, big hits near a goal). */
  excite(amount: number): void {
    this.boost = Math.min(0.6, this.boost + amount);
  }

  get level(): number {
    return this.excitement;
  }

  /** One-shot reaction. amount: 0..1 scale. Repeats of the same reaction within 0.7 s merge (no stacking). */
  react(kind: CrowdReaction, amount: number, at = this.s.now): void {
    if (this.disposed) return;
    const a = clamp01(amount);
    if (a <= 0.01) return;
    const last = this.lastReact[kind];
    if (at - last.t < 0.7 && a <= last.a * 1.2) return;
    last.t = at;
    last.a = a;
    if (this.oneShots.length > 10) return;
    const t = at + 0.02;
    const tex = this.textures;
    switch (kind) {
      case 'roar':
        this.boost = Math.min(0.8, this.boost + 0.6 * a);
        if (tex) {
          this.shot(tex.cheer, t, 1.0, 1.25 * a, 0.2, 2.6, 1.3, 0);
          this.shot(tex.cheer, t + 0.05, 0.94, 0.9 * a, 0.3, 2.3, 1.2, 0.35);
          this.shot(tex.applause, t + 0.9, 1.0, 0.8 * a, 0.5, 2.2, 1.4, 0);
        } else this.noiseSwell(t, 1.1 * a, 0.25, 2.5, 1.2, 1800);
        break;
      case 'cheer':
        this.boost = Math.min(0.8, this.boost + 0.3 * a);
        if (tex) {
          this.shot(tex.cheer, t, 1.02, 0.7 * a, 0.25, 0.8 + 0.6 * a, 0.7, 0);
          if (a > 0.6) this.shot(tex.applause, t + 0.5, 1, 0.5 * a, 0.4, 1.2, 0.9, 0);
        } else this.noiseSwell(t, 0.8 * a, 0.25, 0.9, 0.7, 1600);
        break;
      case 'ooh':
        if (tex) this.shot(tex.ooh, t, this.rng.range(0.97, 1.03), 0.55 * a, 0.03, 1.8, 0.4, 0);
        else this.noiseSwell(t, 0.5 * a, 0.35, 0.6, 0.5, 700);
        break;
      case 'aww':
        if (tex) this.shot(tex.aww, t, 0.97, 0.6 * a, 0.03, 1.8, 0.4, 0);
        else this.noiseSwell(t, 0.45 * a, 0.3, 0.6, 0.6, 600);
        break;
      case 'applause':
        if (tex) this.shot(tex.applause, t, 1, 0.7 * a, 0.35, 1.8, 1.0, 0);
        else this.noiseSwell(t, 0.4 * a, 0.3, 1.5, 0.8, 2500);
        break;
    }
  }

  /** Play a texture one-shot with an attack / hold / release envelope. */
  private shot(b: AudioBuffer, t: number, rate: number, peak: number, attack: number, hold: number, release: number, offset: number): void {
    const s = this.s;
    const g = s.gain(0, this.out);
    const src = s.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    src.connect(g);
    const maxOff = Math.max(0, b.duration - (attack + hold + release * 3) * rate);
    src.start(t, Math.min(offset, maxOff));
    const end = t + attack + hold + release * 5;
    src.stop(end);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold * 0.5);
    g.gain.linearRampToValueAtTime(peak * 0.8, t + attack + hold);
    g.gain.setTargetAtTime(0, t + attack + hold, release);
    this.oneShots.push({ src, g, end: end + 0.1 });
  }

  private noiseSwell(t: number, peak: number, attack: number, hold: number, release: number, center: number): void {
    const s = this.s;
    const g = s.gain(0, this.out);
    const bp = s.filter('bandpass', center, 0.6, g);
    const src = s.noise('pink', t, attack + hold + release * 5, bp);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.setTargetAtTime(0, t + attack + hold, release);
    this.oneShots.push({ src, g, end: t + attack + hold + release * 5 + 0.1 });
  }

  dispose(): void {
    this.disposed = true;
    for (const o of this.oneShots) {
      stopSource(o.src);
      disconnect(o.g, o.src);
    }
    this.oneShots.length = 0;
    stopSource(this.noiseSrc);
    stopSource(this.murmurSrc);
    stopSource(this.exciteSrc);
    disconnect(this.noiseSrc, this.murmurSrc, this.exciteSrc, this.murmurGain, this.exciteGain, this.exciteLP, this.noiseBed, this.out, this.send);
  }
}
