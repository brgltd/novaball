/**
 * In-match HUD. update() runs every frame: every displayed value is cached and the DOM is only written
 * when something visible changed. Animations use transform / opacity (compositor only).
 */
import type { HudState, PlayerLine } from '../../contracts';
import { CAR, PULSE, SURGE } from '../../sim/constants';
import type { MatchPhase } from '../../sim/types';
import { TEAMS, teamColor } from '../../theme';
import { div, formatClock, h, play, roman, scoreText, setText, span, textNode, toggleClass } from '../dom';
import { gp, icon, kbd } from '../widgets';
import { Coach } from './Coach';

/**
 * Optional HudState fields not in the contract yet (read defensively):
 *  - chargeDecay01: 0..1 = fraction of CORE CHARGE's 10 s decay window already elapsed (0 right after a counted touch).
 */
interface HudStateEx extends HudState {
  chargeDecay01?: number;
}

/** Ball-arrow keep-out bands (design units). */
const TOP_GUARD = 158;
const TOP_GUARD_BUSY = 200;
const BL_GUARD = 170;
/** + the free-play hints (R / ESC) above NOVA PULSE */
const BL_GUARD_FREE = 262;
/** + the FIRST FLIGHT column (and the free-play hints under it in a first Free Play) */
const BL_GUARD_COACH = 404;
const BL_GUARD_COACH_FREE = 500;

const TAU = Math.PI * 2;

function arcGauge(cls: string, r: number, sweep: number): { svg: SVGSVGElement; fill: SVGCircleElement } {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const rot = 90 + (360 - sweep) / 2;
  const mk = (c: string, dash: string) => {
    const el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', '100');
    el.setAttribute('cy', '100');
    el.setAttribute('r', String(r));
    el.setAttribute('pathLength', '100');
    el.setAttribute('class', c);
    el.setAttribute('stroke-dasharray', dash);
    el.setAttribute('transform', `rotate(${rot} 100 100)`);
    svg.appendChild(el);
    return el;
  };
  const part = (sweep / 360) * 100;
  mk('g-track', `${part.toFixed(2)} 100`);
  const fill = mk('g-fill', `0 100`);
  return { svg, fill };
}

export class Hud {
  readonly el: HTMLElement;

  // --- scoreboard
  private readonly sbName0: Text;
  private readonly sbName1: Text;
  private readonly sbScore0: Text;
  private readonly sbScore1: Text;
  private readonly sbScoreEl0: HTMLElement;
  private readonly sbScoreEl1: HTMLElement;
  private readonly sbClock: HTMLElement;
  private readonly sbTime: Text;
  private readonly sbYou0: HTMLElement;
  private readonly sbYou1: HTMLElement;
  // --- charge
  private readonly charge: HTMLElement;
  private readonly chargePips: HTMLElement[] = [];
  private readonly chargeNum: Text;
  private readonly chargeLabel: Text;
  private readonly chargeDecay: HTMLElement;
  private readonly chargeDecayFill: HTMLElement;
  // --- surge
  private readonly surge: HTMLElement;
  private readonly surgeWarnN: Text;
  private readonly surgeTime: Text;
  private readonly surgeBar: HTMLElement;
  // --- pulse
  private readonly pulse: HTMLElement;
  private readonly pulseBadge: HTMLElement;
  private readonly pulseRing: SVGCircleElement;
  private readonly pulseCd: Text;
  private readonly pulseCdEl: HTMLElement;
  private readonly pulseDeny: HTMLElement;
  private readonly pulseState: Text;
  // --- boost
  private readonly boost: HTMLElement;
  private readonly boostFill: SVGCircleElement;
  private readonly boostNum: Text;
  private readonly speedNum: Text;
  // --- misc
  private readonly ballCam: HTMLElement;
  private readonly ballCamState: Text;
  private readonly ballInd: HTMLElement;
  private readonly respawn: HTMLElement;
  private readonly respawnN: Text;
  private readonly respawnRing: SVGCircleElement;
  private readonly fps: HTMLElement;
  private readonly fpsN: Text;
  private readonly replay: HTMLElement;
  /** FIRST FLIGHT control chips (bottom-left column, above NOVA PULSE). */
  readonly coach: Coach;

