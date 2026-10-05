/**
 * NOVABALL render-world — the stadium outside the force field (pure scenery, kept cheap):
 *  - tiered stands + 4 floodlight towers merged into ONE mesh (unlit art-directed shader: dark structure,
 *    seat rows, animated LED ribbon boards, rim light strips, blazing floodlight heads);
 *  - thousands of crowd lights in ONE Points draw call (twinkle, stadium waves, goal flashes, excitement);
 *  - volumetric floodlight beams (ONE additive mesh, LAYER_MAIN_ONLY => not in the floor reflection);
 *  - floating holo scoreboards (2 side screens + a rotating holo cube, ONE mesh, canvas texture);
 *  - orbital light rings around the stadium (ONE mesh).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  Vector3,
  type Texture,
} from 'three';
import { LAYER_MAIN_ONLY } from '../../contracts';
import { ARENA } from '../../sim/constants';
import { sampleRoundedRect, type PerimeterSample } from './ArenaGeometry';
import { GLSL_ARENA_UNIFORMS, type ArenaUniforms } from './ArenaUniforms';
import { GLSL_HASH, GLSL_NOISE2 } from './glsl';

const W = ARENA.halfWidth;
const L = ARENA.halfLength;
const RC = ARENA.cornerRadius;

/** Stand cross-section: [offset from the arena outline (m), height (m), kind of the segment STARTING here]. */
const PROFILE: Array<[number, number, number]> = [
  [10, -0.6, 1], // front wall (LED ribbon board)
  [10, 1.8, 0], // lip
  [11.2, 1.8, 2], // lower seating
  [26, 9.4, 0], // concourse
  [28.4, 9.4, 1], // upper front wall (LED ribbon)
  [28.4, 12.0, 0], // lip
  [29.5, 12.0, 2], // upper seating
  [44, 22.6, 3], // back wall inner (rim light)
  [44, 24.6, 0], // roof
  [47.5, 24.6, 0], // outer wall
  [47.5, -8, 0],
];

export const KIND = { structure: 0, led: 1, seats: 2, rim: 3, tower: 4, head: 5 } as const;

const TOWER_OFFSET = 54;
const TOWER_TOP = 44;

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  kind: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly g = new Vector3();

  /** Quad p0..p3 (around), per-vertex normals n0..n3; winding fixed to face the average normal. */
  quad(p: Vector3[], n: Vector3[], kind: number, uv: number[]): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i].x, p[i].y, p[i].z);
      this.nor.push(n[i].x, n[i].y, n[i].z);
      this.kind.push(kind);
      this.uv.push(uv[i * 2], uv[i * 2 + 1]);
    }
    this.e1.subVectors(p[1], p[0]);
    this.e2.subVectors(p[2], p[0]);
    this.g.crossVectors(this.e1, this.e2);
    const avgx = n[0].x + n[1].x + n[2].x + n[3].x;
    const avgy = n[0].y + n[1].y + n[2].y + n[3].y;
    const avgz = n[0].z + n[1].z + n[2].z + n[3].z;
    if (this.g.x * avgx + this.g.y * avgy + this.g.z * avgz >= 0) {
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('aKind', new Float32BufferAttribute(this.kind, 1));
    geo.setAttribute('aUv', new Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Box (8 corners given) with per-face kinds. Corner order: bottom 0-3 (ccw), top 4-7. */
function addBox(b: Builder, c: Vector3[], kinds: number[], faceUv = 1): void {
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    [4, 5, 6, 7],
    [3, 2, 1, 0],
  ];
  const center = new Vector3();
  for (const p of c) center.add(p);
  center.multiplyScalar(1 / 8);
  faces.forEach((f, i) => {
    const p = f.map((k) => c[k]);
    const fc = new Vector3().add(p[0]).add(p[1]).add(p[2]).add(p[3]).multiplyScalar(0.25);
    const n = new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0])).normalize();
    if (n.dot(new Vector3().subVectors(fc, center)) < 0) n.negate();
    b.quad(p, [n, n, n, n], kinds[i], [0, 0, faceUv, 0, faceUv, 1, 0, 1]);
  });
}

