/**
 * AI scenario lab: one bot vs a parked opponent, a scripted ball state, measured outcomes.
 * Used by tests/ai/mechanics.test.ts and tests/ai/tools/labrunner.ts (tuning).
 */
import { Quaternion } from 'three';
import { BotManager } from '../../src/ai/BotManager';
import { BotRng } from '../../src/ai/math';
import { resetCarKinematics } from '../../src/sim/car';
import { predictGoal } from '../../src/sim/predict';
import type { SimMatchState } from '../../src/sim/match';
import type { ControlState, Difficulty } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { quatFromHeading } from '../../src/sim/vmath';
import { World } from '../../src/sim/world';
import { config } from './helpers';

export interface LabSetup {
  car: { x: number; z: number; hx: number; hz: number; v: number; boost: number };
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
}

export interface LabTracePoint {
  t: number;
  b: [number, number, number];
  c: [number, number, number];
  f: [number, number];
  mode: string;
  tgt: [number, number];
  ctl: string;
}

export interface LabResult {
  trace?: LabTracePoint[];
  touched: boolean;
  tTouch: number;
  /** Ball velocity right after the first touch. */
  vAfter: { x: number; y: number; z: number };
  /** Goal for the bot's team (+Z goal) within the run. */
  scored: boolean;
  ownGoal: boolean;
  tGoal: number;
  jumps: number;
  aerialTouch: boolean;
  /** Ball trajectory right after the first touch would score (no further touches, 6 s). */
  onTarget: boolean;
  /** Mode of the bot at the first touch. */
  touchMode: string;
  /** Angle (deg) between the intended shot direction (0.3 s before the touch) and the ball's direction after it. */
  aimErrDeg: number;
  /** Ball / car positions at the touch. */
  touchBall: [number, number, number];
}

const _q = new Quaternion();

/** Run one scenario for `seconds`. The bot is car 0 (team 0, attacks +Z); car 1 is parked out of play. */
export function runLab(setup: LabSetup, diff: Difficulty, seconds: number, seed = 1, keepOpponent = false, trace = false): LabResult {
  const w = new World(config({ teamSize: 1, seed, mutators: { charge: true, pulse: false, surges: false, demolitions: true } }));
  while (w.match.phase !== 'playing') w.step([]);
  w.drainEvents();
  const m = w.match as SimMatchState;
  m.kickoffPending = false;
  const c = setup.car;
  const car = w.cars[0];
  resetCarKinematics(car, c.x, c.z, quatFromHeading(c.hx, c.hz, _q), c.boost);
  const hl = Math.hypot(c.hx, c.hz) || 1;
  car.vel.set((c.hx / hl) * c.v, 0, (c.hz / hl) * c.v);
  const opp = w.cars[1];
  if (!keepOpponent) {
    resetCarKinematics(opp, 30, 45, quatFromHeading(0, -1, _q), 0);
    opp.demolished = true;
    opp.respawnTimer = 1e9;
  }
  const b = setup.ball;
  w.ball.pos.set(b.x, b.y, b.z);
  w.ball.vel.set(b.vx, b.vy, b.vz);
  w.ball.angVel.set(0, 0, 0);
  w.ball.lastTouchCarId = -1;
  const bots = new BotManager(w, keepOpponent ? [0, 1] : [0], diff, seed);
  const inputs: ControlState[] = [makeControlState(), makeControlState()];
  const res: LabResult = {
    touched: false,
    tTouch: -1,
    vAfter: { x: 0, y: 0, z: 0 },
    scored: false,
    ownGoal: false,
    tGoal: -1,
    jumps: 0,
    aerialTouch: false,
    onTarget: false,
    touchMode: '',
    aimErrDeg: NaN,
    touchBall: [0, 0, 0],
  };
  const dirHist: Array<{ x: number; z: number }> = [];
  let pendingAfter = -1;
  const n = Math.round(seconds * 120);
  const t0 = w.time;
  if (trace) res.trace = [];
  for (let i = 0; i < n && w.match.phase === 'playing'; i++) {
    bots.update(w, inputs);
    if (!res.touched) {
      const st = bots.botState(0)!;
      dirHist.push({ x: st.shotDir.x, z: st.shotDir.z });
      if (dirHist.length > 12) dirHist.shift();
    }
    if (res.trace && i % 3 === 0) {
      const st = bots.botState(0)!;
      const k = inputs[0];
      res.trace.push({
        t: w.time - t0,
        b: [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z],
        c: [car.pos.x, car.pos.y, car.pos.z],
        f: [car.fwd.x, car.fwd.z],
        mode: `${st.mode}/${st.shotKind}(${st.shotDir.x.toFixed(2)},${st.shotDir.z.toFixed(2)})`,
        tgt: [st.target.x, st.target.z],
        ctl: `${k.throttle.toFixed(1)} ${k.steer.toFixed(1)}${k.boost ? ' B' : ''}${k.jump ? ' J' : ''}${k.powerslide ? ' S' : ''}${k.pulse ? ' P' : ''}`,
      });
    }
    w.step(inputs);
    for (const e of w.drainEvents()) {
      if (e.type === 'ballHit' && e.carId === 0 && !res.touched) {
        res.touched = true;
        res.tTouch = w.time - t0;
        res.aerialTouch = e.aerial;
        res.touchMode = bots.botState(0)?.mode ?? '';
        res.touchBall = [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z];
        pendingAfter = 3;
      } else if (e.type === 'jump' && e.carId === 0) res.jumps++;
      else if (e.type === 'goal') {
        res.tGoal = w.time - t0;
        if (e.team === 0) res.scored = true;
        else res.ownGoal = true;
      }
    }
    if (pendingAfter > 0 && --pendingAfter === 0) {
      res.vAfter = { x: w.ball.vel.x, y: w.ball.vel.y, z: w.ball.vel.z };
      res.onTarget = predictGoal(w.ball.pos, w.ball.vel, w.ball.angVel, w.match.surge.gravityScale, 6) === 0;
      const d0 = dirHist[0];
      if (d0) {
        const a0 = Math.atan2(d0.x, d0.z);
        const a1 = Math.atan2(w.ball.vel.x, w.ball.vel.z);
        let da = ((a1 - a0) * 180) / Math.PI;
        while (da > 180) da -= 360;
        while (da < -180) da += 360;
        res.aimErrDeg = da;
      }
    }
  }
  return res;
}

