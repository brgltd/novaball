/**
 * NOVABALL relayer — the game server.
 *
 * - Records finished matches on NovaArena (it holds GAME_SERVER_ROLE) → players are minted NOVA without signing or
 *   paying anything.
 * - Submits players' EIP-712-signed garage purchases (NovaGarage.buyFor / buyForWithPermit) and pays the gas, so a
 *   brand-new wallet with 0 ETH can buy NFTs.
 *
 * Framework-free: `handle(Request) → Response` (Fetch API). Mounted by the Vite dev server (server/vite.ts), the
 * standalone Node server (server/node.ts) and Vercel functions (api/*.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  isHex,
  nonceManager,
  stringToHex,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia, foundry } from 'viem/chains';

import { novaArenaAbi, novaGarageAbi } from '../src/chain/abi.ts';
import type { Address, Hex, MatchReceipt, MatchReport, PurchaseRequest, RelayError, RelayStatus, TxReceiptRef } from '../src/chain/api.ts';

export interface Deployment {
  chainId: number;
  nova: Address;
  garage: Address;
  arena: Address;
  relayer: Address;
  startBlock?: number;
}

export interface RelayerOptions {
  chainId: number;
  privateKey: Hex;
  deployment: Deployment;
  rpcUrl?: string;
  /** Log lines (default console.log). */
  log?: (msg: string) => void;
}

/** anvil account #1 — the local relayer that Deploy.s.sol grants GAME_SERVER_ROLE on chain 31337. */
export const ANVIL_RELAYER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const CHAINS: Record<number, Chain> = { [foundry.id]: foundry, [arbitrumSepolia.id]: arbitrumSepolia, [arbitrum.id]: arbitrum };
const DIFFICULTY = { rookie: 0, pro: 1, legend: 2 } as const;
const CALLSIGN_RE = /^[A-Z0-9 _\-.]{1,12}$/;

/** deployments/<chainId>.json written by contracts/script/Deploy.s.sol. */
export function loadDeployment(chainId: number, dir = join(process.cwd(), 'src/chain/deployments')): Deployment | null {
  try {
    return JSON.parse(readFileSync(join(dir, `${chainId}.json`), 'utf8')) as Deployment;
  } catch {
    return null;
  }
}

/** Relayer options from environment variables (RELAYER_PRIVATE_KEY, CHAIN_ID / VITE_CHAIN_ID, RPC_URL). */
export function optionsFromEnv(env: Record<string, string | undefined>, defaultChainId: number, dir?: string): RelayerOptions | { error: string } {
  const chainId = Number(env.CHAIN_ID || env.VITE_CHAIN_ID || defaultChainId);
  const deployment = loadDeployment(chainId, dir);
  if (!deployment) return { error: `no deployment for chain ${chainId} (run contracts/script/Deploy.s.sol)` };
  const privateKey = (env.RELAYER_PRIVATE_KEY || (chainId === foundry.id ? ANVIL_RELAYER_KEY : '')) as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) return { error: 'RELAYER_PRIVATE_KEY is not set' };
  return { chainId, privateKey, deployment, rpcUrl: env.RPC_URL || env.VITE_RPC_URL || undefined };
}

