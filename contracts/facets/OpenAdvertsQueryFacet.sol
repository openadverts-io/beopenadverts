// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import {LibOpenAdvertsQueryStorage} from "../libraries/LibOpenAdvertsQueryStorage.sol";
import {LibOpenAdvertsQueryHelpers} from "../libraries/LibOpenAdvertsQueryHelpers.sol";

/**
 * @title OpenAdvertsQueryFacet
 * @dev Optimized query facet for retrieving combined affiliate and advertisement data
 * @notice Provides efficient batch queries for multiple entity types
 */
contract OpenAdvertsQueryFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Returns both Prospect and Approved affiliates in a single call
     * @return prospectAffiliates Array of prospect affiliates
     * @return approvedAffiliates Array of approved affiliates
     */
    function getProspectAndApprovedAffiliates()
        external
        view
        returns (
            LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory prospectAffiliates,
            LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory approvedAffiliates
        )
    {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        prospectAffiliates = afs.prospectAffiliates;
        approvedAffiliates = afs.approvedAffiliates;
    }

    /**
     * @notice Returns all Prospect and Approved entities (affiliates + advertisements) in a single call.
     *         Advertisement entries include current contract balances (POL native or USDC token).
     * @return prospectAffiliates       Array of prospect affiliates
     * @return approvedAffiliates       Array of approved affiliates
     * @return prospectAdvertisements   Array of prospect advertisements with balances
     * @return approvedAdvertisements   Array of approved advertisements with balances
     */
    function getAllProspectAndApprovedEntities()
        external
        view
        returns (
            LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory prospectAffiliates,
            LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory approvedAffiliates,
            LibOpenAdvertsQueryStorage.AdvertWithBalance[] memory prospectAdvertisements,
            LibOpenAdvertsQueryStorage.AdvertWithBalance[] memory approvedAdvertisements
        )
    {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        prospectAffiliates = afs.prospectAffiliates;
        approvedAffiliates = afs.approvedAffiliates;

        address usdcAddress = aas.usdcTokenAddress;
        prospectAdvertisements = LibOpenAdvertsQueryHelpers.buildAdvertsWithBalances(aas.prospectAdvertisements, usdcAddress);
        approvedAdvertisements = LibOpenAdvertsQueryHelpers.buildAdvertsWithBalances(aas.approvedAdvertisements, usdcAddress);
    }

    /**
     * @notice Returns combined statistics for affiliates and advertisements
     * @return affiliateProspectCount Number of prospect affiliates
     * @return affiliateApprovedCount Number of approved affiliates
     * @return affiliateBannedCount Number of banned affiliates
     * @return advertProspectCount Number of prospect advertisements
     * @return advertApprovedCount Number of approved advertisements
     * @return advertBannedCount Number of banned advertisements
     */
    function getCombinedStatistics()
        external
        view
        returns (
            uint256 affiliateProspectCount,
            uint256 affiliateApprovedCount,
            uint256 affiliateBannedCount,
            uint256 advertProspectCount,
            uint256 advertApprovedCount,
            uint256 advertBannedCount
        )
    {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        affiliateProspectCount = afs.prospectAffiliates.length;
        affiliateApprovedCount = afs.approvedAffiliates.length;
        affiliateBannedCount = afs.bannedAffiliates.length;

        advertProspectCount = aas.prospectAdvertisements.length;
        advertApprovedCount = aas.approvedAdvertisements.length;
        advertBannedCount = aas.bannedAdvertisements.length;
    }

    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own immutable variable for direct calls
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
