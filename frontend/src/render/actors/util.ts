/**
 * Small render-side helpers (NOT for the deterministic sim — Math.random is fine here).
 */
import { Color } from 'three';
import type { Team } from '../../sim/types';
import { BALL_THEME, TEAMS } from '../../theme';

/** Fast xorshift32 RNG for VFX (avoids Math.random overhead in hot loops). */
export class FastRng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  /** [0, 1) */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  /** [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** [-1, 1) */
  signed(): number {
    return this.next() * 2 - 1;
  }
}

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach factor. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Linear-space team colors (three Color handles sRGB hex -> linear working space). */
export const TEAM_PRIMARY: [Color, Color] = [new Color(TEAMS[0].primary), new Color(TEAMS[1].primary)];
export const TEAM_SECONDARY: [Color, Color] = [new Color(TEAMS[0].secondary), new Color(TEAMS[1].secondary)];
export const NEUTRAL_COLOR = new Color(BALL_THEME.neutral);
export const WHITE = new Color(1, 1, 1);

export function teamPrimary(team: Team | -1): Color {
  return team === -1 ? NEUTRAL_COLOR : TEAM_PRIMARY[team];
}
export function teamSecondary(team: Team | -1): Color {
  return team === -1 ? NEUTRAL_COLOR : TEAM_SECONDARY[team];
}
