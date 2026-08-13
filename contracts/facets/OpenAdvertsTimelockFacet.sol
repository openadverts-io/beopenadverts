// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsTimelockStorage.sol";
import "../libraries/LibDiamond.sol";

/**
 * @title OpenAdvertsTimelockFacet
 * @notice Phase 3 — owner-authority timelock. Queue → wait → execute for
 *         privileged configuration changes (oracle feed address, USDC token
 *         address, signing key, oracle bounds, staleness windows).
 * @dev Emergency actions (pause/unpause, ban/unban) intentionally bypass this
 *      facet — they must remain instant.
 *
 *      Targets are restricted to this diamond (address(this)). This lets the
 *      wrapped setters detect the "timelock execution context" via the
 *      inExecution flag in LibOpenAdvertsTimelockStorage while running inside
 *      a single transaction that still hits the diamond's fallback router.
 */
contract OpenAdvertsTimelockFacet {
    // Unused; kept for deploy script symmetry — every facet in this project is
    // deployed with the diamond address in its constructor.
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // Bounds chosen so the timelock is meaningful but not a DoS vector itself.
    uint256 public constant MIN_TIMELOCK_DELAY = 1 hours;
    uint256 public constant MAX_TIMELOCK_DELAY = 30 days;

    event TimelockInitialized(uint256 delaySeconds);
    event TimelockDelayUpdated(uint256 oldDelay, uint256 newDelay);
    event TimelockEnforcementChanged(bool oldEnforced, bool newEnforced);
    event OperationQueued(bytes32 indexed id, address indexed target, uint256 readyAt, bytes data);
    event OperationExecuted(bytes32 indexed id);
    event OperationCancelled(bytes32 indexed id);

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    /**
     * @notice One-shot initializer. Owner-only. Must run before the first
     *         queueOperation call.
     */
    function initializeTimelock(uint256 _delaySeconds) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        require(!s.initialized, "Timelock already initialized");
        require(_delaySeconds >= MIN_TIMELOCK_DELAY && _delaySeconds <= MAX_TIMELOCK_DELAY, "Delay out of range");
        s.initialized = true;
        s.delaySeconds = _delaySeconds;
        emit TimelockInitialized(_delaySeconds);
    }

    // -------------------------------------------------------------------------
    // Config — subject to the timelock itself once enforced == true
    // -------------------------------------------------------------------------

    /**
     * @notice Change the delay. Before enforcement is enabled, owner-direct.
     *         After enforcement, must be queued and executed.
     */
    function setTimelockDelay(uint256 _delaySeconds) external {
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        require(s.initialized, "Timelock not initialized");
        if (s.inExecution) {
            // authorized via timelock executeOperation
        } else if (s.enforced) {
            revert("Must go through timelock");
        } else {
            LibDiamond.enforceIsContractOwner();
        }
        require(_delaySeconds >= MIN_TIMELOCK_DELAY && _delaySeconds <= MAX_TIMELOCK_DELAY, "Delay out of range");
        uint256 old = s.delaySeconds;
        s.delaySeconds = _delaySeconds;
        emit TimelockDelayUpdated(old, _delaySeconds);
    }

    /**
     * @notice Turn enforcement on or off. Before the first enable, owner-direct;
     *         after, must be queued (same rule as setTimelockDelay).
     */
    function setTimelockEnforcement(bool _enforced) external {
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        require(s.initialized, "Timelock not initialized");
        if (s.inExecution) {
            // authorized via timelock executeOperation
        } else if (s.enforced) {
            revert("Must go through timelock");
        } else {
            LibDiamond.enforceIsContractOwner();
        }
        bool old = s.enforced;
        s.enforced = _enforced;
        emit TimelockEnforcementChanged(old, _enforced);
    }

    // -------------------------------------------------------------------------
    // Queue / execute / cancel
    // -------------------------------------------------------------------------

    /**
     * @notice Queue a configuration change. Owner-only. Target must be this diamond.
     * @return id The operation id (can be recomputed off-chain).
     */
    function queueOperation(address target, bytes calldata data) external returns (bytes32 id) {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        require(s.initialized, "Timelock not initialized");
        require(target == address(this), "Target must be diamond");
        require(data.length >= 4, "Empty calldata");

        id = keccak256(abi.encode(target, data, block.timestamp, block.number, msg.sender));
        LibOpenAdvertsTimelockStorage.Operation storage op = s.operations[id];
        require(op.target == address(0), "Op already exists");

        uint256 readyAt = block.timestamp + s.delaySeconds;
        op.target = target;
        op.readyAt = uint64(readyAt);
        op.data = data;

        emit OperationQueued(id, target, readyAt, data);
    }

    /**
     * @notice Execute a queued op after its readyAt. Owner-only. Sets inExecution
     *         so wrapped setters recognise the authorised context, then replays
     *         the stored calldata against the diamond.
     */
    function executeOperation(bytes32 id) external payable {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        LibOpenAdvertsTimelockStorage.Operation storage op = s.operations[id];
        require(op.target != address(0), "Op not found");
        require(op.executedAt == 0, "Already executed");
        require(op.cancelledAt == 0, "Cancelled");
        require(block.timestamp >= op.readyAt, "Too early");

        op.executedAt = uint64(block.timestamp);
        s.inExecution = true;

        (bool ok, bytes memory ret) = op.target.call{value: msg.value}(op.data);

        s.inExecution = false;

        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("Timelock exec failed");
        }

        emit OperationExecuted(id);
    }

    /**
     * @notice Owner-only instant cancel of a queued op. No timelock on cancel —
     *         the owner must always be able to abort a bad op before it executes.
     */
    function cancelOperation(bytes32 id) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        LibOpenAdvertsTimelockStorage.Operation storage op = s.operations[id];
        require(op.target != address(0), "Op not found");
        require(op.executedAt == 0, "Already executed");
        require(op.cancelledAt == 0, "Already cancelled");
        op.cancelledAt = uint64(block.timestamp);
        emit OperationCancelled(id);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getTimelockConfig() external view returns (bool initialized, bool enforced, bool inExecution, uint256 delaySeconds) {
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        return (s.initialized, s.enforced, s.inExecution, s.delaySeconds);
    }

    function getOperation(
        bytes32 id
    ) external view returns (address target, uint256 readyAt, uint256 executedAt, uint256 cancelledAt, bytes memory data) {
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage s = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        LibOpenAdvertsTimelockStorage.Operation storage op = s.operations[id];
        return (op.target, op.readyAt, op.executedAt, op.cancelledAt, op.data);
    }
}
