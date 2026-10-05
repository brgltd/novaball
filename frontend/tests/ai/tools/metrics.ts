/**
 * NOVABALL AI — METRICS table. Runs a batch of headless matches on worker threads and prints a markdown table.
 *
 *   npx rolldown tests/ai/tools/metrics.ts --file <tmp>/metrics.mjs --format esm --platform node
 *   node <tmp>/metrics.mjs [matchesPerMatchup=12] [workers=cpus-2] [durationSec=180]
 *
 * Every A-vs-B matchup alternates sides per seed (A plays team 0 on odd seeds), so side effects cancel.
 */
import { cpus } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { BotManager } from '../../../src/ai/BotManager';
import type { Difficulty, TeamSize } from '../../../src/sim/types';
import { makeControlState } from '../../../src/sim/types';
import { World } from '../../../src/sim/world';
import { makeConfig, runMatch, type MatchMetrics } from '../harness';

interface Job {
  key: string;
  teamSize: TeamSize;
  a: Difficulty;
  b: Difficulty;
  seed: number;
  aTeam: 0 | 1;
  dur: number;
}

type Lite = Omit<MatchMetrics, 'trace' | 'clips'>;

if (!isMainThread) {
  const jobs = workerData.jobs as Job[];
  for (const j of jobs) {
    const diff: [Difficulty, Difficulty] = j.aTeam === 0 ? [j.a, j.b] : [j.b, j.a];
    const m = runMatch({ teamSize: j.teamSize, diff, seed: j.seed, durationSec: j.dur });
    const { trace: _t, clips: _c, ...lite } = m;
    parentPort!.postMessage({ job: j, m: lite });
  }
  parentPort!.postMessage({ done: true });
} else {
  const per = Number(process.argv[2] ?? 12);
  const nWorkers = Number(process.argv[3] ?? Math.max(1, cpus().length - 2));
  const dur = Number(process.argv[4] ?? 180);
  const matchups: Array<[string, TeamSize, Difficulty, Difficulty]> = [
    ['1v1 pro vs pro', 1, 'pro', 'pro'],
    ['1v1 legend vs rookie', 1, 'legend', 'rookie'],
    ['1v1 pro vs rookie', 1, 'pro', 'rookie'],
    ['1v1 legend vs pro', 1, 'legend', 'pro'],
    ['2v2 pro vs pro', 2, 'pro', 'pro'],
    ['3v3 pro vs pro', 3, 'pro', 'pro'],
    ['3v3 legend vs rookie', 3, 'legend', 'rookie'],
    ['3v3 legend vs legend', 3, 'legend', 'legend'],
  ];
  const jobs: Job[] = [];
  for (const [key, ts, a, b] of matchups) {
    const n = ts === 3 ? Math.max(2, Math.round(per / 2)) : per;
    for (let s = 1; s <= n; s++) jobs.push({ key, teamSize: ts, a, b, seed: 1000 + s * 17 + ts, aTeam: (s % 2 === 1 ? 0 : 1) as 0 | 1, dur });
  }
  // longest first for load balance
  jobs.sort((x, y) => y.teamSize - x.teamSize);
  const buckets: Job[][] = Array.from({ length: nWorkers }, () => []);
  jobs.forEach((j, i) => buckets[i % nWorkers].push(j));
  const results: Array<{ job: Job; m: Lite }> = [];
  const t0 = Date.now();
  let running = 0;
  await new Promise<void>((resolve) => {
    for (const b of buckets) {
      if (!b.length) continue;
      running++;
      const w = new Worker(new URL(import.meta.url), { workerData: { jobs: b } });
      w.on('message', (msg: { done?: boolean; job?: Job; m?: Lite }) => {
        if (msg.done) {
          running--;
          if (running === 0) resolve();
        } else results.push({ job: msg.job!, m: msg.m! });
      });
      w.on('error', (e) => {
        console.error(e);
        running--;
        if (running === 0) resolve();
      });
    }
  });
  const wall = (Date.now() - t0) / 1000;

  // ---- update() cost, measured in isolation (6 bots, one manager)
  const perf: Record<string, string> = {};
  for (const d of ['rookie', 'pro', 'legend'] as Difficulty[]) {
    const w = new World(makeConfig({ teamSize: 3, diff: [d, d], seed: 5, durationSec: 300 }));
    const bots = new BotManager(w, [0, 1, 2, 3, 4, 5], d, 9);
    const inputs = w.cars.map(() => makeControlState());
    for (let i = 0; i < 120 * 12; i++) {
      bots.update(w, inputs);
      w.step(inputs);
      w.drainEvents();
    }
    const samples: number[] = [];
    let worst = 0;
    for (let i = 0; i < 120 * 30; i++) {
      const s0 = performance.now();
      bots.update(w, inputs);
      const dt = performance.now() - s0;
      samples.push(dt);
      if (dt > worst) worst = dt;
      w.step(inputs);
      w.drainEvents();
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    samples.sort((a, b) => a - b);
    perf[d] = `mean ${mean.toFixed(3)} ms, p99 ${samples[Math.floor(samples.length * 0.99)].toFixed(3)} ms, max ${worst.toFixed(3)} ms`;
  }

  // ---- aggregate
  const rows: string[] = [];
  const byKey = new Map<string, Array<{ job: Job; m: Lite }>>();
  for (const r of results) byKey.set(r.job.key, [...(byKey.get(r.job.key) ?? []), r]);
  const tpmByDiff: Record<string, number[]> = {};
  const ssByDiff: Record<string, number[]> = {};
  const aerialByDiff: Record<string, number[]> = {};
  let ko: number[] = [];
  let goalsTot = 0;
  let ownTot = 0;
  rows.push('| matchup | n | goals / match (A–B) | wins A–B–draw | touches / min (A / B) | aerial touches / match (A / B) | double-commit % (A / B) | supersonic % (A / B) | stuck max (s) |');
  rows.push('|---|---|---|---|---|---|---|---|---|');
  for (const [key, list] of byKey) {
    let ga = 0;
    let gb = 0;
    let wa = 0;
    let wb = 0;
    let dr = 0;
    const tA: number[] = [];
    const tB: number[] = [];
    let aA = 0;
    let aB = 0;
    let dcA = 0;
    let dcB = 0;
    let play = 0;
    const sA: number[] = [];
    const sB: number[] = [];
    let stuck = 0;
    for (const { job, m } of list) {
      const at = job.aTeam;
      ga += m.goals[at];
      gb += m.goals[1 - at];
      if (m.winner === at) wa++;
      else if (m.winner === 1 - at) wb++;
      else dr++;
      ko = ko.concat(m.kickoffTouch);
      goalsTot += m.goalEvents.length;
      ownTot += m.goalEvents.filter((g) => g.ownGoal).length;
      play += m.playingSec;
      dcA += m.doubleCommitSec[at];
      dcB += m.doubleCommitSec[1 - at];
      for (const c of m.cars) {
        const tpm = (c.touches * 60) / Math.max(1, c.playingSec);
        const ss = c.supersonicSec / Math.max(1, c.playingSec);
        const isA = c.team === at;
        const d = isA ? job.a : job.b;
        (isA ? tA : tB).push(tpm);
        (isA ? sA : sB).push(ss);
        if (isA) aA += c.aerialTouches;
        else aB += c.aerialTouches;
        (tpmByDiff[d] ??= []).push(tpm);
        (ssByDiff[d] ??= []).push(ss);
        (aerialByDiff[d] ??= []).push((c.aerialTouches * 180) / Math.max(1, c.playingSec));
        stuck = Math.max(stuck, c.maxStuck);
      }
    }
    const n = list.length;
    const avg = (x: number[]) => x.reduce((p, q) => p + q, 0) / Math.max(1, x.length);
    rows.push(
      `| ${key} | ${n} | ${(ga / n).toFixed(2)} – ${(gb / n).toFixed(2)} | ${wa}–${wb}–${dr} | ${avg(tA).toFixed(1)} / ${avg(tB).toFixed(1)} | ` +
        `${(aA / n).toFixed(1)} / ${(aB / n).toFixed(1)} | ${((100 * dcA) / play).toFixed(1)} / ${((100 * dcB) / play).toFixed(1)} | ` +
        `${(100 * avg(sA)).toFixed(1)} / ${(100 * avg(sB)).toFixed(1)} | ${stuck.toFixed(1)} |`,
    );
  }
  const avg = (x: number[] | undefined) => (x && x.length ? x.reduce((p, q) => p + q, 0) / x.length : 0);
  ko.sort((a, b) => a - b);
  console.log(`\nNOVABALL AI METRICS (${results.length} matches, ${dur} s each, ${wall.toFixed(0)} s wall on ${nWorkers} workers)\n`);
  console.log(rows.join('\n'));
  console.log('\n| per difficulty | touches / min | aerial touches / 3 min | supersonic % | update() 6 bots |');
  console.log('|---|---|---|---|---|');
  for (const d of ['rookie', 'pro', 'legend']) {
    console.log(`| ${d} | ${avg(tpmByDiff[d]).toFixed(1)} | ${avg(aerialByDiff[d]).toFixed(1)} | ${(100 * avg(ssByDiff[d])).toFixed(1)} | ${perf[d]} |`);
  }
  console.log(
    `\nkickoff first touch: mean ${avg(ko).toFixed(2)} s, median ${ko[ko.length >> 1]?.toFixed(2)} s, ${((100 * ko.filter((x) => x < 3.5).length) / Math.max(1, ko.length)).toFixed(0)} % < 3.5 s (n=${ko.length}) | own goals ${ownTot}/${goalsTot} (${((100 * ownTot) / Math.max(1, goalsTot)).toFixed(1)} %)`,
  );
}
