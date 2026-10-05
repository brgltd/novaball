/**
 * NOVABALL render-world — procedural deep-space sky, baked ONCE into a cube render target.
 *
 * Nebula: domain-warped 3D fbm clouds (purple / teal / magenta) concentrated along a tilted "galactic band"
 * with dark dust lanes. Stars: three cellular layers (dense dim dust, mid stars, a few bright stars with halos
 * and diffraction spikes), antialiased for the target cube resolution.
 */
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CubeCamera,
  Float32BufferAttribute,
  HalfFloatType,
  LessEqualDepth,
  LinearFilter,
  Matrix3,
  Mesh,
  RGBFormat,
  RGBAFormat,
  Scene,
  UnsignedInt101111Type,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { GLSL_HASH, GLSL_NOISE3 } from './glsl';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform float uPix;
uniform float uStarDensity;
varying vec3 vDir;
${GLSL_HASH}
${GLSL_NOISE3}

// Galactic band plane normal (band = great circle perpendicular to it).
const vec3 BAND_N = vec3(0.3558, 0.8134, -0.4601);

vec3 starColor(float t) {
  vec3 warm = vec3(1.0, 0.70, 0.46);
  vec3 white = vec3(1.0, 0.96, 0.92);
  vec3 blue = vec3(0.66, 0.78, 1.0);
  return t < 0.5 ? mix(warm, white, t * 2.0) : mix(white, blue, (t - 0.5) * 2.0);
}

// One cellular star layer. Every star is owned by the cell containing its projection on the sphere,
// and the 3x3x3 neighbourhood is searched so stars are never clipped at cell borders.
vec3 starLayer(vec3 d, float scale, float density, float minB, float maxB, float expo, float sizeMul, float band, float bandBoost, float fancy) {
  vec3 col = vec3(0.0);
  vec3 p = d * scale;
  vec3 ic = floor(p);
  float dens = density * uStarDensity * (1.0 + bandBoost * band);
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 c = ic + vec3(float(x), float(y), float(z));
    if (nbHash13(c + 0.37) > dens) continue;
    vec3 rnd = nbHash33(c + 17.17);
    vec3 sp = normalize(c + 0.1 + 0.8 * rnd);
    if (any(notEqual(floor(sp * scale), c))) continue;
    vec3 rnd2 = nbHash33(c + 91.3);
    float b = mix(minB, maxB, pow(rnd2.x, expo));
    float sigma = uPix * sizeMul * (0.75 + 0.5 * rnd2.y);
    vec3 dv = d - sp;
    float d2 = dot(dv, dv);
    float core = exp(-d2 / (2.0 * sigma * sigma));
    vec3 sc = starColor(rnd2.z);
    col += sc * b * core;
    if (fancy > 0.5) {
      float dist = sqrt(d2);
      col += sc * b * 0.035 * exp(-dist / (uPix * 7.0));
      if (b > maxB * 0.55) {
        vec3 e1 = normalize(cross(sp, vec3(0.0, 1.0, 0.0)));
        vec3 e2 = cross(e1, sp);
        vec2 l = vec2(dot(dv, e1), dot(dv, e2));
        float w = uPix * 0.8;
        float len = uPix * 26.0 * (b / maxB);
        float spikes = exp(-abs(l.x) / w) * exp(-abs(l.y) / len) + exp(-abs(l.y) / w) * exp(-abs(l.x) / len);
        col += sc * b * 0.12 * spikes;
      }
    }
  }
  return col;
}

