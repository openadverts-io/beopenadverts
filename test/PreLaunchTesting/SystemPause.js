// Phase 4 — system-wide emergency pause tests.
// Covers:
//   - pause() / unpause() auth + idempotency
//   - Gated functions revert with "System paused" when paused
//   - Gated functions succeed after unpause
//   - Exit / withdrawal / view paths remain functional even when paused
//   - Events fired

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");

function sampleQuotaProposal() {
    return {
        proposedQuotaProposalQuorum: 51,
        proposedMinQuotaProposalDuration: 302400,
        proposedMaxQuotaProposalDuration: 3888000,
        proposedOpenAdvertsCommission: 10,
        proposedStorageProviderCommissionFromADVC: 5,
        proposedAdminCommissionFromADVC: 5,
        proposedPolBlocksPerHour: 1800,
        proposedMinPOLRequiredforAdvertInWei: ethers.parseEther("200"),
        proposedMinAdvertBountyInPOLWei: ethers.parseEther("0.06"),
        proposedUSDCCurrencyPremiumInPCT: 50,
        proposedAdvertApprovalDenialQuorum: 20,
        proposedAdvertApprovalThreshold: 60,
        proposedAdvertDenialThreshold: 60,
        proposedMaxBlockSeparationAdvertisement: 21600,
        proposedAffiliateApprovalDenialQuorum: 20,
        proposedAffiliateApprovalThreshold: 60,
        proposedAffiliateDenialThreshold: 60,
        proposedFacetProposalQuorum: 51,
        proposedMinFacetProposalDuration: 302400,
        proposedMaxFacetProposalDuration: 3888000,
        proposedOpenAdvertsAdminChangeQuorum: 51,
        proposedAdminApplicantFeeInPolWei: ethers.parseEther("500"),
        proposedAdminVoteDeadlineInBlocks: 1296000,
        proposedAdvertPauseCooldownBlocks: 302400,
        proposedMaxSignaturesPerBatch: 50,
        proposedMinViewerClaimPct: 70,
    };
}

