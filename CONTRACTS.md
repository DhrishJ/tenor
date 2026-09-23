# CONTRACTS

Tenor's on-chain half: what each contract holds, what must always be true,
whom you have to trust, and what an attacker can do.

- **Toolchain:** Foundry 1.8.3 (`network = "monad"`), solc 0.8.36,
  `evm_version = prague`, OpenZeppelin Contracts v5.6.1 (`5fd1781`),
  forge-std v1.16.2 (`bf647bd`).
- **Status:** tested locally only. **Not deployed. Not audited.**

```
contracts/src/
  RiskParams.sol            pure library: score -> tier -> terms
  ScoreRegistry.sol         EIP-712 score attestations + Tenor liquidation history
  TenorMarket.sol           lending market (ERC-4626 lender shares)
  interfaces/IPriceOracle.sol
  mocks/MockPriceOracle.sol TESTNET MOCK: prices set by hand
  mocks/MockERC20.sol       TESTNET MOCK: tUSD, tCOLL with an open faucet
                            (plus a one-time initial supply to the deployer, for seeding)
```

---

## 1. RiskParams (library, pure)

Maps a ChainScore score to Tenor's terms. No storage.

| Tier | Scores | Max LTV | Liquidation threshold | Per-wallet cap |
|---|---|---|---|---|
| FLOOR | unscored, stale, or 300–451 | 60% | 65% | 1,000 tUSD |
| D | 452–577 | 65% | 70% | 2,500 |
| C | 578–642 | 70% | 75% | 5,000 |
| B | 643–773 | 75% | 80% | 10,000 |
| A | 774–850 | 80% | 85% | 20,000 |

- **Tier boundaries** are ChainScore's published grade cutoffs
  (`model_meta.json`, commit `a519058`).
- **Every number is a policy placeholder, not a calibration.** The model's
  performance has not been reproduced, so it supports *ordering* the tiers,
  not sizing the gaps between them.
- **A low score is never priced worse than no score.** Scores below 452 get
  FLOOR terms, the same as unscored, because a wallet can always decline to
  submit a score.
- **One rate for everyone:** 2% + 10% × utilization (2%–12% APR), with a 10%
  reserve factor. The score changes how much collateral you lock, not what
  you pay.
- **Liquidation bonus:** 5%, fixed.

`validate()` enforces four constraints. `TenorMarket`'s constructor calls it,
so a deployment with broken parameters reverts. Solidity has no compile-time
assert, so this is the closest equivalent.

1. maxLtv < 100% for every tier.
2. liquidation threshold > maxLtv.
3. liquidation threshold × (1 + bonus) ≤ 100%, so liquidators are always
   paid in full at the trigger. The worst tier gives 0.85 × 1.05 = 0.8925.
4. Terms never get worse as the tier rises.

## 2. ScoreRegistry

**State**

| Field | Meaning |
|---|---|
| `attestor`, `attestorEpoch` | current signing key; the epoch bumps on rotation |
| `_scores[wallet]` | `{score, issuedAt, expiresAt, attestorEpoch}` |
| `_liquidations[wallet]` | `{lastLiquidatedAt, liquidationCount, shortfallCount, totalShortfall}` |
| `nonces[wallet]` | next expected attestation nonce |
| `isMarket[addr]` | markets allowed to record liquidations |

**Attestation** (EIP-712, domain `"Tenor ScoreRegistry"`, version `"1"`,
chainId, verifyingContract):

```
ScoreAttestation(address wallet,uint16 score,uint64 issuedAt,uint64 expiresAt,
                 uint64 deadline,uint256 nonce,bytes32 modelVersion)
```

`submitAttestation` is permissionless: the signature binds the wallet, so
anyone can relay it. It reverts with a specific error on each of these:

- zero wallet
- wrong nonce (replay)
- `now > deadline`
- `now >= expiresAt`
- `issuedAt > now + 60 s`
- `expiresAt > issuedAt + MAX_TTL (2 days)`
- score outside 300–850
- `issuedAt <= stored issuedAt` (no rolling back to an older score)
- **`issuedAt <= lastLiquidatedAt`** (a score signed before a Tenor
  liquidation can't be used after it)
- signer ≠ current attestor, or a malformed or malleable signature (high-s
  is rejected by OpenZeppelin ECDSA)

**Chain binding:** OpenZeppelin's `EIP712` rebuilds the domain separator
whenever `block.chainid` changes, so a signature can't be replayed on a
fork. Tested by changing the chain ID.

**`getScore`** returns `(score, issuedAt, expiresAt, isStale)`. It is stale
when:

- there is no score,
- it has expired,
- it was signed under a rotated key, or
- it was issued at or before the wallet's last Tenor liquidation.

The number stays visible, but a stale score is never presented as fresh.
`effectiveTier` returns FLOOR for a stale score.

**`recordLiquidation(wallet, shortfall)`**:

- Only authorized markets can call it.
- It is deliberately *not* blocked by pause: liquidation history must never
  be lost.
- It immediately makes the wallet's current score stale.

**The separation that matters:** ChainScore supplies a score. The registry
enforces *Tenor policy* (the liquidation penalty) on-chain, so the penalty
doesn't depend on any off-chain service behaving.

**Admin (Ownable2Step):** `setAttestor` (rotates the key and invalidates
every score signed under the old one), `setMarket`, `pause`/`unpause`
(pausing blocks new attestations only).

## 3. TenorMarket

**State**

| Field | Meaning |
|---|---|
| ERC-4626 shares (`tnLP`, 24 decimals) | lender claims; 6-decimal virtual offset against inflation attacks |
| `borrowIndex` (RAY 1e27), `lastAccrual` | one global borrow index |
| `totalScaledDebt`, `scaledDebtByTier[5]` | debt in index-free units, in total and per tier |
| `reserves` | protocol's claim on the pool, funded by 10% of interest; absorbs bad debt first; not withdrawable in v1 |
| `_positions[wallet]` | `{collateral, scaledDebt, tier, score}`; `tier`/`score` = the terms the position was last priced at |
| `totalCollateral` | sum of posted collateral |
| `globalDebtCap`, `tierDebtCap[5]` | owner-set caps (per-wallet caps come from RiskParams) |
| `totalBadDebt`, `totalReserveDrawn`, `totalSocializedLoss` | cumulative bad-debt ledger |

**Accounting**

- `totalAssets = cash + totalDebt − reserves`
- `debt(position) = ceil(scaledDebt × borrowIndex / RAY)`. Stored debt rounds
  **against the borrower**.
- Per interval `dt` between interactions:
  `index' = index × (1 + rate × dt / 365 days)`, with `rate` set by
  utilization at the start of the interval. Simple interest inside an
  interval, compounding between intervals. Hand-computed tests cover one
  year and two half-years.
- **Bad debt** is the debt left when a liquidation takes all of a position's
  collateral. It is written off `totalScaledDebt`. Reserves absorb it first,
  and the remainder lowers `totalAssets`, so the share price takes the
  socialized part. Both parts are counted and emitted in `BadDebtRealized`.

**Pricing a position**

- **Borrowing or withdrawing collateral** (anything that adds risk) re-prices
  the position at the wallet's current effective tier. It must then satisfy
  that tier's max LTV, per-wallet cap and tier cap. Borrowing also checks the
  global cap and idle cash.
- **An absent or stale score prices at FLOOR.**
- **Repaying and adding collateral never re-price.**
- **Liquidation uses the tier the position was last priced at.** A score
  expiring overnight therefore doesn't make a healthy tier-A position
  instantly liquidatable at FLOOR's 65%.

**Liquidation**

- Allowed when debt value > collateral value × liquidation threshold.
- No close factor. The liquidator names `maxRepay`, and the repay is capped
  at `min(maxRepay, debt, collateralValue / (1 + bonus))`. The liquidator
  receives collateral worth repay × 1.05.
- If the cap binds, all collateral is seized, and any remaining debt is
  realized as bad debt. That includes collateral worth less than one wei of
  debt, where the cap rounds to zero: the position is still closed and its
  debt written off, not left inflating `totalAssets`.
- **Every liquidation** calls `registry.recordLiquidation(wallet, shortfall)`.

**Pause:**

| While paused | Actions |
|---|---|
| Blocked | lender deposits, borrowing, liquidation |
| Still works | repay, adding collateral, lender withdrawals, health-checked collateral withdrawals |

A pause never traps anyone. Liquidation is blocked because the usual reason
to pause is a bad price.

**Views:** `maxBorrow(wallet)` returns an amount guaranteed to succeed. Stored
debt rounds up, so it keeps a margin of `index/RAY + 2` wei; this is fuzzed.
Also: `healthFactor`, `getPosition`, `debtOf`, `scaledDebtOf`, `totalDebt`,
`tierDebt`, `borrowRateBps`.

**Events carry the terms in force.** `Borrowed` and `Liquidated` include the
score, tier, max LTV / liquidation threshold and collateral price, so every
Tenor outcome can be tied back to the terms it happened under (OBJECTIONS
O15).

## 4. MockPriceOracle and IPriceOracle

`IPriceOracle.getPrice(asset) → (priceWad, updatedAt)`. The market enforces
freshness itself: zero price, a future timestamp, or an age above
`maxPriceAge` all revert. A real feed drops in behind an adapter with no
change to market logic.

`MockPriceOracle` is owner-set, and the name says so. Reasons:

- Chainlink has no Monad testnet feeds.
- Pyth's MON/USD price was 15 days old when checked on 2026-09-22 (a pull
  oracle nobody had updated).
