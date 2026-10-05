/** MATCH SETUP: team size, bot difficulty, match length, mutators, START MATCH. */
import type { Difficulty, MatchConfig, TeamSize } from '../../sim/types';
import { Panel, type UIContext } from '../core';
import { div, h, span, textNode, setText } from '../dom';
import type { IconName } from '../icons';
import { button, choiceGroup, gp, hint, icon, kbd, sectionTitle, type ChoiceGroup } from '../widgets';
import { panelHeader } from './common';

const TEAM_SIZES: ReadonlyArray<{ value: TeamSize; title: string; name: string; desc: string }> = [
  { value: 1, title: '1V1', name: 'DUEL', desc: 'One on one. Nowhere to hide.' },
  { value: 2, title: '2V2', name: 'DOUBLES', desc: 'Pass, rotate, charge the core.' },
  { value: 3, title: '3V3', name: 'SQUADS', desc: 'Full-field chaos. The classic.' },
];

const DIFFICULTIES: ReadonlyArray<{ value: Difficulty; name: string; desc: string; level: number }> = [
  { value: 'rookie', name: 'ROOKIE', desc: 'Forgiving rivals — perfect for your first match.', level: 1 },
  { value: 'pro', name: 'PRO', desc: 'Smart rotations and solid aerial reads.', level: 2 },
  { value: 'legend', name: 'LEGEND', desc: 'Ruthless. Fast aerials, zero mercy.', level: 3 },
];

const DURATIONS: ReadonlyArray<{ value: number; label: string; name: string }> = [
  { value: 120, label: '2:00', name: 'SPRINT' },
  { value: 180, label: '3:00', name: 'STANDARD' },
  { value: 300, label: '5:00', name: 'MARATHON' },
];

type MutKey = 'charge' | 'pulse' | 'surges' | 'demolitions';
const MUTATORS: ReadonlyArray<{ key: MutKey; icon: IconName; name: string; desc: string }> = [
  { key: 'charge', icon: 'charge', name: 'CORE CHARGE', desc: 'Team touches charge the ball I → III; a goal scores its level. A rival touch steals it; 10 s without a touch drops a level.' },
  { key: 'pulse', icon: 'pulse', name: 'NOVA PULSE', desc: 'Shockwave ability (10 s cooldown) that blasts the ball and shoves nearby rivals.' },
  { key: 'surges', icon: 'surge', name: 'ZERO-G SURGE', desc: 'Every minute gravity drops for 10 seconds — the ball floats and everyone flies.' },
  { key: 'demolitions', icon: 'demo', name: 'DEMOLITIONS', desc: 'Ram an opponent at supersonic speed to wreck them for 3 seconds.' },
];

export function randomSeed(): number {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  } catch {
    return (Math.random() * 0x100000000) >>> 0;
  }
}

function formation(n: number): HTMLElement {
  const f = div('nb-formation');
  const side = (team: 0 | 1) => {
    const s = div(`nb-form-side t${team}`);
    for (let i = 0; i < n; i++) s.append(span('nb-form-dot'));
    return s;
  };
  f.append(side(0), span('nb-form-vs', 'VS'), side(1));
  return f;
}

export class MatchSetup extends Panel {
  readonly el: HTMLElement;
  private readonly size: ChoiceGroup<TeamSize>;
  private readonly diff: ChoiceGroup<Difficulty>;
  private readonly dur: ChoiceGroup<number>;
  private readonly mutRows: Array<{ el: HTMLElement; key: MutKey }> = [];
  private readonly summary: Text;
  private readonly startBtn: HTMLButtonElement;

