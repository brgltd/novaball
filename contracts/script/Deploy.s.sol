// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {NovaGarage} from "../src/NovaGarage.sol";
import {NovaToken} from "../src/NovaToken.sol";

/// @notice Deploys NOVA + Garage + Arena, lists the cosmetics catalog, wires the roles and writes the addresses to
///         `deployments/<chainId>.json` and `../frontend/src/chain/deployments/<chainId>.json` (read by the web app).
///
/// Environment (all optional except PRIVATE_KEY on public networks; see .env.example):
///   PRIVATE_KEY             deployer key (the local chain always uses anvil account #0)
///   CAR_PRICE               NOVA per car body       (default 100)
///   PAINT_PRICE             NOVA per paint          (default 20)
///   REWARD_PER_100_POINTS   NOVA minted per 100 match points (default 100, i.e. 1 NOVA / point)
///   MAX_POINTS_PER_MATCH    per-player cap per match (default 3000)
///   MATCH_COOLDOWN          seconds between reward claims per player (default 60)
contract Deploy is Script {
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    struct Paint {
        string key;
        string name;
        uint24 color;
    }

    function run() external returns (NovaToken nova, NovaGarage garage, NovaArena arena) {
        bool local = block.chainid == 31_337;
        // the local chain always uses anvil accounts (contracts/.env holds the public-network keys)
        uint256 pk = local ? ANVIL_KEY_0 : vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint128 carPrice = SafeCast.toUint128(vm.envOr("CAR_PRICE", uint256(100)) * 1e18);
        uint128 paintPrice = SafeCast.toUint128(vm.envOr("PAINT_PRICE", uint256(20)) * 1e18);
        uint256 rewardPerPoint = vm.envOr("REWARD_PER_100_POINTS", uint256(100)) * 1e16;
        uint32 maxPoints = SafeCast.toUint32(vm.envOr("MAX_POINTS_PER_MATCH", uint256(3000)));
        uint32 cooldown = SafeCast.toUint32(vm.envOr("MATCH_COOLDOWN", uint256(60)));

        console2.log("chain    ", block.chainid);
        console2.log("deployer ", deployer);

        vm.startBroadcast(pk);
        nova = new NovaToken(deployer);
        garage = new NovaGarage(nova, deployer);
        arena = new NovaArena(nova, deployer, rewardPerPoint, maxPoints, cooldown);

        nova.grantRole(nova.MINTER_ROLE(), address(arena));
        nova.grantRole(nova.SPENDER_ROLE(), address(garage));

        // STRIKER + ARCTIC are the free starter kit; everything else is an NFT.
        garage.addItem(NovaGarage.Kind.Car, "viper", "VIPER", 0xb9c3cf, carPrice);
        garage.addItem(NovaGarage.Kind.Car, "titan", "TITAN", 0xb9c3cf, carPrice);
        Paint[9] memory paints = [
            Paint("graphite", "GRAPHITE", 0x2a2f3a),
            Paint("obsidian", "OBSIDIAN", 0x0d0f14),
            Paint("chrome", "CHROME", 0xb9c3cf),
            Paint("crimson", "CRIMSON", 0xb3122e),
            Paint("cobalt", "COBALT", 0x1947c2),
            Paint("toxic", "TOXIC", 0x7cff3a),
            Paint("solar", "SOLAR", 0xffcc33),
            Paint("violet", "VIOLET", 0x7a2cff),
            Paint("rose", "ROSE", 0xff4fa3)
        ];
        for (uint256 i; i < paints.length; ++i) {
            garage.addItem(NovaGarage.Kind.Paint, paints[i].key, paints[i].name, paints[i].color, paintPrice);
        }

        vm.stopBroadcast();

        _write(nova, garage, arena, deployer);
    }

    function _write(NovaToken nova, NovaGarage garage, NovaArena arena, address deployer) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", vm.getBlockNumber());
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "nova", address(nova));
        vm.serializeAddress(o, "garage", address(garage));
        string memory json = vm.serializeAddress(o, "arena", address(arena));
        console2.log("NOVA     ", address(nova));
        console2.log("Garage   ", address(garage));
        console2.log("Arena    ", address(arena));
        // a simulation (no --broadcast) must not overwrite the real addresses
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("dry run: deployment files not written");
            return;
        }
        string memory file = string.concat(vm.toString(block.chainid), ".json");
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", file));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../frontend/src/chain/deployments/", file));
    }
}
