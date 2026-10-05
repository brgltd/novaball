/**
 * NOVABALL AI — one bot's brain.
 *
 * Every tick: (maneuver in progress? → it owns the controls) → airborne recovery / self-right → kickoff → role
 * behaviour (attacker: shoot / challenge / shadow; support: second man; defender: last man; cover: goal-line block
 * when the ball is heading in) → NOVA PULSE decision. Planning uses the shared, perception-delayed ball path.
 */
import { Vector3 } from 'three';
import { ARENA, BALL, DT, PULSE } from '../sim/constants';
import type { ControlState } from '../sim/types';
import { Aerial } from './aerial';
import { bestBigPad, bigPadDetour, smallPadOnRoute } from './boost';
import type { BotContext } from './context';
import { TEAM_TUNING } from './context';
import { Driver, driveOpts, neutral, type DriveOptions } from './controller';
import type { SkillProfile } from './difficulty';
import { SURGE_TUNING } from './difficulty';
import type { InterceptCaps } from './intercept';
import { aerialDifficulty, CarMotionModel, CONTACT_REACH, findIntercept, GROUND_MAX_DEFAULT } from './intercept';
import { Celebrate, Flip, JumpShot, type Maneuver, recoverOrient, Unstick } from './maneuvers';
import { BotRng, clamp, clamp1, len2, wrapPi } from './math';
import { jumpShotRise, jumpTiming, turnRadius } from './physics';
import { chooseShot, headsToOwnGoal, makeShotPlan, type ShotKind } from './shot';
import type { CarInfo, Intercept } from './types';
import { makeIntercept } from './types';

const L = ARENA.halfLength;
const W = ARENA.halfWidth;
const R = BALL.radius;
/** Time-to-contact at which a ground flip into the ball is started (jump → dodge → nose meets ball). */
export const FLIP_TTC = 0.24;
/** Jump shots: horizontal distance (m) the car center stays short of the ball center at contact. */
const JUMP_CONTACT_BACK = 1.4;
/** Largest cut (rad) a flip keeps on target (measured: flips hold the straight-cut model up to ≈ 35°). */
const FLIP_MAX_CUT = 0.62;

/** Shot-approach tuning (exported for the tuning tools). */
export const STRIKE_TUNING = {
  /** Max cut (rad) driven as a straight line through the calibrated aim point. */
  straightCut: 0.3,
  /** The car's heading must be within this angle (rad) of the aim line to commit to the straight cut … */
  headingTol: 0.35,
  /** … unless there are at least this many turning radii of room left. */
  roomRadii: 2,
};

/** Lateral offset δ (m) of the car's line from the ball center that cuts the ball by `cut` rad (θ° ≈ 17δ + 10δ²). */
export function cutOffset(cut: number): number {
  const th = (cut * 180) / Math.PI;
  const d = (-17 + Math.sqrt(289 + 40 * th)) / 20;
  return d < 0 ? 0 : d > 1.25 ? 1.25 : d;
}

const OPT_FAST: DriveOptions = driveOpts({ reverse: false });
const OPT_DEF: DriveOptions = driveOpts({ reverse: true });
const OPT_FAST_NOBOOST: DriveOptions = driveOpts({ reverse: false, boost: false });
const OPT_POS: DriveOptions = driveOpts({});
const OPT_POS_NOBOOST: DriveOptions = driveOpts({ boost: false });

const _v = new Vector3();

