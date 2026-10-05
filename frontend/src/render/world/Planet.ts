/**
 * NOVABALL render-world — the ringed gas giant, its atmosphere halo and the distant sun glow.
 *
 * Everything here lives "at infinity": the group is re-centered on the camera every frame so there is no
 * parallax. The planet albedo (turbulent bands + storm) is baked once into a texture; the ring density
 * profile is a small CPU-generated data texture. Shading is analytic: soft terminator, atmospheric rim,
 * ring shadow on the planet and planet shadow on the ring.
 */
import {
  AdditiveBlending,
  BackSide,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three';
import { LAYER_MAIN_ONLY } from '../../contracts';
import { GLSL_HASH, GLSL_NOISE3 } from './glsl';

/** Direction (from the viewer) of the planet center, radius and distance. */
export const PLANET_DIR = new Vector3(-0.3, 0.27, 1.0).normalize();
export const PLANET_DIST = 1500;
export const PLANET_RADIUS = 520;
/** Direction to the sun (world). */
export const SUN_DIR = new Vector3(0.9, 0.36, -0.22).normalize();

const RING_IN = 1.32;
const RING_OUT = 2.25;

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BAKE_FRAG = /* glsl */ `
varying vec2 vUv;
${GLSL_HASH}
${GLSL_NOISE3}
float angDiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }
void main() {
  float lat = (vUv.y - 0.5) * 3.14159265;
  float lon = vUv.x * 6.2831853;
  vec3 sp = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  float t = nbFbm3(sp * 2.6, 6);
  float t2 = nbFbm3(sp * vec3(7.0, 2.0, 7.0), 6);
  float y = sin(lat) + (t - 0.5) * 0.16 + (t2 - 0.5) * 0.06;
  float bands = y * 7.5 + (nbFbm3(vec3(y * 11.0, 1.3, 0.7), 4) - 0.5) * 3.0;
  float b1 = 0.5 + 0.5 * sin(bands * 3.1);
  float b2 = 0.5 + 0.5 * sin(bands * 1.37 + 1.2);
  float b3 = 0.5 + 0.5 * sin(bands * 5.3 + 0.4);
  vec3 cream = vec3(0.92, 0.83, 0.70);
  vec3 peach = vec3(0.86, 0.56, 0.38);
  vec3 rust = vec3(0.58, 0.26, 0.15);
  vec3 rose = vec3(0.66, 0.38, 0.44);
  vec3 brown = vec3(0.30, 0.17, 0.13);
  vec3 col = mix(cream, peach, b1);
  col = mix(col, rust, smoothstep(0.55, 0.95, b2) * 0.75);
  col = mix(col, rose, smoothstep(0.62, 0.92, t2) * 0.4);
  col = mix(col, brown, smoothstep(0.75, 1.0, b3) * 0.35);
  // fine flow streaks along the bands
  float streak = nbFbm3(vec3(y * 70.0, sp.x * 3.0, sp.z * 3.0), 5);
  col *= 0.8 + 0.4 * streak;
  // turbulent eddies at band edges
  float eddy = nbFbm3(sp * 14.0 + t * 3.0, 5);
  col = mix(col, cream * 1.05, smoothstep(0.62, 0.8, eddy) * 0.25 * smoothstep(0.3, 0.7, b1));
  // great storm
  vec2 so = vec2(angDiff(lon, 1.9) * cos(lat), lat + 0.36);
  float sd = length(so * vec2(0.55, 1.7));
  float swirl = nbFbm3(vec3(so * 30.0 + vec2(sin(sd * 40.0), cos(sd * 40.0)) * 0.6, 2.0), 4);
  vec3 storm = mix(vec3(0.78, 0.36, 0.20), vec3(0.95, 0.70, 0.52), swirl);
  col = mix(col, storm, smoothstep(0.17, 0.09, sd) * 0.9);
  col = mix(col, cream, smoothstep(0.02, 0.0, abs(sd - 0.18)) * 0.25);
  // polar haze
  col = mix(col, vec3(0.45, 0.38, 0.40), smoothstep(0.6, 0.97, abs(sin(lat))) * 0.6);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const PLANET_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLANET_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uRingTex;
uniform vec3 uSunDir;
uniform vec3 uRingN;
uniform vec3 uCenter;
uniform float uRingIn;
uniform float uRingOut;
uniform float uTime;
uniform float uSurge;
varying vec3 vN;
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 L = uSunDir;
  vec3 albedo = texture2D(uMap, vec2(vUv.x + uTime * 0.0012, vUv.y)).rgb;
  float ndl = dot(N, L);
  float diff = smoothstep(-0.18, 0.85, ndl);
  diff = diff * diff * (3.0 - 2.0 * diff);
  vec3 P = vWP - uCenter;
  float denom = dot(L, uRingN);
  float rs = 1.0;
  if (abs(denom) > 1e-3) {
    float t = -dot(P, uRingN) / denom;
    if (t > 0.0) {
      float r = length(P + L * t);
      float rr = (r - uRingIn) / (uRingOut - uRingIn);
      if (rr > 0.0 && rr < 1.0) rs = 1.0 - 0.8 * texture2D(uRingTex, vec2(rr, 0.5)).r;
    }
  }
  // kept below white (~0.75): high balls in VOLT's attacking half are framed against the planet and need contrast
  vec3 col = albedo * diff * rs * 0.75;
  col += albedo * vec3(0.01, 0.012, 0.028);
  float ndv = max(dot(N, V), 0.0);
  float litRim = smoothstep(-0.15, 0.55, ndl);
  vec3 atmo = mix(vec3(0.45, 0.75, 1.0), vec3(0.75, 0.45, 1.0), uSurge);
  col += atmo * pow(max(1.0 - ndv, 0.0), 3.5) * litRim * 0.9;
  col += vec3(1.0, 0.42, 0.22) * pow(max(1.0 - abs(ndl), 0.0), 10.0) * 0.12 * litRim;
  gl_FragColor = vec4(col, 1.0);
}
`;

const HALO_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uSurge;
varying vec3 vN;
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWP - ro);
  vec3 oc = uCenter - ro;
  float tc = dot(oc, rd);
  vec3 closest = ro + rd * tc - uCenter;
  float h = length(closest);
  float x = max(h - uRadius, 0.0) / (uRadius * 0.05);
  float glow = exp(-x * 1.6) * 0.9 + exp(-x * 0.35) * 0.12;
  glow *= smoothstep(uRadius * 1.25, uRadius * 1.12, h);
  vec3 dirN = closest / max(h, 1e-3);
  float lit = smoothstep(-0.45, 0.6, dot(dirN, uSunDir));
  vec3 atmo = mix(vec3(0.42, 0.72, 1.0), vec3(0.72, 0.42, 1.0), uSurge);
  gl_FragColor = vec4(atmo * glow * lit * 1.2, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform sampler2D uRingTex;
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform vec3 uRingN;
uniform float uRingIn;
uniform float uRingOut;
uniform float uPlanetR;
varying vec3 vN;
varying vec3 vWP;
varying vec2 vUv;
void main() {
  vec3 P = vWP - uCenter;
  float r = length(P);
  float rr = (r - uRingIn) / (uRingOut - uRingIn);
  if (rr <= 0.0 || rr >= 1.0) discard;
  vec4 tex = texture2D(uRingTex, vec2(rr, 0.5));
  float dens = tex.r;
  vec3 L = uSunDir;
  float b = dot(P, L);
  float c = dot(P, P) - uPlanetR * uPlanetR;
  float disc = b * b - c;
  float sh = 1.0;
  if (b < 0.0 && disc > 0.0) sh = 1.0 - smoothstep(0.0, uPlanetR * 0.06, sqrt(disc));
  vec3 V = normalize(cameraPosition - vWP);
  float sideL = dot(uRingN, L);
  float sideV = dot(uRingN, V);
  float litSide = sideL * sideV > 0.0 ? 1.0 : 0.35 + 0.4 * (1.0 - dens);
  float fwd = pow(max(dot(-V, L), 0.0), 8.0);
  vec3 ringCol = mix(vec3(0.80, 0.71, 0.60), vec3(0.58, 0.52, 0.56), tex.g);
  vec3 col = ringCol * (0.62 + 1.6 * fwd) * sh * litSide * 1.05;
  gl_FragColor = vec4(col, dens * 0.92);
}
`;

const SUN_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

const SUN_FRAG = /* glsl */ `
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float core = exp(-r * r / 0.00035) * 40.0;
  float glow = exp(-r / 0.035) * 3.0 + exp(-r / 0.16) * 0.35 + exp(-r / 0.45) * 0.05;
  float streak = exp(-abs(vUv.y) / 0.006) * exp(-abs(vUv.x) / 0.55) * 1.2;
  float fade = smoothstep(1.0, 0.7, r);
  vec3 col = vec3(1.0, 0.95, 0.86) * core + vec3(1.0, 0.74, 0.48) * glow + vec3(0.62, 0.78, 1.0) * streak;
  gl_FragColor = vec4(col * fade * uIntensity, 1.0);
}
`;

function makeRingTexture(): DataTexture {
  const n = 1024;
  const data = new Uint8Array(n * 4);
  // deterministic pseudo-random
  let s = 1234567;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const noise = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) noise[i] = rnd();
  const smooth = (x: number, scale: number) => {
    const p = x * scale;
    const i = Math.floor(p);
    const f = p - i;
    const a = noise[i % n];
    const b = noise[(i + 1) % n];
    return a + (b - a) * (f * f * (3 - 2 * f));
  };
  for (let i = 0; i < n; i++) {
    const r = i / (n - 1);
    const edge = Math.min(1, r / 0.04) * Math.min(1, (1 - r) / 0.05);
    let d = 0.55 + 0.25 * smooth(r, 40) + 0.2 * smooth(r, 160) + 0.12 * Math.sin(r * 210);
    if (r < 0.22) d *= 0.35; // faint inner ring
    const gap = (c: number, w: number, depth: number) => {
      const x = Math.abs(r - c) / w;
      if (x < 1) d *= 1 - depth * (1 - x * x);
    };
    gap(0.6, 0.035, 0.92); // big division
    gap(0.86, 0.008, 0.8);
    gap(0.33, 0.012, 0.5);
    gap(0.74, 0.006, 0.6);
    d = Math.max(0, Math.min(1, d * edge));
    const v = smooth(r, 25);
    data[i * 4] = Math.round(d * 255);
    data[i * 4 + 1] = Math.round(v * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, n, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export class Planet {
  readonly group = new Group();
  private readonly planetMesh: Mesh;
  private readonly haloMesh: Mesh;
  private readonly ringMesh: Mesh;
  private readonly sunMesh: Mesh;
  private readonly planetMat: ShaderMaterial;
  private readonly haloMat: ShaderMaterial;
  private readonly ringMat: ShaderMaterial;
  private readonly sunMat: ShaderMaterial;
  private readonly ringTex: DataTexture;
  private mapRT: WebGLRenderTarget | null = null;
  private readonly center = new Vector3();
  private readonly ringN = new Vector3();

  constructor() {
    this.group.name = 'Planet';
    this.ringTex = makeRingTexture();
    const R = PLANET_RADIUS;
    // ring plane normal (tilted so the ring opens toward the arena)
    this.ringN.set(0.28, 1.0, -0.55).normalize();

    const common = {
      uSunDir: { value: SUN_DIR.clone() },
      uCenter: { value: this.center },
      uRingN: { value: this.ringN },
      uRingIn: { value: R * RING_IN },
      uRingOut: { value: R * RING_OUT },
      uRingTex: { value: this.ringTex },
      uSurge: { value: 0 },
    };

    this.planetMat = new ShaderMaterial({
      name: 'NovaPlanet',
      uniforms: { ...common, uMap: { value: null }, uTime: { value: 0 } },
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      depthWrite: true,
    });
    const sphere = new SphereGeometry(R, 128, 72);
    this.planetMesh = new Mesh(sphere, this.planetMat);
    this.planetMesh.frustumCulled = false;
    // rotate so the planet's pole is tilted like the ring
    this.planetMesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), this.ringN);

    this.haloMat = new ShaderMaterial({
      name: 'NovaPlanetHalo',
      uniforms: { ...common, uRadius: { value: R } },
      vertexShader: PLANET_VERT,
      fragmentShader: HALO_FRAG,
      side: BackSide,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.haloMesh = new Mesh(new SphereGeometry(R * 1.26, 64, 40), this.haloMat);
    this.haloMesh.frustumCulled = false;
    this.haloMesh.renderOrder = -1;

    this.ringMat = new ShaderMaterial({
      name: 'NovaPlanetRing',
      uniforms: { ...common, uPlanetR: { value: R } },
      vertexShader: PLANET_VERT,
      fragmentShader: RING_FRAG,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    const ringGeo = new RingGeometry(R * RING_IN, R * RING_OUT, 192, 1);
    ringGeo.rotateX(-Math.PI / 2); // XZ plane, normal +Y
    this.ringMesh = new Mesh(ringGeo, this.ringMat);
    this.ringMesh.quaternion.copy(this.planetMesh.quaternion);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = -2;

    this.sunMat = new ShaderMaterial({
      name: 'NovaSun',
      uniforms: { uSize: { value: 720 }, uIntensity: { value: 1 } },
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.sunMesh = new Mesh(new PlaneGeometry(1, 1), this.sunMat);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = -3;

    this.group.add(this.sunMesh, this.planetMesh, this.haloMesh, this.ringMesh);
    // sky objects are not mirrored by the floor (it should reflect the arena's own lights, not the heavens)
    for (const m of [this.sunMesh, this.planetMesh, this.haloMesh, this.ringMesh]) m.layers.set(LAYER_MAIN_ONLY);
  }

  /** Bake the planet albedo texture (once). */
  bake(renderer: WebGLRenderer, width: number): void {
    const h = width / 2;
    const rt = new WebGLRenderTarget(width, h, {
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
    });
    rt.texture.name = 'NovaPlanetAlbedo';
    const mat = new ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false });
    const quad = new Mesh(new PlaneGeometry(2, 2), mat);
    const scene = new Scene();
    scene.add(quad);
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    quad.geometry.dispose();
    mat.dispose();
    this.mapRT?.dispose();
    this.mapRT = rt;
    this.planetMat.uniforms.uMap.value = rt.texture;
  }

  /** Drop the baked albedo target without disposing it (after a WebGL context loss its GL objects are gone). */
  forgetBake(): void {
    this.mapRT = null;
  }

  /** Keep the sky objects at infinity (camera-centered). */
  update(time: number, camera: Camera, surge: number): void {
    const cp = camera.position;
    this.center.copy(PLANET_DIR).multiplyScalar(PLANET_DIST).add(cp);
    this.planetMesh.position.copy(this.center);
    this.haloMesh.position.copy(this.center);
    this.ringMesh.position.copy(this.center);
    this.sunMesh.position.copy(SUN_DIR).multiplyScalar(1900).add(cp);
    this.planetMat.uniforms.uTime.value = time;
    this.planetMat.uniforms.uSurge.value = surge;
    this.haloMat.uniforms.uSurge.value = surge;
  }

  dispose(): void {
    this.planetMesh.geometry.dispose();
    this.haloMesh.geometry.dispose();
    this.ringMesh.geometry.dispose();
    this.sunMesh.geometry.dispose();
    this.planetMat.dispose();
    this.haloMat.dispose();
    this.ringMat.dispose();
    this.sunMat.dispose();
    this.ringTex.dispose();
    this.mapRT?.dispose();
  }
}
