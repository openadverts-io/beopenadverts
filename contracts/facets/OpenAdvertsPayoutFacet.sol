// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../libraries/LibOpenAdvertsPayoutStorage.sol";
import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibDiamond.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "../libraries/LibOpenAdvertsTimelockStorage.sol";
import "../libraries/LibOpenAdvertsPauseStorage.sol";

import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOpenAdvertsAdvertisersFacet {
    function reclassifyAdvertisement(
        address advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType fromType,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType toType,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    ) external;
}

interface IClaimPercentagesProvider {
    /**
     * @notice Returns the percentage breakdown for reward claims
     * @return affiliateClaimPercentage Percentage of bounty for affiliate (0-100)
     * @return viewerClaimPercentage Percentage of bounty for viewer (0-100)
     * @return thirdPartyCount Number of third parties (0-6)
     * @return thirdPartyClaimPercentages Array of percentages for each third party (length == thirdPartyCount)
     */
    function getClaimPercentages()
        external
        view
        returns (
            uint256 affiliateClaimPercentage,
            uint256 viewerClaimPercentage,
            uint256 thirdPartyCount,
            uint256[] memory thirdPartyClaimPercentages
        );
}

/**
 * @title OpenAdvertsPayoutFacet
 * @notice Manages the reward claim process by verifying signatures, calculating payouts,
 *         updating accumulated payments, and processing unique payout addresses.
 *
 * @dev The contract maintains a monolithic structure (to limit stack depth) while still
 *      following best practices in naming, variable use, and inline documentation.
 *      It is also protected against reentrancy.
 */
