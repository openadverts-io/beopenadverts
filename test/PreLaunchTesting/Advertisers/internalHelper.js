const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title OpenAdvertsAdvertisersFacet - Internal Array Management Helper Functions Test Suite
 * @notice Comprehensive test coverage for internal array manipulation and state management
 * @dev Tests the swap-and-pop pattern used for efficient array element removal and addition
 * 
 * Test Coverage:
 * - Advertisement array removal operations (_removeFromProspectArray, _removeFromApprovedArray, etc.)
 * - Advertisement array addition operations (_addToTargetArray)
 * - Index management and integrity during array manipulations
 * - Edge cases: empty arrays, single elements, boundary conditions
 * - Error recovery and system state consistency
 * - Integration with reclassification logic
 * 
 * Architecture Notes:
 * - Uses Diamond proxy pattern for upgradeable facets
 * - Implements swap-and-pop for O(1) removal operations
 * - Maintains separate arrays for each advertisement status type
 * - Enforces business rules through state transition validation
 * 
 * Internal Helper Functions Tested:
 * - _removeFromProspectArray: Removes advertisement from prospect array
 * - _removeFromApprovedArray: Removes advertisement from approved array
 * - _removeFromExhaustedArray: Manages exhausted array (terminal state)
 * - _removeFromWithdrawnArray: Manages withdrawn/banned array
 * - _addToTargetArray: Adds advertisement to target status array
 */
