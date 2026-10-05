/**
 * NOVABALL — world snapshots (render interpolation + replays).
 *
 * These helpers never feed back into the simulation, so they may use Quaternion.slerp.
 */
import { Quaternion, Vector3 } from 'three';
import type { BallSnapshot, CarSnapshot, Team, WorldSnapshot } from './types';

/** Positional jumps larger than this between two snapshots are teleports (kickoff / respawn): no lerp. */
export const SNAPSHOT_TELEPORT_DIST = 4;

export function makeCarSnapshot(id = 0, team: Team = 0): CarSnapshot {
  return {
    id,
    team,
    pos: new Vector3(),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    boost: 0,
    boosting: false,
    supersonic: false,
    onGround: true,
    demolished: false,
    dodging: false,
    powersliding: false,
    steer: 0,
    throttle: 0,
    pulseReady01: 0,
  };
}

export function makeBallSnapshot(): BallSnapshot {
  return {
    pos: new Vector3(),
    quat: new Quaternion(),
    vel: new Vector3(),
    angVel: new Vector3(),
    charge: 0,
    chargeTeam: -1,
    visible: true,
  };
}

/** Allocate an empty snapshot with `numCars` cars and `numPads` pads. */
export function makeSnapshot(numCars: number, numPads: number): WorldSnapshot {
  const cars: CarSnapshot[] = [];
  for (let i = 0; i < numCars; i++) cars.push(makeCarSnapshot(i));
  const padsActive: boolean[] = [];
  for (let i = 0; i < numPads; i++) padsActive.push(true);
  return { tick: 0, time: 0, phase: 'countdown', cars, ball: makeBallSnapshot(), padsActive, surge: 0 };
}

function ensureShape(src: WorldSnapshot, dst: WorldSnapshot): void {
  while (dst.cars.length < src.cars.length) dst.cars.push(makeCarSnapshot(dst.cars.length));
  if (dst.cars.length > src.cars.length) dst.cars.length = src.cars.length;
  while (dst.padsActive.length < src.padsActive.length) dst.padsActive.push(true);
  if (dst.padsActive.length > src.padsActive.length) dst.padsActive.length = src.padsActive.length;
}

export function copyCarSnapshot(s: CarSnapshot, d: CarSnapshot): CarSnapshot {
  d.id = s.id;
  d.team = s.team;
  d.pos.copy(s.pos);
  d.quat.copy(s.quat);
  d.vel.copy(s.vel);
  d.angVel.copy(s.angVel);
  d.boost = s.boost;
  d.boosting = s.boosting;
  d.supersonic = s.supersonic;
  d.onGround = s.onGround;
  d.demolished = s.demolished;
  d.dodging = s.dodging;
  d.powersliding = s.powersliding;
  d.steer = s.steer;
  d.throttle = s.throttle;
  d.pulseReady01 = s.pulseReady01;
  return d;
}

export function copyBallSnapshot(s: BallSnapshot, d: BallSnapshot): BallSnapshot {
  d.pos.copy(s.pos);
  d.quat.copy(s.quat);
  d.vel.copy(s.vel);
  d.angVel.copy(s.angVel);
  d.charge = s.charge;
  d.chargeTeam = s.chargeTeam;
  d.visible = s.visible;
  return d;
}

/** Deep copy src → dst (dst is resized if needed; no allocation when shapes match). */
export function copySnapshot(src: WorldSnapshot, dst: WorldSnapshot): WorldSnapshot {
  ensureShape(src, dst);
  dst.tick = src.tick;
  dst.time = src.time;
  dst.phase = src.phase;
  dst.surge = src.surge;
  for (let i = 0; i < src.cars.length; i++) copyCarSnapshot(src.cars[i], dst.cars[i]);
  copyBallSnapshot(src.ball, dst.ball);
  for (let i = 0; i < src.padsActive.length; i++) dst.padsActive[i] = src.padsActive[i];
  return dst;
}

export function cloneSnapshot(src: WorldSnapshot): WorldSnapshot {
  return copySnapshot(src, makeSnapshot(src.cars.length, src.padsActive.length));
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** out may alias a or b. */
function lerpQuat(a: Quaternion, b: Quaternion, t: number, out: Quaternion): void {
  if (out === b) {
    out.slerp(a, 1 - t); // slerp(a, b, t) === slerp(b, a, 1 − t)
    return;
  }
  if (out !== a) out.copy(a);
  out.slerp(b, t);
}

/**
 * Interpolate two snapshots: positions / velocities / scalars lerp, quaternions slerp, booleans and
 * discrete fields come from `b`. Teleports (> SNAPSHOT_TELEPORT_DIST) snap to `b`.
 * `out` may alias `a` or `b`. Returns `out`.
 */
export function lerpSnapshot(a: WorldSnapshot, b: WorldSnapshot, t: number, out: WorldSnapshot): WorldSnapshot {
  ensureShape(b, out);
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  out.tick = b.tick;
  out.time = lerpNum(a.time, b.time, tt);
  out.phase = b.phase;
  out.surge = lerpNum(a.surge, b.surge, tt);
  const n = b.cars.length;
  for (let i = 0; i < n; i++) {
    const cb = b.cars[i];
    const ca = i < a.cars.length ? a.cars[i] : cb;
    const co = out.cars[i];
    const teleport = ca.demolished !== cb.demolished || ca.pos.distanceToSquared(cb.pos) > SNAPSHOT_TELEPORT_DIST * SNAPSHOT_TELEPORT_DIST;
    if (teleport) {
      copyCarSnapshot(cb, co);
      continue;
    }
    co.id = cb.id;
    co.team = cb.team;
    co.pos.lerpVectors(ca.pos, cb.pos, tt);
    lerpQuat(ca.quat, cb.quat, tt, co.quat);
    co.vel.lerpVectors(ca.vel, cb.vel, tt);
    co.angVel.lerpVectors(ca.angVel, cb.angVel, tt);
    co.boost = lerpNum(ca.boost, cb.boost, tt);
    co.boosting = cb.boosting;
    co.supersonic = cb.supersonic;
    co.onGround = cb.onGround;
    co.demolished = cb.demolished;
    co.dodging = cb.dodging;
    co.powersliding = cb.powersliding;
    co.steer = lerpNum(ca.steer, cb.steer, tt);
    co.throttle = lerpNum(ca.throttle, cb.throttle, tt);
    co.pulseReady01 = lerpNum(ca.pulseReady01, cb.pulseReady01, tt);
  }
  const ba = a.ball;
  const bb = b.ball;
  const bo = out.ball;
  if (ba.visible !== bb.visible || ba.pos.distanceToSquared(bb.pos) > SNAPSHOT_TELEPORT_DIST * SNAPSHOT_TELEPORT_DIST) {
    copyBallSnapshot(bb, bo);
  } else {
    bo.pos.lerpVectors(ba.pos, bb.pos, tt);
    lerpQuat(ba.quat, bb.quat, tt, bo.quat);
    bo.vel.lerpVectors(ba.vel, bb.vel, tt);
    bo.angVel.lerpVectors(ba.angVel, bb.angVel, tt);
    bo.charge = bb.charge;
    bo.chargeTeam = bb.chargeTeam;
    bo.visible = bb.visible;
  }
  for (let i = 0; i < b.padsActive.length; i++) out.padsActive[i] = b.padsActive[i];
  return out;
}
