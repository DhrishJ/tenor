# OBJECTIONS

Append-only. Each phase adds a section. Each objection gives what the brief
says, why it is wrong, the evidence, and what to do instead.

---

# Phase 1: Contracts and test suite (raised 2026-09-22)

Ranked by how much each one changes the build. **O1–O4 change the
architecture.** O5–O12 are corrections to specific sections. O13 is the gate.

## O1. The Monad argument in §6 is quantitatively false, and §5.5 would prove it

**Brief says:** "Faster finality means a liquidation executes closer to its
trigger price … the same loss budget supports a higher safe LTV. Monad's
sub-second finality therefore buys capital efficiency directly." §5.5 asks for
a simulation comparing 600 ms with 12 s.

**Why it's wrong:** Bad debt in an overcollateralized market needs the price
to fall *through the whole buffer* between the liquidation trigger and
execution. Under any continuous price model, the move you can expect in
0.6 s or 12 s is orders of magnitude smaller than a 6–10% buffer. The
block-time difference contributes nothing measurable. Shortfall comes from
**jumps** (instant gaps, where no chain speed helps) and from **multi-hour
failures**: oracles that stop updating, liquidators priced out by gas during a
crash, networks halting.

**Evidence** (zero-drift random-walk price model, computed 2026-09-22; the
code is in the session log and goes into `docs/` if we keep this): the chance
that price falls through the buffer during the liquidation delay.

| vol | LT | 0.6 s | 12 s | 1 min | 1 h | 6 h | 24 h |
|---|---|---|---|---|---|---|---|
| 80% | 94% | 0 | 0 | 0 | 2e-13 | 1.6e-3 | 7.0e-2 |
| 150% | 90% | 0 | 0 | 0 | 2e-11 | 3.6e-3 | 9.0e-2 |

At 80% vol, a one-standard-deviation move equal to a 5% buffer takes **36
hours**. Block time is not the variable that matters.

An honest §5.5 would output "no measurable difference between 600 ms and
12 s". Presented alongside §6, that refutes the pitch in our own repo, and a
Paradigm or Dragonfly judge will run the same arithmetic.

