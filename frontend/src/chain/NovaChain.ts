/**
 * NovaChain — the game's single on-chain service + observable store (no framework).
 *
 *   earn:  end of a match → reportMatch() → relayer records it on NovaArena → NOVA is minted to the player
 *   own:   garage → buy() → player signs (EIP-712 purchase + ERC-2612 permit) → relayer submits → NFT minted
 *   drive: unlocked() gates garage cosmetics by NFT ownership (STRIKER + ARCTIC are free)
 *
 * Everything degrades gracefully: no deployment → features off and everything unlocked; RPC down → cached state;
 * relayer down → external wallets with ETH buy directly, rewards say "offline".
 */
import { createPublicClient, http, parseSignature, type PublicClient } from 'viem';

import type { MatchSummary } from '../contracts';
import { novaArenaAbi, novaGarageAbi, novaTokenAbi } from './abi';
import type { Address, Hex, MatchReceipt, MatchReport, PermitPayload, PurchaseRequest, RelayError, RelayStatus, TxReceiptRef } from './api';
import { CHAIN, CHAIN_ID, DEPLOYMENT, RELAYER_URL, RPC_URL } from './config';
import {
  connectExternal,
  guestWallet,
  optionFor,
  rememberGuest,
  restoreWallet,
  watchExternal,
  type NovaWallet,
  type WalletOption,
} from './wallet';

export type CosmeticKind = 'car' | 'paint';

/** The free starter kit (not NFTs). */
export const STARTER: Readonly<Record<CosmeticKind, string>> = { car: 'striker', paint: 'arctic' };

export interface CatalogItem {
  id: number;
  kind: CosmeticKind;
  key: string;
  name: string;
  /** 0xRRGGBB */
  color: number;
  price: bigint;
  listed: boolean;
}

export interface Activity {
  id: string;
  kind: 'reward' | 'purchase';
  title: string;
  /** Signed NOVA delta, wei. */
  amount: string;
  hash: Hex;
  at: number;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface PlayerRecord {
  matches: number;
  wins: number;
  points: number;
  earned: bigint;
}

export type RewardStatus = 'sending' | 'pending' | 'confirmed' | 'cooldown' | 'offline' | 'failed';

export interface RewardState {
  key: string;
  status: RewardStatus;
  points: number;
  amount: bigint;
  hash?: Hex;
  message?: string;
  retryAt?: number;
}

export type PurchaseStatus = 'signing' | 'sending' | 'pending' | 'done' | 'error';

export interface PurchaseState {
  itemId: number;
  status: PurchaseStatus;
  message?: string;
  hash?: Hex;
}

export interface ChainState {
  /** A deployment exists for the configured chain. */
  readonly enabled: boolean;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  wallet: NovaWallet | null;
  balance: bigint | null;
  catalog: CatalogItem[];
  owned: Set<number>;
  /** NOVA wei per match point, max rewarded points per match. */
  rewardPerPoint: bigint;
  maxPoints: number;
  relayer: 'unknown' | 'online' | 'offline';
  relayerBalance: bigint | null;
  activity: Activity[];
  record: PlayerRecord | null;
  reward: RewardState | null;
  purchases: Map<number, PurchaseState>;
  /** Bumped on every change. */
  version: number;
}

type Listener = (s: Readonly<ChainState>) => void;

interface Cache {
  owned: number[];
  balance: string | null;
  activity: Activity[];
  catalog: Array<Omit<CatalogItem, 'price'> & { price: string }>;
}

const POLL_MS = 15_000;
const SIGNATURE_TTL_S = 30 * 60;

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: RelayError,
  ) {
    super(body.message);
  }
}

export class NovaChain {
  readonly state: ChainState = {
    enabled: DEPLOYMENT !== null,
    status: 'loading',
    wallet: null,
    balance: null,
    catalog: [],
    owned: new Set(),
    rewardPerPoint: 0n,
    maxPoints: 0,
    relayer: 'unknown',
    relayerBalance: null,
    activity: [],
    record: null,
    reward: null,
    purchases: new Map(),
    version: 0,
  };

