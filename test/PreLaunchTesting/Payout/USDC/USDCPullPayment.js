// Phase 1B: USDC pull-payment pattern tests.
// Verifies that a blacklisted / hostile token recipient cannot DoS the payout batch,
// that the failed share is escrowed in pendingWithdrawals, and that the recipient
// can claim it via withdrawPendingPayout() once unblocked.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const gate = require("../../../helpers/signatureGate.js");

const { deployDiamond } = require("../../../../scripts/deploy.js");

async function advanceBlocksForVoting(blocks = 15) {
    await mine(blocks);
}

describe("Phase 1B — USDC pull-payment pattern", function () {
    async function fixture() {
        const signers = await ethers.getSigners();
        const [owner, advertiser, affiliate, user, voter1, voter2, voter3, ...rest] = signers;

        const PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
        const signingAddress = new ethers.Wallet(PRIVATE_KEY, ethers.provider);

        const deployed = await deployDiamond();
        const diamondAddress = deployed.diamond;

        const tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
        const affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
        const affiliateVotingFacet = await ethers.getContractAt("OpenAdvertsAffiliatesVotingFacet", diamondAddress);
        const advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        const advertVotingFacet = await ethers.getContractAt("OpenAdvertsAdvertisersVotingFacet", diamondAddress);
        const usdcFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", diamondAddress);
        const payoutFacet = await ethers.getContractAt("OpenAdvertsPayoutFacet", diamondAddress);

        await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress.address);

        const usdcAddress = await advertisersFacet.getUSDCTokenAddress();
        const mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);

        // Fund advertiser with USDC for advert creation.
        const advertiserMintAmount = ethers.parseUnits("10000", 6);
        await mockUSDC.connect(owner).mint(advertiser.address, advertiserMintAmount);

        const MockClaim = await ethers.getContractFactory(
            "contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider"
        );
        const mockClaim = await MockClaim.deploy();
        await mockClaim.waitForDeployment();
        const mockClaimAddress = await mockClaim.getAddress();

        // Voter setup.
        const voterTokens = ethers.parseEther("5000000");
        await tokenFacet.connect(owner).transfer(voter1.address, voterTokens);
        await tokenFacet.connect(owner).transfer(voter2.address, voterTokens);
        await tokenFacet.connect(owner).transfer(voter3.address, voterTokens);

        // Approve affiliate.
        await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
            affiliate.address,
            mockClaimAddress,
            signingAddress.address,
            "phase1b-usdc-affiliate",
            ...(await gate.affiliate(signingAddress, diamondAddress, affiliate.address)));
        await advanceBlocksForVoting(15);
        await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true);
        await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true);
        await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true);

        // Create USDC advert.
        const advertBounty = ethers.parseUnits("1", 6); // 1 USDC / signature
        const fundingAmount = ethers.parseUnits("500", 6);
        const minBlockSeparation = 1;

        await mockUSDC.connect(advertiser).approve(diamondAddress, fundingAmount);

        const tx = await usdcFactoryFacet.connect(advertiser).createNewProspectUSDCAdvertContract(
            "phase1b-usdc-advert",
            advertBounty,
            minBlockSeparation,
            affiliate.address,
            fundingAmount,
            ...(await gate.usdc(signingAddress, diamondAddress, advertiser.address)));
        const rc = await tx.wait();
        const createEvt = rc.logs.find((l) => {
            try { return usdcFactoryFacet.interface.parseLog(l).name === "USDCAdvertCreated"; } catch { return false; }
        });
        const usdcAdvertAddress = usdcFactoryFacet.interface.parseLog(createEvt).args.advert;

        await advanceBlocksForVoting(15);
        await advertVotingFacet.connect(voter1).voteOnAdvert(usdcAdvertAddress, true);
        await advertVotingFacet.connect(voter2).voteOnAdvert(usdcAdvertAddress, true);
        await advertVotingFacet.connect(voter3).voteOnAdvert(usdcAdvertAddress, true);

        const usdcContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", usdcAdvertAddress);

        // The blacklisted recipient — MockUSDC will revert any transfer to this address.
        const blacklisted = rest[0];
        await mockUSDC.setBlacklist(blacklisted.address, true);

        // 2 signatures, 3 third parties each. Signature 0 routes TP1 → blacklisted.
        const thirdPartySets = [
            { thirdPartyAddresses: [blacklisted.address, rest[1].address, rest[2].address] },
            { thirdPartyAddresses: [rest[3].address, rest[4].address, rest[5].address] },
        ];

        const currentNonce = await usdcContract.connect(user).getUserNonceOfAffiliate(affiliate.address);
        const verificationData = {
            affiliateReceivingAddress: affiliate.address,
            affiliateClaimInfoAddress: mockClaimAddress,
            affiliateSigningAddress: signingAddress.address,
            advertismentContractAddress: usdcAdvertAddress,
            nonce: Number(currentNonce),
            viewerAddress: user.address,
        };

        const signatures = [];
        const blockNumbers = [];
        const baseBlock = await ethers.provider.getBlockNumber();
        const wallet = new ethers.Wallet(signingAddress.privateKey);

        for (let i = 0; i < 2; i++) {
            const blockNumber = baseBlock + i * 2;
            blockNumbers.push(blockNumber);
            const tpAddrs = thirdPartySets[i].thirdPartyAddresses;
            const tpHash = ethers.keccak256(ethers.solidityPacked(["address[]"], [tpAddrs]));
            const msgHash = ethers.solidityPackedKeccak256(
                ["address", "uint256", "uint256", "address", "address", "uint256", "bytes32", "uint256"],
                [
                    user.address,
                    BigInt(blockNumber),
                    BigInt(verificationData.nonce),
                    verificationData.affiliateReceivingAddress,
                    usdcAdvertAddress,
                    BigInt(tpAddrs.length),
                    tpHash,
                    advertBounty,
                ]
            );
            signatures.push(await wallet.signMessage(ethers.getBytes(msgHash)));
        }

        const highest = blockNumbers[blockNumbers.length - 1];
        const latest = await ethers.provider.getBlockNumber();
        if (latest < highest) await mine(highest - latest);

        return {
            usdcContract,
            usdcAdvertAddress,
            mockUSDC,
            blacklisted,
            thirdPartySets,
            signatures,
            blockNumbers,
            verificationData,
            advertBounty,
            user,
            rest,
        };
    }

    it("processes payouts to good recipients and escrows the blacklisted share", async function () {
        const {
            usdcContract, mockUSDC, blacklisted, thirdPartySets, signatures,
            blockNumbers, verificationData, advertBounty, user, rest,
        } = await loadFixture(fixture);

        const blBalBefore = await mockUSDC.balanceOf(blacklisted.address);
        const goodTPBefore = await mockUSDC.balanceOf(rest[1].address);

        await expect(
            usdcContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets)
        ).to.emit(usdcContract, "PayoutPending");

        expect(await mockUSDC.balanceOf(blacklisted.address)).to.equal(blBalBefore);

        const pending = await usdcContract.pendingWithdrawals(blacklisted.address);
        expect(pending).to.equal((advertBounty * 6n) / 100n);
        expect(await usdcContract.totalPendingWithdrawals()).to.equal(pending);

        const goodTPAfter = await mockUSDC.balanceOf(rest[1].address);
        expect(goodTPAfter - goodTPBefore).to.equal((advertBounty * 6n) / 100n);
    });

    it("lets the recipient pull the escrow once unblacklisted", async function () {
        const {
            usdcContract, mockUSDC, blacklisted, thirdPartySets, signatures,
            blockNumbers, verificationData, advertBounty, user,
        } = await loadFixture(fixture);

        await usdcContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const pending = await usdcContract.pendingWithdrawals(blacklisted.address);
        expect(pending).to.equal((advertBounty * 6n) / 100n);

        await mockUSDC.setBlacklist(blacklisted.address, false);

        const balBefore = await mockUSDC.balanceOf(blacklisted.address);
        await usdcContract.connect(blacklisted).withdrawPendingPayout();
        const balAfter = await mockUSDC.balanceOf(blacklisted.address);

        expect(balAfter - balBefore).to.equal(pending);
        expect(await usdcContract.pendingWithdrawals(blacklisted.address)).to.equal(0);
        expect(await usdcContract.totalPendingWithdrawals()).to.equal(0);
    });

    it("withdrawPendingPayout reverts when there is nothing to claim", async function () {
        const { usdcContract, user } = await loadFixture(fixture);
        await expect(usdcContract.connect(user).withdrawPendingPayout()).to.be.revertedWith("No pending payout");
    });

    it("withdrawPendingPayout reverts (and leaves escrow intact) while still blacklisted", async function () {
        const {
            usdcContract, mockUSDC, blacklisted, thirdPartySets, signatures,
            blockNumbers, verificationData, user,
        } = await loadFixture(fixture);

        await usdcContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const pending = await usdcContract.pendingWithdrawals(blacklisted.address);
        expect(pending).to.be.gt(0);

        // Still blacklisted → safeTransfer reverts, so withdrawPendingPayout also reverts,
        // leaving the escrow intact for a future retry.
        await expect(usdcContract.connect(blacklisted).withdrawPendingPayout()).to.be.reverted;

        expect(await usdcContract.pendingWithdrawals(blacklisted.address)).to.equal(pending);
        expect(await usdcContract.totalPendingWithdrawals()).to.equal(pending);
    });

    it("excludes escrowed funds from advertiser sweepable balance", async function () {
        const {
            usdcContract, usdcAdvertAddress, mockUSDC, thirdPartySets, signatures,
            blockNumbers, verificationData, user, advertBounty,
        } = await loadFixture(fixture);

        const rawBefore = await mockUSDC.balanceOf(usdcAdvertAddress);
        await usdcContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const rawAfter = await mockUSDC.balanceOf(usdcAdvertAddress);

        const totalPending = await usdcContract.totalPendingWithdrawals();
        expect(totalPending).to.equal((advertBounty * 6n) / 100n);

        const paidOut = rawBefore - rawAfter;
        const expectedPaid = advertBounty * 2n - totalPending;
        expect(paidOut).to.equal(expectedPaid);
    });

    it("emits a PayoutManifest with index-aligned (recipient, amount) allocations, incl. the escrowed blacklisted recipient, and flags it via PayoutPending", async function () {
        const {
            usdcContract, blacklisted, thirdPartySets, signatures,
            blockNumbers, verificationData, advertBounty, user, rest,
        } = await loadFixture(fixture);

        const tx = await usdcContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const receipt = await tx.wait();

        const parse = (name) =>
            receipt.logs
                .map((l) => { try { return usdcContract.interface.parseLog(l); } catch { return null; } })
                .filter((p) => p && p.name === name);

        // Exactly one manifest, with equal-length, index-aligned arrays.
        const manifests = parse("PayoutManifest");
        expect(manifests.length).to.equal(1);
        const { recipients, amounts } = manifests[0].args;
        expect(recipients.length).to.equal(amounts.length);

        // Build the index-aligned ledger: recipients[i] -> amounts[i].
        const ledger = {};
        for (let i = 0; i < recipients.length; i++) ledger[recipients[i].toLowerCase()] = amounts[i];
        const amountOf = (addr) => ledger[addr.toLowerCase()];

        const tpShare = (advertBounty * 6n) / 100n;      // affiliate + each third party = 6% (MockClaim: 6/76/[6,6,6])
        const viewerShare = (advertBounty * 76n) / 100n; // viewer = 76%
        expect(amountOf(rest[1].address)).to.equal(tpShare);          // good TP in signature 0
        expect(amountOf(rest[5].address)).to.equal(tpShare);          // good TP in signature 1
        expect(amountOf(user.address)).to.equal(viewerShare * 2n);    // viewer: 76% aggregated over 2 signatures
        expect(amountOf(verificationData.affiliateReceivingAddress)).to.equal(tpShare * 2n); // affiliate

        // The blacklisted recipient IS present in the manifest (it is an allocation),
        // and is additionally flagged as escrowed via PayoutPending.
        expect(amountOf(blacklisted.address)).to.equal(tpShare);
        const payoutPending = parse("PayoutPending").map((p) => ({ recipient: p.args.recipient, amount: p.args.amount }));
        const pendingForBlacklisted = payoutPending.find((e) => e.recipient.toLowerCase() === blacklisted.address.toLowerCase());
        expect(pendingForBlacklisted, "blacklisted recipient must be escrowed via PayoutPending").to.not.equal(undefined);
        expect(pendingForBlacklisted.amount).to.equal(tpShare);

        // Recipients are deduplicated: no address appears twice in the manifest.
        const unique = new Set(recipients.map((a) => a.toLowerCase()));
        expect(unique.size).to.equal(recipients.length);

        // Manifest total equals the total transferred (pushed + escrowed) reported by USDCTransfersCompleted.
        const manifestSum = amounts.reduce((s, a) => s + a, 0n);
        const transfersCompleted = parse("USDCTransfersCompleted")[0];
        expect(manifestSum).to.equal(transfersCompleted.args.totalTransferred);
    });
});
