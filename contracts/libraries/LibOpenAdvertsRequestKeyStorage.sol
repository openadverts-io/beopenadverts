// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title LibOpenAdvertsRequestKeyStorage
 * @notice Diamond storage slot for the protocol requestKey. Storage-only by design: all read /
 *         validate / rotate logic lives in OpenAdvertsRequestKeyFacet. The requestKey is the address
 *         the off-chain signing service authenticates request callers against off-chain; it is
 *         published on-chain only (never ecrecover'd here) and rotates atomically with ownership.
 * @dev TEE-only: consumed only by the future TEE/enclave (aegis) signing path (which verifies a
 *      requestKey-signed request envelope). The current KMS backend does NOT use it, so the stored
 *      value is inert today; kept on-chain so the TEE cutover needs no upgrade.
 */
library LibOpenAdvertsRequestKeyStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.requestkey.storage");

    struct RequestKeyStruct {
        address requestKey;
    }

    function requestKeyStorage() internal pure returns (RequestKeyStruct storage rks) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            rks.slot := position
        }
    }
}
