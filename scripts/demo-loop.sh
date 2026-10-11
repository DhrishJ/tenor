#!/usr/bin/env bash
# Live liquidation loop for the demo video, on the FINAL deployment. Run from
# a terminal while the browser films the Market and Activity pages.
#
#   scripts/demo-loop.sh fund <wallet>        send 0.2 MON gas to the filmed borrower wallet
#   scripts/demo-loop.sh status <wallet>      position, health factor, mock price
#   scripts/demo-loop.sh drop [price]         MOCK ORACLE: set tCOLL to price (default 1.40)
#   scripts/demo-loop.sh liquidate <wallet>   our second wallet (ADV_LIQUIDATOR) liquidates it
#   scripts/demo-loop.sh restore              MOCK ORACLE: back to $2.00. Always run this after.
#
# The mock price moves for the whole market, not just the filmed wallet:
# restore it straight after the take. Keys come from .env, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"
RPC=https://testnet-rpc.monad.xyz
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
D=deployments/10143.json
MKT=$(jq -r .tenorMarket $D); REG=$(jq -r .scoreRegistry $D); ORC=$(jq -r .mockPriceOracle $D); USD=$(jq -r .tUSD $D); COLL=$(jq -r .tCOLL $D)
send() { cast send "$@" --rpc-url $RPC --json | jq -r '"  tx \(.transactionHash) status \(.status)"'; }
wei() { cast to-wei "$1" ether; }

case "${1:-}" in
  fund)
    send "$2" --value 0.2ether --private-key "$(env_get DEPLOYER_PRIVATE_KEY)" ;;
  status)
    echo "position (collateral, debt, tier, score): $(cast call $MKT 'getPosition(address)(uint256,uint256,uint8,uint16)' "$2" --rpc-url $RPC | tr '\n' ' ')"
    echo "health factor (1e18 = 1.0): $(cast call $MKT 'healthFactor(address)(uint256)' "$2" --rpc-url $RPC 2>&1 | head -1)"
    echo "mock tCOLL price: $(cast call $ORC 'getPrice(address)(uint256,uint256)' $COLL --rpc-url $RPC | head -1)"
    echo "liquidation record: $(cast call $REG 'getLiquidationRecord(address)((uint64,uint32,uint32,uint256))' "$2" --rpc-url $RPC)" ;;
  drop)
    echo "MOCK ORACLE: tCOLL -> \$${2:-1.40}"
    send $ORC 'setPrice(address,uint256)' $COLL "$(wei "${2:-1.40}")" --private-key "$(env_get ORACLE_KEEPER_PRIVATE_KEY)" --gas-limit 120000 ;;
  restore)
    echo "MOCK ORACLE: tCOLL -> \$2.00"
    send $ORC 'setPrice(address,uint256)' $COLL "$(wei 2)" --private-key "$(env_get ORACLE_KEEPER_PRIVATE_KEY)" --gas-limit 120000 ;;
  liquidate)
    LK=$(env_get ADV_LIQUIDATOR_PRIVATE_KEY); L=$(cast wallet address --private-key "$LK")
    BAL=$(cast call $USD 'balanceOf(address)(uint256)' "$L" --rpc-url $RPC | cut -d' ' -f1)
    if [ "$(echo "$BAL < 1000000000000000000000" | bc)" = 1 ]; then echo "liquidator: tUSD faucet"; send $USD 'faucet()' --private-key "$LK" --gas-limit 150000; fi
    send $USD 'approve(address,uint256)' $MKT "$(wei 1000)" --private-key "$LK" --gas-limit 100000
    echo "liquidator $L liquidates $2"
    send $MKT 'liquidate(address,uint256)' "$2" "$(wei 1000)" --private-key "$LK" --gas-limit 600000 ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
