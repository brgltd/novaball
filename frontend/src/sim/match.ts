/**
 * NOVABALL — match rules helpers: match state, kickoff layouts, ZERO-G SURGE schedule, CORE CHARGE.
 * All timers are integer tick counters (exact, deterministic); the public float fields are derived from them.
 */
import { CHARGE, KICKOFF_SPOTS, MATCH, SIM_HZ, SURGE } from './constants';
import type { Rng } from './rng';
import type { BallState, MatchConfig, MatchState, SimEvent, Team } from './types';

/** MatchState + internal bookkeeping (all hashed). */
export interface SimMatchState extends MatchState {
  /** Ticks elapsed in the current phase (phaseTime = phaseTicks / SIM_HZ). */
  phaseTicks: number;
  /** Length of the current countdown in ticks. */
  countdownTicks: number;
  /** Regulation ticks remaining (clock = clockTicks / SIM_HZ). */
  clockTicks: number;
  /** Overtime ticks elapsed (overtimeElapsed = overtimeTicks / SIM_HZ). */
  overtimeTicks: number;
  /** True from a kickoff reset until the ball's first touch. */
  kickoffPending: boolean;
  /** The match ends when the current goal phase finishes. */
  endAfterGoal: boolean;
  /** Regulation clock tick at which the next surge STARTS (-1 = none left). */
  nextSurgeClockTicks: number;
  /** Overtime tick at which the next overtime surge STARTS. */
  nextSurgeOvertimeTicks: number;
  /** Ticks left in the current surge warning / active window. */
  surgeTicksLeft: number;
  /** Total ticks of the current surge window. */
  surgeTicksTotal: number;
  /** Ticks since the last counted charge touch or decay step. */
  chargeIdleTicks: number;
  /** Sim time of the last counted charge touch. */
  lastChargeTouchTime: number;
  /** Global touch sequence counter (orders touches within a tick). Reset each kickoff. */
  touchSeq: number;
}

export const GOAL_PHASE_TICKS = Math.round(MATCH.goalPhase * SIM_HZ);
export const FREEPLAY_COUNTDOWN_TICKS = SIM_HZ; // 1 s
export const SURGE_WARNING_TICKS = Math.round(SURGE.warning * SIM_HZ);
export const SURGE_DURATION_TICKS = Math.round(SURGE.duration * SIM_HZ);
export const SURGE_INTERVAL_TICKS = Math.round(SURGE.interval * SIM_HZ);
export const SURGE_MIN_CLOCK_TICKS = Math.round(SURGE.minClock * SIM_HZ);
/** Surge visual ramps (seconds). */
const SURGE_WARN_GLOW = 0.25;
const SURGE_RAMP_IN = 0.6;
const SURGE_RAMP_OUT = 1.0;

export function createMatchState(config: MatchConfig): SimMatchState {
  const clockTicks = config.freePlay ? 0 : Math.max(1, Math.round(config.durationSec * SIM_HZ));
  return {
    phase: 'countdown',
    phaseTime: 0,
    countdown: 0,
    clock: config.freePlay ? Infinity : clockTicks / SIM_HZ,
    overtime: false,
    overtimeElapsed: 0,
    score: [0, 0],
    surge: { state: 'idle', timeLeft: 0, intensity: 0, gravityScale: 1 },
    lastGoal: null,
    winner: -1,
    freePlay: config.freePlay,
    phaseTicks: 0,
    countdownTicks: 0,
    clockTicks,
    overtimeTicks: 0,
    kickoffPending: true,
    endAfterGoal: false,
    nextSurgeClockTicks: !config.freePlay && config.mutators.surges ? firstSurgeStartTicks(clockTicks) : -1,
    nextSurgeOvertimeTicks: SURGE_INTERVAL_TICKS,
    surgeTicksLeft: 0,
    surgeTicksTotal: 0,
    chargeIdleTicks: 0,
    lastChargeTouchTime: -1e9,
    touchSeq: 0,
  };
}

