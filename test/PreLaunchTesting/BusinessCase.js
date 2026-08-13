const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

const { deployDiamond } = require('../../scripts/deploy.js')
const gate = require('../helpers/signatureGate.js')

/**
 * Advance blocks to bypass voting delay protection
 */
async function advanceBlocksForVoting(blocks = 15) {
    console.log(`⏭️  Advancing ${blocks} blocks for flash loan protection...`);
    await mine(blocks);
}

/**
 * Calculate breakeven and profitability thresholds
 */
function calculateBreakevenPercentages(bountyUSD, gasPerSig, gasPriceGwei = 30, polPrice = 0.25) {
  const gasCostUSD = Number(gasPerSig) * gasPriceGwei * 1e-9 * polPrice
  
  // Breakeven: Revenue = Gas Cost
  // bountyUSD * (claimPct / 100) = gasCostUSD
  // claimPct = (gasCostUSD / bountyUSD) * 100
  const breakevenPct = (gasCostUSD / bountyUSD) * 100
  
  // 2x Gas Recovery: Revenue = 2 * Gas Cost
  // bountyUSD * (claimPct / 100) = 2 * gasCostUSD
  // claimPct = (2 * gasCostUSD / bountyUSD) * 100
  const twoXGasPct = (2 * gasCostUSD / bountyUSD) * 100
  
  return {
    gasCostUSD,
    breakevenPct,
    twoXGasPct
  }
}

