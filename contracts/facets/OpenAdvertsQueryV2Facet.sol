// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsQueryStorage.sol";
import "../libraries/LibOpenAdvertsPayoutStorage.sol";
import "../libraries/LibOpenAdvertsTimelockStorage.sol";
import {LibOpenAdvertsQueryHelpers} from "../libraries/LibOpenAdvertsQueryHelpers.sol";

/**
 * @dev Minimal interface for external calls to advertisement contracts
 *      (both POL and USDC variants share this subset).
 */
interface IAdvertContractForQuery {
    function userAffiliateNonces(address viewer, address affiliate) external view returns (uint256);

    function getAllContractVariables()
        external
        view
        returns (
            address rspContractIssuer,
            uint256 rspAdvertbudget,
            uint256 rspInitialFundedBudget,
            LibOpenAdvertsAdvertisersStorage.AdvertStruct memory rspadvertInfo,
            address diamondaddress,
            string memory payoutToken
        );
}

/**
 * @dev Minimal interface for the affiliate's claim-percentages provider.
 */
interface IClaimPercentagesProviderForQuery {
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
 * @title OpenAdvertsQueryV2Facet
 * @notice Performance-optimised batch view functions.  Reduces frontend RPC
 *         calls from ~70 per page-load to 3-6 depending on active page.
 *
 * DEPLOYMENT: Add via diamondCut (FacetCutAction.Add) with five new selectors.
 *   The existing OpenAdvertsQueryFacet is NOT modified or removed.
 *   No governance proposal is required — diamond cut can be executed directly
 *   by the contract owner.
 *
 * FIVE FUNCTIONS:
 *   Priority 0 — getAdvertisementsWithBalances()
 *   Priority 0 — getUserDashboardDataLite(address)
 *   Priority 1 — getGovernanceSnapshot()
 *   Priority 1 — getPriceDataWithRequirements()
 *   Priority 1 — getUserVotingHistoryPaginated(address,uint256,uint256)
 *
 * PRE-EXISTING BUG DOCUMENTED (do not fix here — separate work item):
 *   ratifyNewAdmin() calls `delete govStorage.proposedAdminAddresses` after each
 *   election round.  The _getAdminVotingData helper in OpenAdvertsQueryFacet
 *   iterates (round 0..adminVoteId) × proposedAdminAddresses (current only).
 *   Votes cast in previous rounds against now-deleted candidates are silently
 *   dropped.  getUserVotingHistoryPaginated inherits this same behaviour to
 *   stay consistent with getUserCompleteDetailedVotingHistory.  Fixing it
 *   requires persisting per-round candidate snapshots in storage.
 *
 * STALENESS LOGIC NOTE:
 *   getPriceDataWithRequirements intentionally duplicates the 3600-second
 *   staleness threshold from getPOLUSDPrice().  This is necessary because
 *   getPOLUSDPrice() reverts on stale data, making it unusable in a batched
 *   view function that must degrade gracefully.  If the staleness window is
 *   changed in getPOLUSDPrice() it must also be updated here.
 */
contract OpenAdvertsQueryV2Facet {
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
        // Storage initialisation happens via initializeQueryV2() called post-diamondCut.
        // Constructor writes target the facet's own storage, not the Diamond's storage.
    }

    // =========================================================================
    // PRIORITY 0 — getAdvertisementsWithBalances
    // =========================================================================

    /**
     * @notice Returns all prospect and approved advertisements with their
     *         current token balances in a single atomic call.
     *
     * Replaces a frontend loop of 100+ individual balance RPC calls.
     * usdcTokenAddress is read once from storage and cached across both arrays.
     *
     * @return prospectAdvertisements  Prospect ads with balance data.
     * @return approvedAdvertisements  Approved ads with balance data.
     */
    function getAdvertisementsWithBalances()
        external
        view
        returns (
            LibOpenAdvertsQueryStorage.AdvertWithBalance[] memory prospectAdvertisements,
            LibOpenAdvertsQueryStorage.AdvertWithBalance[] memory approvedAdvertisements
        )
    {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        // Cache once — avoids re-reading storage for every USDC advert.
        address usdcAddress = aas.usdcTokenAddress;

        prospectAdvertisements = LibOpenAdvertsQueryHelpers.buildAdvertsWithBalances(aas.prospectAdvertisements, usdcAddress);
        approvedAdvertisements = LibOpenAdvertsQueryHelpers.buildAdvertsWithBalances(aas.approvedAdvertisements, usdcAddress);
    }

    // =========================================================================
    // PRIORITY 0 — getUserDashboardDataLite
    // =========================================================================

