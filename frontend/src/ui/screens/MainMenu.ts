/** Title screen over the live 3D attract match: wordmark, main menu, pilot card, NOVA rules card, input hints. */
import { chain, NETWORK_LABEL, shortAddress } from '../../chain';
import { CAR_STYLES, GAME_TAGLINE, PAINTS } from '../../theme';
import { novaAmount } from '../chainui';
import { Panel, type UIContext } from '../core';
import { div, frag, h, span } from '../dom';
import { carSvg, ICONS, type IconName } from '../icons';
import { logo } from '../logo';
import { gp, hint, icon, kbd } from '../widgets';

interface MenuEntry {
  id: string;
  label: string;
  desc: string;
  icon: IconName;
  primary?: boolean;
  action: () => void;
}

export class MainMenu extends Panel {
  readonly el: HTMLElement;
  override root = true;
  override wrap = true;
  private readonly items: HTMLButtonElement[] = [];
  private readonly pilotName: HTMLElement;
  private readonly pilotStyle: HTMLElement;
  private readonly pilotCar: HTMLElement;
  private readonly fsLabel: HTMLElement;
  private readonly walletBalance = novaAmount('nb-wcard-balance');
  private readonly walletSub: HTMLElement;
  private readonly walletCard: HTMLElement | null;

  constructor(private readonly ctx: UIContext, actions: { play(): void; freePlay(): void }) {
    super();
    const entries: MenuEntry[] = [
      { id: 'play', label: 'PLAY', desc: 'Exhibition vs AI · 1v1 · 2v2 · 3v3', icon: 'play', primary: true, action: actions.play },
      { id: 'free', label: 'FREE PLAY', desc: 'Just you, the Nova Core and an empty arena', icon: 'freePlay', action: actions.freePlay },
      { id: 'garage', label: 'GARAGE', desc: chain.state.enabled ? 'Cars & paints · unlock NFTs with NOVA' : 'Callsign, body style and paint', icon: 'garage', action: () => ctx.open('garage') },
      ...(chain.state.enabled
        ? [
            { id: 'wallet', label: 'WALLET', desc: 'NOVA balance, NFTs & on-chain activity', icon: 'wallet' as IconName, action: () => ctx.open('wallet') },
            { id: 'leaderboard', label: 'LEADERBOARD', desc: 'Top pilots, read live from the chain', icon: 'trophy' as IconName, action: () => ctx.open('leaderboard') },
          ]
        : []),
      { id: 'settings', label: 'SETTINGS', desc: 'Graphics · camera · audio · controls', icon: 'settings', action: () => ctx.open('settings') },
      { id: 'controls', label: 'CONTROLS', desc: 'Keyboard, mouse and gamepad layout', icon: 'gamepad', action: () => ctx.open('controls') },
    ];

    const list = h('nav', { class: 'nb-mm-list', 'aria-label': 'Main menu' });
    entries.forEach((e, i) => {
      const b = h(
        'button',
        { class: `nb-mm-item${e.primary ? ' is-primary' : ''}`, type: 'button', 'data-nav': '', 'data-nav-group': 'menu', 'data-id': e.id },
        span('nb-mm-glow'),
        span('nb-mm-idx', String(i + 1).padStart(2, '0')),
        h('span', { class: 'nb-mm-ico' }, frag(ICONS[e.icon])),
        span('nb-mm-label', e.label),
        span('nb-mm-desc', e.desc),
        h('span', { class: 'nb-mm-arrow' }, icon('chevron')),
      );
      b.style.setProperty('--i', String(i));
      b.addEventListener('click', () => {
        ctx.sound('click');
        e.action();
      });
      this.items.push(b);
      list.append(b);
    });

    // Pilot card (top right) → garage.
    this.pilotName = span('nb-pilot-name', '');
    this.pilotStyle = span('nb-pilot-style', '');
    this.pilotCar = span('nb-pilot-car');
    const pilot = h(
      'button',
      { class: 'nb-pilot', type: 'button', 'data-nav': '', 'data-nav-group': 'side', 'aria-label': 'Open garage' },
      this.pilotCar,
      h('span', { class: 'nb-pilot-text' }, span('nb-pilot-k', 'PILOT'), this.pilotName, this.pilotStyle),
      h('span', { class: 'nb-pilot-edit' }, icon('garage')),
    );
    pilot.addEventListener('click', () => {
      ctx.sound('click');
      ctx.open('garage');
    });

    // Wallet card (under the pilot card) → wallet panel. Only when the game is connected to a deployment.
    this.walletSub = span('nb-wcard-sub');
    this.walletCard = chain.state.enabled
      ? h(
          'button',
          { class: 'nb-wcard', type: 'button', 'data-nav': '', 'data-nav-group': 'side', 'aria-label': 'Open wallet' },
          h('span', { class: 'nb-wcard-ico' }, icon('nova')),
          h('span', { class: 'nb-wcard-text' }, h('span', { class: 'nb-wcard-k' }, 'NOVA', span('nb-wcard-net', h('span', { class: 'nb-net-dot' }), NETWORK_LABEL)), this.walletBalance.el, this.walletSub),
          h('span', { class: 'nb-pilot-edit' }, icon('chevron')),
        )
      : null;
    this.walletCard?.addEventListener('click', () => {
      ctx.sound('click');
      ctx.open('wallet');
    });
    chain.subscribe(() => this.refreshWallet());

    // The three original mechanics, always visible for first-time players (and judges).
    const rule = (ico: IconName, name: string, text: string, cls: string) =>
      h('div', { class: `nb-rule ${cls}` }, h('span', { class: 'nb-rule-ico' }, icon(ico)), h('div', { class: 'nb-rule-text' }, span('nb-rule-name', name), span('nb-rule-desc', text)));
    const rules = h(
      'aside',
      { class: 'nb-rules' },
      h('div', { class: 'nb-rules-head' }, span('nb-rules-k', 'THE NOVA RULES'), span('nb-rules-line')),
      rule('charge', 'CORE CHARGE', 'Chain team touches to charge the core. Goals score up to 3 points.', 'r-charge'),
      rule('pulse', 'NOVA PULSE', 'Unleash a shockwave that blasts the ball and rivals away.', 'r-pulse'),
      rule('surge', 'ZERO-G SURGE', 'Every minute, gravity drops for 10 s. The ball floats — take flight.', 'r-surge'),
    );

    // Browser fullscreen (a 1366×768 laptop only leaves ~1366×657 for the game otherwise).
    this.fsLabel = span('nb-mm-fs-l', 'FULLSCREEN');
    const fs = h('button', { class: 'nb-mm-fs', type: 'button', 'data-nav': '', 'data-nav-group': 'foot', 'aria-label': 'Toggle fullscreen' }, icon('fullscreen'), this.fsLabel);
    fs.addEventListener('click', () => {
      ctx.sound('click');
      ctx.toggleFullscreen();
    });
    ctx.onFullscreenChange((on) => {
      this.fsLabel.textContent = on ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
    });

    const footer = h(
      'footer',
      { class: 'nb-mm-foot' },
      h(
        'div',
        { class: 'nb-hints' },
        hint([kbd('↑'), kbd('↓')], [gp('DPAD')], 'NAVIGATE'),
        hint([kbd('ENTER', true)], [gp('A')], 'SELECT'),
        hint([kbd('ESC', true)], [gp('B')], 'BACK'),
      ),
      h(
        'div',
        { class: 'nb-mm-device' },
        h('span', { class: 'nb-only-kb' }, icon('keyboard'), ' KEYBOARD & MOUSE'),
        h('span', { class: 'nb-only-gp' }, icon('gamepad'), ' GAMEPAD CONNECTED'),
      ),
      // audio can only start after a user gesture: say so until the first click / key press
      h('div', { class: 'nb-mm-sound', 'aria-hidden': 'true' }, icon('sound'), span('nb-mm-sound-l', 'CLICK OR PRESS ANY KEY FOR SOUND'), span('nb-mm-sound-s', 'TAP FOR SOUND')),
      fs,
      h('div', { class: 'nb-mm-live' }, span('nb-live-dot'), 'LIVE · AI EXHIBITION MATCH'),
    );

    this.el = h(
      'div',
      { class: 'nb-screen nb-main nb-layer' },
      div('nb-main-shade'),
      div('nb-main-scan'),
      h('header', { class: 'nb-main-head' }, logo('xl'), h('div', { class: 'nb-main-tag' }, span('nb-main-tag-line'), GAME_TAGLINE.toUpperCase())),
      list,
      h('div', { class: 'nb-main-side' }, h('div', { class: 'nb-main-side-top' }, pilot, this.walletCard), rules),
      footer,
    );
  }

