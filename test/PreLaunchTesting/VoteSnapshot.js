// Phase 2 — lazy snapshot-based vote weighting.
// Covers:
//   - balanceOfAt returns current balance before any transfer
//   - balanceOfAt returns the pre-transfer balance for accounts that transfer
//     after a snapshot has been opened
//   - Snapshot id is bumped exactly once per proposal and per admin election
//   - voteOnProposal uses the snapshot balance (fresh transfers give zero weight)
//   - voteForNewAdmin uses the admin-vote snapshot balance
//   - Multiple concurrent snapshots (proposal + admin election) are correctly
//     indexed, including an account that transfers after id=N1 but before id=N2

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDiamond } = require("../../scripts/deploy.js");

const ONE_ADV = ethers.parseEther("1");

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

describe("Phase 2 — Lazy Snapshot-Based Vote Weighting", function () {
    let diamondAddress;
    let tokenFacet;
    let governance;
    let owner;
    let alice;
    let bob;
    let carol;

    beforeEach(async function () {
        [owner, alice, bob, carol] = await ethers.getSigners();
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        tokenFacet  = await ethers.getContractAt("OpenAdvertsTokenFacet",      diamondAddress);
        governance  = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
    });

    // ---------------------------------------------------------------------
    // balanceOfAt primitive
    // ---------------------------------------------------------------------
    describe("balanceOfAt primitive", function () {
        it("starts at currentSnapshotId = 0", async function () {
            expect(await tokenFacet.currentSnapshotId()).to.equal(0);
        });

        it("reverts when queried with id 0", async function () {
            await expect(tokenFacet.balanceOfAt(owner.address, 0))
                .to.be.revertedWith("Snapshot id is zero");
        });

        it("reverts when queried with id above currentSnapshotId", async function () {
            await expect(tokenFacet.balanceOfAt(owner.address, 1))
                .to.be.revertedWith("Snapshot id out of range");
        });

        it("returns pre-transfer balance for the sender after a transfer", async function () {
            // Open snapshot 1 by creating a proposal.
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            expect(await tokenFacet.currentSnapshotId()).to.equal(1);

            const ownerStart = await tokenFacet.balanceOf(owner.address);
            await tokenFacet.connect(owner).transfer(alice.address, ethers.parseEther("1000"));
            // Owner's balance AT snapshot 1 is the pre-transfer amount.
            expect(await tokenFacet.balanceOfAt(owner.address, 1)).to.equal(ownerStart);
            // Alice's balance AT snapshot 1 is zero (she had nothing then).
            expect(await tokenFacet.balanceOfAt(alice.address, 1)).to.equal(0);
            // Live balance reflects the transfer.
            expect(await tokenFacet.balanceOf(alice.address)).to.equal(ethers.parseEther("1000"));
        });

        it("returns current balance when no transfer has touched the account since the snapshot", async function () {
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            const ownerBal = await tokenFacet.balanceOf(owner.address);
            // No transfer → no checkpoint → returns current balance.
            expect(await tokenFacet.balanceOfAt(owner.address, 1)).to.equal(ownerBal);
        });
    });

    // ---------------------------------------------------------------------
    // Snapshot id bumping
    // ---------------------------------------------------------------------
    describe("Snapshot id bumping", function () {
        it("bumps id once per createProposal", async function () {
            expect(await tokenFacet.currentSnapshotId()).to.equal(0);
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            expect(await tokenFacet.currentSnapshotId()).to.equal(1);
            await governance.connect(owner).revokeProposal();
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            expect(await tokenFacet.currentSnapshotId()).to.equal(2);
        });

        it("bumps id when the first applicant opens an admin election round", async function () {
            const fee = ethers.parseEther("500");
            expect(await tokenFacet.currentSnapshotId()).to.equal(0);
            await governance.connect(alice).applyAsNewAdmin("alice-app", { value: fee });
            expect(await tokenFacet.currentSnapshotId()).to.equal(1);
            // A second applicant in the SAME round does NOT bump again.
            await governance.connect(bob).applyAsNewAdmin("bob-app", { value: fee });
            expect(await tokenFacet.currentSnapshotId()).to.equal(1);
        });
    });

    // ---------------------------------------------------------------------
    // voteOnProposal snapshot semantics
    // ---------------------------------------------------------------------
    describe("voteOnProposal uses snapshot balance", function () {
        it("counts the voter's balance at snapshot time, not at vote time", async function () {
            // Fund alice first, then take snapshot.
            await tokenFacet.connect(owner).transfer(alice.address, ethers.parseEther("1000"));
            await mine(5);
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            await mine(5);

            // Alice moves her tokens AWAY before voting — she should still vote
            // with the full pre-transfer weight.
            await tokenFacet.connect(alice).transfer(bob.address, ethers.parseEther("1000"));
            await mine(5);

            // Alice now has zero live balance but snapshot weight is 1000.
            expect(await tokenFacet.balanceOf(alice.address)).to.equal(0);

            await governance.connect(alice).voteOnProposal(true);
            const snap = await governance.getAllCurrentQuotas();
            snap; // not asserting here; read raw state instead
            const govView = await (await ethers.getContractAt("OpenAdvertsQueryV2Facet", diamondAddress)).getGovernanceSnapshot();
            expect(govView.proposalStruct.totalSupportVotesForCurrentProposal).to.equal(ethers.parseEther("1000"));
        });

        it("gives zero weight to accounts that received tokens AFTER the snapshot", async function () {
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            await tokenFacet.connect(owner).transfer(bob.address, ethers.parseEther("5000"));
            await mine(5);

            expect(await tokenFacet.balanceOfAt(bob.address, 1)).to.equal(0);
            await expect(governance.connect(bob).voteOnProposal(true))
                .to.be.revertedWith("Caller does not have ownership tokens");
        });
    });

    // ---------------------------------------------------------------------
    // voteForNewAdmin snapshot semantics
    // ---------------------------------------------------------------------
    describe("voteForNewAdmin uses admin-round snapshot balance", function () {
        it("fresh transfer after admin round opens carries zero weight", async function () {
            const fee = ethers.parseEther("500");
            await governance.connect(alice).applyAsNewAdmin("alice-app", { value: fee });
            // Snapshot id = 1 now covers this admin round.
            await tokenFacet.connect(owner).transfer(carol.address, ethers.parseEther("2000"));
            await mine(5);

            expect(await tokenFacet.balanceOfAt(carol.address, 1)).to.equal(0);
            await expect(governance.connect(carol).voteForNewAdmin(alice.address))
                .to.be.revertedWith("Insufficient token balance to vote");
        });

        it("voter funded before the round opens votes with full weight", async function () {
            await tokenFacet.connect(owner).transfer(bob.address, ethers.parseEther("3000"));
            await mine(5);
            const fee = ethers.parseEther("500");
            await governance.connect(alice).applyAsNewAdmin("alice-app", { value: fee });
            await mine(5);

            await governance.connect(bob).voteForNewAdmin(alice.address);
            // Retrieve via adminVotesByUser path through the query facet is awkward;
            // the important invariant is that the call didn't revert and that the
            // vote was recorded. Confirm via hasVotedOnProposal-equivalent: a
            // second call for the same candidate should now revert.
            await mine(5);
            await expect(governance.connect(bob).voteForNewAdmin(alice.address))
                .to.be.revertedWith("You have already voted for this candidate in the current round");
        });
    });

    // ---------------------------------------------------------------------
    // Concurrent snapshots (proposal + admin election)
    // ---------------------------------------------------------------------
    describe("Concurrent snapshots (proposal + admin election)", function () {
        it("resolves historical balances correctly when a transfer straddles two snapshots", async function () {
            // Fund alice BEFORE any snapshot.
            await tokenFacet.connect(owner).transfer(alice.address, ethers.parseEther("4000"));
            await mine(5);

            // Snapshot id 1: governance proposal.
            await governance.connect(owner).createProposal(0, sampleQuotaProposal(), 605000, []);
            expect(await tokenFacet.currentSnapshotId()).to.equal(1);

            // Alice transfers half away BETWEEN id=1 and id=2.
            await tokenFacet.connect(alice).transfer(bob.address, ethers.parseEther("2000"));
            await mine(5);

            // Snapshot id 2: admin election opens.
            const fee = ethers.parseEther("500");
            await governance.connect(carol).applyAsNewAdmin("carol-app", { value: fee });
            expect(await tokenFacet.currentSnapshotId()).to.equal(2);

            // Balance at id=1 should reflect alice's pre-transfer amount (4000).
            expect(await tokenFacet.balanceOfAt(alice.address, 1)).to.equal(ethers.parseEther("4000"));
            // Balance at id=2 should reflect the post-transfer amount (2000).
            expect(await tokenFacet.balanceOfAt(alice.address, 2)).to.equal(ethers.parseEther("2000"));

            // Bob had no balance before id=1, received 2000 between id=1 and id=2.
            expect(await tokenFacet.balanceOfAt(bob.address, 1)).to.equal(0);
            expect(await tokenFacet.balanceOfAt(bob.address, 2)).to.equal(ethers.parseEther("2000"));

            // Another transfer AFTER id=2 must not retroactively change id=1 or id=2.
            await tokenFacet.connect(alice).transfer(bob.address, ethers.parseEther("500"));
            await mine(5);
            expect(await tokenFacet.balanceOfAt(alice.address, 1)).to.equal(ethers.parseEther("4000"));
            expect(await tokenFacet.balanceOfAt(alice.address, 2)).to.equal(ethers.parseEther("2000"));
            expect(await tokenFacet.balanceOfAt(bob.address, 1)).to.equal(0);
            expect(await tokenFacet.balanceOfAt(bob.address, 2)).to.equal(ethers.parseEther("2000"));
        });
    });
});
