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

## 2026-09-23 (Wed): Phase 3 approved. Corrections to the record

**Correction to the Phase 2 entry (2026-09-22, late):** the end-to-end
"SCORED 850 (A)" result for `0x0438…7e09` used a **history fixture** that
assumed no borrowing outside Arbitrum. The live independent check (HyperSync,
2026-09-23) found borrowing on **Arbitrum (3), Optimism (4) and Base (14)**.
With live data the service returns **UNAVAILABLE**: "Base data unavailable
(etherscan, aave degraded at ChainScore); Optimism data unavailable
(etherscan degraded at ChainScore)". The service behaved as designed. The gate
report overstated what live data had shown. Nothing in the README or the
submission may repeat the fixture-backed SCORED claim.

**Reframing the HyperSync "outage" (22:10 on 09-22 to about 00:30 on
09-23):** it was probably our own query pattern tripping HyperSync's
free-tier fair-use limit (see P3-O17), not provider downtime. The Alchemy
fallback therefore guards against self-inflicted throttling as much as
against outages, and must be described that way.

**Named blocker, Q5 (binding since 2026-09-23):** a demo wallet with real
Aave or Compound borrowing history, on a chain other than Base or Optimism,
whose key you control. It blocks Phase 4 entirely. It was first asked on
2026-09-22.

## 2026-09-23 (Wed), evening: Phase 3 built and at the gate

**Done**
- **Attestor:**
  - Alchemy fallback (Aave on 5 chains) with partial verification and
    per-chain source attribution.
  - Scroll guard (ChainScore issue #21), tier-C liquidation cap itemized
    separately from the −72 points.
  - Serialized, paced HyperSync with 429 retry; history cache.
  - Labelled fixture mode (local only), CORS.
  - 50 unit tests.
- **Indexer (Envio HyperIndex 3.12.1):** Wallet, Attestation,
  WalletEvent (loop timeline), LiquidationEvent, MarketTotals,
  MarketSnapshot. 3 handler tests. Ran locally (Docker via Colima, no admin
  rights): caught up from the deployment block and stayed current.
- **Web (Next.js 14.2.35, wagmi 2.19.5, RainbowKit 2.2.11):** Score,
  Compare, Market, Activity. The full journey was walked in a browser against
  local anvil: attest → borrow at A → price gap → liquidation with shortfall →
  score invalidated → re-attest at 451 (FLOOR) → the same 500 tCOLL now
  supports 600 instead of 800 tUSD.
- Filed DhrishJ/chainscore#21 (Scroll answered with Ethereum data).

**Browser walkthrough: 16 breaks found**
- **Fixed:** 1, 2, 3, 5–14 and 16.
- **Documented, dev-only:** 4 (the mock wallet doesn't reconnect after a full
  reload), 15 (the first click during initial compile doesn't connect).
- **Notable:**
  - #3 local anvil without interval mining → `IssuedInFuture` (use
    `--block-time 1`);
  - #12 polling paused in hidden tabs (now background polling plus refetch
    on focus);
  - #14 the loop strip used post-liquidation collateral (now uses the
    pre-liquidation collateral at the borrow-time price).

**Blocked**
- **HyperSync:** this IP has been refused again since about 17:48. The paced
  distribution rerun can't run (14 wallets attempted, all UNAVAILABLE for
  history, 0 ChainScore calls spent).
- **Q5 (since 2026-09-23):** no demo wallet yet.
- **No Alchemy key:** the fallback can't be demonstrated live.

**ChainScore usage:** about 10 legacy calls today during the walkthrough
(24 h cache).

## 2026-09-24: Phase 4 start

- **Faucet:** 50 MON per 24 h per wallet, behind browser verification.
  Budget: about 8 MON through 12 Oct (OBJECTIONS, Phase 4).
- **Portal read (user signed in):** Perpl "Analytics / Risk Tool" must be
  Perpl-focused (DECLINE). The Alchemy bounty requires "any Alchemy service
  or developer tool that supports Monad" (see P4-O18). The track needs a
  ≤3 min demo video, a ≤2 min pitch video, a logo, and a repo accessible to
  metropolis@hackathon.monad.xyz (public repo: yes).
- **Alchemy serves Monad testnet:** `eth_chainId` gives 0x279f, and
  `alchemy_getAssetTransfers` answers.
- **HyperSync answered from this machine at 17:36 CDT.** Still treated as
  unresolved (§2).
- **Scroll check, live, HyperSync up**
  (`docs/adversarial/scroll-hypersync-up-2026-09-24.json`): wallet
  `0x1ea6…b3ac` (3 Aave borrows on Scroll) → UNAVAILABLE, and ChainScore
  was asked about **no** chain. Pass.
