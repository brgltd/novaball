// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {BaseTest} from "./Base.t.sol";

contract NovaArenaTest is BaseTest {
    event RewardPaid(bytes32 indexed matchId, address indexed player, uint32 points, uint256 amount);

    function test_recordMatch_mintsProportionalReward() public {
        vm.prank(server);
        bytes32 id = arena.recordMatch(_result(1), _solo(alice, 312));

        assertEq(nova.balanceOf(alice), 156 ether); // 312 × 0.5
        assertTrue(arena.recorded(id));
        assertEq(arena.matchCount(), 1);
        NovaArena.PlayerRecord memory r = arena.recordOf(alice);
        assertEq(r.matches, 1);
        assertEq(r.wins, 1);
        assertEq(r.points, 312);
        assertEq(r.earned, 156 ether);
        assertEq(r.lastMatchAt, block.timestamp);
        assertEq(r.callsign, bytes16("ALICE"));
    }

    function test_recordMatch_everyHumanPaidByTheirOwnPoints() public {
        NovaArena.PlayerResult[] memory ps = new NovaArena.PlayerResult[](2);
        ps[0] = NovaArena.PlayerResult({player: alice, team: 0, points: 400, callsign: bytes16("ALICE")});
        ps[1] = NovaArena.PlayerResult({player: bob, team: 1, points: 100, callsign: bytes16("BOB")});
        vm.prank(server);
        arena.recordMatch(_result(2), ps);
        assertEq(nova.balanceOf(alice), 200 ether);
        assertEq(nova.balanceOf(bob), 50 ether);
        assertEq(arena.recordOf(alice).wins, 1);
        assertEq(arena.recordOf(bob).wins, 0, "BLAZE lost");
    }

    function test_recordMatch_drawCountsNoWin() public {
        NovaArena.MatchResult memory m = _result(3);
        m.winner = -1;
        vm.prank(server);
        arena.recordMatch(m, _solo(alice, 10));
        assertEq(arena.recordOf(alice).wins, 0);
    }

    function test_recordMatch_onlyGameServer() public {
        bytes32 role = arena.GAME_SERVER_ROLE();
        NovaArena.MatchResult memory m = _result(1);
        NovaArena.PlayerResult[] memory ps = _solo(alice, 10);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vm.prank(alice);
        arena.recordMatch(m, ps);
    }

    function test_recordMatch_rejectsDuplicates() public {
        vm.prank(server);
        bytes32 id = arena.recordMatch(_result(1), _solo(alice, 10));
        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.AlreadyRecorded.selector, id));
        vm.prank(server);
        arena.recordMatch(_result(1), _solo(alice, 10));
    }

    function test_recordMatch_capsPoints() public {
        NovaArena.MatchResult memory m = _result(1);
        NovaArena.PlayerResult[] memory ps = _solo(alice, MAX_POINTS + 1);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.PointsAboveCap.selector, alice, MAX_POINTS + 1, MAX_POINTS));
        vm.prank(server);
        arena.recordMatch(m, ps);
        vm.prank(server);
        arena.recordMatch(m, _solo(alice, MAX_POINTS));
        assertEq(nova.balanceOf(alice), uint256(MAX_POINTS) * REWARD_PER_POINT);
    }

    function test_recordMatch_cooldown() public {
        vm.prank(server);
        arena.recordMatch(_result(1), _solo(alice, 10));
        uint256 ready = block.timestamp + COOLDOWN;
        assertEq(arena.readyAt(alice), ready);

        vm.warp(ready - 1);
        NovaArena.MatchResult memory m = _result(2);
        NovaArena.PlayerResult[] memory ps = _solo(alice, 10);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.CooldownActive.selector, alice, ready));
        vm.prank(server);
        arena.recordMatch(m, ps);

        vm.warp(ready);
        assertEq(arena.readyAt(alice), 0);
        vm.prank(server);
        arena.recordMatch(m, ps);
        assertEq(arena.recordOf(alice).matches, 2);
    }

    function test_recordMatch_validatesPlayers() public {
        vm.startPrank(server);
        vm.expectRevert(NovaArena.NoPlayers.selector);
        arena.recordMatch(_result(1), new NovaArena.PlayerResult[](0));
        vm.expectRevert(NovaArena.TooManyPlayers.selector);
        arena.recordMatch(_result(1), new NovaArena.PlayerResult[](7));
        vm.expectRevert(NovaArena.ZeroAddress.selector);
        arena.recordMatch(_result(1), _solo(address(0), 1));
        vm.stopPrank();
    }

    function test_recordMatch_emptyCallsignKeepsStoredOne() public {
        vm.prank(server);
        arena.recordMatch(_result(1), _solo(alice, 10));
        NovaArena.PlayerResult[] memory ps = _solo(alice, 10);
        ps[0].callsign = bytes16(0);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(server);
        arena.recordMatch(_result(2), ps);
        assertEq(arena.recordOf(alice).callsign, bytes16("ALICE"));
    }

    function test_zeroPointsStillRecorded() public {
        vm.expectEmit(false, true, false, true, address(arena));
        emit RewardPaid(bytes32(0), alice, 0, 0);
        vm.prank(server);
        arena.recordMatch(_result(1), _solo(alice, 0));
        assertEq(arena.recordOf(alice).matches, 1);
        assertEq(nova.balanceOf(alice), 0);
    }

    function test_leaderboardPaging() public {
        address[5] memory who = [alice, bob, stranger, relayer, admin];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(server);
            arena.recordMatch(_result(uint64(100 + i)), _solo(who[i], uint32(10 * (i + 1))));
        }
        assertEq(arena.playerCount(), 5);
        (address[] memory a, NovaArena.PlayerRecord[] memory r) = arena.getPlayers(3, 10);
        assertEq(a.length, 2);
        assertEq(a[0], relayer);
        assertEq(r[1].points, 50);
        (a,) = arena.getPlayers(9, 10);
        assertEq(a.length, 0);
        // a returning player is not listed twice
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(server);
        arena.recordMatch(_result(999), _solo(alice, 1));
        assertEq(arena.playerCount(), 5);
    }

    function test_setRewardConfig() public {
        vm.prank(admin);
        arena.setRewardConfig(1 ether, 100, 0);
        assertEq(arena.rewardPerPoint(), 1 ether);
        assertEq(arena.maxPointsPerMatch(), 100);
        assertEq(arena.matchCooldown(), 0);
        assertEq(arena.previewReward(40), 40 ether);
        assertEq(arena.previewReward(400), 100 ether, "preview is capped");

        bytes32 role = arena.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, server, role));
        vm.prank(server);
        arena.setRewardConfig(0, 0, 0);
    }

    function test_earnThenBuy_endToEnd() public {
        // one good match pays for a car
        vm.prank(server);
        arena.recordMatch(_result(7), _solo(alice, 240));
        assertEq(nova.balanceOf(alice), 120 ether);

        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _signPurchase(alicePk, viperId, CAR_PRICE, deadline);
        vm.prank(relayer);
        garage.buyForWithPermit(
            alice, viperId, CAR_PRICE, deadline, sig, _signPermit(alicePk, address(garage), CAR_PRICE, deadline)
        );

        assertEq(garage.balanceOf(alice, viperId), 1);
        assertEq(nova.balanceOf(alice), 20 ether);
        assertEq(alice.balance, 0, "the player never needed gas");
    }

    function testFuzz_reward(uint32 points, uint64 rate) public {
        points = uint32(bound(points, 0, MAX_POINTS));
        vm.prank(admin);
        arena.setRewardConfig(rate, MAX_POINTS, COOLDOWN);
        vm.prank(server);
        arena.recordMatch(_result(1), _solo(alice, points));
        assertEq(nova.balanceOf(alice), uint256(points) * rate);
        assertEq(arena.recordOf(alice).earned, uint256(points) * rate);
    }
}
