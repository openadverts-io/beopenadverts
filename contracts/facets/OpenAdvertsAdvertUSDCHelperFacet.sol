// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import {OpenAdvertsAdvertUSDC} from "../OpenAdvertsAdvertUSDC.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";

contract OpenAdvertsAdvertUSDCHelperFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Deploys a new USDC advertisement contract
     * @dev Called by factory after validation.
     *      MUST only be reachable via another facet (i.e. `msg.sender == address(this)`);
     *      otherwise an EOA could invoke this selector directly through the Diamond and
     *      forge an arbitrary `advertiser` as the advert owner.
     * @param storageId Unique identifier for the advertisement
     * @param advertBountyInMicroUSDC Bounty amount in micro USDC (6 decimals)
     * @param minBlockNRSeparation Minimum blocks between affiliate claims
     * @param designatedAffiliate The single approved affiliate address bound to this advert
     * @param usdcAddress The USDC token contract address
     * @param advertiser The address that initiated the advert creation (the real msg.sender of the factory entry)
     * @return advertAddress The deployed advertisement contract address
     */
    function deployUSDCAdvertisement(
        // address owner,
        string calldata storageId,
        uint256 advertBountyInMicroUSDC,
        uint256 minBlockNRSeparation,
        address designatedAffiliate,
        address usdcAddress,
        uint256 initialFundedBudgetInMicroUSDC,
        address advertiser
    ) external returns (address advertAddress) {
        // VALIDATE: Addresses match Diamond storage
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        address diamondAddress = aas.diamondAddress;

        require(diamondAddress != address(0), "Diamond address not initialized");
        require(address(this) == diamondAddress, "Must execute in Diamond context");
        // CRITICAL: only callable from within the diamond (i.e. another facet).
        //    Without this, any EOA could call this selector via the diamond fallback
        //    and forge an `advertiser` of their choice as the advert owner.
        require(msg.sender == address(this), "Only diamond");
        require(usdcAddress == aas.usdcTokenAddress, "Invalid USDC address");

        advertAddress = address(
            new OpenAdvertsAdvertUSDC(
                LibOpenAdvertsAdvertisersStorage.AdvertStruct({
                    advertContractAddress: address(0),
                    advertOwner: advertiser,
                    storageId: storageId,
                    advertFavorableScore: 0,
                    advertUnfavorableScore: 0,
                    AdvertisementType: LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
                    advertCurrency: LibOpenAdvertsAdvertisersStorage.PaymentType.USDC,
                    advertBounty: advertBountyInMicroUSDC,
                    initialFundedBudget: initialFundedBudgetInMicroUSDC,
                    minBlockNRSeparation: minBlockNRSeparation,
                    designatedAffiliate: designatedAffiliate,
                    pausedAtBlock: 0,
                    withdrawalAvailableBlock: 0,
                    isPaused: false
                }),
                diamondAddress,
                usdcAddress,
                initialFundedBudgetInMicroUSDC
            )
        );
    }

    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own immutable variable for direct calls
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
