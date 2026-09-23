// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title MockPriceOracle
/// @notice TESTNET MOCK. Prices are set by hand by the owner. They are not a
/// market feed.
///
/// Why a mock: no Chainlink feeds exist on Monad testnet, and Pyth's MON/USD
/// price was 15 days old when checked on 2026-09-22 (a pull oracle nobody had
/// updated). Both demo assets are mock tokens that no real feed prices anyway,
/// and the liquidation demo needs a price drop on cue.
///
/// Consequence (stated in the README): the owner of this contract can make any
/// position liquidatable by moving the price.
contract MockPriceOracle is IPriceOracle, Ownable {
    struct PriceData {
        uint256 priceWad;
        uint256 updatedAt;
    }

    mapping(address asset => PriceData) internal _prices;

    event PriceSet(address indexed asset, uint256 priceWad, uint256 updatedAt);

    error PriceNotSet(address asset);

    constructor(address owner_) Ownable(owner_) {}

    function setPrice(address asset, uint256 priceWad) external onlyOwner {
        _prices[asset] = PriceData(priceWad, block.timestamp);
        emit PriceSet(asset, priceWad, block.timestamp);
    }

    function getPrice(address asset) external view returns (uint256 priceWad, uint256 updatedAt) {
        PriceData memory p = _prices[asset];
        if (p.updatedAt == 0) revert PriceNotSet(asset);
        return (p.priceWad, p.updatedAt);
    }
}