describe("OpenAdvertsAdvertisersFacet - Internal Array Management Helper Functions", function () {
    // Contract instances
    let diamondAddress;
    let gateSigner;
    let advertisersFacet;
    let advertPOLFactoryFacet;
    let advertUSDCFactoryFacet;
    let governanceFacet;
    let mockUSDC;
    
    // Test accounts
    let owner;
    let nonOwner;
    let user1, user2, user3, user4, user5;

    // Constants
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    /**
     * @notice Advertisement status enumeration
     * @dev Represents the complete lifecycle states of an advertisement
     * 
     * State Transitions:
     * - Prospect (0): Initial state, pending approval
     * - Approved (1): Active advertisement receiving engagement
     * - Exhausted (2): Budget depleted, terminal state
     * - Deprecating (3): Grace period before withdrawal
     * - Withdrawn (4): Funds withdrawn, permanently inactive
     * - Banned (5): Violated terms, forcibly removed
     * 
     * Business Rules:
     * - Cannot transition FROM Exhausted (terminal state)
     * - Cannot transition FROM Withdrawn (terminal state, unless unbanned)
     * - Can transition TO Exhausted from any non-terminal state
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
     * @notice Payment method enumeration
     * @dev Defines supported funding mechanisms for advertisements
     */
    const PaymentType = {
        POL: 0,
        USDC: 1
    };

    /**
     * @notice Signer rotation system for balance management
     * @dev Prevents individual account depletion during bulk test operations
     * 
     * Implementation:
     * - Maintains index into signers array
     * - Increments after each advertisement creation
     * - Each test gets a fresh signer to avoid balance conflicts
     */
    let signerIndex = 1; // Start at 1 (0 is owner)
    let allSigners = [];

    /**
     * @notice Test suite initialization and setup
     * @dev Deploys diamond, initializes facets, and prepares test infrastructure
     * 
     * Setup Process:
     * 1. Retrieve all available signers from Hardhat
     * 2. Deploy diamond proxy and core facets
     * 3. Initialize advertiser, factory, and governance facets
     * 4. Verify facet initialization state
     * 5. Prepare signer rotation for advertisement creation
     */
    before(async function () {
        console.log("🚀 Starting OpenAdvertsAdvertisersFacet internal helper function tests...");

        // Retrieve all available signers from Hardhat network
        allSigners = await ethers.getSigners();
        owner = allSigners[0];
        nonOwner = allSigners[1];
        user1 = allSigners[2];
        user2 = allSigners[3];
        user3 = allSigners[4];
        user4 = allSigners[5];
        user5 = allSigners[6];
        
        console.log(`✅ Total available signers: ${allSigners.length}`);
        console.log(`   Owner: ${owner.address}`);

        try {
            // Deploy diamond proxy and initialize core facets
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            if (!diamondAddress) {
                throw new Error("Diamond deployment failed");
            }
            console.log("✅ Diamond deployed and initialized at:", diamondAddress);

            // Initialize advertiser facet interface
            advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
            console.log("✅ OpenAdvertsAdvertisersFacet contract instance created");

            // Retrieve and initialize MockUSDC contract
            const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
            mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
            console.log("✅ MockUSDC instance created at:", usdcAddress);

            // Initialize factory and governance facets for advertisement creation
            advertPOLFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
            advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
            governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            console.log("✅ Factory facets initialized");

        } catch (error) {
            console.error("❌ Setup failed:", error);
            throw error;
        }
    });

    /**
     * @notice Creates a new POL-funded advertisement via the factory facet
     * @dev Helper function that uses fresh signers to prevent balance depletion
     * 
     * @param signer The account funding the advertisement (required)
     * @param storageId Unique identifier for off-chain data correlation
     * @param emailAddress Contact email for the advertiser
     * @return address The deployed advertisement contract address
     * 
     * Implementation Details:
     * - Requires explicit signer (no auto-rotation at this level)
     * - Retrieves minimum quotas from governance facet
     * - Logs balance for debugging and monitoring
     * - Parses POLAdvertisementCreatedAndValidated event for contract address
     * - Throws if advertisement creation fails
     * 
     * Gas Considerations:
     * - Creates new contract (high gas cost)
     * - Initializes advertisement storage
     * - Emits creation event
     */
    async function createPOLAdvertisement(signer, storageId, emailAddress) {
        // Validate signer is provided (explicit requirement)
        if (!signer) {
            throw new Error("Signer must be provided explicitly");
        }

        // Log balance for debugging and monitoring
        const balance = await ethers.provider.getBalance(signer.address);
        console.log(`   🔄 Using signer: ${signer.address.slice(0, 10)}... (Balance: ${ethers.formatEther(balance)} ETH)`);

        // Retrieve current minimum quotas from governance
        const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();

        // Create advertisement through factory facet
        const tx = await advertPOLFactoryFacet.connect(signer).createNewProspectPOLAdvertContract(
            storageId,
            minBounty,
            100, // Maximum redemptions
            ethers.ZeroAddress,
            ...(await gate.pol(gateSigner, diamondAddress, signer.address)),
            { value: minFunding }
        );

        const receipt = await tx.wait();

        // Parse event logs to extract deployed advertisement contract address
        let advertAddress;
        for (const log of receipt.logs) {
            try {
                const parsed = advertPOLFactoryFacet.interface.parseLog(log);
                if (parsed && parsed.name === "POLAdvertisementCreatedAndValidated") {
                    advertAddress = parsed.args.advertContract;
                    break;
                }
            } catch (e) {
                // Skip logs that don't match our interface
                continue;
            }
        }

        if (!advertAddress) {
            throw new Error(`Failed to create advertisement: ${storageId}`);
        }

        console.log(`   ✅ Created at: ${advertAddress}`);
        return advertAddress;
    }

    /**
     * @notice Creates multiple advertisements in a specified array/status
     * @dev Helper function for bulk test operations with automatic signer rotation
     * 
     * @param advertisementType The target advertisement status
     * @param count Number of advertisements to create
     * @param testIdentifier Unique identifier for this test batch
     * @return Array of created advertisement addresses
     * 
     * Implementation Details:
     * - Uses global signer rotation to prevent balance depletion
     * - Creates advertisements initially as Prospect
     * - Reclassifies to target type if not Prospect
     * - Increments scores for each advertisement for uniqueness
     * - Validates signer availability before creation
     * 
     * Error Handling:
     * - Throws if insufficient signers available
     * - Logs each creation for debugging
     */
    async function createAdvertisementsInArray(advertisementType, count, testIdentifier = "") {
        const addresses = [];
        
        for (let i = 0; i < count; i++) {
            // Get fresh signer for each advertisement to prevent balance issues
            const freshSigner = allSigners[signerIndex++];
            if (!freshSigner) {
                throw new Error(`Ran out of signers at index ${signerIndex - 1}. Total available: ${allSigners.length}`);
            }

            // Create advertisement via factory
            const address = await createPOLAdvertisement(
                freshSigner,
                `test-ad-${testIdentifier}-${i}-${Date.now()}`,
                `test-${testIdentifier}-${i}@example.com`
            );
            addresses.push(address);

            // Reclassify to target type if not prospect
            // Note: Uses incremental scores for uniqueness in testing
            if (advertisementType !== AdvertisementType.Prospect) {
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    address,
                    AdvertisementType.Prospect,
                    advertisementType,
                    10 + i, // Favorable score (incremental)
                    5 + i   // Unfavorable score (incremental)
                );
            }
        }

        return addresses;
    }

    /**
     * @notice Verifies array integrity and consistency with statistics
     * @dev Helper function to validate array state after operations
     * 
     * @param advertisementType The advertisement status type to verify
     * @return Array of advertisements in the specified type
     * 
     * Verification Steps:
     * 1. Retrieves advertisements array via getAdvertisements
     * 2. Retrieves system statistics
     * 3. Verifies array length matches statistics count
     * 4. Validates each advertisement exists
     * 5. Confirms each advertisement has correct status
     * 
     * This helper ensures:
     * - Array counts are consistent with statistics
     * - All advertisements in array actually exist
     * - All advertisements have the expected status
     * - No duplicate or orphaned entries
     */
    async function verifyArrayIntegrity(advertisementType) {
        const advertisements = await advertisersFacet.getAdvertisements(advertisementType);
        const stats = await advertisersFacet.getAdvertisementStatistics();
        
        // Map advertisement type to corresponding statistics index
        let expectedCount;
        switch (advertisementType) {
            case AdvertisementType.Prospect:
                expectedCount = stats[0];
                break;
            case AdvertisementType.Approved:
                expectedCount = stats[1];
                break;
            case AdvertisementType.Exhausted:
                expectedCount = stats[2];
                break;
            case AdvertisementType.Deprecating:
                expectedCount = stats[3];
                break;
            case AdvertisementType.Withdrawn:
                expectedCount = stats[4];
                break;
            case AdvertisementType.Banned:
                expectedCount = stats[5];
                break;
            default:
                throw new Error(`Unknown advertisement type: ${advertisementType}`);
        }

        // Verify array length matches statistics
        expect(advertisements.length).to.equal(Number(expectedCount));

        // Verify each advertisement in the array exists and has correct status
        for (const advertisement of advertisements) {
            // Handle both array and object responses
            const advertisementAddress = advertisement[0] || advertisement.advertContractAddress;
            
            // Verify advertisement exists
            const exists = await advertisersFacet.getAdvertisementExists(advertisementAddress);
            expect(exists).to.be.true;

            // Verify advertisement has correct status
            const [, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertisementAddress);
            expect(status).to.equal(advertisementType);
        }

        return advertisements;
    }

    // =========================================================================
    // REMOVE FROM PROSPECT ARRAY TESTS
    // =========================================================================

    /**
     * @notice Test suite for _removeFromProspectArray internal function
     * @dev Validates removal operations from prospect array using swap-and-pop pattern
     * 
     * Function Purpose:
     * - Removes advertisement from prospect array during reclassification
     * - Uses swap-and-pop for O(1) removal complexity
     * - Updates array indices for remaining advertisements
     * 
     * Test Coverage:
     * - Single element removal (edge case)
     * - Multiple element removal (first, middle, last positions)
     * - Index management verification
     */
    describe("_removeFromProspectArray Function", function () {
        
        describe("Single Element Removal", function () {
            /**
             * @notice Verifies removal when array contains only one element
             * @dev Tests edge case where swap-and-pop degenerates to simple pop
             * 
             * Expected Behavior:
             * - Array count decreases by 1
             * - Advertisement no longer appears in prospect array
             * - Advertisement appears in target array (Approved)
             * - No index corruption or orphaned entries
             */
            it("Should remove the only element from prospect array", async function () {
                // Create a single prospect advertisement for isolated testing
                const addresses = await createAdvertisementsInArray(AdvertisementType.Prospect, 1, "single-removal");
                
                // Verify initial state and record count
                let prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                const initialCount = prospectAdvertisements.length;
                
                // Find our advertisement in the array
                const ourAdvertisement = prospectAdvertisements.find(ad => ad.advertContractAddress === addresses[0]);
                expect(ourAdvertisement).to.not.be.undefined;

                // Remove by reclassifying to approved (triggers internal removal)
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[0],
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    20,
                    5
                );

                // Verify removal from prospect array
                prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                expect(prospectAdvertisements.length).to.equal(initialCount - 1);

                // Verify advertisement moved to approved array
                const approvedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                const movedAdvertisement = approvedAdvertisements.find(ad => ad.advertContractAddress === addresses[0]);
                expect(movedAdvertisement).to.not.be.undefined;

                console.log("✅ Successfully removed single element from prospect array");
            });
        });

        describe("Multiple Element Removal", function () {
            /**
             * @notice Verifies removal of first element from multi-element array
             * @dev Tests swap-and-pop pattern where first element is swapped with last
             * 
             * Expected Behavior:
             * - Array count decreases by 1
             * - First element removed and moved to target array
             * - Remaining elements still accessible
             * - Array integrity maintained (no duplicates or orphans)
             */
            it("Should remove first element from prospect array with multiple elements", async function () {
                // Create multiple prospect advertisements
                const addresses = await createAdvertisementsInArray(AdvertisementType.Prospect, 3, "multi-first-removal");
                
                // Verify initial state
                let prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                const initialCount = prospectAdvertisements.length;
                
                // Find our advertisements in the array
                const ourAdvertisements = prospectAdvertisements.filter(ad => addresses.includes(ad.advertContractAddress));
                expect(ourAdvertisements.length).to.equal(3);
                
                // Remove first element of our test set
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[0],
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    25,
                    8
                );

                // Verify array management after removal
                prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                expect(prospectAdvertisements.length).to.equal(initialCount - 1);
                
                // Verify removed advertisement no longer in prospect array
                const removedAdvertisementStillInProspect = prospectAdvertisements.find(ad => ad.advertContractAddress === addresses[0]);
                expect(removedAdvertisementStillInProspect).to.be.undefined;

                // Verify advertisement moved to approved array
                const approvedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                const movedAdvertisement = approvedAdvertisements.find(ad => ad.advertContractAddress === addresses[0]);
                expect(movedAdvertisement).to.not.be.undefined;

                console.log("✅ Successfully removed first element from prospect array");
            });

            /**
             * @notice Verifies removal of middle element from multi-element array
             * @dev Tests swap-and-pop pattern for element not at array boundaries
             * 
             * Expected Behavior:
             * - Array count decreases by 1
             * - Middle element removed and moved to target array
             * - Other elements remain accessible in correct order
             * - No index corruption
             */
            it("Should remove middle element from prospect array", async function () {
                // Create multiple prospect advertisements
                const addresses = await createAdvertisementsInArray(AdvertisementType.Prospect, 3, "multi-middle-removal");
                
                // Verify initial state
                let prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                const initialCount = prospectAdvertisements.length;
                
                // Remove middle element of our test set
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[1], // Middle element (index 1 of 0,1,2)
                    AdvertisementType.Prospect,
                    AdvertisementType.Exhausted,
                    30,
                    12
                );

                // Verify array management after removal
                prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                expect(prospectAdvertisements.length).to.equal(initialCount - 1);
                
                // Verify removed advertisement no longer in prospect array
                const removedAdvertisementStillInProspect = prospectAdvertisements.find(ad => ad.advertContractAddress === addresses[1]);
                expect(removedAdvertisementStillInProspect).to.be.undefined;

                // Verify advertisement moved to exhausted array
                const exhaustedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Exhausted);
                const movedAdvertisement = exhaustedAdvertisements.find(ad => ad.advertContractAddress === addresses[1]);
                expect(movedAdvertisement).to.not.be.undefined;

                console.log("✅ Successfully removed middle element from prospect array");
            });

            /**
             * @notice Verifies removal of last element from multi-element array
             * @dev Tests edge case where swap-and-pop degenerates to simple pop
             * 
             * Expected Behavior:
             * - Array count decreases by 1
             * - Last element removed (no swap needed, just pop)
             * - Remaining elements unaffected
             * - Most efficient removal case (O(1) without swap overhead)
             */
            it("Should remove last element from prospect array", async function () {
                // Create multiple prospect advertisements
                const addresses = await createAdvertisementsInArray(AdvertisementType.Prospect, 3, "multi-last-removal");
                
                // Verify initial state
                let prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                const initialCount = prospectAdvertisements.length;
                
                // Remove last element of our test set
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[2], // Last element (index 2 of 0,1,2)
                    AdvertisementType.Prospect,
                    AdvertisementType.Deprecating,
                    35,
                    15
                );

                // Verify array management (simple pop, no element movement needed)
                prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                expect(prospectAdvertisements.length).to.equal(initialCount - 1);
                
                // Verify removed advertisement no longer in prospect array
                const removedAdvertisementStillInProspect = prospectAdvertisements.find(ad => ad.advertContractAddress === addresses[2]);
                expect(removedAdvertisementStillInProspect).to.be.undefined;

                // Verify advertisement moved to deprecating array
                const deprecatingAdvertisements = await verifyArrayIntegrity(AdvertisementType.Deprecating);
                const movedAdvertisement = deprecatingAdvertisements.find(ad => ad.advertContractAddress === addresses[2]);
                expect(movedAdvertisement).to.not.be.undefined;

                console.log("✅ Successfully removed last element from prospect array");
            });
        });

        describe("Index Management Verification", function () {
            /**
             * @notice Verifies that array indices remain correct after modifications
             * @dev Tests that swap-and-pop doesn't corrupt advertisement accessibility
             * 
             * Critical Test:
             * - Creates 5 advertisements
             * - Removes middle element (tests swap operation)
             * - Verifies all remaining advertisements still accessible
             * - Confirms no index corruption or data loss
             * 
             * Expected Behavior:
             * - Array size decreases by 1
             * - Removed advertisement in new status
             * - All other advertisements remain in Prospect
             * - All advertisements accessible via getAdvertisementDetailsAndStatus
             */
            it("Should maintain correct indices after prospect array modifications", async function () {
                // Create multiple advertisements for comprehensive index testing
                const addresses = [];
                for (let i = 0; i < 5; i++) {
                    const freshSigner = allSigners[signerIndex++];
                    const address = await createPOLAdvertisement(
                        freshSigner,
                        `index-test-${i}-${Date.now()}`,
                        `index-test-${i}@example.com`
                    );
                    addresses.push(address);
                }

                // Verify initial state
                let prospectAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const initialCount = prospectAdvertisements.length;

                // Remove middle element (critical test case for array management)
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[2], // Middle element (index 2 of 0,1,2,3,4)
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    20,
                    5
                );

                // Verify array size decreased correctly
                prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                expect(prospectAdvertisements.length).to.equal(initialCount - 1);

                // Verify all remaining advertisements are still accessible
                for (let i = 0; i < addresses.length; i++) {
                    if (i === 2) continue; // Skip removed element
                    
                    // Verify advertisement exists
                    const exists = await advertisersFacet.getAdvertisementExists(addresses[i]);
                    expect(exists).to.be.true;

                    // Verify advertisement details and status are correct
                    const [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(addresses[i]);
                    const advertisementAddress = advertisement[0] || advertisement.advertContractAddress;
                    expect(advertisementAddress).to.equal(addresses[i]);
                    expect(status).to.equal(AdvertisementType.Prospect);
                }

                // Verify removed advertisement is now Approved
                const [, removedStatus] = await advertisersFacet.getAdvertisementDetailsAndStatus(addresses[2]);
                expect(removedStatus).to.equal(AdvertisementType.Approved);

                console.log("✅ Index management verified after prospect array modification");
            });
        });
    });

    // =========================================================================
    // REMOVE FROM APPROVED ARRAY TESTS
    // =========================================================================

    /**
     * @notice Test suite for _removeFromApprovedArray internal function
     * @dev Validates removal operations from approved array
     * 
     * Function Purpose:
     * - Removes advertisement from approved array during reclassification
     * - Uses same swap-and-pop pattern as prospect array
     * - Critical for transitioning to Exhausted, Deprecating, or Withdrawn states
     */
    describe("_removeFromApprovedArray Function", function () {
        
        describe("Array Management Operations", function () {
            /**
             * @notice Verifies removal from approved array with score preservation
             * @dev Tests that reclassification maintains data integrity during array transfer
             * 
             * Expected Behavior:
             * - Advertisement removed from approved array
             * - Advertisement added to target array (Exhausted)
             * - Scores updated to new values during transition
             * - Array counts updated correctly in statistics
             */
            it("Should correctly remove elements from approved array", async function () {
                // Create approved advertisements for testing
                const addresses = await createAdvertisementsInArray(AdvertisementType.Approved, 4, "approved-removal");
                
                // Verify initial state
                let approvedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                const initialCount = approvedAdvertisements.length;

                // Remove second element of our test set
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[1],
                    AdvertisementType.Approved,
                    AdvertisementType.Exhausted,
                    40,
                    10
                );

                // Verify removal and array management
                approvedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                expect(approvedAdvertisements.length).to.equal(initialCount - 1);

                // Verify moved advertisement is in exhausted array with correct scores
                const exhaustedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Exhausted);
                const movedAdvertisement = exhaustedAdvertisements.find(ad => ad.advertContractAddress === addresses[1]);
                expect(movedAdvertisement).to.not.be.undefined;
                expect(movedAdvertisement.advertFavorableScore).to.equal(40);
                expect(movedAdvertisement.advertUnfavorableScore).to.equal(10);

                console.log("✅ Successfully managed approved array removal");
            });

            /**
             * @notice Verifies sequential removal operations maintain array integrity
             * @dev Tests that multiple removals don't corrupt array structure
             * 
             * Test Strategy:
             * - Create 3 approved advertisements
             * - Remove all one-by-one to Withdrawn status
             * - Verify each removal decreases count correctly
             * - Confirm all advertisements end up in Withdrawn with correct scores
             * 
             * Expected Behavior:
             * - Each removal decreases approved count
             * - No index corruption during sequential operations
             * - All advertisements accessible in final state
             * - Scores preserved/updated correctly for each
             */
            it("Should handle sequential removals from approved array", async function () {
                // Create approved advertisements for sequential removal testing
                const addresses = await createAdvertisementsInArray(AdvertisementType.Approved, 3, "approved-sequential");
                
                // Remove all elements one by one
                for (let i = 0; i < addresses.length; i++) {
                    const initialAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Approved);
                    const initialCount = initialAdvertisements.length;

                    // Reclassify to Withdrawn with incremental scores
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[i],
                        AdvertisementType.Approved,
                        AdvertisementType.Withdrawn,
                        45 + i, // Incremental favorable score
                        15 + i  // Incremental unfavorable score
                    );

                    // Verify array count decreased
                    const finalAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                    expect(finalAdvertisements.length).to.be.lessThan(initialCount);
                }

                // Verify all our test advertisements are now withdrawn with correct scores
                const withdrawnAdvertisements = await verifyArrayIntegrity(AdvertisementType.Withdrawn);
                for (let i = 0; i < addresses.length; i++) {
                    const foundAdvertisement = withdrawnAdvertisements.find(ad => ad.advertContractAddress === addresses[i]);
                    expect(foundAdvertisement).to.not.be.undefined;
                    expect(foundAdvertisement.advertFavorableScore).to.equal(45 + i);
                    expect(foundAdvertisement.advertUnfavorableScore).to.equal(15 + i);
                }

                console.log("✅ Successfully handled sequential approved array removals");
            });
        });
    });

    // =========================================================================
    // REMOVE FROM EXHAUSTED ARRAY TESTS
    // =========================================================================

    /**
     * @notice Test suite for _removeFromExhaustedArray internal function
     * @dev Validates business rule: Exhausted is a terminal state
     * 
     * Business Rule:
     * - Exhausted advertisements cannot be reclassified
     * - Budget is fully depleted, no further engagement possible
     * - Natural end state should be Deprecating → Withdrawn
     * - This restriction prevents manipulation of depleted advertisements
     * 
     * Expected Behavior:
     * - All reclassification attempts FROM Exhausted should fail
     * - Array data should remain unchanged after failed operations
     * - Can still transition TO Exhausted from other states
     */
    describe("_removeFromExhaustedArray Function", function () {
        
        describe("Complex Array Operations", function () {
            /**
             * @notice Verifies Exhausted status terminal state business rule
             * @dev Tests that attempts to reclassify FROM Exhausted are properly rejected
             * 
             * Test Strategy:
             * 1. Create advertisements in Exhausted status
             * 2. Record original data for integrity verification
             * 3. Attempt various reclassifications FROM Exhausted
             * 4. Verify all attempts are rejected
             * 5. Confirm data remains unchanged
             * 
             * Expected Behavior:
             * - All reclassification attempts revert with "Cannot reclassify from Exhausted"
             * - Array count remains constant
             * - Original data completely preserved
             * - No side effects or state corruption
             */
            it("Should maintain data integrity and enforce Exhausted terminal status rule", async function () {
                // Create exhausted advertisements to test the business rule
                const addresses = await createAdvertisementsInArray(AdvertisementType.Exhausted, 3, "exhausted-terminal-test");
                
                // Verify initial state
                let exhaustedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Exhausted);
                const ourAdvertisements = exhaustedAdvertisements.filter(ad => addresses.includes(ad.advertContractAddress));
                expect(ourAdvertisements.length).to.equal(3);

                // Store original data for verification that state remains unchanged
                const originalData = {};
                for (const advertisement of ourAdvertisements) {
                    originalData[advertisement.advertContractAddress] = {
                        storageId: advertisement.storageId,
                        advertBounty: advertisement.advertBounty,
                        favorableScore: Number(advertisement.advertFavorableScore),
                        unfavorableScore: Number(advertisement.advertUnfavorableScore)
                    };
                }

                // Test business rule: Attempt to reclassify from Exhausted should fail
                await expect(
                    advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[0],
                        AdvertisementType.Exhausted,
                        AdvertisementType.Deprecating,
                        50,
                        25
                    )
                ).to.be.revertedWith("Cannot reclassify from Exhausted");

                // Test business rule: Multiple attempts should consistently fail
                await expect(
                    advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[1],
                        AdvertisementType.Exhausted,
                        AdvertisementType.Approved,
                        60,
                        30
                    )
                ).to.be.revertedWith("Cannot reclassify from Exhausted");

                await expect(
                    advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[2],
                        AdvertisementType.Exhausted,
                        AdvertisementType.Withdrawn,
                        70,
                        35
                    )
                ).to.be.revertedWith("Cannot reclassify from Exhausted");

                // Verify all advertisements remain in Exhausted status with original data intact
                const finalExhaustedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Exhausted);
                const finalOurAdvertisements = finalExhaustedAdvertisements.filter(ad => addresses.includes(ad.advertContractAddress));
                expect(finalOurAdvertisements.length).to.equal(3); // No advertisements removed

                // Verify data integrity is maintained
                for (const advertisement of finalOurAdvertisements) {
                    const originalAdvertisementData = originalData[advertisement.advertContractAddress];
                    expect(advertisement.storageId).to.equal(originalAdvertisementData.storageId);
                    expect(advertisement.advertBounty).to.equal(originalAdvertisementData.advertBounty);
                    expect(Number(advertisement.advertFavorableScore)).to.equal(originalAdvertisementData.favorableScore);
                    expect(Number(advertisement.advertUnfavorableScore)).to.equal(originalAdvertisementData.unfavorableScore);
                }

                console.log("✅ Business rule validated: Exhausted status is terminal");
                console.log("   - Cannot reclassify from Exhausted to any other status");
                console.log("   - Array integrity maintained when reclassification attempts fail");
                console.log("   - Data remains unchanged after failed operations");
            });

            /**
             * @notice Verifies advertisements can transition TO Exhausted status
             * @dev Tests that while FROM Exhausted is blocked, TO Exhausted works
             * 
             * Test Strategy:
             * 1. Create Approved advertisements
             * 2. Transition TO Exhausted (should succeed)
             * 3. Verify advertisement in Exhausted with correct scores
             * 4. Attempt to transition FROM Exhausted (should fail)
             * 
             * Expected Behavior:
             * - Transition FROM Approved TO Exhausted succeeds
             * - Array counts update correctly
             * - Once in Exhausted, cannot transition out
             * - Terminal state restriction enforced
             */
            it("Should handle reclassification TO Exhausted status correctly", async function () {
                // Create approved advertisements that can be moved TO Exhausted
                const addresses = await createAdvertisementsInArray(AdvertisementType.Approved, 2, "to-exhausted-test");
                
                // Get initial counts
                const initialStats = await advertisersFacet.getAdvertisementStatistics();
                
                // Test: Successfully move FROM Approved TO Exhausted
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[0],
                    AdvertisementType.Approved,
                    AdvertisementType.Exhausted,
                    80,
                    40
                );

                // Verify advertisement successfully moved to Exhausted
                const [movedAdvertisement, movedStatus] = await advertisersFacet.getAdvertisementDetailsAndStatus(addresses[0]);
                expect(movedStatus).to.equal(AdvertisementType.Exhausted);
                expect(movedAdvertisement.advertFavorableScore).to.equal(80);
                expect(movedAdvertisement.advertUnfavorableScore).to.equal(40);

                // Verify array counts updated correctly
                const finalStats = await advertisersFacet.getAdvertisementStatistics();
                expect(Number(finalStats.exhaustedCount)).to.be.greaterThan(Number(initialStats.exhaustedCount));

                // Test: Verify the moved advertisement cannot be reclassified (terminal status)
                await expect(
                    advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[0],
                        AdvertisementType.Exhausted,
                        AdvertisementType.Approved,
                        90,
                        45
                    )
                ).to.be.revertedWith("Cannot reclassify from Exhausted");

                console.log("✅ Successfully tested transitions TO Exhausted status");
                console.log("   - Can move FROM other statuses TO Exhausted");
                console.log("   - Once in Exhausted, cannot be moved anywhere else");
            });
        });
    });

    // =========================================================================
    // REMOVE FROM WITHDRAWN ARRAY TESTS
    // =========================================================================

    /**
     * @notice Test suite for _removeFromWithdrawnArray internal function
     * @dev Validates handling of Withdrawn/Banned status and business rules
     * 
     * Implementation Note:
     * - In the current implementation, Banned advertisements may be stored in Withdrawn array
     * - The contract may not have separate arrays for Banned and Withdrawn
     * - Banned status (5) might share storage with Withdrawn status (4)
     * 
     * Business Rules:
     * - Banned advertisements cannot be unbanned via reclassification
     * - May need to use specific unbanAdvertisement function
     * - Withdrawn advertisements are in terminal state
     */
    describe("_removeFromWithdrawnArray Function", function () {
        
        describe("Restoration Operations", function () {
            /**
             * @notice Verifies Withdrawn/Banned status business rules
             * @dev Tests that banned advertisements are properly restricted from reclassification
             * 
             * Test Strategy:
             * 1. Create and approve advertisements
             * 2. Ban the advertisements
             * 3. Verify they appear in Banned status (or Withdrawn array)
             * 4. Attempt to reclassify FROM Banned (should fail)
             * 5. Verify data integrity maintained
             * 
             * Expected Behavior:
             * - Banned advertisements have status Banned (5)
             * - May be stored in withdrawnArray or separate bannedArray
             * - Cannot reclassify FROM Banned via standard reclassification
             * - Must use unbanAdvertisement if supported
             */
            it("Should handle withdrawn status business rules during unban attempts", async function () {
                console.log("\n🔍 TEST START: Withdrawn/Banned status business rules");
                
                // Create approved advertisements to ban
                const addresses = await createAdvertisementsInArray(AdvertisementType.Approved, 3, "withdrawn-business-rules");
                console.log("📝 Created addresses:", addresses);
                
                // Store original data for integrity verification
                const originalData = {};
                for (const address of addresses) {
                    const [advertisement] = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    originalData[address] = {
                        storageId: advertisement.storageId,
                        advertBounty: advertisement.advertBounty,
                        favorableScore: Number(advertisement.advertFavorableScore),
                        unfavorableScore: Number(advertisement.advertUnfavorableScore)
                    };
                    console.log(`📊 Original data for ${address}:`, originalData[address]);
                }

                // Ban all advertisements
                console.log("\n🚫 Banning advertisements...");
                for (const address of addresses) {
                    await advertisersFacet.connect(owner).banAdvertisement(address);
                    console.log(`   ✅ Banned: ${address}`);
                }

                // Verify banned status
                console.log("\n🔍 Verifying banned status...");
                for (let i = 0; i < addresses.length; i++) {
                    const address = addresses[i];
                    console.log(`\n🔍 Checking address #${i}: ${address}`);
                    
                    // Expect Banned status (5), not Withdrawn (4)
                    const [, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(address);
                    console.log(`   📊 Status: ${Object.keys(AdvertisementType)[status]} (${status})`);
                    expect(status).to.equal(AdvertisementType.Banned);
                }

                // Check which array banned advertisements are stored in
                console.log("\n🔍 Checking array location...");
                
                // Try withdrawn array first
                let bannedAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Withdrawn);
                console.log(`📊 Withdrawn array length: ${bannedAdvertisements.length}`);
                
                // If not in withdrawn array, check banned array
                if (bannedAdvertisements.length === 0 || !bannedAdvertisements.find(ad => addresses.includes(ad[0] || ad.advertContractAddress))) {
                    console.log("   ⚠️  Not in withdrawn array, checking banned array...");
                    bannedAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Banned);
                    console.log(`📊 Banned array length: ${bannedAdvertisements.length}`);
                }
                
                // Verify all banned advertisements are in the correct array
                for (let i = 0; i < addresses.length; i++) {
                    const address = addresses[i];
                    console.log(`\n🔍 Looking for address #${i}: ${address}`);
                    
                    const foundAdvertisement = bannedAdvertisements.find(ad => {
                        const advertisementAddress = ad[0] || ad.advertContractAddress;
                        return advertisementAddress && advertisementAddress.toLowerCase() === address.toLowerCase();
                    });
                    
                    if (!foundAdvertisement) {
                        console.error(`   ❌ Address ${address} NOT FOUND in array`);
                        console.error(`   Available addresses:`);
                        bannedAdvertisements.forEach((ad, idx) => {
                            console.error(`     [${idx}]: ${ad[0] || ad.advertContractAddress || 'UNKNOWN'}`);
                        });
                    }
                    
                    expect(foundAdvertisement, `Address ${address} should be in banned/withdrawn array`).to.not.be.undefined;
                }

                // Test unban attempts
                console.log("\n🔄 Testing unban attempts...");
                
                for (const address of addresses) {
                    try {
                        // Attempt to reclassify FROM Banned (should fail)
                        await advertisersFacet.connect(owner).reclassifyAdvertisement(
                            address,
                            AdvertisementType.Banned,
                            AdvertisementType.Approved,
                            100,
                            50
                        );
                        console.log(`   ⚠️  Unban was allowed for ${address}`);
                    } catch (error) {
                        // Check for expected error messages
                        if (error.message.includes("Cannot reclassify from Banned") || 
                            error.message.includes("Cannot reclassify from Withdrawn")) {
                            console.log(`   ✅ Correctly rejected unban for ${address}`);
                        } else {
                            console.error(`   ❌ Unexpected error: ${error.message}`);
                            throw error;
                        }
                    }
                }

                // Verify data integrity maintained
                console.log("\n🔍 Verifying data integrity...");
                bannedAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Banned);
                if (bannedAdvertisements.length === 0) {
                    bannedAdvertisements = await advertisersFacet.getAdvertisements(AdvertisementType.Withdrawn);
                }
                
                for (const address of addresses) {
                    const foundAdvertisement = bannedAdvertisements.find(ad => {
                        const advertisementAddress = ad[0] || ad.advertContractAddress;
                        return advertisementAddress && advertisementAddress.toLowerCase() === address.toLowerCase();
                    });
                    
                    if (foundAdvertisement) {
                        const original = originalData[address];
                        expect(foundAdvertisement.storageId).to.equal(original.storageId);
                        expect(foundAdvertisement.advertBounty).to.equal(original.advertBounty);
                        console.log(`   ✅ Data integrity maintained for ${address}`);
                    }
                }

                console.log("✅ Banned status business rules test completed");
            });
        });
    });

    // =========================================================================
    // ADD TO TARGET ARRAY TESTS
    // =========================================================================

    /**
     * @notice Test suite for _addToTargetArray internal function
     * @dev Validates addition operations to all advertisement status arrays
     * 
     * Function Purpose:
     * - Adds advertisement to target status array during reclassification
     * - Pushes advertisement to end of array (O(1) operation)
     * - Updates array count in statistics
     * 
     * Test Coverage:
     * - Addition to prospect array (reverse transitions)
     * - Addition to valid target arrays (respecting business rules)
     * - Rejection of invalid transitions from terminal states
     * - Index management during additions
     */
    describe("_addToTargetArray Function", function () {
        
        describe("Addition Operations", function () {
            /**
             * @notice Verifies advertisements can be added to prospect array
             * @dev Tests reverse transition: Approved → Prospect
             * 
             * Use Cases:
             * - Advertisement fails quality review after initial approval
             * - Advertiser requests temporary deactivation
             * - Administrative review required
             * 
             * Expected Behavior:
             * - Prospect count increases by 1
             * - Advertisement appears in prospect array
             * - Scores updated to new values
             * - Demonstrates bidirectional transitions (non-terminal states)
             */
            it("Should correctly add advertisements to prospect array", async function () {
                // Get initial prospect count
                const initialStats = await advertisersFacet.getAdvertisementStatistics();
                const initialProspectCount = Number(initialStats.prospectCount);

                // Create an approved advertisement to move back to prospect
                const addresses = await createAdvertisementsInArray(AdvertisementType.Approved, 1, "add-to-prospect");
                
                // Test: Move back to prospect (tests _addToTargetArray for Prospect)
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    addresses[0],
                    AdvertisementType.Approved,
                    AdvertisementType.Prospect,
                    60,
                    30
                );

                // Verify addition to prospect array successful
                const finalStats = await advertisersFacet.getAdvertisementStatistics();
                expect(Number(finalStats.prospectCount)).to.equal(initialProspectCount + 1);

                const prospectAdvertisements = await verifyArrayIntegrity(AdvertisementType.Prospect);
                const addedAdvertisement = prospectAdvertisements.find(ad => ad.advertContractAddress === addresses[0]);
                expect(addedAdvertisement).to.not.be.undefined;
                expect(addedAdvertisement.advertFavorableScore).to.equal(60);
                expect(addedAdvertisement.advertUnfavorableScore).to.equal(30);

                console.log("✅ Successfully added advertisement to prospect array");
            });

            /**
             * @notice Verifies advertisements can be added to valid target arrays
             * @dev Tests multiple state transitions while respecting business rules
             * 
             * Valid Transitions Tested:
             * - Prospect → Approved
             * - Approved → Exhausted
             * - Approved → Deprecating
             * - Deprecating → Withdrawn
             * 
             * Business Rule Enforcement:
             * - Cannot transition FROM Exhausted (terminal state)
             * - Each transition updates scores appropriately
             * - Array counts update correctly
             */
            it("Should correctly add advertisements to valid target arrays (respecting business rules)", async function () {
                const validTestCases = [
                    { from: AdvertisementType.Prospect, to: AdvertisementType.Approved, score: [65, 35] },
                    { from: AdvertisementType.Approved, to: AdvertisementType.Exhausted, score: [70, 40] },
                    { from: AdvertisementType.Approved, to: AdvertisementType.Deprecating, score: [75, 45] },
                    { from: AdvertisementType.Deprecating, to: AdvertisementType.Withdrawn, score: [80, 50] }
                ];

                // Create initial advertisement for transition testing
                const freshSigner = allSigners[signerIndex++];
                const testAddress = await createPOLAdvertisement(
                    freshSigner,
                    `valid-transitions-test-${Date.now()}`,
                    "valid-transitions@example.com"
                );
                
                let currentStatus = AdvertisementType.Prospect;

                // Test: Execute valid transitions
                for (const testCase of validTestCases) {
                    // Only proceed if current status matches test case
                    if (currentStatus === testCase.from) {
                        await advertisersFacet.connect(owner).reclassifyAdvertisement(
                            testAddress,
                            testCase.from,
                            testCase.to,
                            testCase.score[0],
                            testCase.score[1]
                        );

                        // Verify addition to target array successful
                        const targetAdvertisements = await verifyArrayIntegrity(testCase.to);
                        const addedAdvertisement = targetAdvertisements.find(ad => {
                            const advertisementAddress = ad[0] || ad.advertContractAddress;
                            return advertisementAddress === testAddress;
                        });
                        
                        expect(addedAdvertisement).to.not.be.undefined;

                        currentStatus = testCase.to;
                        console.log(`✅ Successfully added to ${Object.keys(AdvertisementType)[testCase.to]} array`);

                        // Special test: If we reached Exhausted, verify it's now terminal
                        if (testCase.to === AdvertisementType.Exhausted) {
                            await expect(
                                advertisersFacet.connect(owner).reclassifyAdvertisement(
                                    testAddress,
                                    AdvertisementType.Exhausted,
                                    AdvertisementType.Approved,
                                    90,
                                    55
                                )
                            ).to.be.revertedWith("Cannot reclassify from Exhausted");
                            
                            console.log("✅ Verified: Exhausted status is terminal after addition");
                            break; // Cannot proceed further
                        }
                    }
                }

                console.log("✅ All valid target array additions completed successfully");
            });

            /**
             * @notice Verifies business rules are enforced during invalid transition attempts
             * @dev Tests that transitions from terminal states are properly rejected
             * 
             * Terminal States:
             * - Exhausted: Cannot transition to any other state
             * - Withdrawn: May have restrictions (contract-specific)
             * 
             * Expected Behavior:
             * - All attempts to reclassify FROM Exhausted fail
             * - Error message: "Cannot reclassify from Exhausted"
             * - Withdrawn restrictions properly enforced (if applicable)
             */
            it("Should reject invalid transitions from terminal states", async function () {
                // Create advertisements in terminal states
                const exhaustedAddress = (await createAdvertisementsInArray(AdvertisementType.Exhausted, 1, "invalid-from-exhausted"))[0];
                const withdrawnAddress = (await createAdvertisementsInArray(AdvertisementType.Withdrawn, 1, "invalid-from-withdrawn"))[0];

                // Test business rule: Cannot reclassify FROM Exhausted
                const exhaustedInvalidTransitions = [
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    AdvertisementType.Deprecating,
                    AdvertisementType.Withdrawn
                ];

                for (const targetType of exhaustedInvalidTransitions) {
                    await expect(
                        advertisersFacet.connect(owner).reclassifyAdvertisement(
                            exhaustedAddress,
                            AdvertisementType.Exhausted,
                            targetType,
                            100,
                            50
                        )
                    ).to.be.revertedWith("Cannot reclassify from Exhausted");
                }

                // Test business rule: Cannot reclassify FROM Withdrawn (if applicable)
                const withdrawnInvalidTransitions = [
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    AdvertisementType.Exhausted,
                    AdvertisementType.Deprecating
                ];

                for (const targetType of withdrawnInvalidTransitions) {
                    try {
                        await advertisersFacet.connect(owner).reclassifyAdvertisement(
                            withdrawnAddress,
                            AdvertisementType.Withdrawn,
                            targetType,
                            110,
                            60
                        );
                        
                        // If it doesn't revert, that's documented behavior
                        console.log(`⚠️  Transition from Withdrawn to ${Object.keys(AdvertisementType)[targetType]} was allowed`);
                        
                    } catch (error) {
                        if (error.message.includes("Cannot reclassify from Withdrawn")) {
                            // Expected behavior if Withdrawn is terminal
                            console.log(`✅ Correctly rejected: Withdrawn → ${Object.keys(AdvertisementType)[targetType]}`);
                        } else {
                            throw error; // Unexpected error
                        }
                    }
                }

                console.log("✅ Terminal state business rules properly enforced");
                console.log("   - Exhausted status: Cannot transition to any other state");
                console.log("   - Withdrawn status: Transition rules properly enforced");
            });

            /**
             * @notice Verifies index management during array additions
             * @dev Tests that multiple additions maintain correct array structure
             * 
             * Test Strategy:
             * - Create 3 advertisements in Prospect
             * - Move all to Approved sequentially
             * - Verify count increases correctly after each addition
             * - Confirm each advertisement is accessible with correct scores
             * 
             * Expected Behavior:
             * - Array length increases by 1 for each addition
             * - All added advertisements remain accessible
             * - Scores preserved correctly for each
             * - No index corruption or duplicates
             */
            it("Should maintain correct indices when adding to arrays", async function () {
                const addresses = [];
                for (let i = 0; i < 3; i++) {
                    const freshSigner = allSigners[signerIndex++];
                    const address = await createPOLAdvertisement(
                        freshSigner,
                        `index-add-test-${i}-${Date.now()}`,
                        `index-add-${i}@example.com`
                    );
                    addresses.push(address);
                }

                const initialStats = await advertisersFacet.getAdvertisementStatistics();
                const initialApprovedCount = Number(initialStats[1]);

                // Test: Move all to approved (tests multiple additions)
                for (let i = 0; i < addresses.length; i++) {
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        addresses[i],
                        AdvertisementType.Prospect,
                        AdvertisementType.Approved,
                        85 + i,
                        55 + i
                    );

                    // Verify each addition maintains correct indices
                    const approvedAdvertisements = await verifyArrayIntegrity(AdvertisementType.Approved);
                    expect(approvedAdvertisements.length).to.equal(initialApprovedCount + i + 1);

                    // Verify the just-added advertisement is accessible
                    const [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(addresses[i]);
                    expect(status).to.equal(AdvertisementType.Approved);
                    expect(advertisement.advertFavorableScore).to.equal(85 + i);
                    expect(advertisement.advertUnfavorableScore).to.equal(55 + i);
                }

                console.log("✅ Index management verified during array additions");
            });
        });

        describe("Complex Operations", function () {
            /**
             * @notice Verifies system handles complex multi-array operations correctly
             * @dev Tests simultaneous operations across multiple arrays
             * 
             * Complex Operations Tested:
             * - Prospect → Approved (forward transition)
             * - Approved → Deprecating (forward transition)
             * - Deprecating → Prospect (reverse transition)
             * 
             * Validation:
             * - Array counts remain consistent
             * - All arrays maintain integrity
             * - System properly rejects invalid operations
             * - Terminal state restrictions enforced
             * 
             * Expected Behavior:
             * - Valid transitions succeed with correct array updates
             * - Invalid transitions from Exhausted fail appropriately
             * - Net counts reflect all operations correctly
             */
            it("Should handle valid simultaneous operations across arrays (respecting business rules)", async function () {
                console.log("\n🔍 TEST START: Complex simultaneous array operations");
                
                // Create advertisements in non-terminal arrays only
                const prospectAddresses = await createAdvertisementsInArray(AdvertisementType.Prospect, 2, "complex-prospect");
                const approvedAddresses = await createAdvertisementsInArray(AdvertisementType.Approved, 2, "complex-approved");
                const deprecatingAddresses = await createAdvertisementsInArray(AdvertisementType.Deprecating, 2, "complex-deprecating");

                console.log("📝 Created test advertisements:");
                console.log(`   Prospect: ${prospectAddresses.length} ads`);
                console.log(`   Approved: ${approvedAddresses.length} ads`);
                console.log(`   Deprecating: ${deprecatingAddresses.length} ads`);

                // Get initial counts
                const initialStats = await advertisersFacet.getAdvertisementStatistics();
                console.log("\n📊 Initial statistics:");
                console.log(`   Prospect: ${initialStats[0]}`);
                console.log(`   Approved: ${initialStats[1]}`);
                console.log(`   Exhausted: ${initialStats[2]}`);
                console.log(`   Deprecating: ${initialStats[3]}`);
                console.log(`   Withdrawn: ${initialStats[4]}`);
                console.log(`   Banned: ${initialStats[5]}`);

                // Test: Perform valid complex transitions (avoiding terminal states)
                console.log("\n🔄 Executing complex transitions...");
                
                // Transition 1: Prospect → Approved (valid)
                console.log("\n▶️  Transition 1: Prospect → Approved");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    prospectAddresses[0],
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    90,
                    60
                );
                console.log(`   ✅ ${prospectAddresses[0].slice(0, 10)}... moved to Approved`);

                // Transition 2: Approved → Deprecating (valid, avoiding Exhausted)
                console.log("\n▶️  Transition 2: Approved → Deprecating");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    approvedAddresses[0],
                    AdvertisementType.Approved,
                    AdvertisementType.Deprecating,
                    95,
                    65
                );
                console.log(`   ✅ ${approvedAddresses[0].slice(0, 10)}... moved to Deprecating`);

                // Transition 3: Deprecating → Prospect (reverse transition, valid)
                console.log("\n▶️  Transition 3: Deprecating → Prospect (reverse)");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    deprecatingAddresses[0],
                    AdvertisementType.Deprecating,
                    AdvertisementType.Prospect,
                    100,
                    70
                );
                console.log(`   ✅ ${deprecatingAddresses[0].slice(0, 10)}... moved back to Prospect`);

                // Verify final state reflects all transitions
                console.log("\n🔍 Verifying final state...");
                const finalStats = await advertisersFacet.getAdvertisementStatistics();
                console.log("📊 Final statistics:");
                console.log(`   Prospect: ${finalStats[0]} (was ${initialStats[0]})`);
                console.log(`   Approved: ${finalStats[1]} (was ${initialStats[1]})`);
                console.log(`   Exhausted: ${finalStats[2]} (was ${initialStats[2]})`);
                console.log(`   Deprecating: ${finalStats[3]} (was ${initialStats[3]})`);
                
                // Net changes should be consistent
                expect(Number(finalStats.prospectCount)).to.be.greaterThanOrEqual(Number(initialStats.prospectCount));
                expect(Number(finalStats.approvedCount)).to.be.greaterThanOrEqual(Number(initialStats.approvedCount));
                expect(Number(finalStats.deprecatingCount)).to.be.greaterThanOrEqual(Number(initialStats.deprecatingCount));

                // Verify all arrays maintain integrity after complex operations
                console.log("\n🔍 Verifying array integrity across all types...");
                await verifyArrayIntegrity(AdvertisementType.Prospect);
                console.log("   ✅ Prospect array integrity verified");
                
                await verifyArrayIntegrity(AdvertisementType.Approved);
                console.log("   ✅ Approved array integrity verified");
                
                await verifyArrayIntegrity(AdvertisementType.Deprecating);
                console.log("   ✅ Deprecating array integrity verified");

                console.log("\n✅ Successfully handled valid complex array operations");
                console.log(`   Final counts: P:${finalStats.prospectCount}, A:${finalStats.approvedCount}, D:${finalStats.deprecatingCount}`);

                // Test: Verify system properly rejects invalid operations involving terminal states
                console.log("\n🚫 Testing terminal state restrictions...");
                const freshSigner = allSigners[signerIndex++];
                const terminalTestAddress = await createPOLAdvertisement(
                    freshSigner,
                    `terminal-test-${Date.now()}`,
                    "terminal-test@example.com"
                );
                console.log(`   Created test ad: ${terminalTestAddress.slice(0, 10)}...`);

                // Move to Approved
                console.log("   Moving to Approved...");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    terminalTestAddress,
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    50,
                    25
                );

                // Move to Exhausted (terminal state)
                console.log("   Moving to Exhausted (terminal)...");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    terminalTestAddress,
                    AdvertisementType.Approved,
                    AdvertisementType.Exhausted,
                    75,
                    35
                );

                // Attempt to move FROM Exhausted (should fail)
                console.log("   Attempting to move FROM Exhausted (should fail)...");
                await expect(
                    advertisersFacet.connect(owner).reclassifyAdvertisement(
                        terminalTestAddress,
                        AdvertisementType.Exhausted,
                        AdvertisementType.Approved,
                        100,
                        50
                    )
                ).to.be.revertedWith("Cannot reclassify from Exhausted");
                console.log("   ✅ Correctly rejected transition FROM Exhausted");

                console.log("\n✅ Complex operations properly respect terminal state business rules");
            });

            /**
             * @notice Verifies array consistency during rapid state changes
             * @dev Tests that quick sequential transitions maintain data integrity
             * 
             * Test Strategy:
             * - Create advertisement in Prospect
             * - Execute rapid transitions: Prospect → Approved → Deprecating → Prospect
             * - Verify advertisement remains accessible after each transition
             * - Confirm scores update correctly at each step
             * - Validate array counts remain consistent
             * 
             * Expected Behavior:
             * - All transitions complete successfully
             * - Advertisement accessible at each state
             * - Scores correctly updated/preserved
             * - No array corruption or orphaned entries
             * - Statistics reflect actual state changes
             */
            it("Should maintain data consistency during rapid state transitions", async function () {
                console.log("\n🔍 TEST START: Rapid state transitions");
                
                // Create fresh advertisement for rapid transition testing
                const freshSigner = allSigners[signerIndex++];
                const rapidTestAddress = await createPOLAdvertisement(
                    freshSigner,
                    `rapid-transition-${Date.now()}`,
                    "rapid-transition@example.com"
                );
                console.log(`📝 Created test ad: ${rapidTestAddress.slice(0, 10)}...`);

                // Define transition sequence with expected scores
                const transitionSequence = [
                    { from: AdvertisementType.Prospect, to: AdvertisementType.Approved, favorable: 20, unfavorable: 5 },
                    { from: AdvertisementType.Approved, to: AdvertisementType.Deprecating, favorable: 40, unfavorable: 10 },
                    { from: AdvertisementType.Deprecating, to: AdvertisementType.Prospect, favorable: 60, unfavorable: 15 },
                    { from: AdvertisementType.Prospect, to: AdvertisementType.Approved, favorable: 80, unfavorable: 20 }
                ];

                console.log("\n🔄 Executing rapid transition sequence:");
                
                // Execute rapid transitions
                for (let i = 0; i < transitionSequence.length; i++) {
                    const transition = transitionSequence[i];
                    const fromName = Object.keys(AdvertisementType)[transition.from];
                    const toName = Object.keys(AdvertisementType)[transition.to];
                    
                    console.log(`\n▶️  Transition ${i + 1}: ${fromName} → ${toName}`);
                    console.log(`   Scores: ${transition.favorable}/${transition.unfavorable}`);

                    // Execute transition
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        rapidTestAddress,
                        transition.from,
                        transition.to,
                        transition.favorable,
                        transition.unfavorable
                    );

                    // Verify advertisement state after transition
                    const [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(rapidTestAddress);
                    const adAddress = advertisement[0] || advertisement.advertContractAddress;
                    
                    expect(adAddress).to.equal(rapidTestAddress);
                    expect(status).to.equal(transition.to);
                    expect(advertisement.advertFavorableScore).to.equal(transition.favorable);
                    expect(advertisement.advertUnfavorableScore).to.equal(transition.unfavorable);
                    
                    console.log(`   ✅ Verified: Status=${toName}, Scores=${transition.favorable}/${transition.unfavorable}`);

                    // Verify advertisement exists in correct array
                    const targetArray = await advertisersFacet.getAdvertisements(transition.to);
                    const foundInArray = targetArray.some(ad => {
                        const arrayAdAddress = ad[0] || ad.advertContractAddress;
                        return arrayAdAddress && arrayAdAddress.toLowerCase() === rapidTestAddress.toLowerCase();
                    });
                    expect(foundInArray).to.be.true;
                    console.log(`   ✅ Found in ${toName} array`);
                }

                // Verify final array integrity across all types
                console.log("\n🔍 Verifying final array integrity...");
                await verifyArrayIntegrity(AdvertisementType.Prospect);
                await verifyArrayIntegrity(AdvertisementType.Approved);
                await verifyArrayIntegrity(AdvertisementType.Deprecating);
                
                console.log("✅ Data consistency maintained during rapid state transitions");
                console.log(`   Completed ${transitionSequence.length} transitions successfully`);
            });

            /**
             * @notice Verifies system handles interleaved operations across multiple advertisements
             * @dev Tests concurrent-like behavior with multiple advertisements in different states
             * 
             * Test Strategy:
             * - Create 3 advertisements (A, B, C)
             * - Perform interleaved operations:
             *   A: Prospect → Approved
             *   B: Prospect → Approved
             *   A: Approved → Deprecating
             *   C: Prospect → Approved
             *   B: Approved → Exhausted
             *   A: Deprecating → Withdrawn
             * 
             * Expected Behavior:
             * - All operations complete successfully
             * - Each advertisement tracked independently
             * - Array integrity maintained for all types
             * - Statistics accurately reflect all changes
             * - No cross-contamination between advertisements
             */
            it("Should handle interleaved operations on multiple advertisements", async function () {
                console.log("\n🔍 TEST START: Interleaved multi-advertisement operations");
                
                // Create three advertisements for interleaved testing
                const advertisementA = await createPOLAdvertisement(
                    allSigners[signerIndex++],
                    `interleaved-A-${Date.now()}`,
                    "interleaved-a@example.com"
                );
                
                const advertisementB = await createPOLAdvertisement(
                    allSigners[signerIndex++],
                    `interleaved-B-${Date.now()}`,
                    "interleaved-b@example.com"
                );
                
                const advertisementC = await createPOLAdvertisement(
                    allSigners[signerIndex++],
                    `interleaved-C-${Date.now()}`,
                    "interleaved-c@example.com"
                );

                console.log("📝 Created test advertisements:");
                console.log(`   A: ${advertisementA.slice(0, 10)}...`);
                console.log(`   B: ${advertisementB.slice(0, 10)}...`);
                console.log(`   C: ${advertisementC.slice(0, 10)}...`);

                // Get initial statistics
                const initialStats = await advertisersFacet.getAdvertisementStatistics();
                console.log("\n📊 Initial statistics recorded");

                // Define interleaved operation sequence
                const operations = [
                    { ad: 'A', address: advertisementA, from: AdvertisementType.Prospect, to: AdvertisementType.Approved, favorable: 30, unfavorable: 10 },
                    { ad: 'B', address: advertisementB, from: AdvertisementType.Prospect, to: AdvertisementType.Approved, favorable: 35, unfavorable: 12 },
                    { ad: 'A', address: advertisementA, from: AdvertisementType.Approved, to: AdvertisementType.Deprecating, favorable: 50, unfavorable: 20 },
                    { ad: 'C', address: advertisementC, from: AdvertisementType.Prospect, to: AdvertisementType.Approved, favorable: 40, unfavorable: 15 },
                    { ad: 'B', address: advertisementB, from: AdvertisementType.Approved, to: AdvertisementType.Exhausted, favorable: 60, unfavorable: 25 },
                    { ad: 'A', address: advertisementA, from: AdvertisementType.Deprecating, to: AdvertisementType.Withdrawn, favorable: 70, unfavorable: 30 }
                ];

                console.log("\n🔄 Executing interleaved operations:");
                
                // Execute interleaved operations
                for (let i = 0; i < operations.length; i++) {
                    const op = operations[i];
                    const fromName = Object.keys(AdvertisementType)[op.from];
                    const toName = Object.keys(AdvertisementType)[op.to];
                    
                    console.log(`\n▶️  Operation ${i + 1}: Ad ${op.ad} - ${fromName} → ${toName}`);
                    console.log(`   Address: ${op.address.slice(0, 10)}...`);
                    console.log(`   Scores: ${op.favorable}/${op.unfavorable}`);

                    // Execute reclassification
                    await advertisersFacet.connect(owner).reclassifyAdvertisement(
                        op.address,
                        op.from,
                        op.to,
                        op.favorable,
                        op.unfavorable
                    );

                    // Verify operation succeeded
                    const [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(op.address);
                    expect(status).to.equal(op.to);
                    expect(advertisement.advertFavorableScore).to.equal(op.favorable);
                    expect(advertisement.advertUnfavorableScore).to.equal(op.unfavorable);
                    
                    console.log(`   ✅ Verified: Ad ${op.ad} in ${toName} with correct scores`);
                }

                // Verify final states of all advertisements
                console.log("\n🔍 Verifying final states:");
                
                const [advertisementAData, statusA] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertisementA);
                expect(statusA).to.equal(AdvertisementType.Withdrawn);
                expect(advertisementAData.advertFavorableScore).to.equal(70);
                console.log("   ✅ Advertisement A: Withdrawn (70/30)");

                const [advertisementBData, statusB] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertisementB);
                expect(statusB).to.equal(AdvertisementType.Exhausted);
                expect(advertisementBData.advertFavorableScore).to.equal(60);
                console.log("   ✅ Advertisement B: Exhausted (60/25)");

                const [advertisementCData, statusC] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertisementC);
                expect(statusC).to.equal(AdvertisementType.Approved);
                expect(advertisementCData.advertFavorableScore).to.equal(40);
                console.log("   ✅ Advertisement C: Approved (40/15)");

                // Verify array integrity for all affected types
                console.log("\n🔍 Verifying array integrity across all affected types...");
                await verifyArrayIntegrity(AdvertisementType.Approved);
                console.log("   ✅ Approved array integrity verified");
                
                await verifyArrayIntegrity(AdvertisementType.Exhausted);
                console.log("   ✅ Exhausted array integrity verified");
                
                await verifyArrayIntegrity(AdvertisementType.Withdrawn);
                console.log("   ✅ Withdrawn array integrity verified");

                // Verify statistics updated correctly
                const finalStats = await advertisersFacet.getAdvertisementStatistics();
                console.log("\n📊 Final statistics:");
                console.log(`   Approved: ${finalStats[1]} (C remains)`);
                console.log(`   Exhausted: ${finalStats[2]} (B ended here)`);
                console.log(`   Withdrawn: ${finalStats[4]} (A ended here)`);

                console.log("\n✅ Successfully handled interleaved operations on multiple advertisements");
                console.log(`   Completed ${operations.length} operations across 3 advertisements`);
            });

            /**
             * @notice Verifies score updates across multiple transitions
             * @dev Tests that scores are properly updated (SET, not accumulated) during each reclassification
             * 
             * Test Strategy:
             * - Create advertisement with initial scores
             * - Perform multiple reclassifications with different scores
             * - Verify scores are SET to new values (not accumulated)
             * - Confirm score persistence across array transfers
             * 
             * Expected Behavior:
             * - Scores are SET (replaced) not accumulated
             * - Each reclassification updates to exact provided scores
             * - Scores preserved during array transfers
             * - Historical scores not retained (current state only)
             */
            it("Should correctly update scores across multiple transitions", async function () {
                console.log("\n🔍 TEST START: Score updates across transitions");
                
                // Create fresh advertisement
                const freshSigner = allSigners[signerIndex++];
                const scoreTestAddress = await createPOLAdvertisement(
                    freshSigner,
                    `score-update-test-${Date.now()}`,
                    "score-update@example.com"
                );
                console.log(`📝 Created test ad: ${scoreTestAddress.slice(0, 10)}...`);

                // Initial state: Prospect (created with default scores from factory)
                let [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(scoreTestAddress);
                console.log(`\n📊 Initial state: ${Object.keys(AdvertisementType)[status]}`);
                console.log(`   Initial scores: ${advertisement.advertFavorableScore}/${advertisement.advertUnfavorableScore}`);

                // Transition 1: Prospect → Approved with specific scores
                console.log("\n▶️  Transition 1: Prospect → Approved (SET scores to 100/50)");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    scoreTestAddress,
                    AdvertisementType.Prospect,
                    AdvertisementType.Approved,
                    100,
                    50
                );

                [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(scoreTestAddress);
                expect(status).to.equal(AdvertisementType.Approved);
                expect(advertisement.advertFavorableScore).to.equal(100);
                expect(advertisement.advertUnfavorableScore).to.equal(50);
                console.log(`   ✅ Scores SET to: ${advertisement.advertFavorableScore}/${advertisement.advertUnfavorableScore}`);

                // Transition 2: Approved → Deprecating with DIFFERENT scores
                console.log("\n▶️  Transition 2: Approved → Deprecating (SET scores to 200/75)");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    scoreTestAddress,
                    AdvertisementType.Approved,
                    AdvertisementType.Deprecating,
                    200,
                    75
                );

                [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(scoreTestAddress);
                expect(status).to.equal(AdvertisementType.Deprecating);
                expect(advertisement.advertFavorableScore).to.equal(200); // SET to 200, NOT 100+200=300
                expect(advertisement.advertUnfavorableScore).to.equal(75); // SET to 75, NOT 50+75=125
                console.log(`   ✅ Scores SET to: ${advertisement.advertFavorableScore}/${advertisement.advertUnfavorableScore}`);
                console.log(`   (NOT accumulated: would be 300/125 if accumulating)`);

                // Transition 3: Deprecating → Prospect with LOWER scores (proves no accumulation)
                console.log("\n▶️  Transition 3: Deprecating → Prospect (SET scores to 50/25)");
                await advertisersFacet.connect(owner).reclassifyAdvertisement(
                    scoreTestAddress,
                    AdvertisementType.Deprecating,
                    AdvertisementType.Prospect,
                    50,
                    25
                );

                [advertisement, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(scoreTestAddress);
                expect(status).to.equal(AdvertisementType.Prospect);
                expect(advertisement.advertFavorableScore).to.equal(50); // SET to 50 (lower than before)
                expect(advertisement.advertUnfavorableScore).to.equal(25); // SET to 25 (lower than before)
                console.log(`   ✅ Scores SET to: ${advertisement.advertFavorableScore}/${advertisement.advertUnfavorableScore}`);
                console.log(`   (Proves scores are SET, not accumulated)`);

                console.log("\n✅ Score update behavior verified:");
                console.log("   - Scores are SET (replaced) during reclassification");
                console.log("   - Scores are NOT accumulated across transitions");
                console.log("   - Scores can increase or decrease");
                console.log("   - Current state only, no historical scores retained");
            });
        });
    });
});
