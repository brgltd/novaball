/**
 * NOVABALL — audio sandbox (dev only). Served by vite at /dev/audio-sandbox.html.
 * Buttons for every sound, music states / intensity / stingers, a drivable fake car for continuous sounds,
 * offline render checks and an update() benchmark. Automation API: window.__audio.
 */
import { Quaternion, Vector3 } from 'three';
import type { MusicState, Stinger, UiSound } from '../src/contracts';
import { AudioSystem } from '../src/audio/AudioSystem';
import { FakeWorld } from '../src/audio/dev/fakeWorld';
import { formatReport, profileComponents, runOfflineChecks, type CheckOptions, type OfflineReport } from '../src/audio/offlineCheck';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import type { SimEvent } from '../src/sim/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sys = new AudioSystem();
const settings: Settings = structuredClone(DEFAULT_SETTINGS);
sys.applySettings(settings);
sys.setMusic('menu'); // remembered until unlock, like the game does at boot
let world = new FakeWorld(3);
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String(e.reason)));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const _f = new Vector3();
const _r = new Vector3();
/** World position `dist` m in front of the listener, `right` m to the right, `up` m above ground. */
function ahead(dist: number, right = 0, up = 1): { x: number; y: number; z: number } {
  const q = world.frame.listenerQuat;
  _f.set(0, 0, -1).applyQuaternion(q);
  _r.set(1, 0, 0).applyQuaternion(q);
  const p = world.frame.listenerPos;
  return { x: p.x + _f.x * dist + _r.x * right, y: up, z: p.z + _f.z * dist + _r.z * right };
}

function fire(events: SimEvent[]): void {
  world.snap.ball.charge = Number(($('charge') as HTMLSelectElement).value);
  world.snap.ball.chargeTeam = world.snap.ball.charge ? 0 : -1;
  sys.handleEvents(events, world.frame);
}

function button(parent: HTMLElement, label: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', () => {
    void sys.unlock();
    fn();
  });
  b.addEventListener('mouseenter', () => sys.playUi('hover'));
  parent.appendChild(b);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Sound catalog
// ---------------------------------------------------------------------------------------------

const n = { x: 0, y: 0, z: 1 };
const hit = (strength: number, dodge = false, aerial = false): SimEvent => ({ type: 'ballHit', carId: 0, team: 0, pos: ahead(7, 1), normal: n, strength, dodge, aerial, ballSpeed: strength + 5 });

export const SFX: Array<[string, () => SimEvent[]]> = [
  ['hit weak', () => [hit(4)]],
  ['hit medium', () => [hit(14)]],
  ['hit strong', () => [hit(30)]],
  ['hit dodge', () => [hit(30, true)]],
  ['hit aerial', () => [hit(22, false, true)]],
  ['bounce floor', () => [{ type: 'ballBounce', pos: ahead(10), normal: { x: 0, y: 1, z: 0 }, speed: 12 }]],
  ['bounce wall (L)', () => [{ type: 'ballBounce', pos: ahead(12, -8, 5), normal: { x: 1, y: 0, z: 0 }, speed: 16 }]],
  ['car impact', () => [{ type: 'carImpact', carId: 1, pos: ahead(8, -3, 0.5), normal: { x: 1, y: 0, z: 0 }, speed: 14 }]],
  ['car bump', () => [{ type: 'carBump', aId: 0, bId: 1, pos: ahead(4, 0, 0.5), speed: 15 }]],
  ['jump', () => [{ type: 'jump', carId: 0, double: false }]],
  ['double jump', () => [{ type: 'jump', carId: 0, double: true }]],
  ['dodge →', () => [{ type: 'dodge', carId: 0, fx: 0.5, rx: 1 }]],
  ['land', () => [{ type: 'land', carId: 0, speed: 8 }]],
  ['jump (other car)', () => [{ type: 'jump', carId: 3, double: false }]],
  ['boost pad', () => [{ type: 'boostPickup', carId: 0, padIndex: 6, big: false }]],
  ['BIG boost', () => [{ type: 'boostPickup', carId: 0, padIndex: 0, big: true }]],
  ['demolish', () => [{ type: 'demolish', victimId: 3, attackerId: 0, pos: ahead(9, 2, 0.5), vel: { x: 0, y: 0, z: 20 } }]],
  ['respawn', () => [{ type: 'respawn', carId: 0 }]],
  ['NOVA PULSE', () => [{ type: 'pulse', carId: 0, pos: ahead(3), hitBall: true, hitCarIds: [] }]],
  ['charge I', () => [{ type: 'chargeChange', team: 0, level: 1, prevLevel: 0 }]],
  ['charge II', () => [{ type: 'chargeChange', team: 0, level: 2, prevLevel: 1 }]],
  ['SUPERNOVA', () => [{ type: 'chargeChange', team: 0, level: 3, prevLevel: 2 }]],
  ['opp charge II', () => [{ type: 'chargeChange', team: 1, level: 2, prevLevel: 1 }]],
  ['charge stolen', () => [{ type: 'chargeChange', team: 1, level: 2, prevLevel: 1 }, { type: 'chargeChange', team: 0, level: 1, prevLevel: 2 }]],
  ['charge decay', () => [{ type: 'chargeChange', team: 0, level: 2, prevLevel: 1 }, { type: 'chargeChange', team: 0, level: 1, prevLevel: 2 }]],
  ['charge lost', () => [{ type: 'chargeChange', team: -1, level: 0, prevLevel: 1 }]],
];

