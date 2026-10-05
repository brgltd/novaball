/** Reusable menu widgets: option pickers, toggles, sliders, choice cards, buttons, key glyphs. */
import { h, span, textNode, setText, clamp, frag } from './dom';
import { ICONS, type IconName } from './icons';
import type { UIContext } from './core';

/** Left/right handlers for `data-adjust` items (read by the UIManager's navigation). */
export const adjustHandlers = new WeakMap<HTMLElement, (dir: -1 | 1, repeat: boolean) => void>();

export interface Row {
  el: HTMLElement;
  refresh(): void;
}

export function icon(name: IconName, cls = ''): HTMLElement {
  const el = frag<SVGElement>(ICONS[name]);
  if (cls) el.classList.add(...cls.split(' ').filter(Boolean));
  return el as unknown as HTMLElement;
}

// ------------------------------------------------------------------------------ glyphs

/** Keyboard keycap. */
export function kbd(label: string, wide = false): HTMLElement {
  return span(`nb-kbd${wide ? ' is-wide' : ''}`, label);
}

/** Gamepad face button / bumper / trigger / stick glyph. */
export function gp(label: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'LS' | 'RS' | 'START' | 'BACK' | 'DPAD'): HTMLElement {
  if (label === 'A' || label === 'B' || label === 'X' || label === 'Y') return span(`nb-gp nb-gp-face nb-gp-${label.toLowerCase()}`, label);
  if (label === 'LB' || label === 'RB') return span('nb-gp nb-gp-bumper', label);
  if (label === 'LT' || label === 'RT') return span('nb-gp nb-gp-trigger', label);
  if (label === 'LS' || label === 'RS') {
    const el = span('nb-gp nb-gp-stick');
    el.append(icon('stick'), span('nb-gp-stick-l', label));
    return el;
  }
  if (label === 'DPAD') return span('nb-gp nb-gp-menu', '✚');
  return span('nb-gp nb-gp-menu', label === 'START' ? '☰' : '⧉');
}

export function mouseGlyph(button: 'left' | 'right'): HTMLElement {
  const el = span('nb-mouse');
  el.append(icon(button === 'left' ? 'mouseLeft' : 'mouseRight'));
  return el;
}

/** A hint chip that swaps between keyboard and gamepad glyphs based on the active device (CSS driven). */
export function hint(kb: Array<HTMLElement | string>, pad: Array<HTMLElement | string>, label: string): HTMLElement {
  const k = span('nb-hint-keys nb-only-kb');
  k.append(...kb.map((x) => (typeof x === 'string' ? kbd(x) : x)));
  const g = span('nb-hint-keys nb-only-gp');
  g.append(...pad.map((x) => (typeof x === 'string' ? span('nb-gp nb-gp-menu', x) : x)));
  return h('span', { class: 'nb-hint' }, k, g, span('nb-hint-label', label));
}

// ------------------------------------------------------------------------------ buttons

export interface ButtonOpts {
  label: string;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  sub?: string;
  onClick: () => void;
  sound?: 'click' | 'start' | 'back' | null;
  cls?: string;
}

export function button(ctx: UIContext, o: ButtonOpts): HTMLButtonElement {
  const b = h('button', { class: `nb-btn nb-btn-${o.variant ?? 'secondary'} ${o.cls ?? ''}`, type: 'button', 'data-nav': '' });
  const inner = span('nb-btn-inner');
  if (o.icon) inner.append(icon(o.icon, 'nb-btn-ico'));
  inner.append(span('nb-btn-label', o.label));
  if (o.sub) inner.append(span('nb-btn-sub', o.sub));
  b.append(inner);
  b.addEventListener('click', () => {
    const snd = o.sound === undefined ? 'click' : o.sound;
    if (snd) ctx.sound(snd);
    o.onClick();
  });
  return b;
}

// ------------------------------------------------------------------------------ settings rows

function rowShell(label: string, desc: string | undefined, control: HTMLElement, cls: string, help?: string): HTMLElement {
  const row = h('div', { class: `nb-row ${cls}`, 'data-nav': '', tabindex: '-1', role: 'group', 'data-label': label, 'data-help': help ?? desc ?? '' });
  const text = h('div', { class: 'nb-row-text' }, h('div', { class: 'nb-row-label' }, label), desc ? h('div', { class: 'nb-row-desc' }, desc) : null);
  row.append(text, control);
  return row;
}

export interface OptionRowOpts<T> {
  label: string;
  desc?: string;
  /** Longer explanation shown in the settings side panel. */
  help?: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  get: () => T;
  set: (v: T) => void;
}

/** Segmented picker. Left/right cycles, click / A advances, click on a segment picks it. */
export function optionRow<T>(ctx: UIContext, o: OptionRowOpts<T>): Row {
  const seg = h('div', { class: 'nb-seg' });
  const btns = o.options.map((opt, i) => {
    const b = h('span', { class: 'nb-seg-opt' }, opt.label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      choose(i);
    });
    seg.append(b);
    return b;
  });
  const el = rowShell(o.label, o.desc, seg, 'nb-row-option', o.help);
  el.setAttribute('data-adjust', '');
  const index = () => Math.max(0, o.options.findIndex((x) => x.value === o.get()));
  const choose = (i: number) => {
    const n = o.options.length;
    const j = ((i % n) + n) % n;
    if (j === index() && o.options[j].value === o.get()) return;
    o.set(o.options[j].value);
    ctx.sound('toggle');
    refresh();
    ctx.settingsChanged();
  };
  const refresh = () => {
    const i = index();
    btns.forEach((b, k) => b.classList.toggle('is-on', k === i));
  };
  el.addEventListener('click', () => choose(index() + 1));
  adjustHandlers.set(el, (dir) => {
    const i = index() + dir;
    if (i < 0 || i >= o.options.length) {
      ctx.sound('error');
      return;
    }
    choose(i);
  });
  refresh();
  return { el, refresh };
}

