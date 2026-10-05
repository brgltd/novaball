/**
 * NOVABALL — module contracts (CONTRACT).
 *
 * Every module's concrete class `implements` its interface below, lives at the stated path, and has the
 * stated constructor signature. The integration layer (src/game/*) only relies on what is declared here,
 * in src/sim/types.ts, src/sim/constants.ts, src/sim/arena.ts, src/settings.ts and src/theme.ts.
 * Do not change these interfaces without coordinating — add optional members instead.
 */
import type { Camera, Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer } from 'three';
import type { QualityPreset, Settings } from './settings';
import type {
  BallSnapshot,
  BallState,
  CarSnapshot,
  CarState,
  CarStyleId,
  ControlState,
  Difficulty,
  MatchConfig,
  MatchPhase,
  MatchState,
  PadState,
  PlayerStats,
  SimEvent,
  Team,
  Vec3Like,
  WorldSnapshot,
} from './sim/types';

/** Objects on this layer are rendered by the main camera but NOT into the planar floor reflection. */
export const LAYER_MAIN_ONLY = 1;

// =============================================================================================
// SIM — src/sim/world.ts:     export class World implements IWorld { constructor(config: MatchConfig) }
//        src/sim/snapshot.ts: export function lerpSnapshot(a, b, t, out): WorldSnapshot
//                             export function copySnapshot(src, dst): WorldSnapshot
//                             export function cloneSnapshot(src): WorldSnapshot
//        src/sim/predict.ts:  export class BallPredictor implements IBallPredictor { constructor(horizonSec?: number, dt?: number) }
// =============================================================================================

export interface IWorld {
  readonly config: MatchConfig;
  readonly cars: CarState[];
  readonly ball: BallState;
  readonly pads: PadState[];
  readonly match: MatchState;
  /** Number of steps simulated so far. */
  readonly tick: number;
  /** Simulated seconds (tick × DT). */
  readonly time: number;
  /** Advance exactly one fixed step (DT). inputs[i] are the controls for car id i (missing => neutral). */
  step(inputs: ReadonlyArray<ControlState>): void;
  /** Returns and clears all events emitted since the previous drain. */
  drainEvents(): SimEvent[];
  createSnapshot(): WorldSnapshot;
  writeSnapshot(out: WorldSnapshot): void;
  /** Free play only: reset the ball (in front of the player) and the player's car. */
  resetFreePlay(): void;
  /** Deterministic 32-bit hash of the full simulation state (same inputs => same hash on every JS engine). */
  hash(): number;
}

export interface BallPredictionSlice {
  t: number; // seconds from now
  pos: Vector3;
  vel: Vector3;
}

export interface IBallPredictor {
  /** Re-simulate the ball's future path (arena collisions only, no cars) from its current state. */
  update(ball: BallState, gravityScale: number): void;
  readonly slices: ReadonlyArray<BallPredictionSlice>;
  readonly count: number;
  readonly dt: number;
}

// =============================================================================================
// AI — src/ai/BotManager.ts: export class BotManager implements IBotManager
//        { constructor(world: IWorld, botIds: number[], difficulty: Difficulty, seed: number) }
// =============================================================================================

export interface IBotManager {
  /** Write controls for every bot into inputs[carId]. Call once per sim tick, BEFORE world.step(). */
  update(world: IWorld, inputs: ControlState[]): void;
  /** Optional one-line debug summary (roles/targets) for dev overlays. */
  debugInfo?(): string;
}
export type BotManagerCtor = new (world: IWorld, botIds: number[], difficulty: Difficulty, seed: number) => IBotManager;

// =============================================================================================
// RENDER (world) — src/render/RenderSystem.ts: export class RenderSystem implements IRenderSystem
//        { constructor(canvas: HTMLCanvasElement, settings: Settings) }
//   Owns: WebGLRenderer, Scene, PerspectiveCamera, environment (sky/nebula/planet/lights/env map),
//         ArenaView (src/render/ArenaView.ts), CameraRig (src/render/CameraRig.ts), PostFX (src/render/PostFX.ts).
// =============================================================================================

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  quality: QualityPreset;
}

export interface FrameFx {
  /** 0..1 player speed / CAR.maxSpeed (chromatic aberration, speed lines). */
  speed01: number;
  boosting: boolean;
  supersonic: boolean;
  /** 0..1 ZERO-G SURGE intensity (color grade shift). */
  surge: number;
  /** Replay playback active (letterbox / grade / grain). */
  replay: boolean;
  /** Game paused (dim / desaturate). */
  paused: boolean;
}

export interface IRenderSystem {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly arena: IArenaView;
  readonly cameraRig: ICameraRig;
  /** Build sky / environment map / arena / stadium and pre-compile shaders. Reports progress 0..1. */
  init(onProgress?: (p: number, label: string) => void): Promise<void>;
  setQuality(q: QualityPreset): void;
  applySettings(s: Settings): void;
  resize(): void;
  /** Full-screen additive flash (goal, demolition). strength 0..1. */
  flash(color: string, strength: number): void;
  /** Render one frame (post-processing, dynamic resolution bookkeeping). */
  render(dt: number, time: number, fx: FrameFx): void;
  getStats(): RenderStats;
  dispose(): void;
}

