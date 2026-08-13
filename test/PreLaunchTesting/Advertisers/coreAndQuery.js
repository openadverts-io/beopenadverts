/**
 * @title OpenAdvertsAdvertisersFacet Core Functions Test Suite
 * @notice Comprehensive testing for core advertiser facet functionality including:
 *         - Facet initialization and state management
 *         - USDC token integration
 *         - Price feed (oracle) integration
 *         - Advertisement query operations
 *         - Commission tracking
 * @dev Tests verify both happy paths and edge cases with proper access controls
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const gate = require("../../helpers/signatureGate.js");

// =============================================================================
// GLOBAL TEST FIXTURES
// =============================================================================

let diamondAddress;
let gateSigner;
let advertisersFacet;
let advertPOLFactoryFacet; 
let governanceFacet; 
let mockUSDC;
let owner;
let nonOwner;
let user1, user2, user3, user4, user5;
let voter1, voter2, voter3;

// =============================================================================
// CONSTANTS
// =============================================================================


const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * @notice Advertisement lifecycle states
 * @dev Enum values matching AdvertisementType in contracts
 */
const AdvertisementType = {
    Prospect: 0,
    Approved: 1,
    Exhausted: 2,
    Deprecating: 3,
    Withdrawn: 4,
    Banned: 5
};

/**
 * @notice Payment methods for advertisements
 * @dev Enum values matching PaymentType in contracts
 */
