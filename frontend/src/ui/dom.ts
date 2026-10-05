/** Tiny DOM helpers for the NOVABALL UI (no framework). */

export type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined | EventListener | ((e: never) => void);
export type Attrs = Record<string, AttrValue>;

function applyAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const key in attrs) {
    const v = attrs[key];
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') {
      if (key.startsWith('on')) el.addEventListener(key.slice(2), v as EventListener);
      continue;
    }
    if (key === 'class') el.setAttribute('class', String(v));
    else if (key === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(v));
  }
}

function appendChildren(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Create an HTML element: h('div', { class: 'x', onclick: fn }, child, 'text'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs ?? undefined);
  appendChildren(el, children);
  return el;
}

/** Shorthand for a div with a class. */
export function div(cls: string, ...children: Child[]): HTMLDivElement {
  return h('div', { class: cls }, ...children);
}

/** Shorthand for a span with a class. */
export function span(cls: string, ...children: Child[]): HTMLSpanElement {
  return h('span', { class: cls }, ...children);
}

/** Parse an SVG (or any HTML) markup string into a single element. */
export function frag<T extends Element = Element>(markup: string): T {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild;
  if (!el) throw new Error('frag(): empty markup');
  return el as T;
}

/** A text node that can be updated cheaply via `.nodeValue`. */
export function textNode(initial = ''): Text {
  return document.createTextNode(initial);
}

/** Set a Text node's value only when it changed. */
export function setText(t: Text, v: string): void {
  if (t.nodeValue !== v) t.nodeValue = v;
}

/** Toggle a class only when the state changes (avoids style invalidation). */
export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

let reducedMql: MediaQueryList | null | undefined;

/** The user asked the OS / browser for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    if (reducedMql === undefined) reducedMql = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    return !!reducedMql?.matches;
  } catch {
    return false;
  }
}

export interface PlayOptions extends KeyframeAnimationOptions {
  /**
   * Keyframes used instead when the user prefers reduced motion. Default: the normal keyframes, applied instantly
   * (1 ms, no delay), i.e. the element jumps to its final state — right for entrances, exits and one-shot flourishes.
   * Pass a static set for effects whose final keyframe hides content that must stay readable (e.g. the GO! slam).
   */
  reduced?: Keyframe[];
  /** Duration of the reduced-motion variant (default 1 ms, capped at 150 ms) — for short, motion-free fades. */
  reducedMs?: number;
}

/**
 * Run a Web Animation on an element. Honors prefers-reduced-motion (CSS media rules do not reach WAAPI):
 * every animation then completes in ≤ 150 ms (default 1 ms) without delay, so nothing moves, scales or flashes.
 */
export function play(el: Element, keyframes: Keyframe[], opts: PlayOptions): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  try {
    const { reduced, reducedMs, ...o } = opts;
    if (prefersReducedMotion()) {
      const ms = Math.min(150, Math.max(1, reducedMs ?? 1));
      return (el as HTMLElement).animate(reduced ?? keyframes, { ...o, duration: ms, delay: 0, endDelay: 0, iterations: 1 });
    }
    return (el as HTMLElement).animate(keyframes, o);
  } catch {
    return null;
  }
}

export function cancelAnimations(el: Element): void {
  if (typeof (el as HTMLElement).getAnimations !== 'function') return;
  for (const a of (el as HTMLElement).getAnimations()) a.cancel();
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** m:ss */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Score / stat values. The score / stat styles render them in Rajdhani 700 with tabular figures: Orbitron's zero is
 * slashed ("Ø") and its capital O is a rounded square that reads as "□" in big standalone numbers.
 */
export function scoreText(n: number): string {
  return String(n);
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}
