// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title LibOpenAdvertsBootstrapStorage
 * @notice Namespaced storage for the one-way bootstrap latch that gates the
 *         owner-only direct diamondCut backdoor (DiamondCutFacet.diamondCut).
 *
 *         While `directCutFinalized == false` the owner may add/replace/remove
 *         facets directly to stand the system up. The latch flips to `true`
 *         (irreversibly) when the owner calls finalizeBootstrap() — performed as
 *         the final step of deployment once all cuts and initializations are done.
 *         Once set, the direct backdoor is permanently disabled and facet
 *         upgrades must go through governance (ratifyUpgrade -> LibDiamond.diamondCut).
 */
library LibOpenAdvertsBootstrapStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.bootstrap.storage");

    struct BootstrapStruct {
        bool directCutFinalized;
        // Transient authorization flag: set only by OpenAdvertsGovernanceFacet.ratifyUpgrade around
        // its self-call to DiamondCutFacet.diamondCut, so a quorum-approved FacetProposal can cut
        // facets without tripping the owner check or the bootstrap latch. Never set by any other path
        // (notably not the timelock), so the owner cannot use it to bypass the latch.
        bool governanceCutInProgress;
    }

    function bootstrapStorage() internal pure returns (BootstrapStruct storage bs) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            bs.slot := position
        }
    }
}
