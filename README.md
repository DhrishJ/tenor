# Tenor

> **Monad testnet. Mock oracle. Unaudited. Not for production use.**

Tenor is an overcollateralized lending market on Monad testnet (chain
10143) where your borrowing history changes your terms. A wallet's
ChainScore credit score sets its tier. The tier sets maximum LTV (60–80%),
liquidation threshold (LTV + 5 points) and per-wallet cap (1k–20k tUSD).
Nobody is turned away: an unscored wallet, or one whose score has expired,
borrows at floor terms. A liquidation on Tenor feeds back: it invalidates
the on-chain score in the same transaction, and the next score carries a
penalty and a tier cap.

Built for Monad Metropolis (Onchain Finance track). ChainScore is the
author's prior work, called only through its public API. No ChainScore code
is in this repository (`INVENTORY.md` records what exists there;
`PROVENANCE.md`, due before submission per `PLAN.md`, will give the full
split).

**Status (2026-09-24):** built and tested locally; testnet deployment in
progress. Deployed addresses, live URLs and explorer verification go
here when the final deployment is frozen (OBJECTIONS P4-O7).

## How it works

```
wallet ──► attestor (packages/attestor) ──► ChainScore API (per chain, untrusted)
               │  independent borrowing-history check: HyperSync, Alchemy fallback
               │  validation → minimum across chains → Tenor policy (penalty, caps)
               ▼
      EIP-712 attestation ──► ScoreRegistry ──► TenorMarket (tiered terms)
                                                    │
                                   Envio HyperIndex ◄┘ (history, Activity page)
```

- **Contracts** (`contracts/`): `RiskParams` (tiers), `ScoreRegistry`
  (verifies EIP-712 attestations, 48 h max TTL, invalidates on
  liquidation), `TenorMarket` (ERC-4626 lender shares, tiered borrowing,
  liquidation with bad-debt handling). Details and test coverage:
  `CONTRACTS.md`.
- **Attestor** (`packages/attestor`): returns one of three states:
  SCORED, INSUFFICIENT_HISTORY, UNAVAILABLE. It never turns missing data
  into a low score.
- **Indexer** (`indexer/`): Envio HyperIndex. History and aggregates only;
  current state is always read from the chain.
- **Web** (`apps/web`): Score, Compare, Market, Activity.

## What is real and what is mocked

- **Real:** ChainScore scores (live API), the borrowing-history check
  (live HyperSync / Alchemy against Aave and Compound on Ethereum,
  Arbitrum, Optimism, Polygon, Base, Avalanche, Scroll), EIP-712
  signatures verified on-chain, all market logic.
- **Mocked:** both tokens (tUSD, tCOLL, with an hourly faucet) and the
  **price oracle**. No Chainlink feed exists on Monad testnet, and Pyth's
  MON/USD price was 15 days old when checked (2026-09-22). The oracle's
  owner can move prices, which is how the liquidation demo works, and
  which means that owner can make any position liquidatable.