vec3 nebula(vec3 d, out float band) {
  float gl = dot(d, BAND_N);
  band = exp(-gl * gl / 0.075);
  float bandWide = exp(-gl * gl / 0.4);
  vec3 p = d * 1.7;
  vec3 w = vec3(nbFbm3(p + vec3(3.1, 0.7, 5.3), 4), nbFbm3(p + vec3(8.4, 2.2, 1.9), 4), nbFbm3(p + vec3(1.3, 6.1, 7.7), 4));
  vec3 q = p + (w - 0.5) * 2.4;
  float n1 = nbFbm3(q * 1.25, 7);
  float n2 = nbFbm3(q * 2.6 + 11.0, 6);
  float n3 = nbFbm3(d * 4.2 + w * 1.8 + 3.0, 6);

  float dens = smoothstep(0.40, 0.82, n1);
  dens *= 0.18 + 0.82 * bandWide;

  vec3 purple = vec3(0.150, 0.040, 0.330);
  vec3 magenta = vec3(0.400, 0.040, 0.240);
  vec3 teal = vec3(0.015, 0.200, 0.280);
  vec3 blue = vec3(0.030, 0.060, 0.230);
  vec3 col = mix(blue, purple, smoothstep(0.30, 0.60, w.y));
  col = mix(col, teal, smoothstep(0.52, 0.78, w.x) * 0.9);
  col = mix(col, magenta, smoothstep(0.55, 0.85, n2) * smoothstep(0.42, 0.72, w.z));
  vec3 neb = col * dens * 1.15;

  // bright emission knots
  float knot = pow(smoothstep(0.64, 0.98, n1), 2.0);
  neb += mix(vec3(0.95, 0.42, 0.85), vec3(0.35, 0.80, 1.0), smoothstep(0.35, 0.65, w.x)) * knot * 0.42 * (0.35 + 0.65 * bandWide);

  // dark dust lanes along the band
  float lane = smoothstep(0.52, 0.70, n3) * band;
  neb *= 1.0 - 0.8 * lane;

  // unresolved starlight haze in the band
  neb += vec3(0.085, 0.075, 0.115) * band * (0.45 + 0.55 * n2) * (1.0 - 0.7 * lane);

  vec3 base = vec3(0.0035, 0.0045, 0.012) + vec3(0.006, 0.004, 0.014) * bandWide;
  return base + neb;
}

void main() {
  vec3 d = normalize(vDir);
  float band;
  vec3 col = nebula(d, band);
  // dim dust of stars
  col += starLayer(d, 150.0, 0.16, 0.02, 0.35, 5.0, 0.75, band, 2.0, 0.0);
  // mid stars
  col += starLayer(d, 52.0, 0.18, 0.12, 1.1, 6.0, 0.85, band, 1.0, 0.0);
  // a few bright stars with halos and (rare) spikes
  col += starLayer(d, 13.0, 0.10, 0.8, 5.5, 7.0, 1.0, band, 0.5, 1.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Bake the sky into a cube render target (HalfFloat, mipmapped). Call once at init. */
export function bakeSkyCube(renderer: WebGLRenderer, size: number, starDensity: number): WebGLCubeRenderTarget {
  // No mipmaps: in the main view the cube is magnified (face texel density < screen density); in the half-res
  // floor reflection the (dimmed) sky gets blurred by the floor's glossy sampling anyway. Halves the bandwidth.
  // Packed float R11G11B10 (4 B/texel) when renderable: half the bandwidth of RGBA16F, HDR preserved.
  const packed = renderer.extensions.has('EXT_color_buffer_float');
  const rt = new WebGLCubeRenderTarget(size, {
    type: packed ? UnsignedInt101111Type : HalfFloatType,
    format: packed ? RGBFormat : RGBAFormat,
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
  rt.texture.name = 'NovaSkyCube';
  const mat = new ShaderMaterial({
    name: 'NovaSkyBake',
    uniforms: {
      uPix: { value: 2 / size },
      uStarDensity: { value: starDensity },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const geo = new BoxGeometry(2, 2, 2);
  const mesh = new Mesh(geo, mat);
  const scene = new Scene();
  scene.add(mesh);
  const cam = new CubeCamera(0.1, 10, rt);
  const prevTarget = renderer.getRenderTarget();
  cam.update(renderer, scene);
  renderer.setRenderTarget(prevTarget);
  geo.dispose();
  mat.dispose();
  return rt;
}

const DOME_VERT = /* glsl */ `
uniform mat3 uRot;
varying vec3 vDir;
void main() {
  // full-screen triangle at the far plane; view ray from the (symmetric) projection + camera rotation
  vec3 viewDir = vec3(position.x / projectionMatrix[0][0], position.y / projectionMatrix[1][1], -1.0);
  vDir = uRot * (transpose(mat3(viewMatrix)) * viewDir);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
uniform samplerCube tSky;
uniform float uIntensity;
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(textureCube(tSky, vDir).rgb * uIntensity, 1.0);
}
`;

/**
 * Sky drawn as a far-plane full-screen triangle AFTER the opaque pass (renderOrder) with depthFunc LessEqual, so
 * early-z skips every pixel already covered by the arena/stadium (cheaper than scene.background, which shades
 * the whole screen first). Works for the planar reflection camera too (uses only the projection's x/y scale).
 */
export class SkyDome {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor() {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.material = new ShaderMaterial({
      name: 'NovaSkyDome',
      uniforms: {
        tSky: { value: null as Texture | null },
        uIntensity: { value: 1 },
        uRot: { value: new Matrix3() },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      depthTest: true,
      depthWrite: false,
    });
    this.material.depthFunc = LessEqualDepth;
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6; // last among opaques, before transparents
  }

  setTexture(t: Texture | null): void {
    this.material.uniforms.tSky.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