export interface IArenaView {
  readonly object: Object3D;
  /** Per frame: floor light pools under cars/ball, crowd, holo screens, force-field animation, surge mood. */
  update(dt: number, time: number, snap: WorldSnapshot): void;
  /** Force-field ripple / floor spark where something hit the arena. strength 0..1. */
  onImpact(pos: Vec3Like, normal: Vec3Like, strength: number, color?: string): void;
  /** Goal celebration: goal frame + stadium lights flash in the scoring team's color. */
  onGoal(scoringTeam: Team, pos: Vec3Like): void;
  /** Stadium holo-screens. */
  setScoreboard(score: [number, number], clock: number, overtime: boolean): void;
}

export type CameraMode = 'car' | 'replay' | 'orbit' | 'broadcast' | 'goal' | 'endPodium';

export interface CameraContext {
  mode: CameraMode;
  /** 'car': the followed car. 'replay': the focus car (e.g. scorer), may be null. */
  target: CarSnapshot | null;
  ball: BallSnapshot;
  snap: WorldSnapshot;
  /** 'car' mode: look at the ball (true) or along the car's heading (false). */
  ballCam: boolean;
  time: number;
  /** 'goal' / 'endPodium': point of interest. */
  focus?: Vec3Like;
  team?: Team;
}

export interface ICameraRig {
  update(dt: number, ctx: CameraContext): void;
  /** Trauma-style screen shake, amount 0..1 (scaled by settings.screenShake). */
  shake(amount: number): void;
  applySettings(s: Settings): void;
  /** Place the camera immediately for ctx (no smoothing). Use on mode switches, kickoff resets, replay start. */
  snap(ctx: CameraContext): void;
}

// =============================================================================================
// RENDER (actors) —
//   src/render/CarView.ts:       export class CarView implements ICarView { constructor(opts: CarViewOptions) }
//   src/render/BallView.ts:      export class BallView implements IBallView { constructor() }
//   src/render/BoostPadsView.ts: export class BoostPadsView implements IBoostPadsView
//                                  { constructor(pads: ReadonlyArray<{ x: number; z: number; big: boolean }>) }
//   src/render/VFXSystem.ts:     export class VFXSystem implements IVFXSystem { constructor() }
// =============================================================================================

export interface CarViewOptions {
  team: Team;
  style: CarStyleId;
  /** Body paint hex; trims/lights always use the team color. */
  paint: string;
  isPlayer: boolean;
  name: string;
  /** Floating nameplate above the car (hidden for the local player's own car). */
  nameplate: boolean;
}

export interface ICarView {
  readonly object: Object3D;
  update(s: CarSnapshot, dt: number, time: number, camera: Camera): void;
  dispose(): void;
}

export interface IBallView {
  readonly object: Object3D;
  update(s: BallSnapshot, dt: number, time: number, camera: Camera): void;
  dispose(): void;
}

export interface IBoostPadsView {
  readonly object: Object3D;
  update(active: ReadonlyArray<boolean>, dt: number, time: number): void;
  dispose(): void;
}

export interface IVFXSystem {
  readonly object: Object3D;
  /** Continuous, state-driven effects: boost exhaust + trails, supersonic streaks, ball trail, hover dust. */
  update(dt: number, time: number, snap: WorldSnapshot, camera: Camera): void;
  /** One-shot effects for sim events (hits, bounces, goals, demolitions, pulses, pickups, landings...). */
  handleEvent(e: SimEvent, snap: WorldSnapshot): void;
  setQuality(q: QualityPreset): void;
  /** Kill all live particles/trails (kickoff reset, replay start/end). */
  clear(): void;
  dispose(): void;
}

// =============================================================================================
// AUDIO — src/audio/AudioSystem.ts: export class AudioSystem implements IAudioSystem { constructor() }
//   100% procedural Web Audio (no audio files).
// =============================================================================================

export type UiSound = 'hover' | 'click' | 'back' | 'start' | 'toggle' | 'error';
export type MusicState = 'off' | 'menu' | 'match' | 'overtime' | 'victory' | 'defeat';
export type Stinger = 'replayStart' | 'replayEnd' | 'matchStart' | 'victory' | 'defeat' | 'countdownGo';

export interface AudioFrame {
  listenerPos: Vector3;
  listenerQuat: Quaternion;
  snap: WorldSnapshot;
  /** -1 when spectating (attract mode). */
  playerCarId: number;
  phase: MatchPhase;
  /** Current time scale (slow-motion after goals). */
  timeScale: number;
  paused: boolean;
  replay: boolean;
}

export interface IAudioSystem {
  /** Create/resume the AudioContext. MUST be called from a user gesture; safe to call repeatedly. */
  unlock(): Promise<void>;
  applySettings(s: Settings): void;
  /** Continuous sounds: engines, boost, wind, crowd bed, surge hum. */
  update(dt: number, frame: AudioFrame): void;
  handleEvents(events: ReadonlyArray<SimEvent>, frame: AudioFrame): void;
  playUi(s: UiSound): void;
  setMusic(state: MusicState): void;
  /** 0..1 musical intensity (final minute, overtime, surges). */
  setMusicIntensity(x: number): void;
  playStinger(s: Stinger): void;
  dispose(): void;
}

