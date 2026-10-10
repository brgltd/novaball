# NOVABALL contracts

Solidity 0.8.28 · Foundry · OpenZeppelin 5.4 · deployed on **Arbitrum**.

| Contract | Standard | Role |
|---|---|---|
| [`NovaToken`](src/NovaToken.sol) | ERC-20 + ERC-2612 permit + burnable | **NOVA**, the game token. Minted only by the arena (`MINTER_ROLE`). |
| [`NovaArena`](src/NovaArena.sol) | AccessControl | Records finished matches (seed + deterministic final state hash + score) and mints `points × rewardPerPoint` NOVA to every human player. Keeps a career record per player (matches, wins, points, NOVA earned, callsign) for the leaderboard. |
| [`NovaGarage`](src/NovaGarage.sol) | ERC-1155 + EIP-712 | The cosmetics shop: one token id per car body / paint. Buying burns the NOVA price and mints the NFT. Metadata **and art** are fully on-chain ([`NovaArt`](src/NovaArt.sol)). |

```
 player plays a match ──► relayer (GAME_SERVER_ROLE) ──► NovaArena.recordMatch ──► NovaToken.mint(player, points × rate)
 player signs Purchase (+ Permit) ──► relayer ──► NovaGarage.buyForWithPermit ──► NOVA burned, NFT minted to player
```

## Gasless by design

Players never need ETH:

- **Rewards** are pushed by the game server — the player does nothing.
- **Purchases** are authorized with signatures only. The buyer signs an EIP-712 `Purchase(buyer, itemId, maxPrice, nonce, deadline)`
  and, if the garage has no allowance yet, an ERC-2612 `Permit` for the price. Anyone (the relayer) can submit them with
  `buyFor` / `buyForWithPermit` and pay the gas. `maxPrice` protects the buyer if the price changes in between; the nonce
  makes every signature single-use; a front-run permit cannot block the purchase (`try permit {} catch {}`);
  `SignatureChecker` also accepts ERC-1271 smart-contract wallets.
- A wallet with ETH can of course call `buy(id, maxPrice)` directly after `approve`.

## Trust model (what the contracts enforce)

Matches are simulated in the browser, so the reported points can't be proven on-chain today. The arena bounds what a
single report can do:

- only `GAME_SERVER_ROLE` can record matches;
- points per player per match are capped (`maxPointsPerMatch`, default 3000);
- a player can be rewarded at most once per `matchCooldown` (default 60 s — a real match lasts ≥ 2 min);
- an identical report can't be recorded twice;
- the match **seed** and the simulation's **final state hash** are stored in the `MatchRecorded` event. The game's
  simulation is deterministic (fixed step, no `Math.random` / transcendental functions), so the same seed + input log
  reproduces the same hash: anyone holding a replay can audit a reward, and server-side re-simulation is the natural
  next step to make rewards fully trustless.

## Economy (all adjustable)

| Setting | Default | Change it with |
|---|---|---|
| Car body price | 100 NOVA | `CAR_PRICE=… forge script script/Configure.s.sol --sig "prices()" …` |
| Paint price | 20 NOVA | `PAINT_PRICE=…` (same command) |
| One item | — | `forge script script/Configure.s.sol --sig "price(string,uint256)" toxic 35 …` |
| Reward | 0.5 NOVA / point (`REWARD_PER_100_POINTS=50`) | `forge script script/Configure.s.sol --sig "rewards()" …` |
| Reward cap / cooldown | 3000 pts / 60 s | `MAX_POINTS_PER_MATCH`, `MATCH_COOLDOWN` (same `rewards()` command) |

A goal is worth 100 match points, a save 50, a shot 20, a touch 2 — a decent rookie match pays ~100–200 NOVA, i.e. a
paint after one match and a car after one or two.

Catalog: cars `viper`, `titan`; paints `graphite`, `obsidian`, `chrome`, `crimson`, `cobalt`, `toxic`, `solar`, `violet`,
`rose` (STRIKER + ARCTIC are the free starter kit). New items: `NovaGarage.addItem(kind, key, name, color, price)`.

## Commands

```bash
forge build
forge test            # 42 tests incl. fuzzing (signatures, permits, caps, cooldowns, on-chain metadata)

# local chain — easiest: `npm run dev:local` in ../frontend (anvil + deploy + game + relayer)
anvil &
./deploy.sh anvil

# Arbitrum Sepolia
cp .env.example .env  # set PRIVATE_KEY (+ ETHERSCAN_API_KEY to verify on Arbiscan)
./deploy.sh           # checks the balance, deploys, verifies, writes the addresses for the web app
```

`deploy.sh` wraps `forge script script/Deploy.s.sol --broadcast --slow [--verify]`; the script writes
`deployments/<chainId>.json` and `../frontend/src/chain/deployments/<chainId>.json` (a dry run without `--broadcast`
writes nothing). Deploying costs ≈ 0.001 ETH on Arbitrum Sepolia.

Roles after deployment: the deployer is admin of all three contracts and curator of the garage; the relayer address
(`RELAYER_ADDRESS`, default = deployer) holds `GAME_SERVER_ROLE`; the arena holds `MINTER_ROLE`.
