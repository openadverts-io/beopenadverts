// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
// import "../libraries/LibOpenAdvertsPayoutStorage.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsTimelockStorage.sol";
import "../libraries/LibDiamond.sol";

/**
 * @title OpenAdvertsAdvertisersFacet
 * @dev Lightweight facet for advertisement management and storage ONLY
 * @notice Factory functions are now in separate specialized facets
 */
contract OpenAdvertsAdvertisersFacet {
    // State variable for direct calls to this facet (separate from diamond storage)
    // This is used when someone sends ETH directly to the facet address
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    // Events
    event ProspectAdvertisementCreated(
        address indexed advertContract,
        address indexed advertOwner,
        string storageId,
        uint256 bounty,
        uint256 fundingAmount,
        LibOpenAdvertsAdvertisersStorage.PaymentType paymentType
    );

    event AdvertisementStatusChanged(
        address indexed advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType oldStatus,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType newStatus,
        uint256 timestamp
    );

    event AdvertisementBanned(address indexed advertContract, uint256 timestamp);
    event AdvertisementUnbanned(address indexed advertContract, uint256 timestamp);

    event USDCAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event PriceFeedAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event OracleStalenessUpdated(uint256 oldValue, uint256 newValue);
    event OraclePriceBoundsUpdated(uint256 oldMin, uint256 oldMax, uint256 newMin, uint256 newMax);
    event AdvertisementDataUpdated(address indexed advertContract, bool isPaused, uint256 pausedAtBlock, uint256 withdrawalAvailableBlock);

    /**
     * @notice Retrieves the diamond address and facet initialization status.
     */
    function returnDiamondAddressAdvertFacet() public view returns (address diamondAddress, bool initialized) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();
        return (storageData.diamondAddress, storageData.isAdvertiserFacetInitialized);
    }

    /**
     * @notice Initializes the advertisers facet.
     */
    function initializeAdvertisersFacet(address _diamondAddress, address _usdcTokenAddress, address _priceFeedAddress) public {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(!storageData.isAdvertiserFacetInitialized, "Already initialized");

        // Allow zero addresses, but warn in comments: only for test/dev environments
        require(_diamondAddress != address(0), "Invalid diamond address");
        require(_usdcTokenAddress != address(0), "Invalid USDC address");
        require(_priceFeedAddress != address(0), "Invalid price feed address");

        storageData.diamondAddress = _diamondAddress;
        storageData.usdcTokenAddress = _usdcTokenAddress;
        storageData.priceFeedAddress = _priceFeedAddress;
        storageData.isAdvertiserFacetInitialized = true;
    }

    /**
     * @notice Gets the USDC token address
     */
    function getUSDCTokenAddress() public view returns (address) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();
        return storageData.usdcTokenAddress;
    }

    /**
     * @notice Updates the USDC token address
     * @dev Phase 3: dual-auth. Before timelock enforcement, owner-direct. After, must be
     *      invoked from OpenAdvertsTimelockFacet.executeOperation (inExecution == true).
     */
    function setUSDCTokenAddress(address _newUSDCAddress) external {
        _enforceOwnerOrTimelockExec();
        require(_newUSDCAddress != address(0), "Invalid USDC address");

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        address oldAddress = storageData.usdcTokenAddress;
        storageData.usdcTokenAddress = _newUSDCAddress;

        emit USDCAddressUpdated(oldAddress, _newUSDCAddress);
    }

    /**
     * Gets the Chainlink price feed address
     */
    function getPriceFeedAddress() public view returns (address) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();
        return storageData.priceFeedAddress;
    }

    /**
     * Updates the Chainlink price feed address
     * @param _newPriceFeedAddress The new price feed address
     * @dev Phase 3: dual-auth (see setUSDCTokenAddress).
     */
    function setPriceFeedAddress(address _newPriceFeedAddress) external {
        _enforceOwnerOrTimelockExec();
        require(_newPriceFeedAddress != address(0), "Invalid price feed address");

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        address oldAddress = storageData.priceFeedAddress;
        storageData.priceFeedAddress = _newPriceFeedAddress;

        emit PriceFeedAddressUpdated(oldAddress, _newPriceFeedAddress);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 1A: Oracle hardening — staleness + price-bounds configuration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the configured oracle staleness window in seconds.
     * @dev A return value of 0 means the price facet's hard-coded default is in effect.
     */
    function getOracleStalenessSeconds() external view returns (uint256) {
        return LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().oracleStalenessSeconds;
    }

    /**
     * @notice Returns the configured oracle price bounds in oracle-native decimals.
     * @dev `(0, 0)` means bounds are disabled (no sanity check).
     */
    function getOraclePriceBounds() external view returns (uint256 minPrice, uint256 maxPrice) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage s = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        return (s.oracleMinPrice, s.oracleMaxPrice);
    }

    /**
     * @notice Sets the oracle staleness window.
     * @dev Bounded to [60, 24*3600] seconds to prevent pathological configurations.
     *      Phase 3: dual-auth (owner-direct until enforcement; timelock-exec after).
     */
    function setOracleStalenessSeconds(uint256 _seconds) external {
        _enforceOwnerOrTimelockExec();
        require(_seconds >= 60 && _seconds <= 24 * 3600, "Staleness out of range");

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage s = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        uint256 old = s.oracleStalenessSeconds;
        s.oracleStalenessSeconds = _seconds;
        emit OracleStalenessUpdated(old, _seconds);
    }

    /**
     * @notice Sets the oracle sanity bounds (min/max price in oracle-native decimals).
     * @dev Pass (0, 0) to disable the bound check. Otherwise require min < max.
     *      Phase 3: dual-auth (owner-direct until enforcement; timelock-exec after).
     */
    function setOraclePriceBounds(uint256 _minPrice, uint256 _maxPrice) external {
        _enforceOwnerOrTimelockExec();
        if (_minPrice == 0 && _maxPrice == 0) {
            // Explicit disable path.
        } else {
            require(_minPrice > 0 && _maxPrice > 0, "Use (0,0) to disable bounds");
            require(_minPrice < _maxPrice, "minPrice must be < maxPrice");
        }

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage s = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        uint256 oldMin = s.oracleMinPrice;
        uint256 oldMax = s.oracleMaxPrice;
        s.oracleMinPrice = _minPrice;
        s.oracleMaxPrice = _maxPrice;
        emit OraclePriceBoundsUpdated(oldMin, oldMax, _minPrice, _maxPrice);
    }

    /**
     * @notice PUBLIC: Reclassification function - callable by voting facet
     */
    function reclassifyAdvertisement(
        address advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType fromType,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType toType,
        uint256 newFavorableScore,
        uint256 newUnfavorableScore
    ) public {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        _validateReclassification(advertContract, fromType, toType);

        uint256 index = storageData.advertisementIndex[advertContract];
        LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement;

        if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            advertisement = storageData.prospectAdvertisements[index];
            _removeFromProspectArray(storageData, index);
        } else if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            advertisement = storageData.approvedAdvertisements[index];
            _removeFromApprovedArray(storageData, index);
        } else if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            advertisement = storageData.deprecatingAdvertisements[index];
            _removeFromDeprecatingArray(storageData, index);
        } else if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            revert("Cannot reclassify from Exhausted");
        } else if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            revert("Cannot reclassify from Withdrawn");
        } else if (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned) {
            advertisement = storageData.bannedAdvertisements[index];
            _removeFromBannedArray(storageData, index);
        }

        advertisement.AdvertisementType = toType;
        if (newFavorableScore > 0) {
            advertisement.advertFavorableScore = newFavorableScore;
        }
        if (newUnfavorableScore > 0) {
            advertisement.advertUnfavorableScore = newUnfavorableScore;
        }

        // Add to target array
        _addToTargetArray(storageData, advertisement, toType, advertContract);
        storageData.advertisementStatus[advertContract] = toType;

        emit AdvertisementStatusChanged(advertContract, fromType, toType, block.timestamp);
    }

    function _validateReclassification(
        address advertContract,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType fromType,
        LibOpenAdvertsAdvertisersStorage.AdvertisementType toType
    ) internal view {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        // Three allowed caller paths
        bool isOwner = msg.sender == ds.contractOwner;
        bool isAdvertContract = msg.sender == advertContract && storageData.advertisementExists[advertContract];
        bool isDiamondInternal = msg.sender == address(this);

        require(isOwner || isAdvertContract || isDiamondInternal, "Unauthorized: only owner, advertisement, or internal Diamond calls");

        // Advert contracts may only trigger lifecycle transitions they own.
        // Community-governed transitions (e.g. Prospect→Approved) must flow through the Diamond.
        if (isAdvertContract && !isOwner && !isDiamondInternal) {
            bool isPermitted = (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved &&
                toType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) ||
                (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect &&
                    toType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) ||
                (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating &&
                    toType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) ||
                (fromType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved &&
                    toType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted);
            require(isPermitted, "Advert contract: transition not permitted");
        }

        require(storageData.advertisementExists[advertContract], "Advertisement does not exist");
        require(fromType != toType, "Advertisement already has target type");

        LibOpenAdvertsAdvertisersStorage.AdvertisementType actualCurrentStatus = storageData.advertisementStatus[advertContract];
        require(actualCurrentStatus == fromType, "Status mismatch");
    }

    // QUERY FUNCTIONS
    function getAdvertisements(
        LibOpenAdvertsAdvertisersStorage.AdvertisementType adType
    ) public view returns (LibOpenAdvertsAdvertisersStorage.AdvertStruct[] memory) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            return storageData.prospectAdvertisements;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            return storageData.approvedAdvertisements;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            return storageData.exhaustedAdvertisements;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            return storageData.deprecatingAdvertisements;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            return storageData.withdrawnAdvertisements;
        } else if (adType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned) {
            return storageData.bannedAdvertisements;
        } else {
            revert("Invalid advertisement type");
        }
    }

    function getRemovedAdvertisements() external view returns (LibOpenAdvertsAdvertisersStorage.AdvertStruct[] memory) {
        return LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().removedAdvertisements;
    }

    function getAdvertisementExists(address advertContractAddress) public view returns (bool) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();
        return storageData.advertisementExists[advertContractAddress];
    }

    function getAdvertisementInitialFundedBudget(address advertContractAddress) public view returns (uint256) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();
        require(storageData.advertisementExists[advertContractAddress], "Advertisement does not exist");
        return storageData.advertisementInitialFundedBudget[advertContractAddress];
    }

    function getAdvertisementDetailsAndStatus(
        address advertContract
    ) public view returns (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advert, LibOpenAdvertsAdvertisersStorage.AdvertisementType status) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(storageData.advertisementExists[advertContract], "Advertisement does not exist");

        status = storageData.advertisementStatus[advertContract];
        uint256 index = storageData.advertisementIndex[advertContract];

        if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            advert = storageData.prospectAdvertisements[index];
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            advert = storageData.approvedAdvertisements[index];
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            advert = storageData.exhaustedAdvertisements[index];
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            advert = storageData.deprecatingAdvertisements[index];
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            advert = storageData.withdrawnAdvertisements[index];
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned) {
            advert = storageData.bannedAdvertisements[index];
        }
    }

    // VOTER TRACKING FUNCTIONS
    function getUserVoteOnAdvertisement(
        address advertContract,
        address user
    ) public view returns (bool hasVoted, uint256 supportVotes, uint256 denyVotes) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(storageData.advertisementExists[advertContract], "Advertisement does not exist");

        hasVoted = storageData.hasVoted[advertContract][user];
        supportVotes = storageData.hasVotedVotes[advertContract][user][true];
        denyVotes = storageData.hasVotedVotes[advertContract][user][false];
    }

    function getAdvertisementVoters(address advertContract) external view returns (address[] memory voters) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(storageData.advertisementExists[advertContract], "Advertisement does not exist");
        return storageData.advertVoters[advertContract];
    }

    function getAdvertisementVotingStats(
        address advertContract
    ) public view returns (uint256 totalVotes, uint256 favorableVotes, uint256 unfavorableVotes, uint256 uniqueVoters) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(storageData.advertisementExists[advertContract], "Advertisement does not exist");

        (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement, ) = getAdvertisementDetailsAndStatus(advertContract);

        favorableVotes = advertisement.advertFavorableScore;
        unfavorableVotes = advertisement.advertUnfavorableScore;
        totalVotes = favorableVotes + unfavorableVotes;
        uniqueVoters = storageData.advertVoters[advertContract].length;
    }

    /**
     * @notice Gets advertisement statistics
     * @return prospectCount Number of prospect advertisements
     * @return approvedCount Number of approved advertisements
     * @return exhaustedCount Number of exhausted advertisements
     * @return deprecatingCount Number of deprecating advertisements
     * @return withdrawnCount Number of withdrawn advertisements
     */
    function getAdvertisementStatistics()
        public
        view
        returns (
            uint256 prospectCount,
            uint256 approvedCount,
            uint256 exhaustedCount,
            uint256 deprecatingCount,
            uint256 withdrawnCount,
            uint256 bannedCount,
            uint256 removedCount
        )
    {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        return (
            storageData.prospectAdvertisements.length,
            storageData.approvedAdvertisements.length,
            storageData.exhaustedAdvertisements.length,
            storageData.deprecatingAdvertisements.length,
            storageData.withdrawnAdvertisements.length,
            storageData.bannedAdvertisements.length,
            storageData.removedAdvertisements.length
        );
    }

    // ADMIN FUNCTIONS
    function banAdvertisement(address advertContract) external {
        LibDiamond.enforceIsContractOwner();

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(storageData.advertisementExists[advertContract], "Advertisement not found");

        LibOpenAdvertsAdvertisersStorage.AdvertisementType currentStatus = storageData.advertisementStatus[advertContract];

        require(currentStatus != LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned, "Advertisement already banned");

        storageData.originalTypeBeforeBan[advertContract] = currentStatus;

        (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement, ) = getAdvertisementDetailsAndStatus(advertContract);

        reclassifyAdvertisement(
            advertContract,
            currentStatus,
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned,
            advertisement.advertFavorableScore,
            advertisement.advertUnfavorableScore
        );

        emit AdvertisementBanned(advertContract, block.timestamp);
    }

    function unbanAdvertisement(address advertContract) external {
        LibDiamond.enforceIsContractOwner();

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData = LibOpenAdvertsAdvertisersStorage
            .openAdvertsAdvertisersStorage();

        require(
            storageData.advertisementStatus[advertContract] == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned,
            "Advertisement is not banned"
        );

        LibOpenAdvertsAdvertisersStorage.AdvertisementType originalType = storageData.originalTypeBeforeBan[advertContract];

        if (originalType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned) {
            originalType = LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect;
        }

        (LibOpenAdvertsAdvertisersStorage.AdvertStruct memory advertisement, ) = getAdvertisementDetailsAndStatus(advertContract);

        reclassifyAdvertisement(
            advertContract,
            LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned,
            originalType,
            advertisement.advertFavorableScore,
            advertisement.advertUnfavorableScore
        );

        delete storageData.originalTypeBeforeBan[advertContract];

        emit AdvertisementUnbanned(advertContract, block.timestamp);
    }

    /**
     * Function to update advertisement's excluded affiliates from POL contract
     * @dev Only the advertisement contract itself can call this to update its own data
     * @param advertContract The address of the advertisement contract
     * @param isPaused Current paused status
     * @param pausedAtBlock Block number when paused (0 if not paused)
     * @param withdrawalAvailableBlock Block number when withdrawal becomes available
     */
    function updateAdvertisementData(address advertContract, bool isPaused, uint256 pausedAtBlock, uint256 withdrawalAvailableBlock) external {
        // SECURITY: Only the advertisement contract itself can update its own data

        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        require(msg.sender == advertContract, "Only advertisement contract can update its own data");
        require(aas.advertisementExists[advertContract], "Advertisement does not exist");

        LibOpenAdvertsAdvertisersStorage.AdvertisementType status = aas.advertisementStatus[advertContract];
        uint256 index = aas.advertisementIndex[advertContract];

        // Update the appropriate array based on current status
        if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Prospect) {
            if (index < aas.prospectAdvertisements.length) {
                aas.prospectAdvertisements[index].isPaused = isPaused;
                aas.prospectAdvertisements[index].pausedAtBlock = pausedAtBlock;
                aas.prospectAdvertisements[index].withdrawalAvailableBlock = withdrawalAvailableBlock;
            }
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Approved) {
            if (index < aas.approvedAdvertisements.length) {
                aas.approvedAdvertisements[index].isPaused = isPaused;
                aas.approvedAdvertisements[index].pausedAtBlock = pausedAtBlock;
                aas.approvedAdvertisements[index].withdrawalAvailableBlock = withdrawalAvailableBlock;
            }
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            if (index < aas.exhaustedAdvertisements.length) {
                aas.exhaustedAdvertisements[index].isPaused = isPaused;
                aas.exhaustedAdvertisements[index].pausedAtBlock = pausedAtBlock;
                aas.exhaustedAdvertisements[index].withdrawalAvailableBlock = withdrawalAvailableBlock;
            }
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            if (index < aas.deprecatingAdvertisements.length) {
                aas.deprecatingAdvertisements[index].isPaused = isPaused;
                aas.deprecatingAdvertisements[index].pausedAtBlock = pausedAtBlock;
                aas.deprecatingAdvertisements[index].withdrawalAvailableBlock = withdrawalAvailableBlock;
            }
        } else if (status == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            if (index < aas.withdrawnAdvertisements.length) {
                aas.withdrawnAdvertisements[index].isPaused = isPaused;
                aas.withdrawnAdvertisements[index].pausedAtBlock = pausedAtBlock;
                aas.withdrawnAdvertisements[index].withdrawalAvailableBlock = withdrawalAvailableBlock;
            }
        }
        emit AdvertisementDataUpdated(advertContract, isPaused, pausedAtBlock, withdrawalAvailableBlock);
    }

    // INTERNAL HELPER FUNCTIONS - Keep all the _removeFromXArray and _addToTargetArray functions
    function _removeFromProspectArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        require(index < storageData.prospectAdvertisements.length, "Invalid index");
        uint256 lastIndex = storageData.prospectAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.prospectAdvertisements[index] = storageData.prospectAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.prospectAdvertisements[index].advertContractAddress] = index;
        }
        storageData.prospectAdvertisements.pop();
    }

    function _removeFromApprovedArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        require(index < storageData.approvedAdvertisements.length, "Invalid index");

        // Read affiliate and advert address BEFORE swap-and-pop destroys the slot
        address affiliate = storageData.approvedAdvertisements[index].designatedAffiliate;
        address advertContract = storageData.approvedAdvertisements[index].advertContractAddress;

        uint256 lastIndex = storageData.approvedAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.approvedAdvertisements[index] = storageData.approvedAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.approvedAdvertisements[index].advertContractAddress] = index;
        }
        storageData.approvedAdvertisements.pop();

        // Remove from affiliate reverse index
        if (affiliate != address(0)) {
            uint256 affAdvLen = storageData.affiliateApprovedAdverts[affiliate].length;
            if (affAdvLen > 0) {
                uint256 affIdx = storageData.affiliateApprovedAdvertIndex[affiliate][advertContract];
                uint256 affLastIdx = affAdvLen - 1;
                if (affIdx != affLastIdx) {
                    address movedAdvert = storageData.affiliateApprovedAdverts[affiliate][affLastIdx];
                    storageData.affiliateApprovedAdverts[affiliate][affIdx] = movedAdvert;
                    storageData.affiliateApprovedAdvertIndex[affiliate][movedAdvert] = affIdx;
                }
                storageData.affiliateApprovedAdverts[affiliate].pop();
                delete storageData.affiliateApprovedAdvertIndex[affiliate][advertContract];
            }
        }
    }

    function _removeFromDeprecatingArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        require(index < storageData.deprecatingAdvertisements.length, "Invalid index");
        uint256 lastIndex = storageData.deprecatingAdvertisements.length - 1;
        if (index != lastIndex) {
            storageData.deprecatingAdvertisements[index] = storageData.deprecatingAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.deprecatingAdvertisements[index].advertContractAddress] = index;
        }
        storageData.deprecatingAdvertisements.pop();
    }

    // ADD: Remove from banned array
    function _removeFromBannedArray(LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage storageData, uint256 index) internal {
        require(index < storageData.bannedAdvertisements.length, "Invalid index");
        uint256 lastIndex = storageData.bannedAdvertisements.length - 1;

        if (index != lastIndex) {
            storageData.bannedAdvertisements[index] = storageData.bannedAdvertisements[lastIndex];
            storageData.advertisementIndex[storageData.bannedAdvertisements[index].advertContractAddress] = index;
        }

        storageData.bannedAdvertisements.pop();
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
            // Add to affiliate reverse index
            if (advertisement.designatedAffiliate != address(0)) {
                storageData.affiliateApprovedAdvertIndex[advertisement.designatedAffiliate][advertContract] = storageData
                    .affiliateApprovedAdverts[advertisement.designatedAffiliate]
                    .length;
                storageData.affiliateApprovedAdverts[advertisement.designatedAffiliate].push(advertContract);
            }
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Exhausted) {
            storageData.exhaustedAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.exhaustedAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Deprecating) {
            storageData.deprecatingAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.deprecatingAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Withdrawn) {
            storageData.withdrawnAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.withdrawnAdvertisements.length - 1;
        } else if (targetType == LibOpenAdvertsAdvertisersStorage.AdvertisementType.Banned) {
            storageData.bannedAdvertisements.push(advertisement);
            storageData.advertisementIndex[advertContract] = storageData.bannedAdvertisements.length - 1;
        }
    }

    /**
     * @notice Checks if an advertisement contract has been commissioned
     * @param advertContract The address of the advertisement contract
     * @return True if commissioned, false otherwise
     */
    function returnAdvertisementCommissioned(address advertContract) external view returns (bool) {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        return aas.advertisementCommissioned[advertContract];
    }

    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own state variable (not library storage) for direct calls
     * @dev This allows the facet to forward funds even when called directly
     */
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
