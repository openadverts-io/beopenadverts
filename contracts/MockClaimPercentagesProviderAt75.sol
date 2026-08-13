// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProvider
 * @notice Mock implementation of IClaimPercentagesProvider for gas testing
 */
contract MockClaimPercentagesProvider {
    /**
     * @notice Returns fixed percentages for claim distribution
     * @return affiliateClaimPercentage Percentage for affiliate (22%)
     * @return viewerClaimPercentage Percentage for viewer (75%)
     * @return thirdPartyCount Number of third parties (3)
     * @return thirdPartyClaimPercentages Percentages for each third party [1%, 1%, 1%]
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
        pcts[0] = 1; // thirdParty1 gets 1%
        pcts[1] = 1; // thirdParty2 gets 1%
        pcts[2] = 1; // thirdParty3 gets 1%
        return (
            22, // affiliate gets 22%
            75, // viewer gets 75%
            3,  // 3 third parties
            pcts
        );
        // Total: 100%
    }
}
