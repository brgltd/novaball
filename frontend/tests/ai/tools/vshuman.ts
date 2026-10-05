/** Bots against a scripted ball-chasing "human" (car 0) in 1v1 — per difficulty. */
import type { Difficulty } from '../../../src/sim/types';
import { runMatch } from '../harness';
import { makeChaser } from '../human';
for (const d of ['rookie', 'pro', 'legend'] as Difficulty[]) {
  let gh = 0, gb = 0, th = 0, tb = 0;
  for (let s = 1; s <= 4; s++) {
    const m = runMatch({ teamSize: 1, diff: [d, d], seed: s, human: makeChaser() });
    gh += m.goals[0];
    gb += m.goals[1];
    th += m.cars[0].touches;
    tb += m.cars[1].touches;
  }
  console.log(`${d} bot vs chaser human (4 matches): goals human ${gh} bot ${gb} | touches human ${th} bot ${tb}`);
}
