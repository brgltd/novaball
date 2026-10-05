/**
 * NOVABALL — keyboard / mouse / gamepad input (DESIGN §3).
 *
 * Keyboard uses KeyboardEvent.code (layout independent). Mouse buttons are read on the target element
 * (LMB = boost, RMB = jump; context menu disabled). Gamepads use the standard mapping via the shared
 * InputHub (which also arbitrates presses with the UI so one physical press is never handled twice).
 */
import type { IInputSystem, InputAction } from '../contracts';
import type { Settings } from '../settings';
import type { ControlState } from '../sim/types';
import { GP, inputHub, type InputDevice } from './InputHub';

/** Every KeyboardEvent.code the game binds (all of them get preventDefault while playing). */
const BOUND_CODES = new Set<string>([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyC',
  'AltLeft',
  'KeyQ',
  'KeyE',
  'KeyF',
  'Tab',
  'Escape',
  'Enter',
  'NumpadEnter',
  'KeyR',
  'Backquote',
]);

const ACTIONS: readonly InputAction[] = ['ballCam', 'pause', 'skipReplay', 'resetFreePlay', 'scoreboard'];

/** Keyboard codes that trigger each action. */
const ACTION_KEYS: Record<InputAction, readonly string[]> = {
  ballCam: ['Tab'],
  pause: ['Escape'],
  skipReplay: ['Space', 'Enter', 'NumpadEnter'],
  resetFreePlay: ['KeyR'],
  scoreboard: ['Backquote'],
};

/** Gamepad buttons that trigger each action. */
const ACTION_BUTTONS: Record<InputAction, readonly number[]> = {
  ballCam: [GP.Y],
  pause: [GP.START],
  skipReplay: [GP.A],
  resetFreePlay: [GP.BACK],
  scoreboard: [GP.BACK],
};

/** An edge-triggered press stays consumable for this many update() calls (covers frames without sim ticks). */
const EDGE_FRAMES = 3;

function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

export class InputSystem implements IInputSystem {
  enabled = true;

  private readonly target: HTMLElement;
  private readonly keys = new Set<string>();
  private mouseBoost = false;
  private mouseJump = false;

  private deadzone = 0.15;
  private invertPitch = false;
  private vibration = true;

  private frame = 0;
  /** Frame id of the last unconsumed press per action (-1 = none). */
  private readonly pressFrame: Record<InputAction, number> = {
    ballCam: -1,
    pause: -1,
    skipReplay: -1,
    resetFreePlay: -1,
    scoreboard: -1,
  };

  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onMouseDown = (e: MouseEvent) => this.handleMouseDown(e);
  private readonly onMouseUp = (e: MouseEvent) => this.handleMouseUp(e);
  private readonly onContextMenu = (e: Event) => e.preventDefault();
  private readonly onBlur = () => this.releaseAll();
  private readonly onVisibility = () => {
    if (document.visibilityState !== 'visible') this.releaseAll();
  };

