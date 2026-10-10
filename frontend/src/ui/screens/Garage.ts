/**
 * GARAGE: pilot callsign, body style, paint. Owned cosmetics save to settings live.
 * On-chain: STRIKER + ARCTIC are free; every other body / paint is an NFT bought with NOVA. Picking a locked one
 * previews it on the stage with a price tag and a BUY button (gasless: the player signs, the relayer pays).
 */
import { chain, formatNova, NETWORK_LABEL, type CatalogItem, type CosmeticKind } from '../../chain';
import type { CarStyleId } from '../../sim/types';
import { CAR_STYLES, PAINTS, TEAMS } from '../../theme';
import { novaAmount, paintKey } from '../chainui';
import { Panel, type UIContext } from '../core';
import { div, h, span, textNode, setText, play } from '../dom';
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

interface Badge {
  el: HTMLElement;
  text: Text;
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
  private readonly ownTag: HTMLElement;
  private readonly shop: HTMLElement;
  private readonly styleBadges: Badge[] = [];
  private readonly balance = novaAmount('nb-gar-balance');
  private readonly walletBtn: HTMLButtonElement | null;
  private renderedStyle: CarStyleId | null = null;
  /** What the stage shows: the equipped setup, or a locked cosmetic being previewed. */
  private previewStyle: CarStyleId;
  private previewPaint: string;
  private unsub: (() => void) | null = null;
  private shopKey = '';

