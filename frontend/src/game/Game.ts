/**
 * NOVABALL — Game orchestrator.
 *
 * App modes:
 *   boot   renderer / shaders / attract match being prepared behind the loading screen
 *   menu   live 2v2 pro-bot exhibition behind the title screen (cinematic camera director; re-seeded when it goes
 *          75 s without a goal)
 *   match  a real match (or free play): fixed-step sim, player input, bots, goal slow-mo, instant replays,
 *          pause, end screen
 *
 * Main loop (renderer.setAnimationLoop): real dt (clamped 0.1 s) → accumulator × time scale → fixed 1/120 s sim
 * ticks (input → bots → world.step → snapshot → replay recorder) → interpolated snapshot → events → camera →
 * actor views → audio → HUD → render.
 */
import { Group, Vector3 } from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import type { AudioFrame, CameraContext, FrameFx, HudNotification, MatchSummary, PlayerLine, UICallbacks, UiSound } from '../contracts';
import { InputSystem } from '../input/InputSystem';
import { BallView } from '../render/BallView';
import { BoostPadsView } from '../render/BoostPadsView';
import { CarView } from '../render/CarView';
import { gameplayVerticalFov } from '../render/fov';
import { RenderSystem } from '../render/RenderSystem';
import { VFXSystem } from '../render/VFXSystem';
import { loadSettings, saveSettings, type QualityPreset, type Settings } from '../settings';
import { CAR, DT, PAD_LAYOUT, SIM_HZ } from '../sim/constants';
import { firstSurgeStartTicks, type SimMatchState } from '../sim/match';
import { copySnapshot, lerpSnapshot, makeBallSnapshot } from '../sim/snapshot';
import type { BallSnapshot, CarSnapshot, MatchConfig, SimEvent, Team } from '../sim/types';
import { makeControlState, makePlayerStats } from '../sim/types';
import { CAR_STYLES } from '../theme';
import { UIManager } from '../ui/UIManager';
import { acquireCarGeometry, releaseCarGeometry } from '../render/actors/carDesigns';
import { AttractDirector } from './Attract';
import { EventRouter, type RouteMode } from './EventRouter';
import { HudBuilder, type HudInputs } from './HudBuilder';
import { MatchSession } from './MatchSession';
import { ReplayPlayer } from './Replay';

type AppMode = 'boot' | 'menu' | 'match';

/** Max sim ticks per rendered frame (0.1 s of sim time) — beyond that, time is dropped (no spiral of death). */
const MAX_STEPS = 12;
/** Goal slow motion: time scale, hold (real s), ramp back to 1 (real s). */
const SLOWMO_SCALE = 0.25;
const SLOWMO_HOLD = 0.9;
const SLOWMO_RAMP = 0.4;
/**
 * During the goal slow motion the VFX (explosion flashes, glow puffs, sparks) run at no less than this fraction of
 * real time: at 0.25× their 0.3–0.6 s flashes hung on screen ~4× longer and the burst read as a white-out.
 */
const SLOWMO_VFX_MIN = 0.6;
/**
 * Replay starts at this goal-phase time (sim s) and covers [goal − REPLAY_BEFORE, goal + REPLAY_AFTER]. Kept short
 * so an unskipped goal → next kickoff takes ~11 s real (slow-mo ≈ 2.6 s + replay ≈ 5.7 s + countdown 3 s) — but
 * the scoring touch is always in it: when the last touch came earlier (a long shot / rolling ball; ~13 % of goals)
 * the replay starts REPLAY_TOUCH_LEAD before that touch, up to REPLAY_MAX_BEFORE before the goal.
 */
const REPLAY_AT = 1.8;
const REPLAY_BEFORE = 3.5;
const REPLAY_MAX_BEFORE = 6.0;
const REPLAY_TOUCH_LEAD = 0.8;
const REPLAY_AFTER = 0.75;
/** Replays can't be skipped during their first moments (a jump press may land exactly on the replay start). */
const REPLAY_SKIP_GUARD = 0.35;
/**
 * While a replay plays (the live sim is paused), the rest of the goal phase is simulated in the background at this
 * many ticks per frame (neutral controls, no AI, no recording; events held until the replay ends), so the replay's
 * end no longer fast-forwards ~150 ticks in one frame.
 */
const HIDDEN_TICKS_PER_FRAME = 6;
/**
 * Events of the goal-phase ticks simulated behind / after a replay that are still routed: the match flow (kickoff
 * reset countdown, charge reset, match end). Their sights and sounds (landings, bumps, pickups…) happened off screen
 * and would all fire at once when the replay ends — they are dropped.
 */
const FLOW_EVENTS: ReadonlySet<SimEvent['type']> = new Set<SimEvent['type']>(['countdown', 'kickoff', 'chargeChange', 'matchEnd', 'overtime']);
/** Seconds between the final horn and the end screen. */
const END_SCREEN_DELAY = 2.4;
/** Length (sim s) of the establishing orbit around the player's car at the start of a match. */
const INTRO_SHOT_SEC = 1.9;
/** The attract match is fast-forwarded past its first countdown so the menu opens on a live kickoff. */
const ATTRACT_PREROLL_TICKS = Math.round(3.25 * SIM_HZ);
/**
 * The exhibition is re-seeded (hard cut to a fresh kickoff) after this long (real s) without a goal, unless a goal is
 * about to fall — then at the latest after ATTRACT_RESEED_MAX.
 */
const ATTRACT_RESEED_AFTER = 75;
const ATTRACT_RESEED_MAX = 78;

/** Session-level overrides decided at boot (main.ts), never saved. */
export interface GameBootOptions {
  /** Force a quality preset for this session (software GL). */
  forceQuality?: QualityPreset;
}

export interface NovaballDebugApi {
  /** Start a match; `autopilot` lets a bot drive the player's car (soak tests). */
  startMatch(partial?: Partial<MatchConfig> & { autopilot?: boolean }): void;
  state(): Record<string, unknown>;
  setTimeScale(x: number): void;
  placeBall(x: number, y: number, z: number, vx?: number, vy?: number, vz?: number): void;
  /** Jump the regulation clock to `sec` seconds left (default 1). */
  endSoon(sec?: number): void;
  skipReplay(): void;
  pause(b: boolean): void;
  menu(): void;
  setQuality(q: Settings['quality']): void;
}

