/**
 * Car materials:
 *  - Body: MeshPhysicalMaterial patched so base color / roughness / metalness / clearcoat come from per-vertex
 *    attributes (aBase, aMat) => paint, carbon, dark metal, chrome and glass all render in ONE draw call and share
 *    one GPU program across every car. Adds a fresnel rim term (uRim) for the supersonic shimmer.
 *  - Glow: unlit HDR emissive trims (team strips, hover pads, thruster rings, tail/head lights) with per-vertex
 *    animation groups (chase lights, brake lights, boost intensity).
 *  - FX: additive plasma plumes (twin thrusters) + hover-pad light cones in one draw call.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshPhysicalMaterial,
  ShaderChunk,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { GLSL_HASH } from './glsl';

export interface BodyMaterialHandle {
  material: MeshPhysicalMaterial;
  /** Fresnel rim emission color (linear HDR). Zero = off. */
  rim: { value: Color };
}

export function createCarBodyMaterial(paint: Color): BodyMaterialHandle {
  const rim = { value: new Color(0, 0, 0) };
  const material = new MeshPhysicalMaterial({
    color: paint,
    roughness: 0.3,
    metalness: 0.6,
    clearcoat: 1,
    clearcoatRoughness: 0.045,
    envMapIntensity: 1.0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = rim;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aBase;\nattribute vec4 aMat;\nvarying vec3 vBase;\nvarying vec4 vMat;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBase = aBase;\nvMat = aMat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBase;\nvarying vec4 vMat;\nuniform vec3 uRim;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( vBase, diffuse, vMat.x ), opacity );')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.z;')
      .replace(
        '#include <lights_physical_fragment>',
        ShaderChunk.lights_physical_fragment.replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * vMat.w;'),
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n{ float nbNv = saturate( dot( normal, normalize( vViewPosition ) ) ); float nbF = 1.0 - nbNv; totalEmissiveRadiance += uRim * ( nbF * nbF * nbF ) * vMat.x; }',
      );
  };
  material.customProgramCacheKey = () => 'novaball-car-body-v1';
  return { material, rim };
}

export interface GlowUniforms {
  [k: string]: { value: unknown };
  uTeam: { value: Color };
  uTime: { value: number };
  uBoost: { value: number };
  uBrake: { value: number };
  uPad: { value: number };
  uChase: { value: number };
  uIntensity: { value: number };
}

