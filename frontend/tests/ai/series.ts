/**
 * Side-swapped, paired difficulty series (the statistical AI tests): every seed is played twice — the stronger side as
 * team 0, then as team 1 — so kickoff-spot / seed / side effects cancel within each pair. Matches run in parallel on
 * worker threads (parallel.ts). Every assertion message carries the measured stats (describeSeries).
 */
import type { Difficulty, TeamSize } from '../../src/sim/types';
import { runMatches, type ParallelJob } from './parallel';

export interface SeriesResult {
  label: string;
  matches: number;
  goalsStrong: number;
  goalsWeak: number;
  winsStrong: number;
  winsWeak: number;
  draws: number;
  /** Mean goal difference per match (strong − weak). */
  gdPerMatch: number;
  winRate: number;
  /** goalsStrong / (goalsStrong + goalsWeak). */
  goalShare: number;
  touchesPerMinStrong: number;
  touchesPerMinWeak: number;
  ownGoals: number;
}

export async function pairedSeries(strong: Difficulty, weak: Difficulty, teamSize: TeamSize, seeds: number[], durationSec = 150): Promise<SeriesResult> {
  const jobs: ParallelJob[] = [];
  for (const seed of seeds) {
    jobs.push({ teamSize, diff: [strong, weak], seed, durationSec });
    jobs.push({ teamSize, diff: [weak, strong], seed, durationSec });
  }
  const res = await runMatches(jobs);
  let gs = 0;
  let gw = 0;
  let ws = 0;
  let ww = 0;
  let ts = 0;
  let tw = 0;
  let own = 0;
  for (let i = 0; i < res.length; i++) {
    const m = res[i];
    const side = i % 2; // the strong team: 0, then 1
    gs += m.goals[side];
    gw += m.goals[1 - side];
    if (m.winner === side) ws++;
    else if (m.winner === 1 - side) ww++;
    own += m.goalEvents.filter((g) => g.ownGoal).length;
    for (const c of m.cars) {
      const per = c.playingSec > 0 ? (c.touches * 60) / c.playingSec : 0;
      if (c.team === side) ts += per;
      else tw += per;
    }
  }
  const n = res.length;
  const r: SeriesResult = {
    label: `${teamSize}v${teamSize} ${strong} vs ${weak} (${seeds.length} seeds × 2 sides × ${durationSec} s)`,
    matches: n,
    goalsStrong: gs,
    goalsWeak: gw,
    winsStrong: ws,
    winsWeak: ww,
    draws: n - ws - ww,
    gdPerMatch: (gs - gw) / n,
    winRate: ws / n,
    goalShare: gs / Math.max(1, gs + gw),
    touchesPerMinStrong: ts / (n * teamSize),
    touchesPerMinWeak: tw / (n * teamSize),
    ownGoals: own,
  };
  console.info(`[ai] ${describeSeries(r)}`);
  return r;
}

export function describeSeries(r: SeriesResult): string {
  return (
    `${r.label}: goals ${r.goalsStrong}-${r.goalsWeak} (share ${r.goalShare.toFixed(2)}, GD/match ${r.gdPerMatch >= 0 ? '+' : ''}${r.gdPerMatch.toFixed(2)}), ` +
    `wins ${r.winsStrong}-${r.winsWeak}-${r.draws} (rate ${r.winRate.toFixed(2)}), touches/min ${r.touchesPerMinStrong.toFixed(1)} vs ${r.touchesPerMinWeak.toFixed(1)}, own goals ${r.ownGoals}`
  );
}
