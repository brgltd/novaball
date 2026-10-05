/**
 * NOVABALL audio — the static mixing graph.
 *
 *   gameplay ─→ slowMoLP ─┐
 *   crowd ────────────────┤
 *   events ───────────────┼→ worldTrim → worldPauseLP → sfxVol ─┐
 *   stadiumSend → [stadium IR] → stadiumReturn ┘                │
 *                                                                │
 *   music ─┐                                                     │
 *   hallSend → [hall IR] → hallReturn ┤                          ├→ master → glue compressor → ×0.5 → soft clip → out
 *                   musicIn → musicDuck → musicTrim → musicLP → musicVol ┘
 *   ui ─→ uiVol ─────────────────────────────────────────────────┘   (UI is never muffled)
 *
 * Volumes come from Settings (master / sfx / music; UI and crowd are under sfx).
 * The two convolvers start empty (silent returns) and get their impulse responses through setReverb(): for a live
 * context that happens in idle time just after the unlock (assigning an IR costs ~5–10 ms of main thread each).
 */
import { getBuffers, type BufferSet, type ReverbKind } from './buffers';
import { kRate } from './synth';
import { SmoothParam, clamp01, disconnect, volumeTaper } from './util';

export class AudioGraph {
  readonly ctx: BaseAudioContext;
  readonly buffers: BufferSet;
  readonly nyquist: number;

  /** Car engines + gameplay one-shots (slow-mo filtered). */
  readonly gameplay: GainNode;
  /** Crowd bed and reactions. */
  readonly crowd: GainNode;
  /** Match-level events: goal boom, horns, countdown, alarms, surge (not slow-mo filtered). */
  readonly events: GainNode;
  /** World reverb send (stadium). */
  readonly stadiumSend: GainNode;
  /** Music instrument input. */
  readonly music: GainNode;
  /** Music reverb send (lush hall/plate). */
  readonly hallSend: GainNode;
  /** UI sounds. */
  readonly ui: GainNode;

  private readonly slowMoLP: BiquadFilterNode;
  private readonly gameplayMute: GainNode;
  private readonly worldTrim: GainNode;
  private readonly worldPauseLP: BiquadFilterNode;
  private readonly sfxVol: GainNode;
  private readonly stadium: ConvolverNode;
  private readonly stadiumReturn: GainNode;
  private readonly hall: ConvolverNode;
  private readonly hallReturn: GainNode;
  private readonly musicIn: GainNode;
  private readonly musicDuck: GainNode;
  private readonly musicTrim: GainNode;
  private readonly musicLP: BiquadFilterNode;
  private readonly musicVol: GainNode;
  private readonly uiVol: GainNode;
  private readonly master: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly clipPre: GainNode;
  private readonly clip: WaveShaperNode;

  private readonly pSlowLP: SmoothParam;
  private readonly pSlowGain: SmoothParam;
  private readonly pWorldTrim: SmoothParam;
  private readonly pWorldLP: SmoothParam;
  private readonly pMusicTrim: SmoothParam;
  private readonly pMusicLP: SmoothParam;

