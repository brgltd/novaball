/** WALLET: NOVA balance, wallet identity (guest / external), career, NFT collection, on-chain activity, contracts. */
import {
  addressUrl,
  chain,
  CHAIN,
  DEPLOYMENT,
  exportGuestKey,
  formatNova,
  friendly,
  NETWORK_LABEL,
  shortAddress,
  tokenUrl,
  txUrl,
  walletOptions,
  type Activity,
  type ChainState,
} from '../../chain';
import { Panel, type UIContext } from '../core';
import { div, h, span } from '../dom';
import { copyText, itemVisual, nftArt, novaAmount, openUrl, timeAgo } from '../chainui';
import { button, gp, hint, icon, kbd, sectionTitle } from '../widgets';
import { panelHeader } from './common';

export class WalletPanel extends Panel {
  readonly el: HTMLElement;
  private readonly balance = novaAmount('nb-wal-balance');
  private readonly kind: HTMLElement;
  private readonly addr: HTMLElement;
  private readonly career: HTMLElement;
  private readonly gas: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly collection: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly contracts: HTMLElement;
  private readonly net: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly explorerBtn: HTMLButtonElement;
  private unsub: (() => void) | null = null;
  private rendered = -1;
  private busy = false;
  /** Last rendered content key per list: lists are only rebuilt when they change (keeps focus while polling). */
  private readonly sig = new Map<string, string>();

  constructor(private readonly ctx: UIContext) {
    super();
    this.kind = span('nb-wal-kind');
    this.addr = span('nb-wal-addr');
    this.copyBtn = this.iconButton('copy', 'Copy address', () => {
      const a = chain.state.wallet?.address;
      if (a) void copyText(a).then((ok) => this.say(ok ? 'ADDRESS COPIED' : 'COPY FAILED'));
    });
    this.explorerBtn = this.iconButton('external', 'View on explorer', () => openUrl(addressUrl(chain.state.wallet?.address ?? '')));
    this.career = div('nb-wal-career');
    this.gas = div('nb-wal-gas');
    this.actions = div('nb-wal-actions');
    this.flash = div('nb-wal-flash');
    this.collection = div('nb-wal-collection');
    this.activity = div('nb-wal-activity');
    this.contracts = div('nb-wal-contracts');
    this.net = h('span', { class: 'nb-net-badge' }, span('nb-net-dot'), NETWORK_LABEL);

    const hero = h(
      'div',
      { class: 'nb-wal-hero' },
      div('nb-wal-hero-glow'),
      h('div', { class: 'nb-wal-id' }, this.kind, this.addr, this.copyBtn, this.explorerBtn),
      h('div', { class: 'nb-wal-balance-k' }, 'NOVA BALANCE'),
      this.balance.el,
      this.career,
      this.gas,
    );

    const how = h(
      'div',
      { class: 'nb-wal-how' },
      this.step('01', 'PLAY', 'Every match point mints NOVA to your wallet — the relayer records the match on-chain.', 'play'),
      this.step('02', 'OWN', 'Spend NOVA on car bodies and paints. Each one is an ERC-1155 NFT; the NOVA is burned.', 'nova'),
      this.step('03', 'DRIVE', 'Owned cosmetics unlock in the garage. Zero gas, zero popups with the guest wallet.', 'garage'),
    );

    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-wallet', 'aria-label': 'Wallet' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'WALLET', 'NOVA · NFTS · ON-CHAIN', this.net),
      h(
        'div',
        { class: 'nb-panel-body nb-wallet-body' },
        h('div', { class: 'nb-wal-main' }, hero, this.actions, this.flash, how),
        h(
          'div',
          { class: 'nb-wal-side' },
          sectionTitle('COLLECTION'),
          this.collection,
          sectionTitle('ACTIVITY'),
          this.activity,
          sectionTitle('CONTRACTS', h('span', { class: 'nb-section-aside' }, CHAIN.name.toUpperCase())),
          this.contracts,
        ),
      ),
      h(
        'footer',
        { class: 'nb-panel-foot' },
        span('nb-foot-note', 'Testnet demo · the guest wallet key is stored in this browser'),
        h('div', { class: 'nb-hints' }, hint([kbd('ENTER', true)], [gp('A')], 'SELECT'), hint([kbd('ESC', true)], [gp('B')], 'BACK')),
      ),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return (this.actions.querySelector('[data-nav]') as HTMLElement | null) ?? this.copyBtn;
  }

  override onShow(): void {
    this.unsub ??= chain.subscribe(() => this.render());
    this.rendered = -1;
    this.sig.clear();
    this.render();
    void chain.refresh();
  }

