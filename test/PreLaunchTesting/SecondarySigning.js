const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture, mine } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')
const gate = require('../helpers/signatureGate.js')

/**
 * Secondary-signer block-cutover feature.
 *
 * Model: a single reward/gate signature is verified against EXACTLY ONE expected signer,
 * selected by whether its reference block is >= the cutover block:
 *   - reward path routes on the SIGNED engagement block (blockNumbers[i]);
 *   - gate path has no signed engagement block, so it routes on the EXECUTION block.number.
 * When the secondary is disabled, every signature must recover to the primary (regression).
 *
 * These tests assert the security-critical property: after activation, a signature for a
 * block >= cutover signed by the (now retired / compromised) PRIMARY key is REJECTED, while
 * the SECONDARY key is accepted — and vice-versa for blocks < cutover.
 */
describe('Secondary Signer Cutover', function () {
  // Reward messageHash preimage — must byte-for-byte match _verifySignatures in
  // OpenAdvertsPayoutFacet (block.chainid, diamond, viewer, block, nonce, affiliate,
  // advert, thirdPartyCount, keccak(thirdPartyAddresses), advertBounty) then EIP-191.
  async function buildRewardSig(wallet, ctx, blockNumber, tpAddrs) {
    const tpCount = BigInt(tpAddrs.length)
    const tpHash = ethers.keccak256(ethers.solidityPacked(['address[]'], [tpAddrs]))
    const messageHash = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'uint256'],
      [
        ctx.chainId,
        ctx.diamondAddress,
        ctx.viewer,
        BigInt(blockNumber),
        BigInt(ctx.nonce),
        ctx.affiliate,
        ctx.advertAddr,
        tpCount,
        tpHash,
        ctx.advertBounty,
      ]
    )
    return wallet.signMessage(ethers.getBytes(messageHash))
  }

  // Extracts totalPayout (the authoritative diamond-side accepted amount) from a POL
  // processReward receipt. Equals acceptedSignatures * advertBounty (each accepted sig pays
  // one full bounty, since the claim split sums to 100%).
  function totalPayoutFromReceipt(receipt, polContract) {
    for (const log of receipt.logs) {
      try {
        const parsed = polContract.interface.parseLog(log)
        if (parsed.name === 'PayoutCompleted') return parsed.args.totalPayout
      } catch {
        /* not a POL event */
      }
    }
    throw new Error('PayoutCompleted event not found')
  }

  async function deployFixture() {
    const signers = await ethers.getSigners()
    const [owner, advertiser, affiliate, user, voter1, voter2, voter3, ...rest] = signers

    // Distinct third-party EOAs (thirdPartyCount = 3 per the mock claim provider).
    const [tp1, tp2, tp3, tp4, tp5, tp6, gateAffA, gateAffB, gateAffC] = rest

    // Fresh signing wallets. primaryWallet is the protocol signer; secondaryWallet is the cutover key.
    const primaryWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider)
    const secondaryWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider)

    const deployed = await deployDiamond()
    const diamondAddress = deployed.diamond

    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const affiliatesFacet = await ethers.getContractAt('OpenAdvertsAffiliatesFacet', diamondAddress)
    const affiliateVotingFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet', diamondAddress)
    const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
    const advertVotingFacet = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
    const polFactoryFacet = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet', diamondAddress)
    const payoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress)
    const requestKeyFacet = await ethers.getContractAt('OpenAdvertsRequestKeyFacet', diamondAddress)

    // Pin the protocol signer to the primary wallet (deterministic, env-independent).
    await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(primaryWallet.address)

    const MockClaimProvider = await ethers.getContractFactory(
      'contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider'
    )
    const mockClaimProvider = await MockClaimProvider.deploy()
    await mockClaimProvider.waitForDeployment()
    const mockClaimProviderAddress = await mockClaimProvider.getAddress()

    // Voting stake.
    const voterTokens = ethers.parseEther('5000000')
    await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)

    // Create + approve affiliate (gate signed by the current protocol signer = primary).
    await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
      affiliate.address,
      mockClaimProviderAddress,
      primaryWallet.address,
      'secondary-signing-affiliate',
      ...(await gate.affiliate(primaryWallet, diamondAddress, affiliate.address))
    )
    await mine(15)
    await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true)

    // Create + approve a POL advert with generous budget (>= 2 bounties needed per test).
    const advertBounty = ethers.parseEther('1')
    const fundingAmount = ethers.parseEther('5000')
    const minBlockSeparation = 1

    const createTx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
      'secondary-signing-advert',
      advertBounty,
      minBlockSeparation,
      affiliate.address,
      ...(await gate.pol(primaryWallet, diamondAddress, advertiser.address)),
      { value: fundingAmount }
    )
    const createReceipt = await createTx.wait()
    const createEvent = createReceipt.logs
      .map((log) => {
        try {
          return polFactoryFacet.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((p) => p && p.name === 'POLAdvertisementCreatedAndValidated')
    const advertAddr = createEvent.args.advertContract

    await mine(15)
    await advertVotingFacet.connect(voter1).voteOnAdvert(advertAddr, true)
    await advertVotingFacet.connect(voter2).voteOnAdvert(advertAddr, true)
    await advertVotingFacet.connect(voter3).voteOnAdvert(advertAddr, true)

    const [, advertStatus] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddr)
    expect(advertStatus).to.equal(1, 'Advertisement should be Approved before reward tests')

    const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', advertAddr)
    const chainId = (await ethers.provider.getNetwork()).chainId

    return {
      diamondAddress,
      payoutFacet,
      requestKeyFacet,
      affiliatesFacet,
      polContract,
      advertAddr,
      mockClaimProviderAddress,
      advertBounty,
      chainId,
      owner,
      advertiser,
      affiliate,
      user,
      primaryWallet,
      secondaryWallet,
      gateAffA,
      gateAffB,
      gateAffC,
      tpSetA: [tp1.address, tp2.address, tp3.address],
      tpSetB: [tp4.address, tp5.address, tp6.address],
    }
  }

  // Submits a 2-signature batch (anchor + probe) and returns the accepted-amount (totalPayout).
  // The anchor is always primary + a pre-cutover block, so at least one signature is accepted
  // and processReward never reverts on the all-rejected path; the probe under test decides
  // whether totalPayout is 1x or 2x the bounty.
  async function submitBatch(f, { anchorWallet, anchorBlock, probeWallet, probeBlock }) {
    const nonce = await f.polContract.connect(f.user).getUserNonceOfAffiliate(f.affiliate.address)
    const ctx = {
      chainId: f.chainId,
      diamondAddress: f.diamondAddress,
      viewer: f.user.address,
      nonce: Number(nonce),
      affiliate: f.affiliate.address,
      advertAddr: f.advertAddr,
      advertBounty: f.advertBounty,
    }
    const anchorSig = await buildRewardSig(anchorWallet, ctx, anchorBlock, f.tpSetA)
    const probeSig = await buildRewardSig(probeWallet, ctx, probeBlock, f.tpSetB)

    const verificationData = {
      affiliateReceivingAddress: f.affiliate.address,
      affiliateClaimInfoAddress: f.mockClaimProviderAddress,
      affiliateSigningAddress: f.primaryWallet.address,
      advertismentContractAddress: f.advertAddr,
      nonce: Number(nonce),
      viewerAddress: f.user.address,
    }
    const tx = await f.polContract.connect(f.user).processReward(
      [anchorSig, probeSig],
      [anchorBlock, probeBlock],
      verificationData,
      [{ thirdPartyAddresses: f.tpSetA }, { thirdPartyAddresses: f.tpSetB }]
    )
    const receipt = await tx.wait()
    return totalPayoutFromReceipt(receipt, f.polContract)
  }

  // Recent past blocks with a cutover between the anchor and the post-cutover probe.
  function blockPlan(now) {
    return {
      anchorBlock: now - 4, // < cutover
      cutover: now - 2,
      probePostBlock: now - 1, // >= cutover
      probePreBlock: now - 3, // < cutover (still > anchor)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Setter authorization, validation and views
  // ──────────────────────────────────────────────────────────────────────────
  describe('Setters: authorization, validation and views', function () {
    it('defaults to disabled with cleared fields', async function () {
      const f = await loadFixture(deployFixture)
      const [enabled, secondary, cutover] = await f.payoutFacet.getSecondarySigningInfo()
      expect(enabled).to.equal(false)
      expect(secondary).to.equal(ethers.ZeroAddress)
      expect(cutover).to.equal(0n)
    })

    it('activateSecondarySigning: only owner', async function () {
      const f = await loadFixture(deployFixture)
      await expect(
        f.payoutFacet.connect(f.advertiser).activateSecondarySigning(f.secondaryWallet.address, 123)
      ).to.be.reverted
    })

    it('activateSecondarySigning: rejects zero address, primary, and unset cutover', async function () {
      const f = await loadFixture(deployFixture)
      await expect(
        f.payoutFacet.connect(f.owner).activateSecondarySigning(ethers.ZeroAddress, 123)
      ).to.be.revertedWith('Zero address')
      await expect(
        f.payoutFacet.connect(f.owner).activateSecondarySigning(f.primaryWallet.address, 123)
      ).to.be.revertedWith('Secondary == primary')
      await expect(
        f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 0)
      ).to.be.revertedWith('Cutover not set')
    })

    it('activateSecondarySigning: sets state and emits event', async function () {
      const f = await loadFixture(deployFixture)
      await expect(f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 4242))
        .to.emit(f.payoutFacet, 'SecondarySigningActivated')
        .withArgs(f.secondaryWallet.address, 4242, f.owner.address)
      const [enabled, secondary, cutover] = await f.payoutFacet.getSecondarySigningInfo()
      expect(enabled).to.equal(true)
      expect(secondary).to.equal(f.secondaryWallet.address)
      expect(cutover).to.equal(4242n)
    })

    it('deactivateSecondarySigning: only owner, clears state and emits event', async function () {
      const f = await loadFixture(deployFixture)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 4242)
      await expect(f.payoutFacet.connect(f.advertiser).deactivateSecondarySigning()).to.be.reverted
      await expect(f.payoutFacet.connect(f.owner).deactivateSecondarySigning())
        .to.emit(f.payoutFacet, 'SecondarySigningDeactivated')
        .withArgs(f.owner.address)
      const [enabled, secondary, cutover] = await f.payoutFacet.getSecondarySigningInfo()
      expect(enabled).to.equal(false)
      expect(secondary).to.equal(ethers.ZeroAddress)
      expect(cutover).to.equal(0n)
    })

    it('promoteSecondaryToPrimary: only owner', async function () {
      const f = await loadFixture(deployFixture)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 4242)
      await expect(f.payoutFacet.connect(f.advertiser).promoteSecondaryToPrimary()).to.be.reverted
    })

    it('promoteSecondaryToPrimary: reverts when no secondary set', async function () {
      const f = await loadFixture(deployFixture)
      await expect(f.payoutFacet.connect(f.owner).promoteSecondaryToPrimary()).to.be.revertedWith('No secondary set')
    })

    it('promoteSecondaryToPrimary: moves secondary to primary, clears state, emits both events', async function () {
      const f = await loadFixture(deployFixture)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 4242)
      await expect(f.payoutFacet.connect(f.owner).promoteSecondaryToPrimary())
        .to.emit(f.payoutFacet, 'SigningAddressUpdated')
        .withArgs(f.primaryWallet.address, f.secondaryWallet.address, f.owner.address)
        .and.to.emit(f.payoutFacet, 'SecondarySigningDeactivated')
        .withArgs(f.owner.address)
      expect(await f.payoutFacet.getOpenAdvertsSigningAddress()).to.equal(f.secondaryWallet.address)
      const [enabled, secondary, cutover] = await f.payoutFacet.getSecondarySigningInfo()
      expect(enabled).to.equal(false)
      expect(secondary).to.equal(ethers.ZeroAddress)
      expect(cutover).to.equal(0n)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Reward path — routing on the SIGNED engagement block
  // ──────────────────────────────────────────────────────────────────────────
  describe('Reward path: block-partitioned signer routing', function () {
    it('disabled: primary accepted, secondary rejected (regression)', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      const p = blockPlan(now)
      const total = await submitBatch(f, {
        anchorWallet: f.primaryWallet,
        anchorBlock: p.anchorBlock,
        probeWallet: f.secondaryWallet, // secondary key, but feature disabled → rejected
        probeBlock: p.probePostBlock,
      })
      expect(total).to.equal(f.advertBounty) // only the primary anchor paid out
    })

    it('enabled: primary accepted pre-cutover AND secondary accepted post-cutover', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      const p = blockPlan(now)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, p.cutover)
      const total = await submitBatch(f, {
        anchorWallet: f.primaryWallet, // < cutover → primary expected
        anchorBlock: p.anchorBlock,
        probeWallet: f.secondaryWallet, // >= cutover → secondary expected
        probeBlock: p.probePostBlock,
      })
      expect(total).to.equal(f.advertBounty * 2n) // both accepted
    })

    it('enabled: retired PRIMARY key is REJECTED for blocks >= cutover (compromise containment)', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      const p = blockPlan(now)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, p.cutover)
      const total = await submitBatch(f, {
        anchorWallet: f.primaryWallet, // < cutover → still valid
        anchorBlock: p.anchorBlock,
        probeWallet: f.primaryWallet, // >= cutover, primary → REJECTED
        probeBlock: p.probePostBlock,
      })
      expect(total).to.equal(f.advertBounty) // only the pre-cutover anchor paid out
    })

    it('enabled: SECONDARY key is REJECTED for blocks < cutover', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      const p = blockPlan(now)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, p.cutover)
      const total = await submitBatch(f, {
        anchorWallet: f.primaryWallet, // < cutover → primary expected, accepted
        anchorBlock: p.anchorBlock,
        probeWallet: f.secondaryWallet, // < cutover, secondary → REJECTED
        probeBlock: p.probePreBlock,
      })
      expect(total).to.equal(f.advertBounty) // only the primary anchor paid out
    })

    it('after promote: former secondary key is now the sole primary and validates all blocks', async function () {
      const f = await loadFixture(deployFixture)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 1)
      await f.payoutFacet.connect(f.owner).promoteSecondaryToPrimary()
      const now = await ethers.provider.getBlockNumber()
      const p = blockPlan(now)
      // Secondary is disabled after promote; the former secondary wallet is the new primary,
      // so it must validate both blocks and the old primary must be rejected.
      const total = await submitBatch(f, {
        anchorWallet: f.secondaryWallet, // new primary
        anchorBlock: p.anchorBlock,
        probeWallet: f.primaryWallet, // old primary → no longer valid
        probeBlock: p.probePostBlock,
      })
      expect(total).to.equal(f.advertBounty) // only the new-primary anchor paid out
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Gate path — routing on the EXECUTION block.number
  // ──────────────────────────────────────────────────────────────────────────
  describe('Gate path: execution-block signer routing on prospect creation', function () {
    async function createAffiliateWith(f, signerWallet, affiliateSigner) {
      return f.affiliatesFacet
        .connect(affiliateSigner)
        .createProspectAffiliateContract(
          affiliateSigner.address,
          f.mockClaimProviderAddress,
          ethers.Wallet.createRandom().address, // unique per-affiliate signing address (registry requires uniqueness)
          'gate-partition-affiliate',
          ...(await gate.affiliate(signerWallet, f.diamondAddress, affiliateSigner.address))
        )
    }

    it('disabled: primary-signed gate is accepted', async function () {
      const f = await loadFixture(deployFixture)
      await expect(createAffiliateWith(f, f.primaryWallet, f.gateAffA)).to.not.be.reverted
    })

    it('enabled (cutover in the past): secondary-signed gate accepted, primary-signed rejected', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, now) // cutover <= exec block
      await expect(createAffiliateWith(f, f.secondaryWallet, f.gateAffB)).to.not.be.reverted
      await expect(createAffiliateWith(f, f.primaryWallet, f.gateAffC)).to.be.revertedWith('Invalid signature')
    })

    it('enabled (cutover in the future): primary-signed gate still accepted', async function () {
      const f = await loadFixture(deployFixture)
      const now = await ethers.provider.getBlockNumber()
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, now + 1_000_000)
      await expect(createAffiliateWith(f, f.primaryWallet, f.gateAffA)).to.not.be.reverted
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // RequestKey must not collide with the secondary signer
  // ──────────────────────────────────────────────────────────────────────────
  describe('RequestKey collision with secondary signer', function () {
    it('setRequestKey rejects the secondary signing address', async function () {
      const f = await loadFixture(deployFixture)
      await f.payoutFacet.connect(f.owner).activateSecondarySigning(f.secondaryWallet.address, 4242)
      await expect(
        f.requestKeyFacet.connect(f.owner).setRequestKey(f.secondaryWallet.address)
      ).to.be.revertedWithCustomError(f.requestKeyFacet, 'RequestKeyEqualsSecondarySigner')
    })
  })
})
