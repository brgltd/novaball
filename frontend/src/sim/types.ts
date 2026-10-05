/**
 * NOVABALL — shared simulation types (CONTRACT).
 *
 * Every module codes against these types. The sim agent may ADD fields to CarState / BallState /
 * MatchState for internal bookkeeping, but must not rename/remove/retype the documented ones.
 * Vector fields are three.js Vector3 / Quaternion instances owned by the sim (treat as read-only
 * outside src/sim). Events carry plain-object copies (never aliases of live sim vectors).
 */
import type { Quaternion, Vector3 } from 'three';

export type Team = 0 | 1;
export type Difficulty = 'rookie' | 'pro' | 'legend';
export type TeamSize = 1 | 2 | 3;
export type CarStyleId = 'striker' | 'viper' | 'titan';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Per-tick controls for one car. Identical shape for human players and bots.
 * Input devices write `yaw` = `steer` (same horizontal axis) and `pitch` = `throttle` for keyboards;
 * gamepads write pitch from the stick's vertical axis. The sim decides what applies (ground vs air).
 */
export interface ControlState {
  /** -1..1, +1 = accelerate forward, -1 = brake / reverse. */
  throttle: number;
  /** -1..1, +1 = steer right. */
  steer: number;
  /** -1..1, +1 = nose DOWN (stick pushed forward). Air only. Also the forward/back component of a dodge. */
  pitch: number;
  /** -1..1, +1 = nose right. Air only. Also the right/left component of a dodge. */
  yaw: number;
  /** -1..1, +1 = roll right (clockwise seen from behind). Air only. */
  roll: number;
  /** Held state; the sim detects press edges (jump / double jump / dodge / self-right). */
  jump: boolean;
  boost: boolean;
  /** Ground: powerslide (drift). Air: "free air roll" — the sim converts yaw input into roll while held. */
  powerslide: boolean;
  /** Held state; the sim triggers NOVA PULSE on the press edge when off cooldown. */
  pulse: boolean;
}

export function makeControlState(): ControlState {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, powerslide: false, pulse: false };
}

export function copyControlState(src: ControlState, dst: ControlState): ControlState {
  dst.throttle = src.throttle;
  dst.steer = src.steer;
  dst.pitch = src.pitch;
  dst.yaw = src.yaw;
  dst.roll = src.roll;
  dst.jump = src.jump;
  dst.boost = src.boost;
  dst.powerslide = src.powerslide;
  dst.pulse = src.pulse;
  return dst;
}

export interface PlayerStats {
  score: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  demos: number;
  touches: number;
  /** Fastest ball speed (m/s) this car produced with a single touch. */
  hardestHit: number;
}

export function makePlayerStats(): PlayerStats {
  return { score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0, hardestHit: 0 };
}

export interface CarState {
  id: number;
  team: Team;
  name: string;
  isBot: boolean;
  style: CarStyleId;
  /** Hitbox center, world space. */
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  /** World-space angular velocity (rad/s). */
  angVel: Vector3;
  boost: number; // 0..100
  /** Hover field engaged on some surface (floor, wall, ceiling, goal). */
  onGround: boolean;
  /** Surface normal under the car (valid while onGround; world up otherwise). */
  groundNormal: Vector3;
  /** Seconds since the car last left the ground (0 while grounded). */
  airTime: number;
  hasJumped: boolean;
  hasDoubleJumped: boolean;
  hasDodged: boolean;
  /** True while the dodge (flip) is in progress. */
  isDodging: boolean;
  isBoosting: boolean;
  isPowersliding: boolean;
  supersonic: boolean;
  demolished: boolean;
  /** Seconds until respawn (while demolished). */
  respawnTimer: number;
  /** Seconds until NOVA PULSE is ready (0 = ready). */
  pulseCooldown: number;
  /** Controls applied during the last step (for visuals: steering lean, throttle, etc.). */
  lastControls: ControlState;
  stats: PlayerStats;
}

export interface BallState {
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  angVel: Vector3;
  /** CORE CHARGE level 0..CHARGE.maxLevel (0 = neutral). */
  charge: number;
  /** Team owning the charge chain, -1 when neutral. */
  chargeTeam: Team | -1;
  lastTouchCarId: number; // -1 = none
  lastTouchTime: number; // sim time of the last touch
  /** True after a goal (ball exploded / hidden) until the next kickoff. */
  exploded: boolean;
}

export interface PadState {
  index: number;
  big: boolean;
  /** Pad center on the floor (y = 0). */
  pos: Vector3;
  active: boolean;
  /** Seconds until re-activation (while inactive). */
  timer: number;
}

export type MatchPhase = 'countdown' | 'playing' | 'goal' | 'ended';

