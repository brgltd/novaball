/**
 * UI sandbox: renders the NOVABALL UI over a fake animated arena (2D canvas stand-in for the 3D scene),
 * with a fake HudState that evolves over time, URL params to jump to any screen, and a dev panel (F2).
 *
 * URL params:
 *   screen = loading | main | setup | garage | settings | controls | tutorial | confirm | hud | pause | end | overlay
 *   t      = start time (s) of the fake match timeline     freeze=1  → keep t fixed
 *   state  = normal | supernova | surge | warning | overtime | freeplay | replay | dead | lowboost | full
 *   notify = goal | goal1 | goal2 | owngoal | overtime | surge | save | epic | demo | feed | supernova
 *   cd     = 3 | 2 | 1 | GO        result = victory | defeat | draw        tab = graphics | camera | audio | controls
 *   device = gamepad (force gamepad glyphs)       dev=0 (hide dev panel)     tutorial=1 (first-time flow)
 *   end screen: score=a-b  diff=rookie|pro|legend  size=1|2|3  hash=1 (VERIFIABLE MATCH hash)  ot=1
 *   feed=1 → feed the sampled controls to ui.updatePlayerControls() (like the game) instead of the key fallback
 * FIRST FLIGHT coach: counted in localStorage 'novaball.coach.v1' (remove it to see the coach again).
 */
import type { HudNotification, HudState, MatchSummary, PlayerLine, UiSound } from '../src/contracts';
import { InputSystem } from '../src/input/InputSystem';
import { inputHub } from '../src/input/InputHub';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../src/settings';
import { makeControlState, makePlayerStats, type MatchConfig, type Team } from '../src/sim/types';
import { UIManager } from '../src/ui/UIManager';

const params = new URLSearchParams(location.search);
const P = (k: string, d = '') => params.get(k) ?? d;

// ------------------------------------------------------------------------------------------ fake 3D scene

const canvas = document.getElementById('game') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
let W = 0;
let H = 0;
function resize() {
  W = canvas.width = Math.round(innerWidth);
  H = canvas.height = Math.round(innerHeight);
}
resize();
addEventListener('resize', resize);

const starField = Array.from({ length: 220 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1), y: r(2) * 0.5, s: r(3) * 1.6 + 0.3, a: r(4) * 0.7 + 0.3, tw: r(5) * 6 };
});

