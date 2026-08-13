// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "../libraries/LibDiamond.sol";
import "../libraries/LibOpenAdvertsPauseStorage.sol";
// import "../libraries/LibOpenAdvertsPayoutStorage.sol";

import {OpenAdvertsAdvertPOL} from "../OpenAdvertsAdvertPOL.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";

interface IOpenAdvertsSignatureGateFacet {
    function verifyAndConsume(bytes32 actionTag, bytes32 uid, uint256 deadline, bytes calldata signature, address caller) external;
}

/**
 * @title OpenAdvertsAdvertPOLFactoryFacet
 * @dev Specialized factory facet for deploying POL advertisement contracts only
 * @notice Lightweight factory focused solely on POL advertisements
 */
contract OpenAdvertsAdvertPOLFactoryFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    // Domain tag binding a website-origin signature to this entrypoint.
    bytes32 private constant POL_ADVERT_CREATE = keccak256("OPENADVERTS_POL_ADVERT_CREATE");

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // Events

    event POLAdvertisementCreatedAndValidated(
        address indexed advertContract,
        address indexed advertiser,
        string storageId,
        uint256 bounty,
        uint256 funding,
        uint256 timestamp
    );

    /**
     * @notice Creates and deploys a new POL prospect advertisement contract
     * @param storageId A unique storage identifier for the advertisement
     * @param advertBountyInPolWei The bounty amount for POL advertisements (in wei)
     * @param BlockNRSeparation The minimum block number separation requirement
     * @param designatedAffiliate The single approved affiliate address bound to this advert
     * @return prospectAdvertisement The address of the deployed POL advertisement contract
     */
    function createNewProspectPOLAdvertContract(
        string memory storageId,
        uint256 advertBountyInPolWei,
        uint256 BlockNRSeparation,
        address designatedAffiliate,
        bytes32 uid,
        uint256 deadline,
        bytes calldata signature
    ) external payable returns (address prospectAdvertisement) {
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        // Capture the real caller once; preserves msg.sender semantics for AA/contract wallets.
        address advertiser = msg.sender;

        // Gate: require a valid, unused, website-issued signature bound to this caller.
        IOpenAdvertsSignatureGateFacet(address(this)).verifyAndConsume(POL_ADVERT_CREATE, uid, deadline, signature, advertiser);

        _validateDesignatedAffiliate(designatedAffiliate);
        // STEP 1: Validate inputs
        _validatePOLAdvertisementInputs(storageId, advertBountyInPolWei, BlockNRSeparation);

        // STEP 2: Deploy inline (no intra-diamond call; advertiser flows explicitly)
        prospectAdvertisement = _deployPOLAdvertContract(storageId, advertBountyInPolWei, BlockNRSeparation, designatedAffiliate, advertiser);

        // STEP 3: Store in Diamond storage (direct storage manipulation)
        _storeAndValidateAdvertisement(prospectAdvertisement, storageId, advertBountyInPolWei, msg.value, BlockNRSeparation, designatedAffiliate);

        // STEP 4: Emit events
        emit POLAdvertisementCreatedAndValidated(prospectAdvertisement, advertiser, storageId, advertBountyInPolWei, msg.value, block.timestamp);

        return prospectAdvertisement;
    }

    /**
     * @notice Deploys the POL advertisement contract. Inlined (was a helper facet hop).
     * @dev Runs in Diamond (delegatecall) context; `new` uses this context, so msg.value forwards natively.
     */
    function _deployPOLAdvertContract(
        string memory storageId,
        uint256 advertBountyInPolWei,
        uint256 minBlockNRSeparation,
        address designatedAffiliate,
        address advertiser
    ) internal returns (address advertAddress) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        address diamondAddress = aas.diamondAddress;
        require(diamondAddress != address(0), "Diamond address not initialized");
        require(address(this) == diamondAddress, "Must execute in Diamond context");

        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvert = LibOpenAdvertsAdvertisersStorage.AdvertStruct({
            advertContractAddress: address(0),
            advertOwner: advertiser,
            storageId: storageId,
            advertFavorableScore: 0,
            advertUnfavorableScore: 0,
            AdvertisementType: LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
            advertCurrency: LibOpenAdvertsAdvertisersStorage.PaymentType.POL,
            advertBounty: advertBountyInPolWei,
            initialFundedBudget: msg.value,
            minBlockNRSeparation: minBlockNRSeparation,
            designatedAffiliate: designatedAffiliate,
            pausedAtBlock: 0,
            withdrawalAvailableBlock: 0,
            isPaused: false
        });

        advertAddress = address(new OpenAdvertsAdvertPOL{value: msg.value}(newAdvert, diamondAddress));
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
     */
    function _validatePOLAdvertisementInputs(string memory storageId, uint256 advertBountyInPolWei, uint256 BlockNRSeparation) internal view {
        // Get governance storage for validation
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage advertStorage = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        // Validate advertiser storage is initialized
        require(advertStorage.diamondAddress != address(0), "Advertisers storage not initialized");

        // Basic validation
        require(bytes(storageId).length > 0, "Invalid storage ID");
        require(BlockNRSeparation >= 1, "BlockNRSeparation must be equal or greater than one");
        require(BlockNRSeparation <= govStorage.currentQuotas.maxBlockSeparationAdvertisement, "BlockNRSeparation exceeds maximum allowed");

        // POL specific validation
        require(advertBountyInPolWei > 0, "POL bounty must be greater than zero");
        require(advertBountyInPolWei >= govStorage.currentQuotas.minAdvertBountyInPOLWei, "POL bounty must meet minimum requirement");
        require(msg.value >= govStorage.currentQuotas.minPOLRequiredforAdvertInWei, "POL funding amount must meet minimum requirement");
        require(msg.value >= advertBountyInPolWei, "POL funding must cover the advertisement bounty");
    }

    /**
     * @notice Gets the current governance quotas for POL advertisements
     * @return minBounty Minimum POL bounty required
     * @return minFunding Minimum POL funding required
     * @return maxBlockSeparation Maximum block separation allowed
     */
    function getPOLAdvertisementQuotas() public view returns (uint256 minBounty, uint256 minFunding, uint256 maxBlockSeparation) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        return (
            govStorage.currentQuotas.minAdvertBountyInPOLWei,
            govStorage.currentQuotas.minPOLRequiredforAdvertInWei,
            govStorage.currentQuotas.maxBlockSeparationAdvertisement
        );
    }

    /**

     * @dev This function ensures the advertisement is properly stored in Diamond storage
     */
    function _storeAndValidateAdvertisement(
        address prospectAdvertisementAddress,
        string memory storageId,
        uint256 advertBountyInPolWei,
        uint256 initialFundedBudgetWei,
        uint256 minBlockNRSeparation,
        address designatedAffiliate
    ) internal {
        //  DIRECT STORAGE: Access Diamond storage directly since we're in Diamond context
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
            advertCurrency: LibOpenAdvertsAdvertisersStorage.PaymentType.POL,
            advertBounty: advertBountyInPolWei,
            initialFundedBudget: initialFundedBudgetWei,
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
        aas.advertisementInitialFundedBudget[prospectAdvertisementAddress] = initialFundedBudgetWei;

        // ADD TO ARRAY: Push to prospect array
        aas.prospectAdvertisements.push(newAdvert);

        // COMPREHENSIVE VALIDATION: Ensure everything was stored correctly
        require(aas.prospectAdvertisements.length == prospectCountBefore + 1, "Failed to add to prospect array");
        require(aas.advertisementExists[prospectAdvertisementAddress], "Advertisement existence mapping failed");
        require(
            aas.advertisementStatus[prospectAdvertisementAddress] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
            "Advertisement status mapping failed"
        );
        require(aas.advertisementInitialFundedBudget[prospectAdvertisementAddress] == initialFundedBudgetWei, "Initial budget mapping failed");

        // VALIDATE STORED DATA: Verify the stored data matches input
        uint256 storedIndex = aas.advertisementIndex[prospectAdvertisementAddress];
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory stored = aas.prospectAdvertisements[storedIndex];

        require(stored.advertContractAddress == prospectAdvertisementAddress, "Stored address mismatch");
        require(keccak256(bytes(stored.storageId)) == keccak256(bytes(storageId)), "Stored ID mismatch");
        require(stored.advertBounty == advertBountyInPolWei, "Stored bounty mismatch");
        require(stored.advertOwner == msg.sender, "Stored owner mismatch");
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
