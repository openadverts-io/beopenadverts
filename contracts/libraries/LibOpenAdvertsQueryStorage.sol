// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "./LibOpenAdvertsAdvertisersStorage.sol";
import "./LibOpenAdvertsGovernanceStorage.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";

/**
 * @title LibOpenAdvertsQueryStorage
 * @notice Storage library for OpenAdvertsQueryV2Facet — contains all structs
 *         and constants used by the performance-optimized query functions.
 *
 * @dev This library uses a dedicated Diamond storage slot (keccak256 namespaced at
 *      "openadverts.queryv2.storage"), consistent with all other protocol storage libraries.
 *      The structs here serve dual purpose: storage fields for QueryV2 configuration
 *      (pagination limits, staleness threshold) and return types for view functions.
 */

// =========================================================================
// External Interface — Chainlink AggregatorV3 (subset)
// =========================================================================

interface AggregatorV3InterfaceV2 {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

library LibOpenAdvertsQueryStorage {
    bytes32 constant STORAGE_POSITION = keccak256("openadverts.queryv2.storage");

    // =========================================================================
    // Storage Structure
    // =========================================================================

    struct QueryV2Storage {
        /// @dev Maximum proposals that can be returned in a single paginated call.
        uint256 maxPaginatedResults;
        /// @dev Default page size when caller passes maxResults = 0.
        uint256 defaultPaginatedResults;
        /// @dev Staleness threshold in seconds (must match getPOLUSDPrice()).
        uint256 priceStalnessSeconds;
        /// @dev True once initializeQueryV2() has been called via the deploy script.
        bool initialized;
    }

    // =========================================================================
    // Storage Accessor
    // =========================================================================

    function queryV2Storage() internal pure returns (QueryV2Storage storage qs) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            qs.slot := position
        }
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /**
     * @notice Get max paginated results.
     * @return Maximum results.
     */
    function getMaxPaginatedResults() internal view returns (uint256) {
        uint256 v = queryV2Storage().maxPaginatedResults;
        return v == 0 ? 100 : v;
    }

    /**
     * @notice Get default paginated results.
     * @return Default results.
     */
    function getDefaultPaginatedResults() internal view returns (uint256) {
        uint256 v = queryV2Storage().defaultPaginatedResults;
        return v == 0 ? 50 : v;
    }

    /**
     * @notice Get price staleness seconds.
     * @return Staleness threshold.
     */
    function getPriceStalnessSeconds() internal view returns (uint256) {
        uint256 v = queryV2Storage().priceStalnessSeconds;
        return v == 0 ? 3600 : v;
    }

    // =========================================================================
    // Return Structs
    // =========================================================================

    // ── getAdvertisementsWithBalances ─────────────────────────────────────────

    /**
     * @notice Advertisement data augmented with current token balance.
     * @param advert             Original advertisement struct (unchanged).
     * @param balance            Current balance of the advertisement contract.
     *                           POL adverts: native wei balance.
     *                           USDC adverts: IERC20.balanceOf result.
     * @param balanceReadSuccess For USDC adverts, false when the balanceOf call
     *                           reverted or usdcTokenAddress is address(0).
     *                           For POL adverts: ALWAYS true — address.balance
     *                           is a VM property read and cannot revert.
     *                           FRONTEND: if advertCurrency==0 (POL) and this
     *                           field is false, log as a critical error because
     *                           that state is impossible.
     */
    struct AdvertWithBalance {
        LibOpenAdvertsAdvertisersStorage.AdvertStruct advert;
        uint256 balance;
        bool balanceReadSuccess;
    }

    // ── getUserDashboardDataLite ──────────────────────────────────────────

    /**
     * @notice Lightweight dashboard data — no voting history, no O(n) loops.
     * @param advBalance              OAD token balance (18 decimals).
     * @param usdcBalance             USDC balance (6 decimals).
     *                                Zero when usdcBalanceReadSuccess is false.
     * @param usdcBalanceReadSuccess  False when USDC call failed or address(0).
     * @param polBalance              Native POL balance in wei.
     * @param isContractOwner         True when user == diamond owner.
     * @param blockNumber             block.number at query time.
     */
    struct UserDashboardDataLite {
        uint256 advBalance;
        uint256 usdcBalance;
        bool usdcBalanceReadSuccess;
        uint256 polBalance;
        bool isContractOwner;
        uint256 blockNumber;
    }

    // ── getGovernanceSnapshot ─────────────────────────────────────────────

    /**
     * @notice Single admin candidate entry — merges the three separate arrays
     *         that getProposedOwnersAndVotes and returnGovernanceStorage return
     *         independently.  getGovernanceSnapshot is an optimised view
     *         function, not a drop-in replacement for either existing function.
     */
    struct ProposedAdminInfo {
        address candidateAddress;
        uint256 forVotes;
        string storageId;
    }

    /**
     * @notice Atomic snapshot of all governance page data.
     * @param contractOwner       Current diamond owner.
     * @param diamondFacets       All registered facets (≡ DiamondLoupeFacet.facets()).
     * @param proposedAdmins      Merged admin candidates: address + votes + storageId.
     * @param adminVoteId         Current election round ID.
     * @param adminVoteDeadline   Block number when the current election expires.
     * @param currentQuotas       All live governance quotas.
     * @param currentProposalId   Monotonically increasing proposal counter.
     * @param isProposalActive    True when a quota/facet proposal is live.
     * @param proposalType        Type of the active proposal.
     * @param proposalStruct      Votes and deadline for the active proposal.
     * @param proposedFacets      FacetCuts staged for an active FacetProposal
     *                            (empty array when no facet proposal is active).
     * @param currentBlockNumber  block.number at query time.
     */
    struct GovernanceSnapshot {
        address contractOwner;
        IDiamondLoupe.Facet[] diamondFacets;
        ProposedAdminInfo[] proposedAdmins;
        uint256 adminVoteId;
        uint256 adminVoteDeadline;
        LibOpenAdvertsGovernanceStorage.CurrentQuotas currentQuotas;
        uint256 currentProposalId;
        bool isProposalActive;
        LibOpenAdvertsGovernanceStorage.ProposalType proposalType;
        LibOpenAdvertsGovernanceStorage.ProposalStruct proposalStruct;
        IDiamondCut.FacetCut[] proposedFacets;
        uint256 currentBlockNumber;
    }

