# NOVABALL

**Hover-car football at the edge of the galaxy — with an on-chain economy on Arbitrum.**

Play a match in the browser (no wallet needed) → hit **CLAIM REWARDS** to mint your match points as **NOVA** tokens to
your own wallet → spend NOVA on **NFT** car bodies and paints in the garage → drive them. Connect MetaMask, Brave Wallet,
Phantom or any EIP-6963 browser wallet; claims and purchases are one transaction each, gas paid in Arbitrum Sepolia ETH.

```
frontend/    the game (TypeScript + three.js, Vite) + the chain layer (viem) — a static site
contracts/   Solidity + Foundry: NovaToken (ERC-20), NovaGarage (ERC-1155), NovaArena (rewards)
```

## The 60-second judge tour

You need a browser wallet with a little **Arbitrum Sepolia ETH** for gas (a claim costs a fraction of a cent; free from
the [QuickNode](https://faucet.quicknode.com/arbitrum/sepolia) or [Alchemy](https://www.alchemy.com/faucets/arbitrum-sepolia)
faucets, or [bridge](https://bridge.arbitrum.io/?destinationChain=arbitrum-sepolia&sourceChain=sepolia) Sepolia ETH).
The game tells you all of this where it matters, and links the faucets.

1. Open the game and **PLAY** a 2-minute match — no wallet, no sign-up.
2. On the end screen, the reward card shows **+N NOVA** (1 NOVA per match point). Hit **CONNECT & CLAIM**: pick your
   wallet, approve the network switch, confirm one transaction. The card flips to *CLAIMED* and the *VERIFIABLE MATCH*
   badge becomes *RECORDED ON-CHAIN*, linking to the transaction. (No ETH yet? The card says so and links the faucets.
   Not now? The reward waits until your next match — claim it later from the WALLET screen.)
3. **GARAGE** → pick a locked car or paint: it previews on the stage with a price tag. **BUY** → one transaction, the
   NFT is minted and equipped.
4. **WALLET** → connect / disconnect, NOVA balance, gas balance with faucet links, career stats, your NFTs, every
   transaction with explorer links, the three contracts. **LEADERBOARD** → every pilot, read live from the chain.

## Blockchain features

| | How |
|---|---|
| **NOVA token** (ERC-20 + permit) | Minted by `NovaArena` when a player claims a match: `1 NOVA per match point` |
| **Proportional match rewards** | `NovaArena.claim` stores the match seed, the deterministic simulation's final-state hash, the score and the player's points on-chain, and mints the reward to the player |
| **NFT cosmetics** (ERC-1155, on-chain SVG art) | Cars 100 NOVA, paints 20 NOVA (configurable). `NovaGarage.buy` burns the NOVA and mints the NFT — one transaction, no approve step |
| **Ownership-gated garage** | STRIKER + ARCTIC are free; everything else needs the NFT in your wallet. Locked items still preview |
| **On-chain career + leaderboard** | Matches, wins, points, NOVA earned, callsign per player |

Contract details, trust model and economy knobs: [contracts/README.md](contracts/README.md).

## Architecture

```
 browser (static site) ─────────────────────────────────────────┐          Arbitrum
 │  game (three.js) ──end of match──► NovaChain (viem)            │
 │                                     │ unclaimed reward kept    │  reads   ┌─────────────┐
 │                                     │ in localStorage          ├─────────►│ NovaToken   │
 │                                     │                          │          │ NovaGarage  │
 │  CLAIM REWARDS / BUY ─────────────► │ browser wallet (EIP-6963)├─────────►│ NovaArena   │
 │                                     │ MetaMask · Brave · Phantom  txs     └─────────────┘
 └────────────────────────────────────────────────────────────────┘  (gas paid by the player)
```

**Tech choices.** The game is framework-free TypeScript, so the chain layer is **viem** alone (no React, so no wagmi):
typed contract calls from the generated ABIs, EIP-6963 discovery for browser wallets (with a `window.ethereum`
fallback), automatic network switch / add, and every transaction simulated first so failures read as plain messages
("one claim per minute", "you already own this NFT") instead of wallet errors. There is no backend: the game is a static
site, so it hosts anywhere (Vercel, GitHub Pages, IPFS). Arbitrum's ~250 ms blocks and sub-cent fees make a
transaction per match cheap and quick.

**Graceful degradation.** No deployment for the chain → on-chain features switch off and every cosmetic is unlocked
(the game is unchanged). No wallet → the game plays normally and the last match's reward waits to be claimed.
RPC down → cached balance / ownership.

## Run it locally (one command)

Requirements: Node ≥ 22.12, [Foundry](https://getfoundry.sh).

```bash
git clone --recursive <repo> && cd colosseum-2026/frontend   # or: git submodule update --init --recursive
npm install
npm run dev:local
```

`dev:local` starts **anvil** (state persisted in `contracts/.anvil/`), deploys the contracts if needed, and runs the game
with an `/rpc` proxy to anvil — open the printed URL. When you claim, the game asks your wallet to add the local network
(chain 31337, RPC `http://127.0.0.1:8545`); then use **GET 10 TEST ETH** (wallet screen, or the claim card) for gas.
`npm run dev:local -- --fresh` starts from an empty chain (after changing the contracts) — reset your wallet's activity
for that network afterwards, or it will reuse stale nonces.

Tests: `cd contracts && forge test` (36 Solidity tests incl. fuzzing) · `cd frontend && npm test` (game + chain helpers).

## Deploy to Arbitrum Sepolia

```bash
cd contracts
cp .env.example .env            # PRIVATE_KEY=0x… (needs ~0.001 ETH: faucets listed in the file), ETHERSCAN_API_KEY optional
./deploy.sh                     # deploys, verifies on Arbiscan, writes frontend/src/chain/deployments/421614.json
```

Commit `frontend/src/chain/deployments/421614.json`, then deploy the static site. On **Vercel**: import the repo, set the
root directory to `frontend` (framework preset *Vite*, build `npm run build`, output `dist`) — that's it, there is no
server and no secret. Production builds target Arbitrum Sepolia by default (`VITE_CHAIN_ID=421614`); optional build
variables are in [frontend/.env.example](frontend/.env.example).

Prices and rewards can be changed after deployment without redeploying — see [contracts/README.md](contracts/README.md#economy-all-adjustable).

## Why Arbitrum

A reward claim after every match and an NFT mint per purchase only make sense on a chain with fast blocks and tiny fees:
on Arbitrum a claim confirms in about a second and costs a fraction of a cent, so asking the player for one transaction
per match is reasonable. It's plain EVM, so the same contracts, Foundry scripts and viem code target Arbitrum One
unchanged (`./deploy.sh arbitrum`, `VITE_CHAIN_ID=42161`).

## Roadmap

- Sponsored gas (a relayer, or ERC-4337 paymasters) so new players can claim without ETH — an earlier version of this
  repo had a relayer + guest wallet; it's in the git history.
- Server-side re-simulation of the input log to make rewards fully trustless (the sim is already deterministic).
- Multiplayer matches, with every human's reward in one record.

## Further documents

- [Game Design](frontend/docs/DESIGN.md)

## Contact Info

- brgltdxyz@gmail.com
