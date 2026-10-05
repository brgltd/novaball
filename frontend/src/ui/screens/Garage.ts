/** GARAGE: pilot callsign, body style, paint. Everything saves to settings live. */
import type { CarStyleId } from '../../sim/types';
import { CAR_STYLES, PAINTS, TEAMS } from '../../theme';
import { Panel, type UIContext } from '../core';
import { div, h, span, textNode, setText } from '../dom';
import { carSvg } from '../icons';
import { choiceGroup, gp, hint, icon, kbd, sectionTitle, type ChoiceGroup } from '../widgets';
import { panelHeader } from './common';

export const NAME_MAX = 12;

/** Uppercase, allowed characters only, max 12. */
export function sanitizeName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9 _\-.]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s+/, '')
    .slice(0, NAME_MAX);
}

export class Garage extends Panel {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly counter: Text;
  private readonly styles: ChoiceGroup<CarStyleId>;
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly paintName: Text;
  private readonly preview: HTMLElement;
  private readonly previewCar: HTMLElement;
  private readonly plateName: Text;
  private readonly styleName: Text;
  private readonly styleBlurb: Text;
  private renderedStyle: CarStyleId | null = null;

  constructor(private readonly ctx: UIContext) {
    super();
    const s = ctx.settings;

    // --- preview
    this.previewCar = div('nb-gar-car');
    this.plateName = textNode('');
    this.styleName = textNode('');
    this.styleBlurb = textNode('');
    this.preview = h(
      'div',
      { class: 'nb-gar-stage' },
      div('nb-gar-rings'),
      div('nb-gar-platform'),
      h('div', { class: 'nb-gar-plate' }, span('nb-gar-plate-team', TEAMS[0].name), span('nb-gar-plate-name', this.plateName)),
      this.previewCar,
      h('div', { class: 'nb-gar-caption' }, h('div', { class: 'nb-gar-style' }, this.styleName), h('div', { class: 'nb-gar-blurb' }, this.styleBlurb)),
    );

    // --- name
    this.input = h('input', {
      class: 'nb-input',
      type: 'text',
      maxlength: String(NAME_MAX),
      spellcheck: 'false',
      autocomplete: 'off',
      'data-nav': '',
      'aria-label': 'Pilot name',
    });
    this.counter = textNode('');
    this.input.addEventListener('input', () => {
      const clean = sanitizeName(this.input.value);
      if (clean !== this.input.value) {
        const pos = Math.min(clean.length, this.input.selectionStart ?? clean.length);
        this.input.value = clean;
        try {
          this.input.setSelectionRange(pos, pos);
        } catch {
          /* ignore */
        }
      }
      const trimmed = clean.trim();
      if (trimmed) {
        s.playerName = trimmed;
        ctx.settingsChanged();
      }
      this.refreshName();
    });
    this.input.addEventListener('blur', () => this.commitName());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.commitName();
        ctx.sound('click');
      }
    });

    // --- styles
    this.styles = choiceGroup(
      ctx,
      'nb-choices-style',
      CAR_STYLES.map((cs) => ({
        value: cs.id,
        build: (c: HTMLElement) => {
          c.classList.add('nb-card-style');
          const art = div('nb-style-art');
          art.innerHTML = carSvg(cs.id, { ground: false });
          c.append(art, span('nb-card-title', cs.name), span('nb-card-desc', cs.blurb));
        },
      })),
      () => s.carStyle,
      (v) => {
        s.carStyle = v;
        this.refreshPreview();
      },
    );

    // --- paints
    this.paintName = textNode('');
    const grid = div('nb-swatches');
    PAINTS.forEach((p) => {
      const b = h('button', { class: 'nb-swatch', type: 'button', 'data-nav': '', 'aria-label': p.name, title: p.name }, span('nb-swatch-chip'), h('span', { class: 'nb-swatch-check' }, icon('check')));
      b.style.setProperty('--sw', p.hex);
      b.addEventListener('click', () => {
        if (s.paint.toLowerCase() !== p.hex.toLowerCase()) {
          s.paint = p.hex;
          ctx.sound('toggle');
          ctx.settingsChanged();
        } else ctx.sound('click');
        this.refreshPaint();
        this.refreshPreview();
      });
      b.addEventListener('focus', () => setText(this.paintName, p.name.toUpperCase()));
      b.addEventListener('blur', () => this.refreshPaintName());
      this.swatches.push(b);
      grid.append(b);
    });

    const form = div(
      'nb-gar-form',
      sectionTitle('PILOT CALLSIGN', h('span', { class: 'nb-section-aside' }, this.counter)),
      h(
        'label',
        { class: 'nb-input-wrap' },
        icon('pilot', 'nb-input-ico'),
        this.input,
        h('span', { class: 'nb-input-hint' }, h('span', { class: 'nb-only-kb' }, kbd('ENTER', true)), h('span', { class: 'nb-only-gp' }, gp('A')), span('nb-input-hint-l', 'EDIT')),
      ),
      sectionTitle('BODY STYLE'),
      this.styles.el,
      sectionTitle('PAINT', h('span', { class: 'nb-section-aside nb-paint-name' }, this.paintName)),
      grid,
      h('div', { class: 'nb-gar-note' }, 'Trims, hover pads and thrusters always glow in your team color. Cosmetics are data-driven — ready for on-chain ownership.'),
    );

    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-garage', 'aria-label': 'Garage' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'GARAGE', 'PILOT & CAR'),
      h('div', { class: 'nb-panel-body nb-garage-body' }, this.preview, form),
      h('footer', { class: 'nb-panel-foot' }, span('nb-foot-note', 'Changes save automatically'), h('div', { class: 'nb-hints' }, hint([kbd('ESC', true)], [gp('B')], 'BACK'))),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.styles.cards.find((c) => c.classList.contains('is-selected')) ?? this.styles.cards[0] ?? null;
  }

  override onShow(): void {
    this.input.value = this.ctx.settings.playerName;
    this.refreshName();
    this.styles.refresh();
    this.refreshPaint();
    this.refreshPreview();
  }

  override onHide(): void {
    this.commitName();
  }

  override onBack(): boolean {
    if (document.activeElement === this.input) {
      this.commitName();
    }
    return false;
  }

  private commitName(): void {
    const clean = sanitizeName(this.input.value).trim();
    const s = this.ctx.settings;
    if (!clean) {
      this.input.value = s.playerName || 'PLAYER';
    } else if (clean !== s.playerName) {
      s.playerName = clean;
      this.ctx.settingsChanged();
    }
    if (this.input.value !== (s.playerName || 'PLAYER')) this.input.value = s.playerName || 'PLAYER';
    this.refreshName();
  }

  private refreshName(): void {
    const v = this.input.value;
    setText(this.counter, `${v.length}/${NAME_MAX}`);
    setText(this.plateName, v.trim() || this.ctx.settings.playerName || 'PLAYER');
  }

  private refreshPaint(): void {
    const cur = this.ctx.settings.paint.toLowerCase();
    PAINTS.forEach((p, i) => this.swatches[i].classList.toggle('is-selected', p.hex.toLowerCase() === cur));
    this.refreshPaintName();
  }

  private refreshPaintName(): void {
    const cur = this.ctx.settings.paint.toLowerCase();
    const p = PAINTS.find((x) => x.hex.toLowerCase() === cur);
    setText(this.paintName, p ? p.name.toUpperCase() : 'CUSTOM');
  }

  private refreshPreview(): void {
    const s = this.ctx.settings;
    const cs = CAR_STYLES.find((c) => c.id === s.carStyle) ?? CAR_STYLES[0];
    if (this.renderedStyle !== cs.id) {
      this.renderedStyle = cs.id;
      this.previewCar.innerHTML = carSvg(cs.id);
      this.previewCar.animate?.(
        [
          { transform: 'translateX(-6%) scale(.96)', opacity: 0 },
          { transform: 'translateX(0) scale(1)', opacity: 1 },
        ],
        { duration: 420, easing: 'cubic-bezier(.2,.9,.2,1)' },
      );
    }
    this.el.style.setProperty('--paint', s.paint);
    setText(this.styleName, cs.name);
    setText(this.styleBlurb, cs.blurb);
  }
}
