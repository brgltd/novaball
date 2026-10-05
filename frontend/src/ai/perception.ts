/**
 * NOVABALL AI — delayed ball perception + time-shifted ball path.
 *
 * Reaction time is modelled as a perception delay: the bots only "see" the ball as it was `delay` seconds ago and
 * predict forward from there with the sim's own ball step (as BallPredictor). With no touches the prediction is exact
 * (bit-identical to the live ball), so the delay only matters when something changes the trajectory (a hit, a pulse) —
 * exactly what a reaction time is. The prediction is maintained ONCE per tick (incrementally) and shared.
 */
import { Quaternion, Vector3 } from 'three';
import { arenaNormal, arenaSDF, goalScoredBy } from '../sim/arena';
import type { BallBody } from '../sim/ball';
import { collideBallArena, integrateBall } from '../sim/ball';
import { ARENA, BALL, DT } from '../sim/constants';
import type { BallState, Team } from '../sim/types';

const _wn = new Vector3();
const WALL_X = ARENA.halfWidth - 6;
const WALL_Z = ARENA.halfLength - 6;

/**
 * Is a ball at (x, y, z) a wall ball (touching / near a side, end or corner wall rather than the floor or ceiling)?
 * Returns the extra path length to drive up to it, or −1 if it isn't a drivable wall ball (the per-car height limit
 * is applied by the intercept search). Car-independent: computed once per predicted sample.
 */
function wallBallExtra(x: number, y: number, z: number): number {
  const ax = x < 0 ? -x : x;
  const az = z < 0 ? -z : z;
  if (ax < WALL_X && az < WALL_Z) return -1; // far from every wall
  if (arenaSDF(x, y, z) > BALL.radius + 0.9) return -1;
  arenaNormal(x, y, z, _wn);
  if (_wn.y > 0.7 || _wn.y < -0.3) return -1; // floor-ish or ceiling
  // goal mouth region: the ball is inside / at the goal, not on a wall
  if (az > ARENA.halfLength - 1 && ax < ARENA.goalHalfWidth) return -1;
  return (y - BALL.radius) * 1.15;
}

interface BallSample {
  pos: Vector3;
  vel: Vector3;
  angVel: Vector3;
  exploded: boolean;
}

/** Ring buffer of recent true ball states; exposes the delayed one as a BallState. */
export class BallPerception {
  readonly delayTicks: number;
  private readonly buf: BallSample[];
  private head = -1;
  private filled = 0;
  /** The perceived (delayed) ball. */
  readonly perceived: BallState;

  constructor(delayTicks: number) {
    this.delayTicks = Math.max(0, Math.floor(delayTicks));
    this.buf = [];
    for (let i = 0; i <= this.delayTicks; i++) {
      this.buf.push({ pos: new Vector3(), vel: new Vector3(), angVel: new Vector3(), exploded: false });
    }
    this.perceived = {
      pos: new Vector3(),
      vel: new Vector3(),
      quat: new Quaternion(),
      angVel: new Vector3(),
      charge: 0,
      chargeTeam: -1,
      lastTouchCarId: -1,
      lastTouchTime: -1,
      exploded: false,
    };
  }

  /** Forget the history (kickoff reset): the next push fills the whole buffer. */
  reset(): void {
    this.filled = 0;
    this.head = -1;
  }

  push(ball: BallState): void {
    const n = this.buf.length;
    if (this.filled === 0) {
      // fill everything with the current state (no stale history)
      for (let i = 0; i < n; i++) this.write(this.buf[i], ball);
      this.head = n - 1;
      this.filled = n;
    } else {
      this.head = (this.head + 1) % n;
      this.write(this.buf[this.head], ball);
    }
    // oldest sample = delayTicks ago
    const s = this.buf[(this.head + 1) % n];
    const p = this.perceived;
    p.pos.copy(s.pos);
    p.vel.copy(s.vel);
    p.angVel.copy(s.angVel);
    p.exploded = s.exploded;
    p.charge = ball.charge;
    p.chargeTeam = ball.chargeTeam;
    p.lastTouchCarId = ball.lastTouchCarId;
    p.lastTouchTime = ball.lastTouchTime;
  }

