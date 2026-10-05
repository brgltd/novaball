/**
 * NOVABALL render-world — arena geometry generated from the physics constants.
 *
 * Every surface here is built analytically from ARENA (the same parameters as src/sim/arena.ts):
 *  - force field: the rounded-rectangle "tube" (floor fillet → vertical wall → ceiling fillet) swept along the
 *    perimeter + the flat ceiling cap. Goal mouths are cut per-pixel in the shader with the exact goal-box SDF.
 *  - goal boxes: rounded boxes (radius goalInnerRadius) mapped with the clamp+normalize rounded-box trick,
 *    which is exactly the SDF's surface.
 *  - goal frames: variable-radius tubes along goalFramePaths().
 * verifyArenaGeometry() checks generated vertices against arenaSDF (used by the dev sandbox).
 */
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { ARENA } from '../../sim/constants';
import { arenaSDF, GOAL_BOX, goalFramePaths } from '../../sim/arena';

const W = ARENA.halfWidth;
const L = ARENA.halfLength;
const H = ARENA.height;
const RC = ARENA.cornerRadius;
const RE = ARENA.edgeRadius;
const G = ARENA.goalHalfWidth;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
const RG = ARENA.goalInnerRadius;

/** Core rectangle (fillet centerline footprint): half extents and corner radius. */
export const CORE_HX = W - RE;
export const CORE_HZ = L - RE;
export const CORE_R = RC - RE;

export interface PerimeterSample {
  /** point on the core rounded rectangle (y ignored) */
  x: number;
  z: number;
  /** outward unit normal (2D) */
  nx: number;
  nz: number;
  /** arclength (m) measured along the wall outline (offset RE) */
  u: number;
}

/**
 * Samples a rounded rectangle (half extents hx, hz, corner radius r) counter-clockwise starting at (+hx, 0).
 * `offset` pushes points outward along the normal (arclength `u` is measured at that offset).
 */
export function sampleRoundedRect(hx: number, hz: number, r: number, arcSegs: number, straightSegs: number, offset = 0): PerimeterSample[] {
  const out: PerimeterSample[] = [];
  const cx = hx - r;
  const cz = hz - r;
  const pushLine = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number, includeEnd: boolean) => {
    const n = straightSegs;
    for (let i = 0; i < n + (includeEnd ? 1 : 0); i++) {
      const t = i / n;
      out.push({ x: x0 + (x1 - x0) * t + nx * offset, z: z0 + (z1 - z0) * t + nz * offset, nx, nz, u: 0 });
    }
  };
  const pushArc = (ccx: number, ccz: number, a0: number) => {
    for (let i = 0; i < arcSegs; i++) {
      const a = a0 + (i / arcSegs) * (Math.PI / 2);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      out.push({ x: ccx + nx * (r + offset), z: ccz + nz * (r + offset), nx, nz, u: 0 });
    }
  };
  // right edge (x = +hx) from z = 0 to z = cz
  pushLine(hx, 0, hx, cz, 1, 0, false);
  pushArc(cx, cz, 0);
  pushLine(cx, hz, -cx, hz, 0, 1, false);
  pushArc(-cx, cz, Math.PI / 2);
  pushLine(-hx, cz, -hx, -cz, -1, 0, false);
  pushArc(-cx, -cz, Math.PI);
  pushLine(-cx, -hz, cx, -hz, 0, -1, false);
  pushArc(cx, -cz, Math.PI * 1.5);
  pushLine(hx, -cz, hx, 0, 1, 0, false);
  // close the loop (duplicate first point so the u coordinate can run continuously)
  const f0 = out[0];
  out.push({ ...f0 });
  // arclength
  let u = 0;
  out[0].u = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    u += Math.hypot(b.x - a.x, b.z - a.z);
    b.u = u;
  }
  return out;
}

/**
 * Force-field geometry: walls, fillets and ceiling. Attributes: position, normal (into the arena),
 * aHex (hex-mapping coords in meters: perimeter u / profile v for the sweep, x/z for the cap).
 */
