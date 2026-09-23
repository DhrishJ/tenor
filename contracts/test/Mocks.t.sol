// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockPriceOracleTest is Test {
    MockPriceOracle oracle;
    address owner = makeAddr("owner");
    address asset = makeAddr("asset");

    function setUp() public {
        vm.warp(1_790_000_000);
        oracle = new MockPriceOracle(owner);
    }

    function test_setAndGet() public {
        vm.expectEmit(address(oracle));
        emit MockPriceOracle.PriceSet(asset, 2e18, block.timestamp);
        vm.prank(owner);
        oracle.setPrice(asset, 2e18);
        (uint256 p, uint256 t) = oracle.getPrice(asset);
        assertEq(p, 2e18);
        assertEq(t, block.timestamp);
    }

    function test_updatedAtMovesWithEachSet() public {
        vm.prank(owner);
        oracle.setPrice(asset, 2e18);
        vm.warp(block.timestamp + 100);
        vm.prank(owner);
        oracle.setPrice(asset, 1e18);
        (uint256 p, uint256 t) = oracle.getPrice(asset);
        assertEq(p, 1e18);
        assertEq(t, block.timestamp);
    }

    function test_revert_unsetAsset() public {
        vm.expectRevert(abi.encodeWithSelector(MockPriceOracle.PriceNotSet.selector, asset));
        oracle.getPrice(asset);
    }

    function test_revert_setPrice_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        oracle.setPrice(asset, 1e18);
    }
}

contract MockERC20Test is Test {
    MockERC20 token;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new MockERC20("Tenor Test USD", "tUSD", 1_000e18);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Tenor Test USD");
        assertEq(token.symbol(), "tUSD");
        assertEq(token.decimals(), 18);
    }

    function test_faucet() public {
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), 1_000e18);
    }

    function test_revert_faucetCooldown() public {
        vm.prank(alice);
        token.faucet();
        vm.warp(block.timestamp + 1 hours - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.FaucetCooldown.selector, block.timestamp + 1));
        token.faucet();
    }

    function test_faucetAfterCooldown() public {
        vm.prank(alice);
        token.faucet();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), 2_000e18);
    }
}
