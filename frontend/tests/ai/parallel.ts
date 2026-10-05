/**
 * Run many headless matches in parallel on worker threads (the statistical AI tests).
 *
 * The worker (matchWorker.ts + the harness + src/sim + src/ai + three) is bundled ONCE per test file with rolldown (a
 * Vite dependency) into a temp dir: matches then run at native speed (≈ 3.5× faster than under vitest's module
 * transform) and in parallel. Falls back to running in-process, sequentially, if bundling isn't possible.
 * Bots are deterministic per engine, so a job gives the same result in a worker as in-process.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { MatchMetrics, MatchOpts } from './harness';
import { runMatch } from './harness';
import { makeChaser } from './human';

/** A serializable match job: MatchOpts without functions (the human stand-in is chosen by name). */
export type ParallelJob = Omit<MatchOpts, 'human'> & { humanKind?: 'chaser' };
export type LiteMetrics = Omit<MatchMetrics, 'trace' | 'clips'>;

let bundled: Promise<string | null> | null = null;

function workerBundle(): Promise<string | null> {
  if (!bundled) {
    bundled = (async () => {
      try {
        const { rolldown } = await import('rolldown');
        const dir = mkdtempSync(join(tmpdir(), 'novaball-ai-tests-'));
        process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
        const file = join(dir, 'match-worker.mjs');
        const input = join(dirname(fileURLToPath(import.meta.url)), 'matchWorker.ts');
        const b = await rolldown({ input, platform: 'node', logLevel: 'silent' });
        await b.write({ file, format: 'esm' });
        await b.close();
        return file;
      } catch (e) {
        console.warn(`[ai] parallel runner unavailable (${String(e)}): running matches in-process`);
        return null;
      }
    })();
  }
  return bundled;
}

/** Default worker count: a share of the machine (vitest runs other test files at the same time). */
export function defaultWorkers(): number {
  return Math.max(2, Math.min(8, Math.floor(cpus().length / 3)));
}

/** Run `jobs` (results in job order). */
export async function runMatches(jobs: ParallelJob[], workers = defaultWorkers()): Promise<LiteMetrics[]> {
  const out: LiteMetrics[] = new Array(jobs.length);
  const file = jobs.length > 1 ? await workerBundle() : null;
  if (!file) {
    for (let i = 0; i < jobs.length; i++) {
      const { humanKind, ...o } = jobs[i];
      const { trace: _t, clips: _c, ...lite } = runMatch({ ...o, human: humanKind === 'chaser' ? makeChaser() : undefined });
      out[i] = lite;
    }
    return out;
  }
  const n = Math.max(1, Math.min(workers, jobs.length));
  let next = 0;
  await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(file);
          const feed = (): void => {
            if (next >= jobs.length) {
              void w.terminate().then(() => resolve());
              return;
            }
            const i = next++;
            w.postMessage({ i, job: jobs[i] });
          };
          w.on('message', (msg: { i: number; m: LiteMetrics }) => {
            out[msg.i] = msg.m;
            feed();
          });
          w.on('error', reject);
          feed();
        }),
    ),
  );
  return out;
}
