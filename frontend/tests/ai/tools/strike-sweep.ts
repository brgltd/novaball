/** Sweep STRIKE_TUNING variants on the lab scenarios (legend + pro). */
import { STRIKE_TUNING } from '../../../src/ai/bot';
import { BotRng } from '../../../src/ai/math';
import type { Difficulty } from '../../../src/sim/types';
import { makeSetup, runLab, type ScenarioKind } from '../lab';

const base = { ...STRIKE_TUNING };
const variants: Array<[string, Partial<typeof STRIKE_TUNING>]> = JSON.parse(process.argv[2] ?? '[["base",{}]]');
const kinds: ScenarioKind[] = ['openNet', 'sideShot', 'rolling', 'bouncing'];
const N = 40;
for (const [name, v] of variants) {
  Object.assign(STRIKE_TUNING, base, v);
  const row: string[] = [];
  let total = 0;
  for (const diff of ['legend', 'pro'] as Difficulty[]) {
    for (const kind of kinds) {
      const rng = new BotRng(1234 + kind.length);
      let sc = 0;
      for (let i = 0; i < N; i++) if (runLab(makeSetup(kind, rng), diff, 7, 100 + i).scored) sc++;
      row.push(`${diff[0]}:${kind.slice(0, 5)} ${((100 * sc) / N).toFixed(0)}`);
      total += sc;
    }
  }
  console.log(`${name.padEnd(22)} total ${total}  | ${row.join('  ')}`);
}
