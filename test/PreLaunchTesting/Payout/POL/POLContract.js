const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const { deployDiamond } = require('../../../../scripts/deploy.js')
const gate = require('../../../helpers/signatureGate.js')

async function advanceBlocksForVoting(blocks = 15) {
    console.log(`â­ï¸  Advancing ${blocks} blocks for flash loan protection...`);
    await mine(blocks);
}

describe('POLContract: processReward Functionality Tests', function () {

  // Captured once during fixture deploy; reused by the createSignature closure.
  let _diamondAddr

  async function deployTestFixture() {
    const allSigners = await ethers.getSigners();
    const [owner, advertiser, advertiser2, affiliate, affiliate2, user, attacker, voter1, voter2, voter3] = allSigners;
    
    // Use default hardhat balances to avoid draining shared signers across the full suite.
    console.log('\nðŸ’° Using default funded hardhat accounts (no idle-account top-ups)\n');

    // Create custom signing address with your private key
    const PRIVATE_KEY = ethers.Wallet.createRandom().privateKey
    const signingAddress = new ethers.Wallet(PRIVATE_KEY, ethers.provider)
    
    console.log(`ðŸ”‘ Created custom signing address: ${signingAddress.address}`)
    // Signer is a random per-run wallet; its address is registered on-chain below.
    
    // Deploy the Diamond with all facets
    const deployedAddresses = await deployDiamond()
    const diamondAddress = deployedAddresses.diamond
    _diamondAddr = diamondAddress
    
    // Get contract interfaces
    const governanceFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress)
    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const affiliatesFacet = await ethers.getContractAt('OpenAdvertsAffiliatesFacet', diamondAddress)
    const affiliateVotingFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet', diamondAddress)
    const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
    const polFactoryFacet = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet', diamondAddress)
    const payoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress)

    // Ensure signatures in this suite are validated against the local test signing wallet.
    await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress.address)
    
    // Deploy MockClaimPercentagesProvider with fully qualified name
    console.log('ðŸ”§ Deploying MockClaimPercentagesProvider...')
    const MockClaimPercentagesProvider = await ethers.getContractFactory(
      'contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider'
    )
    const mockClaimProvider = await MockClaimPercentagesProvider.deploy()
    await mockClaimProvider.waitForDeployment()
    
    const mockClaimProviderAddress = await mockClaimProvider.getAddress()
    console.log(`âœ… MockClaimPercentagesProvider deployed at: ${mockClaimProviderAddress}`)
    const percentages = await mockClaimProvider.getClaimPercentages()
    console.log("Claim percentages:", percentages)
    
    console.log('\nðŸŽ­ POL CONTRACT TEST SETUP')
    console.log(`ðŸ“ Diamond Address: ${diamondAddress}`)
    console.log(`ðŸ“ Owner: ${owner.address}`)
    console.log(`ðŸ“ Advertiser: ${advertiser.address}`)
    console.log(`ðŸ“ Affiliate: ${affiliate.address}`)
    console.log(`ðŸ“ Signing Address: ${signingAddress.address}`)
    console.log(`ðŸ“ User: ${user.address}`)
    console.log(`ðŸ“ Attacker: ${attacker.address}`)
    console.log(`ðŸ“ MockClaimProvider: ${mockClaimProviderAddress}`)
    
    // Deploy malicious reentrancy contract
    console.log('ðŸš¨ Deploying malicious reentrancy contract...')
    const MaliciousReentrancy = await ethers.getContractFactory('MaliciousReentrancy')
    const maliciousContract = await MaliciousReentrancy.connect(attacker).deploy()
    await maliciousContract.waitForDeployment()
    
    const maliciousAddress = await maliciousContract.getAddress()
    console.log(`ðŸš¨ Malicious contract deployed at: ${maliciousAddress}`)
    
    // Configure malicious contract
    await maliciousContract.connect(attacker).setTargets(diamondAddress)
    await maliciousContract.connect(attacker).setAttackDepth(3)
    
    // Fund malicious contract
    await attacker.sendTransaction({
      to: maliciousAddress,
      value: ethers.parseEther('100')
    })
    
    return {
      diamondAddress,
      governanceFacet,
      tokenFacet,
      affiliatesFacet,
      affiliateVotingFacet,
      advertisersFacet,
      polFactoryFacet,
      payoutFacet,
      maliciousContract,
      maliciousAddress,
      mockClaimProvider,
      mockClaimProviderAddress,
      owner,
      advertiser,
      advertiser2,
      affiliate,
      affiliate2,
      signingAddress,
      user,
      attacker,
      voter1,
      voter2,
      voter3
    }
  }

  // =====================================================
  // SHARED HELPER FUNCTIONS
  // =====================================================

  async function setupApprovedAdvertisement(fixture) {
    const {
      diamondAddress,
      tokenFacet,
      affiliatesFacet,
      affiliateVotingFacet,
      advertisersFacet,
      polFactoryFacet,
      mockClaimProviderAddress,
      owner,
      advertiser,
      affiliate,
      signingAddress,
      voter1,
      voter2,
      voter3
    } = fixture

    // Step 1: Distribute voting tokens
    const voterTokens = ethers.parseEther('5000000')
    await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
    await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)
    await tokenFacet.connect(owner).transfer(advertiser.address, voterTokens)

    // Step 2: Create and approve affiliate
    await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
      affiliate.address,
      mockClaimProviderAddress,
      signingAddress.address,
      "test-affiliate-001",
      ...(await gate.affiliate(signingAddress, diamondAddress, affiliate.address)))

    await advanceBlocksForVoting(15)

    await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true)
    await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true)

    const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
    const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

    // Step 3: Create POL advertisement
    const advertBounty = ethers.parseEther('1')
    const fundingAmount = ethers.parseEther('4000')
    const minBlockSeparation = 1
    const excludedAffiliates = []

    const createAdvertTx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
      "test-pol-advert-001",
      advertBounty,
      minBlockSeparation,
      designatedAffiliateAddress,
      ...(await gate.pol(signingAddress, diamondAddress, advertiser.address)),
      { value: fundingAmount }
    )

    const createAdvertReceipt = await createAdvertTx.wait()
    
    const createEvent = createAdvertReceipt.logs.find(log => {
      try {
        const parsed = polFactoryFacet.interface.parseLog(log)
        return parsed.name === 'POLAdvertisementCreatedAndValidated'
      } catch {
        return false
      }
    })
    
    const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvent).args.advertContract

    // Step 4: Approve advertisement
    const advertVotingFacet = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
    
    await advanceBlocksForVoting(15)

    await advertVotingFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true)
    await advertVotingFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true)
    await advertVotingFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true)

    const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', polAdvertAddress)

    return {
      polAdvertAddress,
      polContract,
      designatedAffiliateAddress,
      advertBounty,
      fundingAmount,
      minBlockSeparation
    }
  }

  async function createSignature(signer, blockNumber, verificationData, polAdvertAddress, userAddress, thirdPartyAddresses, amount = ethers.parseEther("1")) {
    const tpAddrs = thirdPartyAddresses.thirdPartyAddresses;
    const tpCount = BigInt(tpAddrs.length);

    // keccak256(abi.encodePacked(address[])) where Solidity pads each address to 32 bytes
    // (equivalent to keccak256 of abi.encode(address[]) without the outer offset/length)
    const paddedHex = tpAddrs.map(a => ethers.zeroPadValue(a, 32)).join('').replace(/0x/g, '');
    const tpHash = ethers.keccak256('0x' + paddedHex);

    // keccak256(abi.encodePacked(...)) â€” outer hash matching Solidity _verifySignatures
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "address", "address", "uint256", "bytes32", "uint256"],
      [chainId, _diamondAddr, userAddress, BigInt(blockNumber), BigInt(verificationData.nonce),
       verificationData.affiliateReceivingAddress, polAdvertAddress,
       tpCount, tpHash, amount]
    );

    const wallet = new ethers.Wallet(signer.privateKey);
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));
    return signature;
  }

  // =====================================================
  // TEST 1: Process Rewards on APPROVED Advertisement
  // =====================================================

  it('R0: Should persist initial POL funded budget in advert contract and Diamond storage', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const { advertisersFacet } = fixture

    const { polAdvertAddress, polContract, fundingAmount } = await setupApprovedAdvertisement(fixture)

    const contractInitialBudget = await polContract.getInitialFundedBudgetWei()
    expect(contractInitialBudget).to.equal(fundingAmount)

    const diamondInitialBudget = await advertisersFacet.getAdvertisementInitialFundedBudget(polAdvertAddress)
    expect(diamondInitialBudget).to.equal(fundingAmount)

    const storedVariables = await polContract.getAllContractVariables()
    expect(storedVariables.rspInitialFundedBudget).to.equal(fundingAmount)
  })

  it('R-SEC: ignores caller-supplied affiliateClaimInfoAddress and uses the affiliate-registered provider (claim-info substitution fix)', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const { user, signingAddress } = fixture

    const { polAdvertAddress, polContract, designatedAffiliateAddress } = await setupApprovedAdvertisement(fixture)

    // Deploy a ROGUE provider: same thirdPartyCount (3) as the affiliate's registered provider,
    // but the split is reallocated 100% to the viewer (affiliate 0%, third parties 0%).
    const Rogue = await ethers.getContractFactory('MockRogueClaimProvider')
    const rogue = await Rogue.deploy()
    await rogue.waitForDeployment()
    const rogueAddress = await rogue.getAddress()

    // Three distinct third-party recipients (fresh EOAs so push transfers succeed cleanly).
    const tp1 = '0x00000000000000000000000000000000000000A1'
    const tp2 = '0x00000000000000000000000000000000000000A2'
    const tp3 = '0x00000000000000000000000000000000000000A3'
    const thirdPartyAddresses = { thirdPartyAddresses: [tp1, tp2, tp3] }

    const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)

    // Attacker (the redeeming viewer) points affiliateClaimInfoAddress at the ROGUE provider.
    // The honest signature below is issued for the real, registered split (20/20/[20,20,20]).
    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: rogueAddress, // ← malicious substitution attempt
      affiliateSigningAddress: signingAddress.address,
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      viewerAddress: user.address
    }

    const currentBlock = await ethers.provider.getBlockNumber()
    const blockNumbers = [currentBlock]
    const sig = await createSignature(
      signingAddress,
      currentBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )
    const signatures = [sig]

    const bounty = ethers.parseEther('1')
    const affBefore = await ethers.provider.getBalance(designatedAffiliateAddress)
    const tp1Before = await ethers.provider.getBalance(tp1)
    const tp2Before = await ethers.provider.getBalance(tp2)
    const tp3Before = await ethers.provider.getBalance(tp3)

    await polContract.connect(user).processReward(
      signatures,
      blockNumbers,
      verificationData,
      [thirdPartyAddresses]
    )

    const affAfter = await ethers.provider.getBalance(designatedAffiliateAddress)
    const tp1After = await ethers.provider.getBalance(tp1)
    const tp2After = await ethers.provider.getBalance(tp2)
    const tp3After = await ethers.provider.getBalance(tp3)

    // If the rogue substitution had taken effect, affiliate and third parties would receive ZERO
    // (viewer 100%). Assert they were paid the REGISTERED provider's shares → substitution ignored.
    const expectedShare = (bounty * 6n) / 100n // 6% per registered provider
    expect(affAfter - affBefore).to.equal(expectedShare, 'affiliate must receive registered 6%, not 0')
    expect(tp1After - tp1Before).to.equal(expectedShare, 'third party 1 must receive registered 6%, not 0')
    expect(tp2After - tp2Before).to.equal(expectedShare, 'third party 2 must receive registered 6%, not 0')
    expect(tp3After - tp3Before).to.equal(expectedShare, 'third party 3 must receive registered 6%, not 0')
  })

  it('R1: Should successfully process rewards when advertisement is APPROVED', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const {
      affiliate,
      user,
      voter1,
      voter2,
      voter3,
      signingAddress
    } = fixture

    console.log('\n=== ðŸŽ¯ TEST: Process Rewards on APPROVED Advertisement ===')

    const { polAdvertAddress, polContract, designatedAffiliateAddress } = await setupApprovedAdvertisement(fixture)

    // Verify advertisement is approved
    const [, advertStatus] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    expect(advertStatus).to.equal(1, "Advertisement should be Approved")

    // Get nonce using user.address as tx.origin
    const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    console.log(`ðŸ“ Current nonce for user ${user.address} + affiliate ${affiliate.address}: ${currentNonce}`)

    // Create verification data
    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: fixture.mockClaimProviderAddress,
      affiliateSigningAddress: signingAddress.address,
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      // Note: the contract overwrites this with msg.sender (user.address) on-chain
      viewerAddress: user.address
    }

    const thirdPartyAddresses = {
      thirdPartyAddresses: [voter1.address, voter2.address, voter3.address]
    }

    // Create signatures for current and previous blocks
    const currentBlock = await ethers.provider.getBlockNumber()
    const blockNumbers = [currentBlock, currentBlock - 2] 

    const signatures = []
    for (const blockNum of blockNumbers) {
      const sig = await createSignature(
        signingAddress,
        blockNum,
        verificationData,
        polAdvertAddress,
        user.address,
        thirdPartyAddresses
      )
      signatures.push(sig)
    }

    // Get balances before
    const polBalanceBefore = await polContract.getPOLBalance()
    const affiliateBalanceBefore = await ethers.provider.getBalance(designatedAffiliateAddress)
    const voter1BalanceBefore = await ethers.provider.getBalance(voter1.address)

    console.log(`ðŸ“Š Before processReward:`)
    console.log(`   POL contract balance: ${ethers.formatEther(polBalanceBefore)} POL`)
    console.log(`   Affiliate balance: ${ethers.formatEther(affiliateBalanceBefore)} POL`)

    // Process rewards
    const processRewardTx = await polContract.connect(user).processReward(
      signatures,
      blockNumbers,
      verificationData,
      [thirdPartyAddresses, thirdPartyAddresses]
    )

    const receipt = await processRewardTx.wait()

    console.log(`âœ… processReward transaction successful`)

    // Verify balances changed
    const polBalanceAfter = await polContract.getPOLBalance()
    const affiliateBalanceAfter = await ethers.provider.getBalance(designatedAffiliateAddress)
    const voter1BalanceAfter = await ethers.provider.getBalance(voter1.address)

    console.log(`ðŸ“Š After processReward:`)
    console.log(`   POL contract balance: ${ethers.formatEther(polBalanceAfter)} POL`)
    console.log(`   Affiliate balance: ${ethers.formatEther(affiliateBalanceAfter)} POL`)
    console.log(`   POL spent: ${ethers.formatEther(polBalanceBefore - polBalanceAfter)} POL`)

    // Verify POL was spent
    expect(polBalanceAfter).to.be.lessThan(polBalanceBefore, "POL contract balance should decrease")

    // Verify affiliate received payment
    expect(affiliateBalanceAfter).to.be.greaterThan(affiliateBalanceBefore, "Affiliate should receive payment")

    // Verify third party received payment
    expect(voter1BalanceAfter).to.be.greaterThan(voter1BalanceBefore, "Third party should receive payment")

    // Verify nonce incremented using user.address
    const newNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    console.log(`ðŸ“Š Nonce behavior:`)
    console.log(`   Before: ${currentNonce}`)
    console.log(`   After: ${newNonce}`)
    console.log(`   Signatures submitted: ${signatures.length}`)

    expect(newNonce).to.equal(currentNonce + 1n, "Nonce should increment once per processReward call")

    console.log(`âœ… All assertions passed`)
    console.log(`   New nonce: ${newNonce}`)
    console.log(`   Affiliate gained: ${ethers.formatEther(affiliateBalanceAfter - affiliateBalanceBefore)} POL`)
    console.log(`   Third party gained: ${ethers.formatEther(voter1BalanceAfter - voter1BalanceBefore)} POL`)

  }).timeout(300000)

  // =====================================================
  // TEST 2: Reject Rewards on DEPRECATED Advertisement
  // =====================================================

  it('R2: Should accept processReward when advertisement is DEPRECATED', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const {
      affiliate,
      advertiser,
      user,
      voter1,
      voter2,
      voter3,
      signingAddress
    } = fixture

    console.log('\n=== ðŸŽ¯ TEST: Accept Rewards on DEPRECATED Advertisement ===')

    const { polAdvertAddress, polContract, designatedAffiliateAddress } = await setupApprovedAdvertisement(fixture)

    // Create signatures BEFORE deprecation
    const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: fixture.mockClaimProviderAddress,
      affiliateSigningAddress: signingAddress.address,
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      // Note: the contract overwrites this with msg.sender (user.address) on-chain
      viewerAddress: user.address
    }

    const thirdPartyAddresses = {
      thirdPartyAddresses: [voter1.address, voter2.address, voter3.address]
    }

    const preDeprecateBlock = await ethers.provider.getBlockNumber()
    const preDeprecationSignature = await createSignature(
      signingAddress,
      preDeprecateBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )

    // Deprecate the contract
    await advanceBlocksForVoting(15)
    await polContract.connect(advertiser).deprecateAdvert()
    console.log(`âœ… Advertisement deprecated`)

    // Verify status is Deprecating (3)
    const [, advertStatus] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    expect(advertStatus).to.equal(3, "Advertisement should be Deprecating")

    // Try to process rewards - should fail
    await expect(
      polContract.connect(user).processReward(
        [preDeprecationSignature],
        [preDeprecateBlock],
        verificationData,
        [thirdPartyAddresses]
      )
    ).not.to.be.reverted;

    console.log(`âœ… Correctly accepted processReward on deprecated advertisement`)

  }).timeout(300000)

  // =====================================================
  // TEST 3: Reject Rewards on WITHDRAWN Advertisement
  // =====================================================

  it('R3: Should reject processReward when advertisement is WITHDRAWN', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const {
      affiliate,
      advertiser,
      user,
      voter1,
      voter2,
      voter3,
      signingAddress
    } = fixture

    console.log('\n=== ðŸŽ¯ TEST: Reject Rewards on WITHDRAWN Advertisement ===')

    const { polAdvertAddress, polContract, designatedAffiliateAddress } = await setupApprovedAdvertisement(fixture)

    // Deprecate the contract
    await advanceBlocksForVoting(15)
    await polContract.connect(advertiser).deprecateAdvert()
    console.log(`âœ… Advertisement deprecated`)

    // Advance past cooldown period (302400 blocks = ~7 days)
    const cooldownBlocks = 302400
    console.log(`â­ï¸  Advancing ${cooldownBlocks} blocks for cooldown period...`)
    await advanceBlocksForVoting(cooldownBlocks + 100)

    // Use correct function name
    const withdrawTx = await polContract.connect(advertiser).withdrawFunds()
    await withdrawTx.wait()
    console.log(`âœ… Funds withdrawn`)

    // Verify status is Withdrawn (4)
    const [, advertStatus] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    expect(advertStatus).to.equal(4, "Advertisement should be Withdrawn")

    // Create verification data
    const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: fixture.mockClaimProviderAddress,
      affiliateSigningAddress: signingAddress.address,
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      // Note: the contract overwrites this with msg.sender (user.address) on-chain
      viewerAddress: user.address
    }

    const thirdPartyAddresses = {
      thirdPartyAddresses: [voter1.address, voter2.address, voter3.address]
    }

    const currentBlock = await ethers.provider.getBlockNumber()
    const signature = await createSignature(
      signingAddress,
      currentBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )

    // Try to process rewards - should fail
    await expect(
      polContract.connect(user).processReward(
        [signature],
        [currentBlock],
        verificationData,
        [thirdPartyAddresses]
      )
    ).to.be.revertedWith('Advertisement must be Approved or Deprecating to process rewards')

    console.log(`âœ… Correctly rejected processReward on withdrawn advertisement`)

  }).timeout(300000)

  // =====================================================
  // TEST 4: Signature Handling Across Deprecation
  // =====================================================

  it('R4: Should handle signatures across deprecation boundary', async function () {
    const fixture = await loadFixture(deployTestFixture)
    const {
      affiliate,
      advertiser,
      user,
      voter1,
      voter2,
      voter3,
      signingAddress,
      governanceFacet
    } = fixture

    console.log('\n' + '='.repeat(80))
    console.log('ðŸŽ¯ TEST: Signature Handling Across Deprecation Boundary')
    console.log('='.repeat(80))

    // ============================================================================
    // STAGE 1: Setup - Create and Approve Advertisement
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 1: Setup Advertisement')
    console.log('â”€'.repeat(80))

    const { polAdvertAddress, polContract, designatedAffiliateAddress } = await setupApprovedAdvertisement(fixture)
    
    console.log(`âœ… Advertisement created and approved`)
    console.log(`   Contract Address: ${polAdvertAddress}`)
    
    const [, advertStatus] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    console.log(`   Status: ${advertStatus} (1 = Approved)`)

    // Get maxBlockSeparation from governance quota
    const currentQuota = await governanceFacet.getAllCurrentQuotas()
    const maxBlockSeparation = Number(currentQuota.polBlocksPerHour)
    console.log(`   Max Block Separation: ${maxBlockSeparation} blocks`)

    // ============================================================================
    // STAGE 2: Create and Process First Signature (Pre-Deprecation)
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 2: Create and Process FIRST Signature (Immediately)')
    console.log('â”€'.repeat(80))

    const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    console.log(`ðŸ“ Current nonce: ${currentNonce}`)

    const verificationData = {
      affiliateReceivingAddress: designatedAffiliateAddress,
      affiliateClaimInfoAddress: fixture.mockClaimProviderAddress,
      affiliateSigningAddress: signingAddress.address,
      advertismentContractAddress: polAdvertAddress,
      nonce: Number(currentNonce),
      // Note: the contract overwrites this with msg.sender (user.address) on-chain
      viewerAddress: user.address
    }

    const thirdPartyAddresses = {
      thirdPartyAddresses: [voter1.address, voter2.address, voter3.address]
    }

    const firstBlock = await ethers.provider.getBlockNumber()
    const firstSignature = await createSignature(
      signingAddress,
      firstBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )

    console.log(`ðŸ“ First signature created:`)
    console.log(`   Block: ${firstBlock}`)
    console.log(`   Signature: ${firstSignature.slice(0, 20)}...`)

    // Process first signature immediately
    console.log(`\nðŸ“ž Processing FIRST signature...`)
    const polBalanceBefore1 = await polContract.getPOLBalance()
    console.log(`   POL balance before: ${ethers.formatEther(polBalanceBefore1)} POL`)

    const processReward1Tx = await polContract.connect(user).processReward(
      [firstSignature],
      [firstBlock],
      verificationData,
      [thirdPartyAddresses]
    )

    const receipt1 = await processReward1Tx.wait()
    
    const polBalanceAfter1 = await polContract.getPOLBalance()
    const polSpent1 = polBalanceBefore1 - polBalanceAfter1
    
    console.log(`âœ… Transaction successful`)
    console.log(`   POL balance after: ${ethers.formatEther(polBalanceAfter1)} POL`)
    console.log(`   POL spent: ${ethers.formatEther(polSpent1)} POL`)

    // Update nonce after first call
    const nonceAfterFirst = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    console.log(`   Nonce: ${currentNonce} â†’ ${nonceAfterFirst}`)
    
    // Update verification data with new nonce
    verificationData.nonce = Number(nonceAfterFirst)

    // ============================================================================
    // STAGE 3: Advance Blocks and Create Second Signature (Still Pre-Deprecation)
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 3: Advance Blocks & Create SECOND Signature (Pre-Deprecation)')
    console.log('â”€'.repeat(80))

    // Advance past the per-(viewer, advertContract, affiliateSigningAddress) cooldown
    // (maxBlockSeparationAdvertisement = 21,600 blocks) so the same viewer can resubmit
    // to this advert/affiliate combination in stage 5.
    const viewerCooldownBlocks = 21601
    console.log(`â­ï¸  Advancing ${viewerCooldownBlocks} blocks (past global viewer cooldown)...`)
    await advanceBlocksForVoting(viewerCooldownBlocks)

    const secondBlock = await ethers.provider.getBlockNumber()
    const secondSignature = await createSignature(
      signingAddress,
      secondBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )

    console.log(`ðŸ“ Second signature created:`)
    console.log(`   Block: ${secondBlock}`)
    console.log(`   Block difference from first: ${secondBlock - firstBlock} blocks`)
    console.log(`   Signature: ${secondSignature.slice(0, 20)}...`)
    console.log(`   â„¹ï¸  This signature is created BEFORE deprecation`)

    // ============================================================================
    // STAGE 4: Deprecate Advertisement
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 4: Deprecate Advertisement')
    console.log('â”€'.repeat(80))

    await advanceBlocksForVoting(15) 

    const deprecateTx = await polContract.connect(advertiser).deprecateAdvert()
    const deprecateReceipt = await deprecateTx.wait()

    let deprecationBlock = 0
    let withdrawalAvailableBlock = 0

    for (const log of deprecateReceipt.logs) {
      try {
        const parsed = polContract.interface.parseLog(log)
        if (parsed && parsed.name === 'AdvertDeprecated') {
          deprecationBlock = Number(parsed.args.deprecatedAtBlock)
          withdrawalAvailableBlock = Number(parsed.args.withdrawalAvailableAtBlock)
          break
        }
      } catch (e) {}
    }

    console.log(`âœ… Advertisement deprecated`)
    console.log(`   Deprecation block: ${deprecationBlock}`)
    console.log(`   Withdrawal available at: ${withdrawalAvailableBlock}`)
    console.log(`   Second signature block: ${secondBlock} (created ${deprecationBlock - secondBlock} blocks BEFORE deprecation)`)

    const [, statusAfterDeprecation] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    console.log(`   Status: ${statusAfterDeprecation} (3 = Deprecating)`)

    // ============================================================================
    // STAGE 5: Advance 20 Blocks Then Process Second Signature (Pre-Deprecation)
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 5: Process SECOND Signature (Created Pre-Deprecation)')
    console.log('â”€'.repeat(80))

    console.log(`â­ï¸  Advancing 20 blocks after deprecation...`)
    await advanceBlocksForVoting(20)

    const currentBlockStage5 = await ethers.provider.getBlockNumber()
    console.log(`ðŸ“ Current block: ${currentBlockStage5}`)
    console.log(`ðŸ“ Second signature block: ${secondBlock}`)
    console.log(`ðŸ“ Deprecation block: ${deprecationBlock}`)
    console.log(`ðŸ“ Timeline:`)
    console.log(`   Second signature created: Block ${secondBlock}`)
    console.log(`   Advertisement deprecated: Block ${deprecationBlock}`)
    console.log(`   Current block: Block ${currentBlockStage5}`)
    console.log(`   âœ… Signature was created ${deprecationBlock - secondBlock} blocks BEFORE deprecation`)

    console.log(`\nðŸ“ž Processing SECOND signature (pre-deprecation)...`)
    const polBalanceBefore2 = await polContract.getPOLBalance()
    console.log(`   POL balance before: ${ethers.formatEther(polBalanceBefore2)} POL`)

    const processReward2Tx = await polContract.connect(user).processReward(
      [secondSignature],
      [secondBlock],
      verificationData,
      [thirdPartyAddresses]
    )

    const receipt2 = await processReward2Tx.wait()

    const polBalanceAfter2 = await polContract.getPOLBalance()
    const polSpent2 = polBalanceBefore2 - polBalanceAfter2

    console.log(`âœ… Transaction successful - Pre-deprecation signature ACCEPTED`)
    console.log(`   POL balance after: ${ethers.formatEther(polBalanceAfter2)} POL`)
    console.log(`   POL spent: ${ethers.formatEther(polSpent2)} POL`)
    console.log(`   ðŸ’¡ Key insight: Signatures created BEFORE deprecation can be processed`)
    console.log(`      even when the advertisement is in Deprecating status`)

    // Verify POL was spent
    expect(polSpent2).to.be.greaterThan(0n, "Pre-deprecation signature should be processed")

    // Update nonce
    const nonceAfterSecond = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)
    console.log(`   Nonce: ${nonceAfterFirst} â†’ ${nonceAfterSecond}`)
    
    verificationData.nonce = Number(nonceAfterSecond)

    // ============================================================================
    // STAGE 6: Advance More Blocks and Create Third Signature (Post-Deprecation)
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 6: Create THIRD Signature (Post-Deprecation)')
    console.log('â”€'.repeat(80))

    console.log(`â­ï¸  Advancing ${maxBlockSeparation + 5} blocks...`)
    await advanceBlocksForVoting(maxBlockSeparation + 5)

    const thirdBlock = await ethers.provider.getBlockNumber()
    const thirdSignature = await createSignature(
      signingAddress,
      thirdBlock,
      verificationData,
      polAdvertAddress,
      user.address,
      thirdPartyAddresses
    )

    console.log(`ðŸ“ Third signature created:`)
    console.log(`   Block: ${thirdBlock}`)
    console.log(`   Deprecation block: ${deprecationBlock}`)
    console.log(`   Block difference: ${thirdBlock - deprecationBlock} blocks AFTER deprecation`)
    console.log(`   Signature: ${thirdSignature.slice(0, 20)}...`)
    console.log(`   âš ï¸  This signature is created AFTER deprecation`)

    // ============================================================================
    // STAGE 7: Try to Process Third Signature (Post-Deprecation) - Should Fail
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 7: Process THIRD Signature (Post-Deprecation) - Expect Failure')
    console.log('â”€'.repeat(80))

    console.log(`ðŸ“ Timeline Verification:`)
    console.log(`   First signature: Block ${firstBlock} (Approved status) âœ… Processed`)
    console.log(`   Advertisement deprecated: Block ${deprecationBlock}`)
    console.log(`   Second signature: Block ${secondBlock} (${deprecationBlock - secondBlock} blocks before deprecation) âœ… Processed`)
    console.log(`   Third signature: Block ${thirdBlock} (${thirdBlock - deprecationBlock} blocks after deprecation) âŒ Should fail`)

    console.log(`\nðŸ“ž Attempting to process THIRD signature (post-deprecation)...`)
    
    const [, currentStatus] = await fixture.advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertAddress)
    console.log(`   Current advertisement status: ${currentStatus} (3 = Deprecating)`)

    // This should fail because signature was created after deprecation
    await expect(
      polContract.connect(user).processReward(
        [thirdSignature],
        [thirdBlock],
        verificationData,
        [thirdPartyAddresses]
      )
    ).to.be.reverted

    console.log(`âœ… Transaction correctly REJECTED`)
    console.log(`   ðŸ’¡ Key insight: Signatures created AFTER deprecation are rejected,`)
    console.log(`      even though the advertisement is still in Deprecating status`)

    // ============================================================================
    // STAGE 8: Summary
    // ============================================================================
    console.log('\nðŸ“‹ STAGE 8: Test Summary')
    console.log('â”€'.repeat(80))
    
    console.log(`\nâœ… TEST COMPLETE - All stages passed!`)
    console.log(`\nðŸ“Š Summary of Signature Processing Rules:`)
    console.log(`   1ï¸âƒ£  Signature created at block ${firstBlock} (Approved) â†’ âœ… Processed immediately`)
    console.log(`   2ï¸âƒ£  Signature created at block ${secondBlock} (${deprecationBlock - secondBlock} blocks before deprecation)`)
    console.log(`      â†’ âœ… Processed successfully even after deprecation`)
    console.log(`   3ï¸âƒ£  Signature created at block ${thirdBlock} (${thirdBlock - deprecationBlock} blocks after deprecation)`)
    console.log(`      â†’ âŒ Rejected (created post-deprecation)`)
    console.log(`\nðŸ”‘ Key Finding:`)
    console.log(`   The critical factor is WHEN the signature was created relative to`)
    console.log(`   the deprecation block, NOT when it's processed.`)
    console.log(`\n   Deprecation Block: ${deprecationBlock}`)
    console.log(`   - Signatures created BEFORE this block: âœ… Valid`)
    console.log(`   - Signatures created AFTER this block: âŒ Invalid`)
    console.log('='.repeat(80))

  }).timeout(300000)

})


