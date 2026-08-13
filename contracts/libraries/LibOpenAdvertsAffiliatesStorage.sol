// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

library LibOpenAdvertsAffiliatesStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.affiliates.storage");

    enum AffiliateType {
        Prospect,
        Approved,
        Banned
    }

    struct AffiliateStruct {
        address affiliateContractAddress;
        address affiliateOwner;
        address affiliateClaimInfoAddress;
        address affiliateSigningAddress;
        string storageId;
        uint256 affiliateFavorableScore;
        uint256 affiliateUnfavorableScore;
        AffiliateType AffiliateType;
        AffiliateType originalType; // Track original type before banning
    }

    struct OpenAdvertsAffiliatesStruct {
        // SECTION 1: Initialization & Configuration
        bool isAffiliateFacetInitialized;
        address diamondAddress;
        // SECTION 2: Type Arrays (ordered by enum values)
        AffiliateStruct[] prospectAffiliates; // AffiliateType.Prospect
        AffiliateStruct[] approvedAffiliates; // AffiliateType.Approved
        AffiliateStruct[] bannedAffiliates; // AffiliateType.Banned
        AffiliateStruct[] removedAffiliates; // Removed affiliates
        // SECTION 3: Core Mappings
        mapping(address => bool) affiliateExists;
        mapping(address => uint256) affiliateIndex;
        mapping(address => AffiliateType) affiliateStatus;
        mapping(address => bool) affiliateSigningStatus;
        // SECTION 4: Voting Storage
        mapping(address => mapping(address => bool)) hasVoted;
        mapping(address => mapping(address => mapping(bool => uint256))) hasVotedVotes;
        // SECTION 5: Bidirectional Voter Tracking
        mapping(address => address[]) userVotingAddresses; // user -> affiliates voted on
        mapping(address => address[]) affiliateVoters; // affiliate -> voters
        mapping(address => mapping(address => uint256)) userVotingAddressIndex;
        // SECTION 6: Administrative Features
        mapping(address => AffiliateType) originalTypeBeforeBan;
    }

    function openAdvertsAffiliatesStorage() internal pure returns (OpenAdvertsAffiliatesStruct storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }
}
