// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {TenorMarket} from "../src/TenorMarket.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @dev Shared deployment for market, integration and invariant tests.
/// Prices: tCOLL = $2.00, tUSD = $1.00. One lender supplies 100,000 tUSD.
abstract contract BaseTest is Test {
    uint64 constant T0 = 1_790_000_000;
    uint256 constant MAX_PRICE_AGE = 1 days;
    uint256 constant GLOBAL_CAP = 1_000_000e18;
    bytes32 constant MODEL = keccak256("v5-xgb-cal");

    address owner = makeAddr("owner");
    uint256 attestorKey = 0xA11CE;
    address attestor;
    address lender = makeAddr("lender");

    ScoreRegistry registry;
    MockPriceOracle oracle;
    MockERC20 usd;
    MockERC20 coll;
    TenorMarket market;

    function setUp() public virtual {
        vm.warp(T0);
        attestor = vm.addr(attestorKey);
        usd = new MockERC20("Tenor Test USD", "tUSD", 1_000e18);
        coll = new MockERC20("Tenor Test Collateral", "tCOLL", 1_000e18);
        registry = new ScoreRegistry(owner, attestor);
        oracle = new MockPriceOracle(owner);
        market = new TenorMarket(
            owner,
            IERC20Metadata(address(usd)),
            IERC20Metadata(address(coll)),
            registry,
            oracle,
            MAX_PRICE_AGE,
            GLOBAL_CAP
        );
        vm.startPrank(owner);
        registry.setMarket(address(market), true);
        oracle.setPrice(address(coll), 2e18);
        oracle.setPrice(address(usd), 1e18);
        vm.stopPrank();

        _lend(lender, 100_000e18);
    }

    // ------------------------------------------------------------ helpers

    function _lend(address who, uint256 amount) internal {
        deal(address(usd), who, usd.balanceOf(who) + amount);
        vm.startPrank(who);
        usd.approve(address(market), amount);
        market.deposit(amount, who);
        vm.stopPrank();
    }

    function _postCollateral(address who, uint256 amount) internal {
        deal(address(coll), who, coll.balanceOf(who) + amount);
        vm.startPrank(who);
        coll.approve(address(market), amount);
        market.depositCollateral(amount);
        vm.stopPrank();
    }

    /// Signs and submits a score for `who`, issued now, valid for one day.
    function _attest(address who, uint16 score) internal {
        ScoreRegistry.Attestation memory a = ScoreRegistry.Attestation({
            wallet: who,
            score: score,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 days),
            deadline: uint64(block.timestamp + 15 minutes),
            nonce: registry.nonces(who),
            modelVersion: MODEL
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, registry.hashAttestation(a));
        registry.submitAttestation(a, abi.encodePacked(r, s, v));
    }

    function _setCollPrice(uint256 priceWad) internal {
        vm.prank(owner);
        oracle.setPrice(address(coll), priceWad);
    }

    /// Re-stamps both prices at their current values (keeps them fresh after a warp).
    function _refreshPrices() internal {
        (uint256 c,) = oracle.getPrice(address(coll));
        (uint256 u,) = oracle.getPrice(address(usd));
        vm.startPrank(owner);
        oracle.setPrice(address(coll), c);
        oracle.setPrice(address(usd), u);
        vm.stopPrank();
    }
}
