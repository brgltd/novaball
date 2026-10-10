// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {NovaToken} from "./NovaToken.sol";

/// @title NOVABALL Arena — match results and NOVA rewards
/// @notice The game server records each finished match: its seed and the deterministic simulation's final state hash
///         (anyone holding the input log can re-simulate and check it), the final score, and every human player's
///         match points. Each player is minted `points × rewardPerPoint` NOVA and gets a career record (leaderboard).
/// @dev Matches are simulated client-side, so the contract bounds what a single report can mint: points per player
///      are capped and a player can be rewarded at most once per `matchCooldown` (a real match lasts ≥ 2 minutes).
contract NovaArena is AccessControl {
    bytes32 public constant GAME_SERVER_ROLE = keccak256("GAME_SERVER_ROLE");
    uint256 public constant MAX_PLAYERS = 6;

    struct MatchResult {
        uint64 seed;
        uint32 stateHash;
        uint8 teamSize;
        /// @dev 0 rookie, 1 pro, 2 legend
        uint8 difficulty;
        uint16 durationSec;
        uint16 scoreVolt;
        uint16 scoreBlaze;
        /// @dev 0 VOLT, 1 BLAZE, -1 draw
        int8 winner;
        bool overtime;
    }

    struct PlayerResult {
        address player;
        uint8 team;
        uint32 points;
        /// @dev Pilot callsign, ASCII, left-aligned and zero-padded (0 keeps the stored one).
        bytes16 callsign;
    }

    struct PlayerRecord {
        uint32 matches;
        uint32 wins;
        uint64 points;
        uint64 lastMatchAt;
        uint128 earned;
        bytes16 callsign;
    }

    NovaToken public immutable nova;

    /// @notice NOVA (18 decimals) minted per match point.
    uint256 public rewardPerPoint;
    uint32 public maxPointsPerMatch;
    uint32 public matchCooldown;

    uint256 public matchCount;
    mapping(bytes32 matchId => bool) public recorded;
    mapping(address player => PlayerRecord) private _records;
    address[] private _players;

    event MatchRecorded(
        bytes32 indexed matchId,
        uint64 seed,
        uint32 stateHash,
        uint8 teamSize,
        uint8 difficulty,
        uint16 durationSec,
        uint16 scoreVolt,
        uint16 scoreBlaze,
        int8 winner
    );
    event RewardPaid(bytes32 indexed matchId, address indexed player, uint32 points, uint256 amount);
    event RewardConfigUpdated(uint256 rewardPerPoint, uint32 maxPointsPerMatch, uint32 matchCooldown);

    error NoPlayers();
    error TooManyPlayers();
    error ZeroAddress();
    error AlreadyRecorded(bytes32 matchId);
    error PointsAboveCap(address player, uint32 points, uint32 cap);
    error CooldownActive(address player, uint256 readyAt);

    constructor(
        NovaToken nova_,
        address admin,
        uint256 rewardPerPoint_,
        uint32 maxPointsPerMatch_,
        uint32 matchCooldown_
    ) {
        nova = nova_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setRewardConfig(rewardPerPoint_, maxPointsPerMatch_, matchCooldown_);
    }

    // ------------------------------------------------------------------ game server

    function recordMatch(MatchResult calldata result, PlayerResult[] calldata players)
        external
        onlyRole(GAME_SERVER_ROLE)
        returns (bytes32 matchId)
    {
        if (players.length == 0) revert NoPlayers();
        if (players.length > MAX_PLAYERS) revert TooManyPlayers();
        matchId = keccak256(abi.encode(result, players));
        if (recorded[matchId]) revert AlreadyRecorded(matchId);
        recorded[matchId] = true;
        ++matchCount;
        emit MatchRecorded(
            matchId,
            result.seed,
            result.stateHash,
            result.teamSize,
            result.difficulty,
            result.durationSec,
            result.scoreVolt,
            result.scoreBlaze,
            result.winner
        );
        for (uint256 i; i < players.length; ++i) {
            _reward(matchId, result.winner, players[i]);
        }
    }

    // ------------------------------------------------------------------ admin

    function setRewardConfig(uint256 rewardPerPoint_, uint32 maxPointsPerMatch_, uint32 matchCooldown_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setRewardConfig(rewardPerPoint_, maxPointsPerMatch_, matchCooldown_);
    }

    // ------------------------------------------------------------------ views

    function recordOf(address player) external view returns (PlayerRecord memory) {
        return _records[player];
    }

    function previewReward(uint32 points) external view returns (uint256) {
        return uint256(points > maxPointsPerMatch ? maxPointsPerMatch : points) * rewardPerPoint;
    }

    /// @notice When `player` can be rewarded again (0 = now).
    function readyAt(address player) public view returns (uint256) {
        PlayerRecord storage r = _records[player];
        if (r.matches == 0) return 0;
        uint256 t = uint256(r.lastMatchAt) + matchCooldown;
        return t > block.timestamp ? t : 0;
    }

    function playerCount() external view returns (uint256) {
        return _players.length;
    }

    /// @notice Page through every player that has a record (for the leaderboard).
    function getPlayers(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory addrs, PlayerRecord[] memory recs)
    {
        uint256 n = _players.length;
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        addrs = new address[](len);
        recs = new PlayerRecord[](len);
        for (uint256 i; i < len; ++i) {
            addrs[i] = _players[offset + i];
            recs[i] = _records[addrs[i]];
        }
    }

    // ------------------------------------------------------------------ internals

    function _reward(bytes32 matchId, int8 winner, PlayerResult calldata p) private {
        if (p.player == address(0)) revert ZeroAddress();
        if (p.points > maxPointsPerMatch) revert PointsAboveCap(p.player, p.points, maxPointsPerMatch);
        PlayerRecord storage r = _records[p.player];
        if (r.matches == 0) {
            _players.push(p.player);
        } else {
            uint256 ready = readyAt(p.player);
            if (ready != 0) revert CooldownActive(p.player, ready);
        }
        uint256 amount = uint256(p.points) * rewardPerPoint;
        unchecked {
            ++r.matches;
            if (int8(p.team) == winner) ++r.wins;
            r.points += p.points;
        }
        r.earned += SafeCast.toUint128(amount);
        r.lastMatchAt = uint64(block.timestamp);
        if (p.callsign != bytes16(0)) r.callsign = p.callsign;
        if (amount != 0) nova.mint(p.player, amount);
        emit RewardPaid(matchId, p.player, p.points, amount);
    }

    function _setRewardConfig(uint256 rewardPerPoint_, uint32 maxPointsPerMatch_, uint32 matchCooldown_) private {
        rewardPerPoint = rewardPerPoint_;
        maxPointsPerMatch = maxPointsPerMatch_;
        matchCooldown = matchCooldown_;
        emit RewardConfigUpdated(rewardPerPoint_, maxPointsPerMatch_, matchCooldown_);
    }
}
