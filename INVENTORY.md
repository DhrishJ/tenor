# INVENTORY: ChainScore prior art

Audit of `DhrishJ/chainscore` at commit `a519058` (last commit 2026-07-07),
cloned read-only to `_reference/chainscore/`. Written 2026-09-22.

Everything in this file is **prior art**. Nothing here is hackathon work.

Every claim below comes from something I ran or read on 2026-09-22. Where I
could not verify a claim, this file says so.

---

## 0. Headline findings (read these first)

1. **The published model metrics cannot be reproduced from the public repo.**
   The v5 training pipeline (`model/`) and the holdout set (`data/backtest/`)
   are gitignored. No commit in the repo's history has ever touched them, and
   there is no copy anywhere under `~` on this machine. The figures
   (ROC-AUC 0.849, PR-AUC 0.599, Brier 0.053, ECE 0.018) exist only as numbers
   written into `ml/model_meta.json` and `reports/backtest/*.json`. Per the
   brief, **we may not quote them** until we can reproduce them.
2. **The Python pipeline that *is* committed is an older model that
   contradicts the headline.** `ml/train_model.py` and `ml/features.csv` hold
   2,995 rows and 28 columns with a different feature set, and `ml/report.txt`
   reports **ROC-AUC 0.6529** on a 524-row test set. A judge who clones
   ChainScore and runs the only training script in it gets 0.65, not 0.85.
   This is exactly the mismatch the brief warns about.