  constructor(target: HTMLElement) {
    this.target = target;
    inputHub.ensureListeners();
    // Bubble phase on window: the UI listens in the capture phase and marks the events it consumes.
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get lastDevice(): InputDevice {
    return inputHub.lastDevice;
  }

  applySettings(s: Settings): void {
    const dz = Number(s.gamepadDeadzone);
    this.deadzone = Number.isFinite(dz) ? Math.min(0.9, Math.max(0, dz)) : 0.15;
    this.invertPitch = !!s.invertPitch;
    this.vibration = !!s.vibration;
  }

  update(): void {
    this.frame++;
    inputHub.poll();
    // Gamepad press edges belong to gameplay only while no UI menu owns the input.
    if (!inputHub.uiActive) {
      for (let i = 0; i < ACTIONS.length; i++) {
        const a = ACTIONS[i];
        const btns = ACTION_BUTTONS[a];
        for (let j = 0; j < btns.length; j++) {
          // hasEdge (not takeEdge) so one button can feed several actions (BACK = reset + scoreboard).
          if (inputHub.hasEdge(btns[j])) this.pressFrame[a] = this.frame;
        }
      }
      for (let i = 0; i < ACTIONS.length; i++) {
        const btns = ACTION_BUTTONS[ACTIONS[i]];
        for (let j = 0; j < btns.length; j++) inputHub.takeEdge(btns[j]);
      }
    }
  }

  sample(out: ControlState): ControlState {
    if (!this.enabled) {
      out.throttle = 0;
      out.steer = 0;
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
      out.jump = false;
      out.boost = false;
      out.powerslide = false;
      out.pulse = false;
      return out;
    }
    const k = this.keys;
    const kbThrottle = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const kbSteer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const kbRoll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);

    let gpThrottle = 0;
    let gpSteer = 0;
    let gpPitch = 0;
    let gpRoll = 0;
    let gpJump = false;
    let gpBoost = false;
    let gpSlide = false;
    let gpPulse = false;
    const hub = inputHub;
    if (hub.connected) {
      gpThrottle = hub.gameValue(GP.RT) - hub.gameValue(GP.LT);
      // Radial deadzone on the left stick.
      const x = hub.axes[0];
      const y = hub.axes[1];
      const mag = Math.sqrt(x * x + y * y);
      const dz = this.deadzone;
      if (mag > dz && mag > 1e-6) {
        const scaled = Math.min(1, (mag - dz) / (1 - dz)) / mag;
        gpSteer = x * scaled;
        // Standard mapping: stick up = -1. Pushing forward = nose down = pitch +1.
        gpPitch = -y * scaled;
      }
      gpRoll = hub.gameDown(GP.LB) ? -1 : 0;
      gpJump = hub.gameDown(GP.A);
      gpBoost = hub.gameDown(GP.B);
      gpSlide = hub.gameDown(GP.X);
      gpPulse = hub.gameDown(GP.RB);
    }

    const throttle = clamp1(kbThrottle + gpThrottle);
    const steer = clamp1(kbSteer + gpSteer);
    // Keyboard pitch shares the throttle axis (W = nose down); gamepad pitch comes from the stick.
    let pitch = clamp1(kbThrottle + gpPitch);
    if (this.invertPitch) pitch = -pitch;

    out.throttle = throttle;
    out.steer = steer;
    out.yaw = steer;
    out.pitch = pitch;
    out.roll = clamp1(kbRoll + gpRoll);
    out.jump = k.has('Space') || this.mouseJump || gpJump;
    out.boost = k.has('ShiftLeft') || k.has('ShiftRight') || this.mouseBoost || gpBoost;
    out.powerslide = k.has('KeyC') || k.has('AltLeft') || gpSlide;
    out.pulse = k.has('KeyF') || gpPulse;
    return out;
  }

  consume(action: InputAction): boolean {
    const f = this.pressFrame[action];
    if (f < 0) return false;
    this.pressFrame[action] = -1;
    return this.frame - f < EDGE_FRAMES;
  }

  isHeld(action: InputAction): boolean {
    const codes = ACTION_KEYS[action];
    for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true;
    const btns = ACTION_BUTTONS[action];
    for (let i = 0; i < btns.length; i++) if (inputHub.gameDown(btns[i])) return true;
    return false;
  }

  rumble(strong: number, weak: number, ms: number): void {
    if (!this.vibration || ms <= 0) return;
    const pads = inputHub.pads;
    for (let i = 0; i < pads.length; i++) {
      const act = (pads[i] as Gamepad & { vibrationActuator?: GamepadHapticActuator | null }).vibrationActuator;
      if (!act || typeof act.playEffect !== 'function') continue;
      try {
        act
          .playEffect('dual-rumble', {
            startDelay: 0,
            duration: Math.min(5000, Math.max(1, ms)),
            strongMagnitude: Math.min(1, Math.max(0, strong)),
            weakMagnitude: Math.min(1, Math.max(0, weak)),
          })
          .catch(() => undefined);
      } catch {
        /* haptics unsupported */
      }
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseAll();
  }

  // ------------------------------------------------------------------ internals

  private handleKeyDown(e: KeyboardEvent): void {
    if (inputHub.isUiKey(e) || inputHub.isEditableTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey) return; // never bind Ctrl / Cmd combos (Ctrl+W, Ctrl+R, ...)
    const code = e.code;
    if (!BOUND_CODES.has(code)) return;
    e.preventDefault();
    if (e.repeat) return;
    this.keys.add(code);
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      if (ACTION_KEYS[a].includes(code)) this.pressFrame[a] = this.frame;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const code = e.code;
    if (!this.keys.has(code)) return;
    this.keys.delete(code);
    if (!inputHub.isEditableTarget(e.target)) e.preventDefault();
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button === 0) this.mouseBoost = true;
    else if (e.button === 2) this.mouseJump = true;
    else return;
    e.preventDefault();
    // Keep keyboard focus on the game surface.
    if (document.activeElement !== this.target && this.target.tabIndex >= 0) {
      try {
        this.target.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.mouseBoost = false;
    else if (e.button === 2) this.mouseJump = false;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.mouseBoost = false;
    this.mouseJump = false;
    for (let i = 0; i < ACTIONS.length; i++) this.pressFrame[ACTIONS[i]] = -1;
  }
}
