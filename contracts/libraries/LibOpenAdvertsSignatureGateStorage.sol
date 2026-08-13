// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title LibOpenAdvertsSignatureGateStorage
 * @notice Namespaced storage for the website-origin signature gate on the
 *         prospect-creation entrypoints (POL/USDC advert + affiliate creation).
 * @dev Storage-only library (per project convention). Verification logic lives in
 *      OpenAdvertsSignatureGateFacet. `usedUID` records single-use request UIDs so a
 *      signature minted by the website cannot be replayed against the Diamond directly.
 */
library LibOpenAdvertsSignatureGateStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.signaturegate.storage");

    struct OpenAdvertsSignatureGateStruct {
        mapping(bytes32 => bool) usedUID;
    }

    function openAdvertsSignatureGateStorage() internal pure returns (OpenAdvertsSignatureGateStruct storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
