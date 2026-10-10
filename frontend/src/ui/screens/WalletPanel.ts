/** WALLET: connect a browser wallet, NOVA balance, gas (ETH), unclaimed reward, career, NFTs, activity, contracts. */
import {
  addressUrl,
  chain,
  CHAIN,
  CLAIM_GAS,
  DEPLOYMENT,
  formatEth,
  formatNova,
  friendly,
  NETWORK_LABEL,
  shortAddress,
  tokenUrl,
  txUrl,
  walletOptions,
  type Activity,
  type ChainState,
  type WalletOption,
} from '../../chain';
import { Panel, type UIContext } from '../core';
import { div, h, span } from '../dom';
import { copyText, gasEstimate, gasLinks, itemVisual, nftArt, novaAmount, openUrl, timeAgo, walletChoices, walletIcon } from '../chainui';
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
  private readonly unclaimed: HTMLElement;
  private readonly collection: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly contracts: HTMLElement;
  private readonly net: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly explorerBtn: HTMLButtonElement;
  private unsub: (() => void) | null = null;
  private rendered = -1;
  private busy = false;
  /** Last rendered content key per section: sections are only rebuilt when they change (keeps focus while polling). */
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
    this.unclaimed = div('nb-wal-unclaimed');
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
      this.step('01', 'PLAY', 'No wallet needed to play. Every match point is worth NOVA.', 'play'),
      this.step('02', 'CLAIM', `After a match, claim your NOVA with one transaction. Your wallet pays a tiny gas fee in ${NETWORK_LABEL} ETH.`, 'nova'),
      this.step('03', 'OWN', 'Spend NOVA on car bodies and paints: each one is an ERC-1155 NFT, and the NOVA is burned.', 'garage'),
    );

    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-wallet', 'aria-label': 'Wallet' },
      div('nb-panel-bg'),
      panelHeader(ctx, 'WALLET', 'NOVA · NFTS · ON-CHAIN', this.net),
      h(
        'div',
        { class: 'nb-panel-body nb-wallet-body' },
        h('div', { class: 'nb-wal-main' }, hero, this.actions, this.flash, this.unclaimed, how),
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
        span('nb-foot-note', `Testnet demo · gas is paid in ${NETWORK_LABEL} ETH (free from a faucet)`),
        h('div', { class: 'nb-hints' }, hint([kbd('ENTER', true)], [gp('A')], 'SELECT'), hint([kbd('ESC', true)], [gp('B')], 'BACK')),
      ),
    );
  }

  override defaultFocus(): HTMLElement | null {
    return (this.unclaimed.querySelector('[data-nav]') as HTMLElement | null) ?? (this.actions.querySelector('[data-nav]') as HTMLElement | null) ?? this.copyBtn;
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
    this.el.classList.toggle('no-wallet', !w);
    this.kind.replaceChildren(w ? walletIcon(w.icon, 'nb-wal-kind-ico') : icon('wallet', 'nb-wal-kind-ico'), w ? w.label.toUpperCase() : s.restoring ? 'CHECKING WALLET…' : 'NO WALLET CONNECTED');
    this.addr.textContent = w ? shortAddress(w.address) : '';
    this.addr.title = w?.address ?? '';
    this.copyBtn.style.display = w ? '' : 'none';
    this.explorerBtn.style.display = w && addressUrl('0x0') ? '' : 'none';
    this.balance.set(w ? s.balance : null);

    const r = s.record;
    this.career.replaceChildren(
      this.stat(r ? String(r.matches) : '0', 'MATCHES'),
      this.stat(r ? String(r.wins) : '0', 'WINS'),
      this.stat(r ? r.points.toLocaleString('en-US') : '0', 'POINTS'),
      this.stat(r ? formatNova(r.earned) : '0', 'NOVA EARNED'),
    );

    this.renderGas(s);
    this.renderActions(s);
    this.renderUnclaimed(s);
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

  /** Gas money: the wallet's ETH on the game's chain and where to get more. */
  private renderGas(s: Readonly<ChainState>): void {
    const low = !!s.wallet && chain.needsGas(CLAIM_GAS);
    if (!this.changed('gas', `${s.wallet?.address}:${s.eth}:${s.gasPrice}:${low}:${s.status}`)) return;
    const est = gasEstimate(CLAIM_GAS);
    this.gas.className = `nb-wal-gas${low ? ' is-low' : ''}${s.status === 'error' ? ' is-err' : ''}`;
    const text = !s.wallet
      ? `Claims and purchases are transactions from your wallet: it pays the gas in ${NETWORK_LABEL} ETH${est ? ` (${est} each)` : ''}.`
      : low
        ? `Your wallet has ${formatEth(s.eth)} ETH on ${NETWORK_LABEL}. Get some (free) to pay for gas${est ? ` (${est} per claim)` : ''}:`
        : `GAS · ${formatEth(s.eth)} ETH on ${NETWORK_LABEL}${est ? ` · ${est} per claim` : ''}`;
    this.gas.replaceChildren(h('span', { class: 'nb-wal-gas-row' }, icon('gas', 'nb-wal-gas-ico'), span('nb-wal-gas-t', text)));
    if (s.wallet) this.gas.append(h('span', { class: 'nb-wal-gas-links' }, ...gasLinks(this.ctx, () => this.say('10 TEST ETH ADDED', 'ok'))));
    if (s.status === 'error') this.gas.append(span('nb-wal-gas-err', s.error ?? 'RPC unreachable'));
  }

  private renderActions(s: Readonly<ChainState>): void {
    if (!this.changed('actions', `${s.wallet?.address}:${s.restoring}:${walletOptions().map((o) => o.id).join()}`)) return;
    const keep = this.actions.contains(document.activeElement);
    if (s.wallet) {
      this.actions.replaceChildren(button(this.ctx, { label: 'DISCONNECT', icon: 'unplug', variant: 'ghost', onClick: () => this.run(() => chain.disconnect(), 'WALLET DISCONNECTED') }));
    } else {
      this.actions.replaceChildren(
        h('div', { class: 'nb-wal-connect' }, span('nb-wal-connect-k', 'CONNECT A WALLET TO CLAIM NOVA AND OWN NFTS'), walletChoices(this.ctx, (o) => void this.connect(o))),
      );
    }
    if (keep) this.ctx.focus(this.defaultFocus());
  }

  /** The last match's reward, while it waits to be claimed. */
  private renderUnclaimed(s: Readonly<ChainState>): void {
    const m = s.unclaimed;
    const c = s.claim;
    const busy = chain.claimBusy;
    if (!this.changed('unclaimed', `${m?.key}:${c?.status}:${c?.message}:${!!s.wallet}:${s.rewardPerPoint}`)) return;
    if (!m) {
      this.unclaimed.replaceChildren();
      this.unclaimed.style.display = 'none';
      return;
    }
    this.unclaimed.style.display = '';
    const cta = !s.wallet
      ? span('nb-wal-unc-hint', 'Connect a wallet above to claim')
      : button(this.ctx, {
          label: busy ? (c?.status === 'pending' ? 'MINTING…' : 'CONFIRM IN WALLET') : 'CLAIM',
          icon: busy ? 'spinner' : 'nova',
          variant: 'primary',
          cls: busy ? 'is-busy' : '',
          onClick: () => void chain.claimReward(),
        });
    this.unclaimed.replaceChildren(
      h('span', { class: 'nb-wal-unc-coin' }, icon('nova')),
      h(
        'span',
        { class: 'nb-wal-unc-text' },
        span('nb-wal-unc-k', 'UNCLAIMED REWARD'),
        h('span', { class: 'nb-wal-unc-amt' }, `+${formatNova(chain.rewardFor(m.points))}`, span('nb-wal-unc-u', 'NOVA')),
        span('nb-wal-unc-sub', c?.status === 'failed' ? (c.message ?? 'Claim failed').toUpperCase() : `${m.points} PTS · LAST MATCH · ${timeAgo(m.at)}`),
      ),
      cta,
    );
    this.unclaimed.classList.toggle('is-failed', c?.status === 'failed');
  }

  private renderCollection(s: Readonly<ChainState>): void {
    const owned = s.catalog.filter((i) => s.owned.has(i.id));
    if (!this.changed('collection', owned.map((i) => i.id).join())) return;
    if (!owned.length) {
      const garage = button(this.ctx, { label: 'OPEN GARAGE', icon: 'garage', variant: 'ghost', onClick: () => this.ctx.open('garage') });
      this.collection.replaceChildren(h('div', { class: 'nb-wal-empty' }, span('nb-wal-empty-t', 'No NFTs yet. Claim NOVA from your matches, then unlock cars and paints.'), garage));
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
      this.activity.replaceChildren(h('div', { class: 'nb-wal-empty' }, span('nb-wal-empty-t', 'Your claims and purchases will show up here, with links to the explorer.')));
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
      row('NOVA TOKEN', 'ERC-20', d.nova, tokenUrl(d.nova)),
      row('GARAGE', 'ERC-1155 NFTS', d.garage, tokenUrl(d.garage)),
      row('ARENA', 'MATCH REWARDS', d.arena, addressUrl(d.arena)),
    );
  }

  // ------------------------------------------------------------------ actions

  private connect(o: WalletOption): Promise<void> {
    return this.run(() => chain.connect(o), `${o.name.toUpperCase()} CONNECTED`);
  }

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
