const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");
const gate = require("../helpers/signatureGate.js");

describe("OpenAdvertsSignatureGateFacet - website-origin gate on createProspectAffiliateContract", function () {
    let diamondAddress;
    let affiliatesFacet;
    let gateFacet;
    let owner, user1;
    let gateSigner;

    before(async function () {
        [owner, user1] = await ethers.getSigners();
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
        gateFacet = await ethers.getContractAt("OpenAdvertsSignatureGateFacet", diamondAddress);
        gateSigner = await gate.installGateSigner(diamondAddress, owner);
    });

    function freshAffiliateArgs() {
        return [
            ethers.Wallet.createRandom().address, // affiliateContract
            ethers.Wallet.createRandom().address, // claimInfo
            ethers.Wallet.createRandom().address, // signingAddress
            `aff-${Math.random().toString(36).slice(2)}`, // storageId
        ];
    }

    it("accepts a valid, signed, unused request", async function () {
        const base = freshAffiliateArgs();
        const g = await gate.affiliate(gateSigner, diamondAddress, user1.address);
        await expect(affiliatesFacet.connect(user1).createProspectAffiliateContract(...base, ...g)).to.not.be.reverted;
        expect(await gateFacet.isUidUsed(g[0])).to.equal(true);
    });

    it("rejects reuse of the same uid (replay)", async function () {
        const uid = ethers.hexlify(ethers.randomBytes(32));
        const g1 = await gate.affiliate(gateSigner, diamondAddress, user1.address, { uid });
        await affiliatesFacet.connect(user1).createProspectAffiliateContract(...freshAffiliateArgs(), ...g1);
        const g2 = await gate.affiliate(gateSigner, diamondAddress, user1.address, { uid });
        await expect(
            affiliatesFacet.connect(user1).createProspectAffiliateContract(...freshAffiliateArgs(), ...g2)
        ).to.be.revertedWith("UID already used");
    });

    it("rejects an expired deadline", async function () {
        const past = (await ethers.provider.getBlock("latest")).timestamp - 1;
        const g = await gate.affiliate(gateSigner, diamondAddress, user1.address, { deadline: past });
        await expect(
            affiliatesFacet.connect(user1).createProspectAffiliateContract(...freshAffiliateArgs(), ...g)
        ).to.be.revertedWith("Signature expired");
    });

    it("rejects a signature from the wrong signer", async function () {
        const wrong = ethers.Wallet.createRandom();
        const g = await gate.affiliate(wrong, diamondAddress, user1.address);
        await expect(
            affiliatesFacet.connect(user1).createProspectAffiliateContract(...freshAffiliateArgs(), ...g)
        ).to.be.revertedWith("Invalid signature");
    });

    it("rejects a signature bound to a different caller", async function () {
        const g = await gate.affiliate(gateSigner, diamondAddress, owner.address); // signed for owner
        await expect(
            affiliatesFacet.connect(user1).createProspectAffiliateContract(...freshAffiliateArgs(), ...g) // called by user1
        ).to.be.revertedWith("Invalid signature");
    });

    it("gate runs before input validation (bad input + valid sig reverts on validation)", async function () {
        const g = await gate.affiliate(gateSigner, diamondAddress, user1.address);
        await expect(
            affiliatesFacet
                .connect(user1)
                .createProspectAffiliateContract(ethers.ZeroAddress, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, "x", ...g)
        ).to.be.revertedWith("Invalid affiliate contract address");
    });

    it("rejects direct external call to verifyAndConsume (not via diamond)", async function () {
        const g = await gate.affiliate(gateSigner, diamondAddress, user1.address);
        await expect(
            gateFacet.connect(user1).verifyAndConsume(gate.ACTION_TAGS.AFFILIATE, g[0], g[1], g[2], user1.address)
        ).to.be.revertedWith("Only diamond");
    });
});
