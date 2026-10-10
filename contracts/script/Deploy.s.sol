// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {NovaGarage} from "../src/NovaGarage.sol";
import {NovaToken} from "../src/NovaToken.sol";

/// @notice Deploys NOVA + Garage + Arena, lists the cosmetics catalog, wires the roles and writes the addresses to
///         `deployments/<chainId>.json` and `../frontend/src/chain/deployments/<chainId>.json` (read by the web app
///         and its relayer).
///
/// Environment (all optional except PRIVATE_KEY on public networks; see .env.example):
///   PRIVATE_KEY             deployer key (default: anvil account #0 — local only)
///   RELAYER_ADDRESS         game server / gas relayer that records matches (default: anvil #1 locally, else deployer)
///   CAR_PRICE               NOVA per car body       (default 100)
///   PAINT_PRICE             NOVA per paint          (default 20)
///   REWARD_PER_100_POINTS   NOVA minted per 100 match points (default 100, i.e. 1 NOVA / point)
///   MAX_POINTS_PER_MATCH    per-player cap per match (default 3000)
///   MATCH_COOLDOWN          seconds between rewarded matches per player (default 60)
///   RELAYER_TOPUP_MILLIETH  if > 0 and the relayer has less, send it this much ETH (in 0.001 ETH units)
contract Deploy is Script {
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL_ADDR_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    struct Paint {
        string key;
        string name;
        uint24 color;
    }

    function run() external returns (NovaToken nova, NovaGarage garage, NovaArena arena) {
        bool local = block.chainid == 31_337;
        uint256 pk = local ? vm.envOr("PRIVATE_KEY", ANVIL_KEY_0) : vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address relayer = vm.envOr("RELAYER_ADDRESS", local ? ANVIL_ADDR_1 : deployer);
        uint128 carPrice = SafeCast.toUint128(vm.envOr("CAR_PRICE", uint256(100)) * 1e18);
        uint128 paintPrice = SafeCast.toUint128(vm.envOr("PAINT_PRICE", uint256(20)) * 1e18);
        uint256 rewardPerPoint = vm.envOr("REWARD_PER_100_POINTS", uint256(100)) * 1e16;
        uint32 maxPoints = SafeCast.toUint32(vm.envOr("MAX_POINTS_PER_MATCH", uint256(3000)));
        uint32 cooldown = SafeCast.toUint32(vm.envOr("MATCH_COOLDOWN", uint256(60)));
        uint256 topup = vm.envOr("RELAYER_TOPUP_MILLIETH", uint256(0)) * 1e15;

        console2.log("chain    ", block.chainid);
        console2.log("deployer ", deployer);
        console2.log("relayer  ", relayer);

        vm.startBroadcast(pk);
        nova = new NovaToken(deployer);
        garage = new NovaGarage(nova, deployer);
        arena = new NovaArena(nova, deployer, rewardPerPoint, maxPoints, cooldown);

        nova.grantRole(nova.MINTER_ROLE(), address(arena));
        arena.grantRole(arena.GAME_SERVER_ROLE(), relayer);

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

        if (topup > 0 && relayer != deployer && relayer.balance < topup) {
            payable(relayer).transfer(topup - relayer.balance);
        }
        vm.stopBroadcast();

        _write(nova, garage, arena, deployer, relayer);
    }

    function _write(NovaToken nova, NovaGarage garage, NovaArena arena, address deployer, address relayer) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", vm.getBlockNumber());
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "relayer", relayer);
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
