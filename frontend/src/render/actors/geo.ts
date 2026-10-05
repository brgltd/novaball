/**
 * Procedural geometry toolkit for the hover cars:
 *  - GeoAccumulator: merges many parts into ONE indexed BufferGeometry with custom per-vertex attributes
 *    (so a whole car body is a single draw call).
 *  - Loft: a car-body surface lofted through rounded-polygon cross-sections (monotone cubic interpolation along Z),
 *    emitted as a grid whose quads can be assigned to different material slots without shading seams.
 */
import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Euler, Matrix3, Matrix4, TubeGeometry, Vector3 } from 'three';

export type AttribValues = Record<string, ArrayLike<number>>;

/** Per-vertex override hook: (vertex index within the part, source geometry, output values by attribute name). */
export type VertexHook = (i: number, g: BufferGeometry, out: Record<string, number[]>) => void;

export class GeoAccumulator {
  private readonly spec: Array<[string, number]>;
  private pos: number[] = [];
  private nrm: number[] = [];
  private idx: number[] = [];
  private data: Record<string, number[]> = {};
  private vcount = 0;
  private readonly tmpP = new Vector3();
  private readonly tmpN = new Vector3();
  private readonly nm = new Matrix3();
  private readonly hookOut: Record<string, number[]> = {};

  constructor(spec: Record<string, number>) {
    this.spec = Object.entries(spec);
    for (const [name, size] of this.spec) {
      this.data[name] = [];
      this.hookOut[name] = new Array<number>(size).fill(0);
    }
  }

  get vertexCount(): number {
    return this.vcount;
  }

  addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, attrs: AttribValues): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    for (const [name, size] of this.spec) {
      const v = attrs[name];
      const arr = this.data[name];
      for (let k = 0; k < size; k++) arr.push(v ? (v[k] ?? 0) : 0);
    }
    return this.vcount++;
  }

  addTri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Append a geometry (indexed or not) transformed by `m`. Normals are computed if missing. */
  add(g: BufferGeometry, m: Matrix4 | null, attrs: AttribValues, hook?: VertexHook): this {
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position;
    const N = g.attributes.normal;
    if (m) this.nm.getNormalMatrix(m);
    const base = this.vcount;
    for (let i = 0; i < P.count; i++) {
      this.tmpP.fromBufferAttribute(P, i);
      this.tmpN.fromBufferAttribute(N, i);
      if (m) {
        this.tmpP.applyMatrix4(m);
        this.tmpN.applyMatrix3(this.nm).normalize();
      }
      let a: AttribValues = attrs;
      if (hook) {
        for (const [name, size] of this.spec) {
          const src = attrs[name];
          const o = this.hookOut[name];
          for (let k = 0; k < size; k++) o[k] = src ? (src[k] ?? 0) : 0;
        }
        hook(i, g, this.hookOut);
        a = this.hookOut;
      }
      this.addVertex(this.tmpP.x, this.tmpP.y, this.tmpP.z, this.tmpN.x, this.tmpN.y, this.tmpN.z, a);
    }
    if (g.index) {
      const I = g.index;
      for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    } else {
      for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    }
    return this;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    for (const [name, size] of this.spec) g.setAttribute(name, new BufferAttribute(new Float32Array(this.data[name]), size));
    const IndexArr = this.vcount > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new BufferAttribute(new IndexArr(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// -----------------------------------------------------------------------------------------------
// Loft surface — rounded-polygon cross sections
// -----------------------------------------------------------------------------------------------

/**
 * One key cross-section. The half profile (x >= 0) is a polygon  P0 top center (0, yTop) -> P1 roof edge (rw, ry)
 * -> P2 belt (hw, yMid) -> P3 bottom edge (bw, yBot) -> P4 bottom center (0, yBot), mirrored to x < 0.
 * Every corner is rounded by a quadratic Bezier; r* = rounding fraction (0.05..1) of the adjacent half edges.
 */
export interface LoftKey {
  z: number;
  yTop: number;
  rw: number;
  ry: number;
  hw: number;
  yMid: number;
  bw: number;
  yBot: number;
  r0?: number;
  r1?: number;
  r2?: number;
  r3?: number;
  r4?: number;
  /** X center offset (side pods). */
  cx?: number;
}

export interface LoftSection {
  yTop: number;
  rw: number;
  ry: number;
  hw: number;
  yMid: number;
  bw: number;
  yBot: number;
  r0: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  cx: number;
}

const FIELDS: Array<keyof LoftSection> = ['yTop', 'rw', 'ry', 'hw', 'yMid', 'bw', 'yBot', 'r0', 'r1', 'r2', 'r3', 'r4', 'cx'];

/**
 * Profile parameter p in [0, 16): corner i occupies [2i, 2i+1), the edge from corner i to i+1 occupies [2i+1, 2i+2).
 * Corners in traversal order (counter-clockwise seen from +Z):
 *   0 belt(+x), 1 roof edge(+x), 2 top center, 3 roof edge(-x), 4 belt(-x), 5 bottom edge(-x), 6 bottom center, 7 bottom edge(+x).
 * Mirror (x -> -x): p' = (25 - p) mod 16.
 */
export const LP = {
  belt: 0.5,
  sideUpper: 1.5,
  roofEdge: 2.5,
  roof: 3.5,
  top: 4.5,
  bottomEdge: 14.5,
  sideLower: 15.5,
  bottom: 12.5,
  mirror: (p: number): number => (((25 - p) % 16) + 16) % 16,
};

/** Samples per corner / edge (index = corner or edge id). */
const CORNER_SAMPLES = [5, 4, 4, 4, 5, 3, 2, 3];
const EDGE_SAMPLES = [3, 4, 4, 3, 2, 3, 3, 2];

/** Material slot chooser for a loft quad: (z, profile parameter p, x, y, section) -> slot, or -1 to skip. */
export type SlotFn = (z: number, p: number, x: number, y: number, s: Readonly<LoftSection>) => number;

const _cx = new Float64Array(8);
const _cy = new Float64Array(8);
const _rf = new Float64Array(8);

export class Loft {
  readonly zs: number[];
  private readonly vals: number[][];
  private readonly tans: number[][];
  readonly zMin: number;
  readonly zMax: number;
  private readonly sec: LoftSection = { yTop: 0, rw: 0, ry: 0, hw: 0, yMid: 0, bw: 0, yBot: 0, r0: 1, r1: 0.5, r2: 0.5, r3: 0.5, r4: 1, cx: 0 };

  constructor(keys: LoftKey[]) {
    const ks = [...keys].sort((a, b) => a.z - b.z);
    this.zs = ks.map((k) => k.z);
    this.zMin = this.zs[0];
    this.zMax = this.zs[this.zs.length - 1];
    const full: LoftSection[] = ks.map((k) => ({
      yTop: k.yTop,
      rw: k.rw,
      ry: k.ry,
      hw: k.hw,
      yMid: k.yMid,
      bw: k.bw,
      yBot: k.yBot,
      r0: k.r0 ?? 1,
      r1: k.r1 ?? 0.5,
      r2: k.r2 ?? 0.5,
      r3: k.r3 ?? 0.6,
      r4: k.r4 ?? 1,
      cx: k.cx ?? 0,
    }));
    this.vals = FIELDS.map((f) => full.map((s) => s[f]));
    this.tans = this.vals.map((v) => pchipTangents(this.zs, v));
  }

  section(z: number): Readonly<LoftSection> {
    const zs = this.zs;
    const n = zs.length;
    let i = 0;
    if (z <= zs[0]) i = 0;
    else if (z >= zs[n - 1]) i = n - 2;
    else while (i < n - 2 && z > zs[i + 1]) i++;
    const h = zs[i + 1] - zs[i];
    let t = h > 0 ? (z - zs[i]) / h : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const out = this.sec as unknown as Record<string, number>;
    for (let f = 0; f < FIELDS.length; f++) {
      const v = this.vals[f];
      const m = this.tans[f];
      out[FIELDS[f]] = h00 * v[i] + h10 * h * m[i] + h01 * v[i + 1] + h11 * h * m[i + 1];
    }
    const s = this.sec;
    if (s.hw < 1e-4) s.hw = 1e-4;
    if (s.rw < 0) s.rw = 0;
    if (s.bw < 0) s.bw = 0;
    return s;
  }

  /** Surface point at (z, p). */
  point(z: number, p: number, out: Vector3): Vector3 {
    return profilePoint(this.section(z), z, p, out);
  }

  /** Outward surface normal at (z, p) by finite differences. */
  normal(z: number, p: number, out: Vector3): Vector3 {
    const e = 1e-3;
    const pz0 = this.point(Math.max(this.zMin, z - e), p, _v0);
    const pz1 = this.point(Math.min(this.zMax, z + e), p, _v1);
    const dz = _v2.subVectors(pz1, pz0);
    const ep = 0.02;
    const pa0 = this.point(z, (p - ep + 16) % 16, _v0);
    const pa1 = this.point(z, (p + ep) % 16, _v1);
    const dp = _v3.subVectors(pa1, pa0);
    out.crossVectors(dp, dz);
    if (out.lengthSq() < 1e-14) out.set(0, 0, 1);
    out.normalize();
    const s = this.section(z);
    this.point(z, p, _v0);
    _v1.set(_v0.x - s.cx, _v0.y - (s.yTop + s.yBot) * 0.5, 0);
    if (out.dot(_v1) < 0) out.negate();
    return out;
  }

  /** Points along the surface line p = const from z0 to z1, offset along the normal. */
  curve(p: number, z0: number, z1: number, n: number, offset: number): Vector3[] {
    const pts: Vector3[] = [];
    const nn = new Vector3();
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      const q = this.point(z, p, new Vector3());
      this.normal(z, p, nn);
      pts.push(q.addScaledVector(nn, offset));
    }
    return pts;
  }

  /** Points around the section at z from p0 to p1 (p1 may exceed 16 to wrap), offset along the normal. */
  ring(z: number, p0: number, p1: number, n: number, offset: number, dz = 0): Vector3[] {
    const pts: Vector3[] = [];
    const nn = new Vector3();
    for (let i = 0; i <= n; i++) {
      const p = (p0 + ((p1 - p0) * i) / n) % 16;
      const q = this.point(z, p, new Vector3());
      this.normal(z, p, nn);
      q.addScaledVector(nn, offset);
      q.z += dz;
      pts.push(q);
    }
    return pts;
  }

  /**
   * Emit the loft into accumulators. `slots[k]` = [accumulator, attribute values]; slotFn picks the slot per quad.
   * Normals are averaged over the full closed grid, so material boundaries have no shading seams.
   */
  emit(
    slots: Array<[GeoAccumulator, AttribValues]>,
    slotFn: SlotFn,
    opts: { step?: number; capRear?: number; capFront?: number; zSplits?: number[]; density?: number } = {},
  ): void {
    const step = opts.step ?? 0.03;
    const dens = opts.density ?? 1;
    // profile columns
    const cols: number[] = [];
    for (let c = 0; c < 8; c++) {
      const nc = Math.max(1, Math.round(CORNER_SAMPLES[c] * dens));
      for (let k = 0; k < nc; k++) cols.push(2 * c + k / nc);
      const ne = Math.max(1, Math.round(EDGE_SAMPLES[c] * dens));
      for (let k = 0; k < ne; k++) cols.push(2 * c + 1 + k / ne);
    }
    const M = cols.length;
    const stops = [...new Set([...this.zs, ...(opts.zSplits ?? [])])].sort((a, b) => a - b);
    const ringZ: number[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const len = stops[i + 1] - stops[i];
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) ringZ.push(stops[i] + (len * k) / n);
    }
    ringZ.push(stops[stops.length - 1]);
    const R = ringZ.length;
    const P: Vector3[] = [];
    const N: Vector3[] = [];
    for (let i = 0; i < R; i++) {
      const s = this.section(ringZ[i]);
      for (let j = 0; j < M; j++) {
        P.push(profilePoint(s, ringZ[i], cols[j], new Vector3()));
        N.push(new Vector3());
      }
    }
    const id = (i: number, j: number) => i * M + (((j % M) + M) % M);
    const e1 = new Vector3();
    const e2 = new Vector3();
    const fn = new Vector3();
    const addFace = (a: number, b: number, c: number) => {
      e1.subVectors(P[b], P[a]);
      e2.subVectors(P[c], P[a]);
      fn.crossVectors(e1, e2);
      N[a].add(fn);
      N[b].add(fn);
      N[c].add(fn);
    };
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < M; j++) {
        addFace(id(i, j), id(i, j + 1), id(i + 1, j));
        addFace(id(i, j + 1), id(i + 1, j + 1), id(i + 1, j));
      }
    }
    for (const n of N) {
      if (n.lengthSq() < 1e-20) n.set(0, 0, 1);
      else n.normalize();
    }
    const maps: Array<Map<number, number>> = slots.map(() => new Map());
    const vert = (slot: number, k: number) => {
      const map = maps[slot];
      let v = map.get(k);
      if (v === undefined) {
        const [acc, attrs] = slots[slot];
        const p = P[k];
        const n = N[k];
        v = acc.addVertex(p.x, p.y, p.z, n.x, n.y, n.z, attrs);
        map.set(k, v);
      }
      return v;
    };
    const c = new Vector3();
    for (let i = 0; i < R - 1; i++) {
      const zc = (ringZ[i] + ringZ[i + 1]) * 0.5;
      const s = this.section(zc);
      for (let j = 0; j < M; j++) {
        const p0 = cols[j];
        const p1 = j + 1 < M ? cols[j + 1] : 16;
        const pc = (p0 + p1) * 0.5;
        c.copy(P[id(i, j)]).add(P[id(i, j + 1)]).add(P[id(i + 1, j)]).add(P[id(i + 1, j + 1)]).multiplyScalar(0.25);
        const slot = slotFn(zc, pc, c.x, c.y, s);
        if (slot < 0) continue;
        const a = vert(slot, id(i, j));
        const b = vert(slot, id(i, j + 1));
        const cc = vert(slot, id(i + 1, j + 1));
        const d = vert(slot, id(i + 1, j));
        const acc = slots[slot][0];
        acc.addTri(a, b, d);
        acc.addTri(b, cc, d);
      }
    }
    const cap = (ring: number, slot: number, front: boolean) => {
      if (slot < 0) return;
      const [acc, attrs] = slots[slot];
      const z = ringZ[ring];
      const s = this.section(z);
      const nz = front ? 1 : -1;
      const center = acc.addVertex(s.cx, (s.yTop + s.yBot) * 0.5, z, 0, 0, nz, attrs);
      const first = acc.vertexCount;
      for (let j = 0; j < M; j++) {
        const p = P[id(ring, j)];
        acc.addVertex(p.x, p.y, p.z, 0, 0, nz, attrs);
      }
      for (let j = 0; j < M; j++) {
        const a = first + j;
        const b = first + ((j + 1) % M);
        if (front) acc.addTri(center, a, b);
        else acc.addTri(center, b, a);
      }
    };
    cap(0, opts.capRear ?? -1, false);
    cap(R - 1, opts.capFront ?? -1, true);
  }
}

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

