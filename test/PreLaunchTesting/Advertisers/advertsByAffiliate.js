const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title getApprovedAdvertsForAffiliate — Reverse Index Tests
 * @notice Validates the affiliate → approved-advert live index maintained in Diamond storage.
 *
 * The reverse mapping is populated exclusively via reclassifyAdvertisement():
 *   • _addToTargetArray (toType == Approved) → push to index
 *   • _removeFromApprovedArray                → pop from index
 *
 * Every transition path touching the Approved status is exercised here.
 */
describe("getApprovedAdvertsForAffiliate — Reverse Index", function () {
    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    let diamondAddress;
    let gateSigner;
    let advertisersFacet;
    let affiliatesFacet;
    let advertPOLFactoryFacet;
    let advertUSDCFactoryFacet;
    let votingFacet;
    let tokenFacet;
    let governanceFacet;
    let queryV2Facet;
    let mockUSDC;

    let owner;
    let voter1, voter2, voter3, voter4, voter5;
    let affiliateOwner1, affiliateOwner2, affiliateOwner3;
    let advertiser1, advertiser2, advertiser3, advertiser4, advertiser5;
    let extraSigner1, extraSigner2, extraSigner3;

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
     * Creates a prospect affiliate and immediately approves it via owner reclassify.
     * Returns the affiliate address used as the key in the reverse index.
     */
    async function createAndApproveAffiliate(ownerSigner, label) {
        const affiliateAddr = ownerSigner.address;

        // Need unique addresses for claimInfo / signingAddress
        const claimAddr = ethers.Wallet.createRandom().address;
        const signingAddr = ethers.Wallet.createRandom().address;

        await affiliatesFacet.connect(ownerSigner).createProspectAffiliateContract(
            affiliateAddr,
            claimAddr,
            signingAddr,
            `aff-${label}`,
            ...(await gate.affiliate(gateSigner, diamondAddress, ownerSigner.address)));

        // Owner can reclassify directly (bypasses voting for test speed)
        await affiliatesFacet.connect(owner).reclassifyAffiliate(
            affiliateAddr,
            AffiliateType.Prospect,
            AffiliateType.Approved,
            100,
            0
        );

        return affiliateAddr;
    }

    /**
     * Creates a POL prospect advert with a given designated affiliate.
     * Returns the deployed advert contract address.
     */
    let advertCounter = 0;
    async function createPOLProspect(signer, designatedAffiliate) {
        const sid = `rev-idx-pol-${++advertCounter}`;
        const [minBounty, minFunding, maxBlockSep] = await advertPOLFactoryFacet.getPOLAdvertisementQuotas();

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
     * Returns the deployed advert contract address.
     */
    async function createUSDCProspect(signer, designatedAffiliate) {
        const sid = `rev-idx-usdc-${++advertCounter}`;

        // Get proper min requirements from factory
        const quotas = await advertUSDCFactoryFacet.getUSDCAdvertisementQuotas();
        const bounty = quotas.minBountyUSDC;
        const funding = quotas.minFundingUSDC;

        // Approve diamond to spend USDC
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

    /**
     * Owner-shortcut: Prospect → Approved (bypasses voting quorum for test speed).
     */
    async function ownerApproveAdvert(advertAddress) {
        await advertisersFacet.connect(owner).reclassifyAdvertisement(
            advertAddress,
            AdvertisementType.Prospect,
            AdvertisementType.Approved,
            100,
            0
        );
    }

    /**
     * Queries the reverse index.
     */
    async function getIndex(affiliateAddr) {
        return queryV2Facet.getApprovedAdvertsForAffiliate(affiliateAddr);
    }

    // -----------------------------------------------------------------------
    // Governance initialization (required before factory calls)
    // -----------------------------------------------------------------------
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
                proposedMaxSignaturesPerBatch: 200,
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
        console.log("🚀 Starting getApprovedAdvertsForAffiliate reverse-index tests…");

        [
            owner,
            voter1, voter2, voter3, voter4, voter5,
            affiliateOwner1, affiliateOwner2, affiliateOwner3,
            advertiser1, advertiser2, advertiser3, advertiser4, advertiser5,
            extraSigner1, extraSigner2, extraSigner3
        ] = await ethers.getSigners();

        // Deploy diamond (registers all facets including QueryV2)
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        expect(diamondAddress).to.not.be.undefined;
        console.log("✅ Diamond deployed at:", diamondAddress);

        // Facet handles
        advertisersFacet   = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        affiliatesFacet    = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
        advertPOLFactoryFacet  = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
        advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
        votingFacet        = await ethers.getContractAt("OpenAdvertsAdvertisersVotingFacet", diamondAddress);
        tokenFacet         = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
        governanceFacet    = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
        queryV2Facet       = await ethers.getContractAt("OpenAdvertsQueryV2Facet", diamondAddress);
        gateSigner = await gate.installGateSigner(diamondAddress, owner);

        // USDC token from deploy
        const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
        mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);

        // Governance quotas must be set before factory calls
        await initializeGovernanceQuotas();
        console.log("✅ Governance quotas initialized");

        // Distribute OAD tokens for voting tests
        const tokenAmount = ethers.parseUnits("1000", 18);
        for (const v of [voter1, voter2, voter3, voter4, voter5]) {
            await tokenFacet.connect(owner).transfer(v.address, tokenAmount);
        }

        // Mint USDC to all signers that may create USDC adverts
        const allSigners = await ethers.getSigners();
        const usdcMintAmount = ethers.parseUnits("100000", 6);
        for (let i = 0; i < Math.min(allSigners.length, 35); i++) {
            await mockUSDC.connect(owner).mint(allSigners[i].address, usdcMintAmount);
        }

        await advanceBlocks(15); // flash-loan protection cooldown

        console.log("✅ Setup complete");
    });

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    describe("Empty / baseline state", function () {
        it("1. Returns empty array for affiliate with no adverts", async function () {
            const result = await getIndex(extraSigner1.address);
            expect(result).to.deep.equal([]);
        });

        it("2. Prospect advert is NOT in the index", async function () {
            const aff = await createAndApproveAffiliate(affiliateOwner1, "base-aff-1");
            await createPOLProspect(advertiser1, aff);
            const result = await getIndex(aff);
            expect(result).to.deep.equal([]);
        });
    });

    describe("Prospect → Approved (adds to index)", function () {
        let aff;
        let advert1;

        before(async function () {
            aff = await createAndApproveAffiliate(affiliateOwner2, "approve-aff");
        });

        it("3. Single approved advert appears in index", async function () {
            advert1 = await createPOLProspect(advertiser2, aff);
            await ownerApproveAdvert(advert1);

            const result = await getIndex(aff);
            expect(result.length).to.equal(1);
            expect(result[0]).to.equal(advert1);
        });

        it("4. Multiple approved adverts for same affiliate", async function () {
            const advert2 = await createPOLProspect(advertiser3, aff);
            const advert3 = await createPOLProspect(advertiser4, aff);
            await ownerApproveAdvert(advert2);
            await ownerApproveAdvert(advert3);

            const result = await getIndex(aff);
            expect(result.length).to.equal(3);
            expect(result).to.include(advert1);
            expect(result).to.include(advert2);
            expect(result).to.include(advert3);
        });
    });

    describe("Affiliate isolation", function () {
        it("5. Different affiliates have isolated indexes", async function () {
            const affA = await createAndApproveAffiliate(extraSigner2, "iso-aff-a");
            const affB = await createAndApproveAffiliate(extraSigner3, "iso-aff-b");

            const advertA = await createPOLProspect(advertiser5, affA);
            const advertB = await createPOLProspect(voter5, affB);
            await ownerApproveAdvert(advertA);
            await ownerApproveAdvert(advertB);

            const resultA = await getIndex(affA);
            const resultB = await getIndex(affB);

            expect(resultA.length).to.equal(1);
            expect(resultA[0]).to.equal(advertA);
            expect(resultB.length).to.equal(1);
            expect(resultB[0]).to.equal(advertB);
        });
    });

    describe("Approved → Deprecating (removes from index)", function () {
        it("6. Deprecating advert is removed from index", async function () {
            const aff = await createAndApproveAffiliate(voter1, "dep-aff");
            const advert = await createPOLProspect(voter2, aff);
            await ownerApproveAdvert(advert);

            // Process commission first (required before deprecation in some flows)
            const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advert);
            await advertContract.connect(owner).processCommission();

            // Deprecate (Approved → Deprecating): owner-initiated via advert contract
            await advertContract.connect(voter2).deprecateAdvert();

            const result = await getIndex(aff);
            expect(result).to.deep.equal([]);
        });
    });

    describe("Approved → Banned (removes from index)", function () {
        it("7. Banned advert is removed from index", async function () {
            const aff = await createAndApproveAffiliate(voter3, "ban-aff");
            const advert = await createPOLProspect(voter4, aff);
            await ownerApproveAdvert(advert);

            expect((await getIndex(aff)).length).to.equal(1);

            await advertisersFacet.connect(owner).banAdvertisement(advert);

            const result = await getIndex(aff);
            expect(result).to.deep.equal([]);
        });
    });

    describe("Banned → Approved via unban (re-adds to index)", function () {
        it("8. Unbanned advert is re-added to index", async function () {
            // Need fresh signers not used in any prior test as affiliate owners
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[34]; // far enough to avoid collisions
            const freshAdvertiser = signers[35];

            const aff = await createAndApproveAffiliate(freshAffOwner, "unban-aff");
            const advert = await createPOLProspect(freshAdvertiser, aff);
            await ownerApproveAdvert(advert);
            expect((await getIndex(aff)).length).to.equal(1);

            // Ban
            await advertisersFacet.connect(owner).banAdvertisement(advert);
            expect((await getIndex(aff)).length).to.equal(0);

            // Unban (restores to Approved since originalTypeBeforeBan == Approved)
            await advertisersFacet.connect(owner).unbanAdvertisement(advert);

            const result = await getIndex(aff);
            expect(result.length).to.equal(1);
            expect(result[0]).to.equal(advert);
        });
    });

    describe("Approved → Prospect demotion (removes from index)", function () {
        it("9. Demoted advert is removed from index", async function () {
            // Owner can reclassify Approved → Prospect directly
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[18];
            const freshAdvertiser = signers[19];

            const aff = await createAndApproveAffiliate(freshAffOwner, "demote-aff");
            const advert = await createPOLProspect(freshAdvertiser, aff);
            await ownerApproveAdvert(advert);
            expect((await getIndex(aff)).length).to.equal(1);

            // Demote: Approved → Prospect
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                advert,
                AdvertisementType.Approved,
                AdvertisementType.Prospect,
                0,
                100
            );

            const result = await getIndex(aff);
            expect(result).to.deep.equal([]);
        });
    });

    describe("address(0) affiliate is never indexed", function () {
        it("10. Advert with zero-address affiliate does not pollute index", async function () {
            const advert = await createPOLProspect(advertiser1, ZERO_ADDRESS);
            await ownerApproveAdvert(advert);

            const result = await getIndex(ZERO_ADDRESS);
            expect(result).to.deep.equal([]);
        });
    });

    describe("Swap-and-pop correctness", function () {
        it("11. Removing middle element preserves remaining entries", async function () {
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[20];

            const aff = await createAndApproveAffiliate(freshAffOwner, "swap-aff");

            const advA = await createPOLProspect(signers[21], aff);
            const advB = await createPOLProspect(signers[22], aff);
            const advC = await createPOLProspect(signers[23], aff);
            await ownerApproveAdvert(advA);
            await ownerApproveAdvert(advB);
            await ownerApproveAdvert(advC);

            expect((await getIndex(aff)).length).to.equal(3);

            // Remove B (middle element) by banning
            await advertisersFacet.connect(owner).banAdvertisement(advB);

            const result = await getIndex(aff);
            expect(result.length).to.equal(2);
            expect(result).to.include(advA);
            expect(result).to.include(advC);
            expect(result).to.not.include(advB);
        });
    });

    describe("USDC advert path", function () {
        it("12. USDC advert appears in index when approved", async function () {
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[24];
            const freshAdvertiser = signers[25];

            const aff = await createAndApproveAffiliate(freshAffOwner, "usdc-aff");
            const advert = await createUSDCProspect(freshAdvertiser, aff);
            await ownerApproveAdvert(advert);

            const result = await getIndex(aff);
            expect(result.length).to.equal(1);
            expect(result[0]).to.equal(advert);
        });
    });

    describe("Mixed POL + USDC", function () {
        it("13. Both POL and USDC adverts appear for same affiliate", async function () {
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[26];

            const aff = await createAndApproveAffiliate(freshAffOwner, "mixed-aff");
            const polAdvert = await createPOLProspect(signers[27], aff);
            const usdcAdvert = await createUSDCProspect(signers[28], aff);
            await ownerApproveAdvert(polAdvert);
            await ownerApproveAdvert(usdcAdvert);

            const result = await getIndex(aff);
            expect(result.length).to.equal(2);
            expect(result).to.include(polAdvert);
            expect(result).to.include(usdcAdvert);
        });
    });

    describe("Full lifecycle round-trip", function () {
        it("14. Approve → deprecate → create new → approve new → only new in index", async function () {
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[29];

            const aff = await createAndApproveAffiliate(freshAffOwner, "round-aff");

            // First advert: approve then deprecate
            const advert1 = await createPOLProspect(signers[30], aff);
            await ownerApproveAdvert(advert1);
            expect((await getIndex(aff)).length).to.equal(1);

            // Process commission before deprecation
            const advert1Contract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advert1);
            await advert1Contract.connect(owner).processCommission();
            await advert1Contract.connect(signers[30]).deprecateAdvert();
            expect((await getIndex(aff)).length).to.equal(0);

            // Second advert: approve
            const advert2 = await createPOLProspect(signers[31], aff);
            await ownerApproveAdvert(advert2);

            const result = await getIndex(aff);
            expect(result.length).to.equal(1);
            expect(result[0]).to.equal(advert2);
            expect(result).to.not.include(advert1);
        });
    });

    describe("Approved → Exhausted (removes from index)", function () {
        it("15. Owner reclassify Approved → Exhausted removes from index", async function () {
            const signers = await ethers.getSigners();
            const freshAffOwner = signers[32];
            const freshAdvertiser = signers[33];

            const aff = await createAndApproveAffiliate(freshAffOwner, "exhaust-aff");
            const advert = await createPOLProspect(freshAdvertiser, aff);
            await ownerApproveAdvert(advert);
            expect((await getIndex(aff)).length).to.equal(1);

            // Simulate exhaustion via owner reclassify
            await advertisersFacet.connect(owner).reclassifyAdvertisement(
                advert,
                AdvertisementType.Approved,
                AdvertisementType.Exhausted,
                0,
                0
            );

            const result = await getIndex(aff);
            expect(result).to.deep.equal([]);
        });
    });
});