**Instead:** drop §5.5 (it's first on the cut list anyway). Replace the §6
wording with a claim that survives the arithmetic:

> Liquidations only protect lenders if they land when markets crash, which is
> exactly when congested chains price them out or delay them (Black Thursday,
> March 2020, is the canonical case). Monad's throughput and low fees keep
> liquidation cheap and prompt under load, so the liquidation threshold
> buffer is not eaten by congestion. Score attestations refresh roughly
> daily; nothing here depends on per-block repricing.

This is an argument, not a measurement, and we label it that way. If you want
a quantitative piece, the honest version models **liquidation delay under
congestion in minutes to hours, plus jump risk**, not 0.6 s vs 12 s. It's
still first on the cut list.

## O2. A shortfall-keyed feedback loop almost never fires; key it on liquidations

**Brief says (§4):** a liquidation with shortfall calls `recordShortfall`;
this is "the single most important thing in the repo".

**Why it's wrong:** By O1, shortfall in an overcollateralized market needs a
price jump bigger than the buffer. In real conditions that's rare. In our demo
it happens only because we move the mock oracle by hand. A headline feature
that fires only when an admin stages a gap is weak, and a judge will see that.

The model's label is *liquidation*, not shortfall. A liquidation on Tenor is
exactly a positive example of what the model predicts, observed natively on
Monad.

**Instead:** record **every liquidation**, plus shortfall when there is one:

- `liquidationCount`, `lastLiquidatedAt`, `shortfallCount`, `totalShortfall`.
- The pitch gets stronger: *Tenor generates native Monad credit history*.
  Every liquidation becomes a labelled outcome, so the cold-start problem
  shrinks with use.
- Shortfall stays tracked as the more severe event.
- The loop fires in every liquidation demo, not only staged gaps.

## O3. The penalty must be enforced on-chain, not left to the attestation service

**Brief says (§4):** "The attestation service reads defaultCount and
totalShortfall and lowers the wallet's next score."

**Why it's wrong:**

1. **An old attestation still works.** Signatures issued *before* the
   liquidation stay valid until their submit deadline, and an
   already-submitted score stays valid until its TTL. A borrower liquidated
   at 10:00 still holds a valid high score until it expires.
2. **The penalty depends on off-chain code**, which is exactly the trust
   assumption a judge will attack.
3. **"Lowers the score" means changing the model's output** with a
   hand-written rule, and it must not be passed off as the model's number.

**Instead:** enforce it in the registry.

- A recorded liquidation **immediately invalidates** the wallet's current
  score (`isStale = true`, so the wallet falls back to unscored terms).
- The registry **rejects any attestation with
  `issuedAt ≤ lastLiquidatedAt`**.
- The off-chain service then applies a documented *policy overlay*, for
  example "tier capped at C for 90 days after a Tenor liquidation". It is
  labelled "Tenor policy", not "ChainScore score".

All of this is on-chain and fully testable in Phase 1. It's a few lines in
the registry.

## O4. Per-tier rates have no loss-based justification; use one rate and let the score move LTV only

**Brief says (§3.1):** `tierToRate(tier, utilization)`, "derived from an
assumed annualized liquidation rate per tier".

**Why it's wrong:** In an overcollateralized market, **a liquidation costs the
lender nothing**. The liquidator repays the debt in full, and the *borrower*
pays the bonus. Lender loss is shortfall only, and by O1 shortfall is driven
by jumps and outages, not by who the borrower is. A rate premium "derived
from the liquidation rate" prices a cost the lender doesn't bear. The
arithmetic the brief asks me to write out would show the premium should be
about zero.

**Instead:**

- **One rate curve for all borrowers** (a linear utilization curve plus a
  reserve factor). The score changes **LTV and caps only**.
- The demo message gets cleaner: "same loan, same rate, 40% less
  collateral".
- This also answers §0.1's index question (see O5).

If you want a tier rate premium anyway, the honest version is a
reserve-contribution premium: lower tiers get liquidated more often, and each
liquidation is a gap exposure, so they pay more into the reserve. We'd label
it a policy placeholder with no calibration.

## O5. Answer to §0.1: yes to an index, but one global index, and no supply index

**Brief says:** "borrow and supply indices"; asks whether index-based accrual
is worth it.

**Assessment:**

- **Per-tier rates** (the old plan) would need six tier buckets and
  "re-bucketing" debt whenever a score changes. That's the riskiest code in
  the market.
- **With O4, one global borrow index** (Compound-style) is less code than
  per-position linear interest, and it makes "sum of debts equals total debt"
  a clean invariant.
- **A supply index is unnecessary:** ERC-4626 share accounting prices lender
  shares off `cash + totalDebt − reserve`. Interest and socialized losses show
  up in the share price automatically. That also covers §2.2's "documented
  index adjustment": socializing bad debt just means writing down
  `totalDebt`, which lowers the share price. No second index.

**Instead:** one borrow index (1e27 precision), ERC-4626-style lender shares
with virtual-offset protection against inflation attacks, and no supply index.

## O6. §3.4 contradicts §5.4: "borrow enforces score present, not stale"

**Brief says:** borrow requires a present, fresh score, **and** §5.4 has an
unscored wallet borrowing ("borrows materially less"). The §5.3 invariant says
"no borrow was ever priced by a stale or absent score".

**Why it's wrong:** You can't have both. The approved design (PLAN §2.3) has
absent or stale scores fall back to **unscored terms**. The contrast between
unscored and scored terms *is* the demo.

**Instead:**

- **Borrow rule:** a stale or absent score prices at **Unscored** terms,
  never better.
- **Invariant:** "every borrow is priced at the tier of the score that was
  valid in that block, or at Unscored terms".

## O7. The shortfall definition in §3.4 is mis-specified

**Brief says:** "calls recordShortfall when seized collateral does not cover
repaid debt".

**Why it's wrong:** A correctly built liquidation caps the repay so the
liquidator never repays more than the collateral they seize:
`maxRepay = collateralValue / (1 + bonus)`. Seized collateral *always* covers
the repaid debt. Shortfall is the debt **left over** once the collateral is
exhausted, which no liquidator will ever repay.

**Instead:** when a liquidation leaves collateral at 0 and debt above 0, the
remaining debt is realized shortfall:

1. Write it off from `totalDebt`.
2. Draw it from the reserve.
3. Socialize any remainder through the share price.
4. Call `recordShortfall`.

Dust collateral that isn't worth liquidating is handled by letting the
liquidator seize all remaining collateral when it's below the
repay-equivalent.

## O8. Answer to §0.1: drop the close factor; add an on-chain bound on LT × bonus

**Brief asks:** is "close factor plus bonus" sufficient, given a mock oracle?

**Assessment:** A close factor protects big positions in deep markets from
being over-liquidated. Our caps keep positions small, and a 50% close factor
adds repeated partial calls, dust, and a harder shortfall invariant.

There's also a hard constraint the brief doesn't state: a liquidator is paid
in full at the trigger only if **LT × (1 + bonus) ≤ 1**. At LT 94% with an 8%
bonus the product is 1.015, which means liquidators lose money at the trigger
and positions rot.

**Instead:**

- **Close factor 100%:** the liquidator chooses any repay amount up to the
  cap in O7.
- **Fixed bonus of 5%.**
- A **compile-time check in RiskParams** that `LT × (10000 + bonus) ≤ 10000²`
  for every tier, alongside the `maxLTV < 10000` ceiling.
- On-screen label in the demo: the price drop that triggers liquidation is
  staged through the mock oracle.

## O9. §0.1 LTV band: the model's reproducible performance supports no specific spread

**Brief asks:** what spread does the model's actual performance support?

**Answer:** none. Nothing about the model's performance has been reproduced
(INVENTORY §7). At most we can rely on its *ranking*, and even that is
unverified.

Also, per O4, lender risk from LTV is gap risk, which depends on the
collateral's volatility, not the borrower. The score legitimately affects
**how often a position gets near the threshold**, and therefore how much gap
exposure it creates. That supports **ordering** the tiers, not sizing the
gaps between them.

**Instead:**

- Label the LTV band a **risk-appetite policy placeholder**, not a
  calibration.
- Set the **top tier by the LT × bonus bound and the buffer**, not by the
  model.
- **Narrow the spread** so an unverified ranking can't move terms too far.

Proposed values (all placeholders):

| Tier | Max LTV | LT | Buffer |
|---|---|---|---|
| Unscored = F | 60% | 70% | 10 pts |
| D | 65% | 75% | 10 pts |
| C | 70% | 78% | 8 pts |
| B | 75% | 82% | 7 pts |
| A | 80% | 86% | 6 pts |

At the extremes, $1,000 of debt needs $1,667 of collateral unscored and
$1,250 at tier A. That still lands in 45 seconds.

## O10. The §1 framing overstates, and a sharp judge will catch it

**Brief says:** "setting a liquidation-risk parameter (LTV) using a
liquidation-risk model … is the correct application of that label. Do not
apologize."

**Why it's wrong:** The direction is right, but the claim goes further than
the evidence. The model measured liquidation propensity **at the LTVs
borrowers chose on Aave/Compound**. Tenor lets them borrow at a *different*
LTV. Whether the ranking still holds when the buffer changes is an
assumption. Stating it confidently isn't apologizing; hiding it is what a
judge will call out.

**Instead:** use this wording in comments and docs:

> Tenor sets a liquidation-risk parameter from a liquidation-risk model: the
> score ranks how likely a wallet is to run a position into liquidation, and
> Tenor gives lower-risk wallets a thinner buffer. We assume that ranking,
> measured on Aave and Compound, carries over to Tenor's LTVs. Tenor's own
> liquidation records (O2) are what will test it.

## O11. Two §5.3 invariants are false as written

- **"Total exposure never exceeds the global cap."** Interest accrues after a
  borrow, so total debt can pass the cap with no new borrowing. That's
  intended behavior, not a bug.
  **Instead:** "no borrow succeeds that would push total debt above the cap,
  evaluated after accruing interest".
- **"Recorded shortfall plus reserve draw equals realized shortfall."** This
  double-counts. `recordShortfall` records the *full* realized amount against
  the wallet, and the reserve is one of two places the loss goes.
  **Instead:** two invariants:
  - Σ recorded shortfall == Σ realized shortfall
  - reserve draw + socialized loss == realized shortfall

## O12. Smaller corrections

- **Tier stored in the registry (§3.2).** Derive it from the score through
  `RiskParams` at read time. A stored tier goes stale the moment RiskParams
  changes, and then two fields can disagree.
- **Pause semantics (§3.4)** need one more rule:
  - During a pause, **allow** repay, adding collateral, lender withdraw (up
    to available cash), and collateral withdraw (still subject to the health
    check).
  - **Block** borrow and **liquidate.** If we paused because the oracle is
    wrong, liquidating on it would be harmful.
  - Borrowers are never trapped: they can always repay and then withdraw.
- **"supply" is ambiguous.** The market needs both a lender path
  (`deposit`/`withdraw`) and a collateral path
  (`depositCollateral`/`withdrawCollateral`). The brief lists only one.
- **Domain separator (§3.2).** OpenZeppelin's `EIP712` already caches it and
  rebuilds it when `block.chainid` changes. We use it rather than
  hand-rolling, and a test forks the chain ID to prove it.
- **The ban on the word "undercollateralized" (§1).** INVENTORY, PLAN and this
  file use it to record *why* we rejected it. Rewriting decision records
  erases the audit trail you asked judges to rely on. Proposal: banned in
  code, UI, README (except the "why not" section) and the submission;
  allowed in decision records (PLAN, OBJECTIONS, RUNNING_LOG).
- **§5.4 "re-attest at a lower score".** In Phase 1 the test signs the lower
  score itself, standing in for the service. With O3 it additionally proves
  that the *old* score is dead on-chain, which is the part that matters.

## O13. Gate check is false

**Brief says:** "Git identity set, first commit made."

**Evidence (2026-09-22):** `git config --global user.name` and `user.email`
are empty, and `git log` reports "your current branch 'main' does not have
any commits yet". Foundry is also not installed.

**Instead:** you set the git identity, and I make the first commit (Phase 0
docs and the rename to Tenor), then install Foundry (≥ 1.8.0) before any
contract code.

## Still unanswered from Phase 0 (not blocking Phase 1, blocking later)

- **Q3:** worst-of-chains aggregation (affects Phase 2).
- **Q4:** is a testnet submission eligible? The portal shows chain 143.
  (Affects everything.)
- **Q5:** a demo wallet with real Aave or Compound history (affects
  Phases 2 and 4).
- **Q6:** ChainScore API as a black box vs vendoring the scorer (affects
  Phase 2).

## Assumptions I'm least confident about in my own objections

1. **O4 (one rate for all):** it makes the "rate differs" half of the
   original demo disappear. If you value the visual contrast in rates, the
   reserve-premium variant keeps it, labelled as policy.
2. **O1's reframe** still rests on an unmeasured claim: that Monad keeps
   liquidations prompt under crash-level load. It's a plausible design
   argument, not evidence, and must be presented that way.

## Phase 1 resolutions (2026-09-22)

| # | Decision |
|---|---|
| O1 | Accepted. §5.5 is dropped; the §6 wording is deleted (it never reached code). The replacement framing is adopted, amended per O14 below. |
| O2 | Accepted. The registry records `liquidationCount` and `lastLiquidatedAt` (these drive the feedback loop), plus separate `shortfallCount` and `totalShortfall`. |
| O3 | Accepted. The registry rejects any attestation with `issuedAt <= lastLiquidatedAt`, and a liquidation invalidates the current score. Tested in Phase 1, and again in the Phase 4 adversarial pass. |
| O4 | Accepted. One rate for everyone, one global borrow index, share-based supply. The reserve is respecified in share terms (see CONTRACTS.md). |
| O6 | Resolved. A present score must be fresh. An absent or stale score prices at the floor tier. |
| O7, O11 | Mine to resolve. As proposed. |
| O8/O9 | Accepted. LTV 60–80%, each liquidation threshold = LTV + 5 points, no close factor, fixed 5% bonus, permanent compile-time bound. |
| O12 | No answer. My proposal applies by default: the word is banned in code, UI, README (except the "why not" section) and the submission; allowed in decision records. |

## O14. Pyth's staleness is not evidence of oracle cadence; remove it from the Monad argument

**Brief says:** "The price oracle updates far slower than blocks … Pyth's
MON/USD feed was 15 days stale … the oracle refreshes on a cadence measured
in minutes at best."

**Why it's wrong:**

- **Pyth is a pull oracle.** The on-chain price is only as old as the last
  transaction that pushed an update. On mainnet, a liquidator fetches a price
  from Pyth's off-chain price service, Hermes (published every ~400 ms), and
  posts it *in the liquidation transaction itself*. Then oracle freshness is
  sub-second and set by the liquidator, not by a cadence. The 15-day
  staleness we saw is an **unused testnet feed** that nobody pulled. It tells
  us nothing about production timing.
- **Push oracles don't work that way either.** They update on deviation
  (RedStone on Monad testnet: 0.5% deviation *or* a 6 h heartbeat). The
  6-hour heartbeat applies to a flat market. During a crash, the 0.5%
  deviation trigger fires on every such move.

A judge who knows Pyth would read this line as us misunderstanding pull
oracles, and that would undercut the O1 argument that's actually sound.

**Evidence:** RESEARCH.md §4 (Pyth listed as "Pull"; RedStone "0.5%
deviation & 6h heartbeat"), and the Monad oracle docs describing Pyth as
"Users pull aggregated prices … onto Monad when needed".

**Instead:** leave the oracle out of the timing argument. Mention the stale
Pyth feed only where it's true: as the reason Tenor uses a mock on testnet.

**One wording fix to the adopted framing:** "a race run by bots against a
congested mempool". Monad has **no global mempool** (docs:
developer-essentials/differences, "Transactions" §5). Use "a race run by
bots for scarce block space".

## O15. "The loop is the label" overstates it by one step

**Brief says:** a Tenor liquidation "is the label … Tenor produces the
precise outcome variable ChainScore was trained to predict."

**Why it's wrong:** ChainScore's label is a liquidation **on Aave V2/V3 or
Compound V2**, under **those protocols' LTVs and thresholds**, inside a
**fixed six-month window after an observation cutoff** (`LABELS.md`). A Tenor
liquidation is the same *kind* of event with different parameters. Worse,
it's **caused partly by Tenor's own terms**: high-score wallets get thinner
buffers, which mechanically raises their chance of liquidation. A model
retrained on Tenor liquidations without accounting for this learns from terms
its own scores set (a feedback loop between score and outcome). "The precise
outcome variable" is exactly the kind of data claim a judge can pull apart.

**Instead:**

- Claim: "Tenor records, on-chain, the same kind of event ChainScore
  predicts (a liquidation), together with the terms it happened under, so
  future model versions can learn from Monad-native outcomes."
- To make that true, **every `Borrow` and `Liquidate` event carries the score,
  tier, max LTV and liquidation threshold in force.** That's a small addition
  to the event design, now in the contracts.

## O16. "Tier-differentiated rates point the wrong way" is unproven

**Brief says:** priced honestly, residual bad debt sits with the high tiers,
so tier rates "point the wrong way".

**Why it's wrong:** Expected gap loss per position is roughly
P(position reaches liquidation) × P(gap exceeds buffer | liquidation) ×
severity. High tiers have a lower first factor (per the model's ranking) and
a higher second factor (thinner buffer). The net direction depends on
magnitudes we haven't measured. The honest statement is "undetermined", not
"reversed".

**Instead:** the README says the score doesn't change the rate because the
LTV already absorbs the risk difference, and residual gap loss is priced
uniformly through the reserve factor. Make no claim about which direction
tier rates "should" go. Suggested two sentences:

> In a collateralized market the interest rate compensates lenders for
> expected loss, and the LTV controls how much loss is possible. A normal
> liquidation repays the lender in full, so the score acts on the LTV, and
> the small residual gap risk is priced uniformly through the reserve factor.

---

# Phase 2: Attestation service (raised 2026-09-22)

Evidence was gathered on 2026-09-22. Re-probes of the live API are shown
where relevant.

## P2-O1. The gate check is false

**Brief says:** "Commits made. Deploy script written and tested against a
local Monad-mode node."

**Evidence:**
- `git config --global user.name/user.email` are both empty.
- `git log` says "your current branch 'main' does not have any commits yet".
- `contracts/script/` is empty.

**Instead:**
- You set the git identity, and I commit (Phase 0, 1 and 2 docs; contracts
  and tests as separate readable commits).
- The deploy script plus a local Monad-mode anvil dry-run is Phase 1 work
  that was approved as "next". I'll finish it before any Phase 2 code; it's
  under an hour.

## P2-O2. "Every source on every chain healthy" would refuse every wallet, forever

**Brief says (§4b):** refuse unless "every upstream source for every chain
queried reported healthy."

**Why it's wrong:** Two chains are degraded on every call, not now and then.
Etherscan's docs list **Base, OP Mainnet and Avalanche as paid-tier only**,
and ChainScore's key is free tier.

**Evidence:**
- Probes of `chainscore.dev/api/score/0x0438…7e09`, twice per chain:
  - Base: `degradedSources: ["etherscan","aave"]` both times.
  - Optimism: `["etherscan"]` both times.
- Etherscan's supported-chains page lists Base, OP Mainnet and Avalanche
  under "Paid Tier Only".

**Instead:** only chains that could change the result must be healthy.

1. The independent history check (P2-O4) decides, per chain, whether the
   wallet has ever borrowed on Aave or Compound.
2. **No borrowing on a chain:** exclude that chain, with the reason
   recorded. ChainScore can't score it anyway, since its model only scores
   borrowers. Its health doesn't matter.
3. **Borrowing on a chain, but ChainScore degraded there: UNAVAILABLE.**
   Excluding that chain would let a wallet benefit from a provider outage
   under the min rule.
4. **Our own independent check fails for a chain: UNAVAILABLE.**

Consequence you should know: with ChainScore's current Etherscan plan,
**any wallet that has borrowed on Base or Optimism will always be
UNAVAILABLE**. Its transaction-history features would be zeros, so any score
would be wrong. The fix is on the ChainScore side (a paid Etherscan plan),
which is your call. I haven't verified plan prices, so I'm not quoting one.

This answers your §0.1 question: as written, the rule isn't just
over-strict, it's total. Scoped this way, a transient failure refuses only
when it touches a chain the wallet actually borrowed on. The demo shows that
as UNAVAILABLE plus a retry.

## P2-O3. An independent history check would NOT have caught the 850-with-zero-transactions case

**Brief says (§4a):** the independent history check "is the check that
catches 850-with-zero-transactions."

**Why it's wrong:** That wallet has *real* Aave borrowing on Arbitrum. The
bad input was an empty transaction history from Etherscan that ChainScore
didn't flag.

**Evidence:**
- Today's re-probe of the same wallet on Arbitrum returns
  `totalTxns: 188, walletAge: 801, protocolsUsed: ["Aave"]`, score 850.
- In Phase 0 the same call returned `totalTxns: 0` with no degraded source.
- An independent borrowing check passes this wallet in both cases.

**Instead:** add an **internal-consistency check (4e)** alongside 4a. For
any chain where ChainScore returns a score from borrowing history,
`totalTxns > 0` and `walletAge > 0` are required. Otherwise the transaction
source failed silently, so the result is UNAVAILABLE for that chain. Keep 4a
for what it actually catches: ChainScore saying "no borrow history" or "new
wallet" where borrowing really exists, or scoring a chain with none.

## P2-O4. The independent history check is feasible for free, with two caveats

**Brief asks (§0.1, §4a):** is an independent borrowing check feasible
without a paid data provider?

**Answer: yes, via Envio HyperSync's free tier.** It needs an Envio account
and API token, which only you can create at `envio.dev/app/api-tokens`.

- **Coverage:** HyperSync natively serves all 7 chains: 1, 42161, 10, 8453,
  137, 43114 and 534352 (docs.envio.dev, supported networks).
- **Aave V2/V3:** `Borrow(address indexed reserve, address user, address
  indexed onBehalfOf, …)`. `onBehalfOf` is indexed (verified in
  `aave/aave-v3-core` `IPool.sol`), so it's one filtered log query per pool
  over the full history.
- **Compound V2:** `Borrow(address borrower, …)` has **no indexed fields**
  (verified in `compound-protocol` `CTokenInterfaces.sol`), so it can't be
  filtered by borrower. The approximation is transactions *from* the wallet
  *to* a cToken calling `borrow(uint256)`. **It misses borrows made through
  a contract** (DeFi Saver, Instadapp, a Safe). This is documented as a
  false-negative source.
- **Cost:** $0 on the free plan ("fair-use based rate limiting"). If we hit
  limits, Starter is $70/month for 100 requests/minute (envio.dev pricing
  page).
- **What "independent" means here:** independent of ChainScore's pipeline
  (different provider, raw logs rather than ChainScore's subgraphs), not of
  the chain itself.
- **Addresses:** pool and cToken addresses come from the official Aave
  address book and Compound's deployments, fetched rather than remembered.

**Rejected alternatives:**
- Public-RPC `eth_getLogs`: block-range limits make full-history scans
  impractical.
- The Graph: it's the *same* source ChainScore uses, so not independent, and
  it needs a key.

**Needed from you:** an Envio HyperSync API token.

## P2-O5. The "aggregation consistency" rule (4d) would throw away the signal the min rule exists for

**Brief says (§4d):** refuse unless per-chain scores are "consistent enough
to aggregate".

**Why it's wrong:** Under a minimum rule, scores that disagree across chains
are usually information, not error. Clean on Arbitrum and liquidated on
Polygon is exactly the wallet the min rule should price low. Refusing it
shows UNAVAILABLE (floor terms, no score) and hides *why*.

**Instead:** define consistency *per chain*, as agreement between ChainScore
and the independent check:

- ChainScore says no borrowing or new wallet, but borrowing exists on that
  chain: **UNAVAILABLE**. ChainScore is missing data.
- ChainScore scores a chain where no borrowing exists: **UNAVAILABLE**.
  ChainScore reports something we can't corroborate.
- Otherwise the chain counts, and the min is taken over the counted chains.
  Disagreement *between* chains is shown in the per-chain breakdown, not
  refused.

## P2-O6. The nonce requirement and "never cache signatures" pull against each other

**Brief says (§8):** "Two concurrent requests for one wallet must never
produce two signatures on one nonce", and "cache scores, never signatures."

**Why it needs care:**

- **Why it matters:** two *different* payloads on the same nonce let a
  wallet pick the better one.
- **Identical re-signing is harmless:** the same payload signed twice gives
  identical bytes, because viem's secp256k1 signing uses deterministic
  RFC 6979 nonces. I'll prove this in a test rather than assume it.
- **What "concurrent" means in production:** requests hitting separate
  serverless instances, so an in-process lock proves nothing.

**Instead:**

- Keep a **payload reservation** per (wallet, nonce), valid until its
  15-minute submit deadline. A second request re-signs the *reserved
  payload*, producing the identical signature, instead of building a new
  one. Only the payload is stored, never a signature.
- After the deadline passes unused, a new payload may be reserved.
- The reservation lives in the shared store (P2-O9) and is claimed with an
  atomic insert-if-absent.

## P2-O7. "Never issue an attestation the registry will reject" can't be guaranteed; the precise version can

**Brief says (§8):** re-check `lastLiquidatedAt` and "never issue an
attestation the registry will reject."

**Why it's wrong:** Things can land between signing and submission and make
the registry reject a valid signature: a liquidation, another attestation
advancing the nonce, or the deadline passing. That's the registry doing its
job.

**Instead:** "never issue an attestation that the registry would reject
*against chain state at signing time*". Rejections after that are the
registry enforcing policy, and the UI explains them.

**A related trap: `issuedAt` must be the upstream *data* time**, not our
signing time:

- ChainScore v1 envelopes can be cached, or served as a last-known-good
  result up to 7 days old when providers fail (`stale`, `cached`, `asOf`,
  `computedAt` fields).
- We take `issuedAt` from ChainScore's `computedAt` and refuse `stale: true`.
- If `computedAt ≤ lastLiquidatedAt`, we bypass our cache and fetch fresh.
  If it's still ≤, the result is UNAVAILABLE.

## P2-O8. Which ChainScore endpoint: the v1 API needs a key that only you can mint

**Brief says (§3):** call chainscore.dev. It doesn't say which endpoint.

**Evidence:**

| Endpoint | Auth | Limits | Notes |
|---|---|---|---|
| Legacy `GET /api/score/[address]` | none | `x-ratelimit-remaining` fell 19 → 14 over 6 probes, so about 20 per window per IP | deprecated (`Deprecation: true` header); serverless egress IPs are shared |
| v1 `GET /api/v1/score/[address]` | `Bearer cs_live_…` | free plan: **1,000 scores/month, 30/minute** (`lib/pricing/plans.ts`) | returns `computedAt`, `stale`, `cached`, integrity penalty |

**Instead:**

- Use **v1**, with a key minted by you:
  `npx tsx scripts/mintApiKey.ts "Tenor" 120` against the production
  database.
- Give that key a non-free plan row, since it's your database. At 7 chains
  per attestation, the free plan allows about 140 attestations a month.
- With P2-O2's scoping, we only call ChainScore for chains where borrowing
  exists, typically 1–2 calls per attestation, not 7.

**Naming:** the "ChainScore score" is v1's `score`, which includes
ChainScore's own integrity penalty. `modelScore` is logged alongside it.

**Needed from you:** the v1 API key.

## P2-O9. The service needs a shared store, which the brief never names

**Brief says:** rate limits, a score cache, nonce safety, and a refusal log
"queryable for the demo". It names no store.

**Why it matters:** in a serverless deployment, in-memory state is
per-instance. None of those four features work without shared storage.

**Instead:**

- A storage interface with two implementations:
  - **in-memory**, for unit tests and the local end-to-end run;
  - **Postgres**, for deployment. You already have Supabase.
- Postgres gives the refusal log as a table (`GET /refusals` for the demo),
  and a unique constraint on (wallet, nonce) for P2-O6.
- The service core is a framework-free TypeScript library, with a small HTTP
  adapter for local runs. Phase 3 mounts the same core in Next.js route
  handlers, so there is one implementation.

**Needed from you:** confirm Supabase Postgres. A new project, separate from
ChainScore's, is recommended.

## P2-O10. Section 6 names a field that doesn't exist; a proposed penalty scale

- **The field:** the registry has `shortfallCount`, not `defaultCount`
  (per O2 and CONTRACTS.md).
- **Proposed penalty (policy placeholder, in the model's own units):**
  ChainScore's score band is points-to-double-odds with PDO = 72.2
  (`model_meta.json`), so 72 points means "double the odds of
  liquidation".
  - **Each Tenor liquidation in the last 180 days:** −72 points, up to 3
    (−216).
  - **Any shortfall in the last 180 days:** the Tenor score is capped at 451
    (FLOOR).
  - Example: an 800 wallet liquidated once drops to 728 (tier A to B); with
    a shortfall it drops to FLOOR. The drop is unmistakable, and every step
    is itemized.

## P2-O11. §9's "service refuses to reissue it" needs precision, or it breaks the feedback loop

**Brief says (§9):** after a liquidation, "confirm the service refuses to
reissue [the pre-liquidation attestation]."

**Why it's wrong as worded:** The service should never re-serve a payload
from *before* the liquidation (enforced by P2-O7). But it must **issue a new,
penalized attestation from post-liquidation data**. That's step 7 of the
approved journey (re-attest at a lower score). A flat refusal would stop the
loop.

**Instead, the test asserts three things:**
1. The old signature is rejected on-chain.
2. The service's next response has `issuedAt > lastLiquidatedAt` and
   carries the penalty.
3. That new attestation is accepted on-chain at the lower tier.

## P2-O12. The distribution check is blocked by the HyperSync token, not by Q5, and SCORED end to end doesn't need Q5 at all

**Brief says (§2):** the distribution check and "genuinely scoreable" paths
are blocked on Q5.

**Why it's wrong:**

- **Distribution check:** it needs *read-only* multi-chain borrowers.
  HyperSync can find them (wallets with Aave `Borrow` logs on 2 or more
  chains). ChainScore's own `ml/features.csv` also lists 2,995 historical
  borrower addresses to use as read-only test subjects. The data file stays
  in `_reference/`; nothing is shipped. The blocker is the HyperSync token
  (P2-O4), and the whole check should take under an hour once it arrives.
- **SCORED end to end:** `submitAttestation` is permissionless, and anvil
  can impersonate any address. So the full path works on local anvil
  **with a public real borrower's address**: score from the live upstream,
  sign, submit, read back, borrow as that address, liquidate, re-attest.
- **What Q5 still blocks:** only the *testnet demo*, where a real key must
  sign in a browser. That's Phase 4, as you said.

## Answers to §0.1

| Question | Answer |
|---|---|
| Is the min rule too flat? | Unknown until the distribution check runs. It needs the HyperSync token, not Q5, and uses public borrowers (P2-O12). If it collapses to FLOOR, I bring it to you before continuing. |
| TTL | **Keep 24 h.** The exposure it leaves open: a wallet liquidated on Aave or Compound keeps its Tenor terms until expiry, bounded by the caps in CONTRACTS.md §9.1. A shorter TTL adds friction twice: users re-attest more often, and every re-attestation spends ChainScore quota (P2-O8). With 1–2 calls each, 24 h is sustainable; 6 h would roughly quadruple quota use for a window Tenor can't observe anyway. Tenor's own liquidations are already covered instantly on-chain. |
| Independent history check | Feasible for free with a HyperSync token; Compound V2 is approximate (P2-O4). |
| Refusal when degraded | Over-strict as written: total, in fact (P2-O2). Scoped to chains with verified borrowing, it's correct. |

## What I need from you before Phase 2 code

1. Git identity (for commits).
2. An Envio HyperSync API token.
3. A ChainScore v1 API key minted for Tenor, preferably on a non-free plan
   row.
4. Confirm Supabase Postgres for the service store (a new project).

Meanwhile, with your OK, I can do the deploy script and dry-run (Phase 1
remainder), the refusal layer, the three states, the aggregation interface,
the signing, the nonce reservations and the in-memory store. All of that is
testable without any of the four items above.

## Phase 2 resolutions (2026-09-22)

All twelve approved. TTL stays 24 h. Additions from your approval, now
requirements:
- The README says the upstream "does not distinguish 'no data' from
  'provider failed', and the layer in front of it does."
- The UI names the chain when a wallet is UNAVAILABLE for chain-data
  reasons.
- The Compound contract-wallet gap goes in the README.
- Impersonation is used only in local tests and never appears in the demo.
- ChainScore quota burn is tracked in RUNNING_LOG.md.

## P2-O13. (Raised mid-phase) The v1 endpoint cannot support the primary defense; the legacy endpoint can

**Approved decision:** use ChainScore v1 (P2-O8).

**Why it's wrong:** the consistency check you made the primary defense
(P2-O3: a borrowing-derived score alongside `totalTxns == 0`) needs
`totalTxns` and `walletAge`, and **the v1 response doesn't contain them**.

**Evidence:**
- `lib/scoring/service.ts` `buildEnvelope()` returns score, grade,
  percentile, modelScore, modelVersion, featureSetVersion, calibratedPD,
  factors, integrity, dataCompleteness, degradedSources, newWallet,
  noBorrowHistory, asOf, computedAt, cached and stale. There is no
  transaction count and no wallet age.
- The legacy `GET /api/score/[address]` returns `walletAge` and `totalTxns`
  (seen live in every probe).
- The legacy route computes fresh on every call: no cache and no
  last-known-good. It's limited to **20 requests per minute per IP**
  (`middleware.ts`, `expensiveLimiter`).

**Options:**
1. **Legacy endpoint (recommended).** It has the fields the primary defense
   needs, needs no API key, and never serves stale or cached data (so
   P2-O7's stale case can't occur). Costs:
   - It's marked deprecated.
   - 20/min per egress IP. At 1–2 calls per attestation, plus our 24 h
     cache, that's fine for demo scale.
   - It lacks `computedAt`. Its `timestamp` is the computation time, and it
     serves that role.
   - It returns no integrity penalty field. Its `score` is the model score,
     which is the right thing to call the "ChainScore score".
2. **v1 plus parsing the transaction count from `factors[].explanation`
   text.** Fragile; rejected.
3. **Add `walletAge`/`totalTxns` to ChainScore's v1 envelope.** That's a
   change to the prior-art repository made during the window, and it blurs
   provenance. Rejected unless you want it.

**Status:** the upstream client sits behind an interface. I've built the
legacy adapter (it needs no credentials, so it's testable now). Switching to
v1 is a one-file change. **Needs your confirmation.** It also means **no
ChainScore API key or Vercel login is needed.**

---

# Phase 3: Indexer and frontend, plus the bounty addendum (raised 2026-09-22)

## P3-O1. Gate claim: "Tier cap on liquidation implemented" is false

**Evidence:** `packages/attestor/src/policy.ts` has three rules:
`tenor-liquidation` (−72 per liquidation), `tenor-shortfall-cap` (451 on
shortfall), and `range-clamp`. At the Phase 2 gate I proposed a tier cap
after a liquidation as an *option* and said "I haven't changed it."

**Instead:** confirm the rule. My proposal: after any Tenor liquidation
within 180 days, the Tenor score is capped at 642, the top of tier C. Once
confirmed, it's a small policy change with tests. See P3-O2 for how it is
displayed.

## P3-O2. A tier cap can't be "shown rather than folded into the number" on-chain; it can in the UI

**Brief says (3.1):** show "any tier cap … as a policy cap rather than folded
into the number."

**Why it needs care:** the registry derives the tier from the *signed score*
(`RiskParams.scoreToTier`). The score is the only channel a cap can travel
on-chain, so a tier cap has to be enacted as a score ceiling, exactly as the
shortfall cap already is (851 → 451).

**Instead:**
- On-chain it stays a score ceiling.
- In the service response and the UI it is itemized as a **named policy
  cap**: "Tenor policy cap: tier C maximum for 180 days after a Tenor
  liquidation", with its point effect. The ChainScore score is shown
  unchanged next to it.
- A true separation (an on-chain `tierCap` field alongside the score) would
  change the Phase 1 contracts and their test suite. Not recommended at this
  stage.

## P3-O3. The event names in §2 don't match the contracts

**Brief says:** index "AttestationSubmitted, Supply, Withdraw, Borrow, Repay,
Liquidate, ShortfallRecorded".

**Evidence (CONTRACTS.md and the ABIs):** the real events are:
- ScoreRegistry: `AttestationSubmitted`, `LiquidationRecorded`,
  `AttestorRotated`, `MarketSet`.
- TenorMarket:
  - lenders: ERC-4626 `Deposit` and `Withdraw`;
  - borrowers: `CollateralDeposited`, `CollateralWithdrawn`, `Borrowed`,
    `Repaid`, `Liquidated`, `BadDebtRealized`, `Retiered`;
  - market: `InterestAccrued`, `CapsSet`.
- "Score and terms at the time" is carried by `Borrowed` and `Liquidated`
  (score, tier, LTV/LT, price). There is no `ShortfallRecorded`: shortfall is
  in `Liquidated.shortfall`, `BadDebtRealized` and `LiquidationRecorded`.

**Instead:** index all of the above.

## P3-O4. The indexer is for history; current state must come from the chain

**Brief says (§2):** "Keep derived aggregates in the indexer rather than
recomputing client-side", and "each screen needs one query".

**Why it's wrong for *current* numbers:** debt, health factor, `maxBorrow`
and `totalAssets` change every second through interest accrual. An indexer
only sees events. Recomputing accrued interest there would duplicate the
contract's rounding logic and drift from it. Showing a health factor the
contract disagrees with is the fastest way to lose a judge.

**Instead:**
- **Indexer (one GraphQL query per screen):** history and aggregates:
  attestation history, liquidations feed, the per-wallet loop timeline,
  market activity, counts and totals of events.
- **Chain (one multicall per screen):** current state: position, debt,
  health factor, `maxBorrow`, score freshness. This is not "querying the
  chain for historical data", which the original brief rightly forbids.

For the bounty, HyperIndex is still load-bearing: without it there is no
liquidations feed, no loop timeline, and no attestation history.

## P3-O5. No separate direct-RPC read path is needed; HyperIndex already has one

**Brief asks (§0.1, §2):** is a direct-RPC fallback worth building?

**Evidence:** Envio's config schema: `rpc: [{ url, for: fallback }]`, "for
chains supported by HyperSync, RPC serves as a fallback for added
reliability" (docs.envio.dev, config-schema-reference).

**Instead:** configure the Monad testnet RPC as `for: fallback` in the
indexer. Current-state values already come from the chain (P3-O4). Nothing
extra to build.

## P3-O6. Envio Cloud's free tier can carry judging, with two operational duties

**Evidence** (docs.envio.dev, hosted-service-deployment, "Development Plan
Fair Usage Policy"):
- **Hard limits:** 20 GB of storage, 30 days of age.
- **Soft limits, whichever comes first:** 100,000 events processed, 5 GB, or
  **no requests for 7 days**.

**Assessment:**
- **Events:** our volume is small. Even busy testnet use is in the
  thousands.
- **Age:** deploying on Oct 7 gives an Oct 7 → Nov 6 lifetime, which covers
  judging (Oct 14–27) and winners (Nov 3).
- **The idle rule is the real risk.** If no one queries for 7 days during
  judging, deletion starts.

**Instead:** a scheduled keep-alive query every 24 h from Phase 4, and a
redeploy on Oct 12 to reset the 30-day clock. Self-hosting (`envio start`)
remains the fallback.

## P3-O7. The Alchemy fallback as specified is not feasible on Alchemy's free plan; here's what is

**Addendum says (1.2):** Alchemy is the second history source: "falls back to
Alchemy", and "the SCORED path still completes through Alchemy."

**Evidence:**
- Alchemy `eth_getLogs` on the **Free** plan: **a 10-block range**; Pay As
  You Go is unlimited (alchemy.com/docs, eth-getlogs). A full-history borrow
  scan is impossible on free.
- `alchemy_getAssetTransfers` (120 CU per call, full history, paged) covers
  **Ethereum, Base, Polygon, Arbitrum and Optimism only**; Avalanche and
  Scroll aren't listed (alchemy.com/docs, alchemy-getassettransfers).
- **Compound V2 can't be read this way.** A borrow and a redeem both move the
  underlying from the cToken to the wallet, so transfer data can't tell them
  apart.

**What is feasible for free:**
- **Aave V3/V2 on those 5 chains**, detected as **variable/stable debt-token
  mints to the wallet** via `getAssetTransfers` (category `erc20`,
  `contractAddresses` = the chain's Aave debt tokens, from the Aave address
  book). A borrow mints debt tokens to `onBehalfOf`, so this is the same
  fact the HyperSync check reads, from a different provider.
- **Not covered by the fallback:** Avalanche, Scroll, and Compound V2 on
  Ethereum.

**This forces a clear definition of "partial verification"** (which the
addendum rightly asks for):
- A chain or protocol verified by at least one source counts as normal.
- A chain or protocol **no source could verify** (for example Scroll while
  HyperSync is down) is marked **unverified**. ChainScore's own per-chain
  view is used for it:
  - If ChainScore sees borrowing there, that chain's score is counted,
    which can only lower the minimum. It can't be cherry-picked.
  - If ChainScore sees none, the chain is excluded and labelled
    "unverified: independent check unavailable".
- The response state is SCORED with `verification: "partial"`, and the UI
  names the unverified chains.
- This never collapses to total refusal, and never silently counts
  something unverified as verified.

**Cost:** $0 on Alchemy Free (30M CU/month; about 7 × 120 CU per wallet).
**Needed from you:** an Alchemy account and API key. I have none, and making
one needs your email.

**Bounty consequence:** Alchemy becomes load-bearing only *while HyperSync is
down*. By the addendum's test (removing it breaks a demonstrated feature), it
qualifies only if the demo actually shows the fallback answering, for example
a filmed forced-failure run. Otherwise it's USED, not CLAIMED.

## P3-O8. Using ChainScore's view for unverifiable chains changes what "independent" means; say so

Following P3-O7: when a chain is unverified, Tenor falls back to trusting
ChainScore's own "no borrowing here" for it. The README must say that
partial verification exists, when it happens, and that it is shown per
chain.

## P3-O9. Five screens become four pages; the loop needs its own

**Brief says (§3):** five screens, 3.1–3.5.

**Instead:**
1. **/score**: connect, three states, itemization, then attest (3.1 and 3.2
   are one flow; splitting them adds a navigation step to the filmed
   journey).
2. **/compare**: the pitch (3.3).
3. **/market**: supply, borrow, repay and position with a live health factor
   (3.4 and the position half of 3.5 act on the same position; one page).
4. **/activity**: the liquidations feed plus a **per-wallet loop timeline**
   (liquidation, score invalidated, new penalized score, smaller capacity),
   one indexer query.

Same scope, fewer clicks in a 3-minute video.

## P3-O10. The comparison must show which limit binds, or it overstates the score's effect

**Brief says (3.3):** lead with the borrow-amount difference.

**Why it needs care:** at meaningful collateral, FLOOR's **per-wallet cap
(1,000 tUSD) binds before its 60% LTV** (Phase 1 journey test). At $2,000 of
collateral, tier A borrows 1,600 while FLOOR borrows 1,000. Only 200 of that
600 difference comes from LTV (1,200 vs 1,600 would be the LTV-only
comparison, a 400 difference); the rest comes from the cap. A judge who
checks the maths sees the pitch's "the score governs collateral" is half cap.

**Instead:**
- The comparison shows, per wallet, **LTV limit, cap limit, and which one
  binds**.
- The default collateral is chosen where **no cap binds** (≤ $1,666 for
  FLOOR, for example 800 tCOLL = $1,600 → A 1,280 vs FLOOR 960). The currency
  difference is then purely LTV.
- A slider shows where caps take over.

## P3-O11. I can't walk the journey with a real wallet extension; here's the honest split

**Brief says (§5):** walk the full journey yourself in a browser.

**Why it's limited:** I can drive a browser, but I can't operate a
wallet-extension signature prompt, and I won't put a private key into one.

**Instead:**
- **(a)** A development-only wagmi *mock connector* that uses anvil's
  unlocked or impersonated accounts. It works only against a local anvil and
  is compiled out of production builds. I walk the whole journey with it and
  report every break.
- **(b)** You do a real-wallet pass on testnet in Phase 4.
- The impersonation rule from Phase 2 still holds: never filmed.

## P3-O12. Running the indexer against testnet needs a testnet deploy, which needs faucet MON

**Brief says (§2):** confirm the indexer "catches up from the deployment
block and stays current."

**Evidence:** HyperSync supports 10143, not a local anvil (31337); locally
HyperIndex would run in RPC mode. The faucet page (`faucet.monad.xyz`) is a
JavaScript app, and I couldn't read its requirements or rate limit.

**Instead:**
- Build and verify the indexer locally (RPC mode) first.
- Do an **early testnet deploy during Phase 3** with a fresh throwaway
  deployer, to test the indexer on real Monad and surface faucet and RPC
  limits (your Phase 4 note) before they matter. We're about 10 days ahead
  of schedule, so this costs nothing.
- **Needed from you:** fund the throwaway deployer from the faucet. It may
  need a browser, a captcha or a social login; I'll give you the address.

## P3-O13. The distribution check, done now with a labelled substitute

**Brief says (§1):** run it "as soon as HyperSync is reachable". It has been
unreachable since about 22:10.

**Instead (running now, read-only):** 50 historical borrowers sampled from
ChainScore's `features.csv` (seeded, reproducible). ChainScore itself decides
which chains each wallet borrowed on (`protocolsUsed`, `noBorrowHistory`),
all 7 chains per wallet. Tenor's validation rules are then applied offline
to classify SCORED, UNAVAILABLE or INSUFFICIENT_HISTORY.

**Labelled limitations:**
- Discovery is ChainScore's, not independent.
- On Base and Aave-degraded chains, borrowing can't be seen at all, which
  is reported as its own count.
- The sample comes from an older dataset.

It will be rerun through the real pipeline once HyperSync is back.

## P3-O14. Bounty addendum items I can't do from here

- **Perpl terms (2.2)** and **the platform's full bounty list (§4)** are
  behind the hackathon portal login. **Needed from you:** paste them, or the
  relevant sections.
- **Nansen (2.1):** DECLINED for now. Its own preconditions aren't met: the
  distribution check hasn't been run through the pipeline, and the second
  history source hasn't shipped. It gets re-evaluated only if both clear
  early.
- **Separate bounty submission steps (§5):** also behind the portal. The
  same request.

## Assumptions I'm least confident about in these objections

1. **P3-O7's debt-token approach** assumes Alchemy's `getAssetTransfers`
   indexes Aave debt-token mints. Debt tokens emit `Transfer` on mint but
   aren't transferable. It's plausible but unverified until I have a key; I'll
   test it on the known Arbitrum borrower first.
2. **P3-O13's substitute** may overstate UNAVAILABLE on Base and Optimism,
   because ChainScore's Aave source is also degraded on Base, so we can't tell
   whether those wallets borrowed there. The real pipeline, with independent
   history, resolves this.

## P3-O15. (Found by the distribution check) ChainScore cannot score Scroll and silently answers with Ethereum

**Evidence:** `docs/distribution/README.md`, finding 1. In 48 of 48 wallets,
`?chain=scroll` equals `?chain=ethereum` field for field (including
Compound). ChainScore's `chainSlugSchema` has no `scroll`, and the legacy
route falls back to `'ethereum'`.

**Impact on the Phase 2 service:** `COVERED_CHAINS` includes Scroll. For a
wallet that really borrowed on Scroll, the service would have counted its
*Ethereum* score as its Scroll score. That's a silent mis-score that none of
the current checks catch, because the legacy response doesn't echo the
chain.

**Instead** (a service change, after approval):
1. ChainScore is only ever called with slugs from its accepted list (pinned
   from commit a519058). The service's coverage table gains a
   `chainscoreScoreable` flag: Scroll = false.
2. The independent check still looks at Scroll. If borrowing is found there,
   the result is **UNAVAILABLE** ("Scroll: ChainScore does not score
   Scroll"). Excluding the chain instead would let a Scroll liquidation hide
   from the minimum.
3. A test asserts no request is ever built with a slug outside the list.

## P3-O16. The distribution isn't floor-collapsed; it's top-heavy, and multi-chain wallets are rare

**Evidence:** `docs/distribution/README.md`, finding 2. 36 of 46 are tier A
(78%); no wallet is FLOOR. Only 4 are genuinely multi-chain.

**What it means:**
- **The comparison screen is viable** (§1's stop condition isn't met).
  "Tier A vs unscored" is the *typical* case for a real borrower, not a
  cherry-picked one.
- **The middle tiers are thin in practice** (B 8, C 1, D 1). A judge asking
  "what do the middle tiers do" gets an honest answer: in this sample, most
  real borrowers score A, and B–D come from weaker histories or a bad chain
  under the minimum (2 of the 4 multi-chain wallets dropped a tier because
  of it).
- **The pile-up at 850** (the score band's ceiling) suggests ChainScore
  separates weakly among good borrowers. That's a property of the prior art,
  stated as an observation, not a metric.
- **The ≥ 20 multi-chain requirement can't be met from this sample.** Getting
  there needs HyperSync-based discovery (wallets with Aave `Borrow` logs on 2
  or more chains). It's queued for when HyperSync returns.

## P3-O17. (Found running the real pipeline) Our HyperSync usage trips the free-tier limit

**Evidence:** `docs/distribution/README.md`, run 2. 30 of 50 wallets were
UNAVAILABLE from HyperSync 429s or timeouts, at about 4 wallets a minute ×
7 parallel chain queries each. The earlier TLS-rejection "outage" (about
22:10 to 00:30) may have been the same protection.

**Instead:**
- Serialize history queries (no 7-way fan-out per wallet), with backoff on
  429.
- Cache history results for the 24 h TTL.
- Pre-warm the cache for demo wallets.
- The Alchemy fallback (P3-O7) covers throttling as well as outages.
- If judging load still trips it, HyperSync Starter is $70/month for 100
  requests a minute (envio.dev pricing). Your call, not needed yet.

## P3-O18. (Found running the real pipeline) 40% of real borrowers are unscoreable because of ChainScore's Etherscan plan

**Evidence:** 8 of the 20 wallets whose history check completed borrowed on
Base or Optimism, and are UNAVAILABLE with the chain named, as designed.
Etherscan's free tier excludes Base, OP and Avalanche (RESEARCH, P2-O2).

**Why it matters now:** a judge who connects a real borrowing wallet has
roughly a 40% chance of seeing "Base data unavailable". That's honest, but
it's the most likely first impression.

**Options:**
1. **ChainScore upgrades its Etherscan plan.** That's an operational change
   to your running prior-art service, not code, so provenance is unaffected.
   It removes the failure at the source. Needs you; price not verified by me.
2. **Accept it**, and make the README and UI explain it prominently (already
   required by P2-O2).
3. **Not recommended:** excluding degraded chains would let a Base
   liquidation hide from the minimum.

---

# Phase 4 brief received before the Phase 3 gate (2026-09-23)

## P4-O0. The Phase 4 gate check is false on almost every item; Phase 3 has not started

| Gate claim | Actual |
|---|---|
| Phase 3 approved | The Phase 3 objections (P3-O1 to P3-O18) haven't been presented or approved yet. |
| Distribution check run on 50 wallets and reported | Run twice. Run 1 used ChainScore-only discovery. Run 2 went through the real pipeline, but 30 of 50 were throttled by HyperSync, so it is **not yet a valid distribution** (P3-O17). |
| Indexer catching up and current | **Not built.** |
| Full journey walked in a browser | **No frontend exists.** |
| Alchemy fallback shipped and tested | **Not built.** No Alchemy key; the free plan is limited (P3-O7). |
| BOUNTIES.md current incl. platform list | Created, but the platform list needs your portal login (P3-O14). |

**Instead:** Phase 4 waits. The Phase 3 objections go first. It's
2026-09-23 and Phase 3's original window was Oct 3–6, so we're ahead of
schedule, not behind. When Phase 3 clears, I'll write the full Phase 4
objections against the brief. Items already visible:

- **"Borrow with stale score: rejected, floor tier still available" (§5)**
  contradicts O6: a stale score is *priced at FLOOR*, never rejected. Only an
  amount above FLOOR terms reverts.
- **"Tier capped at B by policy" (§5) vs P3-O1:** I proposed a cap at C
  (642); the brief now says B. Undecided. This needs your one-word answer.
- **ChainScore's rate limit (§2) is keyed on `bucket:IP`** (`middleware.ts`,
  `${bucket}:${ip}`). A judge's browser never calls ChainScore; only the
  attestor does, so the budget is the attestor's egress IP. On serverless,
  that IP may be shared with other tenants' traffic, which argues for an
  always-on host with a stable IP over Vercel functions.
- **Throttling produces a clean 429** (not garbage), which our client maps to
  UNAVAILABLE (unit-tested). Garbage under *provider* throttling inside
  ChainScore (an empty Etherscan result) is what the consistency check is
  for, and it fired on real data in run 2.
