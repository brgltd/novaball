/**
 * NOVABALL render-world — shared GLSL snippets (hashes, noise, hex grid, arena SDF pieces).
 * All snippets are plain strings concatenated into shaders; names are prefixed with `nb` to avoid clashes
 * with three.js chunks.
 */
import { ARENA } from '../../sim/constants';
import { GOAL_BOX } from '../../sim/arena';

const f = (x: number): string => {
  const s = String(x);
  return s.includes('.') || s.includes('e') ? s : s + '.0';
};

/** Hash functions without sine (Dave Hoskins), stable across GPUs. */
export const GLSL_HASH = /* glsl */ `
float nbHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float nbHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float nbHash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 nbHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 nbHash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
`;

/** 2D value noise + fbm (cheap, runtime use). Requires GLSL_HASH. */
export const GLSL_NOISE2 = /* glsl */ `
float nbNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = nbHash12(i);
  float b = nbHash12(i + vec2(1.0, 0.0));
  float c = nbHash12(i + vec2(0.0, 1.0));
  float d = nbHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float nbFbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * nbNoise2(p);
    p = p * 2.03 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return s;
}
`;

/** 3D gradient noise + fbm (bake-time quality). Requires GLSL_HASH. Returns roughly [-1, 1] / fbm [0, 1]. */
export const GLSL_NOISE3 = /* glsl */ `
vec3 nbGrad3(vec3 p) { return normalize(nbHash33(p) * 2.0 - 1.0 + 1e-4); }
float nbGNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(nbGrad3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(nbGrad3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(nbGrad3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(nbGrad3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(nbGrad3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(nbGrad3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(nbGrad3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(nbGrad3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float nbFbm3(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * nbGNoise3(p);
    n += a;
    p = p * 2.02 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return 0.5 + 0.5 * s / n * 1.6;
}
`;

/**
 * Hexagonal grid. Input in "hex units" (cell flat-to-flat = 1). Returns
 *   xy = position relative to the cell center, z = distance to the cell edge (0 at edges, ~0.5 at the center),
 *   w = per-cell random [0,1).
 * Requires GLSL_HASH.
 */
export const GLSL_HEX = /* glsl */ `
vec4 nbHex(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hC.xy * s, p - (hC.zw + 0.5) * s);
  vec4 r = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
  vec2 a = abs(r.xy);
  float edge = 0.5 - max(dot(a, s * 0.5), a.x);
  return vec4(r.xy, edge, nbHash12(r.zw * 1.37 + 11.3));
}
`;

/**
 * Arena SDF pieces mirrored from src/sim/arena.ts (render-side only, float precision).
 * nbMainFree(p) > 0 inside the main volume; nbGoalFree(p) > 0 inside a goal box (folded coords handled internally).
 */
export const GLSL_ARENA = /* glsl */ `
#define NB_W ${f(ARENA.halfWidth)}
#define NB_L ${f(ARENA.halfLength)}
#define NB_H ${f(ARENA.height)}
#define NB_RC ${f(ARENA.cornerRadius)}
#define NB_RE ${f(ARENA.edgeRadius)}
#define NB_G ${f(ARENA.goalHalfWidth)}
#define NB_GH ${f(ARENA.goalHeight)}
#define NB_GD ${f(ARENA.goalDepth)}
#define NB_RG ${f(ARENA.goalInnerRadius)}
#define NB_GB_Z0 ${f(GOAL_BOX.z0)}
float nbRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float nbMainFree(vec3 p) {
  float d2 = nbRoundRect(p.xz, vec2(NB_W, NB_L), NB_RC);
  float wx = d2 + NB_RE;
  float wy = abs(p.y - NB_H * 0.5) - NB_H * 0.5 + NB_RE;
  return -(min(max(wx, wy), 0.0) + length(max(vec2(wx, wy), 0.0)) - NB_RE);
}
float nbGoalFree(vec3 p) {
  float z0 = NB_GB_Z0;
  float z1 = NB_L + NB_GD;
  vec3 c = vec3(0.0, NB_GH * 0.5, (z0 + z1) * 0.5);
  vec3 hb = vec3(NB_G, NB_GH * 0.5, (z1 - z0) * 0.5);
  vec3 q = abs(vec3(abs(p.x), p.y, abs(p.z)) - c) - hb + NB_RG;
  return -(length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - NB_RG);
}
`;

/** Filmic-ish helpers. */
export const GLSL_UTIL = /* glsl */ `
float nbLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float nbSat(float x) { return clamp(x, 0.0, 1.0); }
`;