// =============================================================================================
// INPUT — src/input/InputSystem.ts: export class InputSystem implements IInputSystem { constructor(target: HTMLElement) }
// =============================================================================================

export type InputAction = 'ballCam' | 'pause' | 'skipReplay' | 'resetFreePlay' | 'scoreboard';

export interface IInputSystem {
  /** When false (menus open) sample() returns neutral controls; actions still register. */
  enabled: boolean;
  /** Poll gamepads. Call once per frame before sample()/consume(). */
  update(): void;
  /** Merged keyboard + mouse + gamepad controls. */
  sample(out: ControlState): ControlState;
  /** Edge-triggered: true once per press. */
  consume(action: InputAction): boolean;
  isHeld(action: InputAction): boolean;
  readonly lastDevice: 'keyboard' | 'gamepad';
  applySettings(s: Settings): void;
  rumble(strong: number, weak: number, ms: number): void;
  dispose(): void;
}

// =============================================================================================
// UI — src/ui/UIManager.ts: export class UIManager implements IUIManager
//        { constructor(root: HTMLElement, settings: Settings, callbacks: UICallbacks) }
//   Plain DOM + CSS (src/ui/*.css imported from TS). No frameworks.
// =============================================================================================

export interface PlayerLine {
  id: number;
  name: string;
  team: Team;
  isPlayer: boolean;
  isBot: boolean;
  stats: PlayerStats;
}

export interface HudState {
  freePlay: boolean;
  teamNames: [string, string];
  playerTeam: Team;
  score: [number, number];
  /** Regulation seconds remaining. */
  clock: number;
  overtime: boolean;
  overtimeElapsed: number;
  phase: MatchPhase;
  /** Seconds left in the kickoff countdown. */
  countdown: number;
  boost: number;
  speed: number;
  supersonic: boolean;
  pulseEnabled: boolean;
  /** 0..1, 1 = NOVA PULSE ready. */
  pulseReady01: number;
  chargeEnabled: boolean;
  charge: number;
  chargeTeam: Team | -1;
  /**
   * Optional: 0..1 fraction of CORE CHARGE's decay window (CHARGE.decayTime) elapsed since the last counted touch —
   * at 1 the chain drops a level. 0 when the ball is neutral and during replays.
   */
  chargeDecay01?: number;
  surge: { state: 'idle' | 'warning' | 'active'; timeLeft: number };
  ballCam: boolean;
  /** Off-screen ball arrow, CSS px relative to the viewport. */
  ballIndicator: { visible: boolean; x: number; y: number; angle: number };
  replay: boolean;
  fps: number;
  showFps: boolean;
  /** Seconds until the player's car respawns (0 when alive). */
  respawnIn: number;
  scoreboard: PlayerLine[];
}

export type NotificationKind =
  | 'goal'
  | 'ownGoal'
  | 'assist'
  | 'save'
  | 'epicSave'
  | 'shot'
  | 'demolition'
  | 'demolished'
  | 'surge'
  | 'overtime'
  | 'charge'
  | 'supernova'
  | 'lastMinute'
  | 'hatTrick'
  | 'info';

export interface HudNotification {
  kind: NotificationKind;
  title: string;
  subtitle?: string;
  team?: Team | -1;
  points?: number;
  /** true = large center banner; false/undefined = small feed item. */
  big?: boolean;
}

export interface MatchSummary {
  winner: Team | -1;
  score: [number, number];
  playerTeam: Team;
  players: PlayerLine[];
  mvpId: number;
  config: MatchConfig;
  overtime: boolean;
  /**
   * Optional: the sim's deterministic state hash (IWorld.hash(), unsigned 32-bit) on the tick the match ended —
   * together with config.seed and the input log it identifies the match result on any machine.
   */
  hash?: number;
}

export interface UICallbacks {
  onStartMatch(cfg: MatchConfig): void;
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onSettingsChanged(s: Settings): void;
  onUiSound(s: UiSound): void;
  /** First user gesture (click / key) on the page — unlock audio here. */
  onUserGesture(): void;
}

export type UIScreen = 'loading' | 'main' | 'hud' | 'pause' | 'end' | 'none';

export interface IUIManager {
  readonly screen: UIScreen;
  setLoading(progress: number, label: string): void;
  showScreen(s: UIScreen): void;
  /** Called every frame while in a match; must only touch the DOM when displayed values change. */
  updateHUD(h: HudState): void;
  notify(n: HudNotification): void;
  /** Big kickoff countdown: 3, 2, 1, 'GO', or null to hide. */
  showCountdown(value: number | 'GO' | null): void;
  setReplay(active: boolean): void;
  showEndScreen(summary: MatchSummary): void;
  setScoreboardVisible(v: boolean): void;
  dispose(): void;
}
