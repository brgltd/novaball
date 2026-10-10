/** The game's on-chain layer (NOVA token, garage NFTs, arena rewards). One shared instance. */
import { NovaChain } from './NovaChain';

export const chain = new NovaChain();

export * from './NovaChain';
export * from './config';
export * from './format';
export { exportGuestKey, walletOptions } from './wallet';

// dev builds: inspect / drive the on-chain layer from the console (window.__nova.state, __nova.refresh(), ...)
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __nova: NovaChain }).__nova = chain;
