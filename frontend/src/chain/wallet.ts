/**
 * The player's own browser wallet (MetaMask, Brave Wallet, Phantom, Rabby, Coinbase...), discovered via EIP-6963
 * with a `window.ethereum` fallback. The player sends their own transactions (reward claims, purchases) and pays
 * the gas in ETH on the game's chain.
 */
import { createWalletClient, custom, numberToHex, type EIP1193Provider, type WalletClient } from 'viem';

import type { Address } from './types';
import { CHAIN, CHAIN_ID, EXPLORER, NETWORK_LABEL, WALLET_RPC_URL } from './config';

export interface NovaWallet {
  readonly address: Address;
  /** The extension's name ("MetaMask"). */
  readonly label: string;
  /** Extension icon (data URI), when it announced one. */
  readonly icon?: string;
  readonly option: WalletOption;
  readonly client: WalletClient;
  /** Make sure the wallet is on the game's chain (prompts a switch, or adding the network). */
  ensureChain(): Promise<void>;
}

export interface WalletOption {
  /** EIP-6963 rdns (`io.metamask`) or 'injected'. */
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

/** Wallets we point players to when none is installed. */
export const SUGGESTED_WALLETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Brave Wallet', url: 'https://brave.com/wallet/' },
  { name: 'Phantom', url: 'https://phantom.com/download' },
];

const MODE_KEY = 'novaball.wallet.v2';

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: reconnect next visit */
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ discovery (EIP-6963 + window.ethereum)

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const discovered = new Map<string, WalletOption>();
let discoveryStarted = false;

/** Listing order of the known wallets (EIP-6963 rdns); any other wallet follows, in announcement order. */
const WALLET_ORDER = ['io.metamask', 'com.brave.wallet', 'app.phantom'];

function walletRank(id: string): number {
  const i = WALLET_ORDER.indexOf(id);
  return i < 0 ? WALLET_ORDER.length : i;
}

function startDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = (e as CustomEvent<Eip6963Detail>).detail;
    if (d?.info?.rdns && d.provider) discovered.set(d.info.rdns, { id: d.info.rdns, name: d.info.name, icon: d.info.icon, provider: d.provider });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Installed browser wallets. */
export function walletOptions(): WalletOption[] {
  startDiscovery();
  const list = [...discovered.values()].sort((a, b) => walletRank(a.id) - walletRank(b.id));
  const legacy = (window as unknown as { ethereum?: EIP1193Provider & { isMetaMask?: boolean; isBraveWallet?: boolean; isPhantom?: boolean } }).ethereum;
  if (!list.length && legacy) {
    const name = legacy.isBraveWallet ? 'Brave Wallet' : legacy.isPhantom ? 'Phantom' : legacy.isMetaMask ? 'MetaMask' : 'Browser wallet';
    list.push({ id: 'injected', name, provider: legacy });
  }
  return list;
}

startDiscovery();

// ------------------------------------------------------------------ chain

interface ProviderError {
  code?: number;
  message?: string;
}

function errorCode(err: unknown): number | undefined {
  return (err as ProviderError).code ?? (err as { data?: { originalError?: ProviderError } }).data?.originalError?.code;
}

/** Switch the wallet to the game's chain, adding the network first if the wallet doesn't know it. */
async function ensureProviderChain(opt: WalletOption): Promise<void> {
  const provider = opt.provider;
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === CHAIN_ID) return;
  const chainId = numberToHex(CHAIN_ID);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    return;
  } catch (err) {
    if (errorCode(err) === 4001) throw err; // the player said no
    const unknown = errorCode(err) === 4902 || /unrecognized|not added|unknown chain|not supported/i.test((err as ProviderError).message ?? '');
    if (!unknown) throw chainError(opt, err);
  }
  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: CHAIN.name,
          nativeCurrency: CHAIN.nativeCurrency,
          rpcUrls: [WALLET_RPC_URL],
          blockExplorerUrls: EXPLORER ? [EXPLORER] : undefined,
        },
      ],
    });
  } catch (err) {
    if (errorCode(err) === 4001) throw err;
    throw chainError(opt, err);
  }
  // some wallets add the network without switching to it
  if (Number(await provider.request({ method: 'eth_chainId' })) !== CHAIN_ID) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }).catch((err) => {
      throw chainError(opt, err);
    });
  }
}

function chainError(opt: WalletOption, cause: unknown): Error {
  console.warn('[wallet] chain switch failed', cause);
  return new Error(`${opt.name} couldn't switch to ${NETWORK_LABEL}. Add the network in your wallet, or try MetaMask or Brave Wallet.`);
}

// ------------------------------------------------------------------ connect / restore

function makeWallet(opt: WalletOption, address: Address): NovaWallet {
  return {
    address,
    label: opt.name,
    icon: opt.icon,
    option: opt,
    client: createWalletClient({ account: address, chain: CHAIN, transport: custom(opt.provider) }),
    ensureChain: () => ensureProviderChain(opt),
  };
}

/** Ask the wallet to connect (needs a user gesture), then to switch to the game's chain. */
export async function connectWallet(opt: WalletOption): Promise<NovaWallet> {
  const accounts = (await opt.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!accounts?.length) throw new Error('No account was shared');
  store(MODE_KEY, opt.id);
  const w = makeWallet(opt, accounts[0]);
  // switching networks right away keeps balances in the wallet's UI consistent; a refusal is fine until a transaction
  await w.ensureChain().catch((err) => console.warn('[wallet] not switched yet', err));
  return w;
}

/** The wallet connected last time, without any prompt (if it still shares an account with the game). */
export async function restoreWallet(): Promise<NovaWallet | null> {
  const id = read(MODE_KEY);
  if (!id) return null;
  // EIP-6963 announcements answer the request event synchronously, but give slow extensions a beat
  for (let i = 0; i < 3 && !walletOptions().some((o) => o.id === id); i++) await new Promise((r) => setTimeout(r, 150));
  const opt = walletOptions().find((o) => o.id === id);
  if (!opt) return null;
  try {
    const accounts = (await opt.provider.request({ method: 'eth_accounts' })) as Address[];
    return accounts?.length ? makeWallet(opt, accounts[0]) : null;
  } catch {
    return null;
  }
}

/** Forget the connection (and, where supported, revoke the site's permission in the wallet). */
export async function disconnectWallet(w: NovaWallet | null): Promise<void> {
  store(MODE_KEY, null);
  if (!w) return;
  await w.option.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] } as never).catch(() => undefined);
}

/** Subscribe to the wallet's account switches / disconnects. */
export function watchWallet(w: NovaWallet, onAccounts: (a: Address[]) => void): () => void {
  const p = w.option.provider;
  if (!p?.on) return () => {};
  const fn = (a: unknown) => onAccounts((a as Address[]) ?? []);
  p.on('accountsChanged', fn as never);
  return () => p.removeListener?.('accountsChanged', fn as never);
}
