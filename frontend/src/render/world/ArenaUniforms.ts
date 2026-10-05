/**
 * NOVABALL render-world — uniforms shared by every arena material (one object, many materials).
 * Updating a value here updates the floor, force field, goals and stadium at once.
 */
import { Color, Vector2, Vector4 } from 'three';
import { ARENA_THEME, TEAMS } from '../../theme';

export const MAX_RIPPLES = 16;
export const MAX_POOLS = 8;

export interface ArenaUniforms {
  [name: string]: { value: unknown };
  uTime: { value: number };
  uSurge: { value: number };
  uTeam0: { value: Color };
  uTeam1: { value: Color };
  uSurgeColor: { value: Color };
  uFieldColor: { value: Color };
  /** xyz = impact point, w = start time (uTime); inactive when uTime - w > lifetime. */
  uRipplePos: { value: Vector4[] };
  /** rgb = color, w = strength 0..1 */
  uRippleCol: { value: Vector4[] };
  /** number of active (packed) ripples */
  uRippleCount: { value: number };
  /** number of active (packed) pools */
  uPoolCount: { value: number };
  /** the first uWallPoolCount pools are close to a wall/ceiling (force field only evaluates those) */
  uWallPoolCount: { value: number };
  /** xyz = light source, w = radius (0 = off) */
  uPoolPos: { value: Vector4[] };
  /** rgb = color * intensity */
  uPoolCol: { value: Vector4[] };
  /** x = flash of the -Z goal (team 0's), y = flash of the +Z goal (team 1's), 0..1 */
  uGoalFlash: { value: Vector2 };
  /** color of the current goal celebration (scoring team) */
  uFlashColor: { value: Color };
  /** 0..1 stadium-wide celebration (crowd, lights) */
  uStadiumFlash: { value: number };
  /** crowd excitement per end: x = -Z end, y = +Z end (ball near that goal) */
  uExcite: { value: Vector2 };
  /** 1 while the planar floor reflection is being rendered (lets very bright emitters tone down in the mirror). */
  uReflPass: { value: number };
}

export function createArenaUniforms(): ArenaUniforms {
  const ripPos: Vector4[] = [];
  const ripCol: Vector4[] = [];
  for (let i = 0; i < MAX_RIPPLES; i++) {
    ripPos.push(new Vector4(0, -1000, 0, -1000));
    ripCol.push(new Vector4(0, 0, 0, 0));
  }
  const poolPos: Vector4[] = [];
  const poolCol: Vector4[] = [];
  for (let i = 0; i < MAX_POOLS; i++) {
    poolPos.push(new Vector4(0, -1000, 0, 0));
    poolCol.push(new Vector4(0, 0, 0, 0));
  }
  return {
    uTime: { value: 0 },
    uSurge: { value: 0 },
    uTeam0: { value: new Color(TEAMS[0].primary) },
    uTeam1: { value: new Color(TEAMS[1].primary) },
    uSurgeColor: { value: new Color(ARENA_THEME.surge) },
    uFieldColor: { value: new Color(ARENA_THEME.forceField) },
    uRipplePos: { value: ripPos },
    uRippleCol: { value: ripCol },
    uRippleCount: { value: 0 },
    uPoolCount: { value: 0 },
    uWallPoolCount: { value: 0 },
    uPoolPos: { value: poolPos },
    uPoolCol: { value: poolCol },
    uGoalFlash: { value: new Vector2(0, 0) },
    uFlashColor: { value: new Color(1, 1, 1) },
    uStadiumFlash: { value: 0 },
    uExcite: { value: new Vector2(0, 0) },
    uReflPass: { value: 0 },
  };
}

/** GLSL declarations + helpers for the shared uniforms. */
export const GLSL_ARENA_UNIFORMS = /* glsl */ `
#define NB_MAX_RIPPLES ${MAX_RIPPLES}
#define NB_MAX_POOLS ${MAX_POOLS}
uniform float uTime;
uniform float uSurge;
uniform vec3 uTeam0;
uniform vec3 uTeam1;
uniform vec3 uSurgeColor;
uniform vec3 uFieldColor;
uniform vec4 uRipplePos[NB_MAX_RIPPLES];
uniform vec4 uRippleCol[NB_MAX_RIPPLES];
uniform int uRippleCount;
uniform int uPoolCount;
uniform int uWallPoolCount;
uniform vec4 uPoolPos[NB_MAX_POOLS];
uniform vec4 uPoolCol[NB_MAX_POOLS];
uniform vec2 uGoalFlash;
uniform vec3 uFlashColor;
uniform float uStadiumFlash;
uniform vec2 uExcite;
uniform float uReflPass;

const float NB_RIPPLE_LIFE = 1.9;

// Expanding energy rings from impacts. Returns additive color.
vec3 nbRipples(vec3 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < NB_MAX_RIPPLES; i++) {
    if (i >= uRippleCount) break;
    vec4 rp = uRipplePos[i];
    float age = uTime - rp.w;
    if (age < 0.0 || age > NB_RIPPLE_LIFE) continue;
    vec4 rc = uRippleCol[i];
    float d = distance(p, rp.xyz);
    float speed = 7.0 + 10.0 * rc.w;
    float radius = age * speed;
    float w = 0.35 + age * 0.9;
    float x = (d - radius) / w;
    float ring = exp(-x * x);
    float life = 1.0 - age / NB_RIPPLE_LIFE;
    life *= life;
    float core = exp(-d * d / (0.6 + age * 6.0)) * exp(-age * 6.0);
    acc += rc.rgb * (ring * life + core * 2.0) * (0.35 + rc.w);
  }
  return acc;
}

// Colored "fake light" pools from cars / ball. falloff in units of each pool radius.
vec3 nbPoolsN(vec3 p, int count) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < NB_MAX_POOLS; i++) {
    if (i >= count) break;
    vec4 pp = uPoolPos[i];
    vec3 d = p - pp.xyz;
    float r2 = dot(d, d) / (pp.w * pp.w);
    acc += uPoolCol[i].rgb * exp(-r2 * 2.2) / (1.0 + r2 * 3.0);
  }
  return acc;
}
vec3 nbPools(vec3 p) { return nbPoolsN(p, uPoolCount); }
vec3 nbWallPools(vec3 p) { return nbPoolsN(p, uWallPoolCount); }
`;