function buildStructure(): { geo: BufferGeometry; heads: Array<{ pos: Vector3; dir: Vector3 }> } {
  const b = new Builder();
  const rings: PerimeterSample[][] = PROFILE.map(([d]) => sampleRoundedRect(W, L, RC, 18, 6, d));
  const up = new Vector3(0, 1, 0);
  const n2 = new Vector3();
  const nn = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const pp = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  for (let j = 0; j < PROFILE.length - 1; j++) {
    const [d0, y0, kind] = PROFILE[j];
    const [d1, y1] = PROFILE[j + 1];
    const r0 = rings[j];
    const r1 = rings[j + 1];
    const dd = d1 - d0;
    const dy = y1 - y0;
    const len = Math.hypot(dd, dy);
    // profile normal (rotate segment dir by +90°): (-dy, dd)
    const pnx = -dy / len;
    const pny = dd / len;
    for (let i = 0; i < r0.length - 1; i++) {
      const a0 = r0[i];
      const a1 = r0[i + 1];
      const b0 = r1[i];
      const b1 = r1[i + 1];
      pp[0].set(a0.x, y0, a0.z);
      pp[1].set(a1.x, y0, a1.z);
      pp[2].set(b1.x, y1, b1.z);
      pp[3].set(b0.x, y1, b0.z);
      const ns = [a0, a1, b1, b0];
      for (let k = 0; k < 4; k++) {
        n2.set(ns[k].nx, 0, ns[k].nz);
        nn[k].copy(n2).multiplyScalar(pnx).addScaledVector(up, pny).normalize();
      }
      b.quad(pp, nn, kind, [a0.u, 0, a1.u, 0, b1.u, len, b0.u, len]);
    }
  }
  // floodlight towers at the 4 corners
  const heads: Array<{ pos: Vector3; dir: Vector3 }> = [];
  for (const [sx, sz] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    const cx = sx * (W - RC);
    const cz = sz * (L - RC);
    const dir = new Vector3(sx, 0, sz).normalize();
    const base = new Vector3(cx, 0, cz).addScaledVector(dir, RC + TOWER_OFFSET);
    const side = new Vector3(-dir.z, 0, dir.x);
    // tapered pylon
    const hb = 2.0;
    const ht = 1.1;
    const c: Vector3[] = [];
    for (const [h, y] of [
      [hb, -8],
      [ht, TOWER_TOP],
    ] as const) {
      c.push(
        base.clone().addScaledVector(dir, -h).addScaledVector(side, -h).setY(y),
        base.clone().addScaledVector(dir, h).addScaledVector(side, -h).setY(y),
        base.clone().addScaledVector(dir, h).addScaledVector(side, h).setY(y),
        base.clone().addScaledVector(dir, -h).addScaledVector(side, h).setY(y),
      );
    }
    addBox(b, c, [KIND.tower, KIND.tower, KIND.tower, KIND.tower, KIND.tower, KIND.tower]);
    // head: a panel facing the arena center, tilted down
    const headCenter = base.clone().setY(TOWER_TOP + 3.5).addScaledVector(dir, -1.5);
    const target = new Vector3(cx * 0.35, 0, cz * 0.35);
    const fwd = new Vector3().subVectors(target, headCenter).normalize();
    const right = new Vector3().crossVectors(fwd, up).normalize();
    const hup = new Vector3().crossVectors(right, fwd).normalize();
    const hw = 7.5;
    const hh = 3.6;
    const hd = 0.9;
    const hc: Vector3[] = [];
    for (const dz of [-hd, hd]) {
      const cc = headCenter.clone().addScaledVector(fwd, dz);
      hc.push(
        cc.clone().addScaledVector(right, -hw).addScaledVector(hup, -hh),
        cc.clone().addScaledVector(right, hw).addScaledVector(hup, -hh),
        cc.clone().addScaledVector(right, hw).addScaledVector(hup, hh),
        cc.clone().addScaledVector(right, -hw).addScaledVector(hup, hh),
      );
    }
    // faces: 0..3 sides, 4 = front (+fwd side is the second ring => corners 4-7), 5 = back
    addBox(b, [hc[0], hc[1], hc[2], hc[3], hc[4], hc[5], hc[6], hc[7]], [KIND.tower, KIND.tower, KIND.tower, KIND.tower, KIND.head, KIND.tower], 1);
    heads.push({ pos: headCenter.clone().addScaledVector(fwd, hd + 0.2), dir: fwd.clone() });
  }
  return { geo: b.build(), heads };
}