    /**
     * @notice Returns lightweight wallet dashboard data in a single atomic call.
     *
     * Replaced the original getUserDashboardData (which included voting history)
     * per frontend spec revision.  Voting history is fetched separately via
     * getUserVotingHistoryPaginated when the user navigates to their profile
     * page.  This eliminates both the cross-facet call dependency and the
     * O(proposalCount) complexity from the critical dashboard path.
     *
     * All reads are either direct storage accesses or a single external USDC
     * call — no loops, O(1) gas complexity.
     *
     * @param user   The wallet address to query.
     * @return data  Dashboard fields at a consistent block state.
     */
    function getUserDashboardDataLite(address user) external view returns (LibOpenAdvertsQueryStorage.UserDashboardDataLite memory data) {
        data.advBalance = LibOpenAdvertsTokenStorage.tokenStorage().balances[user];

        // Native POL: property read, cannot revert.
        data.polBalance = user.balance;

        // Owner check: direct storage read.
        data.isContractOwner = (LibDiamond.contractOwner() == user);

        // USDC: external call — wrap in try/catch.
        address usdcAddress = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().usdcTokenAddress;
        if (usdcAddress != address(0)) {
            try IERC20(usdcAddress).balanceOf(user) returns (uint256 bal) {
                data.usdcBalance = bal;
                data.usdcBalanceReadSuccess = true;
            } catch {
                data.usdcBalance = 0;
                data.usdcBalanceReadSuccess = false;
            }
        }
        // usdcBalanceReadSuccess stays false (zero-value) when usdcAddress == address(0).

        data.blockNumber = block.number;
    }

    // =========================================================================
    // PRIORITY 1 — getGovernanceSnapshot
    // =========================================================================

    /**
     * @notice Returns all governance page data in a single atomic call.
     *
     * Replaces five separate calls: owner, facets, getProposedOwnersAndVotes,
     * returnGovernanceStorage, block.number.
     *
     * Admin candidate data is merged into a single ProposedAdminInfo[] array.
     * This differs from the return types of getProposedOwnersAndVotes and
     * returnGovernanceStorage (which return separate parallel arrays).
     * getGovernanceSnapshot is an optimised view — it is NOT a drop-in
     * replacement for either existing function.
     *
     * Zero external calls — all reads target diamond storage and governance
     * storage directly.  Atomicity is guaranteed.
     *
     * @return snap  Full governance snapshot at the current block.
     */
    function getGovernanceSnapshot() external view returns (LibOpenAdvertsQueryStorage.GovernanceSnapshot memory snap) {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();

        snap.currentBlockNumber = block.number;
        snap.contractOwner = ds.contractOwner;

        // ── Diamond facet list ────────────────────────────────────────────────
        uint256 numFacets = ds.facetAddresses.length;
        snap.diamondFacets = new IDiamondLoupe.Facet[](numFacets);
        for (uint256 i = 0; i < numFacets; ) {
            address facetAddr = ds.facetAddresses[i];
            snap.diamondFacets[i].facetAddress = facetAddr;
            snap.diamondFacets[i].functionSelectors = ds.facetFunctionSelectors[facetAddr].functionSelectors;
            unchecked {
                ++i;
            }
        }

        // ── Admin election data (merged — replaces three separate parallel arrays)
        uint256 adminLen = gs.proposedAdminAddresses.length;
        snap.proposedAdmins = new LibOpenAdvertsQueryStorage.ProposedAdminInfo[](adminLen);
        for (uint256 i = 0; i < adminLen; ) {
            address candidate = gs.proposedAdminAddresses[i];
            snap.proposedAdmins[i] = LibOpenAdvertsQueryStorage.ProposedAdminInfo({
                candidateAddress: candidate,
                forVotes: gs.totalVotesPerAdminCandidate[gs.adminVoteId][candidate],
                storageId: gs.adminApplicantStorageId[candidate][gs.adminVoteId]
            });
            unchecked {
                ++i;
            }
        }
        snap.adminVoteId = gs.adminVoteId;
        snap.adminVoteDeadline = gs.adminVoteDeadline;

        // ── Quota/proposal state ──────────────────────────────────────────────
        snap.currentQuotas = gs.currentQuotas;
        snap.currentProposalId = gs.currentProposalId;
        snap.isProposalActive = gs.isProposalActive;
        snap.proposalType = gs.proposalType;
        snap.proposalStruct = gs.proposalStruct;

        // Proposed facets: only populated during an active FacetProposal.
        uint256 facetCutLen = gs.proposedNewFacets.length;
        snap.proposedFacets = new IDiamondCut.FacetCut[](facetCutLen);
        for (uint256 i = 0; i < facetCutLen; ) {
            snap.proposedFacets[i] = gs.proposedNewFacets[i];
            unchecked {
                ++i;
            }
        }
    }

