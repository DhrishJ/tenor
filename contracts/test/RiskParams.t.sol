// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {RiskParams} from "../src/RiskParams.sol";

/// @dev Exposes the internal library functions as external calls so that
/// vm.expectRevert can observe their reverts.
contract RiskParamsHarness {
    function scoreToTier(uint16 score) external pure returns (RiskParams.Tier) {
        return RiskParams.scoreToTier(score);
    }

    function maxLtv(RiskParams.Tier t) external pure returns (uint256) {
        return RiskParams.tierToMaxLtv(t);
    }

    function liqThreshold(RiskParams.Tier t) external pure returns (uint256) {
        return RiskParams.tierToLiquidationThreshold(t);
    }

    function walletCap(RiskParams.Tier t) external pure returns (uint256) {
        return RiskParams.tierToWalletCap(t);
    }

    function rate(uint256 u) external pure returns (uint256) {
        return RiskParams.borrowRateBps(u);
    }

    function validate() external pure {
        RiskParams.validate();
    }
}

contract RiskParamsTest is Test {
    RiskParamsHarness h;

    function setUp() public {
        h = new RiskParamsHarness();
    }

    // ---------------------------------------------------------------- unit

    function test_boundaries_exact() public view {
        assertEq(uint256(h.scoreToTier(300)), uint256(RiskParams.Tier.FLOOR));
        assertEq(uint256(h.scoreToTier(451)), uint256(RiskParams.Tier.FLOOR));
        assertEq(uint256(h.scoreToTier(452)), uint256(RiskParams.Tier.D));
        assertEq(uint256(h.scoreToTier(577)), uint256(RiskParams.Tier.D));
        assertEq(uint256(h.scoreToTier(578)), uint256(RiskParams.Tier.C));
        assertEq(uint256(h.scoreToTier(642)), uint256(RiskParams.Tier.C));
        assertEq(uint256(h.scoreToTier(643)), uint256(RiskParams.Tier.B));
        assertEq(uint256(h.scoreToTier(773)), uint256(RiskParams.Tier.B));
        assertEq(uint256(h.scoreToTier(774)), uint256(RiskParams.Tier.A));
        assertEq(uint256(h.scoreToTier(850)), uint256(RiskParams.Tier.A));
    }

    function test_revert_scoreBelowRange() public {
        vm.expectRevert(abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, uint16(299)));
        h.scoreToTier(299);
    }

    function test_revert_scoreAboveRange() public {
        vm.expectRevert(abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, uint16(851)));
        h.scoreToTier(851);
    }

    function test_revert_scoreZero() public {
        vm.expectRevert(abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, uint16(0)));
        h.scoreToTier(0);
    }

    function test_termsTable() public view {
        // The agreed placeholder band: 60/65 at the floor up to 80/85 at A.
        assertEq(h.maxLtv(RiskParams.Tier.FLOOR), 6_000);
        assertEq(h.liqThreshold(RiskParams.Tier.FLOOR), 6_500);
        assertEq(h.maxLtv(RiskParams.Tier.A), 8_000);
        assertEq(h.liqThreshold(RiskParams.Tier.A), 8_500);
    }

    function test_validate_passes() public view {
        h.validate();
    }

    function test_rate_endpoints() public view {
        assertEq(h.rate(0), 200); // 2% APR at 0% utilization
        assertEq(h.rate(0.5e18), 700); // 2% + 10% * 0.5
        assertEq(h.rate(1e18), 1_200); // 12% APR at 100%
        assertEq(h.rate(5e18), 1_200); // clamped above 100%
    }

    // ---------------------------------------------------------------- fuzz

    /// A higher score never yields worse terms.
    function testFuzz_monotonic(uint16 a, uint16 b) public view {
        a = uint16(bound(a, 300, 850));
        b = uint16(bound(b, 300, 850));
        if (a > b) (a, b) = (b, a);
        RiskParams.Tier ta = h.scoreToTier(a);
        RiskParams.Tier tb = h.scoreToTier(b);
        assertLe(uint256(ta), uint256(tb));
        assertLe(h.maxLtv(ta), h.maxLtv(tb));
        assertLe(h.liqThreshold(ta), h.liqThreshold(tb));
        assertLe(h.walletCap(ta), h.walletCap(tb));
    }

    /// Hard bounds for every in-range score: LTV below 100%, threshold above
    /// LTV, and a liquidator always paid in full at the trigger.
    function testFuzz_bounds(uint16 s) public view {
        s = uint16(bound(s, 300, 850));
        RiskParams.Tier t = h.scoreToTier(s);
        uint256 ltv = h.maxLtv(t);
        uint256 lt = h.liqThreshold(t);
        assertLt(ltv, 10_000);
        assertGt(lt, ltv);
        assertLe(lt * (10_000 + RiskParams.LIQUIDATION_BONUS_BPS), 10_000 * 10_000);
    }

    /// Every out-of-range score reverts; none is silently mapped to a tier.
    function testFuzz_outOfRangeReverts(uint16 raw, bool high) public {
        uint16 s = high ? uint16(bound(raw, 851, type(uint16).max)) : uint16(bound(raw, 0, 299));
        vm.expectRevert(abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, s));
        h.scoreToTier(s);
    }

    /// The rate never leaves [2%, 12%] and never falls as utilization rises.
    function testFuzz_rate(uint256 u1, uint256 u2) public view {
        u1 = bound(u1, 0, 2e18);
        u2 = bound(u2, 0, 2e18);
        if (u1 > u2) (u1, u2) = (u2, u1);
        uint256 r1 = h.rate(u1);
        uint256 r2 = h.rate(u2);
        assertGe(r1, 200);
        assertLe(r2, 1_200);
        assertLe(r1, r2);
    }
}
