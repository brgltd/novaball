/**
 * NovaChain — the game's single on-chain service + observable store (no framework).
 *
 *   earn:  end of a match → reportMatch() keeps it as an unclaimed reward → the player hits CLAIM REWARDS →
 *          their wallet sends NovaArena.claim (they pay the gas) → NOVA is minted to them
 *   own:   garage → buy() → their wallet sends NovaGarage.buy → NOVA burned, NFT minted
 *   drive: unlocked() gates garage cosmetics by NFT ownership (STRIKER + ARCTIC are free)
 *
 * Playing needs no wallet: the last match's reward waits (in this browser) until the player connects and claims it.
 * Everything degrades gracefully: no deployment → features off and everything unlocked; RPC down → cached state.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeAbiParameters,
  hexToString,
  http,
  InsufficientFundsError,
  keccak256,
  stringToHex,
  trim,
  UserRejectedRequestError,
  type PublicClient,
} from 'viem';

import type { MatchSummary } from '../contracts';
import { novaArenaAbi, novaGarageAbi, novaTokenAbi } from './abi';
import { BUY_GAS, CHAIN, CHAIN_ID, CLAIM_GAS, DEPLOYMENT, IS_LOCAL, NETWORK_LABEL, RPC_URL } from './config';
import type { Address, Hex } from './types';
import { connectWallet, disconnectWallet, restoreWallet, watchWallet, type NovaWallet, type WalletOption } from './wallet';

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
  /** Unix seconds of the last claim (0 = never). */
  lastMatchAt: number;
}

export interface LeaderRow {
  rank: number;
  address: Address;
  callsign: string;
  matches: number;
  wins: number;
  points: number;
  earned: bigint;
  isYou: boolean;
}

/** A finished match whose reward has not been claimed yet (kept in this browser until claimed or replaced). */
export interface UnclaimedMatch {
  key: string;
  /** ms */
  at: number;
  points: number;
  team: 0 | 1;
  callsign: string;
  seed: number;
  stateHash: number;
  teamSize: number;
  difficulty: 'rookie' | 'pro' | 'legend';
  durationSec: number;
  score: [number, number];
  winner: -1 | 0 | 1;
  overtime: boolean;
}

/**
 * The claim of the last match's reward:
 *   ready → (CLAIM) → confirm (in the wallet) → pending (mining) → confirmed
 *   failed: `reason` says why — no ETH for gas, cooldown, declined, wrong network, other.
 */
export type ClaimStatus = 'ready' | 'confirm' | 'pending' | 'confirmed' | 'failed';
export type ClaimFailure = 'gas' | 'cooldown' | 'declined' | 'network' | 'error';

export interface ClaimState {
  key: string;
  status: ClaimStatus;
  points: number;
  hash?: Hex;
  reason?: ClaimFailure;
  message?: string;
  /** Unix seconds when a cooldown ends. */
  retryAt?: number;
}

export type PurchaseStatus = 'confirm' | 'pending' | 'done' | 'error';

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
  /** The connected wallet (null: playing without one). */
  wallet: NovaWallet | null;
  /** The last session's wallet is being looked up (no prompt). */
  restoring: boolean;
  /** A connect prompt is open. */
  connecting: boolean;
  /** NOVA balance, wei. */
  balance: bigint | null;
  /** ETH balance on the game's chain (gas money), wei. */
  eth: bigint | null;
  gasPrice: bigint | null;
  catalog: CatalogItem[];
  owned: Set<number>;
  /** NOVA wei per match point, max rewarded points per match, seconds between claims. */
  rewardPerPoint: bigint;
  maxPoints: number;
  cooldown: number;
  activity: Activity[];
  record: PlayerRecord | null;
  unclaimed: UnclaimedMatch | null;
  claim: ClaimState | null;
  purchases: Map<number, PurchaseState>;
  /** Bumped on every change. */
  version: number;
}

type Listener = (s: Readonly<ChainState>) => void;

