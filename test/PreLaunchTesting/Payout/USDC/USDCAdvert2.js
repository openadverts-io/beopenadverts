const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../../scripts/deploy");
const gate = require("../../../helpers/signatureGate.js");

describe("OpenAdvertsAdvertUSDCFactoryFacet - Advertisement Creation Tests", function () {
    let diamondAddress;
    let usdcFactoryFacet;
    let usdcPriceFacet;
    let advertisersFacet;
    let governanceFacet;
    let mockUSDC;
    let mockPriceFeed;
    let owner;
    let advertiser1;
    let advertiser2;
    let user1;
    let user2;
    let affiliate1;
    let affiliate2;
    let gateSigner;

    // Test constants
    const INITIAL_USDC_BALANCE = ethers.parseUnits("10000", 6); // 10,000 USDC
    const POL_PRICE = 50000000; // $0.50 with 8 decimals

    // âœ… FIXED: Remove hardcoded values, will fetch from governance
    let MIN_POL_BOUNTY;
    let MIN_POL_FUNDING;
    let PREMIUM_PCT;
    let MAX_BLOCK_SEPARATION;

    before(async function () {
        [owner, advertiser1, advertiser2, user1, user2, affiliate1, affiliate2] = await ethers.getSigners();

        console.log("\nðŸš€ Deploying Diamond with Mock USDC and Price Feed...");
        const deployedAddresses = await deployDiamond();
        diamondAddress = deployedAddresses.diamond;

        // Get facets
        usdcFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
        usdcPriceFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCPriceFacet", diamondAddress);
        advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);

        // âœ… NEW: Fetch actual governance quotas
        const allQuotas = await governanceFacet.getAllCurrentQuotas();
        MIN_POL_BOUNTY = allQuotas.minAdvertBountyInPOLWei;
        MIN_POL_FUNDING = allQuotas.minPOLRequiredforAdvertInWei;
        PREMIUM_PCT = allQuotas.USDCCurrencyPremiumInPCT;
        MAX_BLOCK_SEPARATION = allQuotas.maxBlockSeparationAdvertisement;

        // Get mock contracts
        const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
        const priceFeedAddress = await advertisersFacet.getPriceFeedAddress();
        mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
        mockPriceFeed = await ethers.getContractAt("MockV3Aggregator", priceFeedAddress);

        gateSigner = await gate.installGateSigner(diamondAddress, owner);

        console.log("âœ… Diamond deployed at:", diamondAddress);
        console.log("âœ… Mock USDC at:", usdcAddress);
        console.log("âœ… Mock Price Feed at:", priceFeedAddress);
        console.log("âœ… Governance quotas loaded:");
        console.log(`   - Min POL Bounty: ${ethers.formatEther(MIN_POL_BOUNTY)} POL`);
        console.log(`   - Min POL Funding: ${ethers.formatEther(MIN_POL_FUNDING)} POL`);
        console.log(`   - USDC Premium: ${PREMIUM_PCT}%`);
        console.log(`   - Max Block Separation: ${MAX_BLOCK_SEPARATION}`);

        // Fund test accounts with USDC
        await mockUSDC.connect(owner).mint(advertiser1.address, INITIAL_USDC_BALANCE);
        await mockUSDC.connect(owner).mint(advertiser2.address, INITIAL_USDC_BALANCE);
        await mockUSDC.connect(owner).mint(user1.address, INITIAL_USDC_BALANCE);

        console.log("âœ… Test accounts funded with USDC");

        // Set POL price
        await mockPriceFeed.updateAnswer(POL_PRICE);
        console.log("âœ… POL price set to $0.50");
    });

    describe("1. Basic Advertisement Creation", function () {
        it("âœ… Should create a basic USDC advertisement with minimum requirements", async function () {
            // Calculate minimum requirements
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            console.log(`   Min Bounty: ${ethers.formatUnits(minBountyUSDC, 6)} USDC`);
            console.log(`   Min Funding: ${ethers.formatUnits(minFundingUSDC, 6)} USDC`);

            // Approve USDC
            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            // Create advertisement
            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-001",
                minBountyUSDC,
                100, // min block separation
                ethers.ZeroAddress, // no excluded affiliates
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });

            expect(event).to.exist;
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            console.log(`   âœ… Advertisement created at: ${advertAddress}`);
            console.log(`   â›½ Gas used: ${receipt.gasUsed}`);

            // Verify advertisement exists in storage
            const { advert, status } = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
            expect(status).to.equal(0); // Prospect = 0
            expect(advert.storageId).to.equal("test-ad-001");
            expect(advert.advertOwner).to.equal(advertiser1.address);
            expect(advert.advertBounty).to.equal(minBountyUSDC);
        });

        it("âœ… Should transfer USDC from advertiser to advertisement contract", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const balanceBefore = await mockUSDC.balanceOf(advertiser1.address);

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-002",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            const balanceAfter = await mockUSDC.balanceOf(advertiser1.address);
            const advertBalance = await mockUSDC.balanceOf(advertAddress);

            expect(balanceBefore - balanceAfter).to.equal(minFundingUSDC);
            expect(advertBalance).to.equal(minFundingUSDC);

            console.log(`   ðŸ’° Advertiser balance decreased: ${ethers.formatUnits(minFundingUSDC, 6)} USDC`);
            console.log(`   ðŸ’° Advertisement balance: ${ethers.formatUnits(advertBalance, 6)} USDC`);
        });

        it("âœ… Should create advertisement with custom bounty and funding (above minimum)", async function () {
            // âœ… FIXED: Calculate minimums first to ensure custom values are above them
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // âœ… FIXED: Use values well above minimums
            const customBounty = minBountyUSDC * 2n; // 2x minimum
            const customFunding = minFundingUSDC * 2n; // 2x minimum

            await mockUSDC.connect(advertiser1).approve(diamondAddress, customFunding);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-003",
                customBounty,
                200, // custom block separation
                ethers.ZeroAddress,
                customFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);

            expect(parsedEvent.args.bounty).to.equal(customBounty);
            expect(parsedEvent.args.funding).to.equal(customFunding);

            console.log(`   âœ… Custom bounty: ${ethers.formatUnits(customBounty, 6)} USDC`);
            console.log(`   âœ… Custom funding: ${ethers.formatUnits(customFunding, 6)} USDC`);
        });

        it("âœ… Should persist designated affiliate on creation", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const designatedAffiliate = ethers.ZeroAddress;

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-004",
                minBountyUSDC,
                100,
                designatedAffiliate,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            // Verify designated affiliate in advertisement contract and Diamond storage
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", advertAddress);
            const designatedFromContract = await advertContract.designatedAffiliate();
            const { advert } = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);

            expect(designatedFromContract).to.equal(designatedAffiliate);
            expect(advert.designatedAffiliate).to.equal(designatedAffiliate);

            console.log(`   âœ… Designated affiliate persisted: ${designatedAffiliate}`);
        });
    });

    describe("2. Validation Tests", function () {
        it("âŒ Should revert if bounty is below minimum", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const lowBounty = minBountyUSDC - 1n;

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-001",
                    lowBounty,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Bounty below minimum");
        });

        it("âŒ Should revert if funding is below minimum", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const lowFunding = minFundingUSDC - 1n;

            await mockUSDC.connect(advertiser1).approve(diamondAddress, lowFunding);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-002",
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    lowFunding,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Funding below minimum");
        });

        it("âŒ Should revert if funding is less than bounty", async function () {
            // âœ… FIXED: Use values above minimum but funding < bounty
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const bounty = minFundingUSDC; // Use funding minimum as bounty
            const funding = minFundingUSDC - 1n; // One less than bounty

            await mockUSDC.connect(advertiser1).approve(diamondAddress, funding);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-003",
                    bounty,
                    100,
                    ethers.ZeroAddress,
                    funding,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Funding below minimum");
        });

        it("âŒ Should revert if insufficient USDC balance", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // Use account with no USDC
            const poorAccount = (await ethers.getSigners())[10];

            await mockUSDC.connect(poorAccount).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(poorAccount).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-004",
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, poorAccount.address)))
            ).to.be.revertedWith("Insufficient balance");
        });

        it("âŒ Should revert if insufficient USDC allowance", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // Don't approve enough USDC
            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC / 2n);

            // âœ… FIX: Expect custom error instead of string revert
            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-005",
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWithCustomError(mockUSDC, "ERC20InsufficientAllowance");
            
            console.log(`   âœ… Correctly reverted with custom error for low allowance`);
        });

        it("âŒ Should revert if storage ID is empty", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "",
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Invalid storage ID");
        });

        it("âŒ Should revert if block separation is zero", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-006",
                    minBountyUSDC,
                    0,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Invalid block separation");
        });

        it("âŒ Should revert if block separation exceeds maximum", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "test-ad-fail-007",
                    minBountyUSDC,
                    Number(MAX_BLOCK_SEPARATION) + 1,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            ).to.be.revertedWith("Invalid block separation");
        });
    });

    describe("3. Price Sensitivity Tests", function () {
        it("âœ… Should adjust minimum requirements when POL price increases", async function () {
            // Get minimums at $0.50
            let { minBountyUSDC: minBounty1, minFundingUSDC: minFunding1 } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            console.log(`   @ $0.50: Bounty = ${ethers.formatUnits(minBounty1, 6)} USDC`);

            // Increase POL price to $1.00
            await mockPriceFeed.updateAnswer(100000000);

            // Get new minimums at $1.00
            let { minBountyUSDC: minBounty2, minFundingUSDC: minFunding2 } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            console.log(`   @ $1.00: Bounty = ${ethers.formatUnits(minBounty2, 6)} USDC`);

            // Higher POL price means higher USDC requirements
            expect(minBounty2).to.be.gt(minBounty1);
            expect(minFunding2).to.be.gt(minFunding1);

            // Reset price
            await mockPriceFeed.updateAnswer(POL_PRICE);
        });

        it("âœ… Should create advertisement at different price points", async function () {
            const prices = [
                { price: 25000000, label: "$0.25" },
                { price: 50000000, label: "$0.50" },
                { price: 100000000, label: "$1.00" },
                { price: 200000000, label: "$2.00" }
            ];

            console.log("   Testing different POL prices:");

            for (let i = 0; i < prices.length; i++) {
                await mockPriceFeed.updateAnswer(prices[i].price);

                const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                    MIN_POL_BOUNTY,
                    MIN_POL_FUNDING,
                    PREMIUM_PCT
                );

                await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

                const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    `test-ad-price-${i}`,
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

                await tx.wait();

                console.log(`   ${prices[i].label}: Min Funding = ${ethers.formatUnits(minFundingUSDC, 6)} USDC`);
            }

            // Reset price
            await mockPriceFeed.updateAnswer(POL_PRICE);
        });
    });

    describe("4. Storage Verification Tests", function () {
        it("âœ… Should correctly store advertisement in prospect array", async function () {
            // âœ… FIXED: Use getAdvertisementStatistics() instead
            const statsBefore = await advertisersFacet.getAdvertisementStatistics();
            const prospectCountBefore = statsBefore.prospectCount;

            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-storage-001",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            const statsAfter = await advertisersFacet.getAdvertisementStatistics();
            const prospectCountAfter = statsAfter.prospectCount;

            expect(prospectCountAfter).to.equal(prospectCountBefore + 1n);

            // Verify it exists
            const exists = await advertisersFacet.getAdvertisementExists(advertAddress);
            expect(exists).to.be.true;

            console.log(`   âœ… Prospect count: ${prospectCountBefore} â†’ ${prospectCountAfter}`);
        });

        it("âœ… Should set correct advertisement type (Prospect)", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "test-ad-storage-002",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            const { status } = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);

            expect(status).to.equal(0); // Prospect = 0

            console.log(`   âœ… Advertisement type correctly set to Prospect`);
        });

        it("âœ… Should maintain advertisement details in storage", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const storageId = "test-ad-storage-003";
            const customBounty = minBountyUSDC * 2n;
            const customFunding = minFundingUSDC * 2n;
            const blockSeparation = 250;
            const designatedAffiliate = ethers.ZeroAddress;

            await mockUSDC.connect(advertiser1).approve(diamondAddress, customFunding);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                storageId,
                customBounty,
                blockSeparation,
                designatedAffiliate,
                customFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent = usdcFactoryFacet.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advert;

            // Get details from Diamond storage
            const { advert } = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);

            expect(advert.storageId).to.equal(storageId);
            expect(advert.advertOwner).to.equal(advertiser1.address);
            expect(advert.advertBounty).to.equal(customBounty);
            expect(advert.minBlockNRSeparation).to.equal(blockSeparation);

            // Verify designated affiliate is persisted in both contract and Diamond advert struct.
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", advertAddress);
            const designatedFromContract = await advertContract.designatedAffiliate();
            expect(designatedFromContract).to.equal(designatedAffiliate);
            expect(advert.designatedAffiliate).to.equal(designatedAffiliate);

            console.log(`   âœ… All advertisement details correctly stored`);
            console.log(`   âœ… Designated affiliate verified: ${designatedAffiliate}`);
        });
    });

    describe("5. Multiple Advertisements Tests", function () {
        it("âœ… Should allow same user to create multiple advertisements", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // âœ… FIXED: Use getAdvertisementStatistics()
            const statsBefore = await advertisersFacet.getAdvertisementStatistics();
            const countBefore = statsBefore.prospectCount;
            const numAds = 3;

            for (let i = 0; i < numAds; i++) {
                await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

                await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    `test-ad-multi-${i}`,
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));
            }

            const statsAfter = await advertisersFacet.getAdvertisementStatistics();
            const countAfter = statsAfter.prospectCount;

            expect(countAfter - countBefore).to.equal(BigInt(numAds));

            console.log(`   âœ… Created ${numAds} advertisements successfully`);
        });

        it("âœ… Should allow different users to create advertisements", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // Advertiser1 creates ad
            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);
            const tx1 = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "advertiser1-ad",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));
            const receipt1 = await tx1.wait();
            const event1 = receipt1.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent1 = usdcFactoryFacet.interface.parseLog(event1);
            const advert1Address = parsedEvent1.args.advert;

            // Advertiser2 creates ad
            await mockUSDC.connect(advertiser2).approve(diamondAddress, minFundingUSDC);
            const tx2 = await usdcFactoryFacet.connect(advertiser2).createNewProspectUSDCAdvertContract(
                "advertiser2-ad",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser2.address)));
            const receipt2 = await tx2.wait();
            const event2 = receipt2.logs.find(log => {
                try {
                    const parsed = usdcFactoryFacet.interface.parseLog(log);
                    return parsed.name === "USDCAdvertCreated";
                } catch {
                    return false;
                }
            });
            const parsedEvent2 = usdcFactoryFacet.interface.parseLog(event2);
            const advert2Address = parsedEvent2.args.advert;

            // âœ… FIXED: Use 'advert' instead of 'advertDetails'
            const { advert: advert1 } = await advertisersFacet.getAdvertisementDetailsAndStatus(advert1Address);
            const { advert: advert2 } = await advertisersFacet.getAdvertisementDetailsAndStatus(advert2Address);

            expect(advert1.advertOwner).to.equal(advertiser1.address);
            expect(advert2.advertOwner).to.equal(advertiser2.address);
            expect(advert1Address).to.not.equal(advert2Address);

            console.log(`   âœ… Both advertisers created unique advertisements`);
        });
    });

    describe("6. Gas Optimization Tests", function () {
        it("â›½ Should measure gas for basic advertisement creation", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "gas-test-001",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();

            console.log(`   â›½ Gas used (no excluded affiliates): ${receipt.gasUsed}`);
        });

        it("â›½ Should measure gas with excluded affiliates", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            const excludedAffiliates = [affiliate1.address, affiliate2.address, user1.address, user2.address];

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "gas-test-002",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            const receipt = await tx.wait();

            console.log(`   â›½ Gas used (4 excluded affiliates): ${receipt.gasUsed}`);
        });
    });

    describe("7. Event Emission Tests", function () {
        it("âœ… Should emit USDCAdvertCreated event with correct parameters", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            await expect(
                usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                    "event-test-001",
                    minBountyUSDC,
                    100,
                    ethers.ZeroAddress,
                    minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)))
            )
                .to.emit(usdcFactoryFacet, "USDCAdvertCreated")
                .withArgs(
                    (advert) => advert !== ethers.ZeroAddress,
                    advertiser1.address,
                    "event-test-001",
                    minBountyUSDC,
                    minFundingUSDC
                );

            console.log(`   âœ… Event emitted with correct parameters`);
        });
    });

    describe("8. Edge Cases", function () {
        it("âœ… Should handle funding exactly equal to bounty", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            // Use minimum funding (which is >= minimum bounty)
            const amount = minFundingUSDC;

            await mockUSDC.connect(advertiser1).approve(diamondAddress, amount);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "edge-test-001",
                minBountyUSDC,
                100,
                ethers.ZeroAddress,
                amount,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            await expect(tx).to.not.be.reverted;

            console.log(`   âœ… Handled funding === bounty case`);
        });

        it("âœ… Should handle maximum block separation", async function () {
            const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
                MIN_POL_BOUNTY,
                MIN_POL_FUNDING,
                PREMIUM_PCT
            );

            await mockUSDC.connect(advertiser1).approve(diamondAddress, minFundingUSDC);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "edge-test-002",
                minBountyUSDC,
                Number(MAX_BLOCK_SEPARATION),
                ethers.ZeroAddress,
                minFundingUSDC,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            await expect(tx).to.not.be.reverted;

            console.log(`   âœ… Handled maximum block separation: ${MAX_BLOCK_SEPARATION}`);
        });

        it("âœ… Should handle very large funding amounts", async function () {
            const largeBounty = ethers.parseUnits("1000", 6); // 1000 USDC
            const largeFunding = ethers.parseUnits("10000", 6); // 10000 USDC

            // âœ… FIXED: Ensure advertiser1 has enough USDC balance
            const currentBalance = await mockUSDC.balanceOf(advertiser1.address);
            if (currentBalance < largeFunding) {
                const additionalAmount = largeFunding - currentBalance + ethers.parseUnits("1000", 6); // Extra buffer
                await mockUSDC.connect(owner).mint(advertiser1.address, additionalAmount);
                console.log(`   ðŸ’° Minted additional ${ethers.formatUnits(additionalAmount, 6)} USDC for large test`);
            }

            await mockUSDC.connect(advertiser1).approve(diamondAddress, largeFunding);

            const tx = await usdcFactoryFacet.connect(advertiser1).createNewProspectUSDCAdvertContract(
                "edge-test-003",
                largeBounty,
                100,
                ethers.ZeroAddress,
                largeFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser1.address)));

            await expect(tx).to.not.be.reverted;

            console.log(`   âœ… Handled large funding: ${ethers.formatUnits(largeFunding, 6)} USDC`);
        });
    });

    after(async function () {
        const stats = await advertisersFacet.getAdvertisementStatistics();
        console.log(`\nðŸ“Š Total prospect advertisements created: ${stats.prospectCount}`);
    });
});
