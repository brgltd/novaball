/** Loading screen: starfield backdrop, wordmark, animated progress bar, status label. */
import { GAME_TAGLINE } from '../../theme';
import { div, h, setText, span, textNode, clamp } from '../dom';
import { logo } from '../logo';

/** A single 1px element whose box-shadows form a deterministic star field (one paint, drifts on the compositor). */
function stars(cls: string, count: number, seed: number, minA: number, maxA: number): HTMLElement {
  let x = seed * 2654435761;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = (minA + (maxA - minA) * rnd()).toFixed(2);
    const tint = rnd() < 0.2 ? '190,210,255' : rnd() < 0.1 ? '255,220,240' : '255,255,255';
    parts.push(`${(rnd() * 112).toFixed(2)}vw ${(rnd() * 100).toFixed(2)}vh 0 0 rgba(${tint},${a})`);
  }
  const el = div(cls);
  el.style.boxShadow = parts.join(',');
  return el;
}

export class LoadingScreen {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly head: HTMLElement;
  private readonly pct: Text;
  private readonly label: Text;
  private shown = -1;
  private lastLabel = '';

  constructor() {
    this.pct = textNode('0');
    this.label = textNode('Initializing');
    this.fill = span('nb-load-fill');
    this.head = span('nb-load-head');
    const bar = h('div', { class: 'nb-load-bar' }, span('nb-load-track'), this.fill, this.head);
    this.el = h(
      'div',
      { class: 'nb-screen nb-loading', 'aria-busy': 'true' },
      div('nb-load-bg'),
      stars('nb-load-stars s1', 150, 7, 0.35, 0.85),
      stars('nb-load-stars s2', 45, 13, 0.55, 1),
      div('nb-load-horizon'),
      h(
        'div',
        { class: 'nb-load-center' },
        logo('lg'),
        h('div', { class: 'nb-load-tag' }, GAME_TAGLINE),
        h(
          'div',
          { class: 'nb-load-meter' },
          bar,
          h('div', { class: 'nb-load-row' }, h('span', { class: 'nb-load-label' }, this.label, span('nb-load-dots', '')), h('span', { class: 'nb-load-pct' }, this.pct, span('nb-load-pct-u', '%'))),
        ),
      ),
      h('div', { class: 'nb-load-foot' }, span('nb-load-foot-l', 'PROCEDURAL ARENA · REAL-TIME PLASMA · ZERO ASSETS'), span('nb-load-foot-r', 'NOVABALL · HACKATHON BUILD')),
    );
  }

  set(progress: number, label: string): void {
    const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    const q = Math.round(p * 1000);
    if (q !== this.shown) {
      this.shown = q;
      this.fill.style.transform = `scaleX(${(q / 1000).toFixed(3)})`;
      this.head.style.transform = `translateX(${(q / 10).toFixed(1)}cqw)`;
      setText(this.pct, String(Math.round(p * 100)));
    }
    const l = label || 'Loading';
    if (l !== this.lastLabel) {
      this.lastLabel = l;
      setText(this.label, l.replace(/[.…]+$/, ''));
    }
  }
}
