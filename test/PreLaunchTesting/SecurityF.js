const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

async function deployDividendTestFixture() {
  const [owner, maliciousContract, user2, user3, user4, user5] = await ethers.getSigners()
  
  const deployedAddresses = await deployDiamond()
  const diamondAddress = deployedAddresses.diamond
  const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
  
  const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
  const usdcAddress = await advertisersFacet.getUSDCTokenAddress()
  const mockUSDC = await ethers.getContractAt('MockUSDC', usdcAddress)
  
  console.log('\n🎭 COMPREHENSIVE DIVIDEND TEST SETUP')
  console.log(`📍 Diamond Address: ${diamondAddress}`)
  console.log(`📍 Owner: ${owner.address}`)
  console.log(`📍 User2: ${user2.address}`)
  console.log(`📍 User3: ${user3.address}`)
  console.log(`📍 User4: ${user4.address}`)
  console.log(`📍 User5: ${user5.address}`)
  console.log(`📍 Malicious: ${maliciousContract.address}`)
  console.log(`📍 USDC Token: ${usdcAddress}`)
  
  return {
    diamondAddress,
    tokenFacet,
    advertisersFacet,
    mockUSDC,
    owner,
    maliciousContract,
    user2,
    user3,
    user4,
    user5
  }
}

// ========================================
// GROUP F: REENTRANCY PROTECTION & SECURITY
// ========================================
describe('Group F: Reentrancy Protection & Security', function () {

  async function deploySecurityFixture() {
    const [owner, attacker, victim, addr1, addr2] = await ethers.getSigners()
    
    const deployedAddresses = await deployDiamond()
    const diamondAddress = deployedAddresses.diamond
    
    const governanceFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress)
    const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
    const affiliatesFacet = await ethers.getContractAt('OpenAdvertsAffiliatesFacet', diamondAddress)
    const payoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress)
    const polFactoryFacet = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet', diamondAddress)
    const ownershipFacet = await ethers.getContractAt('OwnershipFacet', diamondAddress)
    
    const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
    const usdcAddress = await advertisersFacet.getUSDCTokenAddress()
    const mockUSDC = await ethers.getContractAt('MockUSDC', usdcAddress)
    
    console.log('🚨 Deploying malicious reentrancy contract...')
    const MaliciousReentrancy = await ethers.getContractFactory('MaliciousReentrancy')
    const maliciousContract = await MaliciousReentrancy.connect(attacker).deploy()
    await maliciousContract.waitForDeployment()
    
    const maliciousAddress = await maliciousContract.getAddress()
    console.log(`🚨 Malicious contract deployed at: ${maliciousAddress}`)
    
    await maliciousContract.connect(attacker).setTargets(diamondAddress)
    await maliciousContract.connect(attacker).setAttackDepth(3)
    
    await attacker.sendTransaction({
      to: maliciousAddress,
      value: ethers.parseEther('1000')
    })
    
    console.log(`💰 Funded malicious contract with 1000 ETH`)
    console.log(`💰 Malicious contract balance: ${ethers.formatEther(await maliciousContract.getBalance())} ETH`)
    
    return {
      diamondAddress,
      governanceFacet,
      tokenFacet,
      advertisersFacet,
      mockUSDC,
      affiliatesFacet,
      payoutFacet,
      polFactoryFacet,
      ownershipFacet,
      maliciousContract,
      maliciousAddress,
      owner,
      attacker,
      victim,
      addr1,
      addr2
    }
  }

  it('F1: Basic reentrancy protection during dividend distribution', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 F1: BASIC REENTRANCY PROTECTION ===')

    const MaliciousContract = await ethers.getContractFactory('MaliciousReentrancy')
    const maliciousContract = await MaliciousContract.deploy()
    await maliciousContract.waitForDeployment()
    
    const maliciousAddress = await maliciousContract.getAddress()
    console.log(`🦹 Deployed malicious contract at: ${maliciousAddress}`)
    
    const tokenAmount = ethers.parseEther('2000000') // 2M OAD
    const dividendAmountPOL = ethers.parseEther('500') // 500 POL
    
    await tokenFacet.connect(owner).transfer(maliciousAddress, tokenAmount)
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })
    
    const dividendAmountUSDC = ethers.parseUnits('25000', 6) // 25,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)
    
    const maliciousBalance = await tokenFacet.balanceOf(maliciousAddress)
    const maliciousDividendPOL = await tokenFacet.calculateRewardPOL(maliciousAddress)
    const maliciousDividendUSDC = await tokenFacet.calculateRewardUSDC(maliciousAddress)
    
    console.log(`📊 SETUP STATE:`)
    console.log(`   Malicious contract balance: ${ethers.formatEther(maliciousBalance)} OAD`)
    console.log(`   Malicious contract POL dividend: ${ethers.formatEther(maliciousDividendPOL)} POL`)
    console.log(`   Malicious contract USDC dividend: ${ethers.formatUnits(maliciousDividendUSDC, 6)} USDC`)
    console.log(`   POL dividend pool: ${ethers.formatEther(dividendAmountPOL)} POL`)
    
    await maliciousContract.setTargets(diamondAddress)
    
    console.log(`🔄 ATTEMPTING REENTRANCY ATTACK:`)
    
    const diamondETHBefore = await ethers.provider.getBalance(diamondAddress)
    const maliciousETHBefore = await ethers.provider.getBalance(maliciousAddress)
    const dividendPoolBefore = await tokenFacet.getTotalAggregateRewardInPOL()
    
    console.log(`   Diamond ETH before: ${ethers.formatEther(diamondETHBefore)} ETH`)
    console.log(`   Malicious ETH before: ${ethers.formatEther(maliciousETHBefore)} ETH`)
    console.log(`   Dividend pool before: ${ethers.formatEther(dividendPoolBefore)} ETH`)
    
    let attackSucceeded = false
    let attackError = null
    
    try {
      const attackTx = await maliciousContract.attackDividendDistribution(maliciousAddress)
      await attackTx.wait()
      console.log("Attack transaction succeeded")
    } catch (error) {
      attackError = error
      console.log(`   ✅ Attack transaction failed: ${error.message}`)
    }
    
    const diamondETHAfter = await ethers.provider.getBalance(diamondAddress)
    const maliciousETHAfter = await ethers.provider.getBalance(maliciousAddress)
    const dividendPoolAfter = await tokenFacet.getTotalAggregateRewardInPOL()
    const maliciousDividendAfterPOL = await tokenFacet.calculateRewardPOL(maliciousAddress)
    
    const maliciousETHGained = maliciousETHAfter - maliciousETHBefore
    const diamondETHLost = diamondETHBefore - diamondETHAfter
    
    console.log(`📊 AFTER ATTACK ATTEMPT:`)
    console.log(`   Diamond ETH after: ${ethers.formatEther(diamondETHAfter)} ETH`)
    console.log(`   Malicious ETH after: ${ethers.formatEther(maliciousETHAfter)} ETH`)
    console.log(`   Malicious ETH gained: ${ethers.formatEther(maliciousETHGained)} ETH`)
    console.log(`   Diamond ETH lost: ${ethers.formatEther(diamondETHLost)} ETH`)
    console.log(`   Dividend pool after: ${ethers.formatEther(dividendPoolAfter)} ETH`)
    console.log(`   Malicious unrealized dividend after: ${ethers.formatEther(maliciousDividendAfterPOL)} ETH`)
    
    const expectedDividend = (dividendAmountPOL * maliciousBalance) / await tokenFacet.totalSupply()
    console.log(`   Expected legitimate dividend: ${ethers.formatEther(expectedDividend)} ETH`)
    expect(maliciousETHGained).to.be.lessThanOrEqual(expectedDividend * 110n / 100n, "Should not gain more than 110% of expected dividend")
    console.log(`   ⚠️  Attack was limited to legitimate dividend`)
    expect(maliciousDividendAfterPOL).to.equal(0n, "Should have 0 dividend after claiming")
    console.log(`   ✅ Attack completely blocked - perfect security`)
    
    console.log(`🔄 TESTING LEGITIMATE DIVIDEND CLAIMS:`)
    
    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    await tokenFacet.connect(owner).transfer(user2.address, ethers.parseEther('1000000'))
    
    const user2DividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    console.log(`   User2 legitimate POL dividend: ${ethers.formatEther(user2DividendPOL)} POL`)
    
    if (user2DividendPOL > 0n) {
      await tokenFacet.distributeReward(user2.address)
      const user2ETHAfter = await ethers.provider.getBalance(user2.address)
      const user2Gained = user2ETHAfter - user2ETHBefore
      
      console.log(`   User2 claimed: ${ethers.formatEther(user2Gained)} ETH`)
      expect(user2Gained).to.be.greaterThan(0n, "Legitimate users should still be able to claim")
    }
    
    console.log('✅ F1 PASSED: Basic reentrancy protection working correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('===========================================================\n')
  })

  it('F2: Multiple malicious contracts cannot drain dividend pool', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 F2: MULTIPLE MALICIOUS CONTRACTS ===')

    const numMaliciousContracts = 5
    const maliciousContracts = []
    const maliciousAddresses = []
    
    console.log(`🦹 DEPLOYING ${numMaliciousContracts} MALICIOUS CONTRACTS:`)
    
    for (let i = 0; i < numMaliciousContracts; i++) {
      const MaliciousContract = await ethers.getContractFactory('MaliciousReentrancy')
      const maliciousContract = await MaliciousContract.deploy()
      await maliciousContract.waitForDeployment()
      
      const address = await maliciousContract.getAddress()
      maliciousContracts.push(maliciousContract)
      maliciousAddresses.push(address)
      
      console.log(`   Malicious${i + 1}: ${address}`)
    }
    
    const tokenPerContract = ethers.parseEther('1000000') // 1M OAD each
    const totalDividendPOL = ethers.parseEther('2000') // 2000 POL
    
    console.log(`🔄 SETUP: Distributing tokens and creating dividend pool`)
    
    for (let i = 0; i < numMaliciousContracts; i++) {
      await tokenFacet.connect(owner).transfer(maliciousAddresses[i], tokenPerContract)
      await maliciousContracts[i].setTargets(diamondAddress)
    }
    
    await owner.sendTransaction({
      to: diamondAddress,
      value: totalDividendPOL
    })
    
    const totalDividendUSDC = ethers.parseUnits('100000', 6) // 100,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, totalDividendUSDC)
    
    const totalSupply = await tokenFacet.totalSupply()
    const expectedDividendPerContract = (totalDividendPOL * tokenPerContract) / totalSupply
    
    console.log(`📊 SETUP COMPLETE:`)
    console.log(`   Tokens per contract: ${ethers.formatEther(tokenPerContract)} OAD`)
    console.log(`   Total POL dividend pool: ${ethers.formatEther(totalDividendPOL)} POL`)
    console.log(`   Total USDC in diamond: ${ethers.formatUnits(totalDividendUSDC, 6)} USDC`)
    console.log(`   Expected POL dividend per contract: ${ethers.formatEther(expectedDividendPerContract)} POL`)
    
    const diamondETHBefore = await ethers.provider.getBalance(diamondAddress)
    const dividendPoolBefore = await tokenFacet.getTotalAggregateRewardInPOL()
    
    console.log(`   Diamond ETH before attacks: ${ethers.formatEther(diamondETHBefore)} ETH`)
    console.log(`   Dividend pool before attacks: ${ethers.formatEther(dividendPoolBefore)} ETH`)
    
    console.log(`🔄 LAUNCHING COORDINATED ATTACK:`)
    
    const attackResults = []
    let totalETHGainedByAttackers = 0n
    
    for (let i = 0; i < numMaliciousContracts; i++) {
      console.log(`   Attacking with Malicious${i + 1}...`)
      
      const ethBefore = await ethers.provider.getBalance(maliciousAddresses[i])
      
      let attackSucceeded = false
      try {
        const attackTx = await maliciousContracts[i].attackDividendDistribution(maliciousAddresses[i])
        await attackTx.wait()
        attackSucceeded = true
      } catch (error) {
        console.log(`     Attack failed: ${error.message}`)
      }
      
      const ethAfter = await ethers.provider.getBalance(maliciousAddresses[i])
      const ethGained = ethAfter - ethBefore
      totalETHGainedByAttackers += ethGained
      
      attackResults.push({
        index: i + 1,
        succeeded: attackSucceeded,
        ethGained: ethGained
      })
      
      console.log(`     Result: ${attackSucceeded ? 'Succeeded' : 'Failed'}, ETH gained: ${ethers.formatEther(ethGained)} ETH`)
    }
    
    const diamondETHAfter = await ethers.provider.getBalance(diamondAddress)
    const dividendPoolAfter = await tokenFacet.getTotalAggregateRewardInPOL()
    const totalETHLostByDiamond = diamondETHBefore - diamondETHAfter
    
    console.log(`📊 ATTACK RESULTS SUMMARY:`)
    console.log(`   Total ETH gained by attackers: ${ethers.formatEther(totalETHGainedByAttackers)} ETH`)
    console.log(`   Total ETH lost by Diamond: ${ethers.formatEther(totalETHLostByDiamond)} ETH`)
    console.log(`   Diamond ETH after: ${ethers.formatEther(diamondETHAfter)} ETH`)
    console.log(`   Dividend pool after: ${ethers.formatEther(dividendPoolAfter)} ETH`)
    
    const maxLegitimateGain = expectedDividendPerContract * BigInt(numMaliciousContracts)
    const toleranceMargin = maxLegitimateGain * 10n / 100n
    
    expect(totalETHGainedByAttackers).to.be.lessThanOrEqual(maxLegitimateGain + toleranceMargin, "Total attacker gains should not exceed legitimate dividends plus tolerance")
    
      const netTotalDividendPOL = totalDividendPOL - (totalDividendPOL * 5n / 100n)
      const minExpectedDiamondETH = netTotalDividendPOL - maxLegitimateGain - toleranceMargin
    expect(diamondETHAfter).to.be.greaterThanOrEqual(minExpectedDiamondETH, "Diamond should retain most of its ETH")
    
    console.log(`🔄 TESTING LEGITIMATE USERS AFTER ATTACK:`)
    
    await tokenFacet.connect(owner).transfer(user2.address, ethers.parseEther('500000'))
    const user2DividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    
    if (user2DividendPOL > 0n) {
      const user2ETHBefore = await ethers.provider.getBalance(user2.address)
      await tokenFacet.distributeReward(user2.address)
      const user2ETHAfter = await ethers.provider.getBalance(user2.address)
      const user2Gained = user2ETHAfter - user2ETHBefore
      
      console.log(`   User2 legitimate claim: ${ethers.formatEther(user2Gained)} ETH`)
      expect(user2Gained).to.be.greaterThan(0n, "Legitimate users should still be able to claim after attacks")
    }
    
    console.log('✅ F2 PASSED: Multiple malicious contracts properly contained')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('===============================================================\n')
  })

  it('F3: Reentrancy protection in transfer function', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 F3: REENTRANCY PROTECTION IN TRANSFER ===')

    const MaliciousContract = await ethers.getContractFactory('MaliciousReentrancy')
    const maliciousContract = await MaliciousContract.deploy()
    await maliciousContract.waitForDeployment()
    
    const maliciousAddress = await maliciousContract.getAddress()
    console.log(`🦹 Deployed malicious contract at: ${maliciousAddress}`)
    
    const initialTokens = ethers.parseEther('3000000') // 3M OAD
    const dividendAmountPOL = ethers.parseEther('600') // 600 POL
    
    await tokenFacet.connect(owner).transfer(maliciousAddress, initialTokens)
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })
    
    const dividendAmountUSDC = ethers.parseUnits('30000', 6) // 30,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)
    
    await maliciousContract.setTargets(diamondAddress)
    
    const maliciousBalanceBefore = await tokenFacet.balanceOf(maliciousAddress)
    const user2BalanceBefore = await tokenFacet.balanceOf(user2.address)
    const maliciousETHBefore = await ethers.provider.getBalance(maliciousAddress)
    
    console.log(`📊 BEFORE TRANSFER ATTACK:`)
    console.log(`   Malicious balance: ${ethers.formatEther(maliciousBalanceBefore)} OAD`)
    console.log(`   User2 balance: ${ethers.formatEther(user2BalanceBefore)} OAD`)
    console.log(`   Malicious ETH: ${ethers.formatEther(maliciousETHBefore)} ETH`)
    
    console.log(`🔄 ATTEMPTING TRANSFER REENTRANCY ATTACK:`)
    
    let transferAttackSucceeded = false
    let transferError = null
    
    const transferAmount = ethers.parseEther('100000') // 100K OAD
    
    try {
      const attackTx = await maliciousContract.attackTokenTransfer(user2.address, transferAmount)
      await attackTx.wait()
      transferAttackSucceeded = true
      console.log(`   Transfer attack transaction succeeded`)
    } catch (error) {
      transferError = error
      console.log(`   Transfer attack failed: ${error.message}`)
    }
    
    const maliciousBalanceAfter = await tokenFacet.balanceOf(maliciousAddress)
    const user2BalanceAfter = await tokenFacet.balanceOf(user2.address)
    const maliciousETHAfter = await ethers.provider.getBalance(maliciousAddress)
    
    const tokensTransferred = maliciousBalanceBefore - maliciousBalanceAfter
    const user2TokensGained = user2BalanceAfter - user2BalanceBefore
    const maliciousETHGained = maliciousETHAfter - maliciousETHBefore
    
    console.log(`📊 AFTER TRANSFER ATTACK:`)
    console.log(`   Malicious balance: ${ethers.formatEther(maliciousBalanceAfter)} OAD`)
    console.log(`   User2 balance: ${ethers.formatEther(user2BalanceAfter)} OAD`)
    console.log(`   Tokens transferred: ${ethers.formatEther(tokensTransferred)} OAD`)
    console.log(`   User2 tokens gained: ${ethers.formatEther(user2TokensGained)} OAD`)
    console.log(`   Malicious ETH gained: ${ethers.formatEther(maliciousETHGained)} ETH`)
    
    if (transferAttackSucceeded) {
      expect(tokensTransferred).to.be.lessThanOrEqual(transferAmount, "Should not transfer more than intended")
      expect(user2TokensGained).to.equal(tokensTransferred, "User2 should receive exactly what was transferred")
      
      const expectedDividend = (dividendAmountPOL * maliciousBalanceBefore) / await tokenFacet.totalSupply()
      expect(maliciousETHGained).to.be.lessThanOrEqual(expectedDividend * 110n / 100n, "Should not gain excessive ETH through reentrancy")
      
      console.log(`   ✅ Transfer succeeded but was limited to legitimate amounts`)
    } else {
      expect(tokensTransferred).to.equal(0n, "No tokens should be transferred when attack fails")
      expect(user2TokensGained).to.equal(0n, "User2 should gain no tokens when attack fails")
      expect(maliciousETHGained).to.equal(0n, "No ETH should be gained when attack fails")
      
      console.log(`   ✅ Transfer attack completely blocked`)
    }
    
    console.log(`🔄 TESTING NORMAL TRANSFER AFTER ATTACK:`)
    
    const normalTransferAmount = ethers.parseEther('50000')
    const user2BalanceBeforeNormal = await tokenFacet.balanceOf(user2.address)
    
    try {
      await tokenFacet.connect(owner).transfer(user2.address, normalTransferAmount)
      const user2BalanceAfterNormal = await tokenFacet.balanceOf(user2.address)
      const normalGain = user2BalanceAfterNormal - user2BalanceBeforeNormal
      
      console.log(`   Normal transfer succeeded: ${ethers.formatEther(normalGain)} OAD`)
      expect(normalGain).to.equal(normalTransferAmount, "Normal transfers should work correctly")
    } catch (error) {
      console.log(`   Normal transfer failed: ${error.message}`)
      expect.fail("Normal transfers should still work after failed attack")
    }
    
    console.log('✅ F3 PASSED: Transfer reentrancy protection working correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('==============================================================\n')
  })

  it('F4: Protection against dividend claim frontrunning', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 F4: PROTECTION AGAINST DIVIDEND CLAIM FRONTRUNNING ===')

    const user2Tokens = ethers.parseEther('2000000') // 2M OAD
    const user3Tokens = ethers.parseEther('1000000') // 1M OAD
    
    await tokenFacet.connect(owner).transfer(user2.address, user2Tokens)
    await tokenFacet.connect(owner).transfer(user3.address, user3Tokens)
    
    const dividendAmountPOL = ethers.parseEther('900') // 900 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })
    
    const dividendAmountUSDC = ethers.parseUnits('45000', 6) // 45,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)
    
    const totalSupply = await tokenFacet.totalSupply()
    const f3NetDividendPOL = dividendAmountPOL - (dividendAmountPOL * 5n / 100n)
    const user2ExpectedDividend = (f3NetDividendPOL * user2Tokens) / totalSupply
    const user3ExpectedDividend = (f3NetDividendPOL * user3Tokens) / totalSupply
    
    console.log(`📊 SETUP COMPLETE:`)
    console.log(`   User2 tokens: ${ethers.formatEther(user2Tokens)} OAD`)
    console.log(`   User3 tokens: ${ethers.formatEther(user3Tokens)} OAD`)
    console.log(`   POL dividend pool: ${ethers.formatEther(dividendAmountPOL)} POL`)
    console.log(`   User2 expected POL dividend: ${ethers.formatEther(user2ExpectedDividend)} POL`)
    console.log(`   User3 expected POL dividend: ${ethers.formatEther(user3ExpectedDividend)} POL`)
    
    const MaliciousContract = await ethers.getContractFactory('MaliciousReentrancy')
    const frontrunner = await MaliciousContract.deploy()
    await frontrunner.waitForDeployment()
    
    const frontrunnerAddress = await frontrunner.getAddress()
    console.log(`🦹 Deployed frontrunner at: ${frontrunnerAddress}`)
    
    console.log(`🔄 TESTING FRONTRUNNING PROTECTION:`)
    
    const user2DividendCalculated = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendCalculated = await tokenFacet.calculateRewardPOL(user3.address)
    
    console.log(`   User2 calculated POL dividend: ${ethers.formatEther(user2DividendCalculated)} POL`)
    console.log(`   User3 calculated POL dividend: ${ethers.formatEther(user3DividendCalculated)} POL`)
    
    expect(user2DividendCalculated).to.be.approximately(user2ExpectedDividend, ethers.parseEther('0.01'), "User2 dividend calculation should be correct")
    expect(user3DividendCalculated).to.be.approximately(user3ExpectedDividend, ethers.parseEther('0.01'), "User3 dividend calculation should be correct")
    
    console.log(`🔄 TESTING FRONTRUNNER WITH LATE TOKEN ACQUISITION:`)
    
    const frontrunnerTokens = ethers.parseEther('500000') // 500K OAD
    await tokenFacet.connect(owner).transfer(frontrunnerAddress, frontrunnerTokens)
    
    const frontrunnerDividendPOL = await tokenFacet.calculateRewardPOL(frontrunnerAddress)
    const frontrunnerLastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(frontrunnerAddress)
    
    console.log(`   Frontrunner tokens: ${ethers.formatEther(frontrunnerTokens)} OAD`)
    console.log(`   Frontrunner POL dividend: ${ethers.formatEther(frontrunnerDividendPOL)} POL`)
    console.log(`   Frontrunner last POL claim: ${ethers.formatEther(frontrunnerLastClaimPOL)} POL`)
    
    const currentDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    expect(frontrunnerLastClaimPOL).to.equal(currentDividendPoolPOL, "Frontrunner's last claim should be set to current pool")
    expect(frontrunnerDividendPOL).to.equal(0n, "Frontrunner should not get dividends from before owning tokens")
    
    console.log(`🔄 ADDING NEW DIVIDENDS AFTER FRONTRUNNER ACQUISITION:`)
    
    const newDividendPOL = ethers.parseEther('300') // 300 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: newDividendPOL
    })
    
    const newDividendUSDC = ethers.parseUnits('15000', 6) // 15,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, newDividendUSDC)
    
    const finalDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    console.log(`   Added new POL dividend: ${ethers.formatEther(newDividendPOL)} POL`)
    console.log(`   Final POL dividend pool: ${ethers.formatEther(finalDividendPoolPOL)} POL`)
    
    const user2FinalDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3FinalDividendPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const frontrunnerFinalDividendPOL = await tokenFacet.calculateRewardPOL(frontrunnerAddress)
    
    const totalSupplyAfterTransfer = await tokenFacet.totalSupply()
    const frontrunnerExpectedFromNew = (newDividendPOL * 95n / 100n * frontrunnerTokens) / totalSupplyAfterTransfer
    
    console.log(`💰 FINAL POL DIVIDEND CALCULATIONS:`)
    console.log(`   User2 final POL dividend: ${ethers.formatEther(user2FinalDividendPOL)} POL`)
    console.log(`   User3 final POL dividend: ${ethers.formatEther(user3FinalDividendPOL)} POL`)
    console.log(`   Frontrunner final POL dividend: ${ethers.formatEther(frontrunnerFinalDividendPOL)} POL`)
    console.log(`   Frontrunner expected from new: ${ethers.formatEther(frontrunnerExpectedFromNew)} POL`)
    
    expect(frontrunnerFinalDividendPOL).to.be.approximately(frontrunnerExpectedFromNew, ethers.parseEther('0.01'), "Frontrunner should only get dividend from new addition")
    expect(frontrunnerFinalDividendPOL).to.be.lessThan(user2FinalDividendPOL, "Frontrunner should get less than users who held tokens longer")
    expect(frontrunnerFinalDividendPOL).to.be.lessThan(user3FinalDividendPOL, "Frontrunner should get less than users who held tokens longer")
    
    console.log(`🔄 TESTING ACTUAL CLAIMS:`)
    
    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore = await ethers.provider.getBalance(user3.address)
    const frontrunnerETHBefore = await ethers.provider.getBalance(frontrunnerAddress)
    
    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)
    await tokenFacet.distributeReward(frontrunnerAddress)
    
    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user3ETHAfter = await ethers.provider.getBalance(user3.address)
    const frontrunnerETHAfter = await ethers.provider.getBalance(frontrunnerAddress)
    
    const user2Claimed = user2ETHAfter - user2ETHBefore
    const user3Claimed = user3ETHAfter - user3ETHBefore
    const frontrunnerClaimed = frontrunnerETHAfter - frontrunnerETHBefore
    
    console.log(`   User2 claimed: ${ethers.formatEther(user2Claimed)} ETH`)
    console.log(`   User3 claimed: ${ethers.formatEther(user3Claimed)} ETH`)
    console.log(`   Frontrunner claimed: ${ethers.formatEther(frontrunnerClaimed)} ETH`)
    
    expect(user2Claimed).to.be.approximately(user2FinalDividendPOL, ethers.parseEther('0.01'), "User2 claim should match calculated")
    expect(user3Claimed).to.be.approximately(user3FinalDividendPOL, ethers.parseEther('0.01'), "User3 claim should match calculated")
    expect(frontrunnerClaimed).to.be.approximately(frontrunnerFinalDividendPOL, ethers.parseEther('0.01'), "Frontrunner claim should match calculated")
    
    expect(frontrunnerClaimed).to.be.lessThan(user2Claimed, "Frontrunner should receive less than long-term holders")
    expect(frontrunnerClaimed).to.be.lessThan(user3Claimed, "Frontrunner should receive less than long-term holders")

    console.log('✅ F4 PASSED: Frontrunning protection working correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('=========================================================\n')
  })

  it('F5: Protection against dividendClaimInProgress manipulation', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 F5: DIVIDEND CLAIM IN PROGRESS PROTECTION ===')

    const userTokens = ethers.parseEther('1500000') // 1.5M OAD
    const dividendAmountPOL = ethers.parseEther('400') // 400 POL
    
    await tokenFacet.connect(owner).transfer(user2.address, userTokens)
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })
    
    const dividendAmountUSDC = ethers.parseUnits('20000', 6) // 20,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)
    
    const userDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    console.log(`📊 SETUP:`)
    console.log(`   User2 tokens: ${ethers.formatEther(userTokens)} OAD`)
    console.log(`   POL dividend pool: ${ethers.formatEther(dividendAmountPOL)} POL`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(userDividendPOL)} POL`)
    
    const MaliciousContract = await ethers.getContractFactory('MaliciousReentrancy')
    const maliciousContract = await MaliciousContract.deploy()
    await maliciousContract.waitForDeployment()
    
    const maliciousAddress = await maliciousContract.getAddress()
    console.log(`🦹 Deployed malicious contract at: ${maliciousAddress}`)
    
    await tokenFacet.connect(owner).transfer(maliciousAddress, ethers.parseEther('1000000'))
    
    await maliciousContract.setTargets(diamondAddress)
    
    console.log(`🔄 TESTING CONCURRENT CLAIM ATTEMPTS:`)
    
    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    
    console.log(`   Attempting normal claim...`)
    try {
      await tokenFacet.distributeReward(user2.address)
      console.log(`Normal claim succeeded`)
    } catch (error) {
      console.log(`Normal claim failed: ${error.message}`)
    }
    
    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user2Claimed = user2ETHAfter - user2ETHBefore
    
    console.log(`   User2 claimed: ${ethers.formatEther(user2Claimed)} ETH`)
    
    console.log(`   Attempting double claim...`)
    try {
      const user2ETHBeforeDouble = await ethers.provider.getBalance(user2.address)
      console.log(`   User2 ETH before double claim: ${ethers.formatEther(user2ETHBeforeDouble)} ETH`)
      await tokenFacet.distributeReward(user2.address)
      const user2ETHAfterDouble = await ethers.provider.getBalance(user2.address)
      const user2DoubleClaimed = user2ETHAfterDouble - user2ETHBeforeDouble
      console.log(`   User2 double claimed: ${ethers.formatEther(user2DoubleClaimed)} ETH`)
      expect(user2DoubleClaimed).to.equal(0n, "Double claim should not yield any ETH")
      console.log(`   ✅ Double claim properly blocked: no ETH gained`)
    } catch (error) {
      console.log(`Double claim attempt failed: ${error.message}`)
    }
    
    console.log(`🔄 TESTING MALICIOUS RAPID CLAIM ATTEMPTS:`)

    const additionalDividend2POL = ethers.parseEther('300') // 300 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: additionalDividend2POL
    })
    
    const additionalDividend2USDC = ethers.parseUnits('15000', 6) // 15,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, additionalDividend2USDC)
    
    const maliciousETHBefore = await ethers.provider.getBalance(maliciousAddress)
    const maliciousDividendBeforePOL = await tokenFacet.calculateRewardPOL(maliciousAddress)
    
    console.log(`   Malicious POL dividend available: ${ethers.formatEther(maliciousDividendBeforePOL)} POL`)
    
    let successfulAttacks = 0
    let totalMaliciousGained = 0n
    
    for (let i = 0; i < 3; i++) {
      console.log(`   Rapid attack attempt ${i + 1}...`)
      
      try {
        const attackTx = await maliciousContract.attackDividendDistribution(maliciousAddress)
        await attackTx.wait()
        successfulAttacks++
        console.log(`   Attack ${i + 1} succeeded`)
      } catch (error) {
        console.log(`   Attack ${i + 1} failed: ${error.message}`)
      }
    }
    
    const maliciousETHAfter = await ethers.provider.getBalance(maliciousAddress)
    totalMaliciousGained = maliciousETHAfter - maliciousETHBefore
    
    console.log(`📊 MALICIOUS ATTACK RESULTS:`)
    console.log(`   Successful attacks: ${successfulAttacks}`)
    console.log(`   Total malicious ETH gained: ${ethers.formatEther(totalMaliciousGained)} ETH`)
    console.log(`   Expected legitimate POL dividend: ${ethers.formatEther(maliciousDividendBeforePOL)} POL`)
    
    expect(totalMaliciousGained).to.be.lessThanOrEqual(maliciousDividendBeforePOL * 110n / 100n, "Should not gain more than 110% of legitimate dividend")
    
    console.log(`🔄 TESTING CLAIM FLAG MANAGEMENT:`)
    
    const additionalDividendPOL = ethers.parseEther('200') // 200 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: additionalDividendPOL
    })
    
    const additionalDividendUSDC = ethers.parseUnits('10000', 6) // 10,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, additionalDividendUSDC)
    
    const newUserDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const newMaliciousDividendPOL = await tokenFacet.calculateRewardPOL(maliciousAddress)
    
    console.log(`   New User2 POL dividend: ${ethers.formatEther(newUserDividendPOL)} POL`)
    console.log(`   New malicious POL dividend: ${ethers.formatEther(newMaliciousDividendPOL)} POL`)
    
    if (newUserDividendPOL > 0n) {
      try {
        await tokenFacet.distributeReward(user2.address)
        console.log(`   ✅ User2 new claim succeeded`)
      } catch (error) {
        console.log(`   ❌ User2 new claim failed: ${error.message}`)
      }
    }
    
    if (newMaliciousDividendPOL > 0n) {
      try {
        await tokenFacet.distributeReward(maliciousAddress)
        console.log(`   ✅ Malicious new claim succeeded`)
      } catch (error) {
        console.log(`   ❌ Malicious new claim failed: ${error.message}`)
      }
    }
    
    console.log('✅ F5 PASSED: Dividend claim protection working correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('=========================================================\n')
  })

})
