// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IOpenAdvertsAffiliatesFacet - Interface for calling main facet
 */
interface IOpenAdvertsAffiliatesFacet {
    function reclassifyAffiliate(
        address affiliateAddress,
        LibOpenAdvertsAffiliatesStorage.AffiliateType fromType,
        LibOpenAdvertsAffiliatesStorage.AffiliateType toType,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    ) external;
}

/**
 * @title IOpenAdvertsTokenFacet - Universal Voting Protection
 */
interface IOpenAdvertsTokenFacet {
    function canVoteThisBlock(address account) external view returns (bool);
    function recordVoteActivity(address voter) external;
}

/**
 * @title OpenAdvertsAffiliatesVotingFacet
 * @dev Handles all voting operations for affiliates - separated for contract size optimization
 */
contract OpenAdvertsAffiliatesVotingFacet is ReentrancyGuard {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    event AffiliateApproved(
        address indexed affiliateAddress,
        uint256 affiliateIndex,
        uint256 affilateFavorableScore,
        uint256 affiliateUnfavorableScore,
        string affiliateStorageID
    );

    event AffiliateDenied(
        address indexed affiliateAddress,
        uint256 affiliateIndex,
        uint256 affilateFavorableScore,
        uint256 affiliateUnfavorableScore,
        string affiliateStorageID
    );

    event VoteCast(
        address indexed affiliateAddress,
        address indexed voter,
        bool support,
        uint256 voteWeight,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    );

    /**
     * @notice Same-transaction vote/transfer throttle for all voting operations
     * @dev Checks both msg.sender and tx.origin, records activity for both.
     *      NOTE: This is not a full flash-loan defense (a true defense would snapshot
     *      voting weight at proposal start). It only prevents the caller AND the
     *      top-level EOA from both voting and transferring in the same transaction.
     */
    modifier flashLoanProtection() {
        // CHECK: msg.sender (the actual caller)
        require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(msg.sender), "Cannot vote: recent transfer or voting activity");

        // CHECK: tx.origin if different (contract call scenario)
        if (msg.sender != tx.origin) {
            require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(tx.origin), "Cannot vote: EOA has recent activity");
        }

        _;

        // RECORD: Both addresses
        IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(msg.sender);
        if (msg.sender != tx.origin) {
            IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(tx.origin);
        }
    }

    /**
     * @notice Main voting function for affiliates
     * @param affiliateAddress The affiliate to vote on
     * @param support True for approval, false for denial
     */
    function voteOnAffiliate(address affiliateAddress, bool support) external flashLoanProtection nonReentrant {
        _validateVoteRequest(affiliateAddress);

        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();

        uint256 voterBalance = ts.balances[msg.sender];
        require(voterBalance > 0, "Caller does not have ownership tokens");

        _trackVoterIfNeeded(affiliateAddress, afs);
        _processVote(affiliateAddress, support, voterBalance, afs);
        _checkThresholdsAndReclassify(affiliateAddress, afs, ts.totalSupply);
    }

    function _validateVoteRequest(address affiliateAddress) internal view {
        require(affiliateAddress != address(0), "Invalid affiliate address");

        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");

        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType = afs.affiliateStatus[affiliateAddress];
        require(currentType != LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned, "Cannot vote on banned affiliate");
    }

    function _trackVoterIfNeeded(address affiliateAddress, LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs) internal {
        if (!afs.hasVoted[affiliateAddress][msg.sender]) {
            afs.hasVoted[affiliateAddress][msg.sender] = true;
            afs.affiliateVoters[affiliateAddress].push(msg.sender);

            uint256 newVotingIndex = afs.userVotingAddresses[msg.sender].length;
            afs.userVotingAddressIndex[affiliateAddress][msg.sender] = newVotingIndex;
            afs.userVotingAddresses[msg.sender].push(affiliateAddress);
        }
    }

    function _processVote(
        address affiliateAddress,
        bool support,
        uint256 voterBalance,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType = afs.affiliateStatus[affiliateAddress];
        uint256 index = afs.affiliateIndex[affiliateAddress];

        if (support) {
            _processSupportVote(affiliateAddress, voterBalance, currentType, index, afs);
        } else {
            _processDenyVote(affiliateAddress, voterBalance, currentType, index, afs);
        }

        uint256 finalFavorable;
        uint256 finalUnfavorable;

        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            finalFavorable = afs.prospectAffiliates[index].affiliateFavorableScore;
            finalUnfavorable = afs.prospectAffiliates[index].affiliateUnfavorableScore;
        } else {
            finalFavorable = afs.approvedAffiliates[index].affiliateFavorableScore;
            finalUnfavorable = afs.approvedAffiliates[index].affiliateUnfavorableScore;
        }

        emit VoteCast(affiliateAddress, msg.sender, support, voterBalance, finalFavorable, finalUnfavorable);
    }

    function _processSupportVote(
        address affiliateAddress,
        uint256 voterBalance,
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        uint256 previousSupport = afs.hasVotedVotes[affiliateAddress][msg.sender][true];
        uint256 previousDeny = afs.hasVotedVotes[affiliateAddress][msg.sender][false];

        if (previousSupport > 0) {
            if (voterBalance > previousSupport) {
                uint256 diff = voterBalance - previousSupport;
                _updateFavorableScore(currentType, index, diff, afs);
                afs.hasVotedVotes[affiliateAddress][msg.sender][true] = voterBalance;
            }
        } else if (previousDeny > 0) {
            _switchFromDenyToSupport(affiliateAddress, voterBalance, currentType, index, afs);
        } else {
            _updateFavorableScore(currentType, index, voterBalance, afs);
            afs.hasVotedVotes[affiliateAddress][msg.sender][true] = voterBalance;
        }
    }

    function _processDenyVote(
        address affiliateAddress,
        uint256 voterBalance,
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        uint256 previousSupport = afs.hasVotedVotes[affiliateAddress][msg.sender][true];
        uint256 previousDeny = afs.hasVotedVotes[affiliateAddress][msg.sender][false];

        if (previousDeny > 0) {
            if (voterBalance > previousDeny) {
                uint256 diff = voterBalance - previousDeny;
                _updateUnfavorableScore(currentType, index, diff, afs);
                afs.hasVotedVotes[affiliateAddress][msg.sender][false] = voterBalance;
            }
        } else if (previousSupport > 0) {
            _switchFromSupportToDeny(affiliateAddress, voterBalance, currentType, index, afs);
        } else {
            _updateUnfavorableScore(currentType, index, voterBalance, afs);
            afs.hasVotedVotes[affiliateAddress][msg.sender][false] = voterBalance;
        }
    }

    function _updateFavorableScore(
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        uint256 amount,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            afs.prospectAffiliates[index].affiliateFavorableScore += amount;
        } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            afs.approvedAffiliates[index].affiliateFavorableScore += amount;
        }
    }

    function _updateUnfavorableScore(
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        uint256 amount,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            afs.prospectAffiliates[index].affiliateUnfavorableScore += amount;
        } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            afs.approvedAffiliates[index].affiliateUnfavorableScore += amount;
        }
    }

    function _switchFromDenyToSupport(
        address affiliateAddress,
        uint256 voterBalance,
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        uint256 previousDenyAmount = afs.hasVotedVotes[affiliateAddress][msg.sender][false];
        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            require(afs.prospectAffiliates[index].affiliateUnfavorableScore >= previousDenyAmount, "Insufficient unfavorable votes");
            afs.prospectAffiliates[index].affiliateFavorableScore += voterBalance;
            afs.prospectAffiliates[index].affiliateUnfavorableScore -= previousDenyAmount;
        } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            require(afs.approvedAffiliates[index].affiliateUnfavorableScore >= previousDenyAmount, "Insufficient unfavorable votes");
            afs.approvedAffiliates[index].affiliateFavorableScore += voterBalance;
            afs.approvedAffiliates[index].affiliateUnfavorableScore -= previousDenyAmount;
        }
        afs.hasVotedVotes[affiliateAddress][msg.sender][false] = 0;
        afs.hasVotedVotes[affiliateAddress][msg.sender][true] = voterBalance;
    }

    function _switchFromSupportToDeny(
        address affiliateAddress,
        uint256 voterBalance,
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType,
        uint256 index,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs
    ) internal {
        uint256 previousSupportAmount = afs.hasVotedVotes[affiliateAddress][msg.sender][true];
        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            require(afs.prospectAffiliates[index].affiliateFavorableScore >= previousSupportAmount, "Insufficient favorable votes");
            afs.prospectAffiliates[index].affiliateFavorableScore -= previousSupportAmount;
            afs.prospectAffiliates[index].affiliateUnfavorableScore += voterBalance;
        } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            require(afs.approvedAffiliates[index].affiliateFavorableScore >= previousSupportAmount, "Insufficient favorable votes");
            afs.approvedAffiliates[index].affiliateFavorableScore -= previousSupportAmount;
            afs.approvedAffiliates[index].affiliateUnfavorableScore += voterBalance;
        }
        afs.hasVotedVotes[affiliateAddress][msg.sender][true] = 0;
        afs.hasVotedVotes[affiliateAddress][msg.sender][false] = voterBalance;
    }

    function _checkThresholdsAndReclassify(
        address affiliateAddress,
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs,
        uint256 totalSupply
    ) internal {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentType = afs.affiliateStatus[affiliateAddress];
        uint256 index = afs.affiliateIndex[affiliateAddress];

        uint256 favorableScore;
        uint256 unfavorableScore;

        if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            favorableScore = afs.prospectAffiliates[index].affiliateFavorableScore;
            unfavorableScore = afs.prospectAffiliates[index].affiliateUnfavorableScore;
        } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            favorableScore = afs.approvedAffiliates[index].affiliateFavorableScore;
            unfavorableScore = afs.approvedAffiliates[index].affiliateUnfavorableScore;
        }

        uint256 totalVotes = favorableScore + unfavorableScore;
        if (totalVotes > 0 && (totalVotes * 100) / totalSupply >= gs.currentQuotas.affiliateApprovalDenialQuorum) {
            if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
                if ((favorableScore * 100) / totalVotes >= gs.currentQuotas.affiliateApprovalThreshold) {
                    emit AffiliateApproved(affiliateAddress, index, favorableScore, unfavorableScore, afs.prospectAffiliates[index].storageId);

                    IOpenAdvertsAffiliatesFacet(address(this)).reclassifyAffiliate(
                        affiliateAddress,
                        currentType,
                        LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved,
                        favorableScore,
                        unfavorableScore
                    );
                }
            } else if (currentType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
                if ((unfavorableScore * 100) / totalVotes >= gs.currentQuotas.affiliateDenialThreshold) {
                    emit AffiliateDenied(affiliateAddress, index, favorableScore, unfavorableScore, afs.approvedAffiliates[index].storageId);

                    IOpenAdvertsAffiliatesFacet(address(this)).reclassifyAffiliate(
                        affiliateAddress,
                        currentType,
                        LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect,
                        favorableScore,
                        unfavorableScore
                    );
                }
            }
        }
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