  constructor(private readonly ctx: UIContext) {
    super();
    const s = ctx.settings;
    this.previewStyle = s.carStyle;
    this.previewPaint = s.paint;
    const onChain = chain.state.enabled;

    // --- preview
    this.previewCar = div('nb-gar-car');
    this.plateName = textNode('');
    this.styleName = textNode('');
    this.styleBlurb = textNode('');
    this.ownTag = span('nb-gar-own');
    this.shop = div('nb-gar-shop');
    this.preview = h(
      'div',
      { class: 'nb-gar-stage' },
      div('nb-gar-rings'),
      div('nb-gar-platform'),
      h('div', { class: 'nb-gar-plate' }, span('nb-gar-plate-team', TEAMS[0].name), span('nb-gar-plate-name', this.plateName)),
      this.previewCar,
      div('nb-gar-unlock'),
      h('div', { class: 'nb-gar-caption' }, this.ownTag, h('div', { class: 'nb-gar-style' }, this.styleName), h('div', { class: 'nb-gar-blurb' }, this.styleBlurb)),
      this.shop,
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
          const badgeText = textNode('');
          const badge = h('span', { class: 'nb-own-badge' }, icon('lock', 'nb-own-lock'), icon('nova', 'nb-own-nova'), icon('check', 'nb-own-check'), span('nb-own-t', badgeText));
          this.styleBadges.push({ el: badge, text: badgeText });
          c.append(art, span('nb-card-title', cs.name), span('nb-card-desc', cs.blurb), badge);
        },
      })),
      () => this.previewStyle,
      (v) => {
        this.previewStyle = v;
        if (chain.unlocked('car', v)) s.carStyle = v;
        this.refreshPreview();
      },
    );

    // --- paints
    this.paintName = textNode('');
    const grid = div('nb-swatches');
    PAINTS.forEach((p) => {
      const b = h(
        'button',
        { class: 'nb-swatch', type: 'button', 'data-nav': '', 'aria-label': p.name, title: p.name },
        span('nb-swatch-chip'),
        h('span', { class: 'nb-swatch-lock' }, icon('lock')),
        h('span', { class: 'nb-swatch-check' }, icon('check')),
      );
      b.style.setProperty('--sw', p.hex);
      b.addEventListener('click', () => {
        const key = p.name.toLowerCase();
        const changed = this.previewPaint.toLowerCase() !== p.hex.toLowerCase();
        this.previewPaint = p.hex;
        if (chain.unlocked('paint', key) && s.paint.toLowerCase() !== p.hex.toLowerCase()) {
          s.paint = p.hex;
          ctx.settingsChanged();
        }
        ctx.sound(changed ? 'toggle' : 'click');
        this.refreshPaint();
        this.refreshPreview();
      });
      b.addEventListener('focus', () => setText(this.paintName, this.paintLabel(p.hex)));
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
      h(
        'div',
        { class: 'nb-gar-note' },
        onChain
          ? `STRIKER and ARCTIC are free. Every other body and paint is an ERC-1155 NFT on ${NETWORK_LABEL.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}, bought with NOVA you earn in matches — the NOVA is burned and the gas is on us.`
          : 'Trims, hover pads and thrusters always glow in your team color.',
      ),
    );

    // --- wallet chip (header)
    this.walletBtn = onChain
      ? h('button', { class: 'nb-gar-wallet', type: 'button', 'data-nav': '', 'aria-label': 'Open wallet' }, this.balance.el, span('nb-gar-wallet-l', 'WALLET'), icon('chevron'))
      : null;
    this.walletBtn?.addEventListener('click', () => {
      ctx.sound('click');
      ctx.open('wallet');
    });

    this.el = h(
      'section',
      { class: `nb-layer nb-panel nb-garage${onChain ? ' is-onchain' : ''}`, 'aria-label': 'Garage' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'GARAGE', onChain ? 'PILOT · CARS · NFTS' : 'PILOT & CAR', this.walletBtn),
      h('div', { class: 'nb-panel-body nb-garage-body' }, this.preview, form),
      h(
        'footer',
        { class: 'nb-panel-foot' },
        span('nb-foot-note', onChain ? 'Owned items equip instantly · locked items preview on the stage' : 'Changes save automatically'),
        h('div', { class: 'nb-hints' }, hint([kbd('ESC', true)], [gp('B')], 'BACK')),
      ),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.styles.cards.find((c) => c.classList.contains('is-selected')) ?? this.styles.cards[0] ?? null;
  }

  override onShow(): void {
    const s = this.ctx.settings;
    this.previewStyle = s.carStyle;
    this.previewPaint = s.paint;
    this.input.value = s.playerName;
    this.unsub ??= chain.subscribe(() => this.refreshChain());
    this.refreshName();
    this.styles.refresh();
    this.refreshPaint();
    this.refreshPreview();
    void chain.refresh();
  }

  override onHide(): void {
    this.commitName();
    this.unsub?.();
    this.unsub = null;
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
    const cur = this.previewPaint.toLowerCase();
    PAINTS.forEach((p, i) => {
      const b = this.swatches[i];
      b.classList.toggle('is-selected', p.hex.toLowerCase() === cur);
      b.classList.toggle('is-locked', !chain.unlocked('paint', p.name.toLowerCase()));
    });
    this.refreshPaintName();
  }

  private refreshPaintName(): void {
    setText(this.paintName, this.paintLabel(this.previewPaint));
  }

  /** "CRIMSON" / "CRIMSON · 20 NOVA" (locked) / "CUSTOM". */
  private paintLabel(hex: string): string {
    const p = PAINTS.find((x) => x.hex.toLowerCase() === hex.toLowerCase());
    if (!p) return 'CUSTOM';
    const key = p.name.toLowerCase();
    const it = chain.item('paint', key);
    return !chain.unlocked('paint', key) && it ? `${p.name.toUpperCase()} · ${formatNova(it.price)} NOVA` : p.name.toUpperCase();
  }

  private refreshPreview(): void {
    const cs = CAR_STYLES.find((c) => c.id === this.previewStyle) ?? CAR_STYLES[0];
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
    this.el.style.setProperty('--paint', this.previewPaint);
    setText(this.styleName, cs.name);
    setText(this.styleBlurb, cs.blurb);
    this.refreshChain();
  }

  // ------------------------------------------------------------------ on-chain: locks, ownership tags, shop

  private refreshChain(): void {
    const st = chain.state;
    if (!st.enabled) return;
    this.balance.set(st.balance);
    // style cards
    CAR_STYLES.forEach((cs, i) => {
      const b = this.styleBadges[i];
      const it = chain.item('car', cs.id);
      const own = chain.unlocked('car', cs.id);
      const starter = cs.id === 'striker';
      b.el.className = `nb-own-badge ${starter ? 'is-free' : own ? 'is-owned' : 'is-locked'}`;
      setText(b.text, starter ? 'STARTER' : own ? `NFT #${it?.id ?? ''}` : it ? formatNova(it.price) : '—');
      this.styles.cards[i].classList.toggle('is-locked', !own);
    });
    this.refreshPaint();
    // ownership tag over the caption
    const car = chain.item('car', this.previewStyle);
    const ownCar = chain.unlocked('car', this.previewStyle);
    const pk = paintKey(this.previewPaint);
    const ownPaint = !pk || chain.unlocked('paint', pk);
    const locked = !ownCar || !ownPaint;
    this.preview.classList.toggle('is-preview', locked);
    this.ownTag.className = `nb-gar-own ${locked ? 'is-locked' : 'is-owned'}`;
    this.ownTag.replaceChildren(
      icon(locked ? 'lock' : 'verified'),
      locked ? 'PREVIEW · NOT OWNED' : car && ownCar ? `OWNED · NFT #${car.id}` : this.previewStyle === 'striker' ? 'STARTER CAR · EQUIPPED' : 'EQUIPPED',
    );
    this.renderShop();
  }

  /** Price tags + BUY buttons for whatever locked cosmetic the stage is previewing. */
  private renderShop(): void {
    const items: CatalogItem[] = [];
    const car = chain.item('car', this.previewStyle);
    if (car && !chain.unlocked('car', this.previewStyle)) items.push(car);
    const pk = paintKey(this.previewPaint);
    const paint = pk ? chain.item('paint', pk) : null;
    if (paint && !chain.unlocked('paint', pk!)) items.push(paint);
    const st = chain.state;
    const key = items.map((i) => `${i.id}:${i.price}:${st.purchases.get(i.id)?.status ?? ''}:${st.purchases.get(i.id)?.message ?? ''}`).join('|') + `|${st.balance}`;
    if (key === this.shopKey) return;
    this.shopKey = key;
    const hadFocus = this.shop.contains(document.activeElement);
    this.shop.replaceChildren(...items.map((it) => this.shopRow(it)));
    if (hadFocus) this.ctx.focus((this.shop.querySelector('[data-nav]') as HTMLElement | null) ?? this.defaultFocus());
  }

  private shopRow(it: CatalogItem): HTMLElement {
    const st = chain.state;
    const p = st.purchases.get(it.id);
    const busy = p && (p.status === 'signing' || p.status === 'sending' || p.status === 'pending');
    const balance = st.balance ?? 0n;
    const short = it.price - balance;
    const kind: CosmeticKind = it.kind;
    const label = kind === 'car' ? (CAR_STYLES.find((c) => c.id === it.key)?.name ?? it.name) : (PAINTS.find((x) => x.name.toLowerCase() === it.key)?.name.toUpperCase() ?? it.name);

    let btn: HTMLButtonElement;
    if (!busy && chain.purchaseBusy) {
      // one purchase at a time (each one signs the wallet's next nonce)
      btn = h('button', { class: 'nb-btn nb-btn-secondary nb-gar-buy is-busy', type: 'button', 'data-nav': '', title: 'Another purchase is in progress' }, h('span', { class: 'nb-btn-inner' }, span('nb-btn-label', 'WAIT')));
    } else if (busy) {
      const text = p!.status === 'signing' ? (st.wallet?.kind === 'external' ? 'CONFIRM IN WALLET' : 'SIGNING') : p!.status === 'sending' ? 'SENDING' : 'MINTING NFT';
      btn = h('button', { class: 'nb-btn nb-btn-primary nb-gar-buy is-busy', type: 'button', 'data-nav': '' }, h('span', { class: 'nb-btn-inner' }, icon('spinner', 'nb-btn-ico nb-spin'), span('nb-btn-label', text)));
    } else if (short > 0n) {
      btn = h('button', { class: 'nb-btn nb-btn-secondary nb-gar-buy', type: 'button', 'data-nav': '', title: 'Play a match to earn NOVA' }, h('span', { class: 'nb-btn-inner' }, icon('play', 'nb-btn-ico'), span('nb-btn-label', 'EARN NOVA')));
      btn.addEventListener('click', () => {
        this.ctx.sound('click');
        this.ctx.open('setup');
      });
    } else {
      btn = h('button', { class: 'nb-btn nb-btn-primary nb-gar-buy', type: 'button', 'data-nav': '' }, h('span', { class: 'nb-btn-inner' }, icon('nova', 'nb-btn-ico'), span('nb-btn-label', p?.status === 'error' ? 'TRY AGAIN' : 'BUY')));
      btn.addEventListener('click', () => this.buy(it));
    }

    const status =
      p?.status === 'error'
        ? span('nb-shop-msg is-err', p.message ?? 'Purchase failed')
        : busy
          ? span('nb-shop-msg', p!.status === 'pending' ? 'Minting your NFT on-chain…' : p!.status === 'sending' ? 'Relayer is submitting · gas sponsored' : 'Authorizing the purchase…')
          : short > 0n
            ? span('nb-shop-msg', `Need ${formatNova(short)} more NOVA — play a match`)
            : span('nb-shop-msg is-ok', `Balance ${formatNova(balance)} NOVA · no gas needed`);

    return h(
      'div',
      { class: `nb-shop-row is-${kind}` },
      h(
        'div',
        { class: 'nb-shop-info' },
        h('span', { class: 'nb-shop-k' }, icon('lock'), kind === 'car' ? 'CAR BODY · NFT' : 'PAINT · NFT'),
        h('span', { class: 'nb-shop-name' }, kind === 'paint' ? h('span', { class: 'nb-shop-chip', style: `--sw:${PAINTS.find((x) => x.name.toLowerCase() === it.key)?.hex ?? '#fff'}` }) : null, label),
        h('span', { class: 'nb-shop-price' }, icon('nova', 'nb-nova-ico'), span('nb-nova-v', formatNova(it.price)), span('nb-nova-u', 'NOVA')),
        status,
      ),
      btn,
    );
  }

  private async buy(it: CatalogItem): Promise<void> {
    this.ctx.sound('click');
    try {
      await chain.buy(it.id);
    } catch {
      this.ctx.sound('error');
      return;
    }
    // equip what was just bought (if the stage still shows it) and celebrate
    const s = this.ctx.settings;
    if (it.kind === 'car') {
      s.carStyle = it.key as CarStyleId;
      this.previewStyle = s.carStyle;
    } else {
      const p = PAINTS.find((x) => x.name.toLowerCase() === it.key);
      if (p) {
        s.paint = p.hex;
        this.previewPaint = p.hex;
      }
    }
    this.ctx.settingsChanged();
    this.ctx.sound('start');
    this.styles.refresh();
    this.refreshPreview();
    const burst = this.preview.querySelector('.nb-gar-unlock') as HTMLElement | null;
    if (burst) {
      burst.textContent = `${it.kind === 'car' ? it.name : `${it.name} PAINT`} UNLOCKED`;
      play(
        burst,
        [
          { opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' },
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1.05)', offset: 0.25 },
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 },
          { opacity: 0, transform: 'translate(-50%, -50%) scale(1)' },
        ],
        { duration: 2200, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }
  }
}
