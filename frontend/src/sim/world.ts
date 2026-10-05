/**
 * NOVABALL — the deterministic simulation world (implements IWorld).
 *
 * Step order (phases 'playing' / 'goal' / 'ended'; 'countdown' freezes cars and ball):
 *   cars (controls → hover / air physics → integrate → body vs arena) → NOVA PULSEs (id order) → boost pads →
 *   ball (gravity, drag, integrate, arena) → car–ball (same-tick contacts resolved symmetrically) → car–car →
 *   displaced cars re-resolved vs arena → ball containment → surge window →
 *   rules (goal, charge decay, clock / overtime / match end, surge schedule) → goal-phase timer.
 *
 * Everything is deterministic: fixed DT, integer tick timers, seeded RNG, arithmetic + sqrt only.
 */
import { Quaternion, Vector3 } from 'three';
import type { IWorld } from '../contracts';
import { goalScoredBy } from './arena';
import type { BallBody } from './ball';
import { BALL_BOUNCE_EVENT_SPEED, clampBallSpin, collideBallArena, enforceBallInside, integrateBall, makeBallContactInfo } from './ball';
import type { SimCar } from './car';
import { collideCarArena, createCar, popCar, resetCarKinematics, stepCar, updateAxes } from './car';
import type { CarBallContact, CarBallResponse } from './collide';
import {
  carBallContact,
  carCarContact,
  makeCarBallContact,
  makeCarBallResponse,
  makeCarCarContact,
  resolveCarBall,
  resolveCarCar,
} from './collide';
import {
  BALL,
  BOT_NAMES,
  CAR,
  CAR_CAR,
  DT,
  GRAVITY,
  HIT,
  MATCH,
  PULSE,
  RESPAWN_SPOTS,
  SIM_HZ,
  STAT_POINTS,
} from './constants';
import type { SimMatchState } from './match';
import {
  carGravityScaleFor,
  chargeTouch,
  chooseKickoffSpots,
  createMatchState,
  endSurge,
  FREEPLAY_COUNTDOWN_TICKS,
  GOAL_PHASE_TICKS,
  resetCharge,
  SURGE_INTERVAL_TICKS,
  SURGE_MIN_CLOCK_TICKS,
  SURGE_WARNING_TICKS,
  tickChargeDecay,
  tickSurge,
  triggerSurgeWarning,
} from './match';
import { createPads, resetPads, updatePads } from './pads';
import { predictGoal } from './predict';
import { Rng } from './rng';
import { makeSnapshot } from './snapshot';
import type {
  BallState,
  CarStyleId,
  ControlState,
  MatchConfig,
  PadState,
  SimEvent,
  Team,
  WorldSnapshot,
} from './types';
import { makeControlState } from './types';
import { integrateQuat, quatFromHeading } from './vmath';

/** BallState + internal bookkeeping. */
export interface SimBall extends BallState {
  /** Touching the arena this tick (rolling / resting / bouncing). */
  onSurface: boolean;
}

/** Car styles bots pick from. */
const STYLES: ReadonlyArray<CarStyleId> = ['striker', 'viper', 'titan'];
/** Free play spawn (car 0). */
const FREEPLAY_SPAWN = { x: 0, z: -20 };
/** Assist window (seconds before the scorer's last touch). */
const ASSIST_WINDOW = 5;
/** Save / shot prediction horizon (s). */
const SHOT_PREDICT_HORIZON = 2.5;
/** Epic save thresholds. */
const EPIC_SAVE_BALL_SPEED = 28;
const AERIAL_HEIGHT = 3;
/** Minimum spacing between two stat-counted touches of the same car. */
const STAT_TOUCH_INTERVAL = 0.2;
/** Car–car bumps below this closing speed are silent (no extra impulse, no event). */
const BUMP_MIN_SPEED = 2;
/** A respawn spot is "free" if no live car is within this distance. */
const RESPAWN_CLEARANCE = 3;

const NEUTRAL: ControlState = Object.freeze(makeControlState()) as ControlState;

// hashing scratch
const _hv = new DataView(new ArrayBuffer(8));

export class World implements IWorld {
  readonly config: MatchConfig;
  readonly cars: SimCar[];
  readonly ball: SimBall;
  readonly pads: PadState[];
  readonly match: SimMatchState;
  tick = 0;
  time = 0;
  /** Seeded RNG (names, styles, kickoff layouts, respawn spots). Part of the hash. Private: any outside call
   *  would change the random stream and break replay / verification determinism. */
  private readonly rng: Rng;

  private events: SimEvent[] = [];
  private readonly pairContact: Uint8Array;
  private readonly pulseReq: Uint8Array;
  private readonly cbContacts: CarBallContact[] = [];
  private readonly cbResps: CarBallResponse[] = [];
  private readonly cbStart: Uint8Array;
  /** Cars moved by car–car / car–ball separation this tick (re-resolved against the arena). */
  private readonly displaced: Uint8Array;
  private readonly ballBefore: BallBody = { pos: new Vector3(), vel: new Vector3(), angVel: new Vector3() };
  private readonly _dPos = new Vector3();
  private readonly _dVel = new Vector3();
  private readonly _dAng = new Vector3();
  private readonly ccContact = makeCarCarContact();
  private readonly ballInfo = makeBallContactInfo();
  private readonly _tmpQ = new Quaternion();

