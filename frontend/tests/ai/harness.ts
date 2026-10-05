/**
 * Headless full-match harness for the AI: World + BotManager(s), metrics collection.
 * Used by the vitest suites (tests/ai/*.test.ts) and the tuning CLI (tests/ai/tools/matchrunner.ts).
 */
import { BotManager } from '../../src/ai/BotManager';
import type { SkillProfile } from '../../src/ai/difficulty';
import { SIM_HZ } from '../../src/sim/constants';
import type { ControlState, Difficulty, MatchConfig, MatchMutators, TeamSize } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';

export interface MatchOpts {
  teamSize: TeamSize;
  /** Difficulty of team 0 / team 1 bots. */
  diff: [Difficulty, Difficulty];
  seed: number;
  durationSec?: number;
  mutators?: Partial<MatchMutators>;
  /** One manager for all bots (the in-game setup; requires equal difficulties). */
  singleManager?: boolean;
  /** Safety cap on simulated seconds (goal phases, overtime). */
  maxSimSec?: number;
  /** Record a coarse trace (positions every 6 ticks) for plots. */
  trace?: boolean;
  /** Human stand-in for car 0 (team 0): input function; car 0 is then not a bot. */
  human?: (w: World, out: ControlState) => void;
  /** Keep the last seconds before every goal (positions + bot modes) for plots. */
  goalClips?: boolean;
  /** Skill overrides per team (ablation / tuning). */
  skill?: [Partial<SkillProfile> | undefined, Partial<SkillProfile> | undefined];
  /** Swap the two managers' seeds (symmetry checks). */
  swapSeeds?: boolean;
}

export interface ClipFrame {
  t: number;
  b: [number, number, number];
  c: Array<[number, number, number, string]>;
}

export interface CarMetrics {
  id: number;
  team: number;
  touches: number;
  aerialTouches: number;
  goals: number;
  ownGoals: number;
  shots: number;
  saves: number;
  demos: number;
  pulses: number;
  pulseHits: number;
  supersonicSec: number;
  /** Mean boost in the tank while playing. */
  avgBoost: number;
  playingSec: number;
  /** Longest continuous time (s) with speed < 1 m/s while its target was > 5 m away (stuck). */
  maxStuck: number;
  /** Longest continuous time (s) with speed < 1 m/s (any reason). */
  maxStill: number;
  modeSec: Record<string, number>;
  maneuvers?: { starts: Record<string, number>; hits: Record<string, number> };
}

export interface MatchMetrics {
  opts: { teamSize: number; diff: [Difficulty, Difficulty]; seed: number };
  score: [number, number];
  goals: number[];
  goalEvents: Array<{
    team: number;
    ownGoal: boolean;
    points: number;
    scorerId: number;
    t: number;
    ballSpeed?: number;
    /** Seconds since the last touch before the goal, and that touch's distance to the goal line. */
    sinceTouch?: number;
    touchDist?: number;
    lastToucher?: number;
    /** Modes of the conceding team's bots at the last touch. */
    defModes?: string[];
    /** Mode of the car that made the last touch. */
    hitMode?: string;
  }>;
  winner: number;
  overtime: boolean;
  simSec: number;
  playingSec: number;
  kickoffTouch: number[];
  /** Sim time of each kickoff (GO). */
  kickoffTimes: number[];
  cars: CarMetrics[];
  /** Seconds with ≥ 2 teammates within 6 m of the ball, per team. */
  doubleCommitSec: [number, number];
  nan: boolean;
  updateMsAvg: number;
  updateMsMax: number;
  events: Record<string, number>;
  trace?: Array<{ t: number; b: [number, number, number]; c: Array<[number, number, number]> }>;
  clips?: Array<{ team: number; scorerId: number; frames: ClipFrame[] }>;
}

export function makeConfig(o: MatchOpts): MatchConfig {
  return {
    teamSize: o.teamSize,
    durationSec: o.durationSec ?? 180,
    difficulty: o.diff[0],
    seed: o.seed,
    freePlay: false,
    mutators: { charge: true, pulse: true, surges: true, demolitions: true, ...(o.mutators ?? {}) },
    player: o.human ? { name: 'HUMAN', style: 'striker', paint: '#ffffff' } : null,
  };
}

