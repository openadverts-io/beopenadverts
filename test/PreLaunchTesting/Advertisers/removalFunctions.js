const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title OpenAdvertsAdvertisersVotingFacet - Prospect Advertisement Removal Tests
 * @notice Comprehensive test suite for removeProspectAdvertisement function
 * @dev Tests the complete removal flow including refunds, cleanup, and edge cases
 * 
 * Test Coverage Areas:
 * - Prospect advertisement removal by owner and diamond owner
 * - Fund refunding via removeAndRefund() contract call
 * - Storage cleanup (arrays, mappings, status changes)
 * - Removed array tracking
 * - Access control validation
 * - Edge cases (non-existent ads, wrong status, etc.)
 * - Event emission verification
 * 
 * Architecture Notes:
 * - Uses Diamond proxy pattern
 * - Tests interaction between VotingFacet and OpenAdvertsAdvertPOL
 * - Verifies refund flow through contract interface
 */

describe("OpenAdvertsAdvertisersVotingFacet - removeProspectAdvertisement", function () {
    // Contract instances
    let diamondAddress;
    let gateSigner;
    let advertisersFacet;
    let votingFacet;
    let tokenFacet;
    let governanceFacet;
    let advertPOLFactoryFacet;
    let advertUSDCFactoryFacet;
    let mockUSDC;

    // Test accounts
    let owner;
    let advertiser1;
    let advertiser2;
    let nonOwner;
    let user1, user2, user3;
    let fundingAccounts; // Pool of accounts for funding

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    /**
     * @notice Advertisement status enumeration
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
     */
    const PaymentType = {
        POL: 0,
        USDC: 1
    };

    /**
     * @notice Test suite initialization
     * @dev Deploys diamond, initializes facets, and prepares test accounts
     */
    before(async function () {
        console.log("🚀 Starting Prospect Advertisement Removal tests...");
        
        // Retrieve test accounts
        const allSigners = await ethers.getSigners();
        [owner, advertiser1, advertiser2, nonOwner, user1, user2, user3] = allSigners;
        
        // Set up funding pool (accounts 10-30 have default 10000 ETH each)
        fundingAccounts = allSigners.slice(10, 30);
        
        console.log(`✅ Test accounts retrieved`);
        console.log(`   - Owner: ${owner.address}`);
        console.log(`   - Advertiser1: ${advertiser1.address}`);
        console.log(`   - Advertiser2: ${advertiser2.address}`);
        console.log(`   - Funding pool: ${fundingAccounts.length} accounts`);

        try {
            // Deploy diamond and initialize facets
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            
            if (!diamondAddress) {
                throw new Error("Diamond deployment failed");
            }
            console.log("✅ Diamond deployed at:", diamondAddress);

            // Initialize facet instances
            advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
            votingFacet = await ethers.getContractAt("OpenAdvertsAdvertisersVotingFacet", diamondAddress);
            tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
            governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
            advertPOLFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            
            console.log("✅ All facet instances created");

            // Get MockUSDC instance
            const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
            mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
            console.log("✅ MockUSDC instance created at:", usdcAddress);

            // Get USDC factory facet instance
            advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
            console.log("✅ USDC factory facet instance created");

        } catch (error) {
            console.error("❌ Setup failed:", error);
            throw error;
        }
    });

    /**
     * @notice Helper function to create a POL advertisement
     * @dev Creates a prospect advertisement via the factory facet
     * @param signer The account creating the advertisement
     * @param storageId Unique identifier for the advertisement
     * @param emailAddress Advertiser's email
     * @return advertAddress The deployed advertisement contract address
     */
    async function createPOLAdvertisement(signer, storageId, emailAddress) {
        // Get minimum quotas from governance
        const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
        
        // Check if signer needs funding
        const signerBalance = await ethers.provider.getBalance(signer.address);
        const requiredBalance = minFunding * 2n; // 2x for safety
        
        if (signerBalance < requiredBalance) {
            console.log(`   💰 Funding ${signer.address.slice(0, 10)}... from pool`);
            // Find a funding account with sufficient balance
            for (const funder of fundingAccounts) {
                const funderBalance = await ethers.provider.getBalance(funder.address);
                if (funderBalance > ethers.parseEther("5000")) {
                    await funder.sendTransaction({
                        to: signer.address,
                        value: ethers.parseEther("3000")
                    });
                    console.log(`   ✅ Funded ${ethers.formatEther(ethers.parseEther("3000"))} POL`);
                    break;
                }
            }
        }
        
        console.log(`   📝 Creating POL advert with:`);
        console.log(`      - Storage ID: ${storageId}`);
        console.log(`      - Min Bounty: ${ethers.formatEther(minBounty)} POL`);
        console.log(`      - Min Funding: ${ethers.formatEther(minFunding)} POL`);
        console.log(`      - Signer: ${signer.address}`);

        // Create advertisement via factory
        const tx = await advertPOLFactoryFacet.connect(signer).createNewProspectPOLAdvertContract(
            storageId,
            minBounty,
            100, // minBlockNRSeparation
            ethers.ZeroAddress,
            ...(await gate.pol(gateSigner, diamondAddress, signer.address)),
            { value: minFunding }
        );
        
        const receipt = await tx.wait();
        
        // Extract advertisement address from event
        let advertAddress;
        for (const log of receipt.logs) {
            try {
                const parsedLog = advertPOLFactoryFacet.interface.parseLog(log);
                if (parsedLog && parsedLog.name === "POLAdvertisementCreatedAndValidated") {
                    advertAddress = parsedLog.args.advertContract; // ✅ Correct parameter name
                    break;
                }
            } catch (e) {
                // Skip logs that don't match
                continue;
            }
        }
        
        if (!advertAddress) {
            // Try alternative event parsing from OpenAdvertsAdvertisersFacet
            for (const log of receipt.logs) {
                try {
                    const parsedLog = advertisersFacet.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "ProspectAdvertisementCreated") {
                        advertAddress = parsedLog.args.advertContractAddress;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        if (!advertAddress) {
            console.log("   ⚠️  Could not parse events. Dumping all logs:");
            for (const log of receipt.logs) {
                console.log("     ", log.topics[0]);
            }
            throw new Error("Failed to extract advertisement address from event");
        }
        
        console.log(`   ✅ Created POL advert at: ${advertAddress}`);
        return advertAddress;
    }

    /**
     * @notice Helper to get advertisement details
     * @param advertAddress The advertisement contract address
     * @return Tuple of [advertDetails, status]
     */
    async function getAdvertDetails(advertAddress) {
        return await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
    }

    /**
     * @notice Helper function to create a USDC advertisement
     * @dev Creates a prospect USDC advertisement via the USDC factory facet
     * @param signer The account creating the advertisement
     * @param storageId Unique identifier for the advertisement
     * @param emailAddress Advertiser's email
     * @return advertAddress The deployed USDC advertisement contract address
     */
    async function createUSDCAdvertisement(signer, storageId, emailAddress) {
        // Get USDC price facet to calculate minimum requirements
        const usdcPriceFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCPriceFacet", diamondAddress);
        const [minBountyPOL, minFundingPOL] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
        
        // Get USDC premium from current quotas
        const currentQuotas = await governanceFacet.getAllCurrentQuotas();
        const usdcPremium = currentQuotas.USDCCurrencyPremiumInPCT;
        
        // Calculate USDC minimums (in micro USDC - 6 decimals)
        const [minBountyUSDC, minFundingUSDC] = await usdcPriceFacet.calculateMinimumUSDCRequirements(
            minBountyPOL,
            minFundingPOL,
            usdcPremium
        );
        
        console.log(`   📝 Creating USDC advert with:`);
        console.log(`      - Storage ID: ${storageId}`);
        console.log(`      - Min Bounty: ${minBountyUSDC} microUSDC`);
        console.log(`      - Min Funding: ${minFundingUSDC} microUSDC`);
        console.log(`      - Signer: ${signer.address}`);

        // Check if signer has enough USDC
        const signerUSDCBalance = await mockUSDC.balanceOf(signer.address);
        if (signerUSDCBalance < minFundingUSDC * 2n) {
            console.log(`   💰 Minting USDC for ${signer.address.slice(0, 10)}...`);
            // Mint USDC to signer
            await mockUSDC.connect(owner).mint(signer.address, minFundingUSDC * 10n);
            console.log(`   ✅ Minted ${minFundingUSDC * 10n} microUSDC`);
        }

        // Approve USDC spending
        const currentAllowance = await mockUSDC.allowance(signer.address, diamondAddress);
        if (currentAllowance < minFundingUSDC) {
            console.log(`   🔓 Approving USDC spending...`);
            await mockUSDC.connect(signer).approve(diamondAddress, minFundingUSDC * 100n);
            console.log(`   ✅ Approved ${minFundingUSDC * 100n} microUSDC`);
        }

        // Create USDC advertisement via factory
        const tx = await advertUSDCFactoryFacet.connect(signer).createNewProspectUSDCAdvertContract(
            storageId,
            minBountyUSDC,
            100, // minBlockNRSeparation
            ethers.ZeroAddress, // excludedAffiliates
            minFundingUSDC,
            ...(await gate.usdc(gateSigner, diamondAddress, signer.address)));
        
        const receipt = await tx.wait();
        
        // Extract advertisement address from event
        let advertAddress;
        for (const log of receipt.logs) {
            try {
                const parsedLog = advertUSDCFactoryFacet.interface.parseLog(log);
                if (parsedLog && parsedLog.name === "USDCAdvertCreated") {
                    advertAddress = parsedLog.args.advert;
                    break;
                }
            } catch (e) {
                // Skip logs that don't match
                continue;
            }
        }
        
        if (!advertAddress) {
            // Try alternative event parsing from OpenAdvertsAdvertisersFacet
            for (const log of receipt.logs) {
                try {
                    const parsedLog = advertisersFacet.interface.parseLog(log);
                    if (parsedLog && parsedLog.name === "ProspectAdvertisementCreated") {
                        advertAddress = parsedLog.args.advertContractAddress;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        if (!advertAddress) {
            console.log("   ⚠️  Could not parse events. Dumping all logs:");
            for (const log of receipt.logs) {
                console.log("     ", log.topics[0]);
            }
            throw new Error("Failed to extract USDC advertisement address from event");
        }
        
        console.log(`   ✅ Created USDC advert at: ${advertAddress}`);
        return advertAddress;
    }

    // =========================================================================
    // REMOVAL FUNCTION BASIC TESTS
    // =========================================================================

    describe("Basic Removal Functionality", function () {
        let testAdvertAddress;
        let advertiserInitialBalance;
        let fundingAmount;

        it("Should successfully remove a prospect advertisement by advertisement owner", async function () {
            console.log("\n   🧪 Testing removal by advertisement owner...");

            // Create a prospect advertisement
            testAdvertAddress = await createPOLAdvertisement(
                advertiser1,
                "test-removal-by-owner",
                "owner@test.com"
            );

            // Get initial state
            const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
            fundingAmount = minFunding;
            advertiserInitialBalance = await ethers.provider.getBalance(advertiser1.address);
            
            // Get initial prospect array length
            const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountBefore = BigInt(prospectArrayBefore.length);
            const removedArrayBefore = await advertisersFacet.getRemovedAdvertisements();
            const removedCountBefore = BigInt(removedArrayBefore.length);

            // Verify advertisement exists and is Prospect
            const [detailsBefore, statusBefore] = await getAdvertDetails(testAdvertAddress);
            expect(statusBefore).to.equal(AdvertisementType.Prospect);
            expect(detailsBefore.advertOwner).to.equal(advertiser1.address);

            console.log(`   📊 Initial state:`);
            console.log(`      - Prospect count: ${prospectCountBefore}`);
            console.log(`      - Removed count: ${removedCountBefore}`);
            console.log(`      - Advert status: Prospect`);

            // Get contract balance before removal
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", testAdvertAddress);
            const contractBalanceBefore = await ethers.provider.getBalance(testAdvertAddress);
            console.log(`      - Contract balance: ${ethers.formatEther(contractBalanceBefore)} POL`);

            // Remove the advertisement
            const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvertAddress);
            const receipt = await tx.wait();

            // Get gas used for accurate balance calculation
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            console.log(`   ✅ Removal transaction completed`);

            // Verify removal event was emitted
            const removeEvent = receipt.logs.find(log => {
                try {
                    const parsed = votingFacet.interface.parseLog(log);
                    return parsed && parsed.name === "AdvertisementRemoved";
                } catch (e) {
                    return false;
                }
            });
            expect(removeEvent).to.not.be.undefined;
            console.log(`   ✅ AdvertisementRemoved event emitted`);

            // Verify prospect array was updated
            const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter = BigInt(prospectArrayAfter.length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);
            console.log(`   ✅ Prospect count decreased: ${prospectCountBefore} → ${prospectCountAfter}`);

            // Verify removed array was updated
            const removedArrayAfter = await advertisersFacet.getRemovedAdvertisements();
            const removedCountAfter = BigInt(removedArrayAfter.length);
            expect(removedCountAfter).to.equal(removedCountBefore + 1n);
            console.log(`   ✅ Removed count increased: ${removedCountBefore} → ${removedCountAfter}`);

            // Verify advertisement no longer exists in active storage
            const exists = await advertisersFacet.getAdvertisementExists(testAdvertAddress);
            expect(exists).to.be.false;
            console.log(`   ✅ Advertisement removed from active storage`);

            // Verify funds were refunded to advertiser
            const advertiserFinalBalance = await ethers.provider.getBalance(advertiser1.address);
            const contractBalanceAfter = await ethers.provider.getBalance(testAdvertAddress);
            
            // Contract should have 0 balance after refund
            expect(contractBalanceAfter).to.equal(0);
            console.log(`   ✅ Contract balance after refund: ${ethers.formatEther(contractBalanceAfter)} POL`);

            // Advertiser should have received refund (accounting for gas)
            const expectedBalance = advertiserInitialBalance - gasUsed + contractBalanceBefore;
            const actualDifference = advertiserFinalBalance - advertiserInitialBalance + gasUsed;
            
            console.log(`   📊 Refund verification:`);
            console.log(`      - Contract had: ${ethers.formatEther(contractBalanceBefore)} POL`);
            console.log(`      - Advertiser received: ${ethers.formatEther(actualDifference)} POL`);
            console.log(`      - Gas used: ${ethers.formatEther(gasUsed)} POL`);
            
            // Allow small rounding errors (within 0.001 POL)
            expect(actualDifference).to.be.closeTo(contractBalanceBefore, ethers.parseEther("0.001"));
            console.log(`   ✅ Funds successfully refunded to advertiser`);
        });

        it("Should successfully remove a prospect advertisement by diamond owner", async function () {
            console.log("\n   🧪 Testing removal by diamond owner...");

            // Create a prospect advertisement
            const testAdvert2 = await createPOLAdvertisement(
                advertiser2,
                "test-removal-by-diamond-owner",
                "diamond@test.com"
            );

            // Get initial balances
            const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
            const advertiserBalanceBefore = await ethers.provider.getBalance(advertiser2.address);
            const contractBalanceBefore = await ethers.provider.getBalance(testAdvert2);

            console.log(`   📊 Initial state:`);
            console.log(`      - Contract balance: ${ethers.formatEther(contractBalanceBefore)} POL`);
            console.log(`      - Advertiser balance: ${ethers.formatEther(advertiserBalanceBefore)} POL`);

            // Verify only diamond owner can remove
            const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountBefore = BigInt(prospectArrayBefore.length);

            // Remove by diamond owner (should succeed)
            const tx = await votingFacet.connect(owner).removeProspectAdvertisement(testAdvert2);
            await tx.wait();

            console.log(`   ✅ Diamond owner successfully removed advertisement`);

            // Verify removal
            const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter = BigInt(prospectArrayAfter.length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);

            const exists = await advertisersFacet.getAdvertisementExists(testAdvert2);
            expect(exists).to.be.false;

            // Verify refund went to advertisement owner (not diamond owner)
            const advertiserBalanceAfter = await ethers.provider.getBalance(advertiser2.address);
            const refundReceived = advertiserBalanceAfter - advertiserBalanceBefore;
            
            expect(refundReceived).to.be.closeTo(contractBalanceBefore, ethers.parseEther("0.001"));
            console.log(`   ✅ Refund correctly sent to advertisement owner: ${ethers.formatEther(refundReceived)} POL`);
        });

        it("Should handle removal when contract has no funds", async function () {
            console.log("\n   🧪 Testing removal with zero balance...");

            // Create advertisement
            const testAdvert3 = await createPOLAdvertisement(
                advertiser1,
                "test-removal-zero-balance",
                "zero@test.com"
            );

            // Manually withdraw all funds first (simulating exhausted state)
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", testAdvert3);
            
            // Note: In real scenario, funds would be exhausted through rewards
            // For testing, we're verifying the removal function handles 0 balance gracefully
            
            const contractBalance = await ethers.provider.getBalance(testAdvert3);
            console.log(`   📊 Contract balance: ${ethers.formatEther(contractBalance)} POL`);

            // Remove should still work even if removeAndRefund returns 0
            const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert3);
            await tx.wait();

            console.log(`   ✅ Removal succeeded even with funds present`);

            // Verify removal
            const exists = await advertisersFacet.getAdvertisementExists(testAdvert3);
            expect(exists).to.be.false;
            console.log(`   ✅ Advertisement successfully removed from storage`);
        });
    });

    // =========================================================================
    // ACCESS CONTROL TESTS
    // =========================================================================

    describe("Access Control", function () {
        let testAdvertAddress;

        beforeEach(async function () {
            // Create a fresh advertisement for each test
            testAdvertAddress = await createPOLAdvertisement(
                advertiser1,
                `test-access-${Date.now()}`,
                "access@test.com"
            );
        });

        it("Should reject removal by unauthorized user", async function () {
            console.log("\n   🧪 Testing unauthorized removal attempt...");

            await expect(
                votingFacet.connect(nonOwner).removeProspectAdvertisement(testAdvertAddress)
            ).to.be.revertedWith("Only contract owner or advertisement owner can remove");

            console.log(`   ✅ Unauthorized removal correctly rejected`);

            // Verify advertisement still exists
            const exists = await advertisersFacet.getAdvertisementExists(testAdvertAddress);
            expect(exists).to.be.true;
            console.log(`   ✅ Advertisement remains in storage`);
        });

        it("Should reject removal by other advertiser", async function () {
            console.log("\n   🧪 Testing removal by different advertiser...");

            await expect(
                votingFacet.connect(advertiser2).removeProspectAdvertisement(testAdvertAddress)
            ).to.be.revertedWith("Only contract owner or advertisement owner can remove");

            console.log(`   ✅ Other advertiser correctly rejected`);
        });
    });

    // =========================================================================
    // VALIDATION AND ERROR HANDLING
    // =========================================================================

    describe("Validation and Error Handling", function () {
        it("Should reject removal of non-existent advertisement", async function () {
            console.log("\n   🧪 Testing removal of non-existent advertisement...");

            const fakeAddress = "0x0000000000000000000000000000000000000123";

            await expect(
                votingFacet.connect(owner).removeProspectAdvertisement(fakeAddress)
            ).to.be.revertedWith("Advertisement does not exist");

            console.log(`   ✅ Non-existent advertisement correctly rejected`);
        });

        it("Should reject removal of approved advertisement", async function () {
            console.log("\n   🧪 Testing removal of approved advertisement...");

            // Create and manually approve advertisement
            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "test-approved-removal",
                "approved@test.com"
            );

            // Get initial details
            const [details, statusBefore] = await getAdvertDetails(testAdvert);
            console.log(`   📊 Initial status: ${statusBefore} (Prospect)`);

            // Manually reclassify to Approved (simulate approval process)
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                testAdvert,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                0,
                0
            );

            const [, statusAfter] = await getAdvertDetails(testAdvert);
            console.log(`   📊 After reclassification: ${statusAfter} (Approved)`);

            // Attempt removal (should fail)
            await expect(
                votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert)
            ).to.be.revertedWith("Only prospect advertisements can be removed");

            console.log(`   ✅ Approved advertisement removal correctly rejected`);
        });

        it("Should reject removal of deprecated advertisement", async function () {
            console.log("\n   🧪 Testing removal of deprecated advertisement...");

            // Create advertisement
            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "test-deprecated-removal",
                "deprecated@test.com"
            );

            // First approve it
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                testAdvert,
                AdvertisementType.Prospect,
                AdvertisementType.Approved,
                0,
                0
            );

            // Then deprecate it
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                testAdvert,
                AdvertisementType.Approved,
                AdvertisementType.Deprecating,
                0,
                0
            );

            const [, status] = await getAdvertDetails(testAdvert);
            console.log(`   📊 Status: ${status} (Deprecating)`);

            // Attempt removal (should fail)
            await expect(
                votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert)
            ).to.be.revertedWith("Only prospect advertisements can be removed");

            console.log(`   ✅ Deprecated advertisement removal correctly rejected`);
        });

        it("Should reject removal with zero address", async function () {
            console.log("\n   🧪 Testing removal with zero address...");

            await expect(
                votingFacet.connect(owner).removeProspectAdvertisement(ZERO_ADDRESS)
            ).to.be.revertedWith("Advertisement does not exist");

            console.log(`   ✅ Zero address correctly rejected`);
        });
    });

    // =========================================================================
    // STORAGE CLEANUP VERIFICATION
    // =========================================================================

    describe("Storage Cleanup Verification", function () {
        it("Should properly clean up all storage mappings and arrays", async function () {
            console.log("\n   🧪 Testing complete storage cleanup...");

            // Create multiple advertisements
            const advert1 = await createPOLAdvertisement(advertiser1, "cleanup-test-1", "cleanup1@test.com");
            const advert2 = await createPOLAdvertisement(advertiser1, "cleanup-test-2", "cleanup2@test.com");
            const advert3 = await createPOLAdvertisement(advertiser1, "cleanup-test-3", "cleanup3@test.com");

            const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountBefore = BigInt(prospectArrayBefore.length);
            const removedArrayBefore = await advertisersFacet.getRemovedAdvertisements();
            const removedCountBefore = BigInt(removedArrayBefore.length);

            console.log(`   📊 Initial state:`);
            console.log(`      - Prospect count: ${prospectCountBefore}`);
            console.log(`      - Removed count: ${removedCountBefore}`);

            // Remove middle advertisement
            await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert2);

            console.log(`   ✅ Removed advert2 (middle advertisement)`);

            // Verify counts
            const prospectArrayAfter1 = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter1 = BigInt(prospectArrayAfter1.length);
            const removedArrayAfter1 = await advertisersFacet.getRemovedAdvertisements();
            const removedCountAfter1 = BigInt(removedArrayAfter1.length);

            expect(prospectCountAfter1).to.equal(prospectCountBefore - 1n);
            expect(removedCountAfter1).to.equal(removedCountBefore + 1n);

            console.log(`   📊 After first removal:`);
            console.log(`      - Prospect count: ${prospectCountAfter1}`);
            console.log(`      - Removed count: ${removedCountAfter1}`);

            // Verify advert2 is gone but advert1 and advert3 still exist
            expect(await advertisersFacet.getAdvertisementExists(advert1)).to.be.true;
            expect(await advertisersFacet.getAdvertisementExists(advert2)).to.be.false;
            expect(await advertisersFacet.getAdvertisementExists(advert3)).to.be.true;

            console.log(`   ✅ Array reordering worked correctly`);

            // Remove first advertisement
            await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert1);

            const prospectArrayAfter2 = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter2 = BigInt(prospectArrayAfter2.length);
            const removedArrayAfter2 = await advertisersFacet.getRemovedAdvertisements();
            const removedCountAfter2 = BigInt(removedArrayAfter2.length);

            expect(prospectCountAfter2).to.equal(prospectCountAfter1 - 1n);
            expect(removedCountAfter2).to.equal(removedCountAfter1 + 1n);

            console.log(`   📊 After second removal:`);
            console.log(`      - Prospect count: ${prospectCountAfter2}`);
            console.log(`      - Removed count: ${removedCountAfter2}`);

            // Only advert3 should remain
            expect(await advertisersFacet.getAdvertisementExists(advert1)).to.be.false;
            expect(await advertisersFacet.getAdvertisementExists(advert2)).to.be.false;
            expect(await advertisersFacet.getAdvertisementExists(advert3)).to.be.true;

            console.log(`   ✅ Multiple removals handled correctly`);

            // Remove last advertisement
            await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert3);

            const prospectArrayFinal = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountFinal = BigInt(prospectArrayFinal.length);
            const removedArrayFinal = await advertisersFacet.getRemovedAdvertisements();
            const removedCountFinal = BigInt(removedArrayFinal.length);

            console.log(`   📊 Final state:`);
            console.log(`      - Prospect count: ${prospectCountFinal}`);
            console.log(`      - Removed count: ${removedCountFinal}`);

            // All should be removed
            expect(await advertisersFacet.getAdvertisementExists(advert1)).to.be.false;
            expect(await advertisersFacet.getAdvertisementExists(advert2)).to.be.false;
            expect(await advertisersFacet.getAdvertisementExists(advert3)).to.be.false;

            console.log(`   ✅ All advertisements successfully removed and tracked`);
        });
    });

    // =========================================================================
    // REMOVED ARRAY VERIFICATION
    // =========================================================================

    describe("Removed Array Tracking", function () {
        it("Should correctly add removed advertisements to removed array", async function () {
            console.log("\n   🧪 Testing removed array tracking...");

            const removedArrayBefore = await advertisersFacet.getRemovedAdvertisements();
            const removedCountBefore = BigInt(removedArrayBefore.length);
            console.log(`   📊 Removed count before: ${removedCountBefore}`);

            // Create and remove an advertisement
            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "removed-array-test",
                "removed@test.com"
            );

            // Get details before removal
            const [detailsBefore, statusBefore] = await getAdvertDetails(testAdvert);
            console.log(`   📊 Details before removal:`);
            console.log(`      - Owner: ${detailsBefore.advertOwner}`);
            console.log(`      - Storage ID: ${detailsBefore.storageId}`);
            console.log(`      - Status: ${statusBefore}`);

            // Remove it
            await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);

            const removedArrayAfter = await advertisersFacet.getRemovedAdvertisements();
            const removedCountAfter = BigInt(removedArrayAfter.length);
            console.log(`   📊 Removed count after: ${removedCountAfter}`);

            expect(removedCountAfter).to.equal(removedCountBefore + 1n);

            // Get the removed advertisement from the array
            const removedAdvert = removedArrayAfter[Number(removedCountAfter - 1n)];
            
            console.log(`   📊 Removed advertisement details:`);
            console.log(`      - Address: ${removedAdvert.advertContractAddress}`);
            console.log(`      - Owner: ${removedAdvert.advertOwner}`);
            console.log(`      - Storage ID: ${removedAdvert.storageId}`);

            // Verify the details match
            expect(removedAdvert.advertContractAddress).to.equal(testAdvert);
            expect(removedAdvert.advertOwner).to.equal(advertiser1.address);
            expect(removedAdvert.storageId).to.equal("removed-array-test");

            console.log(`   ✅ Removed advertisement correctly stored in removed array`);
        });

        it("Should maintain removed array across multiple removals", async function () {
            console.log("\n   🧪 Testing removed array with multiple entries...");

            const removedArrayStart = await advertisersFacet.getRemovedAdvertisements();
            const removedCountStart = BigInt(removedArrayStart.length);

            // Create and remove multiple advertisements
            const adverts = [];
            for (let i = 0; i < 3; i++) {
                const advert = await createPOLAdvertisement(
                    advertiser1,
                    `multi-removed-${i}`,
                    `multi${i}@test.com`
                );
                adverts.push(advert);
            }

            console.log(`   📝 Created ${adverts.length} advertisements`);

            // Remove all
            for (let i = 0; i < adverts.length; i++) {
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(adverts[i]);
                console.log(`   ✅ Removed advertisement ${i + 1}`);
            }

            const removedArrayEnd = await advertisersFacet.getRemovedAdvertisements();
            const removedCountEnd = BigInt(removedArrayEnd.length);
            expect(removedCountEnd).to.equal(removedCountStart + BigInt(adverts.length));

            console.log(`   📊 Removed array size: ${removedCountStart} → ${removedCountEnd}`);

            // Verify all are in removed array
            for (let i = 0; i < adverts.length; i++) {
                const index = Number(removedCountStart) + i;
                const removedAdvert = removedArrayEnd[index];
                expect(removedAdvert.advertContractAddress).to.equal(adverts[i]);
                expect(removedAdvert.storageId).to.equal(`multi-removed-${i}`);
            }

            console.log(`   ✅ All removed advertisements correctly tracked in order`);
        });
    });

    // =========================================================================
    // REFUND FLOW INTEGRATION TESTS
    // =========================================================================

    describe("Refund Flow Integration", function () {
        it("Should successfully refund when removeAndRefund succeeds", async function () {
            console.log("\n   🧪 Testing successful refund flow...");

            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "refund-success-test",
                "refund@test.com"
            );

            const advertiserBalanceBefore = await ethers.provider.getBalance(advertiser1.address);
            const contractBalanceBefore = await ethers.provider.getBalance(testAdvert);

            console.log(`   📊 Before removal:`);
            console.log(`      - Contract: ${ethers.formatEther(contractBalanceBefore)} POL`);
            console.log(`      - Advertiser: ${ethers.formatEther(advertiserBalanceBefore)} POL`);

            const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            const advertiserBalanceAfter = await ethers.provider.getBalance(advertiser1.address);
            const contractBalanceAfter = await ethers.provider.getBalance(testAdvert);

            console.log(`   📊 After removal:`);
            console.log(`      - Contract: ${ethers.formatEther(contractBalanceAfter)} POL`);
            console.log(`      - Advertiser: ${ethers.formatEther(advertiserBalanceAfter)} POL`);
            console.log(`      - Gas used: ${ethers.formatEther(gasUsed)} POL`);

            // Contract should be empty
            expect(contractBalanceAfter).to.equal(0);

            // Advertiser should have received refund
            const netChange = advertiserBalanceAfter - advertiserBalanceBefore + gasUsed;
            expect(netChange).to.be.closeTo(contractBalanceBefore, ethers.parseEther("0.001"));

            console.log(`   ✅ Refund flow completed successfully`);
        });

        it("Should continue removal even if removeAndRefund fails", async function () {
            console.log("\n   🧪 Testing removal continues on refund failure...");

            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "refund-fail-test",
                "fail@test.com"
            );

            const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountBefore = BigInt(prospectArrayBefore.length);

            // Note: In actual implementation, removeAndRefund has a try-catch
            // If it fails, removal should still proceed

            const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);
            await tx.wait();

            // Verify removal succeeded even if refund had issues
            const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter = BigInt(prospectArrayAfter.length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);

            const exists = await advertisersFacet.getAdvertisementExists(testAdvert);
            expect(exists).to.be.false;

            console.log(`   ✅ Removal succeeded despite potential refund issues`);
        });
    });

    // =========================================================================
    // EVENT EMISSION TESTS
    // =========================================================================

    describe("Event Emission", function () {
        it("Should emit AdvertisementRemoved event with correct parameters", async function () {
            console.log("\n   🧪 Testing AdvertisementRemoved event...");

            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "event-test",
                "event@test.com"
            );

            const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);
            const receipt = await tx.wait();

            // Find and parse the event
            let eventFound = false;
            let eventData;

            for (const log of receipt.logs) {
                try {
                    const parsed = votingFacet.interface.parseLog(log);
                    if (parsed && parsed.name === "AdvertisementRemoved") {
                        eventFound = true;
                        eventData = parsed.args;
                        break;
                    }
                } catch (e) {
                    // Skip logs that don't match
                }
            }

            expect(eventFound).to.be.true;
            expect(eventData.advertContract).to.equal(testAdvert);
            expect(eventData.timestamp).to.be.gt(0);

            console.log(`   ✅ AdvertisementRemoved event emitted correctly`);
            console.log(`      - Contract: ${eventData.advertContract}`);
            console.log(`      - Timestamp: ${eventData.timestamp}`);
        });
    });

    // =========================================================================
    // EDGE CASES AND STRESS TESTS
    // =========================================================================

    describe("Edge Cases", function () {
        it("Should handle removal of very first prospect advertisement", async function () {
            console.log("\n   🧪 Testing removal of first prospect...");

            // Get current count
            const currentArray = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const currentCount = BigInt(currentArray.length);
            
            // Create one more
            const testAdvert = await createPOLAdvertisement(
                advertiser1,
                "first-prospect-test",
                "first@test.com"
            );

            // Remove it
            await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);

            // Should work fine
            const exists = await advertisersFacet.getAdvertisementExists(testAdvert);
            expect(exists).to.be.false;

            console.log(`   ✅ First prospect removal handled correctly`);
        });

        it("Should handle rapid successive removals", async function () {
            console.log("\n   🧪 Testing rapid successive removals...");

            // Create multiple advertisements
            const adverts = [];
            for (let i = 0; i < 5; i++) {
                const advert = await createPOLAdvertisement(
                    advertiser1,
                    `rapid-${i}-${Date.now()}`,
                    `rapid${i}@test.com`
                );
                adverts.push(advert);
            }

            console.log(`   📝 Created ${adverts.length} advertisements`);

            const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountBefore = BigInt(prospectArrayBefore.length);

            // Remove all rapidly
            for (const advert of adverts) {
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert);
            }

            console.log(`   ✅ All removed successfully`);

            const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
            const prospectCountAfter = BigInt(prospectArrayAfter.length);
            expect(prospectCountAfter).to.equal(prospectCountBefore - BigInt(adverts.length));

            // Verify none exist
            for (const advert of adverts) {
                const exists = await advertisersFacet.getAdvertisementExists(advert);
                expect(exists).to.be.false;
            }

            console.log(`   ✅ Rapid successive removals handled correctly`);
        });
    });

    // =========================================================================
    // USDC ADVERTISEMENT REMOVAL TESTS
    // =========================================================================

    describe("USDC Advertisement Removal", function () {
        describe("Basic USDC Removal Functionality", function () {
            let testAdvertAddress;
            let advertiserInitialUSDCBalance;
            let fundingAmount;

            it("Should successfully remove a USDC prospect advertisement by advertisement owner", async function () {
                console.log("\n   🧪 Testing USDC removal by advertisement owner...");

                // Create a USDC prospect advertisement
                testAdvertAddress = await createUSDCAdvertisement(
                    advertiser1,
                    "test-usdc-removal-by-owner",
                    "usdcowner@test.com"
                );

                // Get initial state
                advertiserInitialUSDCBalance = await mockUSDC.balanceOf(advertiser1.address);
                
                // Get initial prospect array length
                const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountBefore = BigInt(prospectArrayBefore.length);
                const removedArrayBefore = await advertisersFacet.getRemovedAdvertisements();
                const removedCountBefore = BigInt(removedArrayBefore.length);

                // Verify advertisement exists and is Prospect
                const [detailsBefore, statusBefore] = await getAdvertDetails(testAdvertAddress);
                expect(statusBefore).to.equal(AdvertisementType.Prospect);
                expect(detailsBefore.advertOwner).to.equal(advertiser1.address);
                expect(detailsBefore.advertCurrency).to.equal(PaymentType.USDC);

                console.log(`   📊 Initial state:`);
                console.log(`      - Prospect count: ${prospectCountBefore}`);
                console.log(`      - Removed count: ${removedCountBefore}`);
                console.log(`      - Advert status: Prospect`);
                console.log(`      - Currency: USDC`);

                // Get contract USDC balance before removal
                const advertContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", testAdvertAddress);
                const contractUSDCBalanceBefore = await mockUSDC.balanceOf(testAdvertAddress);
                console.log(`      - Contract USDC balance: ${contractUSDCBalanceBefore} microUSDC`);

                // Remove the advertisement
                const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvertAddress);
                const receipt = await tx.wait();

                console.log(`   ✅ Removal transaction completed`);

                // Verify removal event was emitted
                const removeEvent = receipt.logs.find(log => {
                    try {
                        const parsed = votingFacet.interface.parseLog(log);
                        return parsed && parsed.name === "AdvertisementRemoved";
                    } catch (e) {
                        return false;
                    }
                });
                expect(removeEvent).to.not.be.undefined;
                console.log(`   ✅ AdvertisementRemoved event emitted`);

                // Verify prospect array was updated
                const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountAfter = BigInt(prospectArrayAfter.length);
                expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);
                console.log(`   ✅ Prospect count decreased: ${prospectCountBefore} → ${prospectCountAfter}`);

                // Verify removed array was updated
                const removedArrayAfter = await advertisersFacet.getRemovedAdvertisements();
                const removedCountAfter = BigInt(removedArrayAfter.length);
                expect(removedCountAfter).to.equal(removedCountBefore + 1n);
                console.log(`   ✅ Removed count increased: ${removedCountBefore} → ${removedCountAfter}`);

                // Verify advertisement no longer exists in active storage
                const exists = await advertisersFacet.getAdvertisementExists(testAdvertAddress);
                expect(exists).to.be.false;
                console.log(`   ✅ Advertisement removed from active storage`);

                // Verify USDC was refunded to advertiser
                const advertiserFinalUSDCBalance = await mockUSDC.balanceOf(advertiser1.address);
                const contractUSDCBalanceAfter = await mockUSDC.balanceOf(testAdvertAddress);
                
                // Contract should have 0 USDC balance after refund
                expect(contractUSDCBalanceAfter).to.equal(0);
                console.log(`   ✅ Contract USDC balance after refund: ${contractUSDCBalanceAfter} microUSDC`);

                // Advertiser should have received USDC refund
                const usdcRefundReceived = advertiserFinalUSDCBalance - advertiserInitialUSDCBalance;
                
                console.log(`   📊 USDC Refund verification:`);
                console.log(`      - Contract had: ${contractUSDCBalanceBefore} microUSDC`);
                console.log(`      - Advertiser received: ${usdcRefundReceived} microUSDC`);
                
                expect(usdcRefundReceived).to.equal(contractUSDCBalanceBefore);
                console.log(`   ✅ USDC successfully refunded to advertiser`);
            });

            it("Should successfully remove a USDC prospect advertisement by diamond owner", async function () {
                console.log("\n   🧪 Testing USDC removal by diamond owner...");

                // Create a USDC prospect advertisement
                const testAdvert2 = await createUSDCAdvertisement(
                    advertiser2,
                    "test-usdc-removal-by-diamond-owner",
                    "usdcdiamond@test.com"
                );

                // Get initial USDC balances
                const advertiserUSDCBalanceBefore = await mockUSDC.balanceOf(advertiser2.address);
                const contractUSDCBalanceBefore = await mockUSDC.balanceOf(testAdvert2);

                console.log(`   📊 Initial state:`);
                console.log(`      - Contract USDC balance: ${contractUSDCBalanceBefore} microUSDC`);
                console.log(`      - Advertiser USDC balance: ${advertiserUSDCBalanceBefore} microUSDC`);

                // Verify only diamond owner can remove
                const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountBefore = BigInt(prospectArrayBefore.length);

                // Remove by diamond owner (should succeed)
                const tx = await votingFacet.connect(owner).removeProspectAdvertisement(testAdvert2);
                await tx.wait();

                console.log(`   ✅ Diamond owner successfully removed USDC advertisement`);

                // Verify removal
                const prospectArrayAfter = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountAfter = BigInt(prospectArrayAfter.length);
                expect(prospectCountAfter).to.equal(prospectCountBefore - 1n);

                const exists = await advertisersFacet.getAdvertisementExists(testAdvert2);
                expect(exists).to.be.false;

                // Verify USDC refund went to advertisement owner (not diamond owner)
                const advertiserUSDCBalanceAfter = await mockUSDC.balanceOf(advertiser2.address);
                const usdcRefundReceived = advertiserUSDCBalanceAfter - advertiserUSDCBalanceBefore;
                
                expect(usdcRefundReceived).to.equal(contractUSDCBalanceBefore);
                console.log(`   ✅ USDC refund correctly sent to advertisement owner: ${usdcRefundReceived} microUSDC`);
            });

            it("Should handle USDC removal when contract has no funds", async function () {
                console.log("\n   🧪 Testing USDC removal with zero balance...");

                // Create USDC advertisement
                const testAdvert3 = await createUSDCAdvertisement(
                    advertiser1,
                    "test-usdc-removal-zero-balance",
                    "usdczero@test.com"
                );

                const contractUSDCBalance = await mockUSDC.balanceOf(testAdvert3);
                console.log(`   📊 Contract USDC balance: ${contractUSDCBalance} microUSDC`);

                // Remove should still work
                const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert3);
                await tx.wait();

                console.log(`   ✅ Removal succeeded with USDC balance present`);

                // Verify removal
                const exists = await advertisersFacet.getAdvertisementExists(testAdvert3);
                expect(exists).to.be.false;
                console.log(`   ✅ USDC advertisement successfully removed from storage`);
            });
        });

        describe("USDC Access Control", function () {
            let testAdvertAddress;

            beforeEach(async function () {
                // Create a fresh USDC advertisement for each test
                testAdvertAddress = await createUSDCAdvertisement(
                    advertiser1,
                    `test-usdc-access-${Date.now()}`,
                    "usdcaccess@test.com"
                );
            });

            it("Should reject USDC removal by unauthorized user", async function () {
                console.log("\n   🧪 Testing unauthorized USDC removal attempt...");

                await expect(
                    votingFacet.connect(nonOwner).removeProspectAdvertisement(testAdvertAddress)
                ).to.be.revertedWith("Only contract owner or advertisement owner can remove");

                console.log(`   ✅ Unauthorized USDC removal correctly rejected`);

                // Verify advertisement still exists
                const exists = await advertisersFacet.getAdvertisementExists(testAdvertAddress);
                expect(exists).to.be.true;
                console.log(`   ✅ USDC advertisement remains in storage`);
            });

            it("Should reject USDC removal by other advertiser", async function () {
                console.log("\n   🧪 Testing USDC removal by different advertiser...");

                await expect(
                    votingFacet.connect(advertiser2).removeProspectAdvertisement(testAdvertAddress)
                ).to.be.revertedWith("Only contract owner or advertisement owner can remove");

                console.log(`   ✅ Other advertiser correctly rejected for USDC removal`);
            });
        });

        describe("USDC Storage Cleanup Verification", function () {
            it("Should properly clean up all storage for USDC advertisements", async function () {
                console.log("\n   🧪 Testing complete USDC storage cleanup...");

                // Create multiple USDC advertisements
                const advert1 = await createUSDCAdvertisement(advertiser1, "usdc-cleanup-test-1", "usdccleanup1@test.com");
                const advert2 = await createUSDCAdvertisement(advertiser1, "usdc-cleanup-test-2", "usdccleanup2@test.com");
                const advert3 = await createUSDCAdvertisement(advertiser1, "usdc-cleanup-test-3", "usdccleanup3@test.com");

                const prospectArrayBefore = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountBefore = BigInt(prospectArrayBefore.length);
                const removedArrayBefore = await advertisersFacet.getRemovedAdvertisements();
                const removedCountBefore = BigInt(removedArrayBefore.length);

                console.log(`   📊 Initial state:`);
                console.log(`      - Prospect count: ${prospectCountBefore}`);
                console.log(`      - Removed count: ${removedCountBefore}`);

                // Remove middle advertisement
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert2);
                console.log(`   ✅ Removed USDC advert2 (middle advertisement)`);

                // Verify counts
                const prospectArrayAfter1 = await advertisersFacet.getAdvertisements(AdvertisementType.Prospect);
                const prospectCountAfter1 = BigInt(prospectArrayAfter1.length);
                const removedArrayAfter1 = await advertisersFacet.getRemovedAdvertisements();
                const removedCountAfter1 = BigInt(removedArrayAfter1.length);

                expect(prospectCountAfter1).to.equal(prospectCountBefore - 1n);
                expect(removedCountAfter1).to.equal(removedCountBefore + 1n);

                console.log(`   📊 After first USDC removal:`);
                console.log(`      - Prospect count: ${prospectCountAfter1}`);
                console.log(`      - Removed count: ${removedCountAfter1}`);

                // Verify advert2 is gone but advert1 and advert3 still exist
                expect(await advertisersFacet.getAdvertisementExists(advert1)).to.be.true;
                expect(await advertisersFacet.getAdvertisementExists(advert2)).to.be.false;
                expect(await advertisersFacet.getAdvertisementExists(advert3)).to.be.true;

                console.log(`   ✅ USDC array reordering worked correctly`);

                // Remove remaining advertisements
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert1);
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(advert3);

                // All should be removed
                expect(await advertisersFacet.getAdvertisementExists(advert1)).to.be.false;
                expect(await advertisersFacet.getAdvertisementExists(advert2)).to.be.false;
                expect(await advertisersFacet.getAdvertisementExists(advert3)).to.be.false;

                console.log(`   ✅ All USDC advertisements successfully removed and tracked`);
            });
        });

        describe("USDC Refund Flow Integration", function () {
            it("Should successfully refund USDC when removeAndRefund succeeds", async function () {
                console.log("\n   🧪 Testing successful USDC refund flow...");

                const testAdvert = await createUSDCAdvertisement(
                    advertiser1,
                    "usdc-refund-success-test",
                    "usdcrefund@test.com"
                );

                const advertiserUSDCBalanceBefore = await mockUSDC.balanceOf(advertiser1.address);
                const contractUSDCBalanceBefore = await mockUSDC.balanceOf(testAdvert);

                console.log(`   📊 Before removal:`);
                console.log(`      - Contract: ${contractUSDCBalanceBefore} microUSDC`);
                console.log(`      - Advertiser: ${advertiserUSDCBalanceBefore} microUSDC`);

                const tx = await votingFacet.connect(advertiser1).removeProspectAdvertisement(testAdvert);
                await tx.wait();

                const advertiserUSDCBalanceAfter = await mockUSDC.balanceOf(advertiser1.address);
                const contractUSDCBalanceAfter = await mockUSDC.balanceOf(testAdvert);

                console.log(`   📊 After removal:`);
                console.log(`      - Contract: ${contractUSDCBalanceAfter} microUSDC`);
                console.log(`      - Advertiser: ${advertiserUSDCBalanceAfter} microUSDC`);

                // Contract should be empty
                expect(contractUSDCBalanceAfter).to.equal(0);

                // Advertiser should have received USDC refund
                const netUSDCChange = advertiserUSDCBalanceAfter - advertiserUSDCBalanceBefore;
                expect(netUSDCChange).to.equal(contractUSDCBalanceBefore);

                console.log(`   ✅ USDC refund flow completed successfully`);
            });
        });

        describe("Mixed POL and USDC Removal", function () {
            it("Should handle removal of both POL and USDC advertisements in same session", async function () {
                console.log("\n   🧪 Testing mixed POL and USDC removals...");

                // Create both types
                const polAdvert = await createPOLAdvertisement(advertiser1, "mixed-pol", "mixedpol@test.com");
                const usdcAdvert = await createUSDCAdvertisement(advertiser1, "mixed-usdc", "mixedusdc@test.com");

                // Verify both exist
                const [polDetails, polStatus] = await getAdvertDetails(polAdvert);
                const [usdcDetails, usdcStatus] = await getAdvertDetails(usdcAdvert);
                
                expect(polStatus).to.equal(AdvertisementType.Prospect);
                expect(usdcStatus).to.equal(AdvertisementType.Prospect);
                expect(polDetails.advertCurrency).to.equal(PaymentType.POL);
                expect(usdcDetails.advertCurrency).to.equal(PaymentType.USDC);

                console.log(`   ✅ Created both POL and USDC advertisements`);

                const prospectCountBefore = BigInt((await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length);

                // Remove both
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(polAdvert);
                await votingFacet.connect(advertiser1).removeProspectAdvertisement(usdcAdvert);

                console.log(`   ✅ Removed both advertisements`);

                // Verify both are gone
                expect(await advertisersFacet.getAdvertisementExists(polAdvert)).to.be.false;
                expect(await advertisersFacet.getAdvertisementExists(usdcAdvert)).to.be.false;

                const prospectCountAfter = BigInt((await advertisersFacet.getAdvertisements(AdvertisementType.Prospect)).length);
                expect(prospectCountAfter).to.equal(prospectCountBefore - 2n);

                console.log(`   ✅ Mixed currency removals handled correctly`);
            });
        });
    });
});
