// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProvider
 * @notice Mock implementation of IClaimPercentagesProvider for gas testing
 */
contract MockClaimPercentagesProvider {
    /**
     * @notice Returns fixed percentages for claim distribution
     * @return affiliateClaimPercentage Percentage for affiliate (20%)
     * @return viewerClaimPercentage Percentage for viewer (50%)
     * @return thirdPartyCount Number of third parties (3)
     * @return thirdPartyClaimPercentages Percentages for each third party [10%, 10%, 10%]
     */
    function getClaimPercentages()
        external
        pure
        returns (
            uint256 affiliateClaimPercentage,
            uint256 viewerClaimPercentage,
            uint256 thirdPartyCount,
            uint256[] memory thirdPartyClaimPercentages
        )
    {
        uint256[] memory pcts = new uint256[](3);
        pcts[0] = 10; // thirdParty1 gets 10%
        pcts[1] = 10; // thirdParty2 gets 10%
        pcts[2] = 10; // thirdParty3 gets 10%
        return (
            20, // affiliate gets 20%
            50, // viewer gets 50%
            3,  // 3 third parties
            pcts
        );
        // Total: 100%
    }
}