3. **The model scores one (wallet, chain) pair, not a wallet across chains.**
   That is its training unit (`LABELS.md`) and its serving unit
   (`scoreEvmWallet(address, chainSlug)`). No cross-chain aggregate score
   exists in the prior art. The hackathon thesis ("import your history from
   Ethereum, Arbitrum, …") needs an aggregation step, which would be **new
   work that the model was never validated on**. That is an architecture
   decision for you (see PLAN.md, open questions).
4. **The model only scores wallets that have borrowed on Aave V2/V3 or
   Compound V2.** Every other wallet returns `noBorrowHistory` (score 0) or
   `newWallet` (score **300**). Fresh testnet wallets, including any a judge
   creates, will be unscored. The demo needs a real mainnet borrower address
   whose key you control.
5. **The live API makes up a low score when data is missing or providers
   fail.** Probed on 2026-09-22 against `https://chainscore.dev/api/score/…`
   (details in section 8):
   - A wallet with no history on a chain returns `score: 300, grade F`
     instead of "unscored".
   - On Base and Optimism the providers were degraded (`degradedSources`
     non-empty), yet the API still returned `300 / newWallet`.
   - On Arbitrum the same wallet scored **850** with `totalTxns: 0`: the
     transaction history came back empty and was not flagged as degraded.

   The attestation service must never sign in any of these states.
6. **Some features are always zero in serving.** `has_governance_vote` is
   hard-coded `false`, and `getUniswapActivity` is a stub that always returns
   `hasLP: false` (LP status comes from Alchemy's NFT API instead). Four
   features (`has_uniswap_lp`, `has_governance_vote`, `has_ens`,
   `is_gnosis_safe`) are never split on in any tree. They are dead weight, not
   a bug, but copy that says "every factor" is overstating things.

---

## 1. Repository shape

102 commits between 2026-03-05 and 2026-07-07. 91 of them fall in
2026-07-02..07. Public on GitHub.

| Area | Tracked files | Notes |
|---|---|---|
| `lib/` | 68 | scoring, ingest, integrity detectors, pricing, agents, auth |
| `app/` | 43 | Next.js 14 App Router pages and API routes |
| `tests/` | 34 | Vitest unit tests (31 files) and Playwright e2e tests (2) |
| `components/` | 34 | shadcn/ui-based UI |
| `scripts/` | 10 | backtest, load test, API-key minting, secret scan |
| `ml/` | 9 | serving model artifacts and a **stale** training pipeline |
| `docs/`, root `*.md` | ~18 | ARCHITECTURE, THREAT_MODEL, LABELS, COST_TO_GAME, DECISIONS, FACTS_TODO, … |

Lines of code (tracked, excluding `package-lock.json`):

| Language | Lines |
|---|---|
| TypeScript (`.ts`) | 13,635 |
| TSX | 5,781 |
| Python | 1,072 |
| JS / MJS | 736 |
| Prisma schema | 513 |

Key versions from `package.json`: `next` 14.2.35, `viem` ^2.17.5, `wagmi`
^2.19.5, `@rainbow-me/rainbowkit` ^2.2.10, `@prisma/client` ^5.22.0, `zod`
4.4.3, `vitest` 4.1.9.

## 2. The model

**Where it lives.** `ml/model.json` (945 KB) and `ml/model_meta.json` (12 KB).
The last training commit is `aa7c9e0`, "ship v5-xgb-cal, the 34-feature
calibrated retrain".

**Format.** A native XGBoost JSON booster, saved by XGBoost 3.2.0, objective
`binary:logistic`, 301 trees with at most 63 nodes each. The booster records
`best_iteration = 260` and `best_score = 0.7846` (early-stopping validation
metric). Serving walks **all 301 trees**, not the first 261. That is
consistent with the backtest, which uses the serving path, but worth knowing.

**How it's invoked.** No Python in production. `lib/data/mlScorer.ts`
(513 lines) loads both JSON files once per lambda and walks the trees in
TypeScript:

```
features[34] → XGB margin + per-feature path contributions
            → sigmoid → raw P(liquidation)
            → calibration lookup (201-point piecewise-linear x→y table)
            → PD → score = offset − factor·logit(PD), clamped to [300, 850]
            → grade (A ≥ 774, B ≥ 643, C ≥ 578, D ≥ 452, else F)
            → percentile from exported deciles
```

Score band: `offset 196.578`, `factor 104.166`, PDO 72.2. The anchors are
PD 0.30% → 800 and PD 18.65% → 350.

I checked the tree walker: leaf `base_weights` equal leaf `split_conditions`,
so the TypeScript reproduces XGBoost's leaf values correctly.

**What it predicts** (`LABELS.md`). y = 1 if the (wallet, chain) pair borrowed
before 2024-06-01 and was liquidated on that chain between 2024-06-01 and
2024-12-01. It is a liquidation-in-window proxy, **not default**. `LABELS.md`
says so itself, which is good.

**Smoke test I ran** (synthetic vectors through `predictFromFeatureVector`):

| Case | PD | Score |
|---|---|---|
| 4-year wallet, 25 borrows all repaid, no liquidations | 0.0012 | 850 |
| 20-day wallet, 1 open borrow | 0.119 | 405 |
| 13-month wallet, 2 prior liquidations, half repaid | 0.216 | 331 |

The ordering makes sense, and the scorer is deterministic and runs offline
with no API keys. That makes it reusable as an imported artifact.

## 3. Feature vector (v5, 34 features, order matters)

All features are float64 with no normalization at inference. Clips are
applied in `buildFeatureVector`. The source for each group is listed below.

| # | Feature | Source (live serving) | Derivation / clip |
|---|---|---|---|
| 0 | wallet_age_days | Etherscan v2 first tx | now − first tx |
| 1 | wallet_age_months | derived | days / 30 |
| 2 | days_since_first_defi | derived | **= wallet age if any borrow detected, else 0** (approximation, not a real first-DeFi timestamp) |
| 3 | active_days_count | Etherscan v2 txlist | |
| 4–7 | tx_count, tx_count_30d/90d/180d | Etherscan v2 txlist | |
| 8 | active_months_12 | Etherscan v2 txlist | |
| 9–11 | aave_borrows, aave_repays, aave_liquidations_prior | The Graph (Aave V2/V3 subgraphs) | `first: 1000`, liquidations `first: 100` (counts saturate) |
| 12–14 | compound_borrows, compound_repays, compound_liquidations_prior | The Graph (Messari Compound V2, **Ethereum only**) | same |
| 15–16 | total_borrows, total_repays | derived | sums |
| 17 | repayment_ratio | derived | repays / max(borrows, 1) |
| 18–19 | prior_liquidation_count, has_prior_liquidation | derived | |
| 20 | protocols_used_count | derived | Aave, Compound, UniLP, stETH flags |
| 21 | has_uniswap_lp | Alchemy NFT API (thegraph stub always false) | never split on |
| 22 | has_staked_eth | Alchemy balances | |
| 23 | has_governance_vote | **hard-coded false** | never split on |
| 24–26 | total_portfolio_usd, stablecoin_pct, token_diversity | Alchemy balances | |
| 27–29 | has_eth, has_ens, is_gnosis_safe | Alchemy, ENS via viem | has_ens, is_gnosis_safe never split on |
| 30 | borrow_velocity | derived | min(borrows / max(age, 1), 50) |
| 31 | liquidation_rate | derived | min(liqs / max(borrows, 1), 10) |
| 32 | net_unpaid_borrows | derived | clip(borrows − repays, 0, 1000) |
| 33 | defi_tenure_ratio | derived | min(days_since_first_defi / max(age, 1), 1.5) |

Share of total split gain, computed by me from `model.json`: total_borrows
0.224, days_since_first_defi 0.133, prior_liquidation_count 0.111,
borrow_velocity 0.093, repayment_ratio 0.076, then a long tail.

⚠ **Possible train/serve skew I cannot rule out.** Training features were
built by `model/src/*.py`, which is not available. `days_since_first_defi`
is the #2 feature by gain, but in serving it is just a copy of wallet age. If
training computed it from real first-DeFi timestamps, serving inputs differ
from training inputs on the second most important feature.

`COST_TO_GAME.md` says the model uses monotonic constraints. `model.json`
records none in its saved training parameters, so I could not verify that
claim.

## 4. Data sources and keys

| Provider | Used for | Env var | Chains |
|---|---|---|---|
| Etherscan v2 (multichain) | first tx, tx history | `ETHERSCAN_API_KEY` | eth, arb, op, polygon, base; **degraded on Scroll and Avalanche** (no txlist) |
| Alchemy | balances, portfolio flags, NFT LP, ENS RPC | `ALCHEMY_API_KEY` | all 7 EVM |
| The Graph gateway | Aave V2/V3 and Compound V2 events | `THEGRAPH_API_KEY` | 9 deployments listed in `lib/data/coverage.generated.json` |
| Helius | Solana (separate scorer) | `HELIUS_API_KEY` | Solana; not relevant here |
| Postgres (Supabase) | history, API keys, feature snapshots | `DATABASE_URL` | n/a |
| Redis (optional) | shared score cache, 7-day last-known-good | env in `lib/scoring/cacheDurable.ts` | n/a |

Lending coverage: Aave V3 on eth, arb, op, polygon, base, avalanche and
scroll; Aave V2 on eth; Compound V2 on eth only.

## 5. Scoring API surface

| Route | Auth | Shape |
|---|---|---|
| `GET /api/score/[address]?chain=` | none (legacy, shape frozen per D-004) | `ScoreResult`: `{address, ens, score, grade, percentile, factors[], walletAge, totalTxns, protocolsUsed, timestamp, newWallet, noBorrowHistory?, calibratedPD?, modelVersion?, topContributions?, dataCompleteness, degradedSources[]}` |
| `GET /api/v1/score/[address]?chain=` | `Authorization: Bearer cs_live_…`, metered per plan | `ScoreEnvelope`: adds `modelScore`, `featureSetVersion: "v5"`, `integrity{penalty, flagged, signals}`, `asOf`, `computedAt`, `cached`, `stale` |
| `/api/v1/openapi` | none | OpenAPI spec (`public/openapi.json`) |

Cache: 5 minutes fresh, 1 hour stale-servable, plus a 7-day last-known-good in
Redis that is served when 4 or more sources fail.

## 6. Relevant database schema

`Wallet` (address PK, score, grade, percentile), `ScoreSnapshot`,
`FeatureSnapshot` (address, chain, validAtTs, featureSetVersion, features
JSON, dataCompleteness), `OutcomeLabel`, `ApiKey` (keyHash, rateLimitPerMin),
`WebhookSubscription`, and marketplace tables (`LoanListing`, `Loan`,
`Review`). None of these are needed for the hackathon. The attestation
service needs its own small nonce and attestation store.

## 7. Metrics: what I could and could not reproduce

| Claim | Source | Reproduced? |
|---|---|---|
| ROC-AUC 0.8489, PR-AUC 0.5993, Brier 0.0528, ECE 0.0181 (n = 7,720) | `reports/backtest/latest.json` (2026-07-05) | **No.** `npm run backtest` needs `data/backtest/holdout.json`, produced by `scripts/export-backtest-holdout.py` from `model/data`. Neither exists. |
| test ROC 0.8489, n_train 30,595 / n_test 7,648 | `ml/model_meta.json` | **No.** The training code is not in the repo. |
| ROC-AUC 0.6529, CV 0.6409 ± 0.026 | `ml/report.txt` | Not run yet (needs xgboost and sklearn installed). It describes the **old** model, not the one being served. |
| "~40,000 wallets across seven chains" | brief, `FACTS_TODO.md` | Partly. 30,595 + 7,648 = 38,243 labelled rows, and the unit is a (wallet, chain) **pair**, not a wallet. The backtest has slices for only 4 chains (eth, arb, avalanche, scroll). |

Things that look off even taking the numbers at face value:

- **Base rate.** `model_meta.metrics.base_rate_pr = 0.0909` (1/11), but the
  test set's own positive rate is 1,918 / 7,648 = **0.251**. The backtest
  says it reweights to 0.0909. Reporting a PR-AUC next to a base rate that
  isn't the test set's own rate is exactly what an adversarial judge will
  question.
- **Scroll dominates the sample.** It is 2,609 of 7,720 backtest rows
  (818 positives) and has the best AUC (0.875). The headline metric is
  flattered by one chain.
- **The top reliability bin looks too good.** 651 wallets are predicted at
  PD ≈ 0.986 and observed at 1.000. That is the pattern label leakage leaves
  (for example, a liquidation just after the cutoff leaking into the
  "prior" counts). I can't confirm or rule it out without `model/`.
- **Same-set evaluation.** Backtest ROC (0.84889) is almost identical to the
  training test ROC (0.84888). The "backtest" appears to be the same temporal
  holdout scored through the TypeScript path, not an independent sample.
- **The operating point is weak.** At score < 578: recall 0.88, false
  positive rate 0.48, precision 0.15. `LABELS.md` acknowledges this.

**Recommendation.** Unless you have the `model/` directory somewhere (another
machine, backup, or cloud) and we reproduce the backtest from it, the
submission should state no ROC or PR figures at all. Instead it should say:
"model metrics are published by ChainScore (prior art) and are not
re-verified in this submission". Alternatively, we reproduce a metric on data
we build ourselves, which is costly (see PLAN.md).

## 8. Broken, stale, or half-finished

- **Live API makes up scores** (probed 2026-09-22, wallet
  `0x0438…7e09`, which has 13 Aave borrows in `features.csv`):

  | chain | score | newWallet | totalTxns | degradedSources |
  |---|---|---|---|---|
  | ethereum | 300 | true | 0 | none |
  | polygon | 300 | true | 0 | none |
  | arbitrum | **850** | false | **0** | none |
  | optimism | 300 | true | 0 | etherscan |
  | base | 300 | true | 0 | etherscan, aave |
  | avalanche | 300 | true | 0 | none |

  `computeScore` returns 300 / F for `newWallet`, and it computes a score even
  when a source's error has been silently replaced with zeros.
- **Stale training pipeline committed.** `ml/train_model.py`,
  `ml/scripts/train.py`, `ml/features.csv` and `ml/report.txt` are all
  pre-v5.
- **Stale comment.** `mlScorer.ts` says "MUST match model/schema.json order
  (30 features)"; the vector has 34.
- **Unit tests.** `npx vitest run` gives 337 passed and 2 failed
  (`repoGuard.test.ts`, path-traversal tests for the ops agent; probably the
  macOS `/private/tmp` symlink, since I ran them from a scratch copy), plus 1
  unhandled error (`publicFacts.test.ts` imports `scripts/seedFacts.ts`, which
  runs `main()` and exits because there is no database). All `mlScorer` and
  `backtest` tests pass. `tsc --noEmit` passes.
- **`FACTS_TODO.md`** already lists six public claims that are
  unverified (including "8 networks", "25K+ liquidations" and a made-up demo
  score card). None of those numbers may appear in our submission.
- The **integrity detectors** for instant-repay and Sybil receive no live
  input (the file itself says so), so the `integrity.penalty` field is only
  partly working.
- The marketplace write path, Stripe billing and the ops agents are unrelated
  and out of scope.

## 9. What we can safely reuse (as prior art, clearly labelled)

- `ml/model.json` and `ml/model_meta.json`, imported as pinned artifacts with
  their SHA-256 recorded in PROVENANCE.md.
- `lib/data/mlScorer.ts` (pure, offline, deterministic). Either vendor it into
  a `prior-art/` folder with its original commit hash, or call the ChainScore
  v1 API as a black box.
- The ingest adapters (`lib/ingest/*`, `lib/data/thegraph.ts`,
  `lib/data/alchemy.ts`), but only behind a new "refuse to attest on any
  degraded source" gate that we write.
