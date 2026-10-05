/**
 * NOVABALL — instant-replay recorder + player.
 *
 * Recording (live play): a preallocated ring of WorldSnapshots at 60 Hz (every 2nd sim tick) plus a ring of the
 * sim events tagged with the tick they were emitted on. No allocation per tick (events are the sim's own objects,
 * which are never mutated after emission).
 *
 * Playback: a cursor in sim ticks advances with real time × a rate curve (full speed, easing into slow motion
 * around the goal moment). `sample()` interpolates the two surrounding snapshots; `forEachEvent()` re-emits the
 * gameplay events that happened between two cursor positions so VFX / audio / arena ripples replay too.
 */
import { SIM_HZ } from '../sim/constants';
import { lerpSnapshot, makeSnapshot } from '../sim/snapshot';
import type { SimEvent, WorldSnapshot } from '../sim/types';
import type { World } from '../sim/world';

/** Snapshot ring rate: one snapshot every REC_EVERY sim ticks (120 Hz / 2 = 60 Hz). */
const REC_EVERY = 2;
/** Seconds of history kept. */
const HISTORY_SEC = 9;
const SNAP_CAP = Math.ceil((HISTORY_SEC * SIM_HZ) / REC_EVERY);
const EVENT_CAP = 4096;

/** Events worth re-emitting during a replay (visual / audio gameplay feedback only). */
const REPLAY_EVENTS: ReadonlySet<SimEvent['type']> = new Set<SimEvent['type']>([
  'ballHit',
  'ballBounce',
  'carImpact',
  'carBump',
  'jump',
  'dodge',
  'land',
  'boostPickup',
  'demolish',
  'respawn',
  'pulse',
  'chargeChange',
  'goal',
]);

export class ReplayBuffer {
  private readonly snaps: WorldSnapshot[] = [];
  private readonly snapTicks = new Float64Array(SNAP_CAP);
  private head = 0; // next write slot
  private count = 0;
  private readonly events: Array<SimEvent | null> = new Array<SimEvent | null>(EVENT_CAP).fill(null);
  private readonly eventTicks = new Float64Array(EVENT_CAP);
  private evHead = 0;
  private evCount = 0;

  constructor(numCars: number, numPads: number) {
    for (let i = 0; i < SNAP_CAP; i++) this.snaps.push(makeSnapshot(numCars, numPads));
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.evHead = 0;
    this.evCount = 0;
    this.events.fill(null);
  }

  /** Call after every world.step(). */
  recordTick(world: World): void {
    if (world.tick % REC_EVERY !== 0) return;
    world.writeSnapshot(this.snaps[this.head]);
    this.snapTicks[this.head] = world.tick;
    this.head = (this.head + 1) % SNAP_CAP;
    if (this.count < SNAP_CAP) this.count++;
  }

