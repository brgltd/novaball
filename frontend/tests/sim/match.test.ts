import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ARENA, BALL, BOT_NAMES, CAR, CHARGE, KICKOFF_SPOTS, MATCH, SIM_HZ, STAT_POINTS } from '../../src/sim/constants';
import type { SimEvent, Team } from '../../src/sim/types';
import { carIdsForTeam, makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { config, ctl, eventsOf, place, skipCountdown } from './helpers';

/**
 * Real touch: put car `id` right behind the ball (relative to `dir`) moving at `speed`, and step until it hits.
 * Returns all events emitted while doing so.
 */
function touch(w: World, id: number, ballPos: Vector3, dir: Vector3, speed = 12, maxSteps = 120): SimEvent[] {
  const d = dir.clone().setY(0).normalize();
  w.ball.pos.copy(ballPos);
  w.ball.vel.set(0, 0, 0);
  w.ball.angVel.set(0, 0, 0);
  const car = place(w, id, ballPos.x - d.x * 2.3, ballPos.z - d.z * 2.3, d.x, d.z, 50);
  car.vel.copy(d).multiplyScalar(speed);
  const evs: SimEvent[] = [];
  for (let i = 0; i < maxSteps; i++) {
    w.step([]);
    const e = w.drainEvents();
    evs.push(...e);
    if (e.some((x) => x.type === 'ballHit' && x.carId === id)) break;
  }
  return evs;
}

/** Park all cars far from the action. */
function parkAll(w: World): void {
  w.cars.forEach((c, i) => place(w, c.id, -30 + i * 4, -46 + (c.team === 1 ? 92 : 0) * 0, 0, 1, c.boost));
}

function stepUntil(w: World, pred: () => boolean, maxSec = 20): SimEvent[] {
  const evs: SimEvent[] = [];
  for (let i = 0; i < maxSec * SIM_HZ && !pred(); i++) {
    w.step([]);
    evs.push(...w.drainEvents());
  }
  return evs;
}

describe('match setup', () => {
  it('follows the car id convention, names and styles', () => {
    const w = new World(config({ teamSize: 3, seed: 99 }));
    expect(w.cars.length).toBe(6);
    expect(carIdsForTeam(3, 0).every((id) => w.cars[id].team === 0)).toBe(true);
    expect(carIdsForTeam(3, 1).every((id) => w.cars[id].team === 1)).toBe(true);
    expect(w.cars[0].name).toBe('TESTER');
    expect(w.cars[0].isBot).toBe(false);
    expect(w.cars[0].style).toBe('striker');
    const botNames = w.cars.slice(1).map((c) => c.name);
    expect(new Set(botNames).size).toBe(5);
    botNames.forEach((n) => expect(BOT_NAMES).toContain(n));
    w.cars.slice(1).forEach((c) => {
      expect(c.isBot).toBe(true);
      expect(['striker', 'viper', 'titan']).toContain(c.style);
    });
    // spectator mode: every car is a bot
    const spec = new World(config({ teamSize: 2, player: null }));
    expect(spec.cars.every((c) => c.isBot)).toBe(true);
    // free play: only the player
    const fp = new World(config({ freePlay: true }));
    expect(fp.cars.length).toBe(1);
    expect(fp.match.freePlay).toBe(true);
    expect(fp.match.clock).toBe(Infinity);
  });

  it('kickoff: mirrored spots facing the ball, 3v3 always has a diagonal, ball centered, boost 33', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const w = new World(config({ teamSize: 3, seed }));
      const t0 = w.cars.filter((c) => c.team === 0);
      const t1 = w.cars.filter((c) => c.team === 1);
      const kinds = t0.map((c) => KICKOFF_SPOTS.find((s) => s.x === c.pos.x && s.z === c.pos.z)?.kind);
      expect(kinds.every((k) => k !== undefined)).toBe(true);
      expect(kinds).toContain('diagonal');
      // team 1 = point mirror of team 0 (as sets)
      const key = (x: number, z: number) => `${x.toFixed(3)},${z.toFixed(3)}`;
      const s0 = new Set(t0.map((c) => key(-c.pos.x, -c.pos.z)));
      t1.forEach((c) => expect(s0.has(key(c.pos.x, c.pos.z))).toBe(true));
      for (const c of w.cars) {
        const toBall = new Vector3(-c.pos.x, 0, -c.pos.z).normalize();
        expect(c.fwd.dot(toBall)).toBeGreaterThan(0.9999);
        expect(c.up.y).toBeCloseTo(1, 9);
        expect(c.boost).toBe(CAR.boostStart);
        expect(c.pos.y).toBeCloseTo(CAR.rideHeight, 9);
      }
      expect(w.ball.pos.toArray()).toEqual([BALL.spawn.x, BALL.spawn.y, BALL.spawn.z]);
    }
  });

  it('countdown: 3-2-1-kickoff with everything frozen', () => {
    const w = new World(config({ teamSize: 2 }));
    const evs: SimEvent[] = w.drainEvents();
    const p0 = w.cars[0].pos.clone();
    const inputs = w.cars.map(() => ctl({ throttle: 1, boost: true, jump: true }));
    const times: Record<string, number> = {};
    for (let i = 1; i <= MATCH.countdown * SIM_HZ; i++) {
      w.step(inputs);
      for (const e of w.drainEvents()) {
        evs.push(e);
        times[e.type === 'countdown' ? `c${e.value}` : e.type] = i;
      }
      if (w.match.phase === 'countdown') expect(w.cars[0].pos.equals(p0)).toBe(true);
    }
    expect(eventsOf(evs, 'countdown').map((e) => e.value)).toEqual([3, 2, 1]);
    expect(times.c2).toBe(SIM_HZ);
    expect(times.c1).toBe(2 * SIM_HZ);
    expect(times.kickoff).toBe(3 * SIM_HZ);
    expect(w.match.phase).toBe('playing');
    // jump was held through the countdown ⇒ no jump at GO (edge needed)
    w.step(inputs);
    expect(eventsOf(w.drainEvents(), 'jump').length).toBe(0);
    expect(w.cars[0].vel.length()).toBeGreaterThan(0);
  });
});

