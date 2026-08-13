// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
*
* Implementation of a diamond.
/******************************************************************************/

import {LibDiamond} from "./libraries/LibDiamond.sol";
import {IDiamondCut} from "./interfaces/IDiamondCut.sol";
import {LibOpenAdvertsTokenStorage} from "./libraries/LibOpenAdvertsTokenStorage.sol";
import {LibOpenAdvertsGovernanceStorage} from "./libraries/LibOpenAdvertsGovernanceStorage.sol";
import {LibOpenAdvertsPayoutStorage} from "./libraries/LibOpenAdvertsPayoutStorage.sol";

// import "./libraries/LibOpenAdvertsTokenStorage.sol";

contract Diamond {
    constructor(address _contractOwner, address _diamondCutFacet) payable {
        LibDiamond.setContractOwner(_contractOwner);

        // Add the diamondCut external function from the diamondCutFacet
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = IDiamondCut.diamondCut.selector;
        cut[0] = IDiamondCut.FacetCut({facetAddress: _diamondCutFacet, action: IDiamondCut.FacetCutAction.Add, functionSelectors: functionSelectors});
        LibDiamond.diamondCut(cut, address(0), "");
    }

    // Find facet for function that is called and execute the
    // function if a facet is found and return any value.
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds;
        bytes32 position = LibDiamond.DIAMOND_STORAGE_POSITION;
        // get diamond storage
        assembly {
            ds.slot := position
        }
        // get facet from function selector
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        require(facet != address(0), "Diamond: Function does not exist");
        // Execute external function from facet using delegatecall and return any value.
        assembly {
            // copy function selector and any arguments
            calldatacopy(0, 0, calldatasize())
            // execute function call using the facet
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            // get any return value
            returndatacopy(0, 0, returndatasize())
            // return any return value or error back to the caller
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    receive() external payable {
        if (msg.value > 0) {
            // Get storage references
            LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
            LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
            LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
            LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

            // Get commission percentages from governance quotas
            uint256 adminCommissionPct = govStorage.currentQuotas.adminCommissionFromADVC;
            uint256 storageProviderCommissionPct = govStorage.currentQuotas.storageProviderCommissionFromADVC;

            // Calculate each share as a percentage of msg.value
            uint256 adminAmount = (msg.value * adminCommissionPct) / 100;
            uint256 spAmount = (msg.value * storageProviderCommissionPct) / 100;
            uint256 platformAmount = msg.value - adminAmount - spAmount;

            // Transfer admin commission to Diamond owner
            if (adminAmount > 0) {
                (bool adminSuccess, ) = payable(ds.contractOwner).call{value: adminAmount}("");
                require(adminSuccess, "Admin commission transfer failed");
            }

            // Transfer storage provider commission; redirect to reward pool if address not set
            if (spAmount > 0) {
                address spAddress = payoutStore.storageProviderAddress;
                if (spAddress != address(0)) {
                    (bool spSuccess, ) = payable(spAddress).call{value: spAmount}("");
                    require(spSuccess, "Storage provider commission transfer failed");
                } else {
                    // No storage provider configured — redirect to OAD holder reward pool
                    platformAmount += spAmount;
                }
            }

            // Remainder accumulates in Diamond for OAD holder dividends
            if (platformAmount > 0) {
                tokenStorage.totalAggregateRewardInPOL += platformAmount;
            }
        }
    }
}
// import "./OpenAdvertsProposal.sol";

// Diamond Storage Library
// library LibOpenAdvertsTokenStorage {
//     bytes32 constant STORAGE_POSITION = keccak256("openadverts.token.storage");

//     struct TokenStorage {
//         uint256 totalAggregateDividend;
//         mapping(address => uint256) lastDividendClaim;
//         bytes4[] pendingFunctionSelectors;
//         address[] pendingImplementations;
//         address currentProposal;
//     }

//     function tokenStorage() internal pure returns (TokenStorage storage ts) {
//         bytes32 position = STORAGE_POSITION;
//         assembly {
//             ts.slot := position
//         }
//     }
// }
// // Getter for the state variables
// function getTotalAggregateDividend() external view returns (uint256) {
//     return ts.totalAggregateDividend;
// }

// function getLastDividendClaim(address account) external view returns (uint256) {
//     return ts.lastDividendClaim[account];
// }

// function getPendingFunctionSelectors() external view returns (bytes4[] memory) {
//     return ts.pendingFunctionSelectors;
// }

// function getPendingImplementations() external view returns (address[] memory) {
//     return ts.pendingImplementations;
// }

// function getCurrentProposal() external view returns (address) {
//     return ts.currentProposal;
// }
