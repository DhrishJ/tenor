// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TenorMarket} from "../src/TenorMarket.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @dev Hostile collateral token: on every transfer out of the market it calls
/// back into the market (as the recipient would with a hook token).
contract HookToken is ERC20 {
    TenorMarket public market;
    bytes public reenterCall;

    constructor() ERC20("Hook", "HOOK") {}

    function arm(TenorMarket m, bytes calldata call) external {
        market = m;
        reenterCall = call;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(market) != address(0) && from == address(market) && reenterCall.length > 0) {
            (bool ok, bytes memory ret) = address(market).call(reenterCall);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

contract ReentrancyTest is Test {
    TenorMarket market;
    HookToken hook;
    MockERC20 usd;
    MockPriceOracle oracle;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_790_000_000);
        hook = new HookToken();
        usd = new MockERC20("Tenor Test USD", "tUSD", 1_000e18);
        ScoreRegistry registry = new ScoreRegistry(owner, vm.addr(1));
        oracle = new MockPriceOracle(owner);
        market = new TenorMarket(
            owner, IERC20Metadata(address(usd)), IERC20Metadata(address(hook)), registry, oracle, 1 days, 1_000_000e18
        );
        vm.startPrank(owner);
        registry.setMarket(address(market), true);
        oracle.setPrice(address(hook), 2e18);
        oracle.setPrice(address(usd), 1e18);
        vm.stopPrank();

        deal(address(usd), address(this), 10_000e18);
        usd.approve(address(market), 10_000e18);
        market.deposit(10_000e18, address(this));

        hook.mint(alice, 1_000e18);
        vm.startPrank(alice);
        hook.approve(address(market), 1_000e18);
        market.depositCollateral(1_000e18);
        vm.stopPrank();
    }

    /// Withdrawing collateral transfers the hook token out; its callback tries
    /// to borrow in the middle of the withdrawal and is stopped by the guard.
    function test_reentrantBorrowDuringCollateralWithdraw_blocked() public {
        hook.arm(market, abi.encodeCall(TenorMarket.borrow, (100e18)));
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        market.withdrawCollateral(10e18);
    }

    function test_reentrantWithdrawDuringCollateralWithdraw_blocked() public {
        hook.arm(market, abi.encodeCall(TenorMarket.withdrawCollateral, (10e18)));
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        market.withdrawCollateral(10e18);
    }
}