const STRUCT_VERT = /* glsl */ `
attribute float aKind;
attribute vec2 aUv;
varying vec3 vN;
varying vec3 vWP;
varying float vKind;
varying vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vKind = aKind;
  vUv = aUv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const STRUCT_FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_ARENA_UNIFORMS}
varying vec3 vN;
varying vec3 vWP;
varying float vKind;
varying vec2 vUv;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  float k = floor(vKind + 0.5);
  // floodlight LED grid footprint (derivatives taken outside the per-kind branches: defined everywhere)
  vec2 ledGp = vUv * vec2(8.0, 4.0);
  float ledFw = length(fwidth(ledGp));
  float up = N.y * 0.5 + 0.5;
  // dark gunmetal with a cool sky fill, faint warm key from above and a blue rim
  vec3 base = mix(vec3(0.0025, 0.003, 0.006), vec3(0.010, 0.013, 0.024), up);
  base += vec3(0.012, 0.011, 0.010) * pow(max(N.y, 0.0), 4.0);
  float rimv = pow(max(1.0 - abs(dot(N, V)), 0.0), 5.0);
  base += vec3(0.01, 0.018, 0.045) * rimv;
  vec3 col = base;
  vec3 teamSide = mix(uTeam0, uTeam1, step(0.0, vWP.z));
  float flash = uStadiumFlash;
  if (k == 1.0) {
    // LED ribbon boards: thin band with scrolling segments, dot matrix, dark separators
    float u = vUv.x;
    float band = smoothstep(0.55, 0.62, vUv.y) * (1.0 - smoothstep(1.38, 1.45, vUv.y));
    float seg = fract(u / 38.0 - uTime * 0.06);
    float segId = floor(u / 38.0 - uTime * 0.06);
    float pick = nbHash11(segId * 3.7 + 1.0);
    vec3 a = pick < 0.4 ? uTeam0 : (pick < 0.8 ? uTeam1 : vec3(0.85, 0.9, 1.0));
    a = mix(a, vec3(1.0), 0.18);
    float sep = smoothstep(0.0, 0.015, seg) * (1.0 - smoothstep(0.985, 1.0, seg));
    // "text" blocks
    float glyph = step(0.35, nbHash12(floor(vec2(u * 2.2, vUv.y * 5.0)) + segId));
    float txt = mix(0.45, 1.0, glyph * step(0.15, seg) * step(seg, 0.75));
    float sweep = pow(max(0.5 + 0.5 * sin(u * 0.18 - uTime * 2.5), 0.0), 6.0);
    vec3 ledCol = mix(a, uSurgeColor, uSurge * 0.8);
    ledCol = mix(ledCol, uFlashColor, flash);
    vec2 dots = abs(fract(vec2(u * 7.0, vUv.y * 7.0)) - 0.5);
    float dm = 1.0 - smoothstep(0.3, 0.45, max(dots.x, dots.y));
    dm = mix(dm, 0.6, smoothstep(0.3, 1.0, fwidth(u * 7.0)));
    col += ledCol * band * sep * (0.55 * txt + 0.45 * sweep + flash * 2.5) * (0.4 + 0.6 * dm) * 0.9;
  } else if (k == 2.0) {
    // seating: row stripes + aisles (very dim), team-tinted sections near each end
    float row = fract(vUv.y / 0.85);
    float rowLine = smoothstep(0.0, 0.1, row) * (1.0 - smoothstep(0.25, 0.45, row));
    float aisle = 1.0 - smoothstep(0.0, 0.5, abs(fract(vUv.x / 14.0) - 0.5) * 14.0);
    float endAff = smoothstep(20.0, 70.0, abs(vWP.z));
    vec3 seat = mix(vec3(0.010, 0.012, 0.022), teamSide * 0.025, endAff);
    col = base * 0.7 + seat * (0.35 + 0.65 * rowLine);
    col += vec3(0.03, 0.045, 0.08) * aisle * 0.2;
  } else if (k == 3.0) {
    float chase = pow(max(0.5 + 0.5 * sin(vUv.x * 0.05 - uTime * 1.2), 0.0), 4.0);
    float band = smoothstep(0.25, 0.35, vUv.y) * (1.0 - smoothstep(0.6, 0.7, vUv.y));
    vec3 rc = mix(vec3(0.55, 0.72, 1.0), uSurgeColor, uSurge);
    rc = mix(rc, uFlashColor, flash);
    col += rc * band * (0.45 + 0.7 * chase + flash * 3.0);
  } else if (k == 4.0) {
    col = base * 1.1;
    float beacon = step(${(TOWER_TOP - 1.2).toFixed(1)}, vWP.y) * step(0.55, fract(uTime * 0.5));
    col += vec3(1.0, 0.08, 0.04) * beacon * 3.0;
  } else if (k == 5.0) {
    // floodlight head: an array of discrete blazing LEDs in a dark housing. Each LED is a white-hot core in a
    // softer lens glow; the gaps stay dark so the grid reads through bloom (the halo comes from per-LED bloom,
    // not from a flat over-exposed rectangle).
    vec2 g = fract(ledGp);
    float cd = length(g - 0.5);
    float cell = 1.0 - smoothstep(0.2, 0.36, cd);
    float hot = 1.0 - smoothstep(0.0, 0.24, cd);
    float led = 0.6 * cell + 7.0 * hot * hot;
    // sub-pixel LEDs (far away / low resolution): fade to the cell-average brightness instead of aliasing
    led = mix(led, 0.55, smoothstep(0.18, 0.5, ledFw));
    // faint lit bezel around the housing edge (soft rim, reads as a lamp head, not a hard box)
    vec2 e = min(vUv, 1.0 - vUv);
    float bezel = exp(-min(e.x * 8.0, e.y * 4.0) * 9.0) * 0.35;
    vec3 fl = vec3(1.0, 0.95, 0.88);
    fl = mix(fl, uFlashColor, flash * 0.6);
    col = vec3(0.012, 0.014, 0.02) + fl * (led + bezel) * (1.0 + flash * 0.8);
    // in the (blurred) floor mirror bright emitters smear into blocks right under the HUD: reflect them much dimmer
    col *= 1.0 - 0.9 * uReflPass;
  }
  // atmospheric depth
  float dist = length(vWP - cameraPosition);
  col = mix(col, vec3(0.006, 0.008, 0.02), smoothstep(70.0, 220.0, dist) * 0.5 * step(k, 2.5));
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------- crowd
const CROWD_VERT = /* glsl */ `
${GLSL_HASH}
${GLSL_ARENA_UNIFORMS}
uniform float uPxScale;
attribute vec4 aSeed;
attribute vec2 aInfo;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float fan = step(0.0, aInfo.y + (aSeed.x - 0.5) * 0.9);
  vec3 teamC = mix(uTeam0, uTeam1, fan);
  vec3 warm = mix(vec3(1.0, 0.8, 0.6), vec3(0.75, 0.85, 1.0), aSeed.z);
  bool stick = aSeed.y > 0.62;
  vec3 col = stick ? teamC * 1.2 : warm * 0.7;
  if (aSeed.y > 0.95) col = vec3(0.9, 0.4, 1.0);
  float tw = 0.3 + 0.7 * pow(max(0.5 + 0.5 * sin(uTime * (0.6 + aSeed.w * 2.4) + aSeed.x * 50.0), 0.0), 3.0);
  float wp = fract(aInfo.x - uTime * 0.035);
  float wx = (wp - 0.5) * 24.0;
  float wave = exp(-wx * wx);
  float endEx = aInfo.y < 0.0 ? uExcite.x : uExcite.y;
  float ex = endEx * smoothstep(0.2, 0.8, abs(aInfo.y));
  float flick = 0.5 + 0.5 * sin(uTime * 13.0 + aSeed.x * 90.0);
  // occasional camera flashes
  float pop = step(0.9975, nbHash12(vec2(floor(uTime * 7.0), aSeed.x * 977.0)));
  // sections (14 m aisles) differ in activity: some calm, some lit up
  float section = nbHash11(floor(aInfo.x * 30.0) + 3.0);
  float b = (0.07 + tw * 0.2) * (0.45 + 0.9 * section) + wave * 0.8 + ex * (0.2 + flick * 0.6) + pop * 4.0;
  float fl = uStadiumFlash;
  b += fl * (1.0 + 1.6 * (0.5 + 0.5 * sin(uTime * 16.0 + aSeed.z * 40.0)));
  col = mix(col, uFlashColor * 1.2, clamp(fl * 1.4, 0.0, 1.0) * step(0.3, aSeed.y));
  col = mix(col, vec3(0.72, 0.42, 1.0), uSurge * 0.55);
  if (pop > 0.5) col = vec3(1.0);
  vCol = col * b * 0.55;
  gl_PointSize = clamp(0.42 * uPxScale / -mv.z, 1.5, 5.0);
  gl_Position = projectionMatrix * mv;
}
`;

const CROWD_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 16.0);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

function buildCrowd(count: number): BufferGeometry {
  let s = 424242;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // seating slopes: profile segments with kind 2
  const slopes: Array<[number, number, number, number]> = [];
  for (let j = 0; j < PROFILE.length - 1; j++) {
    if (PROFILE[j][2] === KIND.seats) slopes.push([PROFILE[j][0], PROFILE[j][1], PROFILE[j + 1][0], PROFILE[j + 1][1]]);
  }
  // weight by area (approx: perimeter at mid offset * slope length)
  const weights = slopes.map(([d0, y0, d1, y1]) => {
    const mid = (d0 + d1) / 2;
    const per = 2 * (2 * (W - RC)) + 2 * (2 * (L - RC)) + 2 * Math.PI * (RC + mid);
    return per * Math.hypot(d1 - d0, y1 - y0);
  });
  const wsum = weights.reduce((a, b2) => a + b2, 0);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const info = new Float32Array(count * 2);
  const cache = new Map<number, PerimeterSample[]>();
  const ringAt = (d: number) => {
    const key = Math.round(d * 4) / 4;
    let r = cache.get(key);
    if (!r) {
      r = sampleRoundedRect(W, L, RC, 24, 16, key);
      cache.set(key, r);
    }
    return r;
  };
  let i = 0;
  let guard = 0;
  while (i < count && guard < count * 4) {
    guard++;
    let pick = rnd() * wsum;
    let si = 0;
    while (si < slopes.length - 1 && pick > weights[si]) {
      pick -= weights[si];
      si++;
    }
    const [d0, y0, d1, y1] = slopes[si];
    const t = 0.03 + rnd() * 0.94;
    const d = d0 + (d1 - d0) * t;
    const y = y0 + (y1 - y0) * t;
    const ring = ringAt(d);
    const total = ring[ring.length - 1].u;
    const u = rnd() * total;
    // aisles every 14 m: skip
    const aisle = Math.abs(((u / 14) % 1) - 0.5) * 14;
    if (aisle < 0.7) continue;
    let lo = 0;
    let hi = ring.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ring[mid].u <= u) lo = mid;
      else hi = mid;
    }
    const a = ring[lo];
    const b2 = ring[hi];
    const f = (u - a.u) / Math.max(1e-6, b2.u - a.u);
    const x = a.x + (b2.x - a.x) * f;
    const z = a.z + (b2.z - a.z) * f;
    pos[i * 3] = x + (rnd() - 0.5) * 0.4;
    pos[i * 3 + 1] = y + 0.55 + rnd() * 0.5;
    pos[i * 3 + 2] = z + (rnd() - 0.5) * 0.4;
    seed[i * 4] = rnd();
    seed[i * 4 + 1] = rnd();
    seed[i * 4 + 2] = rnd();
    seed[i * 4 + 3] = rnd();
    info[i * 2] = u / total;
    info[i * 2 + 1] = Math.max(-1, Math.min(1, z / (L + 20)));
    i++;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos.subarray(0, i * 3), 3));
  geo.setAttribute('aSeed', new BufferAttribute(seed.subarray(0, i * 4), 4));
  geo.setAttribute('aInfo', new BufferAttribute(info.subarray(0, i * 2), 2));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------------------------- beams
const BEAM_VERT = /* glsl */ `
attribute float aAxial;
varying float vAxial;
varying vec3 vN;
varying vec3 vWP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vAxial = aAxial;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const BEAM_FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_ARENA_UNIFORMS}
uniform float uBeamIntensity;
varying float vAxial;
varying vec3 vN;
varying vec3 vWP;
void main() {
  vec3 V = normalize(cameraPosition - vWP);
  float soft = pow(max(abs(dot(normalize(vN), V)), 0.0), 1.2);
  float along = pow(max(1.0 - vAxial, 0.0), 1.3) * smoothstep(0.0, 0.03, vAxial);
  float dust = 0.75 + 0.5 * nbNoise2(vec2(vAxial * 9.0 - uTime * 0.25, atan(vN.x, vN.z) * 3.0));
  vec3 col = mix(vec3(0.75, 0.85, 1.0), uFlashColor, uStadiumFlash * 0.5);
  col = mix(col, uSurgeColor, uSurge * 0.5);
  float I = soft * along * dust * uBeamIntensity * (1.0 + uStadiumFlash * 1.5);
  // don't fog the camera when it sits inside a beam
  I *= smoothstep(2.0, 12.0, length(vWP - cameraPosition));
  gl_FragColor = vec4(col * I, 1.0);
}
`;

function buildBeams(heads: Array<{ pos: Vector3; dir: Vector3 }>): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const ax: number[] = [];
  const idx: number[] = [];
  const seg = 28;
  const len = 92;
  const r0 = 3.0;
  const r1 = 18;
  for (const h of heads) {
    const f = h.dir.clone().normalize();
    const right = new Vector3().crossVectors(f, new Vector3(0, 1, 0)).normalize();
    const upv = new Vector3().crossVectors(right, f).normalize();
    const base = pos.length / 3;
    const slope = (r1 - r0) / len;
    for (const t of [0, 1]) {
      const c = h.pos.clone().addScaledVector(f, len * t);
      const r = r0 + (r1 - r0) * t;
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const dir = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(upv, Math.sin(a));
        const p = c.clone().addScaledVector(dir, r);
        const n = dir.clone().addScaledVector(f, -slope).normalize();
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        ax.push(t);
      }
    }
    for (let k = 0; k < seg; k++) {
      const a = base + k;
      const b2 = base + seg + 1 + k;
      idx.push(a, b2, a + 1, b2, b2 + 1, a + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('aAxial', new Float32BufferAttribute(ax, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------------------------- screens
const SCREEN_VERT = /* glsl */ `
uniform float uTime;
attribute float aSpin;
attribute vec3 aCenter;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying float vSpin;
void main() {
  vUv = uv;
  vSpin = aSpin;
  vec3 p = position;
  vec3 n = normal;
  if (aSpin > 0.5) {
    float a = uTime * 0.12;
    float c = cos(a);
    float s = sin(a);
    vec3 q = p - aCenter;
    p = aCenter + vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z);
    n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const SCREEN_FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_ARENA_UNIFORMS}