interface WalletCache {
  owned: number[];
  balance: string | null;
  activity: Activity[];
}

const POLL_MS = 15_000;
const DIFFICULTY = { rookie: 0, pro: 1, legend: 2 } as const;
const MATCH_RESULT = {
  type: 'tuple',
  components: [
    { name: 'seed', type: 'uint64' },
    { name: 'stateHash', type: 'uint32' },
    { name: 'teamSize', type: 'uint8' },
    { name: 'difficulty', type: 'uint8' },
    { name: 'durationSec', type: 'uint16' },
    { name: 'scoreVolt', type: 'uint16' },
    { name: 'scoreBlaze', type: 'uint16' },
    { name: 'winner', type: 'int8' },
    { name: 'overtime', type: 'bool' },
  ],
} as const;

export class NovaChain {
  readonly state: ChainState = {
    enabled: DEPLOYMENT !== null,
    status: 'loading',
    wallet: null,
    restoring: DEPLOYMENT !== null,
    connecting: false,
    balance: null,
    eth: null,
    gasPrice: null,
    catalog: [],
    owned: new Set(),
    rewardPerPoint: 0n,
    maxPoints: 0,
    cooldown: 0,
    activity: [],
    record: null,
    unclaimed: null,
    claim: null,
    purchases: new Map(),
    version: 0,
  };