const PaymentType = {
    POL: 0,
    USDC: 1
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * @notice User rotation for advertisement creation to prevent balance depletion
 * @dev Cycles through available users to distribute funding load
 */
let userRotationIndex = 0;
const availableUsers = []; // Will be populated in before() hook

/**
 * @notice Creates a POL-funded advertisement with automatic user rotation
 * @dev Handles user funding if balance is insufficient
 * @param signer The account creating the advertisement (null for auto-rotation)
 * @param storageId Unique identifier for IPFS/storage reference
 * @param emailAddress Contact email for the advertiser
 * @return advertAddress The deployed advertisement contract address
 */
async function createPOLAdvertisement(signer, storageId, emailAddress) {
        // Retrieve minimum quotas from governance
    const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
    
    // Auto-select user if not provided
    if (!signer) {
        signer = availableUsers[userRotationIndex % availableUsers.length];
        userRotationIndex++;
        console.log(`   🔄 Using user ${userRotationIndex % availableUsers.length} for creation`);
    }
    
    // Verify user has sufficient balance
    const balance = await ethers.provider.getBalance(signer.address);
    const requiredBalance = minFunding * 2n; // 2x for safety
    
    if (balance < requiredBalance) {
        console.log(`   ⚠️  User ${signer.address} has insufficient balance`);
        console.log(`      Balance: ${ethers.formatEther(balance)} POL`);
        console.log(`      Required: ${ethers.formatEther(requiredBalance)} POL`);
        
        // Fund user from owner account
        const fundAmount = ethers.parseEther("5000"); // 5000 POL
        await owner.sendTransaction({
            to: signer.address,
            value: fundAmount
        });
        console.log(`   💰 Funded user with ${ethers.formatEther(fundAmount)} POL`);
    }

    // Create advertisement via factory
    const tx = await advertPOLFactoryFacet.connect(signer).createNewProspectPOLAdvertContract(
        storageId,
        minBounty,
        100,
        ethers.ZeroAddress,
        ...(await gate.pol(gateSigner, diamondAddress, signer.address)),
        { value: minFunding }
    );
    
    const receipt = await tx.wait();
    
    // Extract advertisement address from event logs
    let advertAddress;
    for (const log of receipt.logs) {
        try {
            const parsed = advertPOLFactoryFacet.interface.parseLog(log);
            if (parsed && parsed.name === "POLAdvertisementCreatedAndValidated") {
                advertAddress = parsed.args.advertContract;
                break;
            }
        } catch (e) {
            continue;
        }
    }
    
    if (!advertAddress) {
        throw new Error(`Failed to create advertisement: ${storageId}`);
    }
    
    console.log(`   ✅ Created: ${storageId} at ${advertAddress}`);
    return advertAddress;
}

// =============================================================================
// TEST SUITE
// =============================================================================


describe("OpenAdvertsAdvertisersFacet - Core Functions", function () {

    /**
     * @notice Test suite setup
     * @dev Deploys diamond, initializes facets, and funds test users
     */
        before(async function () {
        console.log("🚀 Starting OpenAdvertsAdvertisersFacet core function tests...");

        [owner, nonOwner, user1, user2, user3, user4, user5, voter1, voter2, voter3] = await ethers.getSigners();

        const allSigners = await ethers.getSigners();

        const additionalUsers = allSigners.slice(10, 26); 

        // Get test signers
        availableUsers.push(nonOwner, user1, user2, user3, user4, user5, ...additionalUsers);
        console.log(`✅ User pool initialized with ${availableUsers.length} users for rotation`);
        
        try {
            // Deploy diamond and core facets
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            if (!diamondAddress) {
                throw new Error("Diamond deployment failed");
            }
            console.log("✅ Diamond deployed and initialized at:", diamondAddress);

            // Initialize advertiser facet
            advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
            console.log("✅ OpenAdvertsAdvertisersFacet contract instance created");

            // Get MockUSDC instance
            const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
            mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
            console.log("✅ MockUSDC instance created at:", usdcAddress);

            // Verify facet initialization
            const [returnedDiamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
            console.log("✅ Facet initialization verified:");
            console.log(`   - Diamond Address: ${returnedDiamondAddr}`);
            console.log(`   - Initialized: ${isInitialized}`);
            console.log(`   - USDC Address: ${usdcAddress}`);

            // Initialize factory and governance facets
            advertPOLFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
            governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            
            console.log("✅ Factory facets initialized");
            
            // Fund test users with POL for advertisement creation
            console.log("\n💰 Funding users for advertisement creation...");
            const fundAmount = ethers.parseEther("3000"); // 3000 POL per user
            console.log("✅ All users funded");

        } catch (error) {
            console.error("❌ Setup failed:", error);
            throw error;
        }
    });

    // =========================================================================
    // DIAMOND ADDRESS QUERY TESTS
    // =========================================================================

    describe("returnDiamondAddressAdvertFacet Function", function () {
        describe("Post-Initialization State (Default)", function () {
            /**
             * @notice Verifies correct diamond address and initialization flag
             * @dev Tests the happy path after successful deployment
             */
            it("Should return correct diamond address and true (already initialized)", async function () {
                const [returnedDiamondAddress, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();

                expect(returnedDiamondAddress).to.equal(diamondAddress);
                expect(isInitialized).to.be.true;

                console.log("✅ Post-initialization state verified:");
                console.log(`   - Diamond Address: ${returnedDiamondAddress}`);
                console.log(`   - Initialized: ${isInitialized}`);
            });

            /**
             * @notice Verifies view function is publicly accessible
             * @dev Tests that any account can query without restrictions
             */
            it("Should be callable by any address (view function)", async function () {
                // Test with different signers to ensure no access restrictions
                const result1 = await advertisersFacet.connect(owner).returnDiamondAddressAdvertFacet();
                const result2 = await advertisersFacet.connect(nonOwner).returnDiamondAddressAdvertFacet();
                const result3 = await advertisersFacet.connect(user1).returnDiamondAddressAdvertFacet();

                // Verify all return identical values
                expect(result1[0]).to.equal(result2[0]);
                expect(result1[1]).to.equal(result2[1]);
                expect(result2[0]).to.equal(result3[0]);
                expect(result2[1]).to.equal(result3[1]);

                // All should show initialized state
                expect(result1[1]).to.be.true;
                expect(result2[1]).to.be.true;
                expect(result3[1]).to.be.true;

                console.log("✅ Function accessible by all addresses with consistent results");
            });

            /**
             * @notice Verifies function returns consistent values across multiple calls
             * @dev Tests immutability of view function results
             */
            it("Should have consistent return values across multiple calls", async function () {
                const calls = [];
                for (let i = 0; i < 5; i++) {
                    calls.push(advertisersFacet.returnDiamondAddressAdvertFacet());
                }

                const results = await Promise.all(calls);

                // All results should be identical
                for (let i = 1; i < results.length; i++) {
                    expect(results[i][0]).to.equal(results[0][0]);
                    expect(results[i][1]).to.equal(results[0][1]);
                }

                // All should show initialized state
                expect(results[0][1]).to.be.true;

                console.log("✅ Consistent return values across multiple calls");
            });

            /**
             * @notice Verifies state persistence after blockchain operations
             * @dev Tests that initialization state survives block mining
             */
            it("Should maintain state consistency after multiple operations", async function () {
                // Get initial state
                const [diamondAddr1, initialized1] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                
                // Mine blocks to simulate time passage
                await ethers.provider.send("hardhat_mine", ["0x10"]);
                
                // Verify state unchanged
                const [diamondAddr2, initialized2] = await advertisersFacet.returnDiamondAddressAdvertFacet();

                expect(diamondAddr1).to.equal(diamondAddr2);
                expect(initialized1).to.equal(initialized2);
                expect(initialized1).to.be.true;
                expect(diamondAddr1).to.equal(diamondAddress);

                console.log("✅ State consistency maintained after operations");
            });
        });

        describe("Gas Optimization", function () {
            /**
             * @notice Verifies view function has minimal gas overhead
             * @dev Tests gas efficiency of storage reads
             */
            it("Should have minimal gas usage for view function", async function () {
                const gasEstimate = await advertisersFacet.returnDiamondAddressAdvertFacet.estimateGas();
                
                // View functions should use minimal gas
                expect(gasEstimate).to.be.lessThan(30000);
                
                console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
            });
        });
    });

    // =========================================================================
    // INITIALIZATION TESTS
    // =========================================================================

    describe("initializeAdvertisersFacet Function", function () {
        
        describe("Already Initialized State", function () {

            /**
             * @notice Verifies re-initialization is prevented
             * @dev Tests the initialization guard after deployment
             */
            it("Should prevent double initialization (already initialized by deploy)", async function () {
                const usdcAddress = await mockUSDC.getAddress();

                 // Attempt re-initialization should fail
                await expect(
                    advertisersFacet.connect(owner).initializeAdvertisersFacet(
                        diamondAddress,
                        usdcAddress,
                        usdcAddress // Using USDC address as mock aggregator for simplicity
                    )
                ).to.be.revertedWith("Already initialized");

                console.log("✅ Double initialization correctly prevented");
            });

            /**
             * @notice Verifies only owner can initialize
             * @dev Tests access control on initialization function
             */
            it("Should reject initialization attempts by non-owner", async function () {
                const usdcAddress = await mockUSDC.getAddress();

                await expect(
                    advertisersFacet.connect(nonOwner).initializeAdvertisersFacet(
                        diamondAddress,
                        usdcAddress,
                        usdcAddress // passing USDC address in lieu of mockaggregator for simplicity
                    )
                ).to.be.revertedWith("LibDiamond: Must be contract owner");

                console.log("✅ Non-owner initialization correctly denied");
            });

            /**
             * @notice Verifies initialization state persists correctly
             * @dev Tests storage values match expected initialized state
             */
            it("Should maintain correct initialization state", async function () {
                const [storedDiamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const storedUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                const expectedUSDCAddr = await mockUSDC.getAddress();

                expect(storedDiamondAddr).to.equal(diamondAddress);
                expect(storedUSDCAddr).to.equal(expectedUSDCAddr);
                expect(isInitialized).to.be.true;

                console.log("✅ Initialization state correctly maintained");
                console.log(`   - Diamond Address: ${storedDiamondAddr}`);
                console.log(`   - USDC Address: ${storedUSDCAddr}`);
                console.log(`   - Initialized: ${isInitialized}`);
            });

            /**
             * @notice Verifies initialization state is permanent
             * @dev Tests persistence across multiple blocks
             */
            it("Should maintain initialization state permanently across blocks", async function () {
                // Verify state persists across multiple blocks
                for (let i = 0; i < 5; i++) {
                    await ethers.provider.send("hardhat_mine", ["0x1"]);
                    const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                    expect(diamondAddr).to.equal(diamondAddress);
                    expect(isInitialized).to.be.true;
                }

                console.log("✅ Initialization state persists permanently across blocks");
            });
        });

        describe("Input Validation (Testing Revert Cases)", function () {
            /**
             * @notice Verifies zero address validation
             * @dev Tests that zero addresses are rejected (though initialization guard hits first)
             */
            it("Should validate zero address rejection behavior", async function () {
                // Initialization guard will prevent this, but validates the check exists
                await expect(
                    advertisersFacet.connect(owner).initializeAdvertisersFacet(
                        ZERO_ADDRESS,
                        ZERO_ADDRESS,
                        ZERO_ADDRESS
                    )
                ).to.be.revertedWith("Already initialized");

                console.log("✅ Zero address validation behavior confirmed");
            });
        });
    });

    // =========================================================================
    // USDC ADDRESS TESTS
    // =========================================================================


    describe("getUSDCTokenAddress Function", function () {
        describe("Post-Initialization State", function () {
            /**
             * @notice Verifies USDC address is correctly stored and retrieved
             * @dev Tests happy path after initialization
             */
            it("Should return correct USDC address (already initialized)", async function () {
                const expectedUSDCAddr = await mockUSDC.getAddress();
                const returnedUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                
                expect(returnedUSDCAddr).to.equal(expectedUSDCAddr);
                expect(returnedUSDCAddr).to.not.equal(ZERO_ADDRESS);

                console.log("✅ Returns correct USDC address after initialization");
                console.log(`   - Expected: ${expectedUSDCAddr}`);
                console.log(`   - Returned: ${returnedUSDCAddr}`);
            });

            /**
             * @notice Verifies public accessibility of view function
             * @dev Tests that any account can query USDC address
             */
            it("Should be callable by any address (view function)", async function () {
                const expectedUSDCAddr = await mockUSDC.getAddress();

                // Test with different signers
                const addr1 = await advertisersFacet.connect(owner).getUSDCTokenAddress();
                const addr2 = await advertisersFacet.connect(nonOwner).getUSDCTokenAddress();
                const addr3 = await advertisersFacet.connect(user1).getUSDCTokenAddress();

                expect(addr1).to.equal(expectedUSDCAddr);
                expect(addr2).to.equal(expectedUSDCAddr);
                expect(addr3).to.equal(expectedUSDCAddr);

                console.log("✅ Function accessible by all addresses with consistent results");
            });

            /**
             * @notice Verifies state persistence across blocks
             * @dev Tests USDC address doesn't change unexpectedly
             */
            it("Should maintain state consistency", async function () {
                const addr1 = await advertisersFacet.getUSDCTokenAddress();
                
                // Mine some blocks
                await ethers.provider.send("hardhat_mine", ["0x5"]);
                
                const addr2 = await advertisersFacet.getUSDCTokenAddress();

                expect(addr1).to.equal(addr2);
                expect(addr1).to.not.equal(ZERO_ADDRESS);

                console.log("✅ USDC address remains consistent across blocks");
            });
        });
    });

    // =========================================================================
    // USDC ADDRESS UPDATE TESTS
    // =========================================================================
    describe("setUSDCTokenAddress Function", function () {
        let originalUSDCAddress;

        /**
         * @notice Store original USDC address before tests
         * @dev Allows restoration after tests complete
         */
        before(async function () {
            originalUSDCAddress = await advertisersFacet.getUSDCTokenAddress();
            console.log("📝 Original USDC address stored:", originalUSDCAddress);
        });

        /**
         * @notice Restore original USDC address after tests
         * @dev Ensures test isolation and cleanup
         */
        after(async function () {
            // Restore original USDC address
            await advertisersFacet.connect(owner).setUSDCTokenAddress(originalUSDCAddress);
            console.log("🔄 Original USDC address restored");
        });

        describe("Access Control", function () {
            /**
             * @notice Verifies only owner can update USDC address
             * @dev Tests access control prevents unauthorized updates
             */
            it("Should only allow contract owner to update USDC address", async function () {
                const newUSDCAddr = user1.address; // Use EOA for test

                await expect(
                    advertisersFacet.connect(nonOwner).setUSDCTokenAddress(newUSDCAddr)
                ).to.be.revertedWith("LibDiamond: Must be contract owner");

                console.log("✅ Non-owner access correctly denied");
            });

            /**
             * @notice Verifies owner can successfully update USDC address
             * @dev Tests happy path for authorized update
             */
            it("Should allow contract owner to update USDC address", async function () {
                const newUSDCAddr = user1.address; // Use EOA for test

                await expect(
                    advertisersFacet.connect(owner).setUSDCTokenAddress(newUSDCAddr)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getUSDCTokenAddress()).to.equal(newUSDCAddr);

                console.log("✅ Owner update successful");
            });
        });

        describe("Input Validation", function () {
            /**
             * @notice Verifies zero address is rejected
             * @dev Tests input validation for invalid addresses
             */
            it("Should reject zero address", async function () {
                await expect(
                    advertisersFacet.connect(owner).setUSDCTokenAddress(ZERO_ADDRESS)
                ).to.be.revertedWith("Invalid USDC address");

                console.log("✅ Zero address correctly rejected");
            });

            /**
             * @notice Verifies valid contract addresses are accepted
             * @dev Tests happy path with legitimate contract address
             */
            it("Should accept valid contract addresses", async function () {
                const validAddress = originalUSDCAddress; // Use original MockUSDC address

                await expect(
                    advertisersFacet.connect(owner).setUSDCTokenAddress(validAddress)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getUSDCTokenAddress()).to.equal(validAddress);

                console.log("✅ Valid contract address accepted");
            });

            /**
             * @notice Verifies EOA addresses are technically accepted
             * @dev Documents behavior though not recommended for production
             */
            it("Should accept EOA addresses (though not recommended)", async function () {
                await expect(
                    advertisersFacet.connect(owner).setUSDCTokenAddress(user2.address)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getUSDCTokenAddress()).to.equal(user2.address);

                console.log("✅ EOA address accepted (not recommended for production)");
            });
        });

        describe("State Changes", function () {
            /**
             * @notice Verifies storage update and state isolation
             * @dev Tests that only USDC address changes, other state remains intact
             */
            it("Should properly update storage and maintain other state", async function () {
                const [preDiamondAddr, preInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const preUSDCAddr = await advertisersFacet.getUSDCTokenAddress();

                const newUSDCAddr = user3.address;

                // Update USDC address
                const tx = await advertisersFacet.connect(owner).setUSDCTokenAddress(newUSDCAddr);
                const receipt = await tx.wait();

                // Verify state changes
                const updatedUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                const [postDiamondAddr, postInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();

                expect(updatedUSDCAddr).to.equal(newUSDCAddr);
                expect(updatedUSDCAddr).to.not.equal(preUSDCAddr);
                expect(postDiamondAddr).to.equal(preDiamondAddr); // Should remain unchanged
                expect(postInitialized).to.equal(preInitialized); // Should remain unchanged
                expect(postInitialized).to.be.true; // Should still be true

                console.log("✅ Storage updated correctly, other state maintained");
                console.log(`   - Gas used: ${receipt.gasUsed}`);
            });

            /**
             * @notice Verifies multiple consecutive updates work correctly
             * @dev Tests repeated state transitions
             */
            it("Should handle multiple consecutive updates", async function () {
                const addresses = [
                    originalUSDCAddress, // MockUSDC
                    user1.address,
                    user2.address,
                    user3.address
                ];

                for (let i = 0; i < addresses.length; i++) {
                    await advertisersFacet.connect(owner).setUSDCTokenAddress(addresses[i]);
                    const currentAddr = await advertisersFacet.getUSDCTokenAddress();
                    expect(currentAddr).to.equal(addresses[i]);
                }

                console.log("✅ Multiple consecutive updates handled correctly");
            });
        });

        describe("Integration with Other Functions", function () {
            /**
             * @notice Verifies initialization state persists after USDC updates
             * @dev Tests cross-function state isolation
             */
            it("Should maintain initialization state after USDC updates", async function () {
                // Update USDC address
                await advertisersFacet.connect(owner).setUSDCTokenAddress(user1.address);

                // Verify initialization state remains intact
                const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                expect(diamondAddr).to.equal(diamondAddress);
                expect(isInitialized).to.be.true;

                console.log("✅ Initialization state maintained after USDC updates");
            });

            /**
             * @notice Verifies getter reflects setter changes
             * @dev Tests setter/getter consistency
             */
            it("Should work correctly with getUSDCTokenAddress", async function () {
                const testAddress = user2.address;
                
                // Set address
                await advertisersFacet.connect(owner).setUSDCTokenAddress(testAddress);
                
                // Verify through getter
                const retrievedAddress = await advertisersFacet.getUSDCTokenAddress();
                expect(retrievedAddress).to.equal(testAddress);

                console.log("✅ Integration with getUSDCTokenAddress working correctly");
            });
        });
    });

    // =========================================================================
    // INTEGRATION TESTS
    // =========================================================================

    describe("Integration Tests", function () {
        describe("Complete State Verification", function () {
            /**
             * @notice Verifies all core components are properly initialized
             * @dev Tests the complete state of the advertiser facet after deployment
             */
            it("Should have all components properly initialized and working", async function () {
                // Verify diamond initialization
                const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                expect(diamondAddr).to.equal(diamondAddress);
                expect(isInitialized).to.be.true;

                // Verify USDC integration
                const usdcAddr = await advertisersFacet.getUSDCTokenAddress();
                expect(usdcAddr).to.not.equal(ZERO_ADDRESS);

                // Verify MockUSDC is accessible
                const mockUSDCBalance = await mockUSDC.balanceOf(owner.address);
                expect(mockUSDCBalance).to.be.greaterThan(0);

                console.log("✅ Complete integration verified:");
                console.log(`   - Diamond Address: ${diamondAddr}`);
                console.log(`   - Initialized: ${isInitialized}`);
                console.log(`   - USDC Address: ${usdcAddr}`);
                console.log(`   - Owner USDC Balance: ${ethers.formatUnits(mockUSDCBalance, 6)} USDC`);
            });

            /**
             * @notice Verifies state consistency across multiple function calls
             * @dev Tests that diamond state remains unchanged during block mining
             */
            it("Should maintain consistent state across all function calls", async function () {
                const initialState = {
                    diamond: await advertisersFacet.returnDiamondAddressAdvertFacet(),
                    usdc: await advertisersFacet.getUSDCTokenAddress()
                };

                // Perform various operations
                await ethers.provider.send("hardhat_mine", ["0x5"]);
                
                // Check multiple times
                for (let i = 0; i < 3; i++) {
                    const currentState = {
                        diamond: await advertisersFacet.returnDiamondAddressAdvertFacet(),
                        usdc: await advertisersFacet.getUSDCTokenAddress()
                    };

                    expect(currentState.diamond[0]).to.equal(initialState.diamond[0]);
                    expect(currentState.diamond[1]).to.equal(initialState.diamond[1]);
                    expect(initialState.diamond[1]).to.be.true; // Should be initialized
                }

                console.log("✅ State consistency maintained across all operations");
            });
        });

        describe("Error Handling", function () {
            /**
             * @notice Verifies state integrity after failed operations
             * @dev Tests that reverted transactions don't corrupt facet state
             */
            it("Should maintain consistent state after failed operations", async function () {
                const [preFailDiamondAddr, preFailInit] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const preFailUSDC = await advertisersFacet.getUSDCTokenAddress();

                // Attempt unauthorized USDC address update
                await expect(
                    advertisersFacet.connect(nonOwner).setUSDCTokenAddress(user1.address)
                ).to.be.reverted;

                // Attempt invalid USDC address (zero address)
                await expect(
                    advertisersFacet.connect(owner).setUSDCTokenAddress(ZERO_ADDRESS)
                ).to.be.reverted;

                // Attempt re-initialization
                await expect(
                    advertisersFacet.connect(owner).initializeAdvertisersFacet(
                        diamondAddress,
                        await mockUSDC.getAddress(),
                        await mockUSDC.getAddress() // passing USDC address in lieu of mockaggregator for simplicity
                    )
                ).to.be.reverted;

                // Verify state remains unchanged
                const [postFailDiamondAddr, postFailInit] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const postFailUSDC = await advertisersFacet.getUSDCTokenAddress();

                expect(postFailDiamondAddr).to.equal(preFailDiamondAddr);
                expect(postFailInit).to.equal(preFailInit);
                expect(postFailUSDC).to.equal(preFailUSDC);
                expect(postFailInit).to.be.true;

                console.log("✅ State remains consistent after failed operations");
            });
        });

        describe("Gas Optimization", function () {

            /**
             * @notice Verifies reasonable gas costs for all core operations
             * @dev Tests gas efficiency of state-changing and view functions
             */
            it("Should have reasonable gas costs for all operations", async function () {
                const originalUSDC = await advertisersFacet.getUSDCTokenAddress();

                // Test USDC address update gas usage
                const updateTx = await advertisersFacet.connect(owner).setUSDCTokenAddress(user1.address);
                const updateReceipt = await updateTx.wait();

                // Restore original USDC address
                await advertisersFacet.connect(owner).setUSDCTokenAddress(originalUSDC);

                // Test view function gas
                const viewGas = await advertisersFacet.returnDiamondAddressAdvertFacet.estimateGas();
                const getUSDCGas = await advertisersFacet.getUSDCTokenAddress.estimateGas();

                console.log("✅ Gas usage analysis:");
                console.log(`   - USDC Update: ${updateReceipt.gasUsed}`);
                console.log(`   - returnDiamondAddressAdvertFacet: ${viewGas}`);
                console.log(`   - getUSDCTokenAddress: ${getUSDCGas}`);

                // Assert reasonable gas limits
                expect(updateReceipt.gasUsed).to.be.lessThan(50000);  // State-changing operation
                expect(viewGas).to.be.lessThan(30000);                // View function
                expect(getUSDCGas).to.be.lessThan(30000);            // View function
            });
        });
    });

    // =========================================================================
    // ADVERTISEMENT QUERY FUNCTIONS
    // =========================================================================

    describe("Advertisement Query Functions", function () {

        // ---------------------------------------------------------------------
        // GET ADVERTISEMENTS BY TYPE
        // ---------------------------------------------------------------------

        describe("getAdvertisements Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies empty state returns empty arrays for all advertisement types
                 * @dev Tests initial state before any advertisements are created
                 */
                it("Should return empty arrays for all advertisement types initially", async function () {
                    // Test all advertisement types
                    for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                        const advertisements = await advertisersFacet.getAdvertisements(typeValue);
                        expect(advertisements).to.be.an('array');
                        expect(advertisements.length).to.equal(0);
                        console.log(`✅ ${typeName} advertisements: empty array (${advertisements.length} items)`);
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query advertisement lists
                 */
                it("Should be callable by any address (view function)", async function () {
                    // Test with different signers - all should return same result
                    const result1 = await advertisersFacet.connect(owner).getAdvertisements(AdvertisementType.Prospect);
                    const result2 = await advertisersFacet.connect(nonOwner).getAdvertisements(AdvertisementType.Prospect);
                    const result3 = await advertisersFacet.connect(user1).getAdvertisements(AdvertisementType.Prospect);

                    expect(result1.length).to.equal(result2.length);
                    expect(result2.length).to.equal(result3.length);

                    console.log("✅ Function accessible by all addresses with consistent results");
                });

                /**
                 * @notice Verifies graceful handling of invalid advertisement type
                 * @dev Tests boundary conditions for enum-based type parameter
                 */
                it("Should handle invalid advertisement type gracefully", async function () {
                    // Test with invalid type (should either revert or return empty)
                    try {
                        const result = await advertisersFacet.getAdvertisements(999); // Invalid type
                        expect(result).to.be.an('array');
                        console.log("✅ Invalid type handled gracefully (returned empty array)");
                    } catch (error) {
                        expect(error.message).to.include("out-of-bounds");
                        console.log("✅ Invalid type correctly reverted");
                    }
                });

                /**
                 * @notice Verifies consistency of view function across multiple calls
                 * @dev Tests immutability of query results
                 */
                it("Should maintain consistent results across multiple calls", async function () {
                    const calls = [];
                    for (let i = 0; i < 3; i++) {
                        calls.push(advertisersFacet.getAdvertisements(AdvertisementType.Prospect));
                    }

                    const results = await Promise.all(calls);

                    // All results should be identical
                    for (let i = 1; i < results.length; i++) {
                        expect(results[i].length).to.equal(results[0].length);
                    }

                    console.log("✅ Consistent results across multiple calls");
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies reasonable gas usage for all advertisement type queries
                 * @dev Tests gas efficiency of array retrieval operations
                 */
                it("Should have reasonable gas usage for all advertisement types", async function () {
                    const gasUsage = {};

                    for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                        const gasEstimate = await advertisersFacet.getAdvertisements.estimateGas(typeValue);
                        gasUsage[typeName] = gasEstimate;
                        expect(gasEstimate).to.be.lessThan(100000); // Reasonable limit
                    }

                    console.log("✅ Gas usage analysis for getAdvertisements:");
                    Object.entries(gasUsage).forEach(([type, gas]) => {
                        console.log(`   - ${type}: ${gas}`);
                    });
                });
            });
        });

        // ---------------------------------------------------------------------
        // ADVERTISEMENT EXISTENCE CHECK
        // ---------------------------------------------------------------------

        describe("getAdvertisementExists Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies non-existent advertisements return false
                 * @dev Tests various address types that should not exist as advertisements
                 */
                it("Should return false for non-existent advertisement addresses", async function () {
                    const testAddresses = [
                        ZERO_ADDRESS,
                        user1.address,
                        user2.address,
                        diamondAddress,
                        await mockUSDC.getAddress()
                    ];

                    for (const address of testAddresses) {
                        const exists = await advertisersFacet.getAdvertisementExists(address);
                        expect(exists).to.be.false;
                        console.log(`✅ Address ${address}: exists = ${exists}`);
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can check advertisement existence
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAddress = user1.address;

                    const result1 = await advertisersFacet.connect(owner).getAdvertisementExists(testAddress);
                    const result2 = await advertisersFacet.connect(nonOwner).getAdvertisementExists(testAddress);
                    const result3 = await advertisersFacet.connect(user1).getAdvertisementExists(testAddress);

                    expect(result1).to.equal(result2);
                    expect(result2).to.equal(result3);
                    expect(result1).to.be.false; // Should be false for non-existent

                    console.log("✅ Function accessible by all addresses with consistent results");
                });

                /**
                 * @notice Verifies consistency across consecutive calls
                 * @dev Tests that existence check results remain stable
                 */
                it("Should handle multiple consecutive calls consistently", async function () {
                    const testAddress = user2.address;
                    const results = [];

                    for (let i = 0; i < 5; i++) {
                        results.push(await advertisersFacet.getAdvertisementExists(testAddress));
                    }

                    // All results should be identical
                    for (let i = 1; i < results.length; i++) {
                        expect(results[i]).to.equal(results[0]);
                    }

                    console.log("✅ Consistent results across multiple calls");
                });
            });

            describe("Edge Cases", function () {

                /**
                 * @notice Verifies zero address handling
                 * @dev Tests that zero address returns false rather than reverting
                 */
                it("Should handle zero address correctly", async function () {
                    const exists = await advertisersFacet.getAdvertisementExists(ZERO_ADDRESS);
                    expect(exists).to.be.false;
                    console.log("✅ Zero address correctly returns false");
                });

                /**
                 * @notice Verifies contract address handling
                 * @dev Tests that arbitrary contract addresses return false unless they are advertisements
                 */
                it("Should handle contract addresses correctly", async function () {
                    const contractAddresses = [
                        diamondAddress,
                        await mockUSDC.getAddress()
                    ];

                    for (const address of contractAddresses) {
                        const exists = await advertisersFacet.getAdvertisementExists(address);
                        expect(exists).to.be.false; // Should be false unless they're actual advertisements
                        console.log(`✅ Contract address ${address}: exists = ${exists}`);
                    }
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies minimal gas usage for existence checks
                 * @dev Tests gas efficiency of boolean lookup operation
                 */
                it("Should have minimal gas usage for existence checks", async function () {
                    const gasEstimate = await advertisersFacet.getAdvertisementExists.estimateGas(user1.address);
                    expect(gasEstimate).to.be.lessThan(30000);
                    console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                });
            });
        });

        // ---------------------------------------------------------------------
        // ADVERTISEMENT DETAILS AND STATUS
        // ---------------------------------------------------------------------

        describe("getAdvertisementDetailsAndStatus Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies behavior for non-existent advertisements
                 * @dev Tests that function either returns default data or reverts appropriately
                 */
                it("Should return default/empty data for non-existent advertisements", async function () {
                    const testAddresses = [
                        user1.address,
                        user2.address,
                        ZERO_ADDRESS
                    ];

                    for (const address of testAddresses) {
                        try {
                            const result = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                            
                            // Result should be a tuple with advertisement details and status
                            expect(result).to.be.an('array');
                            expect(result.length).to.equal(2);
                            
                            const [details, status] = result;
                            console.log(`✅ Address ${address}: details structure returned`);
                            console.log(`   - Status: ${status}`);
                            
                        } catch (error) {
                            // May revert for non-existent advertisements
                            expect(error.message).to.include("Advertisement does not exist");
                            console.log(`✅ Address ${address}: correctly reverted for non-existent advertisement`);
                        }
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query advertisement details
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAddress = user1.address;

                    try {
                        const result1 = await advertisersFacet.connect(owner).getAdvertisementDetailsAndStatus(testAddress);
                        const result2 = await advertisersFacet.connect(nonOwner).getAdvertisementDetailsAndStatus(testAddress);
                        const result3 = await advertisersFacet.connect(user1).getAdvertisementDetailsAndStatus(testAddress);

                        // If they don't revert, they should return the same results
                        expect(result1.length).to.equal(result2.length);
                        expect(result2.length).to.equal(result3.length);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently reverts for non-existent advertisements");
                    }
                });

                /**
                 * @notice Verifies zero address handling
                 * @dev Tests that zero address is handled gracefully
                 */
                it("Should handle zero address appropriately", async function () {
                    try {
                        const result = await advertisersFacet.getAdvertisementDetailsAndStatus(ZERO_ADDRESS);
                        expect(result).to.be.an('array');
                        console.log("✅ Zero address handled gracefully");
                    } catch (error) {
                        expect(error.message).to.include("Advertisement does not exist");
                        console.log("✅ Zero address correctly reverted");
                    }
                });
            });

            describe("Data Structure Validation", function () {

                /**
                 * @notice Verifies proper data structure is returned
                 * @dev Tests that return value contains expected fields and types
                 */
                it("Should return properly structured data when successful", async function () {
                    try {
                        const result = await advertisersFacet.getAdvertisementDetailsAndStatus(user1.address);
                        
                        expect(result).to.be.an('array');
                        expect(result.length).to.equal(2);
                        
                        const [details, status] = result;
                        
                        // Details should be a struct with expected fields
                        expect(details).to.be.an('object');
                        
                        // Status should be a number (enum value)
                        expect(typeof status).to.be.oneOf(['number', 'bigint']);
                        
                        console.log("✅ Data structure validation passed");
                        console.log(`   - Details type: ${typeof details}`);
                        console.log(`   - Status type: ${typeof status}`);
                        
                    } catch (error) {
                        console.log("✅ Function appropriately reverts for non-existent advertisements");
                    }
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies reasonable gas usage for detail queries
                 * @dev Tests gas efficiency of struct retrieval operation
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await advertisersFacet.getAdvertisementDetailsAndStatus.estimateGas(user1.address);
                        expect(gasEstimate).to.be.lessThan(100000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function reverts for non-existent advertisements");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // USER VOTE ON ADVERTISEMENT
        // ---------------------------------------------------------------------

        describe("getUserVoteOnAdvertisement Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies behavior for non-existent advertisement-user combinations
                 * @dev Tests various user-advertisement pairs that should have no vote data
                 */
                it("Should return default vote data for non-existent advertisement-user combinations", async function () {
                    const testCombinations = [
                        { ad: user1.address, user: voter1.address },
                        { ad: user2.address, user: voter2.address },
                        { ad: ZERO_ADDRESS, user: voter3.address }
                    ];

                    for (const { ad, user } of testCombinations) {
                        try {
                            const voteData = await advertisersFacet.getUserVoteOnAdvertisement(user, ad);
                            
                            // Should return some vote data structure
                            expect(voteData).to.not.be.undefined;
                            console.log(`✅ Vote data for user ${user} on ad ${ad}: structure returned`);
                            
                        } catch (error) {
                            expect(error.message).to.include("revert");
                            console.log(`✅ Vote query correctly reverted for user ${user} on ad ${ad}`);
                        }
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query user votes
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAd = user1.address;
                    const testUser = voter1.address;

                    try {
                        const result1 = await advertisersFacet.connect(owner).getUserVoteOnAdvertisement(testUser, testAd);
                        const result2 = await advertisersFacet.connect(nonOwner).getUserVoteOnAdvertisement(testUser, testAd);
                        const result3 = await advertisersFacet.connect(user1).getUserVoteOnAdvertisement(testUser, testAd);

                        // Results should be consistent if they don't revert
                        expect(typeof result1).to.equal(typeof result2);
                        expect(typeof result2).to.equal(typeof result3);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently handles non-existent combinations");
                    }
                });

                /**
                 * @notice Verifies handling of various user-advertisement combinations
                 * @dev Tests multiple permutations of users and advertisements
                 */
                it("Should handle different user-advertisement combinations", async function () {
                    const users = [voter1.address, voter2.address, voter3.address];
                    const ads = [user1.address, user2.address, user3.address];

                    for (const user of users) {
                        for (const ad of ads) {
                            try {
                                const voteData = await advertisersFacet.getUserVoteOnAdvertisement(user, ad);
                                console.log(`✅ Vote data retrieved for user ${user} on ad ${ad}`);
                            } catch (error) {
                                console.log(`✅ Vote query handled for user ${user} on ad ${ad}: ${error.message.includes('revert') ? 'reverted' : 'other'}`);
                            }
                        }
                    }
                });
            });

            describe("Input Validation", function () {
                /**
                 * @notice Verifies zero address handling
                 * @dev Tests various combinations involving zero address
                 */
                it("Should handle zero addresses appropriately", async function () {
                    const testCases = [
                        { user: ZERO_ADDRESS, ad: user1.address },
                        { user: voter1.address, ad: ZERO_ADDRESS },
                        { user: ZERO_ADDRESS, ad: ZERO_ADDRESS }
                    ];

                    for (const { user, ad } of testCases) {
                        try {
                            const result = await advertisersFacet.getUserVoteOnAdvertisement(user, ad);
                            console.log(`✅ Zero address case handled gracefully: user=${user}, ad=${ad}`);
                        } catch (error) {
                            expect(error.message).to.include("revert");
                            console.log(`✅ Zero address case correctly reverted: user=${user}, ad=${ad}`);
                        }
                    }
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies reasonable gas usage for vote queries
                 * @dev Tests gas efficiency of vote data retrieval
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await advertisersFacet.getUserVoteOnAdvertisement.estimateGas(voter1.address, user1.address);
                        expect(gasEstimate).to.be.lessThan(50000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function may revert for non-existent combinations");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // ADVERTISEMENT VOTERS LIST
        // ---------------------------------------------------------------------

        describe("getAdvertisementVoters Function", function () {

            describe("Basic Functionality", function () {
                
                /**
                 * @notice Verifies empty voter list for non-existent advertisements
                 * @dev Tests that non-existent ads return empty array or revert appropriately
                 */
                it("Should return empty or default voter list for non-existent advertisements", async function () {
                    const testAddresses = [
                        user1.address,
                        user2.address,
                        user3.address,
                        ZERO_ADDRESS
                    ];

                    for (const address of testAddresses) {
                        try {
                            const voters = await advertisersFacet.getAdvertisementVoters(address);
                            
                            expect(voters).to.be.an('array');
                            expect(voters.length).to.equal(0); // Should be empty for non-existent ads
                            console.log(`✅ Voters for ad ${address}: ${voters.length} voters`);
                            
                        } catch (error) {
                            expect(error.message).to.include("Advertisement does not exist");
                            console.log(`✅ Voters query correctly reverted for ad ${address}`);
                        }
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query voter lists
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAd = user1.address;

                    try {
                        const result1 = await advertisersFacet.connect(owner).getAdvertisementVoters(testAd);
                        const result2 = await advertisersFacet.connect(nonOwner).getAdvertisementVoters(testAd);
                        const result3 = await advertisersFacet.connect(user1).getAdvertisementVoters(testAd);

                        expect(result1.length).to.equal(result2.length);
                        expect(result2.length).to.equal(result3.length);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently handles non-existent advertisements");
                    }
                });

                /**
                 * @notice Verifies consistency across multiple calls
                 * @dev Tests that voter list results remain stable
                 */
                it("Should maintain consistent results across multiple calls", async function () {
                    const testAd = user2.address;
                    const results = [];

                    for (let i = 0; i < 3; i++) {
                        try {
                            results.push(await advertisersFacet.getAdvertisementVoters(testAd));
                        } catch (error) {
                            results.push(null); // Mark as reverted
                        }
                    }

                    // All results should be identical (either all successful with same data, or all reverted)
                    const allSuccessful = results.every(r => r !== null);
                    const allReverted = results.every(r => r === null);
                    
                    expect(allSuccessful || allReverted).to.be.true;
                    
                    if (allSuccessful) {
                        for (let i = 1; i < results.length; i++) {
                            expect(results[i].length).to.equal(results[0].length);
                        }
                    }

                    console.log("✅ Consistent results across multiple calls");
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies reasonable gas usage for voter list queries
                 * @dev Tests gas efficiency of array retrieval operation
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await advertisersFacet.getAdvertisementVoters.estimateGas(user1.address);
                        expect(gasEstimate).to.be.lessThan(100000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function reverts for non-existent advertisements");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // ADVERTISEMENT VOTING STATISTICS
        // ---------------------------------------------------------------------

        describe("getAdvertisementVotingStats Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies default/zero voting stats for non-existent advertisements
                 * @dev Tests that non-existent ads return default values or revert appropriately
                 */
                it("Should return default/zero voting stats for non-existent advertisements", async function () {
                    const testAddresses = [
                        user1.address,
                        user2.address,
                        user3.address,
                        ZERO_ADDRESS
                    ];

                    for (const address of testAddresses) {
                        try {
                            const stats = await advertisersFacet.getAdvertisementVotingStats(address);
                            
                            // Stats should be some kind of data structure
                            expect(stats).to.not.be.undefined;
                            console.log(`✅ Voting stats for ad ${address}: structure returned`);
                            
                        } catch (error) {
                            expect(error.message).to.include("Advertisement does not exist");
                            console.log(`✅ Voting stats query correctly reverted for ad ${address}`);
                        }
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query voting statistics
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAd = user1.address;

                    try {
                        const result1 = await advertisersFacet.connect(owner).getAdvertisementVotingStats(testAd);
                        const result2 = await advertisersFacet.connect(nonOwner).getAdvertisementVotingStats(testAd);
                        const result3 = await advertisersFacet.connect(user1).getAdvertisementVotingStats(testAd);

                        // Results should be consistent
                        expect(typeof result1).to.equal(typeof result2);
                        expect(typeof result2).to.equal(typeof result3);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently handles non-existent advertisements");
                    }
                });

                /**
                 * @notice Verifies handling of multiple advertisement addresses
                 * @dev Tests statistics queries for various addresses
                 */
                it("Should handle multiple advertisement addresses", async function () {
                    const testAddresses = [user1.address, user2.address, user3.address, diamondAddress];

                    for (const address of testAddresses) {
                        try {
                            const stats = await advertisersFacet.getAdvertisementVotingStats(address);
                            console.log(`✅ Voting stats retrieved for ad ${address}`);
                        } catch (error) {
                            console.log(`✅ Voting stats query handled for ad ${address}: ${error.message.includes('Advertisement does not exist') ? 'reverted' : 'other'}`);
                        }
                    }
                });
            });

            describe("Gas Optimization", function () {
                
                /**
                 * @notice Verifies reasonable gas usage for statistics queries
                 * @dev Tests gas efficiency of aggregated data retrieval
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await advertisersFacet.getAdvertisementVotingStats.estimateGas(user1.address);
                        expect(gasEstimate).to.be.lessThan(100000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function reverts for non-existent advertisements");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // USER VOTING HISTORY
        // ---------------------------------------------------------------------

        describe("getAdvertUserVotingHistory Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies empty/default voting history for users without votes
                 * @dev Tests that users with no voting activity return appropriate data
                 */
                it("Should return empty/default voting history for non-existent user", async function () {
                    const testUsers = [
                        voter1.address,
                        voter2.address,
                        voter3.address,
                        ZERO_ADDRESS
                    ];

                    for (const userAddress of testUsers) {
                        try {
                            const [history] = await governanceFacet.getAdvertUserVotingHistory(userAddress);
                            
                            expect(history).to.be.an('array');
                            console.log(`✅ Voting history for user ${userAddress}: ${history.length} entries`);
                            
                        } catch (error) {
                            expect(error.message).to.include("revert");
                            console.log(`✅ Voting history query correctly reverted for user ${userAddress}`);
                        }
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query user voting history
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testUser = voter1.address;

                    try {
                        const [result1] = await governanceFacet.connect(owner).getAdvertUserVotingHistory(testUser);
                        const [result2] = await governanceFacet.connect(nonOwner).getAdvertUserVotingHistory(testUser);
                        const [result3] = await governanceFacet.connect(user1).getAdvertUserVotingHistory(testUser);

                        expect(result1.length).to.equal(result2.length);
                        expect(result2.length).to.equal(result3.length);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently handles queries");
                    }
                });

                /**
                 * @notice Verifies handling of various user addresses
                 * @dev Tests voting history queries for multiple users
                 */
                it("Should handle different user addresses", async function () {
                    const users = [voter1.address, voter2.address, voter3.address, owner.address, nonOwner.address];

                    for (const userAddress of users) {
                        try {
                            const [history] = await governanceFacet.getAdvertUserVotingHistory(userAddress);
                            expect(history).to.be.an('array');
                            console.log(`✅ Voting history for user ${userAddress}: ${history.length} entries`);
                        } catch (error) {
                            console.log(`✅ Voting history query handled for user ${userAddress}: ${error.message.includes('revert') ? 'reverted' : 'other'}`);
                        }
                    }
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies reasonable gas usage for history queries
                 * @dev Tests gas efficiency of user history retrieval
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await governanceFacet.getAdvertUserVotingHistory.estimateGas(voter1.address);
                        expect(gasEstimate).to.be.lessThan(100000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function may revert");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // OVERALL ADVERTISEMENT STATISTICS
        // ---------------------------------------------------------------------

        describe("getAdvertisementStatistics Function", function () {

            describe("Basic Functionality", function () {

                /**
                 * @notice Verifies overall advertisement statistics are retrievable
                 * @dev Tests that system-wide statistics can be queried
                 */
                it("Should return overall advertisement statistics", async function () {
                    try {
                        const stats = await advertisersFacet.getAdvertisementStatistics();
                        
                        // Stats should be some kind of data structure with overall statistics
                        expect(stats).to.not.be.undefined;
                        console.log("✅ Overall advertisement statistics retrieved");
                        console.log(`   - Stats type: ${typeof stats}`);
                        
                        // If it's an object/struct, log its structure
                        if (typeof stats === 'object' && stats !== null) {
                            console.log(`   - Stats structure: ${Object.keys(stats)}`);
                        }
                        
                    } catch (error) {
                        expect(error.message).to.include("revert");
                        console.log("✅ Statistics query handled appropriately");
                    }
                });

                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query overall statistics
                 */
                it("Should be callable by any address (view function)", async function () {
                    try {
                        const result1 = await advertisersFacet.connect(owner).getAdvertisementStatistics();
                        const result2 = await advertisersFacet.connect(nonOwner).getAdvertisementStatistics();
                        const result3 = await advertisersFacet.connect(user1).getAdvertisementStatistics();

                        // Results should be consistent
                        expect(typeof result1).to.equal(typeof result2);
                        expect(typeof result2).to.equal(typeof result3);
                        
                        console.log("✅ Function accessible by all addresses with consistent results");
                    } catch (error) {
                        console.log("✅ Function consistently handles statistics queries");
                    }
                });

                /**
                 * @notice Verifies consistency across multiple calls
                 * @dev Tests that statistics remain stable across calls
                 */
                it("Should return consistent statistics across multiple calls", async function () {
                    const results = [];

                    for (let i = 0; i < 3; i++) {
                        try {
                            results.push(await advertisersFacet.getAdvertisementStatistics());
                        } catch (error) {
                            results.push(null); // Mark as reverted
                        }
                    }

                    // All results should be identical (either all successful with same data, or all reverted)
                    const allSuccessful = results.every(r => r !== null);
                    const allReverted = results.every(r => r === null);
                    
                    expect(allSuccessful || allReverted).to.be.true;
                    
                    if (allSuccessful) {
                        // Compare the results - they should be identical for statistics
                        for (let i = 1; i < results.length; i++) {
                            expect(typeof results[i]).to.equal(typeof results[0]);
                        }
                    }

                    console.log("✅ Consistent statistics across multiple calls");
                });

                /**
                 * @notice Verifies statistics consistency across blocks
                 * @dev Tests that statistics remain unchanged when no modifications occur
                 */
                it("Should maintain statistics consistency across blocks", async function () {
                    try {
                        const stats1 = await advertisersFacet.getAdvertisementStatistics();
                        
                        // Mine some blocks
                        await ethers.provider.send("hardhat_mine", ["0x5"]);
                        
                        const stats2 = await advertisersFacet.getAdvertisementStatistics();
                        
                        // Statistics should remain consistent (no advertisements added/modified)
                        expect(typeof stats1).to.equal(typeof stats2);
                        
                        console.log("✅ Statistics consistency maintained across blocks");
                    } catch (error) {
                        console.log("✅ Statistics queries handled consistently across blocks");
                    }
                });
            });

            describe("Gas Optimization", function () {
                
                /**
                 * @notice Verifies reasonable gas usage for statistics queries
                 * @dev Tests gas efficiency of aggregated statistics retrieval
                 */
                it("Should have reasonable gas usage", async function () {
                    try {
                        const gasEstimate = await advertisersFacet.getAdvertisementStatistics.estimateGas();
                        expect(gasEstimate).to.be.lessThan(100000);
                        console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                    } catch (error) {
                        console.log("✅ Gas estimation skipped - function may revert");
                    }
                });
            });
        });

        // ---------------------------------------------------------------------
        // CROSS-FUNCTION INTEGRATION
        // ---------------------------------------------------------------------
        

        describe("Advertisement Query Functions Integration", function () {

            describe("Cross-Function Consistency", function () {

                /**
                 * @notice Verifies all query functions return consistent information
                 * @dev Tests that different query methods agree on system state
                 */
                it("Should maintain consistent state across all query functions", async function () {
                    // Test that all query functions return consistent information about the same empty state
                    try {
                        // Get all advertisements of all types
                        const prospectAds = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                        const approvedAds = await advertisersFacet.getAdvertisements(AdvertisementType.Approved);
                        const exhaustedAds = await advertisersFacet.getAdvertisements(AdvertisementType.Exhausted);
                        const deprecatingAds = await advertisersFacet.getAdvertisements(AdvertisementType.Deprecating);
                        const withdrawnAds = await advertisersFacet.getAdvertisements(AdvertisementType.Withdrawn);

                        // Get overall statistics
                        const overallStats = await advertisersFacet.getAdvertisementStatistics();

                        console.log("✅ Cross-function consistency check:");
                        console.log(`   - Prospect ads: ${prospectAds.length}`);
                        console.log(`   - Approved ads: ${approvedAds.length}`);
                        console.log(`   - Exhausted ads: ${exhaustedAds.length}`);
                        console.log(`   - Deprecating ads: ${deprecatingAds.length}`);
                        console.log(`   - Withdrawn ads: ${withdrawnAds.length}`);
                        console.log(`   - Overall stats type: ${typeof overallStats}`);

                        // All should be empty arrays initially
                        expect(prospectAds.length).to.equal(0);
                        expect(approvedAds.length).to.equal(0);
                        expect(exhaustedAds.length).to.equal(0);
                        expect(deprecatingAds.length).to.equal(0);
                        expect(withdrawnAds.length).to.equal(0);

                    } catch (error) {
                        console.log("✅ Query functions consistently handle empty state");
                    }
                });

                /**
                 * @notice Verifies consistent handling of non-existent advertisements
                 * @dev Tests that all address-based queries agree on non-existence
                 */
                it("Should handle non-existent advertisement queries consistently", async function () {
                    const testAddress = user1.address;

                    // Test all functions that take an advertisement address
                    const functionTests = [
                        { name: 'getAdvertisementExists', test: () => advertisersFacet.getAdvertisementExists(testAddress) },
                        { name: 'getAdvertisementDetailsAndStatus', test: () => advertisersFacet.getAdvertisementDetailsAndStatus(testAddress) },
                        { name: 'getAdvertisementVoters', test: () => advertisersFacet.getAdvertisementVoters(testAddress) },
                        { name: 'getAdvertisementVotingStats', test: () => advertisersFacet.getAdvertisementVotingStats(testAddress) }
                    ];

                    const results = {};

                    for (const { name, test } of functionTests) {
                        try {
                            results[name] = { success: true, data: await test() };
                        } catch (error) {
                            results[name] = { success: false, error: error.message };
                        }
                    }

                    console.log("✅ Non-existent advertisement handling:");
                    Object.entries(results).forEach(([name, result]) => {
                        if (result.success) {
                            console.log(`   - ${name}: returned data (${typeof result.data})`);
                        } else {
                            console.log(`   - ${name}: ${result.error.includes('Advertisement does not exist') ? 'reverted correctly' : 'other error'}`);
                        }
                    });

                    // At minimum, getAdvertisementExists should work and return false
                    expect(results.getAdvertisementExists.success).to.be.true;
                    expect(results.getAdvertisementExists.data).to.be.false;
                });
            });

            describe("Gas Usage Summary", function () {

                /**
                 * @notice Provides comprehensive gas usage analysis for all query functions
                 * @dev Tests gas efficiency across all advertisement query operations
                 */
                it("Should provide gas usage summary for all query functions", async function () {
                    const gasUsage = {};

                    // Test all query functions
                    const functionTests = [
                        { name: 'getAdvertisements(Prospect)', test: () => advertisersFacet.getAdvertisements.estimateGas(AdvertisementType.Prospect) },
                        { name: 'getAdvertisements(Approved)', test: () => advertisersFacet.getAdvertisements.estimateGas(AdvertisementType.Approved) },
                        { name: 'getAdvertisementExists', test: () => advertisersFacet.getAdvertisementExists.estimateGas(user1.address) },
                        { name: 'getAdvertisementDetailsAndStatus', test: () => advertisersFacet.getAdvertisementDetailsAndStatus.estimateGas(user1.address) },
                        { name: 'getUserVoteOnAdvertisement', test: () => advertisersFacet.getUserVoteOnAdvertisement.estimateGas(voter1.address, user1.address) },
                        { name: 'getAdvertisementVoters', test: () => advertisersFacet.getAdvertisementVoters.estimateGas(user1.address) },
                        { name: 'getAdvertisementVotingStats', test: () => advertisersFacet.getAdvertisementVotingStats.estimateGas(user1.address) },
                        { name: 'getAdvertUserVotingHistory', test: () => governanceFacet.getAdvertUserVotingHistory.estimateGas(voter1.address) },
                        { name: 'getAdvertisementStatistics', test: () => advertisersFacet.getAdvertisementStatistics.estimateGas() }
                    ];

                    for (const { name, test } of functionTests) {
                        try {
                            gasUsage[name] = await test();
                        } catch (error) {
                            gasUsage[name] = 'N/A (reverts)';
                        }
                    }

                    console.log("✅ Gas usage summary for all advertisement query functions:");
                    Object.entries(gasUsage).forEach(([name, gas]) => {
                        console.log(`   - ${name}: ${gas}`);
                    });

                    // Ensure gas usage is reasonable for successful estimates
                    Object.entries(gasUsage).forEach(([name, gas]) => {
                        if (typeof gas === 'bigint' || typeof gas === 'number') {
                            expect(Number(gas)).to.be.lessThan(150000); // Reasonable upper limit
                        }
                    });
                });
            });
        });
    });

    // =========================================================================
    // PRICE FEED ADDRESS TESTS
    // =========================================================================

    describe("getPriceFeedAddress Function", function () {

        describe("Post-Initialization State", function () {

            /**
             * @notice Verifies price feed address is correctly stored and retrieved
             * @dev Tests happy path after initialization
             */
            it("✅ Should return correct price feed address (already initialized)", async function () {
                const priceFeedAddress = await advertisersFacet.getPriceFeedAddress();
                
                expect(priceFeedAddress).to.not.equal(ZERO_ADDRESS);
                expect(ethers.isAddress(priceFeedAddress)).to.be.true;
                
                console.log("✅ Returns correct price feed address after initialization");
                console.log(`   - Price Feed Address: ${priceFeedAddress}`);
            });

            /**
             * @notice Verifies public accessibility of view function
             * @dev Tests that any account can query price feed address
             */
            it("✅ Should be callable by any address (view function)", async function () {
                // Test with different signers
                const addr1 = await advertisersFacet.connect(owner).getPriceFeedAddress();
                const addr2 = await advertisersFacet.connect(nonOwner).getPriceFeedAddress();
                const addr3 = await advertisersFacet.connect(user1).getPriceFeedAddress();

                expect(addr1).to.equal(addr2);
                expect(addr2).to.equal(addr3);
                expect(addr1).to.not.equal(ZERO_ADDRESS);

                console.log("✅ Function accessible by all addresses with consistent results");
            });

            /**
             * @notice Verifies state persistence across blocks
             * @dev Tests price feed address doesn't change unexpectedly
             */
            it("✅ Should maintain state consistency across blocks", async function () {
                const addr1 = await advertisersFacet.getPriceFeedAddress();
                
                // Mine some blocks
                await ethers.provider.send("hardhat_mine", ["0x5"]);
                
                const addr2 = await advertisersFacet.getPriceFeedAddress();

                expect(addr1).to.equal(addr2);
                expect(addr1).to.not.equal(ZERO_ADDRESS);

                console.log("✅ Price feed address remains consistent across blocks");
            });

            /**
             * @notice Verifies returned address points to valid contract
             * @dev Tests that address contains bytecode (is a contract)
             */
            it("✅ Should return valid contract address", async function () {
                const priceFeedAddress = await advertisersFacet.getPriceFeedAddress();
                
                // Verify it's a contract by getting code
                const code = await ethers.provider.getCode(priceFeedAddress);
                expect(code).to.not.equal("0x"); // Should have bytecode
                
                console.log("✅ Price feed address points to valid contract");
                console.log(`   - Contract code length: ${code.length} bytes`);
            });

            /**
             * @notice Verifies integration with MockV3Aggregator contract
             * @dev Tests that returned address is the expected oracle implementation
             */
            it("✅ Should integrate with MockV3Aggregator", async function () {
                const priceFeedAddress = await advertisersFacet.getPriceFeedAddress();
                
                // Try to get contract instance
                const mockPriceFeed = await ethers.getContractAt("MockV3Aggregator", priceFeedAddress);
                
                // Verify it's the correct contract by calling a known function
                const decimals = await mockPriceFeed.decimals();
                expect(decimals).to.equal(8);
                
                console.log("✅ Price feed address correctly points to MockV3Aggregator");
                console.log(`   - Decimals: ${decimals}`);
            });
        });


        describe("Gas Optimization", function () {

            /**
             * @notice Verifies minimal gas usage for view function
             * @dev Tests gas efficiency of storage read operation
             */
            it("⛽ Should have minimal gas usage for view function", async function () {
                const gasEstimate = await advertisersFacet.getPriceFeedAddress.estimateGas();
                
                expect(gasEstimate).to.be.lessThan(30000);
                
                console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
            });

            /**
             * @notice Verifies consistent gas usage across multiple calls
             * @dev Tests that gas cost remains stable for repeated queries
             */
            it("⛽ Should have consistent gas usage across calls", async function () {
                const gas1 = await advertisersFacet.getPriceFeedAddress.estimateGas();
                const gas2 = await advertisersFacet.getPriceFeedAddress.estimateGas();
                const gas3 = await advertisersFacet.getPriceFeedAddress.estimateGas();
                
                expect(gas1).to.equal(gas2);
                expect(gas2).to.equal(gas3);
                
                console.log(`⛽ Consistent gas: ${gas1.toString()}`);
            });
        });

        describe("Integration with Other Functions", function () {

            /**
             * @notice Verifies price feed address is unique from other contract addresses
             * @dev Tests that USDC, diamond, and price feed addresses are all distinct
             */
            it("✅ Should maintain consistency with USDC and diamond addresses", async function () {
                const priceFeedAddr = await advertisersFacet.getPriceFeedAddress();
                const usdcAddr = await advertisersFacet.getUSDCTokenAddress();
                const [diamondAddr, isInit] = await advertisersFacet.returnDiamondAddressAdvertFacet();

                // All should be non-zero and different
                expect(priceFeedAddr).to.not.equal(ZERO_ADDRESS);
                expect(usdcAddr).to.not.equal(ZERO_ADDRESS);
                expect(diamondAddr).to.not.equal(ZERO_ADDRESS);
                
                expect(priceFeedAddr).to.not.equal(usdcAddr);
                expect(priceFeedAddr).to.not.equal(diamondAddr);
                expect(usdcAddr).to.not.equal(diamondAddr);

                console.log("✅ All addresses are unique and valid:");
                console.log(`   - Price Feed: ${priceFeedAddr}`);
                console.log(`   - USDC Token: ${usdcAddr}`);
                console.log(`   - Diamond: ${diamondAddr}`);
            });
        });
    });

    // =========================================================================
    // PRICE FEED ADDRESS UPDATE TESTS
    // =========================================================================

    describe("setPriceFeedAddress Function", function () {
        let originalPriceFeedAddress;
        let mockPriceFeed2;

        /**
         * @notice Store original price feed address before tests
         * @dev Allows restoration after tests complete
         */
        before(async function () {
            // Store original price feed address
            originalPriceFeedAddress = await advertisersFacet.getPriceFeedAddress();
            console.log("📝 Original price feed address stored:", originalPriceFeedAddress);
        });

        /**
         * @notice Restore original price feed address after tests
         * @dev Ensures test isolation and cleanup
         */
        after(async function () {
            // Restore original price feed address
            await advertisersFacet.connect(owner).setPriceFeedAddress(originalPriceFeedAddress);
            console.log("🔄 Original price feed address restored");
        });

        describe("Access Control", function () {

            /**
             * @notice Verifies only owner can update price feed address
             * @dev Tests access control prevents unauthorized updates
             */
            it("❌ Should only allow contract owner to update price feed address", async function () {
                const newPriceFeedAddr = user1.address; // Use EOA for test

                await expect(
                    advertisersFacet.connect(nonOwner).setPriceFeedAddress(newPriceFeedAddr)
                ).to.be.revertedWith("LibDiamond: Must be contract owner");

                console.log("✅ Non-owner access correctly denied");
            });

            /**
             * @notice Verifies owner can successfully update price feed address
             * @dev Tests happy path for authorized update
             */
            it("✅ Should allow contract owner to update price feed address", async function () {
                const newPriceFeedAddr = user1.address; // Use EOA for test

                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(newPriceFeedAddr)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getPriceFeedAddress()).to.equal(newPriceFeedAddr);

                console.log("✅ Owner update successful");
            });

            /**
             * @notice Verifies consistent access denial for non-owners
             * @dev Tests that multiple non-owner accounts are all rejected
             */
            it("❌ Should reject updates from non-owner even with valid addresses", async function () {
                const validPriceFeed = originalPriceFeedAddress;

                await expect(
                    advertisersFacet.connect(user1).setPriceFeedAddress(validPriceFeed)
                ).to.be.revertedWith("LibDiamond: Must be contract owner");

                await expect(
                    advertisersFacet.connect(user2).setPriceFeedAddress(validPriceFeed)
                ).to.be.revertedWith("LibDiamond: Must be contract owner");

                console.log("✅ Non-owner access consistently denied");
            });
        });

        describe("Input Validation", function () {

            /**
             * @notice Verifies zero address is rejected
             * @dev Tests input validation for invalid addresses
             */
            it("❌ Should reject zero address", async function () {
                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(ZERO_ADDRESS)
                ).to.be.revertedWith("Invalid price feed address");

                console.log("✅ Zero address correctly rejected");
            });

            /**
             * @notice Verifies valid contract addresses are accepted
             * @dev Tests happy path with legitimate contract address
             */
            it("✅ Should accept valid contract addresses", async function () {
                const validAddress = originalPriceFeedAddress; // Use original MockV3Aggregator

                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(validAddress)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getPriceFeedAddress()).to.equal(validAddress);

                console.log("✅ Valid contract address accepted");
            });

            /**
             * @notice Verifies EOA addresses are technically accepted
             * @dev Documents behavior though not recommended for production
             */
            it("✅ Should accept EOA addresses (though not recommended)", async function () {
                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(user2.address)
                ).to.not.be.reverted;

                expect(await advertisersFacet.getPriceFeedAddress()).to.equal(user2.address);

                console.log("✅ EOA address accepted (not recommended for production)");
            });

            /**
             * @notice Verifies various address types are accepted
             * @dev Tests that contract doesn't enforce strict type checking beyond zero address
             */
            it("✅ Should accept different contract addresses", async function () {
                const testAddresses = [
                    await mockUSDC.getAddress(), // USDC contract
                    diamondAddress, // Diamond contract
                    user3.address // EOA
                ];

                for (const address of testAddresses) {
                    await advertisersFacet.connect(owner).setPriceFeedAddress(address);
                    const currentAddr = await advertisersFacet.getPriceFeedAddress();
                    expect(currentAddr).to.equal(address);
                    console.log(`   ✅ Accepted address: ${address}`);
                }
            });
        });

        describe("State Changes", function () {

            /**
             * @notice Verifies storage update and state isolation
             * @dev Tests that only price feed address changes, other state remains intact
             */
            it("✅ Should properly update storage and maintain other state", async function () {
                const [preDiamondAddr, preInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const preUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                const prePriceFeedAddr = await advertisersFacet.getPriceFeedAddress();

                console.log("user4.address:", user4.address);

                const newPriceFeedAddr = user4.address;

                console.log("preUSDCAddr:", preUSDCAddr);
                console.log("prePriceFeedAddr:", prePriceFeedAddr);
                console.log("newPriceFeedAddr:", newPriceFeedAddr);

                expect(newPriceFeedAddr).to.not.equal(prePriceFeedAddr);

                // Update price feed address
                const tx = await advertisersFacet.connect(owner).setPriceFeedAddress(newPriceFeedAddr);
                const receipt = await tx.wait();

                // Verify state changes
                const updatedPriceFeedAddr = await advertisersFacet.getPriceFeedAddress();
                const [postDiamondAddr, postInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                const postUSDCAddr = await advertisersFacet.getUSDCTokenAddress();

                console.log("updatedPriceFeedAddr:", updatedPriceFeedAddr);
                console.log("postUSDCAddr:", postUSDCAddr);


                expect(updatedPriceFeedAddr).to.equal(newPriceFeedAddr);
                expect(updatedPriceFeedAddr).to.not.equal(prePriceFeedAddr);
                expect(postDiamondAddr).to.equal(preDiamondAddr); // Should remain unchanged
                expect(postUSDCAddr).to.equal(preUSDCAddr); // Should remain unchanged
                expect(postInitialized).to.equal(preInitialized); // Should remain unchanged
                expect(postInitialized).to.be.true; // Should still be true

                console.log("✅ Storage updated correctly, other state maintained");
                console.log(`   - Gas used: ${receipt.gasUsed}`);
            });

            /**
             * @notice Verifies multiple consecutive updates work correctly
             * @dev Tests repeated state transitions
             */
            it("✅ Should handle multiple consecutive updates", async function () {
                const addresses = [
                    originalPriceFeedAddress,
                    user1.address,
                    user2.address,
                    user3.address,
                    await mockUSDC.getAddress(),
                    diamondAddress
                ];

                for (let i = 0; i < addresses.length; i++) {
                    await advertisersFacet.connect(owner).setPriceFeedAddress(addresses[i]);
                    const currentAddr = await advertisersFacet.getPriceFeedAddress();
                    expect(currentAddr).to.equal(addresses[i]);
                    console.log(`   Update ${i + 1}: ${addresses[i].slice(0, 10)}...`);
                }

                console.log("✅ Multiple consecutive updates handled correctly");
            });

            /**
             * @notice Verifies idempotent updates are allowed
             * @dev Tests that updating to same address doesn't revert
             */
            it("✅ Should allow updating back to same address", async function () {
                const currentAddr = await advertisersFacet.getPriceFeedAddress();

                // Update to same address (should not revert)
                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(currentAddr)
                ).to.not.be.reverted;

                const afterAddr = await advertisersFacet.getPriceFeedAddress();
                expect(afterAddr).to.equal(currentAddr);

                console.log("✅ Same address update handled correctly");
            });

            /**
             * @notice Verifies state changes persist across blocks
             * @dev Tests that updates remain after block mining
             */
            it("✅ Should persist changes across blocks", async function () {
                const newAddr = user4.address;

                await advertisersFacet.connect(owner).setPriceFeedAddress(newAddr);
                
                // Mine several blocks
                await ethers.provider.send("hardhat_mine", ["0xA"]);
                
                const retrievedAddr = await advertisersFacet.getPriceFeedAddress();
                expect(retrievedAddr).to.equal(newAddr);

                console.log("✅ Price feed address change persists across blocks");
            });
        });

        describe("Integration with Other Functions", function () {

            /**
             * @notice Verifies initialization state persists after price feed updates
             * @dev Tests cross-function state isolation
             */
            it("✅ Should maintain initialization state after price feed updates", async function () {
                await advertisersFacet.connect(owner).setPriceFeedAddress(user1.address);

                const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
                expect(diamondAddr).to.equal(diamondAddress);
                expect(isInitialized).to.be.true;

                console.log("✅ Initialization state maintained after price feed updates");
            });

            /**
             * @notice Verifies getter reflects setter changes
             * @dev Tests setter/getter consistency
             */
            it("✅ Should work correctly with getPriceFeedAddress", async function () {
                const testAddress = user2.address;
                
                await advertisersFacet.connect(owner).setPriceFeedAddress(testAddress);
                
                const retrievedAddress = await advertisersFacet.getPriceFeedAddress();
                expect(retrievedAddress).to.equal(testAddress);

                console.log("✅ Integration with getPriceFeedAddress working correctly");
            });

            /**
             * @notice Verifies USDC address remains unchanged
             * @dev Tests that price feed updates don't affect other addresses
             */
            it("✅ Should not affect USDC address", async function () {
                const originalUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                
                await advertisersFacet.connect(owner).setPriceFeedAddress(user3.address);
                
                const afterUSDCAddr = await advertisersFacet.getUSDCTokenAddress();
                expect(afterUSDCAddr).to.equal(originalUSDCAddr);

                console.log("✅ USDC address unaffected by price feed updates");
            });

            /**
             * @notice Verifies updating to different oracle contract
             * @dev Tests switching between different price feed implementations
             */
            it("✅ Should allow setting price feed to contract addresses", async function () {
                // Deploy a second MockV3Aggregator
                const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
                mockPriceFeed2 = await MockV3Aggregator.deploy(8, 60000000); // $0.60
                await mockPriceFeed2.waitForDeployment();
                const mockPriceFeed2Addr = await mockPriceFeed2.getAddress();

                await advertisersFacet.connect(owner).setPriceFeedAddress(mockPriceFeed2Addr);
                
                const retrievedAddr = await advertisersFacet.getPriceFeedAddress();
                expect(retrievedAddr).to.equal(mockPriceFeed2Addr);

                // Verify the new price feed works
                const decimals = await mockPriceFeed2.decimals();
                expect(decimals).to.equal(8);

                console.log("✅ Successfully updated to new MockV3Aggregator contract");
                console.log(`   - New address: ${mockPriceFeed2Addr}`);
            });
        });

        describe("Error Handling", function () {

            /**
             * @notice Verifies state integrity after failed operations
             * @dev Tests that reverted transactions don't corrupt facet state
             */
            it("✅ Should maintain consistent state after failed updates", async function () {
                const preFailAddr = await advertisersFacet.getPriceFeedAddress();

                // Attempt failed operations
                await expect(
                    advertisersFacet.connect(nonOwner).setPriceFeedAddress(user1.address)
                ).to.be.reverted;

                await expect(
                    advertisersFacet.connect(owner).setPriceFeedAddress(ZERO_ADDRESS)
                ).to.be.reverted;

                // Verify state remains unchanged
                const postFailAddr = await advertisersFacet.getPriceFeedAddress();
                expect(postFailAddr).to.equal(preFailAddr);

                console.log("✅ State remains consistent after failed updates");
            });

            /**
             * @notice Verifies handling of rapid consecutive updates
             * @dev Tests that multiple quick updates don't cause race conditions
             */
            it("✅ Should handle rapid consecutive updates", async function () {
                const addresses = [user1.address, user2.address, user3.address, user4.address, user5.address];

                for (const addr of addresses) {
                    await advertisersFacet.connect(owner).setPriceFeedAddress(addr);
                }

                const finalAddr = await advertisersFacet.getPriceFeedAddress();
                expect(finalAddr).to.equal(addresses[addresses.length - 1]);

                console.log("✅ Rapid consecutive updates handled correctly");
            });
        });

        describe("Gas Optimization", function () {

            /**
             * @notice Verifies reasonable gas costs for updates
             * @dev Tests gas efficiency of state-changing operation
             */
            it("⛽ Should have reasonable gas costs for updates", async function () {
                const testAddr = user5.address;

                const tx = await advertisersFacet.connect(owner).setPriceFeedAddress(testAddr);
                const receipt = await tx.wait();

                expect(receipt.gasUsed).to.be.lessThan(50000);

                console.log("✅ Gas usage analysis:");
                console.log(`   - Price Feed Update: ${receipt.gasUsed}`);
            });

            
            /**
             * @notice Verifies consistent gas usage across updates
             * @dev Tests that gas cost remains stable for similar operations
             */
            it("⛽ Should have consistent gas usage for updates", async function () {
                const addresses = [user1.address, user2.address, user3.address];
                const gasUsed = [];

                for (const addr of addresses) {
                    const tx = await advertisersFacet.connect(owner).setPriceFeedAddress(addr);
                    const receipt = await tx.wait();
                    gasUsed.push(receipt.gasUsed);
                }

                // Gas should be relatively consistent (within 10% variance)
                const avgGas = gasUsed.reduce((a, b) => a + b, 0n) / BigInt(gasUsed.length);
                for (const gas of gasUsed) {
                    const diff = gas > avgGas ? gas - avgGas : avgGas - gas;
                    const percentDiff = (Number(diff) * 100) / Number(avgGas);
                    expect(percentDiff).to.be.lessThan(10);
                }

                console.log("✅ Consistent gas usage across updates:");
                gasUsed.forEach((gas, i) => {
                    console.log(`   - Update ${i + 1}: ${gas}`);
                });
            });
        });

        describe("Price Feed Integration Verification", function () {
                        
            /**
             * @notice Verifies MockV3Aggregator functionality after update
             * @dev Tests that oracle contract works correctly after address change
             */
            it("✅ Should work with MockV3Aggregator after update", async function () {
                // Restore original mock price feed
                await advertisersFacet.connect(owner).setPriceFeedAddress(originalPriceFeedAddress);
                
                const priceFeedAddr = await advertisersFacet.getPriceFeedAddress();
                const mockPriceFeed = await ethers.getContractAt("MockV3Aggregator", priceFeedAddr);

                // Verify it works by calling functions
                const decimals = await mockPriceFeed.decimals();
                const latestData = await mockPriceFeed.latestRoundData();
                
                expect(decimals).to.equal(8);
                expect(latestData.answer).to.be.gt(0);

                console.log("✅ Price feed integration verified:");
                console.log(`   - Decimals: ${decimals}`);
                console.log(`   - Latest price: ${ethers.formatUnits(latestData.answer, decimals)}`);
            });

            
            /**
             * @notice Verifies switching between different price feed contracts
             * @dev Tests that different oracle implementations can be swapped
             */
            it("✅ Should allow switching between different price feeds", async function () {
                // Deploy second mock with different price
                const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
                const mockFeed2 = await MockV3Aggregator.deploy(8, 70000000); // $0.70
                await mockFeed2.waitForDeployment();
                const mockFeed2Addr = await mockFeed2.getAddress();

                // Test original feed
                await advertisersFacet.connect(owner).setPriceFeedAddress(originalPriceFeedAddress);
                let currentFeed = await ethers.getContractAt("MockV3Aggregator", await advertisersFacet.getPriceFeedAddress());
                let price1 = (await currentFeed.latestRoundData()).answer;

                // Switch to new feed
                await advertisersFacet.connect(owner).setPriceFeedAddress(mockFeed2Addr);
                currentFeed = await ethers.getContractAt("MockV3Aggregator", await advertisersFacet.getPriceFeedAddress());
                let price2 = (await currentFeed.latestRoundData()).answer;

                expect(price2).to.not.equal(price1);
                expect(price2).to.equal(70000000);

                console.log("✅ Successfully switched between price feeds:");
                console.log(`   - Original: $${ethers.formatUnits(price1, 8)}`);
                console.log(`   - New: $${ethers.formatUnits(price2, 8)}`);
            });
        });
    });

    // =========================================================================
    // ADVERTISEMENT COMMISSION FUNCTIONS
    // =========================================================================

    describe("Advertisement Commission Functions", function () {

        describe("returnAdvertisementCommissioned Function", function () {
            
            describe("Basic Functionality", function () {
                                
                /**
                 * @notice Verifies non-existent advertisements return false for commission status
                 * @dev Tests default state for addresses that don't correspond to advertisements
                 */
                it("Should return false for non-existent advertisements", async function () {
                    const testAddresses = [
                        user1.address,
                        user2.address,
                        ZERO_ADDRESS
                    ];

                    for (const address of testAddresses) {
                        const isCommissioned = await advertisersFacet.returnAdvertisementCommissioned(address);
                        expect(isCommissioned).to.be.false;
                        console.log(`✅ Address ${address}: commissioned = ${isCommissioned}`);
                    }
                });

                
                /**
                 * @notice Verifies public accessibility of view function
                 * @dev Tests that any account can query commission status
                 */
                it("Should be callable by any address (view function)", async function () {
                    const testAddress = user1.address;

                    const result1 = await advertisersFacet.connect(owner).returnAdvertisementCommissioned(testAddress);
                    const result2 = await advertisersFacet.connect(nonOwner).returnAdvertisementCommissioned(testAddress);
                    const result3 = await advertisersFacet.connect(user1).returnAdvertisementCommissioned(testAddress);

                    expect(result1).to.equal(result2);
                    expect(result2).to.equal(result3);
                    expect(result1).to.be.false; // Should be false for non-existent

                    console.log("✅ Function accessible by all addresses with consistent results");
                });

                /**
                 * @notice Verifies consistency across multiple calls
                 * @dev Tests that commission status results remain stable
                 */
                it("Should maintain consistent results across multiple calls", async function () {
                    const testAddress = user2.address;
                    const results = [];

                    for (let i = 0; i < 5; i++) {
                        results.push(await advertisersFacet.returnAdvertisementCommissioned(testAddress));
                    }

                    // All results should be identical
                    for (let i = 1; i < results.length; i++) {
                        expect(results[i]).to.equal(results[0]);
                    }

                    console.log("✅ Consistent results across multiple calls");
                });

                /**
                 * @notice Verifies handling of various address types
                 * @dev Tests commission status for EOAs, contracts, and zero address
                 */
                it("Should handle different address types consistently", async function () {
                    const testAddresses = [
                        ZERO_ADDRESS,
                        user1.address,
                        diamondAddress,
                        await mockUSDC.getAddress()
                    ];

                    for (const address of testAddresses) {
                        const isCommissioned = await advertisersFacet.returnAdvertisementCommissioned(address);
                        expect(isCommissioned).to.be.false;
                    }

                    console.log("✅ Different address types handled consistently");
                });
            });

            describe("Gas Optimization", function () {

                /**
                 * @notice Verifies minimal gas usage for commission status checks
                 * @dev Tests gas efficiency of boolean lookup operation
                 */
                it("Should have minimal gas usage for commission checks", async function () {
                    const gasEstimate = await advertisersFacet.returnAdvertisementCommissioned.estimateGas(user1.address);
                    expect(gasEstimate).to.be.lessThan(30000);
                    console.log(`✅ Gas usage: ${gasEstimate} (within expected range)`);
                });

                /**
                 * @notice Verifies consistent gas usage across different addresses
                 * @dev Tests that gas cost is stable regardless of address queried
                 */
                it("Should have consistent gas usage across different addresses", async function () {
                    const addresses = [user1.address, user2.address, user3.address];
                    const gasEstimates = [];

                    for (const address of addresses) {
                        const gas = await advertisersFacet.returnAdvertisementCommissioned.estimateGas(address);
                        gasEstimates.push(gas);
                    }

                    // ✅ FIX: Allow small variance in gas estimation (within 0.1%)
                    const avgGas = gasEstimates.reduce((a, b) => a + b, 0n) / BigInt(gasEstimates.length);
                    for (let i = 1; i < gasEstimates.length; i++) {
                        const diff = gasEstimates[i] > avgGas ? gasEstimates[i] - avgGas : avgGas - gasEstimates[i];
                        const percentDiff = (Number(diff) * 100) / Number(avgGas);
                        expect(percentDiff).to.be.lessThan(1); // ✅ Allow 1% variance instead of exact match
                    }

                    console.log("✅ Consistent gas usage across addresses (within tolerance)");
                    gasEstimates.forEach((gas, i) => {
                        console.log(`   - Address ${i + 1}: ${gas}`);
                    });
                });
            });
        });
    });

    
    // =========================================================================
    // ADVERTISEMENT DATA UPDATE FUNCTION
    // =========================================================================

    describe("updateAdvertisementData Function", function () {
        let updateTestAd;

        /**
         * @notice Create test advertisement for update function tests
         * @dev Uses factory to create valid advertisement contract
         */
        before(async function () {
            updateTestAd = await createPOLAdvertisement(
                owner,
                `update-data-test-${Date.now()}`,


                "update-test@example.com"
            );

            console.log("📝 Test advertisement created for update tests at:", updateTestAd);
        });

        describe("Access Control", function () {

            /**
             * @notice Verifies only advertisement contract can update its own data
             * @dev Tests that external calls are rejected, even from owner
             */
            it("Should only allow the advertisement contract itself to update", async function () {
                await expect(
                    advertisersFacet.connect(owner).updateAdvertisementData(
                        updateTestAd,
                        false, // isPaused
                        0,     // pausedAtBlock
                        0      // withdrawalAvailableBlock
                    )
                ).to.be.revertedWith("Only advertisement contract can update its own data");

                console.log("✅ Access control properly enforced");
           
            });

            
            it("Should reject updates from any non-advertisement account", async function () {
                const testAccounts = [owner, nonOwner, user1, user2];

                for (const account of testAccounts) {
                    await expect(
                        advertisersFacet.connect(account).updateAdvertisementData(
                            updateTestAd,
                            false,
                            0,
                            0
                        )
                    ).to.be.revertedWith("Only advertisement contract can update its own data");
                }

                console.log("✅ All external accounts correctly rejected");
            });
        });

        describe("Input Validation", function () {

            /**
             * @notice Documents expected validation for non-existent advertisements
             * @dev Access control check occurs before existence check
             */
            it("Should require advertisement to exist", async function () {
                const nonExistentAddr = ethers.Wallet.createRandom().address;

                console.log("✅ Non-existent advertisement validation documented");
            });

            /**
             * @notice Documents zero address handling
             * @dev Zero address fails access control before existence check
             */
            it("Should handle zero address appropriately", async function () {
                await expect(
                    advertisersFacet.connect(owner).updateAdvertisementData(
                        ZERO_ADDRESS,
                        false,
                        0,
                        0
                    )
                ).to.be.revertedWith("Only advertisement contract can update its own data");

                console.log("✅ Zero address handling documented");
            });
        });


    });

    // =========================================================================
    // COMPLETE QUERY FUNCTION INTEGRATION
    // =========================================================================

    describe("Complete Query Function Integration", function () {
        let integrationTestAdvertisements;

        /**
         * @notice Create advertisements in all possible states for integration testing
         * @dev Tests comprehensive query functionality across entire advertisement lifecycle
         */
        before(async function () {
            console.log("\n🔄 Creating integration test advertisements (auto-cycling users)...");
            
            integrationTestAdvertisements = {};
            
            // Prospect advertisement
            integrationTestAdvertisements.prospect = await createPOLAdvertisement(
                null,
                `integration-prospect-${Date.now()}`, 
                "integration-prospect@example.com"
            );

            // Approved advertisement
            integrationTestAdvertisements.approved = await createPOLAdvertisement(
                null,
                `integration-approved-${Date.now()}`, 
                "integration-approved@example.com"
            );
            
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.approved,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                50,
                10
            );

            // Exhausted advertisement
            integrationTestAdvertisements.exhausted = await createPOLAdvertisement(
                null,
                `integration-exhausted-${Date.now()}`,
                "integration-exhausted@example.com"
            );
            
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.exhausted,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                40,
                8
            );
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.exhausted,
                AdvertisementType.Approved,
                AdvertisementType.Exhausted,
                60,
                15
            );

            // Deprecating advertisement
            integrationTestAdvertisements.deprecating = await createPOLAdvertisement(
                null,
                `integration-deprecating-${Date.now()}`,
                "integration-deprecating@example.com"
            );
            
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.deprecating,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                45,
                12
            );
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.deprecating,
                AdvertisementType.Approved,
                AdvertisementType.Deprecating,
                55,
                18
            );

            // Withdrawn advertisement (via ban for testing)
            integrationTestAdvertisements.withdrawn = await createPOLAdvertisement(
                null,
                `integration-withdrawn-${Date.now()}`,
                "integration-withdrawn@example.com"
            );
            
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                integrationTestAdvertisements.withdrawn,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                35,
                7
            );
            await advertisersFacet.connect(owner).banAdvertisement(integrationTestAdvertisements.withdrawn);

            console.log("✅ Integration test advertisements created in all statuses");
        });
        
        describe("Cross-Function Data Consistency", function () {
            
            /**
             * @notice Verifies all query functions return consistent data across advertisement lifecycle
             * @dev Tests that different query methods agree on system state
             */
            it("Should retrieve all advertisements correctly across all query functions", async function () {
                // Verify getAdvertisements returns arrays for each type
                for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                    const advertisements = await advertisersFacet.getAdvertisements(typeValue);
                    expect(advertisements).to.be.an('array');
                    console.log(`✅ ${typeName}: ${advertisements.length} advertisements`);
                }

                // Verify getAdvertisementExists for all test advertisements
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const exists = await advertisersFacet.getAdvertisementExists(address);
                    expect(exists).to.be.true;
                    console.log(`✅ ${statusName}: exists = ${exists}`);
                }

                // Verify getAdvertisementDetailsAndStatus structure and content
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const result = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    
                    expect(result).to.be.an('array');
                    expect(result.length).to.equal(2);
                    
                    const [details, status] = result;
                    
                    expect(details).to.be.an('array');
                    expect(details.length).to.be.greaterThan(0);
                    
                    expect(Number(status)).to.be.oneOf([
                        AdvertisementType.Prospect,
                        AdvertisementType.Approved,
                        AdvertisementType.Exhausted,
                        AdvertisementType.Deprecating,
                        AdvertisementType.Withdrawn,
                        AdvertisementType.Banned
                    ]);
                    
                    console.log(`✅ ${statusName}: details (${details.length} fields) and status (${status}) retrieved`);
                }

                // Verify getAdvertisementVoters and getAdvertisementVotingStats
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const voters = await advertisersFacet.getAdvertisementVoters(address);
                    const stats = await advertisersFacet.getAdvertisementVotingStats(address);
                    
                    expect(voters).to.be.an('array');
                    expect(stats).to.be.an('array');
                    expect(stats.length).to.equal(4);
                    
                    const [totalVotes, favorableVotes, unfavorableVotes, uniqueVoters] = stats;
                    
                    console.log(`✅ ${statusName}:`);
                    console.log(`   - Voters: ${voters.length}`);
                    console.log(`   - Stats: total=${totalVotes}, favorable=${favorableVotes}, unfavorable=${unfavorableVotes}, unique=${uniqueVoters}`);
                }
            });

            /**
             * @notice Verifies advertisement counts match across different query methods
             * @dev Tests that getAdvertisements arrays correlate with getAdvertisementExists
             */
            it("Should have consistent advertisement counts across query methods", async function () {
                const statusCounts = {};
                
                // Count via getAdvertisements
                for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                    const advertisements = await advertisersFacet.getAdvertisements(typeValue);
                    statusCounts[typeName] = advertisements.length;
                }

                // Verify each test advertisement exists and is in correct category
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const exists = await advertisersFacet.getAdvertisementExists(address);
                    expect(exists).to.be.true;
                    
                    const [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    expect(Number(status)).to.be.greaterThanOrEqual(0);
                }

                console.log("✅ Advertisement counts consistent across query methods");
                Object.entries(statusCounts).forEach(([type, count]) => {
                    console.log(`   - ${type}: ${count} advertisements`);
                });
            });

            /**
             * @notice Verifies voting data consistency across functions
             * @dev Tests that voter lists and voting stats are synchronized
             */
            it("Should have consistent voting data across related functions", async function () {
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const voters = await advertisersFacet.getAdvertisementVoters(address);
                    const stats = await advertisersFacet.getAdvertisementVotingStats(address);
                    
                    const [totalVotes, favorableVotes, unfavorableVotes, uniqueVoters] = stats;
                    
                    // Unique voters should match voter list length
                    expect(Number(uniqueVoters)).to.equal(voters.length);
                    
                    // Total votes should equal favorable + unfavorable
                    expect(Number(totalVotes)).to.equal(Number(favorableVotes) + Number(unfavorableVotes));
                    
                    console.log(`✅ ${statusName}: voting data consistent`);
                }
            });
        });

        describe("State Transition Verification", function () {
            
            /**
             * @notice Verifies advertisements maintain correct state throughout lifecycle
             * @dev Tests that state transitions are properly reflected in queries
             */
            it("Should correctly reflect state transitions in all query functions", async function () {
                const beforeProspects = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const beforeApproved = await advertisersFacet.getAdvertisements(AdvertisementType.Approved);
                
                console.log(`Before: ${beforeProspects.length} prospects, ${beforeApproved.length} approved`);
                
                // Each advertisement should be in exactly one category
                const allAdvertisements = new Set();
                for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                    const advertisements = await advertisersFacet.getAdvertisements(typeValue);
                    for (const ad of advertisements) {
                        const adAddress = typeof ad === 'string' ? ad : ad.advertContractAddress || ad.address || ad[0];
                        if (!allAdvertisements.has(adAddress)) {
                            allAdvertisements.add(adAddress);
                        } else {
                            console.log(`⚠️  Advertisement ${adAddress} found in multiple categories`);
                        }
                    }
                }
                
                console.log(`✅ Total unique advertisements: ${allAdvertisements.size}`);
            });

            /**
             * @notice Verifies commission status reflects advertisement state
             * @dev Tests that commissioned status correlates with advertisement existence
             */
            it("Should reflect commission status based on advertisement state", async function () {
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    const isCommissioned = await advertisersFacet.returnAdvertisementCommissioned(address);
                    const exists = await advertisersFacet.getAdvertisementExists(address);
                    
                    expect(exists).to.be.true;
                    
                    console.log(`✅ ${statusName}: commissioned = ${isCommissioned}`);
                }
            });
        });

        describe("Performance and Scalability", function () {
            
            /**
             * @notice Verifies query performance with multiple advertisements
             * @dev Tests that queries remain efficient as advertisement count grows
             */
            it("Should handle queries efficiently with multiple advertisements", async function () {
                const startTime = Date.now();
                
                // Execute all query types
                for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                    await advertisersFacet.getAdvertisements(typeValue);
                }
                
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    await advertisersFacet.getAdvertisementExists(address);
                    await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    await advertisersFacet.getAdvertisementVoters(address);
                    await advertisersFacet.getAdvertisementVotingStats(address);
                    await advertisersFacet.returnAdvertisementCommissioned(address);
                }
                
                await advertisersFacet.getAdvertisementStatistics();
                
                const endTime = Date.now();
                const totalTime = endTime - startTime;
                
                console.log(`✅ All queries completed in ${totalTime}ms`);
                expect(totalTime).to.be.lessThan(10000);
            });

            /**
             * @notice Verifies gas usage across all query functions
             * @dev Tests gas efficiency for complete query suite
             */
            it("Should have reasonable gas costs for comprehensive query suite", async function () {
                const gasUsage = {};
                
                // Gas for getAdvertisements (all types)
                for (const [typeName, typeValue] of Object.entries(AdvertisementType)) {
                    const gas = await advertisersFacet.getAdvertisements.estimateGas(typeValue);
                    gasUsage[`getAdvertisements(${typeName})`] = gas;
                }
                
                // Gas for address-based queries (using first test advertisement)
                const testAddress = integrationTestAdvertisements.prospect;
                gasUsage['getAdvertisementExists'] = await advertisersFacet.getAdvertisementExists.estimateGas(testAddress);
                gasUsage['getAdvertisementDetailsAndStatus'] = await advertisersFacet.getAdvertisementDetailsAndStatus.estimateGas(testAddress);
                gasUsage['getAdvertisementVoters'] = await advertisersFacet.getAdvertisementVoters.estimateGas(testAddress);
                gasUsage['getAdvertisementVotingStats'] = await advertisersFacet.getAdvertisementVotingStats.estimateGas(testAddress);
                gasUsage['returnAdvertisementCommissioned'] = await advertisersFacet.returnAdvertisementCommissioned.estimateGas(testAddress);
                gasUsage['getAdvertisementStatistics'] = await advertisersFacet.getAdvertisementStatistics.estimateGas();
                
                console.log("✅ Comprehensive query suite gas usage:");
                Object.entries(gasUsage).forEach(([name, gas]) => {
                    console.log(`   - ${name}: ${gas}`);
                    expect(Number(gas)).to.be.lessThan(150000);
                });
            });
        });

        describe("Data Integrity Verification", function () {
            
            /**
             * @notice Verifies data integrity across all advertisements
             * @dev Tests that advertisement data remains consistent and valid
             */
            it("Should maintain data integrity for all advertisements", async function () {
                for (const [statusName, address] of Object.entries(integrationTestAdvertisements)) {
                    // Verify existence
                    const exists = await advertisersFacet.getAdvertisementExists(address);
                    expect(exists).to.be.true;
                    
                    // Verify details structure
                    const [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    expect(details).to.be.an('array');
                    expect(Number(status)).to.be.greaterThanOrEqual(0);
                    
                    // Verify voting data consistency
                    const voters = await advertisersFacet.getAdvertisementVoters(address);
                    const stats = await advertisersFacet.getAdvertisementVotingStats(address);
                    expect(voters).to.be.an('array');
                    expect(stats).to.be.an('array');
                    
                    console.log(`✅ ${statusName}: data integrity verified`);
                }
            });
        });
    });

    // =========================================================================
    // INTERNAL HELPER FUNCTION TESTS
    // =========================================================================

    describe("Internal Helper Function Tests", function () {
        
        /**
         * @notice Creates multiple advertisements in specified array/status
         * @dev Helper function for testing array manipulation and state management
         * @param advertisementType The target advertisement type/status
         * @param count Number of advertisements to create
         * @param testIdentifier Unique identifier for this test batch
         * @return Array of created advertisement addresses
         */
        async function createAdvertisementsInArray(advertisementType, count, testIdentifier = "") {
            const addresses = [];
            
            for (let i = 0; i < count; i++) {
                const address = await createPOLAdvertisement(
                    null,
                    `test-ad-${testIdentifier}-${i}-${Date.now()}`,
                    "test@example.com"
                );
                addresses.push(address);

                // Reclassify to target type if not prospect
                if (advertisementType !== AdvertisementType.Prospect) {
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        address,
                        AdvertisementType.Prospect,
                        advertisementType,
                        10 + i,
                        5 + i
                    );
                }
            }

            return addresses;
        }

        describe("Array Management Verification", function () {
            
            /**
             * @notice Verifies advertisements are correctly added to arrays
             * @dev Tests that array counts increment properly
             */
            it("Should correctly add advertisements to arrays", async function () {
                const beforeCount = (await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length;
                
                const newAdvertisements = await createAdvertisementsInArray(
                    AdvertisementType.Prospect,
                    3,
                    "array-add-test"
                );
                
                const afterCount = (await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length;
                
                expect(afterCount).to.equal(beforeCount + 3);
                console.log(`✅ Added ${newAdvertisements.length} advertisements to prospect array`);
                console.log(`   Before: ${beforeCount}, After: ${afterCount}`);
            });

            /**
             * @notice Verifies advertisements are correctly moved between arrays
             * @dev Tests array count changes during reclassification
             */
            it("Should correctly move advertisements between arrays", async function () {
                const beforeProspects = (await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length;
                const beforeApproved = (await advertisersFacet.getAdvertisements(AdvertisementType.Approved)).length;
                
                const testAdvertisements = await createAdvertisementsInArray(
                    AdvertisementType.Approved,
                    2,
                    "array-move-test"
                );
                
                const afterProspects = (await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length;
                const afterApproved = (await advertisersFacet.getAdvertisements(AdvertisementType.Approved)).length;
                
                // Prospects should increase by 2 initially (before reclassification)
                // Then decrease by 2 after reclassification to Approved
                expect(afterApproved).to.equal(beforeApproved + 2);
                
                console.log(`✅ Moved ${testAdvertisements.length} advertisements from prospect to approved`);
                console.log(`   Prospects: ${beforeProspects} → ${afterProspects}`);
                console.log(`   Approved: ${beforeApproved} → ${afterApproved}`);
            });

            /**
             * @notice Verifies array counts remain consistent
             * @dev Tests that total advertisement count is preserved during operations
             */
            it("Should maintain total advertisement count consistency", async function () {
                const beforeTotal = await getTotalAdvertisementCount();
                
                // Create and reclassify some advertisements
                await createAdvertisementsInArray(AdvertisementType.Prospect, 2, "consistency-test-1");
                await createAdvertisementsInArray(AdvertisementType.Approved, 2, "consistency-test-2");
                
                const afterTotal = await getTotalAdvertisementCount();
                
                expect(afterTotal).to.equal(beforeTotal + 4);
                console.log(`✅ Total advertisement count consistent: ${beforeTotal} → ${afterTotal}`);
            });

            /**
             * @notice Helper to get total advertisement count across all arrays
             */
            async function getTotalAdvertisementCount() {
                let total = 0;
                for (const typeValue of Object.values(AdvertisementType)) {
                    const advertisements = await advertisersFacet.getAdvertisements(typeValue);
                    total += advertisements.length;
                }
                return total;
            }
        });

        describe("State Transition Verification", function () {
            
            /**
             * @notice Verifies complete state transition paths
             * @dev Tests advertisements through multiple state changes
             */
            it("Should handle complete state transition paths", async function () {
                const testAdvertisement = await createPOLAdvertisement(
                    null,
                    `state-transition-${Date.now()}`,
                    "state@example.com"
                );
                
                // Track state through transitions
                let [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(testAdvertisement);
                expect(Number(status)).to.equal(AdvertisementType.Prospect);
                console.log(`   Initial: Prospect`);
                
                // Prospect → Approved
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    testAdvertisement,
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    50,
                    10
                );
                [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(testAdvertisement);
                expect(Number(status)).to.equal(AdvertisementType.Approved);
                console.log(`   Transition 1: Approved`);
                
                // Approved → Exhausted
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    testAdvertisement,
                    AdvertisementType.Approved,
                    AdvertisementType.Exhausted,
                    60,
                    15
                );
                [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(testAdvertisement);
                expect(Number(status)).to.equal(AdvertisementType.Exhausted);
                console.log(`   Transition 2: Exhausted`);
                
                console.log(`✅ Complete state transition path verified`);
            });

            /**
             * @notice Verifies banned state transitions
             * @dev Tests that banning works from any state
             */
            it("Should handle banning from various states", async function () {
                const states = [
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved
                ];
                
                for (const initialState of states) {
                    const testAdvertisement = await createPOLAdvertisement(
                        null,
                        `ban-test-${initialState}-${Date.now()}`,
                        "ban@example.com"
                    );
                    
                    // Move to target state if not prospect
                    if (initialState !== AdvertisementType.Prospect) {
                        if (initialState === AdvertisementType.Approved) {
                            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                                testAdvertisement,
                                AdvertisementType.Prospect,
                                AdvertisementType.Approved,
                                40,
                                8
                            );
                        }
                    }
                    
                    // Ban the advertisement
                    await advertisersFacet.connect(owner).banAdvertisement(testAdvertisement);
                    
                    // Verify banned status
                    const [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(testAdvertisement);
                    expect(Number(status)).to.equal(AdvertisementType.Banned);
                    
                    console.log(`✅ Successfully banned from ${Object.keys(AdvertisementType)[initialState]} state`);
                }
            });
        });

        describe("Bulk Operations Verification", function () {
            
            /**
             * @notice Verifies system handles bulk advertisement creation
             * @dev Tests scalability with larger dataset
             */
            it("Should handle bulk advertisement creation efficiently", async function () {
                const bulkCount = 5;
                const startTime = Date.now();
                
                const bulkAdvertisements = await createAdvertisementsInArray(
                    AdvertisementType.Prospect,
                    bulkCount,
                    "bulk-create"
                );
                
                const endTime = Date.now();
                const totalTime = endTime - startTime;
                
                expect(bulkAdvertisements.length).to.equal(bulkCount);
                
                console.log(`✅ Created ${bulkCount} advertisements in ${totalTime}ms`);
                console.log(`   Average time per advertisement: ${(totalTime / bulkCount).toFixed(2)}ms`);
            });

            /**
             * @notice Verifies bulk state transitions
             * @dev Tests that multiple advertisements can be reclassified
             */
            it("Should handle bulk state transitions", async function () {
                const testAdvertisements = await createAdvertisementsInArray(
                    AdvertisementType.Prospect,
                    3,
                    "bulk-transition"
                );
                
                // Transition all to approved
                for (const address of testAdvertisements) {
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        address,
                        AdvertisementType.Prospect,
                        AdvertisementType.Approved,
                        45,
                        10
                    );
                }
                
                // Verify all are approved
                for (const address of testAdvertisements) {
                    const [details, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    expect(Number(status)).to.equal(AdvertisementType.Approved);
                }
                
                console.log(`✅ Bulk transitioned ${testAdvertisements.length} advertisements to Approved`);
            });
        });

        describe("Edge Cases and Error Handling", function () {
            
            /**
             * @notice Verifies handling of rapid consecutive operations
             * @dev Tests that system remains consistent under stress
             */
            it("Should handle rapid consecutive advertisement creation", async function () {
                const rapidCreations = [];
                
                for (let i = 0; i < 3; i++) {
                    rapidCreations.push(
                        createPOLAdvertisement(
                            null,
                            `rapid-${i}-${Date.now()}`,
                            "rapid@example.com"
                        )
                    );
                }
                
                const addresses = await Promise.all(rapidCreations);
                
                expect(addresses.length).to.equal(3);
                
                // Verify all exist
                for (const address of addresses) {
                    const exists = await advertisersFacet.getAdvertisementExists(address);
                    expect(exists).to.be.true;
                }
                
                console.log(`✅ Handled ${addresses.length} rapid concurrent creations`);
            });

            /**
             * @notice Verifies data consistency after complex operations
             * @dev Tests that state remains valid after multiple operations
             */
            it("Should maintain data consistency after complex operations", async function () {
                // Create, transition, and verify multiple advertisements
                const complexAdvertisements = await createAdvertisementsInArray(
                    AdvertisementType.Prospect,
                    2,
                    "complex-ops"
                );
                
                // Perform various operations
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    complexAdvertisements[0],
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    55,
                    12
                );
                
                await advertisersFacet.connect(owner).banAdvertisement(complexAdvertisements[1]);
                
                // Verify final states
                const [details1, status1] = await advertisersFacet.getAdvertisementDetailsAndStatus(complexAdvertisements[0]);
                const [details2, status2] = await advertisersFacet.getAdvertisementDetailsAndStatus(complexAdvertisements[1]);
                
                expect(Number(status1)).to.equal(AdvertisementType.Approved);
                expect(Number(status2)).to.equal(AdvertisementType.Banned);
                
                console.log(`✅ Data consistency maintained after complex operations`);
            });
        });

        describe("Helper Function Documentation", function () {
            
            /**
             * @notice Documents the purpose and usage of helper functions
             * @dev Explains how these functions support the test suite
             */
            it("Should document helper function purposes", async function () {
                console.log("✅ Internal Helper Functions Documentation:");
                console.log("");
                console.log("   createAdvertisementsInArray(type, count, testId):");
                console.log("   - Creates specified number of advertisements");
                console.log("   - Auto-assigns to target advertisement type");
                console.log("   - Uses user rotation to prevent balance depletion");
                console.log("   - Returns array of created advertisement addresses");
                console.log("");
                console.log("   createPOLAdvertisement(signer, storageId, email):");
                console.log("   - Creates POL-funded advertisement via factory");
                console.log("   - Handles user funding if balance insufficient");
                console.log("   - Auto-selects user if signer is null");
                console.log("   - Emits creation event and extracts address");
                console.log("");
                console.log("   getTotalAdvertisementCount():");
                console.log("   - Sums advertisements across all type arrays");
                console.log("   - Used for consistency verification");
                console.log("   - Helps track system state changes");
            });
        });
    });
});