  constructor(config: MatchConfig) {
    this.config = {
      ...config,
      mutators: { ...config.mutators },
      player: config.player ? { ...config.player } : null,
    };
    const cfg = this.config;
    const teamSize = cfg.teamSize < 1 ? 1 : cfg.teamSize > 3 ? 3 : cfg.teamSize;
    this.rng = new Rng(cfg.seed);

    // ---- cars (id convention: 0..ts-1 team 0, ts..2ts-1 team 1; free play: only car 0)
    const names = this.rng.shuffle(BOT_NAMES.slice());
    let nameIdx = 0;
    const numCars = cfg.freePlay ? 1 : teamSize * 2;
    this.cars = [];
    for (let id = 0; id < numCars; id++) {
      const team: Team = id < teamSize ? 0 : 1;
      const isPlayer = cfg.player !== null && id === 0;
      let name: string;
      let style: CarStyleId;
      if (isPlayer && cfg.player) {
        name = cfg.player.name;
        style = cfg.player.style;
      } else {
        name = names[nameIdx % names.length];
        if (nameIdx >= names.length) name += '-' + String(Math.floor(nameIdx / names.length) + 1);
        nameIdx++;
        style = STYLES[this.rng.int(STYLES.length)];
      }
      this.cars.push(createCar(id, team, name, !isPlayer, style));
    }
    this.pairContact = new Uint8Array(numCars * numCars);
    this.pulseReq = new Uint8Array(numCars);
    this.cbStart = new Uint8Array(numCars);
    this.displaced = new Uint8Array(numCars);
    for (let i = 0; i < numCars; i++) {
      this.cbContacts.push(makeCarBallContact());
      this.cbResps.push(makeCarBallResponse());
    }

    // ---- ball
    this.ball = {
      pos: new Vector3(BALL.spawn.x, BALL.spawn.y, BALL.spawn.z),
      vel: new Vector3(),
      quat: new Quaternion(),
      angVel: new Vector3(),
      charge: 0,
      chargeTeam: -1,
      lastTouchCarId: -1,
      lastTouchTime: -1,
      exploded: false,
      onSurface: true,
    };

    this.pads = createPads();
    this.match = createMatchState(cfg);
    this.kickoffReset();
  }

  // ===========================================================================================
  // IWorld
  // ===========================================================================================

  step(inputs: ReadonlyArray<ControlState>): void {
    this.tick++;
    this.time = this.tick * DT;
    const m = this.match;
    m.phaseTicks++;
    m.phaseTime = m.phaseTicks / SIM_HZ;

    if (m.phase === 'countdown') {
      this.countdownStep(inputs);
      return;
    }

    const events = this.events;
    const time = this.time;
    const playing = m.phase === 'playing';
    const ended = m.phase === 'ended';
    const gScale = m.surge.gravityScale; // ball gravity multiplier (ZERO-G SURGE)
    const gravity = GRAVITY * carGravityScaleFor(gScale); // cars fall faster than the ball during a surge
    const cars = this.cars;
    const ball = this.ball;

    // ---- cars
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const c = ended ? NEUTRAL : (inputs[car.id] ?? NEUTRAL);
      const pulsePressed = c.pulse && !car.prevPulse;
      car.prevPulse = c.pulse;
      if (car.pulseCooldown > 0) {
        car.pulseCooldown -= DT;
        if (car.pulseCooldown < 0) car.pulseCooldown = 0;
      }
      this.pulseReq[i] = 0;
      if (car.demolished) {
        car.prevJump = c.jump;
        car.respawnTimer -= DT;
        if (car.respawnTimer <= 0) this.respawn(car);
        continue;
      }
      stepCar(car, c, DT, gravity, time, events);
      if (pulsePressed && playing && this.config.mutators.pulse && car.pulseCooldown <= 0) this.pulseReq[i] = 1;
    }

    // ---- NOVA PULSE (after all cars moved, in id order)
    for (let i = 0; i < cars.length; i++) if (this.pulseReq[i]) this.doPulse(cars[i]);

    // ---- boost pads
    updatePads(this.pads, cars, DT, events);

    // ---- ball
    if (!ball.exploded) {
      integrateBall(ball, DT, gScale);
      const w = ball.angVel;
      integrateQuat(ball.quat, w.x, w.y, w.z, DT);
      const info = this.ballInfo;
      ball.onSurface = collideBallArena(ball, DT, info);
      if (info.impactSpeed >= BALL_BOUNCE_EVENT_SPEED) {
        events.push({
          type: 'ballBounce',
          pos: { x: info.px, y: info.py, z: info.pz },
          normal: { x: info.nx, y: info.ny, z: info.nz },
          speed: info.impactSpeed,
        });
      }
      // ---- car–ball (same-tick contacts resolved symmetrically)
      this.carBallAll(playing);
    }

    // ---- car–car
    this.carCar();

    // ---- cars displaced by car–car / car–ball separation: resolve against the arena again
    for (let i = 0; i < cars.length; i++) {
      if (this.displaced[i]) {
        this.displaced[i] = 0;
        if (!cars[i].demolished) collideCarArena(cars[i], time, null);
      }
    }

