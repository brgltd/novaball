/**
 * NOVABALL AI — choosing where to send the ball.
 *
 * The strike assist sends the ball mostly along the car→ball line at contact (+20 % car forward), so a car can
 * only "cut" the ball so far away from its approach line. We sample hit directions inside that feasible cone and
 * score them: into the enemy goal (aim inside the posts, far post / away from the keeper) ≫ upfield ≫ sideways;
 * anything that could end in our own goal is heavily penalised. No safe option ⇒ kind 'none' (reposition instead).
 */
import { Vector3 } from 'three';
import { ARENA } from '../sim/constants';
import type { BotContext } from './context';
import { clamp, len2 } from './math';
import type { CarInfo } from './types';

export type ShotKind = 'goal' | 'upfield' | 'clear' | 'center' | 'none';

export interface ShotPlan {
  kind: ShotKind;
  /** Horizontal unit direction to send the ball. */
  dir: Vector3;
  score: number;
  /** Aim point in the enemy goal (kind 'goal'). */
  aimX: number;
}

export function makeShotPlan(): ShotPlan {
  return { kind: 'none', dir: new Vector3(0, 0, 1), score: -Infinity, aimX: 0 };
}

const L = ARENA.halfLength;
const W = ARENA.halfWidth;
const G = ARENA.goalHalfWidth;
/** Aim this far inside the posts (ball radius + margin). */
const POST_MARGIN = 1.6;

/** x where the ray from (px, pz) along (dx, dz) crosses z = zLine (NaN if it never does going forward). */
function xAtLine(px: number, pz: number, dx: number, dz: number, zLine: number): number {
  if (Math.abs(dz) < 1e-6) return NaN;
  const t = (zLine - pz) / dz;
  if (t <= 0) return NaN;
  return px + dx * t;
}

/**
 * Choose the enemy-goal aim x: away from the defending keeper if there is one, else the far post relative to the
 * ball, then add the skill's aim spread (noise already sampled by the caller).
 */
export function goalAimX(ctx: BotContext, me: CarInfo, px: number, spread: number): number {
  const enemyZ = L * me.dir;
  // keeper = opponent closest to its own goal center (and near it)
  let keeperX = NaN;
  let best = 14;
  for (let i = 0; i < ctx.cars.length; i++) {
    const c = ctx.cars[i];
    if (c.team === me.team || c.demolished) continue;
    const d = len2(c.pos.x, c.pos.z - enemyZ);
    if (d < best) {
      best = d;
      keeperX = c.pos.x;
    }
  }
  const lim = G - POST_MARGIN;
  let x: number;
  if (!Number.isNaN(keeperX)) x = keeperX > 0 ? -lim * 0.75 : lim * 0.75; // away from the keeper
  else if (Math.abs(px) > 2) x = px > 0 ? -lim * 0.3 : lim * 0.3; // open net: just inside the far half
  else x = 0;
  return clamp(x + spread, -lim, lim);
}

const _a = new Vector3();

/**
 * Pick the hit direction for a ball at (px, pz) contacted by a car coming from (cx, cz).
 * @param cut max angle (rad) away from the approach line
 * @param aimErr skill aim error (rad) applied to the chosen direction
 * @param spread skill aim spread (m) for the goal aim point
 */