  /** Record the events emitted during `tick` (the sim tick after which they were drained). */
  recordEvents(tick: number, events: ReadonlyArray<SimEvent>): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!REPLAY_EVENTS.has(e.type)) continue;
      this.events[this.evHead] = e;
      this.eventTicks[this.evHead] = tick;
      this.evHead = (this.evHead + 1) % EVENT_CAP;
      if (this.evCount < EVENT_CAP) this.evCount++;
    }
  }

  /** Oldest / newest recorded snapshot tick (NaN when empty). */
  get oldestTick(): number {
    if (this.count === 0) return Number.NaN;
    return this.snapTicks[(this.head - this.count + SNAP_CAP) % SNAP_CAP];
  }

  get newestTick(): number {
    if (this.count === 0) return Number.NaN;
    return this.snapTicks[(this.head - 1 + SNAP_CAP) % SNAP_CAP];
  }

  /** Interpolated snapshot at a (fractional) sim tick, clamped to the recorded range. Returns false when empty. */
  sample(tick: number, out: WorldSnapshot): boolean {
    if (this.count === 0) return false;
    const oldest = this.oldestTick;
    const newest = this.newestTick;
    const t = tick < oldest ? oldest : tick > newest ? newest : tick;
    // Slots are consecutive REC_EVERY ticks apart (the sim never skips ticks while recording).
    const back = (newest - t) / REC_EVERY;
    const bi = Math.floor(back);
    const frac = back - bi; // 0 → exactly slot (newest - bi)
    const idxB = (this.head - 1 - bi + SNAP_CAP * 2) % SNAP_CAP; // later slot
    if (frac <= 1e-6 || bi + 1 >= this.count) {
      lerpSnapshot(this.snaps[idxB], this.snaps[idxB], 0, out);
      return true;
    }
    const idxA = (idxB - 1 + SNAP_CAP) % SNAP_CAP; // earlier slot
    // out = lerp(A, B, 1 - frac)
    lerpSnapshot(this.snaps[idxA], this.snaps[idxB], 1 - frac, out);
    return true;
  }

  /** Calls fn for every recorded event with t0 < tick <= t1 (chronological), with the tick it was emitted on. */
  forEachEvent(t0: number, t1: number, fn: (e: SimEvent, tick: number) => void): void {
    if (this.evCount === 0 || t1 <= t0) return;
    const start = (this.evHead - this.evCount + EVENT_CAP) % EVENT_CAP;
    for (let k = 0; k < this.evCount; k++) {
      const i = (start + k) % EVENT_CAP;
      const tk = this.eventTicks[i];
      if (tk <= t0) continue;
      if (tk > t1) break;
      const e = this.events[i];
      if (e) fn(e, tk);
    }
  }
}

/** Playback parameters for one goal replay. */
export interface ReplayPlan {
  startTick: number;
  endTick: number;
  goalTick: number;
  /** Scoring team (the goal attacked by this team is where the ball went in). */
  team: 0 | 1;
  scorerId: number;
}

/**
 * Replay cursor with a cinematic rate curve: 1× until shortly before the goal, eased slow motion through the
 * goal moment, then back to 1×.
 */
export class ReplayPlayer {
  active = false;
  plan: ReplayPlan = { startTick: 0, endTick: 0, goalTick: 0, team: 0, scorerId: -1 };
  /** Current cursor (fractional sim tick). */
  pos = 0;
  /** Real seconds since the replay started. */
  elapsed = 0;

  private readonly slowFrom: number = 0.8 * SIM_HZ; // ticks before the goal where slow-mo is fully in
  private readonly slowTo: number = 0.02 * SIM_HZ; // ticks after the goal where slow-mo starts easing out
  private readonly ramp: number = 0.3 * SIM_HZ; // ramp length (ticks)
  private readonly slowRate = 0.4;

  start(plan: ReplayPlan): void {
    this.plan = plan;
    this.pos = plan.startTick;
    this.elapsed = 0;
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  /** Playback rate (sim ticks per real tick) at cursor position `p`. */
  rateAt(p: number): number {
    const g = this.plan.goalTick;
    const a = g - this.slowFrom; // fully slow from here
    const b = g + this.slowTo; // until here
    let k: number; // 1 = slow, 0 = full speed
    if (p < a - this.ramp || p > b + this.ramp) k = 0;
    else if (p < a) k = smooth((p - (a - this.ramp)) / this.ramp);
    else if (p <= b) k = 1;
    else k = 1 - smooth((p - b) / this.ramp);
    return 1 + (this.slowRate - 1) * k;
  }

  /** Advance by real dt; returns the previous cursor so the caller can emit events in (prev, pos]. */
  advance(realDt: number): number {
    const prev = this.pos;
    this.elapsed += realDt;
    this.pos = Math.min(this.plan.endTick, this.pos + realDt * SIM_HZ * this.rateAt(this.pos));
    return prev;
  }

  get finished(): boolean {
    return this.pos >= this.plan.endTick - 1e-6;
  }
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
