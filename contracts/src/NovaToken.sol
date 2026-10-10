// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title NOVA — the NOVABALL game token
/// @notice Earned by playing matches (minted by {NovaArena}) and spent in the garage (burned by {NovaGarage}).
/// @dev The garage holds SPENDER_ROLE so a purchase is a single transaction (no approve first). It only ever spends
///      from the buyer that sends the purchase, so no one can spend a player's NOVA but the player.
contract NovaToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant SPENDER_ROLE = keccak256("SPENDER_ROLE");

    constructor(address admin) ERC20("Nova", "NOVA") ERC20Permit("Nova") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Burn `amount` of `from`'s NOVA as payment to a game contract (no allowance needed).
    function spend(address from, uint256 amount) external onlyRole(SPENDER_ROLE) {
        _burn(from, amount);
    }
}
