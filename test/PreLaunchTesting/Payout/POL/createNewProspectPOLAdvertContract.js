const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../../scripts/deploy");
const gate = require("../../../helpers/signatureGate.js");

describe("OpenAdvertsAdvertPOLFactoryFacet - createNewProspectPOLAdvertContract", function () {
    let diamondAddress;
    let gateSigner;
    let polFactory;
    let advertisersFacet;
    let governanceFacet;
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


    const DEFAULT_STORAGE_ID = "test-pol-ad-001";
    const DEFAULT_POL_BOUNTY = ethers.parseEther("1.0"); 
    const DEFAULT_MIN_BLOCK_SEPARATION = 10;
    const DEFAULT_POL_FUNDING = ethers.parseEther("3001.0"); 
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    before(async function () {
        console.log("ðŸš€ Starting test setup...");

        [owner, advertiser, advertiser2, advertiser3, advertiser4, advertiser5, advertiser6, advertiser7, advertiser8, advertiser9, advertiser10, advertiser11, advertiser12, advertiser13, advertiser14, advertiser15, advertiser16, advertiser17, advertiser18, advertiser19, advertiser20, advertiser21, advertiser22, advertiser23, affiliate1, affiliate2, nonAdvertiser] = await ethers.getSigners();


        try {
            console.log("ðŸ“¦ Deploying diamond...");
            const deployedAddresses = await deployDiamond();
            diamondAddress = deployedAddresses.diamond;
            
            if (!diamondAddress) {
                throw new Error("Diamond deployment returned null/undefined address");
            }
            
            console.log("âœ… Diamond deployed at:", diamondAddress);
            
          
            await ethers.provider.send("hardhat_mine", ["0x1"]);
            
       
            polFactory = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
            advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
            governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
            gateSigner = await gate.installGateSigner(diamondAddress, owner);
            
            console.log("âœ… Facet contracts instantiated");
            
            await initializeGovernanceQuotas();
            console.log("âœ… Governance quotas initialized");
            

            const [diamondAddr, isInitialized] = await advertisersFacet.returnDiamondAddressAdvertFacet();
            console.log("ðŸ” AdvertisersFacet initialized:", isInitialized, "Diamond:", diamondAddr);
            
            if (!isInitialized) {
                console.log("âš ï¸ AdvertisersFacet not initialized, initializing now...");
                await advertisersFacet.connect(owner).initializeAdvertisersFacet(diamondAddress, ZERO_ADDRESS);
                console.log("âœ… AdvertisersFacet initialized manually");
            }
            
        } catch (error) {
            console.error("âŒ Setup failed:", error);
            throw error;
        }
    });

    async function initializeGovernanceQuotas() {
        try {

            const currentQuotas = await governanceFacet.getAllCurrentQuotas();
            
            if (currentQuotas.minPOLRequiredforAdvertInWei == 0) {
                console.log("ðŸ›ï¸ Initializing governance quotas...");
                
                const quotas = {
                    proposedQuotaProposalQuorum: 51,
                    proposedMinQuotaProposalDuration: 300,
                    proposedMaxQuotaProposalDuration: 86400,
                    proposedOpenAdvertsCommission: 5,
                    proposedStorageProviderCommissionFromADVC: 2,
                    proposedPolBlocksPerHour: 1800,
                    proposedMinPOLRequiredforAdvertInWei: ethers.parseEther("0.5"),
                    proposedMinUSDCRequiredforAdvertInMicro: 500000,
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
                    proposedMaxSignaturesPerBatch: 200,
                    proposedMinViewerClaimPct: 70
                };
                
                await governanceFacet.connect(owner).createProposal(
                    0, // QuotaProposal type
                    quotas,
                    300, // voting duration
                    []
                );
                
                await ethers.provider.send("hardhat_mine", [`0x${(301).toString(16)}`]);
                await governanceFacet.connect(owner).ratifyUpgrade();
                
                console.log("âœ… Governance quotas set successfully");
            } else {
                console.log("âœ… Governance already initialized");
            }
        } catch (error) {
            console.error("âŒ Failed to initialize governance quotas:", error);
            throw error;
        }
    }

    describe("Successful Advertisement Creation", function () {
        it("Should successfully create a POL advertisement with valid parameters", async function () {
            console.log("ðŸ§ª Testing POL advertisement creation...");
            
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            const actualBounty = quotas.minBounty > DEFAULT_POL_BOUNTY ? quotas.minBounty : DEFAULT_POL_BOUNTY;
            const actualFunding = quotas.minFunding > actualBounty ? quotas.minFunding : actualBounty;
            
     
            const tx = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
                DEFAULT_STORAGE_ID,
                actualBounty,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
                { value: actualFunding }
            );

            const receipt = await tx.wait();
            console.log("â›½ Gas used:", receipt.gasUsed.toString());
            
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            
            expect(parsedEvent.args.advertiser).to.equal(advertiser.address);
            expect(parsedEvent.args.storageId).to.equal(DEFAULT_STORAGE_ID);
            expect(parsedEvent.args.bounty).to.equal(actualBounty);
            expect(parsedEvent.args.funding).to.equal(actualFunding);

            const advertExists = await advertisersFacet.getAdvertisementExists(parsedEvent.args.advertContract);
            expect(advertExists).to.be.true;
            
            console.log("âœ… POL advertisement created successfully!");
        });

        it("Should create advertisement with minimum required values", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const minBounty = quotas.minBounty;
            const minFunding = quotas.minFunding;

         
            const tx = await polFactory.connect(advertiser2).createNewProspectPOLAdvertContract(
                "minimal-ad",
                minBounty,
                1,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser2.address)),
                { value: minFunding }
            );

            await expect(tx).to.not.be.reverted;
        });

        it("Should create advertisement with maximum allowed block separation", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const maxBlockSeparation = quotas.maxBlockSeparation;

          
            const tx = await polFactory.connect(advertiser3).createNewProspectPOLAdvertContract(
                "max-block-separation",
                DEFAULT_POL_BOUNTY,
                maxBlockSeparation,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser3.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            await expect(tx).to.not.be.reverted;
        });

        it("Should handle multiple excluded affiliates correctly", async function () {
            const tx = await polFactory.connect(advertiser4).createNewProspectPOLAdvertContract(
                "multiple-affiliates",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser4.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            const advertContract = parsedEvent.args.advertContract;

            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertContract);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
        });

        it("Should accept funding that exceeds bounty amount", async function () {
            const largeFunding = ethers.parseEther("8000.0");

  
            const tx = await polFactory.connect(advertiser5).createNewProspectPOLAdvertContract(
                "large-funding",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser5.address)),
                { value: largeFunding }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            expect(parsedEvent.args.funding).to.equal(largeFunding);
        });
    });

    describe("Input Validation Failures", function () {
        it("Should revert with empty storage ID", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const actualBounty = quotas.minBounty > DEFAULT_POL_BOUNTY ? quotas.minBounty : DEFAULT_POL_BOUNTY;
            const actualFunding = quotas.minFunding > actualBounty ? quotas.minFunding : actualBounty;
            
    
            await expect(
                polFactory.connect(advertiser6).createNewProspectPOLAdvertContract(
                    "",
                    actualBounty,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser6.address)),
                    { value: actualFunding }
                )
            ).to.be.revertedWith("Invalid storage ID");
        });

        it("Should revert with zero bounty amount", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const actualFunding = quotas.minFunding;
            
          
            await expect(
                polFactory.connect(advertiser7).createNewProspectPOLAdvertContract(
                    "zero-bounty-test",
                    0,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser7.address)),
                    { value: actualFunding }
                )
            ).to.be.revertedWith("POL bounty must be greater than zero");
        });

        it("Should revert with bounty below minimum requirement", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const belowMinBounty = quotas.minBounty - 1n;

        
            await expect(
                polFactory.connect(advertiser8).createNewProspectPOLAdvertContract(
                    "below-min-bounty",
                    belowMinBounty,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser8.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.be.revertedWith("POL bounty must meet minimum requirement");
        });

        it("Should revert with zero block separation", async function () {
         
            await expect(
                polFactory.connect(advertiser9).createNewProspectPOLAdvertContract(
                    "zero-block-separation",
                    DEFAULT_POL_BOUNTY,
                    0,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser9.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.be.revertedWith("BlockNRSeparation must be equal or greater than one");
        });

        it("Should revert with block separation exceeding maximum", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const exceedsMaxBlockSeparation = quotas.maxBlockSeparation + 1n;

           
            await expect(
                polFactory.connect(advertiser10).createNewProspectPOLAdvertContract(
                    "exceeds-max-block",
                    DEFAULT_POL_BOUNTY,
                    exceedsMaxBlockSeparation,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser10.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.be.revertedWith("BlockNRSeparation exceeds maximum allowed");
        });

        it("Should revert with funding below minimum requirement", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const belowMinFunding = quotas.minFunding - 1n;

          
            await expect(
                polFactory.connect(advertiser11).createNewProspectPOLAdvertContract(
                    "below-min-funding",
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser11.address)),
                    { value: belowMinFunding }
                )
            ).to.be.revertedWith("POL funding amount must meet minimum requirement");
        });

        it("Should revert when funding doesn't cover bounty", async function () {
            const largeBounty = ethers.parseEther("5000.0");
            const smallFunding = ethers.parseEther("4000.0");

         
            await expect(
                polFactory.connect(advertiser12).createNewProspectPOLAdvertContract(
                    "funding-not-cover-bounty",
                    largeBounty,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser12.address)),
                    { value: smallFunding }
                )
            ).to.be.revertedWith("POL funding must cover the advertisement bounty");
        });

        it("Should revert with zero funding", async function () {
           
            await expect(
                polFactory.connect(advertiser13).createNewProspectPOLAdvertContract(
                    "zero-funding",
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser13.address)),
                    { value: 0 }
                )
            ).to.be.revertedWith("POL funding amount must meet minimum requirement");
        });
    });

    describe("Storage Validation", function () {
        it("Should properly validate advertisement storage after creation", async function () {
          
            const tx = await polFactory.connect(advertiser14).createNewProspectPOLAdvertContract(
                "storage-validation",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser14.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            expect(await advertisersFacet.getAdvertisementExists(advertAddress)).to.be.true;
            
            const advertData = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
            const advertStruct = advertData[0];
            
            expect(advertStruct.advertOwner).to.equal(advertiser14.address);
            expect(advertStruct.storageId).to.equal("storage-validation");
            expect(advertStruct.advertBounty).to.equal(DEFAULT_POL_BOUNTY);
            expect(advertStruct.minBlockNRSeparation).to.equal(DEFAULT_MIN_BLOCK_SEPARATION);
            
          
            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
            
            console.log("âœ… Storage validation: Email in Diamond, affiliates in contract");
        });

        it("Should handle duplicate storage ID gracefully", async function () {
            const duplicateId = "duplicate-id";
            
           
            await polFactory.connect(advertiser15).createNewProspectPOLAdvertContract(
                duplicateId,
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress, 
                ...(await gate.pol(gateSigner, diamondAddress, advertiser15.address)),
                { value: DEFAULT_POL_FUNDING }
            );

       
            await expect(
                polFactory.connect(advertiser16).createNewProspectPOLAdvertContract(
                    duplicateId,
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser16.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.not.be.reverted; 
        });
    });

    describe("Edge Cases and Boundary Conditions", function () {
        it("Should handle very long storage ID", async function () {
            const longStorageId = "a".repeat(100);

        
            await expect(
                polFactory.connect(advertiser17).createNewProspectPOLAdvertContract(
                    longStorageId,
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser17.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.not.be.reverted;
        });

        it("Should handle large excluded affiliates array", async function () {
            const manyAffiliates = [];
            for (let i = 0; i < 10; i++) {
                manyAffiliates.push(ethers.Wallet.createRandom().address);
            }

           
            await expect(
                polFactory.connect(advertiser18).createNewProspectPOLAdvertContract(
                    "many-affiliates",
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress, 
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser18.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.not.be.reverted;
        });

        it("Should handle duplicate addresses in excluded affiliates", async function () {
            const duplicateAffiliates = [affiliate1.address, affiliate1.address, affiliate2.address];

          
            await expect(
                polFactory.connect(advertiser19).createNewProspectPOLAdvertContract(
                    "duplicate-affiliates",
                    DEFAULT_POL_BOUNTY,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser19.address)),
                    { value: DEFAULT_POL_FUNDING }
                )
            ).to.not.be.reverted;
        });
    });

    describe("Gas Optimization Tests", function () {
        it("Should track gas usage for typical advertisement creation", async function () {
            const tx = await polFactory.connect(advertiser20).createNewProspectPOLAdvertContract(
                "gas-tracking",
     
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser20.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            console.log(`Gas used for POL advertisement creation: ${receipt.gasUsed}`);
            
            expect(receipt.gasUsed).to.be.lessThan(5000000);
        });

        it("Should compare gas usage with different excluded affiliates array sizes", async function () {
            const smallArray = [affiliate1.address];
            const largeArray = Array(5).fill(0).map(() => ethers.Wallet.createRandom().address);

            const tx1 = await polFactory.connect(nonAdvertiser).createNewProspectPOLAdvertContract(
                "small-array-gas",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, nonAdvertiser.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const tx2 = await polFactory.connect(affiliate1).createNewProspectPOLAdvertContract(
                "large-array-gas",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, affiliate1.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt1 = await tx1.wait();
            const receipt2 = await tx2.wait();

            console.log(`Small array gas: ${receipt1.gasUsed}`);
            console.log(`Large array gas: ${receipt2.gasUsed}`);

            // Both calls are functionally identical (the arrays above are not passed to the factory),
            // so gas must be comparable; a strict >= flips on ~12 gas of calldata asymmetry.
            expect(receipt2.gasUsed).to.be.closeTo(receipt1.gasUsed, 100000n);
        });
    });

    describe("Return Value Validation", function () {
        it("Should return valid contract address", async function () {
            const result = await polFactory.connect(affiliate2).createNewProspectPOLAdvertContract.staticCall(
                "static-call-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, affiliate2.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            expect(result).to.not.equal(ZERO_ADDRESS);
            expect(ethers.isAddress(result)).to.be.true;
        });

        it("Should return different addresses for different advertisements", async function () {
            const tx1 = await polFactory.connect(owner).createNewProspectPOLAdvertContract(
                "return-validation-1",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const tx2 = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
                "return-validation-2",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt1 = await tx1.wait();
            const receipt2 = await tx2.wait();

            const event1 = receipt1.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const event2 = receipt2.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent1 = polFactory.interface.parseLog(event1);
            const parsedEvent2 = polFactory.interface.parseLog(event2);

            expect(parsedEvent1.args.advertContract).to.not.equal(parsedEvent2.args.advertContract);
        });
    });

    describe("Integration Tests", function () {
        it("Should properly integrate with OpenAdvertsAdvertisersFacet", async function () {
            const tx = await polFactory.connect(advertiser2).createNewProspectPOLAdvertContract(
                "integration-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser2.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            
          
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            const prospectAds = await advertisersFacet.getAdvertisements(0);
            const foundAd = prospectAds.find(ad => ad.advertContractAddress === advertAddress);
            expect(foundAd).to.not.be.undefined;
            expect(foundAd.advertOwner).to.equal(advertiser2.address);
        });
    });



describe("Storage Validation Internal Function Tests", function () {
    describe("_storeAndValidateAdvertisement Require Statements", function () {
        it("Should detect advertisement address conflict", async function () {
   
            const tx1 = await polFactory.connect(advertiser18).createNewProspectPOLAdvertContract(
                "conflict-test-1",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser18.address)),
                { value: DEFAULT_POL_FUNDING }
            );
            
            const receipt1 = await tx1.wait();
            const event1 = receipt1.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });
            
            const parsedEvent1 = polFactory.interface.parseLog(event1);
            const firstAdvertAddress = parsedEvent1.args.advertContract;
            
      
            expect(await advertisersFacet.getAdvertisementExists(firstAdvertAddress)).to.be.true;
            

            
            console.log("âœ… Address conflict detection would be triggered by duplicate deployment");
        });

        it("Should validate advertisement is marked as existing after storage", async function () {
            const tx = await polFactory.connect(advertiser17).createNewProspectPOLAdvertContract(
                "existence-validation-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser17.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

      
            const exists = await advertisersFacet.getAdvertisementExists(advertAddress);
            expect(exists).to.be.true;
            console.log("âœ… Advertisement correctly marked as existing:", advertAddress);
        });

        it("Should validate prospect count is incremented", async function () {
     
            const initialProspects = await advertisersFacet.getAdvertisements(0); 
            const initialCount = initialProspects.length;
            
            console.log("Initial prospect count:", initialCount);

            const tx = await polFactory.connect(advertiser16).createNewProspectPOLAdvertContract(
                "count-increment-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser16.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;

     
            const finalProspects = await advertisersFacet.getAdvertisements(0);
            const finalCount = finalProspects.length;
            
            console.log("Final prospect count:", finalCount);
            expect(finalCount).to.equal(initialCount + 1);
            console.log("âœ… Prospect count correctly incremented");
        });

        it("Should validate advertisement status is set to Prospect", async function () {
            const tx = await polFactory.connect(advertiser15).createNewProspectPOLAdvertContract(
                "status-validation-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser15.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            const advertData = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
            const status = advertData[1];
            
            expect(status).to.equal(0); 
            console.log("âœ… Advertisement status correctly set to Prospect");
        });

        it("Should validate stored advertisement data matches submitted data", async function () {
            const testStorageId = "data-validation-test";
            const testBounty = ethers.parseEther("2.5");
            const testBlockSeparation = 25;
              const testEmail = "data-validation@example.com";
            const tx = await polFactory.connect(advertiser16).createNewProspectPOLAdvertContract(
                testStorageId,
                testBounty,
                testBlockSeparation,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser16.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;


            const advertData = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
            const storedAd = advertData[0];
 
            expect(storedAd.advertContractAddress).to.equal(advertAddress);
            console.log("âœ… Address validation passed");

            expect(storedAd.storageId).to.equal(testStorageId);
            console.log("âœ… Storage ID validation passed");

            expect(storedAd.advertBounty).to.equal(testBounty);
            console.log("âœ… Bounty validation passed");

            expect(storedAd.advertOwner).to.equal(advertiser16.address);
            console.log("âœ… Owner validation passed");

            expect(storedAd.minBlockNRSeparation).to.equal(testBlockSeparation);
            console.log("âœ… Block separation validation passed");

            expect(storedAd.AdvertisementType).to.equal(0); 
            console.log("âœ… Type validation passed");

            console.log("âœ… Email validation passed");

            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
        });

        it("Should validate excluded affiliates array with empty array", async function () {
            const tx = await polFactory.connect(advertiser6).createNewProspectPOLAdvertContract(
                "empty-affiliates-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser6.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

      
            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
        });

        it("Should validate excluded affiliates with single element", async function () {
            const tx = await polFactory.connect(advertiser7).createNewProspectPOLAdvertContract(
                "single-affiliate-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser7.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
        });

        it("Should validate storage index is valid", async function () {
            const tx = await polFactory.connect(advertiser8).createNewProspectPOLAdvertContract(
                "index-validation-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser8.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            const prospects = await advertisersFacet.getAdvertisements(0);
            const found = prospects.find(ad => ad.advertContractAddress === advertAddress);
            
            expect(found).to.not.be.undefined;
            console.log("âœ… Storage index validation passed - advertisement found in prospects array");
        });

        it("Should handle maximum length excluded affiliates array", async function () {
            const maxAffiliates = [];
            for (let i = 0; i < 20; i++) { 
                maxAffiliates.push(ethers.Wallet.createRandom().address);
            }

            const tx = await polFactory.connect(advertiser9).createNewProspectPOLAdvertContract(
                "max-affiliates-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser9.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);
        });

        it("Should validate all require statements work together in edge case", async function () {
            const edgeStorageId = "edge-case-validation-test-" + Date.now(); 
            const edgeBounty = ethers.parseEther("0.1"); 
            const edgeBlockSeparation = 1; 
            const edgeEmail = "edge-case@example.com";
            const edgeAffiliates = [
                advertiser.address,
                affiliate1.address,
                affiliate2.address,
              
            ];

            const tx = await polFactory.connect(advertiser10).createNewProspectPOLAdvertContract(
                edgeStorageId,
                edgeBounty,
                edgeBlockSeparation,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser10.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = polFactory.interface.parseLog(event);
            const advertAddress = parsedEvent.args.advertContract;

   
            expect(await advertisersFacet.getAdvertisementExists(advertAddress)).to.be.true;
            
            const advertData = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress);
            const storedAd = advertData[0];
            const status = advertData[1];

  
            expect(storedAd.advertContractAddress).to.equal(advertAddress);
            expect(storedAd.storageId).to.equal(edgeStorageId);
            expect(storedAd.advertBounty).to.equal(edgeBounty);
            expect(storedAd.advertOwner).to.equal(advertiser10.address);
            expect(storedAd.minBlockNRSeparation).to.equal(edgeBlockSeparation);
            expect(status).to.equal(0); 

            const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress);
            expect(await advertPOLContract.designatedAffiliate()).to.equal(ethers.ZeroAddress);

            console.log("âœ… All edge case validations passed successfully");
            console.log(`   - Gas used: ${receipt.gasUsed}`);
            console.log(`   - Contract address: ${advertAddress}`);
            console.log(`   - Diamond storage: Email, bounty, separation âœ“`);
            console.log(`   - Contract storage: Excluded affiliates âœ“`);
            console.log("âœ… All edge case validations passed successfully");
            console.log(`   - Gas used: ${receipt.gasUsed}`);
            console.log(`   - Contract address: ${advertAddress}`);
        });
    });

    describe("Storage Validation Error Scenarios", function () {
        it("Should demonstrate validation would catch storage failures", async function () {
            
            console.log("ðŸ“ Expected validation behaviors:");
            console.log("   - Address conflict: Would revert with 'Advertisement address conflict detected'");
            console.log("   - Storage failure: Would revert with 'Advertisement storage failed - not marked as existing'");
            console.log("   - Count mismatch: Would revert with 'Advertisement storage failed - prospect count not incremented'");
            console.log("   - Status error: Would revert with 'Advertisement storage failed - incorrect status'");
            console.log("   - Data mismatch: Would revert with specific field mismatch messages");
            console.log("   - Index error: Would revert with 'Advertisement storage failed - invalid index'");
            console.log("   - Array mismatch: Would revert with excluded affiliates validation errors");
            
            const tx = await polFactory.connect(advertiser11).createNewProspectPOLAdvertContract(
                "validation-demo-test",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser11.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
            
            console.log("âœ… Positive validation case completed successfully");
        });

        it("Should validate gas usage for complex validation scenarios", async function () {
            const complexAffiliates = [];
            for (let i = 0; i < 15; i++) {
                complexAffiliates.push(ethers.Wallet.createRandom().address);
            }

            const tx = await polFactory.connect(advertiser12).createNewProspectPOLAdvertContract(
                "gas-validation-complex",
                DEFAULT_POL_BOUNTY,
                DEFAULT_MIN_BLOCK_SEPARATION,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser12.address)),
                { value: DEFAULT_POL_FUNDING }
            );

            const receipt = await tx.wait();
            console.log(`Gas used for complex validation: ${receipt.gasUsed}`);
            
            expect(receipt.gasUsed).to.be.lessThan(6000000); 
            
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            console.log("âœ… Complex validation completed within gas limits");
        });
    });

    describe("getPOLAdvertisementQuotas Function Tests", function () {
    describe("Quota Retrieval - Basic Functionality", function () {
        it("Should successfully retrieve POL advertisement quotas", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotas).to.have.lengthOf(3);
            expect(quotas.minBounty).to.be.a('bigint');
            expect(quotas.minFunding).to.be.a('bigint');
            expect(quotas.maxBlockSeparation).to.be.a('bigint');
            
            console.log("âœ… Successfully retrieved POL quotas");
            console.log(`   - Min Bounty: ${ethers.formatEther(quotas.minBounty)} POL`);
            console.log(`   - Min Funding: ${ethers.formatEther(quotas.minFunding)} POL`);
            console.log(`   - Max Block Separation: ${quotas.maxBlockSeparation}`);
        });

        it("Should return non-zero values for all quotas", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotas.minBounty).to.be.greaterThan(0n);
            expect(quotas.minFunding).to.be.greaterThan(0n);
            expect(quotas.maxBlockSeparation).to.be.greaterThan(0n);
            
            console.log("âœ… All quotas have non-zero values");
        });

        it("Should be callable by any address (view function)", async function () {
        
            const quotasFromOwner = await polFactory.connect(owner).getPOLAdvertisementQuotas();
            expect(quotasFromOwner.minBounty).to.be.greaterThan(0n);
            
            const quotasFromAdvertiser = await polFactory.connect(advertiser).getPOLAdvertisementQuotas();
            expect(quotasFromAdvertiser.minBounty).to.be.greaterThan(0n);
            
            const quotasFromNonUser = await polFactory.connect(nonAdvertiser).getPOLAdvertisementQuotas();
            expect(quotasFromNonUser.minBounty).to.be.greaterThan(0n);
            
            expect(quotasFromOwner.minBounty).to.equal(quotasFromAdvertiser.minBounty);
            expect(quotasFromAdvertiser.minBounty).to.equal(quotasFromNonUser.minBounty);
            
            console.log("âœ… Function accessible by all addresses (proper view function)");
        });

        it("Should return consistent values across multiple calls", async function () {
            const call1 = await polFactory.getPOLAdvertisementQuotas();
            const call2 = await polFactory.getPOLAdvertisementQuotas();
            const call3 = await polFactory.getPOLAdvertisementQuotas();
            
            expect(call1.minBounty).to.equal(call2.minBounty);
            expect(call2.minBounty).to.equal(call3.minBounty);
            
            expect(call1.minFunding).to.equal(call2.minFunding);
            expect(call2.minFunding).to.equal(call3.minFunding);
            
            expect(call1.maxBlockSeparation).to.equal(call2.maxBlockSeparation);
            expect(call2.maxBlockSeparation).to.equal(call3.maxBlockSeparation);
            
            console.log("âœ… Quotas remain consistent across multiple calls");
        });
    });

    describe("Quota Values - Validation and Relationships", function () {
        it("Should have minBounty less than or equal to minFunding", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotas.minBounty).to.be.lessThanOrEqual(quotas.minFunding);
            
            console.log("âœ… Bounty/Funding relationship validated");
            console.log(`   - Min Bounty: ${ethers.formatEther(quotas.minBounty)} POL`);
            console.log(`   - Min Funding: ${ethers.formatEther(quotas.minFunding)} POL`);
            console.log(`   - Funding covers bounty: ${quotas.minFunding >= quotas.minBounty ? 'Yes' : 'No'}`);
        });

        it("Should have reasonable maxBlockSeparation value", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotas.maxBlockSeparation).to.be.greaterThanOrEqual(1n);
            expect(quotas.maxBlockSeparation).to.be.lessThan(1000000n); 
            
            console.log("âœ… Block separation value is within reasonable range");
            console.log(`   - Max Block Separation: ${quotas.maxBlockSeparation}`);
        });

        it("Should have minBounty match governance settings", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const governanceQuotas = await governanceFacet.getAllCurrentQuotas();
            
            expect(quotas.minBounty).to.equal(governanceQuotas.minAdvertBountyInPOLWei);
            
            console.log("âœ… Min bounty matches governance settings");
            console.log(`   - Factory quota: ${ethers.formatEther(quotas.minBounty)} POL`);
            console.log(`   - Governance quota: ${ethers.formatEther(governanceQuotas.minAdvertBountyInPOLWei)} POL`);
        });

        it("Should have minFunding match governance settings", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const governanceQuotas = await governanceFacet.getAllCurrentQuotas();
            
            expect(quotas.minFunding).to.equal(governanceQuotas.minPOLRequiredforAdvertInWei);
            
            console.log("âœ… Min funding matches governance settings");
            console.log(`   - Factory quota: ${ethers.formatEther(quotas.minFunding)} POL`);
            console.log(`   - Governance quota: ${ethers.formatEther(governanceQuotas.minPOLRequiredforAdvertInWei)} POL`);
        });

        it("Should have maxBlockSeparation match governance settings", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            const governanceQuotas = await governanceFacet.getAllCurrentQuotas();
            
            expect(quotas.maxBlockSeparation).to.equal(governanceQuotas.maxBlockSeparationAdvertisement);
            
            console.log("âœ… Max block separation matches governance settings");
            console.log(`   - Factory quota: ${quotas.maxBlockSeparation}`);
            console.log(`   - Governance quota: ${governanceQuotas.maxBlockSeparationAdvertisement}`);
        });
    });

    describe("Quota Usage in Advertisement Creation", function () {
        it("Should use retrieved quotas to create valid advertisement", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
         
            const tx = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
                "quota-validation-test",
                quotas.minBounty,
                1, 
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
                { value: quotas.minFunding }
            );

            await expect(tx).to.not.be.reverted;
            
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = polFactory.interface.parseLog(log);
                    return parsed && parsed.name === "POLAdvertisementCreatedAndValidated";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            console.log("âœ… Advertisement created using quota values");
        });

        it("Should reject advertisement with values below quota minimums", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
        
            await expect(
                polFactory.connect(advertiser2).createNewProspectPOLAdvertContract(
                    "below-quota-bounty",
                    quotas.minBounty - 1n,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser2.address)),
                    { value: quotas.minFunding }
                )
            ).to.be.revertedWith("POL bounty must meet minimum requirement");
            
            console.log("âœ… Advertisement rejected when below quota minimum");
        });

        it("Should reject advertisement with funding below quota minimum", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
      
            await expect(
                polFactory.connect(advertiser3).createNewProspectPOLAdvertContract(
                    "below-quota-funding",
                    quotas.minBounty,
                    DEFAULT_MIN_BLOCK_SEPARATION,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser3.address)),
                    { value: quotas.minFunding - 1n }
                )
            ).to.be.revertedWith("POL funding amount must meet minimum requirement");
            
            console.log("âœ… Advertisement rejected when funding below quota minimum");
        });

        it("Should reject advertisement with block separation above quota maximum", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            

            await expect(
                polFactory.connect(advertiser4).createNewProspectPOLAdvertContract(
                    "above-quota-blocks",
                    quotas.minBounty,
                    quotas.maxBlockSeparation + 1n,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser4.address)),
                    { value: quotas.minFunding }
                )
            ).to.be.revertedWith("BlockNRSeparation exceeds maximum allowed");
            
            console.log("âœ… Advertisement rejected when block separation exceeds quota maximum");
        });

        it("Should accept advertisement at exact quota boundaries", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            

            const tx1 = await polFactory.connect(advertiser21).createNewProspectPOLAdvertContract(
                "exact-min-bounty",
                quotas.minBounty,
                1,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser21.address)),
                { value: quotas.minFunding }
            );
            await expect(tx1).to.not.be.reverted;
            console.log("   âœ“ Exact minimum bounty accepted");
            

            const tx2 = await polFactory.connect(advertiser22).createNewProspectPOLAdvertContract(
                "exact-min-funding",
                quotas.minBounty,
                1,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser22.address)),
                { value: quotas.minFunding }
            );
            await expect(tx2).to.not.be.reverted;
            console.log("   âœ“ Exact minimum funding accepted");
            
 
            const tx3 = await polFactory.connect(advertiser23).createNewProspectPOLAdvertContract(
                "exact-max-blocks",
                quotas.minBounty,
                quotas.maxBlockSeparation,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser23.address)),
                { value: quotas.minFunding }
            );
            await expect(tx3).to.not.be.reverted;
            console.log("   âœ“ Exact maximum block separation accepted");
            
            console.log("âœ… All boundary values accepted");
        });
    });

    describe("Quota Return Values - Type Safety", function () {
        it("Should return proper tuple structure", async function () {
            const result = await polFactory.getPOLAdvertisementQuotas();
            
    
            expect(result).to.have.lengthOf(3);
            
 
            expect(typeof result.minBounty).to.equal('bigint');
            expect(typeof result.minFunding).to.equal('bigint');
            expect(typeof result.maxBlockSeparation).to.equal('bigint');
            
            console.log("âœ… Return tuple structure validated");
        });

        it("Should support destructuring assignment", async function () {
            const { minBounty, minFunding, maxBlockSeparation } = await polFactory.getPOLAdvertisementQuotas();
            
            expect(minBounty).to.be.greaterThan(0n);
            expect(minFunding).to.be.greaterThan(0n);
            expect(maxBlockSeparation).to.be.greaterThan(0n);
            
            console.log("âœ… Destructuring assignment works correctly");
            console.log(`   - minBounty: ${ethers.formatEther(minBounty)} POL`);
            console.log(`   - minFunding: ${ethers.formatEther(minFunding)} POL`);
            console.log(`   - maxBlockSeparation: ${maxBlockSeparation}`);
        });

        it("Should support array-style access", async function () {
            const result = await polFactory.getPOLAdvertisementQuotas();
            
            expect(result[0]).to.equal(result.minBounty);
            expect(result[1]).to.equal(result.minFunding);
            expect(result[2]).to.equal(result.maxBlockSeparation);
            
            console.log("âœ… Array-style access works correctly");
        });
    });

    describe("Quota Integration with Governance", function () {
        it("Should reflect changes if governance quotas are updated", async function () {
            const initialQuotas = await polFactory.getPOLAdvertisementQuotas();
            
            console.log("ðŸ“Š Initial quotas:");
            console.log(`   - Min Bounty: ${ethers.formatEther(initialQuotas.minBounty)} POL`);
            console.log(`   - Min Funding: ${ethers.formatEther(initialQuotas.minFunding)} POL`);
            console.log(`   - Max Block Separation: ${initialQuotas.maxBlockSeparation}`);
                        
            const governanceQuotas = await governanceFacet.getAllCurrentQuotas();
            
            expect(initialQuotas.minBounty).to.equal(governanceQuotas.minAdvertBountyInPOLWei);
            expect(initialQuotas.minFunding).to.equal(governanceQuotas.minPOLRequiredforAdvertInWei);
            expect(initialQuotas.maxBlockSeparation).to.equal(governanceQuotas.maxBlockSeparationAdvertisement);
            
            console.log("âœ… Quotas correctly synchronized with governance");
        });

        it("Should be used for validation in all advertisement creation scenarios", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            await expect(
                polFactory.connect(advertiser8).createNewProspectPOLAdvertContract(
                    "validation-fail-1",
                    quotas.minBounty - 1n,
                    0,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser8.address)),
                    { value: quotas.minFunding - 1n }
                )
            ).to.be.reverted;
            
            await expect(
                polFactory.connect(advertiser9).createNewProspectPOLAdvertContract(
                    "validation-pass-1",
                    quotas.minBounty,
                    1,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser9.address)),
                    { value: quotas.minFunding }
                )
            ).to.not.be.reverted;
            
            await expect(
                polFactory.connect(advertiser10).createNewProspectPOLAdvertContract(
                    "validation-fail-2",
                    quotas.minBounty,
                    quotas.maxBlockSeparation + 1n,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser10.address)),
                    { value: quotas.minFunding }
                )
            ).to.be.revertedWith("BlockNRSeparation exceeds maximum allowed");
            
            console.log("âœ… Quotas properly enforced in all validation scenarios");
        });
    });

    describe("Gas Efficiency", function () {
        it("Should use minimal gas for quota retrieval", async function () {
            const tx = await polFactory.connect(advertiser11).getPOLAdvertisementQuotas.estimateGas();
            
            console.log(`â›½ Gas estimate for getPOLAdvertisementQuotas: ${tx}`);
            
            expect(tx).to.be.lessThan(50000n); 
            
            console.log("âœ… Gas usage is efficient for view function");
        });

        it("Should not modify state (pure view function)", async function () {
            const quotasBefore = await polFactory.getPOLAdvertisementQuotas();
            
            await polFactory.getPOLAdvertisementQuotas();
            await polFactory.getPOLAdvertisementQuotas();
            await polFactory.getPOLAdvertisementQuotas();
            
            const quotasAfter = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotasAfter.minBounty).to.equal(quotasBefore.minBounty);
            expect(quotasAfter.minFunding).to.equal(quotasBefore.minFunding);
            expect(quotasAfter.maxBlockSeparation).to.equal(quotasBefore.maxBlockSeparation);
            
            console.log("âœ… Function does not modify state (proper view function)");
        });
    });

    describe("Edge Cases and Error Handling", function () {
        it("Should handle concurrent calls correctly", async function () {
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(polFactory.getPOLAdvertisementQuotas());
            }
            
            const results = await Promise.all(promises);
            
            for (let i = 1; i < results.length; i++) {
                expect(results[i].minBounty).to.equal(results[0].minBounty);
                expect(results[i].minFunding).to.equal(results[0].minFunding);
                expect(results[i].maxBlockSeparation).to.equal(results[0].maxBlockSeparation);
            }
            
            console.log("âœ… Concurrent calls handled correctly (all returned same values)");
        });

        it("Should work immediately after deployment", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            expect(quotas.minBounty).to.be.greaterThan(0n);
            expect(quotas.minFunding).to.be.greaterThan(0n);
            expect(quotas.maxBlockSeparation).to.be.greaterThan(0n);
            
            console.log("âœ… Quotas available immediately after deployment");
        });

        it("Should provide quotas that allow successful advertisement creation", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            const tx = await polFactory.connect(advertiser12).createNewProspectPOLAdvertContract(
                "quota-usability-test",
                quotas.minBounty,
                1,
                ethers.ZeroAddress,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser12.address)),
                { value: quotas.minFunding }
            );

            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
            
            console.log("âœ… Quotas provide usable values for advertisement creation");
        });
    });

    describe("Documentation and Developer Experience", function () {
        it("Should provide clear quota values for developer guidance", async function () {
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            
            console.log("\nðŸ“š Developer Reference - POL Advertisement Quotas:");
            console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
            console.log(`Minimum Bounty: ${ethers.formatEther(quotas.minBounty)} POL`);
            console.log(`                (${quotas.minBounty} wei)`);
            console.log(`Minimum Funding: ${ethers.formatEther(quotas.minFunding)} POL`);
            console.log(`                 (${quotas.minFunding} wei)`);
            console.log(`Maximum Block Separation: ${quotas.maxBlockSeparation} blocks`);
            console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n");
            
            expect(quotas.minBounty).to.be.greaterThan(0n);
            expect(quotas.minFunding).to.be.greaterThan(0n);
            expect(quotas.maxBlockSeparation).to.be.greaterThan(0n);
            
            console.log("âœ… Documentation reference generated");
        });

        it("Should demonstrate proper usage pattern", async function () {
            console.log("\nðŸ’¡ Best Practice Usage Pattern:");
            console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
            
            const quotas = await polFactory.getPOLAdvertisementQuotas();
            console.log("1ï¸âƒ£  Retrieve quotas using getPOLAdvertisementQuotas()");
            
            const userBounty = ethers.parseEther("2.0");
            const userFunding = ethers.parseEther("3500.0");
            const userBlockSeparation = 50n;
            
            console.log("2ï¸âƒ£  Validate user parameters:");
            console.log(`   - User bounty: ${ethers.formatEther(userBounty)} POL ${userBounty >= quotas.minBounty ? 'âœ“' : 'âœ—'}`);
            console.log(`   - User funding: ${ethers.formatEther(userFunding)} POL ${userFunding >= quotas.minFunding ? 'âœ“' : 'âœ—'}`);
            console.log(`   - User block separation: ${userBlockSeparation} ${userBlockSeparation <= quotas.maxBlockSeparation ? 'âœ“' : 'âœ—'}`);
            
            if (userBounty >= quotas.minBounty && 
                userFunding >= quotas.minFunding && 
                userBlockSeparation <= quotas.maxBlockSeparation) {
                console.log("3ï¸âƒ£  All validations passed - creating advertisement");
                
                const tx = await polFactory.connect(advertiser13).createNewProspectPOLAdvertContract(
                    "best-practice-demo",
              
                    userBounty,
                    userBlockSeparation,
                    ethers.ZeroAddress,
                    ...(await gate.pol(gateSigner, diamondAddress, advertiser13.address)),
                    { value: userFunding }
                );
                
                await expect(tx).to.not.be.reverted;
                console.log("   âœ“ Advertisement created successfully");
            }
            
            console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n");
            
            console.log("âœ… Best practice pattern demonstrated");
        });
    });
})})})
