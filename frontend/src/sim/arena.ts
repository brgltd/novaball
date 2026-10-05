/**
 * NOVABALL — arena geometry as a signed distance field (CONTRACT, shared by sim + render + AI).
 *
 * arenaSDF(x, y, z) returns the distance from a point to the nearest arena surface:
 *   > 0  inside the playable volume (free space)
 *   < 0  inside walls / floor / ceiling / goal frame (solid)
 * The gradient (arenaNormal) points from the surface INTO the playable volume.
 *
 * Shape:
 *  - Main volume: a rounded rectangle in XZ (half sizes halfWidth × halfLength, corner radius cornerRadius),
 *    extruded from y = 0 to y = height, with every floor/ceiling-to-wall edge filleted by edgeRadius
 *    (these fillets are the ramps cars drive up onto the walls).
 *  - Two goal boxes (free space) behind z = ±halfLength: x ∈ [-goalHalfWidth, goalHalfWidth], y ∈ [0, goalHeight],
 *    depth goalDepth, interior edges filleted by goalInnerRadius. The box starts edgeRadius in front of the goal line
 *    so the end-wall ramp is carved away in front of the goal mouth (flat floor into the goal).
 *  - Goal frame (solid tubes, radius goalFrameRadius): crossbar (y = goalHeight), posts (x = ±goalHalfWidth, from
 *    y = edgeRadius up to the crossbar) and "base arcs" that follow the carved ramp edge down to the floor
 *    (tapered to zero radius at the floor so they don't form a bump).
 *
 * Only +, -, *, /, sqrt, abs, min, max are used => bit-exact across JS engines (deterministic).
 */
import { Vector3 } from 'three';
import { ARENA, BALL } from './constants';
import type { Team } from './types';

const W = ARENA.halfWidth;
const L = ARENA.halfLength;
const H = ARENA.height;
const RC = ARENA.cornerRadius;
const RE = ARENA.edgeRadius;
const G = ARENA.goalHalfWidth;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
const RG = ARENA.goalInnerRadius;
const RF = ARENA.goalFrameRadius;

// Goal box (free space) in folded coordinates (|x|, y, |z|).
const GB_HX = G;
const GB_CY = GH * 0.5;
const GB_HY = GH * 0.5;
/**
 * The box starts over the FLAT floor (before the end-wall ramp begins at L - RE, minus the box's own front
 * rounding RG and a margin), so its rounded front edge never meets the ramp: the floor into the goal is perfectly
 * flat (no crease/ridge where the two fillets would otherwise intersect).
 */
const GB_Z0 = L - RE - RG - 0.3;
const GB_Z1 = L + GD;
const GB_CZ = (GB_Z0 + GB_Z1) * 0.5;
const GB_HZ = (GB_Z1 - GB_Z0) * 0.5;
/** Beyond this distance from the goal region the goal terms cannot affect the SDF (max free distance is H/2). */
const GOAL_INFLUENCE_Z = L - RE - (H * 0.5 + 2);

/** Free-space distance of the main arena volume (positive inside). ax, az are |x|, |z|. */
function mainFree(ax: number, y: number, az: number): number {
  // 2D rounded rectangle SDF (negative inside).
  const qx = ax - W + RC;
  const qz = az - L + RC;
  const ox = qx > 0 ? qx : 0;
  const oz = qz > 0 ? qz : 0;
  const d2 = Math.min(Math.max(qx, qz), 0) + Math.sqrt(ox * ox + oz * oz) - RC;
  // Rounded extrusion over y ∈ [0, H] with edge radius RE.
  const wx = d2 + RE;
  const wy = Math.abs(y - H * 0.5) - H * 0.5 + RE;
  const px = wx > 0 ? wx : 0;
  const py = wy > 0 ? wy : 0;
  return -(Math.min(Math.max(wx, wy), 0) + Math.sqrt(px * px + py * py) - RE);
}

