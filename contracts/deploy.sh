#!/usr/bin/env bash
# Deploy NOVABALL's contracts to a public network and point the web app at them.
#
#   ./deploy.sh                    # Arbitrum Sepolia (default)
#   ./deploy.sh arbitrum           # Arbitrum One (mainnet)
#   ./deploy.sh anvil              # local chain (or just use `npm run dev:local` in frontend/)
#
# Reads contracts/.env (see .env.example): PRIVATE_KEY is required on public networks; ETHERSCAN_API_KEY enables
# source verification on Arbiscan. Writes deployments/<chainId>.json and frontend/src/chain/deployments/<chainId>.json.
set -euo pipefail
cd "$(dirname "$0")"

NETWORK="${1:-arbitrum_sepolia}"
[ -f .env ] && set -a && . ./.env && set +a

case "$NETWORK" in
  arbitrum_sepolia | sepolia) NETWORK=arbitrum_sepolia; RPC="${ARBITRUM_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"; CHAIN_ID=421614 ;;
  arbitrum | arbitrum_one) NETWORK=arbitrum; RPC="${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}"; CHAIN_ID=42161 ;;
  anvil | local) NETWORK=anvil; RPC="http://127.0.0.1:8545"; CHAIN_ID=31337 ;;
  *) echo "unknown network '$NETWORK' (arbitrum_sepolia | arbitrum | anvil)"; exit 1 ;;
esac

ARGS=(script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow)
if [ "$NETWORK" != anvil ]; then
  if [ -z "${PRIVATE_KEY:-}" ]; then
    echo "PRIVATE_KEY is not set — copy .env.example to .env and fill it in."
    exit 1
  fi
  DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
  BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)
  echo "Deployer $DEPLOYER has $BALANCE ETH on $NETWORK"
  if [ "$(echo "$BALANCE" | awk '{print ($1 < 0.0005)}')" = 1 ]; then
    echo "That is not enough for gas. Get Arbitrum Sepolia ETH from a faucet (see .env.example) and retry."
    exit 1
  fi
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    ARGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    echo "(ETHERSCAN_API_KEY not set — skipping Arbiscan verification)"
  fi
fi

forge "${ARGS[@]}"

# keep the web app's ABIs in sync with what was just deployed
if command -v node > /dev/null; then node ../frontend/scripts/sync-abis.mjs; fi

cat <<NEXT

Deployed to $NETWORK (chain $CHAIN_ID). Addresses: deployments/$CHAIN_ID.json (also copied to the web app).

Next — run the game with its relayer against this chain:
  cd ../frontend
  echo "RELAYER_PRIVATE_KEY=<the key of RELAYER_ADDRESS (default: PRIVATE_KEY)>" >> .env.local
  npm run build && VITE_CHAIN_ID=$CHAIN_ID npm start         # serves dist/ + /api on :8787
Commit frontend/src/chain/deployments/$CHAIN_ID.json so production builds pick it up.
NEXT
