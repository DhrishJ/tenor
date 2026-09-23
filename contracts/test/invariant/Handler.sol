// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TenorMarket} from "../../src/TenorMarket.sol";
import {ScoreRegistry} from "../../src/ScoreRegistry.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {MockPriceOracle} from "../../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @dev Drives random sequences of market actions across a fixed set of
/// actors. Ghost variables record anything the protocol should never have
/// allowed; the invariant test asserts they stay zero.
contract Handler is CommonBase, StdCheats, StdUtils {
    TenorMarket public market;
    ScoreRegistry public registry;
    MockPriceOracle public oracle;
    MockERC20 public usd;
    MockERC20 public coll;
    address public oracleOwner;
    uint256 internal attestorKey;

    address[] public actors;
    address public liquidator = address(0xC0FFEE);

    // ---- ghost variables: violations (must stay 0) ----
    uint256 public ghost_borrowAboveMaxLtv;
    uint256 public ghost_borrowTierMismatch; // priced at a tier other than the effective one
    uint256 public ghost_borrowPricedByStaleScore; // stale/absent score priced above FLOOR
    uint256 public ghost_borrowAboveGlobalCap;
    uint256 public ghost_zombieDebt; // debt left on a position with zero collateral

    // ---- ghost variables: counters (for the summary) ----
    uint256 public calls_borrow;
    uint256 public calls_borrowOk;
    uint256 public calls_liquidateOk;
    uint256 public calls_shortfall;
    uint256 public calls_attest;
    uint256 public calls_repayOk;
    uint256 public calls_withdrawCollOk;

    constructor(
        TenorMarket market_,
        ScoreRegistry registry_,
        MockPriceOracle oracle_,
        MockERC20 usd_,
        MockERC20 coll_,
        address oracleOwner_,
        uint256 attestorKey_
    ) {
        market = market_;
        registry = registry_;
        oracle = oracle_;
        usd = usd_;
        coll = coll_;
        oracleOwner = oracleOwner_;
        attestorKey = attestorKey_;
        for (uint256 i = 0; i < 4; i++) {
            actors.push(address(uint160(0xA000 + i)));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ------------------------------------------------------------- lenders

    function lend(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1e18, 50_000e18);
        deal(address(usd), a, usd.balanceOf(a) + amount);
        vm.startPrank(a);
        usd.approve(address(market), amount);
        try market.deposit(amount, a) {} catch {}
        vm.stopPrank();
    }

    function redeem(uint256 seed, uint256 shares) external {
        address a = _actor(seed);
        uint256 max = market.maxRedeem(a);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(a);
        try market.redeem(shares, a, a) {} catch {}
    }

    // ----------------------------------------------------------- borrowers

    function depositCollateral(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1e18, 20_000e18);
        deal(address(coll), a, coll.balanceOf(a) + amount);
        vm.startPrank(a);
        coll.approve(address(market), amount);
        market.depositCollateral(amount);
        vm.stopPrank();
    }

    function withdrawCollateral(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        (uint256 c,,,) = market.getPosition(a);
        if (c == 0) return;
        amount = bound(amount, 1, c);
        vm.prank(a);
        try market.withdrawCollateral(amount) {
            calls_withdrawCollOk++;
        } catch {}
    }

    function borrow(uint256 seed, uint256 amount, bool useMax) external {
        address a = _actor(seed);
        calls_borrow++;
        (RiskParams.Tier expected,) = registry.effectiveTier(a);
        (,,, bool stale) = registry.getScore(a);

        if (useMax) {
            try market.maxBorrow(a) returns (uint256 m) {
                if (m == 0) return;
                amount = m;
            } catch {
                return;
            }
        } else {
            amount = bound(amount, 1, 25_000e18);
        }

        vm.prank(a);
        try market.borrow(amount) {
            calls_borrowOk++;
            (uint256 c, uint256 d, RiskParams.Tier tier,) = market.getPosition(a);
            if (tier != expected) ghost_borrowTierMismatch++;
            if (stale && tier != RiskParams.Tier.FLOOR) ghost_borrowPricedByStaleScore++;
            (uint256 cp,) = oracle.getPrice(address(coll));
            (uint256 up,) = oracle.getPrice(address(usd));
            // debtValue <= collValue * maxLtv, in 1e36-scaled units to avoid rounding.
            if (d * up * 10_000 > c * cp * RiskParams.tierToMaxLtv(tier)) ghost_borrowAboveMaxLtv++;
            if (market.totalDebt() > market.globalDebtCap()) ghost_borrowAboveGlobalCap++;
        } catch {}
    }

    function repay(uint256 seed, uint256 amount, bool full) external {
        address a = _actor(seed);
        uint256 debt = market.debtOf(a);
        if (debt == 0) return;
        amount = full ? type(uint256).max : bound(amount, 1, debt);
        uint256 need = full ? debt : amount;
        deal(address(usd), a, usd.balanceOf(a) + need);
        vm.startPrank(a);
        usd.approve(address(market), need);
        try market.repay(a, amount) {
            calls_repayOk++;
        } catch {}
        vm.stopPrank();
    }

    function liquidate(uint256 seed, uint256 maxRepay) external {
        address a = _actorWithDebt(seed);
        if (a == address(0)) return;
        _liquidate(a, maxRepay);
    }

    /// Gap the price down (to 5%..95% of its current value, floored at
    /// $0.05) and liquidate straight away: exercises shortfall paths that
    /// random sequences reach only rarely.
    function crashAndLiquidate(uint256 seed, uint256 pct, uint256 maxRepay) external {
        address a = _actorWithDebt(seed);
        if (a == address(0)) return;
        (uint256 p,) = oracle.getPrice(address(coll));
        pct = bound(pct, 5, 95);
        uint256 np = p * pct / 100;
        if (np < 0.05e18) np = 0.05e18;
        vm.startPrank(oracleOwner);
        oracle.setPrice(address(coll), np);
        (uint256 u,) = oracle.getPrice(address(usd));
        oracle.setPrice(address(usd), u); // keep the debt price fresh too
        vm.stopPrank();
        _liquidate(a, maxRepay);
    }

    function _actorWithDebt(uint256 seed) internal view returns (address) {
        for (uint256 i = 0; i < actors.length; i++) {
            address a = actors[(seed % actors.length + i) % actors.length];
            if (market.debtOf(a) > 0) return a;
        }
        return address(0);
    }

    function _liquidate(address a, uint256 maxRepay) internal {
        uint256 debt = market.debtOf(a);
        maxRepay = bound(maxRepay, 1, debt * 2);
        deal(address(usd), liquidator, maxRepay);
        uint256 badDebtBefore = market.totalBadDebt();
        vm.startPrank(liquidator);
        usd.approve(address(market), maxRepay);
        try market.liquidate(a, maxRepay) {
            calls_liquidateOk++;
            if (market.totalBadDebt() > badDebtBefore) calls_shortfall++;
        } catch {}
        vm.stopPrank();
        _checkZombie(a);
    }

    // --------------------------------------------------------------- world

    /// Moves the collateral price anywhere in [$0.20, $3.00], including gaps
    /// straight through every tier's buffer.
    function movePrice(uint256 price) external {
        price = bound(price, 0.2e18, 3e18);
        vm.prank(oracleOwner);
        oracle.setPrice(address(coll), price);
    }

    /// Passes time (up to 3 days, so scores expire and interest accrues).
    /// Usually refreshes prices; sometimes leaves them stale.
    function warp(uint256 dt, bool refresh) external {
        dt = bound(dt, 1, 3 days);
        vm.warp(block.timestamp + dt);
        if (refresh) {
            (uint256 c,) = oracle.getPrice(address(coll));
            (uint256 u,) = oracle.getPrice(address(usd));
            vm.startPrank(oracleOwner);
            oracle.setPrice(address(coll), c);
            oracle.setPrice(address(usd), u);
            vm.stopPrank();
        }
    }

    function attest(uint256 seed, uint16 score) external {
        address a = _actor(seed);
        score = uint16(bound(score, 300, 850));
        ScoreRegistry.Attestation memory att = ScoreRegistry.Attestation({
            wallet: a,
            score: score,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 days),
            deadline: uint64(block.timestamp + 15 minutes),
            nonce: registry.nonces(a),
            modelVersion: keccak256("v5-xgb-cal")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, registry.hashAttestation(att));
        try registry.submitAttestation(att, abi.encodePacked(r, s, v)) {
            calls_attest++;
        } catch {}
    }

    function _checkZombie(address a) internal {
        (uint256 c, uint256 d,,) = market.getPosition(a);
        if (c == 0 && d > 0) ghost_zombieDebt++;
    }
}
