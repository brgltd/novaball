// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {NovaGarage} from "../src/NovaGarage.sol";
import {NovaToken} from "../src/NovaToken.sol";

/// Shared fixture: the three contracts wired like Deploy.s.sol, a small catalog and a few actors.
abstract contract BaseTest is Test {
    NovaToken internal nova;
    NovaGarage internal garage;
    NovaArena internal arena;

    address internal admin = makeAddr("admin");
    address internal server = makeAddr("server");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    uint256 internal alicePk = 0xA11CE;
    address internal alice = vm.addr(alicePk);
    uint256 internal bobPk = 0xB0B;
    address internal bob = vm.addr(bobPk);

    uint256 internal constant REWARD_PER_POINT = 0.5 ether;
    uint32 internal constant MAX_POINTS = 3000;
    uint32 internal constant COOLDOWN = 60;
    uint128 internal constant CAR_PRICE = 100 ether;
    uint128 internal constant PAINT_PRICE = 20 ether;

    uint256 internal viperId;
    uint256 internal titanId;
    uint256 internal crimsonId;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        nova = new NovaToken(admin);
        garage = new NovaGarage(nova, admin);
        arena = new NovaArena(nova, admin, REWARD_PER_POINT, MAX_POINTS, COOLDOWN);
        vm.startPrank(admin);
        nova.grantRole(nova.MINTER_ROLE(), address(arena));
        arena.grantRole(arena.GAME_SERVER_ROLE(), server);
        viperId = garage.addItem(NovaGarage.Kind.Car, "viper", "VIPER", 0xb9c3cf, CAR_PRICE);
        titanId = garage.addItem(NovaGarage.Kind.Car, "titan", "TITAN", 0xb9c3cf, CAR_PRICE);
        crimsonId = garage.addItem(NovaGarage.Kind.Paint, "crimson", "CRIMSON", 0xb3122e, PAINT_PRICE);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _mintNova(address to, uint256 amount) internal {
        vm.startPrank(admin);
        nova.grantRole(nova.MINTER_ROLE(), admin);
        nova.mint(to, amount);
        vm.stopPrank();
    }

    function _result(uint64 seed) internal pure returns (NovaArena.MatchResult memory) {
        return NovaArena.MatchResult({
            seed: seed,
            stateHash: 0xDEADBEEF,
            teamSize: 2,
            difficulty: 0,
            durationSec: 120,
            scoreVolt: 4,
            scoreBlaze: 2,
            winner: 0,
            overtime: false
        });
    }

    function _solo(address player, uint32 points) internal pure returns (NovaArena.PlayerResult[] memory ps) {
        ps = new NovaArena.PlayerResult[](1);
        ps[0] = NovaArena.PlayerResult({player: player, team: 0, points: points, callsign: bytes16("ALICE")});
    }

    function _signPurchase(uint256 pk, uint256 id, uint256 maxPrice, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address buyer = vm.addr(pk);
        bytes32 digest = garage.purchaseDigest(buyer, id, maxPrice, garage.nonces(buyer), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signPermit(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (NovaGarage.PermitSig memory)
    {
        address owner = vm.addr(pk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nova.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", nova.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return NovaGarage.PermitSig({value: value, deadline: deadline, v: v, r: r, s: s});
    }
}