export const EVENTS: Array<[string, () => SimEvent[]]> = [
  ['GOAL (us, x3 SUPERNOVA)', () => [{ type: 'goal', team: 0, scorerId: 0, assistId: 1, points: 3, charge: 3, ballSpeed: 42, pos: { x: 0, y: 2, z: 51 }, ownGoal: false }]],
  ['GOAL (us, x1)', () => [{ type: 'goal', team: 0, scorerId: 0, assistId: -1, points: 1, charge: 1, ballSpeed: 25, pos: { x: 0, y: 2, z: 51 }, ownGoal: false }]],
  ['GOAL (them)', () => [{ type: 'goal', team: 1, scorerId: 3, assistId: -1, points: 1, charge: 1, ballSpeed: 25, pos: { x: 0, y: 2, z: -51 }, ownGoal: false }]],
  ['save', () => [{ type: 'save', carId: 0, epic: false }]],
  ['epic save', () => [{ type: 'save', carId: 0, epic: true }]],
  ['shot', () => [{ type: 'shot', carId: 0 }]],
  ['countdown 3', () => [{ type: 'countdown', value: 3 }]],
  ['countdown 2', () => [{ type: 'countdown', value: 2 }]],
  ['countdown 1', () => [{ type: 'countdown', value: 1 }]],
  ['GO', () => [{ type: 'kickoff' }]],
  ['surge warning', () => [{ type: 'surgeWarning', seconds: 3 }]],
  ['surge start', () => [{ type: 'surgeStart' }]],
  ['surge end', () => [{ type: 'surgeEnd' }]],
  ['overtime', () => [{ type: 'overtime' }]],
  ['clock tick 8', () => [{ type: 'clockTick', secondsLeft: 8 }]],
  ['clock tick 2', () => [{ type: 'clockTick', secondsLeft: 2 }]],
  ['match end (win)', () => [{ type: 'matchEnd', winner: 0 }]],
  ['match end (loss)', () => [{ type: 'matchEnd', winner: 1 }]],
];

const UI: UiSound[] = ['hover', 'click', 'back', 'start', 'toggle', 'error'];
const MUSIC: MusicState[] = ['off', 'menu', 'match', 'overtime', 'victory', 'defeat'];
const STINGERS: Stinger[] = ['matchStart', 'countdownGo', 'replayStart', 'replayEnd', 'victory', 'defeat'];

for (const [label, make] of SFX) button($('sfxBtns'), label, () => fire(make()));
for (const [label, make] of EVENTS) button($('eventBtns'), label, () => fire(make()), label.startsWith('GOAL') ? 'hot' : '');
for (const u of UI) button($('uiBtns'), u, () => sys.playUi(u));
const musicButtons: HTMLButtonElement[] = [];
for (const m of MUSIC) {
  const b = button($('musicBtns'), m, () => {
    sys.setMusic(m);
    for (const x of musicButtons) x.classList.toggle('on', x === b);
  });
  musicButtons.push(b);
}
for (const s of STINGERS) button($('stingerBtns'), '★ ' + s, () => sys.playStinger(s));

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