  override onHide(): void {
    this.unsub?.();
    this.unsub = null;
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    const s = chain.state;
    if (this.rendered === s.version) return;
    this.rendered = s.version;
    const w = s.wallet;
    this.el.classList.toggle('is-off', !s.enabled);
    this.kind.replaceChildren(w?.icon ? h('img', { class: 'nb-wal-kind-ico', src: w.icon, alt: '' }) : icon(w?.kind === 'external' ? 'wallet' : 'pilot', 'nb-wal-kind-ico'), w?.label ?? 'NO WALLET');
    this.addr.textContent = w ? shortAddress(w.address) : '—';
    this.addr.title = w?.address ?? '';
    this.explorerBtn.style.display = addressUrl('0x0') ? '' : 'none';
    this.balance.set(s.balance);

    const r = s.record;
    this.career.replaceChildren(
      this.stat(r ? String(r.matches) : '0', 'MATCHES'),
      this.stat(r ? String(r.wins) : '0', 'WINS'),
      this.stat(r ? r.points.toLocaleString('en-US') : '0', 'POINTS'),
      this.stat(r ? formatNova(r.earned) : '0', 'NOVA EARNED'),
    );

    const relayer = s.relayer;
    this.gas.className = `nb-wal-gas is-${relayer}`;
    this.gas.replaceChildren(
      span('nb-wal-gas-dot'),
      relayer === 'offline' ? 'GAS RELAYER OFFLINE — rewards paused' : `GAS SPONSORED BY THE NOVABALL RELAYER${relayer === 'online' ? '' : ' · CONNECTING…'}`,
    );
    if (s.status === 'error') this.gas.append(span('nb-wal-gas-err', ` · ${s.error ?? 'RPC unreachable'}`));

    this.renderActions(s);
    this.renderCollection(s);
    this.renderActivity(s.activity);
    this.renderContracts();
  }

  /** True when `key` differs from the last render of `name`. */
  private changed(name: string, key: string): boolean {
    if (this.sig.get(name) === key) return false;
    this.sig.set(name, key);
    return true;
  }

  private renderActions(s: Readonly<ChainState>): void {
    if (!this.changed('actions', `${s.wallet?.kind}:${s.wallet?.address}:${walletOptions().map((o) => o.id).join()}`)) return;
    const keep = this.actions.contains(document.activeElement);
    const btns: HTMLElement[] = [];
    if (s.wallet?.kind === 'external') {
      btns.push(button(this.ctx, { label: 'USE GUEST WALLET', icon: 'pilot', onClick: () => this.run(() => chain.useGuest(), 'SWITCHED TO THE GUEST WALLET') }));
    } else {
      const opts = walletOptions().slice(0, 2);
      for (const o of opts) {
        btns.push(button(this.ctx, { label: `CONNECT ${o.name.toUpperCase()}`, icon: 'wallet', variant: 'primary', onClick: () => this.run(() => chain.connect(o), `${o.name.toUpperCase()} CONNECTED`) }));
      }
      if (!opts.length) btns.push(h('div', { class: 'nb-wal-hint' }, icon('info'), 'No browser wallet detected — the guest wallet works everywhere, no setup needed.'));
      btns.push(button(this.ctx, { label: 'EXPORT KEY', icon: 'key', variant: 'ghost', onClick: () => this.exportKey() }));
    }
    this.actions.replaceChildren(...btns);
    if (keep) this.ctx.focus(this.defaultFocus());
  }

  private renderCollection(s: Readonly<ChainState>): void {
    const owned = s.catalog.filter((i) => s.owned.has(i.id));
    if (!this.changed('collection', owned.map((i) => i.id).join())) return;
    if (!owned.length) {
      const garage = button(this.ctx, { label: 'OPEN GARAGE', icon: 'garage', variant: 'ghost', onClick: () => this.ctx.open('garage') });
      this.collection.replaceChildren(h('div', { class: 'nb-wal-empty' }, span('nb-wal-empty-t', 'No NFTs yet. Win NOVA on the pitch, then unlock cars and paints.'), garage));
      return;
    }
    this.collection.replaceChildren(
      ...owned.map((it) => {
        const v = itemVisual(it);
        const b = h('button', { class: 'nb-nft', type: 'button', 'data-nav': '', title: 'View NFT' }, nftArt(it), span('nb-nft-name', v.name), span('nb-nft-id', `${it.kind === 'car' ? 'CAR' : 'PAINT'} · #${it.id}`));
        b.addEventListener('click', () => {
          this.ctx.sound('click');
          openUrl(DEPLOYMENT ? tokenUrl(DEPLOYMENT.garage, it.id) : null);
        });
        return b;
      }),
    );
  }

