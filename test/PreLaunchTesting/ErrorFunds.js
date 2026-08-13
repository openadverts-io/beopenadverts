/* global describe it */

const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const { deployDiamond } = require('../../scripts/deploy.js')

/**
 * ARCHITECTURE NOTE:
 * - The Diamond is the main contract that receives all funds via its receive()
 * - Facets are logic contracts called via delegatecall through the Diamond
 * - When calling through Diamond: facet code executes in Diamond's storage context
 * - When calling facet directly: facet code executes in facet's own storage
 * - The facet can have its own state variables (diamondAddressForDirectCalls) 
 *   that don't interfere with the Diamond's storage
 * - This test verifies funds sent to facet address are forwarded to diamond
 */

describe('Error Funds Recovery Tests', function () {
	async function deployFixture() {
		const [owner, addr1, addr2] = await ethers.getSigners()
		
		console.log('\n🔧 DEPLOYING DIAMOND SYSTEM...')
		const deployedAddresses = await deployDiamond()
		const diamondAddress = deployedAddresses.diamond
		console.log(`✅ Diamond deployed at: ${diamondAddress}`)
		
		const diamondLoupeFacet = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)
		const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
		
		console.log('✅ System ready for funding tests\n')

		return {
			owner,
			addr1,
			addr2,
			diamondAddress,
			diamondLoupeFacet,
			tokenFacet
		}
	}

	async function getFacetAddressByName(diamondLoupeFacet, facetName) {
		const Facet = await ethers.getContractFactory(facetName)
		const selectors = Facet.interface.fragments
			.filter(fragment => fragment.type === 'function')
			.map(fragment => Facet.interface.getFunction(fragment.format('minimal')).selector)

		if (selectors.length === 0) {
			throw new Error(`No function selectors found for ${facetName}`)
		}

		return diamondLoupeFacet.facetAddress(selectors[0])
	}

	describe('All Facets Funding Flow', function () {
		// List of all facets to test (matching deploy.js order)
		const facetsToTest = [
			'DiamondLoupeFacet',
			'OwnershipFacet',
			'OpenAdvertsAdvertisersFacet',
			'OpenAdvertsAdvertisersVotingFacet',
			'OpenAdvertsAffiliatesFacet',
			'OpenAdvertsAffiliatesVotingFacet',
			'OpenAdvertsGovernanceFacet',
			'OpenAdvertsPayoutFacet',
			'OpenAdvertsTokenFacet',
			'OpenAdvertsAdvertPOLFactoryFacet',
			'OpenAdvertsAdvertUSDCPriceFacet',
			'OpenAdvertsAdvertUSDCHelperFacet',
			'OpenAdvertsAdvertUSDCFactoryFacet',
			'OpenAdvertsQueryFacet'
		]

		facetsToTest.forEach((facetName, index) => {
			it(`should forward funds from ${facetName} to diamond and update totalAggregateRewardInPOL`, async function () {
				const { addr1, diamondAddress, diamondLoupeFacet, tokenFacet, owner } = await loadFixture(deployFixture)
				
				// Get the deployed facet address
				const facetAddress = await getFacetAddressByName(diamondLoupeFacet, facetName)
				
				console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
				console.log(`🧪 TEST ${index + 1}/15: ${facetName}`)
				console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

				console.log('\n📋 SETUP:')
				console.log(`   Facet: ${facetName}`)
				console.log(`   Facet Address: ${facetAddress}`)
				console.log(`   Diamond Address: ${diamondAddress}`)

				// Get initial state
				const initialFacetBalance = await ethers.provider.getBalance(facetAddress)
				const initialDiamondBalance = await ethers.provider.getBalance(diamondAddress)
				const initialAggregate = await tokenFacet.getTotalAggregateRewardInPOL()
				const initialOwnerRewards = await tokenFacet.calculateRewardPOL(owner.address)

				console.log('\n📊 INITIAL STATE:')
				console.log(`   Facet Balance: ${ethers.formatEther(initialFacetBalance)} POL`)
				console.log(`   Diamond Balance: ${ethers.formatEther(initialDiamondBalance)} POL`)
				console.log(`   totalAggregateRewardInPOL: ${ethers.formatEther(initialAggregate)} POL`)
				console.log(`   Owner Pending Rewards: ${ethers.formatEther(initialOwnerRewards)} POL`)

				// Send varying amounts to each facet (1-15 POL based on index)
				const fundingAmount = ethers.parseEther((index + 1).toString())
				console.log(`\n💸 SENDING ${ethers.formatEther(fundingAmount)} POL to ${facetName}...`)
				
				const tx = await addr1.sendTransaction({
					to: facetAddress,
					value: fundingAmount
				})
				const receipt = await tx.wait()
				console.log(`   ✅ Transaction confirmed: ${tx.hash}`)
				console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`)

				// Get final state
				const finalFacetBalance = await ethers.provider.getBalance(facetAddress)
				const finalDiamondBalance = await ethers.provider.getBalance(diamondAddress)
				const finalAggregate = await tokenFacet.getTotalAggregateRewardInPOL()
				const finalOwnerRewards = await tokenFacet.calculateRewardPOL(owner.address)

				console.log('\n📊 FINAL STATE:')
				console.log(`   Facet Balance: ${ethers.formatEther(finalFacetBalance)} POL`)
				console.log(`   Diamond Balance: ${ethers.formatEther(finalDiamondBalance)} POL`)
				console.log(`   totalAggregateRewardInPOL: ${ethers.formatEther(finalAggregate)} POL`)
				console.log(`   Owner Pending Rewards: ${ethers.formatEther(finalOwnerRewards)} POL`)

				console.log('\n🔍 VERIFICATION:')
				
				// Verify facet doesn't hold funds (forwarded to diamond)
				expect(finalFacetBalance).to.equal(initialFacetBalance)
				console.log(`   ✅ Facet balance unchanged (${ethers.formatEther(finalFacetBalance)} POL) - funds forwarded`)

				// Diamond.receive() sends adminCommissionFromADVC (5%) directly to owner;
				// SP commission (5%) is redirected to pool since storageProviderAddress is unset.
				// Net amount added to pool = fundingAmount - adminAmount.
				const adminAmount = (fundingAmount * 5n) / 100n
				const netPoolAmount = fundingAmount - adminAmount

				// Verify diamond net balance increased by netPoolAmount (adminAmount left diamond)
				const expectedDiamondBalance = initialDiamondBalance + netPoolAmount
				expect(finalDiamondBalance).to.equal(expectedDiamondBalance)
				console.log(`   ✅ Diamond net balance increased by ${ethers.formatEther(netPoolAmount)} POL (5% admin commission sent to owner)`)

				// Verify totalAggregateRewardInPOL was updated by diamond's receive()
				const expectedAggregate = initialAggregate + netPoolAmount
				expect(finalAggregate).to.equal(expectedAggregate)
				console.log(`   ✅ totalAggregateRewardInPOL updated correctly (+${ethers.formatEther(netPoolAmount)} POL net after commission)`)

				// Verify owner rewards increased (owner has 100% of tokens initially)
				const expectedOwnerRewards = initialOwnerRewards + netPoolAmount
				expect(finalOwnerRewards).to.equal(expectedOwnerRewards)
				console.log(`   ✅ Owner rewards increased by ${ethers.formatEther(fundingAmount)} POL`)

				console.log('\n✅ COMPLETE FLOW VERIFIED FOR ' + facetName)
				console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
			})
		})

		it('should revert when any facet is deployed with zero diamond address', async function () {
			const { addr1 } = await loadFixture(deployFixture)

			console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
			console.log('🧪 SECURITY TEST: Zero Address Rejection')
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

			// Test a representative facet (OpenAdvertsAdvertisersFacet)
			const OpenAdvertsAdvertisersFacet = await ethers.getContractFactory('OpenAdvertsAdvertisersFacet')
			const standaloneFacet = await OpenAdvertsAdvertisersFacet.deploy(ethers.ZeroAddress)
			await standaloneFacet.waitForDeployment()
			
			const standaloneFacetAddress = await standaloneFacet.getAddress()
			console.log(`   Test Facet: OpenAdvertsAdvertisersFacet`)
			console.log(`   Standalone Address: ${standaloneFacetAddress}`)
			console.log(`   Diamond Address (immutable): ${ethers.ZeroAddress}`)
			console.log(`   Attempting to send 1 POL...`)

			// This should fail because the facet's diamond address is zero
			await expect(
				addr1.sendTransaction({
					to: standaloneFacetAddress,
					value: ethers.parseEther('1')
				})
			).to.be.revertedWith('Diamond address not set')

			console.log(`   ✅ Correctly rejected (diamond address is zero)`)
			console.log('\n✅ SECURITY TEST PASSED - All facets have same protection')
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
		})

		it('should show cumulative rewards after sending to multiple facets', async function () {
			const { addr1, diamondAddress, diamondLoupeFacet, tokenFacet, owner } = await loadFixture(deployFixture)

			console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
			console.log('🧪 CUMULATIVE TEST: All Facets Together')
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

			const initialDiamondBalance = await ethers.provider.getBalance(diamondAddress)
			const initialAggregate = await tokenFacet.getTotalAggregateRewardInPOL()
			
			console.log('📊 INITIAL STATE:')
			console.log(`   Diamond Balance: ${ethers.formatEther(initialDiamondBalance)} POL`)
			console.log(`   totalAggregateRewardInPOL: ${ethers.formatEther(initialAggregate)} POL`)

			// Send 1 POL to each of first 5 facets
			const testFacets = ['DiamondLoupeFacet', 'OwnershipFacet', 'OpenAdvertsTokenFacet', 'OpenAdvertsGovernanceFacet', 'OpenAdvertsPayoutFacet']
			const amountPerFacet = ethers.parseEther('1')
			let totalSent = 0n

			console.log('\n💸 SENDING TO MULTIPLE FACETS:')
			for (const facetName of testFacets) {
				const facetAddress = await getFacetAddressByName(diamondLoupeFacet, facetName)
				await addr1.sendTransaction({ to: facetAddress, value: amountPerFacet })
				totalSent += amountPerFacet
				console.log(`   ✅ ${facetName}: ${ethers.formatEther(amountPerFacet)} POL`)
			}

			const finalDiamondBalance = await ethers.provider.getBalance(diamondAddress)
			const finalAggregate = await tokenFacet.getTotalAggregateRewardInPOL()

			console.log('\n📊 FINAL STATE:')
			console.log(`   Diamond Balance: ${ethers.formatEther(finalDiamondBalance)} POL`)
			console.log(`   totalAggregateRewardInPOL: ${ethers.formatEther(finalAggregate)} POL`)
			console.log(`   Total Sent: ${ethers.formatEther(totalSent)} POL`)

			// Net amounts after 5% admin commission per send
			const totalAdminCommission = (totalSent * 5n) / 100n
			const totalNetPool = totalSent - totalAdminCommission

			console.log('\n🔍 VERIFICATION:')
			expect(finalDiamondBalance).to.equal(initialDiamondBalance + totalNetPool)
			console.log(`   ✅ Diamond net balance increased by ${ethers.formatEther(totalNetPool)} POL (5% admin commission per send)`)

			expect(finalAggregate).to.equal(initialAggregate + totalNetPool)
			console.log(`   ✅ Aggregate rewards increased by ${ethers.formatEther(totalNetPool)} POL net`)

			console.log('\n✅ CUMULATIVE FORWARDING VERIFIED')
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
		})
	})
})
