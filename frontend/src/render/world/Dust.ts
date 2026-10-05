/**
 * NOVABALL render-world — drifting space dust motes (one Points draw call).
 * Subtle twinkling specks around and inside the arena that give depth/parallax; during a ZERO-G SURGE they
 * glow violet, grow and stream upward.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { LAYER_MAIN_ONLY } from '../../contracts';
import { GLSL_HASH } from './glsl';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uDrift;
uniform float uSurge;
uniform float uPxScale;
attribute vec4 aSeed;
varying vec3 vCol;
varying float vA;
${GLSL_HASH}
void main() {
  vec3 p = position;
  // slow wander + vertical drift (wrapped in a 110 m tall band)
  p.x += sin(uTime * 0.07 + aSeed.x * 40.0) * 2.0;
  p.z += cos(uTime * 0.05 + aSeed.y * 40.0) * 2.0;
  p.y = mod(p.y + uDrift * (0.6 + aSeed.z), 110.0) - 25.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed.w * 3.0) + aSeed.x * 60.0);
  float size = (0.06 + 0.12 * aSeed.w) * (1.0 + uSurge * 1.6);
  gl_PointSize = clamp(size * uPxScale / -mv.z, 1.0, 6.0);
  // fade near the camera to avoid big blobs, and far away
  float dist = -mv.z;
  vA = smoothstep(1.5, 6.0, dist) * (1.0 - smoothstep(160.0, 260.0, dist)) * tw;
  vec3 base = mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.85, 0.7), aSeed.y);
  vCol = mix(base, vec3(0.75, 0.4, 1.0), uSurge) * (0.5 + 1.2 * uSurge);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  float a = exp(-r2 * 14.0) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

export class Dust {
  readonly points: Points;
  private readonly mat: ShaderMaterial;
  private drift = 0;

  constructor(count: number) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    let s = 987654321;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      // denser near the arena, sparse far away
      const inner = rnd() < 0.45;
      const ex = inner ? 34 : 140;
      const ez = inner ? 48 : 160;
      pos[i * 3] = (rnd() * 2 - 1) * ex;
      pos[i * 3 + 1] = rnd() * 110;
      pos[i * 3 + 2] = (rnd() * 2 - 1) * ez;
      seed[i * 4] = rnd();
      seed[i * 4 + 1] = rnd();
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = rnd();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new BufferAttribute(seed, 4));
    this.mat = new ShaderMaterial({
      name: 'NovaDust',
      uniforms: {
        uTime: { value: 0 },
        uDrift: { value: 0 },
        uSurge: { value: 0 },
        uPxScale: { value: 800 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'SpaceDust';
    this.points.layers.set(LAYER_MAIN_ONLY);
  }

  update(dt: number, time: number, surge: number, pxScale: number): void {
    this.drift += dt * (0.25 + surge * 7.0);
    if (this.drift > 1e5) this.drift = 0; // (practically never) keep float precision
    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uDrift.value = this.drift;
    u.uSurge.value = surge;
    u.uPxScale.value = pxScale;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
