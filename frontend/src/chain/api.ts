/**
 * Wire format between the web app and the NOVABALL relayer (server/relayer.ts), shared by both sides (no imports).
 *
 *   GET  /api/status    → RelayStatus
 *   POST /api/match     MatchReport     → MatchReceipt   (the server records the match and mints the reward)
 *   POST /api/purchase  PurchaseRequest → TxReceiptRef   (the server submits the player's signed purchase, pays gas)
 *   errors              → RelayError (HTTP 4xx / 5xx)
 */
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type DifficultyName = 'rookie' | 'pro' | 'legend';

/**
 * Match reports are signed, so nobody can file reports for someone else's address (and burn their reward cooldown).
 * A guest wallet signs MatchReport itself; an external wallet signs a Session once (at connect) that delegates to a
 * key kept in this browser, which then signs each MatchReport without a popup.
 */
export const REPORT_DOMAIN = { name: 'NOVABALL', version: '1' } as const;
export const SESSION_TYPES = {
  Session: [
    { name: 'player', type: 'address' },
    { name: 'sessionKey', type: 'address' },
    { name: 'expires', type: 'uint256' },
  ],
} as const;
export const REPORT_TYPES = {
  MatchReport: [
    { name: 'player', type: 'address' },
    { name: 'seed', type: 'uint256' },
    { name: 'stateHash', type: 'uint256' },
    { name: 'points', type: 'uint256' },
  ],
} as const;

export interface SessionGrant {
  key: Address;
  /** Unix seconds. */
  expires: number;
  /** The player's EIP-712 Session signature. */
  signature: Hex;
}

export interface MatchReport {
  player: Address;
  /** Pilot callsign (A–Z 0–9 space _ - ., max 12). */
  callsign: string;
  team: 0 | 1;
  /** The player's match score (scoreboard points). */
  points: number;
  /** MatchConfig.seed (uint32). */
  seed: number;
  /** The deterministic sim's state hash on the final tick (uint32). */
  stateHash: number;
  teamSize: number;
  difficulty: DifficultyName;
  durationSec: number;
  score: [number, number];
  winner: -1 | 0 | 1;
  overtime: boolean;
  /** EIP-712 MatchReport signature, by the player or by its session key. */
  signature: Hex;
  session?: SessionGrant;
}

export interface TxReceiptRef {
  hash: Hex;
}

export interface MatchReceipt extends TxReceiptRef {
  matchId: Hex;
  points: number;
  /** NOVA minted, wei (decimal string). */
  amount: string;
}

export interface PermitPayload {
  value: string;
  deadline: number;
  v: number;
  r: Hex;
  s: Hex;
}

export interface PurchaseRequest {
  buyer: Address;
  itemId: number;
  /** wei, decimal string */
  maxPrice: string;
  deadline: number;
  signature: Hex;
  /** ERC-2612 permit for the price, when the buyer's allowance is too low. */
  permit?: PermitPayload;
}

export interface RelayStatus {
  ok: true;
  chainId: number;
  relayer: Address;
  /** Relayer ETH balance, wei (decimal string). */
  balance: string;
  garage: Address;
  arena: Address;
}

export interface RelayError {
  /** Contract error name (e.g. CooldownActive) or a relayer code (bad_request, rate_limited, unavailable, ...). */
  error: string;
  message: string;
  /** Unix seconds when a retry can succeed (cooldowns / rate limits). */
  retryAt?: number;
}
