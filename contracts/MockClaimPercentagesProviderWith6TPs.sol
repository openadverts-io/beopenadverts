// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProviderWith6TPs
 * @notice Mock implementation of IClaimPercentagesProvider for gas benchmarking
 *         with the maximum of 6 third parties.
 * @dev Percentages: affiliate 6% + viewer 70% + 6 TPs × 4% = 100%
 */
contract MockClaimPercentagesProviderWith6TPs {
    /**
     * @notice Returns fixed percentages for claim distribution across 6 third parties
     * @return affiliateClaimPercentage  6%
     * @return viewerClaimPercentage     70%
     * @return thirdPartyCount           6
     * @return thirdPartyClaimPercentages [4%, 4%, 4%, 4%, 4%, 4%]
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
        uint256[] memory pcts = new uint256[](6);
        pcts[0] = 4;
        pcts[1] = 4;
        pcts[2] = 4;
        pcts[3] = 4;
        pcts[4] = 4;
        pcts[5] = 4;
        return (
            6, // affiliate gets 6%
            70, // viewer gets 70% (>= 70% enforced minimum)
            6, // 6 third parties
            pcts
        );
        // Total: 20 + 20 + (6 × 10) = 100%
    }
}