  override defaultFocus(): HTMLElement | null {
    return this.items[0] ?? null;
  }

  override onShow(): void {
    const s = this.ctx.settings;
    this.pilotName.textContent = s.playerName || 'PLAYER';
    const style = CAR_STYLES.find((c) => c.id === s.carStyle) ?? CAR_STYLES[0];
    const paint = PAINTS.find((p) => p.hex.toLowerCase() === s.paint.toLowerCase());
    this.pilotStyle.textContent = `${style.name} · ${paint ? paint.name.toUpperCase() : 'CUSTOM'}`;
    this.pilotCar.innerHTML = carSvg(style.id, { ground: false });
    this.pilotCar.style.setProperty('--paint', s.paint);
    this.refreshWallet();
  }

  private refreshWallet(): void {
    if (!this.walletCard) return;
    const st = chain.state;
    this.walletBalance.set(st.balance);
    const n = chain.affordable().length;
    this.walletSub.textContent = !st.wallet
      ? 'CONNECTING…'
      : n > 0
        ? `${n} UNLOCK${n === 1 ? '' : 'S'} AVAILABLE IN THE GARAGE`
        : st.balance === 0n && !st.record?.matches
          ? 'PLAY A MATCH TO EARN NOVA · NO GAS NEEDED'
          : `${st.wallet.kind === 'guest' ? 'GUEST WALLET' : st.wallet.label.toUpperCase()} · ${shortAddress(st.wallet.address)}`;
    this.walletCard.classList.toggle('has-unlocks', n > 0);
    this.walletCard.classList.toggle('is-offline', st.status === 'error');
  }
}