- **Price age:** the market rejects prices older than 7 days, not
  minutes. A keeper re-stamps the prices daily with its own throwaway
  key (not the deployer's), and the attestor's `/health` reports
  **degraded** if it's overdue. With a real feed this would be minutes.
  On a hand-set testnet price, a short limit would only mean a judge
  arriving on day 3 can't borrow (OBJECTIONS P4-O3, P4-O13).

## Honest limitations

- **Base and Optimism borrowers are refused (UNAVAILABLE).** ChainScore's
  Aave data for those chains is degraded on its current Etherscan plan.
  Tenor refuses rather than score a wallet with a borrowing chain it can't
  see.
- **Scroll can't be scored.** ChainScore answers Scroll requests with
  Ethereum data (upstream issue DhrishJ/chainscore#21), so Tenor never
  asks it about Scroll. A wallet with Scroll borrowing is refused, and
  ChainScore is not queried at all (checked live 2026-09-24,
  `docs/adversarial/`). **That guard depends on HyperSync**, the only
  source here that sees Scroll, which has refused this project's
  connections twice. With HyperSync down, a wallet that borrowed on both
  Ethereum and Scroll would be scored on Ethereum alone.
- **HyperSync has refused connections from the development machine**
  (2026-09-22 and 2026-09-23). The Alchemy fallback covers Aave on five
  chains; Compound, Avalanche and Scroll are then unverified, and the
  response says so. Moving the attestor to a hosted service with a stable IP
  doesn't necessarily fix this (the block may be per token).
- **The consistency check was captured once, not reproducible now.** On
  2026-09-23, wallet `0x09f2e285…5bef` was refused because ChainScore
  returned an empty Polygon transaction history while the chain showed 9
  borrows (`docs/distribution/pipeline-2026-09-23.jsonl`). That was a
  real wallet on a real date. The upstream data has since recovered: the
  same wallet now scores normally. The rule is unit-tested, and any replay
  is labelled as one.
- **Aggregation is the minimum across chains.** It's a conservative
  heuristic, not a validated model.

## The distribution check (2026-09-23)

- **Run 1** (50 borrowers, ChainScore's own view of where they borrowed):
  - 46 scored: A 36, B 8, C 1, D 1, floor 0.
  - Only 4 of 50 were multi-chain. For those four, the minimum rule
    changed the tier in 2, and was at least 50 points below the average in
    1.
  - These are four wallets, not a distribution. They show that the rule
    changes outcomes. They can't show that it's right.
- **Run 2** (the real pipeline): the history check completed for 20
  wallets. 40% of those were UNAVAILABLE because they borrowed on Base or
  Optimism, and 1 was refused by the consistency check.
- **A full pipeline distribution couldn't be completed**, because HyperSync
  blocked the development machine.
- Raw results are archived in `docs/distribution/`.

## Why not undercollateralized

Uncollateralized or undercollateralized credit needs recourse (identity,
legal agreements, collections) and a score validated against real
defaults. Tenor has neither. What a score can safely do onchain is adjust
the terms of an overcollateralized loan within bounds where the collateral
still covers the debt. Tenor does only that.

## Run it locally

Tested on macOS (arm64) from a clean clone, following exactly these steps
(see "Clean-clone test" in `RUNNING_LOG.md`).

**Prerequisites:** git, Node 24, Foundry 1.8.3 (`foundryup -i 1.8.3`), and
Docker (only for the indexer). You also need a free Envio API token
(envio.dev/app/api-tokens). An Alchemy key is optional.

```bash
git clone --recurse-submodules https://github.com/DhrishJ/tenor.git
cd tenor
```

**1. Contracts: build and test**

```bash
cd contracts
forge build
forge test
cd ..
```

**2. Local chain and deployment.** In a separate terminal, run
`anvil --network monad --block-time 1`. The block time makes timestamps
track real time; without it, attestations fail with `IssuedInFuture`. Then
deploy with anvil's well-known test accounts (#0 deployer, #1 attestor
signer). These are public keys, local only:

```bash
M="test test test test test test test test test test test junk"
export DEPLOYER_KEY=$(cast wallet private-key "$M" 0)
export LOCAL_ATTESTOR_KEY=$(cast wallet private-key "$M" 1)
cd contracts
ATTESTOR_ADDRESS=$(cast wallet address --private-key $LOCAL_ATTESTOR_KEY) \
MAX_PRICE_AGE=604800 GLOBAL_DEBT_CAP=1000000000000000000000000 \
SEED_LIQUIDITY=100000000000000000000000 COLL_PRICE_WAD=2000000000000000000000 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER_KEY --broadcast
cd ..
```

This writes `deployments/31337.json`, which every other component reads.

**3. Attestor** (another terminal, same exports):

```bash
cd packages/attestor
npm ci
npm test
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 \
ATTESTOR_PRIVATE_KEY=$LOCAL_ATTESTOR_KEY ENVIO_API_TOKEN=<your token> \
CHAINSCORE_BASE_URL=https://chainscore.dev CORS_ORIGINS=http://localhost:3000 \
npm run dev
```

It listens on :8787. `curl localhost:8787/health` lists every dependency.
Locally the store is in memory. With `DATABASE_URL` set, it uses Postgres,
and off the local chain it refuses to start without Postgres. To replay
recorded history instead of querying it live, add
`HISTORY_FIXTURE=fixtures/recorded-history-2026-09-23.json`. Every response
is then labelled FIXTURE, and it refuses to start on any chain but 31337.

**4. Indexer** (optional; needs Docker running):

```bash
cd indexer
npm ci
npm run abis
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 npm run config
ENVIO_API_TOKEN=<your token> npm run dev
```

GraphQL is served at http://localhost:8080/v1/graphql. The local admin
secret is Envio's dev default, `testing`.

**5. Web app:**

```bash
cd apps/web
npm ci
cat > .env.local <<'EOF'
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_CHAIN_NAME=Anvil (Monad mode)
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_ATTESTOR_URL=http://localhost:8787
NEXT_PUBLIC_INDEXER_URL=http://localhost:8080/v1/graphql
NEXT_PUBLIC_INDEXER_DEV_SECRET=testing
EOF
npm run dev
```

Open http://localhost:3000. To connect, point a browser wallet at
`http://127.0.0.1:8545` (chain 31337) and import one of anvil's test
accounts. Or, locally only, set `NEXT_PUBLIC_DEV_WALLET` to an anvil
account for a dev-wallet button.

**End-to-end script:** `packages/attestor/scripts/e2e-local.ts` runs the
whole loop (score, attest, borrow, price drop, liquidation, re-score)
against the local deployment.

## Tests

| Component | Command | Count (2026-09-24) |
|---|---|---|
| Contracts | `forge test` (unit, fuzz, invariant, journey, reentrancy) | 153 |
| Attestor | `npm test` (Postgres store tests also run when `TEST_DATABASE_URL` is set) | 74 |
| Indexer | `npm test` | 3 |

Static analysis: `docs/audit/SLITHER.md` (Slither 0.11.6, triaged; plus a
checks-effects-interactions review).

## Repository map

| Path | What |
|---|---|
| `contracts/` | Solidity (Foundry 1.8.3, solc 0.8.36, OpenZeppelin 5.6.1) |
| `packages/attestor/` | Attestation service (Hono, viem) and its container image |
| `indexer/` | Envio HyperIndex |
| `apps/web/` | Next.js app |
| `deployments/` | Addresses per chain, written by the deploy script |
| `docs/` | Distribution check, adversarial runs, static analysis |
| `OBJECTIONS.md` | Every decision we pushed back on, and how it was resolved |
| `RUNNING_LOG.md` | Dated log of what happened, including what went wrong |
| `BOUNTIES.md` | Sponsor bounties: claimed, used or declined, and why |
