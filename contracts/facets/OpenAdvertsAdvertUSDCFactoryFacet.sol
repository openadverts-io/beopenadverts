// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// ✅ ADD: SafeERC20 import
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsPauseStorage.sol";

interface IOpenAdvertsAdvertisersFacet {
    function getUSDCTokenAddress() external view returns (address);
}

interface IOpenAdvertsAdvertUSDCPriceFacet {
    function calculateMinimumUSDCRequirements(uint256, uint256, uint256) external view returns (uint256, uint256);
}

interface IOpenAdvertsAdvertUSDCHelperFacet {
    function deployUSDCAdvertisement(
        string calldata storageId,
        uint256 advertBountyInMicroUSDC,
        uint256 minBlockNRSeparation,
        address designatedAffiliate,
        address usdcAddress,
        uint256 initialFundedBudgetInMicroUSDC,
        address advertiser
    ) external returns (address);
}

interface IOpenAdvertsSignatureGateFacet {
    function verifyAndConsume(bytes32 actionTag, bytes32 uid, uint256 deadline, bytes calldata signature, address caller) external;
}

contract OpenAdvertsAdvertUSDCFactoryFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    // Domain tag binding a website-origin signature to this entrypoint.
    bytes32 private constant USDC_ADVERT_CREATE = keccak256("OPENADVERTS_USDC_ADVERT_CREATE");

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    using SafeERC20 for IERC20;

    event USDCAdvertCreated(address indexed advert, address indexed owner, string storageId, uint256 bounty, uint256 funding);

    function createNewProspectUSDCAdvertContract(
        string calldata storageId,
        uint256 advertBountyInMicroUSDC,
        uint256 minBlockNRSeparation,
        address designatedAffiliate,
        uint256 usdcFundingAmountInMicroUSDC,
        bytes32 uid,
        uint256 deadline,
        bytes calldata signature
    ) external returns (address) {
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        // Capture the real caller once; preserves msg.sender semantics for AA/contract wallets.
        address advertiser = msg.sender;

        // Gate: require a valid, unused, website-issued signature bound to this caller.
        // Replay/atomicity: verifyAndConsume marks usedUID[uid]=true (reverts "UID already used"
        // on any reuse) in THIS same transaction, before deployment. Because the UID consumption
        // and the contract creation share one atomic tx, a single signature can mint at most one
        // advert contract — any revert downstream also rolls back the UID spend.
        IOpenAdvertsSignatureGateFacet(address(this)).verifyAndConsume(USDC_ADVERT_CREATE, uid, deadline, signature, advertiser);

        _validateDesignatedAffiliate(designatedAffiliate);
        // Validate and get USDC address
        address usdcAddr = _validateAndGetUSDC(storageId, advertBountyInMicroUSDC, minBlockNRSeparation, usdcFundingAmountInMicroUSDC);

        // Deploy via helper facet (intra-diamond CALL; helper enforces msg.sender==address(this)
        //    and receives `advertiser` explicitly, so msg.sender being the diamond is fine).
        address prospectAdvertisement = IOpenAdvertsAdvertUSDCHelperFacet(address(this)).deployUSDCAdvertisement(
            storageId,
            advertBountyInMicroUSDC,
            minBlockNRSeparation,
            designatedAffiliate,
            usdcAddr,
            usdcFundingAmountInMicroUSDC,
            advertiser
        );

        IERC20(usdcAddr).safeTransferFrom(advertiser, prospectAdvertisement, usdcFundingAmountInMicroUSDC);

        // Store advertisement
        _storeAndValidateAdvertisement(
            prospectAdvertisement,
            storageId,
            advertBountyInMicroUSDC,
            usdcFundingAmountInMicroUSDC,
            minBlockNRSeparation,
            designatedAffiliate
        );

        emit USDCAdvertCreated(prospectAdvertisement, advertiser, storageId, advertBountyInMicroUSDC, usdcFundingAmountInMicroUSDC);

        return prospectAdvertisement;
    }

    function _validateDesignatedAffiliate(address designatedAffiliate) internal view {
        if (designatedAffiliate == address(0)) {
            return;
        }

        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[designatedAffiliate], "Designated affiliate does not exist");
        require(
            afs.affiliateStatus[designatedAffiliate] == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved,
            "Designated affiliate must be Approved"
        );
    }

    /**
     * @notice Internal validation function to reduce stack depth
     * @dev Separated to avoid "stack too deep" error
     * @dev NOW INCLUDES: Explicit allowance and balance checks with custom revert messages
     */
    function _validateAndGetUSDC(
        string calldata storageId,
        uint256 advertBountyInMicroUSDC,
        uint256 minBlockNRSeparation,
        uint256 usdcFundingAmountInMicroUSDC
    ) internal view returns (address usdcAddr) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        // Basic validation
        require(aas.diamondAddress != address(0), "Storage not initialized");
        require(bytes(storageId).length > 0, "Invalid storage ID");
        require(minBlockNRSeparation >= 1 && minBlockNRSeparation <= gs.currentQuotas.maxBlockSeparationAdvertisement, "Invalid block separation");

        // Calculate and validate minimum requirements
        (uint256 minBountyUSDC, uint256 minFundingUSDC) = IOpenAdvertsAdvertUSDCPriceFacet(address(this)).calculateMinimumUSDCRequirements(
            gs.currentQuotas.minAdvertBountyInPOLWei,
            gs.currentQuotas.minPOLRequiredforAdvertInWei,
            gs.currentQuotas.USDCCurrencyPremiumInPCT
        );

        require(advertBountyInMicroUSDC >= minBountyUSDC, "Bounty below minimum");
        require(usdcFundingAmountInMicroUSDC >= minFundingUSDC, "Funding below minimum");
        require(usdcFundingAmountInMicroUSDC >= advertBountyInMicroUSDC, "Funding < bounty");

        // Get and validate USDC token
        usdcAddr = IOpenAdvertsAdvertisersFacet(address(this)).getUSDCTokenAddress();
        require(usdcAddr != address(0), "USDC not set");

        IERC20 usdc = IERC20(usdcAddr);

        uint256 userBalance = usdc.balanceOf(msg.sender);
        require(userBalance >= usdcFundingAmountInMicroUSDC, "Insufficient balance");
    }

    /**
     * @notice Store and validate advertisement in Diamond storage
     * @dev This function ensures the advertisement is properly stored in Diamond storage
     * @dev Called after deployment to persist advertisement data
     */
    function _storeAndValidateAdvertisement(
        address prospectAdvertisementAddress,
        string memory storageId,
        uint256 advertBountyInMicroUSDC,
        uint256 initialFundedBudgetInMicroUSDC,
        uint256 minBlockNRSeparation,
        address designatedAffiliate
    ) internal {
        // DIRECT STORAGE: Access Diamond storage directly since we're in Diamond context
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        // VALIDATION: Check that advertisement doesn't already exist
        require(!aas.advertisementExists[prospectAdvertisementAddress], "Advertisement already exists");

        uint256 prospectCountBefore = aas.prospectAdvertisements.length;

        // CREATE STRUCT: Build the advertisement struct
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvert = LibOpenAdvertsAdvertisersStorage.AdvertStruct({
            advertContractAddress: prospectAdvertisementAddress,
            advertOwner: msg.sender,
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
        });

        // CRITICAL: Set mappings BEFORE adding to array
        aas.advertisementIndex[prospectAdvertisementAddress] = aas.prospectAdvertisements.length;
        aas.advertisementExists[prospectAdvertisementAddress] = true;
        aas.advertisementStatus[prospectAdvertisementAddress] = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect;
        aas.advertisementInitialFundedBudget[prospectAdvertisementAddress] = initialFundedBudgetInMicroUSDC;

        // ADD TO ARRAY: Push to prospect array
        aas.prospectAdvertisements.push(newAdvert);

        // COMPREHENSIVE VALIDATION: Ensure everything was stored correctly
        require(aas.prospectAdvertisements.length == prospectCountBefore + 1, "Failed to add to prospect array");
        require(aas.advertisementExists[prospectAdvertisementAddress], "Advertisement existence mapping failed");
        require(
            aas.advertisementStatus[prospectAdvertisementAddress] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
            "Advertisement status mapping failed"
        );
        require(
            aas.advertisementInitialFundedBudget[prospectAdvertisementAddress] == initialFundedBudgetInMicroUSDC,
            "Initial budget mapping failed"
        );

        // VALIDATE STORED DATA: Verify the stored data matches input
        uint256 storedIndex = aas.advertisementIndex[prospectAdvertisementAddress];
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory stored = aas.prospectAdvertisements[storedIndex];

        require(stored.advertContractAddress == prospectAdvertisementAddress, "Stored address mismatch");
        require(keccak256(bytes(stored.storageId)) == keccak256(bytes(storageId)), "Stored ID mismatch");
        require(stored.advertBounty == advertBountyInMicroUSDC, "Stored bounty mismatch");
        require(stored.advertOwner == msg.sender, "Stored owner mismatch");
    }

    /**
     * @notice Gets the current governance quotas for USDC advertisements
     * @return minBountyUSDC Minimum USDC bounty required
     * @return minFundingUSDC Minimum USDC funding required
     * @return maxBlockSeparation Maximum block separation allowed
     */
    function getUSDCAdvertisementQuotas() public view returns (uint256 minBountyUSDC, uint256 minFundingUSDC, uint256 maxBlockSeparation) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();

        (minBountyUSDC, minFundingUSDC) = IOpenAdvertsAdvertUSDCPriceFacet(address(this)).calculateMinimumUSDCRequirements(
            gs.currentQuotas.minAdvertBountyInPOLWei,
            gs.currentQuotas.minPOLRequiredforAdvertInWei,
            gs.currentQuotas.USDCCurrencyPremiumInPCT
        );

        maxBlockSeparation = gs.currentQuotas.maxBlockSeparationAdvertisement;
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
