/**
 * NOVABALL audio — objective offline verification (no ears required).
 *
 * Renders sounds through the REAL AudioSystem graph (buses, reverbs, compressor, soft clipper) into an
 * OfflineAudioContext and measures: peak, RMS, active RMS, max short-term (50 ms) RMS, spectral centroid, DC offset,
 * render time; for music also in-key energy (chroma) and tempo (onset autocorrelation).
 * Used by dev/audio-sandbox.ts (window.__audio.offline() / offlineText() / profile()).
 */
import { Vector3 } from 'three';
import type { Stinger, UiSound } from '../contracts';
import { DEFAULT_SETTINGS } from '../settings';
import type { SimEvent } from '../sim/types';
import { AudioSystem } from './AudioSystem';
import { FakeWorld } from './dev/fakeWorld';

export interface MusicAnalysis {
  /** Share of pitched energy (55–2000 Hz spectral peaks) on A-minor pitch classes incl. G# (random / noise ≈ 0.67). */
  inKey: number;
  /** Strongest pitch classes, e.g. ['A', 'E', 'C']. */
  topPitchClasses: string[];
  /** Tempo from onset-envelope autocorrelation (80–160 BPM search). */
  bpm: number;
}

export interface LevelStats {
  name: string;
  group: string;
  seconds: number;
  peak: number;
  peakDb: number;
  rmsDb: number;
  activeRmsDb: number;
  maxShortRmsDb: number;
  centroidHz: number;
  dc: number;
  silent: boolean;
  clipped: boolean;
  renderMs: number;
  /** Expected max short-term RMS range (dBFS) and verdict. */
  expect?: readonly [number, number];
  ok: boolean;
  note?: string;
  /** Music only: tonal analysis + tempo. */
  music?: MusicAnalysis;
}

const SR = 48000;
const db = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

export function analyze(name: string, group: string, buf: AudioBuffer, renderMs: number, expect?: readonly [number, number], window?: readonly [number, number]): LevelStats {
  const sr = buf.sampleRate;
  const a = window ? Math.max(0, Math.floor(window[0] * sr)) : 0;
  const b = window ? Math.min(buf.length, Math.floor(window[1] * sr)) : buf.length;
  const chs: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).subarray(a, b));
  const n = b - a;
  let peak = 0;
  let sum = 0;
  let dcSum = 0;
  for (const d of chs) {
    for (let i = 0; i < n; i++) {
      const x = d[i];
      const ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      sum += x * x;
      dcSum += x;
    }
  }
  const total = n * chs.length;
  const rms = Math.sqrt(sum / total);
  // Short-term RMS (50 ms window, 25 ms hop).
  const win = Math.floor(0.05 * sr);
  const hop = Math.floor(0.025 * sr);
  let maxShort = 0;
  const shorts: number[] = [];
  for (let s = 0; s + win <= n; s += hop) {
    let e = 0;
    for (const d of chs) for (let i = s; i < s + win; i++) e += d[i] * d[i];
    const r = Math.sqrt(e / (win * chs.length));
    shorts.push(r);
    if (r > maxShort) maxShort = r;
  }
  // Active RMS: windows within 40 dB of the loudest.
  let aSum = 0;
  let aCnt = 0;
  for (const r of shorts) {
    if (r > maxShort * 0.01) {
      aSum += r * r;
      aCnt++;
    }
  }
  const activeRms = aCnt ? Math.sqrt(aSum / aCnt) : 0;
  const centroid = spectralCentroid(chs, sr, maxShort);
  const silent = peak < 1e-4;
  const clipped = peak > 0.98;
  let ok = !silent && !clipped;
  let note = '';
  const ms = db(maxShort);
  if (expect && !silent) {
    if (ms < expect[0]) {
      ok = false;
      note = `quiet (< ${expect[0]} dB)`;
    } else if (ms > expect[1]) {
      ok = false;
      note = `loud (> ${expect[1]} dB)`;
    }
  }
  if (silent) note = 'SILENT';
  if (clipped) note = 'CLIPPED';
  return {
    name,
    group,
    seconds: n / sr,
    peak,
    peakDb: db(peak),
    rmsDb: db(rms),
    activeRmsDb: db(activeRms),
    maxShortRmsDb: ms,
    centroidHz: centroid,
    dc: dcSum / total,
    silent,
    clipped,
    renderMs,
    expect,
    ok,
    note,
  };
}