/** Evaluate the rounded polygon of section s at profile parameter p. */
function profilePoint(s: Readonly<LoftSection>, z: number, p: number, out: Vector3): Vector3 {
  // corners in traversal order
  _cx[0] = s.hw;
  _cy[0] = s.yMid;
  _cx[1] = s.rw;
  _cy[1] = s.ry;
  _cx[2] = 0;
  _cy[2] = s.yTop;
  _cx[3] = -s.rw;
  _cy[3] = s.ry;
  _cx[4] = -s.hw;
  _cy[4] = s.yMid;
  _cx[5] = -s.bw;
  _cy[5] = s.yBot;
  _cx[6] = 0;
  _cy[6] = s.yBot;
  _cx[7] = s.bw;
  _cy[7] = s.yBot;
  _rf[0] = s.r2;
  _rf[1] = s.r1;
  _rf[2] = s.r0;
  _rf[3] = s.r1;
  _rf[4] = s.r2;
  _rf[5] = s.r3;
  _rf[6] = s.r4;
  _rf[7] = s.r3;
  let pp = p % 16;
  if (pp < 0) pp += 16;
  const piece = Math.min(15, Math.floor(pp));
  const t = pp - piece;
  const ci = piece >> 1;
  if ((piece & 1) === 0) {
    // corner ci: quadratic Bezier cutIn -> corner -> cutOut
    const prev = (ci + 7) & 7;
    const next = (ci + 1) & 7;
    cutPoint(ci, prev, _a);
    cutPoint(ci, next, _b);
    const u = 1 - t;
    out.set(
      u * u * _a.x + 2 * u * t * _cx[ci] + t * t * _b.x + s.cx,
      u * u * _a.y + 2 * u * t * _cy[ci] + t * t * _b.y,
      z,
    );
  } else {
    // edge from corner ci (cutOut) to corner ci+1 (cutIn)
    const next = (ci + 1) & 7;
    cutPoint(ci, next, _a);
    cutPoint(next, ci, _b);
    out.set(_a.x + (_b.x - _a.x) * t + s.cx, _a.y + (_b.y - _a.y) * t, z);
  }
  return out;
}