/** Largest multiple of the surge interval strictly below the match length and above minClock (-1 if none). */
export function firstSurgeStartTicks(durationTicks: number): number {
  const k = Math.floor((durationTicks - 1) / SURGE_INTERVAL_TICKS);
  const t = k * SURGE_INTERVAL_TICKS;
  if (k < 1 || t <= SURGE_MIN_CLOCK_TICKS) return -1;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Kickoff layouts
// ---------------------------------------------------------------------------------------------

/** Spot index sets per team size (indices into KICKOFF_SPOTS). 3v3 always contains a diagonal. */
function buildLayouts(size: number): number[][] {
  const n = KICKOFF_SPOTS.length;
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === size) {
      if (size < 3 || acc.some((i) => KICKOFF_SPOTS[i].kind === 'diagonal')) out.push(acc.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      acc.push(i);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}
const LAYOUTS: Record<number, number[][]> = { 1: buildLayouts(1), 2: buildLayouts(2), 3: buildLayouts(3) };

/**
 * Pick a kickoff layout. Returns, for each team, the spot (x, z) of each car slot (slot k = k-th car of the team).
 * Team 1 gets the point-mirrored spots of the same layout (fair), with its own random slot assignment.
 */
export function chooseKickoffSpots(rng: Rng, teamSize: number): Array<Array<{ x: number; z: number }>> {
  const layouts = LAYOUTS[teamSize] ?? LAYOUTS[1];
  const layout = layouts[rng.int(layouts.length)];
  const t0 = rng.shuffle(layout.slice());
  const t1 = rng.shuffle(layout.slice());
  return [
    t0.map((i) => ({ x: KICKOFF_SPOTS[i].x, z: KICKOFF_SPOTS[i].z })),
    t1.map((i) => ({ x: -KICKOFF_SPOTS[i].x, z: -KICKOFF_SPOTS[i].z })),
  ];
}

// ---------------------------------------------------------------------------------------------
// ZERO-G SURGE
// ---------------------------------------------------------------------------------------------

/**
 * ZERO-G SURGE: the CAR gravity multiplier for a BALL gravity multiplier (match.surge.gravityScale).
 * Linear map 1 → 1, SURGE.gravityScale → SURGE.carGravityScale: during a surge cars fall faster than the ball (jumps
 * stay controllable, cars can't park on the ceiling) while the ball floats. Arithmetic only (deterministic); exactly 1
 * outside surges, so normal play is bit-identical.
 */
export function carGravityScaleFor(ballScale: number): number {
  const span = 1 - SURGE.gravityScale;
  if (span === 0) return ballScale;
  const t = (1 - ballScale) / span;
  return 1 - t * (1 - SURGE.carGravityScale);
}

export function triggerSurgeWarning(m: SimMatchState, events: SimEvent[]): void {
  const s = m.surge;
  s.state = 'warning';
  m.surgeTicksLeft = SURGE_WARNING_TICKS;
  m.surgeTicksTotal = SURGE_WARNING_TICKS;
  s.timeLeft = SURGE_WARNING_TICKS / SIM_HZ;
  s.gravityScale = 1;
  events.push({ type: 'surgeWarning', seconds: SURGE.warning });
  updateSurgeIntensity(m);
}

/** Advance the surge window by one tick (warning → active → idle). */
export function tickSurge(m: SimMatchState, events: SimEvent[]): void {
  const s = m.surge;
  if (s.state === 'idle') return;
  m.surgeTicksLeft--;
  if (m.surgeTicksLeft <= 0) {
    if (s.state === 'warning') {
      s.state = 'active';
      m.surgeTicksLeft = SURGE_DURATION_TICKS;
      m.surgeTicksTotal = SURGE_DURATION_TICKS;
      s.gravityScale = SURGE.gravityScale;
      events.push({ type: 'surgeStart' });
    } else {
      endSurge(m, events);
      return;
    }
  }
  s.timeLeft = m.surgeTicksLeft / SIM_HZ;
  updateSurgeIntensity(m);
}

/** Force the surge to idle (emits 'surgeEnd' if one was running). */
export function endSurge(m: SimMatchState, events: SimEvent[]): void {
  const s = m.surge;
  const wasActive = s.state !== 'idle';
  s.state = 'idle';
  s.timeLeft = 0;
  s.intensity = 0;
  s.gravityScale = 1;
  m.surgeTicksLeft = 0;
  m.surgeTicksTotal = 0;
  if (wasActive) events.push({ type: 'surgeEnd' });
}

function updateSurgeIntensity(m: SimMatchState): void {
  const s = m.surge;
  if (s.state === 'warning') {
    s.intensity = SURGE_WARN_GLOW * (1 - m.surgeTicksLeft / m.surgeTicksTotal);
  } else if (s.state === 'active') {
    const elapsed = (m.surgeTicksTotal - m.surgeTicksLeft) / SIM_HZ;
    let x = SURGE_WARN_GLOW + ((1 - SURGE_WARN_GLOW) * elapsed) / SURGE_RAMP_IN;
    if (x > 1) x = 1;
    const out = m.surgeTicksLeft / SIM_HZ / SURGE_RAMP_OUT;
    if (out < x) x = out;
    s.intensity = x < 0 ? 0 : x;
  } else {
    s.intensity = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// CORE CHARGE
// ---------------------------------------------------------------------------------------------

/**
 * Register a touch for the charge chain. `pulse` waives the closing-speed requirement.
 * Returns true if the touch was counted.
 */
export function chargeTouch(
  m: SimMatchState,
  ball: BallState,
  team: Team,
  closingSpeed: number,
  pulse: boolean,
  time: number,
  events: SimEvent[],
): boolean {
  if (time - m.lastChargeTouchTime < CHARGE.minTouchInterval) return false;
  if (!pulse && closingSpeed < CHARGE.minTouchSpeed) return false;
  m.lastChargeTouchTime = time;
  m.chargeIdleTicks = 0;
  const prevLevel = ball.charge;
  const prevTeam = ball.chargeTeam;
  if (prevTeam === team && prevLevel >= 1) {
    ball.charge = prevLevel + 1 > CHARGE.maxLevel ? CHARGE.maxLevel : prevLevel + 1;
  } else {
    ball.chargeTeam = team;
    ball.charge = 1;
  }
  if (ball.charge !== prevLevel || ball.chargeTeam !== prevTeam) {
    events.push({ type: 'chargeChange', team: ball.chargeTeam, level: ball.charge, prevLevel });
  }
  return true;
}

const CHARGE_DECAY_TICKS = Math.round(CHARGE.decayTime * SIM_HZ);

/** One tick of charge decay (one level per decayTime without a counted touch). */
export function tickChargeDecay(m: SimMatchState, ball: BallState, events: SimEvent[]): void {
  if (ball.charge <= 0) {
    m.chargeIdleTicks = 0;
    return;
  }
  m.chargeIdleTicks++;
  if (m.chargeIdleTicks >= CHARGE_DECAY_TICKS) {
    m.chargeIdleTicks = 0;
    const prevLevel = ball.charge;
    ball.charge = prevLevel - 1;
    if (ball.charge <= 0) {
      ball.charge = 0;
      ball.chargeTeam = -1;
    }
    events.push({ type: 'chargeChange', team: ball.chargeTeam, level: ball.charge, prevLevel });
  }
}

/** Neutralize the charge (kickoff). Emits 'chargeChange' if it was charged. */
export function resetCharge(m: SimMatchState, ball: BallState, events: SimEvent[]): void {
  const prevLevel = ball.charge;
  ball.charge = 0;
  ball.chargeTeam = -1;
  m.chargeIdleTicks = 0;
  m.lastChargeTouchTime = -1e9;
  if (prevLevel !== 0) events.push({ type: 'chargeChange', team: -1, level: 0, prevLevel });
}
