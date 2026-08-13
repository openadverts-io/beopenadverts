// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title LibOpenAdvertsTimelockStorage
 * @notice Namespaced storage for the Phase 3 owner-authority timelock.
 * @dev Storage-only library (per project convention). Helpers live in
 *      OpenAdvertsTimelockFacet and in the individual wrapped setters.
 *
 *      Lifecycle:
 *        - enforced == false (default): wrapped setters accept direct owner calls.
 *          Backward-compatible; existing tests & deploys work unchanged.
 *        - enforced == true: wrapped setters only accept calls made inside
 *          OpenAdvertsTimelockFacet.executeOperation (inExecution == true).
 *
 *      setTimelockDelay + setTimelockEnforcement are themselves subject to the
 *      same rule once enforced is true (they must be queued and executed), so
 *      a rogue owner can't instantly shorten the delay or disable enforcement.
 */
library LibOpenAdvertsTimelockStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.timelock.storage");

    struct Operation {
        address target; // diamond facet target (must equal address(this) in executeOperation)
        uint64 readyAt; // unix seconds when op becomes executable
        uint64 executedAt; // 0 until executed
        uint64 cancelledAt; // 0 until cancelled
        bytes data; // calldata to replay via target.call(data)
    }

    struct OpenAdvertsTimelockStruct {
        bool initialized;
        bool enforced;
        bool inExecution; // transient flag — true only during executeOperation body
        uint256 delaySeconds;
        mapping(bytes32 => Operation) operations;
    }

    function openAdvertsTimelockStorage() internal pure returns (OpenAdvertsTimelockStruct storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
