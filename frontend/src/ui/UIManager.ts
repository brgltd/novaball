/**
 * NOVABALL — UIManager: menus, HUD, notifications, settings (plain DOM + CSS).
 *
 * Input ownership: while a menu screen is shown ('main' / 'pause' / 'end') the UI owns keyboard + gamepad
 * presses (via the shared InputHub); the gameplay InputSystem never sees a press the UI handled.
 * Pause root: Esc / B / Start → callbacks.onResume().
 */
import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import './styles/base.css';
import './styles/menus.css';
import './styles/panels.css';
import './styles/hud.css';
import './styles/chain.css';

import type { HudNotification, HudState, IUIManager, MatchSummary, NotificationKind, UICallbacks, UIScreen, UiSound } from '../contracts';
import { GP, inputHub, type InputDevice } from '../input/InputHub';
import { saveSettings, type Settings } from '../settings';
import { makeControlState, type ControlState, type MatchConfig } from '../sim/types';
import { Panel, type ConfirmOptions, type PanelName, type UIContext } from './core';
import { div, h } from './dom';
import { Coach, type CoachChip } from './hud/Coach';
import { Countdown } from './hud/Countdown';
import { Hud } from './hud/Hud';
import { Notifications } from './hud/Notifications';
import { ScoreTable } from './hud/ScoreTable';
import { isNavigable, navItems, revealInScroller, spatialPick, type NavDir } from './nav';
import { ConfirmDialog } from './screens/Confirm';
import { ControlsPanel } from './screens/ControlsPanel';
import { EndScreen } from './screens/EndScreen';
import { Garage } from './screens/Garage';
import { LoadingScreen } from './screens/Loading';
import { MainMenu } from './screens/MainMenu';
import { MatchSetup, randomSeed } from './screens/MatchSetup';
import { PauseMenu } from './screens/PauseMenu';
import { SettingsPanel } from './screens/SettingsPanel';
import { Tutorial } from './screens/Tutorial';
import { WalletPanel } from './screens/WalletPanel';
import { LeaderboardPanel } from './screens/LeaderboardPanel';
import { adjustHandlers } from './widgets';
import { chain } from '../chain';
import { ownedSetup } from './chainui';

const MENU_SCREENS: ReadonlySet<UIScreen> = new Set<UIScreen>(['main', 'pause', 'end']);
const STICK_THRESHOLD = 0.55;
const REPEAT_DELAY = 380;
const REPEAT_RATE = 115;
/** End screen: ignore select / back / navigation this long after it opens (its slam-in takes ~1 s)... */
const END_LOCK_MS = 1000;
/** ...and while presses keep arriving (mashing through the final replay), up to this long in total. */
const END_LOCK_MASH_MS = 450;
const END_LOCK_MAX_MS = 2500;
/** NOVA PULSE pressed on cooldown: feedback at most this often. */
const PULSE_DENY_MS = 400;

/** Keyboard codes → FIRST FLIGHT chips (fallback when the game does not feed updatePlayerControls()). */
const COACH_KEYS: Readonly<Record<string, CoachChip>> = {
  KeyW: 'drive',
  KeyS: 'drive',
  ArrowUp: 'drive',
  ArrowDown: 'drive',
  KeyA: 'steer',
  KeyD: 'steer',
  ArrowLeft: 'steer',
  ArrowRight: 'steer',
  Space: 'jump',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  KeyF: 'pulse',
};

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type KeyboardLockNavigator = Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } };

export class UIManager implements IUIManager {
  private readonly root: HTMLElement;
  private readonly app: HTMLElement;
  private readonly settings: Settings;
  private readonly cb: UICallbacks;

  private readonly loading: LoadingScreen;
  private readonly hud: Hud;
  private readonly hudLayer: HTMLElement;
  private readonly notifications: Notifications;
  private readonly countdown: Countdown;
  private readonly overlay: HTMLElement;
  private readonly overlayTable: ScoreTable;
  private readonly panelLayer: HTMLElement;

  private readonly mainMenu: MainMenu;
  private readonly pauseMenu: PauseMenu;
  private readonly endScreen: EndScreen;
  private readonly setup: MatchSetup;
  private readonly garage: Garage;
  private readonly settingsPanel: SettingsPanel;
  private readonly controls: ControlsPanel;
  private readonly tutorial: Tutorial;
  private readonly wallet: WalletPanel;
  private readonly leaderboard: LeaderboardPanel;
  private readonly confirmDialog: ConfirmDialog;

