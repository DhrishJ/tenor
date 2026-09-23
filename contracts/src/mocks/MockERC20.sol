// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice TESTNET MOCK token with an open faucet. Worthless by design.
contract MockERC20 is ERC20 {
    uint256 public immutable faucetAmount;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address account => uint256) public lastFaucetAt;

    error FaucetCooldown(uint256 availableAt);

    /// @param initialSupply_ minted once to the deployer, to seed pool liquidity.
    constructor(string memory name_, string memory symbol_, uint256 faucetAmount_, uint256 initialSupply_)
        ERC20(name_, symbol_)
    {
        faucetAmount = faucetAmount_;
        if (initialSupply_ > 0) _mint(msg.sender, initialSupply_);
    }

    /// @notice Anyone can claim `faucetAmount` once per cooldown.
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }
}