  constructor(private readonly ctx: UIContext) {
    super();
    const s = ctx.settings;

    this.size = choiceGroup(
      ctx,
      'nb-choices-size',
      TEAM_SIZES.map((t) => ({
        value: t.value,
        build: (c: HTMLElement) => {
          c.classList.add('nb-card-size');
          c.append(formation(t.value), span('nb-card-title', t.title), span('nb-card-name', t.name), span('nb-card-desc', t.desc));
        },
      })),
      () => s.lastTeamSize,
      (v) => {
        s.lastTeamSize = v;
        this.refreshSummary();
      },
    );

    this.diff = choiceGroup(
      ctx,
      'nb-choices-diff',
      DIFFICULTIES.map((d) => ({
        value: d.value,
        build: (c: HTMLElement) => {
          c.classList.add('nb-card-diff', `d-${d.value}`);
          const bars = div('nb-diff-bars');
          for (let i = 1; i <= 3; i++) bars.append(span(`nb-diff-bar${i <= d.level ? ' is-on' : ''}`));
          c.append(bars, span('nb-card-title', d.name), span('nb-card-desc', d.desc));
        },
      })),
      () => s.lastDifficulty,
      (v) => {
        s.lastDifficulty = v;
        this.refreshSummary();
      },
    );

    this.dur = choiceGroup(
      ctx,
      'nb-choices-dur',
      DURATIONS.map((d) => ({
        value: d.value,
        build: (c: HTMLElement) => {
          c.classList.add('nb-card-dur');
          c.append(span('nb-card-title', d.label), span('nb-card-name', d.name));
        },
      })),
      () => s.lastDuration,
      (v) => {
        s.lastDuration = v;
        this.refreshSummary();
      },
    );

    const mutList = div('nb-mut-list');
    for (const m of MUTATORS) {
      const sw = h('span', { class: 'nb-switch' }, h('span', { class: 'nb-switch-track' }, span('nb-switch-knob')), span('nb-switch-text', 'ON'));
      const row = h(
        'button',
        { class: `nb-mut m-${m.key}`, type: 'button', 'data-nav': '', role: 'switch' },
        h('span', { class: 'nb-mut-ico' }, icon(m.icon)),
        h('span', { class: 'nb-mut-text' }, span('nb-mut-name', m.name), span('nb-mut-desc', m.desc)),
        sw,
      );
      row.addEventListener('click', () => {
        s.lastMutators = { ...s.lastMutators, [m.key]: !s.lastMutators[m.key] };
        ctx.sound('toggle');
        this.refreshMutators();
        this.refreshSummary();
        ctx.settingsChanged();
      });
      this.mutRows.push({ el: row, key: m.key });
      mutList.append(row);
    }

    this.summary = textNode('');
    this.startBtn = button(ctx, {
      label: 'START MATCH',
      variant: 'primary',
      icon: 'play',
      cls: 'nb-start-btn',
      sound: 'start',
      onClick: () => this.start(),
    });

    const left = div(
      'nb-setup-col',
      sectionTitle('MODE'),
      this.size.el,
      sectionTitle('BOT DIFFICULTY'),
      this.diff.el,
      sectionTitle('MATCH LENGTH'),
      this.dur.el,
    );
    const right = div('nb-setup-col nb-setup-mut', sectionTitle('MUTATORS', span('nb-section-aside', 'NOVA RULES')), mutList);

    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-setup', 'aria-label': 'Match setup' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'MATCH SETUP', 'EXHIBITION VS AI'),
      h('div', { class: 'nb-panel-body nb-setup-body' }, left, right),
      h(
        'footer',
        { class: 'nb-panel-foot' },
        h('div', { class: 'nb-setup-summary' }, span('nb-setup-summary-k', 'MATCH'), span('nb-setup-summary-v', this.summary)),
        h('div', { class: 'nb-foot-right' }, h('div', { class: 'nb-hints' }, hint([kbd('ESC', true)], [gp('B')], 'BACK')), this.startBtn),
      ),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.startBtn;
  }

  override onShow(): void {
    this.size.refresh();
    this.diff.refresh();
    this.dur.refresh();
    this.refreshMutators();
    this.refreshSummary();
  }

  override onStart(): boolean {
    this.start();
    return true;
  }

  private refreshMutators(): void {
    const m = this.ctx.settings.lastMutators;
    for (const r of this.mutRows) {
      const on = !!m[r.key];
      r.el.classList.toggle('is-on', on);
      r.el.setAttribute('aria-checked', String(on));
      const t = r.el.querySelector('.nb-switch-text');
      if (t) t.textContent = on ? 'ON' : 'OFF';
      r.el.querySelector('.nb-switch')?.classList.toggle('is-on', on);
    }
  }

  private refreshSummary(): void {
    const s = this.ctx.settings;
    const n = Object.values(s.lastMutators).filter(Boolean).length;
    const d = DURATIONS.find((x) => x.value === s.lastDuration)?.label ?? `${Math.round(s.lastDuration / 60)}:00`;
    const diff = DIFFICULTIES.find((x) => x.value === s.lastDifficulty)?.name ?? s.lastDifficulty.toUpperCase();
    setText(this.summary, `${s.lastTeamSize}V${s.lastTeamSize}  ·  ${diff} BOTS  ·  ${d}  ·  ${n}/4 MUTATORS`);
  }

  private start(): void {
    const s = this.ctx.settings;
    const cfg: MatchConfig = {
      teamSize: s.lastTeamSize,
      durationSec: s.lastDuration,
      difficulty: s.lastDifficulty,
      seed: randomSeed(),
      freePlay: false,
      mutators: { ...s.lastMutators },
      player: { name: s.playerName || 'PLAYER', style: s.carStyle, paint: s.paint },
    };
    this.ctx.settingsChanged();
    this.ctx.launch(cfg);
  }
}
