// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {BaseTest} from "./Base.t.sol";
import {TenorMarket} from "../src/TenorMarket.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract SixDecimals is ERC20 {
    constructor() ERC20("Six", "SIX") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract TenorMarketTest is BaseTest {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address liquidator = makeAddr("liquidator");

    // =========================================================== constructor

    function _deploy(address debt, address col, address reg, address orc, uint256 age) internal returns (TenorMarket) {
        return new TenorMarket(
            owner,
            IERC20Metadata(debt),
            IERC20Metadata(col),
            ScoreRegistry(reg),
            IPriceOracle(orc),
            age,
            GLOBAL_CAP
        );
    }

    function test_constructor_revert_sameAsset() public {
        vm.expectRevert(TenorMarket.InvalidConfig.selector);
        _deploy(address(usd), address(usd), address(registry), address(oracle), 1 days);
    }

    function test_constructor_revert_non18Decimals() public {
        SixDecimals six = new SixDecimals();
        vm.expectRevert(TenorMarket.InvalidConfig.selector);
        _deploy(address(usd), address(six), address(registry), address(oracle), 1 days);
    }

    function test_constructor_revert_zeroRegistry() public {
        vm.expectRevert(TenorMarket.InvalidConfig.selector);
        _deploy(address(usd), address(coll), address(0), address(oracle), 1 days);
    }

    function test_constructor_revert_zeroOracle() public {
        vm.expectRevert(TenorMarket.InvalidConfig.selector);
        _deploy(address(usd), address(coll), address(registry), address(0), 1 days);
    }

    function test_constructor_revert_zeroPriceAge() public {
        vm.expectRevert(TenorMarket.InvalidConfig.selector);
        _deploy(address(usd), address(coll), address(registry), address(oracle), 0);
    }

    function test_constructor_state() public view {
        assertEq(market.asset(), address(usd));
        assertEq(address(market.collateralAsset()), address(coll));
        assertEq(market.borrowIndex(), 1e27);
        assertEq(market.globalDebtCap(), GLOBAL_CAP);
        assertEq(market.tierDebtCap(4), GLOBAL_CAP);
        assertEq(market.decimals(), 24); // 18 + 6 virtual-share offset
    }

    // ================================================================ lenders

    function test_lender_depositAndRedeem() public {
        assertEq(market.totalAssets(), 100_000e18);
        uint256 shares = market.balanceOf(lender);
        vm.prank(lender);
        uint256 assets = market.redeem(shares, lender, lender);
        assertEq(assets, 100_000e18);
        assertEq(usd.balanceOf(lender), 100_000e18);
    }

    function test_lender_mintAndWithdraw() public {
        address carol = makeAddr("carol");
        deal(address(usd), carol, 1_000e18);
        vm.startPrank(carol);
        usd.approve(address(market), type(uint256).max);
        uint256 shares = market.previewDeposit(500e18);
        market.mint(shares, carol);
        market.withdraw(500e18, carol, carol);
        vm.stopPrank();
        assertEq(usd.balanceOf(carol), 1_000e18);
    }

    function test_lender_revert_depositWhilePaused() public {
        vm.prank(owner);
        market.pause();
        assertEq(market.maxDeposit(lender), 0);
        assertEq(market.maxMint(lender), 0);
        deal(address(usd), bob, 10e18);
        vm.startPrank(bob);
        usd.approve(address(market), 10e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.deposit(10e18, bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.mint(1e24, bob);
        vm.stopPrank();
    }

    function test_lender_withdrawWorksWhilePaused() public {
        vm.prank(owner);
        market.pause();
        vm.prank(lender);
        market.withdraw(1_000e18, lender, lender);
        assertEq(usd.balanceOf(lender), 1_000e18);
    }

    function test_lender_withdrawLimitedToIdleCash() public {
        _postCollateral(alice, 1_000e18); // $2,000 of collateral
        vm.prank(alice);
        market.borrow(1_000e18);
        assertEq(market.maxWithdraw(lender), 99_000e18);
        uint256 maxShares = market.maxRedeem(lender);
        assertLt(maxShares, market.balanceOf(lender));
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lender, 99_000e18 + 1, 99_000e18)
        );
        market.withdraw(99_000e18 + 1, lender, lender);
    }

    // ============================================================ collateral

    function test_depositCollateral() public {
        deal(address(coll), alice, 10e18);
        vm.startPrank(alice);
        coll.approve(address(market), 10e18);
        vm.expectEmit(address(market));
        emit TenorMarket.CollateralDeposited(alice, 10e18);
        market.depositCollateral(10e18);
        vm.stopPrank();
        (uint256 c,,,) = market.getPosition(alice);
        assertEq(c, 10e18);
        assertEq(market.totalCollateral(), 10e18);
    }

    function test_depositCollateral_revert_zero() public {
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.depositCollateral(0);
    }

    function test_depositCollateral_worksWhilePaused() public {
        vm.prank(owner);
        market.pause();
        _postCollateral(alice, 1e18);
    }

    function test_withdrawCollateral_noDebt() public {
        _postCollateral(alice, 10e18);
        vm.prank(alice);
        market.withdrawCollateral(10e18);
        assertEq(coll.balanceOf(alice), 10e18);
        assertEq(market.totalCollateral(), 0);
    }

    function test_withdrawCollateral_noDebt_worksWithStalePrice() public {
        _postCollateral(alice, 10e18);
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        market.withdrawCollateral(10e18);
    }

    function test_withdrawCollateral_revert_zero() public {
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.withdrawCollateral(0);
    }

    function test_withdrawCollateral_revert_moreThanPosted() public {
        _postCollateral(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.InsufficientCollateral.selector);
        market.withdrawCollateral(1e18 + 1);
    }

    function test_withdrawCollateral_withDebt_withinLtv() public {
        _postCollateral(alice, 1_000e18); // $2,000
        vm.prank(alice);
        market.borrow(600e18); // 30% LTV
        vm.prank(alice);
        market.withdrawCollateral(500e18); // leaves $1,000 -> 60% LTV, the floor max
    }

    function test_withdrawCollateral_withDebt_revert_aboveLtv() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(600e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.withdrawCollateral(500e18 + 1);
    }

    function test_withdrawCollateral_withDebt_revert_stalePrice() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(100e18);
        vm.warp(block.timestamp + MAX_PRICE_AGE + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TenorMarket.StalePrice.selector, address(coll)));
        market.withdrawCollateral(1e18);
    }

    /// A score that expired since the borrow re-prices the withdrawal at FLOOR.
    function test_withdrawCollateral_retiersToCurrentTier() public {
        _attest(alice, 800); // A: 80% max LTV
        _postCollateral(alice, 1_000e18); // $2,000
        vm.prank(alice);
        market.borrow(1_500e18); // 75% LTV, allowed at A
        vm.warp(block.timestamp + 1 days); // score expires
        _refreshPrices();
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector); // FLOOR 60% now applies
        market.withdrawCollateral(1e18);
    }

    function test_withdrawCollateral_worksWhilePaused() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(100e18);
        vm.prank(owner);
        market.pause();
        vm.prank(alice);
        market.withdrawCollateral(100e18);
    }

    // ================================================================ borrow

    function test_borrow_unscored_atFloorLtv() public {
        _postCollateral(alice, 1_000e18); // $2,000 -> floor 60% = $1,200
        vm.expectEmit(address(market));
        emit TenorMarket.Borrowed(alice, 1_000e18, 1_000e18, 0, RiskParams.Tier.FLOOR, 6_000, 6_500, 2e18);
        vm.prank(alice);
        market.borrow(1_000e18); // at the floor wallet cap
        assertEq(usd.balanceOf(alice), 1_000e18);
        assertEq(market.debtOf(alice), 1_000e18);
    }

    function test_borrow_revert_unscoredAboveFloorLtv() public {
        _postCollateral(alice, 1_000e18); // $2,000
        _attest(alice, 700); // B, so the wallet cap is not the binding limit...
        vm.warp(block.timestamp + 1 days); // ...then let the score go stale
        _refreshPrices();
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(1_200e18 + 1); // 60% of $2,000 is the most FLOOR allows
    }

    function test_borrow_scoredA_atEightyPercent() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18); // $2,000
        vm.prank(alice);
        market.borrow(1_600e18); // 80%
        (,, RiskParams.Tier tier, uint16 score) = market.getPosition(alice);
        assertEq(uint256(tier), uint256(RiskParams.Tier.A));
        assertEq(score, 800);
    }

    function test_borrow_revert_scoredA_aboveEightyPercent() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(1_600e18 + 1);
    }

    function test_borrow_revert_zero() public {
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.borrow(0);
    }

    function test_borrow_revert_paused() public {
        vm.prank(owner);
        market.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.borrow(1);
    }

    function test_borrow_revert_noCollateral() public {
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(1e18);
    }

    function test_borrow_revert_insufficientLiquidity() public {
        vm.prank(alice);
        vm.expectRevert(TenorMarket.InsufficientLiquidity.selector);
        market.borrow(100_000e18 + 1);
    }

    function test_borrow_revert_walletCap() public {
        _postCollateral(alice, 10_000e18); // $20,000; LTV not binding
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsWalletCap.selector);
        market.borrow(1_000e18 + 1); // FLOOR cap is 1,000
    }

    function test_borrow_revert_tierCap() public {
        uint256[5] memory caps = [uint256(500e18), GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP];
        vm.prank(owner);
        market.setCaps(GLOBAL_CAP, caps);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsTierCap.selector);
        market.borrow(500e18 + 1);
    }

    function test_borrow_revert_globalCap() public {
        uint256[5] memory caps = [GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP];
        vm.prank(owner);
        market.setCaps(300e18, caps);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsGlobalCap.selector);
        market.borrow(300e18 + 1);
    }

    function test_borrow_revert_stalePrice() public {
        _postCollateral(alice, 1_000e18);
        vm.warp(block.timestamp + MAX_PRICE_AGE + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TenorMarket.StalePrice.selector, address(coll)));
        market.borrow(1e18);
    }

    function test_borrow_revert_zeroPrice() public {
        _postCollateral(alice, 1_000e18);
        _setCollPrice(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TenorMarket.InvalidPrice.selector, address(coll)));
        market.borrow(1e18);
    }

    function test_borrow_revert_futurePriceTimestamp() public {
        _postCollateral(alice, 1_000e18);
        vm.warp(block.timestamp + 100);
        _setCollPrice(2e18); // stamped at +100
        vm.warp(block.timestamp - 50); // chain "earlier" than the price
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TenorMarket.StalePrice.selector, address(coll)));
        market.borrow(1e18);
    }

    function test_borrow_retierEmitted() public {
        _attest(alice, 650); // B
        _postCollateral(alice, 1_000e18);
        vm.expectEmit(address(market));
        emit TenorMarket.Retiered(alice, RiskParams.Tier.FLOOR, RiskParams.Tier.B, 650);
        vm.prank(alice);
        market.borrow(100e18);
    }

    /// After a liquidation invalidates the score, the next borrow is priced
    /// at FLOOR, even if the old signed score has not expired.
    function test_borrow_afterLiquidation_pricedAtFloor() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_600e18);
        _setCollPrice(1.8e18); // 1,600 / 1,800 = 88.9% > 85% LT
        _liquidate(alice, 100e18);
        (RiskParams.Tier t,) = registry.effectiveTier(alice);
        assertEq(uint256(t), uint256(RiskParams.Tier.FLOOR));
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsMaxLtv.selector);
        market.borrow(1e18);
    }

    /// Documents the rounding edge: once the index is above 1, the stored
    /// debt for a borrow of exactly the cap rounds up by 1 wei and is rejected.
    /// Rounding always goes against the borrower; the UI leaves a wei of margin.
    function test_borrow_exactCapAfterAccrual_roundsOver() public {
        _postCollateral(bob, 1_000e18);
        vm.prank(bob);
        market.borrow(500e18);
        vm.warp(block.timestamp + 365 days);
        _refreshPrices();
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(TenorMarket.ExceedsWalletCap.selector);
        market.borrow(1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18 - 1);
    }

    // ================================================================= repay

    function test_repay_partial() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        vm.startPrank(alice);
        usd.approve(address(market), 200e18);
        uint256 paid = market.repay(alice, 200e18);
        vm.stopPrank();
        assertEq(paid, 200e18);
        assertApproxEqAbs(market.debtOf(alice), 300e18, 1);
    }

    function test_repay_full_withMax() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        vm.warp(block.timestamp + 30 days);
        uint256 owed = market.debtOf(alice);
        assertGt(owed, 500e18);
        deal(address(usd), alice, owed);
        vm.startPrank(alice);
        usd.approve(address(market), owed);
        uint256 paid = market.repay(alice, type(uint256).max);
        vm.stopPrank();
        assertEq(paid, owed);
        assertEq(market.debtOf(alice), 0);
        assertEq(market.totalScaledDebt(), 0);
    }

    function test_repay_byThirdParty() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        deal(address(usd), bob, 500e18);
        vm.startPrank(bob);
        usd.approve(address(market), 500e18);
        vm.expectEmit(address(market));
        emit TenorMarket.Repaid(bob, alice, 500e18, 0);
        market.repay(alice, 500e18);
        vm.stopPrank();
        assertEq(market.debtOf(alice), 0);
    }

    function test_repay_worksWhilePaused() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        vm.prank(owner);
        market.pause();
        vm.startPrank(alice);
        usd.approve(address(market), 500e18);
        market.repay(alice, 500e18);
        vm.stopPrank();
    }

    function test_repay_revert_zero() public {
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.repay(alice, 0);
    }

    function test_repay_revert_noDebt() public {
        vm.expectRevert(TenorMarket.NoDebt.selector);
        market.repay(alice, 1e18);
    }

    function test_repay_revert_dustThatScalesToZero() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        vm.warp(block.timestamp + 365 days); // index > 1, so 1 wei scales to 0
        vm.startPrank(alice);
        usd.approve(address(market), 1);
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.repay(alice, 1);
        vm.stopPrank();
    }

    // ============================================================= liquidate

    function _liquidate(address wallet, uint256 maxRepay) internal returns (uint256 repaid, uint256 seized) {
        deal(address(usd), liquidator, maxRepay);
        vm.startPrank(liquidator);
        usd.approve(address(market), maxRepay);
        (repaid, seized) = market.liquidate(wallet, maxRepay);
        vm.stopPrank();
    }

    function test_liquidate_revert_zero() public {
        vm.expectRevert(TenorMarket.ZeroAmount.selector);
        market.liquidate(alice, 0);
    }

    function test_liquidate_revert_noDebt() public {
        vm.expectRevert(TenorMarket.NoDebt.selector);
        market.liquidate(alice, 1e18);
    }

    function test_liquidate_revert_healthy() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18); // 50%, LT 65%
        vm.expectRevert(TenorMarket.NotLiquidatable.selector);
        market.liquidate(alice, 1e18);
    }

    function test_liquidate_revert_atExactThreshold() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        _setCollPrice(1.538461538461538462e18); // 1,000 / 1,538.46 = 65.0% (just healthy)
        vm.expectRevert(TenorMarket.NotLiquidatable.selector);
        market.liquidate(alice, 1e18);
    }

    function test_liquidate_revert_paused() public {
        vm.prank(owner);
        market.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.liquidate(alice, 1e18);
    }

    function test_liquidate_revert_stalePrice() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        vm.warp(block.timestamp + MAX_PRICE_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(TenorMarket.StalePrice.selector, address(coll)));
        market.liquidate(alice, 1e18);
    }

    /// Partial liquidation, no shortfall. Collateral $2 -> $1.40:
    /// debt 1,000, collateral 1,000 x $1.40 = $1,400, LTV 71.4% > 65% LT.
    /// Liquidator repays 400 and receives 400 x 1.05 / 1.40 = 300 tCOLL.
    function test_liquidate_partial_noShortfall() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        _setCollPrice(1.4e18);
        (uint256 repaid, uint256 seized) = _liquidate(alice, 400e18);
        assertEq(repaid, 400e18);
        assertEq(seized, 300e18);
        assertEq(coll.balanceOf(liquidator), 300e18);
        (uint256 c, uint256 d,,) = market.getPosition(alice);
        assertEq(c, 700e18);
        assertApproxEqAbs(d, 600e18, 1);
        ScoreRegistry.LiquidationRecord memory r = registry.getLiquidationRecord(alice);
        assertEq(r.liquidationCount, 1);
        assertEq(r.totalShortfall, 0);
        assertEq(market.totalBadDebt(), 0);
    }

    /// Liquidator asks for more than the debt: capped at the debt, and the
    /// borrower keeps the remaining collateral.
    function test_liquidate_full_borrowerKeepsExcess() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        _setCollPrice(1.4e18);
        (uint256 repaid, uint256 seized) = _liquidate(alice, 5_000e18);
        assertEq(repaid, 1_000e18);
        assertEq(seized, 750e18); // 1,000 x 1.05 / 1.40
        (uint256 c, uint256 d,,) = market.getPosition(alice);
        assertEq(c, 250e18);
        assertEq(d, 0);
    }

    /// Gap through the buffer. Price $2 -> $0.90:
    /// collateral 1,000 x $0.90 = $900 against 1,000 debt.
    /// repayCap = 900 / 1.05 = 857.142857... ; all 1,000 tCOLL seized.
    /// Shortfall = 1,000 - 857.142857... = 142.857142...; reserves are ~0,
    /// so it is socialized, and recorded against the wallet.
    function test_liquidate_gap_realizesShortfall() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        uint256 assetsBefore = market.totalAssets();
        _setCollPrice(0.9e18);
        (uint256 repaid, uint256 seized) = _liquidate(alice, 5_000e18);

        uint256 expectedRepay = uint256(900e18) * 10_000 / 10_500; // 857.142857142857142857e18
        assertEq(repaid, expectedRepay);
        assertEq(seized, 1_000e18);
        uint256 shortfall = 1_000e18 - expectedRepay;

        (uint256 c, uint256 d,,) = market.getPosition(alice);
        assertEq(c, 0);
        assertEq(d, 0, "remaining debt is written off");
        assertEq(market.totalBadDebt(), shortfall);
        assertEq(market.totalReserveDrawn() + market.totalSocializedLoss(), shortfall);
        assertEq(market.totalAssets(), assetsBefore - shortfall, "lenders absorb the loss via share price");

        ScoreRegistry.LiquidationRecord memory r = registry.getLiquidationRecord(alice);
        assertEq(r.liquidationCount, 1);
        assertEq(r.shortfallCount, 1);
        assertEq(r.totalShortfall, shortfall);
    }

    /// Reserves built up from interest absorb bad debt before lenders.
    function test_liquidate_gap_reservesAbsorbFirst() public {
        // Build reserves: bob (tier A) borrows 10,000 for a year and repays.
        // Utilization 10% -> rate 3% -> interest 300 -> reserves 30.
        _attest(bob, 800);
        _postCollateral(bob, 12_500e18); // $25,000
        vm.prank(bob);
        market.borrow(10_000e18);
        vm.warp(block.timestamp + 365 days);
        _refreshPrices();
        uint256 owed = market.debtOf(bob);
        deal(address(usd), bob, owed);
        vm.startPrank(bob);
        usd.approve(address(market), owed);
        market.repay(bob, type(uint256).max);
        vm.stopPrank();
        uint256 res = market.reserves();
        assertEq(res, 30e18);

        // Small gap: shortfall smaller than the reserve.
        // 990, not 1,000: with the index above 1, borrowing exactly the 1,000
        // wallet cap rounds 1 wei over it (scaled debt rounds against the
        // borrower). See test_borrow_exactCapAfterAccrual_roundsOver.
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(990e18);
        uint256 assetsBefore = market.totalAssets();
        _setCollPrice(1.03e18); // $1,030: repayCap 980.95..., shortfall ~9.05
        _liquidate(alice, 5_000e18);

        uint256 shortfall = market.totalBadDebt();
        assertGt(shortfall, 0);
        assertLt(shortfall, res);
        assertEq(market.totalReserveDrawn(), shortfall);
        assertEq(market.totalSocializedLoss(), 0);
        assertEq(market.reserves(), res - shortfall);
        // Lenders untouched while reserves cover it. Scaled-debt rounding can
        // leave the pool up to 1 wei better off, never worse.
        assertGe(market.totalAssets(), assetsBefore, "lenders must not lose");
        assertLe(market.totalAssets(), assetsBefore + 1, "at most 1 wei of rounding");
    }

    function test_liquidate_emitsTermsInForce() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_600e18);
        _setCollPrice(1.8e18);
        deal(address(usd), liquidator, 100e18);
        vm.startPrank(liquidator);
        usd.approve(address(market), 100e18);
        vm.expectEmit(address(market));
        emit TenorMarket.Liquidated(
            alice, liquidator, 100e18, 58333333333333333333, 0, 800, RiskParams.Tier.A, 8_500, 1.8e18
        );
        market.liquidate(alice, 100e18);
        vm.stopPrank();
    }

    /// Liquidation uses the tier the position was priced at, not the current
    /// one: an expired score does not make a healthy A-tier position
    /// liquidatable at FLOOR's 65%.
    function test_liquidate_usesPricedTier_notExpiredScore() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_500e18); // 75%: healthy at A (85% LT), unhealthy at FLOOR (65%)
        vm.warp(block.timestamp + 2 days);
        _refreshPrices();
        vm.expectRevert(TenorMarket.NotLiquidatable.selector);
        market.liquidate(alice, 1e18);
    }

    /// Collateral crashes to (almost) nothing: worth less than one wei of
    /// debt, so repayCap rounds to 0. The liquidation must still close the
    /// position and realize the full debt as bad debt, not leave it stuck
    /// inflating totalAssets.
    function test_liquidate_worthlessCollateral_writesOffWholeDebt() public {
        _postCollateral(alice, 1e18); // one token, $2
        vm.prank(alice);
        market.borrow(1e18); // 50%
        _setCollPrice(1); // 1e-18 USD per token: collateral worth 1 wei of USD
        uint256 debt = market.debtOf(alice);
        (uint256 repaid, uint256 seized) = _liquidate(alice, 1e18);
        assertEq(repaid, 0);
        assertEq(seized, 1e18);
        (uint256 c, uint256 d,,) = market.getPosition(alice);
        assertEq(c, 0);
        assertEq(d, 0);
        assertEq(market.totalBadDebt(), debt);
        assertEq(registry.getLiquidationRecord(alice).totalShortfall, debt);
    }

    /// Liquidation never seizes more collateral than the position holds, and
    /// never charges the liquidator more than the debt, for any price.
    function testFuzz_liquidationBounds(uint256 collateral, uint256 borrowBps, uint256 price, uint256 maxRepay)
        public
    {
        collateral = bound(collateral, 1e18, 400e18); // up to $800: under the floor wallet cap
        borrowBps = bound(borrowBps, 100, 6_000);
        _postCollateral(alice, collateral);
        uint256 amount = collateral * 2 * borrowBps / 10_000;
        vm.prank(alice);
        market.borrow(amount);
        _setCollPrice(bound(price, 1, 2e18));
        uint256 debt = market.debtOf(alice);
        maxRepay = bound(maxRepay, 1, debt * 2);

        deal(address(usd), liquidator, maxRepay);
        vm.startPrank(liquidator);
        usd.approve(address(market), maxRepay);
        try market.liquidate(alice, maxRepay) returns (uint256 repaid, uint256 seized) {
            assertLe(seized, collateral, "seized more than posted");
            assertLe(repaid, debt, "repaid more than owed");
            assertLe(repaid, maxRepay, "exceeded liquidator's limit");
            (uint256 c, uint256 d,,) = market.getPosition(alice);
            assertEq(c, collateral - seized);
            if (c == 0) assertEq(d, 0, "debt left with no collateral");
        } catch (bytes memory err) {
            assertEq(bytes4(err), TenorMarket.NotLiquidatable.selector, "unexpected revert");
        }
        vm.stopPrank();
    }

    function test_scaledDebtOf() public {
        assertEq(market.scaledDebtOf(alice), 0);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(500e18);
        assertEq(market.scaledDebtOf(alice), 500e18); // index is exactly 1 at t0
        assertEq(market.scaledDebtOf(alice), market.totalScaledDebt());
    }

    // =============================================================== interest

    /// One interval, hand-computed:
    ///   lender supplies 100,000; alice borrows 1,000 -> utilization 1%.
    ///   rate = 2% + 10% x 1% = 2.1% APR (210 bps).
    ///   after 365 days: index = 1 + 0.021 = 1.021 -> debt = 1,021.
    ///   interest = 21; reserves = 10% x 21 = 2.1.
    ///   totalAssets = cash 99,000 + debt 1,021 - reserves 2.1 = 100,018.9.
    function test_interest_oneYear_handComputed() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        assertEq(market.borrowRateBps(), 210);

        vm.warp(block.timestamp + 365 days);
        assertEq(market.debtOf(alice), 1_021e18);
        assertEq(market.totalAssets(), 100_018.9e18);

        // Touch the market so accrual is written to storage, and check again.
        _lend(bob, 1e18);
        assertEq(market.borrowIndex(), 1.021e27);
        assertEq(market.reserves(), 2.1e18);
        assertEq(market.debtOf(alice), 1_021e18);
    }

    /// Two half-year intervals compound: index = 1.0105 x (1 + r2 x 0.5),
    /// where r2 is set by utilization after the first half. Hand-computed:
    ///   half 1: rate 2.1%, index 1.0105, debt 1,010.5, reserves 1.05.
    ///   utilization = 1,010.5 / (99,000 + 1,010.5 - 1.05) = 0.010104... ;
    ///   r2 = 200 + floor(1000 x 0.010104...) = 210 bps (bps floor).
    ///   half 2: index = 1.0105 x 1.0105 = 1.02111025.
    function test_interest_twoIntervals_compound() public {
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        vm.warp(block.timestamp + 365 days / 2);
        _lend(bob, 1e18); // touch
        assertEq(market.borrowIndex(), 1.0105e27);
        vm.warp(block.timestamp + 365 days / 2);
        _lend(bob, 1e18);
        assertEq(market.borrowIndex(), 1.02111025e27);
    }

    function test_interest_noDebt_noAccrual() public {
        vm.warp(block.timestamp + 365 days);
        _lend(bob, 1e18);
        assertEq(market.borrowIndex(), 1e27);
        assertEq(market.reserves(), 0);
    }

    // ================================================================= views

    function test_healthFactor() public {
        assertEq(market.healthFactor(alice), type(uint256).max);
        _postCollateral(alice, 1_000e18); // $2,000
        vm.prank(alice);
        market.borrow(1_000e18);
        // 2,000 x 0.65 / 1,000 = 1.3
        assertEq(market.healthFactor(alice), 1.3e18);
        _setCollPrice(1.4e18); // 1,400 x 0.65 / 1,000 = 0.91
        assertEq(market.healthFactor(alice), 0.91e18);
    }

    function test_tierDebtAndTotals() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1_000e18);
        _postCollateral(bob, 1_000e18);
        vm.prank(bob);
        market.borrow(500e18);
        assertEq(market.tierDebt(RiskParams.Tier.A), 1_000e18);
        assertEq(market.tierDebt(RiskParams.Tier.FLOOR), 500e18);
        assertEq(market.totalDebt(), 1_500e18);
    }

    function test_maxBorrow_unscored() public {
        _postCollateral(alice, 1_000e18); // $2,000 -> 60% = 1,200, capped at 1,000
        assertEq(market.maxBorrow(alice), 1_000e18 - 3); // margin: index/RAY + 2 = 3 wei
    }

    function test_maxBorrow_boundedByCash() public {
        _attest(alice, 800);
        _postCollateral(alice, 1_000_000e18);
        vm.prank(lender);
        market.withdraw(99_990e18, lender, lender); // leave 10 tUSD idle
        assertEq(market.maxBorrow(alice), 10e18 - 3);
    }

    function test_maxBorrow_zeroWithoutCollateral() public view {
        assertEq(market.maxBorrow(alice), 0);
    }

    function test_maxBorrow_tierAndGlobalCaps() public {
        _attest(alice, 800);
        _postCollateral(alice, 100_000e18);
        uint256[5] memory caps = [GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP, GLOBAL_CAP, uint256(700e18)];
        vm.prank(owner);
        market.setCaps(GLOBAL_CAP, caps);
        assertEq(market.maxBorrow(alice), 700e18 - 3);
        caps[4] = GLOBAL_CAP;
        vm.prank(owner);
        market.setCaps(400e18, caps);
        assertEq(market.maxBorrow(alice), 400e18 - 3);
    }

    /// borrow(maxBorrow) always succeeds, after any amount of accrued interest,
    /// for any score and collateral, including a wallet that already has debt
    /// at a different tier.
    function testFuzz_maxBorrowAlwaysBorrowable(
        uint256 collateral,
        uint16 score,
        bool scored,
        uint256 elapsed,
        uint256 firstBorrow
    ) public {
        collateral = bound(collateral, 1e18, 50_000e18);
        score = uint16(bound(score, 300, 850));
        elapsed = bound(elapsed, 0, 3 * 365 days);
        _postCollateral(alice, collateral);
        // Build some interest history with another borrower.
        _postCollateral(bob, 1_000e18);
        vm.prank(bob);
        market.borrow(bound(firstBorrow, 1e18, 1_000e18));
        vm.warp(block.timestamp + elapsed);
        _refreshPrices();
        if (scored) _attest(alice, score);

        uint256 m = market.maxBorrow(alice);
        if (m == 0) return;
        vm.prank(alice);
        market.borrow(m);
    }

    // ================================================================= admin

    function test_setCaps() public {
        uint256[5] memory caps = [uint256(1), 2, 3, 4, 5];
        vm.prank(owner);
        market.setCaps(10, caps);
        assertEq(market.globalDebtCap(), 10);
        assertEq(market.tierDebtCap(0), 1);
        assertEq(market.tierDebtCap(4), 5);
    }

    function test_revert_setCaps_notOwner() public {
        uint256[5] memory caps;
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        market.setCaps(10, caps);
    }

    function test_revert_pause_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        market.pause();
    }

    function test_unpause() public {
        vm.startPrank(owner);
        market.pause();
        market.unpause();
        vm.stopPrank();
        _postCollateral(alice, 1_000e18);
        vm.prank(alice);
        market.borrow(1e18);
    }

    function test_revert_unpause_notOwner() public {
        vm.prank(owner);
        market.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        market.unpause();
    }

    // ================================================================== fuzz

    /// Any borrow that succeeds leaves the position within its tier's max LTV.
    function testFuzz_borrowNeverAboveMaxLtv(uint256 collateral, uint256 amount, uint16 score, bool scored) public {
        collateral = bound(collateral, 1e15, 50_000e18);
        amount = bound(amount, 1, 30_000e18);
        score = uint16(bound(score, 300, 850));
        if (scored) _attest(alice, score);
        _postCollateral(alice, collateral);

        vm.prank(alice);
        try market.borrow(amount) {
            (uint256 c, uint256 d, RiskParams.Tier tier,) = market.getPosition(alice);
            uint256 collValue = c * 2; // $2 per tCOLL
            assertLe(d * 10_000, collValue * RiskParams.tierToMaxLtv(tier), "position above max LTV");
            assertLe(d, RiskParams.tierToWalletCap(tier), "position above wallet cap");
        } catch {}
    }
}
