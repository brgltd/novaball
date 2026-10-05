/**
 * ParticlePool — CPU-simulated, GPU-instanced camera-facing quads. One draw call per pool.
 *  - Preallocated AoS Float32Array state (no allocations after construction).
 *  - Alive particles are kept packed in [0, count) (swap-remove), so the GPU upload is ONE contiguous
 *    bufferSubData of count × 16 floats per frame (InstancedInterleavedBuffer + addUpdateRange).
 *  - Velocity-stretched sparks, soft glows, flickering embers, hex shards, soft smoke — selected per particle.
 */
import {
  AdditiveBlending,
  Vector4,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';

// CPU state layout
const S = 28;
const PX = 0,
  PY = 1,
  PZ = 2,
  VX = 3,
  VY = 4,
  VZ = 5,
  AGE = 6,
  LIFE = 7,
  SZ0 = 8,
  SZ1 = 9,
  R0 = 10,
  G0 = 11,
  B0 = 12,
  R1 = 13,
  G1 = 14,
  B1 = 15,
  ALPHA = 16,
  DRAG = 17,
  GRAV = 18,
  STRETCH = 19,
  SHAPE = 20,
  FLAGS = 21,
  TARGET = 22,
  TURB = 23,
  ROT = 24,
  ROTV = 25,
  FADEIN = 26,
  SEED = 27;

// GPU layout (per instance)
const G = 16; // [px py pz size | vx vy vz stretch | r g b a | shape rot seed 0]

export const SHAPE_GLOW = 0;
export const SHAPE_SPARK = 1;
export const SHAPE_EMBER = 2;
export const SHAPE_HEX = 3;
export const SHAPE_SMOKE = 4;
export const SHAPE_RING = 5;

export const FLAG_FLOOR = 1;
export const FLAG_HOMING = 2;

/** Homing particles die this close to the target car's center (m)... */
const HOME_KILL = 0.45;
/** ...and fade out from this distance on (m), so they vanish into the car body. */
const HOME_FADE = 1.2;

/** Mutable spawn template (reuse one instance; spawn() copies it). */
export class ParticleSpawn {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  size0 = 0.2;
  size1 = 0.2;
  r0 = 1;
  g0 = 1;
  b0 = 1;
  r1 = 1;
  g1 = 1;
  b1 = 1;
  alpha = 1;
  drag = 0;
  grav = 0;
  stretch = 0;
  shape = SHAPE_GLOW;
  flags = 0;
  target = -1;
  turb = 0;
  rot = 0;
  rotVel = 0;
  fadeIn = 0.05;
  seed = 0;
  /** Reset to neutral defaults (call before configuring a new effect). */
  reset(): this {
    this.vx = this.vy = this.vz = 0;
    this.life = 1;
    this.size0 = this.size1 = 0.2;
    this.r0 = this.g0 = this.b0 = this.r1 = this.g1 = this.b1 = 1;
    this.alpha = 1;
    this.drag = this.grav = this.stretch = 0;
    this.shape = SHAPE_GLOW;
    this.flags = 0;
    this.target = -1;
    this.turb = this.rot = this.rotVel = 0;
    this.fadeIn = 0.05;
    this.seed = 0;
    return this;
  }
  color0(r: number, g: number, b: number, k = 1): this {
    this.r0 = r * k;
    this.g0 = g * k;
    this.b0 = b * k;
    return this;
  }
  color1(r: number, g: number, b: number, k = 1): this {
    this.r1 = r * k;
    this.g1 = g * k;
    this.b1 = b * k;
    return this;
  }
}

export interface ParticleContext {
  /** World positions of cars by id (x, y, z triplets) for homing particles. */
  carPos: Float32Array;
  /** World velocities of cars by id (x, y, z triplets): homing particles chase the car in its own frame. */
  carVel: Float32Array;
  carValid: Uint8Array;
  /** Gravity acceleration (m/s², positive = down) already scaled by surge. */
  gravity: number;
  time: number;
}

const _center = new Vector3();
const _viewport = new Vector4();

export class ParticlePool {
  readonly mesh: Mesh;
  readonly capacity: number;
  /** Quality cap (<= capacity). */
  limit: number;
  count = 0;
  private readonly st: Float32Array;
  private readonly gpu: Float32Array;
  private readonly ibuf: InstancedInterleavedBuffer;
  private readonly geo: InstancedBufferGeometry;
  private readonly mat: ShaderMaterial;
  private uploaded = 0;

  constructor(capacity: number, mode: 'add' | 'alpha') {
    this.capacity = capacity;
    this.limit = capacity;
    this.st = new Float32Array(capacity * S);
    this.gpu = new Float32Array(capacity * G);
    this.geo = new InstancedBufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.ibuf = new InstancedInterleavedBuffer(this.gpu, G, 1);
    this.ibuf.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', new InterleavedBufferAttribute(this.ibuf, 4, 0));
    this.geo.setAttribute('iVel', new InterleavedBufferAttribute(this.ibuf, 4, 4));
    this.geo.setAttribute('iCol', new InterleavedBufferAttribute(this.ibuf, 4, 8));
    this.geo.setAttribute('iMisc', new InterleavedBufferAttribute(this.ibuf, 4, 12));
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new Sphere(_center, 1e5);
    this.mat = new ShaderMaterial({
      uniforms: { uViewportH: { value: 900 }, uMinPx: { value: 1.6 }, uMaxFrac: { value: 0.22 } },
      transparent: true,
      depthWrite: false,
      blending: mode === 'add' ? AdditiveBlending : NormalBlending,
      vertexShader: /* glsl */ `
        uniform float uViewportH;
        uniform float uMinPx;
        uniform float uMaxFrac;
        attribute vec4 iPos;
        attribute vec4 iVel;
        attribute vec4 iCol;
        attribute vec4 iMisc;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vShape;
        varying float vSeed;
        varying float vStretch;
        void main() {
          vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
          float size = iPos.w;
          // keep far particles at least uMinPx wide (no sub-pixel shimmer / vanishing sparks); conserve energy via alpha
          float pxPerM = 0.5 * uViewportH * projectionMatrix[1][1] / max(-mv.z, 0.05);
          float minSize = uMinPx / pxPerM;
          float energy = 1.0;
          if (size < minSize) {
            energy = size / minSize;
            size = minSize;
          }
          // cap huge near-camera glows (fill-rate + readability): at most uMaxFrac of the viewport height
          size = min(size, uMaxFrac * uViewportH / pxPerM);
          // particles (almost) touching the camera: fade out, and collapse the quad entirely inside 0.6 m
          float camDist = -mv.z;
          energy *= smoothstep(0.6, 2.2, camDist);
          if (camDist < 0.6) size = 0.0;
          vec2 c = position.xy;
          vUv = c * 2.0;
          vStretch = 0.0;
          if (iVel.w > 0.0) {
            vec3 vv = (viewMatrix * vec4(iVel.xyz, 0.0)).xyz;
            float z = min(mv.z, -0.05);
            // screen-space motion of a point moving with vv at view position mv (perspective-correct)
            vec2 d = vv.xy - (mv.xy / z) * vv.z;
            float l = length(d);
            vec2 dir = l > 1e-5 ? d / l : vec2(0.0, 1.0);
            float len = l * iVel.w;
            // (dir.y, -dir.x) keeps [perp | dir] a proper rotation (det +1): the reflected basis would flip the
            // quad's winding and FrontSide culling would silently drop every stretched spark
            vec2 perp = vec2(dir.y, -dir.x);
            // head at the particle, tail trailing behind
            mv.xy += dir * (c.y * (size + len) - len * 0.5) + perp * c.x * size;
            vStretch = len / (len + size);
          } else {
            float r = iMisc.y;
            float cs = cos(r), sn = sin(r);
            mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
          }
          gl_Position = projectionMatrix * mv;
          vCol = vec4(iCol.rgb, iCol.a * energy);
          vShape = iMisc.x;
          vSeed = iMisc.z;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vShape;
        varying float vSeed;
        varying float vStretch;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float a;
          if (vShape < 0.5) {
            a = exp(-r2 * 4.2) - 0.015;
          } else if (vShape < 1.5) {
            // spark: bright core line with soft falloff
            float w = 1.0 - r2;
            a = w * w * (0.6 + 0.4 * vStretch) + exp(-r2 * 18.0) * 0.8;
          } else if (vShape < 2.5) {
            a = exp(-r2 * 9.0) + exp(-r2 * 2.5) * 0.25;
          } else if (vShape < 3.5) {
            vec2 p = abs(vUv);
            float h = max(p.x * 0.8660254 + p.y * 0.5, p.y) / 0.8660254;
            a = (1.0 - smoothstep(0.86, 1.0, h)) * (0.35 + 0.65 * smoothstep(0.55, 0.85, h));
          } else if (vShape < 4.5) {
            float n = vnoise(vUv * 2.6 + vSeed * 17.0) * 0.6 + vnoise(vUv * 5.3 - vSeed * 7.0) * 0.4;
            a = (1.0 - smoothstep(0.15, 1.0, sqrt(r2))) * (0.45 + 0.75 * n);
          } else {
            float x = (sqrt(r2) - 0.8) / 0.12;
            a = exp(-x * x);
          }
          a = clamp(a, 0.0, 1.0) * vCol.a;
          gl_FragColor = vec4(vCol.rgb, a);
        }
      `,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    const u = this.mat.uniforms.uViewportH;
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(_viewport);
      u.value = _viewport.w > 0 ? _viewport.w : 900;
    };
  }

  get free(): number {
    return this.limit - this.count;
  }

  /** Spawn one particle from the template. Returns false if the pool is full. */
  spawn(p: ParticleSpawn): boolean {
    if (this.count >= this.limit) return false;
    const o = this.count * S;
    const s = this.st;
    s[o + PX] = p.x;
    s[o + PY] = p.y;
    s[o + PZ] = p.z;
    s[o + VX] = p.vx;
    s[o + VY] = p.vy;
    s[o + VZ] = p.vz;
    s[o + AGE] = 0;
    s[o + LIFE] = Math.max(0.016, p.life);
    s[o + SZ0] = p.size0;
    s[o + SZ1] = p.size1;
    s[o + R0] = p.r0;
    s[o + G0] = p.g0;
    s[o + B0] = p.b0;
    s[o + R1] = p.r1;
    s[o + G1] = p.g1;
    s[o + B1] = p.b1;
    s[o + ALPHA] = p.alpha;
    s[o + DRAG] = p.drag;
    s[o + GRAV] = p.grav;
    s[o + STRETCH] = p.stretch;
    s[o + SHAPE] = p.shape;
    s[o + FLAGS] = p.flags;
    s[o + TARGET] = p.target;
    s[o + TURB] = p.turb;
    s[o + ROT] = p.rot;
    s[o + ROTV] = p.rotVel;
    s[o + FADEIN] = p.fadeIn;
    s[o + SEED] = p.seed;
    this.count++;
    return true;
  }

  clear(): void {
    this.count = 0;
  }

  update(dt: number, ctx: ParticleContext): void {
    const s = this.st;
    const g = this.gpu;
    const grav = ctx.gravity;
    const time = ctx.time;
    let n = this.count;
    let i = 0;
    while (i < n) {
      const o = i * S;
      const age = s[o + AGE] + dt;
      const life = s[o + LIFE];
      if (age >= life) {
        // swap-remove
        n--;
        if (i !== n) s.copyWithin(o, n * S, n * S + S);
        continue;
      }
      s[o + AGE] = age;
      const t = age / life;
      let vx = s[o + VX];
      let vy = s[o + VY];
      let vz = s[o + VZ];
      const drag = s[o + DRAG];
      if (drag > 0) {
        const k = Math.max(0, 1 - drag * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      vy -= s[o + GRAV] * grav * dt;
      const turb = s[o + TURB];
      if (turb > 0) {
        const sd = s[o + SEED] * 6.283;
        vx += Math.sin(time * 2.3 + sd + s[o + PY] * 0.7) * turb * dt;
        vy += Math.sin(time * 1.7 + sd * 1.3 + s[o + PX] * 0.5) * turb * 0.6 * dt;
        vz += Math.cos(time * 2.1 + sd * 0.7 + s[o + PX] * 0.6) * turb * dt;
      }
      const flags = s[o + FLAGS];
      let near = 1;
      let tid = -1;
      if ((flags & FLAG_HOMING) !== 0) {
        tid = s[o + TARGET] | 0;
        if (tid >= 0 && ctx.carValid[tid]) {
          const t3 = tid * 3;
          const dx = ctx.carPos[t3] - s[o + PX];
          const dy = ctx.carPos[t3 + 1] - s[o + PY];
          const dz = ctx.carPos[t3 + 2] - s[o + PZ];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
          const sp = 6 + 26 * t;
          const k = Math.min(1, dt * (3 + 14 * t));
          // swirl around the target (tangential, around world up), fading as the particle closes in; the target
          // velocity is the car's own plus the approach, so a fast car never leaves its sparks behind
          const hxz = Math.sqrt(dx * dx + dz * dz) + 1e-4;
          const sw = 9 * (1 - t) * (s[o + SEED] > 0.5 ? 1 : -1);
          vx += (ctx.carVel[t3] + (dx / d) * sp - (dz / hxz) * sw - vx) * k;
          vy += (ctx.carVel[t3 + 1] + (dy / d) * sp - vy) * k;
          vz += (ctx.carVel[t3 + 2] + (dz / d) * sp + (dx / hxz) * sw - vz) * k;
        } else tid = -1;
      }
      let px = s[o + PX] + vx * dt;
      let py = s[o + PY] + vy * dt;
      const pz = s[o + PZ] + vz * dt;
      if ((flags & FLAG_FLOOR) !== 0 && py < 0.03 && vy < 0) {
        py = 0.03;
        vy = -vy * 0.32;
        vx *= 0.72;
        vz *= 0.72;
      }
      if (tid >= 0) {
        // vanish into the car instead of piling up on it (the chase camera sits right behind it); measured at the
        // position actually drawn this frame
        const t3 = tid * 3;
        const ex = ctx.carPos[t3] - px;
        const ey = ctx.carPos[t3 + 1] - py;
        const ez = ctx.carPos[t3 + 2] - pz;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < HOME_KILL && t > 0.15) {
          n--;
          if (i !== n) s.copyWithin(o, n * S, n * S + S);
          continue;
        }
        const f = (d - HOME_KILL) / (HOME_FADE - HOME_KILL);
        near = f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
      }
      s[o + PX] = px;
      s[o + PY] = py;
      s[o + PZ] = pz;
      s[o + VX] = vx;
      s[o + VY] = vy;
      s[o + VZ] = vz;
      const rot = s[o + ROT] + s[o + ROTV] * dt;
      s[o + ROT] = rot;

      // visuals
      const shape = s[o + SHAPE];
      const fi = s[o + FADEIN];
      let a = s[o + ALPHA] * near * (fi > 0 && t < fi ? t / fi : 1);
      if (shape === SHAPE_SPARK) a *= 1 - t * t;
      else if (shape === SHAPE_EMBER) a *= (1 - t) * (0.55 + 0.45 * Math.sin(age * 23 + s[o + SEED] * 40));
      else if (shape === SHAPE_SMOKE) a *= (1 - t) * (1 - t);
      else {
        const f = 1 - t;
        a *= f * Math.sqrt(f);
      }
      const q = i * G;
      g[q] = px;
      g[q + 1] = py;
      g[q + 2] = pz;
      g[q + 3] = s[o + SZ0] + (s[o + SZ1] - s[o + SZ0]) * t;
      g[q + 4] = vx;
      g[q + 5] = vy;
      g[q + 6] = vz;
      g[q + 7] = s[o + STRETCH];
      const ct = 1 - (1 - t) * (1 - t);
      g[q + 8] = s[o + R0] + (s[o + R1] - s[o + R0]) * ct;
      g[q + 9] = s[o + G0] + (s[o + G1] - s[o + G0]) * ct;
      g[q + 10] = s[o + B0] + (s[o + B1] - s[o + B0]) * ct;
      g[q + 11] = a;
      g[q + 12] = shape;
      g[q + 13] = rot;
      g[q + 14] = s[o + SEED];
      g[q + 15] = 0;
      i++;
    }
    this.count = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.ibuf.clearUpdateRanges();
      this.ibuf.addUpdateRange(0, n * G);
      this.ibuf.needsUpdate = true;
    }
    this.uploaded = n;
  }

  /** Debug: GPU-side values of the first n live particles. */
  debugSample(n = 8): Array<{ shape: number; size: number; speed: number; stretch: number; alpha: number; r: number }> {
    const out = [];
    for (let i = 0; i < Math.min(n, this.count); i++) {
      const q = i * G;
      const g = this.gpu;
      out.push({
        shape: g[q + 12],
        size: +g[q + 3].toFixed(3),
        speed: +Math.hypot(g[q + 4], g[q + 5], g[q + 6]).toFixed(2),
        stretch: g[q + 7],
        alpha: +g[q + 11].toFixed(3),
        r: +g[q + 8].toFixed(2),
      });
    }
    return out;
  }

  get lastUploaded(): number {
    return this.uploaded;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