    // ── getPriceDataWithRequirements ──────────────────────────────────────

    /**
     * @notice POL/USD price together with pre-calculated USDC minimums.
     *
     * STALENESS HANDLING: When isPriceStale is true OR priceReadSuccess is
     * false, the frontend SHOULD:
     *   - Display a warning toast with staleness/unavailability message.
     *   - Disable advertisement submission forms.
     *   - Display inline warning near price values.
     *   - Log metric for Chainlink feed reliability monitoring.
     * minBountyUSDC and minFundingUSDC are still populated when isPriceStale
     * is true so the frontend can display values-with-warnings rather than
     * blank fields.  calculationSuccess=false only when the price feed call
     * itself reverted (priceReadSuccess=false).
     *
     * @param polUsdPrice         Raw Chainlink answer (8 decimals).  Zero on failure.
     * @param polUsdUpdatedAt     Chainlink updatedAt timestamp.  Zero on failure.
     * @param priceReadSuccess    False when the Chainlink call reverted or the
     *                            feed address is not yet configured.
     * @param isPriceStale        True when updatedAt is older than 3600 seconds.
     *                            May be true even when priceReadSuccess is true.
     * @param stalePriceAge       Exact age of the price in seconds
     *                            (block.timestamp - updatedAt).  Zero on failure.
     * @param minBountyUSDC       Minimum advert bounty in micro-USDC (6 decimals)
     *                            with USDC premium applied.
     * @param minFundingUSDC      Minimum advert funding in micro-USDC (6 decimals)
     *                            with USDC premium applied.
     * @param calculationSuccess  False only when the price feed call reverted.
     * @param usdcPremiumPCT      Premium percentage from governance quotas.
     * @param currentBlockNumber  block.number at query time.
     */
    struct PriceDataWithRequirements {
        uint256 polUsdPrice;
        uint256 polUsdUpdatedAt;
        bool priceReadSuccess;
        bool isPriceStale;
        uint256 stalePriceAge;
        uint256 minBountyUSDC;
        uint256 minFundingUSDC;
        bool calculationSuccess;
        uint256 usdcPremiumPCT;
        uint256 currentBlockNumber;
    }

    // ── getRewardSignatureData ────────────────────────────────────────────

    /**
     * @notice Aggregated on-chain data needed to construct and sign a reward
     *         payload.  Replaces 5 separate RPC calls with 1 atomic read.
     *
     * @param affiliateSigningAddress  The affiliate's registered signing address, used for
     *                                  server-to-server API identity. On-chain reward signatures are
     *                                  verified against the protocol-level openAdvertsSigningAddress,
     *                                  not this field.
     * @param affiliateStatus          Affiliate lifecycle status (0=Prospect,
     *                                  1=Approved, 2=Banned).  The backend
     *                                  MUST reject if not 1 (Approved).
     * @param affiliateClaimInfoAddress Address of the affiliate's
     *                                  IClaimPercentagesProvider contract
     *                                  (resolved from Diamond storage).
     * @param viewerNonce              Current nonce for (viewer, affiliate) on
     *                                  the advert contract.
     * @param thirdPartyCount          Number of third-party recipients declared
     *                                  by the affiliate's claim-info contract.
     * @param designatedAffiliate      The advert's bound affiliate — backend
     *                                  compares against affiliateReceivingAddress.
     * @param advertBounty             Per-engagement bounty from AdvertStruct
     *                                  (NOT the remaining contract balance).
     *                                  This is the value _verifySignatures hashes.
     * @param currentBlockNumber       block.number at query time — atomic with
     *                                  all other fields.
     */
    struct RewardSignatureData {
        address affiliateSigningAddress;
        uint8 affiliateStatus;
        address affiliateClaimInfoAddress;
        uint256 viewerNonce;
        uint256 thirdPartyCount;
        address designatedAffiliate;
        uint256 advertBounty;
        uint256 currentBlockNumber;
    }

    // ── getAffiliateAdvertsWithDetails ────────────────────────────────────

    /**
     * @notice Full snapshot of a single approved advert from the perspective
     *         of a specific affiliate, aggregated from an external
     *         getAllContractVariables() call on the advert contract.
     *
     * @param contractIssuer       The wallet that created the advert
     *                              (== AdvertStruct.advertOwner in practice).
     * @param currentBalance       Live token balance:
     *                              POL adverts → native wei balance,
     *                              USDC adverts → IERC20.balanceOf result.
     * @param initialFundedBudget  Budget at advert creation (wei or micro-USDC).
     * @param advertInfo           Full 15-field AdvertStruct from the external
     *                              advert contract.
     * @param payoutToken          Human-readable payment type: "POL" or "USDC".
     * @param readSuccess          false when the external getAllContractVariables
     *                              call reverted.  If false, all other fields
     *                              except advertInfo.advertContractAddress are
     *                              zero-initialised.
     */
    struct AffiliateAdvertDetails {
        address contractIssuer;
        uint256 currentBalance;
        uint256 initialFundedBudget;
        LibOpenAdvertsAdvertisersStorage.AdvertStruct advertInfo;
        string payoutToken;
        bool readSuccess;
    }
}
