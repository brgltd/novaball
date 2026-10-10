/**
 * Which chain the game talks to, and where. Build-time env (all optional):
 *   VITE_CHAIN_ID       31337 (local anvil; default in `vite` dev) | 421614 (Arbitrum Sepolia; default in builds) | 42161
 *   VITE_RPC_URL        JSON-RPC endpoint (default: the chain's public RPC; local: the dev server's /rpc proxy to anvil)
 * Contract addresses come from ./deployments/<chainId>.json, written by contracts/script/Deploy.s.sol. Without a
 * deployment for the chain, on-chain features are off and every cosmetic is unlocked (the game is unchanged).
 */
import type { Chain } from 'viem';
import { arbitrum, arbitrumSepolia, foundry } from 'viem/chains';

import type { Address } from './types';

export interface Deployment {
  chainId: number;
  nova: Address;
  garage: Address;
  arena: Address;
  startBlock?: number;
}

const deployments = import.meta.glob<Deployment>('./deployments/*.json', { eager: true, import: 'default' });

const env = import.meta.env;

export const CHAIN_ID = Number(env.VITE_CHAIN_ID || (env.DEV ? foundry.id : arbitrumSepolia.id));

const KNOWN: Record<number, Chain> = {
  [foundry.id]: { ...foundry, name: 'Local Anvil' },
  [arbitrumSepolia.id]: arbitrumSepolia,
  [arbitrum.id]: arbitrum,
};

export const CHAIN: Chain = KNOWN[CHAIN_ID] ?? { ...foundry, id: CHAIN_ID, name: `Chain ${CHAIN_ID}` };

export const DEPLOYMENT: Deployment | null = deployments[`./deployments/${CHAIN_ID}.json`] ?? null;

export const IS_LOCAL = CHAIN_ID === foundry.id;

function origin(): string {
  try {
    return location.origin;
  } catch {
    return 'http://localhost:5173';
  }
}

/** Browser-side RPC. Local anvil goes through the dev server (/rpc) so the game also works from another device. */
export const RPC_URL: string = env.VITE_RPC_URL || (IS_LOCAL ? `${origin()}/rpc` : CHAIN.rpcUrls.default.http[0]);

/** The RPC URL handed to an external wallet when it has to add the network. */
export const WALLET_RPC_URL: string = IS_LOCAL ? 'http://127.0.0.1:8545' : RPC_URL;

export const EXPLORER: string | null = CHAIN.blockExplorers?.default.url ?? null;

/** Short network label for badges. */
export const NETWORK_LABEL = IS_LOCAL ? 'LOCAL ANVIL' : CHAIN_ID === arbitrumSepolia.id ? 'ARBITRUM SEPOLIA' : CHAIN_ID === arbitrum.id ? 'ARBITRUM ONE' : CHAIN.name.toUpperCase();

/** Where to get gas money for the game's chain (testnet faucets, the bridge). */
export const GAS_SOURCES: ReadonlyArray<{ name: string; url: string }> =
  CHAIN_ID === arbitrumSepolia.id
    ? [
        { name: 'QuickNode faucet', url: 'https://faucet.quicknode.com/arbitrum/sepolia' },
        { name: 'Alchemy faucet', url: 'https://www.alchemy.com/faucets/arbitrum-sepolia' },
        { name: 'Bridge from Sepolia', url: 'https://bridge.arbitrum.io/?destinationChain=arbitrum-sepolia&sourceChain=sepolia' },
      ]
    : CHAIN_ID === arbitrum.id
      ? [{ name: 'Arbitrum bridge', url: 'https://bridge.arbitrum.io/' }]
      : [];

/** Gas units of a first reward claim (measured: ~215k) and of a garage purchase (~75k), with headroom. */
export const CLAIM_GAS = 260_000n;
export const BUY_GAS = 110_000n;

export function txUrl(hash: string): string | null {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : null;
}

export function addressUrl(address: string): string | null {
  return EXPLORER ? `${EXPLORER}/address/${address}` : null;
}

export function tokenUrl(contract: string, id?: number): string | null {
  if (!EXPLORER) return null;
  return id === undefined ? `${EXPLORER}/token/${contract}` : `${EXPLORER}/token/${contract}?a=${id}`;
}