function drawScene(t: number, mode: string) {
  const hz = H * 0.46;
  // sky
  const sky = g.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#04050f');
  sky.addColorStop(1, '#0b0d2a');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const neb = (x: number, y: number, r: number, c: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, c);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  };
  neb(W * 0.25, H * 0.12, W * 0.45, 'rgba(120,40,200,0.30)');
  neb(W * 0.78, H * 0.2, W * 0.4, 'rgba(20,150,220,0.22)');
  neb(W * 0.6, H * 0.02, W * 0.3, 'rgba(210,50,160,0.16)');
  for (const s of starField) {
    g.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * 2 + s.tw));
    g.fillStyle = '#fff';
    g.fillRect(s.x * W, s.y * H, s.s, s.s);
  }
  g.globalAlpha = 1;
  // gas giant
  const px = W * 0.82;
  const py = hz + H * 0.02;
  const pr = H * 0.36;
  const pg = g.createRadialGradient(px - pr * 0.3, py - pr * 0.4, pr * 0.1, px, py, pr);
  pg.addColorStop(0, '#6b4bb8');
  pg.addColorStop(0.6, '#2a1a5e');
  pg.addColorStop(1, '#0b0820');
  g.fillStyle = pg;
  g.beginPath();
  g.arc(px, py, pr, Math.PI, 2 * Math.PI);
  g.fill();
  g.strokeStyle = 'rgba(140,200,255,0.55)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(px, py, pr, Math.PI * 1.05, Math.PI * 1.95);
  g.stroke();
  g.strokeStyle = 'rgba(220,190,255,0.35)';
  g.lineWidth = 3;
  g.beginPath();
  g.ellipse(px, py - pr * 0.08, pr * 1.6, pr * 0.22, -0.08, Math.PI * 1.02, Math.PI * 1.98);
  g.stroke();
  // stands glow band
  const band = g.createLinearGradient(0, hz - H * 0.08, 0, hz);
  band.addColorStop(0, 'rgba(30,60,140,0)');
  band.addColorStop(1, 'rgba(40,90,200,0.35)');
  g.fillStyle = band;
  g.fillRect(0, hz - H * 0.08, W, H * 0.08);
  for (let i = 0; i < 180; i++) {
    const x = ((i * 97.13) % 1) * W + (i * 37) % W;
    const y = hz - H * 0.015 - ((i * 13) % 17) * H * 0.003;
    const on = Math.sin(t * 3 + i) > 0.3;
    g.fillStyle = i % 3 === 0 ? `rgba(255,120,40,${on ? 0.8 : 0.3})` : `rgba(60,200,255,${on ? 0.8 : 0.3})`;
    g.fillRect(x % W, y, 2, 2);
  }
  // floor
  const fl = g.createLinearGradient(0, hz, 0, H);
  fl.addColorStop(0, '#060a1a');
  fl.addColorStop(1, '#020309');
  g.fillStyle = fl;
  g.fillRect(0, hz, W, H - hz);
  // perspective grid
  const cx = W * 0.5 + Math.sin(t * 0.3) * W * 0.04;
  const speed = mode === 'hud' ? 6 : 1.5;
  g.lineWidth = 1;
  for (let i = -24; i <= 24; i++) {
    const x0 = cx + i * W * 0.012;
    const x1 = cx + i * W * 0.2;
    g.strokeStyle = i === 0 ? 'rgba(160,190,255,0.55)' : 'rgba(40,70,140,0.35)';
    g.beginPath();
    g.moveTo(x0, hz);
    g.lineTo(x1, H);
    g.stroke();
  }
  for (let k = 0; k < 40; k++) {
    const z = ((k + ((t * speed) % 1)) / 40) ** 2.2;
    const y = hz + z * (H - hz);
    g.strokeStyle = `rgba(40,70,140,${0.12 + z * 0.35})`;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  // far goal (orange)
  const gw = W * 0.09;
  const gh = H * 0.05;
  g.strokeStyle = '#ff7a2a';
  g.shadowColor = '#ff6a1a';
  g.shadowBlur = 18;
  g.lineWidth = 4;
  g.strokeRect(cx - gw / 2, hz - gh, gw, gh);
  g.shadowBlur = 0;
  neb(cx, hz - gh / 2, gw, 'rgba(255,106,26,0.2)');
  // center circle
  g.strokeStyle = 'rgba(159,184,255,0.5)';
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(cx, hz + (H - hz) * 0.32, W * 0.16, (H - hz) * 0.08, 0, 0, Math.PI * 2);
  g.stroke();
  // ball
  const bx = cx + Math.sin(t * 0.9) * W * 0.12;
  const by = hz + (H - hz) * 0.25 - Math.abs(Math.sin(t * 1.7)) * H * 0.12;
  const br = H * 0.028;
  neb(bx, by, br * 6, 'rgba(139,233,255,0.35)');
  const bgr = g.createRadialGradient(bx - br * 0.3, by - br * 0.3, 0, bx, by, br);
  bgr.addColorStop(0, '#fff');
  bgr.addColorStop(0.5, '#bfefff');
  bgr.addColorStop(1, '#2a8fff');
  g.fillStyle = bgr;
  g.beginPath();
  g.arc(bx, by, br, 0, Math.PI * 2);
  g.fill();
  // opponent cars
  for (let i = 0; i < 3; i++) {
    const ox = cx + Math.sin(t * 0.6 + i * 2.1) * W * 0.2;
    const oy = hz + (H - hz) * (0.1 + i * 0.05);
    neb(ox, oy, W * 0.03, 'rgba(255,106,26,0.5)');
    g.fillStyle = '#ffb07a';
    g.fillRect(ox - 10, oy - 3, 20, 6);
  }
  // player car (chase cam)
  if (mode === 'hud') {
    const cxp = W * 0.5;
    const cyp = H * 0.8;
    neb(cxp, cyp + H * 0.03, W * 0.12, 'rgba(30,200,255,0.35)');
    g.fillStyle = '#dfe8f5';
    g.beginPath();
    g.moveTo(cxp - W * 0.07, cyp + H * 0.04);
    g.lineTo(cxp - W * 0.05, cyp - H * 0.03);
    g.lineTo(cxp + W * 0.05, cyp - H * 0.03);
    g.lineTo(cxp + W * 0.07, cyp + H * 0.04);
    g.closePath();
    g.fill();
    g.fillStyle = '#0b1426';
    g.fillRect(cxp - W * 0.035, cyp - H * 0.028, W * 0.07, H * 0.025);
    g.fillStyle = '#1ec8ff';
    g.shadowColor = '#1ec8ff';
    g.shadowBlur = 20;
    g.fillRect(cxp - W * 0.065, cyp + H * 0.03, W * 0.03, 4);
    g.fillRect(cxp + W * 0.035, cyp + H * 0.03, W * 0.03, 4);
    g.shadowBlur = 0;
  }
}