export type ScenarioKind = 'openNet' | 'rolling' | 'bouncing' | 'high' | 'save' | 'sideShot';

/** Random setup generators (all from team 0's point of view: attacks +Z). */
export function makeSetup(kind: ScenarioKind, rng: BotRng): LabSetup {
  const hd = rng.range(-Math.PI, Math.PI);
  switch (kind) {
    case 'openNet': {
      // resting ball in the offensive half, car somewhere behind it
      const bx = rng.range(-20, 20);
      const bz = rng.range(0, 30);
      return {
        car: { x: bx + rng.range(-15, 15), z: bz - rng.range(10, 30), hx: Math.sin(hd), hz: Math.cos(hd), v: rng.range(0, 12), boost: rng.range(20, 100) },
        ball: { x: bx, y: 1, z: bz, vx: 0, vy: 0, vz: 0 },
      };
    }
    case 'sideShot': {
      // ball near the offensive corner / side, car coming from midfield
      const s = rng.chance(0.5) ? 1 : -1;
      const bx = s * rng.range(12, 26);
      const bz = rng.range(20, 38);
      return {
        car: { x: bx * rng.range(-0.5, 1), z: bz - rng.range(12, 30), hx: Math.sin(hd), hz: Math.cos(hd), v: rng.range(0, 14), boost: rng.range(20, 100) },
        ball: { x: bx, y: 1, z: bz, vx: 0, vy: 0, vz: 0 },
      };
    }
    case 'rolling': {
      const bx = rng.range(-25, 25);
      const bz = rng.range(-10, 25);
      const sp = rng.range(4, 14);
      const a = rng.range(-Math.PI, Math.PI);
      return {
        car: { x: rng.range(-25, 25), z: bz - rng.range(10, 30), hx: Math.sin(hd), hz: Math.cos(hd), v: rng.range(0, 14), boost: rng.range(20, 100) },
        ball: { x: bx, y: 1, z: bz, vx: Math.sin(a) * sp, vy: 0, vz: Math.cos(a) * sp },
      };
    }
    case 'bouncing': {
      const bx = rng.range(-20, 20);
      const bz = rng.range(-10, 25);
      const a = rng.range(-Math.PI, Math.PI);
      const sp = rng.range(0, 8);
      return {
        car: { x: rng.range(-25, 25), z: bz - rng.range(8, 28), hx: Math.sin(hd), hz: Math.cos(hd), v: rng.range(0, 14), boost: rng.range(30, 100) },
        ball: { x: bx, y: rng.range(3, 7), z: bz, vx: Math.sin(a) * sp, vy: rng.range(-2, 6), vz: Math.cos(a) * sp },
      };
    }
    case 'high': {
      const bx = rng.range(-15, 15);
      const bz = rng.range(0, 25);
      return {
        car: { x: bx + rng.range(-10, 10), z: bz - rng.range(12, 25), hx: 0, hz: 1, v: rng.range(5, 15), boost: 100 },
        ball: { x: bx, y: rng.range(5, 9), z: bz, vx: rng.range(-3, 3), vy: rng.range(3, 9), vz: rng.range(-4, 2) },
      };
    }
    case 'save': {
      // shot toward our goal (−Z) from midfield; bot near goal or chasing
      const bx = rng.range(-20, 20);
      const bz = rng.range(-20, 0);
      const tx = rng.range(-6, 6);
      const tz = -50;
      const d = Math.hypot(tx - bx, tz - bz);
      const sp = rng.range(14, 24);
      const chasing = rng.chance(0.4);
      return {
        car: chasing
          ? { x: bx + rng.range(-8, 8), z: bz + rng.range(3, 12), hx: 0, hz: -1, v: rng.range(5, 15), boost: rng.range(20, 100) }
          : { x: rng.range(-10, 10), z: rng.range(-46, -35), hx: Math.sin(hd), hz: Math.cos(hd), v: 0, boost: rng.range(20, 100) },
        ball: { x: bx, y: 1, z: bz, vx: ((tx - bx) / d) * sp, vy: rng.range(0, 4), vz: ((tz - bz) / d) * sp },
      };
    }
  }
}
