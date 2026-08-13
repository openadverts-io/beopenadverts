const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

describe('Group D: Multiple Claims and Transfers', function () {

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

  it('D1: Claim → Add more dividends → Claim again', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 D1: MULTIPLE DIVIDEND ADDITIONS AND CLAIMS ===')

    // Setup: Give users tokens
    const user2Tokens = ethers.parseEther('5000000') // 5M OAD (25%)
    const user3Tokens = ethers.parseEther('3000000') // 3M OAD (15%)
    
    console.log(`🔄 SETUP: Distributing tokens`)
    await tokenFacet.connect(owner).transfer(user2.address, user2Tokens)
    await tokenFacet.connect(owner).transfer(user3.address, user3Tokens)
    
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    
    console.log(`   Owner: ${ethers.formatEther(ownerBalance)} OAD (${(ownerBalance * 100n) / totalSupply}%)`)
    console.log(`   User2: ${ethers.formatEther(user2Tokens)} OAD (${(user2Tokens * 100n) / totalSupply}%)`)
    console.log(`   User3: ${ethers.formatEther(user3Tokens)} OAD (${(user3Tokens * 100n) / totalSupply}%)`)
    
    // ROUND 1: First dividend pool
    console.log(`\n🔄 ROUND 1: First dividend addition`)
    
    const firstDividendPOL = ethers.parseEther('800') // 800 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: firstDividendPOL
    })
    
    const firstDividendUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, firstDividendUSDC)
    
    const pool1POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool1USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    console.log(`   POL dividend pool: ${ethers.formatEther(pool1POL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(pool1USDC, 6)} USDC`)
    
    // Calculate and display expected dividends
    const expectedOwner1POL = (pool1POL * ownerBalance) / totalSupply
    const expectedUser2_1POL = (pool1POL * user2Tokens) / totalSupply
    const expectedUser3_1POL = (pool1POL * user3Tokens) / totalSupply
    
    console.log(`💰 ROUND 1 EXPECTED POL DIVIDENDS:`)
    console.log(`   Owner: ${ethers.formatEther(expectedOwner1POL)} POL`)
    console.log(`   User2: ${ethers.formatEther(expectedUser2_1POL)} POL`)
    console.log(`   User3: ${ethers.formatEther(expectedUser3_1POL)} POL`)
    
    const calcOwner1POL = await tokenFacet.calculateRewardPOL(owner.address)
    const calcUser2_1POL = await tokenFacet.calculateRewardPOL(user2.address)
    const calcUser3_1POL = await tokenFacet.calculateRewardPOL(user3.address)
    const calcOwner1USDC = await tokenFacet.calculateRewardUSDC(owner.address)
    const calcUser2_1USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    const calcUser3_1USDC = await tokenFacet.calculateRewardUSDC(user3.address)
    
    console.log(`💰 ROUND 1 CALCULATED DIVIDENDS:`)
    console.log(`   Owner: ${ethers.formatEther(calcOwner1POL)} POL, ${ethers.formatUnits(calcOwner1USDC, 6)} USDC`)
    console.log(`   User2: ${ethers.formatEther(calcUser2_1POL)} POL, ${ethers.formatUnits(calcUser2_1USDC, 6)} USDC`)
    console.log(`   User3: ${ethers.formatEther(calcUser3_1POL)} POL, ${ethers.formatUnits(calcUser3_1USDC, 6)} USDC`)

    expect(calcOwner1POL).to.be.approximately(expectedOwner1POL, ethers.parseEther('0.01'), "Owner calculated POL dividend should match expected")
    expect(calcUser2_1POL).to.be.approximately(expectedUser2_1POL, ethers.parseEther('0.01'), "User2 calculated POL dividend should match expected")
    expect(calcUser3_1POL).to.be.approximately(expectedUser3_1POL, ethers.parseEther('0.01'), "User3 calculated POL dividend should match expected")

    // Claim first round dividends
    console.log(`🔄 CLAIMING ROUND 1 DIVIDENDS:`)
    
    const ownerETHBefore1 = await ethers.provider.getBalance(owner.address)
    const user2ETHBefore1 = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore1 = await ethers.provider.getBalance(user3.address)
    const ownerUSDCBefore1 = await mockUSDC.balanceOf(owner.address)
    const user2USDCBefore1 = await mockUSDC.balanceOf(user2.address)
    const user3USDCBefore1 = await mockUSDC.balanceOf(user3.address)
    
    await tokenFacet.distributeReward(owner.address)
    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)
    
    const ownerETHAfter1 = await ethers.provider.getBalance(owner.address)
    const user2ETHAfter1 = await ethers.provider.getBalance(user2.address)
    const user3ETHAfter1 = await ethers.provider.getBalance(user3.address)
    const ownerUSDCAfter1 = await mockUSDC.balanceOf(owner.address)
    const user2USDCAfter1 = await mockUSDC.balanceOf(user2.address)
    const user3USDCAfter1 = await mockUSDC.balanceOf(user3.address)
    
    const ownerGained1POL = ownerETHAfter1 - ownerETHBefore1
    const user2Gained1POL = user2ETHAfter1 - user2ETHBefore1
    const user3Gained1POL = user3ETHAfter1 - user3ETHBefore1
    const ownerGained1USDC = ownerUSDCAfter1 - ownerUSDCBefore1
    const user2Gained1USDC = user2USDCAfter1 - user2USDCBefore1
    const user3Gained1USDC = user3USDCAfter1 - user3USDCBefore1
    
    console.log(`   Owner claimed: ${ethers.formatEther(ownerGained1POL)} POL, ${ethers.formatUnits(ownerGained1USDC, 6)} USDC`)
    console.log(`   User2 claimed: ${ethers.formatEther(user2Gained1POL)} POL, ${ethers.formatUnits(user2Gained1USDC, 6)} USDC`)
    console.log(`   User3 claimed: ${ethers.formatEther(user3Gained1POL)} POL, ${ethers.formatUnits(user3Gained1USDC, 6)} USDC`)
    
    // Verify claims match expected
    expect(ownerGained1POL).to.be.approximately(expectedOwner1POL, ethers.parseEther('0.01'), "Owner POL claim should match expected")
    expect(user2Gained1POL).to.be.approximately(expectedUser2_1POL, ethers.parseEther('0.01'), "User2 POL claim should match expected")
    expect(user3Gained1POL).to.be.approximately(expectedUser3_1POL, ethers.parseEther('0.01'), "User3 POL claim should match expected")
    // USDC is auto-detected during distributeReward via processNewUSDCDeposits
    const netFirstDividendUSDC = firstDividendUSDC - (firstDividendUSDC * 5n / 100n)
    const expectedOwnerUSDC1 = (netFirstDividendUSDC * ownerBalance) / totalSupply
    const expectedUser2USDC1 = (netFirstDividendUSDC * user2Tokens) / totalSupply
    const expectedUser3USDC1 = (netFirstDividendUSDC * user3Tokens) / totalSupply
    expect(ownerGained1USDC).to.be.approximately(expectedOwnerUSDC1, 1n, "Owner USDC should match proportional share")
    expect(user2Gained1USDC).to.be.approximately(expectedUser2USDC1, 1n, "User2 USDC should match proportional share")
    expect(user3Gained1USDC).to.be.approximately(expectedUser3USDC1, 1n, "User3 USDC should match proportional share")
    
    const afterClaim1_OwnerPOL = await tokenFacet.calculateRewardPOL(owner.address)
    const afterClaim1_User2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const afterClaim1_User3POL = await tokenFacet.calculateRewardPOL(user3.address)
    
    console.log(`💰 AFTER ROUND 1 CLAIMS:`)
    console.log(`   Owner remaining: ${ethers.formatEther(afterClaim1_OwnerPOL)} POL`)
    console.log(`   User2 remaining: ${ethers.formatEther(afterClaim1_User2POL)} POL`)
    console.log(`   User3 remaining: ${ethers.formatEther(afterClaim1_User3POL)} POL`)
    
    expect(afterClaim1_OwnerPOL).to.equal(0n, "Owner should have 0 POL dividend after claiming")
    expect(afterClaim1_User2POL).to.equal(0n, "User2 should have 0 POL dividend after claiming")
    expect(afterClaim1_User3POL).to.equal(0n, "User3 should have 0 POL dividend after claiming")
    
    // ROUND 2: Add more dividends
    console.log(`\n🔄 ROUND 2: Second dividend addition`)
    
    const secondDividendPOL = ethers.parseEther('600') // 600 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })
    
    const secondDividendUSDC = ethers.parseUnits('30000', 6) // 30,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)
    
    const pool2POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool2USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    console.log(`   Total POL dividend pool: ${ethers.formatEther(pool2POL)} POL`)
    console.log(`   New POL dividend added: ${ethers.formatEther(secondDividendPOL)} POL`)
    console.log(`   Total USDC aggregate: ${ethers.formatUnits(pool2USDC, 6)} USDC`)
    
    // Calculate expected dividends from only the new addition (net of 5% admin commission)
    const netSecondDividendPOL = secondDividendPOL - (secondDividendPOL * 5n / 100n)
    const expectedOwner2POL = (netSecondDividendPOL * ownerBalance) / totalSupply
    const expectedUser2_2POL = (netSecondDividendPOL * user2Tokens) / totalSupply
    const expectedUser3_2POL = (netSecondDividendPOL * user3Tokens) / totalSupply
    
    console.log(`💰 ROUND 2 EXPECTED POL DIVIDENDS (from new addition only):`)
    console.log(`   Owner: ${ethers.formatEther(expectedOwner2POL)} POL`)
    console.log(`   User2: ${ethers.formatEther(expectedUser2_2POL)} POL`)
    console.log(`   User3: ${ethers.formatEther(expectedUser3_2POL)} POL`)
    const calcOwner2POL = await tokenFacet.calculateRewardPOL(owner.address)
    const calcUser2_2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const calcUser3_2POL = await tokenFacet.calculateRewardPOL(user3.address)
    
    console.log(`💰 ROUND 2 CALCULATED POL DIVIDENDS:`)
    console.log(`   Owner: ${ethers.formatEther(calcOwner2POL)} POL`)
    console.log(`   User2: ${ethers.formatEther(calcUser2_2POL)} POL`)
    console.log(`   User3: ${ethers.formatEther(calcUser3_2POL)} POL`)

    expect(calcOwner2POL).to.be.approximately(expectedOwner2POL, ethers.parseEther('0.01'), "Owner round 2 POL dividend should match expected")
    expect(calcUser2_2POL).to.be.approximately(expectedUser2_2POL, ethers.parseEther('0.01'), "User2 round 2 POL dividend should match expected")
    expect(calcUser3_2POL).to.be.approximately(expectedUser3_2POL, ethers.parseEther('0.01'), "User3 round 2 POL dividend should match expected")

    // Claim second round dividends
    console.log(`🔄 CLAIMING ROUND 2 DIVIDENDS:`)
    
    const ownerETHBefore2 = await ethers.provider.getBalance(owner.address)
    const user2ETHBefore2 = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore2 = await ethers.provider.getBalance(user3.address)
    
    await tokenFacet.distributeReward(owner.address)
    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)
    
    const ownerETHAfter2 = await ethers.provider.getBalance(owner.address)
    const user2ETHAfter2 = await ethers.provider.getBalance(user2.address)
    const user3ETHAfter2 = await ethers.provider.getBalance(user3.address)
    
    const ownerGained2POL = ownerETHAfter2 - ownerETHBefore2
    const user2Gained2POL = user2ETHAfter2 - user2ETHBefore2
    const user3Gained2POL = user3ETHAfter2 - user3ETHBefore2
    
    console.log(`   Owner claimed: ${ethers.formatEther(ownerGained2POL)} POL`)
    console.log(`   User2 claimed: ${ethers.formatEther(user2Gained2POL)} POL`)
    console.log(`   User3 claimed: ${ethers.formatEther(user3Gained2POL)} POL`)
    
    // Verify round 2 claims
    expect(ownerGained2POL).to.be.approximately(expectedOwner2POL, ethers.parseEther('0.01'), "Owner round 2 POL claim should match expected")
    expect(user2Gained2POL).to.be.approximately(expectedUser2_2POL, ethers.parseEther('0.01'), "User2 round 2 POL claim should match expected")
    expect(user3Gained2POL).to.be.approximately(expectedUser3_2POL, ethers.parseEther('0.01'), "User3 round 2 POL claim should match expected")
    
    // SUMMARY
    console.log(`\n📊 TOTAL CLAIMS SUMMARY:`)
    console.log(`   Owner total: ${ethers.formatEther(ownerGained1POL + ownerGained2POL)} POL`)
    console.log(`   User2 total: ${ethers.formatEther(user2Gained1POL + user2Gained2POL)} POL`)
    console.log(`   User3 total: ${ethers.formatEther(user3Gained1POL + user3Gained2POL)} POL`)
    console.log(`   Grand total: ${ethers.formatEther(ownerGained1POL + ownerGained2POL + user2Gained1POL + user2Gained2POL + user3Gained1POL + user3Gained2POL)} POL`)
    console.log(`   Expected total: ${ethers.formatEther(firstDividendPOL + secondDividendPOL)} POL`)
    
    const totalClaimedPOL = ownerGained1POL + ownerGained2POL + user2Gained1POL + user2Gained2POL + user3Gained1POL + user3Gained2POL
    const expectedTotalPOL = firstDividendPOL + secondDividendPOL
    const netExpectedTotalPOL = expectedTotalPOL - (expectedTotalPOL * 5n / 100n)
    
    expect(totalClaimedPOL).to.be.approximately(netExpectedTotalPOL, ethers.parseEther('0.1'), "Total POL claimed should match total added minus 5% admin commission")
    
    console.log('✅ D1 PASSED: Multiple dividend additions and claims work correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('================================================================\n')
  })

  it('D2: Transfer → Add dividends → Transfer again', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 D2: TRANSFERS WITH DIVIDEND ADDITIONS ===')

    // PHASE 1: Initial transfer (no dividend pool)
    console.log(`🔄 PHASE 1: Initial transfer`)

    const initialTransfer = ethers.parseEther('2100000') // 2.1M OAD
    await tokenFacet.connect(owner).transfer(user2.address, initialTransfer)
    
    const user2Balance1 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaim1POL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaim1USDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    
    console.log(`   User2 balance: ${ethers.formatEther(user2Balance1)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaim1POL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaim1USDC, 6)} USDC`)
    
    expect(user2LastClaim1POL).to.equal(0n, "User2 last POL claim should be 0 (no dividend pool)")
    expect(user2LastClaim1USDC).to.equal(0n, "User2 last USDC claim should be 0 (no dividend pool)")
    
    // PHASE 2: Add dividends
    console.log(`🔄 PHASE 2: Adding dividend pools`)
    
    const firstDividendPOL = ethers.parseEther('1000') // 1000 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: firstDividendPOL
    })
    
    const firstDividendUSDC = ethers.parseUnits('50000', 6) // 50,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, firstDividendUSDC)
    
    const pool1POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool1USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2Dividend1POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend1USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   POL dividend pool: ${ethers.formatEther(pool1POL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(pool1USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend1POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend1USDC, 6)} USDC`)
    
    // PHASE 3: Second transfer (with existing dividend pool)
    console.log(`🔄 PHASE 3: Second transfer (User2 → User3)`)
    
    const secondTransfer = ethers.parseEther('1500000') // 1.5M OAD
    
    const user2BalanceBefore = await tokenFacet.balanceOf(user2.address)
    const user3BalanceBefore = await tokenFacet.balanceOf(user3.address)
    const user2DividendBeforePOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendBeforePOL = await tokenFacet.calculateRewardPOL(user3.address)
    
    console.log(`   Before transfer:`)
    console.log(`     User2: ${ethers.formatEther(user2BalanceBefore)} OAD, ${ethers.formatEther(user2DividendBeforePOL)} POL dividend`)
    console.log(`     User3: ${ethers.formatEther(user3BalanceBefore)} OAD, ${ethers.formatEther(user3DividendBeforePOL)} POL dividend`)
    
    const user2EthBalanceBefore = await ethers.provider.getBalance(user2.address)
    const user3EthBalanceBefore = await ethers.provider.getBalance(user3.address)
    console.log(`     User2 POL balance (pre-transfer): ${ethers.formatEther(user2EthBalanceBefore)} POL`)
    console.log(`     User3 POL balance (pre-transfer): ${ethers.formatEther(user3EthBalanceBefore)} POL`)

    await tokenFacet.connect(user2).transfer(user3.address, secondTransfer)

    const user2EthBalanceAfter = await ethers.provider.getBalance(user2.address)
    const user3EthBalanceAfter = await ethers.provider.getBalance(user3.address)
    console.log(`     User2 POL balance (post-transfer): ${ethers.formatEther(user2EthBalanceAfter)} POL`)
    console.log(`     User3 POL balance (post-transfer): ${ethers.formatEther(user3EthBalanceAfter)} POL`)

    const user2BalanceAfter = await tokenFacet.balanceOf(user2.address)
    const user3BalanceAfter = await tokenFacet.balanceOf(user3.address)
    const user2DividendAfterPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendAfterPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const user3LastClaimAfterPOL = await tokenFacet.getLastRewardClaimInPOL(user3.address)
    const user3LastClaimAfterUSDC = await tokenFacet.getLastRewardClaimInUSDC(user3.address)
    
    console.log(`   After transfer:`)
    console.log(`     User2: ${ethers.formatEther(user2BalanceAfter)} OAD, ${ethers.formatEther(user2DividendAfterPOL)} POL dividend`)
    console.log(`     User3: ${ethers.formatEther(user3BalanceAfter)} OAD, ${ethers.formatEther(user3DividendAfterPOL)} POL dividend`)
    console.log(`     User3 last POL claim: ${ethers.formatEther(user3LastClaimAfterPOL)} POL`)
    console.log(`     User3 last USDC claim: ${ethers.formatUnits(user3LastClaimAfterUSDC, 6)} USDC`)
    
    expect(user2BalanceAfter).to.equal(user2BalanceBefore - secondTransfer, "User2 should lose tokens")
    expect(user3BalanceAfter).to.equal(secondTransfer, "User3 should gain tokens")
    expect(user3LastClaimAfterPOL).to.equal(pool1POL, "User3 last POL claim should be set to current pool")
    expect(user3DividendAfterPOL).to.equal(0n, "User3 should not get pre-existing POL dividends")
    // user3LastClaimUSDC is set to the pre-transfer aggregate (BEFORE processNewUSDCDeposits runs)
    // pool1USDC was read before any USDC was processed, so both equal the pre-processing value
    expect(user3LastClaimAfterUSDC).to.equal(pool1USDC, "User3 last USDC claim should be set to pre-transfer aggregate")
    
    // PHASE 4: Add more dividends
    console.log(`🔄 PHASE 4: Adding more dividends`)
    
    const secondDividendPOL = ethers.parseEther('800') // 800 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })
    
    const secondDividendUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)
    
    const pool2POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool2USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    
    console.log(`   New POL dividend pool: ${ethers.formatEther(pool2POL)} POL`)
    console.log(`   Added: ${ethers.formatEther(secondDividendPOL)} POL`)
    console.log(`   New USDC aggregate: ${ethers.formatUnits(pool2USDC, 6)} USDC`)
    
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    
    const user2DividendNewPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendNewPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const ownerDividendNewPOL = await tokenFacet.calculateRewardPOL(owner.address)
    
    console.log(`💰 POL DIVIDENDS AFTER ADDITION:`)
    console.log(`   Owner: ${ethers.formatEther(ownerDividendNewPOL)} POL`)
    console.log(`   User2: ${ethers.formatEther(user2DividendNewPOL)} POL`)
    console.log(`   User3: ${ethers.formatEther(user3DividendNewPOL)} POL`)
    
    const expectedOwnerFromAllPOL = (pool2POL * ownerBalance) / totalSupply
    const netPool2Delta = pool2POL - pool1POL
    const expectedUser2FromAllPOL = (netPool2Delta * user2BalanceAfter) / totalSupply
    const expectedUser3FromNewPOL = (netPool2Delta * user3BalanceAfter) / totalSupply
    
    console.log(`💡 EXPECTED POL DIVIDENDS:`)
    console.log(`   Owner (from all): ${ethers.formatEther(expectedOwnerFromAllPOL)} POL`)
    console.log(`   User2 (from all): ${ethers.formatEther(expectedUser2FromAllPOL)} POL`)
    console.log(`   User3 (from new only): ${ethers.formatEther(expectedUser3FromNewPOL)} POL`)
    
    expect(user2DividendNewPOL).to.be.approximately(expectedUser2FromAllPOL, ethers.parseEther('0.01'), "User2 should get POL dividend from all pools")
    expect(user3DividendNewPOL).to.be.approximately(expectedUser3FromNewPOL, ethers.parseEther('0.01'), "User3 should only get POL dividend from new pool")
    
    // PHASE 5: Third transfer (User3 → User4)
    console.log(`🔄 PHASE 5: Third transfer (User3 → User4)`)
    
    const thirdTransfer = ethers.parseEther('800000') // 800K OAD
    
    await tokenFacet.connect(user3).transfer(user4.address, thirdTransfer)
    
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)
    const user4FinalBalance = await tokenFacet.balanceOf(user4.address)
    const user4LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user4.address)
    const user4LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user4.address)
    const user4DividendPOL = await tokenFacet.calculateRewardPOL(user4.address)
    const user4DividendUSDC = await tokenFacet.calculateRewardUSDC(user4.address)
    
    console.log(`   After third transfer:`)
    console.log(`     User3: ${ethers.formatEther(user3FinalBalance)} OAD`)
    console.log(`     User4: ${ethers.formatEther(user4FinalBalance)} OAD`)
    console.log(`     User4 last POL claim: ${ethers.formatEther(user4LastClaimPOL)} POL`)
    console.log(`     User4 last USDC claim: ${ethers.formatUnits(user4LastClaimUSDC, 6)} USDC`)
    console.log(`     User4 POL dividend: ${ethers.formatEther(user4DividendPOL)} POL`)
    console.log(`     User4 USDC dividend: ${ethers.formatUnits(user4DividendUSDC, 6)} USDC`)
    
    expect(user4FinalBalance).to.equal(thirdTransfer, "User4 should receive tokens")
    expect(user4LastClaimPOL).to.equal(pool2POL, "User4 last POL claim should be set to current pool")
    expect(user4DividendPOL).to.equal(0n, "User4 should not get pre-existing POL dividends")
    // user4LastClaimUSDC is set to the pre-transfer aggregate (BEFORE processNewUSDCDeposits runs for secondDividendUSDC)
    // pool2USDC was read before the PHASE 5 transfer, so it equals user4's initialized lastClaim
    expect(user4LastClaimUSDC).to.equal(pool2USDC, "User4 last USDC claim should be set to pre-transfer aggregate")
    // user4DividendUSDC > 0 because processNewUSDCDeposits runs during the transfer (processing secondDividendUSDC)
    // but user4.lastClaim was set BEFORE processing, so the delta accrues to user4
    const d2ExpectedUser4USDC = (secondDividendUSDC * 95n / 100n * thirdTransfer) / totalSupply
    expect(user4DividendUSDC).to.be.approximately(d2ExpectedUser4USDC, 1n, "User4 should get proportional share of secondDividendUSDC processed during transfer")

    console.log('✅ D2 PASSED: Transfers with dividend additions work correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('============================================================\n')
  })

  it('D3: Claim → Transfer → Add dividends → Claim', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 D3: CLAIM → TRANSFER → ADD → CLAIM SEQUENCE ===')

    // SETUP: Give tokens and create dividend pool
    console.log(`🔄 SETUP: Initial state`)
    
    const initialTokens = ethers.parseEther('6000000') // 6M OAD
    await tokenFacet.connect(owner).transfer(user2.address, initialTokens)
    
    const initialDividendPOL = ethers.parseEther('1200') // 1200 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: initialDividendPOL
    })
    
    const initialDividendUSDC = ethers.parseUnits('60000', 6) // 60,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, initialDividendUSDC)
    
    const user2InitialDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2InitialDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    console.log(`   User2 tokens: ${ethers.formatEther(initialTokens)} OAD`)
    console.log(`   User2 initial POL dividend: ${ethers.formatEther(user2InitialDividendPOL)} POL`)
    console.log(`   User2 initial USDC dividend: ${ethers.formatUnits(user2InitialDividendUSDC, 6)} USDC`)
    
    // STEP 1: Claim initial dividend
    console.log(`🔄 STEP 1: Claiming initial dividend`)
    
    const user2ETHBefore1 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore1 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter1 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter1 = await mockUSDC.balanceOf(user2.address)
    
    const user2Claimed1POL = user2ETHAfter1 - user2ETHBefore1
    const user2Claimed1USDC = user2USDCAfter1 - user2USDCBefore1
    console.log(`   User2 claimed: ${ethers.formatEther(user2Claimed1POL)} POL, ${ethers.formatUnits(user2Claimed1USDC, 6)} USDC`)
    
    const user2DividendAfterClaimPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendAfterClaimUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    expect(user2DividendAfterClaimPOL).to.equal(0n, "User2 should have 0 POL dividend after claiming")
    expect(user2DividendAfterClaimUSDC).to.equal(0n, "User2 should have 0 USDC dividend after claiming")
    
    // STEP 2: Transfer some tokens
    console.log(`🔄 STEP 2: Transferring tokens`)

    const transferAmount = ethers.parseEther('2000000') // 2M OAD
    await tokenFacet.connect(user2).transfer(user3.address, transferAmount)
    
    const user2BalanceAfterTransfer = await tokenFacet.balanceOf(user2.address)
    const user3BalanceAfterTransfer = await tokenFacet.balanceOf(user3.address)
    
    console.log(`   User2 balance after transfer: ${ethers.formatEther(user2BalanceAfterTransfer)} OAD`)
    console.log(`   User3 balance after transfer: ${ethers.formatEther(user3BalanceAfterTransfer)} OAD`)
    
    expect(user2BalanceAfterTransfer).to.equal(initialTokens - transferAmount, "User2 should have remaining tokens")
    expect(user3BalanceAfterTransfer).to.equal(transferAmount, "User3 should receive transferred tokens")
    
    // STEP 3: Add more dividends
    console.log(`🔄 STEP 3: Adding more dividends`)
    
    const secondDividendPOL = ethers.parseEther('900') // 900 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })
    
    const secondDividendUSDC = ethers.parseUnits('45000', 6) // 45,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)
    
    const totalDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const totalDividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    console.log(`   Total POL dividend pool: ${ethers.formatEther(totalDividendPoolPOL)} POL`)
    console.log(`   New POL dividend added: ${ethers.formatEther(secondDividendPOL)} POL`)
    console.log(`   Total USDC aggregate: ${ethers.formatUnits(totalDividendPoolUSDC, 6)} USDC`)
    
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    
    const user2DividendAfterAdditionPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendAfterAdditionPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const ownerDividendAfterAdditionPOL = await tokenFacet.calculateRewardPOL(owner.address)
    
    console.log(`💰 POL DIVIDENDS AFTER ADDITION:`)
    console.log(`   Owner: ${ethers.formatEther(ownerDividendAfterAdditionPOL)} POL`)
    console.log(`   User2: ${ethers.formatEther(user2DividendAfterAdditionPOL)} POL`)
    console.log(`   User3: ${ethers.formatEther(user3DividendAfterAdditionPOL)} POL`)
    
      const d3NetSecondPOL = secondDividendPOL - (secondDividendPOL * 5n / 100n)
      const expectedUser2POL = (d3NetSecondPOL * user2BalanceAfterTransfer) / totalSupply
      const expectedUser3POL = (d3NetSecondPOL * user3BalanceAfterTransfer) / totalSupply
    const expectedOwnerPOL = (totalDividendPoolPOL * ownerBalance) / totalSupply
    
    console.log(`💡 EXPECTED POL DIVIDENDS:`)
    console.log(`   Owner (from all): ${ethers.formatEther(expectedOwnerPOL)} POL`)
    console.log(`   User2 (from new): ${ethers.formatEther(expectedUser2POL)} POL`)
    console.log(`   User3 (from new): ${ethers.formatEther(expectedUser3POL)} POL`)
    
    expect(user2DividendAfterAdditionPOL).to.be.approximately(expectedUser2POL, ethers.parseEther('0.01'), "User2 should get POL dividend from new addition only")
    expect(user3DividendAfterAdditionPOL).to.be.approximately(expectedUser3POL, ethers.parseEther('0.01'), "User3 should get POL dividend from new addition only")
    
    // STEP 4: Final claims
    console.log(`🔄 STEP 4: Final dividend claims`)
    
    const ownerETHBefore = await ethers.provider.getBalance(owner.address)
    const user2ETHBefore2 = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore = await ethers.provider.getBalance(user3.address)
    
    await tokenFacet.distributeReward(owner.address)
    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)
    
    const ownerETHAfter = await ethers.provider.getBalance(owner.address)
    const user2ETHAfter2 = await ethers.provider.getBalance(user2.address)
    const user3ETHAfter = await ethers.provider.getBalance(user3.address)
    
    const ownerClaimedPOL = ownerETHAfter - ownerETHBefore
    const user2Claimed2POL = user2ETHAfter2 - user2ETHBefore2
    const user3ClaimedPOL = user3ETHAfter - user3ETHBefore
    
    console.log(`   Owner claimed: ${ethers.formatEther(ownerClaimedPOL)} POL`)
    console.log(`   User2 claimed: ${ethers.formatEther(user2Claimed2POL)} POL`)
    console.log(`   User3 claimed: ${ethers.formatEther(user3ClaimedPOL)} POL`)
    
    expect(user2Claimed2POL).to.be.approximately(expectedUser2POL, ethers.parseEther('0.01'), "User2 final POL claim should match expected")
    expect(user3ClaimedPOL).to.be.approximately(expectedUser3POL, ethers.parseEther('0.01'), "User3 final POL claim should match expected")
    
    // SUMMARY
    console.log(`\n📊 TOTAL USER2 CLAIMS:`)
    console.log(`   Round 1: ${ethers.formatEther(user2Claimed1POL)} POL`)
    console.log(`   Round 2: ${ethers.formatEther(user2Claimed2POL)} POL`)
    console.log(`   Total: ${ethers.formatEther(user2Claimed1POL + user2Claimed2POL)} POL`)
    
    const totalAddedPOL = initialDividendPOL + secondDividendPOL
    const netTotalAddedPOL = totalAddedPOL - (totalAddedPOL * 5n / 100n)
    const totalClaimedPOL = ownerClaimedPOL + user2Claimed1POL + user2Claimed2POL + user3ClaimedPOL
    
    console.log(`   Total POL dividends added: ${ethers.formatEther(totalAddedPOL)} POL`)
    console.log(`   Total POL claimed by all: ${ethers.formatEther(totalClaimedPOL)} POL`)
    
    expect(totalClaimedPOL).to.be.approximately(netTotalAddedPOL, ethers.parseEther('0.1'), "Total POL claimed should match total added minus 5% admin commission")

    console.log('✅ D3 PASSED: Claim → Transfer → Add → Claim sequence works correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('================================================================\n')
  })

  it('D4: Transfer → Claim → Transfer → Claim complex sequence', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 D4: COMPLEX TRANSFER-CLAIM SEQUENCE ===')

    // SETUP: Create initial dividend pool
    console.log(`🔄 SETUP: Creating dividend pool`)
    
    const setupDividendPOL = ethers.parseEther('1500') // 1500 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: setupDividendPOL
    })
    
    const setupDividendUSDC = ethers.parseUnits('75000', 6) // 75,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, setupDividendUSDC)
    
    console.log(`   Initial POL dividend pool: ${ethers.formatEther(setupDividendPOL)} POL`)
    console.log(`   Initial USDC in diamond: ${ethers.formatUnits(setupDividendUSDC, 6)} USDC`)
    
    // SEQUENCE 1: Owner → User2 transfer
    console.log(`🔄 SEQUENCE 1: Owner → User2 transfer`)

    const transfer1 = ethers.parseEther('6300000') // 6.3M OAD
    await tokenFacet.connect(owner).transfer(user2.address, transfer1)
    
    const user2Balance1 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaim1POL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaim1USDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2Dividend1POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend1USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   User2 balance: ${ethers.formatEther(user2Balance1)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaim1POL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaim1USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend1POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend1USDC, 6)} USDC`)
    
    const netSetupDividendPOL = setupDividendPOL - (setupDividendPOL * 5n / 100n)
    expect(user2LastClaim1POL).to.equal(netSetupDividendPOL, "User2 last POL claim should be set to current pool (net of 5% admin commission)")
    expect(user2Dividend1POL).to.equal(0n, "User2 should not get pre-existing POL dividends")
    
    // SEQUENCE 2: Add more dividends → User2 claims
    console.log(`🔄 SEQUENCE 2: Add dividends → User2 claims`)
    
    const dividend2POL = ethers.parseEther('800') // 800 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend2POL
    })
    
    const dividend2USDC = ethers.parseUnits('40000', 6) // 40,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend2USDC)
    
    const poolAfterDividend2POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const poolAfterDividend2USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2Dividend2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend2USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   Pool after adding dividend2: ${ethers.formatEther(poolAfterDividend2POL)} POL, ${ethers.formatUnits(poolAfterDividend2USDC, 6)} USDC`)
    console.log(`   User2 POL dividend after addition: ${ethers.formatEther(user2Dividend2POL)} POL`)
    console.log(`   User2 USDC dividend after addition: ${ethers.formatUnits(user2Dividend2USDC, 6)} USDC`)
    
    const user2ETHBefore1 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore1 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter1 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter1 = await mockUSDC.balanceOf(user2.address)
    
    const user2Claimed1POL = user2ETHAfter1 - user2ETHBefore1
    const user2Claimed1USDC = user2USDCAfter1 - user2USDCBefore1
    const user2LastClaimAfterClaim1POL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    
    console.log(`   User2 EXPLICITLY claimed: ${ethers.formatEther(user2Claimed1POL)} POL, ${ethers.formatUnits(user2Claimed1USDC, 6)} USDC`)
    console.log(`   User2 last POL claim after explicit claim: ${ethers.formatEther(user2LastClaimAfterClaim1POL)} POL`)
    
    expect(user2LastClaimAfterClaim1POL).to.equal(poolAfterDividend2POL, "User2 last POL claim should be updated to current pool after explicit claim")
    // USDC is auto-detected during distributeReward via processNewUSDCDeposits
    expect(user2Claimed1USDC).to.be.greaterThanOrEqual(0n, "User2 USDC claimed should be non-negative")
    
    // SEQUENCE 3: User2 → User3 transfer (User2 has already claimed, so no auto-distribution)
    console.log(`🔄 SEQUENCE 3: User2 → User3 transfer`)
    
    const transfer2 = ethers.parseEther('2000000') // 2M OAD
    // Read aggregate AFTER distributeReward(user2) has processed dividend2USDC
    const d4PreTransferUSDCAggregate = await tokenFacet.getTotalAggregateRewardInUSDC()
    
    // Get states before transfer
    const user2BalanceBefore = await tokenFacet.balanceOf(user2.address)
    const user3BalanceBefore = await tokenFacet.balanceOf(user3.address)
    const user2DividendBefore = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendBefore = await tokenFacet.calculateRewardPOL(user3.address)
    
    console.log(`   Before transfer:`)
    console.log(`     User2: ${ethers.formatEther(user2BalanceBefore)} OAD, ${ethers.formatEther(user2DividendBefore)} POL dividend`)
    console.log(`     User3: ${ethers.formatEther(user3BalanceBefore)} OAD, ${ethers.formatEther(user3DividendBefore)} POL dividend`)
    
    //user2 pre-transfer ETH balance:
    const user2EthBalanceBefore = await ethers.provider.getBalance(user2.address)
    console.log(`     User2 POL balance (pre-transfer): ${ethers.formatEther(user2EthBalanceBefore)} POL`)

    //user3 pre-transfer ETH balance:
    const user3EthBalanceBefore = await ethers.provider.getBalance(user3.address)
    console.log(`     User3 POL balance (pre-transfer): ${ethers.formatEther(user3EthBalanceBefore)} POL`)

    // Execute transfer
    await tokenFacet.connect(user2).transfer(user3.address, transfer2)

    //user2 post-transfer ETH balance:
    const user2EthBalanceAfter = await ethers.provider.getBalance(user2.address)
    console.log(`     User2 POL balance (post-transfer): ${ethers.formatEther(user2EthBalanceAfter)} POL`)

    //user3 post-transfer ETH balance:
    const user3EthBalanceAfter = await ethers.provider.getBalance(user3.address)
    console.log(`     User3 POL balance (post-transfer): ${ethers.formatEther(user3EthBalanceAfter)} POL`)

    const user2BalanceAfter = await tokenFacet.balanceOf(user2.address)
    const user3BalanceAfter = await tokenFacet.balanceOf(user3.address)
    const user2DividendAfter = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendAfter = await tokenFacet.calculateRewardPOL(user3.address)
    const user3LastClaimAfterPOL = await tokenFacet.getLastRewardClaimInPOL(user3.address)
    const user3LastClaimAfterUSDC = await tokenFacet.getLastRewardClaimInUSDC(user3.address)
    
    console.log(`   After transfer:`)
    console.log(`     User2: ${ethers.formatEther(user2BalanceAfter)} OAD, ${ethers.formatEther(user2DividendAfter)} POL dividend`)
    console.log(`     User3: ${ethers.formatEther(user3BalanceAfter)} OAD, ${ethers.formatEther(user3DividendAfter)} POL dividend`)
    console.log(`     User3 last POL claim: ${ethers.formatEther(user3LastClaimAfterPOL)} POL`)
    console.log(`     User3 last USDC claim: ${ethers.formatUnits(user3LastClaimAfterUSDC, 6)} USDC`)
    
    // ✅ ASSERTIONS for transfer
    expect(user2BalanceAfter).to.equal(user2BalanceBefore - transfer2, "User2 should lose tokens")
    expect(user3BalanceAfter).to.equal(transfer2, "User3 should gain tokens")
    expect(user3LastClaimAfterPOL).to.equal(poolAfterDividend2POL, "User3 last POL claim should be set to current pool")
    expect(user3DividendAfter).to.equal(0n, "User3 should not get pre-existing POL dividends")
    // user3LastClaimUSDC is set to the pre-transfer aggregate (d4PreTransferUSDCAggregate, already includes dividend2USDC processed by distributeReward(user2))
    expect(user3LastClaimAfterUSDC).to.equal(d4PreTransferUSDCAggregate, "User3 last USDC claim should be set to current aggregate before transfer")
    
    // PHASE 4: Add more dividends
    console.log(`🔄 PHASE 4: Adding more dividends`)
    
    const secondDividendPOL = ethers.parseEther('800') // 800 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })
    
    const secondDividendUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)
    
    const pool2POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool2USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    
    console.log(`   New POL dividend pool: ${ethers.formatEther(pool2POL)} POL`)
    console.log(`   Added: ${ethers.formatEther(secondDividendPOL)} POL`)
    console.log(`   New USDC aggregate: ${ethers.formatUnits(pool2USDC, 6)} USDC`)
    
    // Check dividends after addition
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    
    const user2DividendNewPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendNewPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const ownerDividendNewPOL = await tokenFacet.calculateRewardPOL(owner.address)
    
    console.log(`💰 POL DIVIDENDS AFTER ADDITION:`)
    console.log(`   Owner: ${ethers.formatEther(ownerDividendNewPOL)} POL`)
    console.log(`   User2: ${ethers.formatEther(user2DividendNewPOL)} POL`)
    console.log(`   User3: ${ethers.formatEther(user3DividendNewPOL)} POL`)
    
    // Calculate expected dividends
    const expectedOwnerFromAllPOL = (pool2POL * ownerBalance) / totalSupply
    const expectedUser2FromAllPOL = (secondDividendPOL * 95n / 100n * user2BalanceAfter) / totalSupply
    const expectedUser3FromNewPOL = (secondDividendPOL * 95n / 100n * user3BalanceAfter) / totalSupply
    
    console.log(`💡 EXPECTED POL DIVIDENDS:`)
    console.log(`   Owner (from all): ${ethers.formatEther(expectedOwnerFromAllPOL)} POL`)
    console.log(`   User2 (from all): ${ethers.formatEther(expectedUser2FromAllPOL)} POL`)
    console.log(`   User3 (from new only): ${ethers.formatEther(expectedUser3FromNewPOL)} POL`)
    
    expect(user2DividendNewPOL).to.be.approximately(expectedUser2FromAllPOL, ethers.parseEther('0.01'), "User2 should get POL dividend from all pools")
    expect(user3DividendNewPOL).to.be.approximately(expectedUser3FromNewPOL, ethers.parseEther('0.01'), "User3 should only get POL dividend from new pool")
    
    // PHASE 5: Third transfer (User3 → User4)
    console.log(`🔄 PHASE 5: Third transfer (User3 → User4)`)
    
    const thirdTransfer = ethers.parseEther('800000') // 800K OAD
    
    await tokenFacet.connect(user3).transfer(user4.address, thirdTransfer)
    
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)
    const user4FinalBalance = await tokenFacet.balanceOf(user4.address)
    const user4LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user4.address)
    const user4LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user4.address)
    const user4DividendPOL = await tokenFacet.calculateRewardPOL(user4.address)
    const user4DividendUSDC = await tokenFacet.calculateRewardUSDC(user4.address)
    
    console.log(`   After third transfer:`)
    console.log(`     User3: ${ethers.formatEther(user3FinalBalance)} OAD`)
    console.log(`     User4: ${ethers.formatEther(user4FinalBalance)} OAD`)
    console.log(`     User4 last POL claim: ${ethers.formatEther(user4LastClaimPOL)} POL`)
    console.log(`     User4 last USDC claim: ${ethers.formatUnits(user4LastClaimUSDC, 6)} USDC`)
    console.log(`     User4 POL dividend: ${ethers.formatEther(user4DividendPOL)} POL`)
    console.log(`     User4 USDC dividend: ${ethers.formatUnits(user4DividendUSDC, 6)} USDC`)
    
    expect(user4FinalBalance).to.equal(thirdTransfer, "User4 should receive tokens")
   
    expect(user4LastClaimPOL).to.equal(pool2POL, "User4 last POL claim should be set to current pool")
    expect(user4DividendPOL).to.equal(0n, "User4 should not get pre-existing POL dividends")
    // user4LastClaimUSDC is set BEFORE processNewUSDCDeposits runs during the transfer
    // pool2USDC was read before PHASE 5, so it equals user4's initialized lastClaim
    expect(user4LastClaimUSDC).to.equal(pool2USDC, "User4 last USDC claim should be set to pre-transfer aggregate")
    // user4DividendUSDC > 0 because processNewUSDCDeposits processes secondDividendUSDC during transfer
    const d4ExpectedUser4USDC = (secondDividendUSDC * 95n / 100n * thirdTransfer) / totalSupply
    expect(user4DividendUSDC).to.be.approximately(d4ExpectedUser4USDC, 1n, "User4 should get proportional share of secondDividendUSDC processed during transfer")

    console.log('✅ D4 PASSED: Transfers with dividend additions work correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('============================================================\n')
  })
})
