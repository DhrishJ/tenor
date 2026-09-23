// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {BaseTest} from "../Base.t.sol";
import {Handler} from "./Handler.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {console} from "forge-std/console.sol";

/// @title Protocol invariants
/// @notice Each invariant_ function must hold after every random call sequence
/// the Handler produces (foundry.toml: 256 runs x depth 100).
///
/// Tolerances, and why:
///  - Sum of per-position debt vs total debt: each view rounds scaled debt UP
///    to whole wei, so the per-position sum can exceed the total by at most
///    one wei per position. The SCALED sums are checked exactly.
contract TenorInvariants is BaseTest {
    Handler handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(market, registry, oracle, usd, coll, owner, attestorKey);
        targetContract(address(handler));
    }

    /// Sum of individual debts equals tracked total debt: exact in scaled
    /// units, and within one wei per position in rounded units.
    function invariant_debtSumMatchesTotal() public view {
        uint256 n = handler.actorCount();
        uint256 scaledSum;
        uint256 debtSum;
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            scaledSum += market.scaledDebtOf(a);
            debtSum += market.debtOf(a);
        }
        assertEq(scaledSum, market.totalScaledDebt(), "scaled debt sum");
        uint256 total = market.totalDebt();
        assertGe(debtSum, total, "rounded sum below total");
        assertLe(debtSum, total + n, "rounded sum exceeds tolerance");
    }

    /// Per-tier buckets partition the total exactly.
    function invariant_tierBucketsPartitionDebt() public view {
        uint256 sum;
        for (uint256 i = 0; i < RiskParams.TIER_COUNT; i++) {
            sum += market.scaledDebtByTier(i);
        }
        assertEq(sum, market.totalScaledDebt());
    }

    /// Sum of lender shares equals total supply; the market holds exactly the
    /// collateral it has recorded.
    function invariant_supplyAndCollateralSums() public view {
        uint256 n = handler.actorCount();
        uint256 shares = market.balanceOf(lender);
        uint256 collSum;
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            shares += market.balanceOf(a);
            (uint256 c,,,) = market.getPosition(a);
            collSum += c;
        }
        assertEq(shares, market.totalSupply(), "share sum");
        assertEq(collSum, market.totalCollateral(), "collateral sum");
        assertEq(coll.balanceOf(address(market)), market.totalCollateral(), "collateral held");
    }

    function invariant_noBorrowAboveMaxLtv() public view {
        assertEq(handler.ghost_borrowAboveMaxLtv(), 0);
    }

    /// Every borrow was priced at the tier of the score valid in that block,
    /// and a stale or absent score never priced above FLOOR.
    function invariant_noBorrowPricedByStaleScore() public view {
        assertEq(handler.ghost_borrowTierMismatch(), 0, "tier mismatch");
        assertEq(handler.ghost_borrowPricedByStaleScore(), 0, "stale score priced a borrow");
    }

    /// No borrow ever pushed total debt above the global cap. (Interest may
    /// carry total debt past the cap afterwards; that is intended.)
    function invariant_noBorrowAboveGlobalCap() public view {
        assertEq(handler.ghost_borrowAboveGlobalCap(), 0);
    }

    /// Reserves never exceed what the pool holds (totalAssets cannot
    /// underflow), so the reserve is never effectively negative.
    function invariant_reservesBacked() public view {
        assertLe(market.reserves(), usd.balanceOf(address(market)) + market.totalDebt());
        market.totalAssets(); // must not revert
    }

    /// Bad-debt ledger balances: every realized shortfall was drawn from
    /// reserves or socialized, and every one was recorded against a wallet.
    function invariant_shortfallAccounting() public view {
        assertEq(
            market.totalReserveDrawn() + market.totalSocializedLoss(), market.totalBadDebt(), "draw + socialized"
        );
        uint256 recorded;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            recorded += registry.getLiquidationRecord(handler.actors(i)).totalShortfall;
        }
        assertEq(recorded, market.totalBadDebt(), "recorded vs realized");
    }

    /// Solvency: no position is left holding debt with no collateral. Bad
    /// debt is always realized, never left as a zombie.
    function invariant_noZombieDebt() public view {
        assertEq(handler.ghost_zombieDebt(), 0);
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            (uint256 c, uint256 d,,) = market.getPosition(handler.actors(i));
            if (c == 0) assertEq(d, 0, "debt without collateral");
        }
    }

    function afterInvariant() external view {
        // Keeps the run honest: an invariant suite whose handlers never
        // succeed proves nothing. Printed with -vv.
        console.log("borrow attempts", handler.calls_borrow());
        console.log("borrows ok     ", handler.calls_borrowOk());
        console.log("liquidations   ", handler.calls_liquidateOk());
        console.log("  with shortfall", handler.calls_shortfall());
        console.log("attestations   ", handler.calls_attest());
        console.log("repays ok      ", handler.calls_repayOk());
        console.log("coll withdraws ", handler.calls_withdrawCollOk());
    }
}
