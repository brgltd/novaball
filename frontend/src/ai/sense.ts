/**
 * NOVABALL AI — reading the world into per-tick CarInfo views.
 */
import { CAR } from '../sim/constants';
import type { CarState } from '../sim/types';
import { quatFwd, quatRight, quatUp } from './math';
import type { CarInfo } from './types';

/** Optional extra state exposed by the sim's SimCar (read-only). */
type ExtCar = CarState & { airJumpTimer?: number; lastTouchTime?: number };

/** Fill `out` from a car's live state. `dt` advances the stillness timer. */
export function readCar(c: CarState, mine: boolean, dt: number, out: CarInfo): CarInfo {
  const ext = c as ExtCar;
  out.id = c.id;
  out.team = c.team;
  out.isBot = c.isBot;
  out.mine = mine;
  out.pos.copy(c.pos);
  out.vel.copy(c.vel);
  out.angVel.copy(c.angVel);
  out.quat.copy(c.quat);
  quatFwd(c.quat, out.fwd);
  quatUp(c.quat, out.up);
  quatRight(c.quat, out.right);
  const sp = c.vel.length();
  out.speed = sp;
  out.fwdSpeed = c.vel.dot(out.fwd);
  out.onGround = c.onGround;
  out.demolished = c.demolished;
  out.boost = c.boost;
  out.supersonic = c.supersonic;
  out.hasJumped = c.hasJumped;
  out.hasDoubleJumped = c.hasDoubleJumped;
  out.hasDodged = c.hasDodged;
  out.isDodging = c.isDodging;
  out.airTime = c.airTime;
  const airJumpTimer = typeof ext.airJumpTimer === 'number' ? ext.airJumpTimer : c.airTime;
  out.canAirJump = !c.onGround && !c.demolished && !c.hasDoubleJumped && !c.hasDodged && airJumpTimer <= CAR.doubleJumpWindow - 0.02;
  out.pulseReady = c.pulseCooldown <= 0;
  out.dir = c.team === 0 ? 1 : -1;
  out.zr = c.pos.z * out.dir;
  out.lastTouchTime = typeof ext.lastTouchTime === 'number' ? ext.lastTouchTime : -1e9;
  if (sp < 1 && !c.demolished) out.stillTime += dt;
  else out.stillTime = 0;
  return out;
}
