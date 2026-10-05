/**
 * NOVABALL AI — BotManager (implements IBotManager).
 *
 * Per sim tick (call BEFORE world.step):
 *   1. perception: push the true ball into the delay buffer; predict the perceived ball ONCE (shared by all bots)
 *   2. read every car (bots, humans, other managers' bots) into CarInfo views
 *   3. intercept estimate for every car (bots: their skill-limited plan; others: a generic estimate)
 *   4. team plans: roles (attacker / support / defender) with hysteresis — humans count as teammates: bots yield to a
 *      human who is going for the ball but don't wait on an idle one; kickoff taker (a human teammate by preference,
 *      handed to the nearest bot if they don't go) / cheat assignment — see TEAM_TUNING (context.ts)
 *   5. each bot's brain writes its ControlState into inputs[carId]
 *
 * Deterministic given (world state, seed): no Math.random, no wall-clock time.
 *
 * Integration:
 *   const botIds = world.cars.filter((c) => c.isBot).map((c) => c.id);   // attract mode: every car
 *   const bots = new BotManager(world, botIds, config.difficulty, config.seed);
 *   each sim tick:  input.sample(inputs[0]); bots.update(world, inputs); world.step(inputs);
 * - Call update() exactly once per sim tick in EVERY phase (countdown → kickoff prep, goal → celebrations,
 *   ended → neutral). Don't call it while the sim is paused (replays): the reaction-delay buffer counts ticks.
 * - Writes only inputs[id] for its bots (reusing the objects in the array, creating missing ones). Free play /
 *   no bots: update() is a no-op.
 * - Create a new BotManager for every new World (restart / rematch).
 * - Bot decisions use Math.atan2 / acos (not bit-exact across JS engines): replays / on-chain verification must record
 *   the bots' inputs instead of re-running the AI.
 */
import type { IBotManager, IWorld } from '../contracts';
import { DT, SIM_HZ } from '../sim/constants';
import { carGravityScaleFor } from '../sim/match';
import type { ControlState, Difficulty, Team } from '../sim/types';
import { makeControlState } from '../sim/types';
import { BotBrain } from './bot';
import type { BotContext, TeamPlan } from './context';
import { TEAM_TUNING } from './context';
import type { SkillProfile } from './difficulty';
import { skillFor } from './difficulty';
import type { InterceptCaps } from './intercept';
import { CarMotionModel, findIntercept, GROUND_MAX_DEFAULT } from './intercept';
import { len2 } from './math';
import { BallPath, BallPerception } from './perception';
import { readCar } from './sense';
import type { CarInfo, Intercept, Role } from './types';
import { makeCarInfo, makeIntercept } from './types';

/** Prediction horizon (s) after the perception delay. */
const HORIZON = 4;
/** Role hysteresis: the current attacker keeps the ball unless a teammate is this much (s) faster. */
const ATTACKER_HYSTERESIS = 0.3;
/** Extra seconds charged to a car that is on the wrong side of the ball when choosing the attacker. */
const WRONG_SIDE_PENALTY = 0.55;

const GENERIC_CAPS: InterceptCaps = {
  groundMax: GROUND_MAX_DEFAULT,
  jumpMax: 4.2,
  doubleMax: 6.4,
  aerialMax: 0,
  aerialMinBoost: 100,
  wallMax: 8,
  useBoost: true,
  speedCap: 23,
  slack: 0,
};

function makePlan(team: Team, n: number): TeamPlan {
  const roles: Role[] = [];
  for (let i = 0; i < n; i++) roles.push('support');
  return {
    team,
    members: [],
    roles,
    attackerId: -1,
    humanOnBall: false,
    kickoffTaker: -1,
    kickoffSecond: -1,
    bestEta: Infinity,
    oppBestEta: Infinity,
    oppFirstId: -1,
  };
}

export class BotManager implements IBotManager {
  readonly difficulty: Difficulty;
  readonly skill: SkillProfile;
  readonly botIds: number[];
  private readonly brains: BotBrain[] = [];
  /** Brain per car id (null for cars this manager doesn't control). */
  private readonly brainOf: Array<BotBrain | null> = [];
  private readonly perception: BallPerception;
  private readonly path: BallPath;
  private readonly cars: CarInfo[] = [];
  private readonly genericModel: CarMotionModel[] = [];
  private readonly genericIcpt: Intercept[] = [];
  private readonly controls: ControlState[] = [];
  private readonly plans: [TeamPlan, TeamPlan];
  private readonly ctx: BotContext;
  private lastPhase = '';
  private kickoffStart = -1;
  private kickoffPlanned = false;
  private koReplanned = false;
  /** Last update() cost (ms) and a running average — perf probe for tests / dev overlays. */
  lastUpdateMs = 0;
  avgUpdateMs = 0;

