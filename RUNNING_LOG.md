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
