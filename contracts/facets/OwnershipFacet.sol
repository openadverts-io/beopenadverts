// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";

contract OwnershipFacet is IERC173 {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.setContractOwner(_newOwner);
    }

    function owner() external view override returns (address owner_) {
        owner_ = LibDiamond.contractOwner();
    }

    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own immutable variable for direct calls
     */
    receive() external payable {
        if (msg.value > 0) {
            require(diamondAddressForDirectCalls != address(0), "Diamond address not set");
            
            (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
            require(success, "Transfer to diamond address failed");
        }
    }
}