  /**
   * @param overrides optional skill tweaks on top of the difficulty profile (tuning / tests; not part of the contract)
   */
  constructor(world: IWorld, botIds: number[], difficulty: Difficulty, seed: number, overrides?: Partial<SkillProfile>) {
    this.difficulty = difficulty;
    this.skill = overrides ? { ...skillFor(difficulty), ...overrides } : skillFor(difficulty);
    const n = world.cars.length;
    this.botIds = botIds.filter((id) => id >= 0 && id < n);
    // perception delay rounded to whole 1/60 s slices (2 sim ticks)
    const delayTicks = Math.max(0, Math.round((this.skill.reaction * SIM_HZ) / 2) * 2);
    this.perception = new BallPerception(delayTicks);
    this.path = new BallPath(HORIZON, delayTicks);
    for (let i = 0; i < n; i++) {
      this.cars.push(makeCarInfo());
      this.brainOf.push(null);
      this.genericModel.push(new CarMotionModel(HORIZON, 1 / 60));
      this.genericIcpt.push(makeIntercept());
    }
    const s0 = (Math.floor(Number.isFinite(seed) ? seed : 0) ^ 0x2545f491) >>> 0;
    for (const id of this.botIds) {
      const brain = new BotBrain(id, this.skill, (s0 + Math.imul(id + 1, 0x9e3779b1)) >>> 0, HORIZON + 1);
      this.brains.push(brain);
      this.brainOf[id] = brain;
      this.controls[id] = makeControlState();
    }
    this.plans = [makePlan(0, n), makePlan(1, n)];
    for (let i = 0; i < n; i++) this.plans[world.cars[i].team].members.push(world.cars[i].id);
    this.ctx = {
      world,
      time: world.time,
      dt: DT,
      phase: world.match.phase,
      phaseTime: world.match.phaseTime,
      gScale: 1,
      carGScale: 1,
      surgeActive: false,
      path: this.path,
      cars: this.cars,
      teamSize: world.config.teamSize,
      pads: world.pads,
      mutators: world.config.mutators,
      kickoff: true,
      kickoffTime: 0,
      plans: this.plans,
      ballCharge: 0,
      ballChargeTeam: -1,
      lastTouchTeam: -1,
      lastTouchId: -1,
      lastGoalTeam: -1,
    };
  }

