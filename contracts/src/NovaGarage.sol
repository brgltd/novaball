// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

import {NovaArt} from "./NovaArt.sol";
import {NovaToken} from "./NovaToken.sol";

/// @title NOVABALL Garage — cosmetic NFTs bought with NOVA
/// @notice Every car body and paint beyond the starter kit (STRIKER + ARCTIC) is an ERC-1155 token, one id per
///         cosmetic. Buying one burns its NOVA price and mints the NFT to the buyer. Metadata and art are on-chain.
/// @dev Three ways to buy:
///      - {buy}: the buyer sends the transaction (needs a NOVA allowance for this contract).
///      - {buyFor}: anyone (the game's relayer) submits the buyer's EIP-712 `Purchase` signature and pays the gas.
///      - {buyForWithPermit}: same, plus an ERC-2612 permit for the price, so a fresh wallet needs no approve tx.
///      `maxPrice` protects the buyer from a price change between signing and execution.
contract NovaGarage is ERC1155, AccessControl, EIP712, Nonces {
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    bytes32 public constant PURCHASE_TYPEHASH =
        keccak256("Purchase(address buyer,uint256 itemId,uint256 maxPrice,uint256 nonce,uint256 deadline)");

    enum Kind {
        Car,
        Paint
    }

    struct Item {
        Kind kind;
        bool listed;
        /// @dev Paint body color as 0xRRGGBB (cars: the color the NFT art is drawn in).
        uint24 color;
        uint128 price;
        /// @dev Stable id the game uses: a car style id (`viper`) or a paint name (`graphite`).
        string key;
        string name;
    }

    struct PermitSig {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    string public constant name = "NOVABALL Garage";
    string public constant symbol = "NOVAGEAR";

    NovaToken public immutable nova;

    /// @notice Item ids run from 1 to `itemCount`.
    uint256 public itemCount;
    mapping(uint256 id => Item) private _items;
    mapping(bytes32 kindAndKey => uint256 id) private _idByKey;

    event ItemAdded(uint256 indexed id, Kind kind, string key, string name, uint24 color, uint256 price);
    event PriceChanged(uint256 indexed id, uint256 oldPrice, uint256 newPrice);
    event ListingChanged(uint256 indexed id, bool listed);
    event ItemPurchased(address indexed buyer, uint256 indexed id, uint256 price);

    error UnknownItem(uint256 id);
    error NotListed(uint256 id);
    error AlreadyOwned(address buyer, uint256 id);
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();
    error DuplicateKey(string key);
    error InvalidLabel(string label);
    error LengthMismatch();

    constructor(NovaToken nova_, address admin) ERC1155("") EIP712("NOVABALL Garage", "1") {
        nova = nova_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
    }

    // ------------------------------------------------------------------ catalog (curator)

    function addItem(Kind kind, string calldata key, string calldata itemName, uint24 color, uint128 price)
        external
        onlyRole(CURATOR_ROLE)
        returns (uint256 id)
    {
        // labels end up inside on-chain JSON / SVG: keep them to a safe alphabet
        if (!_isLabel(key, false)) revert InvalidLabel(key);
        if (!_isLabel(itemName, true)) revert InvalidLabel(itemName);
        bytes32 k = keccak256(abi.encode(kind, key));
        if (_idByKey[k] != 0) revert DuplicateKey(key);
        id = ++itemCount;
        _idByKey[k] = id;
        _items[id] = Item({kind: kind, listed: true, color: color, price: price, key: key, name: itemName});
        emit ItemAdded(id, kind, key, itemName, color, price);
    }

    function setPrice(uint256 id, uint128 price) public onlyRole(CURATOR_ROLE) {
        Item storage it = _item(id);
        emit PriceChanged(id, it.price, price);
        it.price = price;
    }

    function setPrices(uint256[] calldata ids, uint128[] calldata prices) external onlyRole(CURATOR_ROLE) {
        if (ids.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            setPrice(ids[i], prices[i]);
        }
    }

    function setListed(uint256 id, bool listed) external onlyRole(CURATOR_ROLE) {
        _item(id).listed = listed;
        emit ListingChanged(id, listed);
    }

    // ------------------------------------------------------------------ purchases

    function buy(uint256 id, uint256 maxPrice) external {
        _purchase(msg.sender, id, maxPrice);
    }

    function buyFor(address buyer, uint256 id, uint256 maxPrice, uint256 deadline, bytes calldata signature) external {
        _verifyPurchase(buyer, id, maxPrice, deadline, signature);
        _purchase(buyer, id, maxPrice);
    }

    function buyForWithPermit(
        address buyer,
        uint256 id,
        uint256 maxPrice,
        uint256 deadline,
        bytes calldata signature,
        PermitSig calldata permit
    ) external {
        _verifyPurchase(buyer, id, maxPrice, deadline, signature);
        // A permit that was front-run (already used) must not block the purchase: the allowance is checked by burnFrom.
        try nova.permit(buyer, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s) {} catch {}
        _purchase(buyer, id, maxPrice);
    }

    // ------------------------------------------------------------------ views

    function item(uint256 id) external view returns (Item memory) {
        return _item(id);
    }

    /// @notice The whole catalog; `items[i]` has id `i + 1`.
    function catalog() external view returns (Item[] memory items) {
        items = new Item[](itemCount);
        for (uint256 i; i < items.length; ++i) {
            items[i] = _items[i + 1];
        }
    }

    function idOf(Kind kind, string calldata key) external view returns (uint256) {
        return _idByKey[keccak256(abi.encode(kind, key))];
    }

    /// @notice `owned[i]` tells whether `account` holds item id `i + 1`.
    function inventoryOf(address account) external view returns (bool[] memory owned) {
        owned = new bool[](itemCount);
        for (uint256 i; i < owned.length; ++i) {
            owned[i] = balanceOf(account, i + 1) > 0;
        }
    }

    /// @notice The EIP-712 digest a buyer signs for {buyFor} (handy for tests and tooling).
    function purchaseDigest(address buyer, uint256 id, uint256 maxPrice, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PURCHASE_TYPEHASH, buyer, id, maxPrice, nonce, deadline)));
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function uri(uint256 id) public view override returns (string memory) {
        Item storage it = _item(id);
        return NovaArt.tokenURI(id, it.kind == Kind.Car, it.key, it.name, it.color, it.price);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ internals

    function _item(uint256 id) private view returns (Item storage it) {
        if (id == 0 || id > itemCount) revert UnknownItem(id);
        it = _items[id];
    }

    function _verifyPurchase(address buyer, uint256 id, uint256 maxPrice, uint256 deadline, bytes calldata signature)
        private
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        bytes32 digest = purchaseDigest(buyer, id, maxPrice, _useNonce(buyer), deadline);
        // EOAs and ERC-1271 smart wallets
        if (!SignatureChecker.isValidSignatureNow(buyer, digest, signature)) revert InvalidSignature();
    }

    function _purchase(address buyer, uint256 id, uint256 maxPrice) private {
        Item storage it = _item(id);
        if (!it.listed) revert NotListed(id);
        if (balanceOf(buyer, id) != 0) revert AlreadyOwned(buyer, id);
        uint256 price = it.price;
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);
        // NOVA spent in the garage leaves circulation (spends this contract's allowance)
        if (price != 0) nova.burnFrom(buyer, price);
        _mint(buyer, id, 1, "");
        emit ItemPurchased(buyer, id, price);
    }

    /// @dev Non-empty, ≤ 24 bytes of [A-Za-z0-9_-] (+ space when `spaces`).
    function _isLabel(string calldata s, bool spaces) private pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > 24) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_" || c == "-"
                || (spaces && c == " ");
            if (!ok) return false;
        }
        return true;
    }
}
