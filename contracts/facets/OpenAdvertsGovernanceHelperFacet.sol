// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibOpenAdvertsGovernanceStorage} from "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import {LibOpenAdvertsAdvertisersStorage} from "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import {LibOpenAdvertsAffiliatesStorage} from "../libraries/LibOpenAdvertsAffiliatesStorage.sol";

/**
 * @title OpenAdvertsGovernanceHelperFacet
 * @notice Read-only governance query/history views, split out of OpenAdvertsGovernanceFacet to keep
 *         that facet under the 24KB (EIP-170) code-size limit and to give both facets durable headroom.
 * @dev Every function here is a pure storage read (no state mutation, no modifiers, no cross-facet
 *      self-calls). On-chain consumers (advert contracts) reach these via the Diamond by selector, so
 *      the split is transparent to them. Governance write logic stays in OpenAdvertsGovernanceFacet.
 */
contract OpenAdvertsGovernanceHelperFacet {
    // Immutable diamond address for direct calls (fund forwarding; facet convention).
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
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
     * @notice Receive function that forwards all funds to the diamond address.
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