class HttpError extends Error {
  readonly status: number;
  readonly body: RelayError;
  constructor(status: number, body: RelayError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

const bad = (message: string) => new HttpError(400, { error: 'bad_request', message });

/** Sliding-window limiter (per relayer instance; the contracts enforce the real limits). */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  /** null when allowed, else the ms until the next slot. */
  take(key: string, now = Date.now()): number | null {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return list[0] + this.windowMs - now;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return null;
  }
}

export function createRelayer(opts: RelayerOptions) {
  const chain = CHAINS[opts.chainId] ?? { ...foundry, id: opts.chainId, name: `Chain ${opts.chainId}` };
  const transport = http(opts.rpcUrl || chain.rpcUrls.default.http[0]);
  const account = privateKeyToAccount(opts.privateKey, { nonceManager });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account });
  const { arena, garage } = opts.deployment;
  const log = opts.log ?? ((m: string) => console.log(m));
  const perPlayer = new Limiter(3, 60_000);
  const perIp = new Limiter(40, 60_000);

  // ------------------------------------------------------------------ routes

  async function status(): Promise<RelayStatus> {
    const balance = await publicClient.getBalance({ address: account.address });
    return { ok: true, chainId: chain.id, relayer: account.address, balance: balance.toString(), garage, arena };
  }

  async function recordMatch(body: unknown): Promise<MatchReceipt> {
    const r = parseMatch(body);
    limit(perPlayer, `m:${r.player.toLowerCase()}`);
    const result = {
      seed: BigInt(r.seed),
      stateHash: r.stateHash,
      teamSize: r.teamSize,
      difficulty: DIFFICULTY[r.difficulty],
      durationSec: r.durationSec,
      scoreVolt: r.score[0],
      scoreBlaze: r.score[1],
      winner: r.winner,
      overtime: r.overtime,
    };
    const players = [{ player: r.player, team: r.team, points: r.points, callsign: stringToHex(r.callsign, { size: 16 }) }];
    const sim = await simulate(() =>
      publicClient.simulateContract({ account, address: arena, abi: novaArenaAbi, functionName: 'recordMatch', args: [result, players] }),
    );
    const amount = (await publicClient.readContract({ address: arena, abi: novaArenaAbi, functionName: 'rewardPerPoint' })) * BigInt(r.points);
    const hash = await wallet.writeContract(sim.request);
    log(`[relayer] match ${r.callsign} ${r.player} ${r.points} pts → ${formatEther(amount)} NOVA  ${hash}`);
    return { hash, matchId: sim.result, points: r.points, amount: amount.toString() };
  }

  async function purchase(body: unknown): Promise<TxReceiptRef> {
    const p = parsePurchase(body);
    limit(perPlayer, `p:${p.buyer.toLowerCase()}`);
    const base = [p.buyer, BigInt(p.itemId), BigInt(p.maxPrice), BigInt(p.deadline), p.signature] as const;
    let hash: Hex;
    if (p.permit) {
      const permit = { value: BigInt(p.permit.value), deadline: BigInt(p.permit.deadline), v: p.permit.v, r: p.permit.r, s: p.permit.s };
      const sim = await simulate(() =>
        publicClient.simulateContract({ account, address: garage, abi: novaGarageAbi, functionName: 'buyForWithPermit', args: [...base, permit] }),
      );
      hash = await wallet.writeContract(sim.request);
    } else {
      const sim = await simulate(() => publicClient.simulateContract({ account, address: garage, abi: novaGarageAbi, functionName: 'buyFor', args: base }));
      hash = await wallet.writeContract(sim.request);
    }
    log(`[relayer] purchase item ${p.itemId} for ${p.buyer}  ${hash}`);
    return { hash };
  }

  // ------------------------------------------------------------------ plumbing

  function limit(l: Limiter, key: string): void {
    const wait = l.take(key);
    if (wait !== null) {
      throw new HttpError(429, { error: 'rate_limited', message: 'Too many requests — try again in a moment.', retryAt: Math.ceil((Date.now() + wait) / 1000) });
    }
  }

  /** Run a simulation; contract reverts become 4xx with the custom error name. */
  async function simulate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toHttpError(err);
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = url.pathname.replace(/\/+$/, '').split('/').pop();
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
      if (route === 'status' && req.method === 'GET') return json(200, await status());
      if (req.method !== 'POST' || (route !== 'match' && route !== 'purchase')) return json(404, { error: 'not_found', message: 'Unknown endpoint' });
      limit(perIp, ip);
      const body = await req.json().catch(() => {
        throw bad('Body must be JSON');
      });
      return json(200, route === 'match' ? await recordMatch(body) : await purchase(body));
    } catch (err) {
      const e = err instanceof HttpError ? err : toHttpError(err);
      if (e.status >= 500) log(`[relayer] ${route}: ${err instanceof Error ? err.message : String(err)}`);
      return json(e.status, e.body);
    }
  }

  return { handle, address: account.address, chainId: chain.id };
}

// ------------------------------------------------------------------ validation

function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

function addr(v: unknown, name: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw bad(`${name} must be an address`);
  return v as Address;
}

function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Body must be a JSON object');
  return v as Record<string, unknown>;
}

function wei(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) throw bad(`${name} must be a decimal string`);
  return v;
}

