# RUNNING_LOG

## 2026-09-22 (Tue): Phase 0

**Done**
- Toolchain: installed gh 2.101.0 and Node v24.21.0 LTS to `~/.local`
  (both checksum-verified, no sudo). gh is logged in as DhrishJ.
- Created `~/monad-metropolis` (git init, branch `main`, no commits yet).
  `.gitignore` excludes `_reference/` and `.env*`.
- Cloned `DhrishJ/chainscore` at `a519058` into `_reference/chainscore`,
  made read-only.
- Wrote INVENTORY.md, RESEARCH.md and PLAN.md.

**Key findings**
- ChainScore's v5 metrics can't be reproduced from the repo: `model/` and
  `data/` are gitignored and missing. The committed `ml/report.txt` shows
  AUC 0.65 from an older model.
- The model is per (wallet, chain) and only scores wallets that have
  borrowed; cross-chain aggregation is new work.
- The live API hands out score 300 for no data and during provider
  failures, and scored a wallet 850 with 0 transactions.
- Monad testnet: chain ID 10143 (verified). No usable push oracle on
  testnet, so the plan uses a labelled mock. Envio supports 10143 natively.
  CRE supports it but needs deploy approval.

**Blocked on**: PLAN.md §0, Q1–Q8, plus git user.name/user.email.

**Next**: once approved, install Foundry (≥ 1.8.0), make the first commit,
then contracts from Sep 24.

## 2026-09-22 (Tue), later: Phase 1 brief received

- The project is now called Tenor. The rename in the docs waits for the
  first commit.
- The gate check in the Phase 1 brief is false: no git identity, no commits,
  no Foundry.
- Wrote the Phase 1 section of OBJECTIONS.md: 13 objections, 4 of which
  change the architecture (O1–O4).
- Key finding: under a zero-drift random-walk price model, the chance of
  shortfall during a 0.6 s vs 12 s liquidation delay is ~0 for both. The §6
  Monad wording doesn't survive this, and the §5.5 simulation would refute
  it.
- **Blocked on:** answers to OBJECTIONS.md and the git identity. No contract
  code written.

## 2026-09-22 (Tue), evening: Phase 1 built and at the gate

**Done**
- Foundry 1.8.3 installed (Monad requires ≥ 1.8.0). OpenZeppelin v5.6.1 and
  forge-std v1.16.2 pinned as submodules. solc 0.8.36, evm prague,
  `network = "monad"`.
- Contracts: RiskParams, ScoreRegistry, TenorMarket, IPriceOracle,
  MockPriceOracle, MockERC20.
- **152 tests pass**: unit, fuzz (10,000 runs), and an 8-invariant campaign
  (256 × 100, 0 handler reverts), plus journey and reentrancy tests.
- Coverage: 100% lines and functions, 94.1% branches. The only misses are
  RiskParams.validate() revert branches, unreachable with the shipped
  constants.
- Wrote CONTRACTS.md. Recorded O14–O16 in OBJECTIONS.md. Renamed PLAN.md to
  Tenor, with a note on which parts are superseded.

**Found and fixed**
- Liquidating collateral worth under 1 wei of debt reverted, leaving
  phantom debt. It now writes the debt off as recorded bad debt.
- Two invariant-handler bugs (an overflow, and too few liquidations to
  exercise shortfall).
- Monad's verify-guide config keys are wrong for Foundry 1.8.3.

**Still blocked**
- Git identity is not set, so there are **still no commits**.
- Q4 (testnet eligibility), Q5 (demo wallet), Q6 (API vs vendored scorer).

**Next (after approval)**: first commit(s); deploy script plus a dry-run on a
local Monad-mode anvil; then Phase 2.

## 2026-09-22 (Tue), night: Phase 2 brief received

- **The gate check is false:** no git identity, no commits, no deploy script
  (P2-O1). Stopped as instructed.
