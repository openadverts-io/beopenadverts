// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "./libraries/LibOpenAdvertsPayoutStorage.sol";
import "./libraries/LibDiamond.sol";
import "./libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "./Diamond.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Interface for the payout facet implemented in the Diamond contract
interface IOpenAdvertsPayoutFacet {
    function claimReward(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.VerificationDataStruct memory verificationData,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddresses,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvertContractRef,
        uint256 remainingBudget,
        address advertContractAddress,
        uint256 advertApprovedBlock
    ) external payable returns (LibOpenAdvertsPayoutStorage.PayoutData memory payoutData);

    function getStorageProviderAddress() external view returns (address);
}

/**
 * @title IOpenAdvertsAdvertisersFacet - Embedded Interface
 * @dev Interface for advertiser operations - declared directly in contract
 */
interface IOpenAdvertsAdvertisersFacet {
    function getAdvertisementDetailsAndStatus(
        address advertContractAddress
    )
        external
        view
        returns (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertDetails, LibOpenAdvertsAdvertisersStorage.AdvertisementType status);

    function updateAdvertisementData(address advertContractAddress, bool isPaused, uint256 pausedAtBlock, uint256 withdrawalAvailableBlock) external;

    function reclassifyAdvertisement(
        address advertContractAddress,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType fromType,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType toType,
        uint256 favorableScoreChange,
        uint256 unfavorableScoreChange
    ) external;

    function returnAdvertisementCommissioned(address advertContractAddress) external returns (bool);

    // function markAdvertisementCommissioned(address advertContract) external; // ✅ ADD
}

/**
 * @title IOpenAdvertsGovernanceFacet - Embedded Interface
 * @dev Interface for governance operations - declared directly in contract
 */
interface IOpenAdvertsGovernanceFacet {
    function getAdvertPauseCooldownBlocks() external view returns (uint256);
    function getPlatformAndAdminCommissions() external view returns (uint256 platformCommission, uint256 adminCommissionFromADVC);
    function receiveAndSplitUSDCCommission(
        IERC20 usdcToken,
        uint256 totalCommission
    ) external returns (uint256 adminAmount, uint256 spAmount, uint256 platformAmount);
    function getMaxSignaturesPerBatch() external view returns (uint256);
}

// ✅ ADD: New interface function to get Diamond owner
interface IOpenAdvertsDiamondOwnership {
    function owner() external view returns (address);
}

interface IOpenAdvertsAffiliatesFacet {
    function getAffiliateStatus(address affiliateAddress) external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateType);
}

// ✅ REMOVED: Manual USDC update functions replaced with automatic balance detection
// The Diamond now uses processNewUSDCDeposits() to automatically detect and allocate
// USDC deposits without relying on external contracts to report them

struct PayoutBreakdown {
    uint256 viewerAmount;
    uint256 affiliateAmount;
    uint256 thirdPartyAmount;
    uint256 storageProviderAmount;
}

/**
 * @notice Aggregated pause/deprecation state for a single advert contract.
 * @dev Mirrors the data returned by the legacy tuple `getPauseAndDeprecationInfo()`.
 *      That tuple-returning function is intentionally preserved unchanged for ABI
 *      backwards compatibility; this struct is used only by `getAdvertRowDetails()`.
 */
struct PauseAndDeprecationInfo {
    bool isPaused;
    uint256 startDeprecatedBlock;
    uint256 withdrawnAtBlock;
}

/**
 * @notice One-call aggregate of the per-advert row-detail fields consumed by the
 *         frontend's PAbout row-expansion view (same logical row across POL and USDC).
 * @dev `startDeprecatedBlock` and `withdrawnAtBlock` are intentionally NOT duplicated
 *      at the top level — read them from `pauseInfo` to keep a single source of truth.
 */
struct AdvertRowDetails {
    PauseAndDeprecationInfo pauseInfo;
    bool isWithdrawalAvailable;
    uint256 totalPendingWithdrawals;
    address issuerCompany;
}

/**
 * @notice Event emitted when processReward completes with detailed payout breakdown
 * @param affiliateReceivingAddress The affiliate that received rewards
 * @param signaturesOffered Total number of signatures submitted
 * @param signaturesAccepted Number of signatures that passed validation
 * @param signaturesRejected Number of signatures that failed validation
 * @param viewerPayout Amount sent to viewer (msg.sender) in wei
 * @param affiliatePayout Amount sent to affiliate in wei
 * @param thirdPartyTotalPayout Total amount sent to all third parties in wei
 * @param totalPayout Total amount transferred in wei
 * @param rejectionReasons Array of rejection reasons with details
 */
event PayoutCompleted(
    address indexed affiliateReceivingAddress,
    uint256 signaturesOffered,
    uint256 signaturesAccepted,
    uint256 signaturesRejected,
    uint256 viewerPayout,
    uint256 affiliatePayout,
    uint256 thirdPartyTotalPayout,
    uint256 totalPayout,
    string[] rejectionReasons
);

