const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../../scripts/deploy");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const gate = require("../../helpers/signatureGate.js");

/**
 * @title getAffiliateAdvertsWithDetails — Paginated Batch View Tests
 * @notice Validates the new QueryV2Facet function that combines
 *         getApprovedAdvertsForAffiliate (address[]) with external
 *         getAllContractVariables() calls into a single paginated view.
 *
 * Tests cover:
 *   1.  Happy path — single POL advert, all fields match individual call
 *   2.  Multiple adverts (POL + USDC mixed), verify count and data
 *   3.  Zero approved adverts → empty array
 *   4.  USDC advert balance is ERC20 balance (not native)
 *   5.  Cross-verify: batch result matches individual getAllContractVariables
 *   6.  readSuccess is true for all valid adverts
 *   7.  Pagination — startIndex and maxResults work correctly
 *   8.  Pagination — hasMore flag and totalCount are accurate
 *   9.  Pagination — startIndex beyond array returns empty
 *  10.  Pagination — maxResults=0 uses default page size
 */
describe("getAffiliateAdvertsWithDetails — Paginated Batch View", function () {
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
    let affiliateOwner1, affiliateOwner2;
    let advertiser1, advertiser2, advertiser3, advertiser4;
    let viewer1;

    // Mock ClaimPercentagesProvider
    let mockClaimProvider;

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

    let advertCounter = 0;
    async function createPOLProspect(signer, designatedAffiliate) {
        const sid = `aad-pol-${++advertCounter}`;
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

    async function createUSDCProspect(signer, designatedAffiliate) {
        const sid = `aad-usdc-${++advertCounter}`;
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

    // Shared state across tests
    let affiliate1;    // approved affiliate with multiple adverts
    let affiliate2;    // approved affiliate with 0 adverts
    let polAdvert1;    // POL advert → affiliate1
    let polAdvert2;    // POL advert → affiliate1
    let usdcAdvert1;   // USDC advert → affiliate1

    before(async function () {
        this.timeout(120_000);
        console.log("🚀 Starting getAffiliateAdvertsWithDetails tests…");

        const signers = await ethers.getSigners();
        [
            owner,
            voter1, voter2, voter3,
            affiliateOwner1, affiliateOwner2,
            advertiser1, advertiser2, advertiser3, advertiser4,
            viewer1
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

        // Deploy mock claim provider (3 TPs)
        const MockClaim = await ethers.getContractFactory("contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider");
        mockClaimProvider = await MockClaim.deploy();
        await mockClaimProvider.waitForDeployment();
        console.log("✅ MockClaimPercentagesProvider deployed");

        // Initialize governance quotas
        await initializeGovernanceQuotas();
        console.log("✅ Governance quotas initialized");

        // Mint USDC to advertisers that will create USDC adverts
        // Only advertiser3 (index 8) needs USDC for USDC advert creation
        for (const signer of [advertiser3]) {
            await mockUSDC.connect(owner).transfer(
                signer.address,
                ethers.parseUnits("50000", 6)
            );
        }
        console.log("✅ USDC distributed to test advertisers");

        // Create affiliate1 (with adverts) and affiliate2 (without adverts)
        affiliate1 = await createAffiliate(affiliateOwner1, mockClaimProvider, "details-1", true);
        affiliate2 = await createAffiliate(affiliateOwner2, mockClaimProvider, "details-2", true);
        console.log("✅ Affiliates created — affiliate1:", affiliate1.affiliateAddr, "affiliate2:", affiliate2.affiliateAddr);

        // Create 2 POL adverts bound to affiliate1
        polAdvert1 = await createPOLProspect(advertiser1, affiliate1.affiliateAddr);
        await ownerApproveAdvert(polAdvert1);
        console.log("✅ POL advert 1 created + approved:", polAdvert1);

        polAdvert2 = await createPOLProspect(advertiser2, affiliate1.affiliateAddr);
        await ownerApproveAdvert(polAdvert2);
        console.log("✅ POL advert 2 created + approved:", polAdvert2);

        // Create 1 USDC advert bound to affiliate1
        usdcAdvert1 = await createUSDCProspect(advertiser3, affiliate1.affiliateAddr);
        await ownerApproveAdvert(usdcAdvert1);
        console.log("✅ USDC advert 1 created + approved:", usdcAdvert1);
    });

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    it("Test 1: Happy path — single POL advert fields match getAllContractVariables", async function () {
        // Fetch page with just the first advert
        const [results, totalCount, hasMore] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 1
        );

        expect(results.length).to.equal(1);
        expect(totalCount).to.equal(3n); // 2 POL + 1 USDC
        expect(hasMore).to.be.true;

        const entry = results[0];
        expect(entry.readSuccess).to.be.true;

        // Cross-check against direct call
        const advertContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvert1);
        const [issuer, balance, initBudget, info, , payoutToken] = await advertContract.getAllContractVariables();

        expect(entry.contractIssuer).to.equal(issuer);
        expect(entry.currentBalance).to.equal(balance);
        expect(entry.initialFundedBudget).to.equal(initBudget);
        expect(entry.payoutToken).to.equal(payoutToken);
        expect(entry.advertInfo.advertContractAddress).to.equal(polAdvert1);
        expect(entry.advertInfo.storageId).to.equal(info.storageId);
        expect(entry.advertInfo.advertBounty).to.equal(info.advertBounty);
    });

    it("Test 2: Multiple adverts (POL + USDC mixed) — verify count and data", async function () {
        const [results, totalCount, hasMore] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 100
        );

        expect(totalCount).to.equal(3n);
        expect(results.length).to.equal(3);
        expect(hasMore).to.be.false;

        // All entries should have readSuccess=true
        for (const entry of results) {
            expect(entry.readSuccess).to.be.true;
        }

        // Collect returned addresses
        const returnedAddrs = results.map(r => r.advertInfo.advertContractAddress);
        expect(returnedAddrs).to.include(polAdvert1);
        expect(returnedAddrs).to.include(polAdvert2);
        expect(returnedAddrs).to.include(usdcAdvert1);
    });

    it("Test 3: Zero approved adverts → empty array", async function () {
        const [results, totalCount, hasMore] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate2.affiliateAddr, 0, 100
        );

        expect(results.length).to.equal(0);
        expect(totalCount).to.equal(0n);
        expect(hasMore).to.be.false;
    });

    it("Test 4: USDC advert balance is ERC20 balanceOf (not native)", async function () {
        const [results] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 100
        );

        // Find the USDC advert entry
        const usdcEntry = results.find(r =>
            r.advertInfo.advertContractAddress === usdcAdvert1
        );
        expect(usdcEntry).to.not.be.undefined;

        // Direct USDC balance check
        const usdcBalance = await mockUSDC.balanceOf(usdcAdvert1);
        expect(usdcEntry.currentBalance).to.equal(usdcBalance);

        // Verify it's a USDC advert (PaymentType.USDC = 1)
        expect(usdcEntry.advertInfo.advertCurrency).to.equal(1n);
        expect(usdcEntry.payoutToken).to.equal("USDC");
    });

    it("Test 5: Cross-verify — batch result matches individual getAllContractVariables", async function () {
        const [results] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 100
        );

        // For each result, call getAllContractVariables directly and compare
        for (const entry of results) {
            const addr = entry.advertInfo.advertContractAddress;
            const isPOL = entry.advertInfo.advertCurrency === 0n;
            const contractName = isPOL ? "OpenAdvertsAdvertPOL" : "OpenAdvertsAdvertUSDC";
            const directContract = await ethers.getContractAt(contractName, addr);

            const [issuer, balance, initBudget, info, , payoutToken] = await directContract.getAllContractVariables();

            expect(entry.contractIssuer).to.equal(issuer);
            // Note: balance may differ slightly due to block timing, but in view context they're atomic
            expect(entry.currentBalance).to.equal(balance);
            expect(entry.initialFundedBudget).to.equal(initBudget);
            expect(entry.payoutToken).to.equal(payoutToken);
            expect(entry.advertInfo.designatedAffiliate).to.equal(info.designatedAffiliate);
            expect(entry.advertInfo.advertBounty).to.equal(info.advertBounty);
            expect(entry.advertInfo.advertOwner).to.equal(info.advertOwner);
        }
    });

    it("Test 6: readSuccess is true for all valid adverts", async function () {
        const [results] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 100
        );

        for (const entry of results) {
            expect(entry.readSuccess).to.be.true;
        }
    });

    it("Test 7: Pagination — startIndex and maxResults work correctly", async function () {
        // Fetch page 1 (first 2 of 3)
        const [page1, total1, hasMore1] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 2
        );
        expect(page1.length).to.equal(2);
        expect(total1).to.equal(3n);
        expect(hasMore1).to.be.true;

        // Fetch page 2 (remaining 1)
        const [page2, total2, hasMore2] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 2, 2
        );
        expect(page2.length).to.equal(1);
        expect(total2).to.equal(3n);
        expect(hasMore2).to.be.false;

        // Pages should not overlap
        const page1Addrs = page1.map(r => r.advertInfo.advertContractAddress);
        const page2Addrs = page2.map(r => r.advertInfo.advertContractAddress);
        for (const addr of page2Addrs) {
            expect(page1Addrs).to.not.include(addr);
        }

        // Combined should cover all
        const allAddrs = [...page1Addrs, ...page2Addrs];
        expect(allAddrs).to.include(polAdvert1);
        expect(allAddrs).to.include(polAdvert2);
        expect(allAddrs).to.include(usdcAdvert1);
    });

    it("Test 8: Pagination — hasMore and totalCount are accurate", async function () {
        // maxResults=1: should have hasMore=true
        const [r1, t1, hm1] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 1
        );
        expect(r1.length).to.equal(1);
        expect(t1).to.equal(3n);
        expect(hm1).to.be.true;

        // startIndex=2, maxResults=1: last element, hasMore=false
        const [r2, t2, hm2] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 2, 1
        );
        expect(r2.length).to.equal(1);
        expect(t2).to.equal(3n);
        expect(hm2).to.be.false;

        // maxResults=3: exact fit, hasMore=false
        const [r3, t3, hm3] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 3
        );
        expect(r3.length).to.equal(3);
        expect(t3).to.equal(3n);
        expect(hm3).to.be.false;
    });

    it("Test 9: Pagination — startIndex beyond array returns empty", async function () {
        const [results, totalCount, hasMore] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 999, 10
        );

        expect(results.length).to.equal(0);
        expect(totalCount).to.equal(3n);
        expect(hasMore).to.be.false;
    });

    it("Test 10: Pagination — maxResults=0 uses default page size", async function () {
        // maxResults=0 should behave identically to using the default
        const [results, totalCount, hasMore] = await queryV2Facet.getAffiliateAdvertsWithDetails(
            affiliate1.affiliateAddr, 0, 0
        );

        // With only 3 adverts and default page size (50), should return all 3
        expect(results.length).to.equal(3);
        expect(totalCount).to.equal(3n);
        expect(hasMore).to.be.false;

        // Verify data integrity
        for (const entry of results) {
            expect(entry.readSuccess).to.be.true;
            expect(entry.contractIssuer).to.not.equal(ZERO_ADDRESS);
        }
    });
});