export function buildForceFieldGeometry(): BufferGeometry {
  // Core footprint samples; arclength must be measured at the WALL (offset RE) for undistorted hexes.
  const core = sampleRoundedRect(CORE_HX, CORE_HZ, CORE_R, 20, 8, 0);
  const wall = sampleRoundedRect(CORE_HX, CORE_HZ, CORE_R, 20, 8, RE);
  // profile: [horizontal offset from core point, y, normal horizontal (outward +), normal y, v]
  const prof: Array<[number, number, number, number, number]> = [];
  const FS = 10;
  for (let i = 0; i <= FS; i++) {
    const th = (i / FS) * (Math.PI / 2);
    prof.push([RE * Math.sin(th), RE - RE * Math.cos(th), -Math.sin(th), Math.cos(th), RE * th]);
  }
  const vWall0 = RE * (Math.PI / 2);
  const WS = 4;
  for (let i = 1; i <= WS; i++) {
    const y = RE + ((H - 2 * RE) * i) / WS;
    prof.push([RE, y, -1, 0, vWall0 + (y - RE)]);
  }
  const vCeil0 = vWall0 + (H - 2 * RE);
  for (let i = 1; i <= FS; i++) {
    const ph = (i / FS) * (Math.PI / 2);
    prof.push([RE * Math.cos(ph), H - RE + RE * Math.sin(ph), -Math.cos(ph), -Math.sin(ph), vCeil0 + RE * ph]);
  }
  const nP = prof.length;
  const nS = core.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const hex: number[] = [];
  for (let s = 0; s < nS; s++) {
    const c = core[s];
    const uw = wall[s].u;
    for (let j = 0; j < nP; j++) {
      const [off, y, nh, ny, v] = prof[j];
      pos.push(c.x + c.nx * off, y, c.z + c.nz * off);
      nor.push(c.nx * nh, ny, c.nz * nh);
      hex.push(uw, v);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < nS - 1; s++) {
    for (let j = 0; j < nP - 1; j++) {
      const a = s * nP + j;
      const b = (s + 1) * nP + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // ceiling cap: fan from the center over the core footprint at y = H
  const capStart = pos.length / 3;
  pos.push(0, H, 0);
  nor.push(0, -1, 0);
  hex.push(0, 0);
  for (let s = 0; s < nS; s++) {
    const c = core[s];
    pos.push(c.x, H, c.z);
    nor.push(0, -1, 0);
    hex.push(c.x, c.z);
  }
  for (let s = 0; s < nS - 1; s++) {
    idx.push(capStart, capStart + 1 + s + 1, capStart + 1 + s);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('aHex', new Float32BufferAttribute(hex, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Axis samples in [-h, h], dense inside the rounded bands of width r at both ends. */
function axisSamples(h: number, r: number, step: number, lo = true, hi = true): number[] {
  const out: number[] = [];
  const band = 6;
  if (lo) {
    for (let i = 0; i < band; i++) out.push(-h + r * (1 - Math.cos(((i / band) * Math.PI) / 2)));
  }
  const a = lo ? -h + r : -h;
  const b = hi ? h - r : h;
  const n = Math.max(1, Math.ceil((b - a) / step));
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  if (hi) {
    for (let i = band - 1; i >= 0; i--) out.push(h - r * (1 - Math.cos(((i / band) * Math.PI) / 2)));
  }
  // dedupe
  const res: number[] = [];
  for (const v of out) if (res.length === 0 || Math.abs(v - res[res.length - 1]) > 1e-6) res.push(v);
  return res;
}

interface GridBuilder {
  pos: number[];
  nor: number[];
  team: number[];
  idx: number[];
}

/** Map a point on the box (half extents h, local coords) to the rounded box surface (radius r). */
function roundedBoxMap(lp: Vector3, h: Vector3, r: number, faceN: Vector3, outP: Vector3, outN: Vector3): void {
  const qx = Math.max(-(h.x - r), Math.min(h.x - r, lp.x));
  const qy = Math.max(-(h.y - r), Math.min(h.y - r, lp.y));
  const qz = Math.max(-(h.z - r), Math.min(h.z - r, lp.z));
  let dx = lp.x - qx;
  let dy = lp.y - qy;
  let dz = lp.z - qz;
  let len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    dx = faceN.x;
    dy = faceN.y;
    dz = faceN.z;
    len = 1;
  }
  dx /= len;
  dy /= len;
  dz /= len;
  outP.set(qx + dx * r, qy + dy * r, qz + dz * r);
  outN.set(-dx, -dy, -dz); // into the goal box (free space)
}

function addFace(
  gb: GridBuilder,
  team: number,
  center: Vector3,
  h: Vector3,
  r: number,
  faceN: Vector3,
  uAxis: 'x' | 'y' | 'z',
  vAxis: 'x' | 'y' | 'z',
  us: number[],
  vs: number[],
  flip: boolean,
): void {
  const base = gb.pos.length / 3;
  const lp = new Vector3();
  const p = new Vector3();
  const n = new Vector3();
  const faceAxis = faceN.x !== 0 ? 'x' : faceN.y !== 0 ? 'y' : 'z';
  const faceVal = faceAxis === 'x' ? faceN.x * h.x : faceAxis === 'y' ? faceN.y * h.y : faceN.z * h.z;
  for (let j = 0; j < vs.length; j++) {
    for (let i = 0; i < us.length; i++) {
      lp.set(0, 0, 0);
      lp[uAxis] = us[i];
      lp[vAxis] = vs[j];
      lp[faceAxis] = faceVal;
      roundedBoxMap(lp, h, r, faceN, p, n);
      gb.pos.push(p.x + center.x, p.y + center.y, p.z + center.z);
      gb.nor.push(n.x, n.y, n.z);
      gb.team.push(team);
    }
  }
  const nu = us.length;
  for (let j = 0; j < vs.length - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = base + j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      if (flip) gb.idx.push(a, c, b, b, c, d);
      else gb.idx.push(a, b, c, b, d, c);
    }
  }
}

function finishGrid(gb: GridBuilder): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(gb.pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(gb.nor, 3));
  geo.setAttribute('aTeam', new Float32BufferAttribute(gb.team, 1));
  geo.setIndex(gb.idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Goal box interiors for both goals. Returns { net: sides + roof + floor fillet bands, portal: back walls }.
 * aTeam = the team that DEFENDS the goal (0 = -Z goal, 1 = +Z goal).
 */
export function buildGoalGeometries(): { net: BufferGeometry; portal: BufferGeometry } {
  const net: GridBuilder = { pos: [], nor: [], team: [], idx: [] };
  const portal: GridBuilder = { pos: [], nor: [], team: [], idx: [] };
  const z0 = GOAL_BOX.z0;
  const z1 = GOAL_BOX.z1;
  const h = new Vector3(G, GH / 2, (z1 - z0) / 2);
  const step = 0.5;
  const xs = axisSamples(h.x, RG, step);
  const ys = axisSamples(h.y, RG, step);
  const zsFull = axisSamples(h.z, RG, step);
  for (const team of [0, 1]) {
    const sz = team === 0 ? -1 : 1;
    const center = new Vector3(0, GH / 2, sz * (z0 + z1) * 0.5);
    // local z axis: for the -Z goal the "back" is at local -h.z. We generate in local coords with the back at
    // local z = sz * h.z.
    // side walls x = ±h.x
    for (const sx of [-1, 1]) {
      const fn = new Vector3(sx, 0, 0);
      addFace(net, team, center, h, RG, fn, 'z', 'y', zsFull, ys, sx < 0);
    }
    // roof y = +h.y
    addFace(net, team, center, h, RG, new Vector3(0, 1, 0), 'x', 'z', xs, zsFull, false);
    // floor fillet bands (only the rounded strips; the flat floor is the arena floor mesh)
    const bandX = axisSamples(h.x, RG, 100).filter((v) => Math.abs(v) >= h.x - RG - 1e-6);
    const left = bandX.filter((v) => v < 0);
    const right = bandX.filter((v) => v > 0);
    addFace(net, team, center, h, RG, new Vector3(0, -1, 0), 'x', 'z', left, zsFull, true);
    addFace(net, team, center, h, RG, new Vector3(0, -1, 0), 'x', 'z', right, zsFull, true);
    // back floor band (z within RG of the back), between the side bands
    const backZ = zsFull.filter((v) => sz * v >= h.z - RG - 1e-6);
    const midX = xs.filter((v) => Math.abs(v) <= h.x - RG + 1e-6);
    addFace(net, team, center, h, RG, new Vector3(0, -1, 0), 'x', 'z', midX, backZ, true);
    // back wall (portal)
    addFace(portal, team, center, h, RG, new Vector3(0, 0, sz), 'x', 'y', xs, ys, sz > 0);
  }
  return { net: finishGrid(net), portal: finishGrid(portal) };
}

/**
 * Goal frame tubes (both goals) with the physics radius profile. Attributes: position, normal, aTeam
 * (defending team), aArc (arclength along the frame, m), aRad (tube radius at that ring).
 */
export function buildGoalFrameGeometry(radialSegments = 18): BufferGeometry {
  const paths = goalFramePaths(24);
  const pos: number[] = [];
  const nor: number[] = [];
  const team: number[] = [];
  const arc: number[] = [];
  const rad: number[] = [];
  const idx: number[] = [];
  const T = new Vector3();
  const N = new Vector3();
  const B = new Vector3();
  const prevN = new Vector3();
  for (const path of paths) {
    // round the two sharp crossbar corners (replace the corner point with a short arc)
    const pts: Vector3[] = [];
    const rs: number[] = [];
    const src = path.points;
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      const isCorner = i > 0 && i < src.length - 1 && Math.abs(p.y - GH) < 1e-6 && Math.abs(Math.abs(p.x) - G) < 1e-6;
      if (!isCorner) {
        // skip exact duplicates
        if (pts.length && pts[pts.length - 1].distanceTo(p) < 1e-5) continue;
        pts.push(p.clone());
        rs.push(path.radius[i]);
        continue;
      }
      const a = src[i - 1];
      const b = src[i + 1];
      const da = new Vector3().subVectors(a, p).normalize();
      const db = new Vector3().subVectors(b, p).normalize();
      const rr = 0.45;
      const pa = p.clone().addScaledVector(da, rr);
      const pb = p.clone().addScaledVector(db, rr);
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        // quadratic bezier pa -> p -> pb
        const q = new Vector3()
          .copy(pa)
          .multiplyScalar((1 - t) * (1 - t))
          .addScaledVector(p, 2 * (1 - t) * t)
          .addScaledVector(pb, t * t);
        pts.push(q);
        rs.push(path.radius[i]);
      }
    }
    // cumulative arclength
    const arcs: number[] = [0];
    for (let i = 1; i < pts.length; i++) arcs.push(arcs[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      T.subVectors(b, a).normalize();
      if (i === 0) {
        // initial normal: any vector perpendicular to T
        N.set(0, 0, 1);
        if (Math.abs(N.dot(T)) > 0.9) N.set(1, 0, 0);
        N.addScaledVector(T, -N.dot(T)).normalize();
      } else {
        // parallel transport
        N.copy(prevN).addScaledVector(T, -prevN.dot(T)).normalize();
      }
      prevN.copy(N);
      B.crossVectors(T, N).normalize();
      for (let k = 0; k <= radialSegments; k++) {
        const ang = (k / radialSegments) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sx = Math.sin(ang);
        const nx = N.x * cx + B.x * sx;
        const ny = N.y * cx + B.y * sx;
        const nz = N.z * cx + B.z * sx;
        pos.push(p.x + nx * rs[i], p.y + ny * rs[i], p.z + nz * rs[i]);
        nor.push(nx, ny, nz);
        team.push(path.goal);
        arc.push(arcs[i]);
        rad.push(rs[i]);
      }
    }
    const ring = radialSegments + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let k = 0; k < radialSegments; k++) {
        const a = base + i * ring + k;
        const b = a + ring;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('aTeam', new Float32BufferAttribute(team, 1));
  geo.setAttribute('aArc', new Float32BufferAttribute(arc, 1));
  geo.setAttribute('aRad', new Float32BufferAttribute(rad, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Dev check: max |arenaSDF| over the vertices of a geometry (optionally only vertices where `filter` is true).
 * Surfaces generated from the physics should report ~0 (float precision).
 */
export function verifyAgainstSDF(geo: BufferGeometry, filter?: (x: number, y: number, z: number) => boolean): { max: number; mean: number; count: number } {
  const p = geo.getAttribute('position') as BufferAttribute;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (filter && !filter(x, y, z)) continue;
    const d = Math.abs(arenaSDF(x, y, z));
    max = Math.max(max, d);
    sum += d;
    count++;
  }
  return { max, mean: count ? sum / count : 0, count };
}

/** Rounded-rectangle SDF (2D), negative inside. */
export function roundRectSDF(x: number, z: number, hx: number, hz: number, r: number): number {
  const qx = Math.abs(x) - hx + r;
  const qz = Math.abs(z) - hz + r;
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  return Math.min(Math.max(qx, qz), 0) + Math.hypot(ox, oz) - r;
}
