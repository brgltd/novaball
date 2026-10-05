/**
 * Full headless 1v1 matches (pro vs pro, 180 s, run in parallel): goals happen, both bots stay involved, nobody gets
 * stuck, kickoffs are contested quickly, own goals are rare, no NaNs.
 * Touch floors sit far below the measured distribution (≈ 30 ± 6 touches per car per 180 s; a broken / stuck bot has
 * < 5), so they catch real breakage without flipping on unrelated tuning.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { summarize } from './harness';
import { runMatches, type LiteMetrics } from './parallel';

const SEEDS = [1, 2, 3];

describe('1v1 pro vs pro — full matches', () => {
  let matches: LiteMetrics[] = [];
  beforeAll(async () => {
    matches = await runMatches(SEEDS.map((seed) => ({ teamSize: 1, diff: ['pro', 'pro'], seed, durationSec: 180 })));
  }, 120_000);

  SEEDS.forEach((seed, k) => {
    it(`seed ${seed}: plays a sane 3-minute match`, () => {
      const m = matches[k];
      const msg = summarize(m);
      console.info('[ai] ' + msg);
      expect(m.nan, msg).toBe(false);
      for (const c of m.cars) {
        expect(c.touches, msg).toBeGreaterThanOrEqual(12);
        // never stuck: slower than 1 m/s while its target is > 5 m away, for more than 4 s
        expect(c.maxStuck, msg).toBeLessThan(4);
      }
    });
  });

  it('across the seeds: involved bots, several goals, fast kickoffs, rare own goals', () => {
    expect(matches.length).toBe(SEEDS.length);
    const touches = matches.flatMap((m) => m.cars.map((c) => c.touches));
    const mean = touches.reduce((a, b) => a + b, 0) / touches.length;
    expect(mean, `touches per car ${touches.join(',')}`).toBeGreaterThanOrEqual(20);
    const goals = matches.reduce((a, m) => a + m.goalEvents.length, 0);
    expect(goals).toBeGreaterThanOrEqual(4);
    const ko = matches.flatMap((m) => m.kickoffTouch);
    const fast = ko.filter((t) => t < 3.5).length;
    expect(fast / ko.length, `kickoff first touches ${ko.map((t) => t.toFixed(2)).join(',')}`).toBeGreaterThanOrEqual(0.85);
    const own = matches.reduce((a, m) => a + m.goalEvents.filter((g) => g.ownGoal).length, 0);
    expect(own / goals).toBeLessThan(0.1);
  });
});