- Wrote the Phase 2 objections in OBJECTIONS.md (P2-O1 to P2-O12). Key
  evidence:
  - Base and Optimism are degraded on *every* ChainScore call, because
    Etherscan's free tier excludes those chains. A strict "all healthy" rule
    would refuse every wallet.
  - The 850/zero-transactions case was a transient empty Etherscan result;
    that wallet really has Aave history.
  - HyperSync's free tier covers all 7 chains. Aave `Borrow` indexes the
    borrower; Compound V2's doesn't.
  - ChainScore v1's free plan is 1,000 scores a month.
- **Named blocker:** the distribution check is blocked since 2026-09-22 on
  the HyperSync token (not on Q5).
- **Waiting on:** approval of the objections, git identity, a HyperSync
  token, a ChainScore v1 key, and confirmation of Supabase.

## 2026-09-22 (Tue), late: Phase 2 built and at the gate

**Done**
- Git identity set (DhrishJ). The history starts 2026-09-22: 10 commits.
- Deploy script (`contracts/script/Deploy.s.sol`) writes
  `deployments/<chainId>.json`. Verified on a local Monad-mode anvil (Phase 1
  remainder, P2-O1).
- `packages/attestor`: the refusal layer, three states, minimum aggregation
  behind an interface, Tenor policy, EIP-712 signer, per-nonce payload
  reservations, rate limits, a refusal log (`/refusals`) and per-dependency
  `/health`. 36 unit tests pass.
- The local end-to-end run (`scripts/e2e-local.ts`) passes every check,
  against the deployed contracts and live ChainScore.

**Found by the end-to-end run and fixed**
- An unsubmitted reservation made before a liquidation blocked the
  post-liquidation score for up to 15 minutes (a feedback-loop bug).
  Reservations issued at or before `lastLiquidatedAt` are now replaced.
  Added a regression unit test.

**Operational incident**
- Envio HyperSync: the token worked at 22:07 CDT (full Arbitrum scan in
  about 3 s). From about 22:10, every `*.hypersync.xyz` host rejects TLS
  ("tlsv1 alert protocol version"), both inside and outside the sandbox.
  `docs.envio.dev` and `envio.dev` are fine; there is no status page. Cause
  unknown: an outage, or an IP-level block after our queries. The end-to-end
  run therefore used an explicitly labelled history fixture.

**Named blockers**
- **The distribution check has been blocked since 2026-09-22** by
  HyperSync's reachability. It's no longer blocked on Q5 (P2-O12).
- Q5 (a demo wallet with real history) blocks Phase 4 only.

**ChainScore usage (you asked me to track burn)**
- The endpoint in use is legacy (P2-O13, needs confirmation). It has **no
  monthly quota**, only 20 requests per minute per IP.
- Requests made on 2026-09-22: about 18 (6 in Phase 0, 6 Phase 2 probes, 3
  per end-to-end run × 2). Forced-failure runs use a dead URL and spend
  none. Our 24 h cache means one live request per chain per wallet per day.

**Next**: Phase 3 after approval. Before Phase 4: resolve HyperSync
reachability and run the distribution check.

## 2026-09-23 (Wed), early: Phase 3 objections and the distribution check

- The gate claim "tier cap implemented" is false (P3-O1). Wrote objections
  P3-O1 to P3-O16 and BOUNTIES.md.
- **Distribution check (ChainScore-only discovery; HyperSync still down):**
  46 of 50 SCORED. Tiers: A 36, B 8, C 1, D 1, FLOOR 0. Only 4 multi-chain
  wallets. Details in `docs/distribution/`.
- **Found:** ChainScore silently answers Scroll requests with Ethereum data
  (P3-O15). Base lending data is unobservable at ChainScore.
- **ChainScore usage:** 350 legacy calls for the distribution check (about
  368 total to date). Legacy has no monthly quota; paced at about 13/min
  after back-off made the unpaced run crawl at 2/min.
- **HyperSync:** still rejecting TLS at last check (since about 22:10 on
  09-22).
- **Blocked on you:** objection approvals, the tier-cap rule, an Alchemy key,
  faucet funding (P3-O12), and the portal bounty terms (P3-O14).