  private readonly listeners = new Set<Listener>();
  private readonly pub: PublicClient | null = DEPLOYMENT ? createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { retryCount: 1 }) }) : null;
  private started = false;
  private pollTimer = 0;
  private unwatch: () => void = () => {};
  private refreshing: Promise<void> | null = null;
  /** The wallet whose NFT ownership is loaded (from the chain or this browser's cache). */
  private ownedFor: string | null = null;
  /** Purchases confirmed by a receipt ("wallet:id" → ms): a lagging RPC read must not un-own them. */
  private readonly confirmedOwned = new Map<string, number>();

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

  /** Restore the last wallet (no prompt) and load on-chain state (idempotent). */
  async start(): Promise<void> {
    if (this.started || !DEPLOYMENT) {
      if (!DEPLOYMENT) {
        this.state.status = 'ready';
        this.emit();
      }
      return;
    }
    this.started = true;
    this.loadCatalogCache();
    this.loadUnclaimed();
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
    const w = await restoreWallet().catch(() => null);
    this.state.restoring = false;
    await this.setWallet(w);
  }

  private async setWallet(w: NovaWallet | null): Promise<void> {
    this.unwatch();
    this.unwatch = () => {};
    this.state.wallet = w;
    this.state.balance = null;
    this.state.eth = null;
    this.state.owned = new Set();
    this.state.activity = [];
    this.state.record = null;
    this.ownedFor = null;
    if (this.state.claim && this.state.claim.status !== 'pending' && this.state.claim.status !== 'confirmed' && this.state.unclaimed) {
      this.state.claim = this.readyClaim(this.state.unclaimed);
    }
    this.loadWalletCache();
    this.emit();
    if (w) {
      this.unwatch = watchWallet(w, (accounts) => {
        if (!accounts.length) void this.setWallet(null);
        else if (accounts[0].toLowerCase() !== this.state.wallet?.address.toLowerCase()) void restoreWallet().then((nw) => this.setWallet(nw));
      });
    }
    await this.refresh(true);
    if (w) void this.settlePending();
  }

  /** Ask a browser wallet to connect (needs a user gesture). */
  async connect(opt: WalletOption): Promise<void> {
    if (this.state.connecting) return;
    this.state.connecting = true;
    this.emit();
    try {
      await this.setWallet(await connectWallet(opt));
    } finally {
      this.state.connecting = false;
      this.emit();
    }
  }

  async disconnect(): Promise<void> {
    const w = this.state.wallet;
    await this.setWallet(null);
    await disconnectWallet(w);
  }

  /** Activity left pending (tab closed before the receipt): look the transactions up again. */
  private async settlePending(): Promise<void> {
    const pub = this.pub;
    if (!pub) return;
    for (const a of this.state.activity.filter((x) => x.status === 'pending')) {
      try {
        const r = await pub.waitForTransactionReceipt({ hash: a.hash, timeout: 20_000 });
        this.settleActivity(a, r.status === 'success' ? 'confirmed' : 'failed');
      } catch {
        if (Date.now() - a.at > 10 * 60_000) this.settleActivity(a, 'failed');
      }
    }
    this.emit();
  }

  // ============================================================================ reads

  /**
   * Reload the catalog and reward config, plus the wallet's balances, inventory and record. Calls coalesce into the
   * read in flight; `force` (after a transaction or a wallet switch) runs a fresh read once that one finishes.
   */
  refresh(force = false): Promise<void> {
    if (!this.pub || !DEPLOYMENT) return Promise.resolve();
    if (this.refreshing) return force ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    const pub = this.pub;
    const d = DEPLOYMENT;
    const who = this.state.wallet?.address ?? null;
    const pending = this.state.unclaimed;
    this.refreshing = (async () => {
      try {
        const [catalog, rewardPerPoint, maxPoints, cooldown, gasPrice] = await Promise.all([
          pub.readContract({ address: d.garage, abi: novaGarageAbi, functionName: 'catalog' }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'rewardPerPoint' }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'maxPointsPerMatch' }),
          pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'matchCooldown' }),
          pub.getGasPrice().catch(() => null),
        ]);
        this.state.catalog = catalog.map((it, i) => ({
          id: i + 1,
          kind: it.kind === 0 ? 'car' : 'paint',
          key: it.key,
          name: it.name,
          color: it.color,
          price: it.price,
          listed: it.listed,
        }));
        this.state.rewardPerPoint = rewardPerPoint;
        this.state.maxPoints = maxPoints;
        this.state.cooldown = cooldown;
        this.state.gasPrice = gasPrice;
        this.saveCatalogCache();

        if (who) {
          const [inventory, balance, eth, record, alreadyClaimed] = await Promise.all([
            pub.readContract({ address: d.garage, abi: novaGarageAbi, functionName: 'inventoryOf', args: [who] }),
            pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'balanceOf', args: [who] }),
            pub.getBalance({ address: who }),
            pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'recordOf', args: [who] }),
            pending ? pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'claimed', args: [matchIdOf(who, pending)] }) : false,
          ]);
          if (this.state.wallet?.address !== who) return; // switched wallets meanwhile
          const owned = new Set(inventory.flatMap((own, i) => (own ? [i + 1] : [])));
          for (const [k, t] of this.confirmedOwned) {
            const [addr, id] = k.split(':');
            if (Date.now() - t > 120_000) this.confirmedOwned.delete(k);
            else if (addr === who) owned.add(Number(id));
          }
          this.state.owned = owned;
          this.ownedFor = who;
          this.state.balance = balance;
          this.state.eth = eth;
          this.state.record = { matches: record.matches, wins: record.wins, points: Number(record.points), earned: record.earned, lastMatchAt: Number(record.lastMatchAt) };
          // claimed meanwhile (another tab, an earlier attempt that landed late)
          if (alreadyClaimed && this.state.unclaimed?.key === pending?.key) this.finishClaim(pending!.key);
          this.saveWalletCache();
        }
        this.state.status = 'ready';
        this.state.error = undefined;
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

  // ============================================================================ leaderboard

  /** Every pilot with a record on NovaArena, best first (NOVA earned, then wins). */
  async leaderboard(limit = 50): Promise<LeaderRow[]> {
    if (!this.pub || !DEPLOYMENT) return [];
    const pub = this.pub;
    const arena = DEPLOYMENT.arena;
    const total = Number(await pub.readContract({ address: arena, abi: novaArenaAbi, functionName: 'playerCount' }));
    const pages = await Promise.all(
      Array.from({ length: Math.min(20, Math.ceil(total / 500)) }, (_, p) =>
        pub.readContract({ address: arena, abi: novaArenaAbi, functionName: 'getPlayers', args: [BigInt(p * 500), 500n] }),
      ),
    );
    const addrs = pages.flatMap((pg) => pg[0]);
    const recs = pages.flatMap((pg) => pg[1]);
    const me = this.state.wallet?.address.toLowerCase();
    return addrs
      .map((address, i) => {
        const r = recs[i];
        let callsign = '';
        try {
          callsign = hexToString(trim(r.callsign, { dir: 'right' })).replace(/[^A-Z0-9 _\-.]/g, '');
        } catch {
          /* not ASCII */
        }
        return { rank: 0, address, callsign: callsign || 'PILOT', matches: r.matches, wins: r.wins, points: Number(r.points), earned: r.earned, isYou: address.toLowerCase() === me };
      })
      .sort((a, b) => (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : b.wins - a.wins))
      .map((row, i) => ({ ...row, rank: i + 1 }))
      .filter((row) => row.rank <= limit || row.isYou);
  }

  // ============================================================================ gas

  /** Rough gas cost of a transaction of `gas` units at the current gas price (null: unknown). */
  gasCost(gas: bigint): bigint | null {
    return this.state.gasPrice === null ? null : gas * this.state.gasPrice;
  }

  /** The wallet visibly lacks ETH for a transaction of `gas` units. */
  needsGas(gas: bigint): boolean {
    const { eth } = this.state;
    if (eth === null) return false;
    const cost = this.gasCost(gas);
    return cost === null ? eth === 0n : eth < cost;
  }

  /** Local chain only: top the wallet up with 10 test ETH. */
  async devFaucet(): Promise<void> {
    const w = this.state.wallet;
    if (!IS_LOCAL || !this.pub || !w) return;
    await this.pub.request({ method: 'anvil_setBalance' as never, params: [w.address, '0x8ac7230489e80000'] as never });
    await this.refresh(true);
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

  /** Whether ownership is known well enough to enforce locks (no wallet: only the starter kit is owned). */
  get ownershipKnown(): boolean {
    const s = this.state;
    if (!s.enabled) return true;
    if (s.restoring) return false;
    return !s.wallet || (this.ownedFor !== null && this.ownedFor === s.wallet.address);
  }

  /** Locked, listed items the player can afford right now. */
  affordable(): CatalogItem[] {
    const bal = this.state.balance ?? 0n;
    return this.state.catalog.filter((i) => i.listed && !this.state.owned.has(i.id) && i.price <= bal);
  }

  // ============================================================================ purchases

  /** Buy a cosmetic NFT: one transaction from the player's wallet (NOVA burned, NFT minted). */
  async buy(itemId: number): Promise<void> {
    const d = DEPLOYMENT;
    const pub = this.pub;
    const w = this.state.wallet;
    const it = this.state.catalog.find((i) => i.id === itemId);
    if (!d || !pub || !w || !it) throw new Error('Connect a wallet first');
    if (this.purchaseBusy) throw new Error('Another purchase is in progress');
    const setP = (p: Omit<PurchaseState, 'itemId'>) => {
      this.state.purchases.set(itemId, { itemId, ...p });
      this.emit();
    };
    setP({ status: 'confirm' });
    try {
      const price = it.price;
      const balance = await pub.readContract({ address: d.nova, abi: novaTokenAbi, functionName: 'balanceOf', args: [w.address] });
      if (balance < price) throw new Error('Not enough NOVA — play a match to earn more');
      await w.ensureChain();
      const { request } = await pub.simulateContract({ account: w.address, address: d.garage, abi: novaGarageAbi, functionName: 'buy', args: [BigInt(itemId), price] });
      if (this.needsGas(BUY_GAS)) throw new Error(`Your wallet needs a little ${NETWORK_LABEL} ETH for gas`);
      const hash = await w.client.writeContract({ ...request, account: w.address, chain: CHAIN });
      setP({ status: 'pending', hash });
      const act = this.pushActivity({ kind: 'purchase', title: `${it.name}${it.kind === 'paint' ? ' PAINT' : ''} NFT`, amount: (-price).toString(), hash });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') {
        this.settleActivity(act, 'failed');
        throw new Error('The purchase transaction reverted');
      }
      this.confirmedOwned.set(`${w.address}:${itemId}`, Date.now());
      if (this.state.wallet?.address === w.address) {
        this.state.owned.add(itemId);
        this.state.balance = (this.state.balance ?? price) - price;
        this.settleActivity(act, 'confirmed');
      }
      setP({ status: 'done', hash });
      void this.refresh(true);
    } catch (err) {
      setP({ status: 'error', message: friendly(err) });
      throw err;
    }
  }

  /** A purchase is waiting for the wallet or being mined. */
  get purchaseBusy(): boolean {
    return [...this.state.purchases.values()].some((p) => p.status === 'confirm' || p.status === 'pending');
  }

  // ============================================================================ rewards

  /** NOVA (wei) a claim of `points` mints at the current rate (capped like the contract does). */
  rewardFor(points: number): bigint {
    const capped = this.state.maxPoints ? Math.min(points, this.state.maxPoints) : points;
    return BigInt(capped) * this.state.rewardPerPoint;
  }

  /** Called when the end screen opens: keeps the match as the claimable reward (no wallet needed yet). */
  reportMatch(sum: MatchSummary): void {
    if (!DEPLOYMENT || sum.config.freePlay) return;
    const me = sum.players.find((p) => p.isPlayer);
    if (!me) return;
    const key = `${sum.config.seed >>> 0}:${(sum.hash ?? 0) >>> 0}`;
    if (this.state.unclaimed?.key === key || this.state.claim?.key === key) return;
    const m: UnclaimedMatch = {
      key,
      at: Date.now(),
      points: Math.max(0, Math.round(me.stats.score)),
      team: me.team,
      callsign: (me.name || 'PLAYER').toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').slice(0, 12).trim() || 'PLAYER',
      seed: sum.config.seed >>> 0,
      stateHash: (sum.hash ?? 0) >>> 0,
      teamSize: sum.config.teamSize,
      difficulty: sum.config.difficulty,
      durationSec: sum.config.durationSec,
      score: [sum.score[0], sum.score[1]],
      winner: sum.winner,
      overtime: sum.overtime,
    };
    // a match without points has nothing to claim
    if (m.points === 0) {
      this.state.claim = { key, status: 'confirmed', points: 0 };
      this.emit();
      return;
    }
    this.state.unclaimed = m;
    this.state.claim = this.readyClaim(m);
    this.saveUnclaimed();
    this.emit();
  }

  private readyClaim(m: UnclaimedMatch): ClaimState {
    return { key: m.key, status: 'ready', points: m.points };
  }

  /** A claim is waiting for the wallet or being mined. */
  get claimBusy(): boolean {
    const s = this.state.claim?.status;
    return s === 'confirm' || s === 'pending';
  }

  /** Claim the unclaimed match's reward: one transaction from the player's wallet, which pays the gas. */
  async claimReward(): Promise<void> {
    const d = DEPLOYMENT;
    const pub = this.pub;
    const w = this.state.wallet;
    const m = this.state.unclaimed;
    if (!d || !pub || !w || !m || this.claimBusy) return;
    const set = (patch: Partial<ClaimState>) => {
      if (this.state.claim?.key !== m.key) return;
      this.state.claim = { ...this.state.claim, ...patch };
      this.emit();
    };
    this.state.claim = { key: m.key, status: 'confirm', points: m.points };
    this.emit();
    try {
      const maxPoints = this.state.maxPoints || Number(await pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'maxPointsPerMatch' }));
      const points = Math.min(m.points, maxPoints);
      const ready = await pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'readyAt', args: [w.address] });
      if (ready > 0n) {
        set({ status: 'failed', reason: 'cooldown', retryAt: Number(ready), message: 'One claim per minute — almost there' });
        return;
      }
      await w.ensureChain().catch((err) => {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { network: true });
      });
      const args = [toResult(m), m.team, points, stringToHex(m.callsign, { size: 16 })] as const;
      const { request } = await pub.simulateContract({ account: w.address, address: d.arena, abi: novaArenaAbi, functionName: 'claim', args });
      if (this.state.eth === null) this.state.eth = await pub.getBalance({ address: w.address }).catch(() => null);
      if (this.needsGas(CLAIM_GAS)) {
        set({ status: 'failed', reason: 'gas', message: `No ${NETWORK_LABEL} ETH for gas` });
        return;
      }
      const hash = await w.client.writeContract({ ...request, account: w.address, chain: CHAIN });
      set({ status: 'pending', hash, points });
      const amount = BigInt(points) * this.state.rewardPerPoint;
      const act = this.pushActivity({ kind: 'reward', title: `MATCH REWARD · ${points} PTS`, amount: amount.toString(), hash });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') {
        this.settleActivity(act, 'failed');
        throw new Error('The claim transaction reverted');
      }
      this.settleActivity(act, 'confirmed');
      if (this.state.wallet?.address === w.address) this.state.balance = (this.state.balance ?? 0n) + amount;
      this.finishClaim(m.key, hash);
      void this.refresh(true);
    } catch (err) {
      const name = revertName(err);
      if (name === 'AlreadyClaimed') {
        this.finishClaim(m.key); // an earlier attempt landed after all
        void this.refresh(true);
        return;
      }
      if (name === 'CooldownActive') {
        const ready = await pub.readContract({ address: d.arena, abi: novaArenaAbi, functionName: 'readyAt', args: [w.address] }).catch(() => 0n);
        set({ status: 'failed', reason: 'cooldown', retryAt: Number(ready) || Math.floor(Date.now() / 1000) + 60, message: 'One claim per minute — almost there' });
        return;
      }
      const reason: ClaimFailure = isRejection(err) ? 'declined' : isNoFunds(err) ? 'gas' : (err as { network?: boolean }).network ? 'network' : 'error';
      set({ status: 'failed', reason, message: reason === 'gas' ? `No ${NETWORK_LABEL} ETH for gas` : friendly(err) });
    }
  }

  private finishClaim(key: string, hash?: Hex): void {
    if (this.state.unclaimed?.key === key) {
      this.state.unclaimed = null;
      this.saveUnclaimed();
    }
    if (this.state.claim?.key === key) this.state.claim = { ...this.state.claim, status: 'confirmed', hash: hash ?? this.state.claim.hash, reason: undefined, message: undefined };
    this.emit();
  }

  // ============================================================================ activity + cache

  private pushActivity(a: Omit<Activity, 'id' | 'at' | 'status'>): Activity {
    const act: Activity = { ...a, id: a.hash, at: Date.now(), status: 'pending' };
    this.state.activity = [act, ...this.state.activity.filter((x) => x.id !== act.id)].slice(0, 30);
    this.saveWalletCache();
    this.emit();
    return act;
  }

  private settleActivity(act: Activity, status: Activity['status']): void {
    act.status = status;
    this.state.activity = [...this.state.activity];
    this.saveWalletCache();
  }

  private key(kind: string, wallet = ''): string | null {
    return DEPLOYMENT ? `novaball.${kind}:${CHAIN_ID}:${DEPLOYMENT.garage}${wallet ? `:${wallet}` : ''}`.toLowerCase() : null;
  }

  private loadJson<T>(k: string | null): T | null {
    if (!k) return null;
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null') as T | null;
    } catch {
      return null;
    }
  }

  private saveJson(k: string | null, v: unknown): void {
    if (!k) return;
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage full / blocked */
    }
  }

  private loadWalletCache(): void {
    const w = this.state.wallet;
    const c = w && this.loadJson<WalletCache>(this.key('wallet.v2', w.address));
    if (!w || !c) return;
    this.state.owned = new Set(c.owned);
    this.ownedFor = w.address;
    this.state.balance = c.balance === null ? null : BigInt(c.balance);
    this.state.activity = c.activity ?? [];
  }

  private saveWalletCache(): void {
    const w = this.state.wallet;
    if (!w) return;
    const s = this.state;
    const c: WalletCache = { owned: [...s.owned], balance: s.balance === null ? null : s.balance.toString(), activity: s.activity };
    this.saveJson(this.key('wallet.v2', w.address), c);
  }

  private loadCatalogCache(): void {
    const c = this.loadJson<Array<Omit<CatalogItem, 'price'> & { price: string }>>(this.key('catalog.v1'));
    if (c && !this.state.catalog.length) this.state.catalog = c.map((i) => ({ ...i, price: BigInt(i.price) }));
  }

  private saveCatalogCache(): void {
    this.saveJson(
      this.key('catalog.v1'),
      this.state.catalog.map((i) => ({ ...i, price: i.price.toString() })),
    );
  }

  private loadUnclaimed(): void {
    const m = this.loadJson<UnclaimedMatch>(this.key('unclaimed.v1'));
    if (m?.key && m.points > 0) {
      this.state.unclaimed = m;
      this.state.claim = this.readyClaim(m);
    }
  }

  private saveUnclaimed(): void {
    this.saveJson(this.key('unclaimed.v1'), this.state.unclaimed);
  }

  dispose(): void {
    window.clearInterval(this.pollTimer);
    this.unwatch();
    this.listeners.clear();
  }
}