  // --- cache (NaN / sentinel = force first write)
  private cFree: boolean | null = null;
  private cReplay: boolean | null = null;
  private cPhase: MatchPhase | '' = '';
  private cN0 = '';
  private cN1 = '';
  private cS0 = -1;
  private cS1 = -1;
  private cPlayerTeam = -1;
  private cClockKey = Number.NaN;
  private cClockCls = '';
  private cChargeKey = Number.NaN;
  private cDecay = Number.NaN;
  private cSurgeState = '';
  private cSurgeKey = Number.NaN;
  private cSurgeBar = Number.NaN;
  private cPulseEnabled: boolean | null = null;
  private cPulseRing = Number.NaN;
  private cPulseSecs = Number.NaN;
  private cPulseReady: boolean | null = null;
  private cBoost = Number.NaN;
  private cBoostCls = '';
  private cSpeed = Number.NaN;
  private cSpeedT = 0;
  private cSuper: boolean | null = null;
  private cBallCam: boolean | null = null;
  private cIndVis: boolean | null = null;
  private cIndX = Number.NaN;
  private cIndY = Number.NaN;
  private cIndA = Number.NaN;
  private cIndTeam = -2;
  private cDead: boolean | null = null;
  private cRespN = Number.NaN;
  private cRespRing = Number.NaN;
  private cShowFps: boolean | null = null;
  private cFps = Number.NaN;
  private cFpsT = 0;
  /** Keep-out state for the off-screen ball arrow. */
  private compactBanner = false;
  private coachVisible = false;

  // viewport metrics for the off-screen ball indicator safe area (updated on resize, never read per frame)
  private vw = 1600;
  private vh = 900;
  private u = 1;
  private readonly onResize = () => {
    this.vw = window.innerWidth || 1600;
    this.vh = window.innerHeight || 900;
    this.u = Math.max(0.6, Math.min(this.vw / 1600, this.vh / 900));
    this.cIndX = Number.NaN;
  };

  /** Latest scoreboard lines / names / score (read by the overlay & pause menu). */
  lines: ReadonlyArray<PlayerLine> = [];
  teamNames: [string, string] = [TEAMS[0].name, TEAMS[1].name];
  score: [number, number] = [0, 0];
  clock = 0;
  overtime = false;
  freePlay = false;

