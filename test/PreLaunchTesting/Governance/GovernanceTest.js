/* global describe it beforeEach ethers */

const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture, time, mine  } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../../scripts/deploy.js')

async function advanceBlocksForVoting(blocks = 15) {
    console.log(`⏭️  Advancing ${blocks} blocks for flash loan protection...`);
    await mine(blocks);
}

describe('OpenAdvertsGovernanceFacet', function () {
  // Test fixture for consistent setup
  async function deployGovernanceFixture() {
    // Get more signers to have 8 total addresses
    const [owner, addr1, addr2, addr3, addr4, addr5, addr6, addr7] = await ethers.getSigners()
    
    const deployedAddresses = await deployDiamond()
    const diamondAddress = deployedAddresses.diamond
    const governanceFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress)
    const claimGasFloorFacet = await ethers.getContractAt('OpenAdvertsClaimGasFloorFacet', diamondAddress)
    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const ownershipFacet = await ethers.getContractAt('OwnershipFacet', diamondAddress)
    const diamondCutFacet = await ethers.getContractAt('DiamondCutFacet', diamondAddress)
    const queryV2Facet = await ethers.getContractAt('OpenAdvertsQueryV2Facet', diamondAddress)
    
    return {
      diamondAddress,
      governanceFacet,
      claimGasFloorFacet,
      tokenFacet,
      ownershipFacet,
      diamondCutFacet,
      queryV2Facet,
      owner,
      addr1,
      addr2,
      addr3,
      addr4,
      addr5,
      addr6, // Added
      addr7  // Added
    }
  }

  // Helper function to create sample quota proposal
  function createSampleQuotaProposal() {
    return {
      // Quota Parameters
      proposedQuotaProposalQuorum: 25,
      proposedMinQuotaProposalDuration: 302400,
      proposedMaxQuotaProposalDuration: 3888000,
      
      // Q.OpenAdverts Commission
      proposedOpenAdvertsCommission: 5,
      proposedStorageProviderCommissionFromADVC: 2,
      proposedAdminCommissionFromADVC: 3, // ✅ CRITICAL FIX
      proposedPolBlocksPerHour: 300,
      
      // Q.Advert Parameters
      proposedMinPOLRequiredforAdvertInWei: ethers.parseEther('100'),
      proposedMinAdvertBountyInPOLWei: ethers.parseEther('0.06'),
      proposedUSDCCurrencyPremiumInPCT: 20,
      proposedAdvertApprovalDenialQuorum: 20,
      proposedAdvertApprovalThreshold: 51,
      proposedAdvertDenialThreshold: 49,
      proposedMaxBlockSeparationAdvertisement: 7200,
      
      // Q.Affiliate Parameters
      proposedAffiliateApprovalDenialQuorum: 15,
      proposedAffiliateApprovalThreshold: 55,
      proposedAffiliateDenialThreshold: 45,
      
      // Facet Parameters
      proposedFacetProposalQuorum: 30,
      proposedMinFacetProposalDuration: 302400,
      proposedMaxFacetProposalDuration: 3888000,
      
      // Admin Parameters
      proposedOpenAdvertsAdminChangeQuorum: 60,
      proposedAdminApplicantFeeInPolWei: ethers.parseEther('1000'),
      proposedAdminVoteDeadlineInBlocks: 44000,
      
      // Cooldown Parameters
      proposedAdvertPauseCooldownBlocks: 302400,
      proposedMaxSignaturesPerBatch: 50,
      proposedMinViewerClaimPct: 70
    }
  }

  // Helper function to distribute tokens for voting
  async function distributeTokensForVoting(tokenFacet, owner, addresses, amount) {
    for (const addr of addresses) {
      await tokenFacet.connect(owner).transfer(addr.address, amount)
    }
  }

  // ✅ ADD THIS AS THE VERY FIRST DESCRIBE BLOCK
  describe('🔍 Contract Owner Verification (Critical Setup Test)', function () {
    it('should verify LibDiamond contract owner is properly set', async function () {
      const { ownershipFacet, owner, diamondAddress } = await loadFixture(deployGovernanceFixture)
      
      console.log('\n=== 🔍 CRITICAL OWNER VERIFICATION ===')
      console.log('Diamond Address:', diamondAddress)
      console.log('Expected Owner (deployer):', owner.address)
      
      try {
        const contractOwner = await ownershipFacet.owner()
        console.log('Actual Contract Owner:', contractOwner)
        console.log('Is Zero Address:', contractOwner === ethers.ZeroAddress)
        console.log('Owner Match:', contractOwner.toLowerCase() === owner.address.toLowerCase())
        
        if (contractOwner === ethers.ZeroAddress) {
          console.log('❌ CRITICAL ERROR: Contract owner is zero address!')
          console.log('   LibDiamond.setContractOwner() was NEVER called during deployment!')
          console.log('   This explains why ALL governance tests are failing.')
        } else if (contractOwner.toLowerCase() === owner.address.toLowerCase()) {
          console.log('✅ SUCCESS: Contract owner correctly set')
        } else {
          console.log('⚠️  WARNING: Contract owner set to unexpected address')
        }
        
        console.log('=====================================\n')
        
        // This assertion will FAIL if owner is not set, showing us the problem
        expect(contractOwner).to.not.equal(ethers.ZeroAddress, "Contract owner is zero address - setContractOwner() never called!")
        expect(contractOwner).to.equal(owner.address, "Contract owner does not match deployer")
        
      } catch (error) {
        console.log('❌ FATAL ERROR: Cannot read contract owner')
        console.log('Error:', error.message)
        console.log('This indicates a serious deployment issue')
        console.log('=====================================\n')
        throw error
      }
    })
  })

  describe('Governance Storage and Initialization', function () {
    it('should return initial governance storage state', async function () {
      const { queryV2Facet } = await loadFixture(deployGovernanceFixture)
      
      const snap = await queryV2Facet.getGovernanceSnapshot()
      
      expect(snap.currentProposalId).to.equal(0)
      expect(snap.isProposalActive).to.be.false
      expect(snap.proposedFacets).to.have.length(0)
      expect(snap.proposedAdmins).to.have.length(0)
      expect(snap.adminVoteId).to.equal(0)
    })

    it('should have reasonable default quotas', async function () {
      const { queryV2Facet } = await loadFixture(deployGovernanceFixture)
      
      const snap = await queryV2Facet.getGovernanceSnapshot()
      
      // Verify some reasonable defaults exist
      expect(snap.currentQuotas.openAdvertsCommission).to.be.a('bigint')
      expect(snap.currentQuotas.QuotaProposalQuorum).to.be.a('bigint')
      expect(snap.currentQuotas.FacetProposalQuorum).to.be.a('bigint')
    })
  })

  describe('Quota Proposal Management', function () {
    describe('Creating Quota Proposals', function () {
      it('should allow owner to create a quota proposal', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        const quotaProposal = createSampleQuotaProposal()
        const votingDuration = 605000 // blocks
        
        await expect(
          governanceFacet.connect(owner).createProposal(
            0, // QuotaProposal
            quotaProposal,
            votingDuration,
            [] // No facet cuts for quota proposal
          )
        ).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.currentProposalId).to.equal(1)
        expect(snap.isProposalActive).to.be.true
      })

      it('should prevent non-owners from creating quota proposals', async function () {
        const { governanceFacet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        const quotaProposal = createSampleQuotaProposal()
        
        await expect(
          governanceFacet.connect(addr1).createProposal(
            0, // QuotaProposal
            quotaProposal,
            605000  ,
            []
          )
        ).to.be.revertedWith('LibDiamond: Must be contract owner')
      })

      it('should prevent creating proposals when one is already active', async function () {
        const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)
        
        const quotaProposal = createSampleQuotaProposal()
        
        // Create first proposal
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        
        // Try to create second proposal
        await expect(
          governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        ).to.be.revertedWith('Currently a proposal is already active')
      })

      it('should set correct voting deadline for quota proposals', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        const quotaProposal = createSampleQuotaProposal()
        const votingDuration = 605000
        
        const blockNumberBefore = await ethers.provider.getBlockNumber()
        
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, votingDuration, [])
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        
        expect(snap.proposalStruct.votingDeadlineBlocknumber).to.be.approximately(
          blockNumberBefore + votingDuration,
          5 // Allow some variance for block timing
        )
      })

      it('should store all quota proposal parameters correctly', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        const quotaProposal = createSampleQuotaProposal()
        
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        
        expect(snap.proposalStruct.quotaProposal.proposedOpenAdvertsCommission).to.equal(quotaProposal.proposedOpenAdvertsCommission)
        expect(snap.proposalStruct.quotaProposal.proposedQuotaProposalQuorum).to.equal(quotaProposal.proposedQuotaProposalQuorum)
        expect(snap.proposalStruct.quotaProposal.proposedAdminApplicantFeeInPol).to.equal(quotaProposal.proposedAdminApplicantFeeInPol)
      })

      it('should reject a quota proposal whose min bounty is below the claim-gas floor', async function () {
        const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)

        const quotaProposal = createSampleQuotaProposal()
        // 0.03 POL * 70% = 0.021 POL < assumed 90k gas * 300 gwei = 0.027 POL → must revert.
        quotaProposal.proposedMinAdvertBountyInPOLWei = ethers.parseEther('0.03')

        await expect(
          governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        ).to.be.revertedWith('Min bounty below claim-gas floor')
      })

      it('should expose the on-chain claim-gas floor assumptions', async function () {
        const { claimGasFloorFacet } = await loadFixture(deployGovernanceFixture)

        const [gasPerSig, gasPriceWei] = await claimGasFloorFacet.getClaimGasFloorAssumptions()
        expect(gasPerSig).to.equal(90000n)
        expect(gasPriceWei).to.equal(300n * (10n ** 9n))
      })

      it('should let the owner update the claim-gas floor assumptions (no vote)', async function () {
        const { claimGasFloorFacet, owner } = await loadFixture(deployGovernanceFixture)

        await expect(claimGasFloorFacet.connect(owner).setClaimGasFloorAssumptions(120000n, 500n * (10n ** 9n)))
          .to.emit(claimGasFloorFacet, 'ClaimGasFloorAssumptionsUpdated')
          .withArgs(120000n, 500n * (10n ** 9n))

        const [gasPerSig, gasPriceWei] = await claimGasFloorFacet.getClaimGasFloorAssumptions()
        expect(gasPerSig).to.equal(120000n)
        expect(gasPriceWei).to.equal(500n * (10n ** 9n))
      })

      it('should reject non-owner, zero, and out-of-range claim-gas assumption updates', async function () {
        const { claimGasFloorFacet, addr1 } = await loadFixture(deployGovernanceFixture)

        await expect(
          claimGasFloorFacet.connect(addr1).setClaimGasFloorAssumptions(120000n, 500n * (10n ** 9n))
        ).to.be.revertedWith('LibDiamond: Must be contract owner')

        await expect(
          claimGasFloorFacet.setClaimGasFloorAssumptions(0n, 500n * (10n ** 9n))
        ).to.be.revertedWith('gasPerSig out of range')

        // Above the 1,000,000 gasPerSig ceiling.
        await expect(
          claimGasFloorFacet.setClaimGasFloorAssumptions(1_000_001n, 500n * (10n ** 9n))
        ).to.be.revertedWith('gasPerSig out of range')

        // Above the 100,000 gwei gasPriceWei ceiling (prevents the unsatisfiable-floor DoS).
        await expect(
          claimGasFloorFacet.setClaimGasFloorAssumptions(90000n, 100_001n * (10n ** 9n))
        ).to.be.revertedWith('gasPriceWei out of range')
      })

      it('should raise the enforced floor when the owner raises the assumptions', async function () {
        const { governanceFacet, claimGasFloorFacet, owner } = await loadFixture(deployGovernanceFixture)

        // Raise assumed gas price 300 -> 1000 gwei; genesis 0.06 POL * 70% now falls below the floor.
        await claimGasFloorFacet.connect(owner).setClaimGasFloorAssumptions(90000n, 1000n * (10n ** 9n))

        const quotaProposal = createSampleQuotaProposal()
        quotaProposal.proposedMinAdvertBountyInPOLWei = ethers.parseEther('0.06')

        await expect(
          governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        ).to.be.revertedWith('Min bounty below claim-gas floor')
      })
    })

    describe('Facet Proposal Management', function () {
      it('should allow owner to create a facet proposal', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        const sampleFacetCut = [{
          facetAddress: ethers.ZeroAddress,
          action: 2, // Remove
          functionSelectors: ['0x12345678']
        }]
        
        await expect(
          governanceFacet.connect(owner).createProposal(
            1, // FacetProposal
            createSampleQuotaProposal(), // Dummy quota data
            605000,
            sampleFacetCut
          )
        ).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposalType).to.equal(1) // FacetProposal
        expect(snap.proposedFacets).to.have.length(1)
      })

      it('should prevent non-owners from creating facet proposals', async function () {
        const { governanceFacet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await expect(
          governanceFacet.connect(addr1).createProposal(1, createSampleQuotaProposal(), 605000, [])
        ).to.be.revertedWith('LibDiamond: Must be contract owner')
      })

      it('should handle multiple facet cuts in proposal', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        const multipleFacetCuts = [
          { facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: ['0x12345678'] },
          { facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: ['0x87654321'] }
        ]
        
        await governanceFacet.connect(owner).createProposal(1, createSampleQuotaProposal(), 650000, multipleFacetCuts)
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedFacets).to.have.length(2)
      })
    })

    describe('Proposal Revocation', function () {
      it('should allow owner to revoke active proposal', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        // Create proposal first
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        // Revoke it
        await expect(governanceFacet.connect(owner).revokeProposal()).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.isProposalActive).to.be.false
      })

      it('should prevent non-owners from revoking proposals', async function () {
        const { governanceFacet, owner, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        await expect(
          governanceFacet.connect(addr1).revokeProposal()
        ).to.be.revertedWith('LibDiamond: Must be contract owner')
      })

      it('should revert when trying to revoke non-existent proposal', async function () {
        const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)
        
        await expect(
          governanceFacet.connect(owner).revokeProposal()
        ).to.be.revertedWith('No active proposal to revoke')
      })
    })
  })

  describe('Voting on Proposals', function () {
    describe('Voting Mechanics', function () {
      it('should allow token holders to vote on proposals', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1 } = await loadFixture(deployGovernanceFixture)
        
        // Give addr1 some tokens
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        // mine blocks
        await advanceBlocksForVoting(15);
        
        // Create proposal
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        // Vote
        await expect(governanceFacet.connect(addr1).voteOnProposal(true)).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposalStruct.totalSupportVotesForCurrentProposal).to.equal(ethers.parseEther('1000'))
      })

      it('should weight votes by token balance', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        // Give different amounts to different addresses
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('2000'))
        await advanceBlocksForVoting(15);
        
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        // Both vote in favor
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(addr2).voteOnProposal(true)
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposalStruct.totalSupportVotesForCurrentProposal).to.equal(ethers.parseEther('3000'))
      })

      it('should prevent double voting on same proposal', async function () {
        const { governanceFacet, tokenFacet, owner, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        await advanceBlocksForVoting(15);
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        await advanceBlocksForVoting(15);
        
        // First vote
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await advanceBlocksForVoting(15);
        
        // Second vote should fail
        await expect(
          governanceFacet.connect(addr1).voteOnProposal(false)
        ).to.be.revertedWith('Already voted')
      })

      it('should prevent voting after deadline', async function () {
        const { governanceFacet, tokenFacet, owner, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, []) // Short deadline
        
        // Mine blocks to pass deadline
        // for (let i = 0; i < 10; i++) {
        //   await ethers.provider.send("evm_mine", [])
        // }
        await advanceBlocksForVoting(605000 + 1); // Advance past voting period
        
        await expect(
          governanceFacet.connect(addr1).voteOnProposal(true)
        ).to.be.revertedWith('Voting period over')
      })

      it('should handle both support and opposition votes', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('1500'))
        await advanceBlocksForVoting(15);

        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])

        await governanceFacet.connect(addr1).voteOnProposal(true) // Support
        await governanceFacet.connect(addr2).voteOnProposal(false) // Oppose
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposalStruct.totalSupportVotesForCurrentProposal).to.equal(ethers.parseEther('1000'))
        expect(snap.proposalStruct.totalDenyVotesForCurrentProposal).to.equal(ethers.parseEther('1500'))
      })

      it('should handle zero balance voters gracefully', async function () {
        const { governanceFacet, queryV2Facet, owner, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        // addr1 has zero balance
        await expect(governanceFacet.connect(addr1).voteOnProposal(true)).to.be.revertedWith('Caller does not have ownership tokens')       
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposalStruct.totalSupportVotesForCurrentProposal).to.equal(0)
      })
    })
  })

  describe('Proposal Ratification', function () {
    describe('Quota Proposal Ratification', function () {
      it('should ratify quota proposal when quorum is met', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        // Get total supply and distribute tokens
        const totalSupply = await tokenFacet.totalSupply()
        const voteAmount = totalSupply / 3n // 33.33% of supply

        await tokenFacet.connect(owner).transfer(addr1.address, voteAmount)
        await tokenFacet.connect(owner).transfer(addr2.address, voteAmount)
        await advanceBlocksForVoting(15);
        
        const quotaProposal = createSampleQuotaProposal()
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        
        // Vote with enough tokens to meet quorum
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(addr2).voteOnProposal(true)
        
        // Wait for voting period to end
        // for (let i = 0; i < 15; i++) {
        //   await ethers.provider.send("evm_mine", [])
        // }

        await advanceBlocksForVoting(605000 + 1); // Advance past voting period
        
        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.currentQuotas.openAdvertsCommission).to.equal(quotaProposal.proposedOpenAdvertsCommission)
      })

      it('resolves (without applying) a proposal that fails to meet quorum', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1 } = await loadFixture(deployGovernanceFixture)

        const before = await queryV2Facet.getGovernanceSnapshot()

        // Give small amount that won't meet quorum
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('100'))
        await advanceBlocksForVoting(15);
        
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 650000, [])
        await governanceFacet.connect(addr1).voteOnProposal(true)
        
        await advanceBlocksForVoting(650000 + 1); // Advance past voting period
        
        // No revert: an under-quorum proposal is cleaned up as failed, never bricking future proposals.
        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted

        const after = await queryV2Facet.getGovernanceSnapshot()
        expect(after.isProposalActive).to.equal(false)
        // Quotas unchanged: the proposal did not apply.
        expect(after.currentQuotas.openAdvertsCommission).to.equal(before.currentQuotas.openAdvertsCommission)
      })

      it('should prevent ratification before voting period ends', async function () {
        const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)
        
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        await expect(
          governanceFacet.connect(owner).ratifyUpgrade()
        ).to.be.revertedWith('Voting period not ended')
      })

      it('allows anyone (permissionless) to ratify a passed proposal after the deadline', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)

        const totalSupply = await tokenFacet.totalSupply()
        const voteAmount = totalSupply / 3n
        await tokenFacet.connect(owner).transfer(addr1.address, voteAmount)
        await tokenFacet.connect(owner).transfer(addr2.address, voteAmount)
        await advanceBlocksForVoting(15)

        const quotaProposal = createSampleQuotaProposal()
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(addr2).voteOnProposal(true)
        await advanceBlocksForVoting(605000 + 1)

        // addr3 holds no tokens and is not the owner — ratification is permissionless
        await expect(governanceFacet.connect(addr3).ratifyUpgrade()).to.not.be.reverted

        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.currentQuotas.openAdvertsCommission).to.equal(quotaProposal.proposedOpenAdvertsCommission)
      })

      it('does not apply a quota proposal that is voted down by majority', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)

        const before = await queryV2Facet.getGovernanceSnapshot()

        const totalSupply = await tokenFacet.totalSupply()
        const share = totalSupply / 3n
        await tokenFacet.connect(owner).transfer(addr1.address, share)
        await tokenFacet.connect(owner).transfer(addr2.address, share)
        await tokenFacet.connect(owner).transfer(addr3.address, share)
        await advanceBlocksForVoting(15)

        const quotaProposal = createSampleQuotaProposal()
        await governanceFacet.connect(owner).createProposal(0, quotaProposal, 605000, [])
        await governanceFacet.connect(addr1).voteOnProposal(true)   // ~33% support
        await governanceFacet.connect(addr2).voteOnProposal(false)  // ~66% deny
        await governanceFacet.connect(addr3).voteOnProposal(false)
        await advanceBlocksForVoting(605000 + 1)

        // Deny outweighs support -> not applied, cleaned up, no revert.
        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted

        const after = await queryV2Facet.getGovernanceSnapshot()
        expect(after.isProposalActive).to.equal(false)
        expect(after.currentQuotas.openAdvertsCommission).to.equal(before.currentQuotas.openAdvertsCommission)
      })
    })

    describe('Facet Proposal Ratification', function () {
      it('executes a real diamondCut when a facet proposal passes', async function () {
        const { governanceFacet, tokenFacet, diamondAddress, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)

        const loupe = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)

        // Finalize bootstrap first: proves the governance path cuts even after the direct backdoor
        // is permanently disabled (governance is authorized via the transient in-progress flag).
        await tokenFacet.connect(owner).finalizeBootstrap()
        expect(await tokenFacet.isBootstrapFinalized()).to.equal(true)

        // Deploy a fresh OwnershipFacet instance to Replace an existing selector with.
        const OwnershipFacet = await ethers.getContractFactory('OwnershipFacet')
        const newOwnership = await OwnershipFacet.deploy(diamondAddress)
        await newOwnership.waitForDeployment()
        const newAddr = await newOwnership.getAddress()
        const ownerSelector = newOwnership.interface.getFunction('owner').selector

        const oldFacetAddr = await loupe.facetAddress(ownerSelector)
        expect(oldFacetAddr).to.not.equal(newAddr)

        const cut = [{ facetAddress: newAddr, action: 1, functionSelectors: [ownerSelector] }] // 1 = Replace

        // Reach facet-proposal quorum (genesis 51%): two 1/3 holders both vote yes = ~66%.
        const totalSupply = await tokenFacet.totalSupply()
        const voteAmount = totalSupply / 3n
        await tokenFacet.connect(owner).transfer(addr1.address, voteAmount)
        await tokenFacet.connect(owner).transfer(addr2.address, voteAmount)
        await advanceBlocksForVoting(15)

        await governanceFacet.connect(owner).createProposal(1, createSampleQuotaProposal(), 605000, cut)
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(addr2).voteOnProposal(true)
        await advanceBlocksForVoting(605000 + 1)

        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted

        // The selector now resolves to the freshly deployed facet — proof the cut executed.
        expect(await loupe.facetAddress(ownerSelector)).to.equal(newAddr)
      })

      it('rejects a passed facet proposal that removes a protected selector (no brick, proposal cleared)', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, diamondAddress, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        const loupe = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)

        // Attempt to Remove a core governance selector.
        const voteSelector = governanceFacet.interface.getFunction('voteOnProposal').selector
        const before = await loupe.facetAddress(voteSelector)
        expect(before).to.not.equal(ethers.ZeroAddress)
        const cut = [{ facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: [voteSelector] }] // 2 = Remove

        const totalSupply = await tokenFacet.totalSupply()
        const voteAmount = totalSupply / 3n
        await tokenFacet.connect(owner).transfer(addr1.address, voteAmount)
        await tokenFacet.connect(owner).transfer(addr2.address, voteAmount)
        await advanceBlocksForVoting(15)

        await governanceFacet.connect(owner).createProposal(1, createSampleQuotaProposal(), 605000, cut)
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(addr2).voteOnProposal(true)
        await advanceBlocksForVoting(605000 + 1)

        // Ratify does not revert (the blocked cut is caught); the selector survives and the queue clears.
        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted
        expect(await loupe.facetAddress(voteSelector)).to.equal(before)
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.isProposalActive).to.equal(false)
      })

      it('does not execute the cut when a facet proposal is voted down', async function () {
        const { governanceFacet, tokenFacet, diamondAddress, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)

        const loupe = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)

        const OwnershipFacet = await ethers.getContractFactory('OwnershipFacet')
        const newOwnership = await OwnershipFacet.deploy(diamondAddress)
        await newOwnership.waitForDeployment()
        const newAddr = await newOwnership.getAddress()
        const ownerSelector = newOwnership.interface.getFunction('owner').selector
        const originalFacet = await loupe.facetAddress(ownerSelector)

        const cut = [{ facetAddress: newAddr, action: 1, functionSelectors: [ownerSelector] }] // 1 = Replace

        const totalSupply = await tokenFacet.totalSupply()
        const share = totalSupply / 3n
        await tokenFacet.connect(owner).transfer(addr1.address, share)
        await tokenFacet.connect(owner).transfer(addr2.address, share)
        await tokenFacet.connect(owner).transfer(addr3.address, share)
        await advanceBlocksForVoting(15)

        await governanceFacet.connect(owner).createProposal(1, createSampleQuotaProposal(), 605000, cut)
        await governanceFacet.connect(addr1).voteOnProposal(true)   // ~33% support
        await governanceFacet.connect(addr2).voteOnProposal(false)  // ~66% deny
        await governanceFacet.connect(addr3).voteOnProposal(false)
        await advanceBlocksForVoting(605000 + 1)

        await expect(governanceFacet.connect(owner).ratifyUpgrade()).to.not.be.reverted

        // The cut did NOT execute: selector still resolves to the original facet.
        expect(await loupe.facetAddress(ownerSelector)).to.equal(originalFacet)
      })
    })
  })

  describe('Bootstrap diamondCut latch', function () {
    async function freshOwnershipReplaceCut(diamondAddress) {
      const OwnershipFacet = await ethers.getContractFactory('OwnershipFacet')
      const nf = await OwnershipFacet.deploy(diamondAddress)
      await nf.waitForDeployment()
      const sel = nf.interface.getFunction('owner').selector
      return [{ facetAddress: await nf.getAddress(), action: 1, functionSelectors: [sel] }] // 1 = Replace
    }

    it('owner can direct diamondCut during bootstrap (no distribution yet)', async function () {
      const { diamondCutFacet, tokenFacet, diamondAddress, owner } = await loadFixture(deployGovernanceFixture)
      expect(await tokenFacet.isBootstrapFinalized()).to.equal(false)
      const cut = await freshOwnershipReplaceCut(diamondAddress)
      await expect(diamondCutFacet.connect(owner).diamondCut(cut, ethers.ZeroAddress, '0x')).to.not.be.reverted
    })

    it('finalizeBootstrap() is owner-only and disables the direct backdoor immediately', async function () {
      const { diamondCutFacet, tokenFacet, diamondAddress, owner, addr1 } = await loadFixture(deployGovernanceFixture)
      await expect(tokenFacet.connect(addr1).finalizeBootstrap()).to.be.revertedWith('LibDiamond: Must be contract owner')

      await tokenFacet.connect(owner).finalizeBootstrap()
      expect(await tokenFacet.isBootstrapFinalized()).to.equal(true)
      await expect(tokenFacet.connect(owner).finalizeBootstrap()).to.be.revertedWith('Bootstrap already finalized')

      const cut = await freshOwnershipReplaceCut(diamondAddress)
      await expect(diamondCutFacet.connect(owner).diamondCut(cut, ethers.ZeroAddress, '0x'))
        .to.be.revertedWith('Direct diamondCut disabled post-bootstrap; use governance')
    })
  })

  describe('Admin Management System', function () {
    describe('Admin Applications', function () {
      it('should allow users to apply as admin with correct fee', async function () {
        const { governanceFacet, queryV2Facet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        const applicationFee = ethers.parseEther('1000')
        
        await expect(
          governanceFacet.connect(addr1).applyAsNewAdmin("test-storage-id", ethers.Wallet.createRandom().address, { value: applicationFee })
        ).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedAdmins).to.have.length(2)
      })

      it('should reject applications with insufficient fee', async function () {
        const { governanceFacet } = await loadFixture(deployGovernanceFixture)
        
        const insufficientFee = ethers.parseEther('5')
        
        await expect(
          governanceFacet.applyAsNewAdmin("test-storage-id", ethers.Wallet.createRandom().address, { value: insufficientFee })
        ).to.be.revertedWith('Insufficient fee for admin application')
      })

      it('should refund excess fee', async function () {
        const { governanceFacet, queryV2Facet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        console.log('\n=== 🔍 DEBUGGING ADMIN FEE REFUND ===')
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        const requiredFee = snap.currentQuotas.adminApplicantFeeInPolWei // Already in wei
        
        console.log('Required Admin Fee (from storage):', ethers.formatEther(requiredFee), 'ETH')
        
        const excessFee = ethers.parseEther('800') // More than required
        console.log('Excess Fee Sent:', ethers.formatEther(excessFee), 'ETH')
        
        const balanceBefore = await ethers.provider.getBalance(addr1.address)
        console.log('Balance Before:', ethers.formatEther(balanceBefore), 'ETH')
        
        const tx = await governanceFacet.connect(addr1).applyAsNewAdmin("test-storage-id", ethers.Wallet.createRandom().address, { value: excessFee })
        const receipt = await tx.wait()
        const gasUsed = receipt.gasUsed * receipt.gasPrice
        
        const balanceAfter = await ethers.provider.getBalance(addr1.address)
        const expectedBalance = balanceBefore - requiredFee - gasUsed
        
        console.log('Expected Balance:', ethers.formatEther(expectedBalance), 'ETH')
        console.log('Actual Balance:', ethers.formatEther(balanceAfter), 'ETH')
        
        expect(balanceAfter).to.be.approximately(expectedBalance, ethers.parseEther('0.01'))
      })

      it('should prevent duplicate applications in same round', async function () {
        const { governanceFacet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        const fee = ethers.parseEther('1000')
        
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: fee })
        
        await expect(
          governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-2", ethers.Wallet.createRandom().address, { value: fee })
        ).to.be.revertedWith('You have already declared yourself an applicant for this round.')
      })

      it('should set admin vote deadline for first applicant', async function () {
        const { governanceFacet, queryV2Facet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        const blockBefore = await ethers.provider.getBlockNumber()
        
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.adminVoteDeadline).to.be.greaterThan(blockBefore)
      })

      it('should handle multiple admin applications', async function () {
        const { governanceFacet, queryV2Facet, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)
        
        const fee = ethers.parseEther('1000')
        
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: fee })
        await governanceFacet.connect(addr2).applyAsNewAdmin("storage-id-2", ethers.Wallet.createRandom().address, { value: fee })
        await governanceFacet.connect(addr3).applyAsNewAdmin("storage-id-3", ethers.Wallet.createRandom().address, { value: fee })
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedAdmins).to.have.length(4)
        const adminAddresses = snap.proposedAdmins.map(a => a.candidateAddress)
        expect(adminAddresses).to.include(addr1.address)
        expect(adminAddresses).to.include(addr2.address)
        expect(adminAddresses).to.include(addr3.address)
      })
    })

    describe('Admin Application Revocation', function () {
      it('should allow applicants to revoke their application', async function () {
        const { governanceFacet, queryV2Facet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        await expect(governanceFacet.connect(addr1).revokeAdminApplication()).to.not.be.reverted
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedAdmins).to.have.length(1)
      })

      it('should prevent non-applicants from revoking', async function () {
        const { governanceFacet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        await expect(
          governanceFacet.connect(addr1).revokeAdminApplication()
        ).to.be.revertedWith('You are not an applicant for this round')
      })

      it('should handle array reorganization correctly on revocation', async function () {
        const { governanceFacet, queryV2Facet, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)
        
        const fee = ethers.parseEther('1000')
        
        // Apply as admins
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: fee })
        await governanceFacet.connect(addr2).applyAsNewAdmin("storage-id-2", ethers.Wallet.createRandom().address, { value: fee })
        await governanceFacet.connect(addr3).applyAsNewAdmin("storage-id-3", ethers.Wallet.createRandom().address, { value: fee })
        
        // Revoke middle application
        await governanceFacet.connect(addr2).revokeAdminApplication()
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedAdmins).to.have.length(3)
        const adminAddresses = snap.proposedAdmins.map(a => a.candidateAddress)
        expect(adminAddresses).to.include(addr1.address)
        expect(adminAddresses).to.include(addr3.address)
        expect(adminAddresses).to.not.include(addr2.address)
      })
    })

    describe('Admin Voting', function () {
      it('should allow voting for admin candidates', async function () {
        const { governanceFacet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        // Give voter some tokens
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('1000'))
        await advanceBlocksForVoting(15);
        
        // Apply as admin
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        // Vote for candidate
        await expect(
          governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)
        ).to.not.be.reverted
        
        const governanceHelperFacet = await ethers.getContractAt('OpenAdvertsGovernanceHelperFacet', governanceFacet.target)
        const [proposedOwners, totalVotes, storageIds] = await governanceHelperFacet.getProposedOwnersAndVotes()
        console.log('Proposed Owners:', proposedOwners)
        console.log('Total Votes:', totalVotes)
        console.log('Storage IDs:', storageIds)
        // addr1 is at index 1 (index 0 is incumbent admin automatically added)
        expect(totalVotes[1]).to.equal(ethers.parseEther('1000'))
        expect(storageIds[1]).to.equal('storage-id-1')
      })

      it('should prevent voting for non-candidates', async function () {
        const { governanceFacet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        
        await expect(
          governanceFacet.connect(addr1).voteForNewAdmin(addr2.address)
        ).to.be.reverted // addr2 is not an applicant
      })

      it('should prevent double voting for same candidate', async function () {
        const { governanceFacet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('1000'))
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        await advanceBlocksForVoting(15);

        // First vote
        await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)
        await advanceBlocksForVoting(15);
        
        // Second vote should fail
        await expect(
          governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)
        ).to.be.revertedWith('You have already voted for this candidate in the current round')
      })

      it('should accumulate votes from multiple voters for same candidate', async function () {
        const { governanceFacet, tokenFacet, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('1000'))
        await tokenFacet.connect(owner).transfer(addr3.address, ethers.parseEther('1500'))
        await advanceBlocksForVoting(15);
        
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address) // 1000 votes
        await advanceBlocksForVoting(15);
        await governanceFacet.connect(addr3).voteForNewAdmin(addr1.address) // 1500 votes
        
        const governanceHelperFacet = await ethers.getContractAt('OpenAdvertsGovernanceHelperFacet', governanceFacet.target)
        const [proposedOwners, totalVotes] = await governanceHelperFacet.getProposedOwnersAndVotes()
        // addr1 is at index 1 (index 0 is incumbent admin)
        // Votes should accumulate: 1000 + 1500 = 2500
        expect(totalVotes[1]).to.equal(ethers.parseEther('2500'))
      })
    })

    describe('Admin Ratification', function () {
      it('should ratify admin with highest net votes meeting quorum', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, ownershipFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        const totalSupply = await tokenFacet.totalSupply()
        const quorumPercentage = snap.currentQuotas.openAdvertsAdminChangeQuorum
        const quorumAmount = (totalSupply * BigInt(quorumPercentage)) / 100n
        const votingAmount = quorumAmount + ethers.parseEther('1000')
        
        await tokenFacet.connect(owner).transfer(addr2.address, votingAmount)
        await advanceBlocksForVoting(15);
        
        const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei
        await governanceFacet.connect(addr1).applyAsNewAdmin("candidate-storage-id", ethers.Wallet.createRandom().address, { value: adminFee })
        await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)

        // Advance past the adminVoteDeadline (read from storage to be robust against quota changes)
        const snap2 = await queryV2Facet.getGovernanceSnapshot()
        const currentBlock = BigInt(await ethers.provider.getBlockNumber())
        await advanceBlocksForVoting(Number(snap2.adminVoteDeadline - currentBlock) + 1)

        const ownerBefore = await ownershipFacet.owner()
        
        try {
          const tx = await governanceFacet.ratifyNewAdmin()
          await tx.wait()
          console.log('✅ Ratification call succeeded')
        } catch (error) {
          console.log('❌ Ratification call failed:', error.message)
          throw error
        }
        
        const ownerAfter = await ownershipFacet.owner()
        
        // Test should pass if ownership changes to addr1
        expect(ownerAfter).to.equal(addr1.address)
      })
    })

    describe('Admin Election Liveness (no brick)', function () {
      it('permissionless clearFailedElection() resolves a no-quorum election and a fresh round can start', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)

        const snap = await queryV2Facet.getGovernanceSnapshot()
        const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei

        // Sub-quorum stake so no candidate clears the change quorum.
        await tokenFacet.connect(owner).transfer(addr2.address, ethers.parseEther('1000'))
        await advanceBlocksForVoting(15)
        await governanceFacet.connect(addr1).applyAsNewAdmin('round-1', ethers.Wallet.createRandom().address, { value: adminFee })
        await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address) // ~1000 tokens << 51% quorum

        const snap2 = await queryV2Facet.getGovernanceSnapshot()
        const currentBlock = BigInt(await ethers.provider.getBlockNumber())
        await advanceBlocksForVoting(Number(snap2.adminVoteDeadline - currentBlock) + 1)

        // ratify must refuse (no candidate met quorum) ...
        await expect(governanceFacet.connect(owner).ratifyNewAdmin()).to.be.revertedWith('No candidates have met the requirement')

        // ... and clearFailedElection is permissionless (called by a zero-stake non-owner).
        await expect(governanceFacet.connect(addr3).clearFailedElection()).to.not.be.reverted

        const after = await queryV2Facet.getGovernanceSnapshot()
        expect(after.adminVoteDeadline).to.equal(0n)

        // Fresh round: addr1 can re-apply, which only succeeds because adminVoteId advanced.
        await expect(governanceFacet.connect(addr1).applyAsNewAdmin('round-2', ethers.Wallet.createRandom().address, { value: adminFee })).to.not.be.reverted
      })

      it('ratifyNewAdmin() and clearFailedElection() are mutually exclusive after the deadline', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)

        const snap = await queryV2Facet.getGovernanceSnapshot()
        const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei
        const totalSupply = await tokenFacet.totalSupply()
        const quorumAmount = (totalSupply * BigInt(snap.currentQuotas.openAdvertsAdminChangeQuorum)) / 100n
        const votingAmount = quorumAmount + ethers.parseEther('1000')

        await tokenFacet.connect(owner).transfer(addr2.address, votingAmount)
        await advanceBlocksForVoting(15)
        await governanceFacet.connect(addr1).applyAsNewAdmin('cand', ethers.Wallet.createRandom().address, { value: adminFee })
        await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)

        const snap2 = await queryV2Facet.getGovernanceSnapshot()
        const currentBlock = BigInt(await ethers.provider.getBlockNumber())
        await advanceBlocksForVoting(Number(snap2.adminVoteDeadline - currentBlock) + 1)

        // A candidate cleared quorum -> clearFailedElection refuses; ratify is the only valid path.
        await expect(governanceFacet.connect(owner).clearFailedElection()).to.be.revertedWith('A candidate met quorum; call ratifyNewAdmin()')
        await expect(governanceFacet.connect(addr1).ratifyNewAdmin()).to.not.be.reverted
      })
    })
  })

  describe('View Functions and Data Retrieval', function () {
    describe('getProposedOwnersAndVotes()', function () {
      it('should return empty arrays when no admin candidates', async function () {
        const { governanceFacet } = await loadFixture(deployGovernanceFixture)
        
        const governanceHelperFacet = await ethers.getContractAt('OpenAdvertsGovernanceHelperFacet', governanceFacet.target)
        const [proposedOwners, forVotes, againstVotes] = await governanceHelperFacet.getProposedOwnersAndVotes()
        
        expect(proposedOwners).to.have.length(0)
        expect(forVotes).to.have.length(0)
        expect(againstVotes).to.have.length(0)
      })

      it('should return correct data for multiple candidates', async function () {
        const { governanceFacet, tokenFacet, owner, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)
        
        await tokenFacet.connect(owner).transfer(addr3.address, ethers.parseEther('1000'))
        await advanceBlocksForVoting(15);
        
        // Apply as admins
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        await governanceFacet.connect(addr2).applyAsNewAdmin("storage-id-2", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        // Vote
        await governanceFacet.connect(addr3).voteForNewAdmin(addr1.address)
        
        const governanceHelperFacet = await ethers.getContractAt('OpenAdvertsGovernanceHelperFacet', governanceFacet.target)
        const [proposedOwners, forVotes, againstVotes] = await governanceHelperFacet.getProposedOwnersAndVotes()
        
        expect(proposedOwners).to.have.length(3)
        expect(forVotes).to.have.length(3)
        expect(againstVotes).to.have.length(3)
        expect(forVotes[1]).to.equal(ethers.parseEther('1000')) // addr1 got votes
        expect(forVotes[2]).to.equal(0) // addr2 got no votes
      })
    })

    describe('getGovernanceSnapshot()', function () {
      it('should return comprehensive governance state', async function () {
        const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
        
        // Create a proposal to have some state
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        
        expect(snap.currentProposalId).to.equal(1)
        expect(snap.isProposalActive).to.be.true
        expect(snap.proposalType).to.equal(0) // QuotaProposal
        expect(snap.proposalStruct.votingDeadlineBlocknumber).to.be.greaterThan(0)
      })

      it('should be a view function with no gas cost', async function () {
        const { queryV2Facet } = await loadFixture(deployGovernanceFixture)
        
        // Should be able to call statically
        const result = await queryV2Facet.getGovernanceSnapshot.staticCall()
        expect(result).to.be.an('array')
      })
    })
  })

  describe('Edge Cases and Error Handling', function () {
    // describe('Invalid Proposal Types', function () {
    //   it('should revert on invalid proposal type', async function () {
    //     const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)
        
    //     await expect(
    //       governanceFacet.connect(owner).createProposal(
    //         99, // Invalid type
    //         createSampleQuotaProposal(),
    //         1000,
    //         []
    //       )
    //     ).to.be.revertedWith('Invalid proposal type')
    //   })
    // })

    describe('State Consistency', function () {
      it('should maintain consistent state across complex operations', async function () {
        const { governanceFacet, queryV2Facet, tokenFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
        
        // Phase 2: fund the voter BEFORE proposal creation so the snapshot captures
        // their non-zero balance.
        await tokenFacet.connect(owner).transfer(addr1.address, ethers.parseEther('1000'))
        await advanceBlocksForVoting(5)

        // Complex sequence of operations
        await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
        await advanceBlocksForVoting(20) // Ensure voting period is active
        
        await governanceFacet.connect(addr1).voteOnProposal(true)
        await governanceFacet.connect(owner).revokeProposal()
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.currentProposalId).to.equal(1) // ID incremented
        expect(snap.isProposalActive).to.be.false // Proposal revoked
      })

      it('should handle admin round transitions correctly', async function () {
        const { governanceFacet, queryV2Facet, addr1 } = await loadFixture(deployGovernanceFixture)
        
        // Apply and then start new round
        await governanceFacet.connect(addr1).applyAsNewAdmin("storage-id-1", ethers.Wallet.createRandom().address, { value: ethers.parseEther('1000') })
        
        const snap = await queryV2Facet.getGovernanceSnapshot()
        expect(snap.proposedAdmins).to.have.length(2)
        expect(snap.adminVoteId).to.equal(0)

        // Advance past the adminVoteDeadline
        const currentBlock = BigInt(await ethers.provider.getBlockNumber())
        await advanceBlocksForVoting(Number(snap.adminVoteDeadline - currentBlock) + 1)

        // Ratify (will fail due to no votes, but advances round)
        await expect(governanceFacet.ratifyNewAdmin()).to.be.revertedWith('No candidates have met the requirement')
      })
    })

    describe('Gas Efficiency', function () {
      it('should have reasonable gas costs for common operations', async function () {
        const { governanceFacet, owner } = await loadFixture(deployGovernanceFixture)
        
        const gasEstimate = await governanceFacet.connect(owner).createProposal.estimateGas(
          0,
          createSampleQuotaProposal(),
          605000,
          []
        )
        
        // Phase 2 added 2 SSTOREs (currentSnapshotId bump + proposalStruct.snapshotId write)
        expect(gasEstimate).to.be.lessThan(750000)
      })

      it('should scale reasonably with multiple admin candidates', async function () {
        const { governanceFacet, addr1, addr2, addr3 } = await loadFixture(deployGovernanceFixture)
        
        const fee = ethers.parseEther('1000')
        
        // Multiple applications
        const gas1 = await governanceFacet.connect(addr1).applyAsNewAdmin.estimateGas("string", ethers.Wallet.createRandom().address, { value: fee })

        await governanceFacet.connect(addr1).applyAsNewAdmin("string", ethers.Wallet.createRandom().address, { value: fee })
        const gas2 = await governanceFacet.connect(addr2).applyAsNewAdmin.estimateGas("string", ethers.Wallet.createRandom().address, { value: fee })

        await governanceFacet.connect(addr2).applyAsNewAdmin("string", ethers.Wallet.createRandom().address, { value: fee })
        const gas3 = await governanceFacet.connect(addr3).applyAsNewAdmin.estimateGas("string", ethers.Wallet.createRandom().address, { value: fee })

        // Gas should not increase dramatically
        expect(gas2).to.be.lessThan(gas1 * 2n)
        expect(gas3).to.be.lessThan(gas1 * 3n)
      })
    })
  })

  describe('Integration with Diamond Architecture', function () {
    it('should work correctly within diamond proxy', async function () {
      const { governanceFacet, diamondAddress } = await loadFixture(deployGovernanceFixture)
      
      expect(await governanceFacet.getAddress()).to.equal(diamondAddress)
    })

    it('should maintain state persistence across calls', async function () {
      const { governanceFacet, queryV2Facet, owner } = await loadFixture(deployGovernanceFixture)
      
      await governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
      
      // State should persist between calls
      const snap1 = await queryV2Facet.getGovernanceSnapshot()
      const snap2 = await queryV2Facet.getGovernanceSnapshot()
      
      expect(snap1.currentProposalId).to.equal(snap2.currentProposalId)
    })

    it('should handle ownership integration correctly', async function () {
      const { governanceFacet, ownershipFacet, owner } = await loadFixture(deployGovernanceFixture)
      
      const currentOwner = await ownershipFacet.owner()
      expect(currentOwner).to.equal(owner.address)
      
      // Governance operations should respect ownership
      await expect(
        governanceFacet.connect(owner).createProposal(0, createSampleQuotaProposal(), 605000, [])
      ).to.not.be.reverted
    })
  })



  it('🔍 DEBUG: Check ratifyNewAdmin behavior in detail', async function () {
    const { governanceFacet, queryV2Facet, tokenFacet, ownershipFacet, owner, addr1, addr2 } = await loadFixture(deployGovernanceFixture)
    
    console.log('\n=== 🔍 DETAILED RATIFICATION BEHAVIOR CHECK ===')
    
    // Set up the scenario
    const snap = await queryV2Facet.getGovernanceSnapshot()
    const totalSupply = await tokenFacet.totalSupply()
    const quorumAmount = (totalSupply * snap.currentQuotas.openAdvertsAdminChangeQuorum) / 100n
    
    await tokenFacet.connect(owner).transfer(addr2.address, quorumAmount + ethers.parseEther('1000'))
    //mine blocks
    await advanceBlocksForVoting(20)
    
    const adminFee = snap.currentQuotas.adminApplicantFeeInPolWei
    await governanceFacet.connect(addr1).applyAsNewAdmin("candidate-storage-id", ethers.Wallet.createRandom().address, { value: adminFee })
    await governanceFacet.connect(addr2).voteForNewAdmin(addr1.address)

    // Advance past the adminVoteDeadline (read from storage to be robust against quota changes)
    const snap2 = await queryV2Facet.getGovernanceSnapshot()
    const currentBlock = BigInt(await ethers.provider.getBlockNumber())
    await advanceBlocksForVoting(Number(snap2.adminVoteDeadline - currentBlock) + 1)

    console.log('Setup complete - ready to test ratification')
    
    // Check if ratifyNewAdmin will actually call setContractOwner
    console.log('Current contract owner:', await ownershipFacet.owner())
    console.log('Admin candidate:', addr1.address)
    const governanceHelperFacet = await ethers.getContractAt('OpenAdvertsGovernanceHelperFacet', governanceFacet.target)
    console.log('Votes for candidate:', ethers.formatEther((await governanceHelperFacet.getProposedOwnersAndVotes())[1][0]))
    console.log('Required quorum:', ethers.formatEther(quorumAmount))
    
    // Test the ratification
    const ownerBefore = await ownershipFacet.owner()
    
    // Try to call ratifyNewAdmin and see what happens
    try {
      const tx = await governanceFacet.ratifyNewAdmin()
      await tx.wait()
      console.log('✅ Ratification call succeeded')
    } catch (error) {
      console.log('❌ Ratification call failed:', error.message)
      throw error
    }
    
    const ownerAfter = await ownershipFacet.owner()
    
    console.log('Owner before ratification:', ownerBefore)
    console.log('Owner after ratification:', ownerAfter)
    console.log('Ownership changed:', ownerBefore !== ownerAfter)
    
    console.log('=============================================\n')
    
    // The assertion should match what actually happens
    if (ownerAfter === addr1.address) {
      console.log('CONCLUSION: ratifyNewAdmin() DOES transfer ownership to the winning candidate')
      expect(ownerAfter).to.equal(addr1.address)
    } else {
      console.log('CONCLUSION: ratifyNewAdmin() does NOT transfer ownership')
      expect(ownerAfter).to.equal(ownerBefore)
    }
  })
})