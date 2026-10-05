/**
 * Procedural hover-car designs (3 styles). Each style is built ONCE into three merged geometries:
 *   shell — every lit surface (paint, carbon, dark metal, chrome, glass) with per-vertex material attributes,
 *   glow  — every emissive trim (team strips, hover pads, thruster rings, head/tail lights),
 *   fx    — additive plasma plumes + hover light cones.
 * Geometries are cached and shared by all CarViews of the same style (ref-counted).
 *
 * Car local frame: +Z forward, +Y up, +X left. Origin = hitbox center. Hitbox half extents 0.46 × 0.20 × 0.66.
 * The surface under a grounded car is at y = -0.45.
 */
import {
  BufferGeometry,
  CircleGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Shape,
  Sphere,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarStyleId } from '../../sim/types';
import { GeoAccumulator, Loft, LP, tubeThrough, xform, type AttribValues } from './geo';

// -----------------------------------------------------------------------------------------------
// Hardpoints (static data shared with the VFX system)
// -----------------------------------------------------------------------------------------------

export interface CarHardpoints {
  /** Thruster nozzle exit centers (car local) and radius. */
  thrusters: ReadonlyArray<{ x: number; y: number; z: number; r: number }>;
  /** Hover pad glow-disc centers (car local) and radius. */
  pads: ReadonlyArray<{ x: number; y: number; z: number; r: number }>;
  /** Supersonic streak origins (car local). */
  wingtips: ReadonlyArray<{ x: number; y: number; z: number }>;
}

export const GROUND_Y = -0.45;

export const CAR_HARDPOINTS: Record<CarStyleId, CarHardpoints> = {
  striker: {
    thrusters: [
      { x: 0.235, y: -0.035, z: -0.712, r: 0.078 },
      { x: -0.235, y: -0.035, z: -0.712, r: 0.078 },
    ],
    pads: [
      { x: 0.31, y: -0.217, z: 0.38, r: 0.07 },
      { x: -0.31, y: -0.217, z: 0.38, r: 0.07 },
      { x: 0.33, y: -0.217, z: -0.44, r: 0.07 },
      { x: -0.33, y: -0.217, z: -0.44, r: 0.07 },
    ],
    wingtips: [
      { x: 0.41, y: 0.22, z: -0.62 },
      { x: -0.41, y: 0.22, z: -0.62 },
    ],
  },
  viper: {
    thrusters: [
      { x: 0.325, y: -0.075, z: -0.7, r: 0.07 },
      { x: -0.325, y: -0.075, z: -0.7, r: 0.07 },
    ],
    pads: [
      { x: 0.325, y: -0.216, z: 0.18, r: 0.062 },
      { x: -0.325, y: -0.216, z: 0.18, r: 0.062 },
      { x: 0.325, y: -0.216, z: -0.46, r: 0.062 },
      { x: -0.325, y: -0.216, z: -0.46, r: 0.062 },
    ],
    wingtips: [
      { x: 0.35, y: 0.16, z: -0.6 },
      { x: -0.35, y: 0.16, z: -0.6 },
    ],
  },
  titan: {
    thrusters: [
      { x: 0.25, y: 0.0, z: -0.72, r: 0.088 },
      { x: -0.25, y: 0.0, z: -0.72, r: 0.088 },
    ],
    pads: [
      { x: 0.33, y: -0.217, z: 0.42, r: 0.078 },
      { x: -0.33, y: -0.217, z: 0.42, r: 0.078 },
      { x: 0.33, y: -0.217, z: -0.42, r: 0.078 },
      { x: -0.33, y: -0.217, z: -0.42, r: 0.078 },
    ],
    wingtips: [
      { x: 0.47, y: 0.14, z: -0.55 },
      { x: -0.47, y: 0.14, z: -0.55 },
    ],
  },
};

// -----------------------------------------------------------------------------------------------
// Material slots (per-vertex attributes for the patched physical material)
// -----------------------------------------------------------------------------------------------

const SHELL_SPEC = { aBase: 3, aMat: 4 };
const GLOW_SPEC = { aGlow: 4, aT: 1 };
const FX_SPEC = { aFx: 4, aOrigin: 3, aRad: 3 };

/** aMat = (paint mix, roughness, metalness, clearcoat). */
const PAINT: AttribValues = { aBase: [1, 1, 1], aMat: [1, 0.3, 0.55, 1] };
const PAINT_DEEP: AttribValues = { aBase: [0.012, 0.014, 0.018], aMat: [0.3, 0.3, 0.6, 1] };
const CARBON: AttribValues = { aBase: [0.022, 0.024, 0.029], aMat: [0, 0.3, 0.45, 0.85] };
const METAL: AttribValues = { aBase: [0.11, 0.115, 0.13], aMat: [0, 0.4, 0.88, 0] };
const CHROME: AttribValues = { aBase: [0.78, 0.8, 0.84], aMat: [0, 0.13, 1, 0] };
const GLASS: AttribValues = { aBase: [0.006, 0.009, 0.016], aMat: [0, 0.035, 0.25, 1] };

/** aGlow = (team weight, white weight, red weight, animation group). Groups: 0 trim, 1 pad, 2 thruster, 3 tail, 4 head, 5 chase. */
const G_TRIM: AttribValues = { aGlow: [1, 0.05, 0, 0], aT: [0] };
const G_PAD: AttribValues = { aGlow: [0.5, 0.05, 0, 1], aT: [0] };
const G_PAD_DISC: AttribValues = { aGlow: [0.35, 0.03, 0, 1], aT: [0] };
const G_THRUST: AttribValues = { aGlow: [1, 0.2, 0, 2], aT: [0] };
const G_THRUST_CORE: AttribValues = { aGlow: [0.7, 0.3, 0, 2], aT: [0] };
const G_TAIL: AttribValues = { aGlow: [0, 0, 1, 3], aT: [0] };
const G_HEAD: AttribValues = { aGlow: [0.35, 0.8, 0, 4], aT: [0] };
const G_CHASE: AttribValues = { aGlow: [1, 0.08, 0, 5], aT: [0] };

/** Tube hook: aT = uv.x (0..1 along the tube). */
const tubeT = () => (i: number, g: BufferGeometry, out: Record<string, number[]>) => {
  const uv = g.attributes.uv;
  out.aT[0] = uv ? uv.getX(i) : 0;
};

interface Builders {
  shell: GeoAccumulator;
  glow: GeoAccumulator;
  fx: GeoAccumulator;
}

function newBuilders(): Builders {
  return { shell: new GeoAccumulator(SHELL_SPEC), glow: new GeoAccumulator(GLOW_SPEC), fx: new GeoAccumulator(FX_SPEC) };
}

// -----------------------------------------------------------------------------------------------
// Part helpers
// -----------------------------------------------------------------------------------------------

/** Lathe around an axis pointing along -Z (profile: [radius, axial] pairs; axial 0 = mount plane). */
function latheBack(profile: Array<[number, number]>, segs: number): LatheGeometry {
  const g = new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segs,
  );
  g.applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2));
  return g;
}

/** Lathe around -Y (hanging pods). profile: [radius, depth below mount]. */
function latheDown(profile: Array<[number, number]>, segs: number): LatheGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, -y)),
    segs,
  );
}

/** Airfoil / blade outline in XY: leading edge at x = 0, trailing edge at x = chord. */
function airfoilShape(chord: number, thick: number, camber = 0.0): Shape {
  const s = new Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0, thick * 0.85, chord * 0.2, thick * 1.05 + camber, chord * 0.45, thick * 0.95 + camber);
  s.bezierCurveTo(chord * 0.75, thick * 0.8 + camber * 0.6, chord * 0.95, thick * 0.35, chord, thick * 0.08);
  s.lineTo(chord, -thick * 0.05);
  s.bezierCurveTo(chord * 0.7, -thick * 0.2, chord * 0.3, -thick * 0.35, 0, 0);
  return s;
}

function extrudeCreased(shape: Shape, depth: number, bevel: number, creaseDeg = 40, bevelSegs = 2): BufferGeometry {
  const g = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: bevelSegs,
    curveSegments: 10,
  });
  return toCreasedNormals(g, (creaseDeg * Math.PI) / 180);
}

/** A wing spanning X (centered at x = cx), chord along -Z from zLE, at height y. */
function wing(chord: number, thick: number, span: number, cx: number, y: number, zLE: number, pitch = 0): BufferGeometry {
  const g = extrudeCreased(airfoilShape(chord, thick, thick * 0.3), span, Math.min(thick * 0.3, 0.006));
  g.applyMatrix4(new Matrix4().makeRotationY(Math.PI / 2));
  g.applyMatrix4(new Matrix4().makeRotationX(pitch));
  g.applyMatrix4(new Matrix4().makeTranslation(cx - span / 2, y, zLE));
  return g;
}

/** A vertical plate/fin in the YZ plane (outline in (z, y) with z forward), thickness along X, centered at x. */
function fin(outline: Array<[number, number]>, thickness: number, x: number, bevel = 0.004): BufferGeometry {
  const s = new Shape();
  outline.forEach(([z, y], i) => (i === 0 ? s.moveTo(z, y) : s.lineTo(z, y)));
  s.closePath();
  const g = extrudeCreased(s, thickness, bevel, 35, 2);
  g.applyMatrix4(new Matrix4().makeRotationY(-Math.PI / 2));
  g.applyMatrix4(new Matrix4().makeTranslation(x + thickness / 2, 0, 0));
  return g;
}

/** A flat plate in the XZ plane (outline in (x, z)), thickness along Y, bottom at y. */
function plate(outline: Array<[number, number]>, thickness: number, y: number, bevel = 0.004): BufferGeometry {
  const s = new Shape();
  outline.forEach(([x, z], i) => (i === 0 ? s.moveTo(x, -z) : s.lineTo(x, -z)));
  s.closePath();
  const g = extrudeCreased(s, thickness, bevel, 35, 2);
  g.applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2));
  g.applyMatrix4(new Matrix4().makeTranslation(0, y, 0));
  return g;
}

/** Thruster nozzle + glowing rings + plume geometry. Mount plane at z = mountZ, exit at exitZ. */
function addThruster(b: Builders, x: number, y: number, mountZ: number, exitZ: number, r: number, housing = METAL): void {
  const len = mountZ - exitZ;
  const nozzle = latheBack(
    [
      [r * 0.82, -0.02],
      [r * 1.02, len * 0.12],
      [r * 1.12, len * 0.62],
      [r * 1.1, len * 0.94],
      [r * 1.02, len],
      [r * 0.9, len * 1.01],
      [r * 0.84, len * 0.9],
      [r * 0.78, len * 0.45],
      [r * 0.72, len * 0.1],
    ],
    24,
  );
  b.shell.add(nozzle, xform(x, y, mountZ), housing);
  b.shell.add(new TorusGeometry(r * 0.96, r * 0.07, 6, 24), xform(x, y, exitZ + 0.002), CHROME);
  b.glow.add(new TorusGeometry(r * 0.72, r * 0.09, 6, 24), xform(x, y, exitZ + len * 0.35), G_THRUST);
  b.glow.add(new CircleGeometry(r * 0.72, 24), xform(x, y, exitZ + len * 0.6, 0, Math.PI, 0), G_THRUST_CORE);
  addPlume(b.fx, x, y, exitZ + len * 0.4, r * 0.78);
}

/**
 * Plume proxy volume at unit length along -Z from the origin (rescaled in the vertex shader). The shading is
 * analytic (see carMaterials), so the mesh only has to contain the glow: it is ~1.8x the visual radius.
 */
function addPlume(fx: GeoAccumulator, ox: number, oy: number, oz: number, r0: number): void {
  const RINGS = 10;
  const SEG = 12;
  const base = fx.vertexCount;
  for (let i = 0; i <= RINGS; i++) {
    const t = Math.pow(i / RINGS, 1.2);
    const bulge = 1 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.4)) * (1 - t);
    const r = r0 * 1.9 * bulge * Math.pow(Math.max(0, 1 - t), 0.5) + 0.004;
    // start slightly behind the origin so the volume fully contains the nozzle exit
    const z = oz + 0.03 - t * 1.03;
    for (let j = 0; j < SEG; j++) {
      const ang = (j / SEG) * Math.PI * 2;
      const cx = Math.cos(ang);
      const cy = Math.sin(ang);
      fx.addVertex(ox + cx * r, oy + cy * r, z, cx, cy, 0, { aFx: [0, t, j / SEG, r0], aOrigin: [ox, oy, oz], aRad: [cx, cy, 0] });
    }
  }
  // close both ends so the back-face layer is watertight
  const c0 = fx.addVertex(ox, oy, oz + 0.03, 0, 0, 1, { aFx: [0, 0, 0, r0], aOrigin: [ox, oy, oz], aRad: [0, 0, 1] });
  const c1 = fx.addVertex(ox, oy, oz - 1.0, 0, 0, -1, { aFx: [0, 1, 0, r0], aOrigin: [ox, oy, oz], aRad: [0, 0, -1] });
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = base + i * SEG + j;
      const bb = base + i * SEG + ((j + 1) % SEG);
      const c = base + (i + 1) * SEG + ((j + 1) % SEG);
      const d = base + (i + 1) * SEG + j;
      fx.addTri(a, bb, d);
      fx.addTri(bb, c, d);
    }
  }
  for (let j = 0; j < SEG; j++) {
    fx.addTri(c0, base + ((j + 1) % SEG), base + j);
    fx.addTri(c1, base + RINGS * SEG + j, base + RINGS * SEG + ((j + 1) % SEG));
  }
}

/** Hover pod (dark metal puck) + glow disc + rim ring + light cone to the surface. */
function addHoverPod(b: Builders, x: number, padY: number, z: number, r: number, mountY: number, housing = METAL): void {
  const depth = mountY - padY;
  const pod = latheDown(
    [
      [0.0001, 0],
      [r * 1.32, 0],
      [r * 1.52, depth * 0.3],
      [r * 1.5, depth * 0.75],
      [r * 1.3, depth * 0.98],
      [r * 1.12, depth],
      [0.0001, depth],
    ],
    20,
  );
  b.shell.add(pod, xform(x, mountY, z), housing);
  b.glow.add(new CircleGeometry(r, 20), xform(x, padY - 0.002, z, Math.PI / 2, 0, 0), G_PAD_DISC);
  b.glow.add(new TorusGeometry(r * 1.42, 0.006, 5, 28), xform(x, mountY - depth * 0.55, z, Math.PI / 2, 0, 0), G_PAD);
  addPadCone(b.fx, x, padY - 0.004, z, r);
}

function addPadCone(fx: GeoAccumulator, ox: number, oy: number, oz: number, r: number): void {
  const RINGS = 5;
  const SEG = 14;
  const h = oy - GROUND_Y;
  const base = fx.vertexCount;
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const rr = r * (0.92 + 0.55 * t);
    for (let j = 0; j < SEG; j++) {
      const ang = (j / SEG) * Math.PI * 2;
      const cx = Math.cos(ang);
      const cz = Math.sin(ang);
      fx.addVertex(ox + cx * rr, oy - h * t * 0.85, oz + cz * rr, cx, 0, cz, { aFx: [2, t, j / SEG, 0], aOrigin: [ox, oy, oz], aRad: [cx, 0, cz] });
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = base + i * SEG + j;
      const bb = base + i * SEG + ((j + 1) % SEG);
      const c = base + (i + 1) * SEG + ((j + 1) % SEG);
      const d = base + (i + 1) * SEG + j;
      fx.addTri(a, bb, d);
      fx.addTri(bb, c, d);
    }
  }
  // contact glow quad on the surface under the pad (kind 3; aFx.yz = quad coords in [-1, 1])
  const q = r * 3.2;
  const gy = GROUND_Y + 0.012;
  const v0 = fx.vertexCount;
  for (const [u, v] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    fx.addVertex(ox + u * q, gy, oz + v * q, 0, 1, 0, { aFx: [3, u, v, 0], aOrigin: [ox, gy, oz], aRad: [0, 1, 0] });
  }
  fx.addTri(v0, v0 + 2, v0 + 1);
  fx.addTri(v0, v0 + 3, v0 + 2);
}

/** Glowing tube following the loft surface along the profile line p = const. */
function surfaceStrip(b: Builders, loft: Loft, p: number, z0: number, z1: number, radius: number, vals: AttribValues, segs = 28): void {
  const pts = loft.curve(p, z0, z1, 20, radius * 0.3);
  b.glow.add(tubeThrough(pts, radius, segs, 5), null, vals, tubeT());
}

const M = LP.mirror;
const inRange = (p: number, a: number, b: number) => p >= a && p <= b;
/** Profile regions: upper body (belt crease over the roof to the other belt crease), underside. */
const isUpper = (p: number) => inRange(p, 0.5, 8.5);
const isUnder = (p: number) => inRange(p, 10.5, 14.5);
const isCanopyHidden = (p: number) => inRange(p, 9.6, 15.4);
const V = (x: number, y: number, z: number) => new Vector3(x, y, z);

// -----------------------------------------------------------------------------------------------
// STRIKER — balanced wedge with fender haunches
// -----------------------------------------------------------------------------------------------

function buildStriker(): Builders {
  const b = newBuilders();
  const hp = CAR_HARDPOINTS.striker;
  const R = { r0: 1, r1: 0.5, r2: 0.34, r3: 0.6, r4: 1 };
  const body = new Loft([
    { z: -0.664, yTop: 0.104, rw: 0.29, ry: 0.094, hw: 0.395, yMid: -0.022, bw: 0.33, yBot: -0.148, ...R },
    { z: -0.648, yTop: 0.126, rw: 0.315, ry: 0.115, hw: 0.432, yMid: -0.026, bw: 0.365, yBot: -0.172, ...R },
    { z: -0.45, yTop: 0.142, rw: 0.33, ry: 0.128, hw: 0.462, yMid: -0.032, bw: 0.39, yBot: -0.192, ...R },
    { z: -0.06, yTop: 0.104, rw: 0.29, ry: 0.088, hw: 0.422, yMid: -0.046, bw: 0.365, yBot: -0.2, ...R },
    { z: 0.36, yTop: 0.036, rw: 0.285, ry: 0.024, hw: 0.448, yMid: -0.066, bw: 0.38, yBot: -0.196, ...R },
    { z: 0.585, yTop: -0.026, rw: 0.245, ry: -0.036, hw: 0.37, yMid: -0.088, bw: 0.31, yBot: -0.178, ...R },
    { z: 0.68, yTop: -0.066, rw: 0.175, ry: -0.072, hw: 0.24, yMid: -0.102, bw: 0.21, yBot: -0.152, ...R },
    { z: 0.712, yTop: -0.09, rw: 0.06, ry: -0.092, hw: 0.08, yMid: -0.108, bw: 0.07, yBot: -0.128, ...R },
  ]);
  body.emit(
    [
      [b.shell, PAINT],
      [b.shell, PAINT_DEEP],
      [b.shell, CARBON],
      [b.shell, METAL],
    ],
    (z, p) => {
      if (isUnder(p)) return 3;
      if (!isUpper(p)) return 2; // lower flanks below the belt crease
      if (z > 0.62) return 2; // nose cone
      if (z < -0.42 && inRange(p, 3.6, 5.4)) return 1; // rear deck spine channel
      return 0;
    },
    { step: 0.031, capRear: 3, capFront: 2, zSplits: [-0.42, 0.62] },
  );

  const RC = { r1: 0.8, r2: 0.6 };
  const canopy = new Loft([
    { z: -0.37, yTop: 0.134, rw: 0.05, ry: 0.13, hw: 0.075, yMid: 0.112, bw: 0.06, yBot: 0.07, ...RC },
    { z: -0.26, yTop: 0.19, rw: 0.13, ry: 0.176, hw: 0.188, yMid: 0.112, bw: 0.17, yBot: 0.04, ...RC },
    { z: -0.06, yTop: 0.214, rw: 0.15, ry: 0.198, hw: 0.214, yMid: 0.096, bw: 0.2, yBot: 0.02, ...RC },
    { z: 0.14, yTop: 0.174, rw: 0.135, ry: 0.16, hw: 0.2, yMid: 0.066, bw: 0.19, yBot: 0.0, ...RC },
    { z: 0.3, yTop: 0.086, rw: 0.08, ry: 0.078, hw: 0.14, yMid: 0.03, bw: 0.13, yBot: -0.01, ...RC },
    { z: 0.372, yTop: 0.032, rw: 0.02, ry: 0.03, hw: 0.035, yMid: 0.02, bw: 0.03, yBot: 0.0, ...RC },
  ]);
  canopy.emit([[b.shell, GLASS]], (_z, p) => (isCanopyHidden(p) ? -1 : 0), { step: 0.03, density: 0.8 });

  // rear wing on struts + endplates
  b.shell.add(wing(0.15, 0.022, 0.8, 0, 0.178, -0.5, 0.06), null, CARBON);
  for (const sx of [1, -1]) {
    b.shell.add(
      fin(
        [
          [-0.47, 0.12],
          [-0.52, 0.19],
          [-0.6, 0.19],
          [-0.62, 0.12],
        ],
        0.026,
        sx * 0.2,
      ),
      null,
      METAL,
    );
    b.shell.add(
      fin(
        [
          [-0.46, 0.15],
          [-0.5, 0.208],
          [-0.665, 0.208],
          [-0.672, 0.15],
          [-0.6, 0.128],
        ],
        0.016,
        sx * 0.408,
      ),
      null,
      PAINT,
    );
    b.glow.add(tubeThrough([V(sx * 0.408, 0.211, -0.5), V(sx * 0.408, 0.211, -0.58), V(sx * 0.408, 0.211, -0.66)], 0.006, 8, 5), null, G_TRIM);
  }
  b.glow.add(tubeThrough([V(0.39, 0.188, -0.654), V(0, 0.19, -0.656), V(-0.39, 0.188, -0.654)], 0.006, 20, 5), null, G_TRIM);
  // front splitter blade + edge light
  b.shell.add(
    plate(
      [
        [0.3, 0.6],
        [0.36, 0.5],
        [-0.36, 0.5],
        [-0.3, 0.6],
        [-0.12, 0.708],
        [0.12, 0.708],
      ],
      0.014,
      -0.166,
    ),
    null,
    CARBON,
  );
  b.glow.add(tubeThrough([V(0.3, -0.158, 0.61), V(0.12, -0.158, 0.7), V(-0.12, -0.158, 0.7), V(-0.3, -0.158, 0.61)], 0.005, 20, 5), null, G_TRIM);
  // rear diffuser fins
  for (const x of [-0.1, 0, 0.1]) {
    b.shell.add(
      fin(
        [
          [-0.5, -0.19],
          [-0.66, -0.15],
          [-0.672, -0.12],
          [-0.52, -0.16],
        ],
        0.012,
        x,
      ),
      null,
      CARBON,
    );
  }

  for (const t of hp.thrusters) addThruster(b, t.x, t.y, -0.652, t.z, t.r);
  b.shell.add(new RoundedBoxGeometry(0.64, 0.13, 0.03, 2, 0.012), xform(0, -0.035, -0.652), METAL);
  for (const p of hp.pads) addHoverPod(b, p.x, p.y, p.z, p.r, -0.16);

  // light strips: belt chase lines, rear-deck spine, tail bar, head lights
  surfaceStrip(b, body, 0.72, 0.6, -0.63, 0.0082, G_CHASE);
  surfaceStrip(b, body, M(0.72), 0.6, -0.63, 0.0082, G_CHASE);
  surfaceStrip(b, body, 4.28, -0.39, -0.646, 0.0055, G_TRIM, 12);
  surfaceStrip(b, body, 4.72, -0.39, -0.646, 0.0055, G_TRIM, 12);
  b.glow.add(tubeThrough(body.ring(-0.655, 0.62, 8.38, 36, 0.004, -0.004), 0.009, 44, 5), null, G_TAIL, tubeT());
  b.glow.add(tubeThrough(body.ring(0.618, 0.58, 1.9, 10, 0.004), 0.0105, 12, 5), null, G_HEAD);
  b.glow.add(tubeThrough(body.ring(0.618, 7.1, 8.42, 10, 0.004), 0.0105, 12, 5), null, G_HEAD);
  return b;
}

// -----------------------------------------------------------------------------------------------
// VIPER — low, long, needle-nosed with outrigger nacelles
// -----------------------------------------------------------------------------------------------

function buildViper(): Builders {
  const b = newBuilders();
  const hp = CAR_HARDPOINTS.viper;
  const R = { r0: 1, r1: 0.55, r2: 0.26, r3: 0.6, r4: 1 };
  const fus = new Loft([
    { z: -0.642, yTop: 0.058, rw: 0.12, ry: 0.048, hw: 0.172, yMid: -0.03, bw: 0.13, yBot: -0.11, ...R },
    { z: -0.625, yTop: 0.083, rw: 0.138, ry: 0.07, hw: 0.2, yMid: -0.034, bw: 0.15, yBot: -0.135, ...R },
    { z: -0.42, yTop: 0.1, rw: 0.15, ry: 0.082, hw: 0.232, yMid: -0.04, bw: 0.162, yBot: -0.158, ...R },
    { z: -0.1, yTop: 0.08, rw: 0.14, ry: 0.06, hw: 0.222, yMid: -0.05, bw: 0.158, yBot: -0.165, ...R },
    { z: 0.2, yTop: 0.03, rw: 0.1, ry: 0.015, hw: 0.165, yMid: -0.066, bw: 0.12, yBot: -0.155, ...R },
    { z: 0.45, yTop: -0.02, rw: 0.058, ry: -0.03, hw: 0.098, yMid: -0.08, bw: 0.07, yBot: -0.135, ...R },
    { z: 0.64, yTop: -0.066, rw: 0.024, ry: -0.07, hw: 0.044, yMid: -0.093, bw: 0.03, yBot: -0.118, ...R },
    { z: 0.722, yTop: -0.096, rw: 0.004, ry: -0.097, hw: 0.007, yMid: -0.1, bw: 0.005, yBot: -0.104, ...R },
  ]);
  fus.emit(
    [
      [b.shell, PAINT],
      [b.shell, CARBON],
      [b.shell, METAL],
      [b.shell, PAINT_DEEP],
    ],
    (z, p) => {
      if (isUnder(p)) return 2;
      if (!isUpper(p)) return 1;
      if (z > 0.5) return 1; // carbon needle
      if (z < -0.44 && inRange(p, 3.7, 5.3)) return 3;
      return 0;
    },
    { step: 0.032, capRear: 2, zSplits: [0.5, -0.44] },
  );
  const RC = { r1: 0.8, r2: 0.6 };
  const canopy = new Loft([
    { z: -0.45, yTop: 0.1, rw: 0.03, ry: 0.098, hw: 0.05, yMid: 0.08, bw: 0.04, yBot: 0.05, ...RC },
    { z: -0.33, yTop: 0.146, rw: 0.08, ry: 0.138, hw: 0.12, yMid: 0.074, bw: 0.1, yBot: 0.02, ...RC },
    { z: -0.16, yTop: 0.158, rw: 0.09, ry: 0.148, hw: 0.135, yMid: 0.06, bw: 0.12, yBot: 0.0, ...RC },
    { z: 0.0, yTop: 0.118, rw: 0.075, ry: 0.11, hw: 0.115, yMid: 0.04, bw: 0.1, yBot: -0.01, ...RC },
    { z: 0.13, yTop: 0.05, rw: 0.04, ry: 0.047, hw: 0.06, yMid: 0.02, bw: 0.05, yBot: -0.01, ...RC },
    { z: 0.172, yTop: 0.018, rw: 0.008, ry: 0.017, hw: 0.012, yMid: 0.012, bw: 0.01, yBot: 0.004, ...RC },
  ]);
  canopy.emit([[b.shell, GLASS]], (_z, p) => (isCanopyHidden(p) ? -1 : 0), { step: 0.03, density: 0.7 });

  for (const sx of [1, -1]) {
    const cx = sx * 0.325;
    const RN = { r0: 1, r1: 0.6, r2: 0.4, r3: 0.6, r4: 1, cx };
    const nac = new Loft([
      { z: -0.646, yTop: 0.0, rw: 0.05, ry: -0.006, hw: 0.084, yMid: -0.075, bw: 0.06, yBot: -0.145, ...RN },
      { z: -0.628, yTop: 0.02, rw: 0.064, ry: 0.012, hw: 0.1, yMid: -0.075, bw: 0.074, yBot: -0.165, ...RN },
      { z: -0.3, yTop: 0.04, rw: 0.07, ry: 0.03, hw: 0.112, yMid: -0.078, bw: 0.084, yBot: -0.19, ...RN },
      { z: 0.08, yTop: 0.02, rw: 0.065, ry: 0.01, hw: 0.104, yMid: -0.082, bw: 0.08, yBot: -0.19, ...RN },
      { z: 0.3, yTop: -0.03, rw: 0.04, ry: -0.036, hw: 0.068, yMid: -0.09, bw: 0.05, yBot: -0.165, ...RN },
      { z: 0.43, yTop: -0.093, rw: 0.006, ry: -0.094, hw: 0.012, yMid: -0.1, bw: 0.008, yBot: -0.108, ...RN },
    ]);
    nac.emit(
      [
        [b.shell, PAINT],
        [b.shell, CARBON],
        [b.shell, METAL],
      ],
      (z, p) => {
        if (isUnder(p)) return 2;
        if (z > 0.3) return 1;
        if (!isUpper(p)) return 1;
        return 0;
      },
      { step: 0.036, capRear: 2, density: 0.62 },
    );
    surfaceStrip(b, nac, sx > 0 ? 2.3 : M(2.3), 0.34, -0.63, 0.0072, G_CHASE);
    b.shell.add(
      plate(
        [
          [sx * 0.16, 0.08],
          [sx * 0.24, 0.02],
          [sx * 0.26, -0.44],
          [sx * 0.16, -0.36],
        ],
        0.018,
        -0.078,
      ),
      null,
      PAINT,
    );
    b.shell.add(
      fin(
        [
          [-0.32, 0.02],
          [-0.52, 0.168],
          [-0.62, 0.168],
          [-0.6, 0.0],
        ],
        0.014,
        cx,
      ),
      null,
      PAINT,
    );
    b.glow.add(tubeThrough([V(cx, 0.03, -0.34), V(cx, 0.1, -0.44), V(cx, 0.172, -0.525), V(cx, 0.172, -0.615)], 0.0055, 14, 5), null, G_TRIM);
    b.glow.add(new TorusGeometry(0.094, 0.0072, 5, 28, Math.PI * 1.25), xform(cx, -0.075, -0.648, 0, 0, -Math.PI * 0.125), G_TAIL);
  }
  b.shell.add(wing(0.12, 0.018, 0.7, 0, 0.152, -0.5, 0.05), null, CARBON);
  b.glow.add(tubeThrough([V(0.34, 0.158, -0.62), V(0, 0.16, -0.622), V(-0.34, 0.158, -0.62)], 0.0055, 20, 5), null, G_TRIM);

  for (const t of hp.thrusters) addThruster(b, t.x, t.y, -0.64, t.z, t.r);
  for (const p of hp.pads) addHoverPod(b, p.x, p.y, p.z, p.r, -0.17);

  surfaceStrip(b, fus, 0.7, 0.42, -0.6, 0.0065, G_CHASE);
  surfaceStrip(b, fus, M(0.7), 0.42, -0.6, 0.0065, G_CHASE);
  surfaceStrip(b, fus, 4.3, -0.46, -0.615, 0.005, G_TRIM, 10);
  surfaceStrip(b, fus, 4.7, -0.46, -0.615, 0.005, G_TRIM, 10);
  b.glow.add(tubeThrough(fus.ring(-0.628, 0.62, 8.38, 22, 0.004, -0.006), 0.008, 28, 5), null, G_TAIL);
  b.glow.add(tubeThrough(fus.curve(4.5, 0.64, 0.716, 6, 0.004), 0.007, 8, 5), null, G_HEAD);
  b.glow.add(tubeThrough(fus.ring(0.4, 0.55, 1.9, 8, 0.004), 0.006, 10, 5), null, G_HEAD);
  b.glow.add(tubeThrough(fus.ring(0.4, 7.1, 8.45, 8, 0.004), 0.006, 10, 5), null, G_HEAD);
  return b;
}

// -----------------------------------------------------------------------------------------------
// TITAN — tall, armored, blunt
// -----------------------------------------------------------------------------------------------

function buildTitan(): Builders {
  const b = newBuilders();
  const hp = CAR_HARDPOINTS.titan;
  const R = { r0: 1, r1: 0.26, r2: 0.3, r3: 0.36, r4: 1 };
  const body = new Loft([
    { z: -0.664, yTop: 0.15, rw: 0.34, ry: 0.145, hw: 0.4, yMid: 0.0, bw: 0.36, yBot: -0.16, ...R },
    { z: -0.646, yTop: 0.172, rw: 0.36, ry: 0.166, hw: 0.428, yMid: 0.0, bw: 0.39, yBot: -0.185, ...R },
    { z: -0.42, yTop: 0.19, rw: 0.37, ry: 0.182, hw: 0.452, yMid: -0.005, bw: 0.41, yBot: -0.21, ...R },
    { z: 0.0, yTop: 0.178, rw: 0.35, ry: 0.17, hw: 0.432, yMid: -0.01, bw: 0.398, yBot: -0.212, ...R },
    { z: 0.42, yTop: 0.1, rw: 0.35, ry: 0.093, hw: 0.452, yMid: -0.02, bw: 0.412, yBot: -0.205, ...R },
    { z: 0.62, yTop: 0.03, rw: 0.33, ry: 0.024, hw: 0.412, yMid: -0.03, bw: 0.38, yBot: -0.19, ...R },
    { z: 0.668, yTop: 0.0, rw: 0.3, ry: -0.004, hw: 0.372, yMid: -0.035, bw: 0.34, yBot: -0.168, ...R },
  ]);
  body.emit(
    [
      [b.shell, PAINT],
      [b.shell, CARBON],
      [b.shell, METAL],
      [b.shell, PAINT_DEEP],
    ],
    (z, p) => {
      if (isUnder(p)) return 2;
      if (!isUpper(p)) return 1;
      if (z > 0.2 && z < 0.46 && inRange(p, 3.0, 6.0)) return 3; // hood panel
      return 0;
    },
    { step: 0.031, capRear: 2, capFront: 1, zSplits: [0.2, 0.46] },
  );
  const RC = { r1: 0.35, r2: 0.4 };
  const canopy = new Loft([
    { z: -0.28, yTop: 0.2, rw: 0.18, ry: 0.195, hw: 0.22, yMid: 0.16, bw: 0.2, yBot: 0.1, ...RC },
    { z: -0.2, yTop: 0.215, rw: 0.27, ry: 0.208, hw: 0.31, yMid: 0.15, bw: 0.3, yBot: 0.08, ...RC },
    { z: 0.04, yTop: 0.216, rw: 0.29, ry: 0.208, hw: 0.335, yMid: 0.14, bw: 0.32, yBot: 0.06, ...RC },
    { z: 0.2, yTop: 0.185, rw: 0.28, ry: 0.178, hw: 0.325, yMid: 0.12, bw: 0.31, yBot: 0.04, ...RC },
    { z: 0.33, yTop: 0.1, rw: 0.24, ry: 0.095, hw: 0.29, yMid: 0.08, bw: 0.28, yBot: 0.03, ...RC },
    { z: 0.38, yTop: 0.065, rw: 0.18, ry: 0.062, hw: 0.21, yMid: 0.055, bw: 0.2, yBot: 0.04, ...RC },
  ]);
  canopy.emit([[b.shell, GLASS]], (_z, p) => (isCanopyHidden(p) ? -1 : 0), { step: 0.03, density: 0.8 });

  for (const p of hp.pads) {
    const sx = Math.sign(p.x);
    b.shell.add(new RoundedBoxGeometry(0.13, 0.12, 0.3, 2, 0.03), xform(sx * 0.412, -0.1, p.z, 0, 0, sx * 0.12), PAINT);
    b.shell.add(new RoundedBoxGeometry(0.06, 0.07, 0.26, 2, 0.02), xform(sx * 0.44, -0.185, p.z), CARBON);
    b.glow.add(tubeThrough([V(sx * 0.482, -0.075, p.z + 0.12), V(sx * 0.486, -0.085, p.z), V(sx * 0.482, -0.095, p.z - 0.12)], 0.0068, 10, 5), null, G_TRIM);
  }
  b.shell.add(new RoundedBoxGeometry(0.84, 0.085, 0.09, 2, 0.03), xform(0, -0.13, 0.64), CARBON);
  b.shell.add(new RoundedBoxGeometry(0.5, 0.05, 0.05, 2, 0.018), xform(0, -0.055, 0.66), METAL);
  b.glow.add(tubeThrough([V(0.36, -0.1, 0.688), V(0, -0.1, 0.692), V(-0.36, -0.1, 0.688)], 0.009, 20, 5), null, { aGlow: [0.75, 0.45, 0, 4], aT: [0] });
  b.shell.add(new RoundedBoxGeometry(0.46, 0.035, 0.34, 2, 0.014), xform(0, 0.188, -0.46), PAINT_DEEP);
  b.shell.add(
    fin(
      [
        [-0.3, 0.195],
        [-0.36, 0.21],
        [-0.52, 0.21],
        [-0.56, 0.195],
      ],
      0.022,
      0,
    ),
    null,
    METAL,
  );
  b.glow.add(tubeThrough([V(0, 0.213, -0.37), V(0, 0.213, -0.44), V(0, 0.213, -0.51)], 0.0055, 8, 5), null, G_TRIM);
  for (const t of hp.thrusters) {
    b.shell.add(new RoundedBoxGeometry(0.25, 0.23, 0.08, 2, 0.03), xform(t.x, t.y, -0.64), METAL);
    addThruster(b, t.x, t.y, -0.675, t.z, t.r, CARBON);
  }
  for (const p of hp.pads) addHoverPod(b, p.x, p.y, p.z, p.r, -0.17);

  surfaceStrip(b, body, 1.25, 0.5, -0.6, 0.0085, G_CHASE);
  surfaceStrip(b, body, M(1.25), 0.5, -0.6, 0.0085, G_CHASE);
  for (const sx of [1, -1]) {
    b.glow.add(tubeThrough([V(sx * 0.37, 0.13, -0.668), V(sx * 0.4, 0.04, -0.668), V(sx * 0.4, -0.08, -0.668)], 0.011, 12, 5), null, G_TAIL);
  }
  surfaceStrip(b, body, 3.3, 0.45, 0.2, 0.0055, G_TRIM, 10);
  surfaceStrip(b, body, M(3.3), 0.45, 0.2, 0.0055, G_TRIM, 10);
  return b;
}

