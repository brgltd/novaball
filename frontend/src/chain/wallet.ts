/**
 * Wallets: a zero-friction GUEST wallet (a key generated in this browser — no extension, no popups, no gas: the
 * relayer pays) or the player's own EXTERNAL wallet (MetaMask, Rabby, Coinbase... via EIP-6963 discovery).
 * Either way the game only ever asks for EIP-712 signatures; transactions are sponsored.
 */
import {
  createWalletClient,
  custom,
  http,
  numberToHex,
  type EIP1193Provider,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { REPORT_DOMAIN, REPORT_TYPES, SESSION_TYPES, type Address, type Hex, type SessionGrant } from './api';
import { CHAIN, CHAIN_ID, EXPLORER, RPC_URL, WALLET_RPC_URL } from './config';

export type WalletKind = 'guest' | 'external';

export interface NovaWallet {
  readonly kind: WalletKind;
  readonly address: Address;
  /** 'GUEST WALLET' or the extension's name. */
  readonly label: string;
  /** Extension icon (data URI), external wallets only. */
  readonly icon?: string;
  readonly client: WalletClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData(def: TypedDataDefinition<any, any>): Promise<Hex>;
  /** External wallets: make sure the wallet is on our chain (prompts a switch / add). */
  ensureChain(): Promise<void>;
  /** Sign a match report (guest: directly; external: with a session key, granted once by the wallet). */
  signReport(m: ReportMessage): Promise<{ signature: Hex; session?: SessionGrant }>;
  /** External wallets: make sure a reward session is granted (one signature prompt, valid 30 days). */
  ensureSession(): Promise<void>;
}

export interface ReportMessage {
  player: Address;
  seed: bigint;
  stateHash: bigint;
  points: bigint;
}

const REPORT = { domain: { ...REPORT_DOMAIN, chainId: CHAIN_ID }, types: REPORT_TYPES, primaryType: 'MatchReport' } as const;
const SESSION_TTL_S = 30 * 86400;

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

const GUEST_KEY = 'novaball.guestWallet.v1';
const SESSION_KEY = 'novaball.rewardSession.v1';
const MODE_KEY = 'novaball.walletMode.v1';

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the wallet lives for this session only */
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ guest

let sessionGuestKey: Hex | null = null;

function guestKey(): Hex {
  const saved = read(GUEST_KEY);
  if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) return saved as Hex;
  if (!sessionGuestKey) {
    sessionGuestKey = generatePrivateKey();
    store(GUEST_KEY, sessionGuestKey);
  }
  return sessionGuestKey;
}

export function guestWallet(): NovaWallet {
  const account = privateKeyToAccount(guestKey());
  const client = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  return {
    kind: 'guest',
    address: account.address,
    label: 'GUEST WALLET',
    client,
    signTypedData: (def) => account.signTypedData(def),
    ensureChain: async () => {},
    signReport: async (message) => ({ signature: await account.signTypedData({ ...REPORT, message }) }),
    ensureSession: async () => {},
  };
}

/** The guest wallet's private key (to import it into a real wallet). */
export function exportGuestKey(): Hex {
  return guestKey();
}

// ------------------------------------------------------------------ external (EIP-6963 + window.ethereum)

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const discovered = new Map<string, WalletOption>();
let discoveryStarted = false;

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
  const list = [...discovered.values()];
  const legacy = (window as unknown as { ethereum?: EIP1193Provider & { isMetaMask?: boolean } }).ethereum;
  if (!list.length && legacy) list.push({ id: 'injected', name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: legacy });
  return list;
}

startDiscovery();

interface ProviderError {
  code?: number;
  message?: string;
}

async function ensureProviderChain(provider: EIP1193Provider): Promise<void> {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === CHAIN_ID) return;
  const chainId = numberToHex(CHAIN_ID);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    const code = (err as ProviderError).code ?? (err as { data?: { originalError?: ProviderError } }).data?.originalError?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test((err as ProviderError).message ?? '')) throw err;
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
  }
}

