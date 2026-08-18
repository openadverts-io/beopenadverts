const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title getRewardSignatureData — Consolidated RPC Tests
 * @notice Validates the new QueryV2Facet function that replaces 5 separate
 *         RPC calls with 1 atomic view call for reward signature construction.
 *
 * Tests cover:
 *   1.  Happy path — all fields match individual contract reads
 *   2.  advertBounty returns per-engagement bounty (NOT remaining balance)
 *   3.  affiliateClaimInfoAddress resolved internally from Diamond storage
 *   4.  Prospect ageffiliate returns data (view, not guard)
 *   5.  Banned affiliate returns data (view, not guard)
 *   6.  Nonexistent affiliate reverts
 *   7.  Invalid advert contract (EOA) reverts
 *   8.  Block number atomic consistency
 *   9.  USDC advert variant works identically
 *  10.  Cross-verification: combined call matches 5 individual calls
 *  11.  Multiple adverts for same affiliate return correct per-advert data
 *  12.  Third party count matches claim percentages provider
 */
describe("getRewardSignatureData — Consolidated RPC", function () {
    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    let diamondAddress;
    let gateSigner;
    let advertisersFacet;
    let affiliatesFacet;
    let advertPOLFactoryFacet;
    let advertUSDCFactoryFacet;
    let tokenFacet;
    let governanceFacet;
    let queryV2Facet;
    let mockUSDC;

    let owner;
    let voter1, voter2, voter3;
    let affiliateOwner1, affiliateOwner2, affiliateOwner3;
    let advertiser1, advertiser2, advertiser3;
    let viewer1, viewer2;

    // Mock ClaimPercentagesProvider contracts
    let mockClaimProvider;       // 3 third parties
    let mockClaimProviderWith6;  // 6 third parties

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    const AdvertisementType = {
        Prospect: 0,
        Approved: 1,
        Exhausted: 2,
        Deprecating: 3,
        Withdrawn: 4,
        Banned: 5
    };

    const AffiliateType = {
        Prospect: 0,
        Approved: 1,
        Banned: 2
    };

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    async function advanceBlocks(n = 15) {
        await mine(n);
    }

    /**
     * Creates a prospect affiliate with a real MockClaimPercentagesProvider
     * and optionally approves it. Returns { affiliateAddr, claimInfoAddr, signingAddr }.
     */
    async function createAffiliate(ownerSigner, claimProvider, label, approve = true) {
        const affiliateAddr = ownerSigner.address;
        const signingAddr = ethers.Wallet.createRandom().address;
        const claimInfoAddr = await claimProvider.getAddress();

        await affiliatesFacet.connect(ownerSigner).createProspectAffiliateContract(
            affiliateAddr,
            claimInfoAddr,
            signingAddr,
            `aff-${label}`,
            ...(await gate.affiliate(gateSigner, diamondAddress, ownerSigner.address)));

        if (approve) {
            await affiliatesFacet.connect(owner).reclassifyAffiliate(
                affiliateAddr,
                AffiliateType.Prospect,
                AffiliateType.Approved,
                100,
                0
            );
        }

        return { affiliateAddr, claimInfoAddr, signingAddr };
    }

    /**
     * Creates a POL prospect advert with a given designated affiliate.
     */
    let advertCounter = 0;
    async function createPOLProspect(signer, designatedAffiliate) {
        const sid = `rsd-pol-${++advertCounter}`;
        const [minBounty, minFunding] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();

        const tx = await advertPOLFactoryFacet.connect(signer).createNewProspectPOLAdvertContract(
            sid,
            minBounty,
            100,
            designatedAffiliate,
            ...(await gate.pol(gateSigner, diamondAddress, signer.address)),
            { value: minFunding }
        );
        const receipt = await tx.wait();

        for (const log of receipt.logs) {
            try {
                const parsed = advertPOLFactoryFacet.interface.parseLog(log);
                if (parsed && parsed.name === "POLAdvertisementCreatedAndValidated") {
                    return parsed.args.advertContract;
                }
            } catch (_) { continue; }
        }
        throw new Error("POL advert creation event not found");
    }

    /**
     * Creates a USDC prospect advert with a given designated affiliate.
     */
    async function createUSDCProspect(signer, designatedAffiliate) {
        const sid = `rsd-usdc-${++advertCounter}`;
        const quotas = await advertUSDCFactoryFacet.getUSDCAdvertisementQuotas();
        const bounty = quotas.minBountyUSDC;
        const funding = quotas.minFundingUSDC;

        await mockUSDC.connect(signer).approve(diamondAddress, funding);

        const tx = await advertUSDCFactoryFacet.connect(signer).createNewProspectUSDCAdvertContract(
            sid,
            bounty,
            100,
            designatedAffiliate,
            funding,
            ...(await gate.usdc(gateSigner, diamondAddress, signer.address)));
        const receipt = await tx.wait();

        for (const log of receipt.logs) {
            try {
                const parsed = advertUSDCFactoryFacet.interface.parseLog(log);
                if (parsed && parsed.name === "USDCAdvertCreated") {
                    return parsed.args.advert;
                }
            } catch (_) { continue; }
        }
        throw new Error("USDC advert creation event not found");
    }

    async function ownerApproveAdvert(advertAddress) {
        await advertisersFacet.connect(owner).reclassifyAdvertisement(
            advertAddress,
            AdvertisementType.Prospect,
            AdvertisementType.Approved,
            100,
            0
        );
    }

    async function initializeGovernanceQuotas() {
        const currentQuotas = await governanceFacet.getAllCurrentQuotas();
        if (currentQuotas.minPOLRequiredforAdvertInWei == 0) {
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
                proposedUSDCCurrencyPremiumInPCT: 10,
                proposedMaxSignaturesPerBatch: 50,
                proposedMinViewerClaimPct: 70
            };
            await governanceFacet.connect(owner).createProposal(0, quotas, 300, []);
            await ethers.provider.send("hardhat_mine", [`0x${(301).toString(16)}`]);
            await governanceFacet.connect(owner).ratifyUpgrade();
        }
    }

    // -----------------------------------------------------------------------
    // Setup
    // -----------------------------------------------------------------------

    before(async function () {
        this.timeout(120_000);
        console.log("🚀 Starting getRewardSignatureData tests…");

        const signers = await ethers.getSigners();
        [
            owner,
            voter1, voter2, voter3,
            affiliateOwner1, affiliateOwner2, affiliateOwner3,
            advertiser1, advertiser2, advertiser3,
            viewer1, viewer2
        ] = signers;

        // Deploy diamond
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        expect(diamondAddress).to.not.be.undefined;
        console.log("✅ Diamond deployed at:", diamondAddress);

        // Facet handles
        advertisersFacet       = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        affiliatesFacet        = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
        advertPOLFactoryFacet  = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
        advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
        tokenFacet             = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
        governanceFacet        = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
        queryV2Facet           = await ethers.getContractAt("OpenAdvertsQueryV2Facet", diamondAddress);
        gateSigner = await gate.installGateSigner(diamondAddress, owner);

        // USDC token from deploy
        const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
        mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);

        // Deploy mock claim providers
        const MockClaim = await ethers.getContractFactory("contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider");
        mockClaimProvider = await MockClaim.deploy();
        await mockClaimProvider.waitForDeployment();

        const MockClaimWith6 = await ethers.getContractFactory("MockClaimPercentagesProviderWith6TPs");
        mockClaimProviderWith6 = await MockClaimWith6.deploy();
        await mockClaimProviderWith6.waitForDeployment();

        // Initialize governance
        await initializeGovernanceQuotas();
        console.log("✅ Governance quotas initialized");

        // Distribute OAD tokens
        const tokenAmount = ethers.parseUnits("1000", 18);
        for (const v of [voter1, voter2, voter3]) {
            await tokenFacet.connect(owner).transfer(v.address, tokenAmount);
        }

        // Mint USDC
        const usdcMintAmount = ethers.parseUnits("100000", 6);
        const allSigners = await ethers.getSigners();
        for (let i = 0; i < Math.min(allSigners.length, 40); i++) {
            await mockUSDC.connect(owner).mint(allSigners[i].address, usdcMintAmount);
        }

        await advanceBlocks(15);
        console.log("✅ Setup complete");
    });

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    describe("Happy path — POL advert", function () {
        let affData;
        let advertAddr;

        before(async function () {
            affData = await createAffiliate(affiliateOwner1, mockClaimProvider, "hp-1");
            advertAddr = await createPOLProspect(advertiser1, affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);
        });

        it("1. Returns all 8 fields correctly", async function () {
            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            // affiliateSigningAddress
            expect(data.affiliateSigningAddress).to.equal(affData.signingAddr);

            // affiliateStatus = 1 (Approved)
            expect(data.affiliateStatus).to.equal(AffiliateType.Approved);

            // affiliateClaimInfoAddress resolved from Diamond storage
            expect(data.affiliateClaimInfoAddress).to.equal(affData.claimInfoAddr);

            // viewerNonce starts at 0
            expect(data.viewerNonce).to.equal(0);

            // thirdPartyCount from MockClaimPercentagesProvider = 3
            expect(data.thirdPartyCount).to.equal(3);

            // designatedAffiliate matches
            expect(data.designatedAffiliate).to.equal(affData.affiliateAddr);

            // advertBounty is per-engagement bounty (NOT remaining balance)
            const [minBounty] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();
            expect(data.advertBounty).to.equal(minBounty);

            // currentBlockNumber is reasonable
            const currentBlock = await ethers.provider.getBlockNumber();
            expect(data.currentBlockNumber).to.be.closeTo(currentBlock, 2);
        });

        it("2. advertBounty is per-engagement bounty, NOT remaining balance", async function () {
            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            // Read the full advert contract variables to get both values
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddr);
            const contractVars = await advertContract.getAllContractVariables();

            // contractVars[1] = rspAdvertbudget (remaining balance)
            // contractVars[3].advertBounty = per-engagement bounty
            const remainingBalance = contractVars[1];
            const perEngagementBounty = contractVars[3].advertBounty;

            // These two values are different (balance > bounty for a funded advert)
            expect(remainingBalance).to.be.greaterThan(perEngagementBounty);

            // getRewardSignatureData returns the per-engagement bounty
            expect(data.advertBounty).to.equal(perEngagementBounty);
            expect(data.advertBounty).to.not.equal(remainingBalance);
        });
    });

    describe("affiliateClaimInfoAddress resolution", function () {
        it("3. Returns the correct claimInfoAddress from Diamond storage", async function () {
            const affData = await createAffiliate(affiliateOwner2, mockClaimProviderWith6, "claim-2");
            const advertAddr = await createPOLProspect(advertiser2, affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            // Verify the claimInfoAddress matches what was registered
            expect(data.affiliateClaimInfoAddress).to.equal(affData.claimInfoAddr);

            // Also verify thirdPartyCount comes from the With6TPs provider (6, not 3)
            expect(data.thirdPartyCount).to.equal(6);
        });
    });

    describe("Affiliate status edge cases", function () {
        it("4. Prospect affiliate returns data without reverting", async function () {
            // Create an approved affiliate first, create advert, then
            // create a SEPARATE prospect affiliate and query with the advert
            // (the view function doesn't enforce affiliate-advert binding)
            const signers = await ethers.getSigners();
            const approvedAffSigner = signers[36];
            const prospectAffSigner = signers[37];

            // Create and approve an affiliate to bind the advert to
            const approvedAffData = await createAffiliate(approvedAffSigner, mockClaimProvider, "prospect-4-approved");
            const advertAddr = await createPOLProspect(signers[38], approvedAffData.affiliateAddr);

            // Create a prospect affiliate (NOT approved)
            const prospectAffData = await createAffiliate(prospectAffSigner, mockClaimProvider, "prospect-4", false);

            // Query with the prospect affiliate — view should still return data
            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                prospectAffData.affiliateAddr,
                viewer1.address
            );

            expect(data.affiliateStatus).to.equal(AffiliateType.Prospect);
            expect(data.affiliateSigningAddress).to.equal(prospectAffData.signingAddr);
        });

        it("5. Banned affiliate returns data without reverting", async function () {
            // Use a fresh signer for this affiliate
            const signers = await ethers.getSigners();
            const freshSigner = signers[20];

            const affData = await createAffiliate(freshSigner, mockClaimProvider, "banned-5", true);
            const advertAddr = await createPOLProspect(signers[21], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            // Ban the affiliate
            await affiliatesFacet.connect(owner).reclassifyAffiliate(
                affData.affiliateAddr,
                AffiliateType.Approved,
                AffiliateType.Banned,
                0,
                100
            );

            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            expect(data.affiliateStatus).to.equal(AffiliateType.Banned);
            expect(data.affiliateSigningAddress).to.equal(affData.signingAddr);
        });

        it("6. Nonexistent affiliate reverts", async function () {
            // Create an advert (needs a real affiliate for creation, but query with random address)
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[22];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "exist-6", true);
            const advertAddr = await createPOLProspect(signers[23], affData.affiliateAddr);

            const randomAddr = ethers.Wallet.createRandom().address;
            await expect(
                queryV2Facet.getRewardSignatureData(advertAddr, randomAddr, viewer1.address)
            ).to.be.revertedWith("Affiliate does not exist");
        });
    });

    describe("Invalid external contracts", function () {
        it("7. Invalid advert contract address (EOA) reverts", async function () {
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[24];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "inv-7", true);

            // Pass an EOA as the advert contract — external call will fail
            await expect(
                queryV2Facet.getRewardSignatureData(
                    viewer2.address, // EOA, not a contract
                    affData.affiliateAddr,
                    viewer1.address
                )
            ).to.be.reverted;
        });
    });

    describe("Block number consistency", function () {
        it("8. currentBlockNumber matches block.number at call time", async function () {
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[25];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "blk-8", true);
            const advertAddr = await createPOLProspect(signers[26], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            // Since this is a view call, block.number is the pending block
            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            const latestBlock = await ethers.provider.getBlockNumber();
            // View calls execute against the latest block
            expect(data.currentBlockNumber).to.be.closeTo(latestBlock, 1);
        });
    });

    describe("USDC advert variant", function () {
        it("9. Works identically for USDC adverts", async function () {
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[27];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "usdc-9", true);
            const advertAddr = await createUSDCProspect(signers[28], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            expect(data.affiliateStatus).to.equal(AffiliateType.Approved);
            expect(data.designatedAffiliate).to.equal(affData.affiliateAddr);

            // Verify advertBounty is per-engagement bounty (not USDC balance)
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", advertAddr);
            const contractVars = await advertContract.getAllContractVariables();
            expect(data.advertBounty).to.equal(contractVars[3].advertBounty);

            // USDC remaining balance should be larger than bounty
            expect(contractVars[1]).to.be.greaterThan(data.advertBounty);
        });
    });

    describe("Cross-verification with individual calls", function () {
        it("10. Combined call matches all 5 individual RPC calls", async function () {
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[29];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "cross-10", true);
            const advertAddr = await createPOLProspect(signers[30], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            // ── Individual call #1: getAffiliateDetailsAndStatus ──────────
            const [affStruct, affStatus] = await affiliatesFacet.getAffiliateDetailsAndStatus(
                affData.affiliateAddr
            );

            // ── Individual call #2: userAffiliateNonces ──────────────────
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddr);
            const nonce = await advertContract.userAffiliateNonces(viewer1.address, affData.affiliateAddr);

            // ── Individual call #3: getClaimPercentages ──────────────────
            const claimResult = await mockClaimProvider.getClaimPercentages();
            const individualTpCount = claimResult[2];

            // ── Individual call #4: getAllContractVariables ───────────────
            const contractVars = await advertContract.getAllContractVariables();
            const individualDesignatedAffiliate = contractVars[3].designatedAffiliate;
            const individualBounty = contractVars[3].advertBounty;

            // ── Combined call ────────────────────────────────────────────
            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            // ── Assert all fields match ──────────────────────────────────
            expect(data.affiliateSigningAddress).to.equal(affStruct.affiliateSigningAddress);
            expect(data.affiliateStatus).to.equal(affStatus);
            expect(data.affiliateClaimInfoAddress).to.equal(affStruct.affiliateClaimInfoAddress);
            expect(data.viewerNonce).to.equal(nonce);
            expect(data.thirdPartyCount).to.equal(individualTpCount);
            expect(data.designatedAffiliate).to.equal(individualDesignatedAffiliate);
            expect(data.advertBounty).to.equal(individualBounty);
        });
    });

    describe("Multiple adverts per affiliate", function () {
        it("11. Returns correct per-advert data for different adverts", async function () {
            const signers = await ethers.getSigners();
            const freshAffSigner = signers[31];
            const affData = await createAffiliate(freshAffSigner, mockClaimProvider, "multi-11", true);

            // Create two different adverts for the same affiliate
            const advertAddr1 = await createPOLProspect(signers[32], affData.affiliateAddr);
            const advertAddr2 = await createPOLProspect(signers[33], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr1);
            await ownerApproveAdvert(advertAddr2);

            const data1 = await queryV2Facet.getRewardSignatureData(
                advertAddr1,
                affData.affiliateAddr,
                viewer1.address
            );
            const data2 = await queryV2Facet.getRewardSignatureData(
                advertAddr2,
                affData.affiliateAddr,
                viewer1.address
            );

            // Affiliate data should be identical
            expect(data1.affiliateSigningAddress).to.equal(data2.affiliateSigningAddress);
            expect(data1.affiliateStatus).to.equal(data2.affiliateStatus);
            expect(data1.thirdPartyCount).to.equal(data2.thirdPartyCount);

            // Both should point to same affiliate
            expect(data1.designatedAffiliate).to.equal(affData.affiliateAddr);
            expect(data2.designatedAffiliate).to.equal(affData.affiliateAddr);

            // Nonces should both be 0 (no engagements yet)
            expect(data1.viewerNonce).to.equal(0);
            expect(data2.viewerNonce).to.equal(0);
        });
    });

    describe("Third party count verification", function () {
        it("12. thirdPartyCount matches the claim percentages provider", async function () {
            const signers = await ethers.getSigners();

            // Create affiliate with the 6-TP provider (different TP count than default 3)
            const freshAffSigner = signers[34];
            const affData = await createAffiliate(freshAffSigner, mockClaimProviderWith6, "tp-12", true);
            const advertAddr = await createPOLProspect(signers[35], affData.affiliateAddr);
            await ownerApproveAdvert(advertAddr);

            const data = await queryV2Facet.getRewardSignatureData(
                advertAddr,
                affData.affiliateAddr,
                viewer1.address
            );

            // Verify against direct call to provider — should be 6
            const directResult = await mockClaimProviderWith6.getClaimPercentages();
            expect(data.thirdPartyCount).to.equal(directResult[2]);
            expect(data.thirdPartyCount).to.equal(6);
        });
    });
});