describe('goals, charge and scoring', () => {
  it('ball into the +Z goal scores for team 0, into −Z for team 1; goal phase → kickoff reset', () => {
    for (const team of [0, 1] as Team[]) {
      const w = new World(config({ teamSize: 1, mutators: { charge: false, pulse: true, surges: false, demolitions: true } }));
      skipCountdown(w);
      w.drainEvents();
      parkAll(w);
      const id = team === 0 ? 0 : 1;
      const sign = team === 0 ? 1 : -1;
      const evs = touch(w, id, new Vector3(0, BALL.radius, sign * 40), new Vector3(0, 0, sign), 16);
      evs.push(...stepUntil(w, () => w.match.phase !== 'playing', 5));
      const goal = eventsOf(evs, 'goal')[0];
      expect(goal).toBeDefined();
      expect(goal.team).toBe(team);
      expect(goal.scorerId).toBe(id);
      expect(goal.points).toBe(1);
      expect(goal.ownGoal).toBe(false);
      expect(goal.ballSpeed).toBeGreaterThan(5);
      expect(w.match.score[team]).toBe(1);
      expect(w.match.score[team === 0 ? 1 : 0]).toBe(0);
      expect(w.match.phase).toBe('goal');
      expect(w.match.lastGoal).toEqual({ team, scorerId: id, points: 1 });
      expect(w.ball.exploded).toBe(true);
      expect(w.createSnapshot().ball.visible).toBe(false);
      expect(w.cars[id].stats.goals).toBe(1);
      expect(w.cars[id].stats.shots).toBeGreaterThanOrEqual(1);
      expect(w.cars[id].stats.score).toBeGreaterThanOrEqual(STAT_POINTS.goal + STAT_POINTS.shot);
      // cars can still drive during the goal phase
      const z = w.cars[0].pos.z;
      for (let i = 0; i < 60; i++) w.step([ctl({ throttle: 1 })]);
      expect(w.cars[0].pos.z).not.toBe(z);
      // after the goal phase: countdown with a fresh kickoff
      const e2 = stepUntil(w, () => w.match.phase === 'countdown', MATCH.goalPhase + 1);
      expect(w.match.phase).toBe('countdown');
      expect(eventsOf(e2, 'countdown')[0]?.value).toBe(3);
      expect(w.ball.exploded).toBe(false);
      expect(w.ball.pos.toArray()).toEqual([BALL.spawn.x, BALL.spawn.y, BALL.spawn.z]);
      expect(w.pads.every((p) => p.active)).toBe(true);
    }
  });

  it('CORE CHARGE: three team touches ⇒ SUPERNOVA goal worth 3; steal resets to I; decay', () => {
    const w = new World(config({ teamSize: 2 }));
    skipCountdown(w);
    w.drainEvents();
    parkAll(w);
    const changes: Array<{ team: number; level: number }> = [];
    const collect = (evs: SimEvent[]) => eventsOf(evs, 'chargeChange').forEach((e) => changes.push({ team: e.team, level: e.level }));
    // team 0: car 0, car 1, car 0 — each touch ≥ minTouchInterval apart
    collect(touch(w, 0, new Vector3(-10, BALL.radius, 0), new Vector3(1, 0, 0.2), 10));
    collect(stepUntil(w, () => false, CHARGE.minTouchInterval + 0.05));
    parkAll(w);
    collect(touch(w, 1, new Vector3(10, BALL.radius, 0), new Vector3(-1, 0, 0.2), 10));
    collect(stepUntil(w, () => false, CHARGE.minTouchInterval + 0.05));
    parkAll(w);
    expect(w.ball.charge).toBe(2);
    expect(w.ball.chargeTeam).toBe(0);
    // steal by team 1 (car 2)
    collect(touch(w, 2, new Vector3(0, BALL.radius, 10), new Vector3(0, 0, -1), 10));
    expect(w.ball.chargeTeam).toBe(1);
    expect(w.ball.charge).toBe(1);
    collect(stepUntil(w, () => false, CHARGE.minTouchInterval + 0.05));
    parkAll(w);
    // team 0 takes it back and chains to III
    collect(touch(w, 0, new Vector3(0, BALL.radius, -10), new Vector3(0, 0, 1), 8));
    collect(stepUntil(w, () => false, CHARGE.minTouchInterval + 0.05));
    parkAll(w);
    collect(touch(w, 1, new Vector3(5, BALL.radius, 0), new Vector3(0, 0, 1), 8));
    collect(stepUntil(w, () => false, CHARGE.minTouchInterval + 0.05));
    parkAll(w);
    const evs = touch(w, 0, new Vector3(0, BALL.radius, 38), new Vector3(0, 0, 1), 18);
    collect(evs);
    expect(w.ball.charge).toBe(3);
    evs.push(...stepUntil(w, () => w.match.phase !== 'playing', 5));
    const goal = eventsOf(evs, 'goal')[0];
    expect(goal.team).toBe(0);
    expect(goal.points).toBe(3);
    expect(goal.charge).toBe(3);
    expect(goal.scorerId).toBe(0);
    expect(goal.assistId).toBe(1);
    expect(w.match.score).toEqual([3, 0]);
    expect(w.cars[1].stats.assists).toBe(1);
    expect(changes.map((c) => `${c.team}:${c.level}`)).toEqual(['0:1', '0:2', '1:1', '0:1', '0:2', '0:3']);
    // kickoff reset neutralizes the charge
    const reset = stepUntil(w, () => w.match.phase === 'countdown', 4);
    expect(eventsOf(reset, 'chargeChange').at(-1)).toMatchObject({ team: -1, level: 0, prevLevel: 3 });
    expect(w.ball.charge).toBe(0);
    expect(w.ball.chargeTeam).toBe(-1);
  });

  it('charge ignores soft touches and rapid re-touches, and decays one level per decayTime', () => {
    const w = new World(config({ teamSize: 1 }));
    skipCountdown(w);
    w.drainEvents();
    parkAll(w);
    touch(w, 0, new Vector3(0, BALL.radius, 0), new Vector3(1, 0, 0), 1.5); // closing speed < 3 m/s
    expect(w.ball.charge).toBe(0);
    parkAll(w);
    touch(w, 0, new Vector3(0, BALL.radius, 0), new Vector3(1, 0, 0), 8);
    expect(w.ball.charge).toBe(1);
    const t0 = w.time;
    parkAll(w);
    touch(w, 0, new Vector3(-5, BALL.radius, 5), new Vector3(1, 0, 0), 8); // < 0.5 s later
    expect(w.time - t0).toBeLessThan(CHARGE.minTouchInterval);
    expect(w.ball.charge).toBe(1);
    // decay: park the ball in a corner-free spot, wait
    parkAll(w);
    w.ball.pos.set(0, BALL.radius, 0);
    w.ball.vel.set(0, 0, 0);
    const evs = stepUntil(w, () => w.ball.charge === 0, CHARGE.decayTime + 1);
    expect(w.ball.charge).toBe(0);
    expect(w.ball.chargeTeam).toBe(-1);
    expect(eventsOf(evs, 'chargeChange').at(-1)).toMatchObject({ team: -1, level: 0, prevLevel: 1 });
  });

  it('own goal: team 1 knocks the ball into its own net ⇒ 1 point for team 0, no scorer', () => {
    const w = new World(config({ teamSize: 1 }));
    skipCountdown(w);
    w.drainEvents();
    parkAll(w);
    const evs = touch(w, 1, new Vector3(0, BALL.radius, 40), new Vector3(0, 0, 1), 16);
    evs.push(...stepUntil(w, () => w.match.phase !== 'playing', 5));
    const goal = eventsOf(evs, 'goal')[0];
    expect(goal.team).toBe(0);
    expect(goal.ownGoal).toBe(true);
    expect(goal.scorerId).toBe(-1);
    expect(goal.points).toBe(1);
    expect(w.match.score).toEqual([1, 0]);
  });

  it('save: blocking a ball heading into your own goal', () => {
    const w = new World(config({ teamSize: 1 }));
    skipCountdown(w);
    w.drainEvents();
    parkAll(w);
    // ball flying at team 0's goal (−Z); team 0 car drives into its path from the side
    w.ball.pos.set(0, BALL.radius, -30);
    w.ball.vel.set(0, 0, -20);
    const car = place(w, 0, 0, -41, 0, 1);
    car.vel.set(0, 0, 8);
    const evs = stepUntil(w, () => false, 1.5);
    expect(eventsOf(evs, 'ballHit').length).toBeGreaterThan(0);
    const save = eventsOf(evs, 'save')[0];
    expect(save).toBeDefined();
    expect(save.carId).toBe(0);
    expect(w.cars[0].stats.saves).toBe(1);
    expect(eventsOf(evs, 'goal').length).toBe(0);
  });
});