export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly settings: Settings;

  private render!: RenderSystem;
  private ui!: UIManager;
  private input!: InputSystem;
  private audio!: AudioSystem;
  private ballView!: BallView;
  private padsView!: BoostPadsView;
  private vfx!: VFXSystem;
  private router!: EventRouter;
  /** Parent group of every CarView (per session). */
  private readonly carsGroup = new Group();
  private programKeeper: CarView | null = null;

  private session: MatchSession | null = null;
  private mode: AppMode = 'boot';

  // ---- loop state
  private lastMs = -1;
  /** Monotonic real time (s): arena / crowd / post animations, camera. */
  private realTime = 0;
  /** Visual time (s): advances with the time-scaled dt, frozen while paused (actors / VFX). */
  private fxTime = 0;
  private acc = 0;
  private timeScale = 1;
  private debugTimeScale = 1;
  /** Min VFX speed (× real time) during the goal slow motion (a field so harnesses can A/B it). */
  private vfxSlowMoMin = SLOWMO_VFX_MIN;
  /** Real seconds since the goal slow-mo started (-1 = none). */
  private slowMoT = -1;
  private paused = false;
  private ballCam = true;
  private readonly frameEvents: SimEvent[] = [];
  private readonly replayEvents: SimEvent[] = [];
  /** Live events of the goal phase simulated during a replay (routed when the replay ends). */
  private readonly heldEvents: SimEvent[] = [];
  private readonly replay = new ReplayPlayer();
  private replayStartPending = false;
  private readonly hud = new HudBuilder();
  private hudIn!: HudInputs;
  private readonly attract = new AttractDirector();
  private attractRestartAt = -1;
  /** Real time of the exhibition's last kickoff / goal (the scoreless re-seed timer). */
  private attractActionAt = 0;
  private lastMusicIntensity = -1;
  private prevClock = Infinity;
  private camSnapPending = true;
  private lastErrorAt = -10;
  private disposed = false;
  /** Per-frame CPU profile (ms, exponential moving averages) — exposed through __novaball.state(). */
  private readonly prof = { frame: 0, sim: 0, bots: 0, events: 0, camera: 0, views: 0, arena: 0, audio: 0, hud: 0, render: 0, ticks: 0 };
  private profBots = 0;
  /** Big banners that must wait until the center of the screen is free (after the kickoff countdown). */
  private overtimeBannerPending = false;
  private readonly delayed: Array<{ at: number; n: HudNotification }> = [];

  // ---- reused per-frame objects
  private readonly camCtx: CameraContext;
  private readonly audioFrame: AudioFrame;
  private readonly fx: FrameFx = { speed01: 0, boosting: false, supersonic: false, surge: 0, replay: false, paused: false };
  /** Camera-only stand-in for the ball during the goal phase (keeps ball-cam framing on the explosion). */
  private readonly goalBall: BallSnapshot = makeBallSnapshot();
  private readonly endFocus = { x: 0, y: 0.5, z: 0 };
  private readonly goalFocus = { x: 0, y: 2, z: 0 };
  /** Current replay camera shot (-1 = none yet): shot changes are hard cuts. */
  private replayShot = -1;
  /** Replay skip requested outside the frame (debug API). */
  private skipRequested = false;
  /** The match-intro hero shot is driving the camera. */
  private introActive = false;
  /** Leak detection (debug API): weak references to every session / world ever created. */
  private readonly sessionRefs: Array<WeakRef<MatchSession>> = [];
  private readonly worldRefs: Array<WeakRef<object>> = [];
  private endFocusCarId = -1;
  private readonly tmpV = new Vector3();
  /** 'GRAPHICS DEVICE RESET' overlay while the WebGL context is lost. */
  private gpuOverlay: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, opts: GameBootOptions = {}) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = loadSettings();
    if (opts.forceQuality) this.settings.quality = opts.forceQuality;
    this.ballCam = this.settings.ballCamDefault;
    this.camCtx = {
      mode: 'orbit',
      target: null,
      ball: makeBallSnapshot(),
      snap: null as unknown as CameraContext['snap'],
      ballCam: true,
      time: 0,
    };
    this.audioFrame = {
      listenerPos: new Vector3(),
      listenerQuat: null as unknown as AudioFrame['listenerQuat'],
      snap: null as unknown as AudioFrame['snap'],
      playerCarId: -1,
      phase: 'countdown',
      timeScale: 1,
      paused: false,
      replay: false,
    };
  }

  // ============================================================================================ boot

  async start(): Promise<void> {
    const callbacks: UICallbacks = {
      onStartMatch: (cfg) => this.startMatch(cfg),
      onResume: () => this.setPaused(false),
      onRestart: () => this.restart(),
      onQuitToMenu: () => this.enterMenu(),
      onSettingsChanged: (s) => this.applySettings(s),
      onUiSound: (s: UiSound) => this.audio?.playUi(s),
      onUserGesture: () => void this.audio?.unlock(),
    };
    this.ui = new UIManager(this.uiRoot, this.settings, callbacks);
    this.ui.setLoading(0.02, 'Booting the reactor');
    this.input = new InputSystem(this.canvas);
    this.input.applySettings(this.settings);
    this.input.enabled = false;
    this.audio = new AudioSystem();
    this.audio.applySettings(this.settings);
    this.audio.setMusic('menu');
    this.audio.setMusicIntensity(0);

    await nextFrame();
    // the UI loader is on screen (opaque from its first frame): the static splash of index.html can go
    document.getElementById('nb-splash')?.remove();
    this.render = new RenderSystem(this.canvas, this.settings);
    this.render.onContextLost = () => this.onContextLost();
    this.render.onContextRestored = (ok) => this.onContextRestored(ok);
    // three.js recommends disabling the synchronous shader-log checks in production (they stall on first use)
    this.render.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    // Car body geometry is shared per style and ref-counted: hold one reference to every style for the app's
    // lifetime so switching sessions never re-lofts / re-uploads the bodies (~35 ms per match start otherwise).
    for (const st of CAR_STYLES) acquireCarGeometry(st.id);
    this.audioFrame.listenerPos = this.render.camera.position;
    this.audioFrame.listenerQuat = this.render.camera.quaternion;
    this.hudIn = {
      world: null as unknown as HudInputs['world'],
      snap: null as unknown as HudInputs['snap'],
      playerId: -1,
      camera: this.render.camera,
      ballCam: true,
      replay: false,
      fps: 60,
      showFps: false,
      width: 1,
      height: 1,
      indicator: false,
    };
    const scene = this.render.scene;
    this.ballView = new BallView();
    this.padsView = new BoostPadsView(PAD_LAYOUT);
    this.vfx = new VFXSystem();
    this.vfx.setQuality(this.settings.quality);
    this.carsGroup.name = 'cars';
    scene.add(this.carsGroup, this.padsView.object, this.ballView.object, this.vfx.object);
    // Shader-program keeper: three.js destroys a program when the last material using it is disposed, so swapping
    // sessions (all CarViews disposed, new ones created) would recompile every car shader — a visible hitch at each
    // match start / menu return. This hidden, never-disposed car keeps those programs (incl. the nameplate sprite)
    // alive; renderer.compile() still visits it (it traverses invisible objects) so its programs exist from load.
    this.programKeeper = new CarView({ team: 0, style: 'striker', paint: '#e8eef7', isPlayer: false, name: 'NOVA', nameplate: true });
    this.programKeeper.object.visible = false;
    this.programKeeper.object.name = 'programKeeper';
    scene.add(this.programKeeper.object);
    this.router = new EventRouter(this.render, this.vfx, this.ui, this.input, {
      onGoal: (e, mode) => this.onGoal(e, mode),
      onKickoffReset: (mode) => this.onKickoffReset(mode),
      onKickoff: (mode) => this.onKickoff(mode),
      onOvertime: () => {
        this.audio.setMusic('overtime');
        this.overtimeBannerPending = true;
      },
      onMatchEnd: (e) => this.onMatchEnd(e.winner),
      onRespawn: () => {
        // the player's car teleported to its respawn spot: cut, don't fly the camera across the field
        this.camSnapPending = true;
      },
    });

    this.ui.setLoading(0.06, 'Spawning the exhibition');
    this.startAttract(true);
    const s = this.session!;
    // place every actor, then make the pooled VFX / ball sub-meshes visible so the shader warm-up covers them
    this.updateViews(s, 1 / 60, 1 / 60, true);
    this.ballView.prewarm();
    this.vfx.prewarm();
    this.updateCamera(s, 0);

    await this.render.init((p, label) => this.ui.setLoading(0.08 + p * 0.88, label));
    this.ui.setLoading(1, 'Ready');
    this.installGlobalListeners();
    this.installDebugApi();
    this.mode = 'menu';
    this.ui.showScreen('main');
    this.lastMs = -1;
    this.render.renderer.setAnimationLoop((t) => this.loop(t));
  }

  // ============================================================================================ UI callbacks

  private applySettings(s: Settings): void {
    this.render.applySettings(s);
    this.vfx.setQuality(s.quality);
    this.audio.applySettings(s);
    this.input.applySettings(s);
    saveSettings(s);
  }

  private newSeed(): number {
    const a = new Uint32Array(1);
    try {
      crypto.getRandomValues(a);
    } catch {
      a[0] = (Math.random() * 0xffffffff) >>> 0;
    }
    return a[0] >>> 0;
  }

  /** Pause-menu RESTART / end-screen REMATCH: same setup, fresh seed. */
  private restart(): void {
    const s = this.session;
    if (!s || s.isAttract) {
      this.enterMenu();
      return;
    }
    this.startMatch({ ...s.config, mutators: { ...s.config.mutators }, player: s.config.player ? { ...s.config.player } : null, seed: this.newSeed() }, s.autopilot);
  }

  // ============================================================================================ modes

  private disposeSession(): void {
    this.stopReplay(false);
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.vfx.clear();
    this.render.arena.clearRipples();
    this.router?.dropDeferredVfx();
    this.frameEvents.length = 0;
    this.replayEvents.length = 0;
    this.heldEvents.length = 0;
  }

  private resetLoopState(): void {
    this.acc = 0;
    this.timeScale = 1;
    this.slowMoT = -1;
    this.paused = false;
    this.prevClock = Infinity;
    this.camSnapPending = true;
    this.attractRestartAt = -1;
    this.endFocusCarId = -1;
    this.overtimeBannerPending = false;
    this.delayed.length = 0;
    this.introActive = false;
  }

  private startAttract(preroll: boolean): void {
    this.disposeSession();
    this.resetLoopState();
    // 2v2 PRO: the liveliest exhibition (headless, 32 × 180 s: 1.29 goals/min vs 0.80 for 3v3 PRO and 0.66 for the
    // old 3v3 LEGEND, whose defences stalled it; a goal in the first minute 84 % of the time) — aerials intact
    const cfg: MatchConfig = {
      teamSize: 2,
      durationSec: 300,
      difficulty: 'pro',
      seed: this.newSeed(),
      freePlay: false,
      mutators: { charge: true, pulse: true, surges: true, demolitions: true },
      player: null,
    };
    const s = new MatchSession(cfg, this.carsGroup);
    this.session = s;
    this.trackSession(s);
    this.vfx.setCarStyles(s.world.cars.map((c) => c.style));
    this.attract.reset();
    this.attractActionAt = this.realTime;
    if (preroll) {
      for (let i = 0; i < ATTRACT_PREROLL_TICKS; i++) this.simTick(s, false);
      this.frameEvents.length = 0;
      copySnapshot(s.curr, s.view);
    }
  }

  private trackSession(s: MatchSession): void {
    if (typeof WeakRef === 'undefined') return;
    if (this.sessionRefs.length > 64) this.sessionRefs.splice(0, 32);
    if (this.worldRefs.length > 64) this.worldRefs.splice(0, 32);
    this.sessionRefs.push(new WeakRef(s));
    this.worldRefs.push(new WeakRef(s.world));
  }

  /** Back to the title screen over a fresh exhibition match (its first countdown runs at 3× speed). */
  private enterMenu(): void {
    this.startAttract(false);
    this.mode = 'menu';
    this.input.enabled = false;
    this.ui.setReplay(false);
    this.ui.resetTransient();
    this.ui.showScreen('main');
    this.audio.setMusic('menu');
    this.setMusicIntensity(0);
    document.body.classList.remove('nb-playing');
  }

  private startMatch(cfg: MatchConfig, autopilot = false): void {
    this.disposeSession();
    this.resetLoopState();
    const s = new MatchSession(cfg, this.carsGroup, { autopilot });
    this.session = s;
    this.trackSession(s);
    this.vfx.setCarStyles(s.world.cars.map((c) => c.style));
    this.ballCam = this.settings.ballCamDefault;
    this.mode = 'match';
    this.ui.setReplay(false);
    // nothing from the previous match (banners, feed, countdown, scoreboard) carries into the new intro
    this.ui.resetTransient();
    this.ui.showScreen('hud');
    this.audio.setMusic('match');
    this.audio.playStinger('matchStart');
    this.setMusicIntensity(cfg.freePlay ? 0.25 : 0.35);
    copySnapshot(s.curr, s.view);
    document.body.classList.add('nb-playing');
  }

  private setPaused(p: boolean): void {
    if (this.mode !== 'match' || !this.session) return;
    if (p === this.paused) {
      if (!p && this.ui.screen !== 'hud') this.ui.showScreen('hud');
      return;
    }
    const s = this.session;
    if (p && s.endShown) return;
    this.paused = p;
    if (p) {
      this.ui.showScreen('pause');
      document.body.classList.remove('nb-playing');
    } else {
      this.ui.showScreen('hud');
      document.body.classList.add('nb-playing');
      this.lastMs = -1; // no catch-up burst after the pause
    }
  }

  // ============================================================================================ loop

  private loop(nowMs: number): void {
    if (this.disposed) return;
    const realDt = this.lastMs < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;
    this.realTime += realDt;
    try {
      this.frame(realDt);
    } catch (err) {
      if (this.realTime - this.lastErrorAt > 2) {
        this.lastErrorAt = this.realTime;
        console.error('[game] frame failed', err);
      }
    }
  }

  private frame(realDt: number): void {
    const s = this.session;
    if (!s) return;
    const w = s.world;
    const P = this.prof;
    const t0 = performance.now();
    this.profBots = 0;
    this.frameEvents.length = 0;
    this.replayEvents.length = 0;
    this.input.update();
    this.handleActions(s);
    if (this.session !== s) return; // an action switched sessions (restart / menu)

    const inMatch = this.mode === 'match';
    this.input.enabled = inMatch && this.ui.screen === 'hud' && !this.paused && !this.replay.active && s.playerId >= 0 && w.match.phase !== 'ended';

    let visDt = 0;
    let vfxDt = 0;
    if (this.replayStartPending) {
      this.replayStartPending = false;
      this.beginReplay(s);
    }
    if (!this.paused) {
      if (this.replay.active) {
        visDt = vfxDt = this.stepReplay(s, realDt);
        if (this.replay.active) this.advanceHidden(s, HIDDEN_TICKS_PER_FRAME);
      } else {
        this.updateTimeScale(s, realDt);
        const scaled = realDt * this.timeScale * this.debugTimeScale;
        this.acc += scaled;
        let steps = 0;
        while (this.acc >= DT && steps < MAX_STEPS) {
          this.simTick(s, true);
          this.acc -= DT;
          steps++;
          if (this.session !== s) return;
        }
        if (steps >= MAX_STEPS && this.acc > DT) this.acc = 0;
        P.ticks = ema(P.ticks, steps);
        visDt = scaled;
        // goal slow motion (live and attract): cars / ball crawl, the explosion VFX keep a readable pace
        vfxDt = this.slowMoT >= 0 ? Math.max(scaled, realDt * this.debugTimeScale * this.vfxSlowMoMin) : scaled;
        lerpSnapshot(s.prev, s.curr, this.acc / DT, s.view);
      }
    }
    this.fxTime += visDt;
    const t1 = performance.now();

    // ---- events (replayed ones first: a replay that just ended may be followed by the live kickoff reset)
    const routeMode: RouteMode = s.isAttract ? 'attract' : 'live';
    if (this.replayEvents.length > 0) this.router.route(this.replayEvents, s.view, s, 'replay');
    if (this.frameEvents.length > 0) this.router.route(this.frameEvents, s.view, s, routeMode);
    if (this.session !== s) return;
    this.postStep(s);
    if (this.session !== s) return;
    const t2 = performance.now();

    // ---- camera → views → arena → audio → HUD → render
    this.updateCamera(s, this.paused ? 0 : realDt);
    const t3 = performance.now();
    this.updateViews(s, visDt, vfxDt, false);
    this.router.flushDeferredVfx(s.view);
    const t4 = performance.now();
    this.render.arena.update(realDt, this.realTime, s.view);
    const m = w.match;
    this.render.arena.setScoreboard(m.score, m.freePlay ? 0 : m.overtime ? m.overtimeElapsed : m.clock, m.overtime);
    const t5 = performance.now();
    this.updateAudio(s, realDt);
    const t6 = performance.now();
    if (inMatch) this.updateHud(s);
    this.updateFx(s);
    this.feedPlayerControls(s);
    const t7 = performance.now();
    this.render.render(realDt, this.realTime, this.fx);
    const t8 = performance.now();
    P.sim = ema(P.sim, t1 - t0);
    P.bots = ema(P.bots, this.profBots);
    P.events = ema(P.events, t2 - t1);
    P.camera = ema(P.camera, t3 - t2);
    P.views = ema(P.views, t4 - t3);
    P.arena = ema(P.arena, t5 - t4);
    P.audio = ema(P.audio, t6 - t5);
    P.hud = ema(P.hud, t7 - t6);
    P.render = ema(P.render, t8 - t7);
    P.frame = ema(P.frame, t8 - t0);
  }

  /**
   * One fixed sim tick for the session. Replay-end fast-forward: `bots = false` skips the AI (the inputs keep whatever
   * the caller set: neutral) and `capture = false` skips the snapshots / replay recording (the caller writes the final
   * snapshot once; the next replay never reaches back before the next kickoff).
   */
  private simTick(s: MatchSession, live: boolean, bots = true, capture = true): void {
    const w = s.world;
    if (s.playerId >= 0 && !s.autopilot) {
      const ctl = s.inputs[s.playerId];
      if (live) this.input.sample(ctl);
      else neutral(ctl);
    }
    if (s.bots && bots) {
      const b0 = performance.now();
      s.bots.update(w, s.inputs);
      this.profBots += performance.now() - b0;
    }
    w.step(s.inputs);
    if (capture) s.captureTick();
    const ev = w.drainEvents();
    if (ev.length > 0) {
      s.replay.recordEvents(w.tick, ev);
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        if (e.type === 'kickoff') s.lastKickoffTick = w.tick;
        else if (e.type === 'countdown' && e.value >= 3) s.countdownsSeen++;
        else if (e.type === 'goal') {
          s.goalTick = w.tick;
          s.lastGoal = e;
          s.replayDone = s.isAttract || w.config.freePlay;
        } else if (e.type === 'matchEnd') s.endHash = w.hash() >>> 0;
        this.frameEvents.push(e);
      }
    }
  }

  private updateTimeScale(s: MatchSession, realDt: number): void {
    let ts = 1;
    if (this.slowMoT >= 0) {
      this.slowMoT += realDt;
      const hold = s.isAttract ? 0.6 : SLOWMO_HOLD;
      const t = this.slowMoT;
      if (t < hold) ts = SLOWMO_SCALE;
      else if (t < hold + SLOWMO_RAMP) ts = SLOWMO_SCALE + (1 - SLOWMO_SCALE) * smooth((t - hold) / SLOWMO_RAMP);
      else this.slowMoT = -1;
    }
    // the exhibition skips through its frozen kickoff countdowns
    if (s.isAttract && s.world.match.phase === 'countdown') ts = 3;
    this.timeScale = ts;
  }

  // ============================================================================================ input actions

  private handleActions(s: MatchSession): void {
    const input = this.input;
    if (this.mode !== 'match') {
      // drain stale edges so nothing fires when the match starts
      input.consume('pause');
      input.consume('ballCam');
      input.consume('skipReplay');
      input.consume('resetFreePlay');
      return;
    }
    const screen = this.ui.screen;
    if (screen === 'hud' && !this.paused) {
      if (input.consume('pause')) {
        this.setPaused(true);
        return;
      }
      if (input.consume('ballCam')) this.ballCam = !this.ballCam;
      if (s.config.freePlay && input.consume('resetFreePlay')) {
        s.world.resetFreePlay();
        s.world.writeSnapshot(s.curr);
        copySnapshot(s.curr, s.prev);
        copySnapshot(s.curr, s.view);
        this.vfx.clear();
        this.camSnapPending = true;
        // a reset during a goal's slow motion: back to full speed right away
        this.slowMoT = -1;
        this.timeScale = 1;
        this.goalBall.visible = false;
      }
      const skip = input.consume('skipReplay');
      if (this.replay.active && ((skip && this.replay.elapsed >= REPLAY_SKIP_GUARD) || this.skipRequested)) this.endReplay(s);
      this.skipRequested = false;
      this.ui.setScoreboardVisible(input.isHeld('scoreboard') && !this.replay.active);
    } else {
      input.consume('ballCam');
      input.consume('skipReplay');
      input.consume('resetFreePlay');
      if (screen !== 'pause') input.consume('pause');
    }
  }

  // ============================================================================================ match flow hooks

  private onGoal(e: Extract<SimEvent, { type: 'goal' }>, mode: RouteMode): void {
    this.slowMoT = 0;
    this.goalBall.pos.set(e.pos.x, Math.max(1.2, e.pos.y), e.pos.z);
    this.goalBall.visible = true;
    if (mode === 'attract') {
      this.attract.onGoal(e.pos);
      this.attractActionAt = this.realTime;
    }
  }

  private onKickoffReset(mode: RouteMode): void {
    this.vfx.clear();
    this.camSnapPending = true;
    this.slowMoT = -1;
    if (mode === 'attract') this.attract.onKickoffReset();
  }

  private onKickoff(mode: RouteMode): void {
    const s = this.session;
    if (!s) return;
    if (mode === 'attract') this.attractActionAt = this.realTime;
    if (mode === 'live' && s.kickoffsSeen === 0 && !s.config.freePlay) this.audio.playStinger('countdownGo');
    s.kickoffsSeen++;
    if (mode === 'live' && this.overtimeBannerPending) {
      this.overtimeBannerPending = false;
      // right after the "GO!" fades
      this.delayed.push({ at: this.realTime + 1.05, n: { kind: 'overtime', title: 'OVERTIME', subtitle: 'NEXT GOAL WINS', big: true } });
    }
  }

  private onMatchEnd(winner: Team | -1): void {
    const s = this.session;
    if (!s) return;
    s.endedAt = this.realTime;
    if (s.isAttract) {
      this.attractRestartAt = this.realTime + 5;
      return;
    }
    const won = winner !== -1 && winner === 0;
    this.audio.setMusic(winner === -1 ? 'victory' : won ? 'victory' : 'defeat');
    this.setMusicIntensity(0.6);
    // podium camera on the MVP
    this.endFocusCarId = this.mvpId(s);
    this.ui.setScoreboardVisible(false);
    // the final whistle gets its own beat before the end screen (queued: the HUD must see phase 'ended' first so
    // the banner uses the full centre style, not the compact live-play one)
    this.delayed.push({
      at: this.realTime + 0.1,
      n: { kind: 'info', title: 'FULL TIME', subtitle: winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT', team: winner, big: true },
    });
  }

  /** MVP: the best match score on the winning team (any team on a draw). */
  private mvpId(s: MatchSession): number {
    const winner = s.world.match.winner;
    let best = -1;
    let bestScore = -Infinity;
    for (const c of s.world.cars) {
      if (winner !== -1 && c.team !== winner) continue;
      if (c.stats.score > bestScore) {
        bestScore = c.stats.score;
        best = c.id;
      }
    }
    return best;
  }

  private buildSummary(s: MatchSession): MatchSummary {
    const w = s.world;
    const players: PlayerLine[] = w.cars.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      isPlayer: c.id === s.playerId,
      isBot: c.isBot,
      stats: { ...makePlayerStats(), ...c.stats },
    }));
    return {
      winner: w.match.winner,
      score: [w.match.score[0], w.match.score[1]],
      playerTeam: 0,
      players,
      mvpId: this.mvpId(s),
      config: s.config,
      overtime: w.match.overtime,
      hash: s.endHash ?? undefined,
    };
  }

  /** Per-frame game logic after the sim stepped: replay trigger, end screen, clock cues, music intensity. */
  private postStep(s: MatchSession): void {
    const w = s.world;
    const m = w.match;
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      if (this.realTime >= d.at && !this.paused) {
        this.delayed.splice(i, 1);
        if (this.mode === 'match') this.ui.notify(d.n);
      }
    }
    if (s.isAttract) {
      if (this.attractRestartAt > 0 && this.realTime >= this.attractRestartAt) {
        this.startAttract(false);
        this.camSnapPending = true;
        return;
      }
      // scoreless for too long: a fresh kickoff (hard cut) keeps the exhibition lively
      const idle = this.realTime - this.attractActionAt;
      if (m.phase === 'playing' && (idle >= ATTRACT_RESEED_MAX || (idle >= ATTRACT_RESEED_AFTER && !this.attract.goalThreat))) {
        this.startAttract(false);
        this.camSnapPending = true;
      }
      return;
    }
    if (!s.replayDone && !this.replay.active && !this.replayStartPending && m.phase === 'goal' && m.phaseTime >= REPLAY_AT) {
      this.replayStartPending = true;
    }
    if (m.phase === 'ended' && s.endedAt >= 0 && !s.endShown && this.realTime - s.endedAt >= END_SCREEN_DELAY && !this.replay.active) {
      s.endShown = true;
      this.paused = false;
      this.ui.showEndScreen(this.buildSummary(s));
      document.body.classList.remove('nb-playing');
    }
    // last-minute cue: a feed line (the clock turns amber too) — or nothing when the ZERO-G SURGE starting at the same
    // moment already announced it in its banner (EventRouter)
    if (!m.freePlay && !m.overtime && s.config.durationSec > 60 && this.prevClock > 60 && m.clock <= 60 && m.clock > 50 && m.phase === 'playing') {
      if (!this.router.lastMinuteAnnounced(s) && m.surge.state !== 'warning') {
        this.ui.notify({ kind: 'lastMinute', title: 'LAST MINUTE', subtitle: '60 SECONDS LEFT · MAKE IT COUNT' });
      }
    }
    this.prevClock = m.clock;
    // music intensity
    let x = 0.35;
    if (m.freePlay) x = 0.25;
    else if (m.phase === 'ended') x = 0.6;
    else if (m.overtime) x = 0.92;
    else if (m.clock <= 10) x = 1;
    else if (m.clock <= 60) x = 0.66;
    if (m.surge.state === 'active' && x < 0.72) x = 0.72;
    this.setMusicIntensity(x);
  }

  private setMusicIntensity(x: number): void {
    if (Math.abs(x - this.lastMusicIntensity) < 1e-3) return;
    this.lastMusicIntensity = x;
    this.audio.setMusicIntensity(x);
  }

  // ============================================================================================ replay

  private beginReplay(s: MatchSession): void {
    const buf = s.replay;
    const g = s.goalTick;
    const e = s.lastGoal;
    if (g < 0 || !e || Number.isNaN(buf.oldestTick)) {
      s.replayDone = true;
      return;
    }
    // last touch of the ball before the goal (the shot / the deflection): the replay must show it
    let touchTick = -1;
    buf.forEachEvent(g - REPLAY_MAX_BEFORE * SIM_HZ, g, (ev, tick) => {
      if (ev.type === 'ballHit' || (ev.type === 'pulse' && ev.hitBall)) touchTick = tick;
    });
    const from = touchTick >= 0 ? Math.min(g - REPLAY_BEFORE * SIM_HZ, touchTick - REPLAY_TOUCH_LEAD * SIM_HZ) : g - REPLAY_BEFORE * SIM_HZ;
    const start = Math.max(from, g - REPLAY_MAX_BEFORE * SIM_HZ, s.lastKickoffTick + 2, buf.oldestTick);
    const end = Math.min(g + REPLAY_AFTER * SIM_HZ, buf.newestTick);
    if (end - start < SIM_HZ) {
      s.replayDone = true;
      return;
    }
    s.replayDone = true;
    this.replayShot = -1;
    this.heldEvents.length = 0;
    // the live goal phase continues in the background during the replay (advanceHidden): neutral controls
    for (let i = 0; i < s.inputs.length; i++) neutral(s.inputs[i]);
    this.replay.start({ startTick: start, endTick: end, goalTick: g, team: e.team, scorerId: e.ownGoal ? -1 : e.scorerId });
    buf.sample(start, s.view);
    this.vfx.clear();
    this.render.arena.clearRipples();
    // the replay starts clean: no banner (goal banner included) plays over it
    this.ui.clearBanners();
    this.ui.setReplay(true);
    this.ui.setScoreboardVisible(false);
    this.audio.playStinger('replayStart');
    this.camSnapPending = true;
    this.slowMoT = -1;
    this.timeScale = 1;
  }

  /**
   * During a replay: quietly simulate up to `n` more ticks of the live goal phase (the camera shows the replay). Stops
   * at the kickoff reset / match end; the events are held for endReplay.
   */
  private advanceHidden(s: MatchSession, n: number): void {
    const w = s.world;
    for (let i = 0; i < n && w.match.phase === 'goal'; i++) this.simTick(s, false, false, false);
    for (let i = 0; i < this.frameEvents.length; i++) if (FLOW_EVENTS.has(this.frameEvents[i].type)) this.heldEvents.push(this.frameEvents[i]);
    this.frameEvents.length = 0;
  }

  /** Advance the replay cursor; returns the visual dt (real dt × playback rate). */
  private stepReplay(s: MatchSession, realDt: number): number {
    const r = this.replay;
    const rate = r.rateAt(r.pos);
    const prev = r.advance(realDt);
    s.replay.sample(r.pos, s.view);
    s.replay.forEachEvent(prev, r.pos, this.pushReplayEvent);
    if (r.finished) this.endReplay(s);
    return realDt * rate;
  }

  private readonly pushReplayEvent = (e: SimEvent): void => {
    this.replayEvents.push(e);
  };

  /** Replay over (finished or skipped): straight to the next kickoff (the rest of the goal phase is skipped). */
  private endReplay(s: MatchSession): void {
    if (!this.replay.active) return;
    this.stopReplay(true);
    // finish the goal phase instantly: the next frame starts on the kickoff countdown (or the match end). Most of it
    // already ran in the background during the replay (advanceHidden); a skipped replay leaves more. The cars are
    // reset at the kickoff anyway, so they coast on neutral controls and the AI is skipped (it re-syncs on the
    // countdown: perception and kickoff plans reset there).
    for (let i = 0; i < s.inputs.length; i++) neutral(s.inputs[i]);
    let guard = 0;
    while (s.world.match.phase === 'goal' && guard++ < 4 * SIM_HZ) this.simTick(s, false, false, false);
    // only the match-flow events are routed: the background ticks' first (chronological), then the ones just produced
    let k = 0;
    for (let i = 0; i < this.frameEvents.length; i++) if (FLOW_EVENTS.has(this.frameEvents[i].type)) this.frameEvents[k++] = this.frameEvents[i];
    this.frameEvents.length = k;
    if (this.heldEvents.length > 0) {
      this.frameEvents.unshift(...this.heldEvents);
      this.heldEvents.length = 0;
    }
    this.acc = 0;
    s.world.writeSnapshot(s.curr);
    copySnapshot(s.curr, s.prev);
    copySnapshot(s.curr, s.view);
    this.camSnapPending = true;
  }

  private stopReplay(withSound: boolean): void {
    if (!this.replay.active) return;
    this.replay.stop();
    this.replayEvents.length = 0;
    this.vfx.clear();
    this.ui.setReplay(false);
    if (withSound) this.audio.playStinger('replayEnd');
  }

  // ============================================================================================ camera

  private updateCamera(s: MatchSession, dt: number): void {
    const ctx = this.camCtx;
    const view = s.view;
    ctx.snap = view;
    ctx.ball = view.ball;
    ctx.time = this.realTime;
    ctx.focus = undefined;
    ctx.team = undefined;
    ctx.ballCam = this.ballCam;
    let cut = this.camSnapPending;
    this.camSnapPending = false;
    const phase = s.world.match.phase;

    if (s.isAttract) {
      cut = this.attract.update(dt, ctx, view, s.world.match.surge.gravityScale, this.ballOnScreen(view.ball.pos)) || cut;
    } else if (this.replay.active) {
      const r = this.replay;
      const plan = r.plan;
      const scorer = plan.scorerId >= 0 ? view.cars[plan.scorerId] : null;
      const chase = !!scorer && !scorer.demolished && plan.goalTick - plan.startTick > 2.8 * SIM_HZ && r.pos < plan.goalTick - 1.5 * SIM_HZ;
      // TV-style shot list with hard cuts: chase-cam on the scorer → low goal-mouth follow → hero shot of the explosion
      let shot: 0 | 1 | 2;
      if (r.pos >= plan.goalTick - 0.12 * SIM_HZ && s.lastGoal) {
        shot = 2;
        const g = s.lastGoal.pos;
        this.goalFocus.x = g.x;
        this.goalFocus.y = Math.max(1.5, g.y);
        this.goalFocus.z = g.z;
        ctx.mode = 'goal';
        ctx.target = null;
        ctx.focus = this.goalFocus;
      } else if (chase) {
        shot = 0;
        ctx.mode = 'car';
        ctx.target = scorer;
        ctx.ballCam = true;
      } else {
        shot = 1;
        ctx.mode = 'replay';
        ctx.target = scorer && !scorer.demolished ? scorer : null;
        ctx.team = plan.team;
      }
      if (shot !== this.replayShot) {
        if (this.replayShot >= 0) cut = true;
        this.replayShot = shot;
      }
    } else if (phase === 'ended' && s.endedAt >= 0) {
      ctx.mode = 'endPodium';
      ctx.target = null;
      const c = this.endFocusCarId >= 0 ? view.cars[this.endFocusCarId] : null;
      if (c && !c.demolished) {
        this.endFocus.x = c.pos.x;
        this.endFocus.y = Math.max(0.3, c.pos.y - 0.2);
        this.endFocus.z = c.pos.z;
      }
      ctx.focus = this.endFocus;
    } else if (phase === 'countdown' && s.countdownsSeen <= 1 && s.playerId >= 0 && !s.config.freePlay && s.world.match.phaseTime < INTRO_SHOT_SEC) {
      // Match intro: a hero shot of the player's car during "3"–"2": front three-quarter, swinging round the side to
      // behind the car. The rig is parked in a non-'car' mode meanwhile, so switching to the chase cam afterwards
      // blends (0.6 s) from this pose — one continuous swoop around the car into the chase position.
      const c = view.cars[s.playerId];
      if (!this.introActive) {
        this.introActive = true;
        this.endFocus.x = c.pos.x;
        this.endFocus.y = c.pos.y;
        this.endFocus.z = c.pos.z;
        ctx.mode = 'endPodium';
        ctx.target = null;
        ctx.focus = this.endFocus;
        this.render.cameraRig.snap(ctx);
      }
      this.introPose(c, s.world.match.phaseTime / INTRO_SHOT_SEC);
      return;
    } else {
      ctx.mode = 'car';
      ctx.target = s.playerId >= 0 ? view.cars[s.playerId] : null;
      if (phase === 'goal' && !view.ball.visible && this.goalBall.visible) {
        // keep the ball-cam framing on the explosion instead of whipping around to the car heading
        ctx.ball = this.goalBall;
      }
    }
    if (phase !== 'goal') this.goalBall.visible = false;
    const rig = this.render.cameraRig;
    if (this.introActive) {
      // leaving the intro: blend from the hero pose (never snap away from it)
      this.introActive = false;
      cut = false;
    }
    if (cut) rig.snap(ctx);
    else rig.update(dt, ctx);
  }

  /** The point was inside the last rendered frame (camera matrices of the previous render). */
  private ballOnScreen(p: Vector3): boolean {
    const cam = this.render.camera;
    const v = this.tmpV.copy(p).applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -0.1) return false;
    v.applyMatrix4(cam.projectionMatrix);
    return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
  }

  /** Intro hero shot around car `c`, progress k 0..1 (camera placed directly; the rig resumes afterwards). */
  private introPose(c: CarSnapshot, k: number): void {
    const cam = this.render.camera;
    const e = smooth(k);
    const fwd = this.tmpV.set(0, 0, 1).applyQuaternion(c.quat);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    // swing toward the side with more room (the field center)
    const lx = fwd.z;
    const lz = -fwd.x;
    const side = c.pos.x * lx + c.pos.z * lz > 0 ? -1 : 1;
    // front three-quarter → side → behind the car, ending close to the chase-cam pose (tiny hand-over blend)
    const th = ((30 + 146 * e) * Math.PI) / 180;
    const r = 5.4 - 1.9 * e;
    const h = 0.7 + 0.55 * e;
    const ct = Math.cos(th) * r;
    const st = Math.sin(th) * r * side;
    cam.position.set(c.pos.x + fwd.x * ct + lx * st, c.pos.y + h, c.pos.z + fwd.z * ct + lz * st);
    cam.up.set(0, 1, 0);
    // aim above the car: it sits in the lower third, clear of the centred "3-2-1" (and near the chase framing the
    // shot hands over to)
    cam.lookAt(c.pos.x, c.pos.y + 0.9, c.pos.z);
    // Hor+ like the gameplay camera (ultrawide screens see more, they don't zoom in)
    const vfov = gameplayVerticalFov(56 + (this.settings.fov - 60) * e, Math.max(0.1, cam.aspect));
    if (Math.abs(cam.fov - vfov) > 1e-4) {
      cam.fov = vfov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  // ============================================================================================ views / audio / hud / fx

  /** `dt`: actor views (time-scaled); `vfxDt`: VFX particles (≥ dt; faster than dt during the goal slow motion). */
  private updateViews(s: MatchSession, dt: number, vfxDt: number, force: boolean): void {
    const cam = this.render.camera;
    const view = s.view;
    const t = this.fxTime;
    for (let i = 0; i < s.cars.length; i++) s.cars[i].update(view.cars[i], dt, t, cam);
    this.ballView.update(view.ball, dt, t, cam);
    this.padsView.update(view.padsActive, dt, t);
    if (!force || vfxDt > 0) this.vfx.update(vfxDt, t, view, cam);
  }

  private updateAudio(s: MatchSession, realDt: number): void {
    const f = this.audioFrame;
    f.snap = s.view;
    f.playerCarId = s.playerId;
    f.phase = s.world.match.phase;
    f.paused = this.paused;
    f.replay = this.replay.active;
    f.timeScale = this.replay.active ? this.replay.rateAt(this.replay.pos) : this.timeScale;
    this.audio.update(realDt, f);
    if (this.frameEvents.length > 0) {
      f.replay = false;
      this.audio.handleEvents(this.frameEvents, f);
    }
    if (this.replayEvents.length > 0) {
      f.replay = true;
      this.audio.handleEvents(this.replayEvents, f);
    }
    f.replay = this.replay.active;
  }

  private updateHud(s: MatchSession): void {
    const phase = s.world.match.phase;
    const hi = this.hudIn;
    hi.world = s.world;
    hi.snap = s.view;
    hi.playerId = s.playerId;
    hi.camera = this.render.camera;
    hi.ballCam = this.ballCam;
    hi.replay = this.replay.active;
    hi.fps = this.render.getStats().fps;
    hi.showFps = this.settings.showFps;
    hi.width = window.innerWidth;
    hi.height = window.innerHeight;
    hi.indicator = !this.replay.active && !this.paused && this.camCtx.mode === 'car' && (phase === 'playing' || phase === 'countdown');
    this.ui.updateHUD(this.hud.build(hi));
  }

  /**
   * The local player's sampled controls → the UI (FIRST FLIGHT coach ticks, NOVA PULSE "on cooldown" feedback)
   * during live play; null otherwise (menus, pause, replays, autopilot soak tests).
   */
  private feedPlayerControls(s: MatchSession): void {
    const live = this.mode === 'match' && this.ui.screen === 'hud' && !this.paused && !this.replay.active && !s.autopilot && s.playerId >= 0;
    this.ui.updatePlayerControls(live ? s.inputs[s.playerId] : null);
  }

  private updateFx(s: MatchSession): void {
    const fx = this.fx;
    fx.paused = this.paused;
    fx.replay = this.replay.active;
    fx.surge = s.view.surge;
    let car: CarSnapshot | null = null;
    const ctx = this.camCtx;
    if (this.mode === 'match' && ctx.mode === 'car' && ctx.target) car = ctx.target;
    if (car && !car.demolished) {
      fx.speed01 = Math.min(1, car.vel.length() / CAR.maxSpeed);
      fx.boosting = car.boosting;
      fx.supersonic = car.supersonic;
    } else {
      fx.speed01 = 0;
      fx.boosting = false;
      fx.supersonic = false;
    }
  }

  // ============================================================================================ global listeners

  private installGlobalListeners(): void {
    const autoPause = () => {
      if (this.mode === 'match' && this.ui.screen === 'hud' && !this.paused && this.session && !this.session.endShown) this.setPaused(true);
    };
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') autoPause();
      this.lastMs = -1;
    });
    // leaving fullscreen mid-match (browser Esc / F11, where the Esc key never reaches the page) pauses too
    const fsChange = () => {
      const d = document as Document & { webkitFullscreenElement?: Element | null };
      if (!(d.fullscreenElement ?? d.webkitFullscreenElement)) autoPause();
    };
    document.addEventListener('fullscreenchange', fsChange);
    document.addEventListener('webkitfullscreenchange', fsChange);
  }

  // ============================================================================================ WebGL context loss

  private onContextLost(): void {
    this.setGpuOverlay(true);
    if (this.mode === 'match' && this.ui.screen === 'hud' && !this.paused && this.session && !this.session.endShown) this.setPaused(true);
  }

  private onContextRestored(ok: boolean): void {
    if (!ok) {
      // could not rebuild the GPU resources: a reload is the clean way back (settings are saved)
      location.reload();
      return;
    }
    this.setGpuOverlay(false);
  }

  private setGpuOverlay(on: boolean): void {
    if (!on) {
      this.gpuOverlay?.remove();
      this.gpuOverlay = null;
      return;
    }
    if (this.gpuOverlay) return;
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    // bottom centre: clear of the pause menu, its scoreboard and the title screen's panels
    el.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:13%',
      'transform:translateX(-50%)',
      'z-index:90',
      'max-width:calc(100vw - 32px)',
      'box-sizing:border-box',
      'padding:12px 24px',
      'border-radius:10px',
      'border:1px solid rgba(139,233,255,0.55)',
      'background:rgba(5,7,13,0.9)',
      'color:#e6f3ff',
      'font:700 14px/1.4 Orbitron,system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'letter-spacing:0.16em',
      'text-align:center',
      'box-shadow:0 0 28px rgba(30,200,255,0.35)',
      'pointer-events:none',
    ].join(';');
    el.textContent = 'GRAPHICS DEVICE RESET — RESTORING…';
    document.body.append(el);
    this.gpuOverlay = el;
  }

  // ============================================================================================ debug / test API

  /**
   * window.__novaball. The full API (match control, ball placement, clock jumps, time scale) exists in dev builds and
   * with `?debug=1`; a normal production page only exposes the read-only state() — nobody can forge a result from
   * the console (the smoke tests / playtest scripts add ?debug=1 against production builds).
   */
  private installDebugApi(): void {
    const api: NovaballDebugApi = {
      startMatch: (partial) => {
        const st = this.settings;
        const { autopilot, ...rest } = partial ?? {};
        const cfg: MatchConfig = {
          teamSize: st.lastTeamSize,
          durationSec: st.lastDuration,
          difficulty: st.lastDifficulty,
          seed: this.newSeed(),
          freePlay: false,
          mutators: { ...st.lastMutators },
          player: { name: st.playerName || 'PLAYER', style: st.carStyle, paint: st.paint },
          ...rest,
        };
        if (cfg.freePlay) cfg.teamSize = 1;
        this.startMatch(cfg, !!autopilot);
      },
      state: () => {
        const s = this.session;
        const st = this.render.getStats();
        const dbg = this.render.getDebugStats();
        const w = s?.world;
        const p = s && s.playerId >= 0 ? w!.cars[s.playerId] : null;
        const r3 = (v: { x: number; y: number; z: number }) => [round2(v.x), round2(v.y), round2(v.z)];
        return {
          mode: this.mode,
          screen: this.ui.screen,
          phase: w?.match.phase,
          clock: w ? round2(w.match.clock) : null,
          overtime: w?.match.overtime,
          score: w ? [...w.match.score] : null,
          tick: w?.tick,
          paused: this.paused,
          replay: this.replay.active,
          replayPos: this.replay.active ? round2((this.replay.pos - this.replay.plan.goalTick) / SIM_HZ) : null,
          camMode: this.camCtx.mode,
          camPos: r3(this.render.camera.position),
          timeScale: this.timeScale,
          fps: st.fps,
          frameMs: st.frameMs,
          drawCalls: st.drawCalls,
          triangles: st.triangles,
          pixelRatio: st.pixelRatio,
          quality: st.quality,
          gpuMs: dbg.gpuMs,
          cpuMs: dbg.cpuMs,
          programs: this.render.renderer.info.programs?.length ?? -1,
          gpuMem: { ...this.render.renderer.info.memory },
          heapMB: round2(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576),
          liveSessions: this.sessionRefs.filter((r) => r.deref() !== undefined).length,
          liveWorlds: this.worldRefs.filter((r) => r.deref() !== undefined).length,
          player: p ? { pos: r3(p.pos), speed: round2(p.vel.length()), boost: Math.round(p.boost), demolished: p.demolished, supersonic: p.supersonic } : null,
          ball: w ? { pos: r3(w.ball.pos), vel: r3(w.ball.vel), charge: w.ball.charge, exploded: w.ball.exploded } : null,
          cars: w ? w.cars.length : 0,
          bots: s?.bots ? s.bots.debugInfo() : null,
          vfx: this.vfx.stats(),
          cpu: Object.fromEntries(Object.entries(this.prof).map(([k, v]) => [k, round2(v)])),
          audio: this.audio.debugInfo(),
        };
      },
      setTimeScale: (x) => {
        this.debugTimeScale = Math.max(0, Math.min(8, Number(x) || 0));
      },
      placeBall: (x, y, z, vx = 0, vy = 0, vz = 0) => {
        const s = this.session;
        if (!s) return;
        const b = s.world.ball;
        b.pos.set(x, y, z);
        b.vel.set(vx, vy, vz);
        b.angVel.set(0, 0, 0);
      },
      endSoon: (sec = 1) => {
        const s = this.session;
        if (!s) return;
        const m = s.world.match as SimMatchState;
        if (m.overtime || m.freePlay) return;
        m.clockTicks = Math.min(m.clockTicks, Math.max(1, Math.round(sec * SIM_HZ)));
        m.clock = m.clockTicks / SIM_HZ;
        // re-plan the ZERO-G SURGE schedule for the new clock (the surges the jump skipped must not all fire now)
        m.nextSurgeClockTicks = s.config.mutators.surges ? firstSurgeStartTicks(m.clockTicks) : -1;
      },
      skipReplay: () => {
        // handled inside the next frame (events emitted by the fast-forward must be routed, not dropped)
        if (this.replay.active) this.skipRequested = true;
      },
      pause: (b) => this.setPaused(!!b),
      menu: () => this.enterMenu(),
      setQuality: (q) => {
        this.settings.quality = q;
        this.applySettings(this.settings);
      },
    };
    let debug = import.meta.env.DEV;
    try {
      debug ||= new URLSearchParams(location.search).has('debug');
    } catch {
      /* no location (never in a browser) */
    }
    const w = window as unknown as { __novaball: NovaballDebugApi | Readonly<Pick<NovaballDebugApi, 'state'>> };
    w.__novaball = debug ? api : Object.freeze({ state: api.state });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.render.renderer.setAnimationLoop(null);
    this.disposeSession();
    for (const st of CAR_STYLES) releaseCarGeometry(st.id);
    this.programKeeper?.dispose();
    this.ballView.dispose();
    this.padsView.dispose();
    this.vfx.dispose();
    this.audio.dispose();
    this.input.dispose();
    this.ui.dispose();
    this.render.dispose();
  }
}

// ============================================================================================ helpers

function neutral(c: ReturnType<typeof makeControlState>): void {
  c.throttle = 0;
  c.steer = 0;
  c.pitch = 0;
  c.yaw = 0;
  c.roll = 0;
  c.jump = false;
  c.boost = false;
  c.powerslide = false;
  c.pulse = false;
}

function ema(prev: number, x: number): number {
  return prev + (x - prev) * 0.05;
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Resolve after the next frame has been PAINTED: the rAF callback runs before the paint, so resolving inside it
 * would run the caller's heavy work before anything reaches the screen.
 */
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}
