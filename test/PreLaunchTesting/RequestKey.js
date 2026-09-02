const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

// Matches the local-only dummy requestKey seeded by scripts/deploy.js.
const DUMMY_REQUEST_KEY = ethers.getAddress("0x000000000000000000000000000000000000bEEF");

describe("🔑 RequestKey (owner-rotated KMS auth key)", function () {
  let diamondAddress, ownershipFacet, requestKeyFacet, governanceFacet, queryV2Facet, tokenFacet, payoutFacet;
  let owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const deployed = await deployDiamond();
    diamondAddress = deployed.diamond;
    ownershipFacet = await ethers.getContractAt("OwnershipFacet", diamondAddress);
    // The RequestKey facet owns get/set + declares the event and custom errors; bind its ABI to the
    // diamond so chai-matchers can decode logs/reverts (self-call rotations bubble up from the diamond).
    requestKeyFacet = await ethers.getContractAt("OpenAdvertsRequestKeyFacet", diamondAddress);
    governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
    queryV2Facet = await ethers.getContractAt("OpenAdvertsQueryV2Facet", diamondAddress);
    tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
    payoutFacet = await ethers.getContractAt("OpenAdvertsPayoutFacet", diamondAddress);
  });

  describe("Deployment", function () {
    it("seeds the dummy requestKey at deploy", async function () {
      expect(await requestKeyFacet.getRequestKey()).to.equal(DUMMY_REQUEST_KEY);
    });
  });

  describe("setRequestKey (owner-only, immediate)", function () {
    it("owner rotates and emits RequestKeyUpdated", async function () {
      const prev = await requestKeyFacet.getRequestKey();
      const next = ethers.Wallet.createRandom().address;
      await expect(requestKeyFacet.connect(owner).setRequestKey(next))
        .to.emit(requestKeyFacet, "RequestKeyUpdated")
        .withArgs(prev, next, owner.address);
      expect(await requestKeyFacet.getRequestKey()).to.equal(next);
    });

    it("rejects a non-owner caller", async function () {
      await expect(
        requestKeyFacet.connect(alice).setRequestKey(ethers.Wallet.createRandom().address)
      ).to.be.revertedWith("LibDiamond: Must be contract owner");
    });

    it("rejects the zero address", async function () {
      await expect(requestKeyFacet.connect(owner).setRequestKey(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyZero");
    });

    it("rejects a key equal to the owner", async function () {
      await expect(requestKeyFacet.connect(owner).setRequestKey(owner.address))
        .to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyEqualsOwner");
    });

    it("rejects an unchanged key", async function () {
      const cur = await requestKeyFacet.getRequestKey();
      await expect(requestKeyFacet.connect(owner).setRequestKey(cur))
        .to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyUnchanged");
    });

    it("rejects a key equal to the signing address", async function () {
      const signer = await payoutFacet.getOpenAdvertsSigningAddress();
      await expect(requestKeyFacet.connect(owner).setRequestKey(signer))
        .to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyEqualsSigner");
    });
  });

  describe("transferOwnership", function () {
    it("the 1-arg IERC173 variant reverts (bypass closed)", async function () {
      await expect(
        ownershipFacet.connect(owner)["transferOwnership(address)"](alice.address)
      ).to.be.revertedWith("Use transferOwnership(address,address)");
    });

    it("the 2-arg variant hands over ownership and rotates the key atomically", async function () {
      const prev = await requestKeyFacet.getRequestKey();
      const newKey = ethers.Wallet.createRandom().address;
      // changedBy is the human caller (owner), threaded through the self-call.
      await expect(
        ownershipFacet.connect(owner)["transferOwnership(address,address)"](alice.address, newKey)
      )
        .to.emit(requestKeyFacet, "RequestKeyUpdated")
        .withArgs(prev, newKey, owner.address);
      expect(await ownershipFacet.owner()).to.equal(alice.address);
      expect(await requestKeyFacet.getRequestKey()).to.equal(newKey);
    });

    it("rejects a new requestKey equal to the new owner", async function () {
      await expect(
        ownershipFacet.connect(owner)["transferOwnership(address,address)"](alice.address, alice.address)
      ).to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyEqualsOwner");
    });

    it("rejects a zero new owner", async function () {
      await expect(
        ownershipFacet
          .connect(owner)
          ["transferOwnership(address,address)"](ethers.ZeroAddress, ethers.Wallet.createRandom().address)
      ).to.be.revertedWith("New owner cannot be zero address");
    });

    it("rejects a non-owner caller", async function () {
      await expect(
        ownershipFacet
          .connect(alice)
          ["transferOwnership(address,address)"](bob.address, ethers.Wallet.createRandom().address)
      ).to.be.revertedWith("LibDiamond: Must be contract owner");
    });
  });

  describe("Governance election rotation", function () {
    async function openRoundAndFund(voter, aboveQuorum) {
      const snap = await queryV2Facet.getGovernanceSnapshot();
      const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei;
      if (aboveQuorum) {
        const totalSupply = await tokenFacet.totalSupply();
        const quorum = (totalSupply * BigInt(snap.currentQuotas.openAdvertsAdminChangeQuorum)) / 100n;
        await tokenFacet.connect(owner).transfer(voter.address, quorum + ethers.parseEther("1000"));
      }
      await mine(15);
      return adminFee;
    }

    async function advancePastDeadline() {
      const snap2 = await queryV2Facet.getGovernanceSnapshot();
      const cur = BigInt(await ethers.provider.getBlockNumber());
      await mine(Number(snap2.adminVoteDeadline - cur) + 1);
    }

    it("activates the winner's requestKey on ratify and replaces the ex-owner's key", async function () {
      const adminFee = await openRoundAndFund(bob, true);
      const before = await requestKeyFacet.getRequestKey();
      const aliceKey = ethers.Wallet.createRandom().address;

      await governanceFacet.connect(alice).applyAsNewAdmin("alice", aliceKey, { value: adminFee });
      await governanceFacet.connect(bob).voteForNewAdmin(alice.address);
      await advancePastDeadline();
      await governanceFacet.ratifyNewAdmin();

      expect(await ownershipFacet.owner()).to.equal(alice.address);
      expect(await requestKeyFacet.getRequestKey()).to.equal(aliceKey);
      expect(await requestKeyFacet.getRequestKey()).to.not.equal(before);
    });

    it("rejects an applicant requestKey equal to the current live key", async function () {
      const snap = await queryV2Facet.getGovernanceSnapshot();
      const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei;
      const cur = await requestKeyFacet.getRequestKey();
      await expect(
        governanceFacet.connect(alice).applyAsNewAdmin("x", cur, { value: adminFee })
      ).to.be.revertedWithCustomError(requestKeyFacet, "RequestKeyUnchanged");
    });

    it("keeps the current requestKey when the incumbent is re-elected", async function () {
      const adminFee = await openRoundAndFund(owner, false); // owner already holds full supply
      const keyBefore = await requestKeyFacet.getRequestKey();

      await governanceFacet.connect(alice).applyAsNewAdmin("alice", ethers.Wallet.createRandom().address, {
        value: adminFee
      });
      await governanceFacet.connect(owner).voteForNewAdmin(owner.address);
      await advancePastDeadline();
      await governanceFacet.ratifyNewAdmin();

      expect(await ownershipFacet.owner()).to.equal(owner.address);
      expect(await requestKeyFacet.getRequestKey()).to.equal(keyBefore);
    });
  });
});
