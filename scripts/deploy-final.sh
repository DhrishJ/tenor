#!/usr/bin/env bash
# Final deployment (Phase 5 §4): one scripted path, so addresses can't drift
# between the chain, the repo and the hosted services. Stops at the first
# failure. Keys come from the repo-root .env and are never printed.
#
#   scripts/deploy-final.sh
#
# Afterwards (printed at the end): commit, push main (Railway and Vercel
# redeploy from it), push main:envio (Envio redeploys), relay a fresh
# attestation for the demo wallet, then check every hosted service.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"
RPC=https://testnet-rpc.monad.xyz
CHAIN=10143
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
say() { printf '\n== %s\n' "$*"; }

say "1. preflight"
git diff --quiet && git diff --cached --quiet || { echo "uncommitted changes; commit first"; exit 1; }
[ "$(cast chain-id --rpc-url $RPC)" = "$CHAIN" ] || { echo "RPC is not chain $CHAIN"; exit 1; }
DEPLOYER_KEY=$(env_get DEPLOYER_PRIVATE_KEY)
ATTESTOR=$(env_get ATTESTOR_ADDRESS)
KEEPER=$(env_get ORACLE_KEEPER_ADDRESS)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
BAL=$(cast balance "$DEPLOYER" --ether --rpc-url $RPC)
echo "deployer $DEPLOYER balance $BAL MON; attestor $ATTESTOR; oracle keeper $KEEPER"
awk -v b="$BAL" 'BEGIN { exit !(b >= 1.2) }' || { echo "need >= 1.2 MON"; exit 1; }
(cd contracts && forge test -q >/dev/null) && echo "forge test: all pass"

say "2. archive the rehearsal deployment record"
if [ -f deployments/$CHAIN.json ]; then
  OLD=$(jq -r .scoreRegistry deployments/$CHAIN.json)
  if [ ! -f deployments/$CHAIN-rehearsal.json ]; then
    jq '. + {role: "rehearsal (superseded; adversarial pass ran here)"}' deployments/$CHAIN.json > deployments/$CHAIN-rehearsal.json
    echo "rehearsal registry $OLD archived to deployments/$CHAIN-rehearsal.json"
  fi
fi

say "3. deploy (committed script, mock collateral at \$2.00)"
(cd contracts && ATTESTOR_ADDRESS="$ATTESTOR" ORACLE_OWNER="$KEEPER" MAX_PRICE_AGE=604800 \
  GLOBAL_DEBT_CAP=1000000000000000000000000 SEED_LIQUIDITY=100000000000000000000000 \
  COLL_PRICE_WAD=2000000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC --private-key "$DEPLOYER_KEY" --broadcast --slow 2>&1 \
  | grep -E "ONCHAIN EXECUTION COMPLETE|Error|error" )
D=deployments/$CHAIN.json
REG=$(jq -r .scoreRegistry $D); MKT=$(jq -r .tenorMarket $D); ORC=$(jq -r .mockPriceOracle $D); COLL=$(jq -r .tCOLL $D)
[ "$REG" != "${OLD:-}" ] || { echo "registry unchanged: deploy did not write a new file"; exit 1; }

say "4. on-chain wiring"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1: $2"; else echo "FAIL  $1: got $2, want $3"; fail=1; fi; }
lc() { tr 'A-F' 'a-f'; }
check "registry.attestor" "$(cast call $REG 'attestor()(address)' --rpc-url $RPC | lc)" "$(echo $ATTESTOR | lc)"
check "registry.isMarket" "$(cast call $REG 'isMarket(address)(bool)' $MKT --rpc-url $RPC)" "true"
check "oracle.owner" "$(cast call $ORC 'owner()(address)' --rpc-url $RPC | lc)" "$(echo $KEEPER | lc)"
check "tCOLL price" "$(cast call $ORC 'getPrice(address)(uint256,uint256)' $COLL --rpc-url $RPC | head -1 | cut -d' ' -f1)" "2000000000000000000"
check "market.totalAssets" "$(cast call $MKT 'totalAssets()(uint256)' --rpc-url $RPC | cut -d' ' -f1)" "100000000000000000000000"
check "market.maxPriceAge" "$(cast call $MKT 'maxPriceAge()(uint256)' --rpc-url $RPC | cut -d' ' -f1)" "604800"
check "market.paused" "$(cast call $MKT 'paused()(bool)' --rpc-url $RPC)" "false"
[ $fail = 0 ] || exit 1

say "5. source verification (Sourcify via BlockVision; Foundry 1.8.3, solc 0.8.36, prague, 200 runs, bytecode_hash none)"
(cd contracts && jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName) \(.contractAddress)"' broadcast/Deploy.s.sol/$CHAIN/run-latest.json \
  | while read -r name addr; do
      forge verify-contract "$addr" "$name" --chain $CHAIN --verifier sourcify \
        --verifier-url https://sourcify-api-monad.blockvision.org/ --watch >/dev/null 2>&1 || true
      m=$(curl -s "https://sourcify-api-monad.blockvision.org/v2/contract/$CHAIN/$addr" | jq -r '.match // "none"')
      echo "$name $addr: $m"
      [ "$m" = match ] || [ "$m" = exact_match ] || { echo "verification failed for $name"; exit 1; }
    done)

say "6. indexer config for the new deployment"
(cd indexer && CHAIN_ID=$CHAIN RPC_URL=$RPC node scripts/gen-config.mjs)

say "done: $(jq -c '{scoreRegistry, tenorMarket, mockPriceOracle, tUSD, tCOLL, startBlock}' $D)"
cat <<EOF

Next (each one checked):
  git add deployments indexer/config.yaml contracts/broadcast && git commit && git push
  git push origin main:envio                  # Envio redeploys; new endpoint -> INDEXER_URL (Railway) + NEXT_PUBLIC_INDEXER_URL (Vercel)
  relay a fresh attestation for the demo wallet to $REG
EOF
