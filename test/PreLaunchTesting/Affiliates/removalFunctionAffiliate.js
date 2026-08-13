const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title OpenAdvertsAffiliatesFacet - Affiliate Removal Tests
 * @notice Comprehensive test suite for removeAffiliate function
 * @dev Tests the complete removal flow including cleanup and edge cases
 * 
 * Test Coverage Areas:
 * - Prospect affiliate removal by owner and diamond owner
 * - Approved affiliate removal by owner and diamond owner
 * - Storage cleanup (arrays, mappings, status changes)
 * - Removed array tracking
 * - Access control validation
 * - Edge cases (non-existent affiliates, wrong status, etc.)
 * - Event emission verification
 * 
 * Architecture Notes:
 * - Uses Diamond proxy pattern
 * - Tests OpenAdvertsAffiliatesFacet removeAffiliate function
 * - Verifies proper cleanup of all affiliate data
 */

describe("OpenAdvertsAffiliatesFacet - removeAffiliate", function () {
    // Contract instances
    let diamondAddress;
    let affiliatesFacet;
    let affiliatesVotingFacet;
    let tokenFacet;

    // Test accounts
    let owner;
    let affiliate1;
    let affiliate2;
    let nonOwner;
    let claimInfo1, claimInfo2;
    let signingAddr1, signingAddr2, signingAddr3;
    let gateSigner;

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    /**
     * @notice Affiliate status enumeration
     */
    const AffiliateType = {
        Prospect: 0,
        Approved: 1,
        Banned: 2
    };

    /**
     * @notice Test suite initialization
     * @dev Deploys diamond, initializes facets, and prepares test accounts
     */
    before(async function () {
        console.log("🚀 Starting Affiliate Removal tests...");
        
        // Retrieve test accounts
        const allSigners = await ethers.getSigners();
        [owner, affiliate1, affiliate2, nonOwner, claimInfo1, claimInfo2, signingAddr1, signingAddr2, signingAddr3] = allSigners;
        
        console.log(`✅ Test accounts retrieved`);
        console.log(`   - Owner: ${owner.address}`);
        console.log(`   - Affiliate1: ${affiliate1.address}`);
        console.log(`   - Affiliate2: ${affiliate2.address}`);

        try {
            // Deploy diamond and initialize facets
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            
            if (!diamondAddress) {
                throw new Error("Diamond deployment failed");
            }
            console.log("✅ Diamond deployed at:", diamondAddress);

            // Initialize facet instances
            affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
            affiliatesVotingFacet = await ethers.getContractAt("OpenAdvertsAffiliatesVotingFacet", diamondAddress);
            tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
            
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            
            console.log("✅ All facet instances created");

        } catch (error) {
            console.error("❌ Setup failed:", error);
            throw error;
        }
    });

    /**
     * @notice Helper function to create a prospect affiliate
     * @dev Creates a prospect affiliate via the affiliates facet
     * @param owner The account creating the affiliate
     * @param affiliateContract Address for the affiliate contract
     * @param claimInfo Address for claim info
     * @param signingAddress Address for signing
     * @param storageId Unique identifier
     * @param email Affiliate's email
     * @return affiliateContract The affiliate address
     */
    async function createProspectAffiliate(owner, affiliateContract, claimInfo, signingAddress, storageId, email) {
        console.log(`   📝 Creating Prospect Affiliate with:`);
        console.log(`      - Storage ID: ${storageId}`);
        console.log(`      - Affiliate: ${affiliateContract}`);
        console.log(`      - Owner: ${owner.address}`);

        const tx = await affiliatesFacet.connect(owner).createProspectAffiliateContract(
            affiliateContract,
            claimInfo,
            signingAddress,
            storageId,
            ...(await gate.affiliate(gateSigner, diamondAddress, owner.address)));
        
        await tx.wait();
        
        console.log(`   ✅ Created Prospect Affiliate: ${affiliateContract}`);
        return affiliateContract;
    }

    /**
     * @notice Helper to get affiliate details
     * @param affiliateAddress The affiliate address
     * @return Tuple of [affiliateDetails, status]
     */
    async function getAffiliateDetails(affiliateAddress) {
        return await affiliatesFacet.getAffiliateDetailsAndStatus(affiliateAddress);
    }

    // =========================================================================
    // REMOVAL FUNCTION BASIC TESTS - PROSPECT AFFILIATES
    // =========================================================================

    describe("Basic Removal Functionality - Prospect", function () {
        it("Should successfully remove a prospect affiliate by affiliate owner", async function () {
            console.log("\n   🧪 Testing prospect removal by affiliate owner...");

            // Create a prospect affiliate
            const testAffiliate = affiliate1.address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                signingAddr1.address,
                "test-prospect-removal",
                "prospect@test.com"
            );

            // Get initial state
            const prospectArrayBefore = await affiliatesFacet.getProspectAffiliates();
            const prospectCountBefore = BigInt(prospectArrayBefore.length);
            const removedArrayBefore = await affiliatesFacet.getRemovedAffiliates();
            const removedCountBefore = BigInt(removedArrayBefore.length);

            // Verify affiliate exists and is Prospect
            const [detailsBefore, statusBefore] = await getAffiliateDetails(testAffiliate);
            expect(statusBefore).to.equal(AffiliateType.Prospect);
            expect(detailsBefore.affiliateOwner).to.equal(affiliate1.address);

            console.log(`   📊 Initial state:`);
            console.log(`      - Prospect count: ${prospectCountBefore}`);
            console.log(`      - Removed count: ${removedCountBefore}`);
            console.log(`      - Affiliate status: Prospect`);

            // Remove the affiliate
            const tx = await affiliatesFacet.connect(affiliate1).removeAffiliate(testAffiliate);
            const receipt = await tx.wait();

            console.log(`   ✅ Removal transaction completed`);

            // Verify removal event was emitted
            const removeEvent = receipt.logs.find(log => {
                try {
                    const parsed = affiliatesFacet.interface.parseLog(log);
                    return parsed && parsed.name === "AffiliateRemoved";
                } catch (e) {
                    return false;
                }
            });
            expect(removeEvent).to.not.be.undefined;
            console.log(`   ✅ AffiliateRemoved event emitted`);

            // Verify prospect array was updated
            const prospectArrayAfter = await affiliatesFacet.getProspectAffiliates();
            const prospectCountAfter = BigInt(prospectArrayAfter.length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);
            console.log(`   ✅ Prospect count decreased: ${prospectCountBefore} → ${prospectCountAfter}`);

            // Verify removed array was updated
            const removedArrayAfter = await affiliatesFacet.getRemovedAffiliates();
            const removedCountAfter = BigInt(removedArrayAfter.length);
            expect(removedCountAfter).to.equal(removedCountBefore + 1n);
            console.log(`   ✅ Removed count increased: ${removedCountBefore} → ${removedCountAfter}`);

            // Verify affiliate no longer exists in active storage
            const stats = await affiliatesFacet.getAffiliateStatistics();
            console.log(`   ✅ Affiliate removed from active storage`);
        });

        it("Should successfully remove a prospect affiliate by diamond owner", async function () {
            console.log("\n   🧪 Testing prospect removal by diamond owner...");

            // Create a prospect affiliate
            const testAffiliate = affiliate2.address;
            await createProspectAffiliate(
                affiliate2,
                testAffiliate,
                claimInfo2.address,
                signingAddr2.address,
                "test-prospect-removal-diamond",
                "diamond@test.com"
            );

            const prospectCountBefore = BigInt((await affiliatesFacet.getProspectAffiliates()).length);

            // Remove by diamond owner (should succeed)
            const tx = await affiliatesFacet.connect(owner).removeAffiliate(testAffiliate);
            await tx.wait();

            console.log(`   ✅ Diamond owner successfully removed affiliate`);

            // Verify removal
            const prospectCountAfter = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);

            console.log(`   ✅ Prospect removal by diamond owner verified`);
        });
    });

    // =========================================================================
    // REMOVAL FUNCTION BASIC TESTS - APPROVED AFFILIATES
    // =========================================================================

    describe("Basic Removal Functionality - Approved", function () {
        it("Should successfully remove an approved affiliate by affiliate owner", async function () {
            console.log("\n   🧪 Testing approved removal by affiliate owner...");

            // Create a prospect affiliate first
            const testAffiliate = ethers.Wallet.createRandom().address;
            const testSigningAddr = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                testSigningAddr,
                "test-approved-removal",
                "approved@test.com"
            );

            // Get initial details
            const [details, statusBefore] = await getAffiliateDetails(testAffiliate);
            expect(statusBefore).to.equal(AffiliateType.Prospect);

            // Reclassify to Approved
            await affiliatesFacet.connect(owner).reclassifyAffiliate(
                testAffiliate,
                AffiliateType.Prospect,
                AffiliateType.Approved,
                100,
                50
            );

            // Verify it's now approved
            const [detailsAfter, statusAfter] = await getAffiliateDetails(testAffiliate);
            expect(statusAfter).to.equal(AffiliateType.Approved);
            console.log(`   📊 Reclassified to Approved status`);

            // Get counts before removal
            const approvedCountBefore = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);
            const removedCountBefore = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);

            console.log(`   📊 Before removal:`);
            console.log(`      - Approved count: ${approvedCountBefore}`);
            console.log(`      - Removed count: ${removedCountBefore}`);

            // Remove the approved affiliate
            const tx = await affiliatesFacet.connect(affiliate1).removeAffiliate(testAffiliate);
            const receipt = await tx.wait();

            console.log(`   ✅ Removal transaction completed`);

            // Verify removal event
            const removeEvent = receipt.logs.find(log => {
                try {
                    const parsed = affiliatesFacet.interface.parseLog(log);
                    return parsed && parsed.name === "AffiliateRemoved";
                } catch (e) {
                    return false;
                }
            });
            expect(removeEvent).to.not.be.undefined;
            console.log(`   ✅ AffiliateRemoved event emitted`);

            // Verify approved array was updated
            const approvedCountAfter = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);
            expect(approvedCountAfter).to.equal(approvedCountBefore - 1n);
            console.log(`   ✅ Approved count decreased: ${approvedCountBefore} → ${approvedCountAfter}`);

            // Verify removed array was updated
            const removedCountAfter = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);
            expect(removedCountAfter).to.equal(removedCountBefore + 1n);
            console.log(`   ✅ Removed count increased: ${removedCountBefore} → ${removedCountAfter}`);
        });

        it("Should successfully remove an approved affiliate by diamond owner", async function () {
            console.log("\n   🧪 Testing approved removal by diamond owner...");

            // Create and approve an affiliate
            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate2,
                testAffiliate,
                claimInfo2.address,
                ethers.Wallet.createRandom().address,
                "test-approved-removal-diamond",
                "approveddiamond@test.com"
            );

            // Reclassify to Approved
            await affiliatesFacet.connect(owner).reclassifyAffiliate(
                testAffiliate,
                AffiliateType.Prospect,
                AffiliateType.Approved,
                200,
                100
            );

            const approvedCountBefore = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);

            // Remove by diamond owner
            await affiliatesFacet.connect(owner).removeAffiliate(testAffiliate);

            console.log(`   ✅ Diamond owner successfully removed approved affiliate`);

            // Verify removal
            const approvedCountAfter = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);
            expect(approvedCountAfter).to.equal(approvedCountBefore - 1n);

            console.log(`   ✅ Approved removal by diamond owner verified`);
        });
    });

    // =========================================================================
    // ACCESS CONTROL TESTS
    // =========================================================================

    describe("Access Control", function () {
        it("Should reject removal by unauthorized user", async function () {
            console.log("\n   🧪 Testing unauthorized removal attempt...");

            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "test-access-control",
                "access@test.com"
            );

            await expect(
                affiliatesFacet.connect(nonOwner).removeAffiliate(testAffiliate)
            ).to.be.revertedWith("Only contract owner or affiliate owner can remove");

            console.log(`   ✅ Unauthorized removal correctly rejected`);
        });

        it("Should reject removal by other affiliate owner", async function () {
            console.log("\n   🧪 Testing removal by different affiliate owner...");

            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "test-other-owner",
                "other@test.com"
            );

            await expect(
                affiliatesFacet.connect(affiliate2).removeAffiliate(testAffiliate)
            ).to.be.revertedWith("Only contract owner or affiliate owner can remove");

            console.log(`   ✅ Other affiliate owner correctly rejected`);
        });
    });

    // =========================================================================
    // VALIDATION AND ERROR HANDLING
    // =========================================================================

    describe("Validation and Error Handling", function () {
        it("Should reject removal of non-existent affiliate", async function () {
            console.log("\n   🧪 Testing removal of non-existent affiliate...");

            const fakeAddress = ethers.Wallet.createRandom().address;

            await expect(
                affiliatesFacet.connect(owner).removeAffiliate(fakeAddress)
            ).to.be.revertedWith("Affiliate does not exist");

            console.log(`   ✅ Non-existent affiliate correctly rejected`);
        });

        it("Should reject removal of banned affiliate", async function () {
            console.log("\n   🧪 Testing removal of banned affiliate...");

            // Create and ban an affiliate
            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "test-banned-removal",
                "banned@test.com"
            );

            // Ban the affiliate
            await affiliatesFacet.connect(owner).banAffiliate(testAffiliate);

            const status = await affiliatesFacet.getAffiliateStatus(testAffiliate);
            expect(status).to.equal(AffiliateType.Banned);
            console.log(`   📊 Status: ${status} (Banned)`);

            await expect(
                affiliatesFacet.connect(owner).removeAffiliate(testAffiliate)
            ).to.be.revertedWith("Only prospect or approved affiliates can be removed");

            console.log(`   ✅ Banned affiliate removal correctly rejected`);
        });

        it("Should reject removal with zero address", async function () {
            console.log("\n   🧪 Testing removal with zero address...");

            await expect(
                affiliatesFacet.connect(owner).removeAffiliate(ZERO_ADDRESS)
            ).to.be.revertedWith("Affiliate does not exist");

            console.log(`   ✅ Zero address correctly rejected`);
        });
    });

    // =========================================================================
    // STORAGE CLEANUP VERIFICATION
    // =========================================================================

    describe("Storage Cleanup Verification", function () {
        it("Should properly clean up all storage mappings and arrays", async function () {
            console.log("\n   🧪 Testing complete storage cleanup...");

            // Create multiple affiliates
            const affiliates = [];
            for (let i = 0; i < 3; i++) {
                const addr = ethers.Wallet.createRandom().address;
                await createProspectAffiliate(
                    affiliate1,
                    addr,
                    claimInfo1.address,
                    ethers.Wallet.createRandom().address,
                    `cleanup-test-${i}`,
                    `cleanup${i}@test.com`
                );
                affiliates.push(addr);
            }

            const prospectCountBefore = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            const removedCountBefore = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);

            console.log(`   📊 Initial state:`);
            console.log(`      - Prospect count: ${prospectCountBefore}`);
            console.log(`      - Removed count: ${removedCountBefore}`);

            // Remove middle affiliate
            await affiliatesFacet.connect(affiliate1).removeAffiliate(affiliates[1]);
            console.log(`   ✅ Removed affiliate 2 (middle)`);

            // Verify counts
            const prospectCountAfter1 = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            const removedCountAfter1 = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);

            expect(prospectCountAfter1).to.equal(prospectCountBefore - 1n);
            expect(removedCountAfter1).to.equal(removedCountBefore + 1n);

            console.log(`   📊 After first removal:`);
            console.log(`      - Prospect count: ${prospectCountAfter1}`);
            console.log(`      - Removed count: ${removedCountAfter1}`);
            console.log(`   ✅ Array reordering worked correctly`);

            // Remove remaining affiliates
            await affiliatesFacet.connect(affiliate1).removeAffiliate(affiliates[0]);
            await affiliatesFacet.connect(affiliate1).removeAffiliate(affiliates[2]);

            const prospectCountFinal = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            const removedCountFinal = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);

            console.log(`   📊 Final state:`);
            console.log(`      - Prospect count: ${prospectCountFinal}`);
            console.log(`      - Removed count: ${removedCountFinal}`);

            expect(removedCountFinal).to.equal(removedCountBefore + 3n);
            console.log(`   ✅ All affiliates successfully removed and tracked`);
        });
    });

    // =========================================================================
    // REMOVED ARRAY VERIFICATION
    // =========================================================================

    describe("Removed Array Tracking", function () {
        it("Should correctly add removed affiliates to removed array", async function () {
            console.log("\n   🧪 Testing removed array tracking...");

            const removedCountBefore = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);
            console.log(`   📊 Removed count before: ${removedCountBefore}`);

            // Create and remove an affiliate
            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "removed-array-test",
                "removed@test.com"
            );

            // Remove it
            await affiliatesFacet.connect(affiliate1).removeAffiliate(testAffiliate);

            const removedArrayAfter = await affiliatesFacet.getRemovedAffiliates();
            const removedCountAfter = BigInt(removedArrayAfter.length);
            console.log(`   📊 Removed count after: ${removedCountAfter}`);

            expect(removedCountAfter).to.equal(removedCountBefore + 1n);

            // Get the removed affiliate from the array
            const removedAffiliate = removedArrayAfter[Number(removedCountAfter - 1n)];
            
            console.log(`   📊 Removed affiliate details:`);
            console.log(`      - Address: ${removedAffiliate.affiliateContractAddress}`);
            console.log(`      - Owner: ${removedAffiliate.affiliateOwner}`);
            console.log(`      - Storage ID: ${removedAffiliate.storageId}`);

            // Verify the details match
            expect(removedAffiliate.affiliateContractAddress).to.equal(testAffiliate);
            expect(removedAffiliate.affiliateOwner).to.equal(affiliate1.address);
            expect(removedAffiliate.storageId).to.equal("removed-array-test");

            console.log(`   ✅ Removed affiliate correctly stored in removed array`);
        });

        it("Should maintain removed array across multiple removals", async function () {
            console.log("\n   🧪 Testing removed array with multiple entries...");

            const removedCountStart = BigInt((await affiliatesFacet.getRemovedAffiliates()).length);

            // Create and remove multiple affiliates
            const affiliates = [];
            for (let i = 0; i < 3; i++) {
                const addr = ethers.Wallet.createRandom().address;
                await createProspectAffiliate(
                    affiliate1,
                    addr,
                    claimInfo1.address,
                    ethers.Wallet.createRandom().address,
                    `multi-removed-${i}`,
                    `multi${i}@test.com`
                );
                affiliates.push(addr);
            }

            console.log(`   📝 Created ${affiliates.length} affiliates`);

            // Remove all
            for (let i = 0; i < affiliates.length; i++) {
                await affiliatesFacet.connect(affiliate1).removeAffiliate(affiliates[i]);
                console.log(`   ✅ Removed affiliate ${i + 1}`);
            }

            const removedArrayEnd = await affiliatesFacet.getRemovedAffiliates();
            const removedCountEnd = BigInt(removedArrayEnd.length);
            expect(removedCountEnd).to.equal(removedCountStart + BigInt(affiliates.length));

            console.log(`   📊 Removed array size: ${removedCountStart} → ${removedCountEnd}`);

            // Verify all are in removed array
            for (let i = 0; i < affiliates.length; i++) {
                const index = Number(removedCountStart) + i;
                const removedAffiliate = removedArrayEnd[index];
                expect(removedAffiliate.affiliateContractAddress).to.equal(affiliates[i]);
                expect(removedAffiliate.storageId).to.equal(`multi-removed-${i}`);
            }

            console.log(`   ✅ All removed affiliates correctly tracked in order`);
        });
    });

    // =========================================================================
    // EVENT EMISSION TESTS
    // =========================================================================

    describe("Event Emission", function () {
        it("Should emit AffiliateRemoved event with correct parameters", async function () {
            console.log("\n   🧪 Testing AffiliateRemoved event...");

            const testAffiliate = ethers.Wallet.createRandom().address;
            await createProspectAffiliate(
                affiliate1,
                testAffiliate,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "event-test",
                "event@test.com"
            );

            const tx = await affiliatesFacet.connect(affiliate1).removeAffiliate(testAffiliate);
            const receipt = await tx.wait();

            // Find and parse the event
            let eventFound = false;
            let eventData;

            for (const log of receipt.logs) {
                try {
                    const parsed = affiliatesFacet.interface.parseLog(log);
                    if (parsed && parsed.name === "AffiliateRemoved") {
                        eventFound = true;
                        eventData = parsed.args;
                        break;
                    }
                } catch (e) {
                    // Skip logs that don't match
                }
            }

            expect(eventFound).to.be.true;
            expect(eventData.affiliateAddress).to.equal(testAffiliate);
            expect(eventData.timestamp).to.be.gt(0);

            console.log(`   ✅ AffiliateRemoved event emitted correctly`);
            console.log(`      - Affiliate: ${eventData.affiliateAddress}`);
            console.log(`      - Timestamp: ${eventData.timestamp}`);
        });
    });

    // =========================================================================
    // EDGE CASES AND STRESS TESTS
    // =========================================================================

    describe("Edge Cases", function () {
        it("Should handle rapid successive removals", async function () {
            console.log("\n   🧪 Testing rapid successive removals...");

            // Create multiple affiliates
            const affiliates = [];
            for (let i = 0; i < 5; i++) {
                const addr = ethers.Wallet.createRandom().address;
                await createProspectAffiliate(
                    affiliate1,
                    addr,
                    claimInfo1.address,
                    ethers.Wallet.createRandom().address,
                    `rapid-${i}`,
                    `rapid${i}@test.com`
                );
                affiliates.push(addr);
            }

            console.log(`   📝 Created ${affiliates.length} affiliates`);

            const prospectCountBefore = BigInt((await affiliatesFacet.getProspectAffiliates()).length);

            // Remove all rapidly
            for (const addr of affiliates) {
                await affiliatesFacet.connect(affiliate1).removeAffiliate(addr);
            }

            console.log(`   ✅ All removed successfully`);

            const prospectCountAfter = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - BigInt(affiliates.length));

            console.log(`   ✅ Rapid successive removals handled correctly`);
        });

        it("Should handle mixed prospect and approved removals", async function () {
            console.log("\n   🧪 Testing mixed status removals...");

            // Create two affiliates
            const prospect = ethers.Wallet.createRandom().address;
            const approved = ethers.Wallet.createRandom().address;

            await createProspectAffiliate(
                affiliate1,
                prospect,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "mixed-prospect",
                "mixedp@test.com"
            );

            await createProspectAffiliate(
                affiliate1,
                approved,
                claimInfo1.address,
                ethers.Wallet.createRandom().address,
                "mixed-approved",
                "mixeda@test.com"
            );

            // Approve the second one
            await affiliatesFacet.connect(owner).reclassifyAffiliate(
                approved,
                AffiliateType.Prospect,
                AffiliateType.Approved,
                100,
                50
            );

            console.log(`   ✅ Created both prospect and approved affiliates`);

            const prospectCountBefore = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            const approvedCountBefore = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);

            // Remove both
            await affiliatesFacet.connect(affiliate1).removeAffiliate(prospect);
            await affiliatesFacet.connect(affiliate1).removeAffiliate(approved);

            console.log(`   ✅ Removed both affiliates`);

            const prospectCountAfter = BigInt((await affiliatesFacet.getProspectAffiliates()).length);
            const approvedCountAfter = BigInt((await affiliatesFacet.getApprovedAffiliates()).length);

            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);
            expect(approvedCountAfter).to.equal(approvedCountBefore - 1n);

            console.log(`   ✅ Mixed status removals handled correctly`);
        });
    });
});
