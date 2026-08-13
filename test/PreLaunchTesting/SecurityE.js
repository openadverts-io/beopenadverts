const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

// ========================================
// GROUP E: EDGE CASES & COMPLEX SCENARIOS
// ========================================
describe('Group E: Edge Cases & Complex Scenarios', function () {
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

  it('E1: Zero balance user receives tokens after multiple dividend additions', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 E1: ZERO BALANCE USER + MULTIPLE DIVIDEND ADDITIONS ===')

    // User2 starts with 0 balance
    const user2InitialBalance = await tokenFacet.balanceOf(user2.address)
    expect(user2InitialBalance).to.equal(0n, "User2 should start with 0 balance")
    
    console.log(`   User2 initial balance: ${ethers.formatEther(user2InitialBalance)} OAD`)
    
    // ROUND 1: Add dividends while user has 0 balance
    console.log(`🔄 ROUND 1: Adding dividends (user has 0 balance)`)
    
    const dividend1POL = ethers.parseEther('500') // 500 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend1POL
    })
    
    const dividend1USDC = ethers.parseUnits('25000', 6) // 25,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend1USDC)
    
    const pool1POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool1USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2Dividend1POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend1USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   POL dividend pool: ${ethers.formatEther(pool1POL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(pool1USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend1POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend1USDC, 6)} USDC`)
    
    expect(user2Dividend1POL).to.equal(0n, "User with 0 balance should get 0 POL dividend")
    expect(user2Dividend1USDC).to.equal(0n, "User with 0 balance should get 0 USDC dividend")
    
    // ROUND 2: Add more dividends while user still has 0 balance
    console.log(`🔄 ROUND 2: Adding more dividends (user still has 0 balance)`)
    
    const dividend2POL = ethers.parseEther('300') // 300 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend2POL
    })
    
    const dividend2USDC = ethers.parseUnits('15000', 6) // 15,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend2USDC)
    
    const pool2POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool2USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2Dividend2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend2USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   POL dividend pool: ${ethers.formatEther(pool2POL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(pool2USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend2POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend2USDC, 6)} USDC`)
    
    expect(user2Dividend2POL).to.equal(0n, "User with 0 balance should still get 0 POL dividend")
    expect(user2Dividend2USDC).to.equal(0n, "User with 0 balance should still get 0 USDC dividend")
    
    // ROUND 3: Add even more dividends
    console.log(`🔄 ROUND 3: Adding even more dividends (user still has 0 balance)`)
    
    const dividend3POL = ethers.parseEther('400') // 400 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend3POL
    })
    
    const dividend3USDC = ethers.parseUnits('20000', 6) // 20,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend3USDC)
    
    const pool3POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool3USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2Dividend3POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend3USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   POL dividend pool: ${ethers.formatEther(pool3POL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(pool3USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend3POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend3USDC, 6)} USDC`)
    
    expect(user2Dividend3POL).to.equal(0n, "User with 0 balance should still get 0 POL dividend")
    expect(user2Dividend3USDC).to.equal(0n, "User with 0 balance should still get 0 USDC dividend")
    
    // ROUND 4: Now give user tokens
    console.log(`🔄 ROUND 4: Finally giving tokens to user`)
    
    const tokenAmount = ethers.parseEther('3000000') // 3M OAD
    await tokenFacet.connect(owner).transfer(user2.address, tokenAmount)
    
    const user2Balance = await tokenFacet.balanceOf(user2.address)
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2DividendAfterTokensPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendAfterTokensUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   User2 balance: ${ethers.formatEther(user2Balance)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   User2 POL dividend after receiving tokens: ${ethers.formatEther(user2DividendAfterTokensPOL)} POL`)
    console.log(`   User2 USDC dividend after receiving tokens: ${ethers.formatUnits(user2DividendAfterTokensUSDC, 6)} USDC`)
    
    // ✅ KEY TEST: User should not get any dividends from before they owned tokens
    expect(user2LastClaimPOL).to.equal(pool3POL, "User's last POL claim should be set to current total pool")
    expect(user2DividendAfterTokensPOL).to.equal(0n, "User should not get POL dividends from before owning tokens")
    expect(user2LastClaimUSDC).to.equal(pool3USDC, "User's last USDC claim should be set to current aggregate")
      const e1TotalMintedUSDC = dividend1USDC + dividend2USDC + dividend3USDC
      const e1NetUSDCPool = e1TotalMintedUSDC - (e1TotalMintedUSDC * 5n / 100n)
      const e1TotalSupply = await tokenFacet.totalSupply()
      const e1User2ExpectedUSDC = (e1NetUSDCPool * tokenAmount) / e1TotalSupply
      expect(user2DividendAfterTokensUSDC).to.be.approximately(e1User2ExpectedUSDC, 1n, "User2 USDC dividend should match proportional share of detected USDC after 5% commission")
    
    // ROUND 5: Add new dividends after user has tokens
    console.log(`🔄 ROUND 5: Adding new dividends after user has tokens`)
    
    const dividend4POL = ethers.parseEther('200') // 200 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend4POL
    })
    
    const dividend4USDC = ethers.parseUnits('10000', 6) // 10,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend4USDC)
    
    const pool4POL = await tokenFacet.getTotalAggregateRewardInPOL()
    const pool4USDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendFromNewPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendFromNewUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   Final POL dividend pool: ${ethers.formatEther(pool4POL)} POL`)
    console.log(`   Final USDC aggregate: ${ethers.formatUnits(pool4USDC, 6)} USDC`)
    console.log(`   User2 POL dividend from new addition: ${ethers.formatEther(user2DividendFromNewPOL)} POL`)
    console.log(`   User2 USDC dividend from new addition: ${ethers.formatUnits(user2DividendFromNewUSDC, 6)} USDC`)
    
    // Calculate expected dividend from only the new addition
    const totalSupply = await tokenFacet.totalSupply()
    const expectedFromNewDividendPOL = (dividend4POL * 95n / 100n * user2Balance) / totalSupply
    
    console.log(`   Expected from new POL dividend: ${ethers.formatEther(expectedFromNewDividendPOL)} POL`)
    
    // ✅ ASSERTION: User should only get dividends from after they owned tokens
    expect(user2DividendFromNewPOL).to.be.approximately(expectedFromNewDividendPOL, ethers.parseEther('0.01'), "Should only get POL dividend from new addition")
    // After ROUND 4 transfer processNewUSDCDeposits ran and updated aggregate; user2.lastClaim = 0 (pre-processing)
    // dividend4USDC not yet processed (no distributeReward/transfer since mint), so USDC reward = same as ROUND 4
    expect(user2DividendFromNewUSDC).to.be.approximately(user2DividendAfterTokensUSDC, 1n, "USDC dividend unchanged since dividend4 not yet processed")
    
    // ROUND 6: Claim and verify
    console.log(`🔄 ROUND 6: Claiming final dividend`)
    
    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter = await mockUSDC.balanceOf(user2.address)
    
    const user2ClaimedPOL = user2ETHAfter - user2ETHBefore
    const user2ClaimedUSDC = user2USDCAfter - user2USDCBefore
    console.log(`   User2 claimed: ${ethers.formatEther(user2ClaimedPOL)} POL, ${ethers.formatUnits(user2ClaimedUSDC, 6)} USDC`)
    
    expect(user2ClaimedPOL).to.be.approximately(expectedFromNewDividendPOL, ethers.parseEther('0.01'), "Claimed POL amount should match expected")
    // distributeReward processes dividend4USDC AND user2 gets all accumulated USDC (dividends 1-4, since lastClaim=0)
    const e1NetDiv4USDC = dividend4USDC - (dividend4USDC * 5n / 100n)
    const e1TotalSupplyForCalc = await tokenFacet.totalSupply()
    const e1ExpectedTotalUSDC = ((e1NetUSDCPool + e1NetDiv4USDC) * tokenAmount) / e1TotalSupplyForCalc
    expect(user2ClaimedUSDC).to.be.approximately(e1ExpectedTotalUSDC, 1n, "Claimed USDC includes all dividends since lastClaim was 0")
    
    // Verify user can't claim again
    const user2DividendAfterClaimPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendAfterClaimUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    expect(user2DividendAfterClaimPOL).to.equal(0n, "User should have 0 POL dividend after claiming")
    expect(user2DividendAfterClaimUSDC).to.equal(0n, "User should have 0 USDC dividend after claiming")
    
    console.log('✅ E1 PASSED: Zero balance user with multiple dividend additions handled correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('=============================================================================\n')
  })

  it('E2: User transfers all tokens, receives new tokens, transfers again', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 E2: MULTIPLE TRANSFER ALL TOKENS CYCLES ===')

    // PHASE 1: Setup with initial tokens and dividends
    console.log(`🔄 PHASE 1: Initial setup`)
    
    const initialTokens = ethers.parseEther('4000000') // 4M OAD
    await tokenFacet.connect(owner).transfer(user2.address, initialTokens)
    
    const initialDividendPOL = ethers.parseEther('800') // 800 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: initialDividendPOL
    })
    
    const initialDividendUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, initialDividendUSDC)
    
    const user2InitialDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2InitialDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    console.log(`   User2 tokens: ${ethers.formatEther(initialTokens)} OAD`)
    console.log(`   User2 initial POL dividend: ${ethers.formatEther(user2InitialDividendPOL)} POL`)
    console.log(`   User2 initial USDC dividend: ${ethers.formatUnits(user2InitialDividendUSDC, 6)} USDC`)
    
    // Claim initial dividend
    const user2ETHBefore1 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore1 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter1 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter1 = await mockUSDC.balanceOf(user2.address)
    const user2Claimed1POL = user2ETHAfter1 - user2ETHBefore1
    const user2Claimed1USDC = user2USDCAfter1 - user2USDCBefore1
    
    console.log(`   User2 claimed initial dividend: ${ethers.formatEther(user2Claimed1POL)} POL, ${ethers.formatUnits(user2Claimed1USDC, 6)} USDC`)
    
    // PHASE 2: Transfer ALL tokens away (first time)
    console.log(`🔄 PHASE 2: First transfer of ALL tokens`)
    
    await tokenFacet.connect(user2).transfer(user3.address, initialTokens)
    
    const user2Balance1 = await tokenFacet.balanceOf(user2.address)
    const user3Balance1 = await tokenFacet.balanceOf(user3.address)
    
    console.log(`   User2 balance after transfer: ${ethers.formatEther(user2Balance1)} OAD`)
    console.log(`   User3 balance after transfer: ${ethers.formatEther(user3Balance1)} OAD`)
    
    expect(user2Balance1).to.equal(0n, "User2 should have 0 tokens")
    expect(user3Balance1).to.equal(initialTokens, "User3 should have all tokens")
    
    // Add dividends while user2 has 0 balance
    console.log(`🔄 Adding dividends while User2 has 0 balance...`)
    
    const dividend2POL = ethers.parseEther('600') // 600 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend2POL
    })
    
    const dividend2USDC = ethers.parseUnits('30000', 6) // 30,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend2USDC)
    
    const user2DividendWith0BalancePOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendWith0BalanceUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    expect(user2DividendWith0BalancePOL).to.equal(0n, "User with 0 balance should get 0 POL dividend")
    expect(user2DividendWith0BalanceUSDC).to.equal(0n, "User with 0 balance should get 0 USDC dividend")
    
    // PHASE 3: User2 receives new tokens (from user3)
    console.log(`🔄 PHASE 3: User2 receives new tokens`)
    
    const newTokens1 = ethers.parseEther('2500000') // 2.5M OAD
    await tokenFacet.connect(user3).transfer(user2.address, newTokens1)
    
    const user2Balance2 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaim2POL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaim2USDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2Dividend2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend2USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   User2 balance after receiving: ${ethers.formatEther(user2Balance2)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaim2POL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaim2USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend2POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend2USDC, 6)} USDC`)
    
    const currentPool = await tokenFacet.getTotalAggregateRewardInPOL()
    expect(user2LastClaim2POL).to.equal(currentPool, "User2's last claim should be updated to current pool")
    expect(user2Dividend2POL).to.equal(0n, "User2 should not get dividends from when they had 0 balance")
    
    // PHASE 4: Add more dividends and user2 claims
    console.log(`🔄 PHASE 4: Adding more dividends`)
    
    const dividend3POL = ethers.parseEther('400') // 400 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend3POL
    })
    
    const dividend3USDC = ethers.parseUnits('20000', 6) // 20,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend3USDC)
    
    const user2Dividend3POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend3USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    console.log(`   User2 dividend after new addition: ${ethers.formatEther(user2Dividend3POL)} POL`)
    console.log(`   User2 USDC dividend after new addition: ${ethers.formatUnits(user2Dividend3USDC, 6)} USDC`)
    
    // Claim this dividend
    const user2ETHBefore2 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore2 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter2 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter2 = await mockUSDC.balanceOf(user2.address)
    const user2Claimed2POL = user2ETHAfter2 - user2ETHBefore2
    const user2Claimed2USDC = user2USDCAfter2 - user2USDCBefore2
    
    console.log(`   User2 claimed: ${ethers.formatEther(user2Claimed2POL)} POL, ${ethers.formatUnits(user2Claimed2USDC, 6)} USDC`)
    
    // PHASE 5: Transfer ALL tokens away AGAIN (second time)
    console.log(`🔄 PHASE 5: Second transfer of ALL tokens`)
    
    await tokenFacet.connect(user2).transfer(user4.address, user2Balance2)
    
    const user2Balance3 = await tokenFacet.balanceOf(user2.address)
    const user4Balance1 = await tokenFacet.balanceOf(user4.address)
    
    console.log(`   User2 balance after second transfer: ${ethers.formatEther(user2Balance3)} OAD`)
    console.log(`   User4 balance after receiving: ${ethers.formatEther(user4Balance1)} OAD`)
    
    expect(user2Balance3).to.equal(0n, "User2 should have 0 tokens again")
    expect(user4Balance1).to.equal(newTokens1, "User4 should have all tokens")
    
    // Add more dividends while user2 has 0 balance again
    console.log(`🔄 Adding more dividends while User2 has 0 balance again...`)
    
    const dividend4POL = ethers.parseEther('300') // 300 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend4POL
    })
    
    const dividend4USDC = ethers.parseUnits('15000', 6) // 15,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend4USDC)
    
    const user2DividendWith0Balance2POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendWith0Balance2USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    expect(user2DividendWith0Balance2POL).to.equal(0n, "User with 0 balance should get 0 POL dividend again")
    expect(user2DividendWith0Balance2USDC).to.equal(0n, "User with 0 balance should get 0 USDC dividend again")
    
    // PHASE 6: User2 receives tokens AGAIN (third time)
    console.log(`🔄 PHASE 6: User2 receives tokens again`)
    
    const newTokens2 = ethers.parseEther('1800000') // 1.8M OAD
    await tokenFacet.connect(user4).transfer(user2.address, newTokens2)
    
    const user2Balance4 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaim3POL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaim3USDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2Dividend4POL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2Dividend4USDC = await tokenFacet.calculateRewardUSDC(user2.address)
    
    console.log(`   User2 balance after receiving again: ${ethers.formatEther(user2Balance4)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaim3POL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaim3USDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2Dividend4POL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2Dividend4USDC, 6)} USDC`)
    
    const finalPool = await tokenFacet.getTotalAggregateRewardInPOL()
    expect(user2LastClaim3POL).to.equal(finalPool, "User2's last claim should be updated to final pool")
    expect(user2Dividend4POL).to.equal(0n, "User2 should not get dividends from when they had 0 balance")
    
    // PHASE 7: Add final dividends and verify user2 gets them
    console.log(`🔄 PHASE 7: Final dividend test`)
    
    const dividend5POL = ethers.parseEther('200') // 200 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend5POL
    })
    
    const dividend5USDC = ethers.parseUnits('10000', 6) // 10,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividend5USDC)
    
    const user2FinalDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2FinalDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    console.log(`   User2 final POL dividend: ${ethers.formatEther(user2FinalDividendPOL)} ETH`)
    console.log(`   User2 final USDC dividend: ${ethers.formatUnits(user2FinalDividendUSDC, 6)} USDC`)
    
    // Calculate expected from only the latest addition
    const totalSupply = await tokenFacet.totalSupply()
      const e2NetDividend5POL = dividend5POL - (dividend5POL * 5n / 100n)
      const expectedFinalPOL = (e2NetDividend5POL * user2Balance4) / totalSupply
    
    expect(user2FinalDividendPOL).to.be.approximately(expectedFinalPOL, ethers.parseEther('0.01'), "Should only get POL dividend from latest addition")
    // user2FinalDividendUSDC reflects dividend4USDC processed during PHASE 6 transfer (user4→user2)
    // user2's lastClaim was set to pre-processNewUSDCDeposits aggregate, so after PHASE 6 transfer they can see dividend4USDC
    const e2NetDividend4USDC = dividend4USDC - (dividend4USDC * 5n / 100n)
    const e2ExpectedUSDCFromDiv4 = (e2NetDividend4USDC * user2Balance4) / totalSupply
    expect(user2FinalDividendUSDC).to.be.approximately(e2ExpectedUSDCFromDiv4, 1n, "User2 USDC dividend from dividend4 processed during PHASE 6 transfer")
    
    console.log(`📊 SUMMARY OF USER2'S JOURNEY:`)
    console.log(`   Claim 1: ${ethers.formatEther(user2Claimed1POL)} POL (initial tokens)`)
    console.log(`   Claim 2: ${ethers.formatEther(user2Claimed2POL)} POL (after first re-acquisition)`)
    console.log(`   Expected final: ${ethers.formatEther(expectedFinalPOL)} POL (after second re-acquisition)`)

    console.log('✅ E2 PASSED: Multiple transfer all tokens cycles handled correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('===============================================================\n')
  })

  it('E3: Rapid successive transfers with dividend pool changes', async function () {
    const { tokenFacet, owner, user2, user3, user4, user5, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 E3: RAPID SUCCESSIVE TRANSFERS WITH DIVIDEND CHANGES ===')

    // Setup: Give initial tokens to start the chain
    const initialAmount = ethers.parseEther('8000000') // 8M OAD
    await tokenFacet.connect(owner).transfer(user2.address, initialAmount)
    
    console.log(`🔄 SETUP: User2 starts with ${ethers.formatEther(initialAmount)} OAD`)
    
    // RAPID SEQUENCE: Transfer → Dividend → Transfer → Dividend → Transfer...
    const transfers = [
      { from: user2, to: user3, amount: ethers.parseEther('2000000'), dividend: ethers.parseEther('300') },
      { from: user3, to: user4, amount: ethers.parseEther('1500000'), dividend: ethers.parseEther('250') },
      { from: user4, to: user5, amount: ethers.parseEther('1000000'), dividend: ethers.parseEther('200') },
      { from: user5, to: user2, amount: ethers.parseEther('800000'), dividend: ethers.parseEther('150') },
      { from: user2, to: user3, amount: ethers.parseEther('600000'), dividend: ethers.parseEther('100') }
    ]
    
    const users = [
      { signer: owner, name: 'Owner', address: owner.address },
      { signer: user2, name: 'User2', address: user2.address },
      { signer: user3, name: 'User3', address: user3.address },
      { signer: user4, name: 'User4', address: user4.address },
      { signer: user5, name: 'User5', address: user5.address }
    ]
    
    let totalDividendsAdded = 0n
    
    console.log(`🔄 EXECUTING RAPID TRANSFER SEQUENCE:`)
    
    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i]
      
      console.log(`\n--- STEP ${i + 1}: ${transfer.from === user2 ? 'User2' : transfer.from === user3 ? 'User3' : transfer.from === user4 ? 'User4' : 'User5'} → ${transfer.to === user2 ? 'User2' : transfer.to === user3 ? 'User3' : transfer.to === user4 ? 'User4' : 'User5'} ---`)
      
      // Execute transfer
      await tokenFacet.connect(transfer.from).transfer(transfer.to.address, transfer.amount)
      console.log(`   Transferred: ${ethers.formatEther(transfer.amount)} OAD`)
      
      // Add dividend
      await owner.sendTransaction({
        to: diamondAddress,
        value: transfer.dividend
      })
      totalDividendsAdded += transfer.dividend
      console.log(`   Added dividend: ${ethers.formatEther(transfer.dividend)} ETH`)
      
      // Display current state
      const totalPool = await tokenFacet.getTotalAggregateRewardInPOL()
      console.log(`   Total POL dividend pool: ${ethers.formatEther(totalPool)} ETH`)
      
      // Show balances and dividends for all users
      const totalSupply = await tokenFacet.totalSupply()
      
      for (const user of users) {
        const balance = await tokenFacet.balanceOf(user.address)
        const dividendPOL = await tokenFacet.calculateRewardPOL(user.address)
        const dividendUSDC = await tokenFacet.calculateRewardUSDC(user.address)
        const lastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user.address)
        const lastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user.address)
        
        if (balance > 0n || dividendPOL > 0n || dividendUSDC > 0n) {
          const percentage = balance > 0n ? (balance * 100n) / totalSupply : 0n
          console.log(`   ${user.name}: ${ethers.formatEther(balance)} OAD (${percentage}%), ${ethers.formatEther(dividendPOL)} ETH dividend, last POL claim: ${ethers.formatEther(lastClaimPOL)} ETH, ${ethers.formatUnits(dividendUSDC, 6)} USDC dividend, last USDC claim: ${ethers.formatUnits(lastClaimUSDC, 6)} ETH`)
        }
      }
    }
    
    // FINAL VERIFICATION: Check that all dividend calculations are correct
    console.log(`\n🔄 FINAL VERIFICATION:`)
    
    const finalTotalPool = await tokenFacet.getTotalAggregateRewardInPOL()
    const totalSupply = await tokenFacet.totalSupply()
    
    console.log(`   Total dividends added: ${ethers.formatEther(totalDividendsAdded)} ETH`)
    console.log(`   Final POL dividend pool: ${ethers.formatEther(finalTotalPool)} ETH`)
    
      const e3NetTotalDividends = totalDividendsAdded - (totalDividendsAdded * 5n / 100n)
      expect(finalTotalPool).to.be.approximately(e3NetTotalDividends, ethers.parseEther('0.01'), "Final pool should equal total dividends added minus 5% admin commission")
    
    // Calculate total expected dividends
    let totalExpectedDividends = 0n
    
    console.log(`💰 FINAL DIVIDEND CALCULATIONS:`)
    
    for (const user of users) {
      const balance = await tokenFacet.balanceOf(user.address)
      const dividendPOL = await tokenFacet.calculateRewardPOL(user.address)
      const dividendUSDC = await tokenFacet.calculateRewardUSDC(user.address)
      const lastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user.address)
      const lastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user.address)
      
      totalExpectedDividends += dividendPOL
      
      if (balance > 0n || dividendPOL > 0n || dividendUSDC > 0n) {
        const percentage = balance > 0n ? (balance * 100n) / totalSupply : 0n
        console.log(`   ${user.name}: ${ethers.formatEther(balance)} OAD (${percentage}%), ${ethers.formatEther(dividendPOL)} ETH dividend`)
        
        // ✅ KEY ASSERTION: Users should only get dividends from after they acquired tokens
        if (balance > 0n) {
          expect(lastClaimPOL).to.be.lessThanOrEqual(finalTotalPool, `${user.name} last claim should not exceed total pool`)
          expect(dividendPOL).to.be.lessThanOrEqual((finalTotalPool * balance) / totalSupply, `${user.name} dividend should not exceed proportional share`)
        } else {
          expect(dividendPOL).to.equal(0n, `${user.name} with 0 balance should have 0 dividend`)
        }
      }
    }
    
    console.log(`   Total expected dividends: ${ethers.formatEther(totalExpectedDividends)} ETH`)
    
    // The total expected dividends should be reasonable (not exceed total pool)
    expect(totalExpectedDividends).to.be.lessThanOrEqual(finalTotalPool, "Total expected dividends should not exceed pool")
    
    // CLAIM TEST: Try claiming all dividends
    console.log(`🔄 TESTING FINAL CLAIMS:`)
    
    let totalClaimed = 0n
    
    for (const user of users) {
      const dividendPOL = await tokenFacet.calculateRewardPOL(user.address)
      const dividendUSDC = await tokenFacet.calculateRewardUSDC(user.address)
      
      if (dividendPOL > 0n) {
        const ethBefore = await ethers.provider.getBalance(user.address)
        await tokenFacet.distributeReward(user.address)
        const ethAfter = await ethers.provider.getBalance(user.address)
        
        const claimed = ethAfter - ethBefore
        totalClaimed += claimed
        
        console.log(`   ${user.name} claimed: ${ethers.formatEther(claimed)} ETH`)
        
        expect(claimed).to.be.approximately(dividendPOL, ethers.parseEther('0.01'), `${user.name} claim should match calculated`)
      }
    }
    
    console.log(`   Total claimed: ${ethers.formatEther(totalClaimed)} ETH`)
    
    // Verify total claimed is reasonable
    expect(totalClaimed).to.be.approximately(totalExpectedDividends, ethers.parseEther('0.1'), "Total claimed should match total expected")
    
    console.log('✅ E3 PASSED: Rapid successive transfers with dividend changes handled correctly')
    console.log('==============================================================================\n')
  })

  it('E4: Circular transfers with multiple dividend additions', async function () {
    const { tokenFacet, owner, user2, user3, user4, user5, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 E4: CIRCULAR TRANSFERS WITH MULTIPLE DIVIDEND ADDITIONS ===')

    // Setup: Distribute tokens to all users initially
    const initialDistributions = [
      { user: user2, amount: ethers.parseEther('3000000'), name: 'User2' },
      { user: user3, amount: ethers.parseEther('2500000'), name: 'User3' },
      { user: user4, amount: ethers.parseEther('2000000'), name: 'User4' },
      { user: user5, amount: ethers.parseEther('1500000'), name: 'User5' }
    ]
    
    console.log(`🔄 INITIAL SETUP: Distributing tokens`)
    
    for (const dist of initialDistributions) {
      await tokenFacet.connect(owner).transfer(dist.user.address, dist.amount)
      console.log(`   ${dist.name}: ${ethers.formatEther(dist.amount)} OAD`)
    }

    
    // Add initial dividend pool
    const initialDividend = ethers.parseEther('1000') // 1000 ETH
    await owner.sendTransaction({
      to: diamondAddress,
      value: initialDividend
    })
    
    console.log(`   Initial dividend pool: ${ethers.formatEther(initialDividend)} ETH`)
    
    // ROUND 1: Everyone claims initial dividends
    console.log(`\n🔄 ROUND 1: Initial dividend claims`)
    
    const initialClaims = {}
    const users = [
      { signer: owner, name: 'Owner', address: owner.address },
      { signer: user2, name: 'User2', address: user2.address },
      { signer: user3, name: 'User3', address: user3.address },
      { signer: user4, name: 'User4', address: user4.address },
      { signer: user5, name: 'User5', address: user5.address }
    ]

    let ownerClaimed = 0n
    let user2Claimed = 0n
    let user3Claimed = 0n
    let user4Claimed = 0n
    let user5Claimed = 0n
    
    for (const user of users) {
      const dividendPOL = await tokenFacet.calculateRewardPOL(user.address)
      const dividendUSDC = await tokenFacet.calculateRewardUSDC(user.address)
      console.log("Dividend for", user.name, "is", ethers.formatEther(dividendPOL), "ETH")
      const ethBefore = await ethers.provider.getBalance(user.address)
      
      await tokenFacet.distributeReward(user.address)
      
      const ethAfter = await ethers.provider.getBalance(user.address)
      const claimed = ethAfter - ethBefore
      
      initialClaims[user.name] = claimed
      if (user.name === 'Owner') ownerClaimed = dividendPOL
      if (user.name === 'User2') user2Claimed = dividendPOL
      if (user.name === 'User3') user3Claimed = dividendPOL
      if (user.name === 'User4') user4Claimed = dividendPOL
      if (user.name === 'User5') user5Claimed = dividendPOL

      console.log(`   ${user.name} claimed: ${ethers.formatEther(claimed)} ETH`)
    }
    
    // ROUND 2: Circular transfers
    console.log(`\n🔄 ROUND 2: Circular transfers`)
    
    const circularTransfers = [
      { from: user2, to: user3, amount: ethers.parseEther('500000'), fromName: 'User2', toName: 'User3' },
      { from: user3, to: user4, amount: ethers.parseEther('400000'), fromName: 'User3', toName: 'User4' },
      { from: user4, to: user5, amount: ethers.parseEther('300000'), fromName: 'User4', toName: 'User5' },
      { from: user5, to: user2, amount: ethers.parseEther('200000'), fromName: 'User5', toName: 'User2' }
    ]
    
    for (const transfer of circularTransfers) {
      await tokenFacet.connect(transfer.from).transfer(transfer.to.address, transfer.amount)
      console.log(`   ${transfer.fromName} → ${transfer.toName}: ${ethers.formatEther(transfer.amount)} OAD`)
    }
    
    // Add dividend after circular transfers
    const dividend2 = ethers.parseEther('600') // 600 ETH
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend2
    })
    
    console.log(`   Added dividend: ${ethers.formatEther(dividend2)} ETH`)
    
    // ROUND 3: More circular transfers (reverse direction)
    console.log(`\n🔄 ROUND 3: Reverse circular transfers`)
    
    const reverseTransfers = [
      
      { from: user2, to: user5, amount: ethers.parseEther('150000'), fromName: 'User2', toName: 'User5' },
      { from: user5, to: user4, amount: ethers.parseEther('250000'), fromName: 'User5', toName: 'User4' },
      { from: user4, to: user3, amount: ethers.parseEther('200000'), fromName: 'User4', toName: 'User3' },
      { from: user3, to: user2, amount: ethers.parseEther('300000'), fromName: 'User3', toName: 'User2' }
    ]

    // prior to transfer (which will call distributeReward), check dividends by calling the calculateDividend and distributeReward functions separately

    let ownerDividendBeforeDividend2
    let user2DividendBeforeDividend2
    let user3DividendBeforeDividend2
    let user4DividendBeforeDividend2
    let user5DividendBeforeDividend2

    ownerDividendBeforeDividend2 = await tokenFacet.calculateRewardPOL(owner.address)
    //add ownerDividendBeforeDividend2 to the initialClaims[Owner]
    initialClaims['Owner'] += ownerDividendBeforeDividend2
    console.log(`   Before transfer, Owner has dividend: ${ethers.formatEther(ownerDividendBeforeDividend2)} ETH`)

    for (const transfer of reverseTransfers) {
      const dividendBefore = await tokenFacet.calculateRewardPOL(transfer.from.address)
      // if (transfer.fromName === 'Owner') ownerDividendBeforeDividend2 = dividendBefore
      if (transfer.fromName === 'User2') user2DividendBeforeDividend2 = dividendBefore
      if (transfer.fromName === 'User3') user3DividendBeforeDividend2 = dividendBefore
      if (transfer.fromName === 'User4') user4DividendBeforeDividend2 = dividendBefore
      if (transfer.fromName === 'User5') user5DividendBeforeDividend2 = dividendBefore
      // add to initialClaims
      initialClaims[transfer.fromName] += dividendBefore
      console.log(`   Before transfer, ${transfer.fromName} has dividend: ${ethers.formatEther(dividendBefore)} ETH`)
    }
    
    for (const transfer of reverseTransfers) {
      await tokenFacet.connect(transfer.from).transfer(transfer.to.address, transfer.amount)
      console.log(`   ${transfer.fromName} → ${transfer.toName}: ${ethers.formatEther(transfer.amount)} OAD`)

    }

    // Have owner claim dividend due to a lack of transfers either from or to:
    await tokenFacet.distributeReward(owner.address)

    // Check dividends after transfers
    for (const user of users) {
      const dividendAfter = await tokenFacet.calculateRewardPOL(user.address)
      // expect(dividendAfter).to.be.equal(0n, `${user.name} dividend should be non-negative`)
      console.log(`   After transfers, ${user.name} has dividend: ${ethers.formatEther(dividendAfter)} ETH`)
    }
    
    // Add more dividends
    const dividend3 = ethers.parseEther('400') // 400 ETH
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend3
    })
    
    console.log(`   Added dividend: ${ethers.formatEther(dividend3)} ETH`)
    
    // ROUND 4: Complex multi-way transfers
    console.log(`\n🔄 ROUND 4: Complex multi-way transfers`)
    
    const complexTransfers = [
      { from: user2, to: user4, amount: ethers.parseEther('100000'), fromName: 'User2', toName: 'User4' },
      { from: user3, to: user5, amount: ethers.parseEther('150000'), fromName: 'User3', toName: 'User5' },
      { from: user4, to: user2, amount: ethers.parseEther('120000'), fromName: 'User4', toName: 'User2' },
      { from: user5, to: user3, amount: ethers.parseEther('180000'), fromName: 'User5', toName: 'User3' }
    ]

    // ckeck dividends before transfer
    let ownerDividendBeforeDividend3
    let user2DividendBeforeDividend3
    let user3DividendBeforeDividend3
    let user4DividendBeforeDividend3
    let user5DividendBeforeDividend3

    ownerDividendBeforeDividend3 = await tokenFacet.calculateRewardPOL(owner.address)

    // add ownerDividendBeforeDividend3 to the initialClaims[Owner]
    initialClaims['Owner'] += ownerDividendBeforeDividend3

    console.log(`   Before transfer, Owner has dividend: ${ethers.formatEther(ownerDividendBeforeDividend3)} ETH`)
    for (const transfer of complexTransfers) {
      const dividendBefore = await tokenFacet.calculateRewardPOL(transfer.from.address)
      // if (transfer.fromName === 'Owner') ownerDividendBeforeDividend3 = dividendBefore
      if (transfer.fromName === 'User2') user2DividendBeforeDividend3 = dividendBefore
      if (transfer.fromName === 'User3') user3DividendBeforeDividend3 = dividendBefore
      if (transfer.fromName === 'User4') user4DividendBeforeDividend3 = dividendBefore
      if (transfer.fromName === 'User5') user5DividendBeforeDividend3 = dividendBefore
      console.log(`   Before transfer, ${transfer.fromName} has dividend: ${ethers.formatEther(dividendBefore)} ETH`)

      // add to initialClaims
      initialClaims[transfer.fromName] += dividendBefore
    }

    // have owner claim due to a lack of transfers either from or to:
    await tokenFacet.distributeReward(owner.address)
    
    for (const transfer of complexTransfers) {
      await tokenFacet.connect(transfer.from).transfer(transfer.to.address, transfer.amount)
      console.log(`   ${transfer.fromName} → ${transfer.toName}: ${ethers.formatEther(transfer.amount)} OAD`)
    }

    // Check dividends after transfers
    for (const user of users) {
      const dividendAfter = await tokenFacet.calculateRewardPOL(user.address)
      // expect(dividendAfter).to.be.equal(0n, `${user.name} dividend should be non-negative`)
      console.log(`   After transfers, ${user.name} has dividend: ${ethers.formatEther(dividendAfter)} ETH`)
    }
    
    // Final dividend addition
    const dividend4 = ethers.parseEther('300') // 300 ETH
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividend4
    })
    
    console.log(`   Added final dividend: ${ethers.formatEther(dividend4)} ETH`)
    
    // FINAL STATE ANALYSIS
    console.log(`\n📊 FINAL STATE ANALYSIS:`)
    
    const totalDividendsAdded = initialDividend + dividend2 + dividend3 + dividend4
    const finalDividendPool = await tokenFacet.getTotalAggregateRewardInPOL()
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    
    console.log(`   Total dividends added: ${ethers.formatEther(totalDividendsAdded)} ETH`)
    console.log(`   Final POL dividend pool: ${ethers.formatEther(finalDividendPool)} ETH`)
    
      const e4NetTotalDividends = totalDividendsAdded - (totalDividendsAdded * 5n / 100n)
      expect(finalDividendPool).to.be.approximately(e4NetTotalDividends, ethers.parseEther('0.01'), "Final pool should equal total added minus 5% admin commission")
    
    // Analyze final balances and dividends
    let totalFinalDividends = 0n
    let totalFinalBalances = 0n
    
    console.log(`💰 FINAL USER STATES:`)
    
    // Include owner in analysis
    const allUsers = [
      // { signer: owner, name: 'Owner', address: owner.address },
      ...users
    ]
    
    for (const user of allUsers) {
      const balance = await tokenFacet.balanceOf(user.address)
      const dividend = await tokenFacet.calculateRewardPOL(user.address)
      const lastClaim = await tokenFacet.getLastRewardClaimInPOL(user.address)
      
      totalFinalDividends += dividend
      totalFinalBalances += balance
      
      const percentage = balance > 0n ? (balance * 100n) / totalSupply : 0n
      
      console.log(`   ${user.name}:`)
      console.log(`     Balance: ${ethers.formatEther(balance)} OAD (${percentage}%)`)
      console.log(`     Dividend: ${ethers.formatEther(dividend)} ETH`)
      console.log(`     Last Claim: ${ethers.formatEther(lastClaim)} ETH`)
      
      // ✅ ASSERTIONS
      if (balance > 0n) {
        expect(dividend).to.be.lessThanOrEqual((finalDividendPool * balance) / totalSupply, `${user.name} dividend should not exceed proportional share`)
      } else {
        expect(dividend).to.equal(0n, `${user.name} with 0 balance should have 0 dividend`)
      }
    }
    
    console.log(`   Total balances: ${ethers.formatEther(totalFinalBalances)} OAD`)
    console.log(`   Total dividends: ${ethers.formatEther(totalFinalDividends)} ETH`)
    
    // FINAL CLAIMS TEST
    console.log(`\n🔄 FINAL CLAIMS TEST:`)
    
    let grandTotalClaimed = 0n
    const finalClaims = {}
    
    for (const user of allUsers) {
      const dividend = await tokenFacet.calculateRewardPOL(user.address)
      console.log(`   ${user.name} has dividend: ${ethers.formatEther(dividend)} ETH`)
      
      if (dividend > 0n) {
        const ethBefore = await ethers.provider.getBalance(user.address)
        await tokenFacet.distributeReward(user.address)
        const ethAfter = await ethers.provider.getBalance(user.address)
        
        const claimed = ethAfter - ethBefore
        grandTotalClaimed += claimed
        finalClaims[user.name] = claimed
        
        console.log(`   ${user.name} final claim: ${ethers.formatEther(claimed)} ETH`)
        
        expect(claimed).to.be.approximately(dividend, ethers.parseEther('0.01'), `${user.name} final claim should match calculated`)
      } else {
        finalClaims[user.name] = 0n
      }
    }
    
    console.log(`   Grand total claimed: ${ethers.formatEther(grandTotalClaimed)} ETH`)
    
    // Calculate total all claims (initial + final)
    const totalAllClaims = Object.keys(initialClaims).reduce((sum, name) => {
      return sum + initialClaims[name] + (finalClaims[name] || 0n)
    }, 0n)
    
    console.log(`   Total all claims (all rounds): ${ethers.formatEther(totalAllClaims)} ETH`)
    console.log(`   Total dividends added: ${ethers.formatEther(totalDividendsAdded)} ETH`)
    
    expect(totalAllClaims).to.be.approximately(e4NetTotalDividends, ethers.parseEther('0.1'), "Total all claims should approximately equal total dividends added minus 5% admin commission")
    
    console.log('✅ E4 PASSED: Circular transfers with multiple dividend additions handled correctly')
    console.log('===============================================================================\n')
  })
})
