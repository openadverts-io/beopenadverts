// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "./libraries/LibOpenAdvertsPayoutStorage.sol";
import "./libraries/LibDiamond.sol";
import "./libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "./Diamond.sol";

// Interface for the payout facet implemented in the Diamond contract
interface IOpenAdvertsPayoutFacet {
    function claimReward(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.VerificationDataStruct memory verificationData,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddresses,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvertContractRef,
        uint256 remainingBudget,
        address advertContractAddress
    ) external payable returns (LibOpenAdvertsPayoutStorage.PayoutData memory payoutData);

    function getStorageProviderAddress() external view returns (address);
}

interface IOpenAdvertsAdvertisersFacet {
    function getAdvertisementDetailsAndStatus(
        address advertContract
    ) external view returns (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory, LibOpenAdvertsAdvertisersStorage.AdvertisementType);

    function updateAdvertisementData(address advertContract, bool isPaused, uint256 pausedAtBlock, uint256 withdrawalAvailableBlock) external;

    // ✅ ADD: Function to reclassify advertisement status
    function reclassifyAdvertisement(
        address advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType newStatus,
        uint256 favorableScoreChange,
        uint256 unfavorableScoreChange
    ) external;

    function returnAdvertisementCommissioned(address advertContract) external view returns (bool);
}

interface IOpenAdvertsGovernanceFacet {
    function getAdvertPauseCooldownBlocks() external view returns (uint256);
    function getPlatformAndAdminCommissions() external view returns (uint256 platformCommission, uint256 adminCommissionFromADVC);
    function getMaxSignaturesPerBatch() external view returns (uint256);
}

// ✅ ADD: New interface function to get Diamond owner
interface IOpenAdvertsDiamondOwnership {
    function owner() external view returns (address);
}

interface IOpenAdvertsAffiliatesFacet {
    function getAffiliateStatus(address affiliateAddress) external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateType);
}

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

