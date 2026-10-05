/**
 * Difficulty scaling (tier 1, always on), 3v3: the legend team beats the rookie team and plays more of the ball.
 * Paired side-swapped series (6 seeds × 2 sides × 150 s, run in parallel); legend wins ≈ 84 % of these 3v3s, so the
 * checks flip ≈ 0.35 % of the time on unrelated changes (bootstrap over 96 measured matches).
 */
import { describe, expect, it } from 'vitest';
import { describeSeries, pairedSeries } from './series';

describe('difficulty scaling — 3v3', () => {
  it('legend team beats rookie team (more wins, more goals, more touches over 12 paired matches)', async () => {
    const r = await pairedSeries('legend', 'rookie', 3, [301, 302, 303, 304, 305, 306], 150);
    const msg = describeSeries(r);
    expect(r.winsStrong, msg).toBeGreaterThan(r.winsWeak);
    expect(r.goalsStrong, msg).toBeGreaterThan(r.goalsWeak);
    expect(r.touchesPerMinStrong, msg).toBeGreaterThan(r.touchesPerMinWeak * 1.1);
  });
});
