/** 2v2 / 3v3 with a scripted human (car 0) on team 0: does the bot teammate yield? */
import type { TeamSize } from '../../../src/sim/types';
import { runMatch } from '../harness';
import { makeChaser } from '../human';
for (const ts of [2, 3] as TeamSize[]) {
  for (let s = 1; s <= 3; s++) {
    const m = runMatch({ teamSize: ts, diff: ['pro', 'pro'], seed: s, human: makeChaser() });
    const mate = m.cars.filter((c) => c.team === 0 && c.id !== 0);
    const roles: Record<string, number> = {};
    for (const c of mate) for (const [k, v] of Object.entries(c.modeSec)) roles[k[0]] = (roles[k[0]] ?? 0) + v;
    const tot = Object.values(roles).reduce((a, b) => a + b, 0);
    console.log(
      `${ts}v${ts} seed ${s}: score ${m.score} | human touches ${m.cars[0].touches}, mates ${mate.map((c) => c.touches).join('/')} | ` +
        `team0 double-commit ${((100 * m.doubleCommitSec[0]) / m.playingSec).toFixed(1)}% team1 ${((100 * m.doubleCommitSec[1]) / m.playingSec).toFixed(1)}% | ` +
        `mate roles ${Object.entries(roles).map(([k, v]) => `${k}:${((100 * v) / tot).toFixed(0)}%`).join(' ')}`,
    );
  }
}
