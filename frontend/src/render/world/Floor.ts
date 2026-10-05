/**
 * NOVABALL render-world — the mirror-dark floor.
 *
 * MeshStandardMaterial (so shadows, the key light, the hemisphere fill and the ball's point light all work)
 * patched with onBeforeCompile:
 *  - planar reflection injected as the specular IBL radiance (weighted by three's DFG => proper fresnel),
 *    roughness blur via textureLod, micro hex-panel grooves perturbing it, dimmed under shadows for readability;
 *  - analytic emissive field markings (boundary, midline, center circle + NOVABALL emblem, goal boxes/arcs,
 *    kickoff spots), team-tinted halves, glowing goal lines;
 *  - colored light pools under cars / ball and impact ripples.
 */
import {
  AddOperation,
  CanvasTexture,
  Color,
  LinearMipmapLinearFilter,
  Mesh,
  MeshPhongMaterial,
  PlaneGeometry,
  ShaderChunk,
  SRGBColorSpace,
  Texture,
  type Matrix4,
} from 'three';
import { ARENA, KICKOFF_SPOTS } from '../../sim/constants';
import { ARENA_THEME } from '../../theme';
import { GLSL_ARENA_UNIFORMS, type ArenaUniforms } from './ArenaUniforms';
import { GLSL_ARENA, GLSL_HASH, GLSL_HEX, GLSL_NOISE2 } from './glsl';

const EMBLEM_SIZE = 17;

let fontsReady: Promise<void> | null = null;
/**
 * Wait for the display font used by the canvas textures (resolves even on failure / after a 2.5 s timeout).
 * The @font-face rules come from the UI's static '@fontsource/orbitron' imports (the sandbox imports them itself);
 * importing them here too only produced INEFFECTIVE_DYNAMIC_IMPORT build warnings.
 */
