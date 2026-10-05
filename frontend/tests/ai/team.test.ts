/**
 * Team play: roles are assigned and rotate, double commits stay rare, and bots yield to a human teammate.
 * (Both matches run in parallel on worker threads.)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { summarize } from './harness';
import { runMatches, type LiteMetrics } from './parallel';

describe('team play', () => {
  let m3: LiteMetrics;
  let mh: LiteMetrics;
  beforeAll(async () => {
    [m3, mh] = await runMatches([
      { teamSize: 3, diff: ['pro', 'pro'], seed: 4, durationSec: 150 },
      { teamSize: 2, diff: ['pro', 'pro'], seed: 2, durationSec: 150, humanKind: 'chaser' },
    ]);
  }, 120_000);

  it('3v3 pro vs pro: every role is used, teammates rarely double-commit, no one gets stuck', () => {
    const m = m3;
    const msg = summarize(m);
    console.info('[ai] ' + msg);
    expect(m.nan).toBe(false);
    for (const team of [0, 1]) {
      const roles = new Set<string>();
      for (const c of m.cars.filter((x) => x.team === team)) for (const k of Object.keys(c.modeSec)) roles.add(k[0]);
      expect(roles.has('a')).toBe(true);
      expect(roles.has('s')).toBe(true);
      expect(roles.has('d')).toBe(true);
      // two teammates within 6 m of the ball at once
      expect(m.doubleCommitSec[team] / m.playingSec, msg).toBeLessThan(0.05);
    }
    for (const c of m.cars) {
      expect(c.touches, msg).toBeGreaterThan(3);
      expect(c.maxStuck, msg).toBeLessThan(4);
    }
  });

  it('2v2 with a ball-chasing human teammate: the bot yields (few double commits) and still plays', () => {
    const m = mh;
    const msg = summarize(m);
    console.info('[ai] human team ' + msg);
    const mate = m.cars[1];
    expect(m.cars[0].touches, msg).toBeGreaterThan(5); // the human gets the ball
    expect(mate.touches, msg).toBeGreaterThan(5); // the bot still contributes
    expect(m.doubleCommitSec[0] / m.playingSec, msg).toBeLessThan(0.05);
    // the bot teammate spends most of its time off the ball (support / defender) when the human chases
    let att = 0;
    let tot = 0;
    for (const [k, v] of Object.entries(mate.modeSec)) {
      tot += v;
      if (k.startsWith('a:')) att += v;
    }
    expect(att / tot, msg).toBeLessThan(0.5);
  });
});