uniform sampler2D tScore;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying float vSpin;
void main() {
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = abs(dot(normalize(vN), V));
  // subtle holographic wobble + scanlines
  vec2 uv = vUv;
  uv.x += sin(uv.y * 40.0 + uTime * 3.0) * 0.0008;
  vec3 tex = texture2D(tScore, uv).rgb;
  float scan = 0.82 + 0.18 * sin(uv.y * 900.0);
  float flick = 0.94 + 0.06 * nbHash11(floor(uTime * 24.0));
  vec3 col = tex * 2.1 * scan * flick;
  col = mix(col, col * vec3(0.8, 0.6, 1.3), uSurge * 0.6);
  col += uFlashColor * uStadiumFlash * 0.8;
  // edge glow
  vec2 e = min(uv, 1.0 - uv);
  float edge = 1.0 - smoothstep(0.0, 0.02, min(e.x, e.y * 2.2));
  col += vec3(0.4, 0.6, 1.0) * edge * 1.5;
  col *= 0.75 + 0.25 * ndv;
  // floor reflection: the mirrored side boards sit right under the HUD boost gauge, and the holo cube hangs right
  // above the centre spot (from high cameras its blurred mirror image read as a white blob on the pitch)
  col *= 1.0 - uReflPass * (vSpin > 0.5 ? 0.85 : 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

function buildScreens(): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const spin: number[] = [];
  const cen: number[] = [];
  const idx: number[] = [];
  const addPlane = (center: Vector3, facing: Vector3, w: number, h: number, isSpin: boolean, spinCenter: Vector3) => {
    const f = facing.clone().normalize();
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), f).normalize();
    const upv = new Vector3(0, 1, 0);
    const base = pos.length / 3;
    const corners: Array<[number, number, number, number]> = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    for (const [sx, sy, u, vv] of corners) {
      const p = center.clone().addScaledVector(right, (sx * w) / 2).addScaledVector(upv, (sy * h) / 2);
      pos.push(p.x, p.y, p.z);
      nor.push(f.x, f.y, f.z);
      uv.push(u, vv);
      spin.push(isSpin ? 1 : 0);
      cen.push(spinCenter.x, spinCenter.y, spinCenter.z);
    }
    // winding: counter-clockwise seen from the facing side
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const zero = new Vector3();
  // side screens (hovering over the long-side stands, facing the field)
  addPlane(new Vector3(W + 20, 20.5, 0), new Vector3(-1, 0, 0), 26, 11.4, false, zero);
  addPlane(new Vector3(-(W + 20), 20.5, 0), new Vector3(1, 0, 0), 26, 11.4, false, zero);
  // rotating holo cube above the arena
  const cc = new Vector3(0, 37, 0);
  const hw = 7.5;
  for (const f of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
    addPlane(cc.clone().addScaledVector(f, hw), f, hw * 2, 6.6, true, cc);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setAttribute('aSpin', new Float32BufferAttribute(spin, 1));
  geo.setAttribute('aCenter', new Float32BufferAttribute(cen, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------------------------- rings
const RING_VERT = /* glsl */ `
attribute float aAng;
attribute float aRing;
varying float vAng;
varying float vRing;
varying vec3 vN;
varying vec3 vWP;
void main() {
  vAng = aAng;
  vRing = aRing;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RING_FRAG = /* glsl */ `
${GLSL_ARENA_UNIFORMS}
varying float vAng;
varying float vRing;
varying vec3 vN;
varying vec3 vWP;
void main() {
  float dir = vRing > 0.5 ? -1.0 : 1.0;
  float segs = vRing > 0.5 ? 24.0 : 12.0;
  float s = fract(vAng * segs / 6.2831853 + dir * uTime * 0.05);
  float dash = smoothstep(0.0, 0.04, s) * (1.0 - smoothstep(0.9, 0.96, s));
  float chase = pow(max(0.5 + 0.5 * sin(vAng * 3.0 - dir * uTime * 0.9), 0.0), 12.0);
  vec3 c = vRing > 0.5 ? mix(uTeam0, vec3(0.8, 0.9, 1.0), 0.5) : vec3(0.65, 0.78, 1.0);
  c = mix(c, uSurgeColor, uSurge * 0.8);
  c = mix(c, uFlashColor, uStadiumFlash);
  vec3 V = normalize(cameraPosition - vWP);
  float core = pow(max(abs(dot(normalize(vN), V)), 0.0), 1.5);
  vec3 col = c * (0.05 + dash * (0.35 + 1.6 * chase + uStadiumFlash * 3.0)) * (0.5 + 0.8 * core);
  gl_FragColor = vec4(col, 1.0);
}
`;

function buildRings(): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const ang: number[] = [];
  const ring: number[] = [];
  const idx: number[] = [];
  const addTorus = (R: number, r: number, y: number, tilt: number, id: number) => {
    const segU = 256;
    const segV = 8;
    const base = pos.length / 3;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    for (let i = 0; i <= segU; i++) {
      const a = (i / segU) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let j = 0; j <= segV; j++) {
        const b2 = (j / segV) * Math.PI * 2;
        const cb = Math.cos(b2);
        const sb = Math.sin(b2);
        // local (flat ring in XZ)
        const nx = ca * cb;
        const ny = sb;
        const nz = sa * cb;
        const px = (R + r * cb) * ca;
        const py = r * sb;
        const pz = (R + r * cb) * sa;
        // tilt around X
        pos.push(px, y + py * ct - pz * st, py * st + pz * ct);
        nor.push(nx, ny * ct - nz * st, ny * st + nz * ct);
        ang.push(a);
        ring.push(id);
      }
    }
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const a = base + i * (segV + 1) + j;
        const b2 = a + segV + 1;
        idx.push(a, b2, a + 1, b2, b2 + 1, a + 1);
      }
    }
  };
  addTorus(98, 0.6, 38, 0.07, 0);
  addTorus(91, 0.3, 35, 0.07, 1);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('aAng', new Float32BufferAttribute(ang, 1));
  geo.setAttribute('aRing', new Float32BufferAttribute(ring, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export class Stadium {
  readonly group = new Group();
  readonly structure: Mesh;
  crowd: Points;
  readonly beams: Mesh;
  readonly screens: Mesh;
  readonly rings: Mesh;
  private readonly structMat: ShaderMaterial;
  private readonly crowdMat: ShaderMaterial;
  private readonly beamMat: ShaderMaterial;
  private readonly screenMat: ShaderMaterial;
  private readonly ringMat: ShaderMaterial;
  private crowdCount: number;

  constructor(uniforms: ArenaUniforms, crowdCount: number, beams: boolean, scoreTexture: Texture) {
    this.group.name = 'Stadium';
    const { geo, heads } = buildStructure();
    this.structMat = new ShaderMaterial({ name: 'NovaStands', uniforms, vertexShader: STRUCT_VERT, fragmentShader: STRUCT_FRAG });
    this.structure = new Mesh(geo, this.structMat);
    this.structure.name = 'Stands';

    this.crowdCount = crowdCount;
    this.crowdMat = new ShaderMaterial({
      name: 'NovaCrowd',
      uniforms: { ...uniforms, uPxScale: { value: 800 } },
      vertexShader: CROWD_VERT,
      fragmentShader: CROWD_FRAG,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.crowd = new Points(buildCrowd(crowdCount), this.crowdMat);
    this.crowd.name = 'Crowd';
    this.crowd.frustumCulled = false;

    this.beamMat = new ShaderMaterial({
      name: 'NovaBeams',
      uniforms: { ...uniforms, uBeamIntensity: { value: 0.14 } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.beams = new Mesh(buildBeams(heads), this.beamMat);
    this.beams.name = 'FloodBeams';
    this.beams.layers.set(LAYER_MAIN_ONLY);
    this.beams.visible = beams;
    this.beams.renderOrder = 10;

    this.screenMat = new ShaderMaterial({
      name: 'NovaHoloScreens',
      uniforms: { ...uniforms, tScore: { value: scoreTexture } },
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
    });
    this.screens = new Mesh(buildScreens(), this.screenMat);
    this.screens.name = 'HoloScreens';
    this.screens.frustumCulled = false;

    this.ringMat = new ShaderMaterial({ name: 'NovaSignRings', uniforms, vertexShader: RING_VERT, fragmentShader: RING_FRAG, side: DoubleSide });
    this.rings = new Mesh(buildRings(), this.ringMat);
    this.rings.name = 'SignRings';

    this.group.add(this.structure, this.crowd, this.beams, this.screens, this.rings);
  }

  setQuality(crowdCount: number, beams: boolean): void {
    this.beams.visible = beams;
    if (crowdCount !== this.crowdCount) {
      this.crowdCount = crowdCount;
      const old = this.crowd.geometry;
      this.crowd.geometry = buildCrowd(crowdCount);
      old.dispose();
    }
  }

  setPixelScale(pxScale: number): void {
    this.crowdMat.uniforms.uPxScale.value = pxScale;
  }

  dispose(): void {
    this.structure.geometry.dispose();
    this.crowd.geometry.dispose();
    this.beams.geometry.dispose();
    this.screens.geometry.dispose();
    this.rings.geometry.dispose();
    this.structMat.dispose();
    this.crowdMat.dispose();
    this.beamMat.dispose();
    this.screenMat.dispose();
    this.ringMat.dispose();
  }
}
