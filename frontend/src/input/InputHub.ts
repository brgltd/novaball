/**
 * NOVABALL — shared input hub (internal to src/input + src/ui).
 *
 * One module-level singleton shared by the gameplay InputSystem and the UIManager's menu navigation:
 *  - tracks the last used device ('keyboard' = keyboard/mouse, 'gamepad') so the UI can show the right glyphs;
 *  - polls gamepads at most once per animation frame and exposes merged button / axis state;
 *  - ARBITRATES presses so one physical press is never handled twice:
 *      * keyboard: the UI listens in the capture phase on window and marks the events it handles
 *        (markUiKey); InputSystem (bubble phase) ignores marked events.
 *      * gamepad: each poll produces press edges; an edge is claimed by exactly one consumer
 *        (UI while `uiActive`, gameplay otherwise). A button claimed by the UI is also MASKED for
 *        gameplay until it is released (so pressing A on "RESUME" never makes the car jump).
 */

export type InputDevice = 'keyboard' | 'gamepad';

/** Standard-mapping gamepad button indices. */
export const GP = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
} as const;

export const GP_BUTTONS = 17;

/** Analog threshold above which a button counts as pressed (triggers are analog). */
const PRESS_THRESHOLD = 0.5;
/** Stick magnitude / trigger value that switches lastDevice to 'gamepad'. */
const ACTIVITY_THRESHOLD = 0.35;

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'range' && type !== 'submit';
  }
  return false;
}

class InputHubImpl {
  private _lastDevice: InputDevice = 'keyboard';
  /** Set by the UIManager while a navigable menu (main / pause / end) owns keyboard + gamepad presses. */
  uiActive = false;

  private readonly uiKeys = new WeakSet<Event>();
  private readonly deviceListeners = new Set<(d: InputDevice) => void>();
  private listening = false;
  private mouseTravel = 0;

  /** Merged analog value (0..1) per button across all connected pads. */
  readonly value = new Float32Array(GP_BUTTONS);
  /** Merged pressed state per button (1 = down). */
  readonly down = new Uint8Array(GP_BUTTONS);
  private readonly prevDown = new Uint8Array(GP_BUTTONS);
  /** 1 = unclaimed press edge in the latest poll. */
  private readonly edges = new Uint8Array(GP_BUTTONS);
  /** 1 = button was claimed by the UI and stays masked for gameplay until released. */
  private readonly uiMasked = new Uint8Array(GP_BUTTONS);
  /** Merged axes: [LS x, LS y, RS x, RS y] (largest magnitude wins). */
  readonly axes = new Float32Array(4);
  /** Connected pads from the latest poll (reused array). */
  readonly pads: Gamepad[] = [];
  connected = false;
  /** Increments on every real poll. */
  pollId = 0;
  private lastStamp = Number.NaN;
  /** Analog activity (sticks / triggers past the threshold) in the previous poll — device switches on the rising edge only. */
  private analogActive = false;

  get lastDevice(): InputDevice {
    return this._lastDevice;
  }

  setDevice(d: InputDevice): void {
    if (d === this._lastDevice) return;
    this._lastDevice = d;
    for (const fn of this.deviceListeners) {
      try {
        fn(d);
      } catch (err) {
        console.error('[InputHub] device listener failed', err);
      }
    }
  }

