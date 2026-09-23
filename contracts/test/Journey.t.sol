// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {BaseTest} from "./Base.t.sol";
import {TenorMarket} from "../src/TenorMarket.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {RiskParams} from "../src/RiskParams.sol";

/// @title Journey tests: what Tenor does, end to end
/// @notice Read these as documentation. Collateral (tCOLL) starts at $2.00 and
/// the borrowed asset (tUSD) is $1.00. Every price move below is made by hand
/// through MockPriceOracle; on testnet the same moves are staged the same way.
contract JourneyTest is BaseTest {
    address proven = makeAddr("proven"); // has cross-chain borrowing history
    address fresh = makeAddr("fresh"); // no history anywhere: unscored
    address liquidator = makeAddr("liquidator");

    /// THE DEMO. Two wallets post identical collateral: 1,000 tCOLL = $2,000.
    ///
    ///   proven: ChainScore 800 -> tier A -> max LTV 80% -> can borrow $1,600
    ///   fresh:  no score       -> FLOOR  -> max LTV 60% -> can borrow $1,200
    ///
    /// Same collateral, same interest rate, 33% more borrowing power for the
    /// proven wallet. Put the other way: for the same $1,200 loan, the proven
    /// wallet locks $1,500 of collateral instead of $2,000.
    function test_demo_provenWalletBorrowsMoreThanUnscored_sameCollateral() public {
        _attest(proven, 800);
        _postCollateral(proven, 1_000e18);
        _postCollateral(fresh, 1_000e18);

        // Note: for the unscored wallet the per-wallet cap (1,000 at FLOOR)
        // binds before its 60% LTV does. The next test isolates LTV alone.
        vm.prank(proven);
        market.borrow(1_600e18); // 80% of $2,000: accepted

        vm.prank(fresh);
        vm.expectRevert(TenorMarket.ExceedsWalletCap.selector);
        market.borrow(1_200e18); // FLOOR's wallet cap (1,000) binds before its 60% LTV
        vm.prank(fresh);
        market.borrow(1_000e18); // the most an unscored wallet can take

        // Both pay the same rate. The score changes collateral, not price.
        (,, RiskParams.Tier provenTier,) = market.getPosition(proven);
        (,, RiskParams.Tier freshTier,) = market.getPosition(fresh);
        assertEq(uint256(provenTier), uint256(RiskParams.Tier.A));
        assertEq(uint256(freshTier), uint256(RiskParams.Tier.FLOOR));
        assertEq(market.debtOf(proven), 1_600e18);
        assertEq(market.debtOf(fresh), 1_000e18);
    }

    /// The same comparison on LTV alone, with loans small enough that no wallet
    /// cap binds: for a $900 loan, the collateral each wallet must lock.
    ///   proven (A, 80%): $900 / 0.80 = $1,125 -> 562.5 tCOLL
    ///   fresh (FLOOR, 60%): $900 / 0.60 = $1,500 -> 750 tCOLL
    function test_demo_collateralRequiredForSameLoan() public {
        _attest(proven, 800);

        _postCollateral(proven, 562.5e18);
        vm.prank(proven);
        market.borrow(900e18); // exactly 80%

        _postCollateral(fresh, 562.5e18);
        vm.prank(fresh);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(900e18); // 80% is above FLOOR's 60%

        _postCollateral(fresh, 187.5e18); // top up to 750 tCOLL
        vm.prank(fresh);
        market.borrow(900e18); // exactly 60%
    }

    /// THE FEEDBACK LOOP. A proven wallet borrows at tier A, the price gaps
    /// through its buffer, it is liquidated with a shortfall, and the registry
    /// records it. Its old score dies on the spot: a pre-signed high attestation
    /// is rejected, and the same collateral now supports less borrowing.
    function test_journey_liquidationFeedsBackIntoTerms() public {
        // 1. Attest and borrow at tier A: 1,000 tCOLL ($2,000), borrow $1,600 (80%).
        _attest(proven, 800);
        _postCollateral(proven, 1_000e18);
        vm.prank(proven);
        market.borrow(1_600e18);

        // The wallet also holds a second, still-unsubmitted high attestation,
        // signed before anything goes wrong.
        ScoreRegistry.Attestation memory preSigned = ScoreRegistry.Attestation({
            wallet: proven,
            score: 820,
            issuedAt: uint64(block.timestamp + 1),
            expiresAt: uint64(block.timestamp + 1 days),
            deadline: uint64(block.timestamp + 15 minutes),
            nonce: registry.nonces(proven),
            modelVersion: MODEL
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, registry.hashAttestation(preSigned));
        bytes memory preSig = abi.encodePacked(r, s, v);

        // 2. The price gaps: $2.00 -> $1.50. Collateral $1,500 < debt $1,600.
        vm.warp(block.timestamp + 5 minutes);
        _setCollPrice(1.5e18);
        assertLt(market.healthFactor(proven), 1e18);

        // 3. Liquidation takes all the collateral; the rest is bad debt.
        //    repayCap = 1,500 / 1.05 = 1,428.571428...; the shortfall is the
        //    debt (1,600 plus 5 minutes of interest) minus that.
        uint256 debtAtLiquidation = market.debtOf(proven);
        deal(address(usd), liquidator, 2_000e18);
        vm.startPrank(liquidator);
        usd.approve(address(market), 2_000e18);
        (uint256 repaid, uint256 seized) = market.liquidate(proven, 2_000e18);
        vm.stopPrank();
        assertEq(seized, 1_000e18);
        assertEq(repaid, uint256(1_500e18) * 10_000 / 10_500);
        uint256 shortfall = debtAtLiquidation - repaid;
        assertGt(shortfall, 171e18);

        // 4. The registry has it, readable by anyone.
        ScoreRegistry.LiquidationRecord memory rec = registry.getLiquidationRecord(proven);
        assertEq(rec.liquidationCount, 1);
        assertEq(rec.shortfallCount, 1);
        assertEq(rec.totalShortfall, shortfall);

        // 5. The old score is dead immediately, not at expiry.
        (,,, bool stale) = registry.getScore(proven);
        assertTrue(stale);

        // 6. The pre-signed high attestation cannot be used to restore terms.
        vm.expectRevert(ScoreRegistry.IssuedBeforeLiquidation.selector);
        registry.submitAttestation(preSigned, preSig);

        // 7. Re-attest after the liquidation, at a lower score (in Phase 2 the
        //    attestation service applies this Tenor policy; here the test signs
        //    it directly). 600 -> tier C -> max LTV 70%.
        vm.warp(block.timestamp + 1);
        _attest(proven, 600);

        // 8. Same collateral as before (1,000 tCOLL, price back at $2.00) now
        //    supports about $1,400 (70%) instead of $1,600 (80%). maxBorrow
        //    leaves a few wei of rounding margin, which is what the UI uses.
        _setCollPrice(2e18);
        _postCollateral(proven, 1_000e18);
        uint256 limit = market.maxBorrow(proven);
        assertApproxEqAbs(limit, 1_400e18, 5);
        vm.prank(proven);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(1_600e18);
        vm.prank(proven);
        market.borrow(limit);
        (,, RiskParams.Tier tier, uint16 score) = market.getPosition(proven);
        assertEq(uint256(tier), uint256(RiskParams.Tier.C));
        assertEq(score, 600);
    }

    /// Lender's view of the same gap: bad debt lowers the share price by
    /// exactly the socialized amount, and the ledger balances.
    function test_journey_badDebtIsAccountedNotHidden() public {
        _attest(proven, 800);
        _postCollateral(proven, 1_000e18);
        vm.prank(proven);
        market.borrow(1_600e18);
        uint256 assetsBefore = market.totalAssets();

        _setCollPrice(1.5e18);
        deal(address(usd), liquidator, 2_000e18);
        vm.startPrank(liquidator);
        usd.approve(address(market), 2_000e18);
        market.liquidate(proven, 2_000e18);
        vm.stopPrank();

        assertEq(market.totalBadDebt(), market.totalReserveDrawn() + market.totalSocializedLoss());
        assertEq(market.totalAssets(), assetsBefore - market.totalSocializedLoss());
    }
}
