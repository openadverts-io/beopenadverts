// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import "../Diamond.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOpenAdvertsAdvertisersFacet {
    function reclassifyAdvertisement(
        address advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType fromType,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType toType,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    ) external;
}

/**
 * @title IOpenAdvertsTokenFacet - Universal Voting Protection
 * @dev Simple interface for flash loan protection - works with ANY voting
 */
interface IOpenAdvertsTokenFacet {
    function canVoteThisBlock(address account) external view returns (bool);
    function recordVoteActivity(address voter) external;
}

interface IAdvertContract {
    function processCommission() external returns (uint256);
    function removeAndRefund() external returns (uint256);
}

contract OpenAdvertsAdvertisersVotingFacet is ReentrancyGuard {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // Events
    event AdvertisementApproved(
        address indexed advertContract,
        uint256 advertIndex,
        uint256 favorableScore,
        uint256 unfavorableScore,
        string storageId
    );

    event AdvertisementDenied(
        address indexed advertContract,
        uint256 advertIndex,
        uint256 favorableScore,
        uint256 unfavorableScore,
        string storageId
    );

    event VoteCast(
        address indexed advertContract,
        address indexed voter,
        bool support,
        uint256 voteWeight,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    );

    event AdvertisementRemoved(address indexed advertContract, uint256 timestamp);

    // event AdvertisementStatusChanged2(
    //     address indexed advertContract,
    //     LibOpenAdvertsAdvertisersStorage.AdvertisementType oldStatus,
    //     LibOpenAdvertsAdvertisersStorage.AdvertisementType newStatus,
    //     uint256 timestamp
    // );

    /**
     * @notice Same-transaction vote/transfer throttle for all voting operations
     * @dev Checks both msg.sender and tx.origin, records activity for both.
     *      NOTE: This is not a full flash-loan defense (a true defense would snapshot
     *      voting weight at proposal start). It only prevents the caller AND the
     *      top-level EOA from both voting and transferring in the same transaction.
     */
    modifier flashLoanProtection() {
        require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(msg.sender), "Cannot vote: recent transfer or voting activity");

        // ✅ CHECK: tx.origin if different (contract call scenario)
        if (msg.sender != tx.origin) {
            require(IOpenAdvertsTokenFacet(address(this)).canVoteThisBlock(tx.origin), "Cannot vote: EOA has recent activity");
        }

        _;

        IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(msg.sender);
        if (msg.sender != tx.origin) {
            IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(tx.origin);
        }
    }

    /**
     * @notice Main voting function`
     */
    function voteOnAdvert(address advertContractAddress, bool support) public flashLoanProtection nonReentrant {
        _validateVoteRequest(advertContractAddress);

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();

        uint256 voterBalance = ts.balances[msg.sender];
        require(voterBalance > 0, "Insufficient token balance to vote");

        _trackVoterIfNeeded(advertContractAddress, aas);
        _processVote(advertContractAddress, support, voterBalance, aas);
        _checkThresholdsAndReclassify(advertContractAddress, aas, ts.totalSupply);
    }

    /**
     * @notice Removes a prospect advertisement and cleans up all associated data
     * @param advertContractAddress The address of the advertisement to remove
     */
    function removeProspectAdvertisement(address advertContractAddress) external {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        require(aas.advertisementExists[advertContractAddress], "Advertisement does not exist");
        require(
            aas.advertisementStatus[advertContractAddress] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
            "Only prospect advertisements can be removed"
        );

        uint256 index = aas.advertisementIndex[advertContractAddress];
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement = aas.prospectAdvertisements[index];

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        require(msg.sender == ds.contractOwner || msg.sender == advertisement.advertOwner, "Only contract owner or advertisement owner can remove");

        // STEP 1: Call advertisement contract to refund funds to owner
        uint256 refundedAmount = 0;
        try IAdvertContract(advertContractAddress).removeAndRefund() returns (uint256 amount) {
            refundedAmount = amount;
        } catch {
            // If refund fails, continue with removal (funds might already be withdrawn)
        }
        // STEP 2: Remove from prospect array
        _removeFromProspectArray(aas, index);

        // STEP 3: Clean up all mappings and data
        delete aas.advertisementExists[advertContractAddress];
        delete aas.advertisementIndex[advertContractAddress];
        delete aas.advertisementStatus[advertContractAddress];

        // STEP 4: Add to removed array
        aas.removedAdvertisements.push(advertisement);

        emit AdvertisementRemoved(advertContractAddress, block.timestamp);
    }

    function _validateVoteRequest(address advertContractAddress) internal view {
        require(advertContractAddress != address(0), "Invalid advertisement address");

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        require(aas.advertisementExists[advertContractAddress], "Advertisement not found");

        LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus = aas.advertisementStatus[advertContractAddress];

        require(currentStatus != LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned, "Cannot vote on banned advertisement");
        require(currentStatus != LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn, "Cannot vote on banned advertisement");
        require(currentStatus != LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted, "Cannot vote on exhausted advertisement");
        require(currentStatus != LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating, "Cannot vote on deprecating advertisement");
        require(
            currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect ||
                currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved,
            "Advertisement is not in a voteable state"
        );

        uint256 advertIndex = aas.advertisementIndex[advertContractAddress];
        bool isPaused = false;

        if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            isPaused = aas.prospectAdvertisements[advertIndex].isPaused;
        } else if (currentStatus == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            isPaused = aas.approvedAdvertisements[advertIndex].isPaused;
        }

        require(!isPaused, "Cannot vote on paused advertisement");
    }

    function _trackVoterIfNeeded(address advertContractAddress, LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas) internal {
        if (!aas.hasVoted[advertContractAddress][msg.sender]) {
            aas.advertVoters[advertContractAddress].push(msg.sender);

            uint256 newUserVotingAddressIndex = aas.userVotingAddresses[msg.sender].length;
            aas.userVotingAddressIndex[advertContractAddress][msg.sender] = newUserVotingAddressIndex;
            aas.userVotingAddresses[msg.sender].push(advertContractAddress);

            aas.hasVoted[advertContractAddress][msg.sender] = true;
        }
    }

    function _processVote(
        address advertContractAddress,
        bool support,
        uint256 voterBalance,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType = aas.advertisementStatus[advertContractAddress];
        uint256 advertIndex = aas.advertisementIndex[advertContractAddress];

        if (support) {
            _processSupportVote(advertContractAddress, voterBalance, adType, advertIndex, aas);
        } else {
            _processDenyVote(advertContractAddress, voterBalance, adType, advertIndex, aas);
        }

        uint256 finalFavorable;
        uint256 finalUnfavorable;

        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            finalFavorable = aas.prospectAdvertisements[advertIndex].advertFavorableScore;
            finalUnfavorable = aas.prospectAdvertisements[advertIndex].advertUnfavorableScore;
        } else {
            finalFavorable = aas.approvedAdvertisements[advertIndex].advertFavorableScore;
            finalUnfavorable = aas.approvedAdvertisements[advertIndex].advertUnfavorableScore;
        }

        emit VoteCast(advertContractAddress, msg.sender, support, voterBalance, finalFavorable, finalUnfavorable);
    }

    // All the helper functions remain the same...
    function _processSupportVote(
        address advertContractAddress,
        uint256 voterBalance,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        uint256 votedCountSupport = aas.hasVotedVotes[advertContractAddress][msg.sender][true];

        if (votedCountSupport > 0) {
            if (voterBalance > votedCountSupport) {
                uint256 difference = voterBalance - votedCountSupport;
                _updateFavorableScore(adType, advertIndex, difference, aas);
                _updateVoteStorage(advertContractAddress, voterBalance, 0, aas);
            }
        } else {
            uint256 votedCountDeny = aas.hasVotedVotes[advertContractAddress][msg.sender][false];
            if (votedCountDeny > 0) {
                _switchFromDenyToSupport(advertContractAddress, adType, advertIndex, voterBalance, aas);
                _updateVoteStorage(advertContractAddress, voterBalance, 0, aas);
            } else {
                _updateFavorableScore(adType, advertIndex, voterBalance, aas);
                _updateVoteStorage(advertContractAddress, voterBalance, 0, aas);
            }
        }
    }

    function _processDenyVote(
        address advertContractAddress,
        uint256 voterBalance,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        uint256 votedCountDeny = aas.hasVotedVotes[advertContractAddress][msg.sender][false];

        if (votedCountDeny > 0) {
            if (voterBalance > votedCountDeny) {
                uint256 difference = voterBalance - votedCountDeny;
                _updateUnfavorableScore(adType, advertIndex, difference, aas);
                _updateVoteStorage(advertContractAddress, 0, voterBalance, aas);
            }
        } else {
            uint256 votedCountSupport = aas.hasVotedVotes[advertContractAddress][msg.sender][true];
            if (votedCountSupport > 0) {
                _switchFromSupportToDeny(advertContractAddress, adType, advertIndex, voterBalance, aas);
                _updateVoteStorage(advertContractAddress, 0, voterBalance, aas);
            } else {
                _updateUnfavorableScore(adType, advertIndex, voterBalance, aas);
                _updateVoteStorage(advertContractAddress, 0, voterBalance, aas);
            }
        }
    }

    function _updateFavorableScore(
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        uint256 amount,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            aas.prospectAdvertisements[advertIndex].advertFavorableScore += amount;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            aas.approvedAdvertisements[advertIndex].advertFavorableScore += amount;
        }
    }

    function _updateUnfavorableScore(
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        uint256 amount,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            aas.prospectAdvertisements[advertIndex].advertUnfavorableScore += amount;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            aas.approvedAdvertisements[advertIndex].advertUnfavorableScore += amount;
        }
    }

    function _switchFromDenyToSupport(
        address advertContractAddress,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        uint256 voterBalance,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        uint256 previousDenyAmount = aas.hasVotedVotes[advertContractAddress][msg.sender][false];
        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            require(
                aas.prospectAdvertisements[advertIndex].advertUnfavorableScore >= previousDenyAmount,
                "Insufficient unfavorable votes to reverse"
            );

            aas.prospectAdvertisements[advertIndex].advertFavorableScore += voterBalance;
            aas.prospectAdvertisements[advertIndex].advertUnfavorableScore -= previousDenyAmount;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            require(
                aas.approvedAdvertisements[advertIndex].advertUnfavorableScore >= previousDenyAmount,
                "Insufficient unfavorable votes to reverse"
            );

            aas.approvedAdvertisements[advertIndex].advertFavorableScore += voterBalance;
            aas.approvedAdvertisements[advertIndex].advertUnfavorableScore -= previousDenyAmount;
        }
    }

    function _switchFromSupportToDeny(
        address advertContractAddress,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType,
        uint256 advertIndex,
        uint256 voterBalance,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        uint256 previousSupportAmount = aas.hasVotedVotes[advertContractAddress][msg.sender][true];
        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            require(aas.prospectAdvertisements[advertIndex].advertFavorableScore >= previousSupportAmount, "Insufficient favorable votes to reverse");

            aas.prospectAdvertisements[advertIndex].advertFavorableScore -= previousSupportAmount;
            aas.prospectAdvertisements[advertIndex].advertUnfavorableScore += voterBalance;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            require(aas.approvedAdvertisements[advertIndex].advertFavorableScore >= previousSupportAmount, "Insufficient favorable votes to reverse");

            aas.approvedAdvertisements[advertIndex].advertFavorableScore -= previousSupportAmount;
            aas.approvedAdvertisements[advertIndex].advertUnfavorableScore += voterBalance;
        }
    }

    // SIMPLIFIED: Remove redundant parameters
    function _updateVoteStorage(
        address advertContractAddress,
        uint256 supportVotes,
        uint256 denyVotes,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas
    ) internal {
        aas.hasVotedVotes[advertContractAddress][msg.sender][true] = supportVotes;
        aas.hasVotedVotes[advertContractAddress][msg.sender][false] = denyVotes;
    }

    // FIXED: Call main facet instead of local function
    function _checkThresholdsAndReclassify(
        address advertContractAddress,
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas,
        uint256 totalSupply
    ) internal {
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage gs = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType = aas.advertisementStatus[advertContractAddress];
        uint256 advertIndex = aas.advertisementIndex[advertContractAddress];

        uint256 favorableScore;
        uint256 unfavorableScore;
        LibOpenAdvertsAdvertisersStorage.PaymentType advertCurrency;

        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            favorableScore = aas.prospectAdvertisements[advertIndex].advertFavorableScore;
            unfavorableScore = aas.prospectAdvertisements[advertIndex].advertUnfavorableScore;
            advertCurrency = aas.prospectAdvertisements[advertIndex].advertCurrency;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            favorableScore = aas.approvedAdvertisements[advertIndex].advertFavorableScore;
            unfavorableScore = aas.approvedAdvertisements[advertIndex].advertUnfavorableScore;
            advertCurrency = aas.approvedAdvertisements[advertIndex].advertCurrency;
        }

        if ((((favorableScore + unfavorableScore) * 100) / totalSupply) >= gs.currentQuotas.advertApprovalDenialQuorum) {
            if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
                if ((favorableScore * 100) / (favorableScore + unfavorableScore) >= gs.currentQuotas.advertApprovalThreshold) {
                    emit AdvertisementApproved(
                        advertContractAddress,
                        advertIndex,
                        favorableScore,
                        unfavorableScore,
                        aas.prospectAdvertisements[advertIndex].storageId
                    );

                    // CHECK: Commission status
                    bool alreadyCommissioned = aas.advertisementCommissioned[advertContractAddress];

                    if (alreadyCommissioned) {
                        // PATH 1: Already commissioned - just reclassify
                        IOpenAdvertsAdvertisersFacet(address(this)).reclassifyAdvertisement(
                            advertContractAddress,
                            adType,
                            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved,
                            favorableScore,
                            unfavorableScore
                        );
                    } else {
                        // PATH 2: Not commissioned yet - reclassify FIRST, then process commission

                        // Step 1: Reclassify to Approved
                        IOpenAdvertsAdvertisersFacet(address(this)).reclassifyAdvertisement(
                            advertContractAddress,
                            adType,
                            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved,
                            favorableScore,
                            unfavorableScore
                        );

                        // Step 2: Try to process commission
                        bool commissionSuccess = false;

                        if (advertCurrency == LibOpenAdvertsAdvertisersStorage.PaymentType.POL) {
                            try IAdvertContract(advertContractAddress).processCommission() {
                                // SUCCESS: Commission processed
                                aas.advertisementCommissioned[advertContractAddress] = true;
                                commissionSuccess = true;
                            } catch {
                                // FAILED: Commission processing failed
                                commissionSuccess = false;
                            }
                        } else if (advertCurrency == LibOpenAdvertsAdvertisersStorage.PaymentType.USDC) {
                            try IAdvertContract(advertContractAddress).processCommission() returns (uint256 commissionAmount) {
                                // SUCCESS: Commission processed
                                LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
                                ts.totalAggregateRewardInUSDC += commissionAmount;
                                aas.advertisementCommissioned[advertContractAddress] = true;
                                commissionSuccess = true;
                            } catch {
                                // FAILED: Commission processing failed
                                commissionSuccess = false;
                            }
                        }

                        // Step 3: If commission failed, revert the reclassification
                        if (!commissionSuccess) {
                            // REVERT: Reclassify back to Prospect
                            IOpenAdvertsAdvertisersFacet(address(this)).reclassifyAdvertisement(
                                advertContractAddress,
                                LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved, // Current status (just changed)
                                LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect, // Revert back
                                favorableScore,
                                unfavorableScore
                            );

                            // REVERT: Entire transaction (commission must succeed)
                            revert("Commission processing failed - advertisement remains Prospect");
                        }
                    }
                }
            } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
                if ((unfavorableScore * 100) / (favorableScore + unfavorableScore) >= gs.currentQuotas.advertDenialThreshold) {
                    emit AdvertisementDenied(
                        advertContractAddress,
                        advertIndex,
                        favorableScore,
                        unfavorableScore,
                        aas.approvedAdvertisements[advertIndex].storageId
                    );

                    // DEMOTION: No commission processing
                    IOpenAdvertsAdvertisersFacet(address(this)).reclassifyAdvertisement(
                        advertContractAddress,
                        adType,
                        LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect,
                        favorableScore,
                        unfavorableScore
                    );
                }
            }
        }
    }

    // INTERNAL HELPER FUNCTIONS - Keep all the _removeFromXArray and _addToTargetArray functions
    function _removeFromProspectArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        uint256 lastIndex = storageData.prospectAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.prospectAdvertisements[index] = storageData.prospectAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.prospectAdvertisements[index].advertContractAddress] = index;
        }
        storageData.prospectAdvertisements.pop();
    }

    function _removeFromApprovedArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        uint256 lastIndex = storageData.approvedAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.approvedAdvertisements[index] = storageData.approvedAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.approvedAdvertisements[index].advertContractAddress] = index;
        }
        storageData.approvedAdvertisements.pop();
    }

    function _removeFromDeprecatingArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        uint256 lastIndex = storageData.deprecatingAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.deprecatingAdvertisements[index] = storageData.deprecatingAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.deprecatingAdvertisements[index].advertContractAddress] = index;
        }
        storageData.deprecatingAdvertisements.pop();
    }

    function _addToTargetArray(
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData,
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType targetType,
        address advertContract
    ) internal {
        if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            storageData.prospectAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.prospectAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            storageData.approvedAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.approvedAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            storageData.exhaustedAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.exhaustedAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            storageData.deprecatingAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.deprecatingAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            storageData.withdrawnAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.withdrawnAdvertisements.length - 1;
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