contract OpenAdvertsPayoutFacet is ReentrancyGuard {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // ============================================
    // CUSTOM ERRORS
    // ============================================

    /**
     * @notice Thrown when attempting to process payouts while emergency pause is active
     * @param pausedBy Address that triggered the emergency pause
     * @param pausedAtBlock Block number when pause was activated
     */
    error PayoutsEmergencyPaused(address pausedBy, uint256 pausedAtBlock);

    /**
     * @notice Thrown when attempting to process payouts for a paused affiliate
     * @param affiliate The affiliate address that is paused
     * @param pausedBy Address that paused the affiliate
     * @param pausedAtBlock Block number when affiliate was paused
     */
    error AffiliatePaused(address affiliate, address pausedBy, uint256 pausedAtBlock);
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    using LibOpenAdvertsAdvertisersStorage for LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct;
    using LibOpenAdvertsPayoutStorage for LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct;
    using SafeERC20 for IERC20;

    // All payout accumulation is done in memory per-call; no persistent state needed here.

    // Function to get USDC contract instance
    // function getUSDCToken() internal view returns (IERC20) {
    //     LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
    //         .openAdvertsAdvertisersStorage();
    //     require(storageData.usdcTokenAddress != address(0), "USDC token not initialized");
    //     return IERC20(storageData.usdcTokenAddress);
    // }

    // ============================================
    // CENTRALISED SIGNING ADDRESS
    // ============================================

    /**
     * @notice Set the protocol-level signing address used to verify all reward signatures.
     * @dev Phase 3: dual-auth. Pre-enforcement, owner-direct. Post-enforcement, must be
     *      invoked via OpenAdvertsTimelockFacet.executeOperation.
     * @param newSigner The OpenAdverts signing EOA address.
     */
    function setOpenAdvertsSigningAddress(address newSigner) external {
        _enforceOwnerOrTimelockExec();
        require(newSigner != address(0), "Zero address");
        LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage().openAdvertsSigningAddress = newSigner;
    }

    /**
     * @notice Returns the current protocol-level signing address.
     */
    function getOpenAdvertsSigningAddress() external view returns (address) {
        return LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage().openAdvertsSigningAddress;
    }

    /**
     * @notice Allows the contract owner to change the storage Provider address.
     * @param storageProvider The new signing key.
     */

    function changeStorageProviderAddress(address storageProvider) public {
        LibDiamond.DiamondStorage storage diamondStore = LibDiamond.diamondStorage();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        require(msg.sender == diamondStore.contractOwner, "Only contract owner can change storage provider");
        payoutStore.storageProviderAddress = storageProvider;
    }

    /**
     * @notice Retrieves the current storage provider address.
     * @return The address of the storage provider.
     */
    function getStorageProviderAddress() public view returns (address) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        return payoutStore.storageProviderAddress;
    }

    // ============================================
    // EMERGENCY PAUSE MECHANISM
    // ============================================

    event EmergencyPayoutsPaused(address indexed pausedBy, uint256 pausedAtBlock, string reason);
    event EmergencyPayoutsUnpaused(address indexed unpausedBy, uint256 unpausedAtBlock);

    /**
     * @notice Emergency function to pause all payout operations
     * @dev Only callable by Diamond contract owner. Stops all claimReward calls immediately.
     * @param reason Description of why the emergency pause was triggered
     */
    function emergencyPausePayouts(string memory reason) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        require(!payoutStore.isPayoutsPaused, "Payouts already paused");

        payoutStore.isPayoutsPaused = true;
        payoutStore.pausedAtBlock = block.number;
        payoutStore.pausedBy = msg.sender;

        emit EmergencyPayoutsPaused(msg.sender, block.number, reason);
    }

    /**
     * @notice Resume normal payout operations after emergency pause
     * @dev Only callable by Diamond contract owner
     */
    function emergencyUnpausePayouts() external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        require(payoutStore.isPayoutsPaused, "Payouts not paused");

        payoutStore.isPayoutsPaused = false;
        // Keep pausedAtBlock and pausedBy for audit trail

        emit EmergencyPayoutsUnpaused(msg.sender, block.number);
    }

    /**
     * @notice Get current emergency pause status and details
     * @return isPaused Whether payouts are currently paused
     * @return pausedAt Block number when pause was activated (0 if never paused)
     * @return pausedByAddress Address that triggered the pause (address(0) if never paused)
     */
    function getPayoutPauseStatus() external view returns (bool isPaused, uint256 pausedAt, address pausedByAddress) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        return (payoutStore.isPayoutsPaused, payoutStore.pausedAtBlock, payoutStore.pausedBy);
    }

    // ============================================
    // AFFILIATE-SPECIFIC PAUSE MECHANISM
    // ============================================

    event AffiliatePausedEvent(address indexed affiliate, address indexed pausedBy, uint256 pausedAtBlock);
    event AffiliateUnpaused(address indexed affiliate, address indexed unpausedBy, uint256 unpausedAtBlock);

    /**
     * @notice Pause a specific affiliate from receiving any payouts
     * @dev Owner only. Prevents all signatures from this affiliate from being processed
     * @param affiliate The affiliate address to pause (signing or receiving address)
     */
    function pauseAffiliate(address affiliate) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        require(affiliate != address(0), "Invalid affiliate address");
        require(!payoutStore.pausedAffiliates[affiliate].isPaused, "Affiliate already paused");

        // Add to paused mapping
        payoutStore.pausedAffiliates[affiliate] = LibOpenAdvertsPayoutStorage.AffiliatePauseInfo({
            isPaused: true,
            pausedAtBlock: block.number,
            pausedBy: msg.sender
        });

        // Add to enumeration array
        payoutStore.pausedAffiliateIndex[affiliate] = payoutStore.pausedAffiliatesList.length;
        payoutStore.pausedAffiliatesList.push(affiliate);

        emit AffiliatePausedEvent(affiliate, msg.sender, block.number);
    }

    /**
     * @notice Unpause an affiliate, allowing them to receive payouts again
     * @dev Owner only
     * @param affiliate The affiliate address to unpause
     */
    function unpauseAffiliate(address affiliate) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        require(payoutStore.pausedAffiliates[affiliate].isPaused, "Affiliate not paused");

        // Mark as not paused (keep historical data)
        payoutStore.pausedAffiliates[affiliate].isPaused = false;

        // Remove from enumeration array (swap and pop pattern)
        uint256 index = payoutStore.pausedAffiliateIndex[affiliate];
        uint256 lastIndex = payoutStore.pausedAffiliatesList.length - 1;

        if (index != lastIndex) {
            address lastAffiliate = payoutStore.pausedAffiliatesList[lastIndex];
            payoutStore.pausedAffiliatesList[index] = lastAffiliate;
            payoutStore.pausedAffiliateIndex[lastAffiliate] = index;
        }

        payoutStore.pausedAffiliatesList.pop();
        delete payoutStore.pausedAffiliateIndex[affiliate];

        emit AffiliateUnpaused(affiliate, msg.sender, block.number);
    }

    /**
     * @notice Check if a specific affiliate is currently paused
     * @param affiliate The affiliate address to check
     * @return isPaused Whether the affiliate is paused
     * @return pausedAt Block number when paused (0 if not paused)
     * @return pausedBy Address that paused (address(0) if not paused)
     */
    function getAffiliatePauseStatus(address affiliate) external view returns (bool isPaused, uint256 pausedAt, address pausedBy) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        LibOpenAdvertsPayoutStorage.AffiliatePauseInfo memory info = payoutStore.pausedAffiliates[affiliate];
        return (info.isPaused, info.pausedAtBlock, info.pausedBy);
    }

    /**
     * @notice Get list of all currently paused affiliates
     * @return affiliates Array of paused affiliate addresses
     */
    function getPausedAffiliates() external view returns (address[] memory affiliates) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        return payoutStore.pausedAffiliatesList;
    }

    /**
     * @notice Get detailed pause information for multiple affiliates
     * @param affiliates Array of affiliate addresses to check
     * @return pauseStatuses Array of pause info for each affiliate
     */
    function getMultipleAffiliatePauseStatus(
        address[] memory affiliates
    ) external view returns (LibOpenAdvertsPayoutStorage.AffiliatePauseInfo[] memory pauseStatuses) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        pauseStatuses = new LibOpenAdvertsPayoutStorage.AffiliatePauseInfo[](affiliates.length);
        for (uint256 i = 0; i < affiliates.length; i++) {
            pauseStatuses[i] = payoutStore.pausedAffiliates[affiliates[i]];
        }
        return pauseStatuses;
    }

    /**
     * @notice Processes a reward claim.
     * @param signatures Array of provided signatures.
     * @param blockNumbers Array of block numbers corresponding to each signature.
     * @param verifyData Contains nonce, affiliate addresses, and contract details for verification.
     * @param thirdPartyAddrs Array of third party address structures corresponding to each signature.
     * @param advertInfo Advert details including bounty and minimum block separation.
     * @param remainingBudget The remaining budget available for rewards.
     * @param advertContractAddress The address of the advertisement contract holding USDC.

     * @return payoutData Returns payout data for POL payments, empty for USDC payments.
     */
    function claimReward(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.VerificationDataStruct memory verifyData,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddrs,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertInfo,
        uint256 remainingBudget,
        address advertContractAddress
    ) external nonReentrant returns (LibOpenAdvertsPayoutStorage.PayoutData memory payoutData) {
        // Phase 4 — system-wide emergency pause check (separate from payouts-only pause below).
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");

        // EMERGENCY PAUSE CHECK: Stop all payouts if emergency pause is active
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        if (payoutStore.isPayoutsPaused) {
            revert PayoutsEmergencyPaused(payoutStore.pausedBy, payoutStore.pausedAtBlock);
        }

        // AFFILIATE PAUSE CHECK: Stop payouts for paused affiliates (keyed by receiving address)
        LibOpenAdvertsPayoutStorage.AffiliatePauseInfo memory affiliatePauseInfo = payoutStore.pausedAffiliates[verifyData.affiliateReceivingAddress];
        if (affiliatePauseInfo.isPaused) {
            revert AffiliatePaused(verifyData.affiliateReceivingAddress, affiliatePauseInfo.pausedBy, affiliatePauseInfo.pausedAtBlock);
        }

        // ADD: Comprehensive input validation
        require(signatures.length > 0, "No signatures provided");
        // maxSignaturesPerBatch is enforced by the advert contract before calling claimReward
        require(remainingBudget > 0, "No budget available");
        require(advertContractAddress != address(0), "Invalid advertisement contract");
        require(verifyData.affiliateReceivingAddress != address(0), "Invalid affiliate address");
        require(advertInfo.advertBounty > 0, "Invalid bounty amount");

        // ADD: Validate array lengths match
        require(signatures.length == blockNumbers.length, "Signature/block number length mismatch");
        require(signatures.length == thirdPartyAddrs.length, "Signature/third party address length mismatch");

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage advStore = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(advStore.advertisementExists[msg.sender], "Only registered advertisement contracts can claim rewards");

        // Verify commission has been processed before allowing reward claims
        require(advStore.advertisementCommissioned[msg.sender], "Commission has not been processed");

        // ADD: Verify msg.sender matches advertContractAddress
        require(msg.sender == advertContractAddress, "Caller must be the advertisement contract");

        // Bind the signed advert address to the actual claiming contract so a signature issued for one
        // advert cannot be redeemed at another (defense-in-depth alongside the designated-affiliate and
        // on-chain claim-provider checks).
        require(verifyData.advertismentContractAddress == advertContractAddress, "Advertisement contract mismatch");

        // ADD: Verify advertisement is in Approved status
        require(
            advStore.advertisementStatus[msg.sender] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved ||
                advStore.advertisementStatus[msg.sender] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating,
            "Only approved or deprecating advertisements can claim rewards"
        );

        // DEFENSE-IN-DEPTH: Verify affiliateReceivingAddress matches the advert's designatedAffiliate
        require(
            verifyData.affiliateReceivingAddress == advertInfo.designatedAffiliate,
            "Affiliate must be the designated affiliate for this advertisement"
        );

        // SECURITY (claim-info provider substitution fix): the payout split MUST be sourced from
        // the affiliate's ON-CHAIN registered provider, NOT the caller-supplied
        // verifyData.affiliateClaimInfoAddress. That field is unsigned and previously unvalidated,
        // which let a redeeming viewer (msg.sender) pass a self-deployed IClaimPercentagesProvider
        // returning the signed thirdPartyCount but a skewed split (viewer 100%, affiliate/third
        // parties 0%) and steal the entire bounty. affiliateReceivingAddress is already required
        // == advertInfo.designatedAffiliate above, and the registry record cannot be set or rotated
        // by the viewer, so this closes the substitution vector. verifyData.affiliateClaimInfoAddress
        // is now ignored (retained in the struct for ABI compatibility only).
        address resolvedClaimProvider = _resolveAffiliateClaimProvider(verifyData.affiliateReceivingAddress);

        // Fetch claim percentages from the affiliate's registered provider — single external call,
        // result threaded through all sub-functions so no repeated calls occur.
        (uint256 affiliatePct, uint256 viewerPct, uint256 thirdPartyCount, uint256[] memory thirdPartyPcts) = getClaimPercentages(
            resolvedClaimProvider
        );

        // PRE-VALIDATION: Ensure every submitted signature's third-party slot count
        //    matches the count declared by the provider before any expensive processing.
        for (uint256 i = 0; i < thirdPartyAddrs.length; i++) {
            require(thirdPartyAddrs[i].thirdPartyAddresses.length == thirdPartyCount, "Third party address count mismatch");
        }

        // Pre-allocate memory arrays for this call — no persistent storage required.
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory validSigs = new LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[](
            signatures.length
        );
        uint256 maxUniqueAddrs = 2 + signatures.length * thirdPartyCount;
        address[] memory uniqueAddrs = new address[](maxUniqueAddrs);
        uint256[] memory uniqueAmounts = new uint256[](maxUniqueAddrs);

        // P0.2 — Per-(viewer, advertContract, affiliateReceivingAddress) cooldown check.
        // The viewer cannot have a previously accepted engagement block within the
        // current maxBlockSeparationAdvertisement window for the same
        // (advertContract, affiliateReceivingAddress) tuple. Scoped at this granularity
        // so that cashing one affiliate's signatures does not block another affiliate's
        // claims for the same viewer. Cross-(viewer, advert, affiliate) Sybil attacks
        // are mitigated off-chain by the signing service, not on-chain here.
        {
            // LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStore = LibOpenAdvertsGovernanceStorage.governanceStorage();
            uint256 lastEngagementBlock = payoutStore.viewerLastEngagementBlock[verifyData.viewerAddress][advertContractAddress];
            if (lastEngagementBlock > 0) {
                // Find the earliest engagement block in this batch.
                uint256 minBatchBlock = blockNumbers[0];
                for (uint256 i = 1; i < blockNumbers.length; i++) {
                    if (blockNumbers[i] < minBatchBlock) minBatchBlock = blockNumbers[i];
                }
                require(minBatchBlock > lastEngagementBlock + advertInfo.minBlockNRSeparation, "Viewer global cooldown not elapsed");
            }
        }

        // Budget cap: how many full bounty rewards can we afford from the remaining budget?
        uint256 maxAffordableSigs = remainingBudget / advertInfo.advertBounty;
        if (maxAffordableSigs == 0) {
            _markExhaustedByBudget(advertContractAddress, advStore);
            return LibOpenAdvertsPayoutStorage.PayoutData({recipients: new address[](0), amounts: new uint256[](0), totalAmount: 0});
        }

        // Verify signatures and collect valid third party address data.
        (uint256 validSigCount, uint256 maxValidBlockNumber) = _verifySignatures(
            signatures,
            blockNumbers,
            verifyData,
            thirdPartyAddrs,
            thirdPartyCount,
            advertInfo,
            validSigs,
            maxAffordableSigs
        );

        // If no valid signatures, skip processing — budget was fine, signatures were invalid.
        if (validSigCount == 0) {
            return LibOpenAdvertsPayoutStorage.PayoutData({recipients: new address[](0), amounts: new uint256[](0), totalAmount: 0});
        }

        // If the remaining budget after this batch is less than one full bounty, mark Exhausted now.
        if (remainingBudget - (validSigCount * advertInfo.advertBounty) < advertInfo.advertBounty) {
            _markExhaustedByBudget(advertContractAddress, advStore);
        }

        // Calculate claim amounts and accumulate into memory arrays.
        uint256 uniqueCount = _calculateClaims(
            verifyData.affiliateReceivingAddress,
            affiliatePct,
            viewerPct,
            thirdPartyCount,
            thirdPartyPcts,
            advertInfo.advertBounty,
            verifyData.viewerAddress,
            validSigs,
            validSigCount,
            uniqueAddrs,
            uniqueAmounts
        );

        // P0.2 — Update per-(viewer, advertContract) last-engagement-block
        // to the highest accepted blockNumber in this batch. maxValidBlockNumber is returned
        // directly from _verifySignatures (equals lastProcessedBlockNumber — the highest
        // accepted block, since the within-batch ordering check guarantees monotonic increase).
        // Only valid-signature blocks can advance the cooldown.
        if (validSigCount > 0) {
            payoutStore.viewerLastEngagementBlock[verifyData.viewerAddress][advertContractAddress] = maxValidBlockNumber;
        }

        // Return payout data for POL contracts to handle transfers.
        return _preparePayoutData(uniqueAddrs, uniqueAmounts, uniqueCount);
    }

    /**
     * @notice Resolves the authoritative claim-percentages provider for an affiliate from the
     *         on-chain affiliate registry (LibOpenAdvertsAffiliatesStorage).
     * @dev SECURITY: replaces the previously caller-supplied verifyData.affiliateClaimInfoAddress,
     *      which was unsigned and unvalidated and allowed a redeeming viewer to substitute a rogue
     *      provider and redirect the entire bounty to themselves. The registry record is set once at
     *      affiliate registration (createProspectAffiliateContract) and has no setter to rotate it in
     *      place, so the viewer cannot influence it. Resolution mirrors
     *      OpenAdvertsQueryV2Facet.getRewardSignatureData so the sign-time and redeem-time providers
     *      never drift.
     * @param affiliate The affiliate address (already validated == designatedAffiliate by the caller).
     * @return provider The affiliate's registered IClaimPercentagesProvider address.
     */
    function _resolveAffiliateClaimProvider(address affiliate) internal view returns (address provider) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[affiliate], "Affiliate not registered");

        uint256 idx = afs.affiliateIndex[affiliate];
        LibOpenAdvertsAffiliatesStorage.AffiliateType status = afs.affiliateStatus[affiliate];

        if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            provider = afs.approvedAffiliates[idx].affiliateClaimInfoAddress;
        } else if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            provider = afs.prospectAffiliates[idx].affiliateClaimInfoAddress;
        } else {
            provider = afs.bannedAffiliates[idx].affiliateClaimInfoAddress;
        }
    }

    /**
     * @notice Retrieves claim percentages from affiliate's custom provider contract
     * @dev Makes external call with comprehensive security checks
     * @param claimInfoAddress Address of contract implementing IClaimPercentagesProvider
     * @return affiliatePct Percentage for affiliate (0-100)
     * @return viewerPct Percentage for viewer (0-100)
     * @return thirdPartyCount Number of third parties (0-6)
     * @return thirdPartyPcts Array of percentages for each third party (length == thirdPartyCount)
     */
    function getClaimPercentages(
        address claimInfoAddress
    ) internal view returns (uint256 affiliatePct, uint256 viewerPct, uint256 thirdPartyCount, uint256[] memory thirdPartyPcts) {
        // VALIDATION: Ensure address is provided
        require(claimInfoAddress != address(0), "Invalid claim info address");

        // SECURITY: Try-catch for external call protection
        try IClaimPercentagesProvider(claimInfoAddress).getClaimPercentages() returns (
            uint256 _affiliatePct,
            uint256 _viewerPct,
            uint256 _thirdPartyCount,
            uint256[] memory _thirdPartyPcts
        ) {
            // VALIDATION: Check count is within maximum
            require(_thirdPartyCount <= 6, "Third party count exceeds maximum of 6");

            // VALIDATION: Array length must match declared count
            require(_thirdPartyPcts.length == _thirdPartyCount, "Third party percentages length mismatch");

            // VALIDATION: Check individual percentages and compute sum
            require(_affiliatePct <= 100, "Affiliate percentage too high");
            require(_viewerPct <= 100, "Viewer percentage too high");
            uint256 minViewerPct = LibOpenAdvertsGovernanceStorage.governanceStorage().currentQuotas.minViewerClaimPct;
            require(_viewerPct >= minViewerPct, "Viewer percentage below minimum");

            uint256 totalPct = _affiliatePct + _viewerPct;
            for (uint256 i = 0; i < _thirdPartyCount; i++) {
                require(_thirdPartyPcts[i] <= 100, "Third party percentage too high");
                totalPct += _thirdPartyPcts[i];
            }
            require(totalPct == 100, "Claim percentages must sum to 100");

            return (_affiliatePct, _viewerPct, _thirdPartyCount, _thirdPartyPcts);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("Failed to retrieve claim percentages: ", reason)));
        } catch (bytes memory) {
            revert("Failed to retrieve claim percentages from provider");
        }
    }

    // Assemble final PayoutData from pre-populated memory accumulators.
    function _preparePayoutData(
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts,
        uint256 uniqueCount
    ) internal pure returns (LibOpenAdvertsPayoutStorage.PayoutData memory) {
        address[] memory recipients = new address[](uniqueCount);
        uint256[] memory amounts = new uint256[](uniqueCount);
        uint256 totalAmount = 0;
        uint256 actualRecipients = 0;

        for (uint256 j = 0; j < uniqueCount; ++j) {
            uint256 payoutAmount = uniqueAmounts[j];
            if (payoutAmount > 0) {
                recipients[actualRecipients] = uniqueAddrs[j];
                amounts[actualRecipients] = payoutAmount;
                totalAmount += payoutAmount;
                ++actualRecipients;
            }
        }

        // Trim arrays to actual recipient count.
        if (actualRecipients < uniqueCount) {
            address[] memory finalRecipients = new address[](actualRecipients);
            uint256[] memory finalAmounts = new uint256[](actualRecipients);
            for (uint256 k = 0; k < actualRecipients; k++) {
                finalRecipients[k] = recipients[k];
                finalAmounts[k] = amounts[k];
            }
            recipients = finalRecipients;
            amounts = finalAmounts;
        }

        return LibOpenAdvertsPayoutStorage.PayoutData({recipients: recipients, amounts: amounts, totalAmount: totalAmount});
    }

    event USDCTransferBatch(address indexed advertContract, address indexed affiliateReceiver, uint256 totalTransferred, uint256 recipientCount);

    /**
     * @notice Marks an advertisement as Exhausted when the remaining budget can no longer
     *         fund a full bounty. Safe to call for both Approved and Deprecating adverts.
     */
    function _markExhaustedByBudget(
        address advertContractAddress,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage advStore
    ) internal {
        LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus = advStore.advertisementStatus[advertContractAddress];
        if (
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved ||
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating
        ) {
            IOpenAdvertsAdvertisersFacet(address(this)).reclassifyAdvertisement(
                advertContractAddress,
                currentStatus,
                LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted,
                0,
                0
            );
        }
    }

    /**
     * @notice Verifies each signature against the protocol-level OpenAdverts signing address.
     * @dev Ensures signature array, blockNumbers array, and thirdPartyAddrs array lengths match.
     * @param signatures Array of provided signatures.
     * @param blockNumbers Array of block numbers for each signature.
     * @param verifyData Contains nonce and affiliate information.
     * @param thirdPartyAddrs Array of third party addresses for each signature.
     * @param thirdPartyCount Number of third parties declared by the provider (included in hash).
     * @param advertInfo Contains advert details including the bounty.
     */
    function _verifySignatures(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        LibOpenAdvertsPayoutStorage.VerificationDataStruct memory verifyData,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory thirdPartyAddrs,
        uint256 thirdPartyCount,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertInfo,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory validSigs,
        uint256 maxValidSigs
    ) internal view returns (uint256 validSigCount, uint256 maxValidBlockNumber) {
        validSigCount = 0;
        require(signatures.length == blockNumbers.length, "Mismatched signatures and blockNumbers");
        require(signatures.length == thirdPartyAddrs.length, "Mismatched signatures and thirdPartyAddresses");

        // PROTOCOL SIGNING KEY CHECK: Verify the central signing address is configured.
        address advSigner = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage().openAdvertsSigningAddress;
        require(advSigner != address(0), "OpenAdverts signing key not set");

        // In-memory seen-set for duplicate signature detection (P0.4).
        // Bounded by signatures.length (max 200 per governance quota) — no SSTORE cost.
        bytes32[] memory seenHashes = new bytes32[](signatures.length);
        uint256 seenCount = 0;

        // Within-batch ordering: track the last accepted engagement block to enforce
        // minBlockNRSeparation spacing between consecutive sigs in this batch (P0.1/P0.3).
        // Cross-transaction cooldown is enforced separately in claimReward() via
        // viewerLastEngagementBlock[viewer][advertContract][affiliateReceivingAddress] in PayoutStorage.
        uint256 lastProcessedBlockNumber = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            require(blockNumbers[i] <= block.number, "Block number in the future");
            bytes32 sigHash = keccak256(signatures[i]);

            // P0.4 — duplicate check: skip and record rejection reason.
            bool isDuplicate = false;
            for (uint256 k = 0; k < seenCount; k++) {
                if (seenHashes[k] == sigHash) {
                    isDuplicate = true;
                    break;
                }
            }
            if (isDuplicate) {
                // Caller tracks rejections via the filteredSignatures pattern in the advert
                // contract; silently skip here (consistent with block-separation skip behaviour).
                continue;
            }
            seenHashes[seenCount++] = sigHash;

            bytes32 messageHash = keccak256(
                abi.encodePacked(
                    block.chainid,
                    address(this),
                    verifyData.viewerAddress,
                    blockNumbers[i],
                    verifyData.nonce,
                    verifyData.affiliateReceivingAddress,
                    verifyData.advertismentContractAddress,
                    thirdPartyCount,
                    keccak256(abi.encodePacked(thirdPartyAddrs[i].thirdPartyAddresses)),
                    advertInfo.advertBounty
                )
            );

            // Convert to the Ethereum signed message hash format.
            bytes32 ethMsgHash = messageHash.toEthSignedMessageHash();

            // Recover the signer's address from the provided signature.
            address recoveredSigner = ECDSA.recover(ethMsgHash, signatures[i]);

            // If the recovered signer matches the OpenAdverts protocol signing address, apply
            // within-batch block separation (P0.1: minBlockNRSeparation is already in
            // blocks — no division by polBlocksPerHour required).
            if (recoveredSigner == advSigner) {
                if ((lastProcessedBlockNumber + advertInfo.minBlockNRSeparation) < blockNumbers[i]) {
                    lastProcessedBlockNumber = blockNumbers[i];
                    validSigs[validSigCount] = thirdPartyAddrs[i];
                    ++validSigCount;
                    if (validSigCount >= maxValidSigs) break;
                }
            }
        }
        maxValidBlockNumber = lastProcessedBlockNumber;
    }

    /**
     * @notice Event emitted when claim percentages are calculated and applied
     * @param affiliateReceiver The affiliate address receiving rewards
     * @param claimPercentages The percentage breakdown for all claim types
     * @param bounty The advertisement bounty amount
     * @param remainingBudget The remaining budget available for payouts
     * @param advertInfo The complete advertisement information
     */
    event ClaimPercentagesApplied(
        address indexed affiliateReceiver,
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct claimPercentages,
        uint256 bounty,
        uint256 remainingBudget,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct advertInfo
    );

    /**
     * @notice Calculates reward claims based on validated signatures and updates pending payments.
     * @param affiliateReceiver Address of the affiliate receiving rewards.
     * @param affiliatePct Pre-fetched affiliate claim percentage.
     * @param viewerPct Pre-fetched viewer claim percentage.
     * @param thirdPartyCount Number of third parties declared by the provider.
     * @param thirdPartyPcts Pre-fetched third party claim percentages array.
     * @param bounty The advert bounty amount.
     */
    function _calculateClaims(
        address affiliateReceiver,
        uint256 affiliatePct,
        uint256 viewerPct,
        uint256 thirdPartyCount,
        uint256[] memory thirdPartyPcts,
        uint256 bounty,
        address viewerAddress,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory validSigs,
        uint256 validSigCount,
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts
    ) internal pure returns (uint256 uniqueCount) {
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages = LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct({
            affiliateClaimPercentage: affiliatePct,
            viewerClaimPercentage: viewerPct,
            thirdPartyClaimPercentages: thirdPartyPcts
        });

        return
            _updatependingPayments(
                affiliateReceiver,
                claimPercentages,
                thirdPartyCount,
                bounty,
                viewerAddress,
                validSigs,
                validSigCount,
                uniqueAddrs,
                uniqueAmounts
            );
    }

    /**
     * @notice Updates the pending payments for each address based on claim percentages.
     * @param affiliateReceivingAddress Affiliate address receiving the reward.
     * @param claimPercentages Struct containing all claim percentages.
     * @param thirdPartyCount Number of third parties to process.
     * @param advertBounty The advert bounty amount.
     */
    function _updatependingPayments(
        address affiliateReceivingAddress,
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages,
        uint256 thirdPartyCount,
        uint256 advertBounty,
        address viewerAddress,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory validSigs,
        uint256 validSigCount,
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts
    ) internal pure returns (uint256 uniqueCount) {
        uniqueCount = _processThirdPartyPayments(
            affiliateReceivingAddress,
            claimPercentages,
            thirdPartyCount,
            advertBounty,
            viewerAddress,
            validSigs,
            validSigCount,
            uniqueAddrs,
            uniqueAmounts
        );

        uniqueCount = _applyStandardPayments(
            affiliateReceivingAddress,
            claimPercentages,
            advertBounty,
            viewerAddress,
            validSigCount,
            uniqueAddrs,
            uniqueAmounts,
            uniqueCount
        );
        return uniqueCount;
    }

    /**
     * @notice Applies standard viewer and affiliate payments
     * @param affiliateReceivingAddress Affiliate receiving address
     * @param claimPercentages Claim percentages structure
     * @param advertBounty Advertisement bounty
     */
    function _applyStandardPayments(
        address affiliateReceivingAddress,
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages,
        uint256 advertBounty,
        address viewerAddress,
        uint256 validSigCount,
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts,
        uint256 uniqueCount
    ) internal pure returns (uint256) {
        uint256 viewerRewardPerSig = (advertBounty * claimPercentages.viewerClaimPercentage) / 100;
        uint256 affiliateRewardPerSig = (advertBounty * claimPercentages.affiliateClaimPercentage) / 100;

        uniqueCount = _addToAccumulator(uniqueAddrs, uniqueAmounts, uniqueCount, viewerAddress, viewerRewardPerSig * validSigCount);
        uniqueCount = _addToAccumulator(uniqueAddrs, uniqueAmounts, uniqueCount, affiliateReceivingAddress, affiliateRewardPerSig * validSigCount);
        return uniqueCount;
    }

    /**
     * @notice Calculates base rewards for viewer and affiliate
     * @param claimPercentages The claim percentage structure
     * @param advertBounty The advertisement bounty amount
     * @return viewerReward Reward per signature for viewer
     * @return affiliateReward Reward per signature for affiliate
     */
    function _calculateBaseRewards(
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages,
        uint256 advertBounty
    ) internal pure returns (uint256 viewerReward, uint256 affiliateReward) {
        viewerReward = (advertBounty * claimPercentages.viewerClaimPercentage) / 100;
        affiliateReward = (advertBounty * claimPercentages.affiliateClaimPercentage) / 100;
        return (viewerReward, affiliateReward);
    }

    /**
     * @notice Calculates viewer and affiliate shares when third party is null
     * @param claimPercentages The claim percentage structure
     * @return viewerShare Percentage share for viewer (out of 100)
     * @return affiliateShare Percentage share for affiliate (out of 100)
     */
    function _calculateShares(
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages
    ) internal pure returns (uint256 viewerShare, uint256 affiliateShare) {
        uint256 totalViewerAffiliate = claimPercentages.viewerClaimPercentage + claimPercentages.affiliateClaimPercentage;
        viewerShare = (claimPercentages.viewerClaimPercentage * 100) / totalViewerAffiliate;
        affiliateShare = (claimPercentages.affiliateClaimPercentage * 100) / totalViewerAffiliate;

        return (viewerShare, affiliateShare);
    }

    /**
     * @notice Processes third-party payments and checks budget exhaustion
     * @param affiliateReceivingAddress Affiliate address
     * @param claimPercentages Claim percentages structure
     * @param thirdPartyCount Number of third parties to process per signature
     * @param advertBounty Advertisement bounty
     * @return uniqueCount Number of unique addresses with accumulated payments
     */
    function _processThirdPartyPayments(
        address affiliateReceivingAddress,
        LibOpenAdvertsPayoutStorage.ClaimPercentagesStruct memory claimPercentages,
        uint256 thirdPartyCount,
        uint256 advertBounty,
        address viewerAddress,
        LibOpenAdvertsPayoutStorage.ThirdPartyAddressStruct[] memory validSigs,
        uint256 validSigCount,
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts
    ) internal pure returns (uint256 uniqueCount) {
        (uint256 calculatedViewerShare, uint256 calculatedAffiliateShare) = _calculateShares(claimPercentages);

        uniqueCount = 0;

        for (uint256 i = 0; i < validSigCount; i++) {
            // Dynamic loop over all declared third parties for this signature.
            for (uint256 j = 0; j < thirdPartyCount; j++) {
                (, uniqueCount) = _processSingleThirdParty(
                    affiliateReceivingAddress,
                    validSigs[i].thirdPartyAddresses[j],
                    claimPercentages.thirdPartyClaimPercentages[j],
                    advertBounty,
                    calculatedViewerShare,
                    calculatedAffiliateShare,
                    viewerAddress,
                    uniqueAddrs,
                    uniqueAmounts,
                    uniqueCount
                );
            }
        }

        return uniqueCount;
    }

    /**
     * @notice Processes payment for a single third party
     * @param affiliateReceivingAddress Affiliate address
     * @param thirdPartyAddress Third party address (can be address(0))
     * @param thirdPartyPercentage Third party claim percentage
     * @param advertBounty Advertisement bounty
     * @param viewerShare Viewer share when third party is null
     * @param affiliateShare Affiliate share when third party is null
     * @return amount Total amount added to pending payments
     */
    function _processSingleThirdParty(
        address affiliateReceivingAddress,
        address thirdPartyAddress,
        uint256 thirdPartyPercentage,
        uint256 advertBounty,
        uint256 viewerShare,
        uint256 affiliateShare,
        address viewerAddress,
        address[] memory uniqueAddrs,
        uint256[] memory uniqueAmounts,
        uint256 uniqueCount
    ) internal pure returns (uint256 amount, uint256 newUniqueCount) {
        if (thirdPartyAddress == address(0)) {
            // Split between viewer and affiliate.
            uint256 viewerAmount = (advertBounty * viewerShare * thirdPartyPercentage) / 10000;
            uint256 affiliateAmount = (advertBounty * affiliateShare * thirdPartyPercentage) / 10000;

            newUniqueCount = _addToAccumulator(uniqueAddrs, uniqueAmounts, uniqueCount, viewerAddress, viewerAmount);
            newUniqueCount = _addToAccumulator(uniqueAddrs, uniqueAmounts, newUniqueCount, affiliateReceivingAddress, affiliateAmount);
            return (viewerAmount + affiliateAmount, newUniqueCount);
        } else {
            // Pay third party directly.
            uint256 thirdPartyAmount = (advertBounty * thirdPartyPercentage) / 100;
            newUniqueCount = _addToAccumulator(uniqueAddrs, uniqueAmounts, uniqueCount, thirdPartyAddress, thirdPartyAmount);
            return (thirdPartyAmount, newUniqueCount);
        }
    }

    /**
     * @notice In-memory accumulator: adds `amount` to the existing entry for `addr`,
     *         or appends a new entry if `addr` is not yet present.
     * @dev    O(n) scan; acceptable because uniqueCount is bounded by the pre-allocated array
     *         (max = 2 + signatures.length * thirdPartyCount).
     */
    function _addToAccumulator(
        address[] memory addrs,
        uint256[] memory amounts,
        uint256 count,
        address addr,
        uint256 amount
    ) internal pure returns (uint256 newCount) {
        for (uint256 k = 0; k < count; k++) {
            if (addrs[k] == addr) {
                amounts[k] += amount;
                return count;
            }
        }
        addrs[count] = addr;
        amounts[count] = amount;
        return count + 1;
    }

    /**
     * @notice Moves advertisement from Approved to Exhausted status
     * @param advert The advertisement to move
     */
    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own immutable variable for direct calls
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }

    /**
     * @notice Phase 3 dual-auth: allows either direct owner (pre-enforcement) or
     *         a call originating inside OpenAdvertsTimelockFacet.executeOperation.
     */
    function _enforceOwnerOrTimelockExec() internal view {
        LibOpenAdvertsTimelockStorage.OpenAdvertsTimelockStruct storage ts = LibOpenAdvertsTimelockStorage.openAdvertsTimelockStorage();
        if (ts.inExecution) {
            return;
        }
        if (ts.enforced) {
            revert("Must go through timelock");
        }
        LibDiamond.enforceIsContractOwner();
    }
}
