// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibOpenAdvertsGovernanceStorage} from "../libraries/LibOpenAdvertsGovernanceStorage.sol";

/**
 * @title OpenAdvertsClaimGasFloorFacet
 * @notice Owner-managed claim-gas floor assumptions consumed by OpenAdvertsGovernanceFacet's
 *         quota guard. Split out of the governance facet to keep it under the 24KB code-size limit.
 * @dev The assumptions have NO hardcoded default: they must be set at deploy time (see deploy.js).
 *      Until they are set, OpenAdvertsGovernanceFacet._validateQuotaProposal reverts on quota
 *      proposal creation ("Claim-gas assumptions not set") — a deliberate fail-safe.
 */
contract OpenAdvertsClaimGasFloorFacet {
    // Immutable diamond address for direct calls (fund forwarding; facet convention).
    address internal immutable diamondAddressForDirectCalls;

    event ClaimGasFloorAssumptionsUpdated(uint256 gasPerSig, uint256 gasPriceWei);

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Owner-only: set the claim-gas floor assumptions (no tokenholder vote).
     * @dev Called once by the deploy script to initialise, and thereafter by the owner to retune.
     *      Owner already gates governance proposal creation, so owner-direct control adds no trust.
     * @param gasPerSig Assumed gas consumed per signature at claim time (1..1,000,000).
     * @param gasPriceWei Assumed worst-case Polygon gas price in wei (1 wei .. 100,000 gwei).
     */
    function setClaimGasFloorAssumptions(uint256 gasPerSig, uint256 gasPriceWei) external {
        LibDiamond.enforceIsContractOwner();
        // Upper bounds prevent an owner misconfiguration (e.g. huge values) from making the governance
        // claim-gas floor check unsatisfiable and thereby DoS-ing all quota proposals. The ceilings are
        // far above any realistic Polygon value (deploy uses 90,000 gas @ 300 gwei).
        require(gasPerSig > 0 && gasPerSig <= 1_000_000, "gasPerSig out of range");
        require(gasPriceWei > 0 && gasPriceWei <= 100_000 gwei, "gasPriceWei out of range");
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        gs.assumedGasPerSig = gasPerSig;
        gs.assumedClaimGasPriceWei = gasPriceWei;
        emit ClaimGasFloorAssumptionsUpdated(gasPerSig, gasPriceWei);
    }

    /**
     * @notice Returns the current claim-gas floor assumptions.
     * @return gasPerSig Assumed gas per signature (0 if not yet initialised).
     * @return gasPriceWei Assumed worst-case gas price in wei (0 if not yet initialised).
     */
    function getClaimGasFloorAssumptions() external view returns (uint256 gasPerSig, uint256 gasPriceWei) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        return (gs.assumedGasPerSig, gs.assumedClaimGasPriceWei);
    }

    /**
     * @notice Receive function that forwards all funds to the diamond address.
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