export interface SurgeState {
  state: 'idle' | 'warning' | 'active';
  /** Seconds left in the current warning / active window. */
  timeLeft: number;
  /** 0..1 smooth visual intensity (ramps in/out around the active window). */
  intensity: number;
  /**
   * Current BALL gravity multiplier (1 outside surges, SURGE.gravityScale during one). Cars use
   * carGravityScaleFor(gravityScale) (src/sim/match.ts): they fall faster than the floating ball.
   */
  gravityScale: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** Seconds elapsed in the current phase. */
  phaseTime: number;
  /** Seconds remaining in the countdown (phase 'countdown'). */
  countdown: number;
  /** Regulation seconds remaining. Frozen during countdown / goal / overtime. */
  clock: number;
  overtime: boolean;
  overtimeElapsed: number;
  score: [number, number];
  surge: SurgeState;
  lastGoal: { team: Team; scorerId: number; points: number } | null;
  /** Set when phase === 'ended'. */
  winner: Team | -1;
  /** Free play: no clock, no opponents, no goals ending the match. */
  freePlay: boolean;
}

export interface MatchMutators {
  charge: boolean; // CORE CHARGE multiplier
  pulse: boolean; // NOVA PULSE ability
  surges: boolean; // ZERO-G SURGE events
  demolitions: boolean;
}

export interface PlayerSetup {
  name: string;
  style: CarStyleId;
  /** Hex paint color for the car body, e.g. '#e8eef7'. Team color is always used for trims/lights. */
  paint: string;
}

export interface MatchConfig {
  teamSize: TeamSize;
  durationSec: number;
  difficulty: Difficulty;
  seed: number;
  freePlay: boolean;
  mutators: MatchMutators;
  /** null => spectator / attract mode: every car is a bot. */
  player: PlayerSetup | null;
}

/**
 * Car id convention (World constructor MUST follow it):
 *   ids 0..teamSize-1 are team 0, ids teamSize..2*teamSize-1 are team 1.
 *   If config.player != null, car 0 is the human player (team 0, isBot = false); all others are bots.
 *   Free play: only car 0 exists (the player).
 */
export function carIdsForTeam(teamSize: number, team: Team): number[] {
  const out: number[] = [];
  for (let i = 0; i < teamSize; i++) out.push(team * teamSize + i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Events (appended by World.step, drained by the game layer each frame)
// ---------------------------------------------------------------------------------------------

export type SimEvent =
  | { type: 'ballHit'; carId: number; team: Team; pos: Vec3Like; normal: Vec3Like; /** ball Δv in m/s */ strength: number; dodge: boolean; aerial: boolean; ballSpeed: number }
  | { type: 'ballBounce'; pos: Vec3Like; normal: Vec3Like; /** impact speed along the normal, m/s */ speed: number }
  | { type: 'carImpact'; carId: number; pos: Vec3Like; normal: Vec3Like; speed: number }
  | { type: 'carBump'; aId: number; bId: number; pos: Vec3Like; speed: number }
  | { type: 'jump'; carId: number; double: boolean }
  | { type: 'dodge'; carId: number; /** forward component */ fx: number; /** right component */ rx: number }
  | { type: 'land'; carId: number; speed: number }
  | { type: 'boostPickup'; carId: number; padIndex: number; big: boolean }
  | { type: 'demolish'; victimId: number; attackerId: number; pos: Vec3Like; vel: Vec3Like }
  | { type: 'respawn'; carId: number }
  | { type: 'pulse'; carId: number; pos: Vec3Like; hitBall: boolean; hitCarIds: number[] }
  | { type: 'chargeChange'; team: Team | -1; level: number; prevLevel: number }
  | { type: 'goal'; team: Team; scorerId: number; assistId: number; points: number; charge: number; ballSpeed: number; pos: Vec3Like; ownGoal: boolean }
  | { type: 'save'; carId: number; epic: boolean }
  | { type: 'shot'; carId: number }
  | { type: 'countdown'; value: number }
  | { type: 'kickoff' }
  | { type: 'surgeWarning'; seconds: number }
  | { type: 'surgeStart' }
  | { type: 'surgeEnd' }
  | { type: 'overtime' }
  | { type: 'clockTick'; secondsLeft: number }
  | { type: 'matchEnd'; winner: Team | -1 };

export type SimEventType = SimEvent['type'];

// ---------------------------------------------------------------------------------------------
// Snapshots (render interpolation + replays). Produced by the sim, consumed by render/replay.
// ---------------------------------------------------------------------------------------------

export interface CarSnapshot {
  id: number;
  team: Team;
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  angVel: Vector3;
  boost: number;
  boosting: boolean;
  supersonic: boolean;
  onGround: boolean;
  demolished: boolean;
  dodging: boolean;
  powersliding: boolean;
  /** -1..1 applied steer / throttle (visual lean, thruster intensity). */
  steer: number;
  throttle: number;
  /** 0..1, 1 = pulse ready. */
  pulseReady01: number;
}

export interface BallSnapshot {
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  angVel: Vector3;
  charge: number;
  chargeTeam: Team | -1;
  /** false while exploded (after a goal). */
  visible: boolean;
}

export interface WorldSnapshot {
  tick: number;
  time: number;
  phase: MatchPhase;
  cars: CarSnapshot[];
  ball: BallSnapshot;
  padsActive: boolean[];
  /** 0..1 zero-G surge visual intensity. */
  surge: number;
}
