/**
 * NOVABALL — visual/brand theme shared by render + UI (CONTRACT).
 */
import type { CarStyleId, Team } from './sim/types';

export const GAME_TITLE = 'NOVABALL';
export const GAME_TAGLINE = 'Hover-car football at the edge of the galaxy';

export interface TeamTheme {
  name: string;
  /** Main neon color (trims, goal, HUD). */
  primary: string;
  /** Lighter accent (highlights, text glow). */
  secondary: string;
  /** Deep shade (panels, backgrounds). */
  dark: string;
}

export const TEAMS: Record<Team, TeamTheme> = {
  0: { name: 'VOLT', primary: '#1ec8ff', secondary: '#8be9ff', dark: '#06263f' },
  1: { name: 'BLAZE', primary: '#ff6a1a', secondary: '#ffc27a', dark: '#3f1405' },
};

/** Ball colors: neutral core + per-level intensity. Charged levels are tinted by the owning team's colors. */
export const BALL_THEME = {
  neutral: '#e6f3ff',
  /** Emissive intensity multiplier per charge level 0..3 (level 3 = SUPERNOVA). */
  levelIntensity: [1.0, 1.6, 2.4, 3.6],
  supernova: '#ffffff',
} as const;

/** Arena accent colors. */
export const ARENA_THEME = {
  floorBase: '#05070d',
  gridLine: '#1b2a44',
  fieldLines: '#9fb8ff',
  forceField: '#3d7bff',
  surge: '#b44dff',
  starlight: '#cfe3ff',
} as const;

export const CAR_STYLES: ReadonlyArray<{ id: CarStyleId; name: string; blurb: string }> = [
  { id: 'striker', name: 'STRIKER', blurb: 'Balanced wedge. The all-rounder.' },
  { id: 'viper', name: 'VIPER', blurb: 'Low, long and needle-nosed.' },
  { id: 'titan', name: 'TITAN', blurb: 'Tall, armored, intimidating.' },
];

/** Paint presets for the garage (body color; trims always use the team color). */
export const PAINTS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Arctic', hex: '#e8eef7' },
  { name: 'Graphite', hex: '#2a2f3a' },
  { name: 'Obsidian', hex: '#0d0f14' },
  { name: 'Chrome', hex: '#b9c3cf' },
  { name: 'Crimson', hex: '#b3122e' },
  { name: 'Cobalt', hex: '#1947c2' },
  { name: 'Toxic', hex: '#7cff3a' },
  { name: 'Solar', hex: '#ffcc33' },
  { name: 'Violet', hex: '#7a2cff' },
  { name: 'Rose', hex: '#ff4fa3' },
];

export function teamColor(team: Team | -1): string {
  return team === -1 ? BALL_THEME.neutral : TEAMS[team].primary;
}
