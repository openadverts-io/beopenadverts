// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title LibOpenAdvertsPauseStorage
 * @notice Phase 4 — namespaced storage for the system-wide emergency pause
 *         primitive. Pause is instant (owner-only, not timelocked) and acts as
 *         a kill-switch for inbound-value and governance-takeover paths only.
 *         Withdrawal / refund / exit paths remain always-on, by design.
 */
library LibOpenAdvertsPauseStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.pause.storage");

    struct OpenAdvertsPauseStruct {
        bool paused;
        uint64 pausedAt;
        address pausedBy;
        string reason;
    }

    function openAdvertsPauseStorage() internal pure returns (OpenAdvertsPauseStruct storage ps) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }
}