- **Same wallet, HyperSync forced down, Alchemy up**
  (`scroll-hypersync-down-2026-09-24.json`): INSUFFICIENT_HISTORY,
  verification partial, Scroll listed as unverified, ChainScore asked
  only about Ethereum and Avalanche. Refused, not mis-scored.
- **The real gap:** a wallet with borrowing on Ethereum *and* Scroll would
  be SCORED on Ethereum alone while HyperSync is down; the Scroll borrow is
  invisible. Goes in the README.

## 2026-09-24: clean-clone test (§7, P4-O16)

A fresh `git clone --recurse-submodules` of github.com/DhrishJ/tenor into a
scratch directory, following README "Run it locally" word for word.

| Step | Result |
|---|---|
| 1. `forge build`, `forge test` | Pass: 153/153 |
| 2. anvil + deploy script | **Failed**: `vm.writeJson ... not allowed`. `deployments/` didn't exist in a clone (its only file is gitignored). **Fixed** (`deployments/README.md`); pulled, then passed. |
| 3. attestor `npm ci`, `npm test`, run | Pass: 66 passed, 8 Postgres tests skipped without `TEST_DATABASE_URL` (as documented). `/health` degraded only for the missing Alchemy key (README now says so). A live `/score` gave SCORED 810, tier A, full verification, matching run 2. |
| 4. indexer | **Failed on this machine**: Envio resumed old local data from a previous deployment and refused the new addresses. My first poll read that stale data and nearly counted as a pass; caught by checking `start_block`. Passed with `npm run dev -- -r`, now in the README. Colima needs `DOCKER_HOST` (README). |
| 5. web | Pass: all four pages 200. In a browser, Market read 100,000 tUSD idle and the $2,000 mock price from the chain; Activity read the indexer. A MetaMask SDK optional-import warning is now aliased away. |

**Not covered:** connecting a wallet (I don't connect the real browser
extensions). Covered in the testnet rehearsal.

## 2026-09-24/25: rehearsal deployment R on Monad testnet

- **Faucet:** 5 MON claimed by the user (the FAQ says "up to 50").
- **Deploy (committed script, `--slow`):** 0.921 MON; matches the
  0.91 estimate. Deployer `0xFBA2…6Eef`, start block 65456372.

| Contract | Address (rehearsal R) |
|---|---|
| tUSD | `0xD4046a56F9695644d9336018932f317D58399507` |
| tCOLL | `0x2BE644f7F9410B6151A9682B8f6542eaFE72443b` |
| ScoreRegistry | `0x51c9e2F27d8E90A3A1feF894E6e60d1B739Ca098` |
| MockPriceOracle | `0x0455C5258cDdbDe02026594D37959aE413858039` |
| TenorMarket | `0x66DCA766F95c3108b70ba4ee0a8f45E84E514408` |

- **Checked on-chain:**
  - registry attestor = `0x59cF…92FF`;
  - market registered;
  - oracle owner = keeper `0xaE3A…0067`;
  - totalAssets 100,000 tUSD;
  - maxPriceAge 604800;
  - not paused.
- **Verified:** all 5 through Sourcify BlockVision
  (`forge verify-contract <addr> <Name> --chain 10143 --verifier sourcify
  --verifier-url https://sourcify-api-monad.blockvision.org/`).
  - Settings: Foundry 1.8.3, solc 0.8.36, evm prague, optimizer 200 runs,
    `cbor_metadata = true`, `bytecode_hash = "none"`,
    `use_literal_content = true`.
  - Sourcify reports `match` (runtime). `exact_match` is impossible by
    design with `bytecode_hash = "none"`.
  - The MonadVision Contract tab shows the verified check.
- **Keeper:** funded with 0.3 MON. A manual run
  (`scripts/keeper-once.ts`) re-stamped both prices on testnet.
- **Bug found and fixed:** the Postgres store wasn't scoped per deployment.
  - A keeper record from a local test appeared as testnet's "last run", and
    would have suppressed the real first run for about 20 h.
  - Rehearsal and final deployments on the same chain could have shared
    nonce reservations.
  - Reservations, refusals and keeper metadata are now scoped by
    `chainId:registry`, with a test.
  - After the fix, the keeper ran on start and re-stamped the prices.
- **§5 "an attestation lands on testnet":** a live SCORED attestation
  (wallet `0x0A11…Bf6A`, score 810, tier A, full verification via
  HyperSync) was relayed by the deployer. Tx
  `0xc90de7fa405a62b8baf92b2b3ae739ad1cf1d226a43b08d5d7660f785f29c871`.
  - `getScore` gives 810, fresh; `effectiveTier` gives A; nonce is 1.
  - No `IssuedInFuture`. The attestor ran locally against testnet (hosting
    accounts pending).