    // ---- containment (cars may have pushed the ball into a wall)
    if (!ball.exploded) enforceBallInside(ball);

    // ---- surge window (warning → active → idle), then rules
    tickSurge(m, events);
    if (playing) {
      if (!ball.exploded) this.checkGoal();
      if (m.phase === 'playing') {
        if (this.config.mutators.charge) tickChargeDecay(m, ball, events);
        this.clockStep();
      }
    }

    if (m.phase === 'goal' && m.phaseTicks >= GOAL_PHASE_TICKS) this.endGoalPhase();
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  createSnapshot(): WorldSnapshot {
    const s = makeSnapshot(this.cars.length, this.pads.length);
    this.writeSnapshot(s);
    return s;
  }

  writeSnapshot(out: WorldSnapshot): void {
    out.tick = this.tick;
    out.time = this.time;
    out.phase = this.match.phase;
    out.surge = this.match.surge.intensity;
    const pulseOn = this.config.mutators.pulse;
    // shape (only allocates if the caller passed a mismatched snapshot)
    while (out.cars.length < this.cars.length) out.cars.push(makeSnapshot(1, 0).cars[0]);
    if (out.cars.length > this.cars.length) out.cars.length = this.cars.length;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const s = out.cars[i];
      s.id = c.id;
      s.team = c.team;
      s.pos.copy(c.pos);
      s.quat.copy(c.quat);
      s.vel.copy(c.vel);
      s.angVel.copy(c.angVel);
      s.boost = c.boost;
      s.boosting = c.isBoosting;
      s.supersonic = c.supersonic;
      s.onGround = c.onGround;
      s.demolished = c.demolished;
      s.dodging = c.isDodging;
      s.powersliding = c.isPowersliding;
      s.steer = c.lastControls.steer;
      s.throttle = c.lastControls.boost ? 1 : c.lastControls.throttle;
      s.pulseReady01 = pulseOn ? 1 - c.pulseCooldown / PULSE.cooldown : 0;
    }
    const b = this.ball;
    const sb = out.ball;
    sb.pos.copy(b.pos);
    sb.quat.copy(b.quat);
    sb.vel.copy(b.vel);
    sb.angVel.copy(b.angVel);
    sb.charge = b.charge;
    sb.chargeTeam = b.chargeTeam;
    sb.visible = !b.exploded;
    while (out.padsActive.length < this.pads.length) out.padsActive.push(true);
    if (out.padsActive.length > this.pads.length) out.padsActive.length = this.pads.length;
    for (let i = 0; i < this.pads.length; i++) out.padsActive[i] = this.pads[i].active;
  }

  resetFreePlay(): void {
    if (!this.config.freePlay) return;
    const car = this.cars[0];
    resetCarKinematics(car, FREEPLAY_SPAWN.x, FREEPLAY_SPAWN.z, quatFromHeading(0, 1, this._tmpQ), CAR.boostMax);
    this.resetBall();
    resetCharge(this.match, this.ball, this.events);
    const m = this.match;
    m.kickoffPending = true;
    m.touchSeq = 0;
    if (m.phase !== 'playing') {
      m.phase = 'playing';
      m.phaseTicks = 0;
      m.phaseTime = 0;
      m.countdown = 0;
    }
  }

  hash(): number {
    let h = 0x811c9dc5 | 0;
    const num = (x: number) => {
      _hv.setFloat64(0, x, true);
      for (let i = 0; i < 8; i++) {
        h ^= _hv.getUint8(i);
        h = Math.imul(h, 16777619);
      }
    };
    const bool = (b: boolean) => {
      h ^= b ? 1 : 2;
      h = Math.imul(h, 16777619);
    };
    const v3 = (v: Vector3) => {
      num(v.x);
      num(v.y);
      num(v.z);
    };
    const q4 = (q: Quaternion) => {
      num(q.x);
      num(q.y);
      num(q.z);
      num(q.w);
    };
    num(this.tick);
    num(this.rng.state);
    // match
    const m = this.match;
    num(PHASES.indexOf(m.phase));
    num(m.phaseTicks);
    num(m.countdownTicks);
    num(m.clockTicks);
    num(m.overtimeTicks);
    bool(m.overtime);
    num(m.score[0]);
    num(m.score[1]);
    num(m.winner);
    bool(m.kickoffPending);
    bool(m.endAfterGoal);
    num(m.nextSurgeClockTicks);
    num(m.nextSurgeOvertimeTicks);
    num(m.surgeTicksLeft);
    num(m.surgeTicksTotal);
    num(SURGE_STATES.indexOf(m.surge.state));
    num(m.surge.gravityScale);
    num(m.surge.intensity);
    num(m.chargeIdleTicks);
    num(m.lastChargeTouchTime);
    num(m.touchSeq);
    // ball
    const b = this.ball;
    v3(b.pos);
    v3(b.vel);
    q4(b.quat);
    v3(b.angVel);
    num(b.charge);
    num(b.chargeTeam);
    num(b.lastTouchCarId);
    num(b.lastTouchTime);
    bool(b.exploded);
    bool(b.onSurface);
    // cars
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      v3(c.pos);
      v3(c.vel);
      q4(c.quat);
      v3(c.angVel);
      num(c.boost);
      bool(c.onGround);
      v3(c.groundNormal);
      num(c.airTime);
      bool(c.hasJumped);
      bool(c.hasDoubleJumped);
      bool(c.hasDodged);
      bool(c.isDodging);
      bool(c.isBoosting);
      bool(c.isPowersliding);
      bool(c.supersonic);
      bool(c.demolished);
      num(c.respawnTimer);
      num(c.pulseCooldown);
      bool(c.prevJump);
      bool(c.prevPulse);
      num(c.jumpTimer);
      bool(c.jumpHolding);
      bool(c.jumpLock);
      num(c.airJumpTimer);
      num(c.dodgeTimer);
      bool(c.flipActive);
      num(c.flipF);
      num(c.flipR);
      num(c.flipAngle);
      num(c.landTimer);
      bool(c.landPending);
      v3(c.prevNormal);
      num(c.turtleTimer);
      num(c.selfRightTimer);
      v3(c.selfRightTarget);
      num(c.bodyContactTimer);
      bool(c.ballContact);
      num(c.lastExtraHitTime);
      num(c.lastTouchTime);
      num(c.lastStatTouchTime);
      num(c.lastImpactEventTime);
      num(c.lastShotTime);
      num(c.lastHitTime);
      num(c.lastTouchSeq);
      const st = c.stats;
      num(st.score);
      num(st.goals);
      num(st.assists);
      num(st.saves);
      num(st.shots);
      num(st.demos);
      num(st.touches);
      num(st.hardestHit);
    }
    for (let i = 0; i < this.pads.length; i++) {
      bool(this.pads[i].active);
      num(this.pads[i].timer);
    }
    for (let i = 0; i < this.pairContact.length; i++) num(this.pairContact[i]);
    return h >>> 0;
  }

  // ===========================================================================================
  // Phases
  // ===========================================================================================

  private countdownStep(inputs: ReadonlyArray<ControlState>): void {
    const m = this.match;
    // Cars and ball frozen; track input edges so a button held through the countdown doesn't fire at GO.
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const c = inputs[car.id] ?? NEUTRAL;
      car.prevJump = c.jump;
      car.prevPulse = c.pulse;
      car.lastControls.throttle = 0;
      car.lastControls.steer = c.steer;
      car.lastControls.boost = false;
      if (car.pulseCooldown > 0) {
        car.pulseCooldown -= DT;
        if (car.pulseCooldown < 0) car.pulseCooldown = 0;
      }
    }
    const left = m.countdownTicks - m.phaseTicks;
    m.countdown = left > 0 ? left / SIM_HZ : 0;
    if (left <= 0) {
      m.phase = 'playing';
      m.phaseTicks = 0;
      m.phaseTime = 0;
      m.countdown = 0;
      this.events.push({ type: 'kickoff' });
    } else if (!m.freePlay && left % SIM_HZ === 0) {
      this.events.push({ type: 'countdown', value: left / SIM_HZ });
    }
  }

  /** Place everything for a kickoff and enter the countdown. */
  private kickoffReset(): void {
    const m = this.match;
    const cfg = this.config;
    const q = this._tmpQ;
    if (cfg.freePlay) {
      resetCarKinematics(this.cars[0], FREEPLAY_SPAWN.x, FREEPLAY_SPAWN.z, quatFromHeading(0, 1, q), CAR.boostMax);
    } else {
      const spots = chooseKickoffSpots(this.rng, cfg.teamSize);
      const slot = [0, 0];
      for (let i = 0; i < this.cars.length; i++) {
        const car = this.cars[i];
        const s = spots[car.team][slot[car.team]++] ?? spots[car.team][0];
        resetCarKinematics(car, s.x, s.z, quatFromHeading(-s.x, -s.z, q), CAR.boostStart);
      }
    }
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.lastTouchTime = -1e9;
      car.lastTouchSeq = -1;
      car.lastExtraHitTime = -1e9;
      car.lastHitTime = -1e9;
      car.lastShotTime = -1e9;
    }
    this.pairContact.fill(0);
    this.resetBall();
    resetCharge(m, this.ball, this.events);
    resetPads(this.pads);
    m.kickoffPending = true;
    m.touchSeq = 0;
    m.phase = 'countdown';
    m.phaseTicks = 0;
    m.phaseTime = 0;
    m.countdownTicks = cfg.freePlay ? FREEPLAY_COUNTDOWN_TICKS : Math.round(MATCH.countdown * SIM_HZ);
    m.countdown = m.countdownTicks / SIM_HZ;
    if (!cfg.freePlay) this.events.push({ type: 'countdown', value: Math.round(MATCH.countdown) });
  }

  private resetBall(): void {
    const b = this.ball;
    b.pos.set(BALL.spawn.x, BALL.spawn.y, BALL.spawn.z);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    b.quat.set(0, 0, 0, 1);
    b.exploded = false;
    b.lastTouchCarId = -1;
    b.lastTouchTime = -1;
    b.onSurface = true;
    for (let i = 0; i < this.cars.length; i++) this.cars[i].ballContact = false;
  }

  private clockStep(): void {
    const m = this.match;
    if (m.freePlay) return;
    const surges = this.config.mutators.surges;
    if (m.overtime) {
      m.overtimeTicks++;
      m.overtimeElapsed = m.overtimeTicks / SIM_HZ;
      if (surges && m.surge.state === 'idle' && m.overtimeTicks >= m.nextSurgeOvertimeTicks - SURGE_WARNING_TICKS) {
        triggerSurgeWarning(m, this.events);
        m.nextSurgeOvertimeTicks += SURGE_INTERVAL_TICKS;
      }
      return;
    }
    if (m.clockTicks > 0) m.clockTicks--;
    m.clock = m.clockTicks / SIM_HZ;
    if (m.clockTicks % SIM_HZ === 0) {
      const secs = m.clockTicks / SIM_HZ;
      if (secs >= 1 && secs <= MATCH.lastSecondsTick) this.events.push({ type: 'clockTick', secondsLeft: secs });
    }
    if (
      surges &&
      m.surge.state === 'idle' &&
      m.nextSurgeClockTicks > 0 &&
      m.clockTicks <= m.nextSurgeClockTicks + SURGE_WARNING_TICKS
    ) {
      triggerSurgeWarning(m, this.events);
      m.nextSurgeClockTicks -= SURGE_INTERVAL_TICKS;
      if (m.nextSurgeClockTicks <= SURGE_MIN_CLOCK_TICKS) m.nextSurgeClockTicks = -1;
    }
    if (m.clockTicks <= 0) {
      if (m.score[0] !== m.score[1]) {
        this.endMatch();
      } else {
        m.overtime = true;
        m.overtimeTicks = 0;
        m.overtimeElapsed = 0;
        m.nextSurgeOvertimeTicks = SURGE_INTERVAL_TICKS;
        this.events.push({ type: 'overtime' });
        this.kickoffReset();
      }
    }
  }

  private endMatch(): void {
    const m = this.match;
    m.phase = 'ended';
    m.phaseTicks = 0;
    m.phaseTime = 0;
    m.winner = m.score[0] > m.score[1] ? 0 : m.score[1] > m.score[0] ? 1 : -1;
    endSurge(m, this.events);
    this.events.push({ type: 'matchEnd', winner: m.winner });
  }

  private endGoalPhase(): void {
    const m = this.match;
    if (m.freePlay) {
      // ball respawns at center, the car keeps its position
      this.resetBall();
      resetCharge(m, this.ball, this.events);
      m.kickoffPending = true;
      m.touchSeq = 0;
      m.phase = 'playing';
      m.phaseTicks = 0;
      m.phaseTime = 0;
      return;
    }
    if (m.endAfterGoal) this.endMatch();
    else this.kickoffReset();
  }

  // ===========================================================================================
  // Goals, touches, stats
  // ===========================================================================================

  private checkGoal(): void {
    const ball = this.ball;
    const team = goalScoredBy(ball.pos);
    if (team === -1) return;
    const m = this.match;
    const cars = this.cars;
    // scorer = last toucher from the scoring team since the kickoff
    let scorer: SimCar | null = null;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.team === team && c.lastTouchSeq >= 0 && (scorer === null || c.lastTouchSeq > scorer.lastTouchSeq)) scorer = c;
    }
    const ownGoal = scorer === null;
    // assist = most recent different teammate touching within ASSIST_WINDOW before the scorer's last touch
    let assist: SimCar | null = null;
    if (scorer) {
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c === scorer || c.team !== team || c.lastTouchSeq < 0) continue;
        if (scorer.lastTouchTime - c.lastTouchTime <= ASSIST_WINDOW && (assist === null || c.lastTouchSeq > assist.lastTouchSeq)) assist = c;
      }
    }
    const chargeLevel = ball.charge;
    const points = !ownGoal && this.config.mutators.charge && ball.chargeTeam === team && chargeLevel >= 1 ? chargeLevel : 1;
    m.score[team] += points;
    m.lastGoal = { team, scorerId: scorer ? scorer.id : -1, points };
    if (scorer) {
      scorer.stats.goals++;
      scorer.stats.score += STAT_POINTS.goal;
      // every goal is also a shot (if the scoring touch wasn't already registered as one)
      if (scorer.lastShotTime < scorer.lastHitTime) {
        scorer.stats.shots++;
        scorer.stats.score += STAT_POINTS.shot;
        scorer.lastShotTime = this.time;
      }
    }
    if (assist) {
      assist.stats.assists++;
      assist.stats.score += STAT_POINTS.assist;
    }
    this.events.push({
      type: 'goal',
      team,
      scorerId: scorer ? scorer.id : -1,
      assistId: assist ? assist.id : -1,
      points,
      charge: chargeLevel,
      ballSpeed: ball.vel.length(),
      pos: { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z },
      ownGoal,
    });
    ball.exploded = true;
    ball.vel.set(0, 0, 0);
    ball.angVel.set(0, 0, 0);
    for (let i = 0; i < cars.length; i++) cars[i].ballContact = false;
    m.phase = 'goal';
    m.phaseTicks = 0;
    m.phaseTime = 0;
    m.endAfterGoal = !m.freePlay && (m.overtime || m.clockTicks <= 0);
  }

  /** Last-touch bookkeeping for every touching tick / pulse hit. */
  private markTouch(car: SimCar): void {
    const ball = this.ball;
    ball.lastTouchCarId = car.id;
    ball.lastTouchTime = this.time;
    car.lastTouchTime = this.time;
    car.lastTouchSeq = ++this.match.touchSeq;
    this.match.kickoffPending = false;
  }

  /**
   * All car–ball contacts of this tick. Contacts of the same tick are resolved SYMMETRICALLY: every car
   * responds against the same pre-contact ball state and the ball deltas are summed (so a perfectly mirrored
   * 50/50 is decided by physics, not by car id order).
   */
  private carBallAll(playing: boolean): void {
    const ball = this.ball;
    const cars = this.cars;
    const n = cars.length;
    const cts = this.cbContacts;
    let count = 0;
    let anyStart = false;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      const ct = cts[i];
      ct.penetrating = false;
      if (car.demolished) continue;
      if (!carBallContact(car, ball, ct)) {
        car.ballContact = false;
        continue;
      }
      if (!ct.penetrating) continue; // within the contact margin only: keep the contact flag as-is
      count++;
      if (!car.ballContact) anyStart = true;
    }
    if (count === 0) return;

    const time = this.time;
    const gScale = this.match.surge.gravityScale;
    const b0 = this.ballBefore;
    b0.pos.copy(ball.pos);
    b0.vel.copy(ball.vel);
    b0.angVel.copy(ball.angVel);
    const speedBefore = b0.vel.length();
    const predBefore: Team | -1 = anyStart && playing ? predictGoal(b0.pos, b0.vel, b0.angVel, gScale, SHOT_PREDICT_HORIZON) : -1;
    const multi = count > 1;
    const dp = this._dPos.set(0, 0, 0);
    const dv = this._dVel.set(0, 0, 0);
    const dw = this._dAng.set(0, 0, 0);
    const chargeLevel = ball.charge;

    for (let i = 0; i < n; i++) {
      const ct = cts[i];
      if (!ct.penetrating) continue;
      const car = cars[i];
      const start = !car.ballContact;
      car.ballContact = true;
      this.cbStart[i] = start ? 1 : 0;
      const allowExtra = start && time - car.lastExtraHitTime >= HIT.minInterval;
      if (multi) {
        ball.pos.copy(b0.pos);
        ball.vel.copy(b0.vel);
        ball.angVel.copy(b0.angVel);
      }
      const resp = this.cbResps[i];
      resolveCarBall(car, ball, ct, allowExtra, chargeLevel, resp);
      this.displaced[i] = 1;
      if (resp.extraApplied) car.lastExtraHitTime = time;
      if (multi) {
        dp.x += ball.pos.x - b0.pos.x;
        dp.y += ball.pos.y - b0.pos.y;
        dp.z += ball.pos.z - b0.pos.z;
        dv.x += ball.vel.x - b0.vel.x;
        dv.y += ball.vel.y - b0.vel.y;
        dv.z += ball.vel.z - b0.vel.z;
        dw.x += ball.angVel.x - b0.angVel.x;
        dw.y += ball.angVel.y - b0.angVel.y;
        dw.z += ball.angVel.z - b0.angVel.z;
      }
      this.markTouch(car);
    }
    if (multi) {
      ball.pos.copy(b0.pos).add(dp);
      ball.vel.copy(b0.vel).add(dv);
      ball.angVel.copy(b0.angVel).add(dw);
      clampBallSpin(ball.angVel);
      const sp2 = ball.vel.lengthSq();
      if (sp2 > BALL.maxSpeed * BALL.maxSpeed) ball.vel.multiplyScalar(BALL.maxSpeed / Math.sqrt(sp2));
    }
    if (!anyStart) return;

    // ---- contact starts: events, stats, charge, saves / shots (against the final ball state)
    const ballSpeed = ball.vel.length();
    const after: Team | -1 = playing ? predictGoal(ball.pos, ball.vel, ball.angVel, gScale, SHOT_PREDICT_HORIZON) : -1;
    // the strongest same-tick contact start is the one that counts for CORE CHARGE
    let chargeIdx = -1;
    for (let i = 0; i < n; i++) {
      if (!cts[i].penetrating || !this.cbStart[i]) continue;
      if (chargeIdx < 0 || this.cbResps[i].closing > this.cbResps[chargeIdx].closing) chargeIdx = i;
    }
    for (let i = 0; i < n; i++) {
      const ct = cts[i];
      if (!ct.penetrating || !this.cbStart[i]) continue;
      const car = cars[i];
      const resp = this.cbResps[i];
      car.lastHitTime = time;
      const st = car.stats;
      const aerial = !car.onGround && ball.pos.y > AERIAL_HEIGHT;
      this.events.push({
        type: 'ballHit',
        carId: car.id,
        team: car.team,
        pos: { x: ct.cx, y: ct.cy, z: ct.cz },
        normal: { x: ct.nx, y: ct.ny, z: ct.nz },
        strength: resp.dv,
        dodge: car.isDodging,
        aerial,
        ballSpeed,
      });
      if (time - car.lastStatTouchTime >= STAT_TOUCH_INTERVAL) {
        car.lastStatTouchTime = time;
        st.touches++;
        st.score += STAT_POINTS.touch;
      }
      if (ballSpeed > st.hardestHit) st.hardestHit = ballSpeed;
      if (playing) {
        if (i === chargeIdx && this.config.mutators.charge) chargeTouch(this.match, ball, car.team, resp.closing, false, time, this.events);
        this.detectSaveShot(car, predBefore, after, speedBefore, aerial);
      }
    }
  }

  private detectSaveShot(car: SimCar, before: Team | -1, after: Team | -1, speedBefore: number, aerial: boolean): void {
    const team = car.team;
    const opp: Team = team === 0 ? 1 : 0;
    const st = car.stats;
    if (before === opp && after !== opp) {
      const epic = speedBefore > EPIC_SAVE_BALL_SPEED || aerial;
      st.saves++;
      st.score += epic ? STAT_POINTS.epicSave : STAT_POINTS.save;
      this.events.push({ type: 'save', carId: car.id, epic });
    }
    if (after === team && before !== team) {
      st.shots++;
      st.score += STAT_POINTS.shot;
      car.lastShotTime = this.time;
      this.events.push({ type: 'shot', carId: car.id });
    }
  }

  private doPulse(car: SimCar): void {
    const ball = this.ball;
    const events = this.events;
    car.pulseCooldown = PULSE.cooldown;
    let hitBall = false;
    const hitCarIds: number[] = [];
    if (!ball.exploded) {
      const dx = ball.pos.x - car.pos.x;
      const dy = ball.pos.y - car.pos.y;
      const dz = ball.pos.z - car.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lim = PULSE.radius + BALL.radius;
      if (d <= lim) {
        const gScale = this.match.surge.gravityScale;
        const before = predictGoal(ball.pos, ball.vel, ball.angVel, gScale, SHOT_PREDICT_HORIZON);
        const speedBefore = ball.vel.length();
        let nx: number;
        let ny: number;
        let nz: number;
        if (d > 1e-6) {
          nx = dx / d;
          ny = dy / d;
          nz = dz / d;
        } else {
          nx = car.fwd.x;
          ny = car.fwd.y;
          nz = car.fwd.z;
        }
        const falloff = 1 - (0.6 * d) / lim;
        const imp = PULSE.ballImpulse * falloff;
        ball.vel.x += nx * imp;
        ball.vel.y += ny * imp + PULSE.ballLift;
        ball.vel.z += nz * imp;
        hitBall = true;
        this.markTouch(car);
        car.lastHitTime = this.time;
        const st = car.stats;
        st.touches++;
        st.score += STAT_POINTS.pulseHit;
        car.lastStatTouchTime = this.time;
        const sp = ball.vel.length();
        if (sp > st.hardestHit) st.hardestHit = sp;
        if (this.config.mutators.charge) chargeTouch(this.match, ball, car.team, 0, true, this.time, events);
        const after = predictGoal(ball.pos, ball.vel, ball.angVel, gScale, SHOT_PREDICT_HORIZON);
        this.detectSaveShot(car, before, after, speedBefore, !car.onGround && ball.pos.y > AERIAL_HEIGHT);
      }
    }
    // shove nearby RIVALS only (a teammate knocked off its own shot by a friendly pulse reads as a bug / griefing)
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i];
      if (o === car || o.demolished || o.team === car.team) continue;
      const dx = o.pos.x - car.pos.x;
      const dy = o.pos.y - car.pos.y;
      const dz = o.pos.z - car.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > PULSE.radius) continue;
      let nx: number;
      let ny: number;
      let nz: number;
      if (d > 1e-6) {
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
      } else {
        nx = car.fwd.x;
        ny = car.fwd.y;
        nz = car.fwd.z;
      }
      const falloff = 1 - (0.6 * d) / PULSE.radius;
      const imp = PULSE.carImpulse * falloff;
      o.vel.x += nx * imp;
      o.vel.y += ny * imp + PULSE.carLift;
      o.vel.z += nz * imp;
      popCar(o);
      hitCarIds.push(o.id);
    }
    events.push({ type: 'pulse', carId: car.id, pos: { x: car.pos.x, y: car.pos.y, z: car.pos.z }, hitBall, hitCarIds });
  }

  private carCar(): void {
    const cars = this.cars;
    const n = cars.length;
    const ct = this.ccContact;
    const demosOn = this.config.mutators.demolitions;
    for (let i = 0; i < n; i++) {
      const a = cars[i];
      for (let j = i + 1; j < n; j++) {
        const b = cars[j];
        const key = i * n + j;
        if (a.demolished || b.demolished || !carCarContact(a, b, ct)) {
          this.pairContact[key] = 0;
          continue;
        }
        const start = this.pairContact[key] === 0;
        this.pairContact[key] = 1;
        // closing speed & demolition checks use the pre-response velocities
        const vn = (b.vel.x - a.vel.x) * ct.nx + (b.vel.y - a.vel.y) * ct.ny + (b.vel.z - a.vel.z) * ct.nz;
        if (vn < 0 && demosOn && a.team !== b.team) {
          const aDemo = a.supersonic && a.fwd.x * ct.nx + a.fwd.y * ct.ny + a.fwd.z * ct.nz > CAR_CAR.demoFrontCos;
          const bDemo = b.supersonic && -(b.fwd.x * ct.nx + b.fwd.y * ct.ny + b.fwd.z * ct.nz) > CAR_CAR.demoFrontCos;
          if (aDemo || bDemo) {
            if (aDemo) this.demolish(b, a);
            if (bDemo) this.demolish(a, b);
            this.pairContact[key] = 0;
            continue;
          }
        }
        const closing = resolveCarCar(a, b, ct);
        this.displaced[i] = 1;
        this.displaced[j] = 1;
        if (start && closing >= BUMP_MIN_SPEED) {
          // attacker = the car driving harder into the other
          const sa = a.vel.x * ct.nx + a.vel.y * ct.ny + a.vel.z * ct.nz;
          const sb = -(b.vel.x * ct.nx + b.vel.y * ct.ny + b.vel.z * ct.nz);
          const attacker = sa >= sb ? a : b;
          const victim = attacker === a ? b : a;
          const sign = attacker === a ? 1 : -1;
          const k = closing / CAR.maxSpeed;
          let hx = ct.nx * sign;
          let hz = ct.nz * sign;
          const hl = Math.sqrt(hx * hx + hz * hz);
          if (hl > 1e-6) {
            hx /= hl;
            hz /= hl;
          }
          victim.vel.x += hx * CAR_CAR.bumpSpeed * k;
          victim.vel.z += hz * CAR_CAR.bumpSpeed * k;
          victim.vel.y += CAR_CAR.bumpUp * k;
          popCar(victim);
          this.events.push({ type: 'carBump', aId: attacker.id, bId: victim.id, pos: { x: ct.px, y: ct.py, z: ct.pz }, speed: closing });
        }
      }
    }
  }

  private demolish(victim: SimCar, attacker: SimCar): void {
    if (victim.demolished) return;
    this.events.push({
      type: 'demolish',
      victimId: victim.id,
      attackerId: attacker.id,
      pos: { x: victim.pos.x, y: victim.pos.y, z: victim.pos.z },
      vel: { x: victim.vel.x, y: victim.vel.y, z: victim.vel.z },
    });
    victim.demolished = true;
    victim.respawnTimer = CAR.respawnTime;
    victim.vel.set(0, 0, 0);
    victim.angVel.set(0, 0, 0);
    victim.isBoosting = false;
    victim.supersonic = false;
    victim.isDodging = false;
    victim.flipActive = false;
    victim.onGround = false;
    victim.ballContact = false;
    attacker.stats.demos++;
    attacker.stats.score += STAT_POINTS.demo;
  }

  private respawn(car: SimCar): void {
    const sign = car.team === 0 ? 1 : -1;
    // free spots (no live car within RESPAWN_CLEARANCE)
    let freeMask = 0;
    let freeCount = 0;
    for (let s = 0; s < RESPAWN_SPOTS.length; s++) {
      const x = RESPAWN_SPOTS[s].x * sign;
      const z = RESPAWN_SPOTS[s].z * sign;
      let free = true;
      for (let i = 0; i < this.cars.length; i++) {
        const o = this.cars[i];
        if (o === car || o.demolished) continue;
        const dx = o.pos.x - x;
        const dz = o.pos.z - z;
        if (dx * dx + dz * dz < RESPAWN_CLEARANCE * RESPAWN_CLEARANCE && o.pos.y < 3) {
          free = false;
          break;
        }
      }
      if (free) {
        freeMask |= 1 << s;
        freeCount++;
      }
    }
    let spot = 0;
    if (freeCount === 0) {
      spot = this.rng.int(RESPAWN_SPOTS.length);
    } else {
      let pick = this.rng.int(freeCount);
      for (let s = 0; s < RESPAWN_SPOTS.length; s++) {
        if (freeMask & (1 << s)) {
          if (pick === 0) {
            spot = s;
            break;
          }
          pick--;
        }
      }
    }
    const x = RESPAWN_SPOTS[spot].x * sign;
    const z = RESPAWN_SPOTS[spot].z * sign;
    resetCarKinematics(car, x, z, quatFromHeading(0, sign, this._tmpQ), CAR.boostStart);
    updateAxes(car);
    this.events.push({ type: 'respawn', carId: car.id });
  }

  // ===========================================================================================
  // Convenience (not part of IWorld)
  // ===========================================================================================

  /** Current BALL gravity multiplier (ZERO-G SURGE) — same as match.surge.gravityScale. */
  get gravityScale(): number {
    return this.match.surge.gravityScale;
  }

  /** Current CAR gravity multiplier (ZERO-G SURGE) — carGravityScaleFor(match.surge.gravityScale). */
  get carGravityScale(): number {
    return carGravityScaleFor(this.match.surge.gravityScale);
  }
}

const PHASES = ['countdown', 'playing', 'goal', 'ended'] as const;
const SURGE_STATES = ['idle', 'warning', 'active'] as const;
