/**
 * FIRST FLIGHT coach: a slim column of control chips above the NOVA PULSE badge during a player's first matches.
 * Each chip ticks the first time the control is used; the column fades once everything is ticked or after 30 s of
 * live play. Shown in the first COACH_MATCHES matches and the first Free Play (UI-owned localStorage counter).
 */
import type { HudState } from '../../contracts';
import type { ControlState } from '../../sim/types';
import { h, span, toggleClass } from '../dom';
import { gp, icon, kbd } from '../widgets';

const STORAGE_KEY = 'novaball.coach.v1';
const COACH_MATCHES = 2;
const COACH_FREE = 1;
/** Seconds of live play ('playing', no replay) after which the coach bows out anyway. */
const MAX_PLAY_S = 30;
/** Pause between the last tick and the fade, so the final check mark is seen. */
const DONE_HOLD_MS = 900;

export type CoachChip = 'drive' | 'steer' | 'jump' | 'boost' | 'pulse';

interface CoachStore {
  matches: number;
  free: number;
}

function readStore(): CoachStore {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CoachStore>;
      return { matches: Math.max(0, Number(p.matches) || 0), free: Math.max(0, Number(p.free) || 0) };
    }
  } catch {
    /* storage blocked / corrupt: coach as a first-timer */
  }
  return { matches: 0, free: 0 };
}

function writeStore(s: CoachStore): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the coach just shows again next time */
  }
}

export class Coach {
  readonly el: HTMLElement;
  private readonly chips = new Map<CoachChip, HTMLElement>();
  private readonly ticked = new Set<CoachChip>();
  private active = false;
  private done = false;
  private pulseEnabled = true;
  private playMs = 0;
  private lastT = -1;
  private doneTimer = 0;
  /** Called when the coach column appears / disappears (the HUD keeps the ball arrow clear of it). */
  onVisibleChange: ((visible: boolean) => void) | null = null;
  private visible = false;

  constructor() {
    const chip = (id: CoachChip, kb: HTMLElement[], pad: HTMLElement[], label: string) => {
      const el = h(
        'div',
        { class: `nb-coach-chip c-${id}` },
        h('span', { class: 'nb-coach-keys' }, h('span', { class: 'nb-only-kb' }, ...kb), h('span', { class: 'nb-only-gp' }, ...pad)),
        span('nb-coach-label', label),
        h('span', { class: 'nb-coach-tick' }, icon('check')),
      );
      this.chips.set(id, el);
      return el;
    };
    this.el = h(
      'div',
      { class: 'nb-coach', 'aria-hidden': 'true' },
      h('div', { class: 'nb-coach-head' }, span('nb-coach-k', 'FIRST FLIGHT'), span('nb-coach-line')),
      chip('drive', [kbd('W'), kbd('S')], [gp('RT'), gp('LT')], 'DRIVE'),
      chip('steer', [kbd('A'), kbd('D')], [gp('LS')], 'STEER'),
      chip('jump', [kbd('SPACE', true)], [gp('A')], 'JUMP · 2× FLIP'),
      chip('boost', [kbd('SHIFT', true)], [gp('B')], 'BOOST'),
      chip('pulse', [kbd('F')], [gp('RB')], 'NOVA PULSE'),
    );
  }

  /** Stored counters say this would be the player's very first (non-free-play) match. */
  static isFirstMatch(): boolean {
    return readStore().matches === 0;
  }

  /** A new match / free-play session began: coach it if the player is still new. Returns true when shown. */
  begin(freePlay: boolean, pulseEnabled: boolean): boolean {
    this.reset();
    const st = readStore();
    const show = freePlay ? st.free < COACH_FREE : st.matches < COACH_MATCHES;
    if (!show) return false;
    if (freePlay) st.free++;
    else st.matches++;
    writeStore(st);
    this.active = true;
    this.pulseEnabled = pulseEnabled;
    toggleClass(this.chips.get('pulse')!, 'is-na', !pulseEnabled);
    if (!pulseEnabled) this.ticked.add('pulse');
    return true;
  }

  /** Stop coaching immediately (match over, quit, restart). */
  reset(): void {
    window.clearTimeout(this.doneTimer);
    this.doneTimer = 0;
    this.active = false;
    this.done = false;
    this.playMs = 0;
    this.lastT = -1;
    this.ticked.clear();
    for (const c of this.chips.values()) c.classList.remove('is-ticked', 'is-na');
    this.el.classList.remove('is-done');
    this.setVisible(false);
  }

  get isActive(): boolean {
    return this.active && !this.done;
  }

  /** Per-frame HUD state: live-play clock (30 s cap) and visibility (hidden in replays, pauses and after the match). */
  update(hs: HudState, screenHud: boolean): void {
    if (!this.active) return;
    const now = performance.now();
    const dt = this.lastT < 0 ? 0 : Math.min(250, now - this.lastT);
    this.lastT = now;
    const live = screenHud && !hs.replay;
    if (live && hs.phase === 'playing' && !this.done) {
      this.playMs += dt;
      if (this.playMs >= MAX_PLAY_S * 1000) this.finish(0);
    }
    if (hs.phase === 'ended') this.finish(0);
    if (this.pulseEnabled !== hs.pulseEnabled) {
      this.pulseEnabled = hs.pulseEnabled;
      toggleClass(this.chips.get('pulse')!, 'is-na', !hs.pulseEnabled);
      if (!hs.pulseEnabled) this.tick('pulse');
    }
    this.setVisible(!this.done && live && hs.phase !== 'ended');
  }

  /** The player's sampled controls this frame (live play only). */
  onControls(c: Readonly<ControlState>): void {
    if (!this.active || this.done) return;
    if (c.throttle > 0.2 || c.throttle < -0.2) this.tick('drive');
    if (c.steer > 0.2 || c.steer < -0.2) this.tick('steer');
    if (c.jump) this.tick('jump');
    if (c.boost) this.tick('boost');
    if (c.pulse) this.tick('pulse');
  }

  tick(id: CoachChip): void {
    if (!this.active || this.done || this.ticked.has(id)) return;
    this.ticked.add(id);
    this.chips.get(id)?.classList.add('is-ticked');
    if (this.ticked.size >= this.chips.size) this.finish(DONE_HOLD_MS);
  }

  private finish(holdMs: number): void {
    if (this.done || this.doneTimer) {
      if (holdMs === 0 && this.doneTimer) {
        window.clearTimeout(this.doneTimer);
        this.doneTimer = 0;
        this.markDone();
      }
      return;
    }
    if (holdMs <= 0) this.markDone();
    else this.doneTimer = window.setTimeout(() => {
      this.doneTimer = 0;
      this.markDone();
    }, holdMs);
  }

  private markDone(): void {
    this.done = true;
    this.el.classList.add('is-done');
    this.setVisible(false);
  }

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    toggleClass(this.el, 'is-on', v);
    try {
      this.onVisibleChange?.(v);
    } catch (err) {
      console.error('[UI] coach visibility listener failed', err);
    }
  }
}
