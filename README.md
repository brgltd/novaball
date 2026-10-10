# NOVABALL

**Hover-car football at the edge of the galaxy — with an on-chain economy on Arbitrum that you never have to think about.**

Play a match in the browser → your match points mint **NOVA** tokens → spend NOVA on **NFT** car bodies and paints in the
garage → drive them. No extension, no faucet, no gas, no popups: a guest wallet is created for you and a relayer pays
every transaction. Bring your own wallet (MetaMask, Rabby, Coinbase…) if you prefer — it only ever signs typed data.

```
frontend/    the game (TypeScript + three.js, Vite) + the chain layer (viem) + the relayer (server/)
contracts/   Solidity + Foundry: NovaToken (ERC-20), NovaGarage (ERC-1155), NovaArena (rewards)
```

## The 60-second judge tour

1. Open the game. The title screen shows your **NOVA** wallet card (top right) — a guest wallet already exists.
2. **PLAY** a 2-minute match. On the end screen the **NOVA EARNED** card counts up and flips to *MINTED* when the
   reward transaction lands on Arbitrum (≈ 1 s). The *VERIFIABLE MATCH* badge becomes *RECORDED ON-CHAIN* and links to it.
3. **GARAGE** → pick a locked car or paint: it previews on the stage with a price tag. **BUY** → it's minted as an NFT
   and equipped. (Not enough NOVA? The button says *EARN NOVA* and takes you to a match.)
4. **WALLET** → balance, career stats, your NFTs, every transaction with explorer links, the three contracts, and
   *CONNECT METAMASK* / *EXPORT KEY* if you want to take the assets elsewhere.

## Blockchain features

| | How | Why it's frictionless |
|---|---|---|
| **NOVA token** (ERC-20 + permit) | Minted by `NovaArena` when a match is recorded: `1 NOVA per match point` for every human player | Pushed by the game server — the player signs nothing |
| **Proportional match rewards** | The relayer records seed, deterministic final-state hash, score and each player's points on-chain | Happens while the end screen animates |
| **NFT cosmetics** (ERC-1155, on-chain SVG art) | Cars 100 NOVA, paints 20 NOVA (configurable). Buying burns the NOVA | EIP-712 purchase + ERC-2612 permit signatures; the relayer submits and pays gas |
| **Ownership-gated garage** | STRIKER + ARCTIC are free; everything else needs the NFT in your wallet | Locked items still preview, so you see what you're buying |
| **On-chain career** | Matches, wins, points, NOVA earned, callsign per player | Read live by the wallet screen |

Contract details, trust model and economy knobs: [contracts/README.md](contracts/README.md).

## Architecture

```
 browser ─────────────────────────────────────────────┐        Arbitrum
 │  game (three.js) ──end of match──► NovaChain (viem)  │
 │                                   │  guest wallet   │        ┌─────────────┐
 │                                   │  or EIP-6963    │  reads │ NovaToken   │
 │                                   │  wallet         ├───────►│ NovaGarage  │
 │                                   └──┬─────────────┘│        │ NovaArena   │
 └──────────────────────────────────────┼──────────────┘        └──────▲──────┘
                    POST /api/match     │  POST /api/purchase           │ txs (gas paid by the relayer)
                    (report)            ▼  (signatures)                 │
                              relayer (server/relayer.ts) ──────────────┘
                              GAME_SERVER_ROLE · validates · rate-limits · simulates before sending
```

**Tech choices.** The game is framework-free TypeScript, so the chain layer is **viem** alone (no React, so no wagmi):
typed contract calls from the generated ABIs, a local-account guest wallet, and EIP-6963 discovery for browser wallets.
The relayer is a single `Request → Response` handler (also viem) mounted by the Vite dev server, by a tiny Node server
for production (`npm start`), or anywhere that speaks the Fetch API. Arbitrum's ~250 ms blocks and sub-cent fees make
"a transaction per match" invisible to the player.

**Graceful degradation.** No deployment for the chain → on-chain features switch off and every cosmetic is unlocked
(the game is unchanged). RPC down → cached balance / ownership. Relayer down → rewards show *offline*; a browser wallet
holding ETH can still buy directly.

## Run it locally (one command)

Requirements: Node ≥ 22.12, [Foundry](https://getfoundry.sh).

```bash
git clone --recursive <repo> && cd colosseum-2026/frontend   # or: git submodule update --init --recursive
npm install
npm run dev:local
```

`dev:local` starts **anvil** (state persisted in `contracts/.anvil/`), deploys the contracts if needed, and runs the game
with the relayer at `/api` and an `/rpc` proxy to anvil — open the printed URL. `npm run dev:local -- --fresh` starts
from an empty chain (after changing the contracts).

Tests: `cd contracts && forge test` (42 Solidity tests incl. fuzzing) · `cd frontend && npm test` (game + relayer).

## Deploy to Arbitrum Sepolia

```bash
cd contracts
cp .env.example .env            # PRIVATE_KEY=0x… (needs ~0.001 ETH: faucets listed in the file), ETHERSCAN_API_KEY optional
./deploy.sh                     # deploys, verifies on Arbiscan, writes frontend/src/chain/deployments/421614.json
```

Then host the game + relayer (one Node process, e.g. Render / Railway / Fly / any VM):

```bash
cd frontend
npm ci && npm run build         # builds for Arbitrum Sepolia by default (VITE_CHAIN_ID=421614)
RELAYER_PRIVATE_KEY=0x… npm start   # serves dist/ and /api on $PORT (default 8787)
```

`RELAYER_PRIVATE_KEY` is the key of the address that got `GAME_SERVER_ROLE` (by default the deployer, so the same key).
Keep it topped up with a little Arbitrum Sepolia ETH — a match reward or a purchase costs a fraction of a cent.
To host the static game elsewhere (Vercel, GitHub Pages, IPFS…), build it with `VITE_RELAYER_URL=https://<relayer>/api`
and run `npm start` wherever the relayer lives (CORS is open). All env vars: [frontend/.env.example](frontend/.env.example).

Prices and rewards can be changed after deployment without redeploying — see [contracts/README.md](contracts/README.md#economy-all-adjustable).