$('unlock').addEventListener('click', () => void unlock());
async function unlock(): Promise<void> {
  await sys.unlock();
  const ctx = sys.context as AudioContext | null;
  const base = ctx ? `${ctx.state} · ${ctx.sampleRate} Hz · base latency ${(ctx.baseLatency * 1000).toFixed(1)} ms` : 'Web Audio unavailable';
  $('status').textContent = base;
  attachScope();
  // Startup cost (AU-1): synchronous unlock (inside the gesture), constructor share, time until crowd + reverbs ready.
  if (ctx) {
    void sys.whenReady().then(() => {
      const init = sys.debugInfo().init as { unlockMs: number; ctorMs: number; readyMs: number; postUnlockMaxSliceMs: number };
      $('status').textContent = `${base} · unlock ${init.unlockMs} ms (ctor ${init.ctorMs}) · crowd + reverbs +${init.readyMs} ms · idle slices since ≤ ${init.postUnlockMaxSliceMs} ms`;
    });
  }
}

for (const [id, key] of [['vMaster', 'masterVolume'], ['vSfx', 'sfxVolume'], ['vMusic', 'musicVolume']] as const) {
  $<HTMLInputElement>(id).addEventListener('input', (e) => {
    settings[key] = Number((e.target as HTMLInputElement).value);
    sys.applySettings(settings);
  });
}
$<HTMLInputElement>('intensity').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('intensityV').textContent = v.toFixed(2);
  sys.setMusicIntensity(v);
});
sys.setMusicIntensity(0.4);

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault();
    keys.add(e.code);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const running = $<HTMLInputElement>('drive').checked;
  const c = world.controls;
  c.throttle = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  c.steer = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  c.boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  c.jump = keys.has('Space');
  c.powerslide = keys.has('KeyC');
  world.autoEvents = $<HTMLInputElement>('autoEv').checked;
  world.frame.playerCarId = $<HTMLInputElement>('spectator').checked ? -1 : 0;
  world.frame.paused = $<HTMLInputElement>('paused').checked;
  world.frame.replay = $<HTMLInputElement>('replay').checked;
  world.frame.timeScale = $<HTMLInputElement>('slowmo').checked ? 0.25 : 1;
  world.snap.surge = Number($<HTMLInputElement>('surge').value);
  world.snap.ball.charge = Number(($('charge') as HTMLSelectElement).value);
  if (running && !world.frame.paused) world.step(dt * world.frame.timeScale);
  if (running) {
    sys.update(dt, world.frame);
    if (world.events.length) sys.handleEvents(world.events, world.frame);
  }
  const car = world.snap.cars[0];
  $('driveInfo').textContent = `speed ${car.vel.length().toFixed(1)} m/s ${car.supersonic ? 'SUPERSONIC' : ''} ${car.boosting ? 'BOOST' : ''} · update ${(sys.stats.lastUpdateMs * 1000).toFixed(0)} µs`;
  const info = sys.debugInfo();
  const mi = info.music as { state: string; section: number; bar: number; tier: number; bpm: number } | null;
  $('musicInfo').textContent = mi ? `${mi.state} · ${mi.bpm} BPM · section ${mi.section} bar ${mi.bar} · tier ${mi.tier} · voices ${info.voices} · crowd ${info.crowdTextures ? 'choir' : 'noise'}` : '';
  drawScope();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

