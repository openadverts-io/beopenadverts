// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProvider
 * @notice Mock implementation of IClaimPercentagesProvider for gas testing
 */
contract MockClaimPercentagesProvider {
    /**
     * @notice Returns fixed percentages for claim distribution
     * @return affiliateClaimPercentage Percentage for affiliate (4%)
     * @return viewerClaimPercentage Percentage for viewer (90%)
     * @return thirdPartyCount Number of third parties (3)
     * @return thirdPartyClaimPercentages Percentages for each third party [2%, 2%, 2%]
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
        pcts[0] = 2; // thirdParty1 gets 2%
        pcts[1] = 2; // thirdParty2 gets 2%
        pcts[2] = 2; // thirdParty3 gets 2%
        return (
            4,  // affiliate gets 4%
            90, // viewer gets 90%
            3,  // 3 third parties
            pcts
        );
        // Total: 100%
    }
}