  private paused = false;
  private replay = false;
  private menu = false;
  private slowMo = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination, buffers: BufferSet = getBuffers(ctx)) {
    this.ctx = ctx;
    this.buffers = buffers;
    this.nyquist = ctx.sampleRate / 2;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const lp = (f: number, q = 0.7071) => {
      const n = ctx.createBiquadFilter();
      kRate(n.frequency);
      kRate(n.Q);
      n.type = 'lowpass';
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const conv = () => {
      const c = ctx.createConvolver();
      c.normalize = true; // applied when the IR is assigned (setReverb)
      return c;
    };

    // ---- master chain ----
    this.master = g(volumeTaper(0.8));
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 9;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.2;
    this.clipPre = g(0.5);
    this.clip = ctx.createWaveShaper();
    this.clip.curve = this.buffers.curveSoftClip;
    this.clip.oversample = 'none';
    this.master.connect(this.comp);
    this.comp.connect(this.clipPre);
    this.clipPre.connect(this.clip);
    this.clip.connect(destination);

    // ---- world (sfx) ----
    this.gameplay = g(1);
    this.crowd = g(1);
    this.events = g(1);
    this.slowMoLP = lp(this.nyquist, 0.8);
    this.worldTrim = g(1);
    this.worldPauseLP = lp(this.nyquist, 0.9);
    this.sfxVol = g(volumeTaper(0.9));
    this.gameplayMute = g(1);
    this.gameplay.connect(this.slowMoLP);
    this.slowMoLP.connect(this.gameplayMute);
    this.gameplayMute.connect(this.worldTrim);
    this.crowd.connect(this.worldTrim);
    this.events.connect(this.worldTrim);
    this.worldTrim.connect(this.worldPauseLP);
    this.worldPauseLP.connect(this.sfxVol);
    this.sfxVol.connect(this.master);

    this.stadiumSend = g(1);
    this.stadium = conv();
    this.stadiumReturn = g(0.9);
    this.stadiumSend.connect(this.stadium);
    this.stadium.connect(this.stadiumReturn);
    this.stadiumReturn.connect(this.worldTrim);

    // ---- music ----
    this.music = g(1);
    this.musicIn = g(1);
    this.musicDuck = g(1);
    this.musicTrim = g(1);
    this.musicLP = lp(this.nyquist, 0.8);
    this.musicVol = g(volumeTaper(0.55));
    this.music.connect(this.musicIn);
    this.musicIn.connect(this.musicDuck);
    this.musicDuck.connect(this.musicTrim);
    this.musicTrim.connect(this.musicLP);
    this.musicLP.connect(this.musicVol);
    this.musicVol.connect(this.master);

    this.hallSend = g(1);
    this.hall = conv();
    this.hallReturn = g(0.8);
    this.hallSend.connect(this.hall);
    this.hall.connect(this.hallReturn);
    this.hallReturn.connect(this.musicIn);

    // ---- ui ----
    this.ui = g(1);
    this.uiVol = g(volumeTaper(0.9));
    this.ui.connect(this.uiVol);
    this.uiVol.connect(this.master);

    this.pSlowLP = new SmoothParam(this.slowMoLP.frequency, 0.08, 1, 0.01);
    this.pSlowGain = new SmoothParam(this.gameplay.gain, 0.08);
    this.pWorldTrim = new SmoothParam(this.worldTrim.gain, 0.12);
    this.pWorldLP = new SmoothParam(this.worldPauseLP.frequency, 0.06, 1, 0.01);
    this.pMusicTrim = new SmoothParam(this.musicTrim.gain, 0.15);
    this.pMusicLP = new SmoothParam(this.musicLP.frequency, 0.1, 1, 0.01);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /**
   * Give a reverb its impulse response (once; later calls are ignored). The IR's sample rate must equal the context's
   * (ConvolverNode requirement). Returns false if the browser rejected it (the reverb then stays dry).
   */
  setReverb(kind: ReverbKind, ir: AudioBuffer): boolean {
    const c = kind === 'stadium' ? this.stadium : this.hall;
    if (c.buffer) return true;
    try {
      c.buffer = ir;
      return true;
    } catch {
      return false;
    }
  }

  /** Which reverbs have their impulse response. */
  get reverbReady(): { stadium: boolean; hall: boolean } {
    return { stadium: !!this.stadium.buffer, hall: !!this.hall.buffer };
  }

  /** Final output node (after the soft clipper) — tap it for meters / scopes. */
  get output(): AudioNode {
    return this.clip;
  }

  /** Master output node (after the soft clipper) is the destination passed to the constructor. */
  setVolumes(master: number, sfx: number, music: number): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(volumeTaper(master), t, 0.03);
    this.sfxVol.gain.setTargetAtTime(volumeTaper(sfx), t, 0.03);
    this.uiVol.gain.setTargetAtTime(volumeTaper(sfx), t, 0.03);
    this.musicVol.gain.setTargetAtTime(volumeTaper(music), t, 0.03);
  }

  /**
   * Per-frame global state: pause muffle, slow-mo, replay, attract-mode (menu) attenuation, and `dead`
   * (the player's car is demolished: gameplay sounds muffled until respawn).
   */
  setState(paused: boolean, timeScale: number, replay: boolean, menu: boolean, dead = false): void {
    const t = this.ctx.currentTime;
    const ts = Number.isFinite(timeScale) ? timeScale : 1;
    // 1 → 0, 0.25 → 1 (full effect at the goal slow-mo scale).
    const slow = paused ? 0 : clamp01((1 - ts) / 0.75);
    this.paused = paused;
    this.replay = replay;
    this.menu = menu;
    this.slowMo = slow;
    // Slow-mo: gentle low-pass (nyquist → ~3.2 kHz, exponential) and a small dip on gameplay sounds.
    let cutoff = this.nyquist * Math.pow(3200 / this.nyquist, slow);
    if (dead && !replay && cutoff > 1400) cutoff = 1400;
    this.pSlowLP.set(cutoff, t, dead ? 0.15 : 0.08);
    this.pSlowGain.set((1 - 0.18 * slow) * (dead && !replay ? 0.75 : 1), t);
    // World: muffled + quieter when paused, attenuated behind the main menu (attract mode).
    this.pWorldTrim.set((paused ? 0.5 : 1) * (menu ? 0.32 : 1), t);
    this.pWorldLP.set(paused ? 480 : this.nyquist, t, paused ? 0.05 : 0.12);
    // Music: lightly muffled when paused, a touch of "flashback" filtering in replays.
    this.pMusicTrim.set(paused ? 0.7 : replay ? 0.85 : 1, t);
    this.pMusicLP.set(paused ? 1200 : replay ? 5200 : this.nyquist, t, paused ? 0.08 : 0.2);
  }

  /** Debug / test: hard-mute a bus (isolated level measurements, sandbox solo buttons). */
  mute(bus: 'gameplay' | 'crowd' | 'events' | 'music' | 'ui', on: boolean): void {
    const node = bus === 'gameplay' ? this.gameplayMute : bus === 'crowd' ? this.crowd : bus === 'events' ? this.events : bus === 'music' ? this.musicIn : this.ui;
    node.gain.cancelScheduledValues(0);
    node.gain.setValueAtTime(on ? 0 : 1, this.ctx.currentTime);
  }

  /** Sidechain-style music duck (goal roar etc.). depth 0..1 of the music level. */
  duckMusic(depth: number, attack: number, hold: number, release: number, at = this.ctx.currentTime): void {
    const p = this.musicDuck.gain;
    const target = 1 - clamp01(depth);
    holdParam(p, at);
    p.setTargetAtTime(target, at, Math.max(0.005, attack / 3));
    p.setTargetAtTime(1, at + attack + hold, Math.max(0.01, release / 3));
  }

  get slowMoAmount(): number {
    return this.slowMo;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get isReplay(): boolean {
    return this.replay;
  }
  get isMenu(): boolean {
    return this.menu;
  }

  dispose(): void {
    disconnect(
      this.gameplay, this.crowd, this.events, this.stadiumSend, this.stadium, this.stadiumReturn, this.slowMoLP, this.gameplayMute,
      this.worldTrim, this.worldPauseLP, this.sfxVol, this.music, this.musicIn, this.hallSend, this.hall, this.hallReturn,
      this.musicDuck, this.musicTrim, this.musicLP, this.musicVol, this.ui,
      this.uiVol, this.master, this.comp, this.clipPre, this.clip,
    );
  }
}

/** Freeze an AudioParam at its current automated value (cancelAndHoldAtTime when available). */
export function holdParam(p: AudioParam, at: number): void {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === 'function') {
    try {
      anyP.cancelAndHoldAtTime(at);
      return;
    } catch {
      /* fall through */
    }
  }
  // Fallback: only setTargetAtTime events are used on held params, so cancelling future events is click-free.
  p.cancelScheduledValues(at);
}