  private write(dst: BallSample, b: BallState): void {
    dst.pos.copy(b.pos);
    dst.vel.copy(b.vel);
    dst.angVel.copy(b.angVel);
    dst.exploded = b.exploded;
  }
}

/**
 * The perceived ball's future, re-indexed to "now": future sample k is at time (k + 1)·dt from now.
 *
 * INCREMENTAL (zero allocation): the future is kept in a ring buffer at the sim step DT (2 sub-steps per 1/60 s
 * sample). Each tick, if the newly perceived ball is exactly the state predicted one step ago (no car touch / pulse /
 * kickoff reset / gravity change — ≈ 99 % of playing ticks) the ring just shifts by one step and one new step is
 * simulated at the tail; otherwise the whole horizon is re-predicted. The sub-steps are the sim's own ball step
 * (integrateBall + collideBallArena at DT, as in BallPredictor), so the path is bit-identical to a full
 * BallPredictor.update() every tick, at a few % of the cost.
 */
export class BallPath {
  readonly dt = 1 / 60;
  /** Samples covering the perception delay (skipped). */
  readonly offset: number;
  /** Usable future samples. */
  readonly count: number;
  /** Perceived ball now (extrapolated through the delay). */
  readonly nowPos = new Vector3();
  readonly nowVel = new Vector3();
  /** The ball's velocity as last SEEN (the delayed observation, not extrapolated) — e.g. "is it resting / pinned?". */
  readonly seenVel = new Vector3();
  exploded = false;
  /** First future sample where the ball is inside a goal (−1 = none within the horizon), and who scores. */
  goalK = -1;
  goalTeam: Team | -1 = -1;
  /** Diagnostics: full re-predictions vs incremental shifts. */
  fullUpdates = 0;
  shiftUpdates = 0;
  /** Samples incl. the delay part (the BallPredictor horizon). */
  private readonly total: number;
  /** Sub-steps kept ahead of the base state (2 per sample). */
  private readonly need: number;
  private readonly cap: number;
  private readonly rp: Vector3[] = [];
  private readonly rv: Vector3[] = [];
  private readonly rw: Vector3[] = [];
  /** Goal flag per ring entry (team that would score there, −1 none). */
  private readonly rg: Int8Array;
  /** Wall-ball extra path length per ring entry (−1: not a wall ball) — see wallBallExtra. */
  private readonly rwe: Float64Array;
  private base = 0;
  private len = -1;
  private g = NaN;
  private readonly body: BallBody = { pos: new Vector3(), vel: new Vector3(), angVel: new Vector3() };

  constructor(horizonSec: number, delayTicks: number) {
    // delay in 1/60 s samples (the manager rounds the delay to an even tick count)
    this.offset = Math.max(0, Math.round((delayTicks * DT) / this.dt));
    this.total = Math.max(1, Math.round((horizonSec + this.offset * this.dt) / this.dt));
    this.count = this.total - this.offset;
    this.need = 2 * this.total;
    this.cap = this.need + 2;
    this.rg = new Int8Array(this.cap);
    this.rwe = new Float64Array(this.cap).fill(-1);
    for (let i = 0; i < this.cap; i++) {
      this.rp.push(new Vector3());
      this.rv.push(new Vector3());
      this.rw.push(new Vector3());
    }
  }