describe('clock, overtime, match end, free play', () => {
  it('clock ticks the last 10 s; tie at 0:00 ⇒ overtime; first goal wins after the goal phase', () => {
    const w = new World(config({ teamSize: 1, durationSec: 12, mutators: { charge: true, pulse: true, surges: false, demolitions: true } }));
    skipCountdown(w);
    const evs = stepUntil(w, () => w.match.overtime, 13);
    expect(eventsOf(evs, 'clockTick').map((e) => e.secondsLeft)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(eventsOf(evs, 'overtime').length).toBe(1);
    expect(w.match.clock).toBe(0);
    expect(w.match.phase).toBe('countdown');
    skipCountdown(w);
    stepUntil(w, () => false, 2);
    expect(w.match.overtimeElapsed).toBeCloseTo(2, 6);
    expect(w.match.clock).toBe(0);
    w.drainEvents();
    parkAll(w);
    const e2 = touch(w, 1, new Vector3(0, BALL.radius, -40), new Vector3(0, 0, -1), 16);
    e2.push(...stepUntil(w, () => w.match.phase === 'ended', 8));
    expect(eventsOf(e2, 'goal')[0].team).toBe(1);
    expect(w.match.phase).toBe('ended');
    expect(w.match.winner).toBe(1);
    expect(eventsOf(e2, 'matchEnd')[0]?.winner).toBe(1);
    // the ended phase is terminal
    stepUntil(w, () => false, 10);
    expect(w.match.phase).toBe('ended');
  });

  it('different scores at 0:00 ⇒ match ends immediately', () => {
    const w = new World(config({ teamSize: 1, durationSec: 5 }));
    skipCountdown(w);
    w.match.score[0] = 2;
    const evs = stepUntil(w, () => w.match.phase === 'ended', 6);
    expect(w.match.phase).toBe('ended');
    expect(w.match.winner).toBe(0);
    expect(eventsOf(evs, 'matchEnd')).toEqual([{ type: 'matchEnd', winner: 0 }]);
    expect(eventsOf(evs, 'overtime').length).toBe(0);
  });

  it('the clock only runs while playing', () => {
    const w = new World(config({ teamSize: 1, durationSec: 60 }));
    expect(w.match.clock).toBe(60);
    skipCountdown(w);
    expect(w.match.clock).toBe(60);
    stepUntil(w, () => false, 1);
    expect(w.match.clock).toBeCloseTo(59, 9);
  });

  it('free play: never ends, goals respawn the ball at center, the car keeps its position', () => {
    const w = new World(config({ freePlay: true }));
    const evs0 = stepUntil(w, () => w.match.phase === 'playing', 3);
    expect(eventsOf(evs0, 'kickoff').length).toBe(1);
    expect(eventsOf(evs0, 'countdown').length).toBe(0);
    expect(w.cars[0].boost).toBe(100);
    // score a goal
    const evs = touch(w, 0, new Vector3(0, BALL.radius, 40), new Vector3(0, 0, 1), 16);
    evs.push(...stepUntil(w, () => w.match.phase === 'goal', 5));
    expect(eventsOf(evs, 'goal').length).toBe(1);
    // the car keeps driving through the goal phase and the ball respawn (no teleport to a kickoff spot)
    const prev = w.cars[0].pos.clone();
    let maxStep = 0;
    for (let i = 0; i < 5 * SIM_HZ && w.match.phase !== 'playing'; i++) {
      w.step([]);
      maxStep = Math.max(maxStep, w.cars[0].pos.distanceTo(prev));
      prev.copy(w.cars[0].pos);
    }
    w.step([]);
    maxStep = Math.max(maxStep, w.cars[0].pos.distanceTo(prev));
    expect(maxStep).toBeLessThan(0.3);
    expect(w.match.phase).toBe('playing');
    expect(w.ball.exploded).toBe(false);
    expect(w.ball.pos.distanceTo(new Vector3(BALL.spawn.x, BALL.spawn.y, BALL.spawn.z))).toBeLessThan(0.01);
    // run for a long time: never ends
    const inputs = [makeControlState()];
    for (let i = 0; i < 400 * SIM_HZ; i++) {
      inputs[0].throttle = (i >> 8) & 1 ? 1 : -1;
      inputs[0].steer = (i >> 9) & 1 ? 1 : 0;
      w.step(inputs);
    }
    expect(w.match.phase).not.toBe('ended');
    expect(w.match.clock).toBe(Infinity);
    // reset
    w.resetFreePlay();
    const c = w.cars[0];
    expect(c.pos.toArray()).toEqual([0, CAR.rideHeight, -20]);
    expect(c.fwd.z).toBeCloseTo(1, 9);
    expect(c.boost).toBe(100);
    expect(c.vel.length()).toBe(0);
    expect(w.ball.pos.toArray()).toEqual([BALL.spawn.x, BALL.spawn.y, BALL.spawn.z]);
    expect(w.ball.vel.length()).toBe(0);
    expect(w.match.phase).toBe('playing');
  });

  it('resetFreePlay cancels a goal phase', () => {
    const w = new World(config({ freePlay: true }));
    stepUntil(w, () => w.match.phase === 'playing', 3);
    w.ball.pos.set(0, 2, ARENA.halfLength + 3);
    w.ball.vel.set(0, 0, 5);
    stepUntil(w, () => w.match.phase === 'goal', 1);
    expect(w.match.phase).toBe('goal');
    w.resetFreePlay();
    expect(w.match.phase).toBe('playing');
    expect(w.ball.exploded).toBe(false);
  });
});
