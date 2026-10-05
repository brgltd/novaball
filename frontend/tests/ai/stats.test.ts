/**
 * Difficulty scaling — TIER 2 (opt-in: AI_STATS=1 npx vitest run tests/ai/stats.test.ts). Large paired side-swapped
 * samples (150-s 1v1s, parallel). Thresholds come from the measured distributions (bootstrap of 100–60 measured
 * pairs per matchup): each check flips ≈ 0.6–1.3 % of the time on unrelated changes. Prints every measured stat.
 *
 * Measured with the current profiles (1v1, 150 s): legend vs rookie +0.9 goals / match, 77 % wins; pro vs rookie
 * 60 % wins but only ≈ +0.2 goals / match (PRO is tuned to be beatable by people — a casual player wins ≈ 25 % against
 * it, 4 % against LEGEND); legend vs pro is a coin flip between bots (51 % wins over 120 matches), so it is reported,
 * not asserted.
 */
import { describe, expect, it } from 'vitest';
import { describeSeries, pairedSeries } from './series';

const seeds = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + i * 7);

describe.skipIf(!process.env.AI_STATS)('difficulty scaling — tier 2 (AI_STATS=1)', () => {
  it('1v1 legend vs rookie (64 matches): clear margin', async () => {
    const r = await pairedSeries('legend', 'rookie', 1, seeds(32, 2001), 150);
    const msg = describeSeries(r);
    expect(r.gdPerMatch, msg).toBeGreaterThanOrEqual(0.3);
    expect(r.winRate, msg).toBeGreaterThanOrEqual(0.55);
    expect(r.goalShare, msg).toBeGreaterThanOrEqual(0.53);
  });

  it('1v1 pro vs rookie (96 matches): pro wins at least as many', async () => {
    const r = await pairedSeries('pro', 'rookie', 1, seeds(48, 3001), 150);
    const msg = describeSeries(r);
    expect(r.winsStrong, msg).toBeGreaterThanOrEqual(r.winsWeak);
  });

  it('1v1 legend vs pro (64 matches): reported', async () => {
    const r = await pairedSeries('legend', 'pro', 1, seeds(32, 4001), 150);
    expect(r.matches).toBe(64);
  });
});
