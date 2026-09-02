// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";

interface IOpenAdvertsRequestKeyOps {
    function validateRequestKeyOnlyDiamond(address newKey, address prospectiveOwner) external view;
    function rotateRequestKeyOnlyDiamond(address newKey, address changedBy) external;
}

contract OwnershipFacet is IERC173 {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // Disabled: ownership can never move without atomically rotating the requestKey.
    function transferOwnership(address) external pure override {
        revert("Use transferOwnership(address,address)");
    }

    // Atomically hand over ownership and rotate the requestKey so an ex-owner's request
    // credential for the external signing service dies with the transfer. Validation/rotation
    // live in OpenAdvertsRequestKeyFacet, reached here via intra-diamond self-call.
    function transferOwnership(address _newOwner, address _newRequestKey) external {
        LibDiamond.enforceIsContractOwner();
        require(_newOwner != address(0), "New owner cannot be zero address");
        IOpenAdvertsRequestKeyOps(address(this)).validateRequestKeyOnlyDiamond(_newRequestKey, _newOwner);
        LibDiamond.setContractOwner(_newOwner);
        IOpenAdvertsRequestKeyOps(address(this)).rotateRequestKeyOnlyDiamond(_newRequestKey, msg.sender);
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
