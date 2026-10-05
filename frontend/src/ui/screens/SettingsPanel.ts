/** SETTINGS: tabs (graphics / camera / audio / controls), live-applied rows, help side panel, reset to defaults. */
import { DEFAULT_SETTINGS, type QualityPreset, type Settings } from '../../settings';
import { Panel, type UIContext } from '../core';
import { div, h, setText, span, textNode } from '../dom';
import type { IconName } from '../icons';
import { button, gp, hint, icon, kbd, optionRow, sliderRow, toggleRow, type Row } from '../widgets';
import { panelHeader } from './common';

type TabId = 'graphics' | 'camera' | 'audio' | 'controls';

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: IconName; blurb: string }> = [
  { id: 'graphics', label: 'GRAPHICS', icon: 'settings', blurb: 'Image quality and performance.' },
  { id: 'camera', label: 'CAMERA', icon: 'ballCam', blurb: 'How the chase camera frames the action.' },
  { id: 'audio', label: 'AUDIO', icon: 'pulse', blurb: 'Mix of effects, crowd and the synthwave score.' },
  { id: 'controls', label: 'CONTROLS', icon: 'gamepad', blurb: 'Stick feel, pitch direction and rumble.' },
];

/** Settings keys reset by "Reset to defaults" (garage / match setup / tutorial state are kept). */
const RESET_KEYS: ReadonlyArray<keyof Settings> = [
  'quality',
  'dynamicResolution',
  'targetFps',
  'maxPixelRatio',
  'showFps',
  'fov',
  'cameraDistance',
  'cameraHeight',
  'cameraStiffness',
  'ballCamDefault',
  'screenShake',
  'masterVolume',
  'sfxVolume',
  'musicVolume',
  'invertPitch',
  'gamepadDeadzone',
  'vibration',
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export class SettingsPanel extends Panel {
  readonly el: HTMLElement;
  private tab: TabId = 'graphics';
  private readonly tabBtns = new Map<TabId, HTMLButtonElement>();
  private readonly pages = new Map<TabId, HTMLElement>();
  private readonly rows: Row[] = [];
  private readonly scroller: HTMLElement;
  private readonly sideIco: HTMLElement;
  private readonly sideTab: Text;
  private readonly sideTitle: Text;
  private readonly sideText: Text;

  constructor(private readonly ctx: UIContext) {
    super();
    const s = ctx.settings;
    const set =
      <K extends keyof Settings>(k: K) =>
      (v: Settings[K]) => {
        s[k] = v;
      };
    const add = (tab: TabId, r: Row) => {
      this.rows.push(r);
      this.pages.get(tab)!.append(r.el);
    };
    for (const t of TABS) this.pages.set(t.id, h('div', { class: `nb-set-page p-${t.id}`, role: 'tabpanel' }));

    // --- graphics
    add(
      'graphics',
      optionRow<QualityPreset>(ctx, {
        label: 'Quality preset',
        desc: 'Reflections, bloom, particles and shadow resolution.',
        help: 'LOW and MEDIUM trade reflection quality and effects for speed; ULTRA adds detail for strong GPUs. If the frame rate dips, step down one preset.',
        options: [
          { value: 'low', label: 'LOW' },
          { value: 'medium', label: 'MEDIUM' },
          { value: 'high', label: 'HIGH' },
          { value: 'ultra', label: 'ULTRA' },
        ],
        get: () => s.quality,
        set: set('quality'),
      }),
    );
    add(
      'graphics',
      toggleRow(ctx, {
        label: 'Dynamic resolution',
        desc: 'Scales render resolution to hold your minimum frame rate.',
        help: 'During heavy moments — goal explosions, surges, 3v3 pile-ups — the renderer briefly lowers its internal resolution to keep motion perfectly smooth, then restores it.',
        get: () => s.dynamicResolution,
        set: set('dynamicResolution'),
      }),
    );
    add(
      'graphics',
      optionRow<number>(ctx, {
        label: 'Minimum frame rate',
        desc: 'Dynamic resolution keeps the game at or above this.',
        help: '60 is right for almost everyone; higher values only help on a strong GPU with a high-refresh display. Dynamic resolution lowers the render resolution to hold this frame rate.',
        options: [
          { value: 60, label: '60' },
          { value: 120, label: '120' },
          { value: 144, label: '144' },
        ],
        get: () => s.targetFps,
        set: set('targetFps'),
      }),
    );
    add(
      'graphics',
      sliderRow(ctx, {
        label: 'Max pixel ratio',
        desc: 'Caps rendering resolution on high-DPI screens.',
        help: 'On Retina / 4K screens the game can render above 1× resolution for extra sharpness. Higher values look crisper but cost GPU time.',
        min: 1,
        max: 2,
        step: 0.25,
        get: () => s.maxPixelRatio,
        set: set('maxPixelRatio'),
        format: (v) => `${v.toFixed(2)}×`,
      }),
    );
    add('graphics', toggleRow(ctx, { label: 'Show FPS', desc: 'Frame-rate counter in the corner of the HUD.', get: () => s.showFps, set: set('showFps') }));
    // Not a stored setting: mirrors the browser's fullscreen state (toggling needs the click / key press itself).
    const fsRow = toggleRow(ctx, {
      label: 'Fullscreen',
      desc: 'Use the whole screen. Hold Esc to leave it.',
      help: 'Hides the browser bars so the arena fills your display. In a match, Esc still pauses; hold Esc (or use this toggle) to leave fullscreen.',
      get: () => ctx.fullscreen,
      set: () => ctx.toggleFullscreen(),
      silent: true,
    });
    add('graphics', fsRow);
    ctx.onFullscreenChange(() => fsRow.refresh());

    // --- camera
    add(
      'camera',
      sliderRow(ctx, {
        label: 'Field of view',
        desc: 'Horizontal FOV. Wider shows more of the arena.',
        help: 'Horizontal field of view. Wider angles give more awareness of cars around you; narrower angles make the ball and cars look bigger.',
        min: 70,
        max: 120,
        step: 1,
        get: () => s.fov,
        set: set('fov'),
        format: (v) => `${Math.round(v)}°`,
      }),
    );
    add('camera', sliderRow(ctx, { label: 'Distance', desc: 'How far the camera trails behind your car.', min: 2.2, max: 5.5, step: 0.1, get: () => s.cameraDistance, set: set('cameraDistance'), format: (v) => `${v.toFixed(1)} m` }));
    add('camera', sliderRow(ctx, { label: 'Height', desc: 'Camera height above your car.', min: 0.6, max: 2.4, step: 0.05, get: () => s.cameraHeight, set: set('cameraHeight'), format: (v) => `${v.toFixed(2)} m` }));
    add(
      'camera',
      sliderRow(ctx, {
        label: 'Stiffness',
        desc: 'Higher = tighter follow, lower = smoother swing.',
        help: 'How rigidly the camera sticks to your car. Low values swing smoothly through turns; high values feel precise and direct.',
        min: 0,
        max: 1,
        step: 0.05,
        get: () => s.cameraStiffness,
        set: set('cameraStiffness'),
        format: pct,
      }),
    );
    add(
      'camera',
      toggleRow(ctx, {
        label: 'Ball cam by default',
        desc: 'Start every match locked onto the Nova Core.',
        help: 'Ball cam keeps the Nova Core in frame at all times. Toggle it any time in a match with TAB or Y.',
        get: () => s.ballCamDefault,
        set: set('ballCamDefault'),
      }),
    );
    add('camera', sliderRow(ctx, { label: 'Screen shake', desc: 'Impacts, goals and demolitions.', min: 0, max: 1, step: 0.05, get: () => s.screenShake, set: set('screenShake'), format: pct }));

    // --- audio
    add('audio', sliderRow(ctx, { label: 'Master volume', desc: 'Overall game volume.', min: 0, max: 1, step: 0.05, get: () => s.masterVolume, set: set('masterVolume'), format: pct }));
    add('audio', sliderRow(ctx, { label: 'Effects', desc: 'Engines, hits, explosions, crowd.', min: 0, max: 1, step: 0.05, get: () => s.sfxVolume, set: set('sfxVolume'), format: pct }));
    add(
      'audio',
      sliderRow(ctx, {
        label: 'Music',
        desc: 'Procedural synthwave soundtrack.',
        help: 'The soundtrack is generated live in your browser and reacts to the match — intensity rises in the final minute, during surges and in overtime.',
        min: 0,
        max: 1,
        step: 0.05,
        get: () => s.musicVolume,
        set: set('musicVolume'),
        format: pct,
      }),
    );

    // --- controls
    add(
      'controls',
      toggleRow(ctx, {
        label: 'Invert pitch',
        desc: 'Flight-sim style: pull the stick back (or press S) to dive.',
        help: 'Flips the pitch axis in the air, for keyboard and gamepad. Off: push forward (or W) to tilt the nose down.',
        get: () => s.invertPitch,
        set: set('invertPitch'),
      }),
    );
    add(
      'controls',
      sliderRow(ctx, {
        label: 'Gamepad deadzone',
        desc: 'Radial left-stick deadzone.',
        help: 'Stick movement below this radius is ignored. Raise it if your car drifts without input; lower it for finer aerial control.',
        min: 0.02,
        max: 0.4,
        step: 0.01,
        get: () => s.gamepadDeadzone,
        set: set('gamepadDeadzone'),
        format: pct,
      }),
    );
    add('controls', toggleRow(ctx, { label: 'Vibration', desc: 'Gamepad rumble on hits, goals and demolitions.', get: () => s.vibration, set: set('vibration') }));
    const viewControls = button(ctx, { label: 'VIEW CONTROLS', icon: 'keyboard', variant: 'ghost', cls: 'nb-set-link', onClick: () => ctx.open('controls') });
    viewControls.setAttribute('data-label', 'View controls');
    viewControls.setAttribute('data-help', 'Full keyboard, mouse and gamepad layout.');
    this.pages.get('controls')!.append(viewControls);

    // --- tabs
    const tabBar = h('div', { class: 'nb-tabs', role: 'tablist' });
    tabBar.append(h('span', { class: 'nb-tabs-key nb-tabs-key-l' }, h('span', { class: 'nb-only-kb' }, kbd('Q')), h('span', { class: 'nb-only-gp' }, gp('LB'))));
    for (const t of TABS) {
      const b = h('button', { class: 'nb-tab', type: 'button', role: 'tab', 'data-nav': '', 'data-label': t.label, 'data-help': t.blurb }, icon(t.icon), span('nb-tab-label', t.label));
      b.addEventListener('click', () => this.setTab(t.id, true));
      this.tabBtns.set(t.id, b);
      tabBar.append(b);
    }
    tabBar.append(h('span', { class: 'nb-tabs-key nb-tabs-key-r' }, h('span', { class: 'nb-only-kb' }, kbd('E')), h('span', { class: 'nb-only-gp' }, gp('RB'))));

    const reset = button(ctx, {
      label: 'RESET TO DEFAULTS',
      icon: 'reset',
      variant: 'ghost',
      cls: 'nb-reset-btn',
      onClick: () =>
        ctx.confirm(
          { title: 'RESET SETTINGS?', body: 'Graphics, camera, audio and control settings return to their defaults. Your garage and match setup are kept.', confirmLabel: 'RESET', danger: true },
          () => this.resetDefaults(),
        ),
    });

    // --- help side panel (follows keyboard / gamepad / mouse focus)
    this.sideIco = div('nb-set-side-ico');
    this.sideTab = textNode('');
    this.sideTitle = textNode('');
    this.sideText = textNode('');
    const side = h(
      'aside',
      { class: 'nb-set-side' },
      this.sideIco,
      h('div', { class: 'nb-set-side-tab' }, this.sideTab),
      h('div', { class: 'nb-set-side-title' }, this.sideTitle),
      h('div', { class: 'nb-set-side-text' }, this.sideText),
      h('div', { class: 'nb-set-side-foot' }, span('nb-live-dot nb-set-live'), 'CHANGES APPLY INSTANTLY'),
    );

    this.scroller = h('div', { class: 'nb-set-scroll', 'data-scroll': '' }, ...TABS.map((t) => this.pages.get(t.id)!));
    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-settings', 'aria-label': 'Settings' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'SETTINGS', 'OPTIONS', reset),
      h('div', { class: 'nb-panel-body nb-settings-body' }, h('div', { class: 'nb-settings-main' }, tabBar, this.scroller), side),
      h(
        'footer',
        { class: 'nb-panel-foot' },
        span('nb-foot-note', 'Saved to this browser'),
        h('div', { class: 'nb-hints' }, hint([kbd('←'), kbd('→')], [gp('DPAD')], 'ADJUST'), hint([kbd('Q'), kbd('E')], [gp('LB'), gp('RB')], 'TABS'), hint([kbd('ESC', true)], [gp('B')], 'BACK')),
      ),
    );
    this.el.addEventListener('focusin', (e) => this.describe(e.target as HTMLElement));
    this.setTab('graphics', false);
  }

  override defaultFocus(): HTMLElement | null {
    const page = this.pages.get(this.tab)!;
    return page.querySelector<HTMLElement>('[data-nav]');
  }

  override onShow(): void {
    for (const r of this.rows) r.refresh();
    this.describe(null);
  }

  override onTab(dir: -1 | 1): boolean {
    const i = TABS.findIndex((t) => t.id === this.tab);
    const j = (i + dir + TABS.length) % TABS.length;
    this.setTab(TABS[j].id, true);
    this.ctx.focus(this.defaultFocus());
    return true;
  }

  private setTab(id: TabId, sound: boolean): void {
    if (sound && id !== this.tab) this.ctx.sound('toggle');
    this.tab = id;
    for (const t of TABS) {
      const on = t.id === id;
      this.tabBtns.get(t.id)!.classList.toggle('is-on', on);
      this.tabBtns.get(t.id)!.setAttribute('aria-selected', String(on));
      this.pages.get(t.id)!.classList.toggle('is-on', on);
    }
    this.scroller.scrollTop = 0;
    const t = TABS.find((x) => x.id === id)!;
    this.sideIco.replaceChildren(icon(t.icon));
    this.describe(null);
  }

  private describe(target: HTMLElement | null): void {
    const src = target?.closest<HTMLElement>('[data-help]');
    const t = TABS.find((x) => x.id === this.tab)!;
    if (!src || src.classList.contains('nb-tab')) {
      setText(this.sideTab, 'SECTION');
      setText(this.sideTitle, t.label);
      setText(this.sideText, t.blurb);
      return;
    }
    setText(this.sideTab, t.label);
    setText(this.sideTitle, (src.getAttribute('data-label') ?? '').toUpperCase());
    setText(this.sideText, src.getAttribute('data-help') ?? '');
  }

  private resetDefaults(): void {
    const s = this.ctx.settings as unknown as Record<string, unknown>;
    const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    for (const k of RESET_KEYS) s[k] = d[k];
    for (const r of this.rows) r.refresh();
    this.ctx.settingsChanged();
  }
}
