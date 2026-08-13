// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

library LibOpenAdvertsAdvertisersStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.advertisers.storage");

    enum AdvertisementType {
        Prospect,
        Approved,
        Exhausted,
        Deprecating, // Paused but still allowing existing claims
        Withdrawn, // Fully withdrawn, no claims allowed,
        Banned
    }

    enum PaymentType {
        POL, // 0 = POL payments
        USDC // 1 = USDC payments
    }

    struct AdvertStruct {
        address advertContractAddress;
        address advertOwner;
        string storageId;
        uint256 advertFavorableScore;
        uint256 advertUnfavorableScore;
        AdvertisementType AdvertisementType;
        PaymentType advertCurrency;
        uint256 advertBounty;
        uint256 initialFundedBudget;
        uint256 minBlockNRSeparation;
        address designatedAffiliate;
        uint256 pausedAtBlock;
        uint256 withdrawalAvailableBlock;
        bool isPaused;
    }

    struct OpenAdvertsAdvertisersStruct {
        // SECTION 1: Initialization & Configuration
        bool isAdvertiserFacetInitialized;
        address diamondAddress;
        address usdcTokenAddress;
        address priceFeedAddress;
        // SECTION 2: Type Arrays (ordered by enum values)
        AdvertStruct[] prospectAdvertisements; // AdvertisementType.Prospect
        AdvertStruct[] approvedAdvertisements; // AdvertisementType.Approved
        AdvertStruct[] exhaustedAdvertisements; // AdvertisementType.Exhausted
        AdvertStruct[] deprecatingAdvertisements; // AdvertisementType.Deprecating
        AdvertStruct[] withdrawnAdvertisements; // AdvertisementType.Withdrawn
        AdvertStruct[] bannedAdvertisements; // AdvertisementType.Banned
        AdvertStruct[] removedAdvertisements; // Removed advertisements
        // SECTION 3: Core Mappings
        mapping(address => bool) advertisementExists;
        mapping(address => uint256) advertisementIndex;
        mapping(address => AdvertisementType) advertisementStatus;
        mapping(address => bool) advertisementCommissioned;
        mapping(address => uint256) advertisementInitialFundedBudget;
        // SECTION 4: Voting Storage
        mapping(address => mapping(address => bool)) hasVoted;
        mapping(address => mapping(address => mapping(bool => uint256))) hasVotedVotes;
        // SECTION 5: Bidirectional Voter Tracking
        mapping(address => address[]) userVotingAddresses; // user -> advertisements voted on
        mapping(address => address[]) advertVoters; // advertisement -> voters
        mapping(address => mapping(address => uint256)) userVotingAddressIndex;
        // SECTION 6: Administrative Features
        mapping(address => AdvertisementType) originalTypeBeforeBan;
        // SECTION 7: Affiliate → Approved Advert Reverse Index
        mapping(address => address[]) affiliateApprovedAdverts;
        mapping(address => mapping(address => uint256)) affiliateApprovedAdvertIndex;
        // SECTION 8: Oracle hardening (Phase 1A)
        // Staleness window in seconds for the Chainlink POL/USD feed.
        // 0 means "use default" (DEFAULT_ORACLE_STALENESS_SECONDS in the facet).
        uint256 oracleStalenessSeconds;
        // Sanity bounds in oracle-native decimals (typically 8 for POL/USD).
        // Both 0 means disabled (no bound check). If either is nonzero, bounds are enforced.
        uint256 oracleMinPrice;
        uint256 oracleMaxPrice;
    }

    function openAdvertsAdvertisersStorage() internal pure returns (OpenAdvertsAdvertisersStruct storage aas) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            aas.slot := position
        }
    }
}
