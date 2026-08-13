// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockClaimPercentagesProviderAt0TPs
 * @notice Mock implementation of IClaimPercentagesProvider with NO third parties.
 * @dev Used in BusinessCaseV2 to establish the minimum-gas floor for processReward.
 *      With 0 TPs there is no deduplication work, no ThirdPartyAddressStruct iteration,
 *      and no additional transfer calls — giving the cleanest possible per-sig baseline.
 *
 * Percentages:
 *   affiliate  20%
 *   viewer     80%
 *   third parties  0 (count = 0)
 *   Total:    100%
 */
contract MockClaimPercentagesProvider {
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
        uint256[] memory pcts = new uint256[](0);
        return (
            20, // affiliate gets 20%
            80, // viewer gets 80%
            0, // no third parties
            pcts
        );
        // Total: 100%
    }
}
