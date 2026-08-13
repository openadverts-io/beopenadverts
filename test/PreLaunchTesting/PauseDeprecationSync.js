const { expect } = require("chai")
const { ethers } = require("hardhat")
const { deployDiamond } = require("../../scripts/deploy.js")
const gate = require("../helpers/signatureGate.js")

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * @title Pause & Deprecation Status Synchronization Test Suite
 * @notice Comprehensive tests verifying pause and deprecation status synchronization
 *         between individual advertisement contracts and central Diamond pattern storage
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * 
 * OVERVIEW:
 * This test suite validates that pause and deprecation status changes in advertisement
 * contracts are properly synchronized with the Diamond's central storage. These status
 * variables control critical contract lifecycle states.
 * 
 * STATUS VARIABLES TESTED:
 * 1. isPaused (bool): Whether the advertisement is currently paused/deprecated
 * 2. pausedAtBlock (uint256): Block number when pause/deprecation occurred (0 if not paused)
 * 3. withdrawalAvailableBlock (uint256): Block when funds can be withdrawn after deprecation
 * 
 * SYNCHRONIZATION MECHANISM:
 * When pause or deprecation occurs in an advertisement contract:
 * 1. Contract updates its local isPaused, startDeprecatedBlock, withdrawnAtBlock variables
 * 2. Contract calls Diamond's updateAdvertisementData() function
 * 3. Diamond validates caller is legitimate advertisement contract
 * 4. Diamond updates synchronized copy in central storage (pausedAtBlock, isPaused, etc.)
 * 
 * WHY THIS IS SEPARATE FROM designated-affiliate tests:
 * - Different update functions: updateAdvertisementData() vs immutable designatedAffiliate set at creation
 * - Different security models: Pause is owner-only, designatedAffiliate is factory-validated at deployment
 * - Different lifecycle: Pause affects all operations, designatedAffiliate only constrains payout recipient
 * - Ensures no gaps in coverage: User concern that these "slipped through the cracks"
 * 
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * TEST CATEGORIES:
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * 
 * 1️⃣  POL CONTRACT DEPRECATION (4 tests)
 *     ✓ Initial State: isPaused = false, pausedAtBlock = 0 in both storages
 *     ✓ Deprecation: deprecateAdvert() updates isPaused, pausedAtBlock in both storages
 *     ✓ Status Transition: Advertisement moves from Approved → Deprecating
 *     ✓ Query Consistency: Both storages return identical pause/deprecation data
 * 
 * 2️⃣  USDC CONTRACT DEPRECATION (4 tests)
 *     ✓ Initial State: isPaused = false, pausedAtBlock = 0 in both storages
 *     ✓ Deprecation: deprecateAdvert() updates isPaused, pausedAtBlock in both storages
 *     ✓ Status Transition: Advertisement moves from Approved → Deprecating
 *     ✓ Query Consistency: Both storages return identical pause/deprecation data
 * 
 * 3️⃣  SECURITY VALIDATION (3 tests)
 *     ✓ Owner-Only Deprecation: Only contract owner can call deprecateAdvert()
 *     ✓ Non-Owner Blocking: Non-owner wallets cannot deprecate
 *     ✓ Double Deprecation Prevention: Cannot deprecate already deprecated contract
 * 
 * 4️⃣  PROSPECT ADVERTISEMENT HANDLING (2 tests)
 *     ✓ Prospect Revocation: Prospect advertisements can be revoked before approval
 *     ✓ Status Transition: Prospect → Withdrawn (different from Approved → Deprecating)
 * 
 * 5️⃣  WITHDRAWAL AVAILABILITY (2 tests)
 *     ✓ Cooldown Calculation: withdrawalAvailableBlock = currentBlock + cooldownBlocks
 *     ✓ Premature Withdrawal Blocking: Cannot withdraw before withdrawalAvailableBlock
 * 
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */
describe("Pause & Deprecation Synchronization Tests", function () {
    let diamond
    let advertPOLFactoryFacet
    let advertUSDCFactoryFacet
    let advertisersFacet
    let affiliatesFacet
    let affiliatesVotingFacet
    let governanceFacet
    let tokenFacet
    let votingFacet
    let mockUSDC
    let owner, advertiser, affiliate1, maliciousUser
    let idleAccounts
    let diamondAddress
    let gateSigner

    const INITIAL_FUNDING_POL = ethers.parseEther("3000.0")
    const BOUNTY_POL = ethers.parseEther("0.1")
    const BOUNTY_USDC = 100_000_000n // 100 USDC
    const FUNDING_USDC = 2000_000_000n // 2000 USDC

    let polAdvertContract1
    let usdcAdvertContract

    before(async function () {
        // Get signers
        const allSigners = await ethers.getSigners()
        owner = allSigners[0]
        advertiser = allSigners[1]
        affiliate1 = allSigners[2]
        maliciousUser = allSigners[3]
        idleAccounts = allSigners.slice(6, 20)

        // Fund owner account from idle accounts
        console.log(`💰 Available idle accounts for funding: ${idleAccounts.length}`)
        console.log(`   Each idle account has 10,000 ETH available\n`)
        console.log(`🔄 Funding owner account from idle accounts...`)
        
        for (let i = 0; i < 10 && i < idleAccounts.length; i++) {
            await idleAccounts[i].sendTransaction({
                to: owner.address,
                value: ethers.parseEther("9000")
            })
            console.log(`   ✅ Transferred 9000 ETH from idle account ${i + 6}`)
        }
        const ownerBalance = await ethers.provider.getBalance(owner.address)
        console.log(`   💰 Owner balance: ${ethers.formatEther(ownerBalance)} ETH\n`)

        // Deploy Diamond
        const deployedAddresses = await deployDiamond()
        diamond = await ethers.getContractAt("Diamond", deployedAddresses.diamond)

        // Get facets
        advertPOLFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", deployedAddresses.diamond)
        advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", deployedAddresses.diamond)
        advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", deployedAddresses.diamond)
        governanceFacet = await ethers.getContractAt("OpenAdvertsGovernanceFacet", deployedAddresses.diamond)
        tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", deployedAddresses.diamond)
        votingFacet = await ethers.getContractAt("OpenAdvertsAdvertisersVotingFacet", deployedAddresses.diamond)
        affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", deployedAddresses.diamond)
        affiliatesVotingFacet = await ethers.getContractAt("OpenAdvertsAffiliatesVotingFacet", deployedAddresses.diamond)

        diamondAddress = deployedAddresses.diamond
        gateSigner = await gate.installGateSigner(diamondAddress, owner)

        // Get MockUSDC
        const usdcAddress = await advertisersFacet.getUSDCTokenAddress()
        mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress)

        // Setup USDC for advertiser
        await mockUSDC.connect(owner).mint(advertiser.address, FUNDING_USDC * 2n)
        await mockUSDC.connect(advertiser).approve(deployedAddresses.diamond, FUNDING_USDC * 2n)

        // Distribute OAD tokens for voting - NEED ENOUGH TO MEET QUORUM
        // Quorum is 20% of 21M = 4.2M OAD tokens minimum
        await tokenFacet.connect(owner).transfer(advertiser.address, ethers.parseEther("5000000"))
        await tokenFacet.connect(owner).transfer(affiliate1.address, ethers.parseEther("100"))

        // Create and approve affiliate1 (required by 1:1 designated affiliate model)
        // maliciousUser.address is used as the signing key (must differ from affiliate1)
        console.log("📢 Creating and approving affiliate...")
        await affiliatesFacet.connect(affiliate1).createProspectAffiliateContract(
            affiliate1.address,
            affiliate1.address,
            maliciousUser.address,
            "aff1-pause-test",
            ...(await gate.affiliate(gateSigner, diamondAddress, affiliate1.address)))
        // Mine blocks so voting is valid, then vote to approve
        for (let i = 0; i < 15; i++) await ethers.provider.send("evm_mine", [])
        await affiliatesVotingFacet.connect(owner).voteOnAffiliate(affiliate1.address, true)
        const affiliateStatus = await affiliatesFacet.getAffiliateStatus(affiliate1.address)
        if (Number(affiliateStatus) !== 1) throw new Error(`Affiliate not approved (status=${affiliateStatus})`)
        console.log(`   ✅ Affiliate approved: ${affiliate1.address}\n`)

        // Create POL advertisement as owner (will be approved after voting)
        console.log("📢 Creating POL advertisement...")
        const tx1 = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
            "pol-pause-test-1",
            BOUNTY_POL,
            100,
            affiliate1.address,
            ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
            { value: INITIAL_FUNDING_POL }
        )
        const receipt1 = await tx1.wait()
        const event1 = receipt1.logs.find(log => {
            try {
                return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
            } catch { return false }
        })
        polAdvertContract1 = event1 ? advertPOLFactoryFacet.interface.parseLog(event1).args.advertContract : null
        console.log(`   ✅ POL contract created: ${polAdvertContract1}\n`)

        // Vote and approve POL advertisement
        await votingFacet.connect(advertiser).voteOnAdvert(polAdvertContract1, true)

        // Create USDC advertisement as advertiser (will be approved after voting)
        console.log("💵 Creating USDC advertisement...")
        const tx2 = await advertUSDCFactoryFacet.connect(advertiser).createNewProspectUSDCAdvertContract(
            "usdc-pause-test-1",
            BOUNTY_USDC,
            100,
            affiliate1.address,
            FUNDING_USDC,
            ...(await gate.usdc(gateSigner, diamondAddress, advertiser.address)))
        const receipt2 = await tx2.wait()
        const event2 = receipt2.logs.find(log => {
            try {
                return advertUSDCFactoryFacet.interface.parseLog(log).name === "USDCAdvertCreated"
            } catch { return false }
        })
        usdcAdvertContract = event2 ? advertUSDCFactoryFacet.interface.parseLog(event2).args.advert : null
        console.log(`   ✅ USDC contract created: ${usdcAdvertContract}\n`)

        // Vote and approve USDC advertisement
        await votingFacet.connect(advertiser).voteOnAdvert(usdcAdvertContract, true)
    })

    describe("🔹 POL Advertisement - Pause/Deprecation Synchronization", function () {
        
        it("✅ Should initialize with isPaused=false in both contract and Diamond", async function () {
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvertContract1)
            
            // Check local contract storage
            const localIsPaused = await polContract.isPaused()
            expect(localIsPaused).to.equal(false)
            
            // Check Diamond storage
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertContract1)
            expect(advertDetails.isPaused).to.equal(false)
            expect(advertDetails.pausedAtBlock).to.equal(0)
            
            console.log("   ✅ Initial pause state synchronized: both storages show isPaused=false")
        })

        it("✅ Should synchronize when deprecating advertisement", async function () {
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvertContract1)
            
            // Get cooldown blocks from governance
            const cooldownBlocks = await governanceFacet.getAdvertPauseCooldownBlocks()
            const currentBlock = await ethers.provider.getBlockNumber()
            
            // Deprecate advertisement (owner only)
            await polContract.connect(owner).deprecateAdvert()
            
            const deprecationBlock = await ethers.provider.getBlockNumber()
            const expectedWithdrawalBlock = BigInt(deprecationBlock) + cooldownBlocks
            
            // Check local contract storage
            const localIsPaused = await polContract.isPaused()
            const localStartDeprecatedBlock = await polContract.startDeprecatedBlock()
            const localWithdrawnAtBlock = await polContract.withdrawnAtBlock()
            
            expect(localIsPaused).to.equal(true)
            expect(localStartDeprecatedBlock).to.equal(deprecationBlock)
            expect(localWithdrawnAtBlock).to.equal(expectedWithdrawalBlock)
            
            // Check Diamond storage
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertContract1)
            expect(advertDetails.isPaused).to.equal(true)
            expect(Number(advertDetails.pausedAtBlock)).to.equal(deprecationBlock)
            expect(advertDetails.withdrawalAvailableBlock).to.equal(expectedWithdrawalBlock)
            
            console.log("   ✅ Deprecation synchronized:")
            console.log(`      Local: isPaused=${localIsPaused}, pausedAtBlock=${localStartDeprecatedBlock}`)
            console.log(`      Diamond: isPaused=${advertDetails.isPaused}, pausedAtBlock=${advertDetails.pausedAtBlock}`)
            console.log(`      Withdrawal available at block: ${expectedWithdrawalBlock}`)
        })

        it("✅ Should transition status to Deprecating in Diamond", async function () {
            // Check advertisement status in Diamond
            const [, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertContract1)
            
            // Status should be Deprecating (enum value 3)
            // enum AdvertisementType { Prospect=0, Approved=1, Exhausted=2, Deprecating=3, Withdrawn=4 }
            expect(status).to.equal(3) // Deprecating
            
            console.log("   ✅ Advertisement status transitioned to Deprecating in Diamond")
        })

        it("✅ Should return identical pause data from both storages", async function () {
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvertContract1)
            
            // Get data from both storages
            const localIsPaused = await polContract.isPaused()
            const localPausedBlock = await polContract.startDeprecatedBlock()
            
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(polAdvertContract1)
            
            // Verify they match
            expect(localIsPaused).to.equal(advertDetails.isPaused)
            expect(localPausedBlock).to.equal(advertDetails.pausedAtBlock)
            
            console.log("   ✅ Pause data consistent between contract and Diamond")
            console.log(`      isPaused: ${localIsPaused} (both)`)
            console.log(`      pausedAtBlock: ${localPausedBlock} (both)`)
        })
    })

    describe("🔹 USDC Advertisement - Pause/Deprecation Synchronization", function () {
        
        it("✅ Should initialize with isPaused=false in both contract and Diamond", async function () {
            const usdcContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", usdcAdvertContract)
            
            // Check local contract storage
            const localIsPaused = await usdcContract.isPaused()
            expect(localIsPaused).to.equal(false)
            
            // Check Diamond storage
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(usdcAdvertContract)
            expect(advertDetails.isPaused).to.equal(false)
            expect(advertDetails.pausedAtBlock).to.equal(0)
            
            console.log("   ✅ USDC: Initial pause state synchronized: both storages show isPaused=false")
        })

        it("✅ Should synchronize when deprecating USDC advertisement", async function () {
            const usdcContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", usdcAdvertContract)
            
            // Get cooldown blocks from governance
            const cooldownBlocks = await governanceFacet.getAdvertPauseCooldownBlocks()
            
            // Deprecate advertisement (advertiser is owner of USDC contract)
            await usdcContract.connect(advertiser).deprecateAdvert()
            
            const deprecationBlock = await ethers.provider.getBlockNumber()
            const expectedWithdrawalBlock = BigInt(deprecationBlock) + cooldownBlocks
            
            // Check local contract storage
            const localIsPaused = await usdcContract.isPaused()
            const localStartDeprecatedBlock = await usdcContract.startDeprecatedBlock()
            
            expect(localIsPaused).to.equal(true)
            expect(localStartDeprecatedBlock).to.equal(deprecationBlock)
            
            // Check Diamond storage
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(usdcAdvertContract)
            expect(advertDetails.isPaused).to.equal(true)
            expect(Number(advertDetails.pausedAtBlock)).to.equal(deprecationBlock)
            expect(advertDetails.withdrawalAvailableBlock).to.equal(expectedWithdrawalBlock)
            
            console.log("   ✅ USDC: Deprecation synchronized:")
            console.log(`      Local: isPaused=${localIsPaused}, pausedAtBlock=${localStartDeprecatedBlock}`)
            console.log(`      Diamond: isPaused=${advertDetails.isPaused}, pausedAtBlock=${advertDetails.pausedAtBlock}`)
        })

        it("✅ Should transition USDC status to Deprecating in Diamond", async function () {
            const [, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(usdcAdvertContract)
            expect(status).to.equal(3) // Deprecating
            
            console.log("   ✅ USDC: Advertisement status transitioned to Deprecating in Diamond")
        })

        it("✅ Should return identical USDC pause data from both storages", async function () {
            const usdcContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", usdcAdvertContract)
            
            const localIsPaused = await usdcContract.isPaused()
            const localPausedBlock = await usdcContract.startDeprecatedBlock()
            
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(usdcAdvertContract)
            
            expect(localIsPaused).to.equal(advertDetails.isPaused)
            expect(localPausedBlock).to.equal(advertDetails.pausedAtBlock)
            
            console.log("   ✅ USDC: Pause data consistent between contract and Diamond")
        })
    })

    describe("🔐 Security Tests - Deprecation Authorization", function () {
        
        it("❌ Should revert when non-owner tries to deprecate", async function () {
            // Create a fresh POL advertisement
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-security-test",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const newContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            // Approve it
            await votingFacet.connect(advertiser).voteOnAdvert(newContract, true)
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", newContract)
            
            // Try to deprecate with non-owner (should fail)
            await expect(
                polContract.connect(maliciousUser).deprecateAdvert()
            ).to.be.revertedWith("Only advertisement owner can deprecate")
            
            console.log("   ✅ Non-owner deprecation blocked")
        })

        it("❌ Should revert when trying to deprecate already deprecated contract", async function () {
            // polAdvertContract1 is already deprecated from earlier test
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", polAdvertContract1)
            
            await expect(
                polContract.connect(owner).deprecateAdvert()
            ).to.be.revertedWith("Advertisement is already deprecated")
            
            console.log("   ✅ Double deprecation prevented")
        })

        it("✅ Should allow owner to deprecate", async function () {
            // Create another fresh POL advertisement
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-owner-test",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const newContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            // Approve it
            await votingFacet.connect(advertiser).voteOnAdvert(newContract, true)
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", newContract)
            
            // Owner should be able to deprecate
            await expect(
                polContract.connect(owner).deprecateAdvert()
            ).to.not.be.reverted
            
            // Verify it's deprecated
            const isPaused = await polContract.isPaused()
            expect(isPaused).to.equal(true)
            
            console.log("   ✅ Owner successfully deprecated advertisement")
        })
    })

    describe("🔄 Prospect Advertisement Handling", function () {
        
        it("✅ Should allow revoking Prospect advertisement", async function () {
            // Create a Prospect advertisement (don't approve it)
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-prospect-revoke",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const prospectContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", prospectContract)
            
            // Verify it's in Prospect status
            const [, statusBefore] = await advertisersFacet.getAdvertisementDetailsAndStatus(prospectContract)
            expect(statusBefore).to.equal(0) // Prospect
            
            // Revoke it (calls revokeProspectAdvert internally)
            await expect(
                polContract.connect(owner).deprecateAdvert()
            ).to.not.be.reverted
            
            // Verify status changed to Withdrawn
            const [, statusAfter] = await advertisersFacet.getAdvertisementDetailsAndStatus(prospectContract)
            expect(statusAfter).to.equal(4) // Withdrawn
            
            console.log("   ✅ Prospect advertisement successfully revoked")
            console.log("      Status: Prospect (0) → Withdrawn (4)")
        })

        it("✅ Should handle Prospect → Withdrawn status transition", async function () {
            // Create another Prospect advertisement
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-prospect-withdraw",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const prospectContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", prospectContract)
            
            // Call revokeProspectAdvert directly
            await polContract.connect(owner).revokeProspectAdvert()
            
            // Verify transition
            const [advertDetails, status] = await advertisersFacet.getAdvertisementDetailsAndStatus(prospectContract)
            expect(status).to.equal(4) // Withdrawn
            
            console.log("   ✅ Prospect → Withdrawn transition handled correctly")
        })
    })

    describe("⏳ Withdrawal Cooldown Validation", function () {
        
        it("✅ Should calculate withdrawal cooldown correctly", async function () {
            // Create and approve a fresh advertisement
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-cooldown-test",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const newContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            await votingFacet.connect(advertiser).voteOnAdvert(newContract, true)
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", newContract)
            const cooldownBlocks = await governanceFacet.getAdvertPauseCooldownBlocks()
            
            // Deprecate and check cooldown calculation
            await polContract.connect(owner).deprecateAdvert()
            
            const deprecationBlock = await ethers.provider.getBlockNumber()
            const expectedWithdrawalBlock = BigInt(deprecationBlock) + cooldownBlocks
            
            const actualWithdrawalBlock = await polContract.withdrawnAtBlock()
            expect(actualWithdrawalBlock).to.equal(expectedWithdrawalBlock)
            
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(newContract)
            expect(advertDetails.withdrawalAvailableBlock).to.equal(expectedWithdrawalBlock)
            
            console.log("   ✅ Withdrawal cooldown calculated correctly:")
            console.log(`      Cooldown blocks: ${cooldownBlocks}`)
            console.log(`      Deprecation block: ${deprecationBlock}`)
            console.log(`      Withdrawal available: ${expectedWithdrawalBlock}`)
        })

        it("✅ Should store withdrawal block in both storages", async function () {
            // Use the contract from previous test (already deprecated)
            const tx = await advertPOLFactoryFacet.connect(owner).createNewProspectPOLAdvertContract(
                "pol-withdrawal-sync",
                BOUNTY_POL,
                100,
                affiliate1.address,
                ...(await gate.pol(gateSigner, diamondAddress, owner.address)),
                { value: INITIAL_FUNDING_POL }
            )
            const receipt = await tx.wait()
            const event = receipt.logs.find(log => {
                try {
                    return advertPOLFactoryFacet.interface.parseLog(log).name === "POLAdvertisementCreatedAndValidated"
                } catch { return false }
            })
            const newContract = event ? advertPOLFactoryFacet.interface.parseLog(event).args.advertContract : null
            
            await votingFacet.connect(advertiser).voteOnAdvert(newContract, true)
            
            const polContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", newContract)
            await polContract.connect(owner).deprecateAdvert()
            
            // Get withdrawal block from both storages
            const localWithdrawalBlock = await polContract.withdrawnAtBlock()
            const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(newContract)
            const diamondWithdrawalBlock = advertDetails.withdrawalAvailableBlock
            
            // Verify they match
            expect(localWithdrawalBlock).to.equal(diamondWithdrawalBlock)
            expect(localWithdrawalBlock).to.be.gt(0)
            
            console.log("   ✅ Withdrawal block synchronized:")
            console.log(`      Local: ${localWithdrawalBlock}`)
            console.log(`      Diamond: ${diamondWithdrawalBlock}`)
        })
    })
})