  constructor() {
    this.onResize();
    window.addEventListener('resize', this.onResize);
    // ---------------------------------------------------------------- scoreboard (top center)
    this.sbName0 = textNode(TEAMS[0].name);
    this.sbName1 = textNode(TEAMS[1].name);
    this.sbScore0 = textNode('0');
    this.sbScore1 = textNode('0');
    this.sbTime = textNode('3:00');
    this.sbYou0 = span('nb-sb-you', 'YOU');
    this.sbYou1 = span('nb-sb-you', 'YOU');
    this.sbScoreEl0 = h('div', { class: 'nb-sb-score' }, span('nb-sb-score-n', this.sbScore0));
    this.sbScoreEl1 = h('div', { class: 'nb-sb-score' }, span('nb-sb-score-n', this.sbScore1));
    this.sbClock = h('div', { class: 'nb-sb-clock' }, span('nb-sb-ot', 'OT'), span('nb-sb-time', this.sbTime));
    const side = (team: 0 | 1, name: Text, you: HTMLElement, score: HTMLElement) => {
      const el = h('div', { class: `nb-sb-side t${team}` });
      el.style.setProperty('--tc', TEAMS[team].primary);
      el.style.setProperty('--tc2', TEAMS[team].secondary);
      el.style.setProperty('--tcd', TEAMS[team].dark);
      const plate = h('div', { class: 'nb-sb-plate' }, span('nb-sb-name', name), you);
      if (team === 0) el.append(plate, score);
      else el.append(score, plate);
      return el;
    };
    const scoreboard = h(
      'div',
      { class: 'nb-sb' },
      side(0, this.sbName0, this.sbYou0, this.sbScoreEl0),
      this.sbClock,
      side(1, this.sbName1, this.sbYou1, this.sbScoreEl1),
      h('div', { class: 'nb-sb-free' }, span('nb-sb-free-k', 'FREE PLAY'), span('nb-sb-free-v', 'NO CLOCK · NO RULES')),
    );

    // ---------------------------------------------------------------- core charge (under the score)
    this.chargeNum = textNode('');
    this.chargeLabel = textNode('CORE');
    const pips = span('nb-charge-pips');
    for (let i = 0; i < 3; i++) {
      const p = span('nb-charge-pip');
      this.chargePips.push(p);
      pips.append(p);
    }
    // 10 s decay window under the pips: drains while nobody touches the core, refills on a counted touch
    this.chargeDecayFill = span('nb-charge-decay-fill');
    this.chargeDecay = h('span', { class: 'nb-charge-decay' }, this.chargeDecayFill);
    pips.append(this.chargeDecay);
    this.charge = h(
      'div',
      { class: 'nb-charge lv0' },
      h('span', { class: 'nb-charge-ico' }, icon('charge')),
      span('nb-charge-label', this.chargeLabel),
      pips,
      span('nb-charge-num', this.chargeNum),
      span('nb-charge-glow'),
    );

    // ---------------------------------------------------------------- zero-g surge
    this.surgeWarnN = textNode('3');
    this.surgeTime = textNode('10.0');
    this.surgeBar = span('nb-surge-bar-fill');
    this.surge = h(
      'div',
      { class: 'nb-surge' },
      h(
        'div',
        { class: 'nb-surge-warn' },
        span('nb-surge-chev', '▲'),
        h('span', { class: 'nb-surge-warn-t' }, 'ZERO-G SURGE IN ', span('nb-surge-warn-n', this.surgeWarnN)),
        span('nb-surge-chev', '▲'),
      ),
      h(
        'div',
        { class: 'nb-surge-active' },
        h('div', { class: 'nb-surge-row' }, icon('surge', 'nb-surge-ico'), span('nb-surge-name', 'ZERO-G SURGE'), span('nb-surge-time', this.surgeTime)),
        h('div', { class: 'nb-surge-bar' }, this.surgeBar),
      ),
    );

    // ---------------------------------------------------------------- nova pulse (bottom left)
    const pr = arcGauge('nb-pulse-ringsvg', 88, 360);
    this.pulseRing = pr.fill;
    this.pulseCd = textNode('');
    this.pulseCdEl = span('nb-pulse-cd', this.pulseCd);
    this.pulseDeny = span('nb-pulse-deny');
    this.pulseState = textNode('READY');
    this.pulseBadge = h(
      'div',
      { class: 'nb-pulse-badge' },
      span('nb-pulse-wave'),
      span('nb-pulse-wave w2'),
      pr.svg,
      h('span', { class: 'nb-pulse-core' }, icon('pulse', 'nb-pulse-ico'), this.pulseCdEl),
      this.pulseDeny,
    );
    this.pulse = h(
      'div',
      { class: 'nb-pulse is-ready' },
      this.pulseBadge,
      h(
        'div',
        { class: 'nb-pulse-text' },
        span('nb-pulse-name', 'NOVA PULSE'),
        span('nb-pulse-state', this.pulseState),
        h('span', { class: 'nb-pulse-key' }, h('span', { class: 'nb-only-kb' }, kbd('F')), h('span', { class: 'nb-only-gp' }, gp('RB'))),
      ),
    );

    // ---------------------------------------------------------------- boost gauge (bottom right)
    const bg = arcGauge('nb-boost-svg', 84, 270);
    this.boostFill = bg.fill;
    // Tick ring + supersonic outer arc (decorative, static geometry).
    const ns = 'http://www.w3.org/2000/svg';
    const ticks = document.createElementNS(ns, 'circle');
    ticks.setAttribute('cx', '100');
    ticks.setAttribute('cy', '100');
    ticks.setAttribute('r', '97');
    ticks.setAttribute('pathLength', '120');
    ticks.setAttribute('stroke-dasharray', '0.35 2.65');
    ticks.setAttribute('class', 'g-ticks');
    ticks.setAttribute('transform', 'rotate(135 100 100)');
    bg.svg.insertBefore(ticks, bg.svg.firstChild);
    const ss = document.createElementNS(ns, 'circle');
    ss.setAttribute('cx', '100');
    ss.setAttribute('cy', '100');
    ss.setAttribute('r', '97');
    ss.setAttribute('pathLength', '100');
    ss.setAttribute('stroke-dasharray', '75 100');
    ss.setAttribute('class', 'g-ss');
    ss.setAttribute('transform', 'rotate(135 100 100)');
    bg.svg.appendChild(ss);
    this.boostNum = textNode('0');
    this.speedNum = textNode('0');
    this.boost = h(
      'div',
      { class: 'nb-boost' },
      span('nb-boost-glow'),
      bg.svg,
      h(
        'div',
        { class: 'nb-boost-center' },
        span('nb-boost-num', this.boostNum),
        span('nb-boost-label', 'BOOST'),
        h('span', { class: 'nb-boost-speed' }, this.speedNum, span('nb-boost-unit', ' KM/H')),
      ),
      h('span', { class: 'nb-boost-key' }, h('span', { class: 'nb-only-kb' }, kbd('SHIFT', true)), h('span', { class: 'nb-only-gp' }, gp('B'))),
      span('nb-boost-ss', 'SUPERSONIC'),
    );

    // ---------------------------------------------------------------- ball cam
    this.ballCamState = textNode('ON');
    this.ballCam = h(
      'div',
      { class: 'nb-ballcam' },
      icon('ballCam', 'nb-ballcam-ico'),
      span('nb-ballcam-l', 'BALL CAM'),
      span('nb-ballcam-s', this.ballCamState),
      h('span', { class: 'nb-ballcam-key' }, h('span', { class: 'nb-only-kb' }, kbd('TAB', true)), h('span', { class: 'nb-only-gp' }, gp('Y'))),
    );

    // ---------------------------------------------------------------- off-screen ball arrow
    this.ballInd = h('div', { class: 'nb-ballind' }, span('nb-ballind-ball'), span('nb-ballind-arrow'));

    // ---------------------------------------------------------------- respawn
    const rr = arcGauge('nb-respawn-svg', 90, 360);
    this.respawnRing = rr.fill;
    this.respawnN = textNode('3');
    this.respawn = h(
      'div',
      { class: 'nb-respawn' },
      span('nb-respawn-k', 'DEMOLISHED'),
      h('div', { class: 'nb-respawn-ring' }, rr.svg, span('nb-respawn-n', this.respawnN)),
      span('nb-respawn-sub', 'RESPAWNING'),
    );

    // ---------------------------------------------------------------- fps / replay / free play
    this.fpsN = textNode('0');
    this.fps = h('div', { class: 'nb-fps' }, span('nb-fps-n', this.fpsN), span('nb-fps-u', 'FPS'));
    this.replay = h(
      'div',
      { class: 'nb-replay' },
      h('div', { class: 'nb-replay-tag' }, span('nb-replay-dot'), span('nb-replay-t', 'REPLAY'), span('nb-replay-stripes')),
      h(
        'div',
        { class: 'nb-replay-skip' },
        h('span', { class: 'nb-only-kb' }, kbd('SPACE', true)),
        h('span', { class: 'nb-only-gp' }, gp('A')),
        span('nb-replay-skip-l', 'SKIP REPLAY'),
      ),
    );
    // Free-play hints + FIRST FLIGHT coach share a column above the NOVA PULSE badge, well clear of the car
    // (bottom centre), the scoreboard and the boost gauge.
    const freeHints = h(
      'div',
      { class: 'nb-free-hints' },
      h('span', { class: 'nb-free-h' }, h('span', { class: 'nb-only-kb' }, kbd('R')), h('span', { class: 'nb-only-gp' }, gp('BACK')), span('', 'RESET BALL')),
      h('span', { class: 'nb-free-h' }, h('span', { class: 'nb-only-kb' }, kbd('ESC', true)), h('span', { class: 'nb-only-gp' }, gp('START')), span('', 'MENU')),
    );
    this.coach = new Coach();
    this.coach.onVisibleChange = (v) => {
      this.coachVisible = v;
      this.cIndX = Number.NaN;
    };

    this.el = h(
      'div',
      { class: 'nb-hud' },
      div('nb-hud-top', scoreboard, this.charge, this.surge),
      this.pulse,
      div('nb-hud-tips', this.coach.el, freeHints),
      div('nb-hud-br', this.ballCam, this.boost),
      this.ballInd,
      this.respawn,
      this.fps,
      this.replay,
    );
  }

  /** A compact live-play banner is up under the scoreboard: keep the ball arrow below it. */
  setCompactBanner(on: boolean): void {
    if (on === this.compactBanner) return;
    this.compactBanner = on;
    this.cIndX = Number.NaN;
  }

  /** NOVA PULSE pressed while on cooldown: shake the badge and flash the countdown (compositor-only). */
  pulseDenied(): void {
    play(
      this.pulseBadge,
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)', offset: 0.2 },
        { transform: 'translateX(4px)', offset: 0.45 },
        { transform: 'translateX(-3px)', offset: 0.7 },
        { transform: 'translateX(2px)', offset: 0.88 },
        { transform: 'translateX(0)' },
      ],
      { duration: 180, easing: 'linear' },
    );
    play(this.pulseCdEl, [{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.2,1)' });
    play(this.pulseDeny, [{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease-out', reduced: [{ opacity: 1 }, { opacity: 0 }], reducedMs: 150 });
  }

  setReplay(active: boolean): void {
    if (active === this.cReplay) return;
    this.cReplay = active;
    toggleClass(this.el, 'is-replay', active);
    if (active) play(this.replay.firstElementChild!, [{ transform: 'translateX(-40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.9,.2,1)' });
  }

  update(hs: HudState): void {
    const root = this.el;
    this.lines = hs.scoreboard;
    this.teamNames = hs.teamNames;
    this.score = hs.score;
    this.clock = hs.clock;
    this.overtime = hs.overtime;
    this.freePlay = hs.freePlay;

    if (hs.freePlay !== this.cFree) {
      this.cFree = hs.freePlay;
      toggleClass(root, 'is-freeplay', hs.freePlay);
    }
    this.setReplay(hs.replay);
    if (hs.phase !== this.cPhase) {
      this.cPhase = hs.phase;
      root.setAttribute('data-phase', hs.phase);
    }

    // ---------------------------------------------------------------- scoreboard
    if (hs.teamNames[0] !== this.cN0) setText(this.sbName0, (this.cN0 = hs.teamNames[0]));
    if (hs.teamNames[1] !== this.cN1) setText(this.sbName1, (this.cN1 = hs.teamNames[1]));
    if (hs.playerTeam !== this.cPlayerTeam) {
      this.cPlayerTeam = hs.playerTeam;
      toggleClass(this.sbYou0, 'is-on', hs.playerTeam === 0);
      toggleClass(this.sbYou1, 'is-on', hs.playerTeam === 1);
    }
    const s0 = hs.score[0];
    const s1 = hs.score[1];
    if (s0 !== this.cS0) {
      const up = this.cS0 >= 0 && s0 > this.cS0;
      this.cS0 = s0;
      setText(this.sbScore0, scoreText(s0));
      if (up) this.popScore(this.sbScoreEl0);
    }
    if (s1 !== this.cS1) {
      const up = this.cS1 >= 0 && s1 > this.cS1;
      this.cS1 = s1;
      setText(this.sbScore1, scoreText(s1));
      if (up) this.popScore(this.sbScoreEl1);
    }
    if (!hs.freePlay) {
      const key = hs.overtime ? -1 - Math.floor(Math.max(0, hs.overtimeElapsed)) : Math.ceil(Math.max(0, hs.clock) - 1e-6);
      if (key !== this.cClockKey) {
        this.cClockKey = key;
        setText(this.sbTime, hs.overtime ? `+${formatClock(-1 - key)}` : formatClock(key));
        const cls = hs.overtime ? 'is-ot' : key <= 10 ? 'is-final' : key <= 60 ? 'is-low' : '';
        if (cls !== this.cClockCls) {
          if (this.cClockCls) this.sbClock.classList.remove(this.cClockCls);
          if (cls) this.sbClock.classList.add(cls);
          this.cClockCls = cls;
        }
        if (cls === 'is-final' && hs.phase === 'playing') play(this.sbClock, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
      }
    }

    // ---------------------------------------------------------------- core charge
    const lvl = hs.chargeEnabled ? Math.max(0, Math.min(3, Math.round(hs.charge))) : -1;
    const cteam = lvl > 0 ? hs.chargeTeam : -1;
    const ckey = lvl < 0 ? -1 : lvl * 3 + (cteam + 1);
    if (ckey !== this.cChargeKey) {
      const prevLvl = Number.isNaN(this.cChargeKey) || this.cChargeKey < 0 ? 0 : Math.floor(this.cChargeKey / 3);
      this.cChargeKey = ckey;
      const el = this.charge;
      el.className = `nb-charge lv${Math.max(0, lvl)}${lvl < 0 ? ' is-off' : ''}${cteam >= 0 ? ` t${cteam}` : ''}`;
      el.style.setProperty('--cc', teamColor(cteam as 0 | 1 | -1));
      el.style.setProperty('--cc2', cteam >= 0 ? TEAMS[cteam as 0 | 1].secondary : '#ffffff');
      for (let i = 0; i < 3; i++) toggleClass(this.chargePips[i], 'is-on', i < lvl);
      setText(this.chargeNum, lvl > 0 ? roman(lvl) : '');
      // state the payoff: level II / III goals are worth 2 / 3
      setText(this.chargeLabel, lvl >= 3 ? 'SUPERNOVA · GOAL ×3' : lvl === 2 ? `${TEAMS[cteam as 0 | 1].name} CORE · GOAL ×2` : lvl === 1 ? `${TEAMS[cteam as 0 | 1].name} CORE` : 'NEUTRAL CORE');
      if (lvl > prevLvl && lvl > 0) {
        const pip = this.chargePips[lvl - 1];
        play(pip, [{ transform: 'scale(2.2) skewX(-18deg)', opacity: 0.2 }, { transform: 'scale(1) skewX(-18deg)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,1.4,.3,1)' });
        play(el, [{ transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.2,.3,1)' });
      }
    }

    const decay = (hs as HudStateEx).chargeDecay01;
    const dk = lvl > 0 && typeof decay === 'number' && Number.isFinite(decay) ? Math.round((1 - Math.max(0, Math.min(1, decay))) * 100) : -1;
    if (dk !== this.cDecay) {
      if ((dk < 0) !== (this.cDecay < 0) || Number.isNaN(this.cDecay)) toggleClass(this.chargeDecay, 'is-on', dk >= 0);
      this.cDecay = dk;
      if (dk >= 0) this.chargeDecayFill.style.transform = `scaleX(${(dk / 100).toFixed(2)})`;
    }

    // ---------------------------------------------------------------- surge
    const sst = hs.surge.state;
    if (sst !== this.cSurgeState) {
      this.cSurgeState = sst;
      this.surge.setAttribute('data-state', sst);
      this.cSurgeKey = Number.NaN;
      this.cSurgeBar = Number.NaN;
    }
    if (sst === 'warning') {
      const n = Math.max(1, Math.ceil(hs.surge.timeLeft - 1e-6));
      if (n !== this.cSurgeKey) {
        this.cSurgeKey = n;
        setText(this.surgeWarnN, String(n));
        play(this.surge.firstElementChild!, [{ transform: 'scale(1.18)', opacity: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,1.3,.3,1)' });
      }
    } else if (sst === 'active') {
      const tl = Math.max(0, hs.surge.timeLeft);
      const k = Math.round(tl * 10);
      if (k !== this.cSurgeKey) {
        this.cSurgeKey = k;
        setText(this.surgeTime, (k / 10).toFixed(1));
      }
      const b = Math.round(Math.min(1, tl / SURGE.duration) * 500);
      if (b !== this.cSurgeBar) {
        this.cSurgeBar = b;
        this.surgeBar.style.transform = `scaleX(${(b / 500).toFixed(3)})`;
      }
    }

    // ---------------------------------------------------------------- nova pulse
    if (hs.pulseEnabled !== this.cPulseEnabled) {
      this.cPulseEnabled = hs.pulseEnabled;
      toggleClass(this.pulse, 'is-off', !hs.pulseEnabled);
    }
    if (hs.pulseEnabled) {
      const r = Math.max(0, Math.min(1, hs.pulseReady01));
      const ready = r >= 0.999;
      const ring = Math.round(r * 400);
      if (ring !== this.cPulseRing) {
        this.cPulseRing = ring;
        this.pulseRing.setAttribute('stroke-dasharray', `${(ring / 4).toFixed(2)} 100`);
      }
      const secs = ready ? 0 : Math.max(1, Math.ceil((1 - r) * PULSE.cooldown - 1e-6));
      if (secs !== this.cPulseSecs) {
        this.cPulseSecs = secs;
        setText(this.pulseCd, ready ? '' : String(secs));
      }
      if (ready !== this.cPulseReady) {
        const wasKnown = this.cPulseReady !== null;
        this.cPulseReady = ready;
        toggleClass(this.pulse, 'is-ready', ready);
        setText(this.pulseState, ready ? 'READY' : 'CHARGING');
        if (ready && wasKnown) play(this.pulse.firstElementChild!, [{ transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(.2,1.5,.3,1)' });
      }
    }

    // ---------------------------------------------------------------- boost + speed
    const boost = Math.max(0, Math.min(100, Math.round(hs.boost)));
    if (boost !== this.cBoost) {
      this.cBoost = boost;
      setText(this.boostNum, String(boost));
      this.boostFill.setAttribute('stroke-dasharray', `${((boost / 100) * 75).toFixed(2)} 100`);
      const cls = boost >= 100 ? 'is-full' : boost < 15 ? 'is-low' : '';
      if (cls !== this.cBoostCls) {
        if (this.cBoostCls) this.boost.classList.remove(this.cBoostCls);
        if (cls) this.boost.classList.add(cls);
        this.cBoostCls = cls;
      }
    }
    const kmh = Math.round(Math.max(0, hs.speed) * 3.6);
    if (kmh !== this.cSpeed) {
      const now = performance.now();
      if (now - this.cSpeedT > 80 || Number.isNaN(this.cSpeed)) {
        this.cSpeedT = now;
        this.cSpeed = kmh;
        setText(this.speedNum, String(kmh));
      }
    }
    if (hs.supersonic !== this.cSuper) {
      this.cSuper = hs.supersonic;
      toggleClass(this.boost, 'is-super', hs.supersonic);
    }

    // ---------------------------------------------------------------- ball cam
    if (hs.ballCam !== this.cBallCam) {
      this.cBallCam = hs.ballCam;
      toggleClass(this.ballCam, 'is-on', hs.ballCam);
      setText(this.ballCamState, hs.ballCam ? 'ON' : 'OFF');
    }

    // ---------------------------------------------------------------- off-screen ball indicator
    const bi = hs.ballIndicator;
    const vis = !!bi.visible && !hs.replay;
    if (vis !== this.cIndVis) {
      this.cIndVis = vis;
      toggleClass(this.ballInd, 'is-on', vis);
    }
    if (vis) {
      // Keep the arrow on screen and off the scoreboard / pulse / boost widgets.
      const u = this.u;
      const m = 46 * u;
      let fx = bi.x < m ? m : bi.x > this.vw - m ? this.vw - m : bi.x;
      let fy = bi.y < m ? m : bi.y > this.vh - m ? this.vh - m : bi.y;
      // top: scoreboard + CORE CHARGE pill (+ surge widget / compact banner under it when shown)
      const busy = this.compactBanner || sst === 'warning' || sst === 'active';
      const top = (busy ? TOP_GUARD_BUSY : TOP_GUARD) * u;
      if (fy < top && Math.abs(fx - this.vw * 0.5) < (busy ? 600 : 360) * u) fy = top;
      // bottom right: boost gauge + ball cam chip
      if (fx > this.vw - 290 * u && fy > this.vh - 310 * u) fy = this.vh - 310 * u;
      // bottom left: NOVA PULSE (+ the free-play hints / FIRST FLIGHT column above it)
      const bl = (this.coachVisible ? (hs.freePlay ? BL_GUARD_COACH_FREE : BL_GUARD_COACH) : hs.freePlay ? BL_GUARD_FREE : BL_GUARD) * u;
      if (fx < 380 * u && fy > this.vh - bl) fy = this.vh - bl;
      const x = Math.round(fx * 2) / 2;
      const y = Math.round(fy * 2) / 2;
      const a = Math.round((((bi.angle % TAU) + TAU) % TAU) * 200) / 200;
      if (x !== this.cIndX || y !== this.cIndY || a !== this.cIndA) {
        this.cIndX = x;
        this.cIndY = y;
        this.cIndA = a;
        this.ballInd.style.transform = `translate3d(${x}px,${y}px,0) rotate(${a}rad)`;
      }
      const t = hs.chargeEnabled && hs.charge > 0 ? hs.chargeTeam : -1;
      if (t !== this.cIndTeam) {
        this.cIndTeam = t;
        this.ballInd.style.setProperty('--bc', teamColor(t));
        toggleClass(this.ballInd, 'is-nova', hs.charge >= 3 && t >= 0);
      }
    }

    // ---------------------------------------------------------------- respawn
    const dead = hs.respawnIn > 0.001;
    if (dead !== this.cDead) {
      this.cDead = dead;
      toggleClass(root, 'is-dead', dead);
    }
    if (dead) {
      const n = Math.max(1, Math.ceil(hs.respawnIn - 1e-6));
      if (n !== this.cRespN) {
        this.cRespN = n;
        setText(this.respawnN, String(n));
      }
      const rr = Math.round(Math.min(1, hs.respawnIn / CAR.respawnTime) * 300);
      if (rr !== this.cRespRing) {
        this.cRespRing = rr;
        this.respawnRing.setAttribute('stroke-dasharray', `${(rr / 3).toFixed(2)} 100`);
      }
    }

    // ---------------------------------------------------------------- fps
    if (hs.showFps !== this.cShowFps) {
      this.cShowFps = hs.showFps;
      toggleClass(this.fps, 'is-on', hs.showFps);
    }
    if (hs.showFps) {
      const f = Math.round(hs.fps);
      const now = performance.now();
      if (f !== this.cFps && now - this.cFpsT > 250) {
        this.cFps = f;
        this.cFpsT = now;
        setText(this.fpsN, String(f));
        this.fps.setAttribute('data-q', f >= 55 ? 'good' : f >= 30 ? 'ok' : 'bad');
      }
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
  }

  private popScore(el: HTMLElement): void {
    play(
      el,
      [
        { transform: 'scale(1.6)', filter: 'brightness(2.2)' },
        { transform: 'scale(0.94)', filter: 'brightness(1.3)', offset: 0.55 },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ],
      { duration: 700, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
  }
}