- The demo needs a price drop on cue.

Both assets are priced through the oracle; tUSD is set to $1.00 on testnet.

## 5. Invariants

`test/invariant/`: 8 invariants over a handler with 4 actors and 11 actions
(including targeted crash-and-liquidate), 256 runs × depth 100. Every run
has 0 handler reverts, enforced by `fail_on_revert = true`.

**Evidence the handler actually exercises the risky paths**, from one run of
depth 5,000: 188 successful borrows, 49 liquidations (17 with shortfall),
341 attestations, 210 repays.

| # | Invariant | Tolerance |
|---|---|---|
| 1 | Σ position scaled debt == `totalScaledDebt` | exact |
| 1b | Σ position debt vs `totalDebt()` | 0 ≤ diff ≤ #positions wei. Each view rounds up, so the sum of rounded parts can exceed the rounded total by < 1 wei per position. |
| 2 | Σ `scaledDebtByTier` == `totalScaledDebt` | exact |
| 3 | Σ lender shares == `totalSupply`; Σ collateral == `totalCollateral` == token balance | exact |
| 4 | No successful borrow leaves a position above its tier's max LTV | exact (checked at 1e36 precision) |
| 5 | Every borrow is priced at the tier of the score valid in that block; a stale or absent score never prices above FLOOR | exact |
| 6 | No borrow pushes total debt above the global cap | exact. Interest may carry total debt past the cap afterwards; that's intended, so the invariant is about borrows. |
| 7 | reserves ≤ cash + total debt (`totalAssets` never underflows) | exact |
| 8 | reserve drawn + socialized == total bad debt; Σ registry shortfall == total bad debt | exact |
| 9 | No position holds debt with zero collateral | exact |

## 6. Tests and coverage (2026-09-22)

`forge test`: **153 tests pass, 0 fail**, in 8 suites:

| Suite | Tests | What it covers |
|---|---|---|
| RiskParams | 11 | including 4 fuzz × 10,000 runs |
| ScoreRegistry | 48 | including a hand-built EIP-712 digest |
| TenorMarket | 78 | including fuzz on LTV, `maxBorrow`, liquidation bounds |
| Journey | 4 | the demo and the feedback loop, written as documentation |
| Reentrancy | 2 | hostile hook token |
| Mocks | 9 | |
| Invariants | 1 campaign | the 8 invariants of §5 run as one campaign; Foundry counts it as one test |

`forge coverage` on `src/`:

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| RiskParams.sol | 100% (38/38) | 93.85% (61/65) | 77.78% (14/18) | 100% (6/6) |
| ScoreRegistry.sol | 100% (61/61) | 100% (75/75) | 100% (15/15) | 100% (14/14) |
| TenorMarket.sol | 100% (234/234) | 100% (313/313) | 100% (33/33) | 100% (39/39) |
| MockERC20.sol | 100% | 100% | 100% | 100% |
| MockPriceOracle.sol | 100% | 100% | 100% | 100% |
| **Total** | **100% (348/348)** | **99.15% (464/468)** | **94.12% (64/68)** | **100% (64/64)** |

**Untested branches:** the four revert branches in `RiskParams.validate()`
(lines 131–134). They fire only if the constants are edited into an invalid
state, so the shipped constants can't reach them. `test_validate_passes` and
the bounds fuzz cover the passing side.

**Bugs the tests found and I fixed:**

- A liquidation on collateral worth under 1 wei of debt used to revert,
  leaving phantom debt in `totalAssets`.
- An invariant-handler overflow.

**Documented rather than "fixed":** after interest accrues, borrowing exactly
the limit rounds 1 wei over it. Rounding goes against the borrower on
purpose; `maxBorrow` gives a safe amount.

