# Distribution check, 2026-09-23 (ChainScore-only discovery)

**What this is:** Tenor's Phase 2 validation rules and minimum aggregation,
applied offline to live ChainScore responses for 50 historical borrowers.

**What it is not:** a run of the real pipeline. HyperSync (the independent
history check) was unreachable, so *ChainScore's own* per-chain view
(`protocolsUsed`, `noBorrowHistory`) decided where each wallet borrowed. It
will be rerun through the pipeline when HyperSync is back.

**Sample:** 50 addresses drawn at random (seed 20260922) from borrowers in
ChainScore's `ml/features.csv` (prior art, older dataset, Ethereum-heavy),
used read-only as test subjects. 7 chains × 50 wallets = 350 calls to the
legacy endpoint, paced at about 13/min. 344 returned 200, 6 transport errors.

**Caveat:** some of these wallets may be in ChainScore's own training data,
which could flatter their scores.

## Finding 1: ChainScore cannot score Scroll; it silently answers with Ethereum

- `?chain=scroll` returned a response **identical field for field** to
  `?chain=ethereum` for all 48 wallets with both. That includes Compound,
  which doesn't exist on Scroll.
- **Cause (source, commit a519058):** `lib/validation.ts` accepts only
  `ethereum, polygon, arbitrum, optimism, base, avalanche, bnb`, and
  `app/api/score/[address]/route.ts` substitutes `'ethereum'` whenever that
  check fails.
- Results below **exclude Scroll** (300 calls).

## Finding 2: the distribution (minimum rule, Scroll excluded)

| State | Wallets |
|---|---|
| SCORED | 46 |
| INSUFFICIENT_HISTORY | 4 (each also had a chain whose lending data was unknowable) |
| UNAVAILABLE | 0 in this discovery mode (see finding 3) |

| Tier (SCORED) | Wallets |
|---|---|
| A (774–850) | 36 |
| B (643–773) | 8 |
| C (578–642) | 1 |
| D (452–577) | 1 |
| FLOOR | 0 |

- **Multi-chain wallets: only 4** (the brief asked for 20 or more; this
  sample can't supply them):
  - arbitrum 850 / polygon 599 → min 599 (C; the mean would be B)
  - ethereum 850 / arbitrum 757 → min 757 (B; the mean would be A)
  - ethereum 850 / polygon 850 → 850
  - ethereum 850 / arbitrum 850 → 850
- The minimum was materially (≥ 50 points) below the mean in 1 of 4, and
  changed the tier in 2 of 4.

## Finding 3: Base is unobservable

ChainScore's Aave source for Base (`degradedSources` includes `aave`) was
degraded for **all 50** wallets. So whether any of them borrowed on Base
can't be known from ChainScore. In the real pipeline, the independent check
finds Base borrowing, and those wallets are UNAVAILABLE ("Base data
unavailable").

## Run 2: through the real pipeline (2026-09-23, after HyperSync came back)

The same 50 wallets through `packages/attestor/scripts/distribution.ts`: live
HyperSync history check, live ChainScore, Tenor's validation and minimum
rule. Display-only; no signing. Raw output: `pipeline-2026-09-23.jsonl`.

| Outcome | Wallets |
|---|---|
| UNAVAILABLE, **our own HyperSync queries throttled (429) or timed out** | 30 |
| UNAVAILABLE, **Base or Optimism data degraded at ChainScore** | 7 |
| UNAVAILABLE, **consistency check** (Polygon: 9 on-chain borrows, empty ChainScore tx history) | 1 |
| SCORED | 11 (A 9, B 2; all Ethereum-only borrowers) |
| INSUFFICIENT_HISTORY | 1 |

**What this shows:**
- The throttled 30 aren't a property of the wallets. This run exceeded
  HyperSync's free "fair use" budget (7 chains per wallet, about 4 wallets a
  minute). It must be rerun serialized and paced.
- **Of the 20 wallets whose history check completed, 8 (40%) are
  UNAVAILABLE** because they borrowed on Base or Optimism, where ChainScore's
  data is degraded on every call.
- **The consistency check fired on real data:** `0x09f2e285…` was SCORED
  850/850 in the ChainScore-only analysis (run 1), and is refused here
  because its Polygon transaction history came back empty despite 9 borrows.