export function createCarGlowMaterial(team: Color): ShaderMaterial & { uniforms: GlowUniforms } {
  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uTeam: { value: new Color() },
      uTime: { value: 0 },
      uBoost: { value: 0 },
      uBrake: { value: 0 },
      uPad: { value: 0 },
      uChase: { value: 0 },
      uIntensity: { value: 1 },
    },
  ]) as GlowUniforms;
  uniforms.uTeam.value.copy(team);
  const mat = new ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aGlow;
      attribute float aT;
      uniform vec3 uTeam;
      uniform float uTime, uBoost, uBrake, uPad, uChase, uIntensity;
      varying vec3 vCol;
      void main() {
        vec3 base = uTeam * aGlow.x + vec3(1.0, 0.97, 0.93) * aGlow.y + vec3(1.0, 0.035, 0.09) * aGlow.z;
        float g = aGlow.w;
        float I = 1.0;
        if (g > 0.5 && g < 1.5) I = 0.8 + 0.55 * uPad;                     // hover pads
        else if (g > 1.5 && g < 2.5) I = 0.28 + 1.3 * uBoost;              // thruster rings / cores (dim at idle)
        else if (g > 2.5 && g < 3.5) I = 0.75 + 1.9 * uBrake;              // tail lights
        else if (g > 4.5) {                                                // chase strips
          float ph = fract(aT * 1.35 - uChase);
          I = 0.5 + 1.9 * pow(max(1.0 - ph, 0.0), 7.0) + 0.6 * uBoost;
        }
        vCol = base * I * uIntensity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vCol;
      void main() {
        gl_FragColor = vec4(vCol, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  return mat as ShaderMaterial & { uniforms: GlowUniforms };
}

export interface FxUniforms {
  [k: string]: { value: unknown };
  uTeam: { value: Color };
  uTime: { value: number };
  uBoost: { value: number };
  uPlumeLen: { value: number };
  uPlumeWidth: { value: number };
  uPlumeGain: { value: number };
  uPad: { value: number };
  uGround: { value: number };
  uSeed: { value: number };
}

/**
 * FX kinds in aFx.x: 0 = plume volume (analytic: brightness from the distance between the view ray and the plume
 * axis, so it reads correctly end-on from the chase camera), 2 = hover-pad shimmer cone, 3 = surface contact glow.
 * aFx.w = plume base radius (kind 0).
 */
export function createCarFxMaterial(team: Color): ShaderMaterial & { uniforms: FxUniforms } {
  const uniforms: FxUniforms = {
    uTeam: { value: new Color().copy(team) },
    uTime: { value: 0 },
    uBoost: { value: 0 },
    uPlumeLen: { value: 0.2 },
    uPlumeWidth: { value: 0.8 },
    uPlumeGain: { value: 1 },
    uPad: { value: 1 },
    uGround: { value: 1 },
    uSeed: { value: 0 },
  };
  const mat = new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aFx;     // kind, t (0 at source .. 1 at tip) or quad u, ring angle or quad v, plume radius
      attribute vec3 aOrigin; // nozzle exit / pad center (car local)
      attribute vec3 aRad;    // radial direction (car local), used as the normal
      uniform float uPlumeLen, uPlumeWidth;
      varying vec3 vN;
      varying vec3 vV;
      varying vec4 vFx;
      varying vec3 vO;
      varying vec3 vD;
      void main() {
        vec3 p = position;
        if (aFx.x < 1.5) {
          // plume geometry is built at unit length along -Z: rescale length / width around the nozzle
          vec3 off = position - aOrigin;
          p = aOrigin + vec3(off.xy * uPlumeWidth, off.z * uPlumeLen);
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * aRad);
        vV = -mv.xyz;
        vFx = aFx;
        vO = (modelViewMatrix * vec4(aOrigin, 1.0)).xyz;
        vD = normalize((modelViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_HASH}
      uniform vec3 uTeam;
      uniform float uTime, uBoost, uPlumeLen, uPlumeWidth, uPlumeGain, uPad, uGround, uSeed;
      varying vec3 vN;
      varying vec3 vV;
      varying vec4 vFx;
      varying vec3 vO;
      varying vec3 vD;
      void main() {
        vec3 col;
        float a;
        if (vFx.x < 1.5) {
          // one layer only (back faces) so every covered pixel is shaded exactly once
          if (gl_FrontFacing) discard;
          vec3 rd = normalize(-vV);
          // closest approach between the view ray (from the eye) and the plume axis, clamped to the plume
          float b = dot(rd, vD);
          float dd = dot(rd, -vO);
          float e = dot(vD, -vO);
          float den = max(1.0 - b * b, 1e-4);
          // lines P(s) = s*rd and Q(t) = O + t*D, w0 = -O: t = (e - b*d) / (1 - b^2)
          float tc = clamp((e - b * dd) / den, 0.0, uPlumeLen);
          vec3 q = vO + vD * tc;
          float dist = length(q - rd * dot(q, rd));
          float t = tc / max(uPlumeLen, 1e-3);
          float R = vFx.w * uPlumeWidth * (1.0 + 0.45 * sin(3.14159 * min(1.0, t * 1.4)) * (1.0 - t)) * pow(max(1.0 - t, 0.0), 0.6) + 1e-3;
          float r2 = (dist * dist) / (R * R);
          // (no atan here: atan(0,0) is undefined in GLSL and a single NaN pixel smears through the bloom chain)
          float n = nb_vnoise(vec2(sqrt(r2) * 2.2 + uSeed, t * 5.0 - uTime * 24.0));
          float n2 = nb_vnoise(vec2(uSeed * 2.0 + t * 13.0 - uTime * 39.0, 3.7));
          float diamonds = 0.72 + 0.28 * cos(t * 30.0);
          float outer = exp(-r2 * 2.6) * pow(max(1.0 - t, 0.0), 1.25) * (0.55 + 0.3 * n + 0.15 * n2);
          float core = exp(-r2 * 11.0) * pow(max(1.0 - t, 0.0), 2.4) * mix(1.0, diamonds, uBoost);
          // looking straight into the exhaust (chase cam) stacks the whole core: tone it down
          core *= mix(1.0, 0.4, smoothstep(0.75, 1.0, abs(b)));
          vec3 hot = vec3(1.0, 0.98, 0.95);
          col = uTeam * outer * mix(1.1, 3.2, uBoost) + mix(hot, uTeam * 0.7 + 0.3, t) * core * mix(1.2, 4.2, uBoost);
          col *= uPlumeGain;
          a = 1.0;
        } else if (vFx.x < 2.5) {
          // hover-pad light cone toward the surface: short soft shimmering haze
          float t = vFx.y;
          float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
          float rings = 0.8 + 0.2 * sin(t * 14.0 - uTime * 9.0 + uSeed);
          float n = nb_vnoise(vec2(vFx.z * 9.0 + uSeed, t * 3.0 - uTime * 4.0));
          a = pow(ndv, 1.8) * pow(clamp(1.0 - t, 0.0, 1.0), 3.2) * rings * (0.55 + 0.45 * n) * uPad * uGround * 0.55;
          col = uTeam * 1.2 + vec3(0.05);
        } else {
          // contact glow on the surface under the pad
          float d = length(vec2(vFx.y, vFx.z));
          float flick = 0.85 + 0.15 * sin(uTime * 13.0 + uSeed);
          a = exp(-d * d * 5.0) * (1.0 - smoothstep(0.75, 1.0, d)) * uGround * (0.6 + 0.4 * uPad) * flick * 0.7;
          col = uTeam * 1.5 + vec3(0.04);
        }
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
  });
  return mat as ShaderMaterial & { uniforms: FxUniforms };
}
