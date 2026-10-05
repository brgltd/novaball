/** Shared pieces for full-screen sub-panels. */
import type { UIContext } from '../core';
import { h, span } from '../dom';
import { gp, icon, kbd } from '../widgets';

/** Header bar: back button (Esc / B), title, eyebrow, optional right-side content. */
export function panelHeader(ctx: UIContext, title: string, eyebrow: string, right?: HTMLElement | null): HTMLElement {
  const back = h(
    'button',
    { class: 'nb-back', type: 'button', 'data-nav': '', 'data-back': '', 'aria-label': 'Back' },
    icon('back'),
    span('nb-back-label', 'BACK'),
    h('span', { class: 'nb-back-key' }, h('span', { class: 'nb-only-kb' }, kbd('ESC', true)), h('span', { class: 'nb-only-gp' }, gp('B'))),
  );
  back.addEventListener('click', () => {
    ctx.sound('back');
    ctx.pop();
  });
  return h(
    'header',
    { class: 'nb-panel-head' },
    back,
    h('div', { class: 'nb-panel-titles' }, span('nb-panel-eyebrow', eyebrow), h('h2', { class: 'nb-panel-title' }, title)),
    h('div', { class: 'nb-panel-head-right' }, right ?? null),
  );
}