function parseMatch(body: unknown): MatchReport {
  const b = obj(body);
  const callsign = typeof b.callsign === 'string' ? b.callsign.toUpperCase().trim() : '';
  if (!CALLSIGN_RE.test(callsign)) throw bad('callsign: A–Z 0–9 space _ - ., 1–12 characters');
  if (typeof b.difficulty !== 'string' || !(b.difficulty in DIFFICULTY)) throw bad('difficulty must be rookie | pro | legend');
  if (!Array.isArray(b.score) || b.score.length !== 2) throw bad('score must be [volt, blaze]');
  if (typeof b.overtime !== 'boolean') throw bad('overtime must be a boolean');
  const durationSec = int(b.durationSec, 'durationSec', 120, 600);
  const score: [number, number] = [int(b.score[0], 'score[0]', 0, 999), int(b.score[1], 'score[1]', 0, 999)];
  const winner = int(b.winner, 'winner', -1, 1) as -1 | 0 | 1;
  const expected = score[0] === score[1] ? -1 : score[0] > score[1] ? 0 : 1;
  if (winner !== expected) throw bad('winner does not match the score');
  return {
    player: addr(b.player, 'player'),
    callsign,
    team: int(b.team, 'team', 0, 1) as 0 | 1,
    points: int(b.points, 'points', 0, 100_000),
    seed: int(b.seed, 'seed', 0, 0xffffffff),
    stateHash: int(b.stateHash, 'stateHash', 0, 0xffffffff),
    teamSize: int(b.teamSize, 'teamSize', 1, 3),
    difficulty: b.difficulty as MatchReport['difficulty'],
    durationSec,
    score,
    winner,
    overtime: b.overtime,
  };
}

function parsePurchase(body: unknown): PurchaseRequest {
  const b = obj(body);
  if (typeof b.signature !== 'string' || !isHex(b.signature)) throw bad('signature must be hex');
  let permit: PurchaseRequest['permit'];
  if (b.permit !== undefined && b.permit !== null) {
    const p = obj(b.permit);
    if (typeof p.r !== 'string' || !isHex(p.r) || typeof p.s !== 'string' || !isHex(p.s)) throw bad('permit.r / permit.s must be hex');
    permit = { value: wei(p.value, 'permit.value'), deadline: int(p.deadline, 'permit.deadline', 0, 2 ** 40), v: int(p.v, 'permit.v', 0, 255), r: p.r as Hex, s: p.s as Hex };
  }
  return {
    buyer: addr(b.buyer, 'buyer'),
    itemId: int(b.itemId, 'itemId', 1, 1_000_000),
    maxPrice: wei(b.maxPrice, 'maxPrice'),
    deadline: int(b.deadline, 'deadline', 0, 2 ** 40),
    signature: b.signature as Hex,
    permit,
  };
}

// ------------------------------------------------------------------ errors / responses

const MESSAGES: Record<string, string> = {
  CooldownActive: 'Match rewards are cooling down — the next match can be rewarded shortly.',
  PointsAboveCap: 'That score is above the per-match reward cap.',
  AlreadyRecorded: 'This match was already recorded.',
  AlreadyOwned: 'You already own this item.',
  NotListed: 'This item is not for sale right now.',
  PriceAboveMax: 'The price changed — refresh and try again.',
  SignatureExpired: 'The purchase signature expired — try again.',
  InvalidSignature: 'The purchase signature is not valid for this wallet.',
  ERC20InsufficientBalance: 'Not enough NOVA.',
  ERC20InsufficientAllowance: 'The NOVA spending permit was not accepted — try again.',
  AccessControlUnauthorizedAccount: 'The relayer is not authorized on this deployment (GAME_SERVER_ROLE).',
};

function toHttpError(err: unknown): HttpError {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? 'reverted';
      const args = revert.data?.args ?? [];
      const retryAt = name === 'CooldownActive' ? Number(args[1]) : undefined;
      const status = name === 'AccessControlUnauthorizedAccount' ? 503 : name === 'CooldownActive' ? 429 : 409;
      return new HttpError(status, { error: name, message: MESSAGES[name] ?? revert.shortMessage, retryAt });
    }
    if (/insufficient funds/i.test(err.message)) {
      return new HttpError(503, { error: 'relayer_out_of_gas', message: 'The relayer is out of gas money — ping the NOVABALL team.' });
    }
    return new HttpError(502, { error: 'chain_error', message: err.shortMessage });
  }
  return new HttpError(500, { error: 'internal', message: err instanceof Error ? err.message : 'Unexpected error' });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}
