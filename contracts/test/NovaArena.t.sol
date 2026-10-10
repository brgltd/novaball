// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {NovaArena} from "../src/NovaArena.sol";
import {BaseTest} from "./Base.t.sol";

contract NovaArenaTest is BaseTest {
    event MatchClaimed(
        bytes32 indexed matchId,
        address indexed player,
        NovaArena.MatchResult result,
        uint8 team,
        uint32 points,
        uint256 amount
    );

    function test_claim_mintsProportionalReward() public {
        bytes32 id = _claim(alice, 1, 312);

        assertEq(nova.balanceOf(alice), 156 ether); // 312 × 0.5
        assertTrue(arena.claimed(id));
        assertEq(arena.matchCount(), 1);
        NovaArena.PlayerRecord memory r = arena.recordOf(alice);
        assertEq(r.matches, 1);
        assertEq(r.wins, 1);
        assertEq(r.points, 312);
        assertEq(r.earned, 156 ether);
        assertEq(r.lastMatchAt, block.timestamp);
        assertEq(r.callsign, bytes16("ALICE"));
    }

    function test_claim_emitsTheMatch() public {
        NovaArena.MatchResult memory m = _result(42);
        bytes32 id = keccak256(abi.encode(alice, m));
        vm.expectEmit(address(arena));
        emit MatchClaimed(id, alice, m, 0, 10, 5 ether);
        vm.prank(alice);
        assertEq(arena.claim(m, 0, 10, bytes16("ALICE")), id);
    }

    function test_claim_lossAndDrawCountNoWin() public {
        vm.prank(alice);
        arena.claim(_result(1), 1, 10, bytes16("ALICE")); // VOLT won, alice was BLAZE
        NovaArena.MatchResult memory m = _result(2);
        m.winner = -1;
        vm.prank(bob);
        arena.claim(m, 0, 10, bytes16("BOB"));
        assertEq(arena.recordOf(alice).wins, 0);
        assertEq(arena.recordOf(bob).wins, 0);
    }

    function test_claim_rejectsDuplicates() public {
        bytes32 id = _claim(alice, 1, 10);
        vm.warp(block.timestamp + COOLDOWN);
        NovaArena.MatchResult memory m = _result(1);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.AlreadyClaimed.selector, id));
        vm.prank(alice);
        arena.claim(m, 0, 999, bytes16(0)); // other points, same match
    }

    function test_claim_sameMatchByAnotherPlayerIsTheirs() public {
        _claim(alice, 1, 10);
        _claim(bob, 1, 10);
        assertEq(nova.balanceOf(bob), 5 ether);
    }

    function test_claim_capsPoints() public {
        NovaArena.MatchResult memory m = _result(1);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.PointsAboveCap.selector, MAX_POINTS + 1, MAX_POINTS));
        vm.prank(alice);
        arena.claim(m, 0, MAX_POINTS + 1, bytes16(0));
        _claim(alice, 1, MAX_POINTS);
        assertEq(nova.balanceOf(alice), uint256(MAX_POINTS) * REWARD_PER_POINT);
    }

    function test_claim_cooldown() public {
        _claim(alice, 1, 10);
        uint256 ready = block.timestamp + COOLDOWN;
        assertEq(arena.readyAt(alice), ready);

        vm.warp(ready - 1);
        NovaArena.MatchResult memory m = _result(2);
        vm.expectRevert(abi.encodeWithSelector(NovaArena.CooldownActive.selector, ready));
        vm.prank(alice);
        arena.claim(m, 0, 10, bytes16(0));
        _claim(bob, 2, 10); // other players are not affected

        vm.warp(ready);
        assertEq(arena.readyAt(alice), 0);
        _claim(alice, 2, 10);
        assertEq(arena.recordOf(alice).matches, 2);
    }

    function test_claim_rejectsInvalidTeam() public {
        // team 255 would read as int8(-1) and count as a "win" on a draw
        NovaArena.MatchResult memory m = _result(1);
        m.winner = -1;
        vm.expectRevert(abi.encodeWithSelector(NovaArena.InvalidTeam.selector, 255));
        vm.prank(alice);
        arena.claim(m, 255, 10, bytes16(0));
    }

    function test_claim_emptyCallsignKeepsStoredOne() public {
        _claim(alice, 1, 10);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        arena.claim(_result(2), 0, 10, bytes16(0));
        assertEq(arena.recordOf(alice).callsign, bytes16("ALICE"));
    }

    function test_zeroPointsStillRecorded() public {
        _claim(alice, 1, 0);
        assertEq(arena.recordOf(alice).matches, 1);
        assertEq(nova.balanceOf(alice), 0);
    }

    function test_leaderboardPaging() public {
        address[5] memory who = [alice, bob, carol, stranger, admin];
        for (uint256 i; i < who.length; ++i) {
            _claim(who[i], uint64(100 + i), uint32(10 * (i + 1)));
        }
        assertEq(arena.playerCount(), 5);
        (address[] memory a, NovaArena.PlayerRecord[] memory r) = arena.getPlayers(3, 10);
        assertEq(a.length, 2);
        assertEq(a[0], stranger);
        assertEq(r[1].points, 50);
        (a,) = arena.getPlayers(9, 10);
        assertEq(a.length, 0);
        // a returning player is not listed twice
        vm.warp(block.timestamp + COOLDOWN);
        _claim(alice, 999, 1);
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
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vm.prank(alice);
        arena.setRewardConfig(0, 0, 0);
    }

    function test_earnThenBuy_endToEnd() public {
        // one good match pays for a car: claim, then buy, two transactions and no approve
        _claim(alice, 7, 240);
        assertEq(nova.balanceOf(alice), 120 ether);

        vm.prank(alice);
        garage.buy(viperId, CAR_PRICE);

        assertEq(garage.balanceOf(alice, viperId), 1);
        assertEq(nova.balanceOf(alice), 20 ether);
    }

    function testFuzz_reward(uint32 points, uint64 rate) public {
        points = uint32(bound(points, 0, MAX_POINTS));
        vm.prank(admin);
        arena.setRewardConfig(rate, MAX_POINTS, COOLDOWN);
        _claim(alice, 1, points);
        assertEq(nova.balanceOf(alice), uint256(points) * rate);
        assertEq(arena.recordOf(alice).earned, uint256(points) * rate);
    }
}
