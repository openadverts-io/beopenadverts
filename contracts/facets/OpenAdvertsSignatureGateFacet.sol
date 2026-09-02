// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import "../libraries/LibOpenAdvertsSignatureGateStorage.sol";
import "../libraries/LibOpenAdvertsPayoutStorage.sol";

/**
 * @title OpenAdvertsSignatureGateFacet
 * @notice Verifies that a prospect-creation call was authorized by the OpenAdverts
 *         website backend, and consumes the single-use request UID to block replay.
 * @dev Signature is EIP-191 personal_sign over the packed payload, recovered against the
 *      protocol-level `openAdvertsSigningAddress` (reused from the reward-claim flow).
 *      Verification is exposed as a facet function (per project convention: no logic in
 *      libraries) and is only reachable via an intra-Diamond call from a factory facet.
 */
contract OpenAdvertsSignatureGateFacet {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Verifies a website-origin signature and marks its UID as spent.
     * @dev MUST only be reachable via another facet (`msg.sender == address(this)`); otherwise an
     *      EOA could invoke this selector directly through the Diamond and forge `caller`. The
     *      calling factory captures the real caller as its own `msg.sender` and forwards it here.
     * @param actionTag Domain tag identifying the calling entrypoint (per-function constant).
     * @param uid Single-use request identifier minted by the website backend.
     * @param deadline Unix timestamp after which the signature is no longer valid.
     * @param signature EIP-191 signature produced by the OpenAdverts signing key.
     * @param caller The address that initiated the creation call (the factory's real msg.sender).
     */
    function verifyAndConsume(bytes32 actionTag, bytes32 uid, uint256 deadline, bytes calldata signature, address caller) external {
        require(msg.sender == address(this), "Only diamond");
        require(block.timestamp <= deadline, "Signature expired");

        LibOpenAdvertsSignatureGateStorage.OpenAdvertsSignatureGateStruct storage gs = LibOpenAdvertsSignatureGateStorage
            .openAdvertsSignatureGateStorage();
        require(!gs.usedUID[uid], "UID already used");

        address signer = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage().openAdvertsSigningAddress;
        require(signer != address(0), "Signing key not set");
        // Secondary-signer cutover: the gate carries no signed engagement block, so route by the
        // execution block — at/after the cutover the secondary signer is authoritative.
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage pas = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        if (pas.secondarySigningEnabled && block.number >= pas.secondarySigningCutoverBlock) {
            signer = pas.secondarySigningAddress;
        }

        bytes32 messageHash = keccak256(abi.encodePacked(actionTag, block.chainid, address(this), caller, uid, deadline));
        require(messageHash.toEthSignedMessageHash().recover(signature) == signer, "Invalid signature");

        gs.usedUID[uid] = true;
    }

    /**
     * @notice Returns whether a request UID has already been consumed.
     */
    function isUidUsed(bytes32 uid) external view returns (bool) {
        return LibOpenAdvertsSignatureGateStorage.openAdvertsSignatureGateStorage().usedUID[uid];
    }
}