export function runMatch(o: MatchOpts): MatchMetrics {
  const cfg = makeConfig(o);
  const w = new World(cfg);
  const n = w.cars.length;
  const ts = o.teamSize;
  const managers: BotManager[] = [];
  const botIds = (team: number) => w.cars.filter((c) => c.team === team && c.isBot).map((c) => c.id);
  if (o.singleManager) {
    managers.push(new BotManager(w, [...botIds(0), ...botIds(1)], o.diff[0], o.seed * 31 + 7, o.skill?.[0]));
  } else {
    const s0 = o.swapSeeds ? o.seed * 57 + 3 : o.seed * 31 + 7;
    const s1 = o.swapSeeds ? o.seed * 31 + 7 : o.seed * 57 + 3;
    managers.push(new BotManager(w, botIds(0), o.diff[0], s0, o.skill?.[0]));
    managers.push(new BotManager(w, botIds(1), o.diff[1], s1, o.skill?.[1]));
  }
  const inputs: ControlState[] = [];
  for (let i = 0; i < n; i++) inputs.push(makeControlState());
  const cars: CarMetrics[] = w.cars.map((c) => ({
    id: c.id,
    team: c.team,
    touches: 0,
    aerialTouches: 0,
    goals: 0,
    ownGoals: 0,
    shots: 0,
    saves: 0,
    demos: 0,
    pulses: 0,
    pulseHits: 0,
    supersonicSec: 0,
    avgBoost: 0,
    playingSec: 0,
    maxStuck: 0,
    maxStill: 0,
    modeSec: {},
  }));
  const stuckRun = new Array(n).fill(0);
  const stillRun = new Array(n).fill(0);
  const events: Record<string, number> = {};
  const kickoffTouch: number[] = [];
  const kickoffTimes: number[] = [];
  const goalEvents: MatchMetrics['goalEvents'] = [];
  let kickoffAt = -1;
  let lastHit: { t: number; id: number; z: number; hitMode: string; defModes: string[] } | null = null;
  let playingSec = 0;
  const dc: [number, number] = [0, 0];
  let nan = false;
  let updMax = 0;
  let updSum = 0;
  let updN = 0;
  const trace: MatchMetrics['trace'] = o.trace ? [] : undefined;
  const clips: MatchMetrics['clips'] = o.goalClips ? [] : undefined;
  const ring: ClipFrame[] = [];
  const maxTicks = Math.round((o.maxSimSec ?? (cfg.durationSec + 240)) * SIM_HZ);
  const dt = 1 / SIM_HZ;
  let ticks = 0;
  while (w.match.phase !== 'ended' && ticks < maxTicks) {
    if (o.human) o.human(w, inputs[0]);
    const t0 = performance.now();
    for (const m of managers) m.update(w, inputs);
    const ms = performance.now() - t0;
    if (w.match.phase === 'playing') {
      updSum += ms;
      updN++;
      if (ms > updMax && ticks > 600) updMax = ms;
    }
    w.step(inputs);
    ticks++;
    const playing = w.match.phase === 'playing';
    for (const e of w.drainEvents()) {
      events[e.type] = (events[e.type] ?? 0) + 1;
      switch (e.type) {
        case 'kickoff':
          kickoffAt = w.time;
          kickoffTimes.push(w.time);
          break;
        case 'ballHit': {
          let hitMode = 'human';
          for (const m of managers) {
            const st = m.botState(e.carId);
            if (st) hitMode = st.mode;
          }
          lastHit = { t: w.time, id: e.carId, z: e.pos.z, hitMode, defModes: w.cars.filter((c) => c.team !== e.team).map((c) => {
            for (const m of managers) {
              const st = m.botState(c.id);
              if (st) return st.mode;
            }
            return 'human';
          }) };
          const cm = cars[e.carId];
          cm.touches++;
          if (e.aerial) cm.aerialTouches++;
          if (kickoffAt >= 0) {
            kickoffTouch.push(w.time - kickoffAt);
            kickoffAt = -1;
          }
          break;
        }
        case 'pulse':
          cars[e.carId].pulses++;
          if (e.hitBall) {
            cars[e.carId].pulseHits++;
            cars[e.carId].touches++;
            if (kickoffAt >= 0) {
              kickoffTouch.push(w.time - kickoffAt);
              kickoffAt = -1;
            }
          }
          break;
        case 'goal':
          goalEvents.push({
            team: e.team,
            ownGoal: e.ownGoal,
            points: e.points,
            scorerId: e.scorerId,
            t: w.time,
            ballSpeed: e.ballSpeed,
            sinceTouch: lastHit ? w.time - lastHit.t : -1,
            touchDist: lastHit ? 50 - Math.abs(lastHit.z) : -1,
            lastToucher: lastHit ? lastHit.id : -1,
            hitMode: lastHit ? lastHit.hitMode : '',
            defModes: lastHit ? lastHit.defModes : [],
          });
          if (clips) clips.push({ team: e.team, scorerId: e.scorerId, frames: ring.slice() });
          if (e.scorerId >= 0) cars[e.scorerId].goals++;
          else {
            // own goal: credit the last toucher of the other team
            const lt = w.ball.lastTouchCarId;
            if (lt >= 0) cars[lt].ownGoals++;
          }
          break;
        case 'shot':
          cars[e.carId].shots++;
          break;
        case 'save':
          cars[e.carId].saves++;
          break;
        case 'demolish':
          cars[e.attackerId].demos++;
          break;
      }
    }
    if (playing) {
      playingSec += dt;
      const b = w.ball;
      if (!Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.vel.x + b.vel.y + b.vel.z)) nan = true;
      const near = [0, 0];
      for (let i = 0; i < n; i++) {
        const c = w.cars[i];
        const cm = cars[i];
        if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.x + c.quat.w)) nan = true;
        cm.playingSec += dt;
        cm.avgBoost += c.boost * dt;
        if (c.supersonic) cm.supersonicSec += dt;
        if (!c.demolished && c.pos.distanceTo(b.pos) < 6) near[c.team]++;
        let st: { mode: string; role: string; target: { x: number; y: number; z: number } } | null = null;
        for (const m of managers) st = st ?? m.botState(i);
        if (st) {
          const key = ts > 1 ? `${st.role[0]}:${st.mode}` : st.mode;
          cm.modeSec[key] = (cm.modeSec[key] ?? 0) + dt;
        }
        const slow = c.vel.length() < 1 && !c.demolished;
        stillRun[i] = slow ? stillRun[i] + dt : 0;
        if (stillRun[i] > cm.maxStill) cm.maxStill = stillRun[i];
        const far = st ? Math.hypot(st.target.x - c.pos.x, st.target.z - c.pos.z) > 5 : false;
        stuckRun[i] = slow && far ? stuckRun[i] + dt : 0;
        if (stuckRun[i] > cm.maxStuck) cm.maxStuck = stuckRun[i];
      }
      if (ts > 1) {
        if (near[0] >= 2) dc[0] += dt;
        if (near[1] >= 2) dc[1] += dt;
      }
    }
    if (clips && ticks % 6 === 0 && playing) {
      ring.push({
        t: w.time,
        b: [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z],
        c: w.cars.map((c) => {
          let mode = 'human';
          for (const m of managers) {
            const st = m.botState(c.id);
            if (st) mode = `${st.mode}[${st.role[0]}]`;
          }
          return [c.pos.x, c.pos.y, c.pos.z, mode] as [number, number, number, string];
        }),
      });
      if (ring.length > 80) ring.shift();
    }
    if (trace && ticks % 6 === 0) {
      trace.push({
        t: w.time,
        b: [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z],
        c: w.cars.map((c) => [c.pos.x, c.pos.y, c.pos.z] as [number, number, number]),
      });
    }
  }
  for (const c of cars) {
    c.avgBoost = c.playingSec > 0 ? c.avgBoost / c.playingSec : 0;
    for (const m of managers) {
      const st = m.botStats(c.id);
      if (st) c.maneuvers = st;
    }
  }
  return {
    opts: { teamSize: ts, diff: o.diff, seed: o.seed },
    score: [w.match.score[0], w.match.score[1]],
    goals: [goalEvents.filter((g) => g.team === 0).length, goalEvents.filter((g) => g.team === 1).length],
    goalEvents,
    winner: w.match.winner,
    overtime: w.match.overtime,
    simSec: ticks / SIM_HZ,
    playingSec,
    kickoffTouch,
    kickoffTimes,
    cars,
    doubleCommitSec: dc,
    nan,
    updateMsAvg: updN ? updSum / updN : 0,
    updateMsMax: updMax,
    events,
    trace,
    clips,
  };
}

/** Compact one-line summary of a match. */
export function summarize(m: MatchMetrics): string {
  const touches = m.cars.map((c) => c.touches).join('/');
  const ko = m.kickoffTouch.length ? (m.kickoffTouch.reduce((a, b) => a + b, 0) / m.kickoffTouch.length).toFixed(2) : '-';
  const og = m.goalEvents.filter((g) => g.ownGoal).length;
  return (
    `${m.opts.teamSize}v${m.opts.teamSize} ${m.opts.diff[0]} vs ${m.opts.diff[1]} seed ${m.opts.seed}: ` +
    `score ${m.score[0]}-${m.score[1]} goals ${m.goals[0]}-${m.goals[1]} (og ${og})${m.overtime ? ' OT' : ''} | touches ${touches} | ` +
    `ko ${ko}s | stuck max ${Math.max(...m.cars.map((c) => c.maxStuck)).toFixed(1)}s | upd ${m.updateMsAvg.toFixed(3)}ms`
  );
}
