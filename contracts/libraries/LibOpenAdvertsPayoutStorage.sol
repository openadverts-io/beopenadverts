// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

library LibOpenAdvertsPayoutStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.payout.storage");

    struct ThirdPartyAddressStruct {
        address[] thirdPartyAddresses; // 0–6 entries, length must equal thirdPartyCount
    }

    struct ClaimPercentagesStruct {
        uint256 affiliateClaimPercentage;
        uint256 viewerClaimPercentage;
        uint256[] thirdPartyClaimPercentages; // length == thirdPartyCount
    }

    struct VerificationDataStruct {
        address affiliateReceivingAddress;
        address affiliateClaimInfoAddress;
        address advertismentContractAddress;
        // string passPhrase;
        uint256 nonce;
        address viewerAddress; // Set by advert contract to msg.sender before cross-contract call
    }

    struct UniqueAddressInfo {
        address addr;
        uint256 amount;
    }

    struct AffiliatePauseInfo {
        bool isPaused;
        uint256 pausedAtBlock;
        address pausedBy;
    }

    struct PayoutData {
        address[] recipients;
        uint256[] amounts;
        uint256 totalAmount;
    }

    struct OpenAdvertsPayoutStruct {
        bool isPayoutFacetInitialized;
        ThirdPartyAddressStruct ThirdPartyAddressStruct;
        ClaimPercentagesStruct ClaimPercentagesStruct;
        VerificationDataStruct VerificationDataStruct;
        UniqueAddressInfo UniqueAddressInfo;
        address storageProviderAddress;
        // Emergency pause mechanism
        bool isPayoutsPaused;
        uint256 pausedAtBlock;
        address pausedBy;
        // Affiliate-specific pause mechanism
        mapping(address => AffiliatePauseInfo) pausedAffiliates;
        address[] pausedAffiliatesList;
        mapping(address => uint256) pausedAffiliateIndex;
        // Centralised signing model — OpenAdverts's protocol-level signing EOA.
        // Set once via setOpenAdvertsSigningAddress(); all signature verification checks against this.
        address openAdvertsSigningAddress;
        // P0.2 — Per-(viewer, advertContract) engagement cooldown.
        // Stores the highest accepted engagement blockNumber for each
        // (viewer, advertContract) tuple. The affiliate is now implicit
        // (1:1 designated affiliate per advert), so the third key is removed.
        // Enforced in claimReward() against maxBlockSeparationAdvertisement.
        mapping(address => mapping(address => uint256)) viewerLastEngagementBlock;
    }
    function openAdvertsPayoutStorage() internal pure returns (OpenAdvertsPayoutStruct storage pas) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            pas.slot := position
        }
    }
}
