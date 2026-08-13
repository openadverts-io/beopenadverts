// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";

library LibOpenAdvertsGovernanceStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.governance.storage");

    enum ProposalType {
        QuotaProposal,
        FacetProposal
    }

    struct QuotaProposal {
        // Quota Parameters
        uint256 proposedQuotaProposalQuorum;
        uint256 proposedMinQuotaProposalDuration; // Minimum voting time
        uint256 proposedMaxQuotaProposalDuration; // Maximum voting time
        // Q.OpenAdverts Commission
        uint256 proposedOpenAdvertsCommission;
        uint256 proposedStorageProviderCommissionFromADVC;
        uint256 proposedAdminCommissionFromADVC;
        uint256 proposedPolBlocksPerHour;
        // Q.Advert Parameters
        uint256 proposedMinPOLRequiredforAdvertInWei;
        uint256 proposedMinAdvertBountyInPOLWei;
        uint256 proposedUSDCCurrencyPremiumInPCT;
        uint256 proposedAdvertApprovalDenialQuorum;
        uint256 proposedAdvertApprovalThreshold;
        uint256 proposedAdvertDenialThreshold;
        uint256 proposedMaxBlockSeparationAdvertisement;
        // Q.Affiliate Parameters
        uint256 proposedAffiliateApprovalDenialQuorum;
        uint256 proposedAffiliateApprovalThreshold;
        uint256 proposedAffiliateDenialThreshold;
        // Facet Parameters
        uint256 proposedFacetProposalQuorum;
        uint256 proposedMinFacetProposalDuration; // Minimum voting time
        uint256 proposedMaxFacetProposalDuration; // Maximum voting time
        // Admin Parameters
        uint256 proposedOpenAdvertsAdminChangeQuorum;
        uint256 proposedAdminApplicantFeeInPolWei; // Fee for admin applicants in POL
        uint256 proposedAdminVoteDeadlineInBlocks; // Deadline for admin voting in blocks
        // Cooldown Parameters
        uint256 proposedAdvertPauseCooldownBlocks;
        // Payout Parameters
        uint256 proposedMaxSignaturesPerBatch; // Maximum signatures allowed per claimReward call
        uint256 proposedMinViewerClaimPct; // Minimum viewer share of every bounty (0-100)
    }

    struct CurrentQuotas {
        // Quota Parameters
        uint256 QuotaProposalQuorum;
        uint256 minQuotaProposalDuration; // Minimum voting time
        uint256 maxQuotaProposalDuration; // Maximum voting time
        // Q.OpenAdverts Commission
        uint256 openAdvertsCommission;
        uint256 storageProviderCommissionFromADVC;
        uint256 adminCommissionFromADVC;
        uint256 polBlocksPerHour;
        // Q.Advert Parameters
        uint256 minPOLRequiredforAdvertInWei;
        uint256 minAdvertBountyInPOLWei;
        uint256 USDCCurrencyPremiumInPCT;
        uint256 advertApprovalDenialQuorum;
        uint256 advertApprovalThreshold;
        uint256 advertDenialThreshold;
        uint256 maxBlockSeparationAdvertisement;
        // Q.Affiliate Parameters
        uint256 affiliateApprovalDenialQuorum;
        uint256 affiliateApprovalThreshold;
        uint256 affiliateDenialThreshold;
        // Facet Parameters
        uint256 FacetProposalQuorum;
        uint256 minFacetProposalDuration; // Minimum voting time
        uint256 maxFacetProposalDuration; // Maximum voting time
        // Admin Parameters
        uint256 openAdvertsAdminChangeQuorum;
        uint256 adminApplicantFeeInPolWei;
        uint256 adminVoteDeadlineInBlocks; // Deadline for admin voting in blocks
        // Cooldown Parameters
        uint256 advertPauseCooldownBlocks; // Blocks between pause and withdrawal availability
        // Payout Parameters
        uint256 maxSignaturesPerBatch; // Maximum signatures allowed per claimReward call
        uint256 minViewerClaimPct; // Minimum viewer share of every bounty (0-100)
    }

    struct ProposalStruct {
        uint256 votingDeadlineBlocknumber;
        uint256 totalSupportVotesForCurrentProposal;
        uint256 totalDenyVotesForCurrentProposal;
        QuotaProposal quotaProposal;
        // Phase 2 — snapshot id captured at proposal creation; voting weight is
        // read from LibOpenAdvertsTokenStorage balanceOfAt(voter, snapshotId).
        uint256 snapshotId;
    }

    struct VotingHistoryData {
        uint256[] proposalIds;
        uint256[] proposalSupportVotes;
        uint256[] proposalDenyVotes;
        bool[] proposalVotedFor;
        uint256[] adminVoteRounds;
        address[] adminCandidates;
        uint256[] adminVotes;
        address[] affiliateAddresses;
        uint256[] affiliateSupportVotes;
        uint256[] affiliateDenyVotes;
        address[] advertAddresses;
        uint256[] advertSupportVotes;
        uint256[] advertDenyVotes;
        // Lifetime vote count totals (all-time, not limited to the current page)
        uint256 totalProposalVoteCount;
        uint256 totalAdminVoteCount;
        uint256 totalAdvertVoteCount;
        uint256 totalAffiliateVoteCount;
        // Governance storage fields
        CurrentQuotas currentQuotas;
        uint256 currentProposalId;
        bool isProposalActive;
        ProposalType proposalType;
        ProposalStruct proposalStruct;
        IDiamondCut.FacetCut[] proposedFacets;
        address[] proposedAdminAddresses;
        uint256 adminVoteId;
        uint256 adminVoteDeadline;
        string[] adminStorageIds;
    }

    struct GovernanceStorage {
        // Proposal Voting Structure
        bool isProposalActive;
        uint256 currentProposalId;
        ProposalType proposalType;
        ProposalStruct proposalStruct;
        IDiamondCut.FacetCut[] proposedNewFacets;
        mapping(address => mapping(uint256 => bool)) hasVotedOnProposal;
        mapping(address => mapping(uint256 => mapping(bool => uint256))) votesByUser; // useraddress>currentProposalIndex>support/oppose>#votes
        CurrentQuotas currentQuotas;
        // Admin Voting Structure - SIMPLIFIED: Only FOR votes
        address[] proposedAdminAddresses;
        uint256 adminVoteId;
        uint256 adminVoteDeadline;
        mapping(address => mapping(uint256 => bool)) isAdminApplicant;
        mapping(address => mapping(uint256 => mapping(address => uint256))) adminVotesByUser;
        mapping(uint256 => mapping(address => uint256)) totalVotesPerAdminCandidate;
        mapping(address => mapping(uint256 => uint256)) adminCandidateIndex;
        mapping(address => mapping(uint256 => string)) adminApplicantStorageId;
        // Phase 2 — snapshot id captured when a new admin election round opens
        // (i.e. when the first applicant applies for a given adminVoteId). Voting
        // weight in voteForNewAdmin is read via balanceOfAt(voter, this id).
        uint256 adminVoteSnapshotId;
        // Owner-controlled (NOT vote-controlled) claim-gas floor assumptions, managed by
        // OpenAdvertsClaimGasFloorFacet and read by OpenAdvertsGovernanceFacet's quota guard.
        // No default: must be set at deploy time, else quota proposal creation reverts.
        uint256 assumedGasPerSig;
        uint256 assumedClaimGasPriceWei;
    }

    function governanceStorage() internal pure returns (GovernanceStorage storage gs) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            gs.slot := position
        }
    }
}
