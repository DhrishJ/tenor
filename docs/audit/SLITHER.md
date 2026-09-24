# Static analysis and CEI review (Phase 4 §7, 2026-09-24)

**Not an audit.** A self-review with a static analyser. Tenor is unaudited
(see the banner).

## Slither

- Slither **0.11.6** (Trail of Bits, PyPI `slither-analyzer==0.11.6`), in a
  Python 3.12 venv made with uv 0.12.18. Foundry 1.8.3, solc 0.8.36.
- Command, from `contracts/`:
  `slither . --filter-paths "lib/|test/|script/" --exclude-dependencies --json ../docs/audit/slither-2026-09-24.json`
- 36 contracts, 102 detectors, **29 results: 0 High, 13 Medium, 16 Low, 0
  Informational.** Raw output: `slither-2026-09-24.json`.

### Medium: `incorrect-equality` (10), all false positives

This detector flags `==` against values an attacker can nudge (a token
balance someone can donate to). Every hit here compares internal accounting
that only the contract writes:

| Where | Comparison | Why it's safe |
|---|---|---|
| `repay`, `liquidate`, `healthFactor` | `debt == 0` | Debt derives from `scaledDebt`, which only borrow/repay/liquidate write. A donation can't change it. |
| `_accrue`, `_previewAccrual` | `block.timestamp == lastAccrual`, `dt == 0 \|\| totalScaledDebt == 0` | Skips a no-op accrual. |
| `_reduceDebt` | `scaledSub == 0` | Reverts a repay that would round to zero scaled debt. |
| `_utilization` | `supplied == 0` | Division guard. |
| `liquidate` | `repaid == repayCap` | Both are computed in the same call. Equality means the collateral is used up, so all of it is seized. `repayCap == 0` (dust collateral) is deliberate and commented: it realizes the debt as bad debt. |
| `liquidate` | `p.collateral == 0 && p.scaledDebt > 0` | Triggers bad-debt realization. Collateral is internal accounting, not `balanceOf`. |
| `MockPriceOracle.getPrice` | `p.updatedAt == 0` | "never set" sentinel. |

### Medium: `unused-return` (3), all intended

| Where | Ignored | Why |
|---|---|---|
| `ScoreRegistry.submitAttestation` | `RiskParams.scoreToTier(a.score)` | Called for its range check (reverts `ScoreOutOfRange`), as the inline comment says. |
| `ScoreRegistry.submitAttestation` | third value of `ECDSA.tryRecover` (the error argument) | `err` itself is checked; the argument only adds detail. |
| `TenorMarket.maxBorrow` | score from `registry.effectiveTier` | Only the tier matters for the limit. |

### Low: `timestamp` (16), accepted

Expiry, submit deadline, TTL and clock skew (`ScoreRegistry`), price age
(`TenorMarket._price`), interest accrual, and the mock faucet cooldown are
time-based by design. A validator's small timestamp leeway can't matter at
these scales (a 60 s skew allowance, a 15-minute submit window, a
24-hour score, a 7-day price age). The detector also flags every function
that reaches `_accrue()` transitively, which accounts for most of the 16.

## Checks-effects-interactions, reviewed by hand

Every state-changing `TenorMarket` entry point is `nonReentrant`. Order in
each:

| Function | Effects | Interaction(s), last |
|---|---|---|
| `depositCollateral` | collateral, totalCollateral, event | `safeTransferFrom` in |
| `withdrawCollateral` | collateral, totalCollateral; re-tier + terms check if in debt | `safeTransfer` out |
| `borrow` | scaled debt (position, total, tier bucket); caps and terms checked | `safeTransfer` out |
| `repay` | debt reduced, event | `safeTransferFrom` in |
| `liquidate` | debt reduced, collateral seized, bad debt realized, event | `registry.recordLiquidation`, then `safeTransferFrom` in, then `safeTransfer` out |
| `deposit/mint/withdraw/redeem` | `_accrue` then OpenZeppelin 5.6.1 ERC-4626 | OZ's ordering (transfer in before mint; burn before transfer out) |

External reads during checks (`registry.effectiveTier`, `oracle.getPrice`)
go to contracts fixed at deployment. `registry.recordLiquidation` is the
only state-changing call to another contract. It happens after all of
`liquidate`'s effects, and `ScoreRegistry` makes no external calls. The
tokens are the repo's own `MockERC20` (no transfer hooks). Behaviour with a
hooked token is covered by `test/Reentrancy.t.sol`.

**Result:** no changes needed.
