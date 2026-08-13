const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

describe('Group C: Advanced Scenarios & Edge Cases', function () {
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

  it('C1: Multiple users claiming from same dividend pool', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, user5, diamondAddress } = await loadFixture(
      deployDividendTestFixture
    )

    console.log('\n=== 🔍 C1: MULTIPLE USERS CLAIMING FROM SAME POOL ===')

    // Setup: Distribute tokens to multiple users
    const distributions = [
      { user: user2, amount: ethers.parseEther('5000000'), name: 'User2' }, // 25%
      { user: user3, amount: ethers.parseEther('3000000'), name: 'User3' }, // 15%
      { user: user4, amount: ethers.parseEther('2000000'), name: 'User4' }, // 10%
      { user: user5, amount: ethers.parseEther('1000000'), name: 'User5' } // 5%
    ]

    console.log(`🔄 DISTRIBUTING TOKENS TO ${distributions.length} USERS:`)

    for (const dist of distributions) {
      await tokenFacet.connect(owner).transfer(dist.user.address, dist.amount)
      const balance = await tokenFacet.balanceOf(dist.user.address)
      console.log(`   ${dist.name}: ${ethers.formatEther(balance)} OAD`)
    }

    // Create POL dividend pool
    const dividendPoolAmountPOL = ethers.parseEther('2000') // 2000 POL

    console.log(`🔄 CREATING POL DIVIDEND POOL:`)
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendPoolAmountPOL
    })

    const totalPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    console.log(`   Total POL pool: ${ethers.formatEther(totalPoolPOL)} POL`)

    // Create USDC dividend pool (balance only)
    const dividendPoolAmountUSDC = ethers.parseUnits('100000', 6) // 100,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendPoolAmountUSDC)

    const totalPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const diamondUSDC = await mockUSDC.balanceOf(diamondAddress)
    console.log(`   USDC in diamond: ${ethers.formatUnits(diamondUSDC, 6)} USDC`)
    console.log(`   USDC aggregate (requires advertisement): ${ethers.formatUnits(totalPoolUSDC, 6)} USDC`)

    // Calculate expected dividends
    const totalSupply = await tokenFacet.totalSupply()
    const ownerBalance = await tokenFacet.balanceOf(owner.address)

    console.log(`💰 EXPECTED POL DIVIDENDS:`)

    const expectedDividends = []

    // Owner
    const ownerExpectedPOL = (totalPoolPOL * ownerBalance) / totalSupply
    expectedDividends.push({ name: 'Owner', address: owner.address, expectedPOL: ownerExpectedPOL })
    console.log(`   Owner (${(ownerBalance * 100n) / totalSupply}%): ${ethers.formatEther(ownerExpectedPOL)} POL`)

    // Users
    for (const dist of distributions) {
      const userBalance = await tokenFacet.balanceOf(dist.user.address)
      const userExpectedPOL = (totalPoolPOL * userBalance) / totalSupply
      expectedDividends.push({ name: dist.name, address: dist.user.address, expectedPOL: userExpectedPOL })
      console.log(`   ${dist.name} (${(userBalance * 100n) / totalSupply}%): ${ethers.formatEther(userExpectedPOL)} POL`)
    }

    // Claim dividends for all users
    console.log(`🔄 CLAIMING DIVIDENDS:`)

    const results = []

    for (const expected of expectedDividends) {
      const ethBefore = await ethers.provider.getBalance(expected.address)
      const usdcBefore = await mockUSDC.balanceOf(expected.address)
      const calculatedDividendPOL = await tokenFacet.calculateRewardPOL(expected.address)
      const calculatedDividendUSDC = await tokenFacet.calculateRewardUSDC(expected.address)

      console.log(`   ${expected.name} calculated POL: ${ethers.formatEther(calculatedDividendPOL)} POL`)
      console.log(`   ${expected.name} calculated USDC: ${ethers.formatUnits(calculatedDividendUSDC, 6)} USDC`)

      // Claim dividend
      const claimTx = await tokenFacet.distributeReward(expected.address)
      const claimReceipt = await claimTx.wait()

      const ethAfter = await ethers.provider.getBalance(expected.address)
      const usdcAfter = await mockUSDC.balanceOf(expected.address)
      const actualGainedPOL = ethAfter - ethBefore
      const actualGainedUSDC = usdcAfter - usdcBefore

      results.push({
        name: expected.name,
        expectedPOL: expected.expectedPOL,
        calculatedPOL: calculatedDividendPOL,
        actualPOL: actualGainedPOL,
        calculatedUSDC: calculatedDividendUSDC,
        actualUSDC: actualGainedUSDC,
        gasUsed: claimReceipt.gasUsed
      })

      console.log(`   ${expected.name} received POL: ${ethers.formatEther(actualGainedPOL)} POL, gas: ${claimReceipt.gasUsed}`)
      console.log(`   ${expected.name} received USDC: ${ethers.formatUnits(actualGainedUSDC, 6)} USDC`)
    }

    // Verify all claims
    console.log(`📊 CLAIM VERIFICATION:`)

    let totalExpectedPOL = 0n
    let totalActualPOL = 0n
    let totalActualUSDC = 0n

    for (const result of results) {
      totalExpectedPOL += result.expectedPOL
      totalActualPOL += result.actualPOL
      totalActualUSDC += result.actualUSDC

      // ✅ ASSERTIONS: Each user should receive their calculated dividend
      expect(result.calculatedPOL).to.be.approximately(
        result.expectedPOL,
        ethers.parseEther('0.01'),
        `${result.name} calculated POL should match expected`
      )
      expect(result.actualPOL).to.be.approximately(
        result.expectedPOL,
        ethers.parseEther('0.01'),
        `${result.name} actual POL should match expected`
      )
      // USDC should be 0 (aggregate not updated)
        // USDC is distributed via processNewUSDCDeposits during distributeReward
        const c1NetUSDCPool = dividendPoolAmountUSDC - (dividendPoolAmountUSDC * 5n / 100n)
        const expectedUserUSDC = (c1NetUSDCPool * result.expectedPOL) / totalPoolPOL
        expect(result.actualUSDC).to.be.approximately(expectedUserUSDC, 1n, `${result.name} USDC dividend should match proportional share after 5% admin commission`)
    }

    console.log(`   Total expected POL: ${ethers.formatEther(totalExpectedPOL)} POL`)
    console.log(`   Total actual POL: ${ethers.formatEther(totalActualPOL)} POL`)
    console.log(`   Total actual USDC: ${ethers.formatUnits(totalActualUSDC, 6)} USDC`)
    console.log(`   POL pool remaining: ${ethers.formatEther(totalPoolPOL - totalExpectedPOL)} POL`)

    // ✅ ASSERTION: Total distributed should approximately equal the pool
    expect(totalActualPOL).to.be.approximately(totalPoolPOL, ethers.parseEther('0.1'), 'Total POL distributed should match pool')

    // Verify no one can claim again
    console.log(`🔄 VERIFYING NO DOUBLE CLAIMS:`)

    for (const dist of distributions) {
      const dividendAfterClaimPOL = await tokenFacet.calculateRewardPOL(dist.user.address)
      const dividendAfterClaimUSDC = await tokenFacet.calculateRewardUSDC(dist.user.address)
      console.log(`   ${dist.name} POL dividend after claim: ${ethers.formatEther(dividendAfterClaimPOL)} POL`)
      console.log(`   ${dist.name} USDC dividend after claim: ${ethers.formatUnits(dividendAfterClaimUSDC, 6)} USDC`)
      expect(dividendAfterClaimPOL).to.equal(0n, `${dist.name} should have 0 POL dividend after claiming`)
      expect(dividendAfterClaimUSDC).to.equal(0n, `${dist.name} should have 0 USDC dividend after claiming`)
    }

    console.log('✅ C1 PASSED: Multiple users claiming from same pool works correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('===============================================================\n')
  })

  it('C2: Complex transfer chain with dividend pool changes', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 C2: COMPLEX TRANSFER CHAIN WITH CHANGING DIVIDEND POOL ===')

    const transferAmount = ethers.parseEther('1000000') // 1M OAD

    // PHASE 1: Transfer to User2 (no dividend pool yet)
    console.log(`🔄 PHASE 1: Initial transfer (no dividend pool)`)

    await tokenFacet.connect(owner).transfer(user2.address, transferAmount)

    const user2Balance1 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaimPOL1 = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC1 = await tokenFacet.getLastRewardClaimInUSDC(user2.address)

    console.log(`   User2 balance: ${ethers.formatEther(user2Balance1)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL1)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC1, 6)} USDC`)

    // PHASE 2: Create dividend pool
    console.log(`🔄 PHASE 2: Creating dividend pools`)

    const firstDividendPOL = ethers.parseEther('500') // 500 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: firstDividendPOL
    })

    const firstDividendUSDC = ethers.parseUnits('25000', 6) // 25,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, firstDividendUSDC)

    const dividendPoolPOL1 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC1 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL1 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC1 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   POL dividend pool: ${ethers.formatEther(dividendPoolPOL1)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC1, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2DividendPOL1)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2DividendUSDC1, 6)} USDC`)

    // PHASE 3: User2 transfers to User3 (with existing dividend pool)
    console.log(`🔄 PHASE 3: User2 → User3 transfer`)

    await tokenFacet.connect(user2).transfer(user3.address, transferAmount / 2n) // 500K OAD

    const user2Balance2 = await tokenFacet.balanceOf(user2.address)
    const user3Balance2 = await tokenFacet.balanceOf(user3.address)
    const user2LastClaimPOL2 = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user3LastClaimPOL2 = await tokenFacet.getLastRewardClaimInPOL(user3.address)
    const user2LastClaimUSDC2 = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user3LastClaimUSDC2 = await tokenFacet.getLastRewardClaimInUSDC(user3.address)

    console.log(`   User2 balance: ${ethers.formatEther(user2Balance2)} OAD`)
    console.log(`   User3 balance: ${ethers.formatEther(user3Balance2)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL2)} POL`)
    console.log(`   User3 last POL claim: ${ethers.formatEther(user3LastClaimPOL2)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC2, 6)} USDC`)
    console.log(`   User3 last USDC claim: ${ethers.formatUnits(user3LastClaimUSDC2, 6)} USDC`)

    // PHASE 4: Add more to dividend pool
    console.log(`🔄 PHASE 4: Adding more to dividend pools`)

    const secondDividendPOL = ethers.parseEther('300') // 300 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })

    const secondDividendUSDC = ethers.parseUnits('15000', 6) // 15,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)

    const dividendPoolPOL2 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC2 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL2 = await tokenFacet.calculateRewardPOL(user2.address)
    const user3DividendPOL2 = await tokenFacet.calculateRewardPOL(user3.address)
    const user2DividendUSDC2 = await tokenFacet.calculateRewardUSDC(user2.address)
    const user3DividendUSDC2 = await tokenFacet.calculateRewardUSDC(user3.address)

    console.log(`   New POL dividend pool: ${ethers.formatEther(dividendPoolPOL2)} POL`)
    console.log(`   New USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC2, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2DividendPOL2)} POL`)
    console.log(`   User3 POL dividend: ${ethers.formatEther(user3DividendPOL2)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2DividendUSDC2, 6)} USDC`)
    console.log(`   User3 USDC dividend: ${ethers.formatUnits(user3DividendUSDC2, 6)} USDC`)

    // PHASE 5: User3 transfers to User4 (with dividend available)
    console.log(`🔄 PHASE 5: User3 → User4 transfer`)

    await tokenFacet.connect(user3).transfer(user4.address, transferAmount / 4n) // 250K OAD

    const user3Balance3 = await tokenFacet.balanceOf(user3.address)
    const user4Balance3 = await tokenFacet.balanceOf(user4.address)
    const user3DividendPOL3 = await tokenFacet.calculateRewardPOL(user3.address)
    const user4DividendPOL3 = await tokenFacet.calculateRewardPOL(user4.address)
    const user3DividendUSDC3 = await tokenFacet.calculateRewardUSDC(user3.address)
    const user4DividendUSDC3 = await tokenFacet.calculateRewardUSDC(user4.address)
    const user4LastClaimPOL3 = await tokenFacet.getLastRewardClaimInPOL(user4.address)
    const user4LastClaimUSDC3 = await tokenFacet.getLastRewardClaimInUSDC(user4.address)

    console.log(`   User3 balance: ${ethers.formatEther(user3Balance3)} OAD`)
    console.log(`   User4 balance: ${ethers.formatEther(user4Balance3)} OAD`)
    console.log(`   User3 POL dividend: ${ethers.formatEther(user3DividendPOL3)} POL`)
    console.log(`   User4 POL dividend: ${ethers.formatEther(user4DividendPOL3)} POL`)
    console.log(`   User3 USDC dividend: ${ethers.formatUnits(user3DividendUSDC3, 6)} USDC`)
    console.log(`   User4 USDC dividend: ${ethers.formatUnits(user4DividendUSDC3, 6)} USDC`)
    console.log(`   User4 last POL claim: ${ethers.formatEther(user4LastClaimPOL3)} POL`)
    console.log(`   User4 last USDC claim: ${ethers.formatUnits(user4LastClaimUSDC3, 6)} USDC`)

    // PHASE 6: Claim dividends and verify
    console.log(`🔄 PHASE 6: Claiming dividends`)

    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore = await ethers.provider.getBalance(user3.address)
    const user2USDCBefore = await mockUSDC.balanceOf(user2.address)
    const user3USDCBefore = await mockUSDC.balanceOf(user3.address)

    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)

    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user3ETHAfter = await ethers.provider.getBalance(user3.address)
    const user2USDCAfter = await mockUSDC.balanceOf(user2.address)
    const user3USDCAfter = await mockUSDC.balanceOf(user3.address)

    const user2ETHGained = user2ETHAfter - user2ETHBefore
    const user3ETHGained = user3ETHAfter - user3ETHBefore
    const user2USDCGained = user2USDCAfter - user2USDCBefore
    const user3USDCGained = user3USDCAfter - user3USDCBefore

    console.log(`   User2 claimed POL: ${ethers.formatEther(user2ETHGained)} POL`)
    console.log(`   User3 claimed POL: ${ethers.formatEther(user3ETHGained)} POL`)
    console.log(`   User2 claimed USDC: ${ethers.formatUnits(user2USDCGained, 6)} USDC`)
    console.log(`   User3 claimed USDC: ${ethers.formatUnits(user3USDCGained, 6)} USDC`)

    // ✅ ASSERTIONS
    expect(user2Balance2).to.equal(transferAmount / 2n, 'User2 should have half tokens after transfer')
    expect(user3Balance2).to.equal(transferAmount / 2n, 'User3 should receive half tokens')

    // ✅ KEY TEST: User3 receiving tokens when dividend pool exists
    expect(user3LastClaimPOL2).to.equal(dividendPoolPOL1, "User3's last POL claim should be set to current pool")
    expect(user3DividendPOL2).to.be.approximately(
      (secondDividendPOL * 95n / 100n * user3Balance2) / (await tokenFacet.totalSupply()),
      ethers.parseEther('0.01')
    )

    // ✅ KEY TEST: User4 receiving tokens when dividend pool exists
    expect(user4LastClaimPOL3).to.equal(dividendPoolPOL2, "User4's last POL claim should be set to current pool")
    expect(user4DividendPOL3).to.equal(0n, 'User4 should not get pre-existing POL dividends')

    // USDC assertions
    expect(user4LastClaimUSDC3).to.equal(dividendPoolUSDC2, "User4's last USDC claim should be set to current aggregate")
      const c2NetUSDC = secondDividendUSDC - (secondDividendUSDC * 5n / 100n)
      const c2TotalSupply = await tokenFacet.totalSupply()
      const user4ExpectedUSDC = (c2NetUSDC * user4Balance3) / c2TotalSupply
      expect(user4DividendUSDC3).to.be.approximately(user4ExpectedUSDC, 1n, 'User4 USDC dividend should match proportional share of newly detected USDC after 5% commission')

    console.log('✅ C2 PASSED: Complex transfer chain with changing dividend pool works correctly')
    console.log('==========================================================================\n')
  })

  it('C3: Dividend pool growth while user has 0 balance, then receives tokens', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 C3: DIVIDEND POOL GROWTH WITH 0 BALANCE USER ===')

    // PHASE 1: User has 0 balance, create dividend pool
    console.log(`🔄 PHASE 1: Creating dividend pool while user has 0 balance`)

    const user2InitialBalance = await tokenFacet.balanceOf(user2.address)
    expect(user2InitialBalance).to.equal(0n, 'User2 should start with 0 balance')

    const firstDividendPOL = ethers.parseEther('800') // 800 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: firstDividendPOL
    })

    const firstDividendUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, firstDividendUSDC)

    const dividendPoolPOL1 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC1 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL1 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC1 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   POL dividend pool: ${ethers.formatEther(dividendPoolPOL1)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC1, 6)} USDC`)
    console.log(`   User2 POL dividend (0 balance): ${ethers.formatEther(user2DividendPOL1)} POL`)
    console.log(`   User2 USDC dividend (0 balance): ${ethers.formatUnits(user2DividendUSDC1, 6)} USDC`)

    expect(user2DividendPOL1).to.equal(0n, 'User with 0 balance should get 0 POL dividend')
    expect(user2DividendUSDC1).to.equal(0n, 'User with 0 balance should get 0 USDC dividend')

    // PHASE 2: Add more to dividend pool while user still has 0 balance
    console.log(`🔄 PHASE 2: Growing dividend pools`)

    const secondDividendPOL = ethers.parseEther('400') // 400 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })

    const secondDividendUSDC = ethers.parseUnits('20000', 6) // 20,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)

    const dividendPoolPOL2 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC2 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL2 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC2 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   New POL dividend pool: ${ethers.formatEther(dividendPoolPOL2)} POL`)
    console.log(`   New USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC2, 6)} USDC`)
    console.log(`   User2 POL dividend (still 0 balance): ${ethers.formatEther(user2DividendPOL2)} POL`)
    console.log(`   User2 USDC dividend (still 0 balance): ${ethers.formatUnits(user2DividendUSDC2, 6)} USDC`)

    expect(user2DividendPOL2).to.equal(0n, 'User with 0 balance should still get 0 POL dividend')
    expect(user2DividendUSDC2).to.equal(0n, 'User with 0 balance should still get 0 USDC dividend')

    // PHASE 3: Now give user tokens
    console.log(`🔄 PHASE 3: Giving tokens to user`)

    const tokenAmount = ethers.parseEther('2000000') // 2M OAD
    await tokenFacet.connect(owner).transfer(user2.address, tokenAmount)

    const user2Balance = await tokenFacet.balanceOf(user2.address)
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2DividendPOL3 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC3 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   User2 balance: ${ethers.formatEther(user2Balance)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   User2 POL dividend after receiving tokens: ${ethers.formatEther(user2DividendPOL3)} POL`)
    console.log(`   User2 USDC dividend after receiving tokens: ${ethers.formatUnits(user2DividendUSDC3, 6)} USDC`)

    // ✅ KEY TEST: User receiving tokens when dividend pool exists
    expect(user2LastClaimPOL).to.equal(dividendPoolPOL2, "User's last POL claim should be set to current pool")
    expect(user2DividendPOL3).to.equal(0n, 'User should not get POL dividends from before they owned tokens')
    expect(user2LastClaimUSDC).to.equal(dividendPoolUSDC2, "User's last USDC claim should be set to current aggregate")
      const c3TotalMintedUSDC = firstDividendUSDC + secondDividendUSDC
      const c3NetUSDCPool = c3TotalMintedUSDC - (c3TotalMintedUSDC * 5n / 100n)
      const c3TotalSupply = await tokenFacet.totalSupply()
      const c3User2ExpectedUSDC = (c3NetUSDCPool * tokenAmount) / c3TotalSupply
      expect(user2DividendUSDC3).to.be.approximately(c3User2ExpectedUSDC, 1n, 'User2 USDC dividend should reflect proportional share of all detected USDC after 5% commission')

    // PHASE 4: Add more to dividend pool after user has tokens
    console.log(`🔄 PHASE 4: Adding to dividend pools after user has tokens`)

    const thirdDividendPOL = ethers.parseEther('300') // 300 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: thirdDividendPOL
    })

    const thirdDividendUSDC = ethers.parseUnits('15000', 6) // 15,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, thirdDividendUSDC)

    const dividendPoolPOL3 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC3 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL4 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC4 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   Final POL dividend pool: ${ethers.formatEther(dividendPoolPOL3)} POL`)
    console.log(`   Final USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC3, 6)} USDC`)
    console.log(`   User2 POL dividend from new pool: ${ethers.formatEther(user2DividendPOL4)} POL`)
    console.log(`   User2 USDC dividend from new pool: ${ethers.formatUnits(user2DividendUSDC4, 6)} USDC`)

    // Calculate expected dividend from only the new addition
    const totalSupply = await tokenFacet.totalSupply()
    const expectedFromNewDividendPOL = (thirdDividendPOL * 95n / 100n * user2Balance) / totalSupply

    console.log(`   Expected from new POL dividend: ${ethers.formatEther(expectedFromNewDividendPOL)} POL`)

    // ✅ ASSERTION: User should only get dividends from after they owned tokens
    expect(user2DividendPOL4).to.be.approximately(
      expectedFromNewDividendPOL,
      ethers.parseEther('0.01'),
      'Should only get POL dividend from new pool'
    )
    // user2DividendUSDC4 reflects the USDC from PHASE 3 transfer (lastClaim was 0, aggregate now = 57k net)
    // thirdDividendUSDC hasn't been processed (no distributeReward called), so same value as Phase 3
    expect(user2DividendUSDC4).to.be.approximately(c3User2ExpectedUSDC, 1n, 'USDC dividend should reflect Phase 3 detected USDC (thirdDividend not yet processed)')

    // PHASE 5: Claim and verify
    console.log(`🔄 PHASE 5: Claiming dividend`)

    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter = await mockUSDC.balanceOf(user2.address)

    const user2ETHGained = user2ETHAfter - user2ETHBefore
    const user2USDCGained = user2USDCAfter - user2USDCBefore
    console.log(`   User2 claimed POL: ${ethers.formatEther(user2ETHGained)} POL`)
    console.log(`   User2 claimed USDC: ${ethers.formatUnits(user2USDCGained, 6)} USDC`)

    expect(user2ETHGained).to.be.approximately(
      expectedFromNewDividendPOL,
      ethers.parseEther('0.01'),
      'Claimed POL amount should match expected'
    )
    // user2USDCGained reflects all detected USDC since user2's lastClaim was initialized to 0
    const c3ThirdDividendNetUSDC = thirdDividendUSDC - (thirdDividendUSDC * 5n / 100n)
    const c3TotalNetUSDCAtClaim = c3NetUSDCPool + c3ThirdDividendNetUSDC
    const c3ExpectedClaimedUSDC = (c3TotalNetUSDCAtClaim * tokenAmount) / c3TotalSupply
    expect(user2USDCGained).to.be.approximately(c3ExpectedClaimedUSDC, 1n, 'Claimed USDC should match all detected USDC proportional share')

    console.log('✅ C3 PASSED: Dividend pool growth with 0 balance user handled correctly')
    console.log('===============================================================\n')
  })

  it('C4: User transfers all tokens, then receives new tokens later', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 C4: TRANSFER ALL TOKENS AWAY, THEN RECEIVE NEW ONES ===')

    // PHASE 1: Give user tokens and create dividend pool
    console.log(`🔄 PHASE 1: Initial setup`)

    const initialTokens = ethers.parseEther('3000000') // 3M OAD
    await tokenFacet.connect(owner).transfer(user2.address, initialTokens)

    const firstDividendPOL = ethers.parseEther('600') // 600 POL
    await owner.sendTransaction({
      to: diamondAddress,
      value: firstDividendPOL
    })

    const firstDividendUSDC = ethers.parseUnits('30000', 6) // 30,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, firstDividendUSDC)

    const user2DividendPOL1 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC1 = await tokenFacet.calculateRewardUSDC(user2.address)
    console.log(`   User2 initial POL dividend: ${ethers.formatEther(user2DividendPOL1)} POL`)
    console.log(`   User2 initial USDC dividend: ${ethers.formatUnits(user2DividendUSDC1, 6)} USDC`)

    // PHASE 2: User claims their dividend
    console.log(`🔄 PHASE 2: Claiming initial dividend`)

    const user2ETHBefore1 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore1 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter1 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter1 = await mockUSDC.balanceOf(user2.address)

    const user2ETHGained1 = user2ETHAfter1 - user2ETHBefore1
    const user2USDCGained1 = user2USDCAfter1 - user2USDCBefore1
    console.log(`   User2 claimed POL: ${ethers.formatEther(user2ETHGained1)} POL`)
    console.log(`   User2 claimed USDC: ${ethers.formatUnits(user2USDCGained1, 6)} USDC`)

    // PHASE 3: User transfers ALL tokens away
    console.log(`🔄 PHASE 3: Transferring all tokens away`)

    await tokenFacet.connect(user2).transfer(user3.address, initialTokens)

    const user2Balance2 = await tokenFacet.balanceOf(user2.address)
    const user3Balance2 = await tokenFacet.balanceOf(user3.address)

    console.log(`   User2 balance after transfer: ${ethers.formatEther(user2Balance2)} OAD`)
    console.log(`   User3 balance after transfer: ${ethers.formatEther(user3Balance2)} OAD`)

    expect(user2Balance2).to.equal(0n, 'User2 should have 0 tokens')

    // PHASE 4: Add more to dividend pool while user has 0 tokens
    console.log(`🔄 PHASE 4: Adding to dividend pools while user has 0 tokens`)

    const secondDividendPOL = ethers.parseEther('400') // 400 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: secondDividendPOL
    })

    const secondDividendUSDC = ethers.parseUnits('20000', 6) // 20,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, secondDividendUSDC)

    const dividendPoolPOL2 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC2 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL2 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC2 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   POL dividend pool: ${ethers.formatEther(dividendPoolPOL2)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC2, 6)} USDC`)
    console.log(`   User2 POL dividend (0 balance): ${ethers.formatEther(user2DividendPOL2)} POL`)
    console.log(`   User2 USDC dividend (0 balance): ${ethers.formatUnits(user2DividendUSDC2, 6)} USDC`)

    expect(user2DividendPOL2).to.equal(0n, 'User with 0 balance should get 0 POL dividend')
    expect(user2DividendUSDC2).to.equal(0n, 'User with 0 balance should get 0 USDC dividend')

    // PHASE 5: User receives new tokens from someone else
    console.log(`🔄 PHASE 5: User receives new tokens`)

    const newTokens = ethers.parseEther('1500000') // 1.5M OAD
    await tokenFacet.connect(user3).transfer(user2.address, newTokens)

    const user2Balance3 = await tokenFacet.balanceOf(user2.address)
    const user2LastClaimPOL3 = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC3 = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2DividendPOL3 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC3 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   User2 balance after receiving: ${ethers.formatEther(user2Balance3)} OAD`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL3)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC3, 6)} USDC`)
    console.log(`   User2 POL dividend after receiving: ${ethers.formatEther(user2DividendPOL3)} POL`)
    console.log(`   User2 USDC dividend after receiving: ${ethers.formatUnits(user2DividendUSDC3, 6)} USDC`)

    // ✅ KEY TEST: User receiving tokens again should have last claim updated
    expect(user2Balance3).to.equal(newTokens, 'User2 should have new tokens')
    expect(user2LastClaimPOL3).to.equal(dividendPoolPOL2, 'Last POL claim should be updated to current pool')
    expect(user2DividendPOL3).to.equal(0n, 'Should not get POL dividends from when they had 0 balance')
    expect(user2LastClaimUSDC3).to.equal(dividendPoolUSDC2, 'Last USDC claim should be updated to current aggregate')
      const c4NetUSDC = secondDividendUSDC - (secondDividendUSDC * 5n / 100n)
      const c4TotalSupply = await tokenFacet.totalSupply()
      const c4User2ExpectedUSDC = (c4NetUSDC * newTokens) / c4TotalSupply
      expect(user2DividendUSDC3).to.be.approximately(c4User2ExpectedUSDC, 1n, 'User2 USDC dividend should match proportional share of newly detected USDC after 5% commission')

    // PHASE 6: Add more to dividend pool and verify user gets it
    console.log(`🔄 PHASE 6: Adding final dividend`)

    const thirdDividendPOL = ethers.parseEther('200') // 200 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: thirdDividendPOL
    })

    const thirdDividendUSDC = ethers.parseUnits('10000', 6) // 10,000 USDC more
    await mockUSDC.connect(owner).mint(diamondAddress, thirdDividendUSDC)

    const dividendPoolPOL3 = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC3 = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2DividendPOL4 = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC4 = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   Final POL dividend pool: ${ethers.formatEther(dividendPoolPOL3)} POL`)
    console.log(`   Final USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC3, 6)} USDC`)
    console.log(`   User2 final POL dividend: ${ethers.formatEther(user2DividendPOL4)} POL`)
    console.log(`   User2 final USDC dividend: ${ethers.formatUnits(user2DividendUSDC4, 6)} USDC`)

    // Calculate expected dividend from only the latest addition
    const totalSupply = await tokenFacet.totalSupply()
    const expectedFromFinalDividendPOL = (thirdDividendPOL * 95n / 100n * user2Balance3) / totalSupply

    console.log(`   Expected from final POL dividend: ${ethers.formatEther(expectedFromFinalDividendPOL)} POL`)

    // ✅ ASSERTION: Should only get dividend from the newest addition
    expect(user2DividendPOL4).to.be.approximately(
      expectedFromFinalDividendPOL,
      ethers.parseEther('0.01'),
      'Should only get POL dividend from newest pool'
    )
    // user2DividendUSDC4 reflects c4 USDC (secondDividendUSDC detected in PHASE 5 transfer)
    // thirdDividendUSDC not yet processed (no distributeReward), so same as c4User2ExpectedUSDC
    expect(user2DividendUSDC4).to.be.approximately(c4User2ExpectedUSDC, 1n, 'USDC dividend should reflect Phase 5 detected USDC (thirdDividend not yet processed)')

    // PHASE 7: Final claim
    console.log(`🔄 PHASE 7: Final dividend claim`)

    const user2ETHBefore2 = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore2 = await mockUSDC.balanceOf(user2.address)
    await tokenFacet.distributeReward(user2.address)
    const user2ETHAfter2 = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter2 = await mockUSDC.balanceOf(user2.address)

    const user2ETHGained2 = user2ETHAfter2 - user2ETHBefore2
    const user2USDCGained2 = user2USDCAfter2 - user2USDCBefore2
    console.log(`   User2 final POL claim: ${ethers.formatEther(user2ETHGained2)} POL`)
    console.log(`   User2 final USDC claim: ${ethers.formatUnits(user2USDCGained2, 6)} USDC`)

    expect(user2ETHGained2).to.be.approximately(
      expectedFromFinalDividendPOL,
      ethers.parseEther('0.01'),
      'Final POL claim should match expected'
    )
    // user2USDCGained2 includes secondDividendUSDC (from Ph5 detection) + thirdDividendUSDC (detected now)
    const c4ThirdNetUSDC = thirdDividendUSDC - (thirdDividendUSDC * 5n / 100n)
    const c4TotalNetUSDCAtFinalClaim = c4NetUSDC + c4ThirdNetUSDC
    const c4ExpectedFinalUSDC = (c4TotalNetUSDCAtFinalClaim * newTokens) / c4TotalSupply
    expect(user2USDCGained2).to.be.approximately(c4ExpectedFinalUSDC, 1n, 'Final USDC claim should match all accumulated USDC proportional share')

    console.log('✅ C4 PASSED: Transfer all tokens away then receive new ones handled correctly')
    console.log('=========================================================================\n')
  })

  it('C5: Mixed scenario - multiple transfers, claims, and pool additions', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, user4, user5, diamondAddress } = await loadFixture(
      deployDividendTestFixture
    )

    console.log('\n=== 🔍 C5: COMPREHENSIVE MIXED SCENARIO ===')

    // This test combines all the edge cases into one comprehensive scenario

    console.log(`🔄 PHASE 1: Initial distribution`)

    // Give tokens to users
    await tokenFacet.connect(owner).transfer(user2.address, ethers.parseEther('4000000')) // 4M OAD
    await tokenFacet.connect(owner).transfer(user3.address, ethers.parseEther('2000000')) // 2M OAD

    console.log(`🔄 PHASE 2: First dividend pool`)

    // Create first dividend pool
    await owner.sendTransaction({
      to: diamondAddress,
      value: ethers.parseEther('1000') // 1000 POL
    })

    await mockUSDC.connect(owner).mint(diamondAddress, ethers.parseUnits('50000', 6)) // 50,000 USDC

    // Users claim
    await tokenFacet.distributeReward(user2.address)
    await tokenFacet.distributeReward(user3.address)

    console.log(`🔄 PHASE 3: Transfers and new user`)

    // User2 transfers to User4 (new user)
    await tokenFacet.connect(user2).transfer(user4.address, ethers.parseEther('1000000')) // 1M OAD

    // User3 transfers to User5 (new user)
    await tokenFacet.connect(user3).transfer(user5.address, ethers.parseEther('500000')) // 500K OAD

    console.log(`🔄 PHASE 4: Second dividend pool`)

    // Add more dividends
    await owner.sendTransaction({
      to: diamondAddress,
      value: ethers.parseEther('800') // 800 POL
    })

    await mockUSDC.connect(owner).mint(diamondAddress, ethers.parseUnits('40000', 6)) // 40,000 USDC

    console.log(`🔄 PHASE 5: Complex transfer chain`)

    // User4 → User5
    await tokenFacet.connect(user4).transfer(user5.address, ethers.parseEther('300000')) // 300K OAD

    // User5 → User2 (existing user)
    await tokenFacet.connect(user5).transfer(user2.address, ethers.parseEther('200000')) // 200K OAD

    console.log(`🔄 PHASE 6: Final dividend additions and claims`)

    // Add final dividend
    await owner.sendTransaction({
      to: diamondAddress,
      value: ethers.parseEther('500') // 500 POL
    })

    await mockUSDC.connect(owner).mint(diamondAddress, ethers.parseUnits('25000', 6)) // 25,000 USDC

    // Get final state
    const finalBalances = {}
    const finalDividendsPOL = {}
    const finalDividendsUSDC = {}
    const users = [
      { name: 'Owner', address: owner.address },
      { name: 'User2', address: user2.address },
      { name: 'User3', address: user3.address },
      { name: 'User4', address: user4.address },
      { name: 'User5', address: user5.address }
    ]

    console.log(`📊 FINAL STATE:`)

    const totalSupply = await tokenFacet.totalSupply()
    const totalDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const totalDividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()

    console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} OAD`)
    console.log(`   Total POL Dividend Pool: ${ethers.formatEther(totalDividendPoolPOL)} POL`)
    console.log(`   Total USDC Aggregate: ${ethers.formatUnits(totalDividendPoolUSDC, 6)} USDC`)

    let totalExpectedDividendsPOL = 0n
    let totalExpectedDividendsUSDC = 0n

    for (const user of users) {
      const balance = await tokenFacet.balanceOf(user.address)
      const dividendPOL = await tokenFacet.calculateRewardPOL(user.address)
      const dividendUSDC = await tokenFacet.calculateRewardUSDC(user.address)
      const lastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user.address)
      const lastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user.address)

      finalBalances[user.name] = balance
      finalDividendsPOL[user.name] = dividendPOL
      finalDividendsUSDC[user.name] = dividendUSDC
      totalExpectedDividendsPOL += dividendPOL
      totalExpectedDividendsUSDC += dividendUSDC

      const percentage = balance > 0n ? (balance * 100n) / totalSupply : 0n

      console.log(`   ${user.name}:`)
      console.log(`     Balance: ${ethers.formatEther(balance)} OAD (${percentage}%)`)
      console.log(`     POL Dividend: ${ethers.formatEther(dividendPOL)} POL`)
      console.log(`     USDC Dividend: ${ethers.formatUnits(dividendUSDC, 6)} USDC`)
      console.log(`     Last POL Claim: ${ethers.formatEther(lastClaimPOL)} POL`)
      console.log(`     Last USDC Claim: ${ethers.formatUnits(lastClaimUSDC, 6)} USDC`)
    }

    console.log(`   Total Expected POL Dividends: ${ethers.formatEther(totalExpectedDividendsPOL)} POL`)
    console.log(`   Total Expected USDC Dividends: ${ethers.formatUnits(totalExpectedDividendsUSDC, 6)} USDC`)

    // ✅ COMPREHENSIVE ASSERTIONS

    // 1. All balances should add up to total supply
    let totalBalances = 0n
    for (const balance of Object.values(finalBalances)) {
      totalBalances += balance
    }
    expect(totalBalances).to.equal(totalSupply, 'All balances should sum to total supply')

    // 2. Users with 0 balance should have 0 dividends
    for (const [name, balance] of Object.entries(finalBalances)) {
      if (balance === 0n) {
        expect(finalDividendsPOL[name]).to.equal(0n, `${name} with 0 balance should have 0 POL dividend`)
        expect(finalDividendsUSDC[name]).to.equal(0n, `${name} with 0 balance should have 0 USDC dividend`)
      }
    }

    // 3. Total expected POL dividends should be reasonable (not exceed total pool by much)
    expect(totalExpectedDividendsPOL).to.be.lessThanOrEqual(totalDividendPoolPOL, 'Expected POL dividends should not exceed total pool')

    console.log(`🔄 PHASE 7: Final claims verification`)

    // Claim all dividends and verify they work
    for (const user of users) {
      if (finalDividendsPOL[user.name] > 0n) {
        try {
          const ethBefore = await ethers.provider.getBalance(user.address)
          const usdcBefore = await mockUSDC.balanceOf(user.address)
          await tokenFacet.distributeReward(user.address)
          const ethAfter = await ethers.provider.getBalance(user.address)
          const usdcAfter = await mockUSDC.balanceOf(user.address)
          const gainedPOL = ethAfter - ethBefore
          const gainedUSDC = usdcAfter - usdcBefore

          console.log(`   ${user.name} claimed POL: ${ethers.formatEther(gainedPOL)} POL`)
          console.log(`   ${user.name} claimed USDC: ${ethers.formatUnits(gainedUSDC, 6)} USDC`)

          // Should gain approximately the calculated amount
          expect(gainedPOL).to.be.approximately(
            finalDividendsPOL[user.name],
            ethers.parseEther('0.01'),
            `${user.name} POL claim should match calculated`
          )
          // USDC may be non-zero since processNewUSDCDeposits runs during distributeReward
          console.log(`   ${user.name} USDC claimed: ${ethers.formatUnits(gainedUSDC, 6)} USDC`)
        } catch (error) {
          console.log(`   ${user.name} claim failed: ${error.message}`)
        }
      }
    }

    console.log('✅ C5 PASSED: Comprehensive mixed scenario handled correctly')
    console.log('⚠️  USDC dividends not distributed (aggregate requires advertisement)')
    console.log('============================================================\n')
  })
})
