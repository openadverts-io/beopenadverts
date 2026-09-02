// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";

library LibOpenAdvertsTokenStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.token.storage");

    // enum VotingBenchmarks {
    //     CustomThreshold,
    //     MajorityThreshold,
    //     SuperMajorityThreshold
    // }

    // struct FacetProposal {
    //     VotingBenchmarks votingBenchmarks;
    //     address targetContract;
    // }

    // struct QuotaProposal {
    //     VotingBenchmarks votingBenchmarks;
    // }

    enum ProposalType {
        QuotaProposal, // Represents a quota proposal
        FacetProposal, // Represents a facet proposal
        AdminProposal // Represents an admin proposal
    }

    /**
     * @notice Phase 2 — per-account balance checkpoints used for snapshot-based
     *         vote weighting. Parallel arrays; `ids` is strictly increasing.
     */
    struct Snapshots {
        uint256[] ids;
        uint256[] values;
    }

    struct TokenStorage {
        bool isTokenFacetinitialized;
        uint256 totalSupply; // this needs to be in the constructor
        string name; // this needs to be in the constructor
        string symbol; // this needs to be in the constructor
        mapping(address => uint256) balances;
        uint256 totalAggregateRewardInPOL;
        uint256 totalAggregateRewardInUSDC;
        mapping(address => uint256) lastRewardClaimInPOL;
        mapping(address => uint256) lastRewardClaimInUSDC;
        mapping(address => bool) rewardClaimInProgress;
        address diamondAddress;
        mapping(address => uint256) lastTransferBlock;
        mapping(address => uint256) lastVoteBlock;
        // USDC balance tracking and admin allocation
        uint256 lastKnownUSDCBalance; // Tracks last known USDC balance to detect new deposits
        uint256 totalAggregateAdminUSDC; // Total USDC allocated to admin
        uint256 adminWithdrawnUSDC; // Total USDC withdrawn by admin
        // Phase 2 — lazy snapshot-based vote weighting.
        // `currentSnapshotId == 0` means no snapshot has ever been taken, and the
        // transfer hook is a no-op (preserves the pre-Phase-2 behaviour for any
        // deployment that never creates a governance proposal).
        uint256 currentSnapshotId;
        mapping(address => Snapshots) accountBalanceSnapshots;
        // Admin-commission escrow: credited when ratifyNewAdmin's push to the outgoing
        // admin fails (token pause/blacklist). Claimed later via withdrawPendingAdminUSDC,
        // independent of current ownership. totalPendingAdminUSDC is the unclaimed sum.
        mapping(address => uint256) pendingAdminUSDC;
        uint256 totalPendingAdminUSDC;
    }

    function tokenStorage() internal pure returns (TokenStorage storage ts) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ts.slot := position
        }
    }
}
