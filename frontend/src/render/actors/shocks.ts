/**
 * ShockPool — pooled instanced shock rings, shock spheres and light beams (one draw call per kind, only when
 * something is alive). CPU-driven expansion curves; zero allocations per frame.
 */
import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type BufferGeometry,
} from 'three';
import { LAYER_MAIN_ONLY } from '../../contracts';

export const SHOCK_RING = 0;
export const SHOCK_SPHERE = 1;
export const SHOCK_BEAM = 2;

const FIELDS = 20;
// [kind, x, y, z, nx, ny, nz, r0, r1, age, life, r, g, b, intensity, thickness, ease, height, fadeStart, _]
const K = 0,
  X = 1,
  Y = 2,
  Z = 3,
  NX = 4,
  NY = 5,
  NZ = 6,
  RA = 7,
  RB = 8,
  AGE = 9,
  LIFE = 10,
  CR = 11,
  CG = 12,
  CB = 13,
  INT = 14,
  THICK = 15,
  EASE = 16,
  HEIGHT = 17,
  FADE = 18;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _n = new Vector3();
const _zAxis = new Vector3(0, 0, 1);
const _yAxis = new Vector3(0, 1, 0);

interface KindMesh {
  mesh: InstancedMesh;
  col: InstancedBufferAttribute;
  par: InstancedBufferAttribute;
  count: number;
}

function makeKind(geo: BufferGeometry, mat: ShaderMaterial, cap: number): KindMesh {
  const mesh = new InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const col = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  col.setUsage(DynamicDrawUsage);
  const par = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  par.setUsage(DynamicDrawUsage);
  geo.setAttribute('iCol', col);
  geo.setAttribute('iPar', par);
  mesh.count = 0;
  // stays visible (0 instances) until the first update so renderer.compile()/compileAsync() warms its shader
  mesh.frustumCulled = false;
  return { mesh, col, par, count: 0 };
}

export class ShockPool {
  readonly object = new Group();
  private readonly data: Float32Array;
  private readonly cap: number;
  private n = 0;
  private readonly kinds: KindMesh[];