/// @title OpenAdvertsAdvertUSDC Contract
/// @notice This contract represents an advertisement contract which uses USDC for rewards instead of POL.
contract OpenAdvertsAdvertUSDC is ReentrancyGuard {
    using LibOpenAdvertsAdvertisersStorage for LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct;
    using LibOpenAdvertsPayoutStorage for LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct;
    using SafeERC20 for IERC20;

    // Address of the Diamond contract which aggregates facets
    address public diamond;

    string public payoutCurrency = "USDC";

    // Storage struct containing advertisement contract information.
    LibOpenAdvertsAdvertisersStorage.AdvertStruct advertInfo;

    // The company that issued this advertisement contract.
    address public issuerCompany;

    // Initial USDC funding set at deployment time (micro USDC, 6 decimals).
    uint256 public immutable initialFundedBudgetMicroUSDC;

    // ✅ NEW: Deprecation state variables (same as POL contract)
    bool public isPaused;
    uint256 public startDeprecatedBlock;
    uint256 public withdrawnAtBlock;

    // Address of the USDC token contract
    IERC20 public immutable usdcToken;

    // ✅ NEW: Deprecation events (same as POL contract)
    event AdvertDeprecated(address indexed advertContract, uint256 deprecatedAtBlock, uint256 withdrawalAvailableAtBlock);
    event ProspectAdvertRevoked(address indexed advertContract, address indexed advertOwner, uint256 refundedAmount);
    event FundsWithdrawn(address indexed advertOwner, uint256 amount);

    // Event emitted when the advertisement contract balance is exhausted during fund transfers.
    event AdvertExhausted(address advertContractAddress);

    // The simplified event for USDC transfers
    event USDCTransfersCompleted(address indexed affiliateReceivingAddress, uint256 processedSignaturesCount, uint256 totalTransferred);

    // ✅ Phase 1B: Pull-payment pattern events
    event PayoutPending(address indexed recipient, uint256 amount);
    event PendingPayoutWithdrawn(address indexed recipient, uint256 amount);

    // Per-payout audit manifest: emitted once per processReward with the full, index-aligned
    // (recipient, amount) allocation for that call. recipients[i] is paid amounts[i] (both arrays
    // are deduplicated and zero-trimmed upstream in claimReward, so every entry is a distinct
    // payee with amount > 0). This is the amount each recipient is ENTITLED to: on a successful
    // transfer they receive it; on a failed transfer it is escrowed and additionally flagged by
    // PayoutPending(recipient, amount). Off-chain: zip(recipients, amounts) to reconstruct who
    // gets what. Single array event (one topic overhead) instead of N per-recipient logs.
    event PayoutManifest(address indexed affiliateReceivingAddress, address[] recipients, uint256[] amounts);

    // The designated affiliate for this advertisement (1:1 binding, set at deployment)
    address public designatedAffiliate;

    // Mapping for nonce tracking for each (user, affiliate) pair.
    mapping(address => mapping(address => uint256)) public userAffiliateNonces;

    // ✅ Phase 1B: USDC escrow for recipients whose safeTransfer failed in _processUSDCTransfers.
    mapping(address => uint256) public pendingWithdrawals;
    // Sum of unclaimed pendingWithdrawals — used to protect advertiser withdraw paths
    // from accidentally sweeping escrowed recipient funds.
    uint256 public totalPendingWithdrawals;

    bool private commissionProcessedLocal;

    // Block at which this advert was approved + commissioned. Set once in processCommission()
    // (which runs in the approval tx and is gated on Approved status) and passed to the Diamond
    // as the lower bound below which reward block numbers are rejected.
    uint256 public approvedBlock;

    /**
     * @notice Constructor sets up the advertisement contract with USDC support.
     * @param newAdvertContractRef Reference to the advertisement details.
     * @param _diamondAddress Address of the Diamond contract.
     * @param _usdcTokenAddress Address of the USDC token contract.
     */
    constructor(
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvertContractRef,
        address _diamondAddress,
        address _usdcTokenAddress,
        uint256 _initialFundedBudgetMicroUSDC
    ) {
        issuerCompany = newAdvertContractRef.advertOwner;
        advertInfo = newAdvertContractRef;
        diamond = _diamondAddress;
        usdcToken = IERC20(_usdcTokenAddress);
        initialFundedBudgetMicroUSDC = _initialFundedBudgetMicroUSDC;
        designatedAffiliate = newAdvertContractRef.designatedAffiliate;

        // ✅ NEW: Initialize deprecation state variables
        isPaused = false;
        startDeprecatedBlock = 0;
        withdrawnAtBlock = 0;
        commissionProcessedLocal = false;
    }

    /**
     * @notice Processes a reward using USDC transfers instead of POL.
     * @dev Uses nonReentrant to prevent reentrancy attacks. The nonce is incremented before external calls.
     * @param signatures Array of signatures validating the reward.
     * @param blockNumbers Array of block numbers corresponding to signatures.
     * @param verificationData Data required for reward verification.
     * @param thirdPartyAddresses Additional addresses for third-party rewards.
     */
    function processReward(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.VerificationDataStruct memory verificationData,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddresses
    ) external nonReentrant {
        // Status check below gates to Approved || Deprecating
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(signatures.length > 0, "No signatures provided");
        require(signatures.length <= IOpenAdvertsGovernanceFacet(diamond).getMaxSignaturesPerBatch(), "Exceeds max signatures per batch");

        require(
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved ||
                currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating,
            "Advertisement must be Approved or Deprecating to process rewards"
        );

        // ✅ Verify commission has been processed before allowing reward claims
        require(IOpenAdvertsAdvertisersFacet(diamond).returnAdvertisementCommissioned(address(this)), "Commission has not been processed");

        require(verificationData.affiliateReceivingAddress == designatedAffiliate, "Affiliate is not the designated affiliate for this advert");
        require(userAffiliateNonces[msg.sender][verificationData.affiliateReceivingAddress] == verificationData.nonce, "Nonce incorrect");

        userAffiliateNonces[msg.sender][verificationData.affiliateReceivingAddress] += 1;
        verificationData.viewerAddress = msg.sender;

        // Get current USDC balance
        uint256 currentUSDCBalance = usdcToken.balanceOf(address(this)) - totalPendingWithdrawals;
        require(currentUSDCBalance > 0, "No USDC balance available for payout");

        (
            bytes[] memory filteredSignatures,
            uint256[] memory filteredBlockNumbers,
            LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory filteredThirdPartyAddresses,
            string[] memory rejectionReasons,
            uint256 signaturesOffered,
            uint256 signaturesRejected
        ) = _filterAndTrackSignatures(signatures, blockNumbers, thirdPartyAddresses);

        uint256 signaturesAccepted = filteredSignatures.length;

        // ✅ Call claimReward with filtered data
        LibOpenAdvertsPayoutStorage.PayoutData memory payoutData = IOpenAdvertsPayoutFacet(diamond).claimReward(
            filteredSignatures,
            filteredBlockNumbers,
            verificationData,
            filteredThirdPartyAddresses,
            advertInfo,
            currentUSDCBalance,
            address(this),
            approvedBlock
        );

        PayoutBreakdown memory breakdown = _calculatePayoutBreakdown(
            payoutData,
            verificationData.affiliateReceivingAddress,
            verificationData.viewerAddress
        );

        // ✅ Process USDC transfers based on filtered data
        _processUSDCTransfers(payoutData, verificationData.affiliateReceivingAddress, filteredSignatures.length);

        emit PayoutCompleted(
            verificationData.affiliateReceivingAddress,
            signaturesOffered,
            signaturesAccepted,
            signaturesRejected,
            breakdown.viewerAmount,
            breakdown.affiliateAmount,
            breakdown.thirdPartyAmount,
            payoutData.totalAmount,
            rejectionReasons
        );
    }

    // function that will process commission and forwards to Diamond for splitting
    function processCommission() external returns (uint256) {
        // call owner function from interface
        address owner = IOpenAdvertsDiamondOwnership(diamond).owner();

        require(msg.sender == diamond || msg.sender == owner, "Only Diamond or Admin can process commission");
        require(!commissionProcessedLocal, "Commission has already been processed for this advertisement");

        // check if commission has already been processed
        bool commissionProcessedDiamond = IOpenAdvertsAdvertisersFacet(diamond).returnAdvertisementCommissioned(address(this));
        require(!commissionProcessedDiamond, "Commission has already been processed for this advertisement");

        // ✅ NEW: Verify advertisement is in Approved status
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved, "Advertisement must be Approved to process commission");

        commissionProcessedLocal = true;
        // Approval block: reward signatures for blocks before this are rejected on-chain.
        approvedBlock = block.number;

        // fetch platform commission percentage from governance
        (uint256 platformCommission, ) = IOpenAdvertsGovernanceFacet(diamond).getPlatformAndAdminCommissions();

        // get current balance and calculate total platform commission amount
        uint256 currentBalance = usdcToken.balanceOf(address(this)) - totalPendingWithdrawals;
        uint256 platformCommissionAmount = (currentBalance * platformCommission) / 100;

        require(platformCommissionAmount > 0, "Commission amount must be greater than zero");

        // ✅ REFACTORED: Approve Diamond to spend commission and let it handle the split
        require(usdcToken.approve(diamond, platformCommissionAmount), "USDC approval failed");

        // Send entire commission to Diamond for 3-way splitting (admin + storage provider + OAD holders)
        (uint256 adminAmount, uint256 spAmount, uint256 platformAmount) = IOpenAdvertsGovernanceFacet(diamond).receiveAndSplitUSDCCommission(
            usdcToken,
            platformCommissionAmount
        );

        require(adminAmount + spAmount + platformAmount == platformCommissionAmount, "Commission split mismatch");

        // ✅ Return total commission amount sent to Diamond
        return platformCommissionAmount;
    }

    /**
     * @notice Syncs local advertisement lifecycle state from the Diamond's canonical AdvertStruct.
     * @dev Only callable by the Diamond owner. One-directional: Diamond → local only.
     *      Fields startDeprecatedBlock and withdrawnAtBlock are local-only and are not affected.
     */
    function syncFromDiamond() external {
        address diamondOwner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == diamondOwner, "Only Diamond owner can sync");

        (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory canonicalAdvert, ) = IOpenAdvertsAdvertisersFacet(diamond)
            .getAdvertisementDetailsAndStatus(address(this));

        advertInfo.AdvertisementType = canonicalAdvert.AdvertisementType;
        advertInfo.pausedAtBlock = canonicalAdvert.pausedAtBlock;
        advertInfo.withdrawalAvailableBlock = canonicalAdvert.withdrawalAvailableBlock;
        advertInfo.advertFavorableScore = canonicalAdvert.advertFavorableScore;
        advertInfo.advertUnfavorableScore = canonicalAdvert.advertUnfavorableScore;
        advertInfo.isPaused = canonicalAdvert.isPaused;
        isPaused = canonicalAdvert.isPaused;
    }

    /**
     * @notice Deprecates the advertisement contract using embedded interfaces
     * @dev ✅ SECURITY: Uses embedded interfaces instead of direct storage access
     */
    function deprecateAdvert() external {
        // LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address diamondOwner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == issuerCompany || msg.sender == diamondOwner, "Only advertisement owner can deprecate");
        require(!isPaused, "Advertisement is already deprecated");

        // ✅ FIXED: Use embedded interface to check advertisement status
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        if (
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating ||
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn
        ) {
            revert("Advertisement is already deprecated or withdrawn");
        }

        // ✅ PROSPECT HANDLING: Call revokeProspectAdvert for prospect advertisements
        if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            revokeProspectAdvert();
            return;
        }

        // ✅ FIXED: Use embedded interface to get cooldown blocks
        uint256 cooldownBlocks = IOpenAdvertsGovernanceFacet(diamond).getAdvertPauseCooldownBlocks();
        require(cooldownBlocks > 0, "Governance cooldown not configured");

        uint256 newStartDeprecatedBlock = block.number;

        // If designated affiliate is Banned, allow cooldown-free withdrawal
        LibOpenAdvertsAffiliatesStorage.AffiliateType affiliateStatus = IOpenAdvertsAffiliatesFacet(diamond).getAffiliateStatus(designatedAffiliate);
        uint256 newWithdrawnAtBlock;
        if (affiliateStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            newWithdrawnAtBlock = block.number; // No cooldown
        } else {
            newWithdrawnAtBlock = newStartDeprecatedBlock + cooldownBlocks;
        }

        // ✅ DIAMOND UPDATE: Call Diamond first — revert before any local state change
        IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), true, newStartDeprecatedBlock, newWithdrawnAtBlock);

        // ✅ DIAMOND RECLASSIFICATION: Notify Diamond to reclassify advertisement
        IOpenAdvertsAdvertisersFacet(diamond).reclassifyAdvertisement(
            address(this),
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved, // From Approved
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating, // To Deprecating
            0, // No score change
            0 // No score change
        );

        // LOCAL STATE: Update only after Diamond calls succeed
        isPaused = true;
        startDeprecatedBlock = newStartDeprecatedBlock;
        withdrawnAtBlock = newWithdrawnAtBlock;

        // ✅ UPDATE STRUCT: Update local advertInfo struct
        advertInfo.isPaused = true;
        advertInfo.pausedAtBlock = newStartDeprecatedBlock;
        advertInfo.withdrawalAvailableBlock = newWithdrawnAtBlock;
        advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating;

        emit AdvertDeprecated(address(this), startDeprecatedBlock, withdrawnAtBlock);
    }

    /**
     * @notice Revokes a prospect advertisement and immediately refunds all balance
     * @dev Only the advertisement owner can call this function
     * @dev This function immediately returns all USDC funds and moves advert from Prospect to Withdrawn
     * 🔄 DIFFERENCE: Uses USDC safeTransfer instead of POL transfer
     */
    function revokeProspectAdvert() public nonReentrant {
        address diamondOwner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == issuerCompany || msg.sender == diamondOwner, "Only advertisement owner can revoke prospect advert");

        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );
        // LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
        //     .openAdvertsAdvertisersStorage();

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, "Only prospect advertisements can be revoked");

        // 🔄 DIFFERENCE: Get USDC balance instead of POL balance (net of Phase 1B pending escrow)
        uint256 balance = usdcToken.balanceOf(address(this)) - totalPendingWithdrawals;
        require(balance > 0, "No USDC funds available for refund");

        // uint256 index = storageData.advertisementIndex[address(this)];

        uint256 newStartDeprecatedBlock = block.number;
        uint256 newWithdrawnAtBlock = block.number;

        // ✅ DIAMOND UPDATE: Call Diamond first — revert before any local state change
        IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), true, newStartDeprecatedBlock, newWithdrawnAtBlock);

        // ✅ DIAMOND RECLASSIFICATION: Notify Diamond to reclassify from Prospect to Withdrawn
        IOpenAdvertsAdvertisersFacet(diamond).reclassifyAdvertisement(
            address(this),
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, // From Prospect
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn, // To Withdrawn
            0, // No score change
            0 // No score change
        );

        // LOCAL STATE: Update only after Diamond calls succeed
        isPaused = true;
        startDeprecatedBlock = newStartDeprecatedBlock;
        withdrawnAtBlock = newWithdrawnAtBlock;

        // ✅ UPDATE STRUCT: Update local advertInfo struct
        advertInfo.isPaused = true;
        advertInfo.pausedAtBlock = newStartDeprecatedBlock;
        advertInfo.withdrawalAvailableBlock = newWithdrawnAtBlock;
        advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;

        // 🔄 IMMEDIATE REFUND: Transfer USDC to issuer
        usdcToken.safeTransfer(issuerCompany, balance);

        emit ProspectAdvertRevoked(address(this), issuerCompany, balance);
    }

    /**
     * @notice Refunds USDC funds when removing a prospect advertisement (called by Diamond)
     * @dev Only callable by Diamond contract during removal process
     * @return refundedAmount The amount of USDC refunded to the advertiser
     */
    function removeAndRefund() external nonReentrant returns (uint256 refundedAmount) {
        require(msg.sender == diamond, "Only Diamond can call this function");

        // Check it's still a Prospect
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, "Only prospect advertisements can be removed");

        // Get USDC balance (net of Phase 1B pending escrow)
        uint256 balance = usdcToken.balanceOf(address(this)) - totalPendingWithdrawals;

        // Refund immediately (no cooldown for removal)
        if (balance > 0) {
            usdcToken.safeTransfer(issuerCompany, balance);
            refundedAmount = balance;
        }

        return refundedAmount;

        // // ✅ Get the advertisement struct and update it
        // LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertStruct = storageData.prospectAdvertisements[index];
        // advertStruct.isPaused = true;
        // advertStruct.pausedAtBlock = block.number;
        // advertStruct.withdrawalAvailableBlock = block.number;
        // advertStruct.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;

        // // ✅ Add to withdrawn array
        // storageData.withdrawnAdvertisements.push(advertStruct);
        // storageData.advertisementIndex[address(this)] = storageData.withdrawnAdvertisements.length - 1;

        // // ✅ Remove from prospect array (swap and pop)
        // uint256 lastIndex = storageData.prospectAdvertisements.length - 1;
        // if (index != lastIndex) {
        //     storageData.prospectAdvertisements[index] = storageData.prospectAdvertisements[lastIndex];
        //     address lastAdvertAddress = storageData.prospectAdvertisements[index].advertContractAddress;
        //     storageData.advertisementIndex[lastAdvertAddress] = index;
        // }
        // storageData.prospectAdvertisements.pop();

        // // Update status mapping
        // storageData.advertisementStatus[address(this)] = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;

        // // 🔄 DIFFERENCE: Transfer USDC using safeTransfer instead of POL transfer
        // usdcToken.safeTransfer(issuerCompany, balance);

        // emit ProspectAdvertRevoked(address(this), issuerCompany, balance);
    }

    /**
     * @notice Withdraws remaining USDC funds to the advertisement owner
     * @dev Only the advertisement owner can call this function and only after cooldown period
     * 🔄 DIFFERENCE: Uses USDC safeTransfer instead of POL transfer
     */
    function withdrawFunds() external nonReentrant {
        require(msg.sender == issuerCompany, "Only advertisement owner can withdraw funds");
        // Note: admin refund capability deferred — would require governance proposal
        require(isPaused, "Advertisement must be deprecated before withdrawal");
        require(block.number >= withdrawnAtBlock, "Cooldown period has not elapsed");

        // 🔄 DIFFERENCE: Get USDC balance instead of POL balance (net of Phase 1B pending escrow)
        uint256 balance = usdcToken.balanceOf(address(this)) - totalPendingWithdrawals;
        require(balance > 0, "No USDC funds available for withdrawal");

        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        // ✅ RECLASSIFY: Move from Deprecating to Withdrawn if needed
        if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            // ✅ DIAMOND UPDATE: Call Diamond first — revert before any local state change
            IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), isPaused, startDeprecatedBlock, withdrawnAtBlock);

            // ✅ DIAMOND RECLASSIFICATION: Notify Diamond to reclassify
            IOpenAdvertsAdvertisersFacet(diamond).reclassifyAdvertisement(
                address(this),
                LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating, // From Deprecating
                LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn, // To Withdrawn
                0, // No score change
                0 // No score change
            );

            // LOCAL STATE: Update only after Diamond calls succeed
            advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;
        }

        // 🔄 TRANSFER: Send USDC to issuer
        usdcToken.safeTransfer(issuerCompany, balance);
        emit FundsWithdrawn(issuerCompany, balance);

        // LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
        //     .openAdvertsAdvertisersStorage();

        // if (storageData.advertisementStatus[address(this)] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
        //     uint256 index = storageData.advertisementIndex[address(this)];

        //     // ✅ Get the advertisement struct and update it
        //     LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertStruct = storageData.deprecatingAdvertisements[index];
        //     advertStruct.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;

        //     // ✅ Add to withdrawn array
        //     storageData.withdrawnAdvertisements.push(advertStruct);
        //     storageData.advertisementIndex[address(this)] = storageData.withdrawnAdvertisements.length - 1;

        //     // ✅ Remove from deprecating array (swap and pop)
        //     uint256 lastIndex = storageData.deprecatingAdvertisements.length - 1;
        //     if (index != lastIndex) {
        //         storageData.deprecatingAdvertisements[index] = storageData.deprecatingAdvertisements[lastIndex];
        //         address lastAdvertAddress = storageData.deprecatingAdvertisements[index].advertContractAddress;
        //         storageData.advertisementIndex[lastAdvertAddress] = index;
        //     }
        //     storageData.deprecatingAdvertisements.pop();

        //     // Update status mapping
        //     storageData.advertisementStatus[address(this)] = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;
        // }

        // // 🔄 DIFFERENCE: Transfer USDC using safeTransfer instead of POL transfer
        // usdcToken.safeTransfer(issuerCompany, balance);
        // emit FundsWithdrawn(issuerCompany, balance);
    }

    /**
     * @notice Phase 1B pull-payment: recipient claims USDC that was escrowed when an
     *         earlier push-transfer from _processUSDCTransfers failed (e.g. blacklisted
     *         address, hostile token hook).
     * @dev Checks-effects-interactions. Guarded by nonReentrant. Uses safeTransfer so
     *      any failure here reverts and leaves the escrow intact for a retry.
     */
    function withdrawPendingPayout() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No pending payout");
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;

        usdcToken.safeTransfer(msg.sender, amount);

        emit PendingPayoutWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Checks if withdrawal is currently available
     * @return True if withdrawal is available, false otherwise
     */
    function isWithdrawalAvailable() external view returns (bool) {
        return isPaused && block.number >= withdrawnAtBlock;
    }

    /**
     * @notice Returns key contract variables including USDC balance
     * @return rspContractIssuer The issuer company address.
     * @return rspAdvertbudget The current USDC balance of the contract.
     * @return rspInitialFundedBudget The initial USDC funding set at deployment (micro USDC).
     * @return rspadvertInfo The advertisement contract information.
     * @return diamondaddress The Diamond contract address.
     * @return payoutToken The currency used for payouts (USDC).
     */
    function getAllContractVariables()
        public
        view
        returns (
            address rspContractIssuer,
            uint256 rspAdvertbudget,
            uint256 rspInitialFundedBudget,
            LibOpenAdvertsAdvertisersStorage.AdvertStruct memory rspadvertInfo,
            address diamondaddress,
            string memory payoutToken
        )
    {
        return (issuerCompany, usdcToken.balanceOf(address(this)), initialFundedBudgetMicroUSDC, advertInfo, diamond, payoutCurrency);
    }

    /**
     * @notice Gets the current USDC balance of this contract
     * @return The USDC balance in USDC units (6 decimals)
     */
    function getUSDCBalance() public view returns (uint256) {
        return usdcToken.balanceOf(address(this));
    }

    /**
     * @notice Gets the initial USDC funding set at deployment
     * @return The initial USDC funding in micro USDC (6 decimals)
     */
    function getInitialFundedBudgetMicroUSDC() public view returns (uint256) {
        return initialFundedBudgetMicroUSDC;
    }

    /**
     * @notice Retrieves the nonce for a given affiliate for the calling user.
     * @param _affiliateAddress The address of the affiliate.
     * @return The current nonce value.
     */
    function getUserNonceOfAffiliate(address _affiliateAddress) public view returns (uint256) {
        return userAffiliateNonces[msg.sender][_affiliateAddress];
    }

    /**
     * @notice Gets pause and deprecation information in a single call
     * @return paused True if the advertisement is paused/deprecated
     * @return deprecatedBlock The block number when deprecation occurred (0 if not deprecated)
     * @return withdrawalBlock The block number when funds can be withdrawn (0 if not deprecated)
     */
    function getPauseAndDeprecationInfo() external view returns (bool paused, uint256 deprecatedBlock, uint256 withdrawalBlock) {
        return (isPaused, startDeprecatedBlock, withdrawnAtBlock);
    }

    /**
     * @notice One-call aggregate getter for the frontend row-detail expansion in PAbout.
     * @dev Pure read aggregator over already-public state; no auth required, no state
     *      changes. `isWithdrawalAvailable` mirrors the standalone `isWithdrawalAvailable()`
     *      function (`isPaused && block.number >= withdrawnAtBlock`).
     * @return details Aggregated row-detail data; deprecation block numbers live inside
     *         `details.pauseInfo` (no top-level duplication).
     */
    function getAdvertRowDetails() external view returns (AdvertRowDetails memory details) {
        details.pauseInfo = PauseAndDeprecationInfo({
            isPaused: isPaused,
            startDeprecatedBlock: startDeprecatedBlock,
            withdrawnAtBlock: withdrawnAtBlock
        });
        details.isWithdrawalAvailable = isPaused && block.number >= withdrawnAtBlock;
        details.totalPendingWithdrawals = totalPendingWithdrawals;
        details.issuerCompany = issuerCompany;
    }

    /**
     * @dev Extracted to reduce stack depth in processReward
     * @return filteredSignatures Valid signatures after filtering
     * @return filteredBlockNumbers Valid block numbers after filtering
     * @return filteredThirdPartyAddresses Valid third party addresses after filtering
     * @return finalRejectionReasons Array of rejection reasons
     * @return signaturesOffered Total number of signatures offered
     * @return signaturesRejected Number of signatures rejected
     */
    function _filterAndTrackSignatures(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddresses
    )
        internal
        view
        returns (
            bytes[] memory filteredSignatures,
            uint256[] memory filteredBlockNumbers,
            LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory filteredThirdPartyAddresses,
            string[] memory finalRejectionReasons,
            uint256 signaturesOffered,
            uint256 signaturesRejected
        )
    {
        signaturesOffered = signatures.length;

        // ✅ Temporary array for tracking rejections
        string[] memory rejectionReasons = new string[](signaturesOffered);
        uint256 rejectionCount = 0;

        // ✅ Filter based on deprecation status
        if (isPaused && startDeprecatedBlock > 0) {
            // Count valid signatures
            uint256 validCount = 0;
            for (uint256 i = 0; i < blockNumbers.length; i++) {
                if (blockNumbers[i] <= startDeprecatedBlock) {
                    validCount++;
                } else {
                    // Track rejection
                    rejectionReasons[rejectionCount] = string(
                        abi.encodePacked(
                            "Sig #",
                            _toString(i),
                            ": Block ",
                            _toString(blockNumbers[i]),
                            " > deprecated block ",
                            _toString(startDeprecatedBlock)
                        )
                    );
                    rejectionCount++;
                }
            }

            // Create filtered arrays
            filteredSignatures = new bytes[](validCount);
            filteredBlockNumbers = new uint256[](validCount);
            filteredThirdPartyAddresses = new LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[](validCount);

            uint256 filteredIndex = 0;
            for (uint256 i = 0; i < blockNumbers.length; i++) {
                if (blockNumbers[i] <= startDeprecatedBlock) {
                    filteredSignatures[filteredIndex] = signatures[i];
                    filteredBlockNumbers[filteredIndex] = blockNumbers[i];
                    filteredThirdPartyAddresses[filteredIndex] = thirdPartyAddresses[i];
                    filteredIndex++;
                }
            }

            require(validCount > 0, "No valid signatures found - all block numbers are after advertisement deprecation");
        } else {
            // Use original arrays if not paused
            filteredSignatures = signatures;
            filteredBlockNumbers = blockNumbers;
            filteredThirdPartyAddresses = thirdPartyAddresses;
        }

        signaturesRejected = rejectionCount;

        // Resize rejection reasons array
        finalRejectionReasons = new string[](rejectionCount);
        for (uint256 i = 0; i < rejectionCount; i++) {
            finalRejectionReasons[i] = rejectionReasons[i];
        }

        return (filteredSignatures, filteredBlockNumbers, filteredThirdPartyAddresses, finalRejectionReasons, signaturesOffered, signaturesRejected);
    }

    /**
     * @notice Calculates the breakdown of payouts by recipient type
     * @param payoutData The payout data from Diamond
     * @return breakdown Structured breakdown of amounts
     */
    function _calculatePayoutBreakdown(
        LibOpenAdvertsPayoutStorage.PayoutData memory payoutData,
        address affiliateAddress,
        address viewerAddress
    ) internal view returns (PayoutBreakdown memory breakdown) {
        // LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        address storageProviderAddress = IOpenAdvertsPayoutFacet(diamond).getStorageProviderAddress();

        for (uint256 i = 0; i < payoutData.recipients.length; i++) {
            address recipient = payoutData.recipients[i];
            uint256 amount = payoutData.amounts[i];

            if (recipient == viewerAddress) {
                // Viewer
                breakdown.viewerAmount += amount;
            } else if (storageProviderAddress != address(0) && recipient == storageProviderAddress) {
                // Storage provider
                breakdown.storageProviderAmount += amount;
            } else if (recipient == affiliateAddress) {
                // ✅ DIRECT COMPARISON!
                // Affiliate - we KNOW this because we check the address directly
                breakdown.affiliateAmount += amount;
            } else {
                // Everything else is third party
                breakdown.thirdPartyAmount += amount;
            }
        }

        return breakdown;
    }

    /**
     * @notice Processes USDC transfers to recipients based on payout data from Diamond contract
     * @param payoutData The payout data containing recipients and amounts
     * @param affiliateReceivingAddress The affiliate address for event logging
     * @param processedSignaturesCount Number of signatures processed for event logging
     */
    function _processUSDCTransfers(
        LibOpenAdvertsPayoutStorage.PayoutData memory payoutData,
        address affiliateReceivingAddress,
        uint256 processedSignaturesCount
    ) internal {
        // No minimum signature count enforced on-chain; threshold enforcement is handled off-chain.
        require(payoutData.totalAmount <= usdcToken.balanceOf(address(this)) - totalPendingWithdrawals, "Insufficient USDC balance for payouts");
        require(payoutData.recipients.length == payoutData.amounts.length, "Recipients and amounts length mismatch");
        // ✅ INTENTIONAL (currency-specific): USDC uses ERC-20 transfers (~30–65k gas each), far
        // costlier than POL's native sends (~9–21k). This 100-recipient ceiling keeps a single
        // USDC payout batch comfortably within Polygon's ~30M block gas limit. It is deliberately
        // TIGHTER than the governance maxSignaturesPerBatch (default 50): a batch whose unique
        // recipients (viewer + affiliate + up to 6 TP/sig, deduplicated) would exceed 100 must be
        // split by the caller. Do NOT remove this to "match" the uncapped POL contract — the gas
        // asymmetry is the reason it exists. See PROJECTDOCS "Batch Processing".
        require(payoutData.recipients.length <= 100, "Too many recipients - gas limit protection");

        uint256 actualTransferred = 0;

        // ✅ Phase 1B: Pull-payment pattern. A single hostile token hook or blacklisted
        // address must not DoS the whole batch. Try the transfer; on revert or bool=false,
        // escrow in pendingWithdrawals for the recipient to pull via withdrawPendingPayout().
        for (uint256 i = 0; i < payoutData.recipients.length; i++) {
            uint256 amount = payoutData.amounts[i];
            if (amount == 0) continue;
            address recipient = payoutData.recipients[i];

            bool ok;
            try usdcToken.transfer(recipient, amount) returns (bool result) {
                ok = result;
            } catch {
                ok = false;
            }
            if (ok) {
                actualTransferred += amount;
            } else {
                pendingWithdrawals[recipient] += amount;
                totalPendingWithdrawals += amount;
                actualTransferred += amount;
                emit PayoutPending(recipient, amount);
            }
        }

        // add that when usdc is depleted emit AdvertExhausted event
        if (usdcToken.balanceOf(address(this)) - totalPendingWithdrawals < advertInfo.advertBounty) {
            (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond)
                .getAdvertisementDetailsAndStatus(address(this));

            if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
                // LOCAL STATE: Update local struct
                advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted;

                // DIAMOND RECLASSIFICATION: Notify Diamond to reclassify to Exhausted
                IOpenAdvertsAdvertisersFacet(diamond).reclassifyAdvertisement(
                    address(this),
                    LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved, // From Approved
                    LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted, // To Exhausted
                    0, // No score change
                    0 // No score change
                );

                // Emit exhaustion event
                emit AdvertExhausted(address(this));
            }
        }

        // call a function in the diamond to update aggregate USDC rewards

        // Per-payout audit manifest: index-aligned (recipient, amount) allocation for this call.
        emit PayoutManifest(affiliateReceivingAddress, payoutData.recipients, payoutData.amounts);

        // Emit event showing USDC transfers completed
        emit USDCTransfersCompleted(affiliateReceivingAddress, processedSignaturesCount, actualTransferred);
    }

    /**
     * @notice Converts uint256 to string for error messages
     */
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
// ✅ NEW: Filter out signatures with block numbers after deprecation if advertisement is paused
// bytes[] memory filteredSignatures;
// uint256[] memory filteredBlockNumbers;
// LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory filteredThirdPartyAddresses;