// ------------------------------------------------------------------------------------------ fake match state

const NAMES: Array<[string, Team, boolean]> = [
  ['PLAYER', 0, false],
  ['VEGA', 0, true],
  ['ORION', 0, true],
  ['ZEPHYR', 1, true],
  ['QUASAR', 1, true],
  ['LYRA', 1, true],
];

function fakeLines(scale: number, playerName: string): PlayerLine[] {
  return NAMES.map(([name, team, bot], id) => {
    const s = makePlayerStats();
    const k = (id * 37) % 5;
    s.goals = Math.floor(scale * ((k % 3) + (id === 0 ? 1 : 0)));
    s.assists = Math.floor(scale * (k % 2));
    s.saves = Math.floor(scale * ((id + 1) % 3));
    s.shots = s.goals + Math.floor(scale * (k + 1));
    s.demos = Math.floor(scale * (id % 2));
    s.touches = 10 + id * 3;
    s.hardestHit = 28 + id * 2.5;
    s.score = s.goals * 100 + s.assists * 50 + s.saves * 50 + s.shots * 20 + s.demos * 25 + s.touches * 2;
    return { id, name: id === 0 ? playerName : name, team, isPlayer: id === 0, isBot: bot, stats: s };
  });
}

const settings: Settings = loadSettings();
if (P('tutorial') === '1') settings.seenTutorial = false;
if (P('style')) settings.carStyle = P('style') as Settings['carStyle'];
if (P('paint')) settings.paint = P('paint');
if (P('name')) settings.playerName = P('name');

const soundLog: UiSound[] = [];
const eventLog: string[] = [];
let lastStart: MatchConfig | null = null;

