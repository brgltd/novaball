/**
 * Notifications: big banners (queued, prioritized, never overlapping) + a small right-side feed.
 *
 * Two banner styles:
 *  - FULL (stoppages: GOAL / OWN GOAL / OVERTIME / HAT TRICK, and anything shown outside live play, e.g. FULL TIME):
 *    centre slam with flash, band, ring and rays.
 *  - COMPACT (every other big banner while the ball is live — phase 'playing', no replay): one slim line under the
 *    scoreboard / CORE CHARGE pill, so it never covers the band where ball cam frames an airborne ball.
 * Live-play banners are news: they are dropped when they would start more than MAX_AGE after notify(), and a newer
 * one may cut the current compact banner short once it has been readable for COMPACT_MIN_SHOW.
 * Every animation is transform / opacity only (compositor), and all glows are pre-rendered gradients.
 */
import type { HudNotification, NotificationKind } from '../../contracts';
import { TEAMS } from '../../theme';
import { cancelAnimations, h, play, span } from '../dom';
import type { IconName } from '../icons';
import { icon } from '../widgets';

const KIND_ICON: Record<NotificationKind, IconName> = {
  goal: 'goal',
  ownGoal: 'goal',
  assist: 'assist',
  save: 'save',
  epicSave: 'save',
  shot: 'shot',
  demolition: 'demo',
  demolished: 'demo',
  surge: 'surge',
  overtime: 'overtime',
  charge: 'charge',
  supernova: 'supernova',
  lastMinute: 'clock',
  hatTrick: 'hatTrick',
  info: 'info',
};

const KIND_PRIORITY: Record<NotificationKind, number> = {
  goal: 3,
  ownGoal: 3,
  overtime: 2,
  hatTrick: 2,
  supernova: 1,
  surge: 1,
  demolished: 1,
  epicSave: 1,
  lastMinute: 1,
  save: 0,
  demolition: 0,
  assist: 0,
  shot: 0,
  charge: 0,
  info: 0,
};

/** Kinds that always use the full centre banner (they happen while play is stopped, or are the headline). */
const STOPPAGE_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>(['goal', 'ownGoal', 'overtime', 'hatTrick']);

/** Full-banner display time (ms). */
const KIND_DURATION: Partial<Record<NotificationKind, number>> = {
  goal: 3300,
  ownGoal: 3000,
  overtime: 1800,
  hatTrick: 1800,
};
const DEFAULT_DURATION = 1700;
const COMPACT_DURATION = 1500;
/** A newer compact banner may replace the current one once it has been up this long (ms). */
const COMPACT_MIN_SHOW = 550;
const CLOSE_MS = 320;
const FAST_CLOSE_MS = 150;

/** Live-play news goes stale fast: dropped if it would start later than this after notify() (ms). */
const MAX_AGE: Partial<Record<NotificationKind, number>> = {
  surge: 800,
  lastMinute: 800,
  supernova: 800,
  demolished: 800,
  demolition: 800,
  epicSave: 800,
};
const LOW_PRIO_MAX_AGE = 4000;

function maxAge(kind: NotificationKind, prio: number): number {
  return MAX_AGE[kind] ?? (prio < 2 ? LOW_PRIO_MAX_AGE : Number.POSITIVE_INFINITY);
}

const FIXED_COLOR: Partial<Record<NotificationKind, [string, string]>> = {
  surge: ['#b44dff', '#e2b8ff'],
  overtime: ['#ffb627', '#fff0c2'],
  lastMinute: ['#ffc53d', '#fff0c2'],
  demolished: ['#ff3d5a', '#ffb3c0'],
  info: ['#9fb8ff', '#e6f0ff'],
};

function colors(n: HudNotification): [string, string] {
  const fixed = FIXED_COLOR[n.kind];
  if (fixed) return fixed;
  if (n.team === 0 || n.team === 1) return [TEAMS[n.team].primary, TEAMS[n.team].secondary];
  if (n.kind === 'supernova' || n.kind === 'charge') return ['#ffffff', '#e6f3ff'];
  return ['#9fb8ff', '#e6f0ff'];
}

function goalBadge(points: number | undefined): string | null {
  if (points === undefined || points <= 0) return null;
  if (points >= 3) return `+${points} SUPERNOVA`;
  if (points === 2) return '+2 CHARGED';
  return '+1';
}

function isGoalKind(k: NotificationKind): boolean {
  return k === 'goal' || k === 'ownGoal';
}

function same(a: HudNotification, b: HudNotification): boolean {
  return a.kind === b.kind && a.title === b.title && a.subtitle === b.subtitle;
}

interface Active {
  n: HudNotification;
  el: HTMLElement;
  prio: number;
  compact: boolean;
  timer: number;
  closing: boolean;
  /** Cut short for a newer banner: close fast. */
  cut: boolean;
  /** performance.now() when it appeared / when it is due to close. */
  start: number;
  end: number;
  /** ms left on the close timer while paused. */
  left: number;
}

interface FeedItem {
  el: HTMLElement;
  timer: number;
  end: number;
  left: number;
}

export class Notifications {
  readonly el: HTMLElement;
  private readonly bannerSlot: HTMLElement;
  private readonly compactSlot: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly queue: Array<{ n: HudNotification; prio: number; t: number }> = [];
  private active: Active | null = null;
  private feedItems: FeedItem[] = [];
  /** Ball in play (phase 'playing', no replay): non-stoppage banners render compact. */
  private live = false;
  private paused = false;
  /** Animations frozen by setPaused(true) (only those that were running: play() would rewind finished ones). */
  private readonly frozen: Animation[] = [];
  enabled = true;
  /** Called when a compact banner appears / goes away (the HUD hides the surge widget under it). */
  onCompactChange: ((on: boolean) => void) | null = null;

  constructor() {
    this.bannerSlot = h('div', { class: 'nb-banner-slot', 'aria-live': 'polite' });
    this.compactSlot = h('div', { class: 'nb-banner-cslot', 'aria-live': 'polite' });
    this.feed = h('div', { class: 'nb-feed', 'aria-live': 'polite' });
    this.el = h('div', { class: 'nb-notify' }, this.bannerSlot, this.compactSlot, this.feed);
  }

  notify(n: HudNotification): void {
    if (!this.enabled) return;
    if (n.big) this.enqueue(n);
    else this.pushFeed(n);
  }

  /** Live play (ball in play, no replay) → non-stoppage banners shown from now on are compact. */
  setLive(live: boolean): void {
    this.live = live;
  }

  /** True while a banner (big or compact) is on screen. */
  get bannerActive(): boolean {
    return this.active !== null;
  }

  /** True while a compact banner is on screen. */
  get compactActive(): boolean {
    return !!this.active && this.active.compact && !this.active.closing;
  }

  /** Drop everything immediately (banners, queue, feed). */
  clear(): void {
    this.queue.length = 0;
    this.frozen.length = 0;
    const a = this.active;
    if (a) {
      window.clearTimeout(a.timer);
      cancelAnimations(a.el);
      a.el.remove();
      this.active = null;
      if (a.compact) this.compactChanged(false);
    }
    for (const f of this.feedItems) {
      window.clearTimeout(f.timer);
      f.el.remove();
    }
    this.feedItems = [];
  }

  /** Close the active big banner quickly and empty the big-banner queue (the side feed is kept). */
  clearBanners(): void {
    this.queue.length = 0;
    if (this.active && !this.active.closing) this.close(this.active, FAST_CLOSE_MS);
  }

  /** Forget queued big banners (they are stale news by the time a replay ends); the active one finishes. */
  dropQueued(): void {
    this.queue.length = 0;
  }

  /** Close the active big banner if it is of `kind`, and drop queued big banners of that kind. */
  dismiss(kind: NotificationKind): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].n.kind === kind) this.queue.splice(i, 1);
    if (this.active && !this.active.closing && this.active.n.kind === kind) this.close(this.active, FAST_CLOSE_MS);
  }

  /** Freeze banner / feed timers and animations (pause screen), or resume them. */
  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    const now = performance.now();
    const a = this.active;
    if (p) {
      if (a) {
        window.clearTimeout(a.timer);
        a.left = Math.max(0, a.end - now);
      }
      for (const f of this.feedItems) {
        window.clearTimeout(f.timer);
        f.left = Math.max(0, f.end - now);
      }
    } else {
      if (a && !a.closing) this.armBanner(a, a.left);
      for (const f of this.feedItems) this.armFeed(f, f.left);
    }
    // freeze / resume the animations running under the banners and the feed (WAAPI and CSS)
    if (p) {
      for (const el of [this.bannerSlot, this.compactSlot, this.feed]) {
        if (typeof el.getAnimations !== 'function') continue;
        for (const anim of el.getAnimations({ subtree: true })) {
          if (anim.playState !== 'running') continue;
          try {
            anim.pause();
            this.frozen.push(anim);
          } catch {
            /* detached */
          }
        }
      }
    } else {
      for (const anim of this.frozen) {
        try {
          if (anim.playState === 'paused') anim.play();
        } catch {
          /* cancelled / detached */
        }
      }
      this.frozen.length = 0;
      if (!this.active) this.showNext();
    }
  }

  // ------------------------------------------------------------------ big banners

  private enqueue(n: HudNotification): void {
    const prio = KIND_PRIORITY[n.kind] ?? 0;
    const now = performance.now();
    // Drop stale entries and exact duplicates.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (now - q.t > maxAge(q.n.kind, q.prio) || same(q.n, n)) this.queue.splice(i, 1);
    }
    const a = this.active;
    if (a && !a.closing && same(a.n, n)) return;
    // Insert by priority (stable).
    let at = this.queue.length;
    while (at > 0 && this.queue[at - 1].prio < prio) at--;
    const entry = { n, prio, t: now };
    this.queue.splice(at, 0, entry);
    while (this.queue.length > 4) {
      // drop the lowest-priority, oldest entry
      let worst = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].prio < this.queue[worst].prio) worst = i;
      this.queue.splice(worst, 1);
    }
    if (!a) {
      if (!this.paused) this.showNext();
      return;
    }
    if (a.closing || this.paused) return;
    if (prio > a.prio) {
      this.close(a, 160);
      return;
    }
    // Live-play news: a newer compact banner replaces the current one once it has been readable, instead of
    // waiting (and then being dropped as stale).
    if (a.compact && this.live && !STOPPAGE_KINDS.has(n.kind)) {
      const cutAt = Math.max(now, a.start + COMPACT_MIN_SHOW);
      if (cutAt < a.end) {
        a.cut = true;
        this.armBanner(a, cutAt - now);
      }
      // it has its slot now: its age counts from when that slot opens
      entry.t = Math.max(entry.t, Math.min(cutAt, a.end));
    }
  }

  private showNext(): void {
    const now = performance.now();
    let next = this.queue.shift();
    while (next && now - next.t > maxAge(next.n.kind, next.prio)) next = this.queue.shift();
    if (!next) return;
    const n = next.n;
    const compact = this.live && !STOPPAGE_KINDS.has(n.kind);
    const el = compact ? this.buildCompact(n) : this.buildBanner(n);
    (compact ? this.compactSlot : this.bannerSlot).append(el);
    const dur = compact ? COMPACT_DURATION : (KIND_DURATION[n.kind] ?? DEFAULT_DURATION);
    const act: Active = { n, el, prio: next.prio, compact, timer: 0, closing: false, cut: false, start: now, end: now + dur, left: dur };
    this.active = act;
    if (compact) {
      this.animateInCompact(el);
      this.compactChanged(true);
    } else this.animateIn(el, n);
    this.armBanner(act, dur);
  }

  private armBanner(a: Active, ms: number): void {
    window.clearTimeout(a.timer);
    a.end = performance.now() + ms;
    a.left = ms;
    if (this.paused) return;
    a.timer = window.setTimeout(() => this.close(a, a.cut ? FAST_CLOSE_MS : CLOSE_MS), Math.max(0, ms));
  }

  private close(a: Active, ms: number): void {
    if (a.closing) return;
    a.closing = true;
    window.clearTimeout(a.timer);
    if (a.compact) this.compactChanged(false);
    const anim = play(
      a.el,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: a.compact ? 'translateY(-8px)' : 'translateY(-14px) scale(1.04)' },
      ],
      { duration: ms, easing: 'ease-in', fill: 'forwards' },
    );
    const done = () => {
      a.el.remove();
      if (this.active === a) {
        this.active = null;
        if (!this.paused) this.showNext();
      }
    };
    if (anim) anim.onfinish = done;
    else done();
  }

  private compactChanged(on: boolean): void {
    try {
      this.onCompactChange?.(on);
    } catch (err) {
      console.error('[UI] onCompactChange failed', err);
    }
  }

  private buildBanner(n: HudNotification): HTMLElement {
    const [c1, c2] = colors(n);
    const isGoal = isGoalKind(n.kind);
    // 14 rays in two groups: each group bursts with ONE animation (scale / opacity), not one per ray.
    const rays = h('div', { class: 'nb-banner-rays' });
    if (isGoal || n.kind === 'supernova' || n.kind === 'hatTrick') {
      for (let g = 0; g < 2; g++) {
        const group = span(`nb-ray-group g${g}`);
        for (let i = g; i < 14; i += 2) {
          const r = span('nb-ray');
          r.style.transform = `rotate(${((i * 360) / 14 + (i % 2) * 7).toFixed(1)}deg) translateX(calc(38 * var(--u)))`;
          group.append(r);
        }
        rays.append(group);
      }
    }
    let title = n.title;
    if (!title) title = isGoal ? (n.kind === 'ownGoal' ? 'OWN GOAL' : 'GOAL!') : n.kind.toUpperCase();
    const badge = isGoal ? goalBadge(n.points) : n.points ? `+${n.points}` : null;
    const el = h(
      'div',
      { class: `nb-banner k-${n.kind}${badge && isGoal && (n.points ?? 0) >= 3 ? ' is-supernova' : ''}` },
      span('nb-banner-flash'),
      span('nb-banner-band'),
      span('nb-banner-line l1'),
      span('nb-banner-line l2'),
      span('nb-banner-ring'),
      rays,
      h(
        'div',
        { class: 'nb-banner-content' },
        h('div', { class: 'nb-banner-titlewrap' }, h('span', { class: 'nb-banner-ico' }, icon(KIND_ICON[n.kind])), h('span', { class: 'nb-banner-title', 'data-text': title }, title)),
        n.subtitle ? h('div', { class: 'nb-banner-sub' }, n.subtitle) : null,
        badge ? h('div', { class: 'nb-banner-pts' }, badge) : null,
      ),
    );
    el.style.setProperty('--tc', c1);
    el.style.setProperty('--tc2', c2);
    return el;
  }

  private buildCompact(n: HudNotification): HTMLElement {
    const [c1, c2] = colors(n);
    const title = n.title || n.kind.toUpperCase();
    const badge = n.points ? `+${n.points}` : null;
    const el = h(
      'div',
      { class: `nb-banner is-compact k-${n.kind}` },
      h(
        'div',
        { class: 'nb-cb-row' },
        span('nb-cb-glow'),
        h('span', { class: 'nb-cb-ico' }, icon(KIND_ICON[n.kind])),
        span('nb-cb-title', title),
        n.subtitle ? span('nb-cb-sub', n.subtitle) : null,
        badge ? span('nb-cb-pts', badge) : null,
        span('nb-cb-line'),
      ),
    );
    el.style.setProperty('--tc', c1);
    el.style.setProperty('--tc2', c2);
    return el;
  }

  private animateInCompact(el: HTMLElement): void {
    const ease = 'cubic-bezier(.16,1,.3,1)';
    const row = el.querySelector<HTMLElement>('.nb-cb-row');
    const line = el.querySelector<HTMLElement>('.nb-cb-line');
    if (row)
      play(
        row,
        [
          { transform: 'translateY(-6px) scale(1.14)', opacity: 0 },
          { transform: 'scale(0.98)', opacity: 1, offset: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 300, easing: ease, fill: 'both' },
      );
    if (line) play(line, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 420, delay: 60, easing: ease, fill: 'both' });
  }

  // Entrance animations use fill 'both': a finished effect keeps its (identity) end value instead of handing back to
  // the base style, which would invalidate layout once per element as each one ends.
  private animateIn(el: HTMLElement, n: HudNotification): void {
    const isGoal = isGoalKind(n.kind);
    const q = (s: string) => el.querySelector<HTMLElement>(s);
    const title = q('.nb-banner-titlewrap');
    const band = q('.nb-banner-band');
    const flash = q('.nb-banner-flash');
    const ring = q('.nb-banner-ring');
    const sub = q('.nb-banner-sub');
    const pts = q('.nb-banner-pts');
    const l1 = q('.nb-banner-line.l1');
    const l2 = q('.nb-banner-line.l2');
    const ease = 'cubic-bezier(.16,1,.3,1)';
    if (band) play(band, [{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }], { duration: 420, easing: ease, fill: 'both' });
    if (l1) play(l1, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600, delay: 60, easing: ease, fill: 'both' });
    if (l2) play(l2, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600, delay: 120, easing: ease, fill: 'both' });
    // transform / opacity only (compositor): no letter-spacing animation, modest start scale
    if (title)
      play(
        title,
        isGoal
          ? [
              { transform: 'scale(1.6)', opacity: 0 },
              { transform: 'scale(0.94)', opacity: 1, offset: 0.55 },
              { transform: 'scale(1)', opacity: 1 },
            ]
          : [
              { transform: 'scale(1.45)', opacity: 0 },
              { transform: 'scale(0.97)', opacity: 1, offset: 0.6 },
              { transform: 'scale(1)', opacity: 1 },
            ],
        { duration: isGoal ? 480 : 380, easing: ease, fill: 'both' },
      );
    if (flash) play(flash, [{ opacity: isGoal ? 0.5 : 0.4 }, { opacity: 0 }], { duration: isGoal ? 650 : 450, easing: 'ease-out', fill: 'forwards' });
    if (ring) play(ring, [{ transform: 'translate(-50%,-50%) scale(0.15)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }], { duration: isGoal ? 900 : 650, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
    if (sub) play(sub, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 220, easing: ease, fill: 'both' });
    // the badge is skewed in CSS: keep the skew in every keyframe so it never snaps at the end
    if (pts)
      play(
        pts,
        [
          { opacity: 0, transform: 'skewX(-10deg) scale(0.6)' },
          { opacity: 1, transform: 'skewX(-10deg) scale(1.12)', offset: 0.7 },
          { opacity: 1, transform: 'skewX(-10deg) scale(1)' },
        ],
        { duration: 420, delay: 380, easing: ease, fill: 'both' },
      );
    el.querySelectorAll<HTMLElement>('.nb-ray-group').forEach((g, i) =>
      play(
        g,
        [
          { transform: 'scale(0.2)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1, offset: 0.35 },
          { transform: `scale(${i ? 2.1 : 2.5})`, opacity: 0 },
        ],
        { duration: i ? 820 : 900, delay: i * 70, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'both' },
      ),
    );
  }

  // ------------------------------------------------------------------ feed

  private pushFeed(n: HudNotification): void {
    const [c1, c2] = colors(n);
    const pts = n.points && n.kind !== 'goal' && n.kind !== 'ownGoal' ? `+${n.points}` : null;
    const el = h(
      'div',
      { class: `nb-feed-item k-${n.kind}` },
      h('span', { class: 'nb-feed-ico' }, icon(KIND_ICON[n.kind])),
      h('span', { class: 'nb-feed-text' }, span('nb-feed-title', n.title || n.kind.toUpperCase()), n.subtitle ? span('nb-feed-sub', n.subtitle) : null),
      pts ? span('nb-feed-pts', pts) : null,
    );
    el.style.setProperty('--tc', c1);
    el.style.setProperty('--tc2', c2);
    this.feed.prepend(el);
    play(el, [{ opacity: 0, transform: 'translateX(40px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
    const item: FeedItem = { el, timer: 0, end: 0, left: 3800 };
    this.armFeed(item, 3800);
    this.feedItems.push(item);
    while (this.feedItems.length > 5) {
      const old = this.feedItems.shift()!;
      window.clearTimeout(old.timer);
      cancelAnimations(old.el);
      old.el.remove();
    }
  }

  private armFeed(item: FeedItem, ms: number): void {
    window.clearTimeout(item.timer);
    item.end = performance.now() + ms;
    item.left = ms;
    if (this.paused) return;
    item.timer = window.setTimeout(() => this.removeFeed(item), Math.max(0, ms));
  }

  private removeFeed(item: FeedItem): void {
    const i = this.feedItems.indexOf(item);
    if (i >= 0) this.feedItems.splice(i, 1);
    const a = play(item.el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(30px)' }], { duration: 260, easing: 'ease-in', fill: 'forwards' });
    if (a) a.onfinish = () => item.el.remove();
    else item.el.remove();
  }
}
