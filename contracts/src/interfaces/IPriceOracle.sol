// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IPriceOracle
/// @notice Price source for TenorMarket. Any real feed (Pyth, Chainlink,
/// RedStone) can sit behind this interface through an adapter, with no change
/// to market logic.
/// @dev Returns the USD price of one whole token, scaled to 1e18, and the time
/// it was last updated. The market rejects zero prices and prices older than
/// its `maxPriceAge`, so staleness is checked no matter which oracle is plugged
/// in.
interface IPriceOracle {
    function getPrice(address asset) external view returns (uint256 priceWad, uint256 updatedAt);
}
