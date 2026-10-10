// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {NovaToken} from "./NovaToken.sol";

/// @title NOVABALL Arena — match results and NOVA rewards
/// @notice After a match, the player claims its reward: the match's seed and the deterministic simulation's final
///         state hash (anyone holding the input log can re-simulate and check it), the final score and the player's
///         match points go on-chain, the player is minted `points × rewardPerPoint` NOVA and its career record
///         (leaderboard) is updated. The player sends the transaction and pays its gas.
/// @dev Matches are simulated client-side, so the contract bounds what a single claim can mint: points are capped,
///      a match can be claimed once, and a player can claim at most once per `matchCooldown` (a real match lasts
///      ≥ 2 minutes).
contract NovaArena is AccessControl {
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
    mapping(bytes32 matchId => bool) public claimed;
    mapping(address player => PlayerRecord) private _records;
    address[] private _players;

    event MatchClaimed(
        bytes32 indexed matchId, address indexed player, MatchResult result, uint8 team, uint32 points, uint256 amount
    );
    event RewardConfigUpdated(uint256 rewardPerPoint, uint32 maxPointsPerMatch, uint32 matchCooldown);

    error InvalidTeam(uint8 team);
    error AlreadyClaimed(bytes32 matchId);
    error PointsAboveCap(uint32 points, uint32 cap);
    error CooldownActive(uint256 readyAt);

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

    // ------------------------------------------------------------------ players

    /// @notice Record a finished match and mint your reward.
    /// @param team Your team (0 VOLT, 1 BLAZE).
    /// @param points Your match points (scoreboard score).
    /// @param callsign Your pilot callsign, ASCII, left-aligned and zero-padded (0 keeps the stored one).
    function claim(MatchResult calldata result, uint8 team, uint32 points, bytes16 callsign)
        external
        returns (bytes32 matchId)
    {
        if (team > 1) revert InvalidTeam(team);
        if (points > maxPointsPerMatch) revert PointsAboveCap(points, maxPointsPerMatch);
        matchId = keccak256(abi.encode(msg.sender, result));
        if (claimed[matchId]) revert AlreadyClaimed(matchId);
        PlayerRecord storage r = _records[msg.sender];
        if (r.matches == 0) {
            _players.push(msg.sender);
        } else {
            uint256 ready = readyAt(msg.sender);
            if (ready != 0) revert CooldownActive(ready);
        }
        claimed[matchId] = true;
        ++matchCount;

        uint256 amount = uint256(points) * rewardPerPoint;
        unchecked {
            ++r.matches;
            // casting to 'int8' is safe because team is 0 or 1 (checked above)
            // forge-lint: disable-next-line(unsafe-typecast)
            if (int8(team) == result.winner) ++r.wins;
            r.points += points;
        }
        r.earned += SafeCast.toUint128(amount);
        r.lastMatchAt = uint64(block.timestamp);
        if (callsign != bytes16(0)) r.callsign = callsign;
        if (amount != 0) nova.mint(msg.sender, amount);
        emit MatchClaimed(matchId, msg.sender, result, team, points, amount);
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

    /// @notice When `player` can claim again (0 = now).
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

    function _setRewardConfig(uint256 rewardPerPoint_, uint32 maxPointsPerMatch_, uint32 matchCooldown_) private {
        rewardPerPoint = rewardPerPoint_;
        maxPointsPerMatch = maxPointsPerMatch_;
        matchCooldown = matchCooldown_;
        emit RewardConfigUpdated(rewardPerPoint_, maxPointsPerMatch_, matchCooldown_);
    }
}
