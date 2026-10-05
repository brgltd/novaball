/** HOW TO PLAY card — shown before the first match (and from CONTROLS). */
import { TEAMS } from '../../theme';
import { Panel, type UIContext } from '../core';
import { div, h, span } from '../dom';
import type { IconName } from '../icons';
import { button, gp, hint, icon, kbd, mouseGlyph } from '../widgets';

export class Tutorial extends Panel {
  readonly el: HTMLElement;
  private readonly goBtn: HTMLButtonElement;
  private readonly goLabel: HTMLElement;
  private onContinue: (() => void) | null = null;

  constructor(private readonly ctx: UIContext) {
    super();
    const mech = (cls: string, ico: IconName, name: string, text: string, keys: HTMLElement) =>
      h(
        'div',
        { class: `nb-tut-mech ${cls}` },
        h('div', { class: 'nb-tut-mech-ico' }, icon(ico), span('nb-tut-mech-ring')),
        h('div', { class: 'nb-tut-mech-name' }, name),
        h('div', { class: 'nb-tut-mech-text' }, text),
        h('div', { class: 'nb-tut-mech-keys' }, keys),
      );
    const keys = (kb: Array<HTMLElement>, pad: Array<HTMLElement>) =>
      h('span', { class: 'nb-tut-k' }, h('span', { class: 'nb-only-kb' }, ...kb), h('span', { class: 'nb-only-gp' }, ...pad));

    const ctl = (k: HTMLElement[], p: HTMLElement[], label: string) => h('div', { class: 'nb-tut-ctl' }, keys(k, p), span('nb-tut-ctl-l', label));

    this.goLabel = span('nb-btn-label', "LET'S GO");
    this.goBtn = button(ctx, { label: "LET'S GO", variant: 'primary', icon: 'play', sound: 'start', cls: 'nb-tut-go', onClick: () => this.go() });
    this.goBtn.querySelector('.nb-btn-label')?.replaceWith(this.goLabel);

    const card = h(
      'div',
      { class: 'nb-tut-card' },
      div('nb-tut-glow'),
      h('div', { class: 'nb-tut-eyebrow' }, 'PILOT BRIEFING'),
      h('h2', { class: 'nb-tut-title' }, 'HOW TO PLAY'),
      h(
        'p',
        { class: 'nb-tut-goal' },
        'Drive your hover-car into the ',
        span('nb-tut-core', 'Nova Core'),
        ' and knock it into the ',
        span('nb-tut-blaze', `${TEAMS[1].name}`),
        ' goal. Most points when the clock hits ',
        span('nb-tut-strong', '0:00'),
        ' wins.',
      ),
      h(
        'div',
        { class: 'nb-tut-mechs' },
        mech('m-charge', 'charge', 'CORE CHARGE', 'Consecutive touches by your team charge the core I → II → III, and a goal is worth its charge: SUPERNOVA = 3 points! A rival touch steals it; 10 s without a touch drops a level.', keys([span('nb-tut-auto', 'AUTOMATIC')], [span('nb-tut-auto', 'AUTOMATIC')])),
        mech('m-pulse', 'pulse', 'NOVA PULSE', 'Release a shockwave that blasts the ball and shoves nearby rivals. 10 s cooldown — save it for the clutch.', keys([kbd('F')], [gp('RB')])),
        mech('m-surge', 'surge', 'ZERO-G SURGE', 'Every minute gravity drops for 10 seconds — the ball floats and everyone flies. Watch for the warning, then take to the sky.', keys([span('nb-tut-auto', 'EVERY 60 S')], [span('nb-tut-auto', 'EVERY 60 S')])),
      ),
      h(
        'div',
        { class: 'nb-tut-ctls' },
        ctl([kbd('W'), kbd('S')], [gp('RT'), gp('LT')], 'DRIVE'),
        ctl([kbd('A'), kbd('D')], [gp('LS')], 'STEER'),
        ctl([kbd('SPACE', true)], [gp('A')], 'JUMP · FLIP'),
        ctl([kbd('SHIFT', true), mouseGlyph('left')], [gp('B')], 'BOOST'),
        ctl([kbd('F')], [gp('RB')], 'PULSE'),
        ctl([kbd('TAB', true)], [gp('Y')], 'BALL CAM'),
      ),
      h('p', { class: 'nb-tut-note' }, 'Upside down? Press ', h('span', { class: 'nb-only-kb' }, kbd('SPACE', true)), h('span', { class: 'nb-only-gp' }, gp('A')), ' JUMP to flip back onto your hover pads.'),
      h('div', { class: 'nb-tut-foot' }, h('div', { class: 'nb-hints' }, hint([kbd('ESC', true)], [gp('B')], 'BACK')), this.goBtn),
    );

    this.el = h('section', { class: 'nb-layer nb-panel nb-tutorial', 'aria-label': 'How to play', role: 'dialog' }, div('nb-tut-backdrop'), card);
  }

  /** Configure before pushing: with a continuation (first match) or as a read-only briefing. */
  prepare(onContinue: (() => void) | null): void {
    this.onContinue = onContinue;
    this.goLabel.textContent = onContinue ? "LET'S GO" : 'GOT IT';
  }

  override defaultFocus(): HTMLElement | null {
    return this.goBtn;
  }

  override onStart(): boolean {
    this.go();
    return true;
  }

  override onHide(): void {
    // no-op: continuation is consumed by go()
  }

  private go(): void {
    const next = this.onContinue;
    this.onContinue = null;
    if (next) next();
    else this.ctx.pop();
  }
}
