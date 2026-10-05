/**
 * BoostPadsView — every boost pad in 4 instanced draw calls:
 *   bases    hex floor plates (procedural rim / inner ring / sweep / recharge arc), LAYER_MAIN_ONLY decals
 *   orbs     small pads: floating gold energy orbs
 *   cells    big pads ("core cells"): rotating crystals with an orbiting ring
 *   columns  big pads: soft light column beacons
 * Inactive pads go dim and show a recharge arc (respawn timing from BOOST_PADS); reactivation pops in with an
 * elastic overshoot and a flash.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYER_MAIN_ONLY, type IBoostPadsView } from '../contracts';
import { BOOST_PADS } from '../sim/constants';
import { clamp01, damp } from './actors/util';

export const BOOST_COLOR = new Color('#ffb52e');
const HOT = new Color(1.0, 0.94, 0.8);

const SMALL_BASE_R = 1.0;
const BIG_BASE_R = 1.65;
const ORB_R = 0.13;
const ORB_Y = 0.62;
const CELL_Y = 1.3;
const COLUMN_H = 7.5;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);

/** Elastic pop-in curve (0 -> 1 with overshoot). */
function elasticOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

export class BoostPadsView implements IBoostPadsView {
  readonly object = new Group();
  private readonly pads: ReadonlyArray<{ x: number; z: number; big: boolean }>;
  private readonly bases: InstancedMesh;
  private readonly orbs: InstancedMesh;
  private readonly cells: InstancedMesh;
  private readonly columns: InstancedMesh;
  private readonly baseState: InstancedBufferAttribute;
  private readonly orbState: InstancedBufferAttribute;
  private readonly cellState: InstancedBufferAttribute;
  private readonly columnState: InstancedBufferAttribute;
  private readonly smallIdx: number[] = [];
  private readonly bigIdx: number[] = [];
  private readonly act: Float32Array;
  private readonly pop: Float32Array;
  private readonly offTime: Float32Array;
  private readonly prevActive: Uint8Array;
  private readonly phase: Float32Array;
  private readonly mats: ShaderMaterial[] = [];
  private first = true;

