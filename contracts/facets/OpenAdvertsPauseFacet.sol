// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsPauseStorage.sol";
import "../libraries/LibDiamond.sol";

/**
 * @title OpenAdvertsPauseFacet
 * @notice Phase 4 — system-wide emergency pause. Owner-only `pause(reason)`
 *         and `unpause()` are instant (NOT routed through the Phase 3
 *         timelock) because the primitive exists specifically for incident
 *         response where the normal delay window is unacceptable.
 *
 *         Gated paths (inbound value + governance takeover): createProposal,
 *         voteOnProposal, voteForNewAdmin, applyAsNewAdmin, both advert
 *         factories, and the Diamond-side claimReward entrypoint.
 *
 *         NOT gated (by design): withdrawals, refunds, revokeProposal,
 *         timelock queue/execute/cancel, token transfer, and all views.
 *         Users must always be able to exit escrowed positions.
 */
contract OpenAdvertsPauseFacet {
    // Kept for deploy-script symmetry; every facet in this project is
    // constructed with the diamond address.
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    event SystemPaused(address indexed by, uint256 at, string reason);
    event SystemUnpaused(address indexed by, uint256 at);

    /**
     * @notice Activate the system-wide pause. Owner-only, instant.
     * @param reason Short human-readable justification (emitted; stored).
     */
    function pause(string calldata reason) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPauseStorage.OpenAdvertsPauseStruct storage ps = LibOpenAdvertsPauseStorage.openAdvertsPauseStorage();
        require(!ps.paused, "Already paused");
        ps.paused = true;
        ps.pausedAt = uint64(block.timestamp);
        ps.pausedBy = msg.sender;
        ps.reason = reason;
        emit SystemPaused(msg.sender, block.timestamp, reason);
    }

    /**
     * @notice Deactivate the system-wide pause. Owner-only, instant.
     */
    function unpause() external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPauseStorage.OpenAdvertsPauseStruct storage ps = LibOpenAdvertsPauseStorage.openAdvertsPauseStorage();
        require(ps.paused, "Not paused");
        ps.paused = false;
        ps.pausedAt = 0;
        ps.pausedBy = address(0);
        delete ps.reason;
        emit SystemUnpaused(msg.sender, block.timestamp);
    }

    /**
     * @notice Returns whether the system is currently paused.
     */
    function isSystemPaused() external view returns (bool) {
        return LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused;
    }

    /**
     * @notice Returns the full pause record for UI/off-chain monitoring.
     */
    function getPauseInfo() external view returns (bool paused, uint256 pausedAt, address pausedBy, string memory reason) {
        LibOpenAdvertsPauseStorage.OpenAdvertsPauseStruct storage ps = LibOpenAdvertsPauseStorage.openAdvertsPauseStorage();
        return (ps.paused, ps.pausedAt, ps.pausedBy, ps.reason);
    }
}