function fakeHud(t: number, state: string): HudState {
  const tt = Math.max(0, t);
  const cycle = tt % 60;
  const boosting = Math.sin(tt * 0.9) > 0.1;
  const boost = state === 'lowboost' ? 8 : state === 'full' ? 100 : Math.round(50 + 50 * Math.sin(tt * 0.45));
  const speed = 12 + 11.5 * Math.max(0, Math.sin(tt * 0.6));
  let charge = cycle < 8 ? 0 : cycle < 12 ? 1 : cycle < 16 ? 2 : cycle < 20 ? 3 : cycle < 30 ? 0 : cycle < 34 ? 1 : cycle < 38 ? 2 : 0;
  let chargeTeam: Team | -1 = charge === 0 ? -1 : cycle < 20 ? 0 : 1;
  let surge: HudState['surge'] = cycle >= 40 && cycle < 43 ? { state: 'warning', timeLeft: 43 - cycle } : cycle >= 43 && cycle < 53 ? { state: 'active', timeLeft: 53 - cycle } : { state: 'idle', timeLeft: 0 };
  if (state === 'supernova') {
    charge = 3;
    chargeTeam = 0;
  }
  if (state === 'surge') surge = { state: 'active', timeLeft: 6.4 };
  if (state === 'warning') surge = { state: 'warning', timeLeft: 2.2 };
  const clock = Math.max(0, 180 - tt);
  const overtime = state === 'overtime';
  const indVisible = (cycle > 25 && cycle < 35) || state === 'ball';
  const ang = tt * 0.8;
  const ix = W / 2 + Math.cos(ang) * (W / 2 - 60);
  const iy = H / 2 + Math.sin(ang) * (H / 2 - 60);
  const score: [number, number] = [Math.floor(tt / 60) + (cycle >= 20 ? 1 : 0), Math.floor(tt / 90)];
  return {
    freePlay: state === 'freeplay',
    teamNames: ['VOLT', 'BLAZE'],
    playerTeam: 0,
    score: state === 'overtime' ? [2, 2] : score,
    clock: overtime ? 0 : state === 'final' ? 7.2 : clock,
    overtime,
    overtimeElapsed: overtime ? 42.3 : 0,
    phase: cycle < 3 && tt < 3 ? 'countdown' : 'playing',
    countdown: Math.max(0, 3 - tt),
    boost: boosting && state !== 'full' && state !== 'lowboost' ? boost : boost,
    speed,
    supersonic: speed > 21.5 || state === 'full',
    pulseEnabled: true,
    pulseReady01: state === 'lowboost' ? 0.35 : Math.min(1, ((tt + 4) % 14) / 10),
    chargeEnabled: true,
    charge,
    chargeTeam,
    surge,
    ballCam: Math.floor(tt / 7) % 2 === 0,
    ballIndicator: { visible: indVisible, x: ix, y: iy, angle: ang },
    replay: state === 'replay',
    fps: 58 + Math.round(3 * Math.sin(tt * 3)),
    showFps: settings.showFps || P('fps') === '1',
    respawnIn: state === 'dead' ? 2.3 : cycle > 36 && cycle < 39 ? 39 - cycle : 0,
    scoreboard: fakeLines(1 + Math.floor(tt / 30), settings.playerName),
    // optional (not in the contract yet): CORE CHARGE decay window elapsed, 0..1
    chargeDecay01: charge > 0 ? (tt % 4) / 4 : 0,
  } as HudState;
}

// ------------------------------------------------------------------------------------------ UI + input

let screen = 'loading';
let simT = Number(P('t', '0')) || 0;
const freeze = P('freeze') === '1';
let hudState = P('state', 'normal');
let replay = hudState === 'replay';
let ballCamToggle = false;
let feedControls = P('feed') === '1';

const ui = new UIManager(document.getElementById('ui')!, settings, {
  onStartMatch(cfg) {
    lastStart = cfg;
    eventLog.push(`start:${JSON.stringify(cfg)}`);
    hudState = cfg.freePlay ? 'freeplay' : 'normal';
    simT = 0;
    fired.clear();
    setScreen('hud');
  },
  onResume() {
    eventLog.push('resume');
    setScreen('hud');
  },
  onRestart() {
    eventLog.push('restart');
    simT = 0;
    fired.clear();
    setScreen('hud');
  },
  onQuitToMenu() {
    eventLog.push('quit');
    setScreen('main');
  },
  onSettingsChanged(s) {
    eventLog.push('settings');
    input.applySettings(s);
  },
  onUiSound(s) {
    soundLog.push(s);
    if (soundLog.length > 200) soundLog.shift();
  },
  onUserGesture() {
    eventLog.push('gesture');
  },
});
const input = new InputSystem(canvas);
input.applySettings(settings);