  onDeviceChange(fn: (d: InputDevice) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  /** Install the (page-lifetime) keyboard/mouse device-detection listeners once. */
  ensureListeners(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    const kb = () => this.setDevice('keyboard');
    window.addEventListener('keydown', kb, { capture: true, passive: true });
    window.addEventListener('pointerdown', kb, { capture: true, passive: true });
    window.addEventListener('wheel', kb, { capture: true, passive: true });
    window.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        if (this._lastDevice === 'keyboard') return;
        this.mouseTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
        if (this.mouseTravel > 24) {
          this.mouseTravel = 0;
          this.setDevice('keyboard');
        }
      },
      { capture: true, passive: true },
    );
  }

  // ------------------------------------------------------------------ keyboard arbitration

  /** UI handled this keyboard event: gameplay must ignore it. */
  markUiKey(e: Event): void {
    this.uiKeys.add(e);
  }

  isUiKey(e: Event): boolean {
    return this.uiKeys.has(e);
  }

  isEditableTarget(t: EventTarget | null): boolean {
    return isEditableTarget(t);
  }

  // ------------------------------------------------------------------ gamepad polling

  /**
   * Poll navigator.getGamepads(). Idempotent within one animation frame (all rAF callbacks of a frame share
   * document.timeline.currentTime), so the game loop and the UI loop can both call it.
   */
  poll(): void {
    let stamp = Number.NaN;
    try {
      const ct = typeof document !== 'undefined' ? document.timeline?.currentTime : null;
      if (typeof ct === 'number') stamp = ct;
    } catch {
      /* ignore */
    }
    if (!Number.isNaN(stamp) && stamp === this.lastStamp) return;
    this.lastStamp = stamp;
    this.pollId++;

    const value = this.value;
    const down = this.down;
    const prev = this.prevDown;
    const axes = this.axes;
    for (let i = 0; i < GP_BUTTONS; i++) {
      prev[i] = down[i];
      value[i] = 0;
      down[i] = 0;
    }
    axes[0] = axes[1] = axes[2] = axes[3] = 0;
    this.pads.length = 0;

    let list: ArrayLike<Gamepad | null> | null = null;
    try {
      list = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
    } catch {
      list = null;
    }
    let active = false;
    if (list) {
      for (let p = 0; p < list.length; p++) {
        const pad = list[p];
        if (!pad || !pad.connected) continue;
        this.pads.push(pad);
        const btns = pad.buttons;
        const nb = btns.length < GP_BUTTONS ? btns.length : GP_BUTTONS;
        for (let i = 0; i < nb; i++) {
          const b = btns[i];
          const v = b.value > 0 ? b.value : b.pressed ? 1 : 0;
          if (v > value[i]) value[i] = v;
          if (b.pressed || v >= PRESS_THRESHOLD) down[i] = 1;
        }
        const pa = pad.axes;
        const na = pa.length < 4 ? pa.length : 4;
        for (let i = 0; i < na; i++) {
          const v = pa[i];
          if (Math.abs(v) > Math.abs(axes[i])) axes[i] = v;
        }
      }
    }
    this.connected = this.pads.length > 0;

    for (let i = 0; i < GP_BUTTONS; i++) {
      const edge = down[i] && !prev[i];
      this.edges[i] = edge ? 1 : 0;
      if (!down[i]) this.uiMasked[i] = 0;
      if (edge && (i < GP.LT || i > GP.RT)) active = true;
    }
    // Sticks / triggers switch the device only when they START moving, so a drifting stick can't keep
    // stealing the glyphs back from the keyboard.
    const analog =
      value[GP.LT] > ACTIVITY_THRESHOLD ||
      value[GP.RT] > ACTIVITY_THRESHOLD ||
      Math.abs(axes[0]) > ACTIVITY_THRESHOLD ||
      Math.abs(axes[1]) > ACTIVITY_THRESHOLD ||
      Math.abs(axes[2]) > ACTIVITY_THRESHOLD ||
      Math.abs(axes[3]) > ACTIVITY_THRESHOLD;
    if (analog && !this.analogActive) active = true;
    this.analogActive = analog;
    if (active) this.setDevice('gamepad');
  }

  /** True if `btn` has an unclaimed press edge in the latest poll. */
  hasEdge(btn: number): boolean {
    return this.edges[btn] === 1;
  }

  /** Claim a press edge for gameplay. Returns false if there is none or it was already claimed. */
  takeEdge(btn: number): boolean {
    if (this.edges[btn] !== 1) return false;
    this.edges[btn] = 0;
    return true;
  }

  /** Claim a press edge for the UI; the button is then masked for gameplay until released. */
  takeUiEdge(btn: number): boolean {
    if (this.edges[btn] !== 1) return false;
    this.edges[btn] = 0;
    this.uiMasked[btn] = 1;
    return true;
  }

  /** Pressed and not masked by a UI claim. */
  gameDown(btn: number): boolean {
    return this.down[btn] === 1 && this.uiMasked[btn] === 0;
  }

  /** Analog value unless masked by a UI claim. */
  gameValue(btn: number): number {
    return this.uiMasked[btn] === 1 ? 0 : this.value[btn];
  }

  /** Mask every currently held button for gameplay until it is released (used on menu → game transitions). */
  maskHeld(): void {
    for (let i = 0; i < GP_BUTTONS; i++) if (this.down[i]) this.uiMasked[i] = 1;
  }
}

/** The page-wide input hub singleton. */
export const inputHub = new InputHubImpl();
export type InputHub = InputHubImpl;
