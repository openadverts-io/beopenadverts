// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import {LibOpenAdvertsGovernanceStorage} from "../libraries/LibOpenAdvertsGovernanceStorage.sol";
import {LibOpenAdvertsAffiliatesStorage} from "../libraries/LibOpenAdvertsAffiliatesStorage.sol";
import {LibOpenAdvertsAdvertisersStorage} from "../libraries/LibOpenAdvertsAdvertisersStorage.sol";
import {LibOpenAdvertsPayoutStorage} from "../libraries/LibOpenAdvertsPayoutStorage.sol";
import {LibOpenAdvertsBootstrapStorage} from "../libraries/LibOpenAdvertsBootstrapStorage.sol";

import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title OpenAdvertsTokenFacet
 * @dev This facet implements the ERC20 token functionality for the OpenAdverts ecosystem,
 * including token initialization, transfers, dividend distribution, and basic metadata accessors.
 * It also interacts with governance and other storage libraries to facilitate protocol-wide updates.
 */
contract OpenAdvertsTokenFacet is ReentrancyGuard {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    event ProposalCreated(address newImplementation, uint256 endTime);
    event ProposalExecuted(address newImplementation);
    event ImplementationUpdated(address newImplementation);
    event UpgradeSet(bytes4[] functionSelectors, address[] implementations);
    event UpgradeRatified(bytes4[] functionSelectors, address[] implementations);

    event Transfer(address indexed from, address indexed to, uint256 value);

    event DividendDistributed(address indexed recipient, uint256 polAmount, uint256 usdcAmount, bool polSuccess, bool usdcSuccess);

    event BootstrapFinalized(address indexed by);

    using SafeERC20 for IERC20; // SafeERC20 for safe token operations

    // mapping(address => uint256) private lastTransferBlock;
    // mapping(address => uint256) private lastVoteBlock;

    /**
     * @dev Initializes the token facet by setting total supply, token metadata, initial governance quotas,
     * and minting the total supply to the deployer. This function can only be executed once.
     */
    function initialize(address _diamondAddress) external {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        // USDC address is set via OpenAdvertsAdvertisersFacet.initializeAdvertisersFacet() and
        // stored in LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().usdcTokenAddress.

        require(msg.sender == LibDiamond.contractOwner(), "Only contract owner can initialize");
        require(!tokenStorage.isTokenFacetinitialized, "Token facet already initialized");

        if (!tokenStorage.isTokenFacetinitialized) {
            // TOKEN INITIALIZATION
            tokenStorage.totalSupply = 21000000 * 10 ** 18; // 21M OAD tokens
            tokenStorage.name = "OpenAdverts";
            tokenStorage.symbol = "OAD";
            tokenStorage.isTokenFacetinitialized = true;
            tokenStorage.diamondAddress = _diamondAddress;

            // COMMISSION PARAMETERS
            govStorage.currentQuotas.openAdvertsCommission = 10; // 10%
            govStorage.currentQuotas.storageProviderCommissionFromADVC = 5; // 5%
            govStorage.currentQuotas.adminCommissionFromADVC = 5; // 5%
            // BLOCKCHAIN PARAMETERS
            govStorage.currentQuotas.polBlocksPerHour = 1800; // ~1800 blocks per hour on Polygon (2s per block)

            // QUOTA PROPOSAL PARAMETERS
            govStorage.currentQuotas.QuotaProposalQuorum = 51; // 51%
            govStorage.currentQuotas.minQuotaProposalDuration = 302400; // ~7 days at 2s/block (7 * 24 * 60 * 60 / 2)
            govStorage.currentQuotas.maxQuotaProposalDuration = 3888000; // ~90 days at 2s per block

            // FACET PROPOSAL PARAMETERS
            govStorage.currentQuotas.FacetProposalQuorum = 51; // 51%
            govStorage.currentQuotas.minFacetProposalDuration = 302400; // ~7 days at 2s/block (7 * 24 * 60 * 60 / 2)
            govStorage.currentQuotas.maxFacetProposalDuration = 3888000; // ~90 days at 2s per block

            // ADMIN PARAMETERS
            govStorage.currentQuotas.openAdvertsAdminChangeQuorum = 51; // 51%
            govStorage.currentQuotas.adminVoteDeadlineInBlocks = 1296000; // ~1 month at 2s per block
            govStorage.currentQuotas.adminApplicantFeeInPolWei = 500 * 1 ether; // 500 POL

            // ADVERTISEMENT PARAMETERS
            govStorage.currentQuotas.minPOLRequiredforAdvertInWei = 200 * 1 ether; // 200 POL
            govStorage.currentQuotas.USDCCurrencyPremiumInPCT = 200; // 200% premium to cover currency risk (governance-adjustable)
            govStorage.currentQuotas.minAdvertBountyInPOLWei = (60 * 1 ether) / 1000; // 0.06 POL — shared POL/USDC floor; covers ~90k gas/sig up to ~467 gwei at 70% viewer share (see OpenAdvertsGovernanceFacet ASSUMED_* + claim-gas guard)
            govStorage.currentQuotas.maxBlockSeparationAdvertisement = (12 * 60 * 60) / 2; // ~12 hours at 2s per block
            govStorage.currentQuotas.advertApprovalDenialQuorum = 20; // 20%
            govStorage.currentQuotas.advertApprovalThreshold = 60; // 60%
            govStorage.currentQuotas.advertDenialThreshold = 60; // 60%
            govStorage.currentQuotas.advertPauseCooldownBlocks = 302400; // ~7 days at 2s/block (7 * 24 * 60 * 60 / 2)
            // AFFILIATE PARAMETERS
            govStorage.currentQuotas.affiliateApprovalDenialQuorum = 20; // 20%
            govStorage.currentQuotas.affiliateApprovalThreshold = 60; // 60%
            govStorage.currentQuotas.affiliateDenialThreshold = 60; // 60%

            // PAYOUT PARAMETERS
            // processReward gas is quadratic in batch size (in-memory dedup scans, ~thirdPartyCount^2);
            // 50 keeps the worst legal path (6 unique third parties/sig on the uncapped POL contract,
            // ~9M gas) well within Polygon's 30M block limit. See OpenAdvertsGovernanceFacet 1-75 bound.
            govStorage.currentQuotas.maxSignaturesPerBatch = 50; // Maximum signatures per claimReward call
            govStorage.currentQuotas.minViewerClaimPct = 70; // Minimum viewer share per bounty

            // TOKEN DISTRIBUTION
            // Mint the total supply to the deployer's address
            address deployer = msg.sender;
            tokenStorage.balances[deployer] += tokenStorage.totalSupply;

            // EMIT INITIAL TRANSFER EVENT
            emit Transfer(address(0), deployer, tokenStorage.totalSupply);
        }
    }

    /**
     * @dev Checks if the token facet has been initialized.
     * @return True if initialized, false otherwise.
     */
    function isInitialized() external view returns (bool) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        return tokenStorage.isTokenFacetinitialized;
    }

    /**
     * @notice Irreversibly ends the bootstrap phase, permanently disabling the owner-only
     *         direct diamondCut backdoor. Owner-only. Called at the end of deployment once all
     *         facet cuts and initializations are complete; afterwards facet upgrades must go
     *         through governance. Does NOT affect owner-only config setters (signing address,
     *         storage provider, claim-gas floor), which remain callable.
     */
    function finalizeBootstrap() external {
        LibDiamond.enforceIsContractOwner();
        LibOpenAdvertsBootstrapStorage.BootstrapStruct storage bs = LibOpenAdvertsBootstrapStorage.bootstrapStorage();
        require(!bs.directCutFinalized, "Bootstrap already finalized");
        bs.directCutFinalized = true;
        emit BootstrapFinalized(msg.sender);
    }

    /**
     * @notice Whether the bootstrap latch has been tripped (direct diamondCut disabled).
     */
    function isBootstrapFinalized() external view returns (bool) {
        return LibOpenAdvertsBootstrapStorage.bootstrapStorage().directCutFinalized;
    }

    /**
     * @dev Returns the token name.
     * @return The token name as a string.
     */
    function name() public view virtual returns (string memory) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        return tokenStorage.name;
    }

    /**
     * @dev Returns the token symbol.
     * @return The token symbol as a string.
     */
    function symbol() public view virtual returns (string memory) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        return tokenStorage.symbol;
    }

    /**
     * @dev Returns the total token supply.
     * @return The total supply as a uint256.
     */
    function totalSupply() public view virtual returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        return tokenStorage.totalSupply;
    }

    /**
     * @dev Returns the number of decimals used for token representation.
     * @return The number of decimals (18).
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @dev Returns the token balance of a given account.
     * @param account The address of the account.
     * @return The token balance as a uint256.
     */
    function balanceOf(address account) public view virtual returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        return tokenStorage.balances[account];
    }

    /**
     * @notice Phase 2 — balance of `account` at the given historical `snapshotId`.
     * @dev Returns the pre-mutation value captured by the transfer hook for the
     *      smallest recorded id >= snapshotId; if no such checkpoint exists, the
     *      current balance is returned (because no transfer has touched this
     *      account since the snapshot was taken, so current == snapshot).
     *      Reverts if snapshotId is zero or greater than the current id.
     */
    function balanceOfAt(address account, uint256 snapshotId) public view returns (uint256) {
        require(snapshotId > 0, "Snapshot id is zero");
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
        require(snapshotId <= ts.currentSnapshotId, "Snapshot id out of range");

        LibOpenAdvertsTokenStorage.Snapshots storage snaps = ts.accountBalanceSnapshots[account];
        uint256 lo = 0;
        uint256 hi = snaps.ids.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (snaps.ids[mid] < snapshotId) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo == snaps.ids.length) {
            // No checkpoint at or after snapshotId — account has not transferred
            // since snapshotId was taken, so current balance == balance at snapshotId.
            return ts.balances[account];
        }
        return snaps.values[lo];
    }

    /**
     * @notice Phase 2 — returns the current (latest) snapshot id.
     * @dev id = 0 means no snapshot has ever been taken.
     */
    function currentSnapshotId() external view returns (uint256) {
        return LibOpenAdvertsTokenStorage.tokenStorage().currentSnapshotId;
    }

    /**
     * @dev Transfers tokens from the caller's account to a recipient.
     * Also triggers dividend distribution for both sender and recipient,
     * and adjusts any associated voting balances.
     * @param recipient The address to transfer tokens to.
     * @param amount The amount of tokens to transfer.
     * @return True if the transfer succeeds.
     */
    function transfer(address recipient, uint256 amount) public virtual returns (bool) {
        // FLASH LOAN PROTECTION: Record transfer activity
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
        ts.lastTransferBlock[msg.sender] = block.number;
        ts.lastTransferBlock[recipient] = block.number;

        // This prevents them from claiming pre-existing dividends
        if (ts.balances[recipient] == 0 && amount > 0) {
            // Recipient is receiving tokens for the first time
            ts.lastRewardClaimInPOL[recipient] = ts.totalAggregateRewardInPOL;
            ts.lastRewardClaimInUSDC[recipient] = ts.totalAggregateRewardInUSDC;
        }

        // Distribute any pending dividends before transferring tokens.
        distributeReward(msg.sender);
        distributeReward(recipient);

        // Adjust votes for the sender as tokens are moved.
        undoVotes(msg.sender, amount);

        // Execute token transfer.
        _transferCustom(msg.sender, recipient, amount);

        return true;
    }

    /**
     * @dev Records voting activity for any type of voting
     * @param voter The address that performed a voting action
     */
    function recordVoteActivity(address voter) external {
        // Only callable via Diamond internal dispatch (flashLoanProtection modifier calls
        // IOpenAdvertsTokenFacet(address(this)).recordVoteActivity(msg.sender), so
        // msg.sender here equals the Diamond address).
        require(msg.sender == address(this), "Only callable via Diamond internal dispatch");
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
        ts.lastVoteBlock[voter] = block.number;
    }

    function canVoteThisBlock(address account) public view returns (bool) {
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
        uint256 transferBlock = ts.lastTransferBlock[account];
        uint256 voteBlock = ts.lastVoteBlock[account];

        // PROTECTION: Can't vote in same block as transfer OR if voted recently
        if (transferBlock == block.number) return false;
        if (voteBlock == block.number) return false;

        // EXTENDED PROTECTION: 1 block cooldown after transfers
        if (transferBlock > 0 && block.number <= transferBlock + 1) return false;
        if (voteBlock > 0 && block.number <= voteBlock + 1) return false;

        return true;
    }

    /**
     * @dev Internal function to handle token transfers between addresses.
     * Validates sender and recipient addresses, and updates token balances.
     * Emits a {Transfer} event upon success.
     * @param sender The address sending tokens.
     * @param recipient The address receiving tokens.
     * @param amount The number of tokens to transfer.
     */
    function _transferCustom(address sender, address recipient, uint256 amount) internal {
        if (sender == address(0)) {
            revert("ERC20: Invalid sender address");
        }

        // Check for invalid recipient address
        if (recipient == address(0)) {
            revert("ERC20: Invalid receiver address");
        }
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        require(tokenStorage.balances[sender] >= amount, "ERC20: transfer amount exceeds balance");

        // Phase 2 — capture pre-mutation balances for the currently active snapshot.
        _updateAccountSnapshot(sender);
        _updateAccountSnapshot(recipient);

        tokenStorage.balances[sender] -= amount;
        tokenStorage.balances[recipient] += amount;

        emit Transfer(sender, recipient, amount);
    }

    /**
     * @notice Phase 2 — lazy snapshot write. Pushes (currentSnapshotId, preBalance)
     *         for `account` only if no checkpoint exists at the current id yet.
     *         No-op when currentSnapshotId == 0 (no snapshot taken).
     */
    function _updateAccountSnapshot(address account) private {
        LibOpenAdvertsTokenStorage.TokenStorage storage ts = LibOpenAdvertsTokenStorage.tokenStorage();
        uint256 currentId = ts.currentSnapshotId;
        if (currentId == 0) {
            return;
        }
        LibOpenAdvertsTokenStorage.Snapshots storage snaps = ts.accountBalanceSnapshots[account];
        uint256 len = snaps.ids.length;
        if (len == 0 || snaps.ids[len - 1] < currentId) {
            snaps.ids.push(currentId);
            snaps.values.push(ts.balances[account]);
        }
    }

    /**
     * @dev Distributes any pending dividend to the specified account.
     * Calculates the dividend amount and transfers it to the account,
     * while updating the last claimed dividend record.
     * @param account The address for which to distribute dividends.
     */
    function distributeReward(address account) public returns (bool) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        require(!tokenStorage.rewardClaimInProgress[account], "Reward claim already in progress for this account");

        // NEW: Process any new USDC deposits FIRST
        processNewUSDCDeposits();

        // Calculate POL rewards
        uint256 polAmountToSend = calculateRewardPOL(account);

        // Calculate USDC rewards
        uint256 usdcAmountToSend = calculateRewardUSDC(account);

        // REMOVED: Don't initialize here - it's too late in the transfer flow
        // The transfer() function now handles this BEFORE calling distributeReward()

        // If no rewards available, just return false without reverting
        if (polAmountToSend == 0 && usdcAmountToSend == 0) {
            return false;
        }

        tokenStorage.rewardClaimInProgress[account] = true; // Prevent re-entrancy

        bool polSuccess = true;
        bool usdcSuccess = true;

        if (polAmountToSend > 0) {
            tokenStorage.lastRewardClaimInPOL[account] = tokenStorage.totalAggregateRewardInPOL;

            (polSuccess, ) = payable(account).call{value: polAmountToSend}("");
        }

        if (usdcAmountToSend > 0) {
            tokenStorage.lastRewardClaimInUSDC[account] = tokenStorage.totalAggregateRewardInUSDC;

            LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage
                .openAdvertsAdvertisersStorage();

            require(aas.usdcTokenAddress != address(0), "USDC token address not set");

            IERC20 usdcToken = IERC20(aas.usdcTokenAddress);
            uint256 contractUSDCBalance = usdcToken.balanceOf(address(this));

            require(contractUSDCBalance >= usdcAmountToSend, "Insufficient USDC balance in contract");

            try usdcToken.transfer(account, usdcAmountToSend) returns (bool transferSuccess) {
                usdcSuccess = transferSuccess;
                // NEW: Update lastKnownUSDCBalance after successful transfer
                if (transferSuccess) {
                    tokenStorage.lastKnownUSDCBalance = usdcToken.balanceOf(address(this));
                }
            } catch {
                usdcSuccess = false;
            }
        }

        emit DividendDistributed(account, polAmountToSend, usdcAmountToSend, polSuccess, usdcSuccess);

        tokenStorage.rewardClaimInProgress[account] = false;

        return polSuccess && usdcSuccess;
    }

    /**
     * @dev Returns the last USDC reward claim aggregate for a specific account.
     */
    function getLastRewardClaimInUSDC(address account) external view returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        return tokenStorage.lastRewardClaimInUSDC[account];
    }

    /**
     * @dev Returns both POL and USDC pending rewards in a single call
     * Gas-efficient combined query
     */
    function getPendingRewards(address account) external view returns (uint256 polRewards, uint256 usdcRewards) {
        return (calculateRewardPOL(account), calculateRewardUSDC(account));
    }

    /**
     * @dev Proportionally removes `account`'s active vote weight before `amount` tokens leave the
     * account, across admin-election, quota/facet proposal, affiliate, and advert votes, so recorded
     * vote tallies stay consistent with token balances.
     * @param account The address whose votes should be adjusted.
     * @param amount The token amount being removed from the account's voting power.
     */
    function undoVotes(address account, uint256 amount) internal {
        // Add all storage access and validation
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        require(amount <= tokenStorage.balances[account], "Amount exceeds account balance");

        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage ds = LibOpenAdvertsAffiliatesStorage.openAdvertsAffiliatesStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        // Admin vote correction - REMOVED BOOLEAN SUPPORT
        for (uint256 i = 0; i < govStorage.proposedAdminAddresses.length; i++) {
            address adminCandidate = govStorage.proposedAdminAddresses[i];

            uint256 currentVotes = govStorage.adminVotesByUser[account][govStorage.adminVoteId][adminCandidate];

            if (currentVotes > 0) {
                uint256 reductionAmount = amount > currentVotes ? currentVotes : amount;
                govStorage.adminVotesByUser[account][govStorage.adminVoteId][adminCandidate] -= reductionAmount;
                govStorage.totalVotesPerAdminCandidate[govStorage.adminVoteId][adminCandidate] -= reductionAmount;
            }
        }

        // Proposal vote correction with better validation
        if (govStorage.hasVotedOnProposal[account][govStorage.currentProposalId]) {
            uint256 currentSupportVotes = govStorage.votesByUser[account][govStorage.currentProposalId][true];
            uint256 currentOpposeVotes = govStorage.votesByUser[account][govStorage.currentProposalId][false];

            if (currentSupportVotes > 0) {
                uint256 reductionAmount = amount > currentSupportVotes ? currentSupportVotes : amount;
                govStorage.votesByUser[account][govStorage.currentProposalId][true] -= reductionAmount;
                govStorage.proposalStruct.totalSupportVotesForCurrentProposal -= reductionAmount;
            } else if (currentOpposeVotes > 0) {
                uint256 reductionAmount = amount > currentOpposeVotes ? currentOpposeVotes : amount;
                govStorage.votesByUser[account][govStorage.currentProposalId][false] -= reductionAmount;
                govStorage.proposalStruct.totalDenyVotesForCurrentProposal -= reductionAmount;
            }

            if (
                govStorage.votesByUser[account][govStorage.currentProposalId][true] == 0 &&
                govStorage.votesByUser[account][govStorage.currentProposalId][false] == 0
            ) {
                govStorage.hasVotedOnProposal[account][govStorage.currentProposalId] = false;
            }
        }

        // Your helper functions are perfect!
        _reduceAffiliateVotes(ds, account, amount, true); // Prospects
        _reduceAffiliateVotes(ds, account, amount, false); // Approved
        _reduceAdvertisementVotes(aas, account, amount, true); // Prospects
        _reduceAdvertisementVotes(aas, account, amount, false); // Approved
    }

    // Helper function to reduce affiliate votes efficiently
    function _reduceAffiliateVotes(
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage ds,
        address account,
        uint256 amount,
        bool isProspect
    ) internal {
        LibOpenAdvertsAffiliatesStorage.AffiliateStruct[] storage affiliateArray = isProspect ? ds.prospectAffiliates : ds.approvedAffiliates;

        for (uint256 i = 0; i < affiliateArray.length; i++) {
            address affiliateAddress = affiliateArray[i].affiliateContractAddress;

            if (ds.hasVoted[affiliateAddress][account]) {
                uint256 supportVotes = ds.hasVotedVotes[affiliateAddress][account][true];
                uint256 denyVotes = ds.hasVotedVotes[affiliateAddress][account][false];

                if (supportVotes > 0) {
                    uint256 reductionAmount = amount > supportVotes ? supportVotes : amount;
                    ds.hasVotedVotes[affiliateAddress][account][true] -= reductionAmount;

                    // Also reduce the affiliate's aggregate favorable score
                    if (affiliateArray[i].affiliateFavorableScore >= reductionAmount) {
                        affiliateArray[i].affiliateFavorableScore -= reductionAmount;
                    } else {
                        affiliateArray[i].affiliateFavorableScore = 0; // Underflow protection
                    }

                    if (ds.hasVotedVotes[affiliateAddress][account][true] == 0 && ds.hasVotedVotes[affiliateAddress][account][false] == 0) {
                        _removeAffiliateVote(ds, account, affiliateAddress);
                    }
                } else if (denyVotes > 0) {
                    uint256 reductionAmount = amount > denyVotes ? denyVotes : amount;
                    ds.hasVotedVotes[affiliateAddress][account][false] -= reductionAmount;

                    //  Also reduce the affiliate's aggregate unfavorable score
                    if (affiliateArray[i].affiliateUnfavorableScore >= reductionAmount) {
                        affiliateArray[i].affiliateUnfavorableScore -= reductionAmount;
                    } else {
                        affiliateArray[i].affiliateUnfavorableScore = 0; // Underflow protection
                    }

                    if (ds.hasVotedVotes[affiliateAddress][account][true] == 0 && ds.hasVotedVotes[affiliateAddress][account][false] == 0) {
                        _removeAffiliateVote(ds, account, affiliateAddress);
                    }
                }
            }
        }
    }

    // Helper function to reduce advertisement votes efficiently
    function _reduceAdvertisementVotes(
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas,
        address account,
        uint256 amount,
        bool isProspect
    ) internal {
        LibOpenAdvertsAdvertisersStorage.AdvertStruct[] storage advertArray = isProspect ? aas.prospectAdvertisements : aas.approvedAdvertisements;

        for (uint256 i = 0; i < advertArray.length; i++) {
            address advertAddress = advertArray[i].advertContractAddress;

            if (aas.hasVoted[advertAddress][account]) {
                uint256 supportVotes = aas.hasVotedVotes[advertAddress][account][true];
                uint256 denyVotes = aas.hasVotedVotes[advertAddress][account][false];

                if (supportVotes > 0) {
                    uint256 reductionAmount = amount > supportVotes ? supportVotes : amount;
                    aas.hasVotedVotes[advertAddress][account][true] -= reductionAmount;

                    // Also reduce the advertisement's aggregate favorable score
                    if (advertArray[i].advertFavorableScore >= reductionAmount) {
                        advertArray[i].advertFavorableScore -= reductionAmount;
                    } else {
                        advertArray[i].advertFavorableScore = 0; // Underflow protection
                    }

                    if (aas.hasVotedVotes[advertAddress][account][true] == 0 && aas.hasVotedVotes[advertAddress][account][false] == 0) {
                        _removeAdvertVote(aas, account, advertAddress);
                    }
                } else if (denyVotes > 0) {
                    uint256 reductionAmount = amount > denyVotes ? denyVotes : amount;
                    aas.hasVotedVotes[advertAddress][account][false] -= reductionAmount;

                    // Also reduce the advertisement's aggregate unfavorable score
                    if (advertArray[i].advertUnfavorableScore >= reductionAmount) {
                        advertArray[i].advertUnfavorableScore -= reductionAmount;
                    } else {
                        advertArray[i].advertUnfavorableScore = 0; // Underflow protection
                    }

                    if (aas.hasVotedVotes[advertAddress][account][true] == 0 && aas.hasVotedVotes[advertAddress][account][false] == 0) {
                        _removeAdvertVote(aas, account, advertAddress);
                    }
                }
            }
        }
    }

    function _removeAffiliateVote(
        LibOpenAdvertsAffiliatesStorage.OpenAdvertsAffiliatesStruct storage ds,
        address sender,
        address affiliateAddress
    ) internal {
        ds.hasVoted[affiliateAddress][sender] = false;
        address[] storage preVoteAddresses = ds.userVotingAddresses[sender];
        uint256 index = ds.userVotingAddressIndex[sender][affiliateAddress];
        address lastAddress = preVoteAddresses[preVoteAddresses.length - 1];
        preVoteAddresses[index] = lastAddress;
        ds.userVotingAddressIndex[sender][lastAddress] = index;
        preVoteAddresses.pop();
        delete ds.userVotingAddressIndex[sender][affiliateAddress];
    }

    function _removeAdvertVote(
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas,
        address sender,
        address advertAddress
    ) internal {
        aas.hasVoted[advertAddress][sender] = false;
        address[] storage preVoteAddresses = aas.userVotingAddresses[sender];
        uint256 index = aas.userVotingAddressIndex[sender][advertAddress];
        address lastAddress = preVoteAddresses[preVoteAddresses.length - 1];
        preVoteAddresses[index] = lastAddress;
        aas.userVotingAddressIndex[sender][lastAddress] = index;
        preVoteAddresses.pop();
        delete aas.userVotingAddressIndex[sender][advertAddress];
    }

    /**
     * @dev Calculates the POL dividend owed to an account.
     * Renamed from calculateReward() to be currency-specific
     * @param account The address for which to calculate the dividend.
     * @return The POL dividend amount as a uint256.
     */
    function calculateRewardPOL(address account) public view returns (uint256) {
        uint256 accountADVBalance = balanceOf(account);
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        // Prevent division by zero
        if (accountADVBalance == 0 || totalSupply() == 0) {
            return 0;
        }

        uint256 lastClaimedAtRewardAggregate = tokenStorage.lastRewardClaimInPOL[account];

        uint256 holderPercentage = (accountADVBalance * 10 ** 18) / totalSupply();
        uint256 holderRewardInPol = ((tokenStorage.totalAggregateRewardInPOL - lastClaimedAtRewardAggregate) * holderPercentage) / 10 ** 18;

        return holderRewardInPol;
    }

    /**
     * @dev Calculates the USDC dividend owed to an account.
     * Calculate USDC rewards based on token holdings
     * @param account The address for which to calculate the USDC dividend.
     * @return The USDC dividend amount as a uint256 (6 decimals for USDC).
     */
    function calculateRewardUSDC(address account) public view returns (uint256) {
        uint256 accountADVBalance = balanceOf(account);
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();

        // Prevent division by zero
        if (accountADVBalance == 0 || totalSupply() == 0) {
            return 0;
        }

        uint256 lastClaimedAtRewardAggregate = tokenStorage.lastRewardClaimInUSDC[account];

        uint256 holderPercentage = (accountADVBalance * 10 ** 18) / totalSupply();
        uint256 holderRewardInUSDC = ((tokenStorage.totalAggregateRewardInUSDC - lastClaimedAtRewardAggregate) * holderPercentage) / 10 ** 18;

        return holderRewardInUSDC;
    }

    /**
     * @dev Returns the total aggregate reward pool.
     */
    function getTotalAggregateRewardInPOL() external view returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        return tokenStorage.totalAggregateRewardInPOL;
    }

    /**
     * @dev Returns the total aggregate reward pool in USDC.
     */
    function getTotalAggregateRewardInUSDC() external view returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        return tokenStorage.totalAggregateRewardInUSDC;
    }

    /**
     * @dev Returns the LastRewardClaimInPOL for a specific account.
     */
    function getLastRewardClaimInPOL(address account) external view returns (uint256) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        return tokenStorage.lastRewardClaimInPOL[account];
    }

    /**
     * @dev Detects and processes new USDC deposits automatically
     * No external contract can manipulate reward tracking
     * This function compares actual USDC balance with last known balance
     * and allocates new deposits between admin and token holders
     * Can be called during admin transitions or by anyone to sync state
     */
    function processNewUSDCDeposits() public {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        LibOpenAdvertsGovernanceStorage.GovernanceStorage storage govStorage = LibOpenAdvertsGovernanceStorage.governanceStorage();
        LibOpenAdvertsPayoutStorage.OpenAdvertsPayoutStruct storage payoutStore = LibOpenAdvertsPayoutStorage.openAdvertsPayoutStorage();

        // Get USDC token contract
        require(aas.usdcTokenAddress != address(0), "USDC token address not set");
        IERC20 usdcToken = IERC20(aas.usdcTokenAddress);

        // Check current balance
        uint256 currentBalance = usdcToken.balanceOf(address(this));
        uint256 lastKnown = tokenStorage.lastKnownUSDCBalance;

        // Detect new deposits
        if (currentBalance > lastKnown) {
            uint256 newDeposits = currentBalance - lastKnown;

            // 3-way split: admin + storage provider + OAD holder rewards
            uint256 adminAmount = (newDeposits * govStorage.currentQuotas.adminCommissionFromADVC) / 100;
            uint256 spAmount = (newDeposits * govStorage.currentQuotas.storageProviderCommissionFromADVC) / 100;
            uint256 holderAmount = newDeposits - adminAmount - spAmount;

            // Track admin allocation (withdrawn later via withdrawAdminUSDC)
            tokenStorage.totalAggregateAdminUSDC += adminAmount;

            // Transfer storage provider share immediately (matches Diamond.receive and receiveAndSplitUSDCCommission patterns)
            if (spAmount > 0) {
                address spAddress = payoutStore.storageProviderAddress;
                if (spAddress != address(0)) {
                    usdcToken.safeTransfer(spAddress, spAmount);
                } else {
                    // No storage provider configured — redirect to OAD holder reward pool
                    holderAmount += spAmount;
                }
            }

            // Remainder accumulates for OAD holder dividends
            tokenStorage.totalAggregateRewardInUSDC += holderAmount;
            tokenStorage.lastKnownUSDCBalance = usdcToken.balanceOf(address(this));
        }
    }

    /**
     * @dev Allows admin to withdraw their accumulated USDC commission
     * ✅ Only the contract owner can call this function
     */
    function withdrawAdminUSDC() external nonReentrant {
        require(msg.sender == LibDiamond.contractOwner(), "Only contract owner can withdraw admin USDC");

        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();

        // Process any new deposits first
        processNewUSDCDeposits();

        // Calculate available admin USDC
        uint256 availableAdmin = tokenStorage.totalAggregateAdminUSDC - tokenStorage.adminWithdrawnUSDC;
        require(availableAdmin > 0, "No admin USDC available");

        // Get USDC token contract
        require(aas.usdcTokenAddress != address(0), "USDC token address not set");
        IERC20 usdcToken = IERC20(aas.usdcTokenAddress);

        // Transfer USDC to admin
        usdcToken.safeTransfer(msg.sender, availableAdmin);

        // Update tracking
        tokenStorage.adminWithdrawnUSDC += availableAdmin;
        tokenStorage.lastKnownUSDCBalance = usdcToken.balanceOf(address(this));
    }

    /**
     * @dev Returns admin USDC allocation information
     */
    function getAdminUSDCInfo() external view returns (uint256 totalAllocated, uint256 withdrawn, uint256 available) {
        LibOpenAdvertsTokenStorage.TokenStorage storage tokenStorage = LibOpenAdvertsTokenStorage.tokenStorage();
        totalAllocated = tokenStorage.totalAggregateAdminUSDC;
        withdrawn = tokenStorage.adminWithdrawnUSDC;
        available = totalAllocated - withdrawn;
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