export function ensureDisplayFont(): Promise<void> {
  if (fontsReady) return fontsReady;
  fontsReady = (async () => {
    try {
      if (typeof document === 'undefined' || !document.fonts) return;
      await Promise.race([
        Promise.all([document.fonts.load('900 64px Orbitron'), document.fonts.load('700 64px Orbitron')]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch {
      /* fall back to system fonts */
    }
  })();
  return fontsReady;
}

export const DISPLAY_FONT = 'Orbitron, "Arial Black", "Segoe UI", sans-serif';

function drawEmblem(c: HTMLCanvasElement): void {
  const S = c.width;
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  g.scale(S / 1024, S / 1024);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  // outer rings
  g.lineWidth = 5;
  g.globalAlpha = 0.55;
  g.beginPath();
  g.arc(0, 0, 470, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.globalAlpha = 0.35;
  g.beginPath();
  g.arc(0, 0, 440, 0, Math.PI * 2);
  g.stroke();
  // tick marks
  g.globalAlpha = 0.45;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r0 = i % 6 === 0 ? 400 : 418;
    g.lineWidth = i % 6 === 0 ? 5 : 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * 432, Math.sin(a) * 432);
    g.stroke();
  }
  // hexagon mark
  g.globalAlpha = 0.9;
  g.lineWidth = 9;
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * 150;
    const y = Math.sin(a) * 150 - 175;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  // four-point star core
  g.beginPath();
  const cy = -175;
  const sr = 92;
  const ir = 22;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? sr : ir;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r + cy;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  // wordmark
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 138px ${DISPLAY_FONT}`;
  g.fillText('NOVABALL', 0, 70);
  g.globalAlpha = 0.7;
  g.font = `700 40px ${DISPLAY_FONT}`;
  g.fillText('ORBITAL  LEAGUE', 0, 190);
  g.globalAlpha = 0.5;
  g.fillRect(-300, 128, 600, 4);
  g.globalAlpha = 1;
}

function makeEmblemTexture(anisotropy: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  drawEmblem(c);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

export interface FloorOptions {
  uniforms: ArenaUniforms;
  anisotropy: number;
}

export class Floor {
  readonly mesh: Mesh;
  readonly material: MeshPhongMaterial;
  private readonly emblem: CanvasTexture;
  readonly local = {
    tRefl: { value: null as Texture | null },
    tReflBlur: { value: null as Texture | null },
    uReflMatrix: { value: null as Matrix4 | null },
    uReflBoost: { value: 2.2 },
    uReflSharp: { value: 0.35 },
    uReflOn: { value: 1 },
    tEmblem: { value: null as Texture | null },
    uLineColor: { value: new Color(ARENA_THEME.fieldLines) },
  };

  constructor(opts: FloorOptions) {
    this.emblem = makeEmblemTexture(opts.anisotropy);
    this.local.tEmblem.value = this.emblem;
    // kickoff spot markers: folded to the (|x|, |z|) quadrant (the layout is point/mirror symmetric)
    const spots: string[] = [];
    const seen = new Set<string>();
    for (const s of KICKOFF_SPOTS) {
      const key = `${Math.abs(s.x)},${Math.abs(s.z)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spots.push(`vec2(${Math.abs(s.x).toFixed(2)}, ${Math.abs(s.z).toFixed(2)})`);
    }

    const hx = ARENA.halfWidth + 13;
    const hz = ARENA.halfLength + 13;
    const geo = new PlaneGeometry(hx * 2, hz * 2, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // Blinn-Phong base (cheap on iGPUs): the look comes from the planar reflection + emissive work below; the
    // key light and the ball's point light still add glossy highlights and shadows are received.
    this.material = new MeshPhongMaterial({
      color: new Color(ARENA_THEME.floorBase),
      specular: new Color(0.16, 0.18, 0.22),
      shininess: 70,
      combine: AddOperation,
      reflectivity: 0.12,
    });
    this.material.name = 'NovaFloor';
    this.material.defines = { NB_PLANAR: '' };
    const shared = opts.uniforms;
    const local = this.local;
    this.material.customProgramCacheKey = () => 'nova-floor-v2';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared, local);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform mat4 uReflMatrix;
varying vec4 vReflCoord;
varying vec3 vFloorWP;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
{
  vec4 fwp = modelMatrix * vec4(transformed, 1.0);
  vFloorWP = fwp.xyz;
  vReflCoord = uReflMatrix * fwp;
}`,
        );
      // capture the directional shadow term into nbShadow
      const lfb = ShaderChunk.lights_fragment_begin;
      const shadowLine =
        'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
      let patched = lfb;
      if (lfb.includes(shadowLine)) {
        patched = lfb.replace(
          shadowLine,
          `{ float nbSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
  nbShadow = min(nbShadow, nbSh); directLight.color *= nbSh; }`,
        );
      } else {
        console.warn('[Floor] shadow capture patch not applied (three.js chunk changed)');
      }
      // With the planar reflection active the PMREM IBL is replaced: skip its (costly) sampling entirely.
      shader.fragmentShader =
        '#ifdef NB_PLANAR\n#undef USE_ENVMAP\n#endif\n' +
        shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_HEX}
${GLSL_ARENA}
${GLSL_ARENA_UNIFORMS}
uniform sampler2D tRefl;
uniform sampler2D tReflBlur;
uniform sampler2D tEmblem;
uniform float uReflBoost;
uniform float uReflSharp;
uniform float uReflOn;
uniform vec3 uLineColor;
varying vec4 vReflCoord;
varying vec3 vFloorWP;

float nbBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}`,
          )
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
vec2 fp = vFloorWP.xz;
vec2 ap = abs(fp);
float az = ap.y;
// regions: flat field (inside the fillet tangency), goal floor, outside deck
float dField = nbRoundRect(fp, vec2(NB_W - NB_RE, NB_L - NB_RE), NB_RC - NB_RE);
float inGoal = step(ap.x, NB_G - NB_RG) * step(NB_L - NB_RE, az) * step(az, NB_L + NB_GD - NB_RG);
float inField = max(step(dField, 0.0), inGoal);
float teamSide = step(0.0, fp.y); // 0 = VOLT half (-Z), 1 = BLAZE half (+Z)
vec3 teamCol = mix(uTeam0, uTeam1, teamSide);
float endT = smoothstep(6.0, NB_L - NB_RE, az);
// one derivative for everything: pixel footprint in meters (distance fields have unit gradient)
float pxw = max(length(fwidth(fp)), 1e-4);
// ---- polished panels: large-scale smudges + hex micro grooves (skipped on the LOW preset)
#ifdef NB_FLOOR_LITE
const float smudge = 0.5;
const vec4 hx = vec4(0.0);
const float groove = 0.0;
const float panelVar = 0.0;
#else
float smudge = nbNoise2(fp * 0.11);
vec4 hx = nbHex(fp / 0.95);
float hfw = pxw / 0.95;
float groove = (1.0 - smoothstep(0.012, 0.012 + hfw * 1.2, hx.z)) * (1.0 - smoothstep(0.06, 0.2, hfw));
float panelVar = (hx.w - 0.5);
#endif
// ---- markings: distance fields (m), min-combined, single AA evaluation per line family
float lw = 0.075;
float rc = length(fp);
float m = 0.0;
if (inField > 0.5) {
  float inner = step(dField, -1.2);
  float dl = abs(dField + 1.2);                                        // boundary
  dl = min(dl, abs(fp.y) + (1.0 - inner) * 1e3);                       // midline
  dl = min(dl, abs(rc - 10.0));                                        // center circle
  float gb = nbBox(vec2(fp.x, az - (NB_L - NB_RE - 6.5)), vec2(15.0, 6.5), 3.0);
  dl = min(dl, abs(gb) + step(NB_L - NB_RE - 0.25, az) * 1e3);         // goal box
  float arcD = abs(length(vec2(fp.x, az - NB_L)) - 22.0);
  dl = min(dl, arcD + (step(NB_L - NB_RE - 13.0, az) + (1.0 - inner)) * 1e3); // goal arc
  float cov = min(1.0, (2.0 * lw) / (pxw * 1.5));
  m = (1.0 - smoothstep(lw - pxw, lw + pxw, dl)) * cov;
  // thin inner ring + kickoff spots (thin lines)
  float dt = abs(rc - 10.55);
  const vec2 KSP[${spots.length}] = vec2[${spots.length}](${spots.join(', ')});
  float dk = 1e3;
  for (int i = 0; i < ${spots.length}; i++) dk = min(dk, abs(length(ap - KSP[i]) - 0.5));
  float tw = 0.035;
  float covT = min(1.0, (2.0 * tw) / (pxw * 1.5));
  m += (1.0 - smoothstep(tw - pxw, tw + pxw, min(dt, dk))) * covT * 0.65;
  // center spot
  m += (1.0 - smoothstep(0.28 - pxw, 0.28 + pxw, rc)) * 0.8;
  m = min(m, 1.0);
}
vec3 lineCol = mix(uLineColor, teamCol, 0.12 + 0.4 * endT);
lineCol = mix(lineCol, uSurgeColor, uSurge * 0.7);
vec3 floorEmit = lineCol * m * 0.8;
// emblem (center)
vec2 euv = vec2(0.5 - fp.x / ${EMBLEM_SIZE.toFixed(1)}, 0.5 + fp.y / ${EMBLEM_SIZE.toFixed(1)});
vec2 edx = dFdx(euv);
vec2 edy = dFdy(euv);
if (rc < ${(EMBLEM_SIZE * 0.5).toFixed(1)}) {
  float em = textureGrad(tEmblem, euv, edx, edy).a;
  floorEmit += mix(uLineColor, vec3(0.75, 0.88, 1.0), 0.5) * em * 0.2;
}
// team tint wash toward each end + goal-line glow + goal interior spill
floorEmit += teamCol * (0.0015 + 0.01 * endT * endT) * inField;
float goalLine = (1.0 - smoothstep(0.07 - pxw, 0.07 + pxw, abs(az - NB_L))) * min(1.0, 0.14 / (pxw * 1.5)) * step(ap.x, NB_G);
float gFlash = mix(uGoalFlash.x, uGoalFlash.y, teamSide);
vec3 gCol = mix(teamCol, uFlashColor, gFlash);
floorEmit += gCol * goalLine * (2.4 + gFlash * 6.0);
floorEmit += gCol * inGoal * smoothstep(NB_L - 1.0, NB_L + NB_GD, az) * (0.04 + gFlash * 0.3);
floorEmit += teamCol * exp(-abs(az - NB_L) * 1.4) * step(ap.x, NB_G) * 0.04;
// light pools + ripples
floorEmit += nbPools(vFloorWP) * 0.3;
floorEmit += nbRipples(vFloorWP) * 0.2;
// outside deck: faint structural grid
float outside = 1.0 - inField;
vec2 dk = abs(fract(fp / 4.0) - 0.5);
float deckLine = (1.0 - smoothstep(0.47, 0.49, max(dk.x, dk.y))) * outside;
floorEmit += vec3(0.25, 0.35, 0.7) * deckLine * 0.004;
floorEmit += lineCol * groove * 0.0008 * inField;
totalEmissiveRadiance += floorEmit;
diffuseColor.rgb *= 2.2 * (1.0 + panelVar * 0.06 + (smudge - 0.5) * 0.1);
float nbShadow = 1.0;`,
          )
          .replace('#include <lights_fragment_begin>', patched)
          .replace(
            '#include <lights_fragment_maps>',
            `#include <lights_fragment_maps>
vec3 nbRefl = vec3(0.0);
#ifdef NB_PLANAR
{
  vec2 ruv = vReflCoord.xy / vReflCoord.w;
  // micro-normal distortion from grooves / panels
  ruv += hx.xy * (0.003 * groove) + vec2(panelVar * 0.0015, 0.0);
  // sharp + Gaussian-blurred reflections, mixed by a smudge-driven gloss (polished but not a mirror)
  vec3 rs = texture2D(tRefl, ruv).rgb;
  vec3 rb = texture2D(tReflBlur, ruv).rgb;
  float gloss = uReflSharp * (0.7 + 0.6 * smudge);
  vec3 refl = mix(rb, rs, gloss);
  vec2 ef = smoothstep(vec2(0.0), vec2(0.035), ruv) * (1.0 - smoothstep(vec2(0.965), vec2(1.0), ruv));
  refl *= ef.x * ef.y;
  refl *= (1.0 - groove * 0.18) * (0.94 + panelVar * 0.08) * (0.85 + 0.3 * smudge);
  refl *= mix(0.3, 1.0, inField);
  // Schlick fresnel (dielectric, capped at grazing for a slightly rough polish)
  vec3 Vw = normalize(cameraPosition - vFloorWP);
  float fres = 0.04 + 0.62 * pow(1.0 - max(Vw.y, 0.0), 4.0);
  nbRefl = refl * fres * uReflBoost;
}
#endif`,
          )
          .replace(
            '#include <lights_fragment_end>',
            `nbRefl *= mix(1.0, nbShadow, 0.82);
totalEmissiveRadiance *= mix(1.0, nbShadow, 0.55);
// floodlit sheen: the stadium lights faintly lift the whole pitch, shadows cut it out (readable shadows)
totalEmissiveRadiance += vec3(0.0065, 0.0085, 0.0135) * inField * nbShadow * (0.85 + 0.3 * smudge);
#include <lights_fragment_end>`,
          )
          .replace('#include <envmap_fragment>', `outgoingLight += nbRefl;
#include <envmap_fragment>`);
    };
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'ArenaFloor';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = -5;
  }

  /** LOW preset: skip the hex micro-grooves and smudge variation (the markings, pools, ripples and mirror stay). */
  setLite(lite: boolean): void {
    const has = 'NB_FLOOR_LITE' in (this.material.defines ?? {});
    if (lite === has) return;
    const d = { ...(this.material.defines ?? {}) };
    if (lite) d.NB_FLOOR_LITE = '';
    else delete d.NB_FLOOR_LITE;
    this.material.defines = d;
    this.material.needsUpdate = true;
  }

  /** Redraw the emblem (e.g. once the display font has loaded). */
  refreshEmblem(): void {
    const img = this.emblem.image as HTMLCanvasElement | undefined;
    if (img && typeof img.getContext === 'function') {
      drawEmblem(img);
      this.emblem.needsUpdate = true;
    }
  }

  /**
   * Planar reflection on (texture) or off (null). Off, the floor only has the key-light / ball-light Phong
   * highlights: MeshPhongMaterial gets NO specular IBL from scene.environment in three.js r186, so every preset
   * keeps a (small) planar reflection for the glossy look.
   */
  setReflection(tex: Texture | null, blurTex: Texture | null, matrix: Matrix4): void {
    this.local.tRefl.value = tex;
    this.local.tReflBlur.value = blurTex;
    this.local.uReflMatrix.value = matrix;
    this.local.uReflOn.value = tex ? 1 : 0;
    const want = !!tex;
    const has = 'NB_PLANAR' in (this.material.defines ?? {});
    if (want !== has) {
      const d = { ...(this.material.defines ?? {}) };
      if (want) d.NB_PLANAR = '';
      else delete d.NB_PLANAR;
      this.material.defines = d;
      this.material.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.emblem.dispose();
  }
}