  constructor(pads: ReadonlyArray<{ x: number; z: number; big: boolean }>) {
    this.pads = pads;
    this.object.name = 'boostPads';
    const n = pads.length;
    this.act = new Float32Array(n).fill(1);
    this.pop = new Float32Array(n);
    this.offTime = new Float32Array(n);
    this.prevActive = new Uint8Array(n).fill(1);
    this.phase = new Float32Array(n);
    pads.forEach((p, i) => {
      (p.big ? this.bigIdx : this.smallIdx).push(i);
      this.phase[i] = ((i * 2.3999632) % (Math.PI * 2)) + p.x * 0.01;
    });

    // ---------------- bases ----------------
    const baseGeo = new PlaneGeometry(2, 2);
    baseGeo.rotateX(-Math.PI / 2);
    const baseMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: BOOST_COLOR.clone() } },
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        attribute vec4 iState; // active, recharge progress, big, pop flash
        varying vec2 vP;
        varying vec4 vState;
        void main() {
          vP = position.xz;
          vState = iState;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vP;
        varying vec4 vState;
        float hexd(vec2 p) { p = abs(p); return max(p.x * 0.8660254 + p.y * 0.5, p.y); }
        void main() {
          float d = hexd(vP) / 0.8660254; // 1 at the hex edge (flat-top, circumradius 1)
          if (d > 1.0) discard;
          float act = vState.x, prog = vState.y, big = vState.z, pop = vState.w;
          float aa = max(fwidth(d) * 1.2, 1e-4);
          float rim = smoothstep(0.84 - aa, 0.84 + aa, d) * (1.0 - smoothstep(0.93 - aa, 0.93 + aa, d));
          float lip = smoothstep(0.96 - aa, 0.96 + aa, d);
          float ring2 = smoothstep(0.5 - aa, 0.5 + aa, d) * (1.0 - smoothstep(0.54 - aa, 0.54 + aa, d));
          float center = exp(-d * d * 7.0);
          float ang = atan(vP.y, vP.x + 1e-5);
          float sweep = pow(clamp(0.5 + 0.5 * cos(ang * 3.0 - uTime * (2.0 + big)), 0.0, 1.0), 8.0);
          // recharge arc (clockwise from the top) while inactive
          float a01 = fract(0.25 - ang / 6.2831853);
          float charged = (1.0 - smoothstep(prog - 0.004, prog + 0.004, a01)) * (1.0 - act);
          // chevrons pointing inward
          vec2 q = vP * 3.2;
          float chev = 0.0;
          vec3 base = vec3(0.018, 0.02, 0.026) + vec3(0.03, 0.028, 0.02) * lip;
          float glow = rim * (0.07 + 1.4 * act) * (0.8 + 0.4 * sweep)
                     + ring2 * (0.03 + 0.75 * act) * (0.5 + 0.9 * sweep)
                     + center * act * (0.16 + 0.14 * big)
                     + rim * charged * (0.55 + 0.45 * prog)
                     + pop * (rim * 2.0 + center * 1.5 + ring2);
          // inner hex micro-grid (energized when active)
          vec2 hq = vP * 7.0;
          vec2 hr = vec2(1.0, 1.7320508);
          vec2 ha = mod(hq, hr) - hr * 0.5;
          vec2 hb = mod(hq - hr * 0.5, hr) - hr * 0.5;
          vec2 hg = dot(ha, ha) < dot(hb, hb) ? ha : hb;
          float cell = max(abs(hg.x) * 0.8660254 + abs(hg.y) * 0.5, abs(hg.y));
          // fade the micro-grid out where it would alias (far / grazing)
          float gridAA = 1.0 - smoothstep(0.25, 0.6, length(fwidth(hq)));
          float grid = smoothstep(0.4, 0.47, cell) * (1.0 - smoothstep(0.84, 0.86, d)) * (0.04 + 0.96 * act) * gridAA;
          glow += grid * 0.22 * (0.6 + 0.4 * sweep);
          vec3 col = base + uColor * glow * 2.1 + vec3(1.0, 0.95, 0.85) * center * act * 0.12;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.bases = new InstancedMesh(baseGeo, baseMat, n);
    this.baseState = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.baseState.setUsage(DynamicDrawUsage);
    baseGeo.setAttribute('iState', this.baseState);
    pads.forEach((p, i) => {
      const r = p.big ? BIG_BASE_R : SMALL_BASE_R;
      _m.compose(_p.set(p.x, 0.018, p.z), _q.identity(), _s.set(r, 1, r));
      this.bases.setMatrixAt(i, _m);
    });
    this.bases.layers.set(LAYER_MAIN_ONLY);
    this.bases.name = 'padBases';
    this.bases.frustumCulled = false;
    this.mats.push(baseMat);

    // ---------------- small orbs ----------------
    // Small and kept well below the ball's brightness: a pad marker must never read as a second (golden) ball.
    const orbGeo = new IcosahedronGeometry(ORB_R, 2);
    const orbMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: BOOST_COLOR.clone() }, uHot: { value: HOT.clone() } },
      vertexShader: /* glsl */ `
        attribute vec2 iOrb; // phase, flash
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        varying vec2 vOrb;
        void main() {
          vObj = position;
          vOrb = iOrb;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor, uHot;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        varying vec2 vOrb;
        void main() {
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float fres = pow(max(1.0 - ndv, 0.0), 2.2);
          vec3 p = normalize(vObj);
          float swirl = 0.5 + 0.5 * sin(p.y * 9.0 + atan(p.z, p.x + 1e-5) * 3.0 - uTime * 5.0 + vOrb.x);
          vec3 col = uColor * (0.5 + 1.25 * fres + 0.3 * swirl) + uHot * pow(ndv, 7.0) * (0.36 + 0.16 * swirl);
          col *= 1.0 + vOrb.y * 2.0;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const ns = this.smallIdx.length;
    this.orbs = new InstancedMesh(orbGeo, orbMat, Math.max(1, ns));
    this.orbs.count = ns;
    this.orbState = new InstancedBufferAttribute(new Float32Array(Math.max(1, ns) * 2), 2);
    this.orbState.setUsage(DynamicDrawUsage);
    orbGeo.setAttribute('iOrb', this.orbState);
    this.orbs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.orbs.frustumCulled = false;
    this.orbs.name = 'padOrbs';
    this.mats.push(orbMat);

    // ---------------- big cells (crystal + orbit ring) ----------------
    const crystal = new LatheGeometry(
      [new Vector2(0.0001, -0.62), new Vector2(0.3, -0.2), new Vector2(0.34, 0.0), new Vector2(0.3, 0.2), new Vector2(0.0001, 0.62)],
      6,
    ).toNonIndexed();
    crystal.computeVertexNormals();
    crystal.deleteAttribute('uv');
    const ring = new TorusGeometry(0.62, 0.018, 6, 48).toNonIndexed();
    ring.rotateX(Math.PI / 2 + 0.35);
    ring.deleteAttribute('uv');
    // mark ring vertices (aKind = 1) to shade them differently
    const kindC = new Float32Array(crystal.attributes.position.count);
    const kindR = new Float32Array(ring.attributes.position.count).fill(1);
    crystal.setAttribute('aKind', new BufferAttribute(kindC, 1));
    ring.setAttribute('aKind', new BufferAttribute(kindR, 1));
    const cellGeo = mergeGeometries([crystal, ring]);
    crystal.dispose();
    ring.dispose();
    const cellMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: BOOST_COLOR.clone() }, uHot: { value: HOT.clone() } },
      vertexShader: /* glsl */ `
        attribute float aKind;
        attribute vec2 iCell; // phase, flash
        varying vec3 vN;
        varying vec3 vV;
        varying float vKind;
        varying vec2 vCell;
        varying float vY;
        void main() {
          vKind = aKind;
          vCell = iCell;
          vY = position.y;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor, uHot;
        varying vec3 vN;
        varying vec3 vV;
        varying float vKind;
        varying vec2 vCell;
        varying float vY;
        void main() {
          vec3 n = normalize(vN);
          float ndv = clamp(abs(dot(n, normalize(vV))), 0.0, 1.0);
          float fres = pow(max(1.0 - ndv, 0.0), 2.0);
          vec3 col;
          if (vKind > 0.5) {
            col = uColor * 3.0 + uHot * 0.6;
          } else {
            float facet = 0.55 + 0.45 * abs(dot(n, normalize(vec3(0.4, 0.8, 0.3))));
            float band = pow(clamp(0.5 + 0.5 * sin(vY * 14.0 - uTime * 4.0 + vCell.x), 0.0, 1.0), 6.0);
            col = uColor * (0.9 * facet + 2.2 * fres + 1.1 * band) * 1.15 + uHot * pow(ndv, 8.0) * 0.9;
          }
          col *= 1.0 + vCell.y * 2.0;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const nb = this.bigIdx.length;
    this.cells = new InstancedMesh(cellGeo, cellMat, Math.max(1, nb));
    this.cells.count = nb;
    this.cellState = new InstancedBufferAttribute(new Float32Array(Math.max(1, nb) * 2), 2);
    this.cellState.setUsage(DynamicDrawUsage);
    cellGeo.setAttribute('iCell', this.cellState);
    this.cells.instanceMatrix.setUsage(DynamicDrawUsage);
    this.cells.frustumCulled = false;
    this.cells.name = 'padCells';
    this.mats.push(cellMat);

    // ---------------- light columns (big pads) ----------------
    const colGeo = new CylinderGeometry(1, 1, 1, 24, 1, true);
    colGeo.translate(0, 0.5, 0);
    const colMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: BOOST_COLOR.clone() } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float iAct;
        varying float vH;
        varying float vAct;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vH = position.y;
          vAct = iAct;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying float vH;
        varying float vAct;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float bands = 0.65 + 0.35 * sin(vH * 26.0 - uTime * 3.5);
          float a = pow(ndv, 1.6) * pow(clamp(1.0 - vH, 0.0, 1.0), 2.2) * bands * vAct * 0.55;
          gl_FragColor = vec4(uColor * 1.6, a);
        }
      `,
    });
    this.columns = new InstancedMesh(colGeo, colMat, Math.max(1, nb));
    this.columns.count = nb;
    this.columnState = new InstancedBufferAttribute(new Float32Array(Math.max(1, nb)), 1);
    this.columnState.setUsage(DynamicDrawUsage);
    colGeo.setAttribute('iAct', this.columnState);
    this.bigIdx.forEach((pi, k) => {
      const p = pads[pi];
      _m.compose(_p.set(p.x, 0.02, p.z), _q.identity(), _s.set(0.95, COLUMN_H, 0.95));
      this.columns.setMatrixAt(k, _m);
    });
    this.columns.frustumCulled = false;
    this.columns.renderOrder = 2;
    this.columns.name = 'padColumns';
    this.mats.push(colMat);

    this.object.add(this.bases, this.orbs, this.cells, this.columns);
  }

  update(active: ReadonlyArray<boolean>, dt: number, time: number): void {
    const n = this.pads.length;
    for (let i = 0; i < n; i++) {
      const a = active[i] !== false;
      const was = this.prevActive[i] === 1;
      if (this.first) {
        this.act[i] = a ? 1 : 0;
      } else if (a && !was) {
        this.pop[i] = 1; // reactivation flash + elastic pop
      } else if (!a && was) {
        this.offTime[i] = 0;
      }
      this.prevActive[i] = a ? 1 : 0;
      if (!a) this.offTime[i] += dt;
      const target = a ? 1 : 0;
      this.act[i] += (target - this.act[i]) * damp(a ? 5 : 16, dt);
      this.pop[i] = Math.max(0, this.pop[i] - dt * 1.6);
    }
    this.first = false;

    // bases
    const bs = this.baseState.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const big = this.pads[i].big;
      const respawn = big ? BOOST_PADS.bigRespawn : BOOST_PADS.smallRespawn;
      const o = i * 4;
      bs[o] = this.act[i];
      bs[o + 1] = this.prevActive[i] ? 1 : clamp01(this.offTime[i] / respawn);
      bs[o + 2] = big ? 1 : 0;
      bs[o + 3] = this.pop[i] * this.pop[i];
    }
    this.baseState.needsUpdate = true;

    // orbs
    const os = this.orbState.array as Float32Array;
    for (let k = 0; k < this.smallIdx.length; k++) {
      const i = this.smallIdx[k];
      const p = this.pads[i];
      const ph = this.phase[i];
      const scale = this.scaleFor(i);
      _p.set(p.x, ORB_Y + Math.sin(time * 2.1 + ph) * 0.07, p.z);
      _q.setFromAxisAngle(_up, time * 1.3 + ph);
      _m.compose(_p, _q, _s.setScalar(scale));
      this.orbs.setMatrixAt(k, _m);
      os[k * 2] = ph;
      os[k * 2 + 1] = this.pop[i] * this.pop[i];
    }
    this.orbs.instanceMatrix.needsUpdate = true;
    this.orbState.needsUpdate = true;

    // cells + columns
    const cs = this.cellState.array as Float32Array;
    const cl = this.columnState.array as Float32Array;
    for (let k = 0; k < this.bigIdx.length; k++) {
      const i = this.bigIdx[k];
      const p = this.pads[i];
      const ph = this.phase[i];
      const scale = this.scaleFor(i);
      _p.set(p.x, CELL_Y + Math.sin(time * 1.4 + ph) * 0.1, p.z);
      _q.setFromAxisAngle(_up, time * 0.9 + ph);
      _m.compose(_p, _q, _s.setScalar(scale));
      this.cells.setMatrixAt(k, _m);
      cs[k * 2] = ph;
      cs[k * 2 + 1] = this.pop[i] * this.pop[i];
      cl[k] = this.act[i] * (0.8 + 0.2 * Math.sin(time * 2.0 + ph)) + this.pop[i] * 1.5;
    }
    this.cells.instanceMatrix.needsUpdate = true;
    this.cellState.needsUpdate = true;
    this.columnState.needsUpdate = true;

    for (const m of this.mats) m.uniforms.uTime.value = time;
  }

  /** Orb / cell scale: collapses fast when picked up, elastic pop when re-activated. */
  private scaleFor(i: number): number {
    if (!this.prevActive[i]) return Math.max(0, this.act[i] * this.act[i]) < 0.02 ? 0 : this.act[i] * this.act[i];
    const t = 1 - this.pop[i]; // pop decays 1 -> 0 over ~0.6 s
    return this.pop[i] > 0 ? elasticOut(Math.min(1, t * 1.25)) : 1;
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const m of [this.bases, this.orbs, this.cells, this.columns]) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.mats) m.dispose();
  }
}
