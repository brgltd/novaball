/**
 * NOVABALL — bootstrap.
 *  - tells the index.html boot watchdog that the bundle runs (window.__nbBooted)
 *  - graphics checks: WebGL2 + renderable float targets (friendly full-screen message otherwise); software GL
 *    (SwiftShader / llvmpipe …) → LOW quality for the session + a one-line notice
 *  - touch-only devices: a "play on desktop" card over the live AI exhibition (the game still boots behind it)
 *  - global error overlay in dev builds (import.meta.env.DEV)
 *  - creates and starts the Game; a boot failure offers RELOAD / RESET SETTINGS
 */
import { Game } from './game/Game';
import { SETTINGS_STORAGE_KEY } from './settings';

// The bundle loaded and evaluated: the index.html watchdog stands down (and a message it showed early goes away).
(window as unknown as { __nbBooted?: boolean }).__nbBooted = true;
document.getElementById('nb-boot-error')?.remove();

const BG = '#05070d';
const FONT = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';

interface GpuInfo {
  webgl2: boolean;
  /** Can render to half-float / float targets (the HDR pipeline needs it). */
  floatTargets: boolean;
  renderer: string;
  /** A CPU rasterizer: hardware acceleration is off or unavailable. */
  software: boolean;
}

function probeGpu(): GpuInfo {
  const info: GpuInfo = { webgl2: false, floatTargets: false, renderer: '', software: false };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return info;
    info.webgl2 = true;
    info.floatTargets = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      info.renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    } catch {
      info.renderer = '';
    }
    info.software = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(info.renderer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* no WebGL2 */
  }
  return info;
}

function removeSplash(): void {
  document.getElementById('nb-splash')?.remove();
}

function fullScreenMessage(title: string, body: string, actions: Array<{ label: string; onClick: () => void }> = []): void {
  removeSplash();
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:18px',
    'padding:32px',
    'text-align:center',
    `background:radial-gradient(ellipse at 50% 35%, #16204a 0%, ${BG} 65%)`,
    'color:#e6f3ff',
    `font-family:${FONT}`,
    'z-index:100',
  ].join(';');
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:clamp(28px,5vw,56px);font-weight:900;letter-spacing:0.12em;color:#8be9ff;text-shadow:0 0 24px #1ec8ff';
  const p = document.createElement('div');
  p.textContent = body;
  p.style.cssText = 'max-width:640px;font-size:18px;line-height:1.55;opacity:0.85';
  el.append(h, p);
  if (actions.length > 0) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:8px';
    for (const a of actions) row.append(button(a.label, a.onClick));
    el.append(row);
  }
  document.body.append(el);
}

function button(label: string, onClick: () => void, primary = true): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = [
    'pointer-events:auto',
    'cursor:pointer',
    'padding:12px 22px',
    'min-height:44px',
    'border-radius:8px',
    `border:1px solid ${primary ? '#8be9ff' : 'rgba(139,233,255,0.4)'}`,
    `background:${primary ? 'rgba(30,200,255,0.18)' : 'rgba(5,7,13,0.6)'}`,
    'color:#e6f3ff',
    `font:700 15px/1.2 ${FONT}`,
    'letter-spacing:0.12em',
  ].join(';');
  b.addEventListener('click', onClick);
  return b;
}

