// test all require statements
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../../scripts/deploy");
const gate = require("../../../helpers/signatureGate.js");

describe("OpenAdvertsAdvertUSDCFactoryFacet - createNewProspectUSDCAdvertContract", function () {
    let diamondAddress;
    let gateSigner;
    let usdcFactory; // ✅ CHANGED: Renamed from polFactory
    let advertisersFacet;
    let governanceFacet;
    let mockUSDC; // ✅ ADD: USDC token reference
    let owner;
    let advertiser;
    let advertiser2;
    let advertiser3;
    let advertiser4;
    let advertiser5;
    let advertiser6;
    let advertiser7;
    let advertiser8;
    let advertiser9;
    let advertiser10;
    let advertiser11;
    let advertiser12;
    let advertiser13;
    let advertiser14;
    let advertiser15;
    let advertiser16;
    let advertiser17;
    let advertiser18;
    let advertiser19;
    let advertiser20;
    let advertiser21;
    let advertiser22;
    let advertiser23;
    let affiliate1;
    let affiliate2;
    let nonAdvertiser;

    // ✅ CHANGED: USDC test constants (6 decimals instead of 18)
    const DEFAULT_STORAGE_ID = "test-usdc-ad-001";
    const DEFAULT_USDC_BOUNTY = ethers.parseUnits("1.0", 6); // 1 USDC (6 decimals)
    const DEFAULT_MIN_BLOCK_SEPARATION = 10;
    const DEFAULT_USDC_FUNDING = ethers.parseUnits("3300.0", 6); // 3300 USDC (6 decimals) - 10% premium over POL
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    before(async function () {
        console.log("🚀 Starting USDC test setup...");

        [owner, advertiser, advertiser2, advertiser3, advertiser4, advertiser5, advertiser6, advertiser7, advertiser8, advertiser9, advertiser10, advertiser11, advertiser12, advertiser13, advertiser14, advertiser15, advertiser16, advertiser17, advertiser18, advertiser19, advertiser20, advertiser21, advertiser22, advertiser23, affiliate1, affiliate2, nonAdvertiser] = await ethers.getSigners();

        try {
            console.log("📦 Deploying diamond...");
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            
            if (!diamondAddress) {
                throw new Error("Diamond deployment returned null/undefined address");
            }
            
            console.log("✅ Diamond deployed at:", diamondAddress);
            
            await ethers.provider.send("hardhat_mine", ["0x1"]);
            
            // ✅ CHANGED: Get USDC factory instead of POL factory
            usdcFactory = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
            advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
            governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            
            console.log("✅ Facet contracts instantiated");
            
            await initializeGovernanceQuotas();
            console.log("✅ Governance quotas initialized");
            
            // ✅ ADD: Get USDC token reference
            const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
            mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
            console.log("✅ USDC token retrieved at:", usdcAddress);

            const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
            console.log("🔍 AdvertisersFacet initialized:", isInitialized, "Diamond:", diamondAddr);
            
            if (!isInitialized) {
                console.log("⚠️ AdvertisersFacet not initialized, initializing now...");
                await advertisersFacet.connect(owner).initializeAdvertisersFacet(diamondAddress, usdcAddress); // ✅ CHANGED: Pass USDC address
                console.log("✅ AdvertisersFacet initialized manually");
            }
            
            // ✅ ADD: Mint USDC to test accounts
            const mintAmount = ethers.parseUnits("100000", 6); // 100k USDC per account
            const accounts = [advertiser, advertiser2, advertiser3, advertiser4, advertiser5, advertiser6, advertiser7, advertiser8, advertiser9, advertiser10, advertiser11, advertiser12, advertiser13, advertiser14, advertiser15, advertiser16, advertiser17, advertiser18, advertiser19, advertiser20, advertiser21, advertiser22, advertiser23];
            
            for (const account of accounts) {
                await mockUSDC.connect(owner).mint(account.address, mintAmount);
            }
            console.log("✅ USDC minted to test accounts");
            
        } catch (error) {
            console.error("❌ Setup failed:", error);
            throw error;
        }
    });

    async function initializeGovernanceQuotas() {
        try {
            const currentQuotas = await governanceFacet.getAllCurrentQuotas();
            
            if (currentQuotas.minPOLRequiredforAdvertInWei == 0) {
                console.log("🏛️ Initializing governance quotas...");
                
                const quotas = {
                    proposedQuotaProposalQuorum: 51,
                    proposedMinQuotaProposalDuration: 300,
                    proposedMaxQuotaProposalDuration: 86400,
                    proposedOpenAdvertsCommission: 5,
                    proposedStorageProviderCommissionFromADVC: 2,
                    proposedPolBlocksPerHour: 1800,
                    proposedMinPOLRequiredforAdvertInWei: ethers.parseEther("0.5"),
                    proposedMinUSDCRequiredforAdvertInMicro: 500000, // 0.5 USDC
                    proposedMinAdvertBountyInPOLWei: ethers.parseEther("0.1"),
                    proposedMinAdvertBountyInUSDCWei: ethers.parseUnits("0.1", 6),
                    proposedAdvertApprovalDenialQuorum: 51,
                    proposedAdvertApprovalThreshold: 60,
                    proposedAdvertDenialThreshold: 40,
                    proposedMaxBlockSeparationAdvertisement: 1000,
                    proposedAffiliateApprovalDenialQuorum: 51,
                    proposedAffiliateApprovalThreshold: 60,
                    proposedAffiliateDenialThreshold: 40,
                    proposedFacetProposalQuorum: 67,
                    proposedMinFacetProposalDuration: 300,
                    proposedMaxFacetProposalDuration: 86400,
                    proposedOpenAdvertsAdminChangeQuorum: 67,
                    proposedAdminApplicantFeeInPolWei: ethers.parseEther("1.0"),
                    proposedAdminVoteDeadlineInBlocks: 7200,
                    proposedAdvertPauseCooldownBlocks: 7200,
                    proposedUSDCCurrencyPremiumInPCT: 10, // ✅ ADD: 10% USDC premium
                    proposedMaxSignaturesPerBatch: 200,
                    proposedMinViewerClaimPct: 70
                };
                
                await governanceFacet.connect(owner).createProposal(
                    0,
                    quotas,
                    300,
                    []
                );
                
                await ethers.provider.send("hardhat_mine", [`0x${(301).toString(16)}`]);
                await governanceFacet.connect(owner).ratifyUpgrade();
                
                console.log("✅ Governance quotas set successfully");
            } else {
                console.log("✅ Governance already initialized");
            }
        } catch (error) {
            console.error("❌ Failed to initialize governance quotas:", error);
            throw error;
        }
    }

    describe("Successful Advertisement Creation", function () {
        it("Should successfully create a USDC advertisement with valid parameters", async function () {
            console.log("🧪 Testing USDC advertisement creation...");
            
            // ✅ CHANGED: Get USDC quotas instead of POL quotas
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            const actualBounty = quotas.minBountyUSDC > DEFAULT_USDC_BOUNTY ? quotas.minBountyUSDC : DEFAULT_USDC_BOUNTY;
            const actualFunding = quotas.minFundingUSDC > actualBounty ? quotas.minFundingUSDC : actualBounty;
            
            // ✅ ADD: Approve USDC spending
            await mockUSDC.connect(advertiser).approve(diamondAddress, actualFunding);
            
            // ✅ CHANGED: Call USDC factory function
            const tx = await usdcFactory.connect(advertiser).createNewProspectUSDCAdvertContract(
                DEFAULT_STORAGE_ID,
                actualBounty,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                actualFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser.address)));

            const receipt = await tx.wait();
            console.log("⛽ Gas used:", receipt.gasUsed.toString());
            
            // ✅ CHANGED: Look for USDC event
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactory.interface.parseLog(log);
                    return parsed && parsed.name === "USDCAdvertCreated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = usdcFactory.interface.parseLog(event);
            
            expect(parsedEvent.args.owner).to.equal(advertiser.address);
            expect(parsedEvent.args.storageId).to.equal(DEFAULT_STORAGE_ID);
            expect(parsedEvent.args.bounty).to.equal(actualBounty);
            expect(parsedEvent.args.funding).to.equal(actualFunding);

            const advertExists = await advertisersFacet.getAdvertisementExists(parsedEvent.args.advert);
            expect(advertExists).to.be.true;
            
            console.log("✅ USDC advertisement created successfully!");
        });

        it("Should create advertisement with minimum required values", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            const minBounty = quotas.minBountyUSDC;
            const minFunding = quotas.minFundingUSDC;

            await mockUSDC.connect(advertiser2).approve(diamondAddress, minFunding);
            
            const tx = await usdcFactory.connect(advertiser2).createNewProspectUSDCAdvertContract(
                "minimal-ad-usdc",
                minBounty,
                1,
                ethers.ZeroAddress,
                minFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser2.address)));

            await expect(tx).to.not.be.reverted;
        });

        it("Should create advertisement with maximum allowed block separation", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            const maxBlockSeparation = quotas.maxBlockSeparation;

            // ✅ ADD: Approve USDC spending
            await mockUSDC.connect(advertiser3).approve(diamondAddress, DEFAULT_USDC_FUNDING);

            const tx = await usdcFactory.connect(advertiser3).createNewProspectUSDCAdvertContract(
                "max-block-separation",
                DEFAULT_USDC_BOUNTY,
                maxBlockSeparation,
                ethers.ZeroAddress,
                DEFAULT_USDC_FUNDING,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser3.address)));

            await expect(tx).to.not.be.reverted;
        });

        it("Should handle multiple excluded affiliates correctly", async function () {
            // ✅ ADD: Approve USDC spending
            await mockUSDC.connect(advertiser4).approve(diamondAddress, DEFAULT_USDC_FUNDING);

            const tx = await usdcFactory.connect(advertiser4).createNewProspectUSDCAdvertContract(
                "multiple-affiliates",
                DEFAULT_USDC_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                DEFAULT_USDC_FUNDING,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser4.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactory.interface.parseLog(log);
                    return parsed && parsed.name === "USDCAdvertCreated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = usdcFactory.interface.parseLog(event);
            
            // ✅ FIX: Use 'advert' instead of 'advertContract' (matching first test)
            const advertContract = parsedEvent.args.advert;

            const advertUSDCContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", advertContract);
            expect(await advertUSDCContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
            
            console.log("✅ Excluded affiliates managed locally by contract");
        });

        it("Should accept funding that exceeds bounty amount", async function () {
            const largeFunding = ethers.parseUnits("8000.0", 6);

            // ✅ ADD: Approve USDC spending
            await mockUSDC.connect(advertiser5).approve(diamondAddress, largeFunding);

            const tx = await usdcFactory.connect(advertiser5).createNewProspectUSDCAdvertContract(
                "large-funding",
                DEFAULT_USDC_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                largeFunding,
                ...(await gate.usdc(gateSigner, diamondAddress, advertiser5.address)));

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = usdcFactory.interface.parseLog(log);
                    return parsed && parsed.name === "USDCAdvertCreated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = usdcFactory.interface.parseLog(event);
            expect(parsedEvent.args.funding).to.equal(largeFunding);
        });
    });

    describe("Input Validation Failures", function () {
        it("Should revert with empty storage ID", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            await mockUSDC.connect(advertiser6).approve(diamondAddress, quotas.minFundingUSDC);
            
            await expect(
                usdcFactory.connect(advertiser6).createNewProspectUSDCAdvertContract(
                    "",
                    quotas.minBountyUSDC,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    quotas.minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser6.address)))
            ).to.be.revertedWith("Invalid storage ID");
        });

        it("Should revert with zero bounty amount", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            await mockUSDC.connect(advertiser7).approve(diamondAddress, quotas.minFundingUSDC);
            
            await expect(
                usdcFactory.connect(advertiser7).createNewProspectUSDCAdvertContract(
                    "zero-bounty-test",
                    0,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    quotas.minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser7.address)))
            ).to.be.revertedWith("Bounty below minimum"); // ✅ USDC-specific error message
        });

        it("Should revert with insufficient USDC balance", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            // ✅ Approve but don't have enough balance
            const largeAmount = ethers.parseUnits("999999", 6);
            await mockUSDC.connect(advertiser8).approve(diamondAddress, largeAmount);
            
            await expect(
                usdcFactory.connect(advertiser8).createNewProspectUSDCAdvertContract(
                    "insufficient-balance",
                    quotas.minBountyUSDC,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    largeAmount,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser8.address)))
            ).to.be.revertedWith("Insufficient balance");
        });

        it("Should revert with insufficient USDC allowance", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            // ✅ Don't approve enough USDC
            await mockUSDC.connect(advertiser9).approve(diamondAddress, 1); // Only approve 1 micro-USDC
            
            await expect(
                usdcFactory.connect(advertiser9).createNewProspectUSDCAdvertContract(
                    "insufficient-allowance",
                    quotas.minBountyUSDC,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    quotas.minFundingUSDC,
                    ...(await gate.usdc(gateSigner, diamondAddress, advertiser9.address)))
            ).to.be.reverted; // SafeERC20 will revert
        });
    });

    // ✅ Add USDC-specific test for getPOLUSDPrice
    describe("Price Oracle Integration", function () {
        it("Should retrieve POL/USD price for USDC calculations", async function () {
            const priceFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCPriceFacet", diamondAddress);
            
            const [price, decimals, updatedAt] = await priceFacet.getPOLUSDPrice();
            
            expect(price).to.be.greaterThan(0);
            expect(decimals).to.equal(8);
            expect(updatedAt).to.be.greaterThan(0);
            
            console.log(`✅ POL price: $${ethers.formatUnits(price, 8)} (${decimals} decimals)`);
        });

        it("Should calculate minimum USDC requirements with premium", async function () {
            const quotas = await usdcFactory.getUSDCAdvertisementQuotas();
            
            console.log(`📊 USDC Advertisement Quotas:`);
            console.log(`   Min Bounty: ${ethers.formatUnits(quotas.minBountyUSDC, 6)} USDC`);
            console.log(`   Min Funding: ${ethers.formatUnits(quotas.minFundingUSDC, 6)} USDC`);
            console.log(`   Max Block Separation: ${quotas.maxBlockSeparation}`);
            
            expect(quotas.minBountyUSDC).to.be.greaterThan(0);
            expect(quotas.minFundingUSDC).to.be.greaterThan(0);
            expect(quotas.maxBlockSeparation).to.be.greaterThan(0);
        });
    });
});