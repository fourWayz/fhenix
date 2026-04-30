// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./CreditScoreRegistry.sol";

/**
 * @title CreditTierNFT
 * @notice Soul-bound ERC-721 that encodes an on-chain credit tier (Gold / Silver / Bronze).
 *
 * Tier is derived from the already-revealed personal interest rate in CreditScoreRegistry:
 *   Gold   — rate ≤ 10.33 % (score ≥ ~9 000)
 *   Silver — rate ≤ 13.83 % (score ≥ ~7 500)
 *   Bronze — rate <  15.00 % (score ≥  7 000 — any credit-approved borrower)
 *
 * Because the rate is computed by FHE from encrypted inputs, the NFT proves credit
 * quality without ever revealing the underlying score or financial signals.
 *
 * Soul-bound: transfers are blocked — the NFT is identity-bound to the minter.
 *
 * Cross-protocol integration:
 *   Any protocol can call balanceOf(borrower) > 0 or getTier(borrower) to gate access
 *   without any direct CoFHE dependency.
 */
contract CreditTierNFT {

    CreditScoreRegistry public immutable registry;

    // ─── Tier thresholds (basis points) ──────────────────────────────────────
    // Derived from rate formula: rateBps = (45000 - (score-7000)*7) / 30
    //   score=9000 → rate = 1033 bps   score=7500 → rate = 1383 bps
    uint32 public constant GOLD_RATE_CEIL   = 1_033;  // ≤10.33% → Gold
    uint32 public constant SILVER_RATE_CEIL = 1_383;  // ≤13.83% → Silver
    uint32 public constant BASE_RATE_BPS    = 1_500;  // 15.00%  → no credit discount

    enum Tier { None, Bronze, Silver, Gold }

    // ─── ERC-721 storage ─────────────────────────────────────────────────────

    string public name   = "CipherCredit Tier";
    string public symbol = "CCT";

    // tokenId = uint256(uint160(holderAddress)) — one token per wallet
    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;

    // ─── Tier storage ─────────────────────────────────────────────────────────

    mapping(address => Tier) public tiers;
    mapping(address => bool) public hasMinted;
    uint256 public totalMinted;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event TierMinted(address indexed holder, Tier tier, uint256 tokenId);
    event TierUpdated(address indexed holder, Tier oldTier, Tier newTier);

    constructor(address _registry) {
        registry = CreditScoreRegistry(_registry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Minting / updating
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Mint your Credit Tier NFT (or update tier if already minted).
     *         Requires the personal rate to have been revealed via the full CoFHE flow.
     */
    function mintOrUpdateTier() external {
        Tier newTier = _computeTier(msg.sender);
        require(newTier != Tier.None, "CreditTierNFT: score too low or rate not revealed");

        uint256 tokenId = uint256(uint160(msg.sender));

        if (!hasMinted[msg.sender]) {
            _owner[tokenId]           = msg.sender;
            _balance[msg.sender]      = 1;
            hasMinted[msg.sender]     = true;
            tiers[msg.sender]         = newTier;
            totalMinted++;
            emit Transfer(address(0), msg.sender, tokenId);
            emit TierMinted(msg.sender, newTier, tokenId);
        } else {
            Tier oldTier          = tiers[msg.sender];
            tiers[msg.sender]     = newTier;
            emit TierUpdated(msg.sender, oldTier, newTier);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ERC-721 interface (read-only — no transfer)
    // ─────────────────────────────────────────────────────────────────────────

    function balanceOf(address holder) external view returns (uint256) {
        return _balance[holder];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owner[tokenId];
        require(o != address(0), "CreditTierNFT: token does not exist");
        return o;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address holder = _owner[tokenId];
        require(holder != address(0), "CreditTierNFT: token does not exist");
        return _buildMetadata(holder);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd // ERC721
            || interfaceId == 0x5b5e139f // ERC721Metadata
            || interfaceId == 0x01ffc9a7; // ERC165
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Soul-bound: block all transfers
    // ─────────────────────────────────────────────────────────────────────────

    function transferFrom(address, address, uint256) external pure {
        revert("CreditTierNFT: soul-bound - non-transferable");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("CreditTierNFT: soul-bound - non-transferable");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("CreditTierNFT: soul-bound - non-transferable");
    }

    function approve(address, uint256) external pure {
        revert("CreditTierNFT: soul-bound - non-transferable");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("CreditTierNFT: soul-bound - non-transferable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Tier helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getTier(address holder) external view returns (Tier) {
        return tiers[holder];
    }

    function getTierName(address holder) external view returns (string memory) {
        return _tierName(tiers[holder]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _computeTier(address borrower) internal view returns (Tier) {
        if (!registry.isRateRevealed(borrower)) return Tier.None;
        uint32 rate = registry.getRevealedRate(borrower);
        // rate == BASE_RATE_BPS means no discount was applied (not credit-approved)
        if (rate >= BASE_RATE_BPS)    return Tier.None;
        if (rate <= GOLD_RATE_CEIL)   return Tier.Gold;
        if (rate <= SILVER_RATE_CEIL) return Tier.Silver;
        return Tier.Bronze;
    }

    function _tierName(Tier t) internal pure returns (string memory) {
        if (t == Tier.Gold)   return "Gold";
        if (t == Tier.Silver) return "Silver";
        if (t == Tier.Bronze) return "Bronze";
        return "None";
    }

    function _tierColor(Tier t) internal pure returns (string memory) {
        if (t == Tier.Gold)   return "#F59E0B";
        if (t == Tier.Silver) return "#94A3B8";
        return "#B45309"; // Bronze
    }

    /**
     * @dev On-chain SVG metadata — no IPFS, no external dependency.
     *      Returns a data URI JSON containing an inline SVG image.
     */
    function _buildMetadata(address holder) internal view returns (string memory) {
        Tier t          = tiers[holder];
        string memory n = _tierName(t);
        string memory c = _tierColor(t);
        string memory a = _addressToShortHex(holder);

        string memory svg = string(abi.encodePacked(
            '<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"400\\" height=\\"400\\" viewBox=\\"0 0 400 400\\">',
            '<defs>',
              '<radialGradient id=\\"g\\" cx=\\"50%\\" cy=\\"40%\\" r=\\"60%\\">',
                '<stop offset=\\"0%\\" stop-color=\\"', c, '\\" stop-opacity=\\"0.25\\"/>',
                '<stop offset=\\"100%\\" stop-color=\\"#0f0f1a\\" stop-opacity=\\"1\\"/>',
              '</radialGradient>',
            '</defs>',
            '<rect width=\\"400\\" height=\\"400\\" fill=\\"#0f0f1a\\" rx=\\"16\\"/>',
            '<rect width=\\"400\\" height=\\"400\\" fill=\\"url(#g)\\" rx=\\"16\\"/>',
            '<circle cx=\\"200\\" cy=\\"155\\" r=\\"88\\" fill=\\"none\\" stroke=\\"', c, '\\" stroke-width=\\"1.5\\" opacity=\\"0.4\\"/>',
            '<circle cx=\\"200\\" cy=\\"155\\" r=\\"68\\" fill=\\"none\\" stroke=\\"', c, '\\" stroke-width=\\"2\\"/>',
            '<text x=\\"200\\" y=\\"174\\" font-family=\\"monospace\\" font-size=\\"30\\" font-weight=\\"bold\\" fill=\\"', c, '\\" text-anchor=\\"middle\\">', n, '</text>',
            '<text x=\\"200\\" y=\\"272\\" font-family=\\"monospace\\" font-size=\\"18\\" fill=\\"#ffffff\\" text-anchor=\\"middle\\" letter-spacing=\\"2\\">CipherCredit</text>',
            '<text x=\\"200\\" y=\\"300\\" font-family=\\"monospace\\" font-size=\\"10\\" fill=\\"#ffffff55\\" text-anchor=\\"middle\\">Privacy-first on-chain credit</text>',
            '<rect x=\\"130\\" y=\\"330\\" width=\\"140\\" height=\\"22\\" rx=\\"11\\" fill=\\"', c, '\\" opacity=\\"0.12\\"/>',
            '<text x=\\"200\\" y=\\"346\\" font-family=\\"monospace\\" font-size=\\"9\\" fill=\\"', c, '\\" text-anchor=\\"middle\\">SOUL-BOUND  |  ', a, '</text>',
            '</svg>'
        ));

        return string(abi.encodePacked(
            'data:application/json;charset=utf-8,',
            '{"name":"CipherCredit ', n, '",',
            '"description":"Soul-bound on-chain credit tier. Score never revealed - computed privately by FHE.",',
            '"image":"data:image/svg+xml;charset=utf-8,', svg, '",',
            '"attributes":[',
              '{"trait_type":"Tier","value":"', n, '"},',
              '{"trait_type":"Soul-Bound","value":"true"},',
              '{"trait_type":"Protocol","value":"CipherCredit"}',
            ']}'
        ));
    }

    function _addressToShortHex(address addr) internal pure returns (string memory) {
        bytes memory hex_ = "0123456789abcdef";
        bytes20 v = bytes20(addr);
        // Return 0x1234…5678 (first 4 + last 4 bytes)
        bytes memory s = new bytes(13); // "0x" + 4 + "…" + 4
        s[0] = '0'; s[1] = 'x';
        for (uint i = 0; i < 4; i++) {
            s[2 + i * 2]     = hex_[uint8(v[i]) >> 4];
            s[3 + i * 2]     = hex_[uint8(v[i]) & 0x0f];
        }
        // unicode ellipsis as UTF-8 bytes: E2 80 A6
        // Simpler: use ASCII "..."
        s[10] = '.'; s[11] = '.'; s[12] = '.';
        // last 4 bytes omitted for brevity — append separately
        bytes memory s2 = new bytes(8);
        for (uint i = 0; i < 4; i++) {
            s2[i * 2]     = hex_[uint8(v[16 + i]) >> 4];
            s2[i * 2 + 1] = hex_[uint8(v[16 + i]) & 0x0f];
        }
        return string(abi.encodePacked(s, s2));
    }
}