/** Magnitude-weighted mean frequency over the active frames (2048-pt Hann FFT, mono sum). */
function spectralCentroid(chs: Float32Array[], sr: number, maxShort: number): number {
  const N = 2048;
  const n = chs[0].length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= n; s += N) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      let x = 0;
      for (const d of chs) x += d[s + i];
      x /= chs.length;
      e += x * x;
      re[i] = x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    if (Math.sqrt(e / N) < maxShort * 0.05) continue;
    fft(re, im);
    for (let k = 1; k < N / 2; k++) mag[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    frames++;
  }
  if (!frames) return 0;
  let num = 0;
  let den = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    num += f * mag[k];
    den += mag[k];
  }
  return den > 0 ? num / den : 0;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** A natural minor + G# (harmonic minor leading tone used by the E major chord). */
const IN_KEY = new Set([9, 11, 0, 2, 4, 5, 7, 8]);

export function analyzeMusic(buf: AudioBuffer, skip = 0.5): MusicAnalysis {
  const sr = buf.sampleRate;
  const a = Math.floor(skip * sr);
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = buf.length;
  // --- chroma (spectral peaks only) ---
  const N = 8192;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const chroma = new Float64Array(12);
  const kMin = Math.ceil((55 * N) / sr);
  const kMax = Math.floor((2000 * N) / sr);
  const pcOfBin = new Int8Array(kMax + 1);
  for (let k = kMin; k <= kMax; k++) {
    const f = (k * sr) / N;
    pcOfBin[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  for (let s = a; s + N <= n; s += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = (L[s + i] + R[s + i]) * 0.5 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = kMin + 1; k < kMax; k++) {
      const m = re[k] * re[k] + im[k] * im[k];
      const m0 = re[k - 1] * re[k - 1] + im[k - 1] * im[k - 1];
      const m1 = re[k + 1] * re[k + 1] + im[k + 1] * im[k + 1];
      if (m > m0 && m >= m1) chroma[pcOfBin[k]] += m;
    }
  }
  let tot = 0;
  let inKey = 0;
  for (let pc = 0; pc < 12; pc++) {
    tot += chroma[pc];
    if (IN_KEY.has(pc)) inKey += chroma[pc];
  }
  const order = [...chroma.keys()].sort((x, y) => chroma[y] - chroma[x]);
  // --- tempo (onset envelope autocorrelation) ---
  const hop = Math.floor(0.01 * sr);
  const env: number[] = [];
  let prev = 0;
  for (let s = a; s + hop <= n; s += hop) {
    let e = 0;
    for (let i = s; i < s + hop; i++) e += L[i] * L[i] + R[i] * R[i];
    e = Math.sqrt(e / hop);
    const d = e - prev;
    env.push(d > 0 ? d : 0);
    prev = e;
  }
  let bestLag = 0;
  let best = -1;
  const lagMin = Math.floor(60 / 160 / 0.01);
  const lagMax = Math.ceil(60 / 80 / 0.01);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let c = 0;
    for (let i = 0; i + lag < env.length; i++) c += env[i] * env[i + lag];
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return {
    inKey: tot > 0 ? inKey / tot : 0,
    topPitchClasses: order.slice(0, 4).map((pc) => PC_NAMES[pc]),
    bpm: bestLag ? 60 / (bestLag * 0.01) : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

type Setup = (sys: AudioSystem, ctx: OfflineAudioContext, world: FakeWorld) => void | Promise<void>;
type OnFrame = (sys: AudioSystem, t: number, dt: number, world: FakeWorld) => void;

async function render(seconds: number, setup: Setup, onFrame?: OnFrame, fps = 60, teamSize = 3): Promise<{ buffer: AudioBuffer; renderMs: number; sys: AudioSystem }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const sys = new AudioSystem();
  sys.applySettings(DEFAULT_SETTINGS);
  await sys.attachContext(ctx);
  const world = new FakeWorld(teamSize);
  await setup(sys, ctx, world);
  if (onFrame) {
    const dt = 1 / fps;
    for (let i = 1; i * dt < seconds - 0.01; i++) {
      const t = i * dt;
      ctx
        .suspend(t)
        .then(() => {
          onFrame(sys, t, dt, world);
          return ctx.resume();
        })
        .catch(() => undefined);
    }
  }
  const t0 = performance.now();
  const buffer = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  sys.dispose();
  return { buffer, renderMs, sys };
}

/** Listener at the field center looking +Z; `ahead` meters in front. */
function frontPos(ahead: number, right = 0, up = 1): { x: number; y: number; z: number } {
  return { x: -right, y: up, z: ahead };
}

function centerCamera(world: FakeWorld): void {
  world.frame.listenerPos.set(0, 2, -6);
  world.frame.listenerQuat.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  if (world.snap.cars[0]) world.snap.cars[0].pos.set(0, 0.45, -2.6);
  // Other cars spread ~10–20 m in front of the camera.
  for (let i = 1; i < world.snap.cars.length; i++) world.snap.cars[i].pos.set((i - 3) * 4, 0.45, 9);
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

interface EventCase {
  name: string;
  seconds: number;
  events: SimEvent[];
  expect: readonly [number, number];
  charge?: number;
}

function eventCases(): EventCase[] {
  const p = frontPos(8, 1.5, 1);
  const n = { x: 0, y: 0, z: 1 };
  const hit = (strength: number, dodge = false): SimEvent => ({ type: 'ballHit', carId: 0, team: 0, pos: p, normal: n, strength, dodge, aerial: false, ballSpeed: strength + 5 });
  return [
    { name: 'ballHit weak (Δv 4)', seconds: 1.5, events: [hit(4)], expect: [-32, -16] },
    { name: 'ballHit medium (Δv 14)', seconds: 1.5, events: [hit(14)], expect: [-22, -9] },
    { name: 'ballHit strong (Δv 30)', seconds: 1.5, events: [hit(30)], expect: [-16, -5] },
    { name: 'ballHit dodge (Δv 30)', seconds: 1.5, events: [hit(30, true)], expect: [-16, -4] },
    { name: 'ballHit charged I', seconds: 1.5, events: [hit(20)], charge: 1, expect: [-18, -6] },
    { name: 'ballHit charged II', seconds: 1.5, events: [hit(20)], charge: 2, expect: [-18, -6] },
    { name: 'ballHit SUPERNOVA', seconds: 1.5, events: [hit(24)], charge: 3, expect: [-16, -4] },
    { name: 'ballBounce floor', seconds: 1.2, events: [{ type: 'ballBounce', pos: frontPos(10), normal: { x: 0, y: 1, z: 0 }, speed: 12 }], expect: [-26, -10] },
    { name: 'ballBounce wall', seconds: 1.2, events: [{ type: 'ballBounce', pos: frontPos(12, 6, 5), normal: { x: 1, y: 0, z: 0 }, speed: 16 }], expect: [-26, -10] },
    { name: 'carImpact', seconds: 1.2, events: [{ type: 'carImpact', carId: 1, pos: frontPos(8, -2, 0.5), normal: { x: 1, y: 0, z: 0 }, speed: 14 }], expect: [-28, -10] },
    { name: 'carBump', seconds: 1.2, events: [{ type: 'carBump', aId: 0, bId: 1, pos: frontPos(4, 0, 0.5), speed: 15 }], expect: [-24, -8] },
    { name: 'jump (player)', seconds: 1.0, events: [{ type: 'jump', carId: 0, double: false }], expect: [-28, -12] },
    { name: 'double jump (player)', seconds: 1.0, events: [{ type: 'jump', carId: 0, double: true }], expect: [-30, -12] },
    { name: 'dodge (player)', seconds: 1.0, events: [{ type: 'dodge', carId: 0, fx: 1, rx: 0.5 }], expect: [-28, -12] },
    { name: 'land (player)', seconds: 1.0, events: [{ type: 'land', carId: 0, speed: 8 }], expect: [-30, -12] },
    { name: 'jump (other car, 15 m)', seconds: 1.0, events: [{ type: 'jump', carId: 3, double: false }], expect: [-44, -20] },
    { name: 'boostPickup small', seconds: 1.0, events: [{ type: 'boostPickup', carId: 0, padIndex: 6, big: false }], expect: [-30, -14] },
    { name: 'boostPickup big', seconds: 1.5, events: [{ type: 'boostPickup', carId: 0, padIndex: 0, big: true }], expect: [-26, -10] },
    { name: 'demolish', seconds: 3.0, events: [{ type: 'demolish', victimId: 3, attackerId: 0, pos: frontPos(10, 2, 0.5), vel: { x: 0, y: 0, z: 20 } }], expect: [-16, -3] },
    { name: 'respawn (player)', seconds: 1.6, events: [{ type: 'respawn', carId: 0 }], expect: [-30, -12] },
    { name: 'NOVA PULSE (player, hit ball)', seconds: 2.0, events: [{ type: 'pulse', carId: 0, pos: frontPos(3), hitBall: true, hitCarIds: [4] }], expect: [-18, -5] },
    { name: 'charge I (friendly)', seconds: 1.2, events: [{ type: 'chargeChange', team: 0, level: 1, prevLevel: 0 }], expect: [-30, -12] },
    { name: 'charge II (friendly)', seconds: 1.2, events: [{ type: 'chargeChange', team: 0, level: 1, prevLevel: 0 }, { type: 'chargeChange', team: 0, level: 2, prevLevel: 1 }], expect: [-30, -12] },
    { name: 'charge II (opponent)', seconds: 1.2, events: [{ type: 'chargeChange', team: 1, level: 2, prevLevel: 1 }], expect: [-32, -12] },
    { name: 'SUPERNOVA charge', seconds: 2.5, events: [{ type: 'chargeChange', team: 0, level: 3, prevLevel: 2 }], expect: [-20, -6] },
    { name: 'charge steal', seconds: 1.2, events: [{ type: 'chargeChange', team: 1, level: 2, prevLevel: 1 }, { type: 'chargeChange', team: 0, level: 1, prevLevel: 2 }], expect: [-30, -10] },
    { name: 'charge decay', seconds: 1.0, events: [{ type: 'chargeChange', team: 0, level: 2, prevLevel: 1 }, { type: 'chargeChange', team: 0, level: 1, prevLevel: 2 }], expect: [-34, -12] },
    { name: 'GOAL (friendly, SUPERNOVA)', seconds: 5.0, events: [{ type: 'goal', team: 0, scorerId: 0, assistId: -1, points: 3, charge: 3, ballSpeed: 40, pos: { x: 0, y: 2, z: 51 }, ownGoal: false }], expect: [-12, -2] },
    { name: 'GOAL (opponent)', seconds: 5.0, events: [{ type: 'goal', team: 1, scorerId: 3, assistId: -1, points: 1, charge: 1, ballSpeed: 25, pos: { x: 0, y: 2, z: -51 }, ownGoal: false }], expect: [-14, -2] },
    { name: 'save (crowd ooh)', seconds: 2.5, events: [{ type: 'save', carId: 0, epic: false }], expect: [-30, -10] },
    { name: 'epic save (crowd cheer)', seconds: 3.0, events: [{ type: 'save', carId: 0, epic: true }], expect: [-26, -8] },
    { name: 'countdown beep', seconds: 0.8, events: [{ type: 'countdown', value: 3 }], expect: [-26, -10] },
    { name: 'kickoff GO', seconds: 1.5, events: [{ type: 'kickoff' }], expect: [-22, -8] },
    { name: 'surge warning (3 s)', seconds: 4.2, events: [{ type: 'surgeWarning', seconds: 3 }], expect: [-24, -8] },
    { name: 'surge start', seconds: 3.0, events: [{ type: 'surgeStart' }], expect: [-18, -5] },
    { name: 'surge end', seconds: 1.5, events: [{ type: 'surgeEnd' }], expect: [-24, -8] },
    { name: 'overtime horn', seconds: 3.0, events: [{ type: 'overtime' }], expect: [-20, -5] },
    { name: 'clock tick', seconds: 0.5, events: [{ type: 'clockTick', secondsLeft: 8 }], expect: [-32, -12] },
    { name: 'clock tick (urgent)', seconds: 0.5, events: [{ type: 'clockTick', secondsLeft: 2 }], expect: [-30, -10] },
    { name: 'match end (win)', seconds: 4.0, events: [{ type: 'matchEnd', winner: 0 }], expect: [-20, -4] },
    { name: 'match end (loss)', seconds: 4.0, events: [{ type: 'matchEnd', winner: 1 }], expect: [-20, -4] },
  ];
}

const UI_EXPECT: Record<UiSound, readonly [number, number]> = {
  hover: [-40, -24],
  click: [-32, -16],
  back: [-32, -16],
  start: [-28, -12],
  toggle: [-34, -16],
  error: [-32, -14],
};

const STINGER_EXPECT: Record<Stinger, readonly [number, number]> = {
  matchStart: [-24, -8],
  countdownGo: [-24, -8],
  victory: [-24, -8],
  defeat: [-28, -10],
  replayStart: [-26, -10],
  replayEnd: [-26, -10],
};

export interface OfflineReport {
  sampleRate: number;
  results: LevelStats[];
  failures: number;
  totalRenderMs: number;
  updateCost: { meanUs: number; p95Us: number; maxUs: number; calls: number };
  stress: { realtimeFactor: number; seconds: number; renderMs: number };
  /** Render cost without per-frame callbacks (music pre-scheduled: an upper bound on audio-thread DSP load). */
  dsp: { realtimeFactor: number; seconds: number; renderMs: number };
}

export type CheckGroup = 'sfx' | 'ui' | 'stinger' | 'engine' | 'crowd' | 'music' | 'stress';

export interface CheckOptions {
  groups?: CheckGroup[];
  onProgress?: (label: string) => void;
}

export async function runOfflineChecks(opts: CheckOptions = {}): Promise<OfflineReport> {
  const groups = new Set<CheckGroup>(opts.groups ?? ['sfx', 'ui', 'stinger', 'engine', 'crowd', 'music', 'stress']);
  const results: LevelStats[] = [];
  const prog = opts.onProgress ?? (() => undefined);
  let totalRenderMs = 0;
  const push = (r: LevelStats) => {
    results.push(r);
    totalRenderMs += r.renderMs;
  };
  const solo = (sys: AudioSystem, keep: 'gameplay' | 'crowd' | 'music') => {
    for (const b of ['gameplay', 'crowd', 'music'] as const) if (b !== keep) sys.debugMute(b, true);
  };

  if (groups.has('sfx')) {
    for (const c of eventCases()) {
      prog(c.name);
      const { buffer, renderMs } = await render(c.seconds, (sys, _ctx, world) => {
        centerCamera(world);
        world.snap.ball.charge = c.charge ?? 0;
        world.snap.ball.chargeTeam = c.charge ? 0 : -1;
        sys.handleEvents(c.events, world.frame);
      });
      push(analyze(c.name, 'sfx', buffer, renderMs, c.expect));
    }
    // Global state effects: the same strong hit, normal vs. paused (muffled) vs. slow-mo (filtered).
    const hitEv: SimEvent = { type: 'ballHit', carId: 0, team: 0, pos: frontPos(8, 1.5, 1), normal: { x: 0, y: 0, z: 1 }, strength: 30, dodge: false, aerial: false, ballSpeed: 35 };
    for (const [label, paused, ts] of [
      ['ballHit strong @0.3 s (normal)', false, 1],
      ['ballHit strong @0.3 s (PAUSED → muffled)', true, 1],
      ['ballHit strong @0.3 s (slow-mo 0.25)', false, 0.25],
    ] as const) {
      prog(label);
      const { buffer, renderMs } = await render(
        1.6,
        (sys, _ctx, world) => {
          sys.debugMute('crowd', true);
          centerCamera(world);
          world.snap.ball.visible = false;
          world.snap.cars.length = 0;
          world.frame.playerCarId = -1;
          world.frame.paused = paused;
          world.frame.timeScale = ts;
          sys.update(1 / 60, world.frame);
        },
        (sys, t, dt, world) => {
          sys.update(dt, world.frame);
          if (Math.abs(t - 0.3) < dt / 2) sys.handleEvents([hitEv], world.frame);
        },
        60,
        1,
      );
      push(analyze(label, 'state', buffer, renderMs, undefined, [0.3, 1.6]));
    }
  }

  if (groups.has('ui')) {
    for (const k of Object.keys(UI_EXPECT) as UiSound[]) {
      prog('ui ' + k);
      const { buffer, renderMs } = await render(0.6, (sys) => sys.playUi(k));
      push(analyze('ui ' + k, 'ui', buffer, renderMs, UI_EXPECT[k]));
    }
  }

  if (groups.has('stinger')) {
    for (const k of Object.keys(STINGER_EXPECT) as Stinger[]) {
      prog('stinger ' + k);
      const { buffer, renderMs } = await render(k === 'victory' || k === 'defeat' ? 4.5 : 3, (sys) => sys.playStinger(k));
      push(analyze('stinger ' + k, 'stinger', buffer, renderMs, STINGER_EXPECT[k]));
    }
  }

  const updCosts: number[] = [];

  if (groups.has('engine')) {
    prog('engine: player drive');
    {
      const { buffer, renderMs } = await render(
        7,
        (sys, _ctx, world) => {
          solo(sys, 'gameplay');
          world.snap.cars.length = 1;
          world.snap.ball.visible = false;
        },
        (sys, t, dt, world) => {
          const k = world.controls;
          k.throttle = t < 5.5 ? 1 : 0;
          k.boost = t > 2 && t < 4.5;
          k.powerslide = t > 4.8 && t < 5.6;
          k.steer = t > 4.8 && t < 5.6 ? 1 : 0;
          world.step(dt);
          const t0 = performance.now();
          sys.update(dt, world.frame);
          updCosts.push(performance.now() - t0);
        },
      );
      push(analyze('engine: player throttle 1.0-2.0 s (accelerating)', 'engine', buffer, renderMs, [-32, -22], [1.0, 2.0]));
      push(analyze('engine: player boost 2.3-3.2 s', 'engine', buffer, 0, [-26, -15], [2.3, 3.2]));
      push(analyze('engine: player boost+supersonic 3.7-4.4 s', 'engine', buffer, 0, [-24, -14], [3.7, 4.4]));
      push(analyze('engine: player powerslide 4.9-5.5 s', 'engine', buffer, 0, [-30, -16], [4.9, 5.5]));
      push(analyze('engine: player coasting 6.2-7.0 s', 'engine', buffer, 0, [-36, -20], [6.2, 7.0]));
    }
    prog('engine: player idle');
    {
      const { buffer, renderMs } = await render(
        2,
        (sys, _ctx, world) => {
          solo(sys, 'gameplay');
          world.snap.cars.length = 1;
          world.snap.ball.visible = false;
        },
        (sys, _t, dt, world) => {
          world.step(dt);
          sys.update(dt, world.frame);
        },
      );
      push(analyze('engine: player idle', 'engine', buffer, renderMs, [-38, -28], [0.5, 2]));
    }
    prog('engine: 3v3 bots + ball');
    {
      const { buffer, renderMs } = await render(
        5,
        (sys, _ctx, world) => {
          solo(sys, 'gameplay');
          world.frame.playerCarId = -1;
        },
        (sys, _t, dt, world) => {
          world.step(dt);
          const t0 = performance.now();
          sys.update(dt, world.frame);
          updCosts.push(performance.now() - t0);
        },
      );
      push(analyze('engine: 3v3 spectator (NPC engines + ball)', 'engine', buffer, renderMs, [-40, -20], [0.5, 5]));
    }
    for (const lv of [0, 3]) {
      const label = `ball voice: resting 5 m away, charge ${lv}${lv === 3 ? ' (SUPERNOVA hum)' : ''}`;
      prog(label);
      const { buffer, renderMs } = await render(
        3,
        (sys, _ctx, world) => {
          solo(sys, 'gameplay');
          centerCamera(world);
          world.snap.cars.length = 0;
          world.frame.playerCarId = -1;
        },
        (sys, _t, dt, world) => {
          const b = world.snap.ball;
          b.pos.set(0, 1, -1);
          b.vel.set(0, 0, 0);
          b.charge = lv;
          b.chargeTeam = lv ? 0 : -1;
          sys.update(dt, world.frame);
        },
        30,
      );
      const r = analyze(label, 'engine', buffer, renderMs, lv ? [-40, -24] : undefined, [1, 3]);
      if (!lv) {
        r.ok = r.maxShortRmsDb < -70;
        r.note = r.ok ? 'silent as expected' : 'should be silent';
      }
      push(r);
    }
  }

  if (groups.has('crowd')) {
    for (const [name, near] of [
      ['crowd bed: calm', false],
      ['crowd bed: ball racing at goal', true],
    ] as const) {
      prog(name);
      const { buffer, renderMs } = await render(
        6,
        (sys, _ctx, world) => {
          solo(sys, 'crowd');
          world.snap.cars.length = 0;
          world.frame.playerCarId = -1;
        },
        (sys, _t, dt, world) => {
          const b = world.snap.ball;
          if (near) {
            b.pos.set(0, 3, 40);
            b.vel.set(0, 0, 25);
          } else {
            b.pos.set(0, 1, 0);
            b.vel.set(2, 0, 0);
          }
          sys.update(dt, world.frame);
        },
        30,
      );
      push(analyze(name, 'crowd', buffer, renderMs, near ? [-27, -19] : [-36, -27], [2, 6]));
    }
  }

  if (groups.has('music')) {
    const cases: Array<[string, 'menu' | 'match' | 'overtime' | 'victory' | 'defeat', number, number, readonly [number, number]]> = [
      ['music: menu', 'menu', 0, 14, [-26, -14]],
      ['music: match intensity 0.2', 'match', 0.2, 12, [-24, -14]],
      ['music: match intensity 0.5', 'match', 0.5, 12, [-24, -14]],
      ['music: match intensity 0.9', 'match', 0.9, 12, [-24, -14]],
      ['music: overtime', 'overtime', 1, 10, [-24, -14]],
      ['music: victory', 'victory', 0.6, 9, [-24, -12]],
      ['music: defeat', 'defeat', 0, 9, [-28, -14]],
    ];
    for (const [name, state, intensity, secs, expect] of cases) {
      prog(name);
      const { buffer, renderMs } = await render(
        secs,
        (sys, _ctx, world) => {
          solo(sys, 'music');
          world.snap.cars.length = 0;
          world.snap.ball.visible = false;
          world.frame.playerCarId = -1;
          sys.setMusicIntensity(intensity);
          sys.setMusic(state);
        },
        (sys, _t, dt, world) => sys.update(dt, world.frame),
        20,
      );
      const r = analyze(name, 'music', buffer, renderMs, expect);
      r.music = analyzeMusic(buffer);
      push(r);
    }
    // Transition quantization: menu (100 BPM) → setMusic('match') at 3.0 s must switch on the next menu bar line.
    prog('music transition');
    const states: Array<[number, string]> = [];
    await render(
      7,
      (sys) => {
        solo(sys, 'music');
        sys.setMusic('menu');
      },
      (sys, t, dt, world) => {
        if (Math.abs(t - 3) < dt / 2) sys.setMusic('match');
        sys.update(dt, world.frame);
        const info = sys.debugInfo().music as { state: string } | null;
        if (info && (!states.length || states[states.length - 1][1] !== info.state)) states.push([t, info.state]);
      },
      50,
      1,
    );
    const sw = states.find((x) => x[1] === 'match');
    const bar = (60 / 100) * 4;
    // Menu starts ≈0.06 s after setMusic; bar lines at 0.06 + k·2.4 s → next after 3.0 s ≈ 4.86 s.
    // The scheduler switches when it *schedules* that bar (≤ 0.2 s lookahead early).
    const expected = 0.06 + Math.ceil((3 - 0.06) / bar) * bar;
    const okT = !!sw && sw[0] >= expected - 0.25 && sw[0] <= expected + 0.05;
    results.push({
      name: `music transition menu→match requested at 3.00 s, switched at ${sw ? sw[0].toFixed(2) : 'never'} s (bar line ${expected.toFixed(2)} s)`,
      group: 'music',
      seconds: 7,
      peak: 0,
      peakDb: 0,
      rmsDb: 0,
      activeRmsDb: 0,
      maxShortRmsDb: 0,
      centroidHz: 0,
      dc: 0,
      silent: false,
      clipped: false,
      renderMs: 0,
      ok: okT,
      note: okT ? 'quantized to bar' : 'not bar-quantized',
    });
  }

  let dsp = { realtimeFactor: 0, seconds: 0, renderMs: 0 };
  if (groups.has('stress')) {
    // DSP cost upper bound: full match music (pre-scheduled) + crowd bed + engines + ball + surge, no frame callbacks.
    prog('dsp cost');
    const seconds = 12;
    const { buffer, renderMs } = await render(seconds, (sys, _ctx, world) => {
      world.controls.throttle = 1;
      world.controls.boost = true;
      for (let i = 0; i < 90; i++) world.step(1 / 60);
      world.snap.ball.charge = 3;
      world.snap.surge = 1;
      sys.setMusicIntensity(1);
      sys.setMusic('match');
      sys.update(1 / 60, world.frame);
      sys.update(1 / 60, world.frame);
      sys.debugPumpMusic(seconds);
    });
    push(analyze('dsp: music x1 + crowd + 4 engines + ball + surge (static)', 'stress', buffer, renderMs, [-20, -6]));
    dsp = { realtimeFactor: renderMs / 1000 / seconds, seconds, renderMs };
  }

  let stress = { realtimeFactor: 0, seconds: 0, renderMs: 0 };
  if (groups.has('stress')) {
    prog('stress: full mix');
    const seconds = 10;
    let evT = 0;
    const { buffer, renderMs } = await render(
      seconds,
      (sys, _ctx, world) => {
        world.autoEvents = true;
        world.snap.ball.charge = 2;
        sys.setMusicIntensity(0.9);
        sys.setMusic('match');
      },
      (sys, t, dt, world) => {
        const k = world.controls;
        k.throttle = 1;
        k.boost = t % 3 > 1.5;
        k.steer = Math.sin(t * 0.7);
        world.step(dt);
        const t0 = performance.now();
        sys.update(dt, world.frame);
        updCosts.push(performance.now() - t0);
        const evs: SimEvent[] = world.events.slice();
        evT += dt;
        if (evT > 0.1) {
          evT = 0;
          evs.push({ type: 'ballHit', carId: 2, team: 0, pos: { x: 3, y: 1, z: world.snap.cars[0].pos.z + 10 }, normal: { x: 0, y: 0, z: 1 }, strength: 10 + ((t * 37) % 20), dodge: false, aerial: false, ballSpeed: 30 });
          evs.push({ type: 'ballBounce', pos: { x: -4, y: 1, z: world.snap.cars[0].pos.z + 6 }, normal: { x: 0, y: 1, z: 0 }, speed: 14 });
          evs.push({ type: 'jump', carId: 1 + (Math.floor(t * 10) % 5), double: false });
        }
        if (Math.abs(t - 5) < dt / 2) evs.push({ type: 'goal', team: 0, scorerId: 0, assistId: 1, points: 3, charge: 3, ballSpeed: 45, pos: { x: 0, y: 2, z: 51 }, ownGoal: false });
        if (Math.abs(t - 6) < dt / 2) evs.push({ type: 'demolish', victimId: 4, attackerId: 0, pos: { x: 2, y: 0.5, z: world.snap.cars[0].pos.z + 5 }, vel: { x: 0, y: 0, z: 22 } });
        if (evs.length) sys.handleEvents(evs, world.frame);
      },
    );
    push(analyze('stress: 3v3 + music + crowd + SFX storm + goal + demo', 'stress', buffer, renderMs, [-16, -2]));
    stress = { realtimeFactor: renderMs / 1000 / seconds, seconds, renderMs };
  }

  updCosts.sort((a, b) => a - b);
  const mean = updCosts.length ? updCosts.reduce((a, b) => a + b, 0) / updCosts.length : 0;
  const p95 = updCosts.length ? updCosts[Math.floor(updCosts.length * 0.95)] : 0;
  const mx = updCosts.length ? updCosts[updCosts.length - 1] : 0;
  return {
    sampleRate: SR,
    results,
    failures: results.filter((r) => !r.ok).length,
    totalRenderMs,
    updateCost: { meanUs: mean * 1000, p95Us: p95 * 1000, maxUs: mx * 1000, calls: updCosts.length },
    stress,
    dsp,
  };
}

/** DSP cost per component: offline render time for 10 s of each layer alone (% of real time, one core). */
export async function profileComponents(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const seconds = 10;
  const HZ = 10;
  const cases: Array<[string, Setup, boolean]> = [
    ['empty graph (reverbs idle)', () => undefined, false],
    [
      'music match x1.0 (0.2 s lookahead)',
      (sys, _c, w) => {
        w.snap.cars.length = 0;
        sys.setMusicIntensity(1);
        sys.setMusic('match');
      },
      true,
    ],
    [
      'music menu (0.2 s lookahead)',
      (sys, _c, w) => {
        w.snap.cars.length = 0;
        sys.setMusic('menu');
      },
      true,
    ],
    [
      'player engine boosting',
      (sys, _c, w) => {
        sys.debugMute('crowd', true);
        w.snap.cars.length = 1;
        w.snap.ball.visible = false;
        w.controls.throttle = 1;
        w.controls.boost = true;
        for (let i = 0; i < 60; i++) w.step(1 / 60);
        sys.update(1 / 60, w.frame);
      },
      false,
    ],
    [
      '3 npc engines + ball',
      (sys, _c, w) => {
        sys.debugMute('crowd', true);
        w.frame.playerCarId = -1;
        w.snap.ball.charge = 3;
        w.snap.ball.vel.set(30, 0, 0);
        for (let i = 0; i < 60; i++) w.step(1 / 60);
        sys.update(1 / 60, w.frame);
        sys.update(1 / 60, w.frame);
      },
      false,
    ],
    [
      'crowd bed (textures)',
      (sys, _c, w) => {
        w.snap.cars.length = 0;
        w.frame.playerCarId = -1;
        sys.update(1 / 60, w.frame);
      },
      false,
    ],
    [
      'surge hum',
      (sys, _c, w) => {
        sys.debugMute('crowd', true);
        w.snap.cars.length = 0;
        w.snap.surge = 1;
        sys.update(1 / 60, w.frame);
      },
      false,
    ],
  ];
  for (const [name, setup, pumped] of cases) {
    const { renderMs } = await render(seconds, setup, pumped ? (sys) => sys.debugPumpMusic((sys.context?.currentTime ?? 0) + 0.2) : undefined, HZ);
    out[name] = Math.round((renderMs / (seconds * 1000)) * 1000) / 10;
  }
  return out;
}

export function formatReport(r: OfflineReport): string {
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-inf');
  const lines = [
    `${pad('sound', 58)} ${pad('peak', 6)} ${pad('pkdB', 6)} ${pad('rms', 6)} ${pad('actRms', 7)} ${pad('max50ms', 8)} ${pad('centroid', 9)} ${pad('expect', 11)} verdict`,
  ];
  for (const x of r.results) {
    lines.push(
      `${pad(x.name, 58)} ${pad(num(x.peak, 3), 6)} ${pad(num(x.peakDb), 6)} ${pad(num(x.rmsDb), 6)} ${pad(num(x.activeRmsDb), 7)} ${pad(num(x.maxShortRmsDb), 8)} ${pad(Math.round(x.centroidHz) + 'Hz', 9)} ${pad(x.expect ? `${x.expect[0]}..${x.expect[1]}` : '', 11)} ${x.ok ? 'ok' + (x.note ? ' ' + x.note : '') : 'FAIL ' + (x.note ?? '')}`,
    );
  }
  for (const x of r.results) {
    if (x.music) lines.push(`  ${pad(x.name, 34)} in-key ${(x.music.inKey * 100).toFixed(1)}% (noise ≈ 66.7%)  top pitch classes ${x.music.topPitchClasses.join(' ')}  tempo ≈ ${x.music.bpm.toFixed(1)} BPM`);
  }
  lines.push(`failures: ${r.failures}/${r.results.length}   total render ${Math.round(r.totalRenderMs)} ms`);
  lines.push(`update() cost: mean ${r.updateCost.meanUs.toFixed(1)} µs, p95 ${r.updateCost.p95Us.toFixed(1)} µs, max ${r.updateCost.maxUs.toFixed(1)} µs over ${r.updateCost.calls} calls`);
  lines.push(`stress render: ${Math.round(r.stress.renderMs)} ms for ${r.stress.seconds} s of audio (x${r.stress.realtimeFactor.toFixed(3)} real time, incl. 60 Hz main-thread callbacks)`);
  lines.push(`dsp-only render: ${Math.round(r.dsp.renderMs)} ms for ${r.dsp.seconds} s of audio (x${r.dsp.realtimeFactor.toFixed(3)} real time, music pre-scheduled = upper bound)`);
  return lines.join('\n');
}