// if (isPaused && startDeprecatedBlock > 0) {
//     // ✅ Count valid signatures (block numbers before or equal to deprecation block)
//     uint256 validCount = 0;
//     for (uint256 i = 0; i < blockNumbers.length; i++) {
//         if (blockNumbers[i] <= startDeprecatedBlock) {
//             validCount++;
//         }
//     }

//     // ✅ Create filtered arrays with only valid signatures
//     filteredSignatures = new bytes[](validCount);
//     filteredBlockNumbers = new uint256[](validCount);
//     filteredThirdPartyAddresses = new LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[](validCount);

//     uint256 filteredIndex = 0;
//     for (uint256 i = 0; i < blockNumbers.length; i++) {
//         if (blockNumbers[i] <= startDeprecatedBlock) {
//             filteredSignatures[filteredIndex] = signatures[i];
//             filteredBlockNumbers[filteredIndex] = blockNumbers[i];
//             filteredThirdPartyAddresses[filteredIndex] = thirdPartyAddresses[i];
//             filteredIndex++;
//         }
//     }

//     // ✅ Ensure we have at least one valid signature after filtering
//     require(validCount > 0, "No valid signatures found - all block numbers are after advertisement deprecation");
// } else {
//     // ✅ Use original arrays if advertisement is not paused
//     filteredSignatures = signatures;
//     filteredBlockNumbers = blockNumbers;
//     filteredThirdPartyAddresses = thirdPartyAddresses;
// }
// /**
//  * @notice Deprecates the advertisement contract, making it unavailable for new rewards
//  * @dev Only the advertisement owner (issuer company) can call this function
//  */
// function deprecateAdvert() external {
//     require(msg.sender == issuerCompany, "Only advertisement owner can deprecate");
//     require(!isPaused, "Advertisement is already deprecated");