// -----------------------------------------------------------------------------------------------
// Cache
// -----------------------------------------------------------------------------------------------

export interface CarGeometrySet {
  shell: BufferGeometry;
  glow: BufferGeometry;
  fx: BufferGeometry;
  hard: CarHardpoints;
}

const cache = new Map<CarStyleId, { set: CarGeometrySet; refs: number }>();

export function acquireCarGeometry(style: CarStyleId): CarGeometrySet {
  let e = cache.get(style);
  if (!e) {
    const b = style === 'viper' ? buildViper() : style === 'titan' ? buildTitan() : buildStriker();
    const fx = b.fx.build();
    // plumes are rescaled in the vertex shader (up to ~1.6 m long): enlarge the bounds for frustum culling
    fx.boundingSphere = new Sphere(new Vector3(0, 0, -0.6), 2.2);
    e = { set: { shell: b.shell.build(), glow: b.glow.build(), fx, hard: CAR_HARDPOINTS[style] }, refs: 0 };
    cache.set(style, e);
  }
  e.refs++;
  return e.set;
}

export function releaseCarGeometry(style: CarStyleId): void {
  const e = cache.get(style);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) {
    e.set.shell.dispose();
    e.set.glow.dispose();
    e.set.fx.dispose();
    cache.delete(style);
  }
}

/** Debug: triangle counts and bounds (shell + glow) per style. */
export function carGeometryStats(style: CarStyleId): { shell: number; glow: number; fx: number; min: number[]; max: number[] } {
  const g = acquireCarGeometry(style);
  const tri = (x: BufferGeometry) => (x.index ? x.index.count : x.attributes.position.count) / 3;
  const bb = g.shell.boundingBox!.clone().union(g.glow.boundingBox!);
  const r3 = (v: Vector3) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
  const r = { shell: tri(g.shell), glow: tri(g.glow), fx: tri(g.fx), min: r3(bb.min), max: r3(bb.max) };
  releaseCarGeometry(style);
  return r;
}
