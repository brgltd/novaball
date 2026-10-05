/**
 * Worker-thread entry for tests/ai/parallel.ts: runs headless matches (tests/ai/harness.ts) sent by the main thread.
 * Bundled with rolldown at test time (native speed, no vitest module transform) — see parallel.ts.
 */
import { parentPort } from 'node:worker_threads';
import { runMatch } from './harness';
import { makeChaser } from './human';
import type { ParallelJob } from './parallel';

parentPort?.on('message', (msg: { i: number; job: ParallelJob }) => {
  const { humanKind, ...opts } = msg.job;
  const m = runMatch({ ...opts, human: humanKind === 'chaser' ? makeChaser() : undefined });
  const { trace: _t, clips: _c, ...lite } = m;
  parentPort!.postMessage({ i: msg.i, m: lite });
});