//     LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
//         .openAdvertsAdvertisersStorage();
//     LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

//     // ✅ Check if this is a Prospect advertisement and call revokeProspectAdvert instead
//     if (storageData.advertisementStatus[address(this)] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
//         revokeProspectAdvert();
//         return;
//     }

//     // Get governance storage to access cooldown blocks
//     uint256 cooldownBlocks = govStorage.currentQuotas.advertPauseCooldownBlocks;

//     // Set deprecation state
//     isPaused = true;
//     startDeprecatedBlock = block.number;
//     withdrawnAtBlock = block.number + cooldownBlocks;

//     // ✅ Update only Approved advertisements (Prospect case handled above)
//     if (storageData.advertisementStatus[address(this)] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
//         uint256 index = storageData.advertisementIndex[address(this)];

//         LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertStruct = storageData.approvedAdvertisements[index];

//         advertStruct.isPaused = true;
//         advertStruct.pausedAtBlock = block.number;
//         advertStruct.withdrawalAvailableBlock = block.number + cooldownBlocks;
//         advertStruct.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating;

//         storageData.deprecatingAdvertisements.push(advertStruct);
//         storageData.advertisementIndex[address(this)] = storageData.deprecatingAdvertisements.length - 1;

//         uint256 lastIndex = storageData.approvedAdvertisements.length - 1;
//         if (index != lastIndex) {
//             storageData.approvedAdvertisements[index] = storageData.approvedAdvertisements[lastIndex];
//             address lastAdvertAddress = storageData.approvedAdvertisements[index].advertContractAddress;
//             storageData.advertisementIndex[lastAdvertAddress] = index;
//         }
//         storageData.approvedAdvertisements.pop();
//     }

