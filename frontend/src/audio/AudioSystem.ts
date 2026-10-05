/**
 * NOVABALL — AudioSystem (100 % procedural Web Audio).
 *
 * Implements IAudioSystem (src/contracts.ts). No AudioContext exists until unlock() (called from a user gesture);
 * every public method is a safe no-op before that, when Web Audio is unavailable, or after dispose(), and never throws.
 *
 * Startup cost: the constructor (called while the game loads) starts preparing the heavy procedural data — noise
 * colors, reverb impulse responses, crowd-choir textures — in idle time (core/idle.ts), before any context exists.
 * unlock(), which runs inside the first click / key press, then only creates the context and the nodes; the two
 * convolvers get their impulse responses in idle steps right after it (reverb returns are silent for a moment).
 *
 * Modules:
 *   core/graph      buses, stadium + hall convolution reverbs, pause muffle, slow-mo filter, music ducking,
 *                   master glue compressor + soft clipper
 *   core/voices     one-shot voice pool (caps, stealing, spatial output chains, cleanup)
 *   core/spatial    listener-relative pan / distance / air absorption / Doppler
 *   sfx/*           one-shot recipes (gameplay, match events, UI)
 *   engines         player engine, 3 nearest NPC engines, ball voice, surge hum (long-lived nodes)
 *   crowd           formant-synthesized crowd (murmur / cheer / ooh / aww / applause) + excitement model
 *   music/*         synthwave sequencer (lookahead scheduler), instruments, songs, stingers
 */
import type { Quaternion, Vector3 } from 'three';
import type { AudioFrame, IAudioSystem, MusicState, Stinger, UiSound } from '../contracts';
import type { Settings } from '../settings';
import { ARENA, PAD_LAYOUT } from '../sim/constants';
import type { CarSnapshot, SimEvent, Team, Vec3Like, WorldSnapshot } from '../sim/types';
import { getBuffers, keepOnlyRate, prebakeBuffers, reverbIR, type ReverbKind } from './core/buffers';
import { AudioGraph } from './core/graph';
import { PRIO, idle, type JobGen } from './core/idle';
import { Listener, makeSpatial, type SpatialResult } from './core/spatial';
import { Synth } from './core/synth';
import { Rng, clamp, clamp01 } from './core/util';
import { VoicePool, type VoiceCat } from './core/voices';
import { Crowd, renderCrowdTextures } from './crowd';
import { BallVoice, NpcEngine, PlayerEngine, SurgeHum } from './engines';
import { Music } from './music/Music';
import * as E from './sfx/events';
import * as G from './sfx/gameplay';
import { uiSound } from './sfx/ui';

/** Per-sound output levels (linear), tuned with the offline render check (src/audio/offlineCheck.ts). */
export const SFX_MIX = {
  ballHit: 1.8,
  bounce: 1.5,
  carImpact: 1.3,
  carBump: 0.9,
  jump: 0.6,
  dodge: 0.6,
  land: 0.5,
  pickupSmall: 0.5,
  pickupBig: 0.6,
  demolish: 0.9,
  respawn: 0.45,
  pulse: 0.75,
  chargeUp: 0.55,
  supernova: 0.65,
  chargeDown: 0.38,
  chargeSteal: 0.45,
  chargeLost: 0.45,
  goalBoom: 0.95,
  horn: 0.55,
  euphoria: 0.55,
  concede: 0.45,
  countdown: 0.42,
  go: 0.5,
  surgeAlarm: 0.5,
  surgeStart: 0.62,
  surgeEnd: 0.5,
  tick: 0.8,
  replayWhoosh: 0.7,
  boostIgnite: 0.45,
  sonicBoom: 0.5,
  pulseReady: 0.4,
  /** Other cars' jumps / dodges / landings / pickups relative to the player's own. */
  others: 0.5,
  ui: { hover: 0.5, click: 0.7, back: 0.9, start: 0.5, toggle: 0.6, error: 0.34 } as Record<UiSound, number>,
};

const LOOKAHEAD = 0.2;
/** Other cars' engines relative to the player's (before distance attenuation). */
const NPC_ENGINE_LEVEL = 0.2;
/** Inverse-distance rolloff for one-shots (gentler than physical: hear the whole field). */
const ROLLOFF = 0.8;
const START_OFFSET = 0.006;
const NPC_SLOTS = 3;
const MAX_CARS = 8;

type Ctor = new (opts?: AudioContextOptions) => AudioContext;

function audioContextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A one-step idle job. */
function* call(fn: () => void): JobGen<void> {
  fn();
}

let prebakeStarted = false;
/** Start the idle-time preparation of everything unlock() will need (once per page; only with Web Audio). */
function prebake(): void {
  if (prebakeStarted || !audioContextCtor()) return;
  prebakeStarted = true;
  warmAudioService();
  prebakeBuffers();
  void renderCrowdTextures();
}

/**
 * The first `new AudioContext()` of a page blocks on the browser bringing up its audio service / output device
 * (Chrome: a synchronous device-authorization round trip, measured 27–70 ms on a busy page). Enumerating the media
 * devices beforehand warms that path asynchronously (no permission needed, no prompt, no console output), and the
 * constructor inside the first user gesture then takes ~3 ms. Creating the context itself before the gesture is
 * not an option: it would start suspended with an autoplay warning.
 */
