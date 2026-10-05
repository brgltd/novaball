/** CONTROLS: keyboard/mouse and gamepad bindings exactly as in DESIGN §3, styled as keycaps. */
import { Panel, type UIContext } from '../core';
import { div, h, span, type Child } from '../dom';
import { button, gp, hint, icon, kbd, mouseGlyph } from '../widgets';
import { panelHeader } from './common';

const or = () => span('nb-or', 'or');
const sl = () => span('nb-sl', '/');
const paren = (...c: Child[]) => h('span', { class: 'nb-paren' }, '(', span('nb-or', 'or'), ...c, ')');
const note = (t: string) => span('nb-ctl-note', t);
const withLabel = (el: HTMLElement, label: string) => h('span', { class: 'nb-glyph-l' }, el, span('nb-glyph-t', label));

export class ControlsPanel extends Panel {
  readonly el: HTMLElement;
  private readonly howTo: HTMLButtonElement;

  constructor(ctx: UIContext) {
    super();
    const rows: Array<[string, string | null, Child[], Child[]]> = [
      ['Throttle / Reverse', 'air: pitch', [kbd('W'), sl(), kbd('S'), paren(kbd('↑'), sl(), kbd('↓'))], [gp('RT'), sl(), gp('LT'), h('span', { class: 'nb-paren' }, '(', note('pitch:'), gp('LS'), note('Y'), ')')]],
      ['Steer', 'air: yaw', [kbd('A'), sl(), kbd('D'), paren(kbd('←'), sl(), kbd('→'))], [gp('LS'), note('Left stick X')]],
      ['Jump / Double jump / Dodge', 'jump + direction', [kbd('SPACE', true), or(), withLabel(mouseGlyph('right'), 'Right Mouse')], [gp('A')]],
      ['Boost', null, [kbd('SHIFT', true), or(), withLabel(mouseGlyph('left'), 'Left Mouse')], [gp('B')]],
      ['Powerslide / Free air roll', 'ground / air', [kbd('C'), or(), kbd('LEFT ALT', true)], [gp('X')]],
      ['Air roll left / right', null, [kbd('Q'), sl(), kbd('E')], [gp('LB'), sl(), note('(none)')]],
      ['NOVA PULSE', null, [kbd('F')], [gp('RB')]],
      ['Ball cam toggle', null, [kbd('TAB', true)], [gp('Y')]],
      ['Pause', null, [kbd('ESC', true)], [gp('START'), note('Start')]],
      ['Skip replay', null, [kbd('SPACE', true), sl(), kbd('ENTER', true)], [gp('A')]],
      ['Reset', 'Free Play', [kbd('R')], [gp('BACK'), note('Back / View')]],
    ];

    const table = h(
      'div',
      { class: 'nb-ctl-table', role: 'table' },
      h(
        'div',
        { class: 'nb-ctl-row nb-ctl-headrow', role: 'row' },
        span('nb-ctl-h', 'ACTION'),
        h('span', { class: 'nb-ctl-h' }, icon('keyboard'), ' KEYBOARD / MOUSE'),
        h('span', { class: 'nb-ctl-h' }, icon('gamepad'), ' GAMEPAD'),
      ),
    );
    rows.forEach(([action, sub, keys, pad], i) => {
      const r = h(
        'div',
        { class: `nb-ctl-row${action === 'NOVA PULSE' ? ' is-nova' : ''}`, role: 'row' },
        h('span', { class: 'nb-ctl-action', role: 'cell' }, span('nb-ctl-name', action), sub ? span('nb-ctl-sub', sub) : null),
        h('span', { class: 'nb-ctl-keys', role: 'cell' }, ...keys),
        h('span', { class: 'nb-ctl-keys', role: 'cell' }, ...pad),
      );
      r.style.setProperty('--i', String(i));
      table.append(r);
    });

    this.howTo = button(ctx, { label: 'HOW TO PLAY', icon: 'info', variant: 'ghost', onClick: () => ctx.open('tutorial') });

    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-controls', 'aria-label': 'Controls' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'CONTROLS', 'INPUT LAYOUT', this.howTo),
      h('div', { class: 'nb-panel-body nb-controls-body' }, table, h('div', { class: 'nb-ctl-foot' }, 'Hold ', kbd('`'), ' / ', gp('BACK'), ' for the scoreboard  ·  Ctrl is never bound  ·  Gamepads use the standard layout')),
      h('footer', { class: 'nb-panel-foot' }, span('nb-foot-note', 'Keys use physical positions — any keyboard layout works'), h('div', { class: 'nb-hints' }, hint([kbd('ESC', true)], [gp('B')], 'BACK'))),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>('.nb-back');
  }
}
