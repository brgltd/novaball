/**
 * NOVABALL audio — cooperative idle-time job runner.
 *
 * Heavy procedural synthesis (noise colors, reverb impulse responses, crowd-choir graphs and textures) is written as
 * generator "jobs" that yield every ≈ 0.1–3 ms of work. The queue runs them highest-priority-first in
 * requestIdleCallback slices (setTimeout fallback), so preparing audio never blocks the main thread for long — it
 * happens while the loading screen / attract mode leaves the thread idle. `IdleJob.now()` finishes one job
 * synchronously when its result is needed immediately (offline contexts, a gesture before the prebake is done).
 */

export type JobGen<T> = Generator<unknown, T, undefined>;

/** Longest slice taken from an idle period (ms). The rest of a long idle period stays free for input. */
const MAX_SLICE_MS = 10;
/** Slice when the idle-callback timeout forced us to run (the page never went idle): keep it short. */
const FORCED_SLICE_MS = 4;
/** Idle-callback timeouts: relaxed while prebaking, short once a result is awaited (after the audio unlock). */
const TIMEOUT_RELAXED_MS = 400;
const TIMEOUT_HURRY_MS = 60;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}
type RIC = (cb: (d: IdleDeadlineLike) => void, opts?: { timeout: number }) => number;
type CIC = (id: number) => void;

export class IdleJob<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (v: T) => void;
  private rejectFn!: (e: unknown) => void;
  private gen: JobGen<T> | null;
  private finished = false;
  private result: T | undefined = undefined;
  private error: unknown = undefined;
  private failed = false;
  private running = false;
  /** Duration of the last step (ms): the queue won't start a step it expects to overrun the slice. */
  lastStepMs = 0;

  constructor(
    readonly name: string,
    gen: JobGen<T>,
    public priority: number,
    readonly seq: number,
    private readonly queue: IdleQueue,
  ) {
    this.gen = gen;
    this.promise = new Promise<T>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
    // Nobody may be awaiting a job (fire-and-forget prebake): never surface as an unhandled rejection.
    this.promise.catch(() => undefined);
  }

  get done(): boolean {
    return this.finished;
  }

  /** The result once done (undefined before, or when the job failed / was cancelled). */
  get value(): T | undefined {
    return this.result;
  }

  get ok(): boolean {
    return this.finished && !this.failed;
  }

  /** A step of this job is executing right now (a nested now() must not re-enter the generator). */
  get busy(): boolean {
    return this.running;
  }

  /** Run one step. Returns true once the job is over (finished, failed or cancelled). */
  step(): boolean {
    if (this.finished || !this.gen) return true;
    if (this.running) return false; // re-entrant call from inside this job's own step: ignore
    this.running = true;
    const t0 = clock();
    try {
      const r = this.gen.next();
      if (r.done) this.settle(r.value);
    } catch (e) {
      this.fail(e);
    } finally {
      this.running = false;
    }
    this.lastStepMs = clock() - t0;
    return this.finished;
  }

  /** Finish synchronously (runs every remaining step in the current task) and return the result. Throws if it failed. */
  now(): T {
    if (!this.finished) this.queue.finishNow(this as IdleJob<unknown>);
    if (!this.finished) throw new Error(`idle job '${this.name}' re-entered`);
    if (this.failed) throw this.error instanceof Error ? this.error : new Error(String(this.error));
    return this.result as T;
  }

  /** Drop the job (pending steps are skipped). */
  cancel(): void {
    if (this.finished) return;
    this.fail(new Error(`idle job '${this.name}' cancelled`));
    this.queue.remove(this as IdleJob<unknown>);
  }

  private settle(v: T): void {
    this.finished = true;
    this.result = v;
    this.gen = null;
    this.resolveFn(v);
  }

  private fail(e: unknown): void {
    this.finished = true;
    this.failed = true;
    this.error = e;
    try {
      this.gen?.return(undefined as unknown as T);
    } catch {
      /* ignore */
    }
    this.gen = null;
    this.rejectFn(e);
  }
}

export interface IdleStats {
  /** Idle / timer slices run. */
  slices: number;
  steps: number;
  /** Total main-thread time spent in slices + synchronous finishes (ms). */
  totalMs: number;
  /** Longest slice (≈ longest main-thread task caused by background audio preparation). */
  maxSliceMs: number;
  maxStepMs: number;
  /** Job that ran the longest step. */
  maxStepJob: string;
  /** Same peaks since the last resetPeaks() (e.g. since the audio unlock). */
  peakSliceMs: number;
  peakStepMs: number;
  peakStepJob: string;
  /** Time spent finishing jobs synchronously (a result was needed before its idle work was done). */
  syncMs: number;
  maxSyncMs: number;
  jobsDone: number;
}

export class IdleQueue {
  private readonly jobs: Array<IdleJob<unknown>> = [];
  private seq = 0;
  private ricId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private hurryUntil = 0;
  readonly stats: IdleStats = {
    slices: 0,
    steps: 0,
    totalMs: 0,
    maxSliceMs: 0,
    maxStepMs: 0,
    maxStepJob: '',
    peakSliceMs: 0,
    peakStepMs: 0,
    peakStepJob: '',
    syncMs: 0,
    maxSyncMs: 0,
    jobsDone: 0,
  };