interface StoredSession {
  pk: Hex;
  key: Address;
  expires: number;
  signature: Hex;
}

function externalWallet(opt: WalletOption, address: Address): NovaWallet {
  const client = createWalletClient({ account: address, chain: CHAIN, transport: custom(opt.provider) });
  const ensureChain = () => ensureProviderChain(opt.provider);
  const storeKey = `${SESSION_KEY}:${CHAIN_ID}:${address.toLowerCase()}`;
  const loadSession = (): StoredSession | null => {
    try {
      const s = JSON.parse(read(storeKey) ?? 'null') as StoredSession | null;
      return s && s.expires - 86400 > Date.now() / 1000 ? s : null;
    } catch {
      return null;
    }
  };
  const ensureSession = async (): Promise<StoredSession> => {
    const cur = loadSession();
    if (cur) return cur;
    const pk = generatePrivateKey();
    const key = privateKeyToAccount(pk).address;
    const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
    await ensureChain();
    const signature = await client.signTypedData({
      account: address,
      domain: { ...REPORT_DOMAIN, chainId: CHAIN_ID },
      types: SESSION_TYPES,
      primaryType: 'Session',
      message: { player: address, sessionKey: key, expires: BigInt(expires) },
    });
    const s: StoredSession = { pk, key, expires, signature };
    store(storeKey, JSON.stringify(s));
    return s;
  };
  return {
    kind: 'external',
    address,
    label: opt.name,
    icon: opt.icon,
    client,
    ensureChain,
    signTypedData: async (def) => {
      await ensureChain();
      return client.signTypedData({ account: address, ...def });
    },
    ensureSession: async () => void (await ensureSession()),
    signReport: async (message) => {
      const s = await ensureSession();
      const signature = await privateKeyToAccount(s.pk).signTypedData({ ...REPORT, message });
      return { signature, session: { key: s.key, expires: s.expires, signature: s.signature } };
    },
  };
}

/** Prompt the wallet to connect (user gesture). */
export async function connectExternal(opt: WalletOption): Promise<NovaWallet> {
  const accounts = (await opt.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!accounts?.length) throw new Error('No account was shared');
  await ensureProviderChain(opt.provider).catch(() => undefined);
  store(MODE_KEY, `external:${opt.id}`);
  return externalWallet(opt, accounts[0]);
}

/** The wallet used last time, without any prompt (an external wallet only if it is still connected). */
export async function restoreWallet(): Promise<NovaWallet> {
  const mode = read(MODE_KEY);
  if (mode?.startsWith('external:')) {
    const id = mode.slice('external:'.length);
    // EIP-6963 announcements are synchronous to the request event, but give slow extensions a beat
    for (let i = 0; i < 3 && !walletOptions().some((o) => o.id === id); i++) await new Promise((r) => setTimeout(r, 150));
    const opt = walletOptions().find((o) => o.id === id);
    if (opt) {
      try {
        const accounts = (await opt.provider.request({ method: 'eth_accounts' })) as Address[];
        if (accounts?.length) return externalWallet(opt, accounts[0]);
      } catch {
        /* fall back to the guest wallet */
      }
    }
  }
  return guestWallet();
}

export function rememberGuest(): void {
  store(MODE_KEY, 'guest');
}

/** Subscribe to an external wallet's account switches / disconnects. */
export function watchExternal(opt: WalletOption | undefined, onAccounts: (a: Address[]) => void): () => void {
  const p = opt?.provider;
  if (!p?.on) return () => {};
  const fn = (a: unknown) => onAccounts((a as Address[]) ?? []);
  p.on('accountsChanged', fn as never);
  return () => p.removeListener?.('accountsChanged', fn as never);
}

export function optionFor(wallet: NovaWallet): WalletOption | undefined {
  return wallet.kind === 'external' ? walletOptions().find((o) => o.name === wallet.label) : undefined;
}
