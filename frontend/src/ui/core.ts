/** Shared UI plumbing: the context handed to panels and the Panel base class. */
import type { UICallbacks, UiSound } from '../contracts';
import type { Settings } from '../settings';
import type { MatchConfig } from '../sim/types';

export type PanelName = 'setup' | 'garage' | 'settings' | 'controls' | 'tutorial' | 'wallet' | 'leaderboard';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface UIContext {
  readonly settings: Settings;
  readonly cb: UICallbacks;
  sound(s: UiSound): void;
  /** Call after mutating `settings`: notifies the game (coalesced to ≤ 1 call / frame) and persists. */
  settingsChanged(): void;
  push(panel: Panel): void;
  pop(): void;
  open(name: PanelName): void;
  focus(el: HTMLElement | null): void;
  confirm(opts: ConfirmOptions, onConfirm: () => void): void;
  /** Launch a match (handles the first-time HOW TO PLAY card). */
  launch(cfg: MatchConfig): void;
  /** Launch a Free Play session with the player's garage setup. */
  freePlay(): void;
  /** Where the settings/controls panels were opened from (for styling). */
  readonly context: 'main' | 'pause' | 'end' | 'none';
  /** Browser fullscreen: current state, and a toggle (must run inside a click / key press). */
  readonly fullscreen: boolean;
  toggleFullscreen(): void;
  /** Subscribe to fullscreen changes; returns an unsubscribe function. */
  onFullscreenChange(fn: (on: boolean) => void): () => void;
}

export abstract class Panel {
  abstract readonly el: HTMLElement;
  /** Vertical focus wrap-around. */
  wrap = false;
  /** Root panels (main / pause / end) are never popped by "back". */
  root = false;
  /** Restored when the panel becomes the top of the stack again. */
  lastFocus: HTMLElement | null = null;

  abstract defaultFocus(): HTMLElement | null;
  /** The panel became the top of the stack. */
  onShow(): void {}
  /** The panel left the stack (or got covered). */
  onHide(): void {}
  /** Esc / B. Return true when handled internally (otherwise the stack pops). */
  onBack(): boolean {
    return false;
  }
  /** LB / RB, Q / E, PageUp / PageDown. */
  onTab(_dir: -1 | 1): boolean {
    return false;
  }
  /** Gamepad Start. */
  onStart(): boolean {
    return false;
  }
}