  update(world: IWorld, inputs: ControlState[]): void {
    if (this.brains.length === 0) return;
    const t0 = performance.now();
    const ctx = this.ctx;
    const m = world.match;
    const ball = world.ball;
    ctx.world = world;
    ctx.time = world.time;
    ctx.phase = m.phase;
    ctx.phaseTime = m.phaseTime;
    // ZERO-G SURGE: the ball floats at gScale, cars fall at carGravityScaleFor(gScale) (exactly 1 outside surges)
    ctx.gScale = m.surge.gravityScale;
    ctx.carGScale = carGravityScaleFor(ctx.gScale);
    ctx.surgeActive = m.surge.state === 'active';
    ctx.pads = world.pads;
    ctx.mutators = world.config.mutators;
    ctx.ballCharge = ball.charge;
    ctx.ballChargeTeam = ball.chargeTeam;
    ctx.lastTouchId = ball.lastTouchCarId;
    ctx.lastTouchTeam = ball.lastTouchCarId >= 0 && ball.lastTouchCarId < world.cars.length ? world.cars[ball.lastTouchCarId].team : -1;
    ctx.lastGoalTeam = m.phase === 'goal' && m.lastGoal ? m.lastGoal.team : -1;

    // ---- kickoff bookkeeping
    const ext = m as typeof m & { kickoffPending?: boolean };
    const pending = typeof ext.kickoffPending === 'boolean' ? ext.kickoffPending : ball.lastTouchCarId < 0;
    if (m.phase === 'countdown') {
      if (this.lastPhase !== 'countdown') {
        this.perception.reset();
        this.kickoffPlanned = false;
      }
      this.kickoffStart = -1;
    } else if (m.phase === 'playing' && this.lastPhase === 'countdown') {
      this.kickoffStart = world.time;
    }
    this.lastPhase = m.phase;
    ctx.kickoff = pending && (m.phase === 'countdown' || m.phase === 'playing') && !m.freePlay;
    ctx.kickoffTime = this.kickoffStart >= 0 ? world.time - this.kickoffStart : m.phase === 'countdown' ? 0 : 99;

    // ---- perception + shared prediction
    this.perception.push(ball);
    this.path.update(this.perception.perceived, ctx.gScale);

    // ---- cars + intercept estimates
    const n = world.cars.length;
    for (let i = 0; i < n; i++) {
      const c = world.cars[i];
      const info = readCar(c, this.brainOf[c.id] !== null, DT, this.cars[c.id]);
      const brain = this.brainOf[c.id];
      if (brain) brain.plan(ctx, info);
      else {
        const model = this.genericModel[c.id];
        model.update(info, GENERIC_CAPS);
        const ic = findIntercept(info, this.path, model, GENERIC_CAPS, ctx.carGScale, this.genericIcpt[c.id]);
        info.eta = ic.found ? ic.time : Infinity;
        if (ic.found) info.etaPos.copy(ic.pos);
      }
    }

    // ---- team plans
    this.planTeam(0);
    this.planTeam(1);
    if (ctx.kickoff && !this.kickoffPlanned) {
      this.planKickoff(0, false);
      this.planKickoff(1, false);
      this.kickoffPlanned = true;
      this.koReplanned = false;
    }
    // a human kickoff taker who isn't going for it: the nearest bot takes over
    if (ctx.kickoff && !this.koReplanned && m.phase === 'playing' && ctx.kickoffTime > TEAM_TUNING.koReplanAt) {
      this.koReplanned = true;
      for (let t = 0; t < 2; t++) {
        const tk = this.plans[t].kickoffTaker;
        if (tk >= 0 && !this.cars[tk].isBot) this.planKickoff(t as Team, true);
      }
    }
    if (!ctx.kickoff) this.kickoffPlanned = false;

    // ---- brains
    for (let b = 0; b < this.brains.length; b++) {
      const brain = this.brains[b];
      const id = brain.id;
      const out = this.controls[id];
      brain.update(ctx, this.cars[id], out);
      if (!inputs[id]) inputs[id] = makeControlState();
      const dst = inputs[id];
      dst.throttle = out.throttle;
      dst.steer = out.steer;
      dst.pitch = out.pitch;
      dst.yaw = out.yaw;
      dst.roll = out.roll;
      dst.jump = out.jump;
      dst.boost = out.boost;
      dst.powerslide = out.powerslide;
      dst.pulse = out.pulse;
    }
    const ms = performance.now() - t0;
    this.lastUpdateMs = ms;
    this.avgUpdateMs = this.avgUpdateMs === 0 ? ms : this.avgUpdateMs * 0.99 + ms * 0.01;
  }

  debugInfo(): string {
    const parts: string[] = [];
    for (const b of this.brains) {
      const plan = this.plans[this.cars[b.id].team];
      parts.push(`${b.id}[${plan.roles[b.id][0]}]${b.mode}`);
    }
    return `${this.difficulty} ${parts.join(' ')}`;
  }

  /** Mode / role / target of one bot (dev overlay, tests). */
  botState(
    id: number,
  ): { mode: string; role: Role; target: { x: number; y: number; z: number }; eta: number; shotDir: { x: number; z: number }; shotKind: string } | null {
    const b = this.brainOf[id];
    if (!b) return null;
    const car = this.cars[id];
    return {
      mode: b.mode,
      role: this.plans[car.team].roles[id],
      target: b.target,
      eta: car.eta,
      shotDir: { x: b.shot.dir.x, z: b.shot.dir.z },
      shotKind: b.shot.kind,
    };
  }

  /** Maneuver statistics of one bot (starts / touches per maneuver type) — tuning & tests. */
  botStats(id: number): { starts: Record<string, number>; hits: Record<string, number> } | null {
    const b = this.brainOf[id];
    return b ? b.stats : null;
  }

  // ===========================================================================================
  // Team coordination
  // ===========================================================================================

