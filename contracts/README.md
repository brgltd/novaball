# NOVABALL contracts

Solidity 0.8.28 · Foundry · OpenZeppelin 5.4 · deployed on **Arbitrum**.

| Contract | Standard | Role |
|---|---|---|
| [`NovaToken`](src/NovaToken.sol) | ERC-20 + ERC-2612 permit + burnable | **NOVA**, the game token. Minted only by the arena (`MINTER_ROLE`), spent only in the garage (`SPENDER_ROLE`). |
| [`NovaArena`](src/NovaArena.sol) | AccessControl | Players claim finished matches: stores the seed + deterministic final state hash + score and mints `points × rewardPerPoint` NOVA to the claimer. Keeps a career record per player (matches, wins, points, NOVA earned, callsign) for the leaderboard. |
| [`NovaGarage`](src/NovaGarage.sol) | ERC-1155 | The cosmetics shop: one token id per car body / paint. Buying burns the NOVA price and mints the NFT. Metadata **and art** are fully on-chain ([`NovaArt`](src/NovaArt.sol)). |

```
 player finishes a match ──► NovaArena.claim(result, team, points, callsign) ──► NovaToken.mint(player, points × rate)
 player buys a cosmetic  ──► NovaGarage.buy(id, maxPrice) ──► NovaToken.spend(player, price) (burn) + NFT minted
```

Both are a single transaction sent (and paid for) by the player's own wallet.

## One transaction per action

- **Claim**: `claim(MatchResult, team, points, callsign)` — `msg.sender` is the player, so nobody can claim for someone
  else. The match id is `keccak256(abi.encode(player, result))`.
- **Buy**: the garage holds NOVA's `SPENDER_ROLE`, so `buy(id, maxPrice)` burns the price straight from `msg.sender` —
  no `approve` transaction first. The garage can only spend from the buyer that calls it. `maxPrice` protects the buyer
  if the price changes while the transaction is pending.

## Trust model (what the contracts enforce)

Matches are simulated in the browser, so the claimed points can't be proven on-chain today. The arena bounds what a
claim can do:

- points per match are capped (`maxPointsPerMatch`, default 3000);
- a player can claim at most once per `matchCooldown` (default 60 s — a real match lasts ≥ 2 min);
- the same match can't be claimed twice by the same player;
- every claim costs the player gas;
- the match **seed** and the simulation's **final state hash** are stored in the `MatchClaimed` event. The game's
  simulation is deterministic (fixed step, no `Math.random` / transcendental functions), so the same seed + input log
  reproduces the same hash: anyone holding a replay can audit a reward, and server-side re-simulation (a signed
  attestation checked by `claim`) is the natural next step to make rewards fully trustless.

## Economy (all adjustable)

| Setting | Default | Change it with |
|---|---|---|
| Car body price | 100 NOVA | `CAR_PRICE=… forge script script/Configure.s.sol --sig "prices()" …` |
| Paint price | 20 NOVA | `PAINT_PRICE=…` (same command) |
| One item | — | `forge script script/Configure.s.sol --sig "price(string,uint256)" toxic 35 …` |
| Reward | 1 NOVA / point (`REWARD_PER_100_POINTS=100`) | `forge script script/Configure.s.sol --sig "rewards()" …` |
| Reward cap / cooldown | 3000 pts / 60 s | `MAX_POINTS_PER_MATCH`, `MATCH_COOLDOWN` (same `rewards()` command) |

A goal is worth 100 match points, a save 50, a shot 20, a touch 2 — a first match typically pays 20–300 NOVA, so a
judge can buy a paint right away and a car after a match or two. Tighten the rate later for a longer progression.

Catalog: cars `viper`, `titan`; paints `graphite`, `obsidian`, `chrome`, `crimson`, `cobalt`, `toxic`, `solar`, `violet`,
`rose` (STRIKER + ARCTIC are the free starter kit). New items: `NovaGarage.addItem(kind, key, name, color, price)`.

## Commands

```bash
forge build
forge test            # 36 tests incl. fuzzing (claims, caps, cooldowns, purchases, on-chain metadata)

# local chain — easiest: `npm run dev:local` in ../frontend (anvil + deploy + game)
anvil &
./deploy.sh anvil

# Arbitrum Sepolia
cp .env.example .env  # set PRIVATE_KEY (+ ETHERSCAN_API_KEY to verify on Arbiscan)
./deploy.sh           # checks the balance, deploys, verifies, writes the addresses for the web app
```

`deploy.sh` wraps `forge script script/Deploy.s.sol --broadcast --slow [--verify]`; the script writes
`deployments/<chainId>.json` and `../frontend/src/chain/deployments/<chainId>.json` (a dry run without `--broadcast`
writes nothing). Deploying costs ≈ 0.001 ETH on Arbitrum Sepolia.

Roles after deployment: the deployer is admin of all three contracts and curator of the garage; the arena holds
NOVA's `MINTER_ROLE` and the garage holds NOVA's `SPENDER_ROLE`.
