/**
 * NOVABALL AI — shared per-tick data structures.
 */
import { Quaternion, Vector3 } from 'three';
import type { Team } from '../sim/types';

/** Per-tick view of one car, computed once per tick for every car and shared by all bots. */
export interface CarInfo {
  id: number;
  team: Team;
  isBot: boolean;
  /** Controlled by this BotManager. */
  mine: boolean;
  pos: Vector3;
  vel: Vector3;
  angVel: Vector3;
  quat: Quaternion;
  fwd: Vector3;
  up: Vector3;
  right: Vector3;
  speed: number;
  /** Velocity along the car's forward axis. */
  fwdSpeed: number;
  onGround: boolean;
  demolished: boolean;
  boost: number;
  supersonic: boolean;
  hasJumped: boolean;
  hasDoubleJumped: boolean;
  hasDodged: boolean;
  isDodging: boolean;
  /** Seconds in the air (0 when grounded). */
  airTime: number;
  /** Can still double-jump / dodge. */
  canAirJump: boolean;
  pulseReady: boolean;
  /** +1 if the team attacks +Z, −1 otherwise. */
  dir: number;
  /** Team-relative long coordinate: −50 = own goal line, +50 = enemy goal line. */
  zr: number;
  /** Earliest intercept estimate (s from now; Infinity when none) — for roles. */
  eta: number;
  /** Ball position at that intercept. */
  etaPos: Vector3;
  /** Sim time of the car's last ball touch (−1e9 if unknown). */
  lastTouchTime: number;
  /** Seconds this car has been (almost) motionless. */
  stillTime: number;
}

export function makeCarInfo(): CarInfo {
  return {
    id: 0,
    team: 0,
    isBot: true,
    mine: false,
    pos: new Vector3(),
    vel: new Vector3(),
    angVel: new Vector3(),
    quat: new Quaternion(),
    fwd: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(-1, 0, 0),
    speed: 0,
    fwdSpeed: 0,
    onGround: true,
    demolished: false,
    boost: 0,
    supersonic: false,
    hasJumped: false,
    hasDoubleJumped: false,
    hasDodged: false,
    isDodging: false,
    airTime: 0,
    canAirJump: false,
    pulseReady: false,
    dir: 1,
    zr: 0,
    eta: Infinity,
    etaPos: new Vector3(),
    lastTouchTime: -1e9,
    stillTime: 0,
  };
}

export type Role = 'attacker' | 'support' | 'defender';

export type HitKind = 'ground' | 'jump' | 'double' | 'aerial' | 'wall';

/** Result of an intercept search on the (perceived) ball path. */
export interface Intercept {
  found: boolean;
  /** Future slice index in the BallPath (time = (k + 1) · dt). */
  k: number;
  /** Seconds from now. */
  time: number;
  pos: Vector3;
  vel: Vector3;
  kind: HitKind;
  /** Estimated time the car needs to get there (≤ time when found). */
  need: number;
}

export function makeIntercept(): Intercept {
  return { found: false, k: -1, time: Infinity, pos: new Vector3(), vel: new Vector3(), kind: 'ground', need: Infinity };
}

export function copyIntercept(src: Intercept, dst: Intercept): Intercept {
  dst.found = src.found;
  dst.k = src.k;
  dst.time = src.time;
  dst.pos.copy(src.pos);
  dst.vel.copy(src.vel);
  dst.kind = src.kind;
  dst.need = src.need;
  return dst;
}
