/**
 * NOVABALL AI — the per-tick shared context every bot brain reads.
 */
import type { IWorld } from '../contracts';
import type { MatchMutators, MatchPhase, PadState, Team } from '../sim/types';
import type { BallPath } from './perception';
import type { CarInfo, Role } from './types';

/**
 * Playing WITH a human (tuning exported for the tools). Bots read what the human is actually doing instead of trusting
 * the physical intercept estimate: a human driving at the ball is COMMITTED (bots yield unless clearly faster, so they
 * don't collide / double-commit), an IDLE one (not heading for the ball) doesn't hold the ball hostage.
 */
export const TEAM_TUNING = {
  /** Committed: closing on the ball faster than this (m/s) within commitDist (m) … */
  commitSpeed: 6,
  commitDist: 35,
  /** … −commitBonus (s) on its intercept score, and bots only take the ball when commitYield (s) faster. */
  commitBonus: 0.5,
  commitYield: 0.9,
  /** Idle: closing slower than idleVTo (m/s) and slower than idleSpeed overall: +idlePenalty (s). */
  idleVTo: 2,
  idleSpeed: 4,
  idlePenalty: 0.75,
  /** Yield margin (s) for a human who isn't committed (idle, or moving elsewhere). */
  humanYield: 0.1,
  /** Kickoff: a human takes it unless a bot is more than this (m) closer to the ball (humans nearly always go) … */
  koHumanPref: 15,
  /** … LEGEND: winning the kickoff matters most — the closest car takes it (humans only win ties). */
  koHumanPrefLegend: 0.6,
  /** … and koReplanAt (s) after GO a human taker who isn't driving at the ball (closing < koGoSpeed m/s) hands it to
   *  the nearest bot. */
  koReplanAt: 0.35,
  koGoSpeed: 3,
  /**
   * A bot kickoff taker stands back while a human teammate going for the ball would get there within this (s) of it.
   * Measured at LEGEND (64 matches per value, scripted humans that always go): 0 s → 52 % first touches but 0.39
   * kickoff bumps / match and GD −1.28; 0.3 s → 32 %, no kickoff bumps, GD −0.92 (racing the player loses more games).
   */
  koHumanContest: 0.3,
  /** Kickoff: bots keep this far (m) to the side of a human teammate's lane to the ball. */
  koLaneClear: 4,
  /**
   * Open play: a human teammate charging the ball (≥ laneMinSpeed m/s, closing on it) sweeps a lane ahead of it
   * (laneTime s of travel, up to the ball); positioning bots keep their spot — and themselves — laneWidth (m) clear of it.
   */
  laneAvoid: true,
  laneMinSpeed: 6,
  laneTime: 1.2,
  laneWidth: 3,
};

/** Team coordination, recomputed every tick by the BotManager. */
export interface TeamPlan {
  team: Team;
  /** Car ids of the team (bots and humans). */
  members: number[];
  /** Role per car id (only members are meaningful). */
  roles: Role[];
  attackerId: number;
  /** A human teammate is (or is about to be) playing the ball — bots yield. */
  humanOnBall: boolean;
  /** Kickoff: the car taking it, and the one cheating up for the follow-up (−1 if none). */
  kickoffTaker: number;
  kickoffSecond: number;
  /** Best (lowest) intercept estimate of the team and of the opponents. */
  bestEta: number;
  oppBestEta: number;
  /** Id of the fastest opponent to the ball (−1 if none). */
  oppFirstId: number;
}

export interface BotContext {
  world: IWorld;
  /** Sim time (s). */
  time: number;
  dt: number;
  phase: MatchPhase;
  phaseTime: number;
  /** BALL gravity multiplier (ZERO-G SURGE: 0.3) — ball path prediction only. */
  gScale: number;
  /**
   * CAR gravity multiplier (ZERO-G SURGE: cars fall faster than the ball, carGravityScaleFor(gScale) = 0.55) — every car
   * kinematics estimate (jump rise / apex / timing, aerial feasibility and targeting, landing prediction) uses this one.
   */
  carGScale: number;
  surgeActive: boolean;
  path: BallPath;
  /** Cars by id. */
  cars: CarInfo[];
  teamSize: number;
  pads: ReadonlyArray<PadState>;
  mutators: MatchMutators;
  /** Ball untouched since the last kickoff reset. */
  kickoff: boolean;
  /** Time since the current kickoff went live (s; large when not in a kickoff). */
  kickoffTime: number;
  plans: [TeamPlan, TeamPlan];
  ballCharge: number;
  ballChargeTeam: Team | -1;
  /** Team of the last car that touched the ball (−1 = none). */
  lastTouchTeam: Team | -1;
  lastTouchId: number;
  /** Team that scored the last goal (goal phase), −1 otherwise. */
  lastGoalTeam: Team | -1;
}
