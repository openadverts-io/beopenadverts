// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../Diamond.sol";

interface IOpenAdvertsSignatureGateFacet {
    function verifyAndConsume(bytes32 actionTag, bytes32 uid, uint256 deadline, bytes calldata signature, address caller) external;
}

/**
 * @title OpenAdvertsAffiliatesFacet
 * @dev Core affiliate management - creation, queries, admin functions, reclassification
 * @notice Voting logic moved to OpenAdvertsAffiliatesVotingFacet for size optimization
 */
contract OpenAdvertsAffiliatesFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    // Domain tag binding a website-origin signature to this entrypoint.
    bytes32 private constant AFFILIATE_CREATE = keccak256("OPENADVERTS_AFFILIATE_CREATE");

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    event AffiliateStatusChanged(
        address indexed affiliateAddress,
        LibOpenAdvertsAffiliatesStorage.AffiliateType oldStatus,
        LibOpenAdvertsAffiliatesStorage.AffiliateType newStatus,
        uint256 timestamp
    );

    event AffiliateBanned(address indexed affiliateAddress, uint256 timestamp);
    event AffiliateUnbanned(address indexed affiliateAddress, uint256 timestamp);
    event AffiliateRemoved(address indexed affiliateAddress, uint256 timestamp);
    event ProspectAffiliateCreated(
        address indexed affiliateAddress,
        address indexed affiliateOwner,
        address claimInfoAddress,
        address signingAddress,
        string storageId,
        uint256 timestamp
    );

    /**
     * @notice Creates a new prospect affiliate
     */
    function createProspectAffiliateContract(
        address affiliateContract,
        address claimInfo,
        address signingAddress,
        string memory storageId,
        bytes32 uid,
        uint256 deadline,
        bytes calldata signature
    ) external {
        // Gate: require a valid, unused, website-issued signature bound to this caller.
        IOpenAdvertsSignatureGateFacet(address(this)).verifyAndConsume(AFFILIATE_CREATE, uid, deadline, signature, msg.sender);

        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(affiliateContract != address(0), "Invalid affiliate contract address");
        require(claimInfo != address(0), "Invalid claim info address");
        require(signingAddress != address(0), "Invalid signing address");
        require(bytes(storageId).length > 0, "Storage ID cannot be empty");
        // require(affiliateContract != claimInfo, "Affiliate and claim addresses must be different");
        require(affiliateContract != signingAddress, "Affiliate and signing addresses must be different");
        require(!afs.affiliateExists[affiliateContract], "Affiliate already exists");
        require(!afs.affiliateSigningStatus[signingAddress], "Signing address already in use");

        afs.affiliateExists[affiliateContract] = true;
        afs.affiliateIndex[affiliateContract] = afs.prospectAffiliates.length;
        afs.affiliateStatus[affiliateContract] = LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect;
        // Global uniqueness: reserve this signing address for the affiliate's entire lifetime
        // (prospect → approved → banned). It is freed only in removeAffiliate() via delete, so the
        // require() above rejects ANY reuse—by prospects, approved, or banned affiliates—while set.
        afs.affiliateSigningStatus[signingAddress] = true;

        afs.prospectAffiliates.push(
            LibOpenAdvertsAffiliatesStorage.AffiliateStruct({
                affiliateContractAddress: affiliateContract,
                affiliateOwner: msg.sender,
                affiliateClaimInfoAddress: claimInfo,
                affiliateSigningAddress: signingAddress,
                storageId: storageId,
                affiliateFavorableScore: 0,
                affiliateUnfavorableScore: 0,
                AffiliateType: LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect,
                originalType: LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect
            })
        );

        emit ProspectAffiliateCreated(affiliateContract, msg.sender, claimInfo, signingAddress, storageId, block.timestamp);
    }

    /**
     * @notice Removes a prospect or approved affiliate and cleans up all associated data
     * @param affiliateAddress The address of the affiliate to remove
     */
    function removeAffiliate(address affiliateAddress) external {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");

        LibOpenAdvertsAffiliatesStorage.AffiliateType currentStatus = afs.affiliateStatus[affiliateAddress];
        require(
            currentStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect ||
                currentStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved,
            "Only prospect or approved affiliates can be removed"
        );

        uint256 index = afs.affiliateIndex[affiliateAddress];
        LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate;

        // Get affiliate struct from appropriate array
        if (currentStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            affiliate = afs.prospectAffiliates[index];
        } else {
            affiliate = afs.approvedAffiliates[index];
        }

        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        require(msg.sender == ds.contractOwner || msg.sender == affiliate.affiliateOwner, "Only contract owner or affiliate owner can remove");

        // Remove from appropriate array based on current status
        if (currentStatus == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            _removeFromProspectArray(afs, index);
        } else {
            _removeFromApprovedArray(afs, index);
        }

        // Clean up all mappings and data
        delete afs.affiliateExists[affiliateAddress];
        delete afs.affiliateIndex[affiliateAddress];
        delete afs.affiliateStatus[affiliateAddress];
        delete afs.affiliateSigningStatus[affiliate.affiliateSigningAddress];

        // Add to removed array
        afs.removedAffiliates.push(affiliate);

        emit AffiliateRemoved(affiliateAddress, block.timestamp);
    }

    /**
     * @notice PUBLIC: Reclassification function - callable by voting facet
     */
    function reclassifyAffiliate(
        address affiliateAddress,
        LibOpenAdvertsAffiliatesStorage.AffiliateType fromType,
        LibOpenAdvertsAffiliatesStorage.AffiliateType toType,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    ) public {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        // LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();

        require(msg.sender == ds.contractOwner || msg.sender == address(this), "Unauthorized: only owner, diamond or voting facet can reclassify");

        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");
        require(fromType != toType, "Affiliate already has target type");

        LibOpenAdvertsAffiliatesStorage.AffiliateType actualCurrentStatus = afs.affiliateStatus[affiliateAddress];
        require(actualCurrentStatus == fromType, "Status mismatch");

        uint256 index = afs.affiliateIndex[affiliateAddress];
        LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate;

        if (fromType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            affiliate = afs.prospectAffiliates[index];
            _removeFromProspectArray(afs, index);
        } else if (fromType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            affiliate = afs.approvedAffiliates[index];
            _removeFromApprovedArray(afs, index);
        } else if (fromType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            affiliate = afs.bannedAffiliates[index];
            _removeFromBannedArray(afs, index);
        }

        affiliate.affiliateFavorableScore = newFavorableScore;
        affiliate.affiliateUnfavorableScore = newUnfavorableScore;
        affiliate.AffiliateType = toType;

        _addToTargetArray(afs, affiliate, toType, affiliateAddress);
        afs.affiliateStatus[affiliateAddress] = toType;

        emit AffiliateStatusChanged(affiliateAddress, fromType, toType, block.timestamp);
    }

    // QUERY FUNCTIONS
    function getAffiliateStatus(address affiliateAddress) public view returns (LibOpenAdvertsAffiliatesStorage.AffiliateType) {
        return LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage().affiliateStatus[affiliateAddress];
    }

    function getProspectAffiliates() external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory) {
        return LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage().prospectAffiliates;
    }

    function getApprovedAffiliates() external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory) {
        return LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage().approvedAffiliates;
    }

    function getBannedAffiliates() external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory) {
        return LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage().bannedAffiliates;
    }

    function getRemovedAffiliates() external view returns (LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] memory) {
        return LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage().removedAffiliates;
    }

    function getAffiliateDetailsAndStatus(
        address affiliateAddress
    ) public view returns (LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate, LibOpenAdvertsAffiliatesStorage.AffiliateType status) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");

        status = afs.affiliateStatus[affiliateAddress];
        uint256 index = afs.affiliateIndex[affiliateAddress];

        if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            affiliate = afs.prospectAffiliates[index];
        } else if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            affiliate = afs.approvedAffiliates[index];
        } else if (status == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            affiliate = afs.bannedAffiliates[index];
        }
    }

    function getAffiliateStatistics()
        external
        view
        returns (uint256 prospectCount, uint256 approvedCount, uint256 bannedCount, uint256 removedCount)
    {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        return (afs.prospectAffiliates.length, afs.approvedAffiliates.length, afs.bannedAffiliates.length, afs.removedAffiliates.length);
    }

    function getUserVoteOnAffiliateWithDetails(
        address affiliateAddress,
        address voter
    ) external view returns (bool hasVoted, uint256 supportVotes, uint256 denyVotes) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        hasVoted = afs.hasVoted[affiliateAddress][voter];
        supportVotes = afs.hasVotedVotes[affiliateAddress][voter][true];
        denyVotes = afs.hasVotedVotes[affiliateAddress][voter][false];
    }

    function getAffiliateVoters(address affiliateAddress) external view returns (address[] memory voters) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");
        return afs.affiliateVoters[affiliateAddress];
    }

    function getAffiliateVotingStats(
        address affiliateAddress
    ) external view returns (uint256 totalVotes, uint256 favorableVotes, uint256 unfavorableVotes, uint256 uniqueVoters) {
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        require(afs.affiliateExists[affiliateAddress], "Affiliate does not exist");

        (LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate, ) = getAffiliateDetailsAndStatus(affiliateAddress);
        favorableVotes = affiliate.affiliateFavorableScore;
        unfavorableVotes = affiliate.affiliateUnfavorableScore;
        totalVotes = favorableVotes + unfavorableVotes;
        uniqueVoters = afs.affiliateVoters[affiliateAddress].length;
    }

    // ADMIN FUNCTIONS
    function banAffiliate(address affiliateAddress) public returns (bool success) {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(afs.affiliateExists[affiliateAddress], "Affiliate not found");
        LibOpenAdvertsAffiliatesStorage.AffiliateType currentStatus = afs.affiliateStatus[affiliateAddress];
        require(currentStatus != LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned, "Affiliate already banned");

        afs.originalTypeBeforeBan[affiliateAddress] = currentStatus;

        (LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate, ) = getAffiliateDetailsAndStatus(affiliateAddress);

        reclassifyAffiliate(
            affiliateAddress,
            currentStatus,
            LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned,
            affiliate.affiliateFavorableScore,
            affiliate.affiliateUnfavorableScore
        );

        emit AffiliateBanned(affiliateAddress, block.timestamp);
        return true;
    }

    function unbanAffiliate(address affiliateAddress) external returns (bool success) {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();

        require(afs.affiliateStatus[affiliateAddress] == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned, "Affiliate is not banned");

        LibOpenAdvertsAffiliatesStorage.AffiliateType originalType = afs.originalTypeBeforeBan[affiliateAddress];
        if (originalType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            originalType = LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect;
        }

        (LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate, ) = getAffiliateDetailsAndStatus(affiliateAddress);

        reclassifyAffiliate(
            affiliateAddress,
            LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned,
            originalType,
            affiliate.affiliateFavorableScore,
            affiliate.affiliateUnfavorableScore
        );

        delete afs.originalTypeBeforeBan[affiliateAddress];

        emit AffiliateUnbanned(affiliateAddress, block.timestamp);
        return true;
    }

    // INTERNAL HELPER FUNCTIONS
    function _removeFromProspectArray(LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs, uint256 index) internal {
        require(afs.prospectAffiliates.length > 0, "Array is empty");
        require(index < afs.prospectAffiliates.length, "Invalid index");

        uint256 lastIndex = afs.prospectAffiliates.length - 1;
        if (index != lastIndex) {
            afs.prospectAffiliates[index] = afs.prospectAffiliates[lastIndex];
            afs.affiliateIndex[afs.prospectAffiliates[index].affiliateContractAddress] = index;
        }
        afs.prospectAffiliates.pop();
    }

    function _removeFromApprovedArray(LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs, uint256 index) internal {
        require(afs.approvedAffiliates.length > 0, "Array is empty");
        require(index < afs.approvedAffiliates.length, "Invalid index");

        uint256 lastIndex = afs.approvedAffiliates.length - 1;
        if (index != lastIndex) {
            afs.approvedAffiliates[index] = afs.approvedAffiliates[lastIndex];
            afs.affiliateIndex[afs.approvedAffiliates[index].affiliateContractAddress] = index;
        }
        afs.approvedAffiliates.pop();
    }

    function _removeFromBannedArray(LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs, uint256 index) internal {
        require(afs.bannedAffiliates.length > 0, "Array is empty");
        require(index < afs.bannedAffiliates.length, "Invalid index");
        uint256 lastIndex = afs.bannedAffiliates.length - 1;
        if (index != lastIndex) {
            afs.bannedAffiliates[index] = afs.bannedAffiliates[lastIndex];
            afs.affiliateIndex[afs.bannedAffiliates[index].affiliateContractAddress] = index;
        }
        afs.bannedAffiliates.pop();
    }

    function _addToTargetArray(
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage afs,
        LibOpenAdvertsAffiliatesStorage.AffiliateStruct memory affiliate,
        LibOpenAdvertsAffiliatesStorage.AffiliateType targetType,
        address affiliateAddress
    ) internal {
        // Global signing-address uniqueness: the address stays reserved for as long as the
        // affiliate exists in ANY array (prospect/approved/banned). It is freed only in
        // removeAffiliate() via delete. Keeping it true across every reclassify transition
        // prevents a second affiliate from registering the same signing key.
        afs.affiliateSigningStatus[affiliate.affiliateSigningAddress] = true;
        if (targetType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Prospect) {
            afs.prospectAffiliates.push(affiliate);
            afs.affiliateIndex[affiliateAddress] = afs.prospectAffiliates.length - 1;
        } else if (targetType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Approved) {
            afs.approvedAffiliates.push(affiliate);
            afs.affiliateIndex[affiliateAddress] = afs.approvedAffiliates.length - 1;
        } else if (targetType == LibOpenAdvertsAffiliatesStorage.AffiliateType.Banned) {
            afs.bannedAffiliates.push(affiliate);
            afs.affiliateIndex[affiliateAddress] = afs.bannedAffiliates.length - 1;
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