describe('Business Case Analysis: Gas Costs & Profitability', function () {
  
  /**
   * Deploy fixture for business case testing
   * Sets up all necessary contracts and test accounts
   */
  async function deployBusinessCaseFixture() {
    const allSigners = await ethers.getSigners()
    const [owner, advertiser, affiliate1, affiliate2, affiliate3, viewer, voter1, voter2, voter3, ...thirdParties] = allSigners
    
    // Keep fixture deterministic and avoid draining shared signers across long suite runs.
    console.log('\n💰 Using default funded hardhat accounts (no idle-account top-ups)')

    // ✅ CREATE 3 SEPARATE SIGNING ADDRESSES (Accounts 8, 9, 10)
    const PRIVATE_KEY_1 = ethers.Wallet.createRandom().privateKey // Account 8
    const PRIVATE_KEY_2 = ethers.Wallet.createRandom().privateKey // Account 9
    const PRIVATE_KEY_3 = ethers.Wallet.createRandom().privateKey // Account 10
    
    const signingAddress1 = new ethers.Wallet(PRIVATE_KEY_1, ethers.provider)
    const signingAddress2 = new ethers.Wallet(PRIVATE_KEY_2, ethers.provider)
    const signingAddress3 = new ethers.Wallet(PRIVATE_KEY_3, ethers.provider)
    
    console.log('\n🎯 BUSINESS CASE TEST SETUP')
    console.log('═══════════════════════════════════════════════════════')
    console.log(`🔑 Signing Address 1 (50%): ${signingAddress1.address}`)
    console.log(`🔑 Signing Address 2 (75%): ${signingAddress2.address}`)
    console.log(`🔑 Signing Address 3 (90%): ${signingAddress3.address}`)
    
    // ✅ REMOVED: Address verification - not needed, just need uniqueness
    // The important thing is each affiliate has a different signing address
    
    console.log('\n📍 DEPLOYING DIAMOND CONTRACT SYSTEM')
    console.log('═══════════════════════════════════════════════════════')
    
    // Deploy the Diamond with all facets
    const deployedAddresses = await deployDiamond()
    const diamondAddress = deployedAddresses.diamond
    console.log(`✅ Diamond deployed at: ${diamondAddress}`)
    
    // Get contract interfaces
    const governanceFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress)
    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const affiliatesFacet = await ethers.getContractAt('OpenAdvertsAffiliatesFacet', diamondAddress)
    const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
    const advertVotingFacet = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
    const polFactoryFacet = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet', diamondAddress)
    const payoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress)
    
    console.log('✅ All facets loaded')
    
    // ✅ DEPLOY ALL MOCK CLAIM PROVIDERS (50%, 75%, 90%) WITH UNIQUE SIGNING ADDRESSES
    console.log('\n🔧 DEPLOYING MOCK CLAIM PERCENTAGES PROVIDERS')
    console.log('═══════════════════════════════════════════════════════')

    const mockClaimProviders = {}

    // Deploy 50% viewer claim provider
    const MockClaimProvider50 = await ethers.getContractFactory('contracts/MockClaimPercentagesProviderAt75.sol:MockClaimPercentagesProvider')
    const mockClaimProvider50 = await MockClaimProvider50.deploy()
    await mockClaimProvider50.waitForDeployment()
    mockClaimProviders['50'] = {
      contract: mockClaimProvider50,
      address: await mockClaimProvider50.getAddress(),
      affiliateSigner: affiliate1,
      signingAddress: signingAddress1 // ✅ Unique signing address
    }

    // Deploy 75% viewer claim provider
    const MockClaimProvider75 = await ethers.getContractFactory('contracts/MockClaimPercentagesProviderAt75.sol:MockClaimPercentagesProvider')
    const mockClaimProvider75 = await MockClaimProvider75.deploy()
    await mockClaimProvider75.waitForDeployment()
    mockClaimProviders['75'] = {
      contract: mockClaimProvider75,
      address: await mockClaimProvider75.getAddress(),
      affiliateSigner: affiliate2,
      signingAddress: signingAddress2 // ✅ Unique signing address
    }

    // Deploy 90% viewer claim provider
    const MockClaimProvider90 = await ethers.getContractFactory('contracts/MockClaimPercentagesProviderAt90.sol:MockClaimPercentagesProvider')
    const mockClaimProvider90 = await MockClaimProvider90.deploy()
    await mockClaimProvider90.waitForDeployment()
    mockClaimProviders['90'] = {
      contract: mockClaimProvider90,
      address: await mockClaimProvider90.getAddress(),
      affiliateSigner: affiliate3,
      signingAddress: signingAddress3 // ✅ Unique signing address
    }

    // Display all providers
    for (const [percentage, provider] of Object.entries(mockClaimProviders)) {
      const percentages = await provider.contract.getClaimPercentages()
      console.log(`\n📊 MockClaimProvider@${percentage}:`)
      console.log(`   Address: ${provider.address}`)
      console.log(`   Affiliate: ${provider.affiliateSigner.address}`)
      console.log(`   Signing Address: ${provider.signingAddress.address}`)
      console.log(`   Viewer: ${percentages[1]}%`)
      console.log(`   Affiliate: ${percentages[0]}%`)
      console.log(`   Third Parties (count=${percentages[2]}): ${percentages[3]}`)
    }
    
    console.log('\n👥 TEST ACCOUNT ADDRESSES')
    console.log('═══════════════════════════════════════════════════════')
    console.log(`📍 Owner: ${owner.address}`)
    console.log(`📍 Advertiser: ${advertiser.address}`)
    console.log(`📍 Affiliate1 (50%): ${affiliate1.address}`)
    console.log(`📍 Affiliate2 (75%): ${affiliate2.address}`)
    console.log(`📍 Affiliate3 (90%): ${affiliate3.address}`)
    console.log(`📍 Viewer: ${viewer.address}`)
    console.log(`📍 Voter1: ${voter1.address}`)
    console.log(`📍 Voter2: ${voter2.address}`)
    console.log(`📍 Voter3: ${voter3.address}`)
    console.log(`📍 Signing Address 1: ${signingAddress1.address}`)
    console.log(`📍 Signing Address 2: ${signingAddress2.address}`)
    console.log(`📍 Signing Address 3: ${signingAddress3.address}`)
    console.log(`📍 Third Party Addresses: ${thirdParties.length} available`)
    console.log('═══════════════════════════════════════════════════════\n')
    // Register a default protocol signer so website-gated creates pass before any reward scenario.
    await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress1.address)    
    return {
      diamondAddress,
      governanceFacet,
      tokenFacet,
      affiliatesFacet,
      advertisersFacet,
      advertVotingFacet,
      polFactoryFacet,
      payoutFacet,
      mockClaimProviders, // ✅ Includes signingAddress for each provider
      owner,
      advertiser,
      viewer,
      signingAddress1, // ✅ Return all 3 signing addresses
      signingAddress2,
      signingAddress3,
      voter1,
      voter2,
      voter3,
      thirdParties
    }
  }

  describe('Setup Phase: Deploy Contracts & Approve Participants', function () {
    
    it('BC1: Should deploy Diamond and initialize governance tokens', async function () {
      const {
        diamondAddress,
        tokenFacet,
        owner,
        voter1,
        voter2,
        voter3,
        advertiser
      } = await loadFixture(deployBusinessCaseFixture)

      console.log('\n📊 STEP 1: DISTRIBUTING GOVERNANCE TOKENS')
      console.log('═══════════════════════════════════════════════════════')

      // Distribute voting tokens to participants
      const voterTokens = ethers.parseEther('5000000') // 5M tokens each
      
      console.log(`💰 Distributing ${ethers.formatEther(voterTokens)} OAD tokens to each voter...`)
      
      const tx1 = await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
      const receipt1 = await tx1.wait()
      console.log(`✅ Voter1 tokens transferred (Gas: ${receipt1.gasUsed.toString()})`)
      
      const tx2 = await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
      const receipt2 = await tx2.wait()
      console.log(`✅ Voter2 tokens transferred (Gas: ${receipt2.gasUsed.toString()})`)
      
      const tx3 = await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)
      const receipt3 = await tx3.wait()
      console.log(`✅ Voter3 tokens transferred (Gas: ${receipt3.gasUsed.toString()})`)
      
      const tx4 = await tokenFacet.connect(owner).transfer(advertiser.address, voterTokens)
      const receipt4 = await tx4.wait()
      console.log(`✅ Advertiser tokens transferred (Gas: ${receipt4.gasUsed.toString()})`)

      // Verify balances
      const voter1Balance = await tokenFacet.balanceOf(voter1.address)
      const voter2Balance = await tokenFacet.balanceOf(voter2.address)
      const voter3Balance = await tokenFacet.balanceOf(voter3.address)
      const advertiserBalance = await tokenFacet.balanceOf(advertiser.address)
      const ownerBalance = await tokenFacet.balanceOf(owner.address)

      console.log('\n📈 GOVERNANCE TOKEN DISTRIBUTION:')
      console.log(`   Owner: ${ethers.formatEther(ownerBalance)} OAD`)
      console.log(`   Voter1: ${ethers.formatEther(voter1Balance)} OAD`)
      console.log(`   Voter2: ${ethers.formatEther(voter2Balance)} OAD`)
      console.log(`   Voter3: ${ethers.formatEther(voter3Balance)} OAD`)
      console.log(`   Advertiser: ${ethers.formatEther(advertiserBalance)} OAD`)

      expect(voter1Balance).to.equal(voterTokens)
      expect(voter2Balance).to.equal(voterTokens)
      expect(voter3Balance).to.equal(voterTokens)
      expect(advertiserBalance).to.equal(voterTokens)

      console.log('\n⛽ GAS COST SUMMARY - TOKEN DISTRIBUTION:')
      console.log('═══════════════════════════════════════════════════════')
      console.log(`   Total Gas: ${(receipt1.gasUsed + receipt2.gasUsed + receipt3.gasUsed + receipt4.gasUsed).toString()} gas`)
      console.log('═══════════════════════════════════════════════════════\n')
    })

    it('BC2: Should create and approve affiliates for all claim percentages (50%, 75%, 90%)', async function () {
      const {
        affiliatesFacet,
        mockClaimProviders,
        owner,
        voter1,
        voter2,
        voter3,
        tokenFacet,
        diamondAddress,
        signingAddress1
      } = await loadFixture(deployBusinessCaseFixture)

      // Distribute tokens first
      const voterTokens = ethers.parseEther('5000000')
      await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
      await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
      await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)

      console.log('\n🤝 STEP 2: CREATE AND APPROVE AFFILIATES FOR ALL CLAIM SCENARIOS')
      console.log('═══════════════════════════════════════════════════════')

      const affiliateVotingFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet', await affiliatesFacet.getAddress())
      const approvedAffiliates = {}

      for (const [percentage, provider] of Object.entries(mockClaimProviders)) {
        console.log(`\n📝 Creating affiliate with ${percentage}% viewer claim...`)
        console.log(`   Affiliate Address: ${provider.affiliateSigner.address}`)
        console.log(`   Claim Provider: ${provider.address}`)
        console.log(`   Signing Address: ${provider.signingAddress.address}`) // ✅ Show unique signing address
        
        const affiliateStorageId = `business-case-affiliate-${percentage}pct`
                
        // ✅ FIX: Use provider's unique signing address
        const createAffiliateTx = await affiliatesFacet.connect(provider.affiliateSigner).createProspectAffiliateContract(
          provider.affiliateSigner.address,
          provider.address,
          provider.signingAddress.address, // ✅ CHANGED: Use unique signing address
          affiliateStorageId,
          ...(await gate.affiliate(signingAddress1, diamondAddress, provider.affiliateSigner.address)))
        
        const createAffiliateReceipt = await createAffiliateTx.wait()
        console.log(`✅ Prospect created (Gas: ${createAffiliateReceipt.gasUsed.toString()})`)

        // Advance blocks
        await advanceBlocksForVoting(15)

        // Vote to approve
        await affiliateVotingFacet.connect(voter1).voteOnAffiliate(provider.affiliateSigner.address, true)
        await affiliateVotingFacet.connect(voter2).voteOnAffiliate(provider.affiliateSigner.address, true)
        await affiliateVotingFacet.connect(voter3).voteOnAffiliate(provider.affiliateSigner.address, true)

        // Verify approval
        const affiliateStatus = await affiliatesFacet.getAffiliateStatus(provider.affiliateSigner.address)
        expect(affiliateStatus).to.equal(1)
        
        console.log(`✅ Affiliate approved for ${percentage}% viewer claim`)
        
        approvedAffiliates[percentage] = {
          address: provider.affiliateSigner.address,
          claimProvider: provider.address,
          signingAddress: provider.signingAddress.address, // ✅ Store signing address
          storageId: affiliateStorageId
        }
      }

      console.log('\n✅ ALL AFFILIATES APPROVED')
      console.log('═══════════════════════════════════════════════════════\n')
    })

    it('BC3: Should create and approve POL advertisements at different bounty levels', async function () {
      const {
        polFactoryFacet,
        advertisersFacet,
        advertVotingFacet,
        governanceFacet,
        tokenFacet,
        owner,
        advertiser,
        voter1,
        voter2,
        voter3,
        diamondAddress,
        signingAddress1
      } = await loadFixture(deployBusinessCaseFixture)

      // Distribute tokens
      const voterTokens = ethers.parseEther('5000000')
      await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
      await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
      await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)
      await tokenFacet.connect(owner).transfer(advertiser.address, voterTokens)

      console.log('\n📺 STEP 3: CREATE POL ADVERTISEMENTS AT DIFFERENT BOUNTY LEVELS')
      console.log('═══════════════════════════════════════════════════════')

      const currentQuotas = await governanceFacet.getAllCurrentQuotas()
      
      console.log('\n🔍 GOVERNANCE QUOTAS:')
      console.log(`   Min Bounty: ${ethers.formatEther(currentQuotas.minAdvertBountyInPOLWei)} POL`)
      console.log(`   Min Funding: ${ethers.formatEther(currentQuotas.minPOLRequiredforAdvertInWei)} POL`)
      
      // ✅ BOUNTY LEVELS (POL @ $0.25 USD)
      const bountyLevels = [
        {
          name: "Google Display Network",
          targetUSD: 0.015,
          bountyPOL: ethers.parseEther("0.06"), // 0.06 POL = $0.015 (governance minimum)
          fundingPOL: currentQuotas.minPOLRequiredforAdvertInWei
        },
        {
          name: "Custom Rate",
          targetUSD: 0.03,
          bountyPOL: ethers.parseEther("0.12"), // 0.12 POL = $0.03
          fundingPOL: currentQuotas.minPOLRequiredforAdvertInWei
        },
        {
          name: "YouTube CPV",
          targetUSD: 0.06,
          bountyPOL: ethers.parseEther("0.24"), // 0.24 POL = $0.06
          fundingPOL: currentQuotas.minPOLRequiredforAdvertInWei
        }
      ]

      const deployedAdverts = []

      for (let i = 0; i < bountyLevels.length; i++) {
        const level = bountyLevels[i]
        
        console.log(`\n📋 CREATING ADVERTISEMENT ${i + 1}/3: ${level.name}`)
        console.log('───────────────────────────────────────────────────────')
        console.log(`   Target USD: $${level.targetUSD.toFixed(4)} per signature`)
        console.log(`   Bounty POL: ${ethers.formatEther(level.bountyPOL)} POL`)
        
        // ✅ FIX: Add email parameter and match correct function signature
        const createTx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
          `business-case-advert-${i + 1}`,
          level.bountyPOL,
          1,
          ethers.ZeroAddress, // ✅ ADD: email parameter
          ...(await gate.pol(signingAddress1, diamondAddress, advertiser.address)),
          { value: level.fundingPOL }
        )
        
        const createReceipt = await createTx.wait()
        
        const createEvent = createReceipt.logs.find(log => {
          try {
            const parsed = polFactoryFacet.interface.parseLog(log)
            return parsed.name === 'POLAdvertisementCreatedAndValidated'
          } catch {
            return false
          }
        })
        
        const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvent).args.advertContract
        
        console.log(`✅ Created at: ${polAdvertAddress}`)

        await advanceBlocksForVoting(15)

        await advertVotingFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true)
        await advertVotingFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true)
        await advertVotingFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true)

        const [, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
        expect(status).to.equal(1)

        deployedAdverts.push({
          ...level,
          address: polAdvertAddress,
          contract: await ethers.getContractAt('OpenAdvertsAdvertPOL', polAdvertAddress)
        })
      }

      console.log('\n✅ ALL ADVERTISEMENTS DEPLOYED')
      console.log('═══════════════════════════════════════════════════════\n')
    })
  })

  describe('Gas Analysis Phase: ProcessReward Testing with Different Claim %', function () {
    
    // ✅ BC4: Test 20 signatures at 50% viewer claim
    it('BC4: Should test 20 signatures with 50% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 20,
        viewerClaimPct: '50',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC4'
      })
    }).timeout(300000)

    // ✅ BC5: Test 20 signatures at 75% viewer claim
    it('BC5: Should test 20 signatures with 75% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 20,
        viewerClaimPct: '75',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC5'
      })
    }).timeout(300000)

    // ✅ BC6: Test 20 signatures at 90% viewer claim
    it('BC6: Should test 20 signatures with 90% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 20,
        viewerClaimPct: '90',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC6'
      })
    }).timeout(300000)

    // ✅ BC7-9: Test different batch sizes at 50% claim
    it('BC7: Should test 30 signatures with 50% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 30,
        viewerClaimPct: '50',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC7'
      })
    }).timeout(300000)

    it('BC8: Should test 40 signatures with 50% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 40,
        viewerClaimPct: '50',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC8'
      })
    }).timeout(300000)

    it('BC9: Should test 50 signatures with 50% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 50,
        viewerClaimPct: '50',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC9'
      })
    }).timeout(300000)

    it('BC10: Should test 60 signatures with 50% viewer claim @ $0.0025 bounty', async function () {
      await testProcessRewardScenario({
        signatureCount: 60,
        viewerClaimPct: '50',
        bountyUSD: 0.015,
        bountyPOL: ethers.parseEther("0.06"),
        testLabel: 'BC10'
      })
    }).timeout(300000)
  })

  // ✅ HELPER FUNCTION: Test processReward scenario
  async function testProcessRewardScenario(params) {
    const {
      polFactoryFacet,
      advertisersFacet,
      advertVotingFacet,
      affiliatesFacet,
      mockClaimProviders,
      tokenFacet,
      payoutFacet,
      owner,
      advertiser,
      viewer,
      voter1,
      voter2,
      voter3,
      thirdParties,
      diamondAddress
    } = await loadFixture(deployBusinessCaseFixture)

    const { signatureCount, viewerClaimPct, bountyUSD, bountyPOL, testLabel } = params

    console.log(`\n🔬 ${testLabel}: ${signatureCount} SIGNATURES @ ${viewerClaimPct}% VIEWER CLAIM`)
    console.log('═══════════════════════════════════════════════════════')

    // Setup tokens
    const voterTokens = ethers.parseEther('5000000')
    await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)
    await tokenFacet.connect(owner).transfer(advertiser.address, voterTokens)

    // ✅ Get the correct affiliate, claim provider, AND signing address
    const claimProviderData = mockClaimProviders[viewerClaimPct]
    const affiliate = claimProviderData.affiliateSigner
    const claimProviderAddress = claimProviderData.address
    const signingAddress = claimProviderData.signingAddress // ✅ Get unique signing address
    
    console.log(`\n📊 Using MockClaimProvider@${viewerClaimPct}:`)
    console.log(`   Provider Address: ${claimProviderAddress}`)
    console.log(`   Affiliate Address: ${affiliate.address}`)
    console.log(`   Signing Address: ${signingAddress.address}`) // ✅ Show unique signing address

    // Ensure global protocol signer matches the wallet used for this scenario's signatures.
    await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress.address)

    // Create and approve affiliate with specific claim %
    const affiliateVotingFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet', await affiliatesFacet.getAddress())
    
    // ✅ FIX: Use unique signing address
    await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
      affiliate.address,
      claimProviderAddress,
      signingAddress.address, // ✅ CHANGED: Use unique signing address
      `${testLabel}-affiliate-${viewerClaimPct}pct`,
      ...(await gate.affiliate(signingAddress, diamondAddress, affiliate.address)))
    
    await advanceBlocksForVoting(15)
    
    await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true)

    const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
    const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

    // Create advertisement
    const minFunding = ethers.parseEther("3000")
    
    console.log(`\n📋 Advertisement Parameters:`)
    console.log(`   Bounty: ${ethers.formatEther(bountyPOL)} POL ($${bountyUSD} @ $0.25/POL)`)
    console.log(`   Viewer gets: ${viewerClaimPct}% = $${(bountyUSD * parseInt(viewerClaimPct) / 100).toFixed(6)} per signature`)

    const createTx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
      `${testLabel}-advert`,
      bountyPOL,
      1,
      designatedAffiliateAddress,
      ...(await gate.pol(signingAddress, diamondAddress, advertiser.address)),
      { value: minFunding }
    )
    
    const createReceipt = await createTx.wait()
    const createEvent = createReceipt.logs.find(log => {
      try {
        const parsed = polFactoryFacet.interface.parseLog(log)
        return parsed.name === 'POLAdvertisementCreatedAndValidated'
      } catch {
        return false
      }
    })
    
    const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvent).args.advertContract
    const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', polAdvertAddress)

    await advanceBlocksForVoting(15)
    
    await advertVotingFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true)
    await advertVotingFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true)
    await advertVotingFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true)

    // Generate signatures
    console.log(`\n✍️  GENERATING ${signatureCount} UNIQUE SIGNATURES`)
    console.log('───────────────────────────────────────────────────────')

    const currentNonce = await polContract.getUserNonceOfAffiliate(designatedAffiliateAddress)
    const currentBlock = await ethers.provider.getBlockNumber()
    
    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: claimProviderAddress,
      affiliateSigningAddress: signingAddress.address, // ✅ CHANGED: Use unique signing address
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      viewerAddress: ethers.ZeroAddress
    }

    const signatures = []
    const blockNumbers = []
    const thirdPartyAddresses = []

    for (let i = 0; i < signatureCount; i++) {
      const blockNumber = currentBlock - (signatureCount - i)
      blockNumbers.push(blockNumber)
      
      const tp1 = thirdParties[i * 3]
      const tp2 = thirdParties[i * 3 + 1]
      const tp3 = thirdParties[i * 3 + 2]
      
      thirdPartyAddresses.push({
        thirdPartyAddresses: [tp1.address, tp2.address, tp3.address]
      })

      const tpAddrs = [tp1.address, tp2.address, tp3.address]
      const tpCount = BigInt(tpAddrs.length)
      const paddedHex = tpAddrs.map(a => ethers.zeroPadValue(a, 32)).join('').replace(/0x/g, '')
      const tpHash = ethers.keccak256('0x' + paddedHex)

      const messageHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "address", "address", "uint256", "bytes32", "uint256"],
        [
          viewer.address,
          BigInt(blockNumber),
          BigInt(verificationData.nonce),
          designatedAffiliateAddress,
          polAdvertAddress,
          tpCount,
          tpHash,
          ethers.parseEther("1")
        ]
      )

      const wallet = new ethers.Wallet(signingAddress.privateKey)
      const signature = await wallet.signMessage(ethers.getBytes(messageHash))
      
      signatures.push(signature)
    }

    console.log(`✅ Generated ${signatureCount} signatures`)

    // Execute processReward
    console.log(`\n⛽ EXECUTING PROCESSREWARD...`)
    
    const processRewardTx = await polContract.connect(viewer).processReward(
      signatures,
      blockNumbers,
      verificationData,
      thirdPartyAddresses
    )
    
    const processRewardReceipt = await processRewardTx.wait()

    // ✅ ANALYZE RESULTS
    const gasUsed = processRewardReceipt.gasUsed
    const gasPerSig = gasUsed / BigInt(signatureCount)
    
    console.log(`\n📊 RESULTS: ${signatureCount} SIGNATURES @ ${viewerClaimPct}% VIEWER CLAIM`)
    console.log('═══════════════════════════════════════════════════════')
    console.log(`⛽ GAS USED: ${gasUsed.toString()} gas`)
    console.log(`   Gas per signature: ${gasPerSig.toString()} gas`)
    
    console.log(`\n💵 GAS COST PER SIGNATURE (POL @ $0.25):`)
    console.log(`───────────────────────────────────────────────────────`)
    console.log(`   @1 gwei:   $${(Number(gasPerSig) * 1e-9 * 0.25).toFixed(6)}`)
    console.log(`   @30 gwei:  $${(Number(gasPerSig) * 30e-9 * 0.25).toFixed(6)}`)
    console.log(`   @200 gwei: $${(Number(gasPerSig) * 200e-9 * 0.25).toFixed(6)}`)
    
    const viewerRevenuePerSig = bountyUSD * parseInt(viewerClaimPct) / 100
    
    console.log(`\n💰 VIEWER PROFITABILITY PER SIGNATURE:`)
    console.log(`───────────────────────────────────────────────────────`)
    console.log(`   Revenue: $${viewerRevenuePerSig.toFixed(6)} (${viewerClaimPct}% of $${bountyUSD})`)
    console.log(`   @1 gwei:   Profit = $${(viewerRevenuePerSig - Number(gasPerSig) * 1e-9 * 0.25).toFixed(6)}`)
    console.log(`   @30 gwei:  Profit = $${(viewerRevenuePerSig - Number(gasPerSig) * 30e-9 * 0.25).toFixed(6)}`)
    console.log(`   @200 gwei: Profit = $${(viewerRevenuePerSig - Number(gasPerSig) * 200e-9 * 0.25).toFixed(6)}`)

    // ✅ NEW: BREAKEVEN & PROFITABILITY THRESHOLD ANALYSIS
    console.log(`\n🎯 PROFITABILITY THRESHOLDS @ $${bountyUSD} BOUNTY:`)
    console.log(`───────────────────────────────────────────────────────`)

    // Calculate at different gas prices
    const gasPrices = [
      { label: '@1 gwei', gwei: 1 },
      { label: '@30 gwei', gwei: 30 },
      { label: '@200 gwei', gwei: 200 }
    ]

    for (const { label, gwei } of gasPrices) {
      const analysis = calculateBreakevenPercentages(bountyUSD, gasPerSig, gwei, 0.25)
      
      console.log(`\n   ${label}:`)
      console.log(`      Gas Cost: $${analysis.gasCostUSD.toFixed(6)}`)
      console.log(`      Breakeven at: ${analysis.breakevenPct.toFixed(2)}% viewer claim`)
      console.log(`      2x Gas Recovery at: ${analysis.twoXGasPct.toFixed(2)}% viewer claim`)
      
      // Show if current claim % is profitable
      const currentClaimPct = parseInt(viewerClaimPct)
      if (currentClaimPct >= analysis.twoXGasPct) {
        console.log(`      ✅ Current ${currentClaimPct}% is HIGHLY PROFITABLE (>2x gas recovery)`)
      } else if (currentClaimPct >= analysis.breakevenPct) {
        console.log(`      ✅ Current ${currentClaimPct}% is PROFITABLE`)
      } else {
        console.log(`      ❌ Current ${currentClaimPct}% is UNPROFITABLE (need ${analysis.breakevenPct.toFixed(2)}% to breakeven)`)
      }
    }

    // ✅ SUMMARY TABLE
    console.log(`\n📈 MINIMUM VIEWER CLAIM % NEEDED FOR PROFITABILITY:`)
    console.log(`───────────────────────────────────────────────────────`)
    console.log(`   Bounty: ${ethers.formatEther(bountyPOL)} POL ($${bountyUSD} USD)`)
    console.log(`   Gas per sig: ${gasPerSig.toString()} gas`)
    console.log(``)
    console.log(`   Gas Price  │ Breakeven % │ 2x Recovery % │ Current (${viewerClaimPct}%)`)
    console.log(`   ───────────┼─────────────┼───────────────┼──────────────`)

    for (const { gwei } of gasPrices) {
      const analysis = calculateBreakevenPercentages(bountyUSD, gasPerSig, gwei, 0.25)
      const currentClaimPct = parseInt(viewerClaimPct)
      
      let status = '❌ Loss'
      if (currentClaimPct >= analysis.twoXGasPct) {
        status = '✅ 2x+'
      } else if (currentClaimPct >= analysis.breakevenPct) {
        status = '✅ Profit'
      }
      
      console.log(`   ${gwei.toString().padStart(4)} gwei  │   ${analysis.breakevenPct.toFixed(2).padStart(6)}% │     ${analysis.twoXGasPct.toFixed(2).padStart(6)}% │ ${status}`)
    }

    console.log('═══════════════════════════════════════════════════════\n')
  }
})