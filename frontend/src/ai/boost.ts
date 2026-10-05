/**
 * NOVABALL AI — boost pad selection.
 */
import type { PadState } from '../sim/types';
import type { BotContext } from './context';
import { len2 } from './math';
import type { CarInfo } from './types';

/**
 * Best active big pad for `me`: nearest by travel, penalised when it lies far upfield past the ball (unsafe) or
 * when a teammate is closer to it. `maxZr` bounds how far upfield (team-relative z) the pad may be.
 */
export function bestBigPad(ctx: BotContext, me: CarInfo, maxZr: number): PadState | null {
  let best: PadState | null = null;
  let bestCost = Infinity;
  const pads = ctx.pads;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p.big) continue;
    // a pad respawning within ~1 s is worth heading to as well
    if (!p.active && p.timer > 1.2) continue;
    const zr = p.pos.z * me.dir;
    if (zr > maxZr) continue;
    const dx = p.pos.x - me.pos.x;
    const dz = p.pos.z - me.pos.z;
    let cost = Math.sqrt(dx * dx + dz * dz);
    // facing bonus (no U-turn)
    const f = (dx * me.fwd.x + dz * me.fwd.z) / (cost || 1);
    cost += (1 - f) * 6;
    // a teammate already much closer to it takes it
    for (let c = 0; c < ctx.cars.length; c++) {
      const o = ctx.cars[c];
      if (o.id === me.id || o.team !== me.team || o.demolished) continue;
      const od = len2(p.pos.x - o.pos.x, p.pos.z - o.pos.z);
      if (od < cost * 0.6) cost += 20;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best;
}

/**
 * An active small pad close to the straight route from `me` to (tx, tz): within `lateral` metres of the line and
 * ahead of the car. Returns the nearest one or null.
 */
export function smallPadOnRoute(ctx: BotContext, me: CarInfo, tx: number, tz: number, lateral = 2.2): PadState | null {
  const dx = tx - me.pos.x;
  const dz = tz - me.pos.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 4) return null;
  const ux = dx / len;
  const uz = dz / len;
  let best: PadState | null = null;
  let bestAlong = Infinity;
  const pads = ctx.pads;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p.big || !p.active) continue;
    const px = p.pos.x - me.pos.x;
    const pz = p.pos.z - me.pos.z;
    const along = px * ux + pz * uz;
    if (along < 2.5 || along > len - 1) continue;
    const lat = Math.abs(px * uz - pz * ux);
    if (lat > lateral) continue;
    if (along < bestAlong) {
      bestAlong = along;
      best = p;
    }
  }
  return best;
}

/**
 * Big pad worth a detour on the way from `me` to (tx, tz): active (or back within ~0.8 s), extra path length below
 * `maxDetour`, and not further upfield than `maxZr` (team-relative). Returns the cheapest or null.
 */
export function bigPadDetour(ctx: BotContext, me: CarInfo, tx: number, tz: number, maxDetour: number, maxZr: number): PadState | null {
  const direct = len2(tx - me.pos.x, tz - me.pos.z);
  let best: PadState | null = null;
  let bestCost = maxDetour;
  const pads = ctx.pads;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p.big) continue;
    if (!p.active && p.timer > 0.8) continue;
    if (p.pos.z * me.dir > maxZr) continue;
    const a = len2(p.pos.x - me.pos.x, p.pos.z - me.pos.z);
    const b = len2(tx - p.pos.x, tz - p.pos.z);
    const cost = a + b - direct;
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best;
}