    // =========================================================================
    // PRIORITY 1 — getPriceDataWithRequirements
    // =========================================================================

    /**
     * @notice Returns current POL/USD price with pre-calculated USDC minimums.
     *
     * Does NOT call the existing getPOLUSDPrice() or calculateMinimumUSDCRequirements()
     * because both revert on stale data, making them unusable in a graceful-
     * degradation context.  latestRoundData() is called directly so that a
     * stale price is returned with isPriceStale=true rather than reverting.
     * The calculation math is identical to calculateMinimumUSDCRequirements().
     *
     * Governance quotas are read unconditionally — the frontend receives them
     * even when the Chainlink feed is down.
     *
     * @return data  Price + requirements data with success and staleness flags.
     */
    function getPriceDataWithRequirements() external view returns (LibOpenAdvertsQueryStorage.PriceDataWithRequirements memory data) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();

        data.currentBlockNumber = block.number;

        // Read governance quotas unconditionally — these are pure storage reads
        // and are useful to the frontend even if the price feed fails.
        data.usdcPremiumPCT = gs.currentQuotas.USDCCurrencyPremiumInPCT;
        uint256 minBountyWei = gs.currentQuotas.minAdvertBountyInPOLWei;
        uint256 minFundingWei = gs.currentQuotas.minPOLRequiredforAdvertInWei;

        address priceFeedAddress = aas.priceFeedAddress;
        if (priceFeedAddress == address(0)) {
            // Price feed not configured; return raw quotas and zero prices.
            return data;
        }

        try AggregatorV3InterfaceV2(priceFeedAddress).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            // Validate oracle response before using it.
            if (answer <= 0 || updatedAt == 0) {
                // Malformed data; treat as feed failure without reverting.
                return data;
            }

            // Fetch decimals; fall back to the Chainlink standard (8) if the
            // call reverts (e.g., a mock without this function).
            uint8 dec = 8;
            try AggregatorV3InterfaceV2(priceFeedAddress).decimals() returns (uint8 d) {
                dec = d;
            } catch {}
            data.polUsdPrice = uint256(answer);
            data.polUsdUpdatedAt = updatedAt;
            data.priceReadSuccess = true;

            uint256 age = block.timestamp - updatedAt;
            data.stalePriceAge = age;
            data.isPriceStale = age > LibOpenAdvertsQueryStorage.getPriceStalnessSeconds();

            // ── Calculate USDC requirements ────────────────────────────────
            // Identical math to calculateMinimumUSDCRequirements().
            // 10 ** (18 + dec - 6) normalises from (wei × price_8dec) to micro-USDC.
            // Overflow analysis: max realistic values are
            //   minFundingWei ~ 200e18  (200 POL)
            //   polUsdPrice   ~ 1e11    (POL at $1 000, 8 decimals)
            // Product ~4e31, well within uint256 range (~1.16e77).
            uint256 divisor = 10 ** (18 + dec - 6);
            uint256 minBountyBase = (minBountyWei * data.polUsdPrice) / divisor;
            uint256 minFundingBase = (minFundingWei * data.polUsdPrice) / divisor;

