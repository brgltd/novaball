// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {NovaGarage} from "../src/NovaGarage.sol";
import {BaseTest} from "./Base.t.sol";

contract NovaGarageTest is BaseTest {
    event ItemPurchased(address indexed buyer, uint256 indexed id, uint256 price);

    // ------------------------------------------------------------------ catalog

    function test_catalog() public view {
        assertEq(garage.itemCount(), 3);
        NovaGarage.Item[] memory items = garage.catalog();
        assertEq(items.length, 3);
        assertEq(items[0].key, "viper");
        assertEq(items[0].name, "VIPER");
        assertEq(uint8(items[0].kind), uint8(NovaGarage.Kind.Car));
        assertEq(items[0].price, CAR_PRICE);
        assertTrue(items[0].listed);
        assertEq(items[2].key, "crimson");
        assertEq(items[2].color, 0xb3122e);
        assertEq(uint8(items[2].kind), uint8(NovaGarage.Kind.Paint));
        assertEq(garage.idOf(NovaGarage.Kind.Paint, "crimson"), crimsonId);
        assertEq(garage.idOf(NovaGarage.Kind.Car, "crimson"), 0);
    }

    function test_addItem_onlyCurator() public {
        bytes32 role = garage.CURATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vm.prank(stranger);
        garage.addItem(NovaGarage.Kind.Paint, "gold", "GOLD", 0xffd700, 1 ether);
    }

    function test_addItem_rejectsDuplicateKeyPerKind() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.DuplicateKey.selector, "viper"));
        garage.addItem(NovaGarage.Kind.Car, "viper", "VIPER II", 0, 1 ether);
        // same key, other kind: fine
        garage.addItem(NovaGarage.Kind.Paint, "viper", "VIPER GREEN", 0x00ff00, 1 ether);
        vm.stopPrank();
    }

    function test_addItem_rejectsUnsafeLabels() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.InvalidLabel.selector, 'x"y'));
        garage.addItem(NovaGarage.Kind.Paint, 'x"y', "OK", 0, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.InvalidLabel.selector, "<b>"));
        garage.addItem(NovaGarage.Kind.Paint, "ok", "<b>", 0, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.InvalidLabel.selector, "with space"));
        garage.addItem(NovaGarage.Kind.Paint, "with space", "OK", 0, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.InvalidLabel.selector, ""));
        garage.addItem(NovaGarage.Kind.Paint, "", "OK", 0, 1 ether);
        vm.stopPrank();
    }

    function test_setPrices() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = viperId;
        ids[1] = crimsonId;
        uint128[] memory prices = new uint128[](2);
        prices[0] = 250 ether;
        prices[1] = 5 ether;
        vm.prank(admin);
        garage.setPrices(ids, prices);
        assertEq(garage.item(viperId).price, 250 ether);
        assertEq(garage.item(crimsonId).price, 5 ether);
        assertEq(garage.item(titanId).price, CAR_PRICE);

        vm.expectRevert(NovaGarage.LengthMismatch.selector);
        vm.prank(admin);
        garage.setPrices(ids, new uint128[](1));
    }

    function test_unknownItem() public {
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.UnknownItem.selector, 0));
        garage.item(0);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.UnknownItem.selector, 99));
        garage.uri(99);
    }

    // ------------------------------------------------------------------ direct buy

    function test_buy_burnsAndMints() public {
        _mintNova(alice, 150 ether);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        vm.expectEmit(address(garage));
        emit ItemPurchased(alice, viperId, CAR_PRICE);
        garage.buy(viperId, CAR_PRICE);
        vm.stopPrank();

        assertEq(garage.balanceOf(alice, viperId), 1);
        assertEq(nova.balanceOf(alice), 50 ether);
        assertEq(nova.totalSupply(), 50 ether, "price is burned");
        bool[] memory inv = garage.inventoryOf(alice);
        assertTrue(inv[0]);
        assertFalse(inv[1]);
        assertFalse(inv[2]);
    }

    function test_buy_revertsWhenAlreadyOwned() public {
        _mintNova(alice, 300 ether);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        garage.buy(viperId, CAR_PRICE);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.AlreadyOwned.selector, alice, viperId));
        garage.buy(viperId, CAR_PRICE);
        vm.stopPrank();
    }

    function test_buy_revertsWhenUnlisted() public {
        vm.prank(admin);
        garage.setListed(titanId, false);
        _mintNova(alice, 300 ether);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.NotListed.selector, titanId));
        garage.buy(titanId, CAR_PRICE);
        vm.stopPrank();
    }

    function test_buy_respectsMaxPrice() public {
        vm.prank(admin);
        garage.setPrice(viperId, 120 ether);
        _mintNova(alice, 300 ether);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.PriceAboveMax.selector, 120 ether, CAR_PRICE));
        garage.buy(viperId, CAR_PRICE);
        vm.stopPrank();
    }

    function test_buy_revertsWithoutFunds() public {
        _mintNova(alice, 10 ether);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10 ether, PAINT_PRICE)
        );
        garage.buy(crimsonId, PAINT_PRICE);
        vm.stopPrank();
    }

    function test_buy_revertsWithoutAllowance() public {
        _mintNova(alice, 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(garage), 0, PAINT_PRICE)
        );
        vm.prank(alice);
        garage.buy(crimsonId, PAINT_PRICE);
    }

    function test_buy_freeItemNeedsNoNova() public {
        vm.prank(admin);
        garage.setPrice(crimsonId, 0);
        vm.prank(bob);
        garage.buy(crimsonId, 0);
        assertEq(garage.balanceOf(bob, crimsonId), 1);
    }

    // ------------------------------------------------------------------ gasless buy (relayer)

    function test_buyFor_withSignature() public {
        _mintNova(alice, 100 ether);
        vm.prank(alice);
        nova.approve(address(garage), type(uint256).max);

        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _signPurchase(alicePk, crimsonId, PAINT_PRICE, deadline);
        vm.prank(relayer);
        garage.buyFor(alice, crimsonId, PAINT_PRICE, deadline, sig);

        assertEq(garage.balanceOf(alice, crimsonId), 1);
        assertEq(garage.balanceOf(relayer, crimsonId), 0);
        assertEq(nova.balanceOf(alice), 80 ether);
        assertEq(garage.nonces(alice), 1);
    }

    function test_buyFor_signatureCannotBeReplayed() public {
        _mintNova(alice, 500 ether);
        vm.prank(alice);
        nova.approve(address(garage), type(uint256).max);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _signPurchase(alicePk, viperId, CAR_PRICE, deadline);
        vm.prank(relayer);
        garage.buyFor(alice, viperId, CAR_PRICE, deadline, sig);
        // nonce moved on: the same signature no longer matches
        vm.expectRevert(NovaGarage.InvalidSignature.selector);
        vm.prank(relayer);
        garage.buyFor(alice, viperId, CAR_PRICE, deadline, sig);
    }

    function test_buyFor_signatureBindsItemAndPrice() public {
        _mintNova(alice, 500 ether);
        vm.prank(alice);
        nova.approve(address(garage), type(uint256).max);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _signPurchase(alicePk, viperId, CAR_PRICE, deadline);

        vm.startPrank(relayer);
        vm.expectRevert(NovaGarage.InvalidSignature.selector);
        garage.buyFor(alice, titanId, CAR_PRICE, deadline, sig); // other item
        vm.expectRevert(NovaGarage.InvalidSignature.selector);
        garage.buyFor(alice, viperId, CAR_PRICE + 1, deadline, sig); // other max price
        vm.expectRevert(NovaGarage.InvalidSignature.selector);
        garage.buyFor(bob, viperId, CAR_PRICE, deadline, sig); // other buyer
        vm.stopPrank();
    }

    function test_buyFor_rejectsExpired() public {
        uint256 deadline = block.timestamp + 1;
        bytes memory sig = _signPurchase(alicePk, crimsonId, PAINT_PRICE, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(NovaGarage.SignatureExpired.selector, deadline));
        garage.buyFor(alice, crimsonId, PAINT_PRICE, deadline, sig);
    }

    function test_buyFor_rejectsForeignSigner() public {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest = garage.purchaseDigest(alice, crimsonId, PAINT_PRICE, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, digest);
        vm.expectRevert(NovaGarage.InvalidSignature.selector);
        garage.buyFor(alice, crimsonId, PAINT_PRICE, deadline, abi.encodePacked(r, s, v));
    }

    function test_buyForWithPermit_freshWalletNoApproveTx() public {
        _mintNova(alice, 120 ether);
        uint256 deadline = block.timestamp + 10 minutes;
        NovaGarage.PermitSig memory permit = _signPermit(alicePk, address(garage), CAR_PRICE, deadline);
        bytes memory sig = _signPurchase(alicePk, viperId, CAR_PRICE, deadline);

        vm.prank(relayer);
        garage.buyForWithPermit(alice, viperId, CAR_PRICE, deadline, sig, permit);

        assertEq(garage.balanceOf(alice, viperId), 1);
        assertEq(nova.balanceOf(alice), 20 ether);
        assertEq(nova.allowance(alice, address(garage)), 0);
    }

    function test_buyForWithPermit_survivesFrontRunPermit() public {
        _mintNova(alice, 120 ether);
        uint256 deadline = block.timestamp + 10 minutes;
        NovaGarage.PermitSig memory permit = _signPermit(alicePk, address(garage), CAR_PRICE, deadline);
        bytes memory sig = _signPurchase(alicePk, viperId, CAR_PRICE, deadline);
        // someone burns the permit first
        vm.prank(stranger);
        nova.permit(alice, address(garage), permit.value, permit.deadline, permit.v, permit.r, permit.s);

        vm.prank(relayer);
        garage.buyForWithPermit(alice, viperId, CAR_PRICE, deadline, sig, permit);
        assertEq(garage.balanceOf(alice, viperId), 1);
    }

    // ------------------------------------------------------------------ metadata

    function test_uri_isOnChainJson() public view {
        string memory uri = garage.uri(crimsonId);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory u = bytes(uri);
        for (uint256 i; i < prefix.length; ++i) {
            assertEq(u[i], prefix[i]);
        }
        // spot-check the decoded payload
        string memory json = string(_decodeTail(u, prefix.length));
        assertTrue(_contains(json, '"name":"CRIMSON paint"'));
        assertTrue(_contains(json, '"value":"#b3122e"'));
        assertTrue(_contains(json, '"value":"20"'));
        assertTrue(_contains(json, "data:image/svg+xml;base64,"));
        assertTrue(_contains(garage.uri(viperId), "data:application/json;base64,"));
    }

    function test_nameAndInterfaces() public view {
        assertEq(garage.name(), "NOVABALL Garage");
        assertEq(garage.symbol(), "NOVAGEAR");
        assertTrue(garage.supportsInterface(0xd9b67a26)); // ERC-1155
        assertTrue(garage.supportsInterface(0x0e89341c)); // ERC-1155 metadata URI
        assertTrue(garage.supportsInterface(0x7965db0b)); // AccessControl
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_buy_chargesExactPrice(uint128 price, uint128 extra) public {
        price = uint128(bound(price, 0, 1e30));
        extra = uint128(bound(extra, 0, 1e30));
        vm.prank(admin);
        garage.setPrice(titanId, price);
        _mintNova(alice, uint256(price) + extra);
        vm.startPrank(alice);
        nova.approve(address(garage), type(uint256).max);
        garage.buy(titanId, price);
        vm.stopPrank();
        assertEq(nova.balanceOf(alice), extra);
        assertEq(garage.balanceOf(alice, titanId), 1);
    }

    // ------------------------------------------------------------------ utils

    function _decodeTail(bytes memory data, uint256 from) private pure returns (bytes memory) {
        bytes memory tail = new bytes(data.length - from);
        for (uint256 i; i < tail.length; ++i) {
            tail[i] = data[from + i];
        }
        return _b64decode(string(tail));
    }

    function _contains(string memory hay, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _b64decode(string memory s) private pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        bytes memory table = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
        uint8[256] memory rev;
        for (uint8 i; i < 64; ++i) {
            rev[uint8(table[i])] = i;
        }
        uint256 pad = b.length > 0 && b[b.length - 1] == "=" ? (b[b.length - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((b.length / 4) * 3 - pad);
        uint256 o;
        for (uint256 i; i < b.length; i += 4) {
            uint256 n = (uint256(rev[uint8(b[i])]) << 18) | (uint256(rev[uint8(b[i + 1])]) << 12)
                | (uint256(rev[uint8(b[i + 2])]) << 6) | uint256(rev[uint8(b[i + 3])]);
            for (uint256 k; k < 3 && o < out.length; ++k) {
                out[o++] = bytes1(uint8(n >> (16 - 8 * k)));
            }
        }
    }
}
