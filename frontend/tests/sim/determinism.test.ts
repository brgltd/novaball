import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM_HZ } from '../../src/sim/constants';
import type { ControlState, MatchConfig, SimEvent } from '../../src/sim/types';
import { copyControlState, makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { ChaseBots } from './bots';
import { config } from './helpers';

function cfg3v3(seed: number): MatchConfig {
  // 125 s ⇒ a ZERO-G surge warning ~2 s into play: the 20 s window covers warning → active → end
  return config({ teamSize: 3, durationSec: 125, seed, player: null });
}

describe('determinism', () => {
  it('same config + same input sequence ⇒ identical hash() on every tick (20 s of 3v3 chaos)', () => {
    const a = new World(cfg3v3(1234));
    const b = new World(cfg3v3(1234));
    const bots = new ChaseBots(6, 777);
    const evCount: Record<string, number> = {};
    const inputsCopy = a.cars.map(() => makeControlState());
    expect(a.hash()).toBe(b.hash());
    for (let i = 0; i < 20 * SIM_HZ; i++) {
      const inp = bots.update(a);
      inp.forEach((c, k) => copyControlState(c, inputsCopy[k]));
      a.step(inp);
      b.step(inputsCopy);
      const ha = a.hash();
      const hb = b.hash();
      if (ha !== hb) throw new Error(`hash diverged at tick ${a.tick}`);
      for (const e of a.drainEvents()) evCount[e.type] = (evCount[e.type] ?? 0) + 1;
      b.drainEvents();
    }
    // the run must actually exercise the interesting paths
    expect(evCount.ballHit ?? 0).toBeGreaterThan(2);
    expect(evCount.jump ?? 0).toBeGreaterThan(5);
    expect(evCount.dodge ?? 0).toBeGreaterThan(2);
    expect(evCount.pulse ?? 0).toBeGreaterThan(1);
    expect(evCount.chargeChange ?? 0).toBeGreaterThan(0);
    expect(evCount.boostPickup ?? 0).toBeGreaterThan(3);
    expect(evCount.surgeStart ?? 0).toBe(1);
    expect(evCount.carBump ?? 0).toBeGreaterThan(0);
    expect(a.cars.map((c) => c.pos.toArray())).toEqual(b.cars.map((c) => c.pos.toArray()));
  });

  it('replaying a recorded input log reproduces the final hash (on-chain verification path)', () => {
    const live = new World(cfg3v3(99));
    const bots = new ChaseBots(6, 5);
    const log: ControlState[][] = [];
    const liveEvents: SimEvent[] = [];
    for (let i = 0; i < 15 * SIM_HZ; i++) {
      const inp = bots.update(live);
      log.push(inp.map((c) => copyControlState(c, makeControlState())));
      live.step(inp);
      liveEvents.push(...live.drainEvents());
    }
    const replay = new World(cfg3v3(99));
    const replayEvents: SimEvent[] = [];
    for (const inp of log) {
      replay.step(inp);
      replayEvents.push(...replay.drainEvents());
    }
    expect(replay.hash()).toBe(live.hash());
    expect(JSON.stringify(replayEvents)).toBe(JSON.stringify(liveEvents));
    expect(replay.match.score).toEqual(live.match.score);
  });

  it('different seed ⇒ different world', () => {
    const a = new World(cfg3v3(1));
    const b = new World(cfg3v3(2));
    expect(a.hash()).not.toBe(b.hash());
    // and the difference is real (kickoff layouts / names / RNG streams differ over several seeds)
    const layouts = new Set<string>();
    for (let s = 1; s <= 12; s++) {
      const w = new World(cfg3v3(s));
      layouts.add(w.cars.map((c) => `${c.pos.x},${c.pos.z}`).join('|'));
    }
    expect(layouts.size).toBeGreaterThan(3);
  });

  it('hash reacts to any state change', () => {
    const w = new World(cfg3v3(3));
    const h0 = w.hash();
    w.cars[4].boost += 1e-12;
    expect(w.hash()).not.toBe(h0);
    w.cars[4].boost -= 1e-12;
    w.cars[2].jumpLock = !w.cars[2].jumpLock;
    expect(w.hash()).not.toBe(h0);
  });

  it('sim source obeys the determinism rules (no trig / pow / random / clock in state-evolving code)', () => {
    const dir = join(__dirname, '../../src/sim');
    // snapshot.ts only interpolates for rendering; arena.ts is the (deterministic) contract SDF with render helpers.
    const exempt = new Set(['snapshot.ts', 'arena.ts']);
    const forbidden: Array<[RegExp, string]> = [
      [/Math\.random/, 'Math.random'],
      [/\bDate\b/, 'Date'],
      [/performance\.now/, 'performance.now'],
      [/Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|pow|log|log2|log10|log1p|hypot|cbrt|sinh|cosh|tanh)\b/, 'transcendental Math'],
      [/\*\*/, '** operator'],
      [/setFromAxisAngle|setFromEuler|\.slerp\(|slerpQuaternions|angleTo|makeRotation|applyAxisAngle|applyEuler/, 'non-arithmetic three.js API'],
    ];
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !exempt.has(f));
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/'[^'\n]*'/g, "''");
      for (const [re, what] of forbidden) {
        if (re.test(src)) throw new Error(`${f}: uses ${what}`);
      }
    }
  });

  it('tolerates malformed inputs (NaN / out-of-range axes, missing entries, shared objects)', () => {
    const w = new World(cfg3v3(8));
    const junk = { ...makeControlState(), throttle: NaN, steer: 7, pitch: -Infinity, yaw: NaN, roll: 3, boost: true, jump: true };
    const inputs: ControlState[] = [junk, junk]; // cars 2..5 missing ⇒ neutral
    for (let i = 0; i < 10 * SIM_HZ; i++) {
      junk.jump = (i & 32) !== 0;
      w.step(inputs);
    }
    for (const c of w.cars) {
      expect(Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.length() + c.quat.w + c.angVel.length())).toBe(true);
    }
    expect(Number.isFinite(w.ball.pos.length())).toBe(true);
  });
});
