# Video scripts (Phase 5 §5): drafts for review before recording

Rules carried from the brief and P5-O1 to O14:
- Real transactions only; nothing sped up and presented as real time;
  nothing fixture-backed on screen.
- MOCK ORACLE named wherever a price appears or moves.
- The demo borrower `0x033B…dCbF` is **a real borrower's public address
  whose attestation we relayed (anyone can)**. Never "my wallet", never a
  connect flow as that address.
- Labels on screen: **LIVE**, **TEST**, **COMPUTED**.
- Words in [brackets] are stage directions, not narration.

---

## Before recording (about 20 minutes)

1. **Network: phone hotspot** (the home Xfinity filter blocks Envio's
   indexer; SC-2).
2. Tell me "about to film". I'll:
   - relay a fresh attestation for `0x033B…dCbF` (today's expires about
     20:05 UTC);
   - check `/health` and that the mock price is $2.00.
3. **Filmed borrower wallet:** a *new* account in your browser wallet,
   used only for this. Add Monad Testnet. Send me its address and I'll
   fund its gas (`scripts/demo-loop.sh fund <address>`).
4. **Silent pass:** run the whole sequence once without recording, on the
   final deployment. It catches repointing mistakes before they appear
   mid-take. Then restore the price
   (`scripts/demo-loop.sh restore`) and use a fresh wallet for the real
   take.
5. Open the tabs in order:
   1. `/compare?wallet=0x033bd44b29375c02d07d8313a90eaae94337dcbf`
   2. `/?wallet=0x033bd44b29375c02d07d8313a90eaae94337dcbf`
   3. `/market` (the filmed wallet connected)
   4. `/activity`
   5. A terminal in the repo.

---

## DEMO VIDEO (≤ 3:00, about 420 words of narration)

**0:00–0:20 · The problem** [the Compare page, not yet scrolled]
> Every lending protocol asks every borrower for the same collateral.
> There's no reputation layer, so a wallet with years of clean borrowing
> is priced exactly like one created this morning. Tenor is a lending
> market on Monad where a wallet's borrowing history changes its terms.

**0:20–0:50 · Compare, LIVE** [the banner is visible; point at it]
> This is a real borrower's public address. Its Aave history on Ethereum
> was scored live, and we relayed its attestation on-chain, which anyone
> can do. We are not this wallet, and the page says so.
> Same 800 tCOLL of collateral, priced by a mock oracle at $1,600. At
> tier A this address could borrow 1,280 tUSD. An unscored wallet gets
> 960. That's 320 tUSD more from the same collateral, at the same
> interest rate. In both cases the binding limit is LTV, 80% against
> 60%, not the per-wallet cap.

**0:50–1:30 · Score, LIVE** [scroll slowly; expand "Excluded chains"]
> Here's where that tier comes from. ChainScore, our scoring API, gives
> this wallet 850. It has no history on Tenor, so there are no Tenor
> adjustments: 850 stays 850, tier A. The score only counts chains where
> an independent check, Envio's HyperSync, found the borrowing on-chain:
> here, one Aave borrow on Ethereum. Every other chain is excluded, with
> the reason shown. If the data can't be verified, Tenor refuses. It
> never turns missing data into a low score.

**1:30–2:05 · The loop: LIVE, then TEST, then COMPUTED**
[Market page, the filmed wallet: faucet → deposit 500 tCOLL → borrow with **Max** (about 600; typing exactly 600 reverts, since maxBorrow sits 3 wei under the limit)]
> Now a wallet we do control, with no history, so it borrows at floor
> terms: about 600 tUSD against $1,000 of collateral. Real transaction, on the
> explorer. [click the explorer link]

[terminal: `scripts/demo-loop.sh drop`, then `liquidate <wallet>`; on screen: "MOCK ORACLE"]
> We drop the mock price to $1.40, and a second wallet liquidates the
> position. The registry records it, and the Activity page shows it.
> [Activity page]

[terminal: `npx tsx packages/attestor/scripts/demo-policy.ts`; on screen: "TEST"]
> After a liquidation, Tenor's policy takes over. This is our test, not
> this wallet: a score of 800 loses 72 points, then is capped at tier C,
> 642. If the liquidation left bad debt, it's capped at floor, 451.

[on screen: "COMPUTED from the tier terms"]
> For the 500 tCOLL this wallet posted, that's the difference between
> 800 tUSD at tier A and 600 at floor.

[terminal: `scripts/demo-loop.sh restore`. This can happen off-camera, but it must happen.]

**2:05–2:30 · Why Monad** [the Market page]
> Liquidation is a race run by bots, and block space gets scarce exactly
> when every position becomes liquidatable at once, in a cascade. Fast,
> high-throughput blocks should keep liquidations landing when it matters
> most. That's our reasoning; we haven't measured it.

**2:30–3:00 · What this doesn't do yet** [a plain text card]
> What this doesn't do yet:
> - The oracle is a mock.
> - The contracts are unaudited.
> - Three keys, all held by one person, control the market, the oracle
>   and the scores.
> - In a sample of 50 historical borrowers, 8 of the 20 we could fully
>   check were refused, because our upstream's data for Base and
>   Optimism is degraded.
> - And we can't show the loop on the scored wallet, because we don't
>   hold its key.
>
> Tenor: tenor-teal-seven.vercel.app.

---

## PITCH VIDEO (≤ 2:00, about 280 words)

**The problem (one sentence)**
> In DeFi lending a proven borrower and a brand-new wallet post exactly
> the same collateral, because there's no reputation layer.

**What exists**
> ChainScore is live, with a public API: it scores a wallet, chain by
> chain, from its on-chain history. Tenor is the lending market built on it
> during this hackathon. A score sets your loan-to-value and borrowing
> cap, and liquidations on Tenor feed back into the score.

**The first user: YOU MUST WRITE THIS**
> [Name a specific protocol or team, and why they'd care. Not "DeFi
> borrowers". For example: a Monad-native lending market that wants
> lower collateral for proven borrowers without taking on unsecured
> risk. Only if that's true and you can defend it.]

**Integrity (not traction)**
> We built the integrity layer first. It found a real bug in our own
> upstream: ChainScore answered requests for Scroll with Ethereum data.
> We filed it and Tenor refuses to score Scroll. On a live chain it
> refuses wallets whose data doesn't add up, and today it caught one
> where ChainScore reported an empty history for a wallet with three
> on-chain borrows.

**Traction, as it is**
> It's live on Monad testnet. [Say the actual number of people who
> completed the testnet journey, from the indexer, excluding our own
> wallets. If it's zero, say we've just opened it up, or cut this
> sentence.]

**What's next**
> Credit delegation, to get past 100% LTV safely. Decentralizing the
> attestor. And fixing the upstream data gaps that today make some
> borrowers unscoreable.

---

## Discord post (draft; you post it)

> **Tenor: credit-scored collateral on Monad testnet (Metropolis)**
> A lending market where your borrowing history on other chains changes
> how much collateral you need. Testnet only, mock oracle, unaudited.
> → https://tenor-teal-seven.vercel.app
> - Anyone: connect a wallet on Monad testnet, take test tokens from the
>   faucet on the Market page, and borrow at floor terms (60% LTV).
> - If you've borrowed on Aave or Compound on Ethereum, Arbitrum or
>   Polygon: the Score page shows what Tenor would give you, and why.
> Feedback welcome, especially anything that breaks.
