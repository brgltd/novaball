/**
 * Difficulty scaling (tier 1, always on), 1v1: legend beats rookie. Paired side-swapped series (16 seeds × 2 sides ×
 * 150 s, run in parallel). Sized from the measured per-pair distribution (legend wins ≈ 77 % of 1v1s against rookie,
 * +0.9 goals / match): an unrelated physics / arena tweak flips this check ≈ 0.5 % of the time (bootstrap), while equal
 * difficulties can never pass it (a side-swapped pair of identical bots is the same match mirrored: an exact tie).
 * (3v3: difficulty-3v3.test.ts; larger opt-in samples incl. pro vs rookie: stats.test.ts with AI_STATS=1.)
 */
import { describe, expect, it } from 'vitest';
import { describeSeries, pairedSeries } from './series';

const SEEDS = Array.from({ length: 16 }, (_, i) => 101 + i);

describe('difficulty scaling — 1v1 legend vs rookie', () => {
  it('legend beats rookie (more wins and more goals over 32 paired matches)', async () => {
    const r = await pairedSeries('legend', 'rookie', 1, SEEDS, 150);
    const msg = describeSeries(r);
    expect(r.winsStrong, msg).toBeGreaterThan(r.winsWeak);
    expect(r.goalsStrong, msg).toBeGreaterThan(r.goalsWeak);
  });
});
