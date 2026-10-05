/**
 * RibbonBuffer — many camera-facing ribbons (trails, electric arcs) in ONE draw call.
 * Fixed layout: `strips` × `points` × 2 vertices, static index buffer, dynamic interleaved vertex data.
 * The vertex shader expands each point sideways (perpendicular to the tangent and the view direction).
 * Zero allocations per frame: write points with setPoint(), then commit().
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';

const STRIDE = 12; // pos3, tangent3, side1, width1, alpha1, u1, col... (packed below)
// layout per vertex: [px, py, pz, tx, ty, tz, side, width, alpha, r, g, b]

export class RibbonBuffer {
  readonly mesh: Mesh;
  readonly strips: number;
  readonly points: number;
  private readonly data: Float32Array;
  private readonly ibuf: InterleavedBuffer;
  /** Number of points written per strip for the current frame. */
  private readonly counts: Int32Array;
  /** Point count written last time per strip (to know what to collapse). */
  private readonly prevCounts: Int32Array;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private readonly material: ShaderMaterial;

  constructor(strips: number, points: number, opts: { softness?: number; core?: number; nearFade?: [number, number] } = {}) {
    this.strips = strips;
    this.points = points;
    const nv = strips * points * 2;
    this.data = new Float32Array(nv * STRIDE);
    this.ibuf = new InterleavedBuffer(this.data, STRIDE);
    this.ibuf.setUsage(DynamicDrawUsage);
    const g = new BufferGeometry();
    g.setAttribute('position', new InterleavedBufferAttribute(this.ibuf, 3, 0));
    g.setAttribute('aTan', new InterleavedBufferAttribute(this.ibuf, 3, 3));
    g.setAttribute('aInfo', new InterleavedBufferAttribute(this.ibuf, 3, 6));
    g.setAttribute('aCol', new InterleavedBufferAttribute(this.ibuf, 3, 9));
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(strips * (points - 1) * 6);
    let k = 0;
    for (let s = 0; s < strips; s++) {
      const base = s * points * 2;
      for (let i = 0; i < points - 1; i++) {
        const a = base + i * 2;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = a + 2;
        idx[k++] = a + 1;
        idx[k++] = a + 3;
        idx[k++] = a + 2;
      }
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.boundingSphere = new Sphere(new Vector3(), 1e5);
    this.counts = new Int32Array(strips);
    this.prevCounts = new Int32Array(strips);
    this.material = new ShaderMaterial({
      uniforms: {
        uSoft: { value: opts.softness ?? 1.6 },
        uCore: { value: opts.core ?? 0.5 },
        uNear: { value: opts.nearFade ?? [0.0, 0.0] },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aTan;
        attribute vec3 aInfo; // side (-1/1), width, alpha
        attribute vec3 aCol;
        uniform vec2 uNear;
        varying vec3 vCol;
        varying float vSide;
        varying float vAlpha;
        void main() {
          vec3 toCam = cameraPosition - position;
          // fade out ribbon sections close to the camera (a wide glowing ribbon would fill the screen)
          float near = uNear.y > 0.0 ? smoothstep(uNear.x, uNear.y, length(toCam)) : 1.0;
          vec3 side = cross(aTan, toCam);
          float l = length(side);
          side = l > 1e-6 ? side / l : vec3(0.0, 1.0, 0.0);
          vec3 p = position + side * aInfo.x * aInfo.y * 0.5;
          vCol = aCol;
          vSide = aInfo.x;
          vAlpha = aInfo.z * near;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uSoft;
        uniform float uCore;
        varying vec3 vCol;
        varying float vSide;
        varying float vAlpha;
        void main() {
          float d = abs(vSide);
          float soft = pow(max(1.0 - d, 0.0), uSoft);
          float core = pow(max(1.0 - d, 0.0), 8.0) * uCore;
          gl_FragColor = vec4(vCol * (soft + core), clamp(vAlpha, 0.0, 1.0));
        }
      `,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Start writing a strip (resets its point count). */
  begin(strip: number): void {
    this.counts[strip] = 0;
  }

  /** Append a point to a strip (world space). Returns false when full. */
  push(strip: number, x: number, y: number, z: number, width: number, alpha: number, r: number, g: number, b: number): boolean {
    const i = this.counts[strip];
    if (i >= this.points) return false;
    const v = (strip * this.points + i) * 2 * STRIDE;
    const d = this.data;
    for (let k = 0; k < 2; k++) {
      const o = v + k * STRIDE;
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      d[o + 6] = k === 0 ? -1 : 1;
      d[o + 7] = width;
      d[o + 8] = alpha;
      d[o + 9] = r;
      d[o + 10] = g;
      d[o + 11] = b;
    }
    this.counts[strip] = i + 1;
    return true;
  }

  /** Finish a strip: compute tangents, collapse unused points, mark its range for upload. */
  end(strip: number): void {
    const n = this.counts[strip];
    const P = this.points;
    const d = this.data;
    const base = strip * P * 2 * STRIDE;
    for (let i = 0; i < n; i++) {
      const i0 = i > 0 ? i - 1 : i;
      const i1 = i < n - 1 ? i + 1 : i;
      const a = base + i0 * 2 * STRIDE;
      const b = base + i1 * 2 * STRIDE;
      let tx = d[b] - d[a];
      let ty = d[b + 1] - d[a + 1];
      let tz = d[b + 2] - d[a + 2];
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (l > 1e-6) {
        tx /= l;
        ty /= l;
        tz /= l;
      } else {
        tx = 0;
        ty = 0;
        tz = 1;
      }
      const o = base + i * 2 * STRIDE;
      d[o + 3] = d[o + STRIDE + 3] = tx;
      d[o + 4] = d[o + STRIDE + 4] = ty;
      d[o + 5] = d[o + STRIDE + 5] = tz;
    }
    // Unused tail: zero width. The FIRST unused point must also sit exactly on the last live point, otherwise the
    // segment between them becomes a sliver triangle reaching to a stale position.
    const prevCount = this.prevCounts[strip];
    let clearTo = Math.max(prevCount, n);
    if (n < P) {
      const o = base + n * 2 * STRIDE;
      const src = base + Math.max(0, n - 1) * 2 * STRIDE;
      for (let k = 0; k < 2; k++) {
        const ok = o + k * STRIDE;
        d[ok] = d[src];
        d[ok + 1] = d[src + 1];
        d[ok + 2] = d[src + 2];
        d[ok + 7] = 0;
        d[ok + 8] = 0;
      }
      clearTo = Math.max(clearTo, n + 1);
    }
    for (let i = n + 1; i < clearTo; i++) {
      const o = base + i * 2 * STRIDE;
      d[o + 7] = d[o + STRIDE + 7] = 0;
      d[o + 8] = d[o + STRIDE + 8] = 0;
    }
    this.prevCounts[strip] = n;
    const end = base + Math.max(clearTo, 1) * 2 * STRIDE;
    if (base < this.dirtyMin) this.dirtyMin = base;
    if (end > this.dirtyMax) this.dirtyMax = end;
  }

  /** Upload everything written since beginFrame() as ONE contiguous range. */
  commit(): void {
    if (this.dirtyMax < 0) return;
    this.ibuf.clearUpdateRanges();
    this.ibuf.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
    this.ibuf.needsUpdate = true;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  /** Clear a strip (no points). */
  clearStrip(strip: number): void {
    this.begin(strip);
    this.end(strip);
  }

  /** Call once per frame before writing (resets the dirty bounds). */
  beginFrame(): void {
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