  private screenName: UIScreen = 'none';
  private readonly stack: Panel[] = [];
  private focused: HTMLElement | null = null;
  private launching = false;
  private lastConfig: MatchConfig | null = null;
  private scoreboardVisible = false;

  private raf = 0;
  private padDir: NavDir | null = null;
  private padNext = 0;
  private lastHoverSound = 0;
  private gestures = 0;
  private settingsRaf = 0;
  private saveTimer = 0;
  private readonly unsubDevice: () => void;
  private readonly unsubChain: () => void;
  private disposed = false;

  // --- end-screen input lock (UI-1)
  private lockOpenedAt = 0;
  private inputLockUntil = 0;
  // --- match tracking (coach, transient reset)
  private newMatchPending = false;
  private pendingFreePlay: boolean | null = null;
  private coachPending = false;
  private lastHud: HudState | null = null;
  // --- player controls (coach ticks + NOVA PULSE on-cooldown feedback)
  /** True once the game feeds updatePlayerControls(); until then key / pad presses are read directly. */
  private ctlFeed = false;
  private prevPulse = false;
  private pulseReadyNow = 1;
  private pulseReadyPrev = 1;
  private lastDeny = -1e9;
  private readonly padCtl: ControlState = makeControlState();
  // --- fullscreen
  private readonly fsListeners = new Set<(on: boolean) => void>();

  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onPointerDown = (e: PointerEvent) => this.gesture(e);
  private readonly onPointerOver = (e: PointerEvent) => this.handleHover(e);
  private readonly onContextMenu = (e: Event) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  };
  /** Clicks on the end screen are swallowed while its input lock is on (a boost click must not press REMATCH). */
  private readonly onClickCapture = (e: MouseEvent) => {
    if (this.screenName === 'end' && this.locked()) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  private readonly onFullscreenChange = () => this.fullscreenChanged();

  constructor(root: HTMLElement, settings: Settings, callbacks: UICallbacks) {
    this.root = root;
    this.settings = settings;
    // Wrap the game's callbacks: a start / restart marks the next 'hud' screen as a brand-new match.
    this.cb = {
      ...callbacks,
      onStartMatch: (cfg) => {
        this.newMatchPending = true;
        this.pendingFreePlay = cfg.freePlay;
        callbacks.onStartMatch(cfg);
      },
      onRestart: () => {
        this.newMatchPending = true;
        this.pendingFreePlay = this.lastConfig ? this.lastConfig.freePlay : null;
        callbacks.onRestart();
      },
    };
    inputHub.ensureListeners();

    const self = this;
    const ctx: UIContext = {
      settings,
      cb: this.cb,
      sound: (s) => this.sound(s),
      settingsChanged: () => this.settingsChanged(),
      push: (p) => this.push(p),
      pop: () => this.pop(),
      open: (n) => this.openPanel(n),
      focus: (el) => this.focusEl(el, false, false),
      confirm: (o, fn) => this.confirm(o, fn),
      launch: (cfg) => this.launch(cfg),
      freePlay: () => this.startFreePlay(),
      get context() {
        return self.screenName === 'main' || self.screenName === 'pause' || self.screenName === 'end' ? self.screenName : 'none';
      },
      get fullscreen() {
        return self.isFullscreen();
      },
      toggleFullscreen: () => this.toggleFullscreen(),
      onFullscreenChange: (fn) => {
        this.fsListeners.add(fn);
        return () => this.fsListeners.delete(fn);
      },
    };

    this.loading = new LoadingScreen();
    this.hud = new Hud();
    this.notifications = new Notifications();
    this.countdown = new Countdown();
    this.overlayTable = new ScoreTable('overlay');
    this.overlay = h('div', { class: 'nb-overlay' }, h('div', { class: 'nb-overlay-card' }, h('div', { class: 'nb-overlay-head' }, 'SCOREBOARD'), this.overlayTable.el));
    this.hudLayer = h('div', { class: 'nb-screen nb-hud-layer' }, this.hud.el, this.notifications.el, this.countdown.el, this.overlay);
    this.notifications.onCompactChange = (on) => {
      if (this.hudLayer.classList.contains('has-cbanner') !== on) this.hudLayer.classList.toggle('has-cbanner', on);
      this.hud.setCompactBanner(on);
    };

    this.mainMenu = new MainMenu(ctx, {
      play: () => this.openPanel('setup'),
      freePlay: () => this.startFreePlay(),
    });
    this.pauseMenu = new PauseMenu(ctx, this.hud, () => this.lastConfig);
    this.endScreen = new EndScreen(ctx);
    this.setup = new MatchSetup(ctx);
    this.garage = new Garage(ctx);
    this.settingsPanel = new SettingsPanel(ctx);
    this.controls = new ControlsPanel(ctx);
    this.tutorial = new Tutorial(ctx);
    this.wallet = new WalletPanel(ctx);
    this.leaderboard = new LeaderboardPanel(ctx);
    this.confirmDialog = new ConfirmDialog(ctx);

    this.panelLayer = div('nb-panels', this.setup.el, this.garage.el, this.settingsPanel.el, this.controls.el, this.tutorial.el, this.wallet.el, this.leaderboard.el, this.confirmDialog.el);

    this.app = h(
      'div',
      { class: 'nb-app', 'data-screen': 'none', 'data-device': inputHub.lastDevice },
      this.hudLayer,
      this.mainMenu.el,
      this.pauseMenu.el,
      this.endScreen.el,
      this.panelLayer,
      this.loading.el,
    );
    root.append(this.app);
    this.applyUiSettings();

    this.unsubDevice = inputHub.onDeviceChange((d) => this.onDevice(d));
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onPointerDown, true);
    this.app.addEventListener('pointerover', this.onPointerOver);
    this.app.addEventListener('contextmenu', this.onContextMenu);
    this.app.addEventListener('dragstart', this.onContextMenu);
    this.app.addEventListener('click', this.onClickCapture, true);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    this.fullscreenChanged();
    // Warm up font faces. The title-screen wordmark stays hidden until Orbitron is ready (max 1.5 s) so it never
    // flashes a fallback font; the boot loader shows its wordmark in the fallback face right away.
    const ready = () => this.app.classList.add('nb-fonts-ready');
    try {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts) {
        const faces = ['900 64px Orbitron', '700 32px Orbitron', '500 20px Orbitron', '500 20px Rajdhani', '600 20px Rajdhani', '700 20px Rajdhani'];
        void Promise.all(faces.map((f) => fonts.load(f).catch(() => undefined))).then(ready, ready);
        window.setTimeout(ready, 1500);
      } else ready();
    } catch {
      ready();
    }
    // Boot straight into the loading screen, opaque from its very first frame (never a black page).
    this.loading.el.classList.add('is-boot');
    this.showScreen('loading');
    // On-chain layer: wallet + NOVA balance + NFT ownership (the garage only equips what the player owns).
    this.unsubChain = chain.subscribe(() => this.enforceOwnership());
    void chain.start();
  }

  // =========================================================================== IUIManager

  get screen(): UIScreen {
    return this.screenName;
  }

  setLoading(progress: number, label: string): void {
    this.loading.set(progress, label);
  }

  showScreen(s: UIScreen): void {
    if (this.disposed) return;
    const prev = this.screenName;
    this.launching = false;
    if (s === prev && s !== 'main') return;
    this.screenName = s;
    this.app.setAttribute('data-screen', s);
    if (s !== 'loading') this.loading.el.classList.remove('is-boot');

    this.loading.el.classList.toggle('is-on', s === 'loading');
    this.hudLayer.classList.toggle('is-on', s === 'hud' || s === 'pause' || s === 'none');
    this.hudLayer.classList.toggle('is-hidden-hud', s === 'none');

    // Reset the panel stack to the screen's root panel.
    this.clearStack();
    const rootPanel = s === 'main' ? this.mainMenu : s === 'pause' ? this.pauseMenu : s === 'end' ? this.endScreen : null;
    for (const p of [this.mainMenu, this.pauseMenu, this.endScreen]) if (p !== rootPanel) p.el.classList.remove('is-on', 'is-covered');
    if (rootPanel) {
      if (s === 'main' && prev === 'loading') this.app.classList.add('is-intro');
      this.pushInternal(rootPanel);
    }

    const menu = MENU_SCREENS.has(s);
    inputHub.uiActive = menu;
    if (menu) this.startLoop();
    else this.stopLoop();

    if (s !== 'hud' && s !== 'pause' && s !== 'none') {
      this.notifications.clear();
      this.countdown.reset();
      this.setScoreboardVisible(false);
      this.hud.coach.reset();
      this.coachPending = false;
    }
    if (s !== 'end') this.inputLockUntil = 0;
    if (s === 'pause') this.setScoreboardVisible(false);
    this.notifications.setPaused(s === 'pause');
    if (s === 'hud' || s === 'none') {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && this.root.contains(ae)) ae.blur();
      this.setFocusClass(null);
    }
    // A brand-new match (from the title / end screen, or a start / restart callback): nothing carries over.
    if (s === 'hud' && (this.newMatchPending || prev === 'main' || prev === 'end' || prev === 'loading')) this.beginMatch();
    if (s === 'main' && prev === 'loading') window.setTimeout(() => this.app.classList.remove('is-intro'), 2600);
  }

  updateHUD(hs: HudState): void {
    this.hud.update(hs);
    this.lastHud = hs;
    this.pulseReadyPrev = this.pulseReadyNow;
    this.pulseReadyNow = hs.pulseEnabled ? hs.pulseReady01 : 1;
    this.notifications.setLive(hs.phase === 'playing' && !hs.replay);
    if (this.coachPending) {
      this.coachPending = false;
      const shown = this.hud.coach.begin(hs.freePlay, hs.pulseEnabled);
      if (hs.freePlay || !shown) this.countdown.setCoachHint(false);
    }
    this.hud.coach.update(hs, this.screenName === 'hud');
    if (!this.ctlFeed) this.pollPadControls(hs);
    if (this.scoreboardVisible) this.overlayTable.update(hs.scoreboard, hs.teamNames, hs.score);
    if (this.screenName === 'pause' && this.top() === this.pauseMenu) this.pauseMenu.refresh();
  }

  notify(n: HudNotification): void {
    if (this.screenName === 'hud' || this.screenName === 'none' || this.screenName === 'pause') this.notifications.notify(n);
  }

  showCountdown(value: number | 'GO' | null): void {
    this.countdown.show(value);
  }

  setReplay(active: boolean): void {
    this.hud.setReplay(active);
    if (active) {
      // banners queued behind the goal are stale by now: never pop them over the replay
      this.notifications.dropQueued();
      this.notifications.setLive(false);
    }
    if (this.app.classList.contains('is-replay') !== active) this.app.classList.toggle('is-replay', active);
  }

  showEndScreen(summary: MatchSummary): void {
    this.lastConfig = summary.config;
    // Mint the player's NOVA for this match (the end screen shows the reward as it lands on-chain).
    chain.reportMatch(summary);
    this.endScreen.set(summary);
    this.showScreen('end');
    // Space / Enter / A also skip the final replay: ignore them until the end screen has landed (UI-1).
    const now = performance.now();
    this.lockOpenedAt = now;
    this.inputLockUntil = now + END_LOCK_MS;
  }

  setScoreboardVisible(v: boolean): void {
    if (v === this.scoreboardVisible) return;
    this.scoreboardVisible = v;
    if (v) this.overlayTable.update(this.hud.lines, this.hud.teamNames, this.hud.score);
    this.overlay.classList.toggle('is-on', v);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    inputHub.uiActive = false;
    this.unsubDevice();
    this.unsubChain();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    this.app.removeEventListener('pointerover', this.onPointerOver);
    this.app.removeEventListener('contextmenu', this.onContextMenu);
    this.app.removeEventListener('dragstart', this.onContextMenu);
    this.app.removeEventListener('click', this.onClickCapture, true);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    this.fsListeners.clear();
    if (this.settingsRaf) cancelAnimationFrame(this.settingsRaf);
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      saveSettings(this.settings);
    }
    this.notifications.clear();
    this.countdown.reset();
    this.hud.coach.reset();
    this.hud.dispose();
    this.app.remove();
  }

  // =========================================================================== extras (public, beyond the contract)

  /** Open a sub-panel directly (e.g. settings from a custom button). Only valid on menu screens. */
  openPanel(name: PanelName): void {
    const p = this.panelFor(name);
    if (name === 'tutorial') this.tutorial.prepare(null);
    if (this.stack.includes(p)) return;
    this.push(p);
  }

  /** The config of the last match launched from the UI (or shown on the end screen). */
  get lastMatchConfig(): MatchConfig | null {
    return this.lastConfig;
  }

  /** Close the active big banner (~150 ms fade) and empty the big-banner queue. The side feed is kept. */
  clearBanners(): void {
    this.notifications.clearBanners();
  }

  /** Close the active big banner if it is of `kind`, and drop queued big banners of that kind. */
  dismissBanner(kind: NotificationKind): void {
    this.notifications.dismiss(kind);
  }

  /**
   * Drop every transient overlay: banners + feed, the kickoff countdown, the scoreboard overlay and the end-screen
   * input lock. For restarts / quits; screens and the HUD itself are untouched.
   */
  resetTransient(): void {
    this.notifications.clear();
    this.countdown.reset();
    this.setScoreboardVisible(false);
    this.inputLockUntil = 0;
  }

  /**
   * The local player's sampled controls, once per frame during live play (null otherwise). Drives the FIRST FLIGHT
   * coach chips and the NOVA PULSE "on cooldown" feedback.
   */
  updatePlayerControls(ctl: Readonly<ControlState> | null): void {
    this.ctlFeed = true;
    if (!ctl) {
      this.prevPulse = false;
      return;
    }
    this.hud.coach.onControls(ctl);
    const edge = ctl.pulse && !this.prevPulse;
    this.prevPulse = ctl.pulse;
    if (edge) this.pulsePressed();
  }

  // =========================================================================== match tracking

  /** A new match / free-play session starts on the HUD: clear leftovers, arm the FIRST FLIGHT coach. */
  private beginMatch(): void {
    const free = this.pendingFreePlay;
    this.newMatchPending = false;
    this.pendingFreePlay = null;
    this.resetTransient();
    this.hud.coach.reset();
    this.prevPulse = false;
    this.lastDeny = -1e9;
    this.pulseReadyNow = this.pulseReadyPrev = 1;
    // whether it is coached is decided on the first HUD frame (free play vs match is known there)
    this.coachPending = true;
    this.countdown.setCoachHint(free !== true && Coach.isFirstMatch());
  }

  /** NOVA PULSE press edge: if it was on cooldown (the sim ignores it), say so. */
  private pulsePressed(): void {
    const hs = this.lastHud;
    if (!hs || !hs.pulseEnabled || this.screenName !== 'hud' || hs.replay) return;
    // Both of the last two HUD frames on cooldown ⇒ the press was not a pulse (robust to call order).
    if (this.pulseReadyNow >= 0.999 || this.pulseReadyPrev >= 0.999) return;
    const now = performance.now();
    if (now - this.lastDeny < PULSE_DENY_MS) return;
    this.lastDeny = now;
    this.hud.pulseDenied();
    this.sound('error');
  }

  /** Live-play controls read straight from the keyboard / pad, until the game feeds updatePlayerControls(). */
  private liveForControls(): boolean {
    const hs = this.lastHud;
    return !!hs && this.screenName === 'hud' && !inputHub.uiActive && !hs.replay && (hs.phase === 'playing' || hs.phase === 'countdown' || hs.phase === 'goal');
  }

  private pollPadControls(hs: HudState): void {
    const hub = inputHub;
    if (!hub.connected || !this.liveForControls()) {
      this.padCtl.pulse = false;
      return;
    }
    const c = this.padCtl;
    c.throttle = hub.gameValue(GP.RT) - hub.gameValue(GP.LT);
    c.steer = Math.abs(hub.axes[0]) > 0.5 ? hub.axes[0] : 0;
    c.jump = hub.gameDown(GP.A);
    c.boost = hub.gameDown(GP.B);
    const pulse = hub.gameDown(GP.RB);
    const edge = pulse && !c.pulse;
    c.pulse = pulse;
    this.hud.coach.onControls(c);
    if (edge && hs.pulseEnabled) this.pulsePressed();
  }

  // =========================================================================== fullscreen

  private isFullscreen(): boolean {
    const d = document as FsDocument;
    return !!(document.fullscreenElement || d.webkitFullscreenElement);
  }

  private toggleFullscreen(): void {
    const d = document as FsDocument;
    const nav = navigator as KeyboardLockNavigator;
    try {
      if (this.isFullscreen()) {
        try {
          nav.keyboard?.unlock?.();
        } catch {
          /* not supported */
        }
        const p = document.exitFullscreen ? document.exitFullscreen() : d.webkitExitFullscreen?.();
        Promise.resolve(p).catch(() => undefined);
        return;
      }
      const el = document.documentElement as FsElement;
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
      Promise.resolve(p)
        .then(() => {
          // Chromium: keep Esc for the game (pause / back). Holding Esc still leaves fullscreen.
          const lock = nav.keyboard?.lock?.(['Escape']);
          return lock ? lock.catch(() => undefined) : undefined;
        })
        .catch(() => this.sound('error'));
    } catch {
      this.sound('error');
    }
  }

  private fullscreenChanged(): void {
    const on = this.isFullscreen();
    this.app.toggleAttribute('data-fullscreen', on);
    for (const fn of this.fsListeners) {
      try {
        fn(on);
      } catch (err) {
        console.error('[UI] fullscreen listener failed', err);
      }
    }
  }

  // =========================================================================== stack

  private panelFor(name: PanelName): Panel {
    switch (name) {
      case 'setup':
        return this.setup;
      case 'garage':
        return this.garage;
      case 'settings':
        return this.settingsPanel;
      case 'controls':
        return this.controls;
      case 'tutorial':
        return this.tutorial;
      case 'wallet':
        return this.wallet;
      case 'leaderboard':
        return this.leaderboard;
    }
  }

  private top(): Panel | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  private clearStack(): void {
    while (this.stack.length) {
      const p = this.stack.pop()!;
      p.el.classList.remove('is-on', 'is-covered');
      p.lastFocus = null;
      p.onHide();
    }
    this.setFocusClass(null);
  }

  private pushInternal(p: Panel): void {
    const top = this.top();
    if (top) {
      top.lastFocus = this.focused && top.el.contains(this.focused) ? this.focused : null;
      top.el.classList.add('is-covered');
      top.onHide();
    }
    this.stack.push(p);
    p.el.classList.remove('is-covered');
    p.el.classList.add('is-on');
    this.app.setAttribute('data-panel', this.stack.length > 1 ? 'sub' : 'root');
    p.onShow();
    this.focusEl(p.lastFocus && p.el.contains(p.lastFocus) ? p.lastFocus : p.defaultFocus(), false, false);
  }

  private push(p: Panel): void {
    if (!MENU_SCREENS.has(this.screenName)) return;
    if (this.stack.includes(p)) return;
    this.pushInternal(p);
  }

  private pop(): void {
    if (this.stack.length <= 1) return;
    const p = this.stack.pop()!;
    p.el.classList.remove('is-on', 'is-covered');
    p.onHide();
    const top = this.top()!;
    top.el.classList.remove('is-covered');
    top.el.classList.add('is-on');
    this.app.setAttribute('data-panel', this.stack.length > 1 ? 'sub' : 'root');
    top.onShow();
    this.focusEl(top.lastFocus && top.el.contains(top.lastFocus) ? top.lastFocus : top.defaultFocus(), false, false);
  }

  private confirm(o: ConfirmOptions, fn: () => void): void {
    this.confirmDialog.prepare(o, fn);
    this.push(this.confirmDialog);
  }

  // =========================================================================== match launch

  private launch(cfg: MatchConfig): void {
    if (this.launching) return;
    if (cfg.player) cfg = { ...cfg, player: { ...cfg.player, ...ownedSetup(cfg.player.style, cfg.player.paint) } };
    const go = () => {
      if (this.launching) return;
      this.launching = true;
      this.lastConfig = cfg;
      this.flushSettings();
      inputHub.maskHeld();
      try {
        this.cb.onStartMatch(cfg);
      } catch (err) {
        this.launching = false;
        console.error('[UI] onStartMatch failed', err);
      }
    };
    if (!this.settings.seenTutorial) {
      this.tutorial.prepare(() => {
        this.settings.seenTutorial = true;
        this.settingsChanged();
        go();
      });
      this.push(this.tutorial);
      return;
    }
    go();
  }

  private startFreePlay(): void {
    const s = this.settings;
    this.launch({
      teamSize: 1,
      durationSec: s.lastDuration,
      difficulty: s.lastDifficulty,
      seed: randomSeed(),
      freePlay: true,
      mutators: { ...s.lastMutators },
      player: { name: s.playerName || 'PLAYER', style: s.carStyle, paint: s.paint },
    });
  }

  // =========================================================================== settings

  /** A cosmetic the wallet does not own (another wallet, a reset chain) falls back to the starter kit. */
  private enforceOwnership(): void {
    if (!chain.ownershipKnown) return;
    const s = this.settings;
    const own = ownedSetup(s.carStyle, s.paint);
    if (own.style === s.carStyle && own.paint === s.paint) return;
    s.carStyle = own.style;
    s.paint = own.paint;
    this.settingsChanged();
  }

  private settingsChanged(): void {
    this.applyUiSettings();
    if (!this.settingsRaf) {
      this.settingsRaf = requestAnimationFrame(() => {
        this.settingsRaf = 0;
        this.emitSettings();
      });
    }
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      saveSettings(this.settings);
    }, 250);
  }

  private flushSettings(): void {
    if (this.settingsRaf) {
      cancelAnimationFrame(this.settingsRaf);
      this.settingsRaf = 0;
      this.emitSettings();
    }
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      saveSettings(this.settings);
    }
  }

  private emitSettings(): void {
    try {
      this.cb.onSettingsChanged(this.settings);
    } catch (err) {
      console.error('[UI] onSettingsChanged failed', err);
    }
  }

  private applyUiSettings(): void {
    this.app.classList.toggle('nb-lowfx', this.settings.quality === 'low');
  }

  // =========================================================================== focus & navigation

  /** End-screen input lock (UI-1). */
  private locked(): boolean {
    return this.screenName === 'end' && performance.now() < this.inputLockUntil;
  }

  /** A press arrived during the lock: keep ignoring while the player is still mashing (bounded). */
  private extendLock(): void {
    const now = performance.now();
    this.inputLockUntil = Math.min(this.lockOpenedAt + END_LOCK_MAX_MS, Math.max(this.inputLockUntil, now + END_LOCK_MASH_MS));
  }

  private setFocusClass(el: HTMLElement | null): void {
    if (this.focused === el) return;
    this.focused?.classList.remove('is-focus');
    this.focused = el;
    el?.classList.add('is-focus');
  }

  private focusEl(el: HTMLElement | null, viaPointer: boolean, withSound: boolean): void {
    if (!el) {
      this.setFocusClass(null);
      return;
    }
    const changed = this.focused !== el;
    this.setFocusClass(el);
    if (el instanceof HTMLInputElement) {
      // Text fields are only highlighted by navigation; Enter / A (activate) or a click starts typing,
      // so WASD / arrow navigation never types into them by accident.
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== el && this.root.contains(ae)) ae.blur();
    } else if (document.activeElement !== el) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    if (!viaPointer) revealInScroller(el);
    if (changed && withSound) this.hoverSound();
  }

  private hoverSound(): void {
    const now = performance.now();
    if (now - this.lastHoverSound < 35) return;
    this.lastHoverSound = now;
    this.sound('hover');
  }

  private navigate(dir: NavDir, repeat: boolean): void {
    const top = this.top();
    if (!top || this.launching) return;
    if (this.locked()) {
      this.extendLock();
      return;
    }
    const cur = this.focused && top.el.contains(this.focused) && isNavigable(this.focused) ? this.focused : null;
    if (cur && (dir === 'left' || dir === 'right')) {
      const adj = adjustHandlers.get(cur);
      if (adj) {
        adj(dir === 'left' ? -1 : 1, repeat);
        return;
      }
    }
    const items = navItems(top.el);
    if (!cur) {
      this.focusEl(top.defaultFocus() ?? items[0] ?? null, false, true);
      return;
    }
    const next = spatialPick(cur, items, dir, top.wrap);
    if (next) this.focusEl(next, false, true);
  }

  private activate(): void {
    const top = this.top();
    if (!top || this.launching) return;
    if (this.locked()) {
      this.extendLock();
      return;
    }
    const el = this.focused && top.el.contains(this.focused) && isNavigable(this.focused) ? this.focused : null;
    if (!el) {
      this.focusEl(top.defaultFocus(), false, true);
      return;
    }
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
      return;
    }
    el.click();
  }

  private back(): void {
    const top = this.top();
    if (!top || this.launching) return;
    if (this.locked()) {
      this.extendLock();
      return;
    }
    if (top.onBack()) return;
    if (top.root) {
      if (this.screenName === 'pause') {
        this.sound('back');
        this.cb.onResume();
      }
      return;
    }
    this.sound('back');
    this.pop();
  }

  private handleHover(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const top = this.top();
    if (!top) return;
    const t = (e.target as Element | null)?.closest?.<HTMLElement>('[data-nav]');
    if (!t || !top.el.contains(t) || !isNavigable(t)) return;
    if (t === this.focused) return;
    // Don't steal focus from a text field the user is typing in.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement !== t && this.focused === document.activeElement) {
      this.setFocusClass(t);
      this.hoverSound();
      return;
    }
    this.focusEl(t, true, true);
  }

  private gesture(e: Event): void {
    if (this.gestures >= 3) return;
    if (e instanceof KeyboardEvent && (e.code === 'Escape' || e.ctrlKey || e.metaKey)) return;
    this.gestures++;
    // the title's "press any key for sound" chip has done its job
    if (!this.app.classList.contains('nb-audio-on')) this.app.classList.add('nb-audio-on');
    try {
      this.cb.onUserGesture();
    } catch (err) {
      console.error('[UI] onUserGesture failed', err);
    }
  }

  private handleKey(e: KeyboardEvent): void {
    this.gesture(e);
    // Live play, until the game feeds updatePlayerControls(): tick the coach / pulse feedback from raw keys.
    if (!this.ctlFeed && !inputHub.uiActive && !e.ctrlKey && !e.metaKey && this.liveForControls()) {
      const chip = COACH_KEYS[e.code];
      if (chip) {
        this.hud.coach.tick(chip);
        if (chip === 'pulse' && !e.repeat) this.pulsePressed();
      }
    }
    if (!inputHub.uiActive || this.stack.length === 0 || this.disposed) return;
    const top = this.top()!;
    // Typing in a text field: let it through, but keep gameplay from seeing it.
    if (inputHub.isEditableTarget(e.target)) {
      inputHub.markUiKey(e);
      const input = e.target as HTMLInputElement;
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'ArrowDown' || e.code === 'Tab') {
        e.preventDefault();
        input.blur();
        this.navigate(e.shiftKey && e.code === 'Tab' ? 'up' : 'down', false);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        input.blur();
        this.navigate('up', false);
      } else if (e.code === 'Escape') {
        e.preventDefault();
        input.blur();
        this.setFocusClass(input);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.navigate('up', e.repeat);
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.navigate('down', e.repeat);
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.navigate('left', e.repeat);
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.navigate('right', e.repeat);
        break;
      case 'Tab':
        this.navigate(e.shiftKey ? 'up' : 'down', e.repeat);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (!e.repeat) this.activate();
        break;
      case 'Escape':
      case 'Backspace':
        if (!e.repeat) this.back();
        break;
      case 'KeyQ':
      case 'PageUp':
        if (!e.repeat && !this.locked()) top.onTab(-1);
        break;
      case 'KeyE':
      case 'PageDown':
        if (!e.repeat && !this.locked()) top.onTab(1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      inputHub.markUiKey(e);
      e.preventDefault();
    }
  }

  // =========================================================================== gamepad menu loop

  private startLoop(): void {
    if (this.raf || this.disposed) return;
    this.padDir = null;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.pollPad();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.padDir = null;
  }

  private pollPad(): void {
    const hub = inputHub;
    hub.poll();
    if (!hub.uiActive || !hub.connected || this.stack.length === 0) {
      this.padDir = null;
      return;
    }
    const top = this.top()!;
    if (hub.takeUiEdge(GP.A)) this.activate();
    if (hub.takeUiEdge(GP.B)) this.back();
    if (hub.takeUiEdge(GP.START) && (this.locked() || !top.onStart())) this.activate();
    if (hub.takeUiEdge(GP.LB) && !this.locked()) top.onTab(-1);
    if (hub.takeUiEdge(GP.RB) && !this.locked()) top.onTab(1);
    hub.takeUiEdge(GP.UP);
    hub.takeUiEdge(GP.DOWN);
    hub.takeUiEdge(GP.LEFT);
    hub.takeUiEdge(GP.RIGHT);

    const ax = hub.axes[0];
    const ay = hub.axes[1];
    let dir: NavDir | null = null;
    if (hub.down[GP.UP]) dir = 'up';
    else if (hub.down[GP.DOWN]) dir = 'down';
    else if (hub.down[GP.LEFT]) dir = 'left';
    else if (hub.down[GP.RIGHT]) dir = 'right';
    else if (Math.abs(ay) >= Math.abs(ax)) {
      if (ay < -STICK_THRESHOLD) dir = 'up';
      else if (ay > STICK_THRESHOLD) dir = 'down';
    } else if (ax < -STICK_THRESHOLD) dir = 'left';
    else if (ax > STICK_THRESHOLD) dir = 'right';

    const now = performance.now();
    if (dir !== this.padDir) {
      this.padDir = dir;
      if (dir) {
        this.navigate(dir, false);
        this.padNext = now + REPEAT_DELAY;
      }
    } else if (dir && now >= this.padNext) {
      this.navigate(dir, true);
      this.padNext = now + REPEAT_RATE;
    }
  }

  // =========================================================================== misc

  private onDevice(d: InputDevice): void {
    this.app.setAttribute('data-device', d);
  }

  private sound(s: UiSound): void {
    try {
      this.cb.onUiSound(s);
    } catch (err) {
      console.error('[UI] onUiSound failed', err);
    }
  }
}