  private readonly listeners = new Set<Listener>();
  private readonly pub: PublicClient | null = DEPLOYMENT ? createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { retryCount: 1 }) }) : null;
  private started = false;
  private pollTimer = 0;
  private unwatch: () => void = () => {};
  private refreshing: Promise<void> | null = null;
  private readonly reported = new Set<string>();

  // ============================================================================ store

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.state.version++;
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('[chain] listener failed', err);
      }
    }
  }

  // ============================================================================ lifecycle

  /** Restore the wallet and load on-chain state (idempotent). */
  async start(): Promise<void> {
    if (this.started || !DEPLOYMENT) {
      if (!DEPLOYMENT) {
        this.state.status = 'ready';
        this.emit();
      }
      return;
    }
    this.started = true;
    await this.setWallet(await restoreWallet().catch(() => guestWallet()));
    void this.checkRelayer();
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
  }

  private async setWallet(w: NovaWallet): Promise<void> {
    this.unwatch();
    this.state.wallet = w;
    this.state.balance = null;
    this.state.owned = new Set();
    this.state.activity = [];
    this.state.record = null;
    this.loadCache();
    this.emit();
    if (w.kind === 'external') {
      this.unwatch = watchExternal(optionFor(w), (accounts) => {
        if (!accounts.length) void this.useGuest();
        else if (accounts[0].toLowerCase() !== this.state.wallet?.address.toLowerCase()) void this.reconnect();
      });
    } else this.unwatch = () => {};
    await this.refresh();
  }

  private async reconnect(): Promise<void> {
    await this.setWallet(await restoreWallet());
  }

  async connect(opt: WalletOption): Promise<void> {
    await this.setWallet(await connectExternal(opt));
  }

  async useGuest(): Promise<void> {
    rememberGuest();
    await this.setWallet(guestWallet());
  }

  // ============================================================================ reads

  /** Reload balance, catalog, inventory and the player's record (coalesced). */
  refresh(): Promise<void> {
    if (!this.pub || !DEPLOYMENT || !this.state.wallet) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const pub = this.pub;
    const d = DEPLOYMENT;
    const who = this.state.wallet.address;
    this.refreshing = (async () => {
      try {
        const [catalog, inventory, balance, rewardPerPoint, maxPoints, record] = await Promise.all([
          pub.readContract({ address: d.garage, abi: novaGarageAbi, functionName: 'catalog' }),
          pub.readContract({ address: d.garage, abi: novaGarageAbi, functionName: 'inventoryOf', args: [who] }),
          pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'balanceOf', args: [who] }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'rewardPerPoint' }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'maxPointsPerMatch' }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'recordOf', args: [who] }),
        ]);
        if (this.state.wallet?.address !== who) return; // switched wallets meanwhile
        this.state.catalog = catalog.map((it, i) => ({
          id: i + 1,
          kind: it.kind === 0 ? 'car' : 'paint',
          key: it.key,
          name: it.name,
          color: it.color,
          price: it.price,
          listed: it.listed,
        }));
        this.state.owned = new Set(inventory.flatMap((own, i) => (own ? [i + 1] : [])));
        this.state.balance = balance;
        this.state.rewardPerPoint = rewardPerPoint;
        this.state.maxPoints = maxPoints;
        this.state.record = { matches: record.matches, wins: record.wins, points: Number(record.points), earned: record.earned };
        this.state.status = 'ready';
        this.state.error = undefined;
        this.saveCache();
      } catch (err) {
        console.warn('[chain] refresh failed', err);
        this.state.status = 'error';
        this.state.error = `Can't reach ${CHAIN.name}`;
      } finally {
        this.refreshing = null;
        this.emit();
      }
    })();
    return this.refreshing;
  }

  private async checkRelayer(): Promise<void> {
    try {
      const s = await this.relay<RelayStatus>('status');
      this.state.relayer = s.chainId === CHAIN_ID ? 'online' : 'offline';
      this.state.relayerBalance = BigInt(s.balance);
    } catch {
      this.state.relayer = 'offline';
    }
    this.emit();
  }

  // ============================================================================ cosmetics

  item(kind: CosmeticKind, key: string): CatalogItem | null {
    return this.state.catalog.find((i) => i.kind === kind && i.key === key) ?? null;
  }

  /** May the player use this cosmetic? (no deployment ⇒ everything is unlocked) */
  unlocked(kind: CosmeticKind, key: string): boolean {
    if (!this.state.enabled || STARTER[kind] === key) return true;
    const it = this.item(kind, key);
    return !!it && this.state.owned.has(it.id);
  }

  /** Whether ownership is known well enough to enforce locks (fresh read or a cache). */
  get ownershipKnown(): boolean {
    return !this.state.enabled || this.state.status === 'ready' || this.state.catalog.length > 0;
  }

  /** Locked, listed items the player can afford right now. */
  affordable(): CatalogItem[] {
    const bal = this.state.balance ?? 0n;
    return this.state.catalog.filter((i) => i.listed && !this.state.owned.has(i.id) && i.price <= bal);
  }

  // ============================================================================ purchases

  async buy(itemId: number): Promise<void> {
    const d = DEPLOYMENT;
    const pub = this.pub;
    const w = this.state.wallet;
    const it = this.state.catalog.find((i) => i.id === itemId);
    if (!d || !pub || !w || !it) throw new Error('Wallet not ready');
    const cur = this.state.purchases.get(itemId);
    if (cur && (cur.status === 'signing' || cur.status === 'sending' || cur.status === 'pending')) return;
    const setP = (p: Omit<PurchaseState, 'itemId'>) => {
      this.state.purchases.set(itemId, { itemId, ...p });
      this.emit();
    };
    setP({ status: 'signing' });
    try {
      const [balance, allowance, nonce, tokenNonce] = await Promise.all([
        pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'balanceOf', args: [w.address] }),
        pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'allowance', args: [w.address, d.garage] }),
        pub.readContract({ address: d.garage, abi: novaGarageAbi, functionName: 'nonces', args: [w.address] }),
        pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'nonces', args: [w.address] }),
      ]);
      const price = it.price;
      if (balance < price) throw new Error('Not enough NOVA — play a match to earn more');
      const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_S;
      let permit: PermitPayload | undefined;
      if (allowance < price) {
        const sig = await w.signTypedData({
          domain: { name: 'Nova', version: '1', chainId: CHAIN_ID, verifyingContract: d.nova },
          types: {
            Permit: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'Permit',
          message: { owner: w.address, spender: d.garage, value: price, nonce: tokenNonce, deadline: BigInt(deadline) },
        });
        const { r, s, v, yParity } = parseSignature(sig);
        permit = { value: price.toString(), deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
      }
      const signature = await w.signTypedData({
        domain: { name: 'NOVABALL Garage', version: '1', chainId: CHAIN_ID, verifyingContract: d.garage },
        types: {
          Purchase: [
            { name: 'buyer', type: 'address' },
            { name: 'itemId', type: 'uint256' },
            { name: 'maxPrice', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Purchase',
        message: { buyer: w.address, itemId: BigInt(itemId), maxPrice: price, nonce, deadline: BigInt(deadline) },
      });
      setP({ status: 'sending' });
      const req: PurchaseRequest = { buyer: w.address, itemId, maxPrice: price.toString(), deadline, signature, permit };
      let hash: Hex;
      try {
        hash = (await this.relay<TxReceiptRef>('purchase', req)).hash;
      } catch (err) {
        if (err instanceof RelayHttpError && err.status < 500) throw err;
        hash = await this.buyDirect(it, price, allowance, err);
      }
      setP({ status: 'pending', hash });
      const act = this.pushActivity({ kind: 'purchase', title: `${it.name}${it.kind === 'paint' ? ' PAINT' : ''} NFT`, amount: (-price).toString(), hash });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== 'success') throw new Error('The purchase transaction reverted');
      this.state.owned.add(itemId);
      this.state.balance = (this.state.balance ?? price) - price;
      this.settleActivity(act, 'confirmed');
      setP({ status: 'done', hash });
      void this.refresh();
    } catch (err) {
      setP({ status: 'error', message: friendly(err) });
      throw err;
    }
  }

  /** Relayer unreachable: an external wallet holding ETH can still buy by itself (approve + buy). */
  private async buyDirect(it: CatalogItem, price: bigint, allowance: bigint, cause: unknown): Promise<Hex> {
    const d = DEPLOYMENT!;
    const w = this.state.wallet!;
    const pub = this.pub!;
    const eth = await pub.getBalance({ address: w.address });
    if (eth === 0n) throw cause instanceof Error ? cause : new Error('The gas relayer is offline');
    await w.ensureChain();
    const account = w.client.account ?? w.address;
    if (allowance < price) {
      const h = await w.client.writeContract({ account, chain: CHAIN, address: d.nova, abi: novaTokenAbi, functionName: 'approve', args: [d.garage, price] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    return w.client.writeContract({ account, chain: CHAIN, address: d.garage, abi: novaGarageAbi, functionName: 'buy', args: [BigInt(it.id), price] });
  }

  // ============================================================================ rewards

  /** Called when the end screen opens: records the match on-chain and mints the player's NOVA. */
  reportMatch(sum: MatchSummary): void {
    if (!DEPLOYMENT || !this.state.wallet || sum.config.freePlay) return;
    const me = sum.players.find((p) => p.isPlayer);
    if (!me) return;
    const key = `${sum.config.seed}:${sum.hash ?? 0}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const points = Math.max(0, Math.round(me.stats.score));
    const counted = this.state.maxPoints ? Math.min(points, this.state.maxPoints) : points;
    const report: MatchReport = {
      player: this.state.wallet.address,
      callsign: (me.name || 'PLAYER').toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').slice(0, 12).trim() || 'PLAYER',
      team: me.team,
      points: counted,
      seed: sum.config.seed >>> 0,
      stateHash: (sum.hash ?? 0) >>> 0,
      teamSize: sum.config.teamSize,
      difficulty: sum.config.difficulty,
      durationSec: sum.config.durationSec,
      score: [sum.score[0], sum.score[1]],
      winner: sum.winner,
      overtime: sum.overtime,
    };
    this.state.reward = { key, status: 'sending', points: counted, amount: BigInt(counted) * this.state.rewardPerPoint };
    this.emit();
    void this.submitReward(report, key);
  }

  private async submitReward(report: MatchReport, key: string, attempt = 0): Promise<void> {
    const set = (patch: Partial<RewardState>) => {
      if (this.state.reward?.key !== key) return;
      this.state.reward = { ...this.state.reward, ...patch };
      this.emit();
    };
    try {
      const r = await this.relay<MatchReceipt>('match', report);
      const amount = BigInt(r.amount);
      set({ status: 'pending', hash: r.hash, amount });
      const act = this.pushActivity({ kind: 'reward', title: `MATCH REWARD · ${r.points} PTS`, amount: amount.toString(), hash: r.hash });
      const receipt = await this.pub!.waitForTransactionReceipt({ hash: r.hash, timeout: 90_000 });
      if (receipt.status !== 'success') throw new Error('The reward transaction reverted');
      this.settleActivity(act, 'confirmed');
      set({ status: 'confirmed' });
      await this.refresh();
    } catch (err) {
      if (err instanceof RelayHttpError && err.body.error === 'CooldownActive' && err.body.retryAt && attempt < 2) {
        // a real match outlasts the cooldown; quick rematches just wait for it
        set({ status: 'cooldown', retryAt: err.body.retryAt, message: err.body.message });
        const wait = Math.max(1000, err.body.retryAt * 1000 - Date.now() + 1500);
        window.setTimeout(() => void this.submitReward(report, key, attempt + 1), wait);
        return;
      }
      const offline = !(err instanceof RelayHttpError) || err.status >= 502;
      set({ status: offline ? 'offline' : 'failed', message: friendly(err) });
    }
  }

  // ============================================================================ relayer

  private async relay<T>(route: 'status' | 'match' | 'purchase', body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${RELAYER_URL}/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      this.state.relayer = 'offline';
      throw new RelayHttpError(503, { error: 'unreachable', message: 'The NOVABALL relayer is unreachable' });
    }
    const data = (await res.json().catch(() => null)) as T | RelayError | null;
    if (!res.ok || !data) {
      const e = (data as RelayError | null) ?? { error: 'http_' + res.status, message: `Relayer error (${res.status})` };
      throw new RelayHttpError(res.status, e);
    }
    if (this.state.relayer !== 'online') {
      this.state.relayer = 'online';
      this.emit();
    }
    return data as T;
  }

  // ============================================================================ activity + cache

  private pushActivity(a: Omit<Activity, 'id' | 'at' | 'status'>): Activity {
    const act: Activity = { ...a, id: a.hash, at: Date.now(), status: 'pending' };
    this.state.activity = [act, ...this.state.activity.filter((x) => x.id !== act.id)].slice(0, 30);
    this.saveCache();
    this.emit();
    return act;
  }

  private settleActivity(act: Activity, status: Activity['status']): void {
    act.status = status;
    this.state.activity = [...this.state.activity];
    this.saveCache();
  }

  private cacheKey(): string | null {
    const w = this.state.wallet;
    return DEPLOYMENT && w ? `novaball.chain.v1:${CHAIN_ID}:${DEPLOYMENT.garage}:${w.address}`.toLowerCase() : null;
  }

  private loadCache(): void {
    const k = this.cacheKey();
    if (!k) return;
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const c = JSON.parse(raw) as Cache;
      this.state.owned = new Set(c.owned);
      this.state.balance = c.balance === null ? null : BigInt(c.balance);
      this.state.activity = c.activity ?? [];
      if (!this.state.catalog.length) this.state.catalog = (c.catalog ?? []).map((i) => ({ ...i, price: BigInt(i.price) }));
    } catch {
      /* ignore a corrupt cache */
    }
  }

  private saveCache(): void {
    const k = this.cacheKey();
    if (!k) return;
    const s = this.state;
    const c: Cache = {
      owned: [...s.owned],
      balance: s.balance === null ? null : s.balance.toString(),
      activity: s.activity,
      catalog: s.catalog.map((i) => ({ ...i, price: i.price.toString() })),
    };
    try {
      localStorage.setItem(k, JSON.stringify(c));
    } catch {
      /* storage full / blocked */
    }
  }

  dispose(): void {
    window.clearInterval(this.pollTimer);
    this.unwatch();
    this.listeners.clear();
  }
}

/** A short, human message for any wallet / relayer / chain error. */
export function friendly(err: unknown): string {
  if (err instanceof RelayHttpError) return err.body.message;
  const e = err as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (e?.code === 4001 || e?.cause?.code === 4001 || /user rejected|denied/i.test(e?.message ?? '')) return 'Signature request was declined';
  return e?.shortMessage ?? e?.message ?? 'Something went wrong';
}

export type { NovaWallet, WalletOption };
export type { Address };
