/**
 * NOVABALL — persistent user settings (CONTRACT).
 * Stored in localStorage under 'novaball.settings.v1'. All reads/writes are wrapped in try/catch.
 * Loaded settings are sanitized (sanitizeSettings): a stale schema, a hand-edited value or a NaN saved as null falls
 * back to the default for that key instead of breaking the game on every boot.
 */
import type { CarStyleId, Difficulty, MatchMutators, TeamSize } from './sim/types';
import { CAR_STYLES } from './theme';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  // --- graphics ---
  quality: QualityPreset;
  /** Automatically scale render resolution to hold the target frame rate. */
  dynamicResolution: boolean;
  /** Target FPS used by dynamic resolution. */
  targetFps: number;
  /** Cap on devicePixelRatio (1 .. 2). */
  maxPixelRatio: number;
  showFps: boolean;
  // --- camera ---
  /** Horizontal field of view in degrees (converted to three.js vertical FOV using the aspect ratio). */
  fov: number;
  cameraDistance: number;
  cameraHeight: number;
  /** 0..1, how tightly the camera follows (1 = rigid). */
  cameraStiffness: number;
  ballCamDefault: boolean;
  /** 0..1 camera-shake intensity multiplier. */
  screenShake: number;
  // --- audio ---
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  // --- controls ---
  invertPitch: boolean;
  gamepadDeadzone: number;
  vibration: boolean;
  // --- player / garage ---
  playerName: string;
  carStyle: CarStyleId;
  paint: string;
  // --- last match setup ---
  lastTeamSize: TeamSize;
  lastDifficulty: Difficulty;
  lastDuration: number;
  lastMutators: MatchMutators;
  /** Controls overlay shown before the first match. */
  seenTutorial: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  dynamicResolution: true,
  targetFps: 60,
  maxPixelRatio: 1.5,
  showFps: false,
  fov: 105,
  cameraDistance: 3.4,
  cameraHeight: 1.25,
  cameraStiffness: 0.45,
  ballCamDefault: true,
  screenShake: 0.8,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  musicVolume: 0.55,
  invertPitch: false,
  gamepadDeadzone: 0.15,
  vibration: true,
  playerName: 'PLAYER',
  carStyle: 'striker',
  paint: '#e8eef7',
  lastTeamSize: 3,
  lastDifficulty: 'rookie',
  // 2:00 STANDARD: a first-timer reaches the end screen in ~3 minutes (the first ZERO-G SURGE still comes at 1:00)
  lastDuration: 120,
  lastMutators: { charge: true, pulse: true, surges: true, demolitions: true },
  seenTutorial: false,
};

export const SETTINGS_STORAGE_KEY = 'novaball.settings.v1';
const KEY = SETTINGS_STORAGE_KEY;

/** Allowed ranges of the numeric settings (the Settings panel sliders) and the enum choices. */
const RANGES: Partial<Record<keyof Settings, readonly [number, number]>> = {
  maxPixelRatio: [1, 2],
  fov: [70, 120],
  cameraDistance: [2.2, 5.5],
  cameraHeight: [0.6, 2.4],
  cameraStiffness: [0, 1],
  screenShake: [0, 1],
  masterVolume: [0, 1],
  sfxVolume: [0, 1],
  musicVolume: [0, 1],
  gamepadDeadzone: [0.02, 0.4],
};
const CHOICES: Partial<Record<keyof Settings, ReadonlyArray<string | number>>> = {
  quality: ['low', 'medium', 'high', 'ultra'],
  targetFps: [60, 120, 144],
  carStyle: CAR_STYLES.map((c) => c.id),
  lastTeamSize: [1, 2, 3],
  lastDifficulty: ['rookie', 'pro', 'legend'],
  lastDuration: [60, 120, 240],
};
const NAME_MAX = 12;

/** Pilot callsign rules (same as the Garage input): uppercase A–Z 0–9 space _ - . , max 12, never empty. */
function sanitizeName(raw: string, fallback: string): string {
  const s = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 _\-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return s || fallback;
}

/**
 * A complete, valid Settings object from anything (parsed JSON of any age / shape): every DEFAULT_SETTINGS key is kept
 * when its type and value are valid (numbers finite and clamped to the Settings panel ranges, enums whitelisted, paint
 * a #rrggbb hex, callsign cleaned), otherwise it takes the default. Unknown keys are dropped. Valid settings come back
 * unchanged.
 */
export function sanitizeSettings(input: unknown): Settings {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  const o = out as unknown as Record<string, unknown>;
  const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const key of Object.keys(d) as Array<keyof Settings>) {
    const v = src[key];
    const def = d[key];
    if (v === undefined) continue;
    if (key === 'lastMutators') {
      const m = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      const dm = DEFAULT_SETTINGS.lastMutators as unknown as Record<string, boolean>;
      const om = out.lastMutators as unknown as Record<string, boolean>;
      for (const mk of Object.keys(dm)) om[mk] = typeof m[mk] === 'boolean' ? (m[mk] as boolean) : dm[mk];
      continue;
    }
    if (typeof v !== typeof def) continue;
    const choices = CHOICES[key];
    if (choices) {
      if (choices.includes(v as string | number)) o[key] = v;
      continue;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      const r = RANGES[key];
      o[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
      continue;
    }
    if (key === 'paint') {
      if (/^#[0-9a-f]{6}$/i.test(v as string)) o[key] = v;
      continue;
    }
    if (key === 'playerName') {
      o[key] = sanitizeName(v as string, DEFAULT_SETTINGS.playerName);
      continue;
    }
    o[key] = v; // booleans
  }
  return out;
}

/** The OS asks for reduced motion (vestibular comfort): softer defaults on a first run. */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function loadSettings(): Settings {
  let raw: string | null | undefined = null;
  try {
    raw = globalThis.localStorage?.getItem(KEY);
  } catch {
    raw = null;
  }
  if (!raw) {
    const s = structuredClone(DEFAULT_SETTINGS);
    if (prefersReducedMotion()) s.screenShake = 0.2;
    return s;
  }
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode / blocked) — settings just won't persist */
  }
}

/** Convert a horizontal FOV (degrees) to the vertical FOV (degrees) three.js expects. */
export function horizontalToVerticalFov(hfovDeg: number, aspect: number): number {
  const h = (hfovDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}