function setScreen(s: string) {
  screen = s;
  const sub: Record<string, 'setup' | 'garage' | 'settings' | 'controls' | 'tutorial'> = {
    setup: 'setup',
    garage: 'garage',
    settings: 'settings',
    controls: 'controls',
    tutorial: 'tutorial',
  };
  if (sub[s]) {
    ui.showScreen('main');
    ui.openPanel(sub[s]);
    screen = 'main';
    return;
  }
  if (s === 'confirm') {
    ui.showScreen('pause');
    (document.querySelector('.nb-pause-btn:nth-child(6)') as HTMLElement | null)?.click();
    screen = 'pause';
    return;
  }
  if (s === 'end') {
    ui.showEndScreen(fakeSummary(P('result', 'victory')));
    return;
  }
  if (s === 'overlay') {
    ui.showScreen('hud');
    screen = 'overlay';
    ui.updateHUD(fakeHud(simT, hudState));
    ui.setScoreboardVisible(true);
    return;
  }
  ui.showScreen(s as 'loading' | 'main' | 'hud' | 'pause' | 'end' | 'none');
  if (s === 'hud' || s === 'pause') ui.updateHUD(fakeHud(simT, hudState));
}

function fakeSummary(result: string): MatchSummary & { hash?: number } {
  const players = fakeLines(2, settings.playerName);
  const winner: Team | -1 = result === 'defeat' ? 1 : result === 'draw' ? -1 : 0;
  let score: [number, number] = result === 'defeat' ? [2, 5] : result === 'draw' ? [3, 3] : [5, 3];
  // score=a-b (e.g. 0-4), diff=rookie|pro|legend, hash=1 (optional deterministic hash), size=1|2|3
  const sc = P('score').split('-').map(Number);
  if (sc.length === 2 && sc.every((n) => Number.isFinite(n))) score = [sc[0], sc[1]];
  const size = (Number(P('size', '3')) || 3) as 1 | 2 | 3;
  const lines = players.filter((p) => (p.team === 0 ? p.id : p.id - 3) < size).map((p, i) => ({ ...p, id: i }));
  return {
    winner,
    score,
    playerTeam: 0,
    players: lines,
    mvpId: result === 'defeat' ? lines.findIndex((p) => p.team === 1) : 0,
    config: { teamSize: size, durationSec: 180, difficulty: (P('diff', 'pro') as MatchConfig['difficulty']), seed: 0x5eed1234, freePlay: false, mutators: { ...DEFAULT_SETTINGS.lastMutators }, player: null },
    overtime: result === 'victory' && P('ot') === '1',
    ...(P('hash') === '1' ? { hash: 0x9a3f21c0 } : {}),
  };
}

