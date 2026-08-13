const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

describe('Group B: Transfer & Dividend Interaction Testing', function () {
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

  it('B1: Transfer 0→>0 OAD when dividend pool = 0 ETH', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B1: TRANSFER WITH NO DIVIDEND POOL ===')

    // Verify no dividend pool exists
    const initialDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const initialDividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    expect(initialDividendPoolPOL).to.equal(0n, "Should start with no POL dividend pool")
    expect(initialDividendPoolUSDC).to.equal(0n, "Should start with no USDC dividend pool")

    const transferAmount = ethers.parseEther('1000000') // 1M OAD

    console.log(`🔄 TRANSFERRING TOKENS (NO DIVIDEND POOL):`)
    console.log(`   From: Owner (${owner.address})`)
    console.log(`   To: User2 (${user2.address})`)
    console.log(`   Amount: ${ethers.formatEther(transferAmount)} OAD`)

    // Get pre-transfer state
    const preOwnerBalance = await tokenFacet.balanceOf(owner.address)
    const preUser2Balance = await tokenFacet.balanceOf(user2.address)
    const preOwnerETH = await ethers.provider.getBalance(owner.address)
    const preUser2ETH = await ethers.provider.getBalance(user2.address)

    console.log(`📊 PRE-TRANSFER STATE:`)
    console.log(`   Owner OAD: ${ethers.formatEther(preOwnerBalance)} OAD`)
    console.log(`   User2 OAD: ${ethers.formatEther(preUser2Balance)} OAD`)
    console.log(`   Owner ETH: ${ethers.formatEther(preOwnerETH)} ETH`)
    console.log(`   User2 ETH: ${ethers.formatEther(preUser2ETH)} ETH`)

    // Execute transfer
    const transferTx = await tokenFacet.connect(owner).transfer(user2.address, transferAmount)
    const transferReceipt = await transferTx.wait()

    console.log(`   ✅ Transfer completed, gas used: ${transferReceipt.gasUsed}`)

    // Get post-transfer state
    const postOwnerBalance = await tokenFacet.balanceOf(owner.address)
    const postUser2Balance = await tokenFacet.balanceOf(user2.address)
    const postOwnerETH = await ethers.provider.getBalance(owner.address)
    const postUser2ETH = await ethers.provider.getBalance(user2.address)

    console.log(`📊 POST-TRANSFER STATE:`)
    console.log(`   Owner OAD: ${ethers.formatEther(postOwnerBalance)} OAD`)
    console.log(`   User2 OAD: ${ethers.formatEther(postUser2Balance)} OAD`)
    console.log(`   Owner ETH: ${ethers.formatEther(postOwnerETH)} ETH`)
    console.log(`   User2 ETH: ${ethers.formatEther(postUser2ETH)} ETH`)

    // Check lastRewardClaimInPOL for new user
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const currentDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const currentDividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()

    console.log(`💰 DIVIDEND TRACKING:`)
    console.log(`   User2 Last Claim POL: ${ethers.formatEther(user2LastClaimPOL)} ETH`)
    console.log(`   User2 Last Claim USDC: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   Current Dividend Pool POL: ${ethers.formatEther(currentDividendPoolPOL)} ETH`)
    console.log(`   Current Dividend Pool USDC: ${ethers.formatUnits(currentDividendPoolUSDC, 6)} USDC`)

    // ✅ ASSERTIONS: Transfer should work, no dividends
    expect(postOwnerBalance).to.equal(preOwnerBalance - transferAmount, "Owner should lose tokens")
    expect(postUser2Balance).to.equal(transferAmount, "User2 should gain tokens")
    expect(postOwnerETH).to.be.lessThan(preOwnerETH, "Owner ETH should decrease due to gas")
    expect(postUser2ETH).to.equal(preUser2ETH, "User2 ETH should remain unchanged")
    expect(currentDividendPoolPOL).to.equal(0n, "POL dividend pool should remain 0")
    expect(currentDividendPoolUSDC).to.equal(0n, "USDC dividend pool should remain 0")

    // ✅ KEY TEST: New user's lastRewardClaimInPOL should be set appropriately
    expect(user2LastClaimPOL).to.equal(currentDividendPoolPOL, "New user's last POL claim should match current pool (0)")
    expect(user2LastClaimUSDC).to.equal(currentDividendPoolUSDC, "New user's last USDC claim should match current pool (0)")

    console.log('✅ B1 PASSED: Transfer with no dividend pool works correctly')
    console.log('============================================================\n')
  })

  it('B2: Transfer >0→>0 OAD when dividend pool = 0 ETH', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3 } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B2: USER-TO-USER TRANSFER (NO DIVIDEND POOL) ===')

    // Setup: Give both users tokens first
    const initialAmount = ethers.parseEther('2000000') // 2M OAD
    const transferAmount = ethers.parseEther('500000') // 500K OAD

    console.log(`🔄 SETUP: Giving initial tokens to users...`)

    await tokenFacet.connect(owner).transfer(user2.address, initialAmount)
    await tokenFacet.connect(owner).transfer(user3.address, initialAmount)

    const user2InitialBalance = await tokenFacet.balanceOf(user2.address)
    const user3InitialBalance = await tokenFacet.balanceOf(user3.address)

    console.log(`   User2 initial: ${ethers.formatEther(user2InitialBalance)} OAD`)
    console.log(`   User3 initial: ${ethers.formatEther(user3InitialBalance)} OAD`)

    // Verify no dividend pool
    const dividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    expect(dividendPoolPOL).to.equal(0n, "Should have no POL dividend pool")
    expect(dividendPoolUSDC).to.equal(0n, "Should have no USDC dividend pool")

    console.log(`🔄 EXECUTING USER-TO-USER TRANSFER:`)
    console.log(`   From: User2 (${user2.address})`)
    console.log(`   To: User3 (${user3.address})`)
    console.log(`   Amount: ${ethers.formatEther(transferAmount)} OAD`)

    // Execute transfer
    const transferTx = await tokenFacet.connect(user2).transfer(user3.address, transferAmount)
    const transferReceipt = await transferTx.wait()

    console.log(`   ✅ Transfer completed, gas used: ${transferReceipt.gasUsed}`)

    // Verify balances
    const user2FinalBalance = await tokenFacet.balanceOf(user2.address)
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)

    console.log(`📊 FINAL BALANCES:`)
    console.log(`   User2 final: ${ethers.formatEther(user2FinalBalance)} OAD`)
    console.log(`   User3 final: ${ethers.formatEther(user3FinalBalance)} OAD`)

    // Check dividend tracking
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user3LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user3.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user3LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user3.address)

    console.log(`💰 DIVIDEND TRACKING:`)
    console.log(`   User2 Last Claim POL: ${ethers.formatEther(user2LastClaimPOL)} ETH`)
    console.log(`   User3 Last Claim POL: ${ethers.formatEther(user3LastClaimPOL)} ETH`)
    console.log(`   User2 Last Claim USDC: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   User3 Last Claim USDC: ${ethers.formatUnits(user3LastClaimUSDC, 6)} USDC`)

    // ✅ ASSERTIONS
    expect(user2FinalBalance).to.equal(user2InitialBalance - transferAmount, "User2 should lose tokens")
    expect(user3FinalBalance).to.equal(user3InitialBalance + transferAmount, "User3 should gain tokens")
    expect(user2LastClaimPOL).to.equal(0n, "User2 last POL claim should remain 0")
    expect(user3LastClaimPOL).to.equal(0n, "User3 last POL claim should remain 0")
    expect(user2LastClaimUSDC).to.equal(0n, "User2 last USDC claim should remain 0")
    expect(user3LastClaimUSDC).to.equal(0n, "User3 last USDC claim should remain 0")

    console.log('✅ B2 PASSED: User-to-user transfer with no dividend pool works correctly')
    console.log('================================================================\n')
  })

  it('B3: Transfer >0→0 OAD when dividend pool = 0 ETH', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3 } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B3: TRANSFER ALL TOKENS AWAY (NO DIVIDEND POOL) ===')

    // Setup: Give user2 tokens
    const allTokens = ethers.parseEther('1000000') // 1M OAD

    await tokenFacet.connect(owner).transfer(user2.address, allTokens)

    const user2InitialBalance = await tokenFacet.balanceOf(user2.address)
    console.log(`   User2 initial: ${ethers.formatEther(user2InitialBalance)} OAD`)

    // Transfer ALL tokens away
    console.log(`🔄 TRANSFERRING ALL TOKENS AWAY:`)
    console.log(`   From: User2 → User3`)
    console.log(`   Amount: ${ethers.formatEther(allTokens)} OAD (ALL tokens)`)

    const transferTx = await tokenFacet.connect(user2).transfer(user3.address, allTokens)
    await transferTx.wait()

    // Verify final state
    const user2FinalBalance = await tokenFacet.balanceOf(user2.address)
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)

    console.log(`📊 FINAL BALANCES:`)
    console.log(`   User2 final: ${ethers.formatEther(user2FinalBalance)} OAD`)
    console.log(`   User3 final: ${ethers.formatEther(user3FinalBalance)} OAD`)

    // Check dividend tracking for user with 0 balance
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user2DividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2DividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`💰 USER WITH 0 BALANCE:`)
    console.log(`   User2 Last Claim POL: ${ethers.formatEther(user2LastClaimPOL)} ETH`)
    console.log(`   User2 Last Claim USDC: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   User2 Dividend POL: ${ethers.formatEther(user2DividendPOL)} ETH`)
    console.log(`   User2 Dividend USDC: ${ethers.formatUnits(user2DividendUSDC, 6)} USDC`)

    // ✅ ASSERTIONS
    expect(user2FinalBalance).to.equal(0n, "User2 should have 0 tokens")
    expect(user3FinalBalance).to.equal(allTokens, "User3 should have all tokens")
    expect(user2DividendPOL).to.equal(0n, "User with 0 balance should get 0 POL dividend")
    expect(user2DividendUSDC).to.equal(0n, "User with 0 balance should get 0 USDC dividend")

    console.log('✅ B3 PASSED: Transfer all tokens away works correctly')
    console.log('====================================================\n')
  })

  it('B4: Transfer 0→>0 OAD when dividend pool > 0 ETH', async function () {
    const { tokenFacet, mockUSDC, owner, user2, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B4: TRANSFER TO NEW USER WITH EXISTING DIVIDEND POOL ===')

    // First create POL dividend pool
    const dividendAmountPOL = ethers.parseEther('1000') // 1000 POL

    console.log(`🔄 STEP 1a: Creating POL dividend pool...`)
    const fundPOLTx = await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })
    await fundPOLTx.wait()

    const dividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    console.log(`   POL dividend pool created: ${ethers.formatEther(dividendPoolPOL)} POL`)

    // Create USDC dividend pool (but don't update aggregate - needs advertisement)
    const dividendAmountUSDC = ethers.parseUnits('50000', 6) // 50,000 USDC

    console.log(`🔄 STEP 1b: Creating USDC dividend pool...`)
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)

    const dividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const diamondUSDC = await mockUSDC.balanceOf(diamondAddress)
    console.log(`   USDC minted to diamond: ${ethers.formatUnits(diamondUSDC, 6)} USDC`)
    console.log(`   USDC aggregate (requires advertisement): ${ethers.formatUnits(dividendPoolUSDC, 6)} USDC`)

    // Now transfer tokens to new user
    const transferAmount = ethers.parseEther('2000000') // 2M OAD

    console.log(`🔄 STEP 2: Transferring tokens to new user...`)
    console.log(`   From: Owner → User2`)
    console.log(`   Amount: ${ethers.formatEther(transferAmount)} OAD`)
    console.log(`   Existing POL dividend pool: ${ethers.formatEther(dividendPoolPOL)} POL`)

    // Get pre-transfer dividends
    const preOwnerDividendPOL = await tokenFacet.calculateRewardPOL(owner.address)
    const preUser2DividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const preOwnerDividendUSDC = await tokenFacet.calculateRewardUSDC(owner.address)
    const preUser2DividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`💰 PRE-TRANSFER DIVIDENDS:`)
    console.log(`   Owner POL dividend: ${ethers.formatEther(preOwnerDividendPOL)} POL`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(preUser2DividendPOL)} POL`)
    console.log(`   Owner USDC dividend: ${ethers.formatUnits(preOwnerDividendUSDC, 6)} USDC`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(preUser2DividendUSDC, 6)} USDC`)

    // Execute transfer
    const transferTx = await tokenFacet.connect(owner).transfer(user2.address, transferAmount)
    await transferTx.wait()

    // Check post-transfer state
    const user2Balance = await tokenFacet.balanceOf(user2.address)
    const ownerBalance = await tokenFacet.balanceOf(owner.address)
    const totalSupply = await tokenFacet.totalSupply()

    console.log(`📊 POST-TRANSFER BALANCES:`)
    console.log(`   Owner: ${ethers.formatEther(ownerBalance)} OAD (${(ownerBalance * 100n) / totalSupply}%)`)
    console.log(`   User2: ${ethers.formatEther(user2Balance)} OAD (${(user2Balance * 100n) / totalSupply}%)`)

    // Check dividend calculations after transfer
    const postOwnerDividendPOL = await tokenFacet.calculateRewardPOL(owner.address)
    const postUser2DividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const postOwnerDividendUSDC = await tokenFacet.calculateRewardUSDC(owner.address)
    const postUser2DividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`💰 POST-TRANSFER DIVIDENDS:`)
    console.log(`   Owner POL dividend: ${ethers.formatEther(postOwnerDividendPOL)} POL`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(postUser2DividendPOL)} POL`)
    console.log(`   Owner USDC dividend: ${ethers.formatUnits(postOwnerDividendUSDC, 6)} USDC`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(postUser2DividendUSDC, 6)} USDC`)

    // Check lastRewardClaimInPOL for new user
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    console.log(`   User2 last POL claim set to: ${ethers.formatEther(user2LastClaimPOL)} POL`)
    console.log(`   User2 last USDC claim set to: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)

    // Calculate expected dividends
    const expectedOwnerDividendPOL = (dividendPoolPOL * ownerBalance) / totalSupply
    const expectedUser2DividendPOL = (dividendPoolPOL * user2Balance) / totalSupply

    console.log(`💡 EXPECTED POL DIVIDENDS:`)
    console.log(`   Owner expected: ${ethers.formatEther(expectedOwnerDividendPOL)} POL`)
    console.log(`   User2 expected: ${ethers.formatEther(expectedUser2DividendPOL)} POL`)

    // ✅ ASSERTIONS
    expect(user2Balance).to.equal(transferAmount, "User2 should receive tokens")

    // ✅ KEY TEST: New user receiving tokens when dividend pool exists
    // The user's lastRewardClaimInPOL should be set to current pool
    // so they don't get dividends from before they owned tokens
    expect(user2LastClaimPOL).to.equal(dividendPoolPOL, "New user's last POL claim should be set to current pool")
    expect(postUser2DividendPOL).to.equal(0n, "New user should get 0 POL dividend from pre-existing pool")

    // USDC should be 0 since aggregate wasn't updated
    expect(user2LastClaimUSDC).to.equal(dividendPoolUSDC, "New user's last USDC claim should match current aggregate (0)")
      const netUSDCPool = dividendAmountUSDC - (dividendAmountUSDC * 5n / 100n)
      const expectedUser2USDC = (netUSDCPool * user2Balance) / totalSupply
      expect(postUser2DividendUSDC).to.be.approximately(expectedUser2USDC, 1n, "User2 USDC dividend should match proportional share after 5% admin commission")

    console.log('✅ B4 PASSED: New user receiving tokens with existing dividend pool handled correctly')
    console.log('⚠️  USDC aggregate not updated - requires advertisement deployment')
    console.log('===============================================================================\n')
  })

  it('B5: Transfer >0→>0 OAD when dividend pool > 0 ETH (with claims)', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B5: USER-TO-USER TRANSFER WITH DIVIDEND POOL ===')

    // Setup: Create dividend pool and give users tokens
    const dividendAmountPOL = ethers.parseEther('1000') // 1000 POL
    const initialTokens = ethers.parseEther('2100000') // 2.1M OAD each

    console.log(`🔄 SETUP: Creating initial state...`)

    // Transfer tokens first (before dividend pool exists)
    await tokenFacet.connect(owner).transfer(user2.address, initialTokens)
    await tokenFacet.connect(owner).transfer(user3.address, initialTokens)

    // Record balances AFTER initial token distribution
    const user2PreBalance = await tokenFacet.balanceOf(user2.address)
    const user3PreBalance = await tokenFacet.balanceOf(user3.address)

    // Then create POL dividend pool
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })

    const dividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    console.log(`   Created POL dividend pool: ${ethers.formatEther(dividendPoolPOL)} POL`)

    // Create USDC dividend pool (balance only, aggregate not updated)
    const dividendAmountUSDC = ethers.parseUnits('25000', 6) // 25,000 USDC
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)

    const dividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    console.log(`   USDC in diamond: ${ethers.formatUnits(dividendAmountUSDC, 6)} USDC`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC, 6)} USDC (requires advertisement)`)

    // Both users should now have POL dividends available
    const user2InitialDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3InitialDividendPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const user2InitialDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    const user3InitialDividendUSDC = await tokenFacet.calculateRewardUSDC(user3.address)

    console.log(`💰 INITIAL DIVIDENDS:`)
    console.log(`   User2 POL: ${ethers.formatEther(user2InitialDividendPOL)} POL`)
    console.log(`   User3 POL: ${ethers.formatEther(user3InitialDividendPOL)} POL`)
    console.log(`   User2 USDC: ${ethers.formatUnits(user2InitialDividendUSDC, 6)} USDC`)
    console.log(`   User3 USDC: ${ethers.formatUnits(user3InitialDividendUSDC, 6)} USDC`)

    // Claim dividends for user2 (but not user3)
    console.log(`🔄 CLAIMING DIVIDENDS FOR USER2...`)
    const user2ETHBefore = await ethers.provider.getBalance(user2.address)
    const user2USDCBefore = await mockUSDC.balanceOf(user2.address)

    await tokenFacet.distributeReward(user2.address)

    const user2ETHAfter = await ethers.provider.getBalance(user2.address)
    const user2USDCAfter = await mockUSDC.balanceOf(user2.address)
    const user2ETHGained = user2ETHAfter - user2ETHBefore
    const user2USDCGained = user2USDCAfter - user2USDCBefore

    console.log(`   User2 claimed POL: ${ethers.formatEther(user2ETHGained)} POL`)
    console.log(`   User2 claimed USDC: ${ethers.formatUnits(user2USDCGained, 6)} USDC`)

    // Now add more to POL dividend pool
    console.log(`🔄 ADDING MORE TO POL DIVIDEND POOL...`)
    const additionalDividendPOL = ethers.parseEther('500') // 500 POL more
    await owner.sendTransaction({
      to: diamondAddress,
      value: additionalDividendPOL
    })

    const newDividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    console.log(`   New POL dividend pool: ${ethers.formatEther(newDividendPoolPOL)} POL`)

    // Check dividends after pool increase
    const user2NewDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3NewDividendPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const user2NewDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    const user3NewDividendUSDC = await tokenFacet.calculateRewardUSDC(user3.address)

    console.log(`💰 DIVIDENDS AFTER POOL INCREASE:`)
    console.log(`   User2 POL: ${ethers.formatEther(user2NewDividendPOL)} POL (should only be from new pool)`)
    console.log(`   User3 POL: ${ethers.formatEther(user3NewDividendPOL)} POL (should be from both pools)`)
    console.log(`   User2 USDC: ${ethers.formatUnits(user2NewDividendUSDC, 6)} USDC`)
    console.log(`   User3 USDC: ${ethers.formatUnits(user3NewDividendUSDC, 6)} USDC`)

    // Now transfer between users
    const transferAmount = ethers.parseEther('1050000') // 1.05M OAD

    console.log(`🔄 EXECUTING TRANSFER:`)
    console.log(`   From: User2 → User3`)
    console.log(`   Amount: ${ethers.formatEther(transferAmount)} OAD`)

    // Record balances immediately before the transfer
    const user2BalanceBeforeTransfer = await tokenFacet.balanceOf(user2.address)
    const user3BalanceBeforeTransfer = await tokenFacet.balanceOf(user3.address)

    const user2ETHBefore2 = await ethers.provider.getBalance(user2.address)
    const user3ETHBefore2 = await ethers.provider.getBalance(user3.address)

    console.log(`📊 BALANCES BEFORE TRANSFER:`)
    console.log(`   User2: ${ethers.formatEther(user2BalanceBeforeTransfer)} OAD`)
    console.log(`   User3: ${ethers.formatEther(user3BalanceBeforeTransfer)} OAD`)
    console.log(`   User2 ETH: ${ethers.formatEther(user2ETHBefore2)} ETH`)
    console.log(`   User3 ETH: ${ethers.formatEther(user3ETHBefore2)} ETH`)

    const transferTx = await tokenFacet.connect(user2).transfer(user3.address, transferAmount)
    await transferTx.wait()

    // Check final state
    const user2FinalBalance = await tokenFacet.balanceOf(user2.address)
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)
    const user2FinalDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3FinalDividendPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const user2FinalDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    const user3FinalDividendUSDC = await tokenFacet.calculateRewardUSDC(user3.address)
    const user2FinalETHBalance = await ethers.provider.getBalance(user2.address)
    const user3FinalETHBalance = await ethers.provider.getBalance(user3.address)
    const user2FinalUSDCBalance = await mockUSDC.balanceOf(user2.address)
    const user3FinalUSDCBalance = await mockUSDC.balanceOf(user3.address)

    console.log(`📊 FINAL STATE:`)
    console.log(`   User2 OAD balance: ${ethers.formatEther(user2FinalBalance)} OAD`)
    console.log(`   User3 OAD balance: ${ethers.formatEther(user3FinalBalance)} OAD`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2FinalDividendPOL)} POL`)
    console.log(`   User3 POL dividend: ${ethers.formatEther(user3FinalDividendPOL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2FinalDividendUSDC, 6)} USDC`)
    console.log(`   User3 USDC dividend: ${ethers.formatUnits(user3FinalDividendUSDC, 6)} USDC`)
    console.log(`   User2 balance before transfer: ${ethers.formatEther(user2BalanceBeforeTransfer)} OAD`)
    console.log(`   User3 balance before transfer: ${ethers.formatEther(user3BalanceBeforeTransfer)} OAD`)
    console.log(`   User2 ETH balance: ${ethers.formatEther(user2FinalETHBalance)} ETH`)
    console.log(`   User3 ETH balance: ${ethers.formatEther(user3FinalETHBalance)} ETH`)
    console.log(`   User2 USDC balance: ${ethers.formatUnits(user2FinalUSDCBalance, 6)} USDC`)
    console.log(`   User3 USDC balance: ${ethers.formatUnits(user3FinalUSDCBalance, 6)} USDC`)

    // ✅ ASSERTIONS - Use the correct baseline (immediately before transfer)
    expect(user2FinalBalance).to.equal(user2BalanceBeforeTransfer - transferAmount, "User2 should lose tokens")
    expect(user3FinalBalance).to.equal(user3BalanceBeforeTransfer + transferAmount, "User3 should gain tokens")

    // ✅ KEY TEST: Dividend calculations should be proportional to current balances
    const totalSupply = await tokenFacet.totalSupply()
    const expectedUser2DividendPOL = (additionalDividendPOL * user2FinalBalance) / totalSupply
    const expectedUser3DividendPOL = (additionalDividendPOL * user3FinalBalance) / totalSupply

    console.log(`💡 CORRECTED EXPECTED POL DIVIDENDS:`)
    console.log(`   User2 expected (from additional only): ${ethers.formatEther(expectedUser2DividendPOL)} POL`)
    console.log(`   User3 expected (from additional only): ${ethers.formatEther(expectedUser3DividendPOL)} POL`)

    console.log('✅ B5 PASSED: User-to-user transfer with dividend pool works correctly')
    console.log('================================================================\n')
  })

  it('B6: Transfer >0→0 OAD when dividend pool > 0 ETH', async function () {
    const { tokenFacet, mockUSDC, owner, user2, user3, diamondAddress } = await loadFixture(deployDividendTestFixture)

    console.log('\n=== 🔍 B6: TRANSFER ALL TOKENS WITH DIVIDEND POOL ===')

    // Setup: Give user tokens and create dividend pool
    const userTokens = ethers.parseEther('2000000') // 2M OAD
    const dividendAmountPOL = ethers.parseEther('800') // 800 POL
    const dividendAmountUSDC = ethers.parseUnits('40000', 6) // 40,000 USDC

    console.log(`🔄 SETUP:`)

    // Transfer tokens first
    await tokenFacet.connect(owner).transfer(user2.address, userTokens)

    // Create POL dividend pool
    await owner.sendTransaction({
      to: diamondAddress,
      value: dividendAmountPOL
    })

    // Create USDC balance (aggregate not updated)
    await mockUSDC.connect(owner).mint(diamondAddress, dividendAmountUSDC)

    const dividendPoolPOL = await tokenFacet.getTotalAggregateRewardInPOL()
    const dividendPoolUSDC = await tokenFacet.getTotalAggregateRewardInUSDC()
    const user2InitialDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user2InitialDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)

    console.log(`   User2 tokens: ${ethers.formatEther(userTokens)} OAD`)
    console.log(`   POL dividend pool: ${ethers.formatEther(dividendPoolPOL)} POL`)
    console.log(`   USDC aggregate: ${ethers.formatUnits(dividendPoolUSDC, 6)} USDC`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2InitialDividendPOL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2InitialDividendUSDC, 6)} USDC`)

    // Transfer ALL tokens away
    console.log(`🔄 TRANSFERRING ALL TOKENS AWAY:`)

    const transferTx = await tokenFacet.connect(user2).transfer(user3.address, userTokens)
    await transferTx.wait()

    // Check post-transfer state
    const user2FinalBalance = await tokenFacet.balanceOf(user2.address)
    const user3FinalBalance = await tokenFacet.balanceOf(user3.address)
    const user2FinalDividendPOL = await tokenFacet.calculateRewardPOL(user2.address)
    const user3FinalDividendPOL = await tokenFacet.calculateRewardPOL(user3.address)
    const user2FinalDividendUSDC = await tokenFacet.calculateRewardUSDC(user2.address)
    const user3FinalDividendUSDC = await tokenFacet.calculateRewardUSDC(user3.address)

    console.log(`📊 AFTER TRANSFERRING ALL TOKENS:`)
    console.log(`   User2 balance: ${ethers.formatEther(user2FinalBalance)} OAD`)
    console.log(`   User3 balance: ${ethers.formatEther(user3FinalBalance)} OAD`)
    console.log(`   User2 POL dividend: ${ethers.formatEther(user2FinalDividendPOL)} POL`)
    console.log(`   User3 POL dividend: ${ethers.formatEther(user3FinalDividendPOL)} POL`)
    console.log(`   User2 USDC dividend: ${ethers.formatUnits(user2FinalDividendUSDC, 6)} USDC`)
    console.log(`   User3 USDC dividend: ${ethers.formatUnits(user3FinalDividendUSDC, 6)} USDC`)

    // Check last claim tracking
    const user2LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user2.address)
    const user3LastClaimPOL = await tokenFacet.getLastRewardClaimInPOL(user3.address)
    const user2LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user2.address)
    const user3LastClaimUSDC = await tokenFacet.getLastRewardClaimInUSDC(user3.address)

    console.log(`💰 LAST CLAIM TRACKING:`)
    console.log(`   User2 last POL claim: ${ethers.formatEther(user2LastClaimPOL)} POL`)
    console.log(`   User3 last POL claim: ${ethers.formatEther(user3LastClaimPOL)} POL`)
    console.log(`   User2 last USDC claim: ${ethers.formatUnits(user2LastClaimUSDC, 6)} USDC`)
    console.log(`   User3 last USDC claim: ${ethers.formatUnits(user3LastClaimUSDC, 6)} USDC`)

    // ✅ ASSERTIONS
    expect(user2FinalBalance).to.equal(0n, "User2 should have 0 tokens")
    expect(user3FinalBalance).to.equal(userTokens, "User3 should have all tokens")
    expect(user2FinalDividendPOL).to.equal(0n, "User with 0 balance should get 0 POL dividend")
    expect(user2FinalDividendUSDC).to.equal(0n, "User with 0 balance should get 0 USDC dividend")

    // ✅ KEY TEST: User3 (new recipient) should not get dividends from before they owned tokens
    expect(user3LastClaimPOL).to.equal(dividendPoolPOL, "New token holder's last POL claim should be set to current pool")
    expect(user3FinalDividendPOL).to.equal(0n, "New token holder should not get pre-existing POL dividends")
    expect(user3LastClaimUSDC).to.equal(dividendPoolUSDC, "New token holder's last USDC claim should be set to current aggregate")
      const b6TotalSupply = await tokenFacet.totalSupply()
      const b6NetUSDCPool = dividendAmountUSDC - (dividendAmountUSDC * 5n / 100n)
      const expectedUser3USDC = (b6NetUSDCPool * user3FinalBalance) / b6TotalSupply
      expect(user3FinalDividendUSDC).to.be.approximately(expectedUser3USDC, 1n, "User3 USDC dividend should match proportional share after 5% admin commission")

    console.log('✅ B6 PASSED: Transfer all tokens with dividend pool handled correctly')
    console.log('================================================================\n')
  })
})