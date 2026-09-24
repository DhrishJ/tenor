// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {TenorMarket} from "../src/TenorMarket.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @title Deploy
/// @notice Deploys the full Tenor stack and writes every address to
/// `deployments/<chainId>.json`, the one place off-chain code reads addresses from.
///
/// Environment (all required, no defaults hidden in code):
///   ATTESTOR_ADDRESS   address the attestation service signs with
///   MAX_PRICE_AGE      seconds a mock price stays valid (testnet: long, see CONTRACTS.md 9.7)
///   GLOBAL_DEBT_CAP    tUSD, 18 decimals
///   SEED_LIQUIDITY     tUSD the deployer lends into the pool (0 for none)
///   COLL_PRICE_WAD     initial tCOLL price in USD, 1e18 = $1
///
///   forge script script/Deploy.s.sol --rpc-url <url> --broadcast --private-key <throwaway>
contract Deploy is Script {
    function run() external {
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        uint256 maxPriceAge = vm.envUint("MAX_PRICE_AGE");
        uint256 globalCap = vm.envUint("GLOBAL_DEBT_CAP");
        uint256 seed = vm.envUint("SEED_LIQUIDITY");
        uint256 collPrice = vm.envUint("COLL_PRICE_WAD");

        vm.startBroadcast();
        address deployer = msg.sender;
        uint256 startBlock = block.number;

        MockERC20 usd = new MockERC20("Tenor Test USD", "tUSD", 1_000e18, seed);
        MockERC20 coll = new MockERC20("Tenor Test Collateral", "tCOLL", 1_000e18, 0);
        ScoreRegistry registry = new ScoreRegistry(deployer, attestor);
        MockPriceOracle oracle = new MockPriceOracle(deployer);
        TenorMarket market = new TenorMarket(
            deployer,
            IERC20Metadata(address(usd)),
            IERC20Metadata(address(coll)),
            registry,
            oracle,
            maxPriceAge,
            globalCap
        );

        registry.setMarket(address(market), true);
        oracle.setPrice(address(usd), 1e18);
        oracle.setPrice(address(coll), collPrice);
        {
            // Optional (OBJECTIONS P4-O13): the oracle keeper's own throwaway key
            // takes over the mock oracle, so the deployer key never sits on a server.
            address oracleOwner = vm.envOr("ORACLE_OWNER", address(0));
            if (oracleOwner != address(0)) oracle.transferOwnership(oracleOwner);
        }

        if (seed > 0) {
            // tUSD's initial supply (= seed) was minted to the deployer above.
            usd.approve(address(market), seed);
            market.deposit(seed, deployer);
        }
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", startBlock);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "attestor", attestor);
        vm.serializeAddress(o, "tUSD", address(usd));
        vm.serializeAddress(o, "tCOLL", address(coll));
        vm.serializeAddress(o, "scoreRegistry", address(registry));
        vm.serializeAddress(o, "mockPriceOracle", address(oracle));
        vm.serializeAddress(o, "oracleOwner", oracle.owner());
        vm.serializeAddress(o, "tenorMarket", address(market));
        vm.serializeString(o, "eip712Name", "Tenor ScoreRegistry");
        vm.serializeString(o, "eip712Version", "1");
        string memory json = vm.serializeUint(o, "maxPriceAge", maxPriceAge);

        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
