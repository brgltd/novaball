/** Jump-shot miss analysis: runs matches and prints where the ball was at the planned contact time. */
import { JUMPSHOT_MISS_LOG } from '../../../src/ai/maneuvers';
import { AI_DEBUG } from '../../../src/ai/maneuvers';
import { runMatch } from '../harness';
AI_DEBUG.log = true;
for (let s = 1; s <= 4; s++) runMatch({ teamSize: 1, diff: ['pro', 'pro'], seed: s });
const L = JUMPSHOT_MISS_LOG;
const hit = L.filter((x) => x[3] === 1);
const miss = L.filter((x) => x[3] === 0);
const stats = (a: typeof L, i: number) => {
  const v = a.map((x) => x[i]).sort((p, q) => p - q);
  return `${v[Math.floor(v.length * 0.1)]?.toFixed(1)}/${v[Math.floor(v.length * 0.5)]?.toFixed(1)}/${v[Math.floor(v.length * 0.9)]?.toFixed(1)}`;
};
console.log(`jump shots logged ${L.length}: touched-before-T ${hit.length}`);
console.log(`misses (p10/median/p90): forward ${stats(miss, 0)}  right ${stats(miss, 1)}  up ${stats(miss, 2)}`);
console.log(`hits   (p10/median/p90): forward ${stats(hit, 0)}  right ${stats(hit, 1)}  up ${stats(hit, 2)}`);