            data.minBountyUSDC = (minBountyBase * (100 + data.usdcPremiumPCT)) / 100;
            data.minFundingUSDC = (minFundingBase * (100 + data.usdcPremiumPCT)) / 100;
            // calculationSuccess=true even when isPriceStale=true so the
            // frontend can display values with a warning rather than blank fields.
            data.calculationSuccess = true;
        } catch {
            // Chainlink call reverted entirely.
            // priceReadSuccess and calculationSuccess remain false.
            // Governance quotas (usdcPremiumPCT etc.) are still populated above.
        }
    }

    // =========================================================================
    // PRIORITY 1 — getUserVotingHistoryPaginated
    // =========================================================================

    /**
     * @notice Returns a paginated slice of a user's governance proposal voting
     *         history, together with their complete non-proposal voting data.
     *
     * PAGINATION MODEL:  Proposals are indexed 1..currentProposalId.  The
     * caller passes fromProposalId (inclusive start) and maxResults (max
     * user-voted proposals to return per page).  The function scans from
     * fromProposalId upward, collecting proposals the user voted on, and
     * stops when maxResults is reached or currentProposalId is exhausted.
     *
     * hasMore=true means additional proposals exist beyond this page.
     * Use nextProposalId as fromProposalId for the subsequent call.
     *
     * NON-PROPOSAL VOTING (admin, affiliate, advert):  These use different
     * storage indices and are NOT paginated here — they are returned in full.
     * Admin voting inherits the pre-existing bug described in the contract
     * header: votes against candidates cleared by ratifyNewAdmin() are silently
     * absent.
     *
     * GOVERNANCE STATE: The returned VotingHistoryData struct embeds current
     * governance state (currentQuotas, isProposalActive, proposalStruct, etc.)
     * exactly as getUserCompleteDetailedVotingHistory does.  If
     * getGovernanceSnapshot was already called for the same page, this data
     * is redundant.
     *
     * @param user            Address to query.
     * @param fromProposalId  First proposal ID to scan (inclusive, 1-based).
     *                        Pass 1 for the first page.  Pass 0 to auto-start at 1.
     * @param maxResults      Maximum user-voted proposals to return.
     *                        Capped at 100.  Pass 0 to use default of 50.
     *
     * @return votingHistory     VotingHistoryData filtered to the scanned range.
     * @return hasMore           True when proposals remain beyond this page.
     * @return nextProposalId    Pass this as fromProposalId for the next page.
     *                           Meaningless when hasMore is false.
     * @return totalProposalCount  gs.currentProposalId — total proposals ever
     *                             created (not the number the user voted on).
     */
    function getUserVotingHistoryPaginated(
        address user,
        uint256 fromProposalId,
        uint256 maxResults
    )
        external
        view
        returns (
            LibOpenAdvertsGovernanceStorage.VotingHistoryData memory votingHistory,
            bool hasMore,
            uint256 nextProposalId,
            uint256 totalProposalCount
        )
    {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();

        // ── Input normalisation ───────────────────────────────────────────────
        if (fromProposalId == 0) fromProposalId = 1;
        if (maxResults == 0) maxResults = LibOpenAdvertsQueryStorage.getDefaultPaginatedResults();
        if (maxResults > LibOpenAdvertsQueryStorage.getMaxPaginatedResults()) maxResults = LibOpenAdvertsQueryStorage.getMaxPaginatedResults();

        totalProposalCount = gs.currentProposalId;

        // ── Pass 1: scan to find stop point and count ─────────────────────────
        // We scan [fromProposalId, currentProposalId] and stop when either
        // we've collected maxResults user-voted proposals OR we run out of proposals.
        uint256 count = 0;
        uint256 stopId = fromProposalId; // the last proposal ID we examined
        bool reachedMax = false;

        for (uint256 i = fromProposalId; i <= gs.currentProposalId; ) {
            if (gs.hasVotedOnProposal[user][i]) {
                count++;
                if (count == maxResults) {
                    stopId = i;
                    reachedMax = true;
                    break;
                }
            }
            stopId = i;
            unchecked {
                ++i;
            }
        }

        // ── Pagination state ──────────────────────────────────────────────────
        if (reachedMax) {
            // We found maxResults votes.  More may exist if stopId isn't the end.
            hasMore = (stopId < gs.currentProposalId);
            nextProposalId = stopId + 1;
        } else {
            // Exhausted all proposals without reaching maxResults.
            hasMore = false;
            nextProposalId = gs.currentProposalId + 1;
        }

        // ── Pass 2: allocate and fill proposal arrays ─────────────────────────
        votingHistory.proposalIds = new uint256[](count);
        votingHistory.proposalSupportVotes = new uint256[](count);
        votingHistory.proposalDenyVotes = new uint256[](count);
        votingHistory.proposalVotedFor = new bool[](count);

        uint256 idx = 0;
        for (uint256 i = fromProposalId; i <= stopId; ) {
            if (gs.hasVotedOnProposal[user][i]) {
                votingHistory.proposalIds[idx] = i;
                votingHistory.proposalSupportVotes[idx] = gs.votesByUser[user][i][true];
                votingHistory.proposalDenyVotes[idx] = gs.votesByUser[user][i][false];
                votingHistory.proposalVotedFor[idx] = gs.votesByUser[user][i][true] > 0;
                unchecked {
                    ++idx;
                }
            }
            unchecked {
                ++i;
            }
        }

        // ── Admin voting data (not paginated — see NatSpec warning) ───────────
        // Replicates _getAdminVotingData from OpenAdvertsQueryFacet inline
        // (that function is `internal` and inaccessible from this contract).
        {
            uint256 adminCount = 0;
            for (uint256 round = 0; round <= gs.adminVoteId; ) {
                for (uint256 j = 0; j < gs.proposedAdminAddresses.length; ) {
                    if (gs.adminVotesByUser[user][round][gs.proposedAdminAddresses[j]] > 0) {
                        unchecked {
                            ++adminCount;
                        }
                    }
                    unchecked {
                        ++j;
                    }
                }
                unchecked {
                    ++round;
                }
            }
            votingHistory.adminVoteRounds = new uint256[](adminCount);
            votingHistory.adminCandidates = new address[](adminCount);
            votingHistory.adminVotes = new uint256[](adminCount);
            uint256 aIdx = 0;
            for (uint256 round = 0; round <= gs.adminVoteId; ) {
                for (uint256 j = 0; j < gs.proposedAdminAddresses.length; ) {
                    address candidate = gs.proposedAdminAddresses[j];
                    uint256 userVotes = gs.adminVotesByUser[user][round][candidate];
                    if (userVotes > 0) {
                        votingHistory.adminVoteRounds[aIdx] = round;
                        votingHistory.adminCandidates[aIdx] = candidate;
                        votingHistory.adminVotes[aIdx] = userVotes;
                        unchecked {
                            ++aIdx;
                        }
                    }
                    unchecked {
                        ++j;
                    }
                }
                unchecked {
                    ++round;
                }
            }
        }

        // ── Affiliate voting data ─────────────────────────────────────────────
        {
            LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
            address[] memory affAddrs = afs.userVotingAddresses[user];
            votingHistory.affiliateAddresses = affAddrs;
            votingHistory.affiliateSupportVotes = new uint256[](affAddrs.length);
            votingHistory.affiliateDenyVotes = new uint256[](affAddrs.length);
            for (uint256 i = 0; i < affAddrs.length; ) {
                votingHistory.affiliateSupportVotes[i] = afs.hasVotedVotes[affAddrs[i]][user][true];
                votingHistory.affiliateDenyVotes[i] = afs.hasVotedVotes[affAddrs[i]][user][false];
                unchecked {
                    ++i;
                }
            }
        }

        // ── Advert voting data ────────────────────────────────────────────────
        {
            LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage
                .openAdvertsAdvertisersStorage();
            address[] memory advAddrs = aas.userVotingAddresses[user];
            votingHistory.advertAddresses = advAddrs;
            votingHistory.advertSupportVotes = new uint256[](advAddrs.length);
            votingHistory.advertDenyVotes = new uint256[](advAddrs.length);
            for (uint256 i = 0; i < advAddrs.length; ) {
                votingHistory.advertSupportVotes[i] = aas.hasVotedVotes[advAddrs[i]][user][true];
                votingHistory.advertDenyVotes[i] = aas.hasVotedVotes[advAddrs[i]][user][false];
                unchecked {
                    ++i;
                }
            }
        }

        // ── Governance state (embedded for frontend convenience) ──────────────
        // NOTE: If getGovernanceSnapshot was called for the same page load,
        // this data is redundant.  Clients may discard it.
        votingHistory.currentQuotas = gs.currentQuotas;
        votingHistory.currentProposalId = gs.currentProposalId;
        votingHistory.isProposalActive = gs.isProposalActive;
        votingHistory.proposalType = gs.proposalType;
        votingHistory.proposalStruct = gs.proposalStruct;

        uint256 facetLen = gs.proposedNewFacets.length;
        votingHistory.proposedFacets = new IDiamondCut.FacetCut[](facetLen);
        for (uint256 i = 0; i < facetLen; ) {
            votingHistory.proposedFacets[i] = gs.proposedNewFacets[i];
            unchecked {
                ++i;
            }
        }

        votingHistory.proposedAdminAddresses = gs.proposedAdminAddresses;
        votingHistory.adminVoteId = gs.adminVoteId;
        votingHistory.adminVoteDeadline = gs.adminVoteDeadline;

        uint256 adminLen = gs.proposedAdminAddresses.length;
        votingHistory.adminStorageIds = new string[](adminLen);
        for (uint256 i = 0; i < adminLen; ) {
            votingHistory.adminStorageIds[i] = gs.adminApplicantStorageId[gs.proposedAdminAddresses[i]][gs.adminVoteId];
            unchecked {
                ++i;
            }
        }

        // ── Lifetime vote count totals ────────────────────────────────────────
        // Matches the logic in GovernanceFacet.getUserCompleteVotingHistory().
        // Note: totalAdminVoteCount shares the known limitation that votes for
        // candidates cleared by ratifyNewAdmin() in prior rounds are not counted.
        {
            uint256 totalPropVotes = 0;
            for (uint256 i = 1; i <= gs.currentProposalId; ) {
                if (gs.hasVotedOnProposal[user][i]) {
                    unchecked {
                        ++totalPropVotes;
                    }
                }
                unchecked {
                    ++i;
                }
            }
            votingHistory.totalProposalVoteCount = totalPropVotes;

            uint256 totalAdminVotes = 0;
            for (uint256 round = 0; round <= gs.adminVoteId; ) {
                for (uint256 j = 0; j < gs.proposedAdminAddresses.length; ) {
                    if (gs.adminVotesByUser[user][round][gs.proposedAdminAddresses[j]] > 0) {
                        unchecked {
                            ++totalAdminVotes;
                        }
                    }
                    unchecked {
                        ++j;
                    }
                }
                unchecked {
                    ++round;
                }
            }
            votingHistory.totalAdminVoteCount = totalAdminVotes;

            votingHistory.totalAdvertVoteCount = votingHistory.advertAddresses.length;
            votingHistory.totalAffiliateVoteCount = votingHistory.affiliateAddresses.length;
        }
    }

    // =========================================================================
    // Configuration Functions (Owner Only)
    // =========================================================================

    /**
     * @notice One-time initialisation called by the deploy script immediately after
     *         this facet is added to the Diamond via diamondCut.
     * @dev Constructor writes target the facet's own storage — not the Diamond's
     *      storage — so defaults must be set via this post-cut call instead.
     *      Reverts if called a second time.
     */
    function initializeQueryV2(uint256 _maxPaginatedResults, uint256 _defaultPaginatedResults, uint256 _priceStalnessSeconds) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsQueryStorage.QueryV2Storage storage qs = LibOpenAdvertsQueryStorage.queryV2Storage();
        require(!qs.initialized, "QueryV2: already initialized");
        require(_maxPaginatedResults > 0, "QueryV2: max must be > 0");
        require(_defaultPaginatedResults > 0 && _defaultPaginatedResults <= _maxPaginatedResults, "QueryV2: invalid default");
        require(_priceStalnessSeconds > 0, "QueryV2: staleness must be > 0");
        qs.maxPaginatedResults = _maxPaginatedResults;
        qs.defaultPaginatedResults = _defaultPaginatedResults;
        qs.priceStalnessSeconds = _priceStalnessSeconds;
        qs.initialized = true;
    }

    /**
     * @notice Set maximum paginated results limit.
     * @dev Only owner can call. Must be > 0 and >= defaultPaginatedResults.
     * @param _maxPaginatedResults New maximum limit.
     */
    function setMaxPaginatedResults(uint256 _maxPaginatedResults) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsQueryStorage.QueryV2Storage storage qs = LibOpenAdvertsQueryStorage.queryV2Storage();
        require(_maxPaginatedResults > 0, "QueryV2: max must be > 0");
        require(_maxPaginatedResults >= qs.defaultPaginatedResults, "QueryV2: max must be >= default");
        qs.maxPaginatedResults = _maxPaginatedResults;
    }

    /**
     * @notice Set default paginated results.
     * @dev Only owner can call. Must be > 0 and <= maxPaginatedResults.
     * @param _defaultPaginatedResults New default page size.
     */
    function setDefaultPaginatedResults(uint256 _defaultPaginatedResults) external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsQueryStorage.QueryV2Storage storage qs = LibOpenAdvertsQueryStorage.queryV2Storage();
        require(_defaultPaginatedResults > 0, "QueryV2: default must be > 0");
        require(_defaultPaginatedResults <= qs.maxPaginatedResults, "QueryV2: default must be <= max");
        qs.defaultPaginatedResults = _defaultPaginatedResults;
    }

    /**
     * @notice Set price staleness threshold in seconds.
     * @dev Phase 3: dual-auth (see OpenAdvertsAdvertisersFacet.setOracleStalenessSeconds).
     * @param _priceStalnessSeconds New staleness threshold.
     */
    function setPriceStalnessSeconds(uint256 _priceStalnessSeconds) external {
        _enforceOwnerOrTimelockExec();
        LibOpenAdvertsQueryStorage.QueryV2Storage storage qs = LibOpenAdvertsQueryStorage.queryV2Storage();
        require(_priceStalnessSeconds > 0, "QueryV2: staleness must be > 0");
        qs.priceStalnessSeconds = _priceStalnessSeconds;
    }

    /**
     * @notice Get current QueryV2 configuration settings.
     * @return maxPaginatedResults Current maximum page size.
     * @return defaultPaginatedResults Current default page size.
     * @return priceStalnessSeconds Current staleness threshold.
     */
    function getQueryV2Settings() external view returns (uint256 maxPaginatedResults, uint256 defaultPaginatedResults, uint256 priceStalnessSeconds) {
        LibOpenAdvertsQueryStorage.QueryV2Storage storage qs = LibOpenAdvertsQueryStorage.queryV2Storage();
        return (qs.maxPaginatedResults, qs.defaultPaginatedResults, qs.priceStalnessSeconds);
    }

    // =========================================================================
    // VIEWER COOLDOWN STATE
    // =========================================================================

    /**
     * @notice Returns the per-(viewer, advertContract) cooldown state.
     * @dev Useful for the backend to check whether a given viewer is currently within the
     *      engagement cooldown window for specific adverts before issuing a signed reward.
     *      With 1:1 advert-affiliate binding, affiliate is now implicit (designated affiliate only).
     * @param viewerAddress The viewer's wallet address.
     * @param advertContractAddresses Array of advertisement contract addresses to check in one call.
     * @return lastEngagementBlocks Parallel array of the last accepted engagement block per advert.
     */
    function getViewerCooldownState(
        address viewerAddress,
        address[] calldata advertContractAddresses
    ) external view returns (uint256[] memory lastEngagementBlocks) {
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();
        uint256 len = advertContractAddresses.length;
        lastEngagementBlocks = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            lastEngagementBlocks[i] = payoutStore.viewerLastEngagementBlock[viewerAddress][advertContractAddresses[i]];
        }
    }

    // =========================================================================
    // REWARD SIGNATURE DATA — Consolidates 5 RPC calls into 1
    // =========================================================================

    /**
     * @notice Returns all on-chain data the backend needs to construct and sign
     *         a reward payload, in a single atomic view call.
     *
     * Replaces five separate RPC calls:
     *   1. getAffiliateDetailsAndStatus (Diamond storage — internal read)
     *   2. userAffiliateNonces          (external call to advert contract)
     *   3. getClaimPercentages          (external call to affiliateClaimInfo contract)
     *   4. getAllContractVariables       (external call to advert contract)
     *   5. eth_blockNumber              (block.number opcode — free, atomic)
     *
     * The affiliateClaimInfoAddress parameter from the original spec is NOT
     * required — it is resolved internally from Diamond affiliate storage,
     * reducing the parameter count from 4 to 3 and eliminating a trust
     * assumption on caller-supplied data.
     *
     * IMPORTANT: `advertBounty` returns `advertInfo.advertBounty` (the per-
     * engagement bounty from AdvertStruct), NOT the contract's remaining
     * balance (`rspAdvertbudget`).  This matches what `_verifySignatures`
     * in the advert contract hashes.  The previous frontend code incorrectly
     * used `contractVars[1]` (remaining balance) — this function corrects that.
     *
     * @param advertContractAddress      The advertisement contract to query.
     * @param affiliateReceivingAddress  The affiliate wallet address.
     * @param viewerAddress              The viewer wallet address.
     * @return data  All fields needed for reward signature construction.
     */
    function getRewardSignatureData(
        address advertContractAddress,
        address affiliateReceivingAddress,
        address viewerAddress
    ) external view returns (LibOpenAdvertsQueryStorage.RewardSignatureData memory data) {
        // ── Replaces RPC #1: getAffiliateDetailsAndStatus ─────────────────
        // Direct Diamond storage read — no external call needed.
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(afs.affiliateExists[affiliateReceivingAddress], "Affiliate does not exist");

        LibOpenAdvertsAffiliatesStorage.AffiliateType status = afs.affiliateStatus[affiliateReceivingAddress];
        uint256 index = afs.affiliateIndex[affiliateReceivingAddress];

        LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate;
        if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            affiliate = afs.prospectAffiliates[index];
        } else if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            affiliate = afs.approvedAffiliates[index];
        } else if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            affiliate = afs.bannedAffiliates[index];
        }

        data.affiliateSigningAddress = affiliate.affiliateSigningAddress;
        data.affiliateStatus = uint8(status);
        data.affiliateClaimInfoAddress = affiliate.affiliateClaimInfoAddress;

        // ── Replaces RPC #2: userAffiliateNonces ──────────────────────────
        data.viewerNonce = IAdvertContractForQuery(advertContractAddress).userAffiliateNonces(viewerAddress, affiliateReceivingAddress);

        // ── Replaces RPC #3: getClaimPercentages ──────────────────────────
        // Uses the affiliateClaimInfoAddress resolved from Diamond storage above.
        (, , uint256 tpCount, ) = IClaimPercentagesProviderForQuery(affiliate.affiliateClaimInfoAddress).getClaimPercentages();
        data.thirdPartyCount = tpCount;

        // ── Replaces RPC #4: getAllContractVariables ──────────────────────
        (
            , // rspContractIssuer
            , // rspAdvertbudget (remaining balance — NOT what we need)
            , // rspInitialFundedBudget
            LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertInfo,
            , // diamondaddress

        ) = IAdvertContractForQuery(advertContractAddress).getAllContractVariables(); // payoutToken

        data.designatedAffiliate = advertInfo.designatedAffiliate;
        data.advertBounty = advertInfo.advertBounty; // Per-engagement bounty — matches _verifySignatures hash

        // ── Replaces RPC #5: eth_blockNumber ──────────────────────────────
        data.currentBlockNumber = block.number;
    }

    // =========================================================================
    // Affiliate → Approved Adverts with Full Contract Details (Paginated)
    // =========================================================================

    /**
     * @notice Returns full contract details for every approved advert bound to
     *         a given affiliate, with pagination support.
     *
     * Combines getApprovedAdvertsForAffiliate (address[]) with an external
     * getAllContractVariables() call on each advert contract, returning a rich
     * struct array in a single atomic call.
     *
     * Pagination is recommended because each entry involves an external call
     * with string copying (payoutToken), which consumes significant gas.
     * For affiliates with many approved adverts, unbounded iteration could
     * exceed the block gas limit.
     *
     * @param affiliate    The affiliate address to query.
     * @param startIndex   Zero-based index into the affiliate's approved-adverts
     *                     array.  Pass 0 for the first page.
     * @param maxResults   Maximum entries to return.  Capped internally at
     *                     maxPaginatedResults.  Pass 0 to use the default page
     *                     size from QueryV2 settings.
     *
     * @return results     Array of AffiliateAdvertDetails structs.
     *                     Length ≤ maxResults.  Each entry has readSuccess=true
     *                     unless the external call reverted.
     * @return totalCount  Total approved adverts for this affiliate (before
     *                     pagination).  Useful for UI page-count calculations.
     * @return hasMore     True when entries remain beyond this page.
     */
    function getAffiliateAdvertsWithDetails(
        address affiliate,
        uint256 startIndex,
        uint256 maxResults
    ) external view returns (LibOpenAdvertsQueryStorage.AffiliateAdvertDetails[] memory results, uint256 totalCount, bool hasMore) {
        address[] storage addrs = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().affiliateApprovedAdverts[affiliate];

        totalCount = addrs.length;

        // If startIndex is beyond the array, return empty.
        if (startIndex >= totalCount) {
            return (new LibOpenAdvertsQueryStorage.AffiliateAdvertDetails[](0), totalCount, false);
        }

        // Normalise maxResults.
        if (maxResults == 0) maxResults = LibOpenAdvertsQueryStorage.getDefaultPaginatedResults();
        uint256 cap = LibOpenAdvertsQueryStorage.getMaxPaginatedResults();
        if (maxResults > cap) maxResults = cap;

        // Determine actual page size.
        uint256 remaining = totalCount - startIndex;
        uint256 pageSize = remaining < maxResults ? remaining : maxResults;
        hasMore = (startIndex + pageSize) < totalCount;

        results = new LibOpenAdvertsQueryStorage.AffiliateAdvertDetails[](pageSize);

        for (uint256 i = 0; i < pageSize; ) {
            address advertAddr = addrs[startIndex + i];

            try IAdvertContractForQuery(advertAddr).getAllContractVariables() returns (
                address rspContractIssuer,
                uint256 rspAdvertbudget,
                uint256 rspInitialFundedBudget,
                LibOpenAdvertsAdvertisersStorage.AdvertStruct memory rspadvertInfo,
                address, // diamondaddress — omitted, always known
                string memory payoutToken
            ) {
                results[i].contractIssuer = rspContractIssuer;
                results[i].currentBalance = rspAdvertbudget;
                results[i].initialFundedBudget = rspInitialFundedBudget;
                results[i].advertInfo = rspadvertInfo;
                // The external contract's AdvertStruct may have advertContractAddress
                // set to address(0) (it can't know its own address at construction).
                // Overwrite with the authoritative value from Diamond storage.
                results[i].advertInfo.advertContractAddress = advertAddr;
                results[i].payoutToken = payoutToken;
                results[i].readSuccess = true;
            } catch {
                // Preserve the address so the frontend knows which contract failed.
                results[i].advertInfo.advertContractAddress = advertAddr;
                // readSuccess stays false; all other fields are zero-initialised.
            }
            unchecked {
                ++i;
            }
        }
    }

    // =========================================================================
    // Affiliate → Approved Advert Reverse Index
    // =========================================================================

    /**
     * @notice Returns all currently-approved advert contract addresses for a given affiliate.
     * @param affiliate The affiliate address to query.
     * @return advertAddresses Array of approved advert contract addresses bound to this affiliate.
     */
    function getApprovedAdvertsForAffiliate(address affiliate) external view returns (address[] memory advertAddresses) {
        return LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().affiliateApprovedAdverts[affiliate];
    }

    // =========================================================================
    // Receive — forward ETH to Diamond (consistent with all other facets)
    // =========================================================================

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
