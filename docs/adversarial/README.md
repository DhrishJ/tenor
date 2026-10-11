# Adversarial pass on a live chain (Phase 5 §3, 2026-10-11)

Against the **rehearsal** deployment on Monad testnet (registry
`0x51c9…a098`, market `0x66DC…4408`), never the final one. Script:
`packages/attestor/scripts/adversarial-testnet.ts`. Rejection checks are
`eth_call` simulations against live state. Market checks and the loop are
real transactions from two throwaway wallets (borrower `0xA641…8687`,
liquidator `0x6E72…01BB`).

**Labelled test input:** the stale-score check needs a scored wallet we
control. No such wallet has borrowing history, so D1 uses a **TEST
attestation signed directly with the attestor key** (score 800, 90-second
lifetime, `modelVersion = keccak256("TEST: manual adversarial attestation,
rehearsal deployment only")`). EIP-712 binds it to the rehearsal registry.

## On-chain: attestations, market, loop (22/22 pass)

| ID | Check | Result | Evidence |
|---|---|---|---|
| A0 | Correctly signed attestation (control) | accepted | sim |
| A1 | Expired | `AttestationExpired` | sim |
| A2 | Replayed nonce | `InvalidNonce` | sim |
| A3 | Unauthorized signer | `InvalidSigner` | sim |
| A4 | Wrong chain id in the signature | `InvalidSigner` | sim |
| A5 | Wrong verifying contract | `InvalidSigner` | sim |
| A6 | Submit deadline passed | `DeadlinePassed` | sim |
| A7 | Issued in the future (> 60 s skew) | `IssuedInFuture` | sim |
| A8 | Lifetime over 48 h | `TtlTooLong` | sim |
| B1 | Unscored wallet priced at FLOOR | tier 0; maxBorrow 1,000 tUSD (wallet cap) for $2,000 collateral | tx `0xf664a4a4…` |
| B2a | maxBorrow vs the true limit | 3 wei under the 1,000 tUSD cap (a rounding margin) | read |
| B2 | True limit + 1 wei | `ExceedsWalletCap` | sim |
| B3 | Unscored wallet borrows exactly maxBorrow (first borrow) | success | tx `0x61821e84…` |
| C1 | Borrow while paused | `EnforcedPause` | sim |
| C2 | Liquidate while paused | `EnforcedPause` | sim |
| C3 | Repay and withdrawCollateral while paused | both succeed | txs `0x0f89a976…`, `0xc6855342…` |
| D1 | TEST attestation 800 accepted; tier while fresh | tier A | tx `0xecb47e7b…` |
| D2 | Same wallet after expiry | tier FLOOR | read |
| D3 | Expired score: borrow above floor terms | `ExceedsWalletCap` | sim |
| D4 | Expired score: borrow within floor terms | success | tx `0x24700c2b…` |
| E1 | Mock price $2.00 → $1.40; second wallet liquidates | HF 0.910; liquidation; registry `liquidationCount` 1; score stale; price restored | txs in `testnet-pass-2026-10-11-ACDE.json` |
| E2 | Score computed before the liquidation | `IssuedBeforeLiquidation` | sim |

Full records: `testnet-pass-2026-10-11-ACDE.json`. B rows are from the
first run's output (RUNNING_LOG, 2026-10-11).

## The attestation service (refusals)

| Check | Where | Result | File |
|---|---|---|---|
| Fresh wallet | hosted | INSUFFICIENT_HISTORY, floor terms | `hosted-fresh-wallet-2026-10-11.json` |
| Base/Optimism borrower `0x0438…7e09` | hosted | UNAVAILABLE (HTTP 503), each degraded source named | `hosted-base-op-borrower-2026-10-11.json` |
| Consistency check, **live**, `0x0199…887d` | hosted | UNAVAILABLE: "ChainScore's transaction history is empty for a wallet with 3 on-chain borrow(s)" (Arbitrum) | `hosted-consistency-check-2026-10-11.json` |
| ChainScore unreachable | local | UNAVAILABLE, chains named, "Not a low score" | `chainscore-down-local-2026-10-11.json` |
| HyperSync off, Alchemy up | **hosted** | SCORED 850 tier A, verification partial, gaps named | `hosted-alchemy-only-2026-10-10.json` |
| Both history sources down | local | UNAVAILABLE; ChainScore not queried | `both-history-sources-down-local-2026-10-11.json` |
| Scroll borrower | local, 2026-09-24 | UNAVAILABLE; ChainScore not queried | `scroll-hypersync-up-2026-09-24.json` |

## Problems this pass found (all fixed in the web app before the final deployment)

1. **"Max" borrow reverts for a wallet that already has debt.** `maxBorrow`
   keeps a 3-wei margin, but interest accrues every block (0.4 s), about
   6×10¹¹ wei/s on 1,000 tUSD, so the value is stale a block later
   (`ExceedsWalletCap`, tx `0xf0b6cfcf…`). Max borrow and All repay now keep
   10 minutes of interest as headroom. The brief's "maxBorrow + 1 wei
   fails" isn't the contract's boundary: maxBorrow + 1 wei succeeds; the
   true limit + 1 wei fails (B2).
2. **A transaction sent with the plain gas estimate ran out of gas**
   (withdrawCollateral, tx `0x54b1d2d8…`: "out of gas" in the final token
   transfer, per `debug_traceTransaction` on the public RPC). Why the
   estimate fell short is not established. Transactions now carry 30% +
   30k gas headroom.
3. **A reverted transaction was shown as success.** The web app only waited
   for the receipt; it now checks the status.

Not covered here: the per-tier *total* debt cap (`ExceedsTierCap`) and the
background-tab polling. Both are covered by contract tests and the Phase 3
browser walkthrough respectively, not re-run on testnet.
