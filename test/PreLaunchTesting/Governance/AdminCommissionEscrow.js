/* global describe it ethers */

const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture, mine } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../../scripts/deploy.js')

// Exercises the ratifyNewAdmin admin-commission handover:
//  - happy path: outgoing admin is paid directly (AdminUSDCPaid)
//  - failure path: a blacklisted/failing USDC push escrows to pendingAdminUSDC
//    (AdminUSDCEscrowed) and is later recoverable by the outgoing admin via
//    withdrawPendingAdminUSDC — independent of the ownership handover.
describe('ratifyNewAdmin — admin USDC commission escrow (Phase 1B)', function () {
  async function fixture() {
    const [owner, addr1, addr2] = await ethers.getSigners()

    const deployed = await deployDiamond()
    const diamondAddress = deployed.diamond

    const governanceFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress)
    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const ownershipFacet = await ethers.getContractAt('OwnershipFacet', diamondAddress)
    const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
    const queryV2Facet = await ethers.getContractAt('OpenAdvertsQueryV2Facet', diamondAddress)

    const usdcAddress = await advertisersFacet.getUSDCTokenAddress()
    const mockUSDC = await ethers.getContractAt('MockUSDC', usdcAddress)

    return { diamondAddress, governanceFacet, tokenFacet, ownershipFacet, advertisersFacet, queryV2Facet, mockUSDC, owner, addr1, addr2 }
  }

  // Accrue admin commission, run an election that addr1 wins, and return the
  // accrued (available) admin USDC just before ratification.
  async function setUpElectionWithAdminCommission(ctx) {
    const { governanceFacet, tokenFacet, queryV2Facet, mockUSDC, diamondAddress, owner, addr1, addr2 } = ctx

    // Generate admin commission: deposit USDC into the diamond and account it.
    await mockUSDC.connect(owner).mint(diamondAddress, ethers.parseUnits('10000', 6))
    await tokenFacet.processNewUSDCDeposits()

    const infoBefore = await tokenFacet.getAdminUSDCInfo()
    expect(infoBefore.available).to.be.gt(0n)

    // Fund a voter above the admin-change quorum, then run the election.
    const snap = await queryV2Facet.getGovernanceSnapshot()
    const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei
    const totalSupply = await tokenFacet.totalSupply()
    const quorumAmount = (totalSupply * BigInt(snap.currentQuotas.openAdvertsAdminChangeQuorum)) / 100n
    const votingAmount = quorumAmount + ethers.parseEther('1000')

    await tokenFacet.connect(owner).transfer(addr2.address, votingAmount)
    await mine(15) // flash-loan protection window
    await governanceFacet.connect(addr1).applyAsNewAdmin('candidate-1', ethers.Wallet.createRandom().address, { value: adminFee })
    await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)

    const snap2 = await queryV2Facet.getGovernanceSnapshot()
    const currentBlock = BigInt(await ethers.provider.getBlockNumber())
    await mine(Number(snap2.adminVoteDeadline - currentBlock) + 1)

    return infoBefore.available
  }

  it('happy path: pays the outgoing admin directly and leaves no escrow', async function () {
    const ctx = await loadFixture(fixture)
    const { governanceFacet, tokenFacet, ownershipFacet, mockUSDC, owner, addr1 } = ctx

    const available = await setUpElectionWithAdminCommission(ctx)
    const ownerUSDCBefore = await mockUSDC.balanceOf(owner.address)

    await expect(governanceFacet.ratifyNewAdmin())
      .to.emit(tokenFacet, 'AdminUSDCPaid')
      .withArgs(owner.address, available)

    expect(await ownershipFacet.owner()).to.equal(addr1.address)
    expect(await mockUSDC.balanceOf(owner.address)).to.equal(ownerUSDCBefore + available)
    expect(await tokenFacet.getPendingAdminUSDC(owner.address)).to.equal(0n)
    const info = await tokenFacet.getAdminUSDCInfo()
    expect(info.available).to.equal(0n)
  })

  it('failure path: escrows commission when the USDC push fails, and the outgoing admin recovers it', async function () {
    const ctx = await loadFixture(fixture)
    const { governanceFacet, tokenFacet, ownershipFacet, mockUSDC, owner, addr1 } = ctx

    const available = await setUpElectionWithAdminCommission(ctx)

    // Simulate USDC blacklisting the outgoing admin so the push reverts.
    await mockUSDC.setBlacklist(owner.address, true)

    // Ownership still transfers (liveness preserved); commission is escrowed, not lost.
    await expect(governanceFacet.ratifyNewAdmin())
      .to.emit(tokenFacet, 'AdminUSDCEscrowed')
      .withArgs(owner.address, available)

    expect(await ownershipFacet.owner()).to.equal(addr1.address)
    expect(await tokenFacet.getPendingAdminUSDC(owner.address)).to.equal(available)

    // Incoming admin cannot claim the outgoing admin's slice (reserved from the pool).
    const info = await tokenFacet.getAdminUSDCInfo()
    expect(info.available).to.equal(0n)
    await expect(tokenFacet.connect(addr1).withdrawAdminUSDC()).to.be.revertedWith('No admin USDC available')

    // Once un-blacklisted, the outgoing admin pulls the escrowed commission.
    await mockUSDC.setBlacklist(owner.address, false)
    const ownerUSDCBefore = await mockUSDC.balanceOf(owner.address)

    await expect(tokenFacet.connect(owner).withdrawPendingAdminUSDC())
      .to.emit(tokenFacet, 'PendingAdminUSDCWithdrawn')
      .withArgs(owner.address, available)

    expect(await mockUSDC.balanceOf(owner.address)).to.equal(ownerUSDCBefore + available)
    expect(await tokenFacet.getPendingAdminUSDC(owner.address)).to.equal(0n)
  })

  it('withdrawPendingAdminUSDC reverts when there is nothing escrowed', async function () {
    const { tokenFacet, addr2 } = await loadFixture(fixture)
    await expect(tokenFacet.connect(addr2).withdrawPendingAdminUSDC()).to.be.revertedWith('No pending admin USDC')
  })

  it('payoutOutgoingAdminCommission is self-call gated', async function () {
    const { tokenFacet, owner, addr1 } = await loadFixture(fixture)
    await expect(tokenFacet.connect(addr1).payoutOutgoingAdminCommission(owner.address)).to.be.revertedWith('Only diamond')
  })
})
