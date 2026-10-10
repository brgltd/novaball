// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Script, console2} from "forge-std/Script.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {NovaGarage} from "../src/NovaGarage.sol";

/// @notice Tune a live deployment (addresses come from deployments/<chainId>.json). Same env vars as Deploy.s.sol.
///
///   forge script script/Configure.s.sol --sig "prices()"  --rpc-url <net> --broadcast   # CAR_PRICE / PAINT_PRICE
///   forge script script/Configure.s.sol --sig "rewards()" --rpc-url <net> --broadcast   # REWARD_PER_100_POINTS, MAX_POINTS_PER_MATCH, MATCH_COOLDOWN
///   forge script script/Configure.s.sol --sig "price(string,uint256)" toxic 35 --rpc-url <net> --broadcast
contract Configure is Script {
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// Reprice every car to CAR_PRICE and every paint to PAINT_PRICE (whole NOVA).
    function prices() external {
        NovaGarage garage = _garage();
        uint256 carPrice = vm.envOr("CAR_PRICE", uint256(100)) * 1e18;
        uint256 paintPrice = vm.envOr("PAINT_PRICE", uint256(20)) * 1e18;
        NovaGarage.Item[] memory items = garage.catalog();
        uint256[] memory ids = new uint256[](items.length);
        uint128[] memory newPrices = new uint128[](items.length);
        for (uint256 i; i < items.length; ++i) {
            ids[i] = i + 1;
            newPrices[i] = SafeCast.toUint128(items[i].kind == NovaGarage.Kind.Car ? carPrice : paintPrice);
        }
        vm.startBroadcast(_key());
        garage.setPrices(ids, newPrices);
        vm.stopBroadcast();
        console2.log("car price  ", carPrice / 1e18);
        console2.log("paint price", paintPrice / 1e18);
    }

    /// Reprice one item by key (car style id or paint name), in whole NOVA.
    function price(string calldata key, uint256 novaPrice) external {
        NovaGarage garage = _garage();
        uint256 id = garage.idOf(NovaGarage.Kind.Car, key);
        if (id == 0) id = garage.idOf(NovaGarage.Kind.Paint, key);
        require(id != 0, "unknown item key");
        vm.startBroadcast(_key());
        garage.setPrice(id, SafeCast.toUint128(novaPrice * 1e18));
        vm.stopBroadcast();
    }

    function rewards() external {
        NovaArena arena = NovaArena(_addr(".arena"));
        uint256 rewardPerPoint = vm.envOr("REWARD_PER_100_POINTS", uint256(50)) * 1e16;
        uint32 maxPoints = SafeCast.toUint32(vm.envOr("MAX_POINTS_PER_MATCH", uint256(3000)));
        uint32 cooldown = SafeCast.toUint32(vm.envOr("MATCH_COOLDOWN", uint256(60)));
        vm.startBroadcast(_key());
        arena.setRewardConfig(rewardPerPoint, maxPoints, cooldown);
        vm.stopBroadcast();
    }

    function _garage() internal view returns (NovaGarage) {
        return NovaGarage(_addr(".garage"));
    }

    function _addr(string memory key) internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        return vm.parseJsonAddress(vm.readFile(path), key);
    }

    function _key() internal view returns (uint256) {
        return block.chainid == 31_337 ? vm.envOr("PRIVATE_KEY", ANVIL_KEY_0) : vm.envUint("PRIVATE_KEY");
    }
}
