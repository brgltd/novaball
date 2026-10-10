// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title NovaArt — fully on-chain metadata + SVG art for garage NFTs
/// @dev Labels are validated by the garage ([A-Za-z0-9 _-]), so they are safe to embed in JSON and SVG as-is.
library NovaArt {
    using Strings for uint256;

    string private constant CHROME = "b9c3cf";
    string private constant VOLT = "1ec8ff";

    function tokenURI(uint256 id, bool isCar, string memory key, string memory label, uint24 color, uint256 price)
        internal
        pure
        returns (string memory)
    {
        string memory hex6 = _hex6(color);
        string memory image = Base64.encode(bytes(_svg(isCar, key, label, isCar ? CHROME : hex6, hex6)));
        string memory head = string.concat(
            '{"name":"',
            label,
            isCar ? "" : " paint",
            '","description":"NOVABALL cosmetic NFT. ',
            isCar
                ? "Unlocks this hover-car body in the garage."
                : "Unlocks this body paint in the garage for every car you own.",
            ' Bought with NOVA earned on the pitch.","image":"data:image/svg+xml;base64,',
            image
        );
        string memory json = string.concat(head, '","attributes":', _attributes(id, isCar, key, hex6, price), "}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _attributes(uint256 id, bool isCar, string memory key, string memory hex6, uint256 price)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '[{"trait_type":"Type","value":"',
            isCar ? "Car body" : "Paint",
            '"},{"trait_type":"Key","value":"',
            key,
            '"},{"trait_type":"Color","value":"#',
            hex6,
            '"},{"trait_type":"Price (NOVA)","value":"',
            _amount(price),
            '"},{"display_type":"number","trait_type":"Item","value":',
            id.toString(),
            "}]"
        );
    }

    function _svg(bool isCar, string memory key, string memory label, string memory body, string memory hex6)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="Orbitron,Verdana,sans-serif">',
            '<defs><radialGradient id="bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#16244a"/>',
            '<stop offset="1" stop-color="#03050b"/></radialGradient>',
            '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>',
            '<linearGradient id="paint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".35"/>',
            '<stop offset=".45" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>',
            '<rect width="400" height="400" fill="url(#bg)"/>',
            '<path d="M0 300H400M0 330H400M0 365H400M200 280L40 400M200 280L360 400M200 280V400" stroke="#1b2a44"/>',
            '<rect x="14" y="14" width="372" height="372" rx="18" fill="none" stroke="#',
            VOLT,
            '" stroke-opacity=".55" stroke-width="2"/>',
            '<text x="34" y="52" fill="#8be9ff" font-size="13" letter-spacing="4">NOVABALL GARAGE</text>',
            _car(key, body),
            '<text x="34" y="338" fill="#ffffff" font-size="34" font-weight="900" letter-spacing="2">',
            label,
            "</text>",
            '<text x="34" y="364" fill="#8be9ff" font-size="12" letter-spacing="3">',
            isCar ? "CAR BODY" : string.concat("PAINT #", hex6),
            "</text></svg>"
        );
    }

    /// @dev A side-view hover car: silhouette by style, painted `body`, glowing VOLT trims and hover pads.
    function _car(string memory key, string memory body) private pure returns (string memory) {
        bytes32 k = keccak256(bytes(key));
        string memory hull;
        string memory canopy;
        if (k == keccak256("viper")) {
            hull = "M44 238L86 214L176 202L222 182L292 180L340 204L362 228L356 240Z";
            canopy = "M190 202L226 186L284 185L310 202Z";
        } else if (k == keccak256("titan")) {
            hull = "M62 240L70 200L120 186L170 150L276 148L320 182L344 196L346 240Z";
            canopy = "M178 186L192 158L268 157L300 186Z";
        } else {
            hull = "M56 238L90 206L168 192L214 166L286 164L330 192L350 214L346 238Z";
            canopy = "M180 192L220 172L278 171L304 192Z";
        }
        return string.concat(
            '<ellipse cx="205" cy="268" rx="140" ry="9" fill="#',
            VOLT,
            '" opacity=".55" filter="url(#glow)"/>',
            '<g><path d="',
            hull,
            '" fill="#',
            body,
            '"/><path d="',
            hull,
            '" fill="url(#paint)" stroke="#000" stroke-opacity=".35"/>',
            '<path d="',
            canopy,
            '" fill="#0a1428" opacity=".85"/>',
            '<path d="M70 230H344" stroke="#',
            VOLT,
            '" stroke-width="3"/>',
            '<ellipse cx="112" cy="246" rx="22" ry="5" fill="#',
            VOLT,
            '"/><ellipse cx="300" cy="246" rx="22" ry="5" fill="#',
            VOLT,
            '"/></g>'
        );
    }

    function _hex6(uint24 color) private pure returns (string memory) {
        bytes memory out = new bytes(6);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < 6; ++i) {
            out[5 - i] = digits[(color >> (4 * i)) & 0xf];
        }
        return string(out);
    }

    /// @dev 18-decimals amount → "100" / "12.5" (up to 2 decimals, truncated).
    function _amount(uint256 wei_) private pure returns (string memory) {
        uint256 whole = wei_ / 1e18;
        uint256 cents = (wei_ % 1e18) / 1e16;
        if (cents == 0) return whole.toString();
        return
            string.concat(
                whole.toString(), ".", cents < 10 ? "0" : "", (cents % 10 == 0 ? cents / 10 : cents).toString()
            );
    }
}
