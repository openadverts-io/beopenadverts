// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import {LibOpenAdvertsGovernanceStorage} from "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import {LibOpenAdvertsAdvertisersStorage} from "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import {LibOpenAdvertsAffiliatesStorage} from "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibOpenAdvertsPayoutStorage} from "../libraries/LibOpenAdvertsPayoutStorage.sol";
import {LibOpenAdvertsPauseStorage} from "../libraries/LibOpenAdvertsPauseStorage.sol";
import {LibOpenAdvertsBootstrapStorage} from "../libraries/LibOpenAdvertsBootstrapStorage.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOpenAdvertsTokenFacet {
    function canVoteThisBlock(address account) external view returns (bool);
    function recordVoteActivity(address voter) external;
    function processNewUSDCDeposits() external;
    function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256);
}

/**
 * @title OpenAdvertsGovernanceFacet
 * @dev Manages governance for the OpenAdverts ecosystem. The contract owner creates quota or facet
 * proposals; token holders vote weighted by their balance snapshot at proposal creation; and once the
 * voting deadline passes anyone may ratify (applies the proposal if it passed, otherwise clears it).
 * It also supports admin applications and voting for the election of a new contract owner.
 */
contract OpenAdvertsGovernanceFacet {
    using SafeERC20 for IERC20;

    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // USDC-advert claim-gas floor assumptions (explicit & governance-safe).
    //
    // A viewer redeems USDC rewards by paying POL gas, so the enforced minimum
    // advert bounty must encode a claim-gas assumption or USDC claims can become
    // unprofitable to withdraw. `minAdvertBountyInPOLWei` is the shared POL/USDC
    // floor; the gas basis is stored in governance storage (owner-set via
    // OpenAdvertsClaimGasFloorFacet) and _validateQuotaProposal forbids lowering it below the
    // coverage invariant:
    //   minAdvertBountyInPOLWei * minViewerClaimPct/100 >= gasPerSig * gasPriceWei
    // Basis: ~90k gas per signature at a 300 gwei worst-case Polygon gas price.
    // ─────────────────────────────────────────────────────────────────────────
    event ProposalCreated(address newImplementation, uint256 endTime);
    event ProposalExecuted(address newImplementation);
    event ImplementationUpdated(address newImplementation);
    event UpgradeSet(bytes4[] functionSelectors, address[] implementations);
    event UpgradeRatified(bytes4[] functionSelectors, address[] implementations);

    event ProposalFailed(uint256 indexed proposalId, string reason);
    event ProposalPassed(uint256 indexed proposalId, LibOpenAdvertsGovernanceStorage.ProposalType proposalType);

    /**
     * @dev Creates a new governance proposal.
     * Depending on the proposal type, either a quota proposal or a facet proposal is created.
     * Only the contract owner can create proposals.
     * @param proposalType The type of proposal (QuotaProposal or FacetProposal).
     * @param quotaProposalData The quota proposal data structure.
     * @param votingDuration The duration for the voting period (in seconds).
     * @param newFacets An array of new facet cuts for a facet proposal.
     */
    function createProposal(
        LibOpenAdvertsGovernanceStorage.ProposalType proposalType,
        LibOpenAdvertsGovernanceStorage.QuotaProposal memory quotaProposalData,
        uint256 votingDuration,
        IDiamondCut.FacetCut[] memory newFacets
    ) public {
        LibDiamond.enforceIsContractOwner();
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        require(!govStorage.isProposalActive, "Currently a proposal is already active");

        govStorage.currentProposalId++;
        govStorage.proposalStruct.votingDeadlineBlocknumber = block.number + votingDuration;

        // Phase 2 — open a fresh balance snapshot. Transfers after this point have
        // their pre-mutation balances captured by OpenAdvertsTokenFacet._transferCustom.
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage_ = LibOpenAdvertsTokenStorage.tokenStorage();
        tokenStorage_.currentSnapshotId += 1;
        govStorage.proposalStruct.snapshotId = tokenStorage_.currentSnapshotId;

        govStorage.isProposalActive = true;
        govStorage.proposalType = proposalType;

        if (proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.QuotaProposal) {
            require(
                votingDuration >= govStorage.currentQuotas.minQuotaProposalDuration &&
                    votingDuration <= govStorage.currentQuotas.maxQuotaProposalDuration,
                "Quota proposal duration outside allowed range"
            );
        } else if (proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.FacetProposal) {
            require(
                votingDuration >= govStorage.currentQuotas.minFacetProposalDuration &&
                    votingDuration <= govStorage.currentQuotas.maxFacetProposalDuration,
                "Facet proposal duration outside allowed range"
            );
        }

        if (proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.QuotaProposal) {
            _validateQuotaProposal(quotaProposalData);

            govStorage.proposalStruct.quotaProposal.proposedOpenAdvertsCommission = quotaProposalData.proposedOpenAdvertsCommission;
            govStorage.proposalStruct.quotaProposal.proposedMinPOLRequiredforAdvertInWei = quotaProposalData.proposedMinPOLRequiredforAdvertInWei;
            govStorage.proposalStruct.quotaProposal.proposedUSDCCurrencyPremiumInPCT = quotaProposalData.proposedUSDCCurrencyPremiumInPCT;
            govStorage.proposalStruct.quotaProposal.proposedOpenAdvertsAdminChangeQuorum = quotaProposalData.proposedOpenAdvertsAdminChangeQuorum;
            govStorage.proposalStruct.quotaProposal.proposedQuotaProposalQuorum = quotaProposalData.proposedQuotaProposalQuorum;
            govStorage.proposalStruct.quotaProposal.proposedFacetProposalQuorum = quotaProposalData.proposedFacetProposalQuorum;
            govStorage.proposalStruct.quotaProposal.proposedAdvertApprovalDenialQuorum = quotaProposalData.proposedAdvertApprovalDenialQuorum;
            govStorage.proposalStruct.quotaProposal.proposedAdvertApprovalThreshold = quotaProposalData.proposedAdvertApprovalThreshold;
            govStorage.proposalStruct.quotaProposal.proposedAdvertDenialThreshold = quotaProposalData.proposedAdvertDenialThreshold;
            govStorage.proposalStruct.quotaProposal.proposedAffiliateApprovalDenialQuorum = quotaProposalData.proposedAffiliateApprovalDenialQuorum;
            govStorage.proposalStruct.quotaProposal.proposedAffiliateApprovalThreshold = quotaProposalData.proposedAffiliateApprovalThreshold;
            govStorage.proposalStruct.quotaProposal.proposedAffiliateDenialThreshold = quotaProposalData.proposedAffiliateDenialThreshold;
            govStorage.proposalStruct.quotaProposal.proposedAdminApplicantFeeInPolWei = quotaProposalData.proposedAdminApplicantFeeInPolWei;
            govStorage.proposalStruct.quotaProposal.proposedAdminVoteDeadlineInBlocks = quotaProposalData.proposedAdminVoteDeadlineInBlocks;
            govStorage.proposalStruct.quotaProposal.proposedStorageProviderCommissionFromADVC = quotaProposalData
                .proposedStorageProviderCommissionFromADVC;
            govStorage.proposalStruct.quotaProposal.proposedAdminCommissionFromADVC = quotaProposalData.proposedAdminCommissionFromADVC; // ✅ NEW
            govStorage.proposalStruct.quotaProposal.proposedPolBlocksPerHour = quotaProposalData.proposedPolBlocksPerHour;
            govStorage.proposalStruct.quotaProposal.proposedMaxBlockSeparationAdvertisement = quotaProposalData
                .proposedMaxBlockSeparationAdvertisement;
            govStorage.proposalStruct.quotaProposal.proposedMinAdvertBountyInPOLWei = quotaProposalData.proposedMinAdvertBountyInPOLWei;
            govStorage.proposalStruct.quotaProposal.proposedAdvertPauseCooldownBlocks = quotaProposalData.proposedAdvertPauseCooldownBlocks;
            govStorage.proposalStruct.quotaProposal.proposedMinQuotaProposalDuration = quotaProposalData.proposedMinQuotaProposalDuration;
            govStorage.proposalStruct.quotaProposal.proposedMaxQuotaProposalDuration = quotaProposalData.proposedMaxQuotaProposalDuration;
            govStorage.proposalStruct.quotaProposal.proposedMinFacetProposalDuration = quotaProposalData.proposedMinFacetProposalDuration;
            govStorage.proposalStruct.quotaProposal.proposedMaxFacetProposalDuration = quotaProposalData.proposedMaxFacetProposalDuration;
            govStorage.proposalStruct.quotaProposal.proposedMaxSignaturesPerBatch = quotaProposalData.proposedMaxSignaturesPerBatch;
            govStorage.proposalStruct.quotaProposal.proposedMinViewerClaimPct = quotaProposalData.proposedMinViewerClaimPct;
        } else if (proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.FacetProposal) {
            govStorage.proposalType = LibOpenAdvertsGovernanceStorage.ProposalType.FacetProposal;
            delete govStorage.proposedNewFacets;

            for (uint256 i = 0; i < newFacets.length; i++) {
                govStorage.proposedNewFacets.push(newFacets[i]);
            }
        } else {
            revert("Invalid proposal type");
        }
    }

    /**
     * @notice Same-transaction vote/transfer throttle for all voting operations
     * @dev Checks both msg.sender and tx.origin, records activity for both.
     *      NOTE: This is not a full flash-loan defense (a true defense would snapshot
     *      voting weight at proposal start). It only prevents the caller AND the
     *      top-level EOA from both voting and transferring in the same transaction.
     */
    modifier flashLoanProtection() {
        // ✅ CHECK: msg.sender (the actual caller)
        require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(msg.sender), "Cannot vote: recent transfer or voting activity");

        // ✅ CHECK: tx.origin if different (contract call scenario)
        if (msg.sender != tx.origin) {
            require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(tx.origin), "Cannot vote: EOA has recent activity");
        }

        _;

        // ✅ RECORD: Both addresses
        IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(msg.sender);
        if (msg.sender != tx.origin) {
            IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(tx.origin);
        }
    }

    /**
     * @dev Casts a vote on the active proposal.
     * Votes are weighted by the caller's token balance. A user may vote only once per proposal.
     * @param support True if voting in favor; false otherwise.
     */
    function voteOnProposal(bool support) public flashLoanProtection {
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        require(!govStorage.hasVotedOnProposal[msg.sender][govStorage.currentProposalId], "Already voted");
        require(block.number < govStorage.proposalStruct.votingDeadlineBlocknumber, "Voting period over");

        // Phase 2 — voting weight is the snapshot balance at proposal creation,
        // not the live balance. This neutralises flash-loan/borrow-to-vote attacks.
        uint256 voterBalance = IOpenAdvertsTokenFacet(address(this)).balanceOfAt(msg.sender, govStorage.proposalStruct.snapshotId);
        require(voterBalance > 0, "Caller does not have ownership tokens");
        tokenStorage; // silence unused-local (kept for storage pointer symmetry)

        if (support) {
            govStorage.votesByUser[msg.sender][govStorage.currentProposalId][true] += voterBalance;
            govStorage.proposalStruct.totalSupportVotesForCurrentProposal += voterBalance;
        } else {
            govStorage.votesByUser[msg.sender][govStorage.currentProposalId][false] += voterBalance;
            govStorage.proposalStruct.totalDenyVotesForCurrentProposal += voterBalance;
        }

        govStorage.hasVotedOnProposal[msg.sender][govStorage.currentProposalId] = true;
    }

    /**
     * @dev Revokes the active proposal.
     * Only the contract owner can revoke a proposal, and only while voting is still open.
     * After the deadline the outcome belongs to the token holders and is immutable.
     */
    function revokeProposal() public {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        LibDiamond.enforceIsContractOwner();

        require(govStorage.isProposalActive, "No active proposal to revoke");
        require(block.number < govStorage.proposalStruct.votingDeadlineBlocknumber, "Cannot revoke after voting ends");

        delete govStorage.proposalStruct.quotaProposal;
        delete govStorage.proposedNewFacets;
        govStorage.isProposalActive = false;
    }

    /**
     * @notice Validates a quota proposal to ensure all parameters are within acceptable ranges
     * @param proposal The quota proposal to validate
     */
    function _validateQuotaProposal(LibOpenAdvertsGovernanceStorage.QuotaProposal memory proposal) internal view {
        // Commission rates: 0-100%
        require(proposal.proposedOpenAdvertsCommission <= 100, "OpenAdverts commission cannot exceed 100%");
        require(proposal.proposedStorageProviderCommissionFromADVC <= 100, "SP commission > 100%");
        require(proposal.proposedAdminCommissionFromADVC <= 100, "Admin commission > 100%");
        require(proposal.proposedAdminCommissionFromADVC + proposal.proposedStorageProviderCommissionFromADVC <= 100, "Combined commission > 100%");

        // Quorums: 1-100%
        require(proposal.proposedQuotaProposalQuorum >= 1 && proposal.proposedQuotaProposalQuorum <= 100, "Quota proposal quorum must be 1-100%");
        require(proposal.proposedFacetProposalQuorum >= 1 && proposal.proposedFacetProposalQuorum <= 100, "Facet proposal quorum must be 1-100%");
        require(
            proposal.proposedOpenAdvertsAdminChangeQuorum >= 1 && proposal.proposedOpenAdvertsAdminChangeQuorum <= 100,
            "Admin change quorum must be 1-100%"
        );
        require(
            proposal.proposedAdvertApprovalDenialQuorum >= 1 && proposal.proposedAdvertApprovalDenialQuorum <= 100,
            "Advert approval/denial quorum must be 1-100%"
        );
        require(
            proposal.proposedAffiliateApprovalDenialQuorum >= 1 && proposal.proposedAffiliateApprovalDenialQuorum <= 100,
            "Affiliate approval/denial quorum must be 1-100%"
        );

        // Thresholds: 1-100%
        require(
            proposal.proposedAdvertApprovalThreshold >= 1 && proposal.proposedAdvertApprovalThreshold <= 100,
            "Advert approval threshold must be 1-100%"
        );
        require(
            proposal.proposedAdvertDenialThreshold >= 1 && proposal.proposedAdvertDenialThreshold <= 100,
            "Advert denial threshold must be 1-100%"
        );
        require(
            proposal.proposedAffiliateApprovalThreshold >= 1 && proposal.proposedAffiliateApprovalThreshold <= 100,
            "Affiliate approval threshold must be 1-100%"
        );
        require(
            proposal.proposedAffiliateDenialThreshold >= 1 && proposal.proposedAffiliateDenialThreshold <= 100,
            "Affiliate denial threshold must be 1-100%"
        );

        // Bounties: Must be positive
        require(proposal.proposedMinAdvertBountyInPOLWei > 0, "Minimum POL bounty must be positive");
        require(proposal.proposedMinViewerClaimPct >= 50 && proposal.proposedMinViewerClaimPct <= 100, "Minimum viewer claim must be 50-100%");
        require(proposal.proposedUSDCCurrencyPremiumInPCT > 0, "USDC currency premium must be positive");

        // Governance-safety: the guaranteed viewer share of the minimum bounty must cover the
        // assumed claim gas cost, otherwise USDC reward withdrawals become unprofitable and the
        // shared POL/USDC floor silently breaks. Assumptions are owner-set via OpenAdvertsClaimGasFloorFacet
        // and have no default, so a fresh deploy must initialise them before quotas can change.
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage floorGs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        uint256 assumedGasPerSig = floorGs.assumedGasPerSig;
        uint256 assumedGasPriceWei = floorGs.assumedClaimGasPriceWei;
        require(assumedGasPerSig != 0 && assumedGasPriceWei != 0, "Claim-gas assumptions not set");
        require(
            proposal.proposedMinAdvertBountyInPOLWei * proposal.proposedMinViewerClaimPct >= assumedGasPerSig * assumedGasPriceWei * 100,
            "Min bounty below claim-gas floor"
        );

        // Funding requirements: Must be positive
        require(proposal.proposedMinPOLRequiredforAdvertInWei > 0, "Minimum POL required must be positive");

        // Proposal durations: Must be reasonable (at least 1 hour, max 30 days in blocks)
        require(proposal.proposedMinQuotaProposalDuration >= 43200, "Minimum quota proposal duration too short"); // 1 day
        require(proposal.proposedMinQuotaProposalDuration <= proposal.proposedMaxQuotaProposalDuration, "Min duration cannot exceed max duration");

        require(proposal.proposedMinFacetProposalDuration >= 43200, "Minimum facet proposal duration too short"); // 1 day
        require(
            proposal.proposedMinFacetProposalDuration <= proposal.proposedMaxFacetProposalDuration,
            "Min facet duration cannot exceed max duration"
        );

        // Block separation: Must be reasonable
        require(proposal.proposedMaxBlockSeparationAdvertisement > 0, "Max block separation must be positive");
        require(proposal.proposedMaxBlockSeparationAdvertisement <= 43200, "Max block separation too high"); // ~1 day max

        // Admin parameters: Must be reasonable
        require(proposal.proposedAdminApplicantFeeInPolWei > 0, "Admin applicant fee must be positive");
        require(proposal.proposedAdminVoteDeadlineInBlocks >= 43200, "Admin vote deadline too short"); // 1 day min

        // ✅ SIMPLIFIED: Only validate cooldown parameter
        require(proposal.proposedAdvertPauseCooldownBlocks >= 43200, "Pause cooldown too short"); // 1 day min
        require(proposal.proposedAdvertPauseCooldownBlocks <= 1296000, "Pause cooldown too long"); // ~30 days max

        // Payout batch limit: 1 to 1000 signatures
        require(
            proposal.proposedMaxSignaturesPerBatch >= 1 && proposal.proposedMaxSignaturesPerBatch <= 1000,
            "maxSignaturesPerBatch must be 1-1000"
        );
    }

    /**
     * @dev Ratifies a proposal after its voting deadline. Permissionless: callable by anyone.
     * Applies the proposal only if the SUPPORT (yes) votes clear quorum and outnumber DENY; otherwise
     * the proposal is cleared as failed. Never reverts on quorum/support, so an expired proposal is
     * always resolvable and can never block future proposals. Quota proposals update the current
     * quotas; facet proposals perform a diamondCut (authorized via the transient governanceCutInProgress
     * flag, so the bootstrap latch and owner check do not apply to a quorum-approved cut).
     */
    function ratifyUpgrade() external {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        require(govStorage.proposalStruct.votingDeadlineBlocknumber < block.number, "Voting period not ended");

        bool proposalPassed = false;

        if (govStorage.proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.QuotaProposal) {
            uint256 requiredQuorum = (tokenStorage.totalSupply * govStorage.currentQuotas.QuotaProposalQuorum) / 100;

            // Post-deadline resolver: apply only if the SUPPORT (yes) votes clear quorum AND outnumber
            // deny; otherwise fall through and clean up as a failed proposal. Quorum is measured on
            // support votes only, so a deny vote can never push a proposal over quorum (avoids the
            // participation-quorum paradox). ratifyUpgrade never reverts on quorum/support, so an
            // expired proposal is always resolvable and can never brick future proposals (revoke is
            // restricted to the voting window).
            if (
                govStorage.proposalStruct.totalSupportVotesForCurrentProposal > requiredQuorum &&
                govStorage.proposalStruct.totalSupportVotesForCurrentProposal > govStorage.proposalStruct.totalDenyVotesForCurrentProposal
            ) {
                govStorage.currentQuotas.openAdvertsCommission = govStorage.proposalStruct.quotaProposal.proposedOpenAdvertsCommission;
                govStorage.currentQuotas.minPOLRequiredforAdvertInWei = govStorage.proposalStruct.quotaProposal.proposedMinPOLRequiredforAdvertInWei;
                govStorage.currentQuotas.USDCCurrencyPremiumInPCT = govStorage.proposalStruct.quotaProposal.proposedUSDCCurrencyPremiumInPCT;
                govStorage.currentQuotas.openAdvertsAdminChangeQuorum = govStorage.proposalStruct.quotaProposal.proposedOpenAdvertsAdminChangeQuorum;
                govStorage.currentQuotas.QuotaProposalQuorum = govStorage.proposalStruct.quotaProposal.proposedQuotaProposalQuorum;
                govStorage.currentQuotas.FacetProposalQuorum = govStorage.proposalStruct.quotaProposal.proposedFacetProposalQuorum;
                govStorage.currentQuotas.advertApprovalDenialQuorum = govStorage.proposalStruct.quotaProposal.proposedAdvertApprovalDenialQuorum;
                govStorage.currentQuotas.advertApprovalThreshold = govStorage.proposalStruct.quotaProposal.proposedAdvertApprovalThreshold;
                govStorage.currentQuotas.advertDenialThreshold = govStorage.proposalStruct.quotaProposal.proposedAdvertDenialThreshold;
                govStorage.currentQuotas.affiliateApprovalDenialQuorum = govStorage
                    .proposalStruct
                    .quotaProposal
                    .proposedAffiliateApprovalDenialQuorum;
                govStorage.currentQuotas.affiliateApprovalThreshold = govStorage.proposalStruct.quotaProposal.proposedAffiliateApprovalThreshold;
                govStorage.currentQuotas.affiliateDenialThreshold = govStorage.proposalStruct.quotaProposal.proposedAffiliateDenialThreshold;
                govStorage.currentQuotas.adminApplicantFeeInPolWei = govStorage.proposalStruct.quotaProposal.proposedAdminApplicantFeeInPolWei;
                govStorage.currentQuotas.adminVoteDeadlineInBlocks = govStorage.proposalStruct.quotaProposal.proposedAdminVoteDeadlineInBlocks;
                govStorage.currentQuotas.storageProviderCommissionFromADVC = govStorage
                    .proposalStruct
                    .quotaProposal
                    .proposedStorageProviderCommissionFromADVC;
                govStorage.currentQuotas.adminCommissionFromADVC = govStorage.proposalStruct.quotaProposal.proposedAdminCommissionFromADVC; // ✅ NEW
                govStorage.currentQuotas.polBlocksPerHour = govStorage.proposalStruct.quotaProposal.proposedPolBlocksPerHour;
                govStorage.currentQuotas.maxBlockSeparationAdvertisement = govStorage
                    .proposalStruct
                    .quotaProposal
                    .proposedMaxBlockSeparationAdvertisement;
                govStorage.currentQuotas.minAdvertBountyInPOLWei = govStorage.proposalStruct.quotaProposal.proposedMinAdvertBountyInPOLWei;
                govStorage.currentQuotas.advertPauseCooldownBlocks = govStorage.proposalStruct.quotaProposal.proposedAdvertPauseCooldownBlocks;
                govStorage.currentQuotas.minQuotaProposalDuration = govStorage.proposalStruct.quotaProposal.proposedMinQuotaProposalDuration;
                govStorage.currentQuotas.maxQuotaProposalDuration = govStorage.proposalStruct.quotaProposal.proposedMaxQuotaProposalDuration;
                govStorage.currentQuotas.minFacetProposalDuration = govStorage.proposalStruct.quotaProposal.proposedMinFacetProposalDuration;
                govStorage.currentQuotas.maxFacetProposalDuration = govStorage.proposalStruct.quotaProposal.proposedMaxFacetProposalDuration;
                govStorage.currentQuotas.maxSignaturesPerBatch = govStorage.proposalStruct.quotaProposal.proposedMaxSignaturesPerBatch;
                govStorage.currentQuotas.minViewerClaimPct = govStorage.proposalStruct.quotaProposal.proposedMinViewerClaimPct;

                proposalPassed = true;
            }
        } else if (govStorage.proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.FacetProposal) {
            uint256 requiredQuorum = (tokenStorage.totalSupply * govStorage.currentQuotas.FacetProposalQuorum) / 100;

            // Quorum measured on support (yes) votes only — see the QuotaProposal branch.
            if (
                govStorage.proposalStruct.totalSupportVotesForCurrentProposal > requiredQuorum &&
                govStorage.proposalStruct.totalSupportVotesForCurrentProposal > govStorage.proposalStruct.totalDenyVotesForCurrentProposal
            ) {
                IDiamondCut.FacetCut[] memory cutsToRatify = new IDiamondCut.FacetCut[](govStorage.proposedNewFacets.length);

                for (uint256 i = 0; i < govStorage.proposedNewFacets.length; i++) {
                    cutsToRatify[i] = govStorage.proposedNewFacets[i];
                }

                // Authorize the self-call to the DiamondCutFacet wrapper for this quorum-approved cut.
                // The wrapper's owner check would otherwise revert (msg.sender would be the diamond),
                // and the bootstrap latch must not apply to governance-approved upgrades. The flag is
                // cleared immediately after; a revert in the cut reverts the whole tx (and the flag).
                LibOpenAdvertsBootstrapStorage.BootstrapStruct storage bs = LibOpenAdvertsBootstrapStorage.bootstrapStorage();
                bs.governanceCutInProgress = true;
                IDiamondCut(address(this)).diamondCut(cutsToRatify, address(0), "");
                bs.governanceCutInProgress = false;

                proposalPassed = true;
            }
        }

        _cleanupProposal(govStorage);

        if (proposalPassed) {
            emit ProposalExecuted(address(0));
        } else {
            emit ProposalFailed(govStorage.currentProposalId, "Insufficient support votes");
        }
    }

    /**
     * @notice Gets the maximum number of signatures allowed per claimReward batch call.
     * @return The current maxSignaturesPerBatch quota value.
     */
    function getMaxSignaturesPerBatch() external view returns (uint256) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        return gs.currentQuotas.maxSignaturesPerBatch;
    }

    /**
     * @notice Gets all current quota values in one call
     * @return currentQuotas The complete CurrentQuotas struct
     */
    function getAllCurrentQuotas() external view returns (LibOpenAdvertsGovernanceStorage.CurrentQuotas memory currentQuotas) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        return gs.currentQuotas;
    }

    /**
     * @dev Internal function to clean up proposal state
     * @param govStorage Reference to governance storage
     */
    function _cleanupProposal(LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage) internal {
        // Clean up proposal state
        govStorage.isProposalActive = false;
        govStorage.proposalStruct.totalSupportVotesForCurrentProposal = 0;
        govStorage.proposalStruct.totalDenyVotesForCurrentProposal = 0;

        // Clean up proposal-specific data
        delete govStorage.proposalStruct.quotaProposal;
        delete govStorage.proposedNewFacets;
    }

    /**
     * @dev Allows an address to apply as a new admin.
     * Sets the admin vote deadline if this is the first applicant.
     * Automatically includes incumbent admin when first candidate applies.
     * @notice Prevents multiple applications in the same round.
     */
    function applyAsNewAdmin(string memory storageId) public payable {
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        require(!govStorage.isAdminApplicant[msg.sender][govStorage.adminVoteId], "You have already declared yourself an applicant for this round.");
        require(msg.value >= govStorage.currentQuotas.adminApplicantFeeInPolWei, "Insufficient fee for admin application");

        // ✅ ADD: Include incumbent admin when first candidate applies
        if (govStorage.proposedAdminAddresses.length == 0) {
            // Set the admin vote end time for this round
            govStorage.adminVoteDeadline = block.number + (govStorage.currentQuotas.adminVoteDeadlineInBlocks);

            // Phase 2 — open a fresh balance snapshot for this admin election round.
            tokenStorage.currentSnapshotId += 1;
            govStorage.adminVoteSnapshotId = tokenStorage.currentSnapshotId;

            // ✅ NEW: Add current contract owner (incumbent admin) as first candidate
            LibDiamond.DiamondStorage storage diamondStorage = LibDiamond.diamondStorage();
            address currentOwner = diamondStorage.contractOwner;

            require(currentOwner != msg.sender, "Current owner cannot apply as new admin");

            // Add incumbent admin to candidates list
            govStorage.proposedAdminAddresses.push(currentOwner);
            govStorage.isAdminApplicant[currentOwner][govStorage.adminVoteId] = true;
            govStorage.adminCandidateIndex[currentOwner][govStorage.adminVoteId] = 0; // First position (index 0)
            govStorage.adminApplicantStorageId[currentOwner][govStorage.adminVoteId] = "INCUMBENT_ADMIN"; // Special identifier
        }

        // Add the new applicant
        require(govStorage.proposedAdminAddresses.length < 100, "Maximum candidate limit reached");
        govStorage.isAdminApplicant[msg.sender][govStorage.adminVoteId] = true;
        govStorage.adminCandidateIndex[msg.sender][govStorage.adminVoteId] = govStorage.proposedAdminAddresses.length;
        govStorage.adminApplicantStorageId[msg.sender][govStorage.adminVoteId] = storageId;
        govStorage.proposedAdminAddresses.push(msg.sender);

        // Process application fee
        uint256 feeAmount = govStorage.currentQuotas.adminApplicantFeeInPolWei;
        tokenStorage.totalAggregateRewardInPOL += feeAmount;

        if (msg.value > feeAmount) {
            uint256 excess = msg.value - feeAmount;
            (bool refundSuccess, ) = payable(msg.sender).call{value: excess}("");
            require(refundSuccess, "Excess refund failed");
        }
    }

    /**
     * @dev Revokes the admin application of the caller.
     * Removes the applicant from the proposed admin addresses array and cleans up mappings.
     */
    function revokeAdminApplication() public {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        require(govStorage.isAdminApplicant[msg.sender][govStorage.adminVoteId], "You are not an applicant for this round");
        govStorage.isAdminApplicant[msg.sender][govStorage.adminVoteId] = false;

        uint256 index = govStorage.adminCandidateIndex[msg.sender][govStorage.adminVoteId];
        address[] storage applicants = govStorage.proposedAdminAddresses;

        uint256 lastIndex = applicants.length - 1;

        if (index < lastIndex) {
            applicants[index] = applicants[lastIndex];
            govStorage.adminCandidateIndex[applicants[index]][govStorage.adminVoteId] = index; // Update index mapping for swapped applicant
        }
        applicants.pop();

        // Clean up the mapping for the removed applicant
        delete govStorage.adminCandidateIndex[msg.sender][govStorage.adminVoteId];
        delete govStorage.adminApplicantStorageId[msg.sender][govStorage.adminVoteId];
    }

    /**
     * @dev Votes for a candidate applying to be the new admin.
     * The vote is weighted by the caller's token balance.
     * A voter may vote for a candidate only once per round.
     * @param candidate The address of the candidate.
     */
    function voteForNewAdmin(address candidate) public flashLoanProtection {
        require(!LibOpenAdvertsPauseStorage.openAdvertsPauseStorage().paused, "System paused");
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        require(govStorage.adminVoteDeadline > 0, "No election in progress");
        require(block.number <= govStorage.adminVoteDeadline, "Voting period has ended");
        require(govStorage.isAdminApplicant[candidate][govStorage.adminVoteId], "Candidate is not an applicant for this round");
        require(
            govStorage.adminVotesByUser[msg.sender][govStorage.adminVoteId][candidate] == 0,
            "You have already voted for this candidate in the current round"
        );

        // Phase 2 — snapshot balance at election open, not live balance.
        uint256 voterBalance = IOpenAdvertsTokenFacet(address(this)).balanceOfAt(msg.sender, govStorage.adminVoteSnapshotId);
        require(voterBalance > 0, "Insufficient token balance to vote");
        tokenStorage; // silence unused-local

        govStorage.adminVotesByUser[msg.sender][govStorage.adminVoteId][candidate] = voterBalance;
        govStorage.totalVotesPerAdminCandidate[govStorage.adminVoteId][candidate] += voterBalance;
    }

    /**
     * @dev Ratifies the admin selection based on the admin vote.
     * The candidate with the highest votes meeting the quorum becomes the new contract owner.
     * After selection, the admin vote round is advanced.
     * ✅ Automatically pays out accumulated admin commission to outgoing admin before transfer
     */
    function ratifyNewAdmin() public {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibDiamond.DiamondStorage storage diamondStorage = LibDiamond.diamondStorage();

        require(govStorage.adminVoteDeadline > 0, "No election in progress");
        require(block.number > govStorage.adminVoteDeadline, "Election period not over");

        address selectedCandidate;
        uint256 highestVotes = 0;

        // Calculate the required votes for approval based on the quorum percentage.
        uint256 requiredVotesForApproval = (tokenStorage.totalSupply * govStorage.currentQuotas.openAdvertsAdminChangeQuorum) / 100;

        for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
            address candidate = govStorage.proposedAdminAddresses[i];
            uint256 candidateVotes = govStorage.totalVotesPerAdminCandidate[govStorage.adminVoteId][candidate];

            if (candidateVotes > requiredVotesForApproval && candidateVotes > highestVotes) {
                highestVotes = candidateVotes;
                selectedCandidate = candidate;
            }
        }

        require(highestVotes > 0, "No candidates have met the requirement");

        // ✅ NEW: Pay out accumulated admin commission to outgoing admin BEFORE ownership transfer
        address outgoingAdmin = diamondStorage.contractOwner;

        // Only if there's a change in admin and USDC is configured
        if (selectedCandidate != outgoingAdmin) {
            LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage
                .openAdvertsAdvertisersStorage();

            if (aas.usdcTokenAddress != address(0)) {
                // Process any new USDC deposits first
                IOpenAdvertsTokenFacet(address(this)).processNewUSDCDeposits();

                // Calculate available admin USDC
                uint256 availableAdmin = tokenStorage.totalAggregateAdminUSDC - tokenStorage.adminWithdrawnUSDC;

                if (availableAdmin > 0) {
                    IERC20 usdcToken = IERC20(aas.usdcTokenAddress);

                    // Transfer USDC to outgoing admin
                    usdcToken.safeTransfer(outgoingAdmin, availableAdmin);

                    // Update tracking
                    tokenStorage.adminWithdrawnUSDC += availableAdmin;
                    tokenStorage.lastKnownUSDCBalance = usdcToken.balanceOf(address(this));
                }
            }
        }

        // Update the contract owner to the selected candidate via canonical path
        // (emits OwnershipTransferred event for indexer/explorer visibility).
        LibDiamond.setContractOwner(selectedCandidate);
        // Increment the admin vote ID for the next round.
        govStorage.adminVoteId++;
        govStorage.adminVoteDeadline = 0;

        delete govStorage.proposedAdminAddresses;
    }

    /**
     * @dev Clears a failed admin election where no candidate met the quorum.
     * Permissionless — anyone can call once the voting deadline has passed and no candidate qualified.
     * If a candidate has met quorum, call ratifyNewAdmin() instead.
     */
    function clearFailedElection() public {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        require(govStorage.adminVoteDeadline > 0, "No election in progress");
        require(block.number > govStorage.adminVoteDeadline, "Election period not over");

        uint256 requiredVotesForApproval = (tokenStorage.totalSupply * govStorage.currentQuotas.openAdvertsAdminChangeQuorum) / 100;

        for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
            address candidate = govStorage.proposedAdminAddresses[i];
            uint256 candidateVotes = govStorage.totalVotesPerAdminCandidate[govStorage.adminVoteId][candidate];
            require(candidateVotes <= requiredVotesForApproval, "A candidate met quorum; call ratifyNewAdmin()");
        }

        govStorage.adminVoteId++;
        govStorage.adminVoteDeadline = 0;

        delete govStorage.proposedAdminAddresses;
    }

    /**
     * @dev Retrieves proposed new admin addresses along with their vote counts.
     * @return proposedOwners An array of candidate addresses.
     * @return votesArray An array of vote counts for each candidate.
     * @return storageIds An array of storage IDs for each candidate.
     */
    function getProposedOwnersAndVotes()
        external
        view
        returns (address[] memory proposedOwners, uint256[] memory votesArray, string[] memory storageIds)
    {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        uint256 length = govStorage.proposedAdminAddresses.length;

        proposedOwners = new address[](length);
        votesArray = new uint256[](length);
        storageIds = new string[](length);

        for (uint256 i = 0; i < length; i++) {
            address ownerAddress = govStorage.proposedAdminAddresses[i];
            proposedOwners[i] = ownerAddress;

            // Retrieve votes for this candidate
            votesArray[i] = govStorage.totalVotesPerAdminCandidate[govStorage.adminVoteId][ownerAddress];

            // Get storage ID
            storageIds[i] = govStorage.adminApplicantStorageId[ownerAddress][govStorage.adminVoteId];
        }
    }

    /**
     * @dev Returns the current state of the active proposal
     * @return state 0=Active, 1=Passed, 2=Failed, 3=Expired, 4=None
     * @return canRatify Whether the proposal can be ratified
     */
    function getProposalState() external view returns (uint8 state, bool canRatify) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        if (!govStorage.isProposalActive) {
            return (4, false); // No active proposal
        }

        if (block.number <= govStorage.proposalStruct.votingDeadlineBlocknumber) {
            return (0, false); // Still active, can't ratify yet
        }

        // Check quorum
        uint256 totalVotes = govStorage.proposalStruct.totalSupportVotesForCurrentProposal +
            govStorage.proposalStruct.totalDenyVotesForCurrentProposal;

        uint256 requiredQuorum;
        if (govStorage.proposalType == LibOpenAdvertsGovernanceStorage.ProposalType.QuotaProposal) {
            requiredQuorum = (tokenStorage.totalSupply * govStorage.currentQuotas.QuotaProposalQuorum) / 100;
        } else {
            requiredQuorum = (tokenStorage.totalSupply * govStorage.currentQuotas.FacetProposalQuorum) / 100;
        }

        if (totalVotes <= requiredQuorum) {
            return (2, true); // Failed (no quorum), can ratify to clean up
        }

        if (govStorage.proposalStruct.totalSupportVotesForCurrentProposal > govStorage.proposalStruct.totalDenyVotesForCurrentProposal) {
            return (1, true); // Passed, can ratify
        }

        return (2, true); // Failed (more opposition), can ratify to clean up
    }

    /**
     * @notice Gets storage ID for a specific admin applicant
     * @param applicant The address of the admin applicant
     * @return storageId The storage ID for this applicant in current round
     */
    function getAdminApplicantStorageId(address applicant) external view returns (string memory storageId) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        return govStorage.adminApplicantStorageId[applicant][govStorage.adminVoteId];
    }

    /**
     * @notice Gets current admin applicant's own storage ID
     * @return storageId The storage ID for the calling applicant in current round
     */
    function getMyAdminApplicationStorageId() external view returns (string memory storageId) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        require(govStorage.isAdminApplicant[msg.sender][govStorage.adminVoteId], "You are not an applicant in current round");
        return govStorage.adminApplicantStorageId[msg.sender][govStorage.adminVoteId];
    }

    // add function that returns advertPauseCooldownBlocks from currentQuotas
    function getAdvertPauseCooldownBlocks() external view returns (uint256) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        return govStorage.currentQuotas.advertPauseCooldownBlocks;
    }

    /**
     * @notice Gets user's voting history on governance proposals
     * @param user The address to query
     * @return proposalIds Array of proposal IDs the user voted on
     * @return supportVotes Array of support votes cast
     * @return denyVotes Array of deny votes cast
     * @return votedFor Array indicating if user voted for (true) or against (false) each proposal
     */
    function getUserProposalVotingHistory(
        address user
    ) external view returns (uint256[] memory proposalIds, uint256[] memory supportVotes, uint256[] memory denyVotes, bool[] memory votedFor) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        // Count how many proposals user voted on
        uint256 count = 0;
        for (uint256 i = 1; i <= govStorage.currentProposalId; i++) {
            if (govStorage.hasVotedOnProposal[user][i]) {
                count++;
            }
        }

        // Allocate arrays
        proposalIds = new uint256[](count);
        supportVotes = new uint256[](count);
        denyVotes = new uint256[](count);
        votedFor = new bool[](count);

        // Populate arrays
        uint256 index = 0;
        for (uint256 i = 1; i <= govStorage.currentProposalId; i++) {
            if (govStorage.hasVotedOnProposal[user][i]) {
                proposalIds[index] = i;
                supportVotes[index] = govStorage.votesByUser[user][i][true];
                denyVotes[index] = govStorage.votesByUser[user][i][false];
                votedFor[index] = supportVotes[index] > 0;
                index++;
            }
        }
    }

    /**
     * @notice Gets user's voting history on affiliate applications
     * @param user The address to query
     * @return affiliates Array of affiliate addresses the user voted on
     * @return supportVotes Array of support votes cast
     * @return denyVotes Array of deny votes cast
     */
    function getAffiliateUserVotingHistory(
        address user
    ) public view returns (address[] memory affiliates, uint256[] memory supportVotes, uint256[] memory denyVotes) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        affiliates = afs.userVotingAddresses[user];
        supportVotes = new uint256[](affiliates.length);
        denyVotes = new uint256[](affiliates.length);

        for (uint256 i = 0; i < affiliates.length; i++) {
            supportVotes[i] = afs.hasVotedVotes[affiliates[i]][user][true];
            denyVotes[i] = afs.hasVotedVotes[affiliates[i]][user][false];
        }
    }

    /**
     * @notice Gets user's voting history on advertisements with vote weights
     * @param user The address to query
     * @return adverts Array of advertisement contract addresses the user voted on
     * @return supportVotes Array of support votes cast
     * @return denyVotes Array of deny votes cast
     */
    function getAdvertUserVotingHistory(
        address user
    ) public view returns (address[] memory adverts, uint256[] memory supportVotes, uint256[] memory denyVotes) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        adverts = aas.userVotingAddresses[user];
        supportVotes = new uint256[](adverts.length);
        denyVotes = new uint256[](adverts.length);

        for (uint256 i = 0; i < adverts.length; i++) {
            supportVotes[i] = aas.hasVotedVotes[adverts[i]][user][true];
            denyVotes[i] = aas.hasVotedVotes[adverts[i]][user][false];
        }
    }

    /**
     * @notice Gets user's voting history on admin elections
     * @param user The address to query
     * @return voteRounds Array of admin vote round IDs
     * @return candidates Array of candidates the user voted for
     * @return votes Array of votes cast
     */
    function getUserAdminVotingHistory(
        address user
    ) external view returns (uint256[] memory voteRounds, address[] memory candidates, uint256[] memory votes) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();

        // Count total votes across all rounds
        uint256 totalVotes = 0;
        for (uint256 round = 0; round <= govStorage.adminVoteId; round++) {
            for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
                address candidate = govStorage.proposedAdminAddresses[i];
                if (govStorage.adminVotesByUser[user][round][candidate] > 0) {
                    totalVotes++;
                }
            }
        }

        // Allocate arrays
        voteRounds = new uint256[](totalVotes);
        candidates = new address[](totalVotes);
        votes = new uint256[](totalVotes);

        // Populate arrays
        uint256 index = 0;
        for (uint256 round = 0; round <= govStorage.adminVoteId; round++) {
            for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
                address candidate = govStorage.proposedAdminAddresses[i];
                uint256 userVotes = govStorage.adminVotesByUser[user][round][candidate];

                if (userVotes > 0) {
                    voteRounds[index] = round;
                    candidates[index] = candidate;
                    votes[index] = userVotes;
                    index++;
                }
            }
        }
    }
    /**
     * @notice Comprehensive voting history - all types
     * @param user The address to query
     */
    function getUserCompleteVotingHistory(
        address user
    ) external view returns (uint256 proposalVoteCount, uint256 adminVoteCount, uint256 advertVoteCount, uint256 affiliateVoteCount) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        // Count proposal votes
        for (uint256 i = 1; i <= govStorage.currentProposalId; i++) {
            if (govStorage.hasVotedOnProposal[user][i]) {
                proposalVoteCount++;
            }
        }

        // Count admin votes
        for (uint256 round = 0; round <= govStorage.adminVoteId; round++) {
            for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
                address candidate = govStorage.proposedAdminAddresses[i];
                if (govStorage.adminVotesByUser[user][round][candidate] > 0) {
                    adminVoteCount++;
                }
            }
        }

        // Advertisement votes (already tracked)
        advertVoteCount = aas.userVotingAddresses[user].length;

        // Affiliate votes (already tracked)
        affiliateVoteCount = afs.userVotingAddresses[user].length;
    }

    /**
     * @notice Gets current platform and admin commission rates
     * @return platformCommission Current platform commission rate
     * @return adminCommissionFromADVC Current admin commission rate from ADVC
     */
    function getPlatformAndAdminCommissions() external view returns (uint256 platformCommission, uint256 adminCommissionFromADVC) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        platformCommission = govStorage.currentQuotas.openAdvertsCommission;
        adminCommissionFromADVC = govStorage.currentQuotas.adminCommissionFromADVC;
    }

    /**
     * @notice Receives and splits USDC commission 3 ways: admin, storage provider, OAD holders.
     * @dev Mirrors Diamond.receive() POL split logic. Called by USDC advertisement contracts
     *      during commission processing. If storageProviderAddress is address(0), the SP
     *      share is redirected to the OAD holder reward pool.
     * @param usdcToken The USDC token contract
     * @param totalCommission Total USDC commission amount to split
     * @return adminAmount Amount sent to Diamond owner
     * @return spAmount Amount sent to storage provider (or redirected to platform)
     * @return platformAmount Amount kept in Diamond for OAD holder dividends
     */
    function receiveAndSplitUSDCCommission(
        IERC20 usdcToken,
        uint256 totalCommission
    ) external returns (uint256 adminAmount, uint256 spAmount, uint256 platformAmount) {
        require(totalCommission > 0, "No commission");

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        adminAmount = (totalCommission * govStorage.currentQuotas.adminCommissionFromADVC) / 100;
        spAmount = (totalCommission * govStorage.currentQuotas.storageProviderCommissionFromADVC) / 100;
        platformAmount = totalCommission - adminAmount - spAmount;

        usdcToken.safeTransferFrom(msg.sender, address(this), totalCommission);

        if (adminAmount > 0) {
            usdcToken.safeTransfer(ds.contractOwner, adminAmount);
        }

        address spAddress = payoutStore.storageProviderAddress;
        if (spAmount > 0) {
            if (spAddress != address(0)) {
                usdcToken.safeTransfer(spAddress, spAmount);
            } else {
                platformAmount += spAmount;
                spAmount = 0;
            }
        }

        if (platformAmount > 0) {
            tokenStorage.totalAggregateRewardInUSDC += platformAmount;
            tokenStorage.lastKnownUSDCBalance = usdcToken.balanceOf(address(this));
        }

        return (adminAmount, spAmount, platformAmount);
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