// ============================================================================ helpers

function toResult(m: UnclaimedMatch) {
  return {
    seed: BigInt(m.seed),
    stateHash: m.stateHash,
    teamSize: m.teamSize,
    difficulty: DIFFICULTY[m.difficulty] ?? 0,
    durationSec: m.durationSec,
    scoreVolt: m.score[0],
    scoreBlaze: m.score[1],
    winner: m.winner,
    overtime: m.overtime,
  };
}

/** NovaArena's id for `player`'s claim of match `m`: keccak256(abi.encode(player, result)). */
export function matchIdOf(player: Address, m: UnclaimedMatch): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, MATCH_RESULT], [player, toResult(m)]));
}

/** The contract error name inside a viem error (e.g. 'CooldownActive'). */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return r?.data?.errorName ?? r?.reason;
}

function isRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  const e = err as { code?: number; cause?: { code?: number }; message?: string };
  return e?.code === 4001 || e?.cause?.code === 4001 || /user rejected|user denied|rejected the request/i.test(e?.message ?? '');
}

function isNoFunds(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) return true;
  return /insufficient funds|exceeds the balance|gas required exceeds/i.test((err as { message?: string })?.message ?? '');
}

const REVERT_MESSAGES: Record<string, string> = {
  AlreadyOwned: 'You already own this NFT',
  NotListed: 'This item is not for sale right now',
  PriceAboveMax: 'The price just changed — try again',
  ERC20InsufficientBalance: 'Not enough NOVA',
  PointsAboveCap: 'Too many points for one match',
  InvalidTeam: 'Invalid match data',
};

/** A short, human message for any wallet / chain error. */
export function friendly(err: unknown): string {
  if (isRejection(err)) return 'Request declined in your wallet';
  if (isNoFunds(err)) return `Your wallet needs ${NETWORK_LABEL} ETH for gas`;
  const name = revertName(err);
  if (name && REVERT_MESSAGES[name]) return REVERT_MESSAGES[name];
  const e = err as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? 'Something went wrong';
}

export type { NovaWallet, WalletOption };
export type { Address };
