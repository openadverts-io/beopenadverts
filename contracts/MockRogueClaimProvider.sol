// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MockRogueClaimProvider
 * @notice Test-only IClaimPercentagesProvider that emulates a viewer-controlled provider used to
 *         attempt the claim-info substitution exploit. It returns the SAME thirdPartyCount (3) that
 *         the honest OpenAdverts signer signed over, but reallocates the entire split to the viewer
 *         (affiliate 0%, third parties 0%). A correct payout facet MUST ignore any caller-supplied
 *         provider and resolve the provider from the affiliate registry instead, so this contract
 *         should never be able to influence a payout.
 */
contract MockRogueClaimProvider {
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
        uint256[] memory pcts = new uint256[](3); // [0, 0, 0]
        return (
            0, // affiliate gets 0%
            100, // viewer (msg.sender) grabs everything
            3, // same count the signer committed to
            pcts
        );
        // Total: 100% → entirely to the redeeming viewer
    }
}