const NOTIFS: Record<string, HudNotification> = {
  goal: { kind: 'goal', title: 'GOAL!', subtitle: 'PLAYER · 104 KM/H', team: 0, points: 3, big: true },
  goal2: { kind: 'goal', title: 'GOAL!', subtitle: 'ZEPHYR · 88 KM/H', team: 1, points: 2, big: true },
  goal1: { kind: 'goal', title: 'GOAL!', subtitle: 'VEGA · 71 KM/H', team: 0, points: 1, big: true },
  owngoal: { kind: 'ownGoal', title: 'OWN GOAL', subtitle: 'QUASAR', team: 0, points: 1, big: true },
  overtime: { kind: 'overtime', title: 'OVERTIME', subtitle: 'NEXT GOAL WINS', big: true },
  surge: { kind: 'surge', title: 'ZERO-G SURGE', subtitle: 'GRAVITY 30% · 10 SECONDS', big: true },
  supernova: { kind: 'supernova', title: 'SUPERNOVA', subtitle: 'VOLT CORE AT LEVEL III', team: 0, big: true },
  demo: { kind: 'demolished', title: 'DEMOLISHED', subtitle: 'BY ZEPHYR', team: 1, big: true },
  epic: { kind: 'epicSave', title: 'EPIC SAVE', subtitle: 'PLAYER', team: 0, points: 75, big: true },
  save: { kind: 'save', title: 'SAVE', subtitle: 'VEGA', team: 0, points: 50 },
  shot: { kind: 'shot', title: 'SHOT ON GOAL', subtitle: 'PLAYER', team: 0, points: 20 },
  assist: { kind: 'assist', title: 'ASSIST', subtitle: 'ORION', team: 0, points: 50 },
  demoFeed: { kind: 'demolition', title: 'DEMOLITION', subtitle: 'PLAYER → LYRA', team: 0, points: 25 },
  charge: { kind: 'charge', title: 'CORE CHARGED II', subtitle: 'BLAZE', team: 1 },
  lastMinute: { kind: 'lastMinute', title: 'LAST MINUTE', subtitle: '60 SECONDS LEFT · MAKE IT COUNT', big: true },
  surgeWarn: { kind: 'surge', title: 'ZERO-G SURGE IN 3…', subtitle: 'BRACE FOR LOW GRAVITY', big: true },
  surgeStart: { kind: 'surge', title: 'ZERO-G SURGE!', subtitle: 'LOW GRAVITY · 10 SECONDS · TAKE FLIGHT', big: true },
  demolition: { kind: 'demolition', title: 'DEMOLITION!', subtitle: 'LYRA DESTROYED', team: 0, points: 25, big: true },
  fullTime: { kind: 'info', title: 'FULL TIME', subtitle: 'VOLT WINS 3 – 1', big: true },
};

// Timeline of events while running (fires once each per run).
const TIMELINE: Array<[number, () => void]> = [
  [0.02, () => ui.showCountdown(3)],
  [1, () => ui.showCountdown(2)],
  [2, () => ui.showCountdown(1)],
  [3, () => ui.showCountdown('GO')],
  [4.2, () => ui.showCountdown(null)],
  [6, () => ui.notify(NOTIFS.shot)],
  [9, () => ui.notify(NOTIFS.save)],
  [16, () => ui.notify(NOTIFS.supernova)],
  [20, () => ui.notify(NOTIFS.goal)],
  [20.3, () => ui.notify(NOTIFS.assist)],
  [26, () => ui.notify(NOTIFS.demoFeed)],
  [34, () => ui.notify(NOTIFS.charge)],
  [36, () => ui.notify(NOTIFS.demo)],
  [40, () => ui.notify({ ...NOTIFS.surge, title: 'ZERO-G SURGE INCOMING', subtitle: 'BRACE FOR LOW GRAVITY' })],
  [48, () => ui.notify(NOTIFS.epic)],
];
const fired = new Set<number>();

// ------------------------------------------------------------------------------------------ dev panel

const dev = document.getElementById('dev')!;
if (P('dev') === '0') dev.classList.add('hidden');
const statsEl = document.createElement('pre');
function devButtons() {
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const row = (title: string, items: Array<[string, () => void]>) => {
    const d = document.createElement('div');
    d.innerHTML = `<b>${title}</b><br>`;
    for (const [l, f] of items) d.append(mk(l, f));
    dev.append(d);
  };
  row('screens', ['loading', 'main', 'setup', 'garage', 'settings', 'controls', 'tutorial', 'hud', 'pause', 'end', 'overlay'].map((s) => [s, () => setScreen(s)]));
  row('hud state', ['normal', 'supernova', 'surge', 'warning', 'overtime', 'freeplay', 'replay', 'dead', 'lowboost', 'full', 'final'].map((s) => [s, () => ((hudState = s), (replay = s === 'replay'), ui.setReplay(replay))]));
  row('notify', Object.keys(NOTIFS).map((k) => [k, () => ui.notify(NOTIFS[k])]));
  row('countdown', [
    ['3', () => ui.showCountdown(3)],
    ['2', () => ui.showCountdown(2)],
    ['1', () => ui.showCountdown(1)],
    ['GO', () => ui.showCountdown('GO')],
    ['hide', () => ui.showCountdown(null)],
    ['restart t', () => ((simT = 0), fired.clear())],
  ]);
  dev.append(statsEl);
}
devButtons();
addEventListener('keydown', (e) => {
  if (e.code === 'F2') dev.classList.toggle('hidden');
});