  update(perceived: BallState, gravityScale: number): void {
    const cap = this.cap;
    this.exploded = perceived.exploded;
    this.seenVel.copy(perceived.vel);
    if (perceived.exploded) {
      // as BallPredictor: every sample at the (hidden) ball, at rest
      for (let i = 0; i < cap; i++) {
        this.rp[i].copy(perceived.pos);
        this.rv[i].set(0, 0, 0);
        this.rw[i].set(0, 0, 0);
        this.rg[i] = -1;
        this.rwe[i] = -1;
      }
      this.base = 0;
      this.len = -1; // re-predict from scratch next time
      this.g = NaN;
      this.nowPos.copy(perceived.pos);
      if (this.offset > 0) this.nowVel.set(0, 0, 0);
      else this.nowVel.copy(perceived.vel);
      this.goalK = -1;
      this.goalTeam = -1;
      return;
    }
    const p = perceived.pos;
    const v = perceived.vel;
    const w = perceived.angVel;
    const i1 = this.base + 1 < cap ? this.base + 1 : 0;
    const a = this.rp[i1];
    const b = this.rv[i1];
    const c = this.rw[i1];
    if (
      this.len >= 1 &&
      gravityScale === this.g &&
      a.x === p.x &&
      a.y === p.y &&
      a.z === p.z &&
      b.x === v.x &&
      b.y === v.y &&
      b.z === v.z &&
      c.x === w.x &&
      c.y === w.y &&
      c.z === w.z
    ) {
      // the ball did exactly what we predicted: shift by one step
      this.base = i1;
      this.len -= 1;
      this.shiftUpdates++;
    } else {
      this.rp[this.base].copy(p);
      this.rv[this.base].copy(v);
      this.rw[this.base].copy(w);
      this.rg[this.base] = -1;
      this.len = 0;
      this.g = gravityScale;
      this.fullUpdates++;
    }
    // top up the tail (the sim's own ball step at DT)
    if (this.len < this.need) {
      let j = this.base + this.len;
      if (j >= cap) j -= cap;
      const body = this.body;
      body.pos.copy(this.rp[j]);
      body.vel.copy(this.rv[j]);
      body.angVel.copy(this.rw[j]);
      while (this.len < this.need) {
        integrateBall(body, DT, gravityScale);
        collideBallArena(body, DT, null);
        j = j + 1 < cap ? j + 1 : 0;
        this.rp[j].copy(body.pos);
        this.rv[j].copy(body.vel);
        this.rw[j].copy(body.angVel);
        this.rg[j] = goalScoredBy(body.pos);
        this.rwe[j] = wallBallExtra(body.pos.x, body.pos.y, body.pos.z);
        this.len++;
      }
    }
    if (this.offset > 0) {
      this.nowPos.copy(this.rp[this.ring(this.offset - 1)]);
      this.nowVel.copy(this.rv[this.ring(this.offset - 1)]);
    } else {
      this.nowPos.copy(p);
      this.nowVel.copy(v);
    }
    // first sample inside a goal over the whole predicted horizon (as BallPredictor.goalIndex)
    this.goalK = -1;
    this.goalTeam = -1;
    for (let i = 0; i < this.total; i++) {
      const gs = this.rg[this.ring(i)];
      if (gs !== -1) {
        const k = i - this.offset;
        this.goalK = k < 0 ? 0 : k;
        this.goalTeam = gs as Team;
        break;
      }
    }
  }

  /** Ring index of predictor sample i (time (i + 1)·dt after the perceived state). */
  private ring(i: number): number {
    const j = this.base + 2 * (i + 1);
    return j >= this.cap ? j - this.cap : j;
  }

  /** Ball position at future sample k (0 ≤ k < count). */
  pos(k: number): Vector3 {
    return this.rp[this.ring(this.offset + k)];
  }

  vel(k: number): Vector3 {
    return this.rv[this.ring(this.offset + k)];
  }

  /** Extra path length (m) to drive up to the ball at future sample k if it's a wall ball, else −1. */
  wallExtra(k: number): number {
    return this.rwe[this.ring(this.offset + k)];
  }

  /** Seconds from now of future sample k. */
  time(k: number): number {
    return (k + 1) * this.dt;
  }

  /** Sample index nearest to `t` seconds from now (clamped). */
  indexAt(t: number): number {
    let k = Math.round(t / this.dt) - 1;
    if (k < 0) k = 0;
    if (k >= this.count) k = this.count - 1;
    return k;
  }

  /** Samples to scan (stops at a predicted goal). */
  scanLimit(): number {
    return this.goalK >= 0 ? Math.min(this.count, this.goalK + 1) : this.count;
  }
}
