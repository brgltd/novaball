/**
 * Scenario lab CLI: success rates of one bot per scenario kind.
 *   node <bundle> <difficulty> <kinds comma-separated> [n] [seconds]
 */
import { BotRng } from '../../../src/ai/math';
import type { Difficulty } from '../../../src/sim/types';
import { makeSetup, runLab, type ScenarioKind } from '../lab';

const a = process.argv.slice(2);
const diff = (a[0] ?? 'pro') as Difficulty;
const kinds = (a[1] ?? 'openNet,rolling,bouncing,high,save,sideShot').split(',') as ScenarioKind[];
const N = Number(a[2] ?? 60);
const secs = Number(a[3] ?? 7);
for (const kind of kinds) {
  const rng = new BotRng(1234 + kind.length);
  let touched = 0, scored = 0, own = 0, tSum = 0, jumps = 0, aerial = 0, fwd = 0, conceded = 0, onT = 0;
  const modes: Record<string, number> = {};
  const errs: number[] = [];
  const fails: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = makeSetup(kind, rng);
    const r = runLab(s, diff, secs, 100 + i);
    if (r.onTarget) onT++;
    if (Number.isFinite(r.aimErrDeg)) errs.push(r.aimErrDeg);
    if (process.env.ERRS && Math.abs(r.aimErrDeg) > 12) console.log(`   #${i} aim err ${r.aimErrDeg.toFixed(0)}° mode ${r.touchMode} ball ${r.touchBall.map((x) => x.toFixed(1)).join(',')}`);
    if (r.touched) modes[r.touchMode] = (modes[r.touchMode] ?? 0) + 1;
    if (r.touched) {
      touched++;
      tSum += r.tTouch;
      if (r.vAfter.z > 0) fwd++;
    }
    if (process.env.NOTOUCH && !r.touched) console.log(`   #${i} never touched`);
    if (r.scored) scored++;
    else if (kind !== 'save') fails.push(i);
    if (kind === 'save' && r.ownGoal) fails.push(i);
    if (r.ownGoal) own++;
    if (kind === 'save' && r.ownGoal) conceded++;
    jumps += r.jumps;
    if (r.aerialTouch) aerial++;
  }
  console.log(
    `${diff} ${kind.padEnd(9)} touched ${((100 * touched) / N).toFixed(0)}%  t≈${(tSum / Math.max(1, touched)).toFixed(2)}s  ` +
      `ball upfield ${((100 * fwd) / Math.max(1, touched)).toFixed(0)}%  scored ${((100 * scored) / N).toFixed(0)}%  own ${((100 * own) / N).toFixed(0)}%  ` +
      `jumps/run ${(jumps / N).toFixed(1)}  aerialTouch ${aerial}  onTarget ${((100 * onT) / N).toFixed(0)}%`,
  );
  if (process.env.MODES) console.log('   touch modes:', JSON.stringify(modes));
  if (errs.length) {
    const abs = errs.map(Math.abs).sort((x, y) => x - y);
    const mean = errs.reduce((x, y) => x + y, 0) / errs.length;
    console.log(`   aim error: mean ${mean.toFixed(1)}°, median |err| ${abs[abs.length >> 1].toFixed(1)}°, p80 ${abs[Math.floor(abs.length * 0.8)].toFixed(1)}°`);
    if (process.env.ERRS) console.log('   errs:', errs.map((e) => e.toFixed(0)).join(' '));
  }
  if (process.env.FAILS) console.log('   not scored:', fails.slice(0, 30).join(','));
}