describe("Phase 4 — System-Wide Emergency Pause", function () {
    let diamondAddress;
    let pauseFacet;
    let governance;
    let polFactory;
    let tokenFacet;
    let owner;
    let nonOwner;
    let alice;

    beforeEach(async function () {
        [owner, nonOwner, alice] = await ethers.getSigners();
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        pauseFacet  = await ethers.getContractAt("OpenAdvertsPauseFacet",              diamondAddress);
        governance  = await ethers.getContractAt("OpenAdvertsGovernanceFacet",         diamondAddress);
        polFactory  = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet",   diamondAddress);
        tokenFacet  = await ethers.getContractAt("OpenAdvertsTokenFacet",              diamondAddress);
    });

    // ---------------------------------------------------------------------
    // pause() / unpause() primitives
    // ---------------------------------------------------------------------
    describe("pause / unpause primitives", function () {
        it("is unpaused by default", async function () {
            expect(await pauseFacet.isSystemPaused()).to.equal(false);
            const info = await pauseFacet.getPauseInfo();
            expect(info.paused).to.equal(false);
            expect(info.pausedAt).to.equal(0);
            expect(info.pausedBy).to.equal(ethers.ZeroAddress);
            expect(info.reason).to.equal("");
        });

        it("pause reverts for non-owner", async function () {
            await expect(pauseFacet.connect(nonOwner).pause("test"))
                .to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("unpause reverts for non-owner", async function () {
            await pauseFacet.connect(owner).pause("test");
            await expect(pauseFacet.connect(nonOwner).unpause())
                .to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("pause emits SystemPaused and records info", async function () {
            const tx = await pauseFacet.connect(owner).pause("incident-2026-04-22");
            await expect(tx).to.emit(pauseFacet, "SystemPaused");
            expect(await pauseFacet.isSystemPaused()).to.equal(true);
            const info = await pauseFacet.getPauseInfo();
            expect(info.paused).to.equal(true);
            expect(info.pausedBy).to.equal(owner.address);
            expect(info.reason).to.equal("incident-2026-04-22");
            expect(info.pausedAt).to.be.gt(0);
        });

        it("unpause emits SystemUnpaused and clears info", async function () {
            await pauseFacet.connect(owner).pause("x");
            const tx = await pauseFacet.connect(owner).unpause();
            await expect(tx).to.emit(pauseFacet, "SystemUnpaused");
            const info = await pauseFacet.getPauseInfo();
            expect(info.paused).to.equal(false);
            expect(info.pausedAt).to.equal(0);
            expect(info.pausedBy).to.equal(ethers.ZeroAddress);
            expect(info.reason).to.equal("");
        });

        it("double-pause reverts", async function () {
            await pauseFacet.connect(owner).pause("x");
            await expect(pauseFacet.connect(owner).pause("y"))
                .to.be.revertedWith("Already paused");
        });

        it("unpause-when-not-paused reverts", async function () {
            await expect(pauseFacet.connect(owner).unpause())
                .to.be.revertedWith("Not paused");
        });
    });

    // ---------------------------------------------------------------------
    // Governance paths are gated
    // ---------------------------------------------------------------------
    describe("Governance paths gated", function () {
        it("createProposal reverts when paused", async function () {
            await pauseFacet.connect(owner).pause("x");
            await expect(governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []))
                .to.be.revertedWith("System paused");
        });

        it("voteOnProposal reverts when paused", async function () {
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            await pauseFacet.connect(owner).pause("x");
            await expect(governance.connect(owner).voteOnProposal(true))
                .to.be.revertedWith("System paused");
        });

        it("applyAsNewAdmin reverts when paused", async function () {
            await pauseFacet.connect(owner).pause("x");
            await expect(
                governance.connect(alice).applyAsNewAdmin("a", { value: ethers.parseEther("500") })
            ).to.be.revertedWith("System paused");
        });

        it("voteForNewAdmin reverts when paused", async function () {
            await governance.connect(alice).applyAsNewAdmin("a", { value: ethers.parseEther("500") });
            await pauseFacet.connect(owner).pause("x");
            await expect(governance.connect(owner).voteForNewAdmin(alice.address))
                .to.be.revertedWith("System paused");
        });

        it("createProposal succeeds after unpause", async function () {
            await pauseFacet.connect(owner).pause("x");
            await pauseFacet.connect(owner).unpause();
            await expect(governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []))
                .to.not.be.reverted;
        });
    });

    // ---------------------------------------------------------------------
    // Factory paths are gated
    // ---------------------------------------------------------------------
    describe("Factory paths gated", function () {
        it("createNewProspectPOLAdvertContract reverts when paused", async function () {
            await pauseFacet.connect(owner).pause("x");
            await expect(
                polFactory.connect(alice).createNewProspectPOLAdvertContract(
                    "ad-1",
                    ethers.parseEther("0.1"),
                    1000,
                    alice.address,
                    ethers.ZeroHash, // dummy gate args; pause check reverts before signature verification
                    0,
                    "0x",
                    { value: ethers.parseEther("400") }
                )
            ).to.be.revertedWith("System paused");
        });
    });

    // ---------------------------------------------------------------------
    // Exit / view paths remain functional
    // ---------------------------------------------------------------------
    describe("Exit and view paths unaffected by pause", function () {
        beforeEach(async function () {
            await pauseFacet.connect(owner).pause("incident");
        });

        it("token transfer still works while paused (no gate)", async function () {
            await expect(tokenFacet.connect(owner).transfer(alice.address, ethers.parseEther("10")))
                .to.not.be.reverted;
            expect(await tokenFacet.balanceOf(alice.address)).to.equal(ethers.parseEther("10"));
        });

        it("balanceOf read still works while paused", async function () {
            expect(await tokenFacet.balanceOf(owner.address)).to.be.gt(0);
        });

        it("revokeProposal still works while paused", async function () {
            // Unpause, create proposal, re-pause, then revoke.
            await pauseFacet.connect(owner).unpause();
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            await pauseFacet.connect(owner).pause("re-pause");
            await expect(governance.connect(owner).revokeProposal()).to.not.be.reverted;
        });

        it("timelock facet functions remain callable while paused", async function () {
            const timelock = await ethers.getContractAt("OpenAdvertsTimelockFacet", diamondAddress);
            await expect(timelock.connect(owner).initializeTimelock(3600)).to.not.be.reverted;
        });

        it("pause-facet views remain callable while paused", async function () {
            expect(await pauseFacet.isSystemPaused()).to.equal(true);
            const info = await pauseFacet.getPauseInfo();
            expect(info.reason).to.equal("incident");
        });
    });
});
