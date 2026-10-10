/** The game's on-chain layer (NOVA token, garage NFTs, arena rewards). One shared instance. */
import { NovaChain } from './NovaChain';

export const chain = new NovaChain();

export * from './NovaChain';
export * from './config';
export * from './format';
export { exportGuestKey, walletOptions } from './wallet';
