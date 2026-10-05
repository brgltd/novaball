/**
 * Spatial focus navigation for keyboard / gamepad menus.
 * Focusable items carry `data-nav`. Items with `data-adjust` consume left/right (value sliders / pickers).
 * Scrollable lists mark their scroll container with `data-scroll`.
 */

export type NavDir = 'up' | 'down' | 'left' | 'right';

export function isNavigable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.getClientRects().length === 0) return false;
  const cv = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof cv === 'function') return cv.call(el, { visibilityProperty: true });
  return true;
}

export function navItems(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    if (isNavigable(el)) out.push(el);
  });
  return out;
}

interface Cand {
  el: HTMLElement;
  r: DOMRect;
}

function gap(a0: number, a1: number, b0: number, b1: number): number {
  if (b0 > a1) return b0 - a1;
  if (a0 > b1) return a0 - b1;
  return 0;
}

/**
 * Pick the best candidate in `dir` from `cur`. Returns null if nothing lies in that direction.
 * Items may declare `data-nav-group`: vertical moves stay inside the current group (wrapping inside it when
 * `wrap` is set); horizontal moves may cross groups.
 */
export function spatialPick(curEl: HTMLElement, items: HTMLElement[], dir: NavDir, wrap: boolean): HTMLElement | null {
  const group = curEl.getAttribute('data-nav-group');
  if (group && (dir === 'up' || dir === 'down')) {
    const same = items.filter((el) => el.getAttribute('data-nav-group') === group);
    const inGroup = pickIn(curEl, same, dir, wrap);
    if (inGroup) return inGroup;
  }
  return pickIn(curEl, items, dir, wrap);
}

function pickIn(curEl: HTMLElement, items: HTMLElement[], dir: NavDir, wrap: boolean): HTMLElement | null {
  const cur = curEl.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  const cands: Cand[] = [];
  for (const el of items) if (el !== curEl && !el.contains(curEl) && !curEl.contains(el)) cands.push({ el, r: el.getBoundingClientRect() });
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    const r = c.r;
    const rcx = r.left + r.width / 2;
    const rcy = r.top + r.height / 2;
    let primary: number;
    let ortho: number;
    let align: number;
    if (dir === 'down' || dir === 'up') {
      const d = dir === 'down' ? rcy - cy : cy - rcy;
      if (d <= 2) continue;
      if (dir === 'down' ? r.bottom <= cur.bottom + 1 : r.top >= cur.top - 1) continue;
      primary = d;
      ortho = gap(cur.left, cur.right, r.left, r.right);
      align = Math.abs(rcx - cx);
    } else {
      const d = dir === 'right' ? rcx - cx : cx - rcx;
      if (d <= 2) continue;
      if (dir === 'right' ? r.right <= cur.right + 1 : r.left >= cur.left - 1) continue;
      primary = d;
      ortho = gap(cur.top, cur.bottom, r.top, r.bottom);
      align = Math.abs(rcy - cy);
    }
    const score = primary + ortho * 3 + align * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = c.el;
    }
  }
  if (best || !wrap || dir === 'left' || dir === 'right') return best;
  // Vertical wrap-around: jump to the farthest item on the opposite side, best aligned.
  let wrapBest: HTMLElement | null = null;
  let wrapScore = Infinity;
  for (const c of cands) {
    const r = c.r;
    const rcx = r.left + r.width / 2;
    const rcy = r.top + r.height / 2;
    const s = (dir === 'down' ? rcy : -rcy) + Math.abs(rcx - cx) * 0.5;
    if (s < wrapScore) {
      wrapScore = s;
      wrapBest = c.el;
    }
  }
  return wrapBest;
}

/** Scroll the nearest `[data-scroll]` ancestor so `el` is fully visible (never scrolls overflow:hidden screens). */
export function revealInScroller(el: HTMLElement): void {
  const sc = el.closest<HTMLElement>('[data-scroll]');
  if (!sc) return;
  const er = el.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  const pad = Math.min(24, sr.height * 0.08);
  if (er.top < sr.top + pad) sc.scrollTop -= sr.top + pad - er.top;
  else if (er.bottom > sr.bottom - pad) sc.scrollTop += er.bottom - (sr.bottom - pad);
}