  private planTeam(team: Team): void {
    const plan = this.plans[team];
    const cars = this.cars;
    const path = this.path;
    const B = path.nowPos;
    const dir = team === 0 ? 1 : -1;
    const bzr = B.z * dir;
    // opponents' best eta
    let oppBest = Infinity;
    let oppFirst = -1;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.team === team || c.demolished) continue;
      if (c.eta < oppBest) {
        oppBest = c.eta;
        oppFirst = c.id;
      }
    }
    plan.oppBestEta = oppBest;
    plan.oppFirstId = oppFirst;
    // attacker: best (penalised) intercept time, with hysteresis
    let best = -1;
    let bestScore = Infinity;
    let bestBot = -1;
    let bestBotScore = Infinity;
    let human = -1;
    let humanScore = Infinity;
    let humanCommitted = false;
    plan.bestEta = Infinity;
    const members = plan.members;
    for (let k = 0; k < members.length; k++) {
      const c = cars[members[k]];
      if (c.demolished) continue;
      if (c.eta < plan.bestEta) plan.bestEta = c.eta;
      let score = c.eta;
      if (!Number.isFinite(score)) score = 50 + len2(B.x - c.pos.x, B.z - c.pos.z) / 10;
      // wrong side of the ball (would have to go around it / hit it backwards)
      if (c.zr > bzr + 1.5) score += WRONG_SIDE_PENALTY;
      if (c.id === plan.attackerId) score -= ATTACKER_HYSTERESIS;
      if (!c.isBot) {
        // humans: driving at the ball within reach = committed; not heading for it = idle (don't wait on them)
        const dx = B.x - c.pos.x;
        const dz = B.z - c.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        const vTo = (c.vel.x * dx + c.vel.z * dz) / d;
        const committed = vTo > TEAM_TUNING.commitSpeed && d < TEAM_TUNING.commitDist;
        if (committed) score -= TEAM_TUNING.commitBonus;
        else if (vTo < TEAM_TUNING.idleVTo && c.speed < TEAM_TUNING.idleSpeed) score += TEAM_TUNING.idlePenalty;
        if (score < humanScore) {
          humanScore = score;
          human = c.id;
          humanCommitted = committed;
        }
      } else if (score < bestBotScore) {
        bestBotScore = score;
        bestBot = c.id;
      }
      if (score < bestScore) {
        bestScore = score;
        best = c.id;
      }
    }
    // yield to a human teammate going for it (unless a bot is clearly faster)
    if (human >= 0 && humanScore < bestBotScore + (humanCommitted ? TEAM_TUNING.commitYield : TEAM_TUNING.humanYield)) best = human;
    plan.attackerId = best;
    plan.humanOnBall = best >= 0 && !cars[best].isBot;
    // remaining: defender = deepest, the rest support
    let deepest = -1;
    let deepZr = Infinity;
    for (let k = 0; k < members.length; k++) {
      const c = cars[members[k]];
      plan.roles[c.id] = 'support';
      if (c.id === best || c.demolished) continue;
      // score depth by position (and a bit by current role to avoid flip-flopping)
      const z = c.zr + (plan.roles[c.id] === 'defender' ? -3 : 0);
      if (z < deepZr) {
        deepZr = z;
        deepest = c.id;
      }
    }
    if (best >= 0) plan.roles[best] = 'attacker';
    const others = members.length - 1;
    if (deepest >= 0) {
      if (others >= 2 || bzr < -5) plan.roles[deepest] = 'defender';
      else plan.roles[deepest] = 'support';
    }
  }

  /**
   * Kickoff roles: the taker (closest; a human is preferred — see TEAM_TUNING), and in 3v3 the second closest cheats up.
   * `replan`: a human taker who isn't driving at the ball by now is skipped (the nearest bot takes over).
   */
  private planKickoff(team: Team, replan: boolean): void {
    const plan = this.plans[team];
    const cars = this.cars;
    const pref = this.difficulty === 'legend' ? TEAM_TUNING.koHumanPrefLegend : TEAM_TUNING.koHumanPref;
    let taker = -1;
    let takerD = Infinity;
    let second = -1;
    let secondD = Infinity;
    for (let k = 0; k < plan.members.length; k++) {
      const c = cars[plan.members[k]];
      if (c.demolished) continue;
      const dc = Math.sqrt(c.pos.x * c.pos.x + c.pos.z * c.pos.z) || 1;
      if (!c.isBot && replan) {
        const vTo = -(c.vel.x * c.pos.x + c.vel.z * c.pos.z) / dc;
        if (vTo < TEAM_TUNING.koGoSpeed) continue;
      }
      // humans are preferred (they nearly always go); then "left goes" (larger x for team 0 / smaller x for team 1)
      let d = dc - (c.isBot ? 0 : pref);
      d -= c.pos.x * (team === 0 ? 1 : -1) * 0.001;
      if (d < takerD) {
        second = taker;
        secondD = takerD;
        taker = c.id;
        takerD = d;
      } else if (d < secondD) {
        second = c.id;
        secondD = d;
      }
    }
    plan.kickoffTaker = taker;
    // in 3v3 the second closest cheats up; in 2v2 the other one fetches boost
    plan.kickoffSecond = plan.members.length >= 3 ? second : -1;
  }
}