function warmAudioService(): void {
  try {
    const md = (globalThis as unknown as { navigator?: { mediaDevices?: { enumerateDevices?: () => Promise<unknown> } } }).navigator?.mediaDevices;
    if (md && typeof md.enumerateDevices === 'function') void md.enumerateDevices().catch(() => undefined);
  } catch {
    /* unavailable (insecure context, old browser): the unlock just pays the full constructor cost */
  }
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function findCar(snap: WorldSnapshot, id: number): CarSnapshot | null {
  if (id < 0) return null;
  const cars = snap.cars;
  const c = cars[id];
  if (c && c.id === id) return c;
  for (let i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i];
  return null;
}

export class AudioSystem implements IAudioSystem {
  private ctx: BaseAudioContext | null = null;
  private realtime = false;
  private graph: AudioGraph | null = null;
  private synth: Synth | null = null;
  private pool: VoicePool | null = null;
  private music: Music | null = null;
  private crowd: Crowd | null = null;
  private player: PlayerEngine | null = null;
  private npcs: NpcEngine[] = [];
  private ballVoice: BallVoice | null = null;
  private surgeHum: SurgeHum | null = null;
  private readonly listener = new Listener();
  private readonly sp: SpatialResult = makeSpatial();
  private timer: ReturnType<typeof setInterval> | null = null;
  private visHandler: (() => void) | null = null;
  private suspendedByVisibility = false;
  private disposed = false;
  private warned = false;
  private crowdReady: Promise<void> = Promise.resolve();
  private reverbReady: Promise<void> = Promise.resolve();
  /** performance.now() of the unlock, duration of its synchronous part, and time until crowd + reverbs were ready. */
  private unlockAt = -1;
  private unlockMs = -1;
  private ctorMs = -1;
  private buildMs: Record<string, number> = {};
  private readyMs = -1;

  private vol = { master: 0.8, sfx: 0.9, music: 0.55 };
  private musicState: MusicState = 'off';
  private musicIntensity = 0;

  // Per-frame bookkeeping.
  private playerId = -1;
  private playerTeam: Team = 0;
  private listenerReady = false;
  private prevBoosting = false;
  private prevSupersonic = false;
  private prevPulseReady = 1;
  private prevPhase = '';
  private chargeTeam: Team | -1 = -1;
  private pitch = 1;
  private inReplay = false;
  private playerAcc = 1;
  private npcAssignAcc = 1;
  /** Per-slot control accumulators with staggered initial phases. */
  private readonly npcAcc = [1 / 20, 1 / 20 - 1 / 60, 1 / 20 - 2 / 60];
  /** Starts half a period behind the NPC accumulator so the two interleave at 60 fps. */
  private ballAcc = 1 / 60;
  private lastUpdateWall = 0;
  private lastTickWall = 0;
  // Throttles.
  private lastHitT = -1;
  private lastHitK = 0;
  private lastBounceT = -1;
  private lastBounceK = 0;
  private lastBumpT = -1;
  private lastHoverT = -1;
  private lastIgniteT = -1;
  private surgeAlarmUntil = -1;
  private readonly carImpactT = new Float64Array(MAX_CARS).fill(-1);
  private readonly landT = new Float64Array(MAX_CARS).fill(-1);
  private readonly moveT = new Float64Array(MAX_CARS).fill(-1);
  // NPC slot selection scratch.
  private readonly candId = new Int32Array(MAX_CARS);
  private readonly candD = new Float64Array(MAX_CARS);

  /** Diagnostics for dev overlays / tests. */
  readonly stats = { updates: 0, events: 0, lastUpdateMs: 0, maxUpdateMs: 0 };

  constructor() {
    try {
      prebake();
    } catch (e) {
      this.warn('prebake', e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    try {
      if (!this.ctx) {
        const C = audioContextCtor();
        if (!C) return Promise.resolve();
        const t0 = clock();
        this.unlockAt = t0;
        idle.resetPeaks();
        let ctx: AudioContext;
        try {
          ctx = new C({ latencyHint: 'interactive' });
        } catch {
          ctx = new C();
        }
        this.ctorMs = clock() - t0;
        this.realtime = true;
        this.build(ctx, ctx.destination);
        this.startTimer();
        this.installVisibility();
        this.primeIOS(ctx);
        this.unlockMs = clock() - t0;
      }
      const ctx = this.ctx as AudioContext | null;
      if (ctx && this.realtime && ctx.state !== 'running' && typeof ctx.resume === 'function') {
        const p = ctx.resume().catch(() => undefined);
        return Promise.race([p, new Promise<void>((r) => setTimeout(r, 500))]).then(() => undefined, () => undefined);
      }
    } catch (e) {
      this.warn('unlock', e);
    }
    return Promise.resolve();
  }

  /**
   * Build the full audio graph on an existing context (e.g. an OfflineAudioContext for render checks / tests).
   * `destination` defaults to ctx.destination. Returns a promise resolved when the crowd textures are ready.
   */
  attachContext(ctx: BaseAudioContext, destination?: AudioNode): Promise<void> {
    if (this.disposed || this.ctx) return this.crowdReady;
    try {
      this.realtime = false;
      this.build(ctx, destination ?? ctx.destination);
    } catch (e) {
      this.warn('attachContext', e);
    }
    return this.crowdReady;
  }

  /** The audio context (null before unlock). */
  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /** Final mix node (post limiter) for meters / scopes; null before unlock. Connect it to an AnalyserNode. */
  get outputNode(): AudioNode | null {
    return this.graph?.output ?? null;
  }

  /** Debug / test hook: hard-mute a bus (solo measurements). */
  debugMute(bus: 'gameplay' | 'crowd' | 'events' | 'music' | 'ui', on: boolean): void {
    try {
      if (bus === 'crowd') this.crowd?.setMuted(on);
      else this.graph?.mute(bus, on);
    } catch (e) {
      this.warn('debugMute', e);
    }
  }

  /** Debug / test hook: schedule the music up to context time `until` (offline renders without a frame loop). */
  debugPumpMusic(until: number): void {
    try {
      this.music?.pump(until);
    } catch (e) {
      this.warn('debugPumpMusic', e);
    }
  }

  /** Resolves when the crowd textures (or their noise fallback, on failure) and both reverbs are in place. */
  whenReady(): Promise<void> {
    return Promise.all([this.crowdReady, this.reverbReady]).then(() => undefined);
  }

  private build(ctx: BaseAudioContext, dest: AudioNode): void {
    this.ctx = ctx;
    const live = this.realtime;
    // Noise + curves were prepared before the unlock (finished inline only if the gesture beat the prebake). A live
    // context at an uncommon rate reuses the 48 kHz noise (buffer sources resample) rather than synthesizing here.
    let tb = clock();
    const lap = (k: string) => {
      const t = clock();
      this.buildMs[k] = round2(t - tb);
      tb = t;
    };
    const buffers = getBuffers(ctx, !live);
    lap('buffers');
    const graph = new AudioGraph(ctx, dest, buffers);
    this.graph = graph;
    const synth = new Synth(ctx, graph.buffers, new Rng(0x70a1));
    this.synth = synth;
    this.pool = new VoicePool(ctx, 30);
    lap('graph');
    this.music = new Music(synth, graph);
    lap('music');
    this.crowd = new Crowd(synth, graph.crowd, graph.stadiumSend);
    lap('crowd');
    this.player = new PlayerEngine(synth, graph.gameplay);
    this.npcs = [];
    for (let i = 0; i < NPC_SLOTS; i++) this.npcs.push(new NpcEngine(synth, graph.gameplay, graph.stadiumSend, i + 1));
    this.ballVoice = new BallVoice(synth, graph.gameplay);
    this.surgeHum = new SurgeHum(synth, graph.events);
    lap('engines');
    graph.setVolumes(this.vol.master, this.vol.sfx, this.vol.music);
    this.music.setIntensity(this.musicIntensity);
    if (this.musicState !== 'off') this.music.setState(this.musicState);
    const crowd = this.crowd;
    this.crowdReady = crowd.load().catch(() => undefined);
    lap('rest');
    if (live) {
      this.reverbReady = this.loadReverbs(graph, ctx);
      const at = this.unlockAt;
      void this.whenReady().then(() => {
        if (at >= 0) this.readyMs = clock() - at;
      });
    } else {
      // Offline renders: everything in place before rendering starts (deterministic checks).
      graph.setReverb('stadium', reverbIR('stadium', ctx).now());
      graph.setReverb('hall', reverbIR('hall', ctx).now());
    }
  }

  /**
   * Live context: the reverb IRs (prepared before the unlock for the common device rates, otherwise synthesized now)
   * are assigned in idle steps — each assignment is ~5–10 ms of main thread (FFT partitioning), kept out of the gesture.
   */
  private loadReverbs(graph: AudioGraph, ctx: BaseAudioContext): Promise<void> {
    keepOnlyRate(ctx.sampleRate);
    idle.hurry();
    const assign = (kind: ReverbKind, prio: number, ir: AudioBuffer): Promise<void> =>
      idle.run(
        `reverb:${kind}`,
        call(() => {
          if (this.graph === graph && !this.disposed && !graph.setReverb(kind, ir)) this.warn('reverb ' + kind, new Error('impulse response rejected'));
        }),
        prio,
      ).promise;
    // A job cancelled under us (another context's keepOnlyRate) is simply requested again.
    const load = (kind: ReverbKind, prio: number): Promise<void> =>
      reverbIR(kind, ctx, prio).promise.then(
        (ir) => assign(kind, prio, ir),
        () => (this.disposed ? undefined : reverbIR(kind, ctx, prio).promise.then((ir) => assign(kind, prio, ir))),
      );
    // Stadium (gameplay) first, then the music hall.
    return Promise.all([load('stadium', PRIO.live + 1), load('hall', PRIO.live)]).then(
      () => undefined,
      (e) => this.warn('reverb', e),
    );
  }

  private startTimer(): void {
    if (this.timer !== null || typeof setInterval !== 'function') return;
    this.timer = setInterval(() => this.tick(), 25);
  }

  /** Timer tick: keeps the music scheduled even if frames stall or update() isn't called (menus, loading). */
  private tick(): void {
    if (!this.ctx || this.disposed) return;
    try {
      const now = this.ctx.currentTime;
      this.lastTickWall = typeof performance !== 'undefined' ? performance.now() : 0;
      this.music?.pump(now + LOOKAHEAD);
      this.pool?.retire(now);
      // Watchdog: if the game stops calling update() (static menu, loading screen), fade the continuous voices
      // instead of leaving the last engine / crowd state humming forever.
      const wall = typeof performance !== 'undefined' ? performance.now() : 0;
      if (this.lastUpdateWall > 0 && wall - this.lastUpdateWall > 600) {
        this.player?.silence(now);
        for (const n of this.npcs) n.silence(now);
        this.ballVoice?.silence(now);
        this.surgeHum?.silence(now);
        this.crowd?.update(now, 0.025, 0, false);
      }
    } catch (e) {
      this.warn('tick', e);
    }
  }

  private installVisibility(): void {
    if (typeof document === 'undefined' || this.visHandler) return;
    this.visHandler = () => {
      const ctx = this.ctx as AudioContext | null;
      if (!ctx || !this.realtime || this.disposed) return;
      try {
        if (document.hidden) {
          if (ctx.state === 'running') {
            this.suspendedByVisibility = true;
            void ctx.suspend().catch(() => undefined);
          }
        } else if (this.suspendedByVisibility) {
          this.suspendedByVisibility = false;
          void ctx.resume().catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('visibilitychange', this.visHandler);
  }

  /** iOS/Safari: playing a silent buffer inside the gesture fully unlocks output. */
  private primeIOS(ctx: AudioContext): void {
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch {
      /* ignore */
    }
  }

  applySettings(s: Settings): void {
    try {
      const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d);
      this.vol = { master: n(s?.masterVolume, 0.8), sfx: n(s?.sfxVolume, 0.9), music: n(s?.musicVolume, 0.55) };
      this.graph?.setVolumes(this.vol.master, this.vol.sfx, this.vol.music);
    } catch (e) {
      this.warn('applySettings', e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      if (this.visHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visHandler);
      this.visHandler = null;
      this.pool?.stopAll();
      this.music?.dispose();
      this.crowd?.dispose();
      this.player?.dispose();
      for (const n of this.npcs) n.dispose();
      this.ballVoice?.dispose();
      this.surgeHum?.dispose();
      this.graph?.dispose();
      const ctx = this.ctx as AudioContext | null;
      if (ctx && this.realtime && typeof ctx.close === 'function') void ctx.close().catch(() => undefined);
    } catch {
      /* ignore */
    }
    this.graph = null;
    this.synth = null;
    this.pool = null;
    this.music = null;
    this.crowd = null;
    this.player = null;
    this.npcs = [];
    this.ballVoice = null;
    this.surgeHum = null;
    this.ctx = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Music
  // ---------------------------------------------------------------------------------------------

  setMusic(state: MusicState): void {
    this.musicState = state;
    try {
      this.music?.setState(state);
      if (this.ctx) this.music?.pump(this.ctx.currentTime + LOOKAHEAD);
    } catch (e) {
      this.warn('setMusic', e);
    }
  }

  setMusicIntensity(x: number): void {
    this.musicIntensity = clamp01(Number.isFinite(x) ? x : 0);
    try {
      this.music?.setIntensity(this.musicIntensity);
    } catch (e) {
      this.warn('setMusicIntensity', e);
    }
  }

  playStinger(s: Stinger): void {
    if (!this.graph || !this.synth || this.disposed) return;
    try {
      if (s === 'replayStart' || s === 'replayEnd') {
        this.oneShot('event', 6, this.graph.events, SFX_MIX.replayWhoosh, null, 0.3, (t, out) => E.replayWhoosh(this.synth!, t, out, s === 'replayStart'));
        this.listener.resetMotion();
        return;
      }
      this.music?.stinger(s);
    } catch (e) {
      this.warn('playStinger', e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------------------------

  playUi(s: UiSound): void {
    if (!this.graph || !this.synth || this.disposed) return;
    try {
      const now = this.ctx!.currentTime;
      if (s === 'hover') {
        if (now - this.lastHoverT < 0.04) return;
        this.lastHoverT = now;
      }
      this.oneShot('ui', s === 'hover' ? 1 : 4, this.graph.ui, SFX_MIX.ui[s] ?? 0.3, null, 0, (t, out) => uiSound(this.synth!, t, out, s));
    } catch (e) {
      this.warn('playUi', e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Continuous sounds
  // ---------------------------------------------------------------------------------------------

  update(dt: number, frame: AudioFrame): void {
    if (!this.graph || !this.ctx || this.disposed || !frame || !frame.snap) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    try {
      this.updateInner(Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0.016, frame);
    } catch (e) {
      this.warn('update', e);
    }
    if (t0) {
      const ms = performance.now() - t0;
      this.stats.lastUpdateMs = ms;
      if (ms > this.stats.maxUpdateMs) this.stats.maxUpdateMs = ms;
    }
    this.stats.updates++;
  }

  private updateInner(dt: number, f: AudioFrame): void {
    const ctx = this.ctx!;
    const graph = this.graph!;
    const now = ctx.currentTime;
    this.lastUpdateWall = typeof performance !== 'undefined' ? performance.now() : 0;
    const snap = f.snap;
    this.listener.update(f.listenerPos as Vector3, f.listenerQuat as Quaternion, dt);
    this.listenerReady = true;

    const pid = f.playerCarId;
    const pc = findCar(snap, pid);
    this.playerId = pc ? pid : -1;
    if (pc) this.playerTeam = pc.team;
    const dead = !!pc && pc.demolished;
    graph.setState(!!f.paused, f.timeScale, !!f.replay, this.musicState === 'menu', dead);
    this.pitch = 1 - 0.2 * graph.slowMoAmount;
    const P = this.pitch;
    if (f.replay !== this.inReplay) {
      this.inReplay = !!f.replay;
      this.listener.resetMotion();
    }

    // Player engine (control rate capped at ~90 Hz: high-refresh displays don't multiply the cost).
    this.playerAcc += dt;
    if (this.playerAcc >= 1 / 90 || !pc) {
      this.player!.update(now, this.playerAcc, pc, P);
      this.playerAcc = 0;
    }

    // Player feedback on state transitions (live play only).
    if (pc && !f.paused && !f.replay && snap.phase === 'playing' && !pc.demolished) {
      if (pc.boosting && !this.prevBoosting && now - this.lastIgniteT > 0.3) {
        this.lastIgniteT = now;
        this.oneShot('move', 5, graph.gameplay, SFX_MIX.boostIgnite, null, 0.1, (t, o) => G.boostIgnite(this.synth!, t, o, P));
      }
      if (pc.supersonic && !this.prevSupersonic) this.oneShot('move', 5, graph.gameplay, SFX_MIX.sonicBoom, null, 0.2, (t, o) => G.sonicBoom(this.synth!, t, o, P));
      if (pc.pulseReady01 >= 0.999 && this.prevPulseReady < 0.999) this.oneShot('ability', 3, graph.gameplay, SFX_MIX.pulseReady, null, 0.2, (t, o) => G.pulseReady(this.synth!, t, o));
    }
    this.prevBoosting = !!pc?.boosting;
    this.prevSupersonic = !!pc?.supersonic;
    this.prevPulseReady = pc ? pc.pulseReady01 : 1;

    // Nearest other cars: slot assignment at 20 Hz; each slot's voice at ~20 Hz with staggered phases (at most one
    // NPC voice per frame → even frame cost). The ball at ~30 Hz. Params are smoothed with 40–60 ms time constants,
    // so these control rates are inaudible and save main-thread automation calls (~1.5–3 µs each).
    this.npcAssignAcc += dt;
    if (this.npcAssignAcc >= 1 / 20) {
      this.npcAssignAcc = 0;
      this.assignNpcs(snap, pid);
    }
    let pick = -1;
    let most = 1 / 20;
    for (let i = 0; i < this.npcs.length; i++) {
      const a = (this.npcAcc[i] += dt);
      if (dt > 0.025 && a >= 1 / 20) {
        // Slow frames: update every due slot.
        this.npcAcc[i] = 0;
        this.updateNpc(i, now, snap, P);
      } else if (a >= most) {
        most = a;
        pick = i;
      }
    }
    if (pick >= 0) {
      this.npcAcc[pick] = 0;
      this.updateNpc(pick, now, snap, P);
    }
    this.ballAcc += dt;
    if (this.ballAcc >= 1 / 30) {
      this.ballAcc = 0;
      const ball = snap.ball;
      const bsp = this.listener.locate(ball.pos, this.sp, 4, 1);
      this.ballVoice!.update(now, ball, bsp, this.listener.doppler(ball.pos, ball.vel, 150), P);
    }

    // Surge ambience.
    this.surgeHum!.update(now, f.paused ? 0 : snap.surge);

    // Crowd.
    const menu = this.musicState === 'menu';
    this.crowd!.update(now, dt, this.excitement(snap, f), !menu);

    if (snap.phase !== this.prevPhase) {
      if (snap.phase === 'countdown') this.chargeTeam = -1;
      this.prevPhase = snap.phase;
    }

    this.pool!.retire(now);
    // Music is normally scheduled by the 25 ms timer (keeps node creation out of the frame); pump here only when
    // there is no timer (offline contexts) or it is being starved (heavy frames delaying timer tasks).
    const wall = this.lastUpdateWall;
    if (this.timer === null || wall - this.lastTickWall > 80) this.music!.pump(now + LOOKAHEAD);
  }

  private assignNpcs(snap: WorldSnapshot, pid: number): void {
    const cars = snap.cars;
    const lp = this.listener.pos;
    let n = 0;
    for (let i = 0; i < cars.length && n < MAX_CARS; i++) {
      const c = cars[i];
      if (c.id === pid || c.demolished) continue;
      const dx = c.pos.x - lp.x;
      const dy = c.pos.y - lp.y;
      const dz = c.pos.z - lp.z;
      this.candId[n] = c.id;
      this.candD[n] = dx * dx + dy * dy + dz * dz;
      n++;
    }
    // Insertion sort by distance (n ≤ 8).
    for (let i = 1; i < n; i++) {
      const id = this.candId[i];
      const d = this.candD[i];
      let j = i - 1;
      while (j >= 0 && this.candD[j] > d) {
        this.candId[j + 1] = this.candId[j];
        this.candD[j + 1] = this.candD[j];
        j--;
      }
      this.candId[j + 1] = id;
      this.candD[j + 1] = d;
    }
    const k = n < NPC_SLOTS ? n : NPC_SLOTS;
    const dLimit = k > 0 ? this.candD[k - 1] * 1.69 : 0; // hysteresis: keep a slot's car while within 1.3× of the k-th distance
    // Free slots whose car is gone or too far.
    for (const slot of this.npcs) {
      if (slot.carId < 0) continue;
      let keep = false;
      for (let i = 0; i < n; i++) {
        if (this.candId[i] === slot.carId) {
          keep = i < k || this.candD[i] <= dLimit;
          break;
        }
      }
      if (!keep) slot.carId = -1;
    }
    // Assign the nearest unassigned cars to free slots.
    for (let i = 0; i < k; i++) {
      const id = this.candId[i];
      let taken = false;
      for (const slot of this.npcs) if (slot.carId === id) taken = true;
      if (taken) continue;
      for (const slot of this.npcs) {
        if (slot.carId < 0) {
          slot.carId = id;
          break;
        }
      }
    }
  }

  private updateNpc(i: number, now: number, snap: WorldSnapshot, P: number): void {
    const slot = this.npcs[i];
    const car = slot.carId >= 0 ? findCar(snap, slot.carId) : null;
    if (!car) {
      slot.update(now, null, null, 1, P, 0);
      return;
    }
    const sp = this.listener.locate(car.pos, this.sp, 6, 1);
    slot.update(now, car, sp, this.listener.doppler(car.pos, car.vel), P, NPC_ENGINE_LEVEL);
  }

  /** Crowd excitement target 0..1 from the action. */
  private excitement(snap: WorldSnapshot, f: AudioFrame): number {
    if (f.replay) return 0.3;
    switch (snap.phase) {
      case 'countdown':
        return 0.35;
      case 'goal':
        return 0.75;
      case 'ended':
        return 0.5;
    }
    const b = snap.ball;
    if (!b.visible) return 0.5;
    const az = Math.abs(b.pos.z);
    const near = clamp01(1 - (ARENA.halfLength - az) / 32);
    const toward = clamp01((b.vel.z * (b.pos.z >= 0 ? 1 : -1)) / 25);
    const central = clamp01(1 - Math.abs(b.pos.x) / ARENA.halfWidth);
    const v = b.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    let x = 0.12 + 0.45 * near * near * (0.5 + 0.5 * central) + 0.25 * near * toward + 0.08 * clamp01(speed / 40);
    x += 0.07 * clamp(b.charge, 0, 3);
    x += 0.1 * snap.surge;
    return x;
  }

  // ---------------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------------

  handleEvents(events: ReadonlyArray<SimEvent>, frame: AudioFrame): void {
    if (!this.graph || !this.synth || this.disposed || !events || events.length === 0 || !frame) return;
    try {
      if (!this.listenerReady && frame.listenerPos && frame.listenerQuat) {
        this.listener.setPose(frame.listenerPos as Vector3, frame.listenerQuat as Quaternion);
        this.listenerReady = true;
      }
      const pc = findCar(frame.snap, frame.playerCarId);
      if (pc) {
        this.playerId = frame.playerCarId;
        this.playerTeam = pc.team;
      } else this.playerId = -1;
      for (let i = 0; i < events.length; i++) {
        try {
          this.handleEvent(events[i], frame);
        } catch (e) {
          this.warn('event ' + events[i]?.type, e);
        }
      }
      this.stats.events += events.length;
    } catch (e) {
      this.warn('handleEvents', e);
    }
  }

  /** Build a one-shot through the voice pool. `recipe` returns the end time. */
  private oneShot(
    cat: VoiceCat,
    prio: number,
    dest: AudioNode,
    gain: number,
    spatial: SpatialResult | null,
    send: number,
    recipe: (t: number, out: AudioNode) => number,
    delay = 0,
  ): void {
    const pool = this.pool!;
    const graph = this.graph!;
    const input = pool.acquire(cat, prio, { dest, reverb: graph.stadiumSend, send, spatial, gain });
    if (!input) return;
    const t = this.ctx!.currentTime + START_OFFSET + delay;
    let end = t + 1;
    try {
      end = recipe(t, input);
    } finally {
      pool.finish(input, end);
    }
  }

  private carPos(snap: WorldSnapshot, id: number): Vec3Like | null {
    const c = findCar(snap, id);
    return c ? c.pos : null;
  }

  /** Spatial for a car-attached sound; null (centered, full) for the player's own car. */
  private carSpatial(snap: WorldSnapshot, id: number): SpatialResult | null | undefined {
    if (id === this.playerId) return null;
    const p = this.carPos(snap, id);
    if (!p) return undefined;
    return this.listener.locate(p, this.sp, 6, ROLLOFF);
  }

  private handleEvent(e: SimEvent, f: AudioFrame): void {
    const s = this.synth!;
    const graph = this.graph!;
    const now = this.ctx!.currentTime;
    const P = this.pitch;
    const snap = f.snap;
    const replay = !!f.replay;
    const crowd = this.crowd!;
    const crowdScale = replay ? 0.45 : 1;
    const others = SFX_MIX.others;

    switch (e.type) {
      case 'ballHit': {
        const k = clamp01((e.strength - 1) / 30);
        if (now - this.lastHitT < 0.035 && k < this.lastHitK * 1.5) return;
        this.lastHitT = now;
        this.lastHitK = k;
        const charge = clamp(snap.ball.charge | 0, 0, 3);
        const sp = this.listener.locate(e.pos, this.sp, 7, ROLLOFF);
        const send = sp.send * (0.5 + 0.8 * k) * (e.aerial ? 1.3 : 1);
        this.oneShot('hit', 5 + 3 * k, graph.gameplay, SFX_MIX.ballHit, sp, send, (t, o) => G.ballHit(s, t, o, P, k, charge, !!e.dodge));
        // Big hits near a goal get the crowd going.
        const near = clamp01(1 - (ARENA.halfLength - Math.abs(e.pos.z)) / 25);
        if (k > 0.4 && near > 0.3) crowd.excite(0.25 * k * near * crowdScale);
        return;
      }
      case 'ballBounce': {
        if (e.speed < 2) return;
        const k = clamp01((e.speed - 2) / 22);
        if (now - this.lastBounceT < 0.045 && k < this.lastBounceK * 1.5) return;
        this.lastBounceT = now;
        this.lastBounceK = k;
        const wall = e.normal.y < 0.7;
        const sp = this.listener.locate(e.pos, this.sp, 7, ROLLOFF);
        this.oneShot('bounce', 2 + 2 * k, graph.gameplay, SFX_MIX.bounce, sp, sp.send * (0.6 + 0.6 * k), (t, o) => G.ballBounce(s, t, o, P, k, wall));
        // Crossbar / post rattles near the goal: "ooh".
        if (wall && k > 0.35 && Math.abs(e.pos.z) > ARENA.halfLength - 3 && Math.abs(e.pos.x) < ARENA.goalHalfWidth + 2 && e.pos.y < ARENA.goalHeight + 2) {
          crowd.react('ooh', 0.7 * crowdScale);
        }
        return;
      }
      case 'carImpact': {
        if (e.speed < 4) return;
        const id = e.carId;
        const slot = id >= 0 && id < MAX_CARS ? id : 0;
        if (now - this.carImpactT[slot] < 0.15) return;
        this.carImpactT[slot] = now;
        const k = clamp01((e.speed - 4) / 18);
        const sp = this.listener.locate(e.pos, this.sp, 6, ROLLOFF);
        const g = SFX_MIX.carImpact * (id === this.playerId ? 1 : 0.8);
        this.oneShot('impact', 2 + k, graph.gameplay, g, sp, sp.send * 0.8, (t, o) => G.carImpact(s, t, o, P, k));
        return;
      }
      case 'carBump': {
        if (now - this.lastBumpT < 0.1) return;
        this.lastBumpT = now;
        const k = clamp01(e.speed / 20);
        const sp = this.listener.locate(e.pos, this.sp, 6, ROLLOFF);
        const mine = e.aId === this.playerId || e.bId === this.playerId;
        this.oneShot('impact', 3 + 2 * k + (mine ? 2 : 0), graph.gameplay, SFX_MIX.carBump * (mine ? 1.1 : 0.85), sp, sp.send * 0.8, (t, o) => G.carBump(s, t, o, P, k));
        return;
      }
      case 'jump': {
        if (!this.moveOk(e.carId, now, 0.06)) return;
        const sp = this.carSpatial(snap, e.carId);
        if (sp === undefined) return;
        const mine = sp === null;
        this.oneShot('move', mine ? 4 : 1, graph.gameplay, SFX_MIX.jump * (mine ? 1 : others), sp, mine ? 0.08 : sp.send * 0.6, (t, o) => G.jump(s, t, o, P, !!e.double));
        return;
      }
      case 'dodge': {
        if (!this.moveOk(e.carId, now, 0.06)) return;
        const sp = this.carSpatial(snap, e.carId);
        if (sp === undefined) return;
        const mine = sp === null;
        this.oneShot('move', mine ? 4 : 1, graph.gameplay, SFX_MIX.dodge * (mine ? 1 : others), sp, mine ? 0.08 : sp.send * 0.6, (t, o) => G.dodge(s, t, o, P, clamp(e.rx, -1, 1)));
        return;
      }
      case 'land': {
        const id = e.carId;
        const slot = id >= 0 && id < MAX_CARS ? id : 0;
        if (now - this.landT[slot] < 0.2) return;
        this.landT[slot] = now;
        const sp = this.carSpatial(snap, id);
        if (sp === undefined) return;
        const mine = sp === null;
        const k = clamp01(e.speed / 10);
        this.oneShot('move', mine ? 3 : 1, graph.gameplay, SFX_MIX.land * (mine ? 1 : others), sp, mine ? 0.05 : sp.send * 0.5, (t, o) => G.land(s, t, o, P, k));
        return;
      }
      case 'boostPickup': {
        const mine = e.carId === this.playerId;
        let sp: SpatialResult | null = null;
        if (!mine) {
          const pad = PAD_LAYOUT[e.padIndex];
          const p = pad ? { x: pad.x, y: 0.3, z: pad.z } : this.carPos(snap, e.carId);
          if (!p) return;
          sp = this.listener.locate(p, this.sp, 6, ROLLOFF);
        }
        const g = (e.big ? SFX_MIX.pickupBig : SFX_MIX.pickupSmall) * (mine ? 1 : others * 0.9);
        this.oneShot('pickup', mine ? 4 : 1, graph.gameplay, g, sp, mine ? 0.12 : (sp?.send ?? 0.2) * 0.6, (t, o) => G.boostPickup(s, t, o, P, !!e.big));
        return;
      }
      case 'demolish': {
        const sp = this.listener.locate(e.pos, this.sp, 9, 0.8);
        this.oneShot('big', 8, graph.gameplay, SFX_MIX.demolish, sp, 0.35 + sp.send * 0.5, (t, o) => G.demolish(s, t, o, P));
        if (!replay) {
          if (e.attackerId === this.playerId) crowd.react('cheer', 0.75);
          else if (e.victimId === this.playerId) crowd.react('ooh', 0.6);
          else crowd.react('cheer', 0.4);
        }
        return;
      }
      case 'respawn': {
        const sp = this.carSpatial(snap, e.carId);
        if (sp === undefined) return;
        const mine = sp === null;
        this.oneShot('ability', mine ? 4 : 1, graph.gameplay, SFX_MIX.respawn * (mine ? 1 : 0.7), sp, mine ? 0.2 : sp.send, (t, o) => G.respawn(s, t, o, P));
        return;
      }
      case 'pulse': {
        const mine = e.carId === this.playerId;
        const sp = mine ? null : this.listener.locate(e.pos, this.sp, 8, 0.9);
        const hitCars = !!e.hitCarIds && e.hitCarIds.length > 0;
        this.oneShot('ability', mine ? 7 : 5, graph.gameplay, SFX_MIX.pulse * (mine ? 1 : 0.85), sp, mine ? 0.3 : (sp?.send ?? 0.3), (t, o) => G.pulse(s, t, o, P, !!e.hitBall, hitCars));
        return;
      }
      case 'chargeChange': {
        const friendly = this.playerId >= 0 ? e.team === this.playerTeam : e.team === 0;
        const prevTeam = this.chargeTeam;
        this.chargeTeam = e.team;
        if (e.team === -1 || e.level <= 0) {
          // Decayed to neutral during play → power-down. (The kickoff reset also neutralizes the charge: silent.)
          if (e.prevLevel > 0 && snap.phase === 'playing') this.oneShot('charge', 3, graph.gameplay, SFX_MIX.chargeLost, null, 0.15, (t, o) => G.chargeLost(s, t, o));
          return;
        }
        if (prevTeam !== -1 && e.team !== prevTeam && e.prevLevel > 0) {
          this.oneShot('charge', 4, graph.gameplay, SFX_MIX.chargeSteal, null, 0.2, (t, o) => G.chargeSteal(s, t, o, friendly));
          return;
        }
        if (e.level > e.prevLevel) {
          if (e.level >= 3) {
            this.oneShot('charge', 8, graph.events, SFX_MIX.supernova, null, 0.35, (t, o) => G.supernova(s, t, o, friendly));
            if (!replay) {
              crowd.react('cheer', friendly ? 0.6 : 0.35);
              crowd.excite(0.3);
            }
          } else {
            this.oneShot('charge', 5, graph.gameplay, SFX_MIX.chargeUp, null, 0.25, (t, o) => G.chargeUp(s, t, o, e.level, friendly));
          }
        } else if (e.level < e.prevLevel) {
          this.oneShot('charge', 2, graph.gameplay, SFX_MIX.chargeDown, null, 0.15, (t, o) => G.chargeDown(s, t, o));
        }
        return;
      }
      case 'goal': {
        const friendly = this.playerId >= 0 ? e.team === this.playerTeam : true;
        const size = clamp01((e.points - 1) / 2 + e.ballSpeed / 120);
        const supernova = e.charge >= 3;
        const g = replay ? 0.7 : 1;
        this.oneShot('big', 10, graph.events, SFX_MIX.goalBoom * g, null, 0.9, (t, o) => E.goalBoom(s, t, o, size, supernova));
        if (replay) return;
        const chord = e.team === 0 ? E.HORN_CHORDS.volt : E.HORN_CHORDS.blaze;
        this.oneShot('event', 9, graph.events, SFX_MIX.horn, null, 0.6, (t, o) => E.horn(s, t, o, chord, [[0, 0.42], [0.58, 1.25]]), 0.3);
        if (friendly) {
          this.oneShot('event', 7, graph.events, SFX_MIX.euphoria, null, 0.5, (t, o) => E.euphoria(s, t, o), 0.08);
          crowd.react('roar', 1);
        } else {
          this.oneShot('event', 7, graph.events, SFX_MIX.concede, null, 0.4, (t, o) => E.concede(s, t, o), 0.3);
          crowd.react('roar', 0.45);
          crowd.react('aww', 0.8, now + 0.4);
        }
        graph.duckMusic(0.72, 0.06, 2.6, 2.2);
        return;
      }
      case 'save': {
        if (e.epic) {
          crowd.react('cheer', 0.9 * crowdScale);
          crowd.react('ooh', 0.6 * crowdScale);
        } else crowd.react('ooh', (e.carId === this.playerId ? 0.8 : 0.6) * crowdScale);
        return;
      }
      case 'shot': {
        crowd.excite(0.22 * crowdScale);
        return;
      }
      case 'countdown': {
        if (replay) return;
        this.oneShot('event', 6, graph.events, SFX_MIX.countdown, null, 0.2, (t, o) => E.countdownBeep(s, t, o, false));
        return;
      }
      case 'kickoff': {
        this.chargeTeam = -1;
        if (replay) return;
        this.oneShot('event', 7, graph.events, SFX_MIX.go, null, 0.3, (t, o) => E.countdownBeep(s, t, o, true));
        crowd.excite(0.2);
        return;
      }
      case 'surgeWarning': {
        if (replay || now < this.surgeAlarmUntil) return;
        const secs = clamp(Number.isFinite(e.seconds) ? e.seconds : 3, 1, 5);
        this.surgeAlarmUntil = now + secs - 0.25;
        this.oneShot('event', 6, graph.events, SFX_MIX.surgeAlarm, null, 0.3, (t, o) => E.surgeAlarm(s, t, o, secs));
        return;
      }
      case 'surgeStart': {
        if (replay) return;
        this.oneShot('event', 7, graph.events, SFX_MIX.surgeStart, null, 0.5, (t, o) => E.surgeStart(s, t, o));
        crowd.react('ooh', 0.5);
        crowd.excite(0.2);
        return;
      }
      case 'surgeEnd': {
        if (replay) return;
        this.oneShot('event', 5, graph.events, SFX_MIX.surgeEnd, null, 0.4, (t, o) => E.surgeEnd(s, t, o));
        return;
      }
      case 'overtime': {
        if (replay) return;
        this.oneShot('event', 8, graph.events, SFX_MIX.horn, null, 0.6, (t, o) => E.horn(s, t, o, E.HORN_CHORDS.neutral, [[0, 1.4]]));
        crowd.react('roar', 0.6);
        graph.duckMusic(0.5, 0.1, 1.2, 1.5);
        return;
      }
      case 'clockTick': {
        if (replay) return;
        const urgent = e.secondsLeft <= 3;
        this.oneShot('event', 4, graph.events, SFX_MIX.tick, null, 0.15, (t, o) => E.clockTick(s, t, o, urgent));
        return;
      }
      case 'matchEnd': {
        if (replay) return;
        this.oneShot('event', 9, graph.events, SFX_MIX.horn * 1.1, null, 0.7, (t, o) => E.horn(s, t, o, E.HORN_CHORDS.neutral, [[0, 2.2]], 0.55));
        const won = e.winner !== -1 && (this.playerId >= 0 ? e.winner === this.playerTeam : true);
        if (e.winner === -1) crowd.react('applause', 0.8);
        else if (won) {
          crowd.react('roar', 1);
          crowd.react('applause', 1, now + 1.2);
        } else {
          crowd.react('aww', 0.8);
          crowd.react('applause', 0.6, now + 1.0);
        }
        return;
      }
      default:
        return;
    }
  }

  private moveOk(id: number, now: number, minGap: number): boolean {
    const slot = id >= 0 && id < MAX_CARS ? id : 0;
    if (now - this.moveT[slot] < minGap) return false;
    this.moveT[slot] = now;
    return true;
  }

  private warn(where: string, e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    try {
      console.warn(`[audio] ${where} failed (further audio errors suppressed):`, e);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------------------------

  debugInfo(): Record<string, unknown> {
    return {
      state: this.ctx ? (this.ctx as AudioContext).state ?? 'offline' : 'none',
      sampleRate: this.ctx?.sampleRate ?? 0,
      voices: this.pool?.active ?? 0,
      stolen: this.pool?.stolen ?? 0,
      dropped: this.pool?.dropped ?? 0,
      music: this.music?.info ?? null,
      crowdTextures: this.crowd?.hasTextures ?? false,
      crowdLevel: this.crowd?.level ?? 0,
      reverb: this.graph?.reverbReady ?? null,
      init: {
        unlockMs: round2(this.unlockMs),
        ctorMs: round2(this.ctorMs),
        buildMs: this.buildMs,
        readyMs: round2(this.readyMs),
        idlePending: idle.pending,
        idleSlices: idle.stats.slices,
        idleMaxSliceMs: round2(idle.stats.maxSliceMs),
        idleMaxStepMs: round2(idle.stats.maxStepMs),
        idleMaxStepJob: idle.stats.maxStepJob,
        postUnlockMaxSliceMs: round2(idle.stats.peakSliceMs),
        postUnlockMaxStepMs: round2(idle.stats.peakStepMs),
        postUnlockMaxStepJob: idle.stats.peakStepJob,
        idleTotalMs: round2(idle.stats.totalMs),
        syncMs: round2(idle.stats.syncMs),
      },
      npcSlots: this.npcs.map((n) => n.carId),
      ...this.stats,
    };
  }
}