/// @title OpenAdvertsAdvertPOL Contract
/// @notice This contract represents an advertisement contract which uses native POL for rewards.
contract OpenAdvertsAdvertPOL is ReentrancyGuard {
    using LibOpenAdvertsAdvertisersStorage for LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct;
    using LibOpenAdvertsPayoutStorage for LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct;

    // Address of the Diamond contract which aggregates facets
    address public diamond;

    string public payoutCurrency = "POL";

    // Storage struct containing advertisement contract information.
    LibOpenAdvertsAdvertisersStorage.AdvertStruct advertInfo;

    // The company that issued this advertisement contract.
    address public issuerCompany;

    // Initial POL funding set at deployment time (wei).
    uint256 public immutable initialFundedBudgetWei;

    bool public isPaused; // double info (redundant but useful for quick access)
    uint256 public startDeprecatedBlock;
    uint256 public withdrawnAtBlock;

    event AdvertDeprecated(address indexed advertContract, uint256 deprecatedAtBlock, uint256 withdrawalAvailableAtBlock);
    event ProspectAdvertRevoked(address indexed advertContract, address indexed advertOwner, uint256 refundedAmount);
    event FundsWithdrawn(address indexed advertOwner, uint256 amount);

    // Event emitted when the advertisement contract balance is exhausted during fund transfers.
    event AdvertExhausted(address advertContractAddress);

    // Event emitted when POL transfers are completed
    event POLTransfersCompleted(address indexed affiliateReceivingAddress, uint256 processedSignaturesCount, uint256 totalTransferred);

    // ✅ Phase 1B: Pull-payment pattern events
    event PayoutPending(address indexed recipient, uint256 amount);
    event PendingPayoutWithdrawn(address indexed recipient, uint256 amount);

    // Per-payout audit manifest: emitted once per processReward with the full, index-aligned
    // (recipient, amount) allocation for that call. recipients[i] is paid amounts[i] (both arrays
    // are deduplicated and zero-trimmed upstream in claimReward, so every entry is a distinct
    // payee with amount > 0). This is the amount each recipient is ENTITLED to: on a successful
    // push they receive it; on a failed push it is escrowed and additionally flagged by
    // PayoutPending(recipient, amount). Off-chain: zip(recipients, amounts) to reconstruct who
    // gets what. Single array event (one topic overhead) instead of N per-recipient logs.
    event PayoutManifest(address indexed affiliateReceivingAddress, address[] recipients, uint256[] amounts);

    // The designated affiliate for this advertisement (1:1 binding, set at deployment)
    address public designatedAffiliate;

    // Mapping for nonce tracking for each (user, affiliate) pair.
    mapping(address => mapping(address => uint256)) public userAffiliateNonces;

    // ✅ Phase 1B: Pending payouts escrowed when a push transfer fails (pull-payment pattern)
    mapping(address => uint256) public pendingWithdrawals;
    // Sum of all unclaimed pendingWithdrawals — used to protect advertiser withdraw paths
    // from accidentally sweeping escrowed recipient funds.
    uint256 public totalPendingWithdrawals;

    bool private commissionProcessedLocal;

    /**
     * @notice Constructor sets up the advertisement contract with POL support.
     * @param newAdvertContractRef Reference to the advertisement details.
     * @param _diamondAddress Address of the Diamond contract.
     */
    constructor(LibOpenAdvertsAdvertisersStorage.AdvertStruct memory newAdvertContractRef, address _diamondAddress) payable {
        issuerCompany = newAdvertContractRef.advertOwner;
        advertInfo = newAdvertContractRef;
        diamond = _diamondAddress;
        initialFundedBudgetWei = msg.value;
        designatedAffiliate = newAdvertContractRef.designatedAffiliate;

        isPaused = false;
        startDeprecatedBlock = 0;
        withdrawnAtBlock = 0;
        commissionProcessedLocal = false;
    }

    /**
     * @notice Processes a reward using POL transfers.
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

        // Get current POL balance (net of Phase 1B pending escrow)
        uint256 currentPOLBalance = address(this).balance - totalPendingWithdrawals;
        require(currentPOLBalance > 0, "No POL balance available for payout");

        // ✅ STEP 1: Filter signatures and track rejections
        (
            bytes[] memory filteredSignatures,
            uint256[] memory filteredBlockNumbers,
            LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory filteredThirdPartyAddresses,
            string[] memory rejectionReasons,
            uint256 signaturesOffered,
            uint256 signaturesRejected
        ) = _filterAndTrackSignatures(signatures, blockNumbers, thirdPartyAddresses);

        uint256 signaturesAccepted = filteredSignatures.length;

        // ✅ STEP 2: Call Diamond to get payout data
        LibOpenAdvertsPayoutStorage.PayoutData memory payoutData = IOpenAdvertsPayoutFacet(diamond).claimReward(
            filteredSignatures,
            filteredBlockNumbers,
            verificationData,
            filteredThirdPartyAddresses,
            advertInfo,
            currentPOLBalance,
            address(this)
        );

        // ✅ STEP 3: Calculate breakdown
        PayoutBreakdown memory breakdown = _calculatePayoutBreakdown(
            payoutData,
            verificationData.affiliateReceivingAddress,
            verificationData.viewerAddress
        );

        // ✅ STEP 4: Process POL transfers
        _processPOLTransfers(payoutData, verificationData.affiliateReceivingAddress, signaturesAccepted);

        // ✅ STEP 5: Emit event
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

        // Note: cleanUp() is no longer required — payout accumulation uses in-call memory, not persistent storage.
    }

    // function that will process commission and forwards to Diamond for splitting
    function processCommission() external returns (uint256) {
        // add owner check
        // call owner function from interface
        address owner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == diamond || msg.sender == owner, "Only Diamond or Admin can process commission");
        require(!commissionProcessedLocal, "Commission has already been processed for this advertisement");
        // check if commission has already been processed
        bool commissionProcessedDiamond = IOpenAdvertsAdvertisersFacet(diamond).returnAdvertisementCommissioned(address(this));
        require(!commissionProcessedDiamond, "Commission has already been processed for this advertisement");

        //  Verify advertisement is in Approved status
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved, "Advertisement must be Approved to process commission");

        commissionProcessedLocal = true;

        // fetch platform commission percentage from governance
        (uint256 platformCommission, ) = IOpenAdvertsGovernanceFacet(diamond).getPlatformAndAdminCommissions();

        // get current balance and calculate total platform commission amount (net of pending escrow)
        uint256 currentBalance = address(this).balance - totalPendingWithdrawals;
        uint256 platformCommissionAmount = (currentBalance * platformCommission) / 100;

        require(platformCommissionAmount > 0, "Commission amount must be greater than zero");

        // ✅ REFACTORED: Send entire commission amount to Diamond
        // Diamond's receive() function will automatically split between admin and platform
        (bool success, ) = payable(diamond).call{value: platformCommissionAmount}("");
        require(success, "Commission transfer to Diamond failed");

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
     * Deprecates the advertisement contract using Diamond interface
     * @dev Only the advertisement owner (issuer company) can call this function
     */
    function deprecateAdvert() external {
        // LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address diamondOwner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == issuerCompany || msg.sender == diamondOwner, "Only advertisement owner can deprecate");
        require(!isPaused, "Advertisement is already deprecated");

        // ✅ USE INTERFACE: Check if this is a Prospect advertisement through Diamond interface
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

        uint256 cooldownBlocks = IOpenAdvertsGovernanceFacet(diamond).getAdvertPauseCooldownBlocks();

        require(cooldownBlocks > 0, "Governance cooldown not configured");

        uint256 newStartDeprecatedBlock = block.number;

        // If designated affiliate is Banned, allow cooldown-free withdrawal
        LibOpenAdvertsAffiliatesStorage.AffiliateType affiliateStatus = IOpenAdvertsAffiliatesFacet(diamond).getAffiliateStatus(designatedAffiliate);
        uint256 newWithdrawnAtBlock;
        if (affiliateStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            newWithdrawnAtBlock = block.number; // No cooldown
        } else {
            newWithdrawnAtBlock = block.number + cooldownBlocks;
        }

        // DIAMOND UPDATE: Call Diamond first — revert before any local state change
        IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), true, newStartDeprecatedBlock, newWithdrawnAtBlock);

        // DIAMOND RECLASSIFICATION: Notify Diamond to reclassify advertisement
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

        // UPDATE STRUCT: Update local advertInfo struct
        advertInfo.isPaused = true;
        advertInfo.pausedAtBlock = newStartDeprecatedBlock;
        advertInfo.withdrawalAvailableBlock = newWithdrawnAtBlock;
        advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating;

        emit AdvertDeprecated(address(this), startDeprecatedBlock, withdrawnAtBlock);
    }

    /**
     * FIXED: Revokes a prospect advertisement using Diamond interface
     * @dev Only the advertisement owner can call this function
     * @dev This function immediately returns all funds and moves advert from Prospect to Withdrawn
     */
    function revokeProspectAdvert() public nonReentrant {
        // LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address diamondOwner = IOpenAdvertsDiamondOwnership(diamond).owner();
        require(msg.sender == issuerCompany || msg.sender == diamondOwner, "Only advertisement owner can revoke prospect advert");

        // USE INTERFACE: Check advertisement status through Diamond interface
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, "Only prospect advertisements can be revoked");

        // ✅ Phase 1B: exclude escrowed pending (should be 0 for Prospect, defensive)
        uint256 balance = address(this).balance - totalPendingWithdrawals;
        require(balance > 0, "No funds available for refund");

        uint256 newStartDeprecatedBlock = block.number;
        uint256 newWithdrawnAtBlock = block.number;

        // DIAMOND UPDATE: Call Diamond first — revert before any local state change
        IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), true, newStartDeprecatedBlock, newWithdrawnAtBlock);

        // DIAMOND RECLASSIFICATION: Notify Diamond to reclassify from Prospect to Withdrawn
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

        // UPDATE STRUCT: Update local advertInfo struct
        advertInfo.isPaused = true;
        advertInfo.pausedAtBlock = newStartDeprecatedBlock;
        advertInfo.withdrawalAvailableBlock = newWithdrawnAtBlock;
        advertInfo.AdvertisementType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn;

        // IMMEDIATE REFUND: Transfer balance to issuer via .call
        (bool success, ) = payable(issuerCompany).call{value: balance}("");
        require(success, "Transfer failed");

        emit ProspectAdvertRevoked(address(this), issuerCompany, balance);
    }

    /**
     * @notice Refunds funds when removing a prospect advertisement (called by Diamond)
     * @dev Only callable by Diamond contract during removal process
     * @return refundedAmount The amount of POL refunded to the advertiser
     */
    function removeAndRefund() external nonReentrant returns (uint256 refundedAmount) {
        require(msg.sender == diamond, "Only Diamond can call this function");

        // Check it's still a Prospect
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        require(currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, "Only prospect advertisements can be removed");

        // ✅ Phase 1B: exclude escrowed pending (should be 0 for Prospect, defensive)
        uint256 balance = address(this).balance - totalPendingWithdrawals;

        // Refund immediately (no cooldown for removal)
        if (balance > 0) {
            (bool success, ) = payable(issuerCompany).call{value: balance}("");
            require(success, "Refund transfer failed");
            refundedAmount = balance;
        }

        return refundedAmount;
    }

    /**
     * Withdraws remaining funds using Diamond interface - NO TRY-CATCH
     * @dev Only the advertisement owner can call this function and only after cooldown period
     */
    function withdrawFunds() external nonReentrant {
        require(msg.sender == issuerCompany, "Only advertisement owner can withdraw funds");
        require(isPaused, "Advertisement must be deprecated before withdrawal");
        require(block.number >= withdrawnAtBlock, "Cooldown period has not elapsed");

        // ✅ Phase 1B: Exclude escrowed pending payouts from the advertiser's sweep.
        uint256 balance = address(this).balance - totalPendingWithdrawals;
        require(balance > 0, "No funds available for withdrawal");

        // DIRECT CALL: Check current status through Diamond interface (no try-catch)
        (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(
            address(this)
        );

        // RECLASSIFY: Move from Deprecating to Withdrawn if needed
        if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            // DIAMOND UPDATE: Call Diamond first — revert before any local state change
            IOpenAdvertsAdvertisersFacet(diamond).updateAdvertisementData(address(this), isPaused, startDeprecatedBlock, withdrawnAtBlock);

            // DIAMOND RECLASSIFICATION: Notify Diamond to reclassify (no try-catch)
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

        // TRANSFER: Send funds to issuer via.call
        (bool success, ) = payable(issuerCompany).call{value: balance}("");
        require(success, "Transfer failed");

        emit FundsWithdrawn(issuerCompany, balance);
    }

    /**
     * @notice Phase 1B pull-payment: recipient claims POL that was escrowed when an
     *         earlier push-transfer from _processPOLTransfers failed.
     * @dev Checks-effects-interactions. Guarded by nonReentrant.
     */
    function withdrawPendingPayout() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No pending payout");
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Pending payout transfer failed");

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
     * @notice Returns key contract variables including POL balance
     * @return rspContractIssuer The issuer company address.
     * @return rspAdvertbudget The current POL balance of the contract.
     * @return rspInitialFundedBudget The initial POL funding set at deployment (wei).
     * @return rspadvertInfo The advertisement contract information.
     * @return diamondaddress The Diamond contract address.
     * @return payoutToken The currency used for payouts (POL).
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
        return (issuerCompany, address(this).balance, initialFundedBudgetWei, advertInfo, diamond, payoutCurrency);
    }

    /**
     * @notice Gets the current POL balance of this contract
     * @return The POL balance in wei
     */
    function getPOLBalance() public view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Gets the initial POL funding set at deployment
     * @return The initial POL funding in wei
     */
    function getInitialFundedBudgetWei() public view returns (uint256) {
        return initialFundedBudgetWei;
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
                // ✅ Viewer
                breakdown.viewerAmount += amount;
            } else if (storageProviderAddress != address(0) && recipient == storageProviderAddress) {
                // ✅ Storage provider
                breakdown.storageProviderAmount += amount;
            } else if (recipient == affiliateAddress) {
                // ✅ FIXED: Explicit affiliate address comparison
                breakdown.affiliateAmount += amount;
            } else {
                // ✅ FIXED: Everything else is third party
                breakdown.thirdPartyAmount += amount;
            }
        }
        return breakdown;
    }

    /**
     * @notice Processes POL transfers to recipients based on payout data from Diamond contract
     * @dev Also checks if contract is exhausted after transfers and reclassifies if needed
     * @param payoutData The payout data containing recipients and amounts
     * @param affiliateReceivingAddress The affiliate address for event logging
     * @param processedSignaturesCount Number of signatures processed for event logging
     */
    function _processPOLTransfers(
        LibOpenAdvertsPayoutStorage.PayoutData memory payoutData,
        address affiliateReceivingAddress,
        uint256 processedSignaturesCount
    ) internal {
        require(payoutData.totalAmount <= address(this).balance - totalPendingWithdrawals, "Insufficient POL balance for payouts");
        require(payoutData.recipients.length == payoutData.amounts.length, "Recipients and amounts length mismatch");

        uint256 actualTransferred = 0;

        // ✅ Phase 1B: Pull-payment pattern. A single hostile or gas-heavy recipient must
        // not DoS the whole payout batch. Push with a bounded gas stipend; on failure,
        // escrow the amount in pendingWithdrawals for the recipient to pull via
        // withdrawPendingPayout(). actualTransferred accounts for both push-successful
        // and escrowed amounts (funds have left the "free" balance either way).
        for (uint256 i = 0; i < payoutData.recipients.length; i++) {
            uint256 amount = payoutData.amounts[i];
            if (amount == 0) continue;
            address recipient = payoutData.recipients[i];

            (bool success, ) = payable(recipient).call{value: amount, gas: 50_000}("");
            if (success) {
                actualTransferred += amount;
            } else {
                pendingWithdrawals[recipient] += amount;
                totalPendingWithdrawals += amount;
                actualTransferred += amount;
                emit PayoutPending(recipient, amount);
            }
        }

        // Per-payout audit manifest: index-aligned (recipient, amount) allocation for this call.
        emit PayoutManifest(affiliateReceivingAddress, payoutData.recipients, payoutData.amounts);

        // Emit event showing POL transfers completed
        emit POLTransfersCompleted(affiliateReceivingAddress, processedSignaturesCount, actualTransferred);

        // ✅ CHECK FOR EXHAUSTION: If advertiser-accessible balance is now too low to pay even one more bounty, mark as exhausted
        uint256 remainingBalance = address(this).balance - totalPendingWithdrawals;

        if (remainingBalance < advertInfo.advertBounty) {
            // Get current status
            (, LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus) = IOpenAdvertsAdvertisersFacet(diamond)
                .getAdvertisementDetailsAndStatus(address(this));

            // Only reclassify if currently Approved (don't override Deprecating/Withdrawn)
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

// /**
//  * @notice Fund the contract with POL - convenience function for direct funding
//  */
// function fundContract() external payable {
//     require(msg.value > 0, "Must send POL to fund contract");
//     // POL is automatically added to contract balance via payable function
// }

// function debugDetailedDiamondState()
//     external
//     view
//     returns (
//         bool exists,
//         LibOpenAdvertsAdvertisersStorage.AdvertisementType status,
//         uint256 index,
//         uint256 prospectLength,
//         uint256 approvedLength,
//         uint256 exhaustedLength,
//         uint256 deprecatingLength,
//         uint256 withdrawnLength
//     )
// {
//     // ✅ ACCESS THROUGH DIAMOND: Use Diamond interface instead of direct storage access
//     try IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementExists(address(this)) returns (bool diamondExists) {
//         exists = diamondExists;

//         if (exists) {
//             try IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementDetailsAndStatus(address(this)) returns (
//                 LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertDetails,
//                 LibOpenAdvertsAdvertisersStorage.AdvertisementType advertStatus
//             ) {
//                 status = advertStatus;
//                 // Note: We can't get array lengths and index through current interface
//                 // These would need additional interface functions if required for debugging
//             } catch {
//                 status = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect;
//             }
//         }
//     } catch {
//         exists = false;
//         status = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect;
//     }

//     // ✅ PLACEHOLDER: Array lengths require direct Diamond queries (not POL contract queries)
//     // These should be queried directly from Diamond contract if needed for debugging
//     index = 0;
//     prospectLength = 0;
//     approvedLength = 0;
//     exhaustedLength = 0;
//     deprecatingLength = 0;
//     withdrawnLength = 0;
// }
// /**
//  * @notice Emergency function to return unused POL to issuer - ADMIN/OWNER ONLY
//  * @dev Only the Diamond contract owner can call this function
//  */
// function returnUnusedPOL() external nonReentrant {
//     require(msg.sender == LibDiamond.diamondStorage().contractOwner, "Only Diamond owner can recall POL");

//     uint256 balance = address(this).balance;
//     if (balance > 0) {
//         (bool success, ) = payable(issuerCompany).call{value: balance}("");
//         require(success, "Transfer failed");
//     }
// }
// /**
//  * @notice New function to check if POL contract exists in Diamond (add around line 600)
//  * ✅ NEW: Check if this POL contract exists in Diamond storage
//  * @return True if the advertisement exists in Diamond storage
//  */
// function existsInDiamond() external view returns (bool) {
//     try IOpenAdvertsAdvertisersFacet(diamond).getAdvertisementExists(address(this)) returns (bool exists) {
//         return exists;
//     } catch {
//         return false;
//     }
// }