  constructor(capacity = 48) {
    this.cap = capacity;
    this.data = new Float32Array(capacity * FIELDS);
    const ringGeo = new PlaneGeometry(2, 2);
    const ringMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 iCol;
        attribute vec4 iPar; // progress, thickness, intensity-mult, unused
        varying vec2 vUv;
        varying vec4 vCol;
        varying vec4 vPar;
        void main() {
          vUv = position.xy;
          vCol = iCol;
          vPar = iPar;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vCol;
        varying vec4 vPar;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float th = max(vPar.y, 0.004);
          // bright leading edge at r = 1 with a soft wake behind it
          float x = (1.0 - r) / th;
          float ring = exp(-x * x * 2.2) + exp(-x * 1.6) * 0.14;
          float inner = (1.0 - smoothstep(0.0, 1.0, r)) * 0.025;
          float aa = max(fwidth(r) * 1.5, 1e-4);
          float a = (ring + inner) * (1.0 - smoothstep(1.0 - aa, 1.0, r)) * vCol.a;
          gl_FragColor = vec4(vCol.rgb, clamp(a, 0.0, 1.0));
        }
      `,
    });
    const sphereGeo = new IcosahedronGeometry(1, 4);
    const sphereMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 iCol;
        attribute vec4 iPar;
        varying vec3 vN;
        varying vec3 vV;
        varying vec4 vCol;
        varying vec4 vPar;
        varying vec3 vObj;
        void main() {
          vCol = iCol;
          vPar = iPar;
          vObj = position;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        varying vec4 vCol;
        varying vec4 vPar;
        varying vec3 vObj;
        void main() {
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float f = clamp(1.0 - ndv, 0.0, 1.0);
          float f2 = f * f;
          float rim = f2 * f2 * f * 1.3 + pow(f, 14.0) * 2.2;
          float bands = 0.85 + 0.15 * sin(vObj.y * 22.0 + vPar.x * 20.0);
          float a = rim * bands * vCol.a;
          gl_FragColor = vec4(vCol.rgb, clamp(a, 0.0, 1.0));
        }
      `,
    });
    const beamGeo = new CylinderGeometry(1, 1, 1, 24, 1, true);
    beamGeo.translate(0, 0.5, 0);
    const beamMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 iCol;
        attribute vec4 iPar;
        varying vec3 vN;
        varying vec3 vV;
        varying vec4 vCol;
        varying vec4 vPar;
        varying float vH;
        void main() {
          vCol = iCol;
          vPar = iPar;
          vH = position.y;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        varying vec4 vCol;
        varying vec4 vPar;
        varying float vH;
        void main() {
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float core = pow(ndv, 3.0);
          float bands = 0.7 + 0.3 * sin(vH * 30.0 - vPar.x * 40.0);
          float a = (core * 1.2 + pow(ndv, 1.2) * 0.25) * pow(clamp(1.0 - vH, 0.0, 1.0), 1.6) * bands * vCol.a;
          gl_FragColor = vec4(vCol.rgb, clamp(a, 0.0, 1.0));
        }
      `,
    });
    this.kinds = [makeKind(ringGeo, ringMat, capacity), makeKind(sphereGeo, sphereMat, capacity), makeKind(beamGeo, beamMat, 16)];
    this.kinds[0].mesh.layers.set(LAYER_MAIN_ONLY);
    this.kinds[0].mesh.renderOrder = 6;
    this.kinds[1].mesh.renderOrder = 6;
    this.kinds[2].mesh.renderOrder = 6;
    this.kinds[0].mesh.name = 'shockRings';
    this.kinds[1].mesh.name = 'shockSpheres';
    this.kinds[2].mesh.name = 'shockBeams';
    for (const k of this.kinds) this.object.add(k.mesh);
  }

  /**
   * Spawn a shock. Rings face `n` (their plane normal); beams extend along `n` for `height`.
   * ease: exponent of the expansion curve (higher = faster start). fadeStart: progress at which fading begins.
   */
  spawn(
    kind: number,
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    r0: number,
    r1: number,
    life: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
    thickness = 0.15,
    ease = 3,
    height = 1,
    fadeStart = 0.25,
  ): void {
    if (this.n >= this.cap) return;
    const o = this.n * FIELDS;
    const d = this.data;
    d[o + K] = kind;
    d[o + X] = x;
    d[o + Y] = y;
    d[o + Z] = z;
    d[o + NX] = nx;
    d[o + NY] = ny;
    d[o + NZ] = nz;
    d[o + RA] = r0;
    d[o + RB] = r1;
    d[o + AGE] = 0;
    d[o + LIFE] = Math.max(0.05, life);
    d[o + CR] = r;
    d[o + CG] = g;
    d[o + CB] = b;
    d[o + INT] = intensity;
    d[o + THICK] = thickness;
    d[o + EASE] = ease;
    d[o + HEIGHT] = height;
    d[o + FADE] = fadeStart;
    this.n++;
  }

  clear(): void {
    this.n = 0;
    for (const k of this.kinds) {
      k.mesh.count = 0;
      k.mesh.visible = false;
    }
  }

  update(dt: number): void {
    const d = this.data;
    const kinds = this.kinds;
    for (let ki = 0; ki < kinds.length; ki++) kinds[ki].count = 0;
    let i = 0;
    while (i < this.n) {
      const o = i * FIELDS;
      const age = d[o + AGE] + dt;
      if (age >= d[o + LIFE]) {
        this.n--;
        if (i !== this.n) d.copyWithin(o, this.n * FIELDS, this.n * FIELDS + FIELDS);
        continue;
      }
      d[o + AGE] = age;
      const t = age / d[o + LIFE];
      const kind = d[o + K] | 0;
      const km = this.kinds[kind];
      if (km.count >= km.mesh.instanceMatrix.count) {
        i++;
        continue;
      }
      const e = 1 - Math.pow(1 - t, d[o + EASE]);
      const rad = d[o + RA] + (d[o + RB] - d[o + RA]) * e;
      const fs = d[o + FADE];
      const fade = t < fs ? 1 : 1 - (t - fs) / (1 - fs);
      _n.set(d[o + NX], d[o + NY], d[o + NZ]);
      if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
      _n.normalize();
      _p.set(d[o + X], d[o + Y], d[o + Z]);
      if (kind === SHOCK_RING) {
        _q.setFromUnitVectors(_zAxis, _n);
        _s.set(rad, rad, rad);
      } else if (kind === SHOCK_BEAM) {
        _q.setFromUnitVectors(_yAxis, _n);
        _s.set(rad, d[o + HEIGHT], rad);
      } else {
        _q.identity();
        _s.set(rad, rad, rad);
      }
      _m.compose(_p, _q, _s);
      const j = km.count++;
      km.mesh.setMatrixAt(j, _m);
      const ca = km.col.array as Float32Array;
      ca[j * 4] = d[o + CR];
      ca[j * 4 + 1] = d[o + CG];
      ca[j * 4 + 2] = d[o + CB];
      ca[j * 4 + 3] = d[o + INT] * fade * fade;
      const pa = km.par.array as Float32Array;
      pa[j * 4] = t;
      pa[j * 4 + 1] = d[o + THICK] * (1 - 0.4 * t);
      pa[j * 4 + 2] = 0;
      pa[j * 4 + 3] = 0;
      i++;
    }
    for (let ki = 0; ki < kinds.length; ki++) {
      const k = kinds[ki];
      k.mesh.count = k.count;
      k.mesh.visible = k.count > 0;
      if (k.count > 0) {
        k.mesh.instanceMatrix.clearUpdateRanges();
        k.mesh.instanceMatrix.addUpdateRange(0, k.count * 16);
        k.mesh.instanceMatrix.needsUpdate = true;
        k.col.clearUpdateRanges();
        k.col.addUpdateRange(0, k.count * 4);
        k.col.needsUpdate = true;
        k.par.clearUpdateRanges();
        k.par.addUpdateRange(0, k.count * 4);
        k.par.needsUpdate = true;
      }
    }
  }

  get active(): number {
    return this.n;
  }

  /** Make every kind visible (0 instances) so a following renderer.compile() warms the shaders. */
  prewarm(): void {
    for (let ki = 0; ki < this.kinds.length; ki++) this.kinds[ki].mesh.visible = true;
  }

  dispose(): void {
    for (const k of this.kinds) {
      k.mesh.geometry.dispose();
      (k.mesh.material as ShaderMaterial).dispose();
      k.mesh.dispose();
    }
  }
}
