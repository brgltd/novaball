/**
 * NOVABALL render-world — force-field walls and ceiling.
 * Additive, depth-tested, no depth write. Fresnel-lit hexagonal energy mesh with scanline shimmer, bright seams
 * along the floor contact line / fillets / ceiling edge, per-cell sparkle, proximity glow near cars and the ball,
 * and impact ripples. The goal mouths are cut per pixel with the exact goal-box SDF. End walls are tinted by the
 * defending team; the whole field turns violet during a ZERO-G SURGE (the ends keep part of their team tint).
 * Quality: NB_FF_DETAIL 2 (full) / 1 (no sparkle / scan sweep) / 0 (lines + seams + ripples + pools only) /
 * -1 (no hex mesh: a smooth energy sheet with seams, ripples and pools).
 */
import { AdditiveBlending, DoubleSide, Mesh, ShaderMaterial } from 'three';
import { buildForceFieldGeometry, CORE_HX, CORE_HZ, CORE_R } from './ArenaGeometry';
import { GLSL_ARENA_UNIFORMS, type ArenaUniforms } from './ArenaUniforms';
import { GLSL_ARENA, GLSL_HASH, GLSL_HEX } from './glsl';

const VERT = /* glsl */ `
attribute vec2 aHex;
varying vec3 vWP;
varying vec3 vN;
varying vec2 vHex;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vHex = aHex;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_HEX}
${GLSL_ARENA}
${GLSL_ARENA_UNIFORMS}
uniform float uIntensity;
varying vec3 vWP;
varying vec3 vN;
varying vec2 vHex;

void main() {
  // goal mouths: the wall does not exist inside the goal box free space
  if (abs(vWP.z) > NB_L - NB_RE - 1.5 && nbGoalFree(vWP) > 0.0) discard;

  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = abs(dot(N, V));
  float fres = pow(max(1.0 - ndv, 0.0), 2.2);

  // hex energy mesh (detail -1: no mesh, a smooth energy sheet at the mesh's average line coverage)
#if NB_FF_DETAIL >= 0
  vec2 hp = vHex / 1.9;
  vec4 hx = nbHex(hp);
  float fw = length(fwidth(hp));
  float lineW = 0.03;
  float line = 1.0 - smoothstep(lineW, lineW + fw * 1.25, hx.z);
  line *= 1.0 - smoothstep(0.12, 0.45, fw);
  float lineAvg = smoothstep(0.12, 0.45, fw) * 0.12; // average coverage once lines are sub-pixel
  line += lineAvg;
#else
  const vec4 hx = vec4(0.0, 0.0, 0.25, 0.5);
  const float line = 0.12;
#endif
  // NB_FF_DETAIL (quality): 2 = full, 1 = no sparkle / scan sweep, 0 = lines + seams + ripples + pools only
#if NB_FF_DETAIL >= 2
  float cell = hx.w;
  float sparkle = pow(max(0.5 + 0.5 * sin(uTime * (0.5 + cell * 1.7) + cell * 61.0), 0.0), 14.0) * step(0.55, cell);
  // scan bands
  float sweep = fract(vWP.y * 0.045 - uTime * 0.11);
  float scan = smoothstep(0.0, 0.04, sweep) * smoothstep(0.12, 0.04, sweep);
#else
  const float sparkle = 0.0;
  const float scan = 0.0;
#endif
#if NB_FF_DETAIL >= 1
  float innerGlow = smoothstep(0.5, 0.0, hx.z) * 0.15;
  float micro = 0.8 + 0.2 * sin(vWP.y * 22.0 - uTime * 5.0);
#else
  const float innerGlow = 0.0;
  const float micro = 0.9;
#endif

  // seams: floor contact line, fillet ends, ceiling edge (analytic, from the core footprint distance)
  float dCore = nbRoundRect(vWP.xz, vec2(${CORE_HX.toFixed(1)}, ${CORE_HZ.toFixed(1)}), ${CORE_R.toFixed(1)});
  float seam = 0.0;
  seam += exp(-vWP.y / 0.08) * 1.6;                              // floor contact line
  seam += exp(-abs(vWP.y - NB_RE) / 0.25) * 0.35 * step(0.0, dCore); // lower fillet top
  seam += exp(-abs(vWP.y - (NB_H - NB_RE)) / 0.25) * 0.25 * step(0.0, dCore);
  seam += exp(-abs(dCore) / 0.3) * step(NB_H - 0.01, vWP.y) * 0.8;   // ceiling edge
  float lowBand = (1.0 - smoothstep(0.0, NB_RE, vWP.y)) * step(0.0, dCore);

  // color: base field color, tinted by the defending team toward each end, violet in surges
  float endT = smoothstep(NB_L * 0.6, NB_L * 0.98, abs(vWP.z));
  vec3 teamCol = vWP.z < 0.0 ? uTeam0 : uTeam1;
  vec3 base = mix(uFieldColor, teamCol, endT * 0.7);
  // surge: the field turns violet, but the ends keep part of the defending team's tint (goals stay readable)
  base = mix(base, uSurgeColor * 1.2, uSurge * (1.0 - 0.5 * endT));
  float gFlash = vWP.z < 0.0 ? uGoalFlash.x : uGoalFlash.y;
  base = mix(base, uFlashColor, gFlash * endT);

  float ceilingDim = mix(1.0, 0.65, smoothstep(NB_H - NB_RE, NB_H, vWP.y));
  // lines strongest along the lower wall (boundary readability) and near the ceiling edge, faint mid-wall
  float hBand = 1.0 - smoothstep(NB_RE, NB_RE + 7.0, vWP.y) * (1.0 - smoothstep(NB_H - NB_RE - 3.0, NB_H - NB_RE, vWP.y)) * 0.65;
  float I = 0.005 + 0.035 * fres;
  I += line * (0.02 + 0.2 * fres) * micro * hBand;
  I += innerGlow * fres * 0.4;
  I += sparkle * 0.1 * (0.25 + fres);
  I += scan * (0.02 + 0.06 * fres);
  I += lowBand * (0.03 + 0.05 * line);
  I *= ceilingDim * (1.0 + uSurge * 0.6 + gFlash * endT * 1.5);
  vec3 col = base * (I + seam * 0.5);

  // proximity: cars / ball light up the mesh nearby (only sources close to the force field are evaluated)
  vec3 prox = nbWallPools(vWP);
  col += prox * (0.06 + line * 1.1 + innerGlow);
  // impact ripples
  vec3 rip = nbRipples(vWP);
  col += rip * (0.25 + line * 2.2 + innerGlow * 2.0);

  // soften exactly at the floor tangency (the floor plate is right there)
  col *= smoothstep(0.0, 0.02, vWP.y + 0.005) * 0.85 + 0.15;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

/** Cheap variant used only inside the planar floor reflection (seams + fresnel glow, no hex/ripples/pools). */
const FRAG_CHEAP = /* glsl */ `
${GLSL_ARENA}
${GLSL_ARENA_UNIFORMS}
uniform float uIntensity;
varying vec3 vWP;
varying vec3 vN;
varying vec2 vHex;
void main() {
  if (abs(vWP.z) > NB_L - NB_RE - 1.5 && nbGoalFree(vWP) > 0.0) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  float fres = pow(max(1.0 - abs(dot(N, V)), 0.0), 2.2);
  float endT = smoothstep(NB_L * 0.6, NB_L * 0.98, abs(vWP.z));
  vec3 teamCol = vWP.z < 0.0 ? uTeam0 : uTeam1;
  vec3 base = mix(uFieldColor, teamCol, endT * 0.7);
  base = mix(base, uSurgeColor * 1.2, uSurge * (1.0 - 0.5 * endT));
  float seam = exp(-vWP.y / 0.08) * 1.6 + exp(-abs(vWP.y - NB_RE) / 0.25) * 0.3;
  float lowBand = 1.0 - smoothstep(0.0, NB_RE, vWP.y);
  float I = 0.006 + 0.05 * fres + lowBand * 0.04;
  gl_FragColor = vec4(base * (I + seam * 0.5) * uIntensity, 1.0);
}
`;

export class ForceField {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  /** Swap in during the floor reflection render. */
  readonly reflectionMaterial: ShaderMaterial;

  constructor(uniforms: ArenaUniforms, detail: -1 | 0 | 1 | 2 = 2) {
    const geo = buildForceFieldGeometry();
    this.material = new ShaderMaterial({
      name: 'NovaForceField',
      defines: { NB_FF_DETAIL: detail },
      uniforms: { ...uniforms, uIntensity: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.reflectionMaterial = new ShaderMaterial({
      name: 'NovaForceFieldCheap',
      uniforms: this.material.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG_CHEAP,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'ForceField';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Shader detail level (quality preset); recompiles the main material when it changes. */
  setDetail(detail: -1 | 0 | 1 | 2): void {
    const d = this.material.defines as { NB_FF_DETAIL: number };
    if (d.NB_FF_DETAIL === detail) return;
    d.NB_FF_DETAIL = detail;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.reflectionMaterial.dispose();
  }
}