//     storageData.advertisementStatus[address(this)] = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating;

//     emit AdvertDeprecated(address(this), startDeprecatedBlock, withdrawnAtBlock);
// }
// /**
//  * @notice Checks if the advertisement is currently paused/deprecated
//  * @return True if the advertisement is paused, false otherwise
//  */
// function getIsPaused() external view returns (bool) {
//     return isPaused;
// }

// /**
//  * @notice Gets the block number when the advertisement was deprecated
//  * @return The block number when deprecation occurred (0 if not deprecated)
//  */
// function getStartDeprecatedBlock() external view returns (uint256) {
//     return startDeprecatedBlock;
// }

// /**
//  * @notice Gets the block number when withdrawal becomes available
//  * @return The block number when funds can be withdrawn (0 if not deprecated)
//  */
// function getWithdrawnAtBlock() external view returns (uint256) {
//     return withdrawnAtBlock;
// }
// /**
//  * @notice Check if contract has sufficient USDC for a payout
//  * @param requiredAmount The amount of USDC required
//  * @return True if contract has sufficient USDC balance
//  */
// function hasSufficientUSDC(uint256 requiredAmount) public view returns (bool) {
//     return usdcToken.balanceOf(address(this)) >= requiredAmount;
// }

// /**
//  * @notice Emergency function to return unused USDC to issuer - ADMIN/OWNER ONLY
//  * @dev Only the Diamond contract owner can call this function
//  */
// function returnUnusedUSDC() external nonReentrant {
//     require(msg.sender == LibDiamond.diamondStorage().contractOwner, "Only Diamond owner can recall USDC");

//     uint256 balance = usdcToken.balanceOf(address(this));
//     if (balance > 0) {
//         usdcToken.safeTransfer(issuerCompany, balance);
//     }
// }

// /**
//  * @notice Fund the contract with USDC - convenience function for direct funding
//  * @param amount The amount of USDC to transfer to this contract
//  */
// function fundContract(uint256 amount) external {
//     require(amount > 0, "Must specify amount to fund contract");
//     usdcToken.safeTransferFrom(msg.sender, address(this), amount);
// }