export function chooseShot(
  ctx: BotContext,
  me: CarInfo,
  px: number,
  pz: number,
  cx: number,
  cz: number,
  cut: number,
  aimErr: number,
  spread: number,
  out: ShotPlan,
): ShotPlan {
  const dir = me.dir;
  const enemyZ = L * dir;
  const ownZ = -L * dir;
  // approach line (car → ball)
  let ax = px - cx;
  let az = pz - cz;
  let al = Math.sqrt(ax * ax + az * az);
  if (al < 1e-3) {
    ax = me.fwd.x;
    az = me.fwd.z;
    al = Math.sqrt(ax * ax + az * az) || 1;
  }
  ax /= al;
  az /= al;
  const aAng = Math.atan2(ax, az);
  // desired goal direction
  const aimX = goalAimX(ctx, me, px, spread);
  const gx = aimX - px;
  const gz = enemyZ - pz;
  const gAng = Math.atan2(gx, gz);
  const pzr = pz * dir; // team-relative
  const teamPlay = ctx.teamSize > 1;
  out.kind = 'none';
  out.score = -Infinity;
  out.aimX = aimX;
  const N = 9;
  for (let i = 0; i <= N; i++) {
    let ang: number;
    let dev: number;
    if (i === N) {
      // exact goal direction if it's inside the cone
      let dg = gAng - aAng;
      while (dg > Math.PI) dg -= 2 * Math.PI;
      while (dg < -Math.PI) dg += 2 * Math.PI;
      if (Math.abs(dg) > cut) continue;
      ang = gAng;
      dev = Math.abs(dg);
    } else {
      dev = -cut + (2 * cut * i) / (N - 1);
      ang = aAng + dev;
      dev = Math.abs(dev);
    }
    const dx = Math.sin(ang);
    const dz = Math.cos(ang);
    const dzr = dz * dir; // + = upfield
    let score = dzr * 1.0 - dev * 0.35;
    let kind: ShotKind = dzr > 0.35 ? 'upfield' : 'clear';
    // into the enemy goal?
    const xe = xAtLine(px, pz, dx, dz, enemyZ);
    if (!Number.isNaN(xe)) {
      const inside = G - POST_MARGIN * 0.6 - Math.abs(xe);
      if (inside > 0) {
        const distToGoal = Math.abs(enemyZ - pz);
        // far shots are less likely to score; still the best thing to do with the ball
        score += 2.2 + 1.2 * clamp(1 - distToGoal / 90, 0, 1) + clamp(inside, 0, 2) * 0.25;
        kind = 'goal';
      } else if (Math.abs(xe) < G + 6) {
        score += 0.4; // near miss: still a threat / corner pressure
      }
    }
    // into our own goal? (any direction heading back toward our goal mouth)
    const xo = xAtLine(px, pz, dx, dz, ownZ);
    if (!Number.isNaN(xo)) {
      const danger = G + 5 - Math.abs(xo);
      if (danger > 0) {
        const distOwn = Math.abs(ownZ - pz);
        score -= 6 * clamp(1.4 - distOwn / 80, 0.25, 1.4) + danger * 0.2;
      }
    }
    // backwards in our own third is bad even when wide
    if (pzr < -L * 0.35 && dzr < 0) score -= 1.5 * -dzr;
    // the car has to come from behind the ball along this direction: no room between the ball and a wall ⇒ infeasible
    const qx = px - dx * 3.2;
    const qz = pz - dz * 3.2;
    const ex = Math.abs(qx) - (W - 4.5);
    const inGoalMouth = Math.abs(qx) < G - 1;
    const ez = inGoalMouth ? 0 : Math.abs(qz) - (L - 4.5);
    if (ex > 0) score -= ex * 0.9;
    if (ez > 0) score -= ez * 0.9;
    // centering pass in team play: from the offensive corners toward the front of the goal
    if (teamPlay && pzr > L * 0.5 && Math.abs(px) > 14) {
      const cxp = 0 - px;
      const czp = (L - 12) * dir - pz;
      const cl = Math.sqrt(cxp * cxp + czp * czp) || 1;
      const c = (dx * cxp + dz * czp) / cl;
      if (c > 0.9) {
        score += 0.8 + (c - 0.9) * 3;
        if (kind !== 'goal') kind = 'center';
      }
    }
    // clears from deep: prefer the side walls over the middle
    if (pzr < -L * 0.4 && kind !== 'goal') {
      score += Math.abs(dx) * 0.4;
      kind = dzr > 0.35 ? 'upfield' : 'clear';
    }
    if (score > out.score) {
      out.score = score;
      out.kind = kind;
      _a.set(dx, 0, dz);
    }
  }
  // unsafe everywhere ⇒ none
  if (out.score < -1.5) out.kind = 'none';
  // skill aim error
  if (aimErr !== 0) {
    const ang = Math.atan2(_a.x, _a.z) + aimErr;
    _a.set(Math.sin(ang), 0, Math.cos(ang));
  }
  out.dir.copy(_a);
  return out;
}

/** Is a hit along (dx, dz) from (px, pz) heading into `me`'s own goal mouth (with margin)? */
export function headsToOwnGoal(me: CarInfo, px: number, pz: number, dx: number, dz: number, margin = 3): boolean {
  const xo = xAtLine(px, pz, dx, dz, -L * me.dir);
  return !Number.isNaN(xo) && Math.abs(xo) < G + margin;
}