## 7. Lint review (`forge lint src`)

| Lint | Count | Verdict |
|---|---|---|
| block-timestamp | 9 | Intended: expiry, deadlines and interest are time-based. Monad timestamps have 1 s granularity, and the 60 s skew tolerance covers it. |
| require-revert-in-loop | 4 | `RiskParams.validate()`, a bounded 5-iteration loop, by design. |
| reentrancy-events | 3 | False positive: the "external call" is `ecrecover` (a precompile) or the oracle's `view` `getPrice` (a staticcall). Neither can re-enter. |
| missing-events-access-control | 1 | False positive: `setMarket` emits `MarketSet`. |
| unused-return | 1 | Intended: `maxBorrow` needs only the tier from `effectiveTier`. |

## 8. Trust assumptions

On testnet, **one deployer EOA holds every admin role below.** Say so in the
README.

| Role | Can | Cannot |
|---|---|---|
| Oracle owner (mock) | set any price, and so **make any position liquidatable** (a liquidator then takes the 5% bonus) | move funds directly |
| Attestor key | sign any score for any wallet, giving a wallet tier-A terms (80% LTV, 20,000 cap) | exceed caps; make a loan undercollateralized |
| Registry owner | rotate the attestor (same power as the attestor); **authorize a fake market that records liquidations against any wallet** (kills that wallet's score, pollutes history); pause attestations | touch market funds |
| Market owner | pause (blocks borrowing and liquidation); set caps (can freeze new borrowing) | withdraw lender funds, reserves or collateral. There is no such function. |

## 9. What an attacker can do (honest list)

1. **Keep a good score after misbehaving off Tenor.** A liquidation on Aave
   or elsewhere doesn't touch an already-submitted Tenor score until it
   expires (the service plans ≤ 24 h; the contract maximum is 48 h).
   Tenor's *own* liquidations invalidate it immediately. Bounded by
   per-wallet and per-tier caps.
2. **Buy an aged wallet with good history** and borrow at tier A. Bounded
   by the 20,000 cap per wallet and the tier-A aggregate cap. Loans are
   still overcollateralized, so lenders lose only on a price gap.
3. **Fill a tier's aggregate cap** so other wallets can't borrow at that
   tier (a griefing DoS). Bounded by per-wallet caps; the owner can raise
   caps.
4. **Front-run liquidations (MEV).** Standard for any market;
   first-come-first-served.
5. **Liquidate themselves.** No profit: they repay their own debt and
   receive their own collateral. It records a liquidation against them.
6. **Donate tUSD to the market.** Raises the share price, benefiting
   lenders. First-depositor inflation is mitigated by the 6-decimal virtual
   offset.
7. **Exploit a stale oracle.** If prices go stale beyond `maxPriceAge`,
   borrowing, liquidation and collateral withdrawal against debt all
   revert. Positions can then deteriorate unliquidated until prices resume.
   On testnet the mock must be refreshed; `maxPriceAge` is a deploy-time
   choice (Phase 4).
8. **Hold old terms after a score expires.** A position keeps its last-priced
   liquidation threshold until its next borrow or collateral withdrawal (by
   design, see §3). It can't take *new* risk on old terms.
9. **Relay someone else's attestation.** Harmless: it's their own signed
   score, and it only advances their nonce.

**Not possible, by test:**

- replaying signatures across chains, contracts or wallets, or reusing a
  nonce
- using an expired, out-of-range, malleable or tampered attestation
- re-entering any state-changing function
- borrowing above a tier's LTV or caps
- a stale or absent score pricing above FLOOR
- bad debt going unrecorded

## 10. Known limitations and deferred work

- **Single collateral, single borrow asset, both 18 decimals** (enforced in
  the constructor).
- **Reserves can't be withdrawn** (v1 has no treasury). They sit as a claim
  on the pool.
- **No keeper pushes score downgrades** (cut list).
- **Not deployed to testnet yet.** `script/Deploy.s.sol` deploys the whole
  stack and writes `deployments/<chainId>.json`. A dry-run on a local
  Monad-mode anvil was verified on 2026-09-22.
- **Two doc discrepancies found:**
  - Monad's verify guide lists `metadata`/`metadata_hash`, which Foundry
    1.8.3 rejects; `foundry.toml` uses `cbor_metadata`/`bytecode_hash`.
  - viem's `monadTestnet` explorer URL isn't one the Monad docs list.
