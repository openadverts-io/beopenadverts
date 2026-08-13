// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProvider
 * @notice Mock implementation of IClaimPercentagesProvider for gas testing
 */
contract MockClaimPercentagesProvider {
    /**
     * @notice Returns fixed percentages for claim distribution
     * @return affiliateClaimPercentage Percentage for affiliate (6%)
     * @return viewerClaimPercentage Percentage for viewer (76%, >= 70% floor)
     * @return thirdPartyCount Number of third parties (3)
     * @return thirdPartyClaimPercentages Percentages for each third party [6%, 6%, 6%]
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
        pcts[0] = 6; // thirdParty1 gets 6%
        pcts[1] = 6; // thirdParty2 gets 6%
        pcts[2] = 6; // thirdParty3 gets 6%
        return (
            6, // affiliate gets 6%
            76, // viewer gets 76% (>= 70% enforced minimum)
            3, // 3 third parties
            pcts
        );
        // Total: 100%
    }
}