// ------------------------------------------------------------------------------------------ loop

const ctl = makeControlState();
const inputStats = {
  frames: 0,
  maxThrottle: 0,
  minThrottle: 0,
  maxSteer: 0,
  minSteer: 0,
  maxPitch: 0,
  minRoll: 0,
  maxRoll: 0,
  jump: 0,
  boost: 0,
  slide: 0,
  pulse: 0,
  actions: { ballCam: 0, pause: 0, skipReplay: 0, resetFreePlay: 0, scoreboard: 0 } as Record<string, number>,
  scoreboardHeldFrames: 0,
};

let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fps = 60;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  if (P('scene') !== '0') drawScene(now / 1000, ui.screen === 'hud' || ui.screen === 'pause' ? 'hud' : 'menu');
  else if (inputStats.frames === 0) {
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, W, H);
  }

  // input (like Game.ts would do)
  input.update();
  input.enabled = ui.screen === 'hud' && !replay;
  input.sample(ctl);
  inputStats.frames++;
  inputStats.maxThrottle = Math.max(inputStats.maxThrottle, ctl.throttle);
  inputStats.minThrottle = Math.min(inputStats.minThrottle, ctl.throttle);
  inputStats.maxSteer = Math.max(inputStats.maxSteer, ctl.steer);
  inputStats.minSteer = Math.min(inputStats.minSteer, ctl.steer);
  inputStats.maxPitch = Math.max(inputStats.maxPitch, ctl.pitch);
  inputStats.minRoll = Math.min(inputStats.minRoll, ctl.roll);
  inputStats.maxRoll = Math.max(inputStats.maxRoll, ctl.roll);
  if (ctl.jump) inputStats.jump++;
  if (ctl.boost) inputStats.boost++;
  if (ctl.powerslide) inputStats.slide++;
  if (ctl.pulse) inputStats.pulse++;
  if (feedControls) ui.updatePlayerControls(ui.screen === 'hud' && !replay ? ctl : null);
  if (ui.screen === 'hud') {
    if (input.consume('pause')) {
      inputStats.actions.pause++;
      ui.showScreen('pause');
    }
    if (input.consume('ballCam')) {
      inputStats.actions.ballCam++;
      ballCamToggle = !ballCamToggle;
    }
    if (input.consume('skipReplay')) {
      inputStats.actions.skipReplay++;
      if (replay) {
        replay = false;
        hudState = 'normal';
        ui.setReplay(false);
      }
    }
    if (input.consume('resetFreePlay')) inputStats.actions.resetFreePlay++;
    const sb = input.isHeld('scoreboard');
    if (sb) inputStats.scoreboardHeldFrames++;
    if (screen !== 'overlay') ui.setScoreboardVisible(sb);
  }

  if ((ui.screen === 'hud' || ui.screen === 'pause') && !(window as unknown as { __freezeLoop?: boolean }).__freezeLoop) {
    if (!freeze && ui.screen === 'hud') simT += dt;
    if (!freeze && ui.screen === 'hud') {
      for (let i = 0; i < TIMELINE.length; i++) {
        if (!fired.has(i) && simT >= TIMELINE[i][0] && simT - TIMELINE[i][0] < 1.5) {
          fired.add(i);
          TIMELINE[i][1]();
        }
      }
      if (simT > 60) {
        simT = 4.5;
        fired.clear();
        for (let i = 0; i < 5; i++) fired.add(i);
      }
    }
    const hs = fakeHud(simT, hudState);
    hs.fps = fps;
    if (ballCamToggle) hs.ballCam = !hs.ballCam;
    ui.updateHUD(hs);
  }
  if (!dev.classList.contains('hidden') && inputStats.frames % 10 === 0) {
    statsEl.textContent = `screen ${ui.screen} dev ${inputHub.lastDevice} t ${simT.toFixed(1)}\nthr ${ctl.throttle.toFixed(2)} str ${ctl.steer.toFixed(2)} pit ${ctl.pitch.toFixed(2)} rol ${ctl.roll.toFixed(2)}\n${ctl.jump ? 'JUMP ' : ''}${ctl.boost ? 'BOOST ' : ''}${ctl.powerslide ? 'SLIDE ' : ''}${ctl.pulse ? 'PULSE' : ''}\nsounds: ${soundLog.slice(-6).join(',')}`;
  }
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------------------------------ boot sequence