function installDevErrorOverlay(): void {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;left:12px;bottom:12px;max-width:min(760px,calc(100vw - 24px));max-height:40vh;overflow:auto;z-index:1000;' +
    'background:rgba(40,0,8,0.92);border:1px solid #ff4d6d;border-radius:8px;padding:10px 14px;color:#ffd6dd;' +
    'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;display:none;pointer-events:auto';
  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'float:right;background:none;border:0;color:#ffd6dd;font-size:18px;cursor:pointer';
  close.onclick = () => {
    box.style.display = 'none';
    box.replaceChildren(close);
  };
  box.append(close);
  document.body.append(box);
  let count = 0;
  const show = (msg: string) => {
    if (count++ > 20) return;
    const line = document.createElement('div');
    line.textContent = msg;
    line.style.cssText = 'border-top:1px solid rgba(255,77,109,0.3);padding-top:4px;margin-top:4px';
    box.append(line);
    box.style.display = 'block';
  };
  window.addEventListener('error', (e) => show(`[error] ${e.message}\n${e.error?.stack ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    show(`[unhandled rejection] ${r?.message ?? String(e.reason)}\n${r?.stack ?? ''}`);
  });
}

function installGlobalStyles(): void {
  const st = document.createElement('style');
  // hide the mouse cursor over the game while driving (menus / pause show it again)
  st.textContent = 'body.nb-playing #game, body.nb-playing #ui { cursor: none; }';
  document.head.append(st);
}

/** Short notice at the top of the screen (dismissable, fades after a while). */
function notice(text: string, ms = 12000): void {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:12px',
    'transform:translateX(-50%)',
    'z-index:95',
    'max-width:calc(100vw - 32px)',
    'padding:8px 14px 8px 16px',
    'border-radius:8px',
    'border:1px solid rgba(255,197,61,0.6)',
    'background:rgba(5,7,13,0.88)',
    'color:#fff0c2',
    `font:600 14px/1.4 ${FONT}`,
    'display:flex',
    'gap:12px',
    'align-items:center',
    'pointer-events:auto',
    'transition:opacity 0.6s',
  ].join(';');
  const t = document.createElement('span');
  t.textContent = text;
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Dismiss');
  x.style.cssText = 'background:none;border:0;color:inherit;font-size:18px;cursor:pointer;padding:0 2px';
  x.onclick = () => el.remove();
  el.append(t, x);
  document.body.append(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 700);
  }, ms);
}

// ------------------------------------------------------------------------------------------ touch-only devices

/** A phone / tablet without a mouse (touch laptops have a fine pointer too and are not affected). */
function isTouchOnly(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

function hasGamepad(): boolean {
  try {
    return Array.from(navigator.getGamepads?.() ?? []).some((p) => !!p);
  } catch {
    return false;
  }
}

/**
 * NOVABALL needs a keyboard + mouse or a gamepad. On touch-only devices a card explains that over the live AI
 * exhibition; WATCH hides the menus so the exhibition plays full screen (a chip brings the card back); PLAY ANYWAY
 * appears once a gamepad is connected (and connecting one dismisses the card).
 */
function installTouchCard(uiRoot: HTMLElement): void {
  const card = document.createElement('div');
  card.id = 'nb-touch-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'NOVABALL needs a keyboard or a gamepad');
  card.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:80',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:16px',
    'box-sizing:border-box',
    'background:radial-gradient(ellipse at 50% 30%, rgba(22,32,74,0.78) 0%, rgba(5,7,13,0.9) 70%)',
    'pointer-events:auto',
    'overflow:auto',
  ].join(';');
  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:min(520px,100%)',
    'box-sizing:border-box',
    'padding:clamp(18px,5vw,30px)',
    'border-radius:14px',
    'border:1px solid rgba(139,233,255,0.45)',
    'background:rgba(5,7,13,0.82)',
    'box-shadow:0 0 40px rgba(30,200,255,0.25)',
    'color:#e6f3ff',
    `font-family:${FONT}`,
    'text-align:center',
    'display:flex',
    'flex-direction:column',
    'gap:14px',
    'align-items:center',
  ].join(';');
  const logo = document.createElement('div');
  logo.textContent = 'NOVABALL';
  logo.style.cssText =
    'font-size:clamp(30px,9vw,48px);font-weight:900;font-style:italic;letter-spacing:0.06em;color:#bff4ff;text-shadow:0 0 22px rgba(30,200,255,0.7)';
  const tag = document.createElement('div');
  tag.textContent = 'HOVER-CAR FOOTBALL AT THE EDGE OF THE GALAXY';
  tag.style.cssText = 'font-size:11px;letter-spacing:0.28em;opacity:0.65';
  const body = document.createElement('div');
  body.textContent =
    'NOVABALL is played with a keyboard & mouse or a gamepad. Open this link on a desktop browser (Chrome, Edge, Firefox or Safari).';
  body.style.cssText = 'font-size:16px;line-height:1.5;opacity:0.9';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:10px;width:100%;margin-top:4px';
  const chip = button('ⓘ  PLAY ON DESKTOP', () => {
    chip.remove();
    card.style.display = 'flex';
    uiRoot.style.visibility = 'hidden';
  }, false);
  chip.style.cssText += ';position:fixed;right:12px;bottom:12px;z-index:79;padding:8px 14px;min-height:36px;font-size:12px';
  const watch = button('WATCH THE AI EXHIBITION', () => {
    card.style.display = 'none';
    uiRoot.style.visibility = 'hidden';
    document.body.append(chip);
  });
  const play = button('PLAY ANYWAY (GAMEPAD)', () => dismiss(), false);
  const dismiss = () => {
    card.remove();
    chip.remove();
    uiRoot.style.visibility = '';
  };
  play.style.display = hasGamepad() ? '' : 'none';
  row.append(watch, play);
  panel.append(logo, tag, body, row);
  card.append(panel);
  document.body.append(card);
  // the menus stay hidden behind the card (they are unusable by touch)
  uiRoot.style.visibility = 'hidden';
  window.addEventListener('gamepadconnected', () => dismiss(), { once: true });
}

// ------------------------------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  if (import.meta.env.DEV) installDevErrorOverlay();
  installGlobalStyles();
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  if (!canvas || !ui) {
    fullScreenMessage('NOVABALL', 'The page is missing its game canvas. Please reload.');
    return;
  }
  const gpu = probeGpu();
  if (!gpu.webgl2) {
    fullScreenMessage(
      'WEBGL 2 REQUIRED',
      'NOVABALL renders a real-time 3D stadium and needs WebGL 2. Please use an up-to-date Chrome, Edge, Firefox or Safari, ' +
        'and make sure hardware acceleration is enabled in your browser settings.',
    );
    return;
  }
  if (!gpu.floatTargets) {
    fullScreenMessage(
      'GRAPHICS NOT SUPPORTED',
      'NOVABALL renders in HDR and needs a browser / graphics driver that can draw to floating-point buffers ' +
        '(WebGL 2 EXT_color_buffer_float), which this one does not offer. Please try an up-to-date Chrome, Edge, Firefox ' +
        'or Safari with hardware acceleration enabled.',
    );
    return;
  }
  if (gpu.software) {
    notice('Hardware acceleration seems off — NOVABALL runs on LOW quality. Enable it in your browser settings for the full show.');
  }
  if (isTouchOnly()) installTouchCard(ui);
  const game = new Game(canvas, ui, gpu.software ? { forceQuality: 'low' } : {});
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
  try {
    await game.start();
  } catch (err) {
    console.error('[novaball] boot failed', err);
    fullScreenMessage('SOMETHING WENT WRONG', 'NOVABALL failed to start: ' + (err instanceof Error ? err.message : String(err)) + '.', [
      { label: 'RELOAD', onClick: () => location.reload() },
      {
        // a broken saved setting must never brick the game: start over from the defaults
        label: 'RESET SETTINGS',
        onClick: () => {
          try {
            localStorage.removeItem(SETTINGS_STORAGE_KEY);
          } catch {
            /* storage blocked */
          }
          location.reload();
        },
      },
    ]);
  }
}

void boot();
