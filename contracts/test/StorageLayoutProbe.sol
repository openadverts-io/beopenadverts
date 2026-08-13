// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "../libraries/LibOpenAdvertsPayoutStorage.sol";
import "../libraries/LibOpenAdvertsQueryStorage.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibDiamond.sol";

/**
 * @title StorageLayoutProbe
 * @notice Phase 1C test helper — exposes each library's STORAGE_POSITION so a test can
 *         assert it equals keccak256(identifier) and no two slots collide.
 */
contract StorageLayoutProbe {
    function advertisersSlot() external pure returns (bytes32) {
        return LibOpenAdvertsAdvertisersStorage.STORAGE_POSITION;
    }
    function affiliatesSlot() external pure returns (bytes32) {
        return LibOpenAdvertsAffiliatesStorage.STORAGE_POSITION;
    }
    function governanceSlot() external pure returns (bytes32) {
        return LibOpenAdvertsGovernanceStorage.STORAGE_POSITION;
    }
    function payoutSlot() external pure returns (bytes32) {
        return LibOpenAdvertsPayoutStorage.STORAGE_POSITION;
    }
    function querySlot() external pure returns (bytes32) {
        return LibOpenAdvertsQueryStorage.STORAGE_POSITION;
    }
    function tokenSlot() external pure returns (bytes32) {
        return LibOpenAdvertsTokenStorage.STORAGE_POSITION;
    }
    function diamondSlot() external pure returns (bytes32) {
        return LibDiamond.DIAMOND_STORAGE_POSITION;
    }
}
