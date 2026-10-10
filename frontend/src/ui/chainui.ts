/** Small UI pieces shared by the on-chain screens (wallet card, wallet panel, garage shop, end-screen claim). */
import { chain, formatEth, formatNova, GAS_SOURCES, hexColor, IS_LOCAL, SUGGESTED_WALLETS, walletOptions, type CatalogItem, type WalletOption } from '../chain';
import { CAR_STYLES, PAINTS } from '../theme';
import type { CarStyleId } from '../sim/types';
import type { UIContext } from './core';
import { h, setText, span, textNode } from './dom';
import { carSvg } from './icons';
import { icon } from './widgets';

/** "◈ 212.5 NOVA" with an updatable value. */
export function novaAmount(cls = ''): { el: HTMLElement; set(wei: bigint | null, sign?: boolean): void } {
  const value = textNode('—');
  const el = h('span', { class: `nb-nova ${cls}` }, icon('nova', 'nb-nova-ico'), span('nb-nova-v', value), span('nb-nova-u', 'NOVA'));
  return {
    el,
    set(wei, sign = false) {
      setText(value, wei === null ? '—' : `${sign && wei > 0n ? '+' : ''}${formatNova(wei)}`);
    },
  };
}

export function openUrl(url: string | null): void {
  if (!url) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* popup blocked */
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago". */
export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'JUST NOW';
  if (s < 3600) return `${Math.round(s / 60)} MIN AGO`;
  if (s < 86400) return `${Math.round(s / 3600)} H AGO`;
  return `${Math.round(s / 86400)} D AGO`;
}

/** Garage display data for a catalog item (falls back to the on-chain name / color). */
export function itemVisual(it: CatalogItem): { name: string; paint: string; style: CarStyleId | null } {
  if (it.kind === 'car') {
    const cs = CAR_STYLES.find((c) => c.id === it.key);
    return { name: cs?.name ?? it.name, paint: '#b9c3cf', style: cs?.id ?? null };
  }
  const p = PAINTS.find((x) => x.name.toLowerCase() === it.key);
  return { name: (p?.name ?? it.name).toUpperCase(), paint: p?.hex ?? hexColor(it.color), style: null };
}

/** A mini NFT tile: car silhouette (cars) or a painted STRIKER (paints). */
export function nftArt(it: CatalogItem): HTMLElement {
  const v = itemVisual(it);
  const art = h('span', { class: `nb-nft-art is-${it.kind}` });
  art.innerHTML = carSvg(v.style ?? 'striker', { ground: false });
  art.style.setProperty('--paint', v.paint);
  return art;
}

/** Paint preset key (lowercase name) for a body color, or null for a custom color. */
export function paintKey(hex: string): string | null {
  const p = PAINTS.find((x) => x.hex.toLowerCase() === hex.toLowerCase());
  return p ? p.name.toLowerCase() : null;
}

export const STARTER_PAINT_HEX = PAINTS[0].hex;

/** The garage setup restricted to what the player owns (locked style / paint → the starter kit). */
export function ownedSetup(style: CarStyleId, paint: string): { style: CarStyleId; paint: string } {
  const key = paintKey(paint);
  return {
    style: chain.unlocked('car', style) ? style : 'striker',
    paint: key && chain.unlocked('paint', key) ? paint : STARTER_PAINT_HEX,
  };
}

// ------------------------------------------------------------------ wallets + gas

/** A wallet's icon (its own when announced, a generic one otherwise). */
export function walletIcon(src: string | undefined, cls = 'nb-wopt-ico'): HTMLElement {
  return src ? h('img', { class: cls, src, alt: '' }) : icon('wallet', cls);
}

/**
 * The player's way in: one button per installed wallet (MetaMask, Brave, Phantom...), or install links when there
 * is none. `onPick` runs after a successful connection.
 */
export function walletChoices(ctx: UIContext, onPick: (opt: WalletOption) => void, cls = ''): HTMLElement {
  const opts = walletOptions();
  const box = h('div', { class: `nb-wopts ${cls}` });
  if (opts.length) {
    for (const o of opts.slice(0, 4)) {
      const b = h('button', { class: 'nb-wopt', type: 'button', 'data-nav': '' }, walletIcon(o.icon), span('nb-wopt-name', o.name.toUpperCase()), icon('chevron', 'nb-wopt-go'));
      b.addEventListener('click', () => {
        ctx.sound('click');
        onPick(o);
      });
      box.append(b);
    }
    return box;
  }
  box.append(span('nb-wopts-none', 'No browser wallet found. Install one, then reload:'));
  for (const s of SUGGESTED_WALLETS) {
    const b = h('button', { class: 'nb-wopt is-install', type: 'button', 'data-nav': '' }, icon('wallet', 'nb-wopt-ico'), span('nb-wopt-name', s.name.toUpperCase()), icon('external', 'nb-wopt-go'));
    b.addEventListener('click', () => {
      ctx.sound('click');
      openUrl(s.url);
    });
    box.append(b);
  }
  return box;
}

/** Where to get gas ETH: faucet / bridge links, or a one-click top-up on the local chain. */
export function gasLinks(ctx: UIContext, onFaucet?: () => void): HTMLElement[] {
  if (IS_LOCAL) {
    const b = h('button', { class: 'nb-link', type: 'button', 'data-nav': '' }, icon('gas'), 'GET 10 TEST ETH');
    b.addEventListener('click', () => {
      ctx.sound('click');
      void chain.devFaucet().then(() => onFaucet?.());
    });
    return [b];
  }
  return GAS_SOURCES.map((g) => {
    const b = h('button', { class: 'nb-link', type: 'button', 'data-nav': '' }, g.name.toUpperCase(), icon('external'));
    b.addEventListener('click', () => {
      ctx.sound('click');
      openUrl(g.url);
    });
    return b;
  });
}

/** "~0.000026 ETH" for a transaction of `gas` units (null when the gas price is unknown). */
export function gasEstimate(gas: bigint): string | null {
  const c = chain.gasCost(gas);
  return c === null ? null : `~${formatEth(c)} ETH`;
}
