/** The NOVABALL wordmark: chrome letters with neon glow; the "O" is the glowing Nova Core orb with orbit rings. */
import { h, span } from './dom';

const HEX_TILE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='48.5' viewBox='0 0 28 48.5'%3E%3Cpath d='M14 0 28 8.08v16.17L14 32.33 0 24.25V8.08z M14 32.33V48.5' fill='none' stroke='%23d8f6ff' stroke-width='1.3' stroke-opacity='.85'/%3E%3C/svg%3E\")";

export function orb(cls = ''): HTMLElement {
  const rings = (side: 'back' | 'front') =>
    h('span', { class: `nb-orb-rings is-${side}`, 'aria-hidden': 'true' }, span('nb-orb-ring r1'), span('nb-orb-ring r2'));
  const core = span('nb-orb-core');
  const shell = span('nb-orb-shell');
  shell.style.backgroundImage = HEX_TILE;
  core.append(shell, span('nb-orb-spec'));
  return h('span', { class: `nb-orb ${cls}`, 'aria-hidden': 'true' }, span('nb-orb-halo'), rings('back'), core, rings('front'));
}

/** Wordmark. `size` picks the CSS modifier (xl = title screen, lg = loading, sm = headers). */
export function logo(size: 'xl' | 'lg' | 'sm'): HTMLElement {
  const word = h('span', { class: 'nb-logo-word', role: 'img', 'aria-label': 'NOVABALL' });
  const letters = ['N', 'O', 'V', 'A', 'B', 'A', 'L', 'L'];
  letters.forEach((ch, i) => {
    if (ch === 'O' && i === 1) {
      const o = orb('nb-logo-orb');
      o.style.setProperty('--i', String(i));
      word.append(o);
      return;
    }
    const s = span('nb-logo-ch', ch);
    s.style.setProperty('--i', String(i));
    s.setAttribute('data-ch', ch);
    word.append(s);
  });
  return h('div', { class: `nb-logo nb-logo-${size}` }, word);
}
