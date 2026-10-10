// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "./Base.t.sol";

contract NovaTokenTest is BaseTest {
    function test_metadata() public view {
        assertEq(nova.name(), "Nova");
        assertEq(nova.symbol(), "NOVA");
        assertEq(nova.decimals(), 18);
        assertEq(nova.totalSupply(), 0);
    }

    function test_mint_onlyMinter() public {
        bytes32 role = nova.MINTER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        nova.mint(stranger, 1 ether);

        vm.prank(address(arena));
        nova.mint(alice, 5 ether);
        assertEq(nova.balanceOf(alice), 5 ether);
    }

    function test_permit_setsAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, bob, 7 ether, deadline);
        vm.prank(stranger); // anyone can submit a permit
        nova.permit(alice, bob, 7 ether, deadline, v, r, s);
        assertEq(nova.allowance(alice, bob), 7 ether);
        assertEq(nova.nonces(alice), 1);
    }

    function test_burn_byHolder() public {
        _mintNova(alice, 10 ether);
        vm.prank(alice);
        nova.burn(4 ether);
        assertEq(nova.balanceOf(alice), 6 ether);
        assertEq(nova.totalSupply(), 6 ether);
    }

    function test_spend_onlySpender() public {
        _mintNova(alice, 10 ether);
        bytes32 role = nova.SPENDER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        nova.spend(alice, 1 ether);

        vm.prank(address(garage));
        nova.spend(alice, 4 ether);
        assertEq(nova.balanceOf(alice), 6 ether);
        assertEq(nova.totalSupply(), 6 ether);
    }
}
