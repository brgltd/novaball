/**
 * Saved settings are sanitized on load: a bad value (older schema, hand edit, NaN persisted as null) must fall back to
 * the default for that key instead of breaking the game on every boot; valid settings round-trip unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings, sanitizeSettings, type Settings } from '../../src/settings';

function withStorage(raw: string | null): void {
  const store = new Map<string, string>();
  if (raw !== null) store.set(SETTINGS_STORAGE_KEY, raw);
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

const VALID: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  quality: 'ultra',
  dynamicResolution: false,
  targetFps: 144,
  maxPixelRatio: 1.75,
  showFps: true,
  fov: 88,
  cameraDistance: 4.1,
  cameraHeight: 1.6,
  cameraStiffness: 0.3,
  ballCamDefault: false,
  screenShake: 0.25,
  masterVolume: 0.5,
  sfxVolume: 0.7,
  musicVolume: 0,
  invertPitch: true,
  gamepadDeadzone: 0.08,
  vibration: false,
  playerName: 'ACE-7 X.Y',
  carStyle: 'viper',
  paint: '#ff4fa3',
  lastTeamSize: 3,
  lastDifficulty: 'legend',
  lastDuration: 300,
  lastMutators: { charge: false, pulse: true, surges: false, demolitions: true },
  seenTutorial: true,
};

describe('settings sanitizing', () => {
  it('keeps valid settings unchanged (round trip through storage)', () => {
    expect(sanitizeSettings(VALID)).toEqual(VALID);
    expect(sanitizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    withStorage(JSON.stringify(VALID));
    expect(loadSettings()).toEqual(VALID);
  });

  it('falls back per key on wrong types, null / NaN and garbage', () => {
    const s = sanitizeSettings({
      ...VALID,
      fov: null,
      cameraDistance: 'far',
      masterVolume: Number.NaN,
      showFps: 'yes',
      quality: 7,
      lastMutators: { charge: 'on', pulse: false },
    });
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.cameraDistance).toBe(DEFAULT_SETTINGS.cameraDistance);
    expect(s.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(s.showFps).toBe(DEFAULT_SETTINGS.showFps);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.lastMutators).toEqual({ charge: DEFAULT_SETTINGS.lastMutators.charge, pulse: false, surges: DEFAULT_SETTINGS.lastMutators.surges, demolitions: DEFAULT_SETTINGS.lastMutators.demolitions });
    // untouched valid keys survive
    expect(s.cameraHeight).toBe(VALID.cameraHeight);
    expect(s.playerName).toBe(VALID.playerName);
  });

  it('clamps numbers to the settings panel ranges', () => {
    const s = sanitizeSettings({ fov: 400, cameraDistance: -3, maxPixelRatio: 9, screenShake: 2, gamepadDeadzone: 0, musicVolume: -1 });
    expect(s.fov).toBe(120);
    expect(s.cameraDistance).toBe(2.2);
    expect(s.maxPixelRatio).toBe(2);
    expect(s.screenShake).toBe(1);
    expect(s.gamepadDeadzone).toBe(0.02);
    expect(s.musicVolume).toBe(0);
  });

  it('whitelists enums and formats', () => {
    const s = sanitizeSettings({
      quality: 'epic',
      carStyle: 'hover',
      lastTeamSize: 4,
      lastDuration: 0,
      lastDifficulty: 'insane',
      targetFps: 75,
      paint: 'red',
      playerName: '  <b>neo</b>!!  ',
    });
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.carStyle).toBe(DEFAULT_SETTINGS.carStyle);
    expect(s.lastTeamSize).toBe(DEFAULT_SETTINGS.lastTeamSize);
    expect(s.lastDuration).toBe(DEFAULT_SETTINGS.lastDuration);
    expect(s.lastDifficulty).toBe(DEFAULT_SETTINGS.lastDifficulty);
    expect(s.targetFps).toBe(DEFAULT_SETTINGS.targetFps);
    expect(s.paint).toBe(DEFAULT_SETTINGS.paint);
    expect(s.playerName).toBe('BNEOB');
    expect(sanitizeSettings({ playerName: '!!!' }).playerName).toBe(DEFAULT_SETTINGS.playerName);
    expect(sanitizeSettings({ playerName: 'A'.repeat(40) }).playerName).toHaveLength(12);
  });

  it('survives any stored shape and drops unknown keys', () => {
    for (const raw of ['null', '42', '"x"', '[1,2]', '{', '{"lastMutators":null}', '{"__proto__":{"fov":1}}']) {
      withStorage(raw);
      const s = loadSettings();
      expect(s).toEqual(DEFAULT_SETTINGS);
    }
    expect(Object.keys(sanitizeSettings({ ...VALID, hacked: true })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('defaults to a 2:00 match for a fresh profile', () => {
    withStorage(null);
    expect(loadSettings().lastDuration).toBe(120);
  });
});
