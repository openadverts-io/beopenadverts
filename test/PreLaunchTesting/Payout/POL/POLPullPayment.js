// Phase 1B: POL pull-payment pattern tests.
// Verifies that a single hostile/reverting recipient cannot DoS the payout batch,
// that the failed share is escrowed in pendingWithdrawals, and that the recipient
// can later claim it via withdrawPendingPayout().

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const gate = require("../../../helpers/signatureGate.js");

const { deployDiamond } = require("../../../../scripts/deploy.js");

async function advanceBlocksForVoting(blocks = 15) {
    await mine(blocks);
}

describe("Phase 1B — POL pull-payment pattern", function () {
    async function fixture() {
        const signers = await ethers.getSigners();
        const [owner, advertiser, affiliate, user, voter1, voter2, voter3, ...rest] = signers;

        // Top up owner so the pre-funded amount can always support large transfers.
        for (let i = 0; i < 5; i++) {
            await rest[40 + i].sendTransaction({ to: owner.address, value: ethers.parseEther("1000") });
        }

        const PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
        const signingAddress = new ethers.Wallet(PRIVATE_KEY, ethers.provider);

        const deployed = await deployDiamond();
        const diamondAddress = deployed.diamond;

        const governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", diamondAddress);
        const tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", diamondAddress);
        const affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", diamondAddress);
        const affiliateVotingFacet = await ethers.getContractAt("OpenAdvertsAffiliatesVotingFacet", diamondAddress);
        const advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        const advertVotingFacet = await ethers.getContractAt("OpenAdvertsAdvertisersVotingFacet", diamondAddress);
        const polFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", diamondAddress);
        const payoutFacet = await ethers.getContractAt("OpenAdvertsPayoutFacet", diamondAddress);

        await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress.address);

        const MockClaim = await ethers.getContractFactory("contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider");
        const mockClaim = await MockClaim.deploy();
        await mockClaim.waitForDeployment();
        const mockClaimAddress = await mockClaim.getAddress();

        // Deploy the reverting recipient that simulates a hostile / broken third-party wallet.
        const Reverter = await ethers.getContractFactory("RevertingReceiver");
        const reverter = await Reverter.deploy();
        await reverter.waitForDeployment();
        const reverterAddress = await reverter.getAddress();

        // Voting token distribution.
        const voterTokens = ethers.parseEther("5000000");
        await tokenFacet.connect(owner).transfer(voter1.address, voterTokens);
        await tokenFacet.connect(owner).transfer(voter2.address, voterTokens);
        await tokenFacet.connect(owner).transfer(voter3.address, voterTokens);

        // Approve affiliate.
        await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
            affiliate.address,
            mockClaimAddress,
            signingAddress.address,
            "phase1b-pol-affiliate",
            ...(await gate.affiliate(signingAddress, diamondAddress, affiliate.address)));
        await advanceBlocksForVoting(15);
        await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true);
        await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true);
        await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true);

        // Create POL advert.
        const advertBounty = ethers.parseEther("1");
        const fundingAmount = ethers.parseEther("500");
        const minBlockSeparation = 1;

        const tx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
            "phase1b-pol-advert",
            advertBounty,
            minBlockSeparation,
            affiliate.address,
            ...(await gate.pol(signingAddress, diamondAddress, advertiser.address)),
            { value: fundingAmount }
        );
        const rc = await tx.wait();
        const createEvt = rc.logs.find((l) => {
            try { return polFactoryFacet.interface.parseLog(l).name === "POLAdvertisementCreatedAndValidated"; } catch { return false; }
        });
        const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvt).args.advertContract;

        await advanceBlocksForVoting(15);
        await advertVotingFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true);
        await advertVotingFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true);
        await advertVotingFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true);

        const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvertAddress);

        // Signature set: 2 signatures. Signature 0 routes its 20% TP1 share to the reverting contract.
        const thirdPartySets = [
            { thirdPartyAddresses: [reverterAddress, rest[0].address, rest[1].address] },
            { thirdPartyAddresses: [rest[2].address, rest[3].address, rest[4].address] },
        ];

        const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(affiliate.address);
        const verificationData = {
            affiliateReceivingAddress: affiliate.address,
            affiliateClaimInfoAddress: mockClaimAddress,
            affiliateSigningAddress: signingAddress.address,
            advertismentContractAddress: polAdvertAddress,
            nonce: Number(currentNonce),
            viewerAddress: user.address,
        };

        const signatures = [];
        const blockNumbers = [];
        const baseBlock = await ethers.provider.getBlockNumber();
        const chainId = (await ethers.provider.getNetwork()).chainId;
        const wallet = new ethers.Wallet(signingAddress.privateKey);

        for (let i = 0; i < 2; i++) {
            const blockNumber = baseBlock + i * 2;
            blockNumbers.push(blockNumber);
            const tpAddrs = thirdPartySets[i].thirdPartyAddresses;
            const tpHash = ethers.keccak256(ethers.solidityPacked(["address[]"], [tpAddrs]));
            const msgHash = ethers.solidityPackedKeccak256(
                ["uint256", "address", "address", "uint256", "uint256", "address", "address", "uint256", "bytes32", "uint256"],
                [
                    chainId,
                    diamondAddress,
                    user.address,
                    BigInt(blockNumber),
                    BigInt(verificationData.nonce),
                    verificationData.affiliateReceivingAddress,
                    polAdvertAddress,
                    BigInt(tpAddrs.length),
                    tpHash,
                    advertBounty,
                ]
            );
            signatures.push(await wallet.signMessage(ethers.getBytes(msgHash)));
        }

        // Make sure signed blocks are reached.
        const highest = blockNumbers[blockNumbers.length - 1];
        const latest = await ethers.provider.getBlockNumber();
        if (latest < highest) await mine(highest - latest);

        return {
            polContract,
            polAdvertAddress,
            reverter,
            reverterAddress,
            thirdPartySets,
            signatures,
            blockNumbers,
            verificationData,
            advertBounty,
            user,
            affiliate,
            rest,
        };
    }

    it("processes payouts to good recipients and escrows the reverting share", async function () {
        const { polContract, reverterAddress, thirdPartySets, signatures, blockNumbers, verificationData, advertBounty, user, rest } =
            await loadFixture(fixture);

        const reverterBalBefore = await ethers.provider.getBalance(reverterAddress);
        const goodTPBefore = await ethers.provider.getBalance(rest[0].address);

        await expect(
            polContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets)
        ).to.emit(polContract, "PayoutPending");

        // Reverter should still have zero balance AND non-zero pendingWithdrawals.
        const reverterBalAfter = await ethers.provider.getBalance(reverterAddress);
        expect(reverterBalAfter).to.equal(reverterBalBefore);

        const pending = await polContract.pendingWithdrawals(reverterAddress);
        expect(pending).to.be.gt(0);
        expect(await polContract.totalPendingWithdrawals()).to.equal(pending);

        // 6% of advertBounty should have been escrowed for the reverter.
        expect(pending).to.equal((advertBounty * 6n) / 100n);

        // Good third party in the SAME signature set was paid normally.
        const goodTPAfter = await ethers.provider.getBalance(rest[0].address);
        expect(goodTPAfter - goodTPBefore).to.equal((advertBounty * 6n) / 100n);
    });

    it("lets the failed recipient pull its escrow once it stops reverting", async function () {
        const { polContract, reverter, reverterAddress, thirdPartySets, signatures, blockNumbers, verificationData, advertBounty, user } =
            await loadFixture(fixture);

        await polContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);

        const pending = await polContract.pendingWithdrawals(reverterAddress);
        expect(pending).to.equal((advertBounty * 6n) / 100n);

        // Turn off the reverter's rejection, then pull the escrow.
        await reverter.setActive(false);

        const polContractAddress = await polContract.getAddress();
        const polContractIface = polContract.interface;

        const balBefore = await ethers.provider.getBalance(reverterAddress);

        // Drive withdrawPendingPayout from the reverter contract's address.
        const callData = polContractIface.encodeFunctionData("withdrawPendingPayout");
        await reverter.call(polContractAddress, callData);

        const balAfter = await ethers.provider.getBalance(reverterAddress);
        expect(balAfter - balBefore).to.equal(pending);

        expect(await polContract.pendingWithdrawals(reverterAddress)).to.equal(0);
        expect(await polContract.totalPendingWithdrawals()).to.equal(0);
    });

    it("withdrawPendingPayout reverts when there is nothing to claim", async function () {
        const { polContract, user } = await loadFixture(fixture);
        await expect(polContract.connect(user).withdrawPendingPayout()).to.be.revertedWith("No pending payout");
    });

    it("excludes escrowed funds from advertiser sweepable balance", async function () {
        const { polContract, polAdvertAddress, signatures, blockNumbers, verificationData, thirdPartySets, user, advertBounty } =
            await loadFixture(fixture);

        const balanceRawBefore = await ethers.provider.getBalance(polAdvertAddress);
        await polContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const balanceRawAfter = await ethers.provider.getBalance(polAdvertAddress);

        const totalPending = await polContract.totalPendingWithdrawals();
        expect(totalPending).to.equal((advertBounty * 6n) / 100n);

        // Raw balance drop equals (bounty*2 - escrowedShare) — the escrowed portion stays in the contract.
        const paidOut = balanceRawBefore - balanceRawAfter;
        const expectedPaid = advertBounty * 2n - totalPending;
        expect(paidOut).to.equal(expectedPaid);
    });

    it("emits a PayoutManifest with index-aligned (recipient, amount) allocations, incl. the escrowed reverter, and flags it via PayoutPending", async function () {
        const { polContract, reverterAddress, thirdPartySets, signatures, blockNumbers, verificationData, advertBounty, user, affiliate, rest } =
            await loadFixture(fixture);

        const tx = await polContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets);
        const receipt = await tx.wait();

        const parse = (name) =>
            receipt.logs
                .map((l) => { try { return polContract.interface.parseLog(l); } catch { return null; } })
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
        expect(amountOf(rest[0].address)).to.equal(tpShare);          // good TP in signature 0
        expect(amountOf(rest[4].address)).to.equal(tpShare);          // good TP in signature 1
        expect(amountOf(user.address)).to.equal(viewerShare * 2n);    // viewer: 76% aggregated over 2 signatures
        expect(amountOf(affiliate.address)).to.equal(tpShare * 2n);   // affiliate: 6% aggregated over 2 signatures

        // The reverting recipient IS present in the manifest (it is an allocation),
        // and is additionally flagged as escrowed via PayoutPending.
        expect(amountOf(reverterAddress)).to.equal(tpShare);
        const payoutPending = parse("PayoutPending").map((p) => ({ recipient: p.args.recipient, amount: p.args.amount }));
        const pendingForReverter = payoutPending.find((e) => e.recipient.toLowerCase() === reverterAddress.toLowerCase());
        expect(pendingForReverter, "reverter must be escrowed via PayoutPending").to.not.equal(undefined);
        expect(pendingForReverter.amount).to.equal(tpShare);

        // Recipients are deduplicated: no address appears twice in the manifest.
        const unique = new Set(recipients.map((a) => a.toLowerCase()));
        expect(unique.size).to.equal(recipients.length);

        // Manifest total equals the total transferred (pushed + escrowed) reported by POLTransfersCompleted.
        const manifestSum = amounts.reduce((s, a) => s + a, 0n);
        const transfersCompleted = parse("POLTransfersCompleted")[0];
        expect(manifestSum).to.equal(transfersCompleted.args.totalTransferred);
    });
});
