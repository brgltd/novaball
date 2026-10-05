/**
 * The bots are deterministic given (world, seed): same seed ⇒ identical world hash; different seed ⇒ different game.
 * They write inputs only for their own car ids.
 */
import { describe, expect, it } from 'vitest';
import { BotManager } from '../../src/ai/BotManager';
import type { ControlState } from '../../src/sim/types';
import { makeControlState } from '../../src/sim/types';
import { World } from '../../src/sim/world';
import { makeConfig } from './harness';

function play(seed: number, botSeed: number, ticks: number): number {
  const w = new World(makeConfig({ teamSize: 2, diff: ['pro', 'pro'], seed }));
  const bots = new BotManager(w, [0, 1, 2, 3], 'legend', botSeed);
  const inputs: ControlState[] = w.cars.map(() => makeControlState());
  for (let i = 0; i < ticks; i++) {
    bots.update(w, inputs);
    w.step(inputs);
    w.drainEvents();
  }
  return w.hash();
}

describe('determinism', () => {
  it('same seeds ⇒ identical game; different bot seed ⇒ different game', () => {
    const a = play(5, 77, 120 * 40);
    const b = play(5, 77, 120 * 40);
    const c = play(5, 78, 120 * 40);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('writes only its own bots’ inputs (and creates missing entries)', () => {
    const w = new World(makeConfig({ teamSize: 2, diff: ['pro', 'pro'], seed: 1, human: () => {} }));
    const bots = new BotManager(w, [1, 2, 3], 'pro', 1);
    const human = makeControlState();
    human.throttle = 0.37;
    human.steer = -0.2;
    const inputs: ControlState[] = [human];
    for (let i = 0; i < 400; i++) {
      bots.update(w, inputs);
      w.step(inputs);
    }
    expect(inputs[0]).toBe(human);
    expect(inputs[0].throttle).toBe(0.37);
    expect(inputs[0].steer).toBe(-0.2);
    for (const id of [1, 2, 3]) expect(inputs[id]).toBeDefined();
    expect(typeof bots.debugInfo()).toBe('string');
  });

  it('no bots / free play: update is a no-op', () => {
    const w = new World(makeConfig({ teamSize: 1, diff: ['pro', 'pro'], seed: 1, human: () => {} }));
    const bots = new BotManager(w, [], 'pro', 1);
    const inputs: ControlState[] = [makeControlState()];
    bots.update(w, inputs);
    expect(inputs.length).toBe(1);
  });
});