let analyser: AnalyserNode | null = null;
let scopeBuf: Float32Array<ArrayBuffer> | null = null;
function attachScope(): void {
  const ctx = sys.context;
  const out = sys.outputNode;
  if (!ctx || !out || analyser) return;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  out.connect(analyser);
  scopeBuf = new Float32Array(analyser.fftSize);
}
function drawScope(): void {
  const cv = $<HTMLCanvasElement>('scope');
  const g = cv.getContext('2d');
  if (!g) return;
  g.fillStyle = '#03050a';
  g.fillRect(0, 0, cv.width, cv.height);
  if (!analyser || !scopeBuf) return;
  analyser.getFloatTimeDomainData(scopeBuf);
  let peak = 0;
  g.strokeStyle = '#1ec8ff';
  g.beginPath();
  for (let i = 0; i < scopeBuf.length; i++) {
    const x = (i / scopeBuf.length) * cv.width;
    const v = scopeBuf[i];
    peak = Math.max(peak, Math.abs(v));
    const y = cv.height / 2 - v * (cv.height / 2);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = peak > 0.95 ? '#ff4040' : '#8be9ff';
  g.fillText(`peak ${peak.toFixed(3)}`, 8, 14);
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

let lastReport: OfflineReport | null = null;
$('offline').addEventListener('click', () => void offline());
async function offline(groups?: CheckOptions['groups']): Promise<OfflineReport> {
  $('checkStatus').textContent = 'rendering…';
  const r = await runOfflineChecks({ groups, onProgress: (l) => ($('checkStatus').textContent = 'rendering ' + l) });
  lastReport = r;
  $('checkStatus').textContent = `${r.results.length} renders, ${r.failures} failures`;
  $('report').textContent = formatReport(r);
  return r;
}

$('bench').addEventListener('click', () => void bench());
$('simMatch').addEventListener('click', () => {
  $('checkStatus').textContent = 'simulating + rendering…';
  void simMatch(30, 3).then((r) => {
    $('checkStatus').textContent = 'sim match done';
    $('report').textContent = JSON.stringify(r, null, 2);
  });
});
/** Measures AudioSystem.update() on a live context with a 3v3 world (perFrame updates per animation frame, dt = 1/(60·perFrame)). */
async function bench(frames = 150, perFrame = 4): Promise<{ meanUs: number; p95Us: number; maxUs: number; calls: number }> {
  await sys.unlock();
  const w = new FakeWorld(3);
  w.autoEvents = false;
  w.controls.throttle = 1;
  const times: number[] = [];
  const dt = 1 / (60 * perFrame);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < perFrame; i++) {
      w.controls.boost = f % 60 > 30;
      w.step(dt);
      const t0 = performance.now();
      sys.update(dt, w.frame);
      times.push(performance.now() - t0);
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  times.sort((a, b) => a - b);
  const res = {
    meanUs: (times.reduce((a, b) => a + b, 0) / times.length) * 1000,
    p95Us: times[Math.floor(times.length * 0.95)] * 1000,
    maxUs: times[times.length - 1] * 1000,
    calls: times.length,
  };
  $('report').textContent = `update() live benchmark (3v3, ${res.calls} calls): mean ${res.meanUs.toFixed(1)} µs · p95 ${res.p95Us.toFixed(1)} µs · max ${res.maxUs.toFixed(1)} µs`;
  return res;
}

/** Headless smoke test: unlock, fire every sound / state, drive the world, report errors + diagnostics. */
async function selfTest(): Promise<Record<string, unknown>> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await unlock();
  await sys.whenReady();
  $<HTMLInputElement>('drive').checked = true;
  $<HTMLInputElement>('autoEv').checked = true;
  for (const [, make] of SFX) {
    fire(make());
    await wait(40);
  }
  for (const [, make] of EVENTS) {
    fire(make());
    await wait(60);
  }
  for (const u of UI) sys.playUi(u);
  for (const m of MUSIC) {
    sys.setMusic(m);
    await wait(120);
  }
  sys.setMusic('match');
  for (const s of STINGERS) {
    sys.playStinger(s);
    await wait(80);
  }
  // Drive: throttle + boost for 2 s.
  keys.add('KeyW');
  keys.add('ShiftLeft');
  await wait(2000);
  keys.clear();
  const info = sys.debugInfo();
  return { errors, info, ctxState: (sys.context as AudioContext | null)?.state ?? null };
}

/** Degraded-environment test: no Web Audio at all → every method must be a silent no-op. */
async function noAudioTest(): Promise<{ ok: boolean; error?: string }> {
  const g = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const saved = [g.AudioContext, g.webkitAudioContext];
  try {
    g.AudioContext = undefined;
    g.webkitAudioContext = undefined;
    const a = new AudioSystem();
    a.applySettings(settings);
    a.setMusic('match');
    a.setMusicIntensity(0.5);
    a.playUi('click');
    a.playStinger('victory');
    a.update(0.016, world.frame);
    for (const [, make] of [...SFX, ...EVENTS]) a.handleEvents(make(), world.frame);
    await a.unlock();
    a.update(0.016, world.frame);
    a.dispose();
    a.dispose();
    a.update(0.016, world.frame);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    g.AudioContext = saved[0];
    g.webkitAudioContext = saved[1];
  }
}

/**
 * Integration test against the REAL simulation: a 3v3 World driven by simple scripted "chase the ball" controls
 * (the AI module is developed in parallel), rendered offline at 60 fps: snapshots + drained events feed
 * AudioSystem.update() / handleEvents() exactly like the game loop will. Reports event rates, voice-pool stats,
 * output levels and any errors.
 */
async function simMatch(seconds = 30, teamSize: 1 | 2 | 3 = 3): Promise<Record<string, unknown>> {
  const sim = await import('../src/sim/index');
  const SR = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const a = new AudioSystem();
  a.applySettings(settings);
  await a.attachContext(ctx);
  const world = new sim.World({
    teamSize,
    durationSec: 180,
    difficulty: 'pro',
    seed: 1234,
    freePlay: false,
    mutators: { charge: true, pulse: true, surges: true, demolitions: true },
    player: { name: 'PLAYER', style: 'striker', paint: '#e8eef7' },
  });
  const n = world.cars.length;
  const inputs = world.cars.map(() => sim.makeControlState());
  const snap = sim.makeSnapshot(n, world.pads.length);
  const frame = {
    listenerPos: new Vector3(),
    listenerQuat: new Quaternion(),
    snap,
    playerCarId: 0,
    phase: snap.phase,
    timeScale: 1,
    paused: false,
    replay: false,
  };
  const counts: Record<string, number> = {};
  const errs: string[] = [];
  const fwd = new Vector3();
  const right = new Vector3();
  const to = new Vector3();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  a.setMusicIntensity(0.5);
  a.setMusic('match');
  const dt = 1 / 60;
  let simAcc = 0;
  for (let i = 1; i * dt < seconds - 0.02; i++) {
    const t = i * dt;
    ctx
      .suspend(t)
      .then(() => {
        try {
          simAcc += dt;
          while (simAcc >= sim.DT) {
            simAcc -= sim.DT;
            for (let c = 0; c < n; c++) {
              const car = world.cars[c];
              const k = inputs[c];
              fwd.set(0, 0, 1).applyQuaternion(car.quat);
              right.set(-1, 0, 0).applyQuaternion(car.quat);
              to.subVectors(world.ball.pos, car.pos);
              const ang = Math.atan2(to.dot(right), to.dot(fwd));
              const dist = to.length();
              k.throttle = 1;
              k.steer = Math.max(-1, Math.min(1, ang * 2.2));
              k.yaw = k.steer;
              k.boost = Math.abs(ang) < 0.35 && dist > 12 && car.boost > 5;
              k.jump = dist < 5 && world.ball.pos.y > 1.6 ? rnd() < 0.5 : rnd() < 0.002;
              k.pitch = k.jump ? -1 : 0;
              k.pulse = rnd() < 0.0015;
            }
            world.step(inputs);
          }
          world.writeSnapshot(snap);
          frame.phase = snap.phase;
          // Chase camera behind car 0.
          const c0 = snap.cars[0];
          fwd.set(0, 0, 1).applyQuaternion(c0.quat);
          fwd.y = 0;
          if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
          fwd.normalize();
          frame.listenerPos.set(c0.pos.x - fwd.x * 3.4, c0.pos.y + 1.25, c0.pos.z - fwd.z * 3.4);
          frame.listenerQuat.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z) + Math.PI);
          const evs = world.drainEvents();
          for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
          a.update(dt, frame as never);
          if (evs.length) a.handleEvents(evs, frame as never);
        } catch (e) {
          errs.push(String(e));
        }
        return ctx.resume();
      })
      .catch((e) => errs.push('suspend: ' + String(e)));
  }
  const buf = await ctx.startRendering();
  const info = a.debugInfo();
  a.dispose();
  let peak = 0;
  let sum = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const x = Math.abs(d[i]);
      if (x > peak) peak = x;
      sum += d[i] * d[i];
    }
  }
  const perMin: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) perMin[k] = Math.round((v / seconds) * 60);
  return {
    simSeconds: seconds,
    score: world.match.score,
    eventsPerMinute: perMin,
    peak: +peak.toFixed(3),
    rmsDb: +(10 * Math.log10(sum / (2 * buf.length))).toFixed(1),
    voices: { stolen: info.stolen, dropped: info.dropped, created: undefined },
    errors: errs.slice(0, 5),
    audioWarnings: info,
  };
}

declare global {
  interface Window {
    __audio: Record<string, unknown>;
  }
}

window.__audio = {
  sys,
  get world() {
    return world;
  },
  resetWorld: (teamSize = 3) => (world = new FakeWorld(teamSize)),
  unlock,
  fire,
  SFX,
  EVENTS,
  offline,
  offlineText: async (groups?: CheckOptions['groups']) => formatReport(await offline(groups)),
  lastReport: () => lastReport,
  bench,
  profile: profileComponents,
  selfTest,
  simMatch,
  noAudioTest,
  errors,
};