export interface ToggleRowOpts {
  label: string;
  desc?: string;
  help?: string;
  get: () => boolean;
  set: (v: boolean) => void;
  /** Not a stored setting (e.g. fullscreen): don't emit settingsChanged. */
  silent?: boolean;
}

export function toggleRow(ctx: UIContext, o: ToggleRowOpts): Row {
  const knob = span('nb-switch-knob');
  const stateText = textNode('');
  const sw = h('span', { class: 'nb-switch', role: 'switch' }, h('span', { class: 'nb-switch-track' }, knob), h('span', { class: 'nb-switch-text' }, stateText));
  const el = rowShell(o.label, o.desc, sw, 'nb-row-toggle', o.help);
  el.setAttribute('data-adjust', '');
  const refresh = () => {
    const on = o.get();
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
    setText(stateText, on ? 'ON' : 'OFF');
  };
  const setv = (v: boolean) => {
    if (v === o.get()) return;
    o.set(v);
    ctx.sound('toggle');
    refresh();
    if (!o.silent) ctx.settingsChanged();
  };
  el.addEventListener('click', () => setv(!o.get()));
  adjustHandlers.set(el, (dir) => setv(dir > 0));
  refresh();
  return { el, refresh };
}

export interface SliderRowOpts {
  label: string;
  desc?: string;
  help?: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format: (v: number) => string;
}

export function sliderRow(ctx: UIContext, o: SliderRowOpts): Row {
  const fill = span('nb-slider-fill');
  const thumb = span('nb-slider-thumb');
  const track = h('span', { class: 'nb-slider-track' }, fill, thumb);
  const valueText = textNode('');
  const control = h('div', { class: 'nb-slider' }, track, h('span', { class: 'nb-slider-value' }, valueText));
  const el = rowShell(o.label, o.desc, control, 'nb-row-slider', o.help);
  el.setAttribute('data-adjust', '');
  const decimals = o.step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(o.step)) + 1);
  const quantize = (v: number) => {
    const q = Math.round((clamp(v, o.min, o.max) - o.min) / o.step) * o.step + o.min;
    return Number(clamp(q, o.min, o.max).toFixed(decimals));
  };
  let lastTick = 0;
  const refresh = () => {
    const v = o.get();
    const t = (clamp(v, o.min, o.max) - o.min) / (o.max - o.min);
    fill.style.transform = `scaleX(${t.toFixed(4)})`;
    thumb.style.left = `${(t * 100).toFixed(2)}%`;
    setText(valueText, o.format(v));
  };
  const setv = (raw: number, tick: boolean) => {
    const v = quantize(raw);
    if (v === o.get()) return false;
    o.set(v);
    refresh();
    ctx.settingsChanged();
    const now = performance.now();
    if (tick && now - lastTick > 45) {
      lastTick = now;
      ctx.sound('hover');
    }
    return true;
  };
  adjustHandlers.set(el, (dir) => {
    if (!setv(o.get() + dir * o.step, true)) ctx.sound('error');
  });
  // Pointer drag on the track.
  let dragging = false;
  const fromPointer = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    setv(o.min + t * (o.max - o.min), true);
  };
  control.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    control.setPointerCapture(e.pointerId);
    fromPointer(e);
    e.preventDefault();
  });
  control.addEventListener('pointermove', (e) => {
    if (dragging) fromPointer(e);
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      control.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  control.addEventListener('pointerup', end);
  control.addEventListener('pointercancel', end);
  refresh();
  return { el, refresh };
}

// ------------------------------------------------------------------------------ choice cards

export interface ChoiceGroup<T> {
  el: HTMLElement;
  cards: HTMLElement[];
  refresh(): void;
}

/** A row of selectable cards (radio semantics). `build` fills each card's content. */
export function choiceGroup<T>(
  ctx: UIContext,
  cls: string,
  items: ReadonlyArray<{ value: T; build: (card: HTMLElement) => void }>,
  get: () => T,
  set: (v: T) => void,
): ChoiceGroup<T> {
  const el = h('div', { class: `nb-choices ${cls}`, role: 'radiogroup' });
  const cards = items.map((it) => {
    const c = h('button', { class: 'nb-card', type: 'button', 'data-nav': '', role: 'radio' });
    it.build(c);
    c.append(h('span', { class: 'nb-card-check' }, icon('check')));
    c.addEventListener('click', () => {
      if (get() === it.value) {
        ctx.sound('click');
        return;
      }
      set(it.value);
      ctx.sound('toggle');
      refresh();
      ctx.settingsChanged();
    });
    el.append(c);
    return c;
  });
  const refresh = () => {
    const v = get();
    items.forEach((it, i) => {
      const on = it.value === v;
      cards[i].classList.toggle('is-selected', on);
      cards[i].setAttribute('aria-checked', String(on));
    });
  };
  refresh();
  return { el, cards, refresh };
}

/** Section heading used in menus. */
export function sectionTitle(text: string, extra?: HTMLElement | null): HTMLElement {
  return h('div', { class: 'nb-section-title' }, span('nb-section-bar'), span('nb-section-text', text), extra ?? null);
}