if (P('device') === 'gamepad') inputHub.setDevice('gamepad');
const target = P('screen', 'loading');
if (target === 'loading' && P('boot') !== '0') {
  ui.showScreen('loading');
  const labels = ['Baking nebula', 'Forging arena', 'Charging Nova Core', 'Compiling shaders', 'Warming thrusters'];
  let p = 0;
  const timer = setInterval(() => {
    p = Math.min(1, p + 0.012);
    ui.setLoading(p, labels[Math.min(labels.length - 1, Math.floor(p * labels.length))]);
    if (P('hold') === '1' && p >= Number(P('p', '0.62'))) clearInterval(timer);
    else if (p >= 1) {
      clearInterval(timer);
      setTimeout(() => setScreen('main'), 300);
    }
  }, 30);
} else {
  if (target === 'hud' || target === 'pause' || target === 'overlay') {
    ui.showScreen('hud');
    ui.updateHUD(fakeHud(simT, hudState));
    if (replay) ui.setReplay(true);
  }
  setScreen(target);
  const tab = P('tab');
  if (tab) {
    const i = ['graphics', 'camera', 'audio', 'controls'].indexOf(tab);
    const btn = document.querySelectorAll<HTMLElement>('.nb-tab')[i];
    btn?.click();
  }
  const n = P('notify');
  if (n) for (const k of n.split(',')) if (NOTIFS[k]) ui.notify(NOTIFS[k]);
  const cd = P('cd');
  if (cd) ui.showCountdown(cd === 'GO' ? 'GO' : Number(cd));
  if (freeze && (target === 'hud' || target === 'overlay')) for (let i = 0; i < TIMELINE.length; i++) fired.add(i);
}

// ------------------------------------------------------------------------------------------ debug handles

Object.assign(window as unknown as Record<string, unknown>, {
  __ui: ui,
  __input: input,
  __hub: inputHub,
  __settings: settings,
  __sounds: soundLog,
  __events: eventLog,
  __inputStats: inputStats,
  __ctl: ctl,
  __lastStart: () => lastStart,
  __setScreen: setScreen,
  __setState: (s: string) => ((hudState = s), (replay = s === 'replay'), ui.setReplay(replay)),
  __notify: (k: string) => ui.notify(NOTIFS[k]),
  __sample: () => input.sample(makeControlState()),
  // UI-3 / UI-4 public API probes
  __clearBanners: () => ui.clearBanners(),
  __dismiss: (k: HudNotification['kind']) => ui.dismissBanner(k),
  __resetTransient: () => ui.resetTransient(),
  /** Feed the sampled controls to the UI each frame (what the game's INT-13 wiring does). */
  __feedControls: (on: boolean) => {
    feedControls = on;
  },
});