/** Free-space distance of the (+Z, folded) goal box (positive inside). */
function goalFree(ax: number, y: number, az: number): number {
  const qx = ax - GB_HX + RG;
  const qy = Math.abs(y - GB_CY) - GB_HY + RG;
  const qz = Math.abs(az - GB_CZ) - GB_HZ + RG;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const oz = qz > 0 ? qz : 0;
  return -(Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - RG);
}

/** Distance from p to segment a→b (all in folded coords). */
function segDist(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  let t = (apx * abx + apy * aby + apz * abz) / (abx * abx + aby * aby + abz * abz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Signed distance to the goal frame tubes (+Z goal, folded, x >= 0 half). Negative inside a tube. */
function frameDist(ax: number, y: number, az: number): number {
  // Crossbar: (0, GH, L) → (G, GH, L)
  let d = segDist(ax, y, az, 0, GH, L, G, GH, L) - RF;
  // Post: (G, RE, L) → (G, GH, L)
  const dp = segDist(ax, y, az, G, RE, L, G, GH, L) - RF;
  if (dp < d) d = dp;
  // Base arc in the plane x = G: center (y = RE, z = L - RE), radius RE, quadrant dy <= 0, dz >= 0.
  // Tube radius tapers from RF (top, at the wall) to 0 (at the floor).
  const dx = ax - G;
  const dy = y - RE;
  const dz = az - (L - RE);
  let da: number;
  if (dy <= 0 && dz >= 0) {
    const r = Math.sqrt(dy * dy + dz * dz);
    const radial = r - RE;
    // taper: fraction along the arc approximated by the normalized height of the closest arc point.
    let s = r > 1e-9 ? dz / r : 1; // 1 at the wall end (top), 0 at the floor end
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    da = Math.sqrt(dx * dx + radial * radial) - RF * s;
  } else {
    // Outside the arc's angular range: nearest of the two endpoints.
    // Top endpoint (G, RE, L) has radius RF; floor endpoint (G, 0, L - RE) has radius 0.
    const tz = az - L;
    const dTop = Math.sqrt(dx * dx + dy * dy + tz * tz) - RF;
    const dFloor = Math.sqrt(dx * dx + y * y + dz * dz);
    da = dTop < dFloor ? dTop : dFloor;
  }
  if (da < d) d = da;
  return d;
}

/** Signed distance to the arena surfaces. Positive = inside the playable volume. */
export function arenaSDF(x: number, y: number, z: number): number {
  const ax = x < 0 ? -x : x;
  const az = z < 0 ? -z : z;
  let f = mainFree(ax, y, az);
  if (az > GOAL_INFLUENCE_Z) {
    const g = goalFree(ax, y, az);
    if (g > f) f = g;
    const fr = frameDist(ax, y, az);
    if (fr < f) f = fr;
  }
  return f;
}

const NORMAL_EPS = 0.002;

/**
 * Surface normal (normalized SDF gradient, pointing into free space) at (x, y, z), written to `out`.
 * Uses the 4-tap tetrahedral gradient. Returns `out`.
 */
export function arenaNormal(x: number, y: number, z: number, out: Vector3): Vector3 {
  const e = NORMAL_EPS;
  const a = arenaSDF(x + e, y - e, z - e);
  const b = arenaSDF(x - e, y - e, z + e);
  const c = arenaSDF(x - e, y + e, z - e);
  const d = arenaSDF(x + e, y + e, z + e);
  let nx = a - b - c + d;
  let ny = -a - b + c + d;
  let nz = -a + b - c + d;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0;
    ny = 1;
    nz = 0;
  }
  return out.set(nx, ny, nz);
}

/** Distance + normal in one call. Writes the normal into `outNormal` and returns the signed distance. */
export function arenaQuery(p: Vector3, outNormal: Vector3): number {
  arenaNormal(p.x, p.y, p.z, outNormal);
  return arenaSDF(p.x, p.y, p.z);
}

/**
 * Projects a point onto the nearest arena surface (a few Newton steps along the gradient).
 * Useful for render mesh generation (snapping vertices exactly onto the physics surface).
 */
export function projectToArenaSurface(p: Vector3, out: Vector3 = new Vector3(), iterations = 4): Vector3 {
  const n = new Vector3();
  out.copy(p);
  for (let i = 0; i < iterations; i++) {
    const d = arenaSDF(out.x, out.y, out.z);
    arenaNormal(out.x, out.y, out.z, n);
    out.addScaledVector(n, -d);
  }
  return out;
}

/**
 * Which team scores if the ball is at `pos` (entire ball past a goal line inside a goal), else -1.
 * Team 0 attacks +Z, so a ball beyond z = +(L + R) is a goal FOR team 0.
 */
export function goalScoredBy(pos: Vector3): Team | -1 {
  const lim = L + BALL.radius;
  if (pos.z > lim) return 0;
  if (pos.z < -lim) return 1;
  return -1;
}

/** Center of the goal defended by `team` (on the goal line, mid-height of the mouth). */
export function ownGoalCenter(team: Team, out: Vector3 = new Vector3()): Vector3 {
  return out.set(0, GH * 0.5, team === 0 ? -L : L);
}

/** Center of the goal attacked by `team`. */
export function targetGoalCenter(team: Team, out: Vector3 = new Vector3()): Vector3 {
  return out.set(0, GH * 0.5, team === 0 ? L : -L);
}

/**
 * Goal frame tube center-lines for rendering (world space, both goals).
 * Each path is a polyline; `radius` is the tube radius at each point (base arcs taper to 0 at the floor).
 */
export function goalFramePaths(arcSegments = 16): Array<{ goal: Team; points: Vector3[]; radius: number[] }> {
  const paths: Array<{ goal: Team; points: Vector3[]; radius: number[] }> = [];
  for (const goalTeam of [0, 1] as Team[]) {
    const sz = goalTeam === 0 ? -1 : 1; // team 0 defends -Z
    const pts: Vector3[] = [];
    const rad: number[] = [];
    // left base arc (x = -G) from floor up to the wall, then post up, crossbar across, post down, right arc down.
    const arc = (sx: number, reverse: boolean) => {
      const tmpP: Vector3[] = [];
      const tmpR: number[] = [];
      for (let i = 0; i <= arcSegments; i++) {
        const t = i / arcSegments; // 0 at floor end, 1 at wall end
        const ang = (1 - t) * Math.PI * 0.5; // π/2 at the floor, 0 at the wall
        const y = RE - RE * Math.sin(ang);
        const z = L - RE + RE * Math.cos(ang);
        tmpP.push(new Vector3(sx * G, y, sz * z));
        tmpR.push(RF * (Math.cos(ang) > 1 ? 1 : Math.cos(ang)));
      }
      if (reverse) {
        tmpP.reverse();
        tmpR.reverse();
      }
      pts.push(...tmpP);
      rad.push(...tmpR);
    };
    arc(-1, false);
    pts.push(new Vector3(-G, GH, sz * L));
    rad.push(RF);
    pts.push(new Vector3(G, GH, sz * L));
    rad.push(RF);
    arc(1, true);
    paths.push({ goal: goalTeam, points: pts, radius: rad });
  }
  return paths;
}

/** Convenience re-exports of the arena dimensions for renderers. */
export const ARENA_DIMS = { W, L, H, RC, RE, G, GH, GD, RG, RF } as const;

/**
 * Goal box (free space) extents in folded coordinates (|x|, y, |z|): x ∈ [-hx, hx], y ∈ [0, 2·hy], z ∈ [z0, z1],
 * interior edges rounded by RG. Renderers must use these (not their own copies) to stay in sync with physics.
 */
export const GOAL_BOX = { hx: GB_HX, cy: GB_CY, hy: GB_HY, z0: GB_Z0, z1: GB_Z1, cz: GB_CZ, hz: GB_HZ, radius: RG } as const;