  /** Restart the peak (since-mark) statistics. */
  resetPeaks(): void {
    this.stats.peakSliceMs = 0;
    this.stats.peakStepMs = 0;
    this.stats.peakStepJob = '';
  }

  /** Queue a generator job. Higher priority runs first; FIFO within a priority. */
  run<T>(name: string, gen: JobGen<T>, priority = 0): IdleJob<T> {
    const job = new IdleJob<T>(name, gen, priority, this.seq++, this);
    this.jobs.push(job as IdleJob<unknown>);
    this.schedule();
    return job;
  }

  /** Queued jobs (not finished yet). */
  get pending(): number {
    return this.jobs.length;
  }

  /** Results are being awaited (e.g. right after the audio unlock): use short idle timeouts for a while. */
  hurry(ms = 3000): void {
    this.hurryUntil = clock() + ms;
    // Re-arm with the short timeout.
    if (this.ricId !== null) {
      const cic = (globalThis as unknown as { cancelIdleCallback?: CIC }).cancelIdleCallback;
      if (typeof cic === 'function') {
        cic(this.ricId);
        this.ricId = null;
      }
    }
    this.schedule();
  }

  /** Run a job to completion right now (plus bookkeeping). */
  finishNow(job: IdleJob<unknown>): void {
    if (job.busy) return;
    const t0 = clock();
    while (!job.step()) {
      /* keep stepping */
    }
    this.remove(job);
    const ms = clock() - t0;
    this.stats.syncMs += ms;
    this.stats.totalMs += ms;
    if (ms > this.stats.maxSyncMs) this.stats.maxSyncMs = ms;
  }

  remove(job: IdleJob<unknown>): void {
    const i = this.jobs.indexOf(job);
    if (i >= 0) {
      this.jobs.splice(i, 1);
      this.stats.jobsDone++;
    }
  }

  /** Finish every queued job synchronously (tests / teardown). */
  flush(): void {
    while (this.jobs.length) this.finishNow(this.pick());
  }

  private pick(): IdleJob<unknown> {
    let best = this.jobs[0];
    for (let i = 1; i < this.jobs.length; i++) {
      const j = this.jobs[i];
      if (j.priority > best.priority || (j.priority === best.priority && j.seq < best.seq)) best = j;
    }
    return best;
  }

  private schedule(): void {
    if (this.ricId !== null || this.timerId !== null || this.jobs.length === 0) return;
    const hurry = clock() < this.hurryUntil;
    const ric = (globalThis as unknown as { requestIdleCallback?: RIC }).requestIdleCallback;
    if (typeof ric === 'function') {
      this.ricId = ric((d) => {
        this.ricId = null;
        this.slice(d.didTimeout ? FORCED_SLICE_MS : Math.min(MAX_SLICE_MS, d.timeRemaining()));
      }, { timeout: hurry ? TIMEOUT_HURRY_MS : TIMEOUT_RELAXED_MS });
    } else if (typeof setTimeout === 'function') {
      // No idle callbacks (Safari): short slices on a timer.
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.slice(FORCED_SLICE_MS);
      }, hurry ? 0 : 12);
    }
  }

  private slice(budgetMs: number): void {
    const t0 = clock();
    const end = t0 + Math.max(1, budgetMs);
    let n = 0;
    try {
      while (this.jobs.length) {
        const job = this.pick();
        // Always make progress; after that, don't start a step expected to overrun the slice.
        if (n > 0 && clock() + Math.min(job.lastStepMs, 8) > end) break;
        const s0 = clock();
        if (job.step()) this.remove(job);
        const sd = clock() - s0;
        const st = this.stats;
        if (sd > st.maxStepMs) {
          st.maxStepMs = sd;
          st.maxStepJob = job.name;
        }
        if (sd > st.peakStepMs) {
          st.peakStepMs = sd;
          st.peakStepJob = job.name;
        }
        n++;
        if (clock() >= end) break;
      }
    } finally {
      const ms = clock() - t0;
      this.stats.slices++;
      this.stats.steps += n;
      this.stats.totalMs += ms;
      if (ms > this.stats.maxSliceMs) this.stats.maxSliceMs = ms;
      if (ms > this.stats.peakSliceMs) this.stats.peakSliceMs = ms;
      this.schedule();
    }
  }
}

/** The shared queue for all audio preparation (buffers are cached per page, like the crowd textures). */
export const idle = new IdleQueue();

/** Job priorities (higher first). */
export const PRIO = {
  /** Awaited right now: reverb IRs / convolver assignment for the live context just after the unlock. */
  live: 100,
  /** Noise sets: needed synchronously by the unlock (a gesture before they're done must finish them inline). */
  noise: 60,
  /** Crowd texture post-processing (its render is done). */
  crowdPost: 50,
  /** Crowd choir graphs (their offline renders run on another thread as soon as each graph is built). */
  crowd: 40,
  /** Reverb IRs for the likely device rates (assigned after the unlock). */
  reverb: 20,
} as const;