  private renderActivity(list: Activity[]): void {
    if (!this.changed('activity', list.map((a) => a.id + a.status).join() + timeAgo(list[0]?.at ?? 0))) return;
    if (!list.length) {
      this.activity.replaceChildren(h('div', { class: 'nb-wal-empty' }, span('nb-wal-empty-t', 'Finish a match to see your first on-chain reward here.')));
      return;
    }
    this.activity.replaceChildren(
      ...list.slice(0, 6).map((a) => {
        const amt = BigInt(a.amount);
        const row = h(
          'button',
          { class: `nb-act is-${a.kind} is-${a.status}`, type: 'button', 'data-nav': '', title: 'View transaction' },
          h('span', { class: 'nb-act-ico' }, icon(a.kind === 'reward' ? 'trophy' : 'garage')),
          h('span', { class: 'nb-act-text' }, span('nb-act-title', a.title), span('nb-act-sub', `${a.status === 'pending' ? 'PENDING' : a.status === 'failed' ? 'FAILED' : 'CONFIRMED'} · ${timeAgo(a.at)} · ${shortAddress(a.hash)}`)),
          span(`nb-act-amt${amt < 0n ? ' is-neg' : ''}`, `${amt > 0n ? '+' : ''}${formatNova(amt)}`),
          a.status === 'pending' ? icon('spinner', 'nb-act-state nb-spin') : icon('external', 'nb-act-state'),
        );
        row.addEventListener('click', () => {
          this.ctx.sound('click');
          openUrl(txUrl(a.hash));
        });
        return row;
      }),
    );
  }

  private renderContracts(): void {
    if (this.contracts.childElementCount || !DEPLOYMENT) return;
    const d = DEPLOYMENT;
    const row = (name: string, std: string, address: string, url: string | null) => {
      const b = h('button', { class: 'nb-contract', type: 'button', 'data-nav': '', title: address }, span('nb-contract-name', name), span('nb-contract-std', std), span('nb-contract-addr', shortAddress(address)), icon(url ? 'external' : 'copy', 'nb-contract-go'));
      b.addEventListener('click', () => {
        this.ctx.sound('click');
        if (url) openUrl(url);
        else void copyText(address).then((ok) => ok && this.say('ADDRESS COPIED'));
      });
      return b;
    };
    this.contracts.replaceChildren(
      row('NOVA TOKEN', 'ERC-20 + PERMIT', d.nova, tokenUrl(d.nova)),
      row('GARAGE', 'ERC-1155 NFTS', d.garage, tokenUrl(d.garage)),
      row('ARENA', 'MATCH REWARDS', d.arena, addressUrl(d.arena)),
    );
  }

  // ------------------------------------------------------------------ actions

  private async run(fn: () => Promise<void>, done: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('WAITING FOR YOUR WALLET…', 'busy');
    try {
      await fn();
      this.say(done, 'ok');
    } catch (err) {
      this.ctx.sound('error');
      this.say(friendly(err).toUpperCase(), 'err');
    } finally {
      this.busy = false;
    }
  }

  private exportKey(): void {
    this.ctx.confirm(
      {
        title: 'EXPORT GUEST KEY?',
        body: 'The private key will be copied to your clipboard. Import it into MetaMask to see your NOVA and NFTs there. Anyone holding it controls this testnet wallet.',
        confirmLabel: 'COPY KEY',
      },
      () => void copyText(exportGuestKey()).then((ok) => this.say(ok ? 'PRIVATE KEY COPIED TO CLIPBOARD' : 'COPY FAILED', ok ? 'ok' : 'err')),
    );
  }

  private say(text: string, tone: 'ok' | 'err' | 'busy' = 'ok'): void {
    this.flash.className = `nb-wal-flash is-on is-${tone}`;
    this.flash.textContent = text;
    window.clearTimeout((this.flash as unknown as { _t?: number })._t);
    if (tone !== 'busy') (this.flash as unknown as { _t?: number })._t = window.setTimeout(() => this.flash.classList.remove('is-on'), 3200);
  }

  // ------------------------------------------------------------------ bits

  private iconButton(name: 'copy' | 'external', label: string, fn: () => void): HTMLButtonElement {
    const b = h('button', { class: 'nb-icon-btn', type: 'button', 'data-nav': '', 'aria-label': label, title: label }, icon(name));
    b.addEventListener('click', () => {
      this.ctx.sound('click');
      fn();
    });
    return b;
  }

  private stat(v: string, l: string): HTMLElement {
    return h('span', { class: 'nb-wal-stat' }, span('nb-wal-stat-v', v), span('nb-wal-stat-l', l));
  }

  private step(n: string, title: string, text: string, ico: 'play' | 'nova' | 'garage'): HTMLElement {
    return h('div', { class: 'nb-wal-step' }, span('nb-wal-step-n', n), h('span', { class: 'nb-wal-step-ico' }, icon(ico)), h('span', { class: 'nb-wal-step-text' }, span('nb-wal-step-t', title), span('nb-wal-step-d', text)));
  }
}
