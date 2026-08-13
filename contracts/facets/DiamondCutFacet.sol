// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import {LibOpenAdvertsBootstrapStorage} from "../libraries/LibOpenAdvertsBootstrapStorage.sol";

// Remember to add the loupe functions from DiamondLoupeFacet to the diamond.
// The loupe functions are required by the EIP2535 Diamonds standard

contract DiamondCutFacet is IDiamondCut {
    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall
    /// @param _diamondCut Contains the facet addresses and function selectors
    /// @param _init The address of the contract or facet to execute _calldata
    /// @param _calldata A function call, including function selector and arguments
    ///                  _calldata is executed with delegatecall on _init
    /// @dev During bootstrap the owner may cut directly. Once finalizeBootstrap() runs, the owner
    ///      path is permanently disabled; thereafter only a quorum-approved governance ratification
    ///      (which sets the transient governanceCutInProgress flag) may cut.
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external override {
        LibOpenAdvertsBootstrapStorage.BootstrapStruct storage bs = LibOpenAdvertsBootstrapStorage.bootstrapStorage();
        if (bs.governanceCutInProgress) {
            // Authorized by a quorum-approved FacetProposal (ratifyUpgrade sets this transient flag).
            // Not subject to the owner check or the one-way bootstrap latch.
        } else {
            LibDiamond.enforceIsContractOwner();
            // One-way bootstrap latch: the owner may cut facets directly only until OAD is distributed
            // (or finalizeBootstrap() is called). Afterwards, upgrades must go through governance.
            require(!bs.directCutFinalized, "Direct diamondCut disabled post-bootstrap; use governance");
        }
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }

    // Do we need to add a receive function to forward funds to the diamond.sol here?

    receive() external payable {}
}