const _a = { x: 0, y: 0 };
const _b = { x: 0, y: 0 };

/** Cut point on the edge from corner i toward corner j, at the rounding distance of corner i. */
function cutPoint(i: number, j: number, out: { x: number; y: number }): void {
  const dx = _cx[j] - _cx[i];
  const dy = _cy[j] - _cy[i];
  const len = Math.sqrt(dx * dx + dy * dy);
  // rounding fraction of HALF of the adjacent edges (so neighbouring corners never overlap)
  const prev = (i + 7) & 7;
  const next = (i + 1) & 7;
  const l1 = Math.hypot(_cx[prev] - _cx[i], _cy[prev] - _cy[i]);
  const l2 = Math.hypot(_cx[next] - _cx[i], _cy[next] - _cy[i]);
  const r = Math.max(0.05, Math.min(1, _rf[i])) * 0.5 * Math.min(l1, l2);
  const f = len > 1e-9 ? r / len : 0;
  out.x = _cx[i] + dx * f;
  out.y = _cy[i] + dy * f;
}

/** Monotone (Fritsch–Carlson / PCHIP) tangents: smooth, no overshoot bulges. */
function pchipTangents(x: number[], y: number[]): number[] {
  const n = x.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const d: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i]);
    d.push(h[i] > 0 ? (y[i + 1] - y[i]) / h[i] : 0);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || d[i - 1] > 0 !== d[i] > 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

// -----------------------------------------------------------------------------------------------
// Small part helpers
// -----------------------------------------------------------------------------------------------

/** A tube through `pts` (smooth Catmull-Rom). uv.x runs 0..1 along the tube. */
export function tubeThrough(pts: Vector3[], radius: number, segs = 24, radial = 6, closed = false): TubeGeometry {
  const curve = new CatmullRomCurve3(pts, closed, 'centripetal');
  return new TubeGeometry(curve, segs, radius, radial, closed);
}

/** Compose a transform matrix from position / euler (XYZ radians) / scale. */
export function xform(
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): Matrix4 {
  const m = new Matrix4();
  const e = new Matrix4().makeRotationFromEuler(_euler.set(rx, ry, rz));
  m.makeScale(sx, sy, sz).premultiply(e);
  m.setPosition(px, py, pz);
  return m;
}

const _euler = new Euler();
