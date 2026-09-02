// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibOpenAdvertsRequestKeyStorage} from "../libraries/LibOpenAdvertsRequestKeyStorage.sol";
import {LibOpenAdvertsPayoutStorage} from "../libraries/LibOpenAdvertsPayoutStorage.sol";

/**
 * @title OpenAdvertsRequestKeyFacet
 * @notice Owns the protocol requestKey: the address the external KMS signing service authenticates
 *         request callers against off-chain (via ECDSA recover). It is published on-chain only,
 *         never used in any on-chain ecrecover, and rotates atomically with ownership so a departed
 *         owner immediately loses request access.
 * @dev Storage lives in LibOpenAdvertsRequestKeyStorage (accessor only). The two `...OnlyDiamond`
 *      helpers are reached by intra-diamond self-call from OwnershipFacet.transferOwnership and the
 *      OpenAdvertsGovernanceFacet admin-election flow, so their validation/rotation bytecode does not
 *      inflate those (size-constrained) facets. Every function name carries `RequestKey`.
 */
contract OpenAdvertsRequestKeyFacet {
    // Immutable diamond address for direct calls (fund forwarding; facet convention).
    address internal immutable diamondAddressForDirectCalls;

    event RequestKeyUpdated(address indexed previousKey, address indexed newKey, address indexed changedBy);

    error RequestKeyZero();
    error RequestKeyEqualsOwner();
    error RequestKeyUnchanged();
    error RequestKeyEqualsSigner();
    error RequestKeyEqualsSecondarySigner();

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Owner-only, immediate (no timelock): rotate the requestKey out-of-band, e.g. on
     *         suspected compromise. Reverts unless the new key is nonzero, != owner, != current
     *         requestKey, and != the current signing address.
     */
    function setRequestKey(address newRequestKey) external {
        LibDiamond.enforceIsContractOwner();
        _validateRequestKey(newRequestKey, LibDiamond.contractOwner());
        _writeRequestKey(newRequestKey, msg.sender);
    }

    /**
     * @notice Returns the current live requestKey (the external service's source of truth).
     */
    function getRequestKey() external view returns (address) {
        return LibOpenAdvertsRequestKeyStorage.requestKeyStorage().requestKey;
    }

    /**
     * @notice onlyDiamond: validate a candidate requestKey without mutating state. Called via
     *         self-call by OwnershipFacet.transferOwnership and OpenAdvertsGovernanceFacet.applyAsNewAdmin.
     */
    function validateRequestKeyOnlyDiamond(address newKey, address prospectiveOwner) external view {
        require(msg.sender == address(this), "Only diamond");
        _validateRequestKey(newKey, prospectiveOwner);
    }

    /**
     * @notice onlyDiamond: write the requestKey (already validated by the caller). Called via
     *         self-call by OwnershipFacet.transferOwnership and OpenAdvertsGovernanceFacet.ratifyNewAdmin.
     * @param changedBy The original tx caller of the entry function, forwarded so RequestKeyUpdated
     *        attributes the human actor rather than the diamond (self-call would otherwise set it).
     */
    function rotateRequestKeyOnlyDiamond(address newKey, address changedBy) external {
        require(msg.sender == address(this), "Only diamond");
        _writeRequestKey(newKey, changedBy);
    }

    // Reverts unless newKey is nonzero, differs from the prospective owner, actually rotates
    // (differs from the current requestKey), and is neither the primary nor the secondary signing address.
    function _validateRequestKey(address newKey, address prospectiveOwner) internal view {
        if (newKey == address(0)) revert RequestKeyZero();
        if (newKey == prospectiveOwner) revert RequestKeyEqualsOwner();
        if (newKey == LibOpenAdvertsRequestKeyStorage.requestKeyStorage().requestKey) revert RequestKeyUnchanged();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        if (newKey == payoutStore.openAdvertsSigningAddress) revert RequestKeyEqualsSigner();
        if (newKey == payoutStore.secondarySigningAddress) revert RequestKeyEqualsSecondarySigner();
    }

    function _writeRequestKey(address newKey, address changedBy) internal {
        LibOpenAdvertsRequestKeyStorage.RequestKeyStruct storage rks = LibOpenAdvertsRequestKeyStorage.requestKeyStorage();
        address previous = rks.requestKey;
        rks.requestKey = newKey;
        emit RequestKeyUpdated(previous, newKey, changedBy);
    }

    /**
     * @notice Receive function that forwards all funds to the diamond address.
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