/** Distance from (px, pz) to the segment (ax, az)–(bx, bz). */
function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const sx = bx - ax;
  const sz = bz - az;
  const l2 = sx * sx + sz * sz;
  let t = l2 > 1e-9 ? ((px - ax) * sx + (pz - az) * sz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + sx * t - px;
  const dz = az + sz * t - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Smallest distance between the 2D segments P1–P2 and Q1–Q2 (0 when they cross). */
function segSegDist(p1x: number, p1z: number, p2x: number, p2z: number, q1x: number, q1z: number, q2x: number, q2z: number): number {
  const o1 = (p2x - p1x) * (q1z - p1z) - (p2z - p1z) * (q1x - p1x);
  const o2 = (p2x - p1x) * (q2z - p1z) - (p2z - p1z) * (q2x - p1x);
  const o3 = (q2x - q1x) * (p1z - q1z) - (q2z - q1z) * (p1x - q1x);
  const o4 = (q2x - q1x) * (p2z - q1z) - (q2z - q1z) * (p2x - q1x);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(
    pointSegDist(p1x, p1z, q1x, q1z, q2x, q2z),
    pointSegDist(p2x, p2z, q1x, q1z, q2x, q2z),
    pointSegDist(q1x, q1z, p1x, p1z, p2x, p2z),
    pointSegDist(q2x, q2z, p1x, p1z, p2x, p2z),
  );
}

/** Mode names (constants: no per-tick string building). */
const JUMP_SETUP = 'jumpSetup';
const SHOOT_MODE: Readonly<Record<ShotKind, string>> = {
  goal: 'shoot:goal',
  upfield: 'shoot:upfield',
  clear: 'shoot:clear',
  center: 'shoot:center',
  none: 'shoot:none',
};

export class BotBrain {
  readonly id: number;
  readonly skill: SkillProfile;
  readonly driver: Driver;
  readonly model: CarMotionModel;
  readonly caps: InterceptCaps;
  readonly icpt: Intercept = makeIntercept();
  maneuver: Maneuver | null = null;
  /** Debug: current behaviour and target. */
  mode = 'idle';
  readonly target = new Vector3();
  private readonly rng: BotRng;
  /** Current shot plan (direction the bot is trying to send the ball) — debug / tests. */
  readonly shot = makeShotPlan();
  /** Maneuver statistics (starts / ones that touched the ball) — tuning & tests. */
  readonly stats = { starts: {} as Record<string, number>, hits: {} as Record<string, number> };
  private tracked: Maneuver | null = null;
  private trackedStart = 0;
  /** Personality: > 1 challenges more eagerly. */
  private readonly aggression: number;
  // per-approach imperfection (resampled whenever the ball's trajectory changes)
  private aimErr = 0;
  private aimSpread = 0;
  private whiffLat = 0;
  private whiffTime = 0;
  private noiseKey = -2;
  // kickoff
  private koPrepared = false;
  private koDelay = 0;
  private koOffset = 0;
  private koFlipDist = 0;
  /** Kickoff taker yielding to a human teammate who is going for it (sim time until which it stands back). */
  private koYieldUntil = -1;
  // misc
  private stuck = 0;
  private jumpPrev = false;
  private pulseUntil = -1;
  private pulseYes = false;
  private celebrated = false;
  private boostGateTimer = 0;
  private faceFwd = true;
  private faceTimer = 0;
  // shot approach
  private readonly avoid = new Vector3();
  private readonly appr = { tx: 0, tz: 0, ax: 0, az: 0, lined: false, cut: 0 };
  private straightCut = false;
  private curving = 0;
  private impatient = -1;
  private demoTarget = -1;
  /** The last planned touch would have gone into our own goal (debug). */
  unsafe = false;

  constructor(id: number, skill: SkillProfile, seed: number, horizon: number) {
    this.id = id;
    this.skill = skill;
    this.rng = new BotRng(seed);
    this.driver = new Driver(skill);
    this.model = new CarMotionModel(horizon, 1 / 60);
    this.caps = {
      groundMax: GROUND_MAX_DEFAULT,
      jumpMax: skill.jumpShots ? skill.jumpMaxHeight : 0,
      doubleMax: skill.doubleJumps ? 6.4 : 0,
      aerialMax: skill.aerialMaxHeight,
      aerialMinBoost: skill.aerialMinBoost,
      wallMax: skill.wallPlay ? skill.wallMaxHeight : 0,
      useBoost: skill.boostUse > 0.5,
      speedCap: skill.speedCap,
      slack: 0,
    };
    this.aggression = 0.85 + this.rng.next() * 0.3;
  }

  /** Planning pass (before roles): motion model + earliest intercept. */
  plan(ctx: BotContext, me: CarInfo): void {
    // ZERO-G SURGE: the ball floats high and slowly — go up for it (see SURGE_TUNING)
    const sk = this.skill;
    const low = 1 - ctx.gScale;
    const surge = low > 0.05;
    if (sk.aerialMaxHeight > 0) {
      this.caps.aerialMax = surge ? Math.min(SURGE_TUNING.aerialCap, sk.aerialMaxHeight + SURGE_TUNING.aerialExtra * low) : sk.aerialMaxHeight;
      this.caps.aerialMinBoost = surge ? sk.aerialMinBoost * SURGE_TUNING.aerialBoostK : sk.aerialMinBoost;
    }
    this.caps.surgeJump = surge && (sk.aerialMaxHeight > 0 ? SURGE_TUNING.jumpReach : SURGE_TUNING.jumpReachNoAerial);
    this.model.update(me, this.caps);
    findIntercept(me, ctx.path, this.model, this.caps, ctx.carGScale, this.icpt);
    me.eta = this.icpt.found ? this.icpt.time : Infinity;
    if (this.icpt.found) me.etaPos.copy(this.icpt.pos);
    // resample imperfection when the ball's course changes (new touch) or every ~1.5 s
    const key = ctx.lastTouchId * 100000 + Math.floor(ctx.time / 1.5);
    if (key !== this.noiseKey) {
      this.noiseKey = key;
      const s = this.skill;
      this.aimErr = this.rng.gauss(s.aimNoise);
      this.aimSpread = this.rng.gauss(s.aimSpread);
      const whiff = this.rng.chance(s.whiff);
      this.whiffLat = whiff ? (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(0.45, 1) * s.whiffOffset : 0;
      this.whiffTime = whiff ? this.rng.range(-0.12, 0.2) : 0;
    }
  }

  /** Write this tick's controls. */
  update(ctx: BotContext, me: CarInfo, out: ControlState): void {
    neutral(out);
    // boost willingness gate (rookies only boost part of the time)
    this.boostGateTimer -= ctx.dt;
    if (this.boostGateTimer <= 0) {
      this.boostGateTimer = 0.8;
      this.driver.boostGate = this.rng.chance(this.skill.boostUse);
    }
    if (me.demolished) {
      this.maneuver = null;
      this.driver.reset();
      this.mode = 'demolished';
      this.jumpPrev = false;
      return;
    }
    if (ctx.phase === 'ended') {
      this.maneuver = null;
      this.mode = 'ended';
      this.jumpPrev = false;
      return;
    }
    if (ctx.phase === 'countdown') {
      this.onCountdown(ctx, me, out);
      this.jumpPrev = out.jump;
      return;
    }
    if (ctx.phase === 'goal') {
      this.onGoalPhase(ctx, me, out);
      this.jumpPrev = out.jump;
      return;
    }
    // ---- playing
    if (!ctx.kickoff) this.koPrepared = false;
    if (this.maneuver) {
      const m = this.maneuver;
      if (this.tracked !== m) {
        this.tracked = m;
        this.trackedStart = ctx.time;
        this.stats.starts[m.name] = (this.stats.starts[m.name] ?? 0) + 1;
      }
      m.step(ctx, me, out);
      m.t += ctx.dt;
      if (!m.done) {
        this.mode = m.name;
        this.afterDecision(ctx, me, out);
        this.jumpPrev = out.jump;
        return;
      }
      if (me.lastTouchTime >= this.trackedStart) this.stats.hits[m.name] = (this.stats.hits[m.name] ?? 0) + 1;
      this.maneuver = null;
      neutral(out);
    }
    if (!me.onGround) {
      this.airborne(ctx, me, out);
    } else if (ctx.kickoff && ctx.kickoffTime < 8) {
      this.kickoff(ctx, me, out);
    } else {
      this.play(ctx, me, out);
      this.stuckCheck(ctx, me, out);
    }
    this.afterDecision(ctx, me, out);
    this.jumpPrev = out.jump;
  }

  debug(): string {
    return `${this.id}:${this.mode}`;
  }

  // ===========================================================================================
  // Phases
  // ===========================================================================================

  private onCountdown(ctx: BotContext, me: CarInfo, out: ControlState): void {
    this.maneuver = null;
    this.driver.reset();
    this.celebrated = false;
    this.mode = 'countdown';
    if (!this.koPrepared) {
      this.koPrepared = true;
      const [a, b] = this.skill.kickoffDelay;
      this.koDelay = this.rng.range(a, b);
      this.koOffset = this.rng.range(-0.35, 0.35);
      this.koFlipDist = this.rng.range(-0.25, 0.25);
    }
    out.steer = 0;
    this.target.copy(me.pos);
  }

  private onGoalPhase(ctx: BotContext, me: CarInfo, out: ControlState): void {
    this.koPrepared = false;
    if (this.maneuver) {
      this.maneuver.step(ctx, me, out);
      this.maneuver.t += ctx.dt;
      if (this.maneuver.done) this.maneuver = null;
      this.mode = 'celebrate';
      return;
    }
    if (!me.onGround) {
      recoverOrient(ctx, me, out);
      this.mode = 'recover';
      return;
    }
    if (ctx.lastGoalTeam === me.team) {
      if (!this.celebrated && ctx.phaseTime > 0.15 + (me.id % 3) * 0.2) {
        this.celebrated = true;
        if (this.rng.chance(0.75)) {
          this.maneuver = new Celebrate(this.rng.int(3));
          return;
        }
      }
      // victory lap: cruise
      out.throttle = 0.6;
      out.steer = 0.25;
      this.mode = 'cheer';
    } else {
      // conceded: roll to a stop
      out.throttle = 0;
      this.mode = 'sulk';
    }
  }

  // ===========================================================================================
  // Air / recovery
  // ===========================================================================================

  private airborne(ctx: BotContext, me: CarInfo, out: ControlState): void {
    // turtled on the floor / wall: self-right with a jump press (edge)
    if (me.up.y < 0.35 && me.speed < 3 && me.pos.y < 1.4) {
      out.jump = !this.jumpPrev;
      out.throttle = 0;
      this.mode = 'selfRight';
      return;
    }
    // mid-air aerial opportunity (e.g. after a bump / off a wall) — legend only
    if (this.skill.aerialMaxHeight >= 10 && this.icpt.found && this.icpt.kind === 'aerial' && me.boost > 25 && me.airTime > 0.1) {
      const plan = ctx.plans[me.team];
      if (plan.roles[me.id] === 'attacker' && !plan.humanOnBall) {
        const P = this.icpt.pos;
        const diff = aerialDifficulty(me, P.x, P.y - 0.2, P.z, this.icpt.time, ctx.carGScale);
        if (diff >= 0 && diff < 0.7) {
          _v.set(-P.x, 0, L * me.dir - P.z).normalize();
          this.maneuver = new Aerial(ctx, me, ctx.time + this.icpt.time, _v, false, true);
          return;
        }
      }
    }
    const B = ctx.path.nowPos;
    recoverOrient(ctx, me, out, B.x, B.z);
    out.throttle = 1;
    this.mode = 'recover';
  }

  // ===========================================================================================
  // Kickoff
  // ===========================================================================================

  private kickoff(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const plan = ctx.plans[me.team];
    const B = ctx.path.nowPos;
    // a human teammate racing us to the ball: don't drive into them — let them have it (legend keeps the distance-based
    // taker, see TEAM_TUNING; at the other levels the human is the taker anyway)
    if (plan.kickoffTaker === me.id && ctx.kickoffTime >= this.koDelay && this.humanContestsKickoff(ctx, me)) this.koYieldUntil = ctx.time + 0.5;
    if (plan.kickoffTaker === me.id && ctx.time >= this.koYieldUntil) {
      this.mode = 'kickoff';
      if (ctx.kickoffTime < this.koDelay) return; // reaction to GO
      const dx = B.x - me.pos.x;
      const dz = B.z - me.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // aim slightly off-center for variety (sends the ball diagonally)
      const px = -dz / (dist || 1);
      const pz = dx / (dist || 1);
      const tx = B.x + px * this.koOffset;
      const tz = B.z + pz * this.koOffset;
      this.target.set(tx, R, tz);
      this.driver.drive(me, tx, R, tz, 23, out, this.skill.kickoffBoost ? OPT_FAST : OPT_FAST_NOBOOST);
      if (!this.skill.kickoffBoost) out.boost = false;
      // flip into the ball
      if (this.skill.kickoffFlip && me.fwdSpeed > 10) {
        const gap = dist - CONTACT_REACH;
        const ttc = gap / Math.max(me.fwdSpeed, 1);
        if (ttc < FLIP_TTC + 0.02 + this.koFlipDist * 0.1 && Math.abs(this.driver.angle) < 0.2) {
          this.maneuver = new Flip(1, clamp1(this.driver.angle * 2), 0.05, 0.1, false, B.x, B.z);
        }
      }
      return;
    }
    if (plan.kickoffSecond === me.id) {
      // cheat up for the follow-up, grabbing small pads on the way — never in a human teammate's lane to the ball
      this.mode = 'koCheat';
      let tx = clamp(me.pos.x * 0.35, -12, 12);
      const tz = -20 * me.dir;
      tx = this.clearOfHumanLanes(ctx, me, tx, tz, B.x, B.z);
      this.goToFacing(ctx, me, tx, tz, B.x, B.z, 0, out, true);
      return;
    }
    // others: corner boost in our half, then drift back to goal (bots that hardly boost go straight back: an open net
    // behind a slow kickoff taker concedes straight from the kickoff)
    this.mode = 'koBoost';
    if (me.boost < 90 && this.skill.boostUse >= 0.5) {
      const pad = bestBigPad(ctx, me, -30);
      // (not across a human teammate's lane to the ball — the classic 3v3 T-bone of the player going for the kickoff)
      if (pad && !this.crossesHumanLane(ctx, me, pad.pos.x, pad.pos.z, B.x, B.z)) {
        this.target.set(pad.pos.x, 0, pad.pos.z);
        this.driver.drive(me, pad.pos.x, 0, pad.pos.z, 23, out, OPT_POS);
        return;
      }
    }
    this.goToFacing(ctx, me, 0, -46 * me.dir, B.x, B.z, 0, out, true);
  }

  /**
   * A human teammate is driving at the kickoff ball and would get there within TEAM_TUNING.koHumanContest (s) of us:
   * two cars arriving together just collide (the classic "my bot rammed me on the kickoff").
   */
  private humanContestsKickoff(ctx: BotContext, me: CarInfo): boolean {
    const B = ctx.path.nowPos;
    for (let i = 0; i < ctx.cars.length; i++) {
      const h = ctx.cars[i];
      if (h.isBot || h.team !== me.team || h.demolished) continue;
      const dx = B.x - h.pos.x;
      const dz = B.z - h.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      const vTo = (h.vel.x * dx + h.vel.z * dz) / d;
      if (vTo > 3 && h.eta < me.eta + TEAM_TUNING.koHumanContest) return true;
    }
    return false;
  }

  /** Does the straight route from the bot to (tx, tz) pass within TEAM_TUNING.koLaneClear of a human teammate's lane to (bx, bz)? */
  private crossesHumanLane(ctx: BotContext, me: CarInfo, tx: number, tz: number, bx: number, bz: number): boolean {
    for (let i = 0; i < ctx.cars.length; i++) {
      const h = ctx.cars[i];
      if (h.isBot || h.team !== me.team || h.demolished) continue;
      if (segSegDist(me.pos.x, me.pos.z, tx, tz, h.pos.x, h.pos.z, bx, bz) < TEAM_TUNING.koLaneClear) return true;
    }
    return false;
  }

  /**
   * Shift a kickoff waypoint (tx, tz) sideways so it stays ≥ TEAM_TUNING.koLaneClear (m) from every human teammate's
   * straight lane to the ball at (bx, bz), on the side the bot is already on. Returns the new x.
   */
  private clearOfHumanLanes(ctx: BotContext, me: CarInfo, tx: number, tz: number, bx: number, bz: number): number {
    for (let i = 0; i < ctx.cars.length; i++) {
      const h = ctx.cars[i];
      if (h.isBot || h.team !== me.team || h.demolished) continue;
      const lx = bx - h.pos.x;
      const lz = bz - h.pos.z;
      const ll = Math.sqrt(lx * lx + lz * lz);
      if (ll < 1) continue;
      // signed lateral offsets of the waypoint and of the bot from the lane
      const nx = -lz / ll;
      const nz = lx / ll;
      const along = ((tx - h.pos.x) * lx + (tz - h.pos.z) * lz) / ll;
      if (along < -TEAM_TUNING.koLaneClear || along > ll + TEAM_TUNING.koLaneClear) continue;
      const off = (tx - h.pos.x) * nx + (tz - h.pos.z) * nz;
      const side = (me.pos.x - h.pos.x) * nx + (me.pos.z - h.pos.z) * nz >= 0 ? 1 : -1;
      // clear on OUR side of the lane (a waypoint across it means driving through the human's path)
      if (off * side >= TEAM_TUNING.koLaneClear) continue;
      // move along the lane normal; only x is free here (tz is the cheat depth): scale by 1/|nx|
      const need = side * TEAM_TUNING.koLaneClear - off;
      tx = Math.abs(nx) > 0.2 ? tx + need / nx : tx + side * TEAM_TUNING.koLaneClear;
    }
    return clamp(tx, -W + 6, W - 6);
  }

  // ===========================================================================================
  // Open play
  // ===========================================================================================

  private play(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const plan = ctx.plans[me.team];
    const role = plan.roles[me.id];
    const path = ctx.path;
    const opp = me.team === 0 ? 1 : 0;
    const goalT = path.goalTeam === opp ? path.time(path.goalK) : Infinity;
    // opportunistic demolition (legend): only when we're not needed on the ball and our goal isn't in danger
    const free = role !== 'attacker' || plan.humanOnBall || !this.icpt.found || this.icpt.time > 2.5;
    if (free && goalT > 4 && this.tryDemo(ctx, me, out)) return;
    if (role === 'attacker' && !plan.humanOnBall) {
      this.attack(ctx, me, out, goalT);
      return;
    }
    // ball heading into our goal: the nearest non-attacker covers the goal line
    if (goalT < 3.5 && (role === 'defender' || plan.humanOnBall || ctx.teamSize === 1)) {
      this.cover(ctx, me, out, goalT);
      return;
    }
    if (role === 'defender') this.defend(ctx, me, out);
    else this.support(ctx, me, out);
  }

  /** First man: shoot, challenge, or shadow when beaten to the ball. */
  private attack(ctx: BotContext, me: CarInfo, out: ControlState, goalT: number): void {
    const icpt = this.icpt;
    const plan = ctx.plans[me.team];
    const threat = goalT < 3.5;
    if (!icpt.found || (threat && icpt.time > goalT - 0.05)) {
      // can't get to it before it goes in: block the goal line; otherwise wait under its landing area
      if (threat) this.cover(ctx, me, out, goalT);
      else this.await(ctx, me, out);
      return;
    }
    const P = icpt.pos;
    const T = icpt.time;
    const s = this.skill;
    // how far can we cut the ball away from our approach line: more time ⇒ swing around more; with a clear time
    // advantage over the opponents (no pressure) and a slow ball, take the long way round to line up a real shot
    let cut = Math.min(s.maxCut, 0.35 + 0.35 * T);
    // patience: after failing to line up a curved approach for a while, just take the direct (safe) touch
    if (this.impatient > ctx.time) cut = Math.min(cut, STRIKE_TUNING.straightCut + 0.1);
    const adv = plan.oppBestEta - T;
    const ballSpeed = icpt.vel.length();
    // never take the long way round while the ball is heading at our goal (it keeps rolling while we loop)
    const towardUs = icpt.vel.z * me.dir < -4 && P.z * me.dir < 10;
    // (only with a clear time advantage and never in our own half: a loop next to the ball invites a steal)
    if (adv > 1.5 && ballSpeed < 12 && !threat && !towardUs && P.z * me.dir > -10) {
      cut = Math.min(2.6, cut + (adv - 1.5) * 0.9 * (1 - ballSpeed / 12) * s.discipline);
    }
    chooseShot(ctx, me, P.x, P.z, me.pos.x, me.pos.z, cut, this.aimErr, this.aimSpread, this.shot);
    if (this.shot.kind === 'none' && !(threat && T < goalT)) {
      // wrong side of the ball: get back goal-side
      this.shadow(ctx, me, out, true);
      return;
    }
    // beaten to the ball by an opponent: shadow instead of a hopeless chase (unless it's coming into our net, or a
    // teammate is covering behind us — then the first man keeps the pressure on)
    const ch = this.chargePlay(ctx, me);
    // charged core: press harder with ours (a SUPERNOVA goal is worth 3), respect theirs
    // (only a ground race is a real contest: waiting under a bouncing ball for a later jump shot while the
    // opponent arrives first just hands them the ball — back off much sooner then)
    const kindK = icpt.kind === 'ground' || icpt.kind === 'wall' ? 1 : 0.3;
    const margin = s.challengeMargin * this.aggression * kindK * (ch >= 2 ? 1.6 : ch <= -2 ? 0.6 : 1);
    const covered = this.teammateCovering(ctx, me, P.z * me.dir);
    if (!threat && !covered && plan.oppBestEta + margin < T && T > 0.6) {
      const goalSide = me.zr < P.z * me.dir - 1;
      const close = len2(P.x - me.pos.x, P.z - me.pos.z) < 12;
      if (!(goalSide && close) || this.rng.next() < 0.02) {
        this.shadow(ctx, me, out, false);
        return;
      }
    }
    this.strike(ctx, me, out, icpt, threat);
  }

  /** Drive into the planned contact with the chosen shot direction (ground / jump / aerial / wall). */
  private strike(ctx: BotContext, me: CarInfo, out: ControlState, icpt: Intercept, threat: boolean): void {
    const s = this.skill;
    const P = icpt.pos;
    const T = icpt.time;
    const D = this.shot.dir;
    this.target.copy(P);
    // ---- aerial
    if (icpt.kind === 'aerial') {
      this.mode = 'aerialSetup';
      if (this.tryAerial(ctx, me, icpt)) return;
      // not lined up yet: drive under it
      this.driver.drive(me, P.x - D.x * 2, 0, P.z - D.z * 2, 23, out, OPT_FAST);
      return;
    }
    // ---- wall ball: drive straight into it (in our third only when it won't be knocked toward our goal)
    if (icpt.kind === 'wall') {
      const wx = P.x - me.pos.x;
      const wz = P.z - me.pos.z;
      const wl = Math.sqrt(wx * wx + wz * wz) || 1;
      if (P.z * me.dir < -L * 0.4 && (wz / wl) * me.dir < -0.3) {
        this.shadow(ctx, me, out, true);
        return;
      }
      this.mode = 'wall';
      this.driver.drive(me, P.x, P.y, P.z, 23, out, OPT_FAST);
      return;
    }
    // ---- ground / jump shots.
    // The ball leaves along the car→ball line at contact, so a car driving straight along u "cuts" the ball by
    // passing it at a lateral offset δ (measured: θ ≈ 17δ + 10δ² degrees, up to ≈ 35°). Plan: drive straight through
    // an aim point beside the ball when the cut is feasible; otherwise curve onto a relaxed approach line u′ first.
    const aim = this.planApproach(me, P, D, threat);
    let tx = aim.tx;
    let tz = aim.tz;
    const lined = aim.lined;
    const cx = aim.ax;
    const cz = aim.az;
    const dist = len2(cx - me.pos.x, cz - me.pos.z);
    const dx = cx - me.pos.x;
    const dz = cz - me.pos.z;
    // ---- own-goal guard: where will the ball REALLY go from this approach (approach line + achievable cut)?
    // Never push it into our own net — reposition goal-side instead (or race to the line if it's going in anyway).
    if (lined && P.z * me.dir < 12 && dist > 1e-3) {
      const ua = Math.atan2(dx, dz) + clamp(aim.cut, -STRIKE_TUNING.straightCut - 0.1, STRIKE_TUNING.straightCut + 0.1);
      if (headsToOwnGoal(me, P.x, P.z, Math.sin(ua), Math.cos(ua), 2.5)) {
        this.unsafe = true;
        if (threat) this.cover(ctx, me, out, ctx.path.goalK >= 0 ? ctx.path.time(ctx.path.goalK) : 3, true);
        else this.shadow(ctx, me, out, true);
        return;
      }
    }
    this.unsafe = false;
    // patience bookkeeping: a curved approach that isn't converging for 2.5 s ⇒ go direct for a while
    if (!lined && icpt.kind === 'ground') {
      this.curving += ctx.dt;
      if (this.curving > 2.5) {
        this.curving = 0;
        this.impatient = ctx.time + 2;
      }
    } else this.curving = Math.max(0, this.curving - ctx.dt * 2);
    // not lined up yet: never clip the ball while swinging around it
    if (!lined && P.y < 3.5 && this.avoidBall(me, P.x, P.z, tx, tz, 2.6)) {
      tx = this.avoid.x;
      tz = this.avoid.z;
    }
    // speed: be there on time (earliest intercept ⇒ usually flat out). Jump shots need exact timing: at contact the
    // car center must be ≈ 1.4 m short of the ball along the approach (not under it — that heads it with the roof).
    const pathLen = len2(tx - me.pos.x, tz - me.pos.z) + len2(cx - tx, cz - tz) * (dist > 2.5 ? 1 : 0);
    const vReq = pathLen / Math.max(T, 0.05);
    const air = icpt.kind === 'jump' || icpt.kind === 'double';
    const ul = dist > 1e-3 ? dist : 1;
    const jx = cx - (dx / ul) * JUMP_CONTACT_BACK;
    const jz = cz - (dz / ul) * JUMP_CONTACT_BACK;
    const distJ = air ? len2(jx - me.pos.x, jz - me.pos.z) * (dx * (jx - me.pos.x) + dz * (jz - me.pos.z) >= 0 ? 1 : -1) : dist;
    let speed: number;
    const bouncing = Math.abs(icpt.vel.y) > 1.5;
    if (!air && !bouncing) speed = threat ? 23 : clamp(vReq * 1.15 + 2, 6, 23);
    else if (!air) speed = clamp(vReq * 1.02, 4, 23); // meet a bouncing ball on time, not early (roof hits)
    else speed = clamp(distJ / Math.max(T, 0.05), 0, 23);
    this.mode = icpt.kind === 'ground' ? SHOOT_MODE[this.shot.kind] : JUMP_SETUP;
    // defending: reversing into the ball (a rear-end block) beats a slow turn-around
    // boost conservation: with a comfortable lead on the opponents there's no need to burn boost getting there
    const plan = ctx.plans[me.team];
    const relaxed = !threat && plan.oppBestEta - T > 0.8 && this.skill.boostUse >= 0.5;
    this.driver.drive(me, tx, 0, tz, speed, out, threat ? OPT_DEF : relaxed ? OPT_FAST_NOBOOST : OPT_FAST);

    // ---- flip into ground balls (power): straight on the aim line, at the right time-to-contact
    // (while our team carries the charge, non-shot touches stay controlled: no flips)
    const controlled = this.shot.kind !== 'goal' && this.chargePlay(ctx, me) >= 1 && !threat;
    if (icpt.kind === 'ground' && s.dodgeShots && !controlled && lined && me.fwdSpeed > 7 && P.y < 1.6 && dist < 9) {
      const fa = (dx * me.fwd.x + dz * me.fwd.z) / (dist || 1);
      const ttc = this.timeToContact(ctx, me, T);
      if (fa > 0.97 && Math.abs(this.appr.cut) < FLIP_MAX_CUT && ttc < FLIP_TTC + 0.02 && ttc > 0.1) {
        // pure front flip: keeps the approach line (a diagonal flip would re-centre the ball and undo the cut)
        this.maneuver = new Flip(1, 0, 0.05, 0.1, false, P.x + D.x * 20, P.z + D.z * 20);
        return;
      }
    }
    // ---- jump shots
    if (icpt.kind === 'jump' || icpt.kind === 'double') {
      const dbl = icpt.kind === 'double';
      // same timing model as the planner (findIntercept): it never offers T below riseTime, so this always fires
      const tRise = jumpTiming(ctx.carGScale).riseTime(jumpShotRise(P.y), dbl);
      if (T <= tRise + 0.02 + this.whiffTime) {
        // horizontal: will we be at the contact spot? (the car keeps its ground velocity in the air)
        const hv = Math.max(me.fwdSpeed, 0);
        const lead = distJ - hv * T;
        const f = dist > 1e-3 ? (dx * me.fwd.x + dz * me.fwd.z) / dist : 1;
        // lateral offset of the ball from our line of travel at contact (must hit it with the nose)
        const bxr = P.x - me.pos.x;
        const bzr = P.z - me.pos.z;
        const lat = Math.abs(bxr * me.right.x + bzr * me.right.z);
        // a little long is fine (air boost can't fix short, but the nose still meets it); short is a whiff
        if (lead < 0.8 && lead > -1.2 && lat < 0.9 && (f > 0.95 || dist < 2)) {
          this.maneuver = new JumpShot(ctx, ctx.time + T, dbl, s.dodgeShots && !dbl && this.rng.chance(0.7));
          this.mode = 'jumpShot';
        }
      }
    }
  }

  /**
   * Approach plan for sending a ball at P along D (horizontal unit). Returns the steering target (tx, tz), the aim
   * point (ax, az) the car's line passes through (beside the ball), and whether the car is already on that line.
   */
  private planApproach(me: CarInfo, P: Vector3, D: Vector3, direct: boolean): { tx: number; tz: number; ax: number; az: number; lined: boolean; cut: number } {
    const o = this.appr;
    const angD = Math.atan2(D.x, D.z);
    // current straight approach
    let ux = P.x - me.pos.x;
    let uz = P.z - me.pos.z;
    let ul = Math.sqrt(ux * ux + uz * uz) || 1;
    ux /= ul;
    uz /= ul;
    let phi = wrapPi(angD - Math.atan2(ux, uz)); // cut needed (+ = D is counter-clockwise from u)
    const maxCut = STRIKE_TUNING.straightCut;
    let ax = P.x;
    let az = P.z;
    // refine u through the aim point twice (the offset changes the approach direction a little)
    for (let it = 0; it < 2; it++) {
      const c = Math.min(Math.abs(phi), maxCut);
      const delta = cutOffset(c);
      // the ball must sit on D's side of the car's centerline ⇒ the line passes on the opposite side
      const sx = uz * (phi >= 0 ? 1 : -1); // perpendicular of u toward D's side (rotate u by +90° about y: (uz, -ux))
      const sz = -ux * (phi >= 0 ? 1 : -1);
      ax = P.x - sx * delta;
      az = P.z - sz * delta;
      ux = ax - me.pos.x;
      uz = az - me.pos.z;
      ul = Math.sqrt(ux * ux + uz * uz) || 1;
      ux /= ul;
      uz /= ul;
      phi = wrapPi(angD - Math.atan2(ux, uz));
    }
    // whiff: a misjudged line
    if (this.whiffLat !== 0) {
      ax += -uz * this.whiffLat * 0.6;
      az += ux * this.whiffLat * 0.6;
    }
    o.cut = phi;
    // hysteresis: once driving the straight cut, keep it a little past the limit. Committing also needs the car to be
    // (nearly) heading down the aim line already, or enough room left to straighten out.
    const lim = maxCut + (this.straightCut ? 0.15 : 0.02);
    const fl = Math.sqrt(me.fwd.x * me.fwd.x + me.fwd.z * me.fwd.z) || 1;
    const hu = (me.fwd.x * ux + me.fwd.z * uz) / fl;
    const room = len2(ax - me.pos.x, az - me.pos.z) / turnRadius(clamp(me.fwdSpeed, 6, 23));
    const headingOk = hu > Math.cos(STRIKE_TUNING.headingTol) || room > STRIKE_TUNING.roomRadii || this.straightCut;
    if ((Math.abs(phi) <= lim && headingOk) || direct) {
      // straight through the aim point (and on into the ball)
      this.straightCut = true;
      o.ax = ax;
      o.az = az;
      o.tx = ax + ux * 4;
      o.tz = az + uz * 4;
      o.lined = true;
      return o;
    }
    this.straightCut = false;
    // too sharp from here: curve in toward the ideal line (contact point C behind the ball along D). The further
    // off we are, the further behind C we aim; the calibrated straight cut takes over once the angle is feasible.
    const reach = CONTACT_REACH;
    const cx = P.x - D.x * reach;
    const cz = P.z - D.z * reach;
    const dx = cx - me.pos.x;
    const dz = cz - me.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const cosA = (dx * D.x + dz * D.z) / dist;
    const behind = (me.pos.x - P.x) * D.x + (me.pos.z - P.z) * D.z; // < 0: car on the good side of the ball
    let tx: number;
    let tz: number;
    if (behind > -0.5 && dist < 14) {
      // level with / past the ball: swing around its side
      const side = (me.pos.x - P.x) * -D.z + (me.pos.z - P.z) * D.x >= 0 ? 1 : -1;
      tx = P.x - D.z * side * 3.4 - D.x * 3.5;
      tz = P.z + D.x * side * 3.4 - D.z * 3.5;
    } else {
      const k = clamp(dist * 0.45, 2, 11) * clamp((1 - cosA) * 1.6, 0.3, 1);
      tx = cx - D.x * k;
      tz = cz - D.z * k;
    }
    // keep waypoints inside the field (walls / corners)
    o.tx = clamp(tx, -W + 4, W - 4);
    o.tz = clamp(tz, -L + 4, L - 4);
    o.ax = cx;
    o.az = cz;
    o.lined = false;
    return o;
  }

  /**
   * If the straight drive from the car to (tx, tz) passes within `clear` of the ball at (px, pz), write a detour
   * waypoint beside the ball into this.avoid and return true.
   */
  private avoidBall(me: CarInfo, px: number, pz: number, tx: number, tz: number, clear: number): boolean {
    const sx = tx - me.pos.x;
    const sz = tz - me.pos.z;
    const len2 = sx * sx + sz * sz;
    if (len2 < 1) return false;
    let t = ((px - me.pos.x) * sx + (pz - me.pos.z) * sz) / len2;
    if (t <= 0.02 || t >= 0.98) return false;
    const qx = me.pos.x + sx * t;
    const qz = me.pos.z + sz * t;
    let nx = qx - px;
    let nz = qz - pz;
    let nl = Math.sqrt(nx * nx + nz * nz);
    if (nl >= clear) return false;
    if (nl < 1e-3) {
      // dead ahead: go around on the side the car is already turning toward
      const l = Math.sqrt(len2);
      nx = -sz / l;
      nz = sx / l;
      if (nx * me.right.x + nz * me.right.z < 0) {
        nx = -nx;
        nz = -nz;
      }
      nl = 1;
    }
    t = (clear * 1.3) / nl;
    this.avoid.set(px + nx * t, 0, pz + nz * t);
    return true;
  }

  /**
   * A teammate is about to play the ball: a bot within PULSE.radius of it that is closer (or quicker) than us, or a
   * human near it (PULSE.radius + 4 m) or getting there before us + 0.5 s. An offensive pulse would yank the ball
   * away from their touch.
   */
  private mateOnBall(ctx: BotContext, me: CarInfo, dMe: number): boolean {
    const B = ctx.path.nowPos;
    for (let i = 0; i < ctx.cars.length; i++) {
      const c = ctx.cars[i];
      if (c.id === me.id || c.team !== me.team || c.demolished) continue;
      const dx = B.x - c.pos.x;
      const dy = B.y - c.pos.y;
      const dz = B.z - c.pos.z;
      const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!c.isBot) {
        if (dc < PULSE.radius + 4 || c.eta < me.eta + 0.5) return true;
      } else if (dc < PULSE.radius && (dc < dMe || c.eta < me.eta)) return true;
    }
    return false;
  }

  /**
   * CORE CHARGE as the bot PLAYS it: disciplined bots (≥ 0.5) manage the charge (controlled touches while charged,
   * pressing / sitting deeper); rookies ignore it (no deliberate charge farming against newcomers).
   */
  private chargePlay(ctx: BotContext, me: CarInfo): number {
    return this.skill.discipline < 0.5 ? 0 : this.chargeFor(ctx, me);
  }

  /** CORE CHARGE held by our team (+) or the enemy (−): −3 … 3 (0 = neutral or mutator off). */
  private chargeFor(ctx: BotContext, me: CarInfo): number {
    if (!ctx.mutators.charge || ctx.ballChargeTeam === -1) return 0;
    return ctx.ballChargeTeam === me.team ? ctx.ballCharge : -ctx.ballCharge;
  }

  /** Demolition run: an opponent roughly ahead that we can hit supersonic with the nose. */
  private tryDemo(ctx: BotContext, me: CarInfo, out: ControlState): boolean {
    if (!this.skill.demos || !ctx.mutators.demolitions || !me.onGround || me.up.y < 0.8) return false;
    if (me.speed < 16 || (me.boost < 12 && !me.supersonic)) return false;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < ctx.cars.length; i++) {
      const o = ctx.cars[i];
      if (o.team === me.team || o.demolished || !o.onGround) continue;
      const dx = o.pos.x - me.pos.x;
      const dz = o.pos.z - me.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 26 || d < 3) continue;
      const f = (dx * me.fwd.x + dz * me.fwd.z) / d;
      // the victim shouldn't be charging straight at us faster than we can line up — and must be roughly ahead
      if (f < (this.demoTarget === o.id ? 0.8 : 0.93)) continue;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      this.demoTarget = -1;
      return false;
    }
    const o = ctx.cars[best];
    // lead the target
    const t = bestD / Math.max(me.speed, 18);
    const tx = o.pos.x + o.vel.x * t;
    const tz = o.pos.z + o.vel.z * t;
    this.demoTarget = o.id;
    this.mode = 'demo';
    this.target.set(tx, 0, tz);
    this.driver.drive(me, tx, 0, tz, 23, out, OPT_FAST);
    if (me.boost > 0 && Math.abs(this.driver.angle) < 0.3) out.boost = true;
    return true;
  }

  /** The support nearest the enemy goal mouth makes the far-post run, if a teammate other than the attacker stays back. */
  private isFarPostRunner(ctx: BotContext, me: CarInfo): boolean {
    const plan = ctx.plans[me.team];
    const ez = L * me.dir;
    let best = -1;
    let bestD = Infinity;
    let backers = 0;
    for (let k = 0; k < plan.members.length; k++) {
      const c = ctx.cars[plan.members[k]];
      if (c.demolished || c.id === plan.attackerId) continue;
      if (plan.roles[c.id] === 'defender') backers++;
      if (plan.roles[c.id] !== 'support') continue;
      const d = len2(c.pos.x, c.pos.z - ez);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    // in 2v2 there is no defender behind the support: only run when the ball is deep and we're not exposed
    return best === me.id && (backers > 0 || ctx.teamSize === 2);
  }

  /** Is a teammate (bot or human) goal-side of the ball at team-relative depth `bzr` and able to defend? */
  private teammateCovering(ctx: BotContext, me: CarInfo, bzr: number): boolean {
    for (let i = 0; i < ctx.cars.length; i++) {
      const c = ctx.cars[i];
      if (c.id === me.id || c.team !== me.team || c.demolished) continue;
      if (c.zr < bzr - 6) return true;
    }
    return false;
  }

  /** Time until the car's nose meets the ball: geometric (relative motion) when closing fast, else the plan's T. */
  private timeToContact(ctx: BotContext, me: CarInfo, T: number): number {
    const B = ctx.path.nowPos;
    const V = ctx.path.nowVel;
    const rx = B.x - me.pos.x;
    const ry = B.y - me.pos.y;
    const rz = B.z - me.pos.z;
    const d = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    const closing = -((V.x - me.vel.x) * rx + (V.y - me.vel.y) * ry + (V.z - me.vel.z) * rz) / d;
    if (closing < 3) return T;
    return Math.max(0, d - CONTACT_REACH) / closing;
  }

  /** Start an aerial if it's feasible from here right now. */
  private tryAerial(ctx: BotContext, me: CarInfo, icpt: Intercept): boolean {
    const P = icpt.pos;
    const T = icpt.time;
    if (!me.onGround || me.boost < this.skill.aerialMinBoost) return false;
    const dx = P.x - me.pos.x;
    const dz = P.z - me.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const f = d > 1e-3 ? (dx * me.fwd.x + dz * me.fwd.z) / d : 1;
    if (f < 0.75 && d > 4) return false; // turn first
    const diff = aerialDifficulty(me, P.x, P.y - 0.2, P.z, T, ctx.carGScale);
    if (diff < 0) return false;
    // leave when the required effort is decent (not too early: long floaty flights go wrong; not at the limit)
    if (diff < 0.3 && T > 1.1) return false;
    const D = this.shot.dir;
    _v.set(D.x, 0.15, D.z).normalize();
    this.maneuver = new Aerial(ctx, me, ctx.time + T, _v, P.y > 7.5 && this.skill.doubleJumps, this.skill.aerialMaxHeight >= 10);
    this.mode = 'aerial';
    return true;
  }

  /** Ball unreachable for now (high / far): wait goal-side under its landing area. */
  private await(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const path = ctx.path;
    const n = path.scanLimit();
    // lowest predicted point (landing area)
    let k = n - 1;
    let lowest = Infinity;
    for (let i = 0; i < n; i += 4) {
      const y = path.pos(i).y;
      if (y < lowest) {
        lowest = y;
        k = i;
      }
    }
    const Pk = path.pos(k);
    const ownZ = -L * me.dir;
    _v.set(0 - Pk.x, 0, ownZ - Pk.z);
    const l = _v.length() || 1;
    const tx = Pk.x + (_v.x / l) * 6;
    const tz = Pk.z + (_v.z / l) * 6;
    this.mode = 'await';
    this.goToFacing(ctx, me, tx, tz, Pk.x, Pk.z, 0, out, true);
  }

  /** Stay between the ball and our goal, facing the ball (retreat at the ball's pace). */
  private shadow(ctx: BotContext, me: CarInfo, out: ControlState, rotate: boolean): void {
    const path = ctx.path;
    const B = path.pos(path.indexAt(0.4));
    const ownZ = -L * me.dir;
    // stand on the line ball → our goal (aimed a little toward the ball's side of the net), roughly halfway:
    // far enough to react to the shot, and in the net once the ball is close
    const gx = clamp(B.x * 0.3, -4, 4);
    const vx = gx - B.x;
    const vz = ownZ - B.z;
    const dist = Math.sqrt(vx * vx + vz * vz) || 1;
    const d = clamp(dist * 0.5, 9, 30);
    let tx: number;
    let tz: number;
    if (dist - d < 4) {
      tx = gx;
      tz = ownZ + 2 * me.dir;
    } else {
      tx = B.x + (vx / dist) * d;
      tz = B.z + (vz / dist) * d;
    }
    if (tz * me.dir < -L + 2) tz = (-L + 2) * me.dir;
    tx = clamp(tx, -W + 6, W - 6);
    const behind = me.zr > B.z * me.dir - 2; // level with / past the ball: rotate back
    if (rotate || behind) {
      const side = me.pos.x >= B.x ? 1 : -1;
      if (behind && Math.abs(me.pos.x - B.x) < 6) {
        // right next to the ball: go around it (don't drive through it)
        tx = clamp(B.x + side * 7, -W + 5, W - 5);
        tz = (B.z * me.dir - 6) * me.dir;
      } else if (behind && B.z * me.dir < 0) {
        // ball in our half and we're upfield of it: rotate back POST — the far post from the ball, keeping vision
        // of the play and staying out of the shooting lane
        const bx = B.x !== 0 ? B.x : me.pos.x;
        tx = -Math.sign(bx || 1) * (ARENA.goalHalfWidth - 2.5);
        tz = (-L + 5) * me.dir;
      }
      this.mode = 'rotate';
    } else this.mode = 'shadow';
    const vToGoal = -(path.nowVel.z * me.dir);
    const arriveV = clamp(vToGoal, 0, 20);
    this.goToFacing(ctx, me, tx, tz, B.x, B.z, arriveV, out, !behind, behind || vToGoal > 6);
  }

  /** Ball heading in: get to the goal line in front of its entry point, facing out. */
  private cover(ctx: BotContext, me: CarInfo, out: ControlState, goalT: number, noStrike = false): void {
    const path = ctx.path;
    const E = path.pos(path.goalK >= 0 ? path.goalK : path.count - 1);
    const tx = clamp(E.x, -ARENA.goalHalfWidth + 2, ARENA.goalHalfWidth - 2);
    const tz = (-L + 2.5) * me.dir;
    this.mode = 'cover';
    const B = path.nowPos;
    // if we can intercept before it goes in, do it (clear toward the sides)
    if (!noStrike && this.icpt.found && this.icpt.time < goalT - 0.1) {
      const P = this.icpt.pos;
      chooseShot(ctx, me, P.x, P.z, me.pos.x, me.pos.z, Math.min(this.skill.maxCut, 1.1), 0, 0, this.shot);
      if (this.shot.kind !== 'none') {
        this.strike(ctx, me, out, this.icpt, true);
        this.mode = 'save';
        return;
      }
    }
    // race to the line (boost allowed) — around the ball, never shunting it in from behind — then face the ball
    const d = len2(tx - me.pos.x, tz - me.pos.z);
    if (d > 4) {
      let rx = tx;
      let rz = tz;
      if (B.y < 3 && this.avoidBall(me, B.x, B.z, tx, tz, 2.8)) {
        rx = this.avoid.x;
        rz = this.avoid.z;
      }
      this.target.set(rx, 0, rz);
      this.driver.drive(me, rx, 0, rz, 23, out, OPT_DEF);
    } else this.goToFacing(ctx, me, tx, tz, B.x, B.z, 0, out, false);
  }

  /** Second man: behind the play, ready for rebounds / passes; tops up boost. */
  private support(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const path = ctx.path;
    const B = path.pos(path.indexAt(0.8));
    const bzr = B.z * me.dir;
    if (this.boostRun(ctx, me, out, 45, bzr - 5)) return;
    let tx = clamp(B.x * 0.45, -20, 20);
    // stay on the other side of the field from the attacker (spacing)
    const att = ctx.plans[me.team].attackerId;
    if (att >= 0 && att !== me.id) {
      const a = ctx.cars[att];
      if (Math.abs(a.pos.x - tx) < 8) tx = clamp(tx - Math.sign(a.pos.x - tx || 1) * 8, -24, 24);
    }
    // second man: close enough to pounce on rebounds, deeper when the ball is in our half
    const ch = this.chargePlay(ctx, me);
    // possession-aware: press close behind our own attack in their half, sit deeper when they have it
    const ours = ctx.lastTouchTeam === me.team && ctx.path.nowVel.z * me.dir > -6;
    // our attack in their corner: make a run to the far post for the centering pass (only the support closest to
    // the goal mouth, and only while someone else stays back)
    if (ours && bzr > L * 0.45 && Math.abs(B.x) > 12 && this.isFarPostRunner(ctx, me)) {
      const fx = -Math.sign(B.x) * 5;
      const fz = (L - 13) * me.dir;
      this.mode = 'farPost';
      this.goToFacing(ctx, me, fx, fz, B.x, B.z, 4, out, false, true);
      return;
    }
    const back = (ours && bzr > 0 ? 9 : bzr > 0 ? 14 : 18) + (ch <= -2 ? 6 : ch >= 2 ? -3 : 0);
    const zr = clamp(bzr - back, -40, 30);
    this.mode = 'support';
    // keep pace with the play (the spot moves with the ball): arrive at the ball's speed, hurry when far behind
    const bv = ctx.path.nowVel;
    const pace = clamp(Math.sqrt(bv.x * bv.x + bv.z * bv.z) * 0.8, 0, 18);
    const far = len2(tx - me.pos.x, zr * me.dir - me.pos.z) > 18;
    this.goToFacing(ctx, me, tx, zr * me.dir, B.x, B.z, pace, out, true, far);
  }

  /** Last man: in front of our goal, a little up when the ball is far away. */
  private defend(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const path = ctx.path;
    const B = path.pos(path.indexAt(0.5));
    const bzr = B.z * me.dir;
    if (bzr > 5 && this.boostRun(ctx, me, out, 30, -25)) return;
    // last man: in the net while the ball is in our half, stepping up to midfield when it's deep in theirs;
    // much deeper while the enemy carries a charged (II / SUPERNOVA) core
    const ch = this.chargePlay(ctx, me);
    const ours = ctx.lastTouchTeam === me.team && ctx.path.nowVel.z * me.dir > -4;
    const zr = ch <= -2 ? clamp(bzr - 44, -47, -28) : clamp(bzr - (ours ? 34 : 38), -46, ours ? -8 : -14);
    const tx = clamp(B.x * 0.2, -5, 5);
    this.mode = 'defend';
    this.goToFacing(ctx, me, tx, zr * me.dir, B.x, B.z, 0, out, true);
  }

  /** Go collect a big pad when low (returns false when not worth it). */
  private boostRun(ctx: BotContext, me: CarInfo, out: ControlState, below: number, maxZr: number): boolean {
    if (me.boost >= below || this.skill.boostUse < 0.5) return false;
    const pad = bestBigPad(ctx, me, maxZr);
    if (!pad) return false;
    const d = len2(pad.pos.x - me.pos.x, pad.pos.z - me.pos.z);
    if (d > 45) return false;
    // not across a charging human teammate's path (positioning steps aside instead)
    if (this.clearHumanPath(ctx, me, pad.pos.x, pad.pos.z)) return false;
    this.mode = 'boost';
    this.target.set(pad.pos.x, 0, pad.pos.z);
    this.driver.drive(me, pad.pos.x, 0, pad.pos.z, 23, out, OPT_POS_NOBOOST);
    return true;
  }

  // ===========================================================================================
  // Positioning primitives
  // ===========================================================================================

  /**
   * Drive to (tx, tz) and end up facing (lx, lz), arriving at `arriveV`. Picks up small pads on the way when
   * `pads` and the skill allows.
   */
  private goToFacing(
    ctx: BotContext,
    me: CarInfo,
    tx: number,
    tz: number,
    lx: number,
    lz: number,
    arriveV: number,
    out: ControlState,
    pads: boolean,
    /** Race there (boost allowed from shorter distances). */
    hurry = false,
  ): void {
    tx = clamp(tx, -W + 3, W - 3);
    tz = clamp(tz, -L + 1.5, L - 1.5);
    // never park in (or drive along) a charging human teammate's path to the ball
    if (this.clearHumanPath(ctx, me, tx, tz)) {
      tx = clamp(this.avoid.x, -W + 3, W - 3);
      tz = clamp(this.avoid.z, -L + 1.5, L - 1.5);
      hurry = true;
    }
    this.target.set(tx, 0, tz);
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let hx = lx - tx;
    let hz = lz - tz;
    const hl = Math.sqrt(hx * hx + hz * hz);
    if (hl > 1e-3) {
      hx /= hl;
      hz /= hl;
    } else {
      hx = 0;
      hz = me.dir;
    }
    if (dist < 2.2 && arriveV < 3) {
      this.face(me, hx, hz, out);
      return;
    }
    // big pad close to the route when low (pro+), then small pads on the way
    if (pads && me.boost < 45 && this.skill.boostUse >= 0.5 && dist > 6) {
      const bzr = ctx.path.nowPos.z * me.dir;
      const pad = bigPadDetour(ctx, me, tx, tz, 9 + (45 - me.boost) * 0.15, Math.max(bzr, -20));
      if (pad) {
        this.target.set(pad.pos.x, 0, pad.pos.z);
        this.driver.drive(me, pad.pos.x, 0, pad.pos.z, 23, out, OPT_POS_NOBOOST);
        return;
      }
    }
    if (pads && this.skill.smallPads && me.boost < 85 && dist > 8) {
      const pad = smallPadOnRoute(ctx, me, tx, tz);
      if (pad) {
        this.driver.drive(me, pad.pos.x, 0, pad.pos.z, 23, out, OPT_POS_NOBOOST);
        return;
      }
    }
    // curve in so we arrive facing the ball
    const ux = dx / (dist || 1);
    const uz = dz / (dist || 1);
    const cosA = ux * hx + uz * hz;
    let ax = tx;
    let az = tz;
    if (dist > 4) {
      const k = clamp(dist * 0.35, 0, 8) * clamp((1 - cosA) * 0.7, 0, 1);
      ax = tx - hx * k;
      az = tz - hz * k;
    }
    const v = Math.min(23, Math.sqrt(arriveV * arriveV + 2 * 10 * Math.max(0, dist - 1.5)));
    const boostOk = hurry ? dist > 10 && me.boost > 5 : dist > 25 && me.boost > 40;
    this.driver.drive(me, ax, 0, az, v, out, boostOk ? OPT_POS : OPT_POS_NOBOOST);
  }

  /**
   * A human teammate charging the ball sweeps a lane ahead of it (TEAM_TUNING.lane*). If this bot stands in it, or its
   * positioning target (tx, tz) lies in it, write a spot beside the lane into this.avoid and return true — bots step
   * out of the player's way instead of being rammed (or ramming) on the way to the ball.
   */
  private clearHumanPath(ctx: BotContext, me: CarInfo, tx: number, tz: number): boolean {
    const T = TEAM_TUNING;
    if (!T.laneAvoid) return false;
    const B = ctx.path.nowPos;
    for (let i = 0; i < ctx.cars.length; i++) {
      const h = ctx.cars[i];
      if (h.isBot || h.team !== me.team || h.demolished || !h.onGround) continue;
      const vx = h.vel.x;
      const vz = h.vel.z;
      const sp = Math.sqrt(vx * vx + vz * vz);
      if (sp < T.laneMinSpeed) continue;
      const bx = B.x - h.pos.x;
      const bz = B.z - h.pos.z;
      const bd = Math.sqrt(bx * bx + bz * bz) || 1;
      if ((vx * bx + vz * bz) / bd < T.laneMinSpeed * 0.7) continue; // not heading for the ball
      const ux = vx / sp;
      const uz = vz / sp;
      const len = Math.min(bd + 3, sp * T.laneTime + 3);
      const hw = T.laneWidth;
      // the bot itself in the lane (ahead of the human): step out sideways, on the side it's already on
      const px = me.pos.x - h.pos.x;
      const pz = me.pos.z - h.pos.z;
      const along = px * ux + pz * uz;
      const lat = px * uz - pz * ux; // signed lateral offset from the human's heading line
      if (along > -1 && along < len && Math.abs(lat) < hw) {
        const side = lat >= 0 ? 1 : -1;
        const a = Math.max(along, 2);
        this.avoid.set(h.pos.x + ux * a + uz * side * (hw + 2.5), 0, h.pos.z + uz * a - ux * side * (hw + 2.5));
        return true;
      }
      // the target in the lane: move it beside the lane (the bot's side)
      const qx = tx - h.pos.x;
      const qz = tz - h.pos.z;
      const qa = qx * ux + qz * uz;
      const ql = qx * uz - qz * ux;
      if (qa > -2 && qa < len && Math.abs(ql) < hw) {
        const side = lat >= 0 ? 1 : -1;
        this.avoid.set(tx + uz * (side * (hw + 1.5) - ql), 0, tz - ux * (side * (hw + 1.5) - ql));
        return true;
      }
    }
    return false;
  }

  /** Turn (almost) in place to face (hx, hz): forward/reverse shuffle with lock. */
  private face(me: CarInfo, hx: number, hz: number, out: ControlState): void {
    const f = hx * me.fwd.x + hz * me.fwd.z;
    const r = hx * me.right.x + hz * me.right.z;
    const ang = Math.atan2(r, f);
    const aa = Math.abs(ang);
    this.driver.angle = ang;
    if (aa < 0.3) {
      // hold: roll to a stop, small corrections
      out.throttle = me.fwdSpeed > 1 ? 0 : me.fwdSpeed < -1 ? 1 : 0;
      out.steer = clamp1(ang * 2);
      out.boost = false;
      return;
    }
    this.faceTimer -= DT;
    if (this.faceTimer <= 0 || Math.abs(me.fwdSpeed) > 5) {
      this.faceFwd = !this.faceFwd;
      this.faceTimer = 0.55;
      if (Math.abs(me.fwdSpeed) > 5) this.faceFwd = me.fwdSpeed < 0;
    }
    if (this.faceFwd) {
      out.throttle = 0.7;
      out.steer = ang > 0 ? 1 : -1;
    } else {
      out.throttle = -0.7;
      out.steer = ang > 0 ? -1 : 1;
    }
    out.boost = false;
  }

  // ===========================================================================================
  // Extras
  // ===========================================================================================

  private stuckCheck(ctx: BotContext, me: CarInfo, out: ControlState): void {
    const pushing = Math.abs(out.throttle) > 0.5;
    // watchdog: parked in a jump setup next to a (nearly) static ball — e.g. one pinned at jump height on a ramp or
    // resting on a car — for a jump that doesn't come (the jump / facing checks keep failing): back off and re-approach
    const V = ctx.path.seenVel;
    const stalled = this.mode === JUMP_SETUP && V.x * V.x + V.y * V.y + V.z * V.z < 1;
    if ((pushing || stalled) && me.speed < 0.8 && me.onGround) this.stuck += ctx.dt;
    else this.stuck = Math.max(0, this.stuck - ctx.dt * 2);
    if (this.stuck > 0.9) {
      this.stuck = 0;
      this.maneuver = new Unstick(this.rng.chance(0.5) ? 1 : -1, 0.6 + this.rng.next() * 0.3);
    }
  }

  /** NOVA PULSE: clutch saves and (skill-dependent) offensive redirects. */
  private afterDecision(ctx: BotContext, me: CarInfo, out: ControlState): void {
    if (!ctx.mutators.pulse || !me.pulseReady || ctx.phase !== 'playing' || ctx.kickoff) return;
    const B = ctx.path.nowPos;
    const dx = B.x - me.pos.x;
    const dy = B.y - me.pos.y;
    const dz = B.z - me.pos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > PULSE.radius + R - 0.5 || d < 1e-3) return;
    const nzr = (dz / d) * me.dir; // + = pushes the ball upfield
    const opp = me.team === 0 ? 1 : 0;
    const path = ctx.path;
    const goalT = path.goalTeam === opp ? path.time(path.goalK) : Infinity;
    const bzr = B.z * me.dir;
    const danger = goalT < 2.2 || (bzr < -36 && Math.abs(B.x) < 13 && path.nowVel.z * me.dir < -3);
    let want = false;
    let prob = 0;
    if (danger && nzr > 0.1) {
      want = true;
      prob = this.skill.pulseSave + (this.chargePlay(ctx, me) <= -2 ? 0.3 : 0);
    } else if (this.skill.pulseShot > 0 && d < 6.5 && path.goalTeam !== me.team && bzr > 5 && !this.mateOnBall(ctx, me, d)) {
      // offensive redirect: the push line goes into the enemy goal (never snatching it from a teammate's touch)
      const ez = L * me.dir;
      const t = (ez - B.z) / (dz / d);
      if (t > 0 && t < 45) {
        const xe = B.x + (dx / d) * t;
        // rookies (discipline < 0.5) pulse when it's roughly goalward — a show of the mechanic more than a sure goal
        if (Math.abs(xe) < ARENA.goalHalfWidth + (this.skill.discipline < 0.5 ? 4 : -1.5)) {
          want = true;
          prob = this.skill.pulseShot;
        }
      }
    }
    if (!want) return;
    if (ctx.time > this.pulseUntil) {
      this.pulseUntil = ctx.time + 0.8;
      this.pulseYes = this.rng.chance(prob);
    }
    if (this.pulseYes) out.pulse = true;
  }
}
