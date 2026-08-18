/**
 * GasPostRefactor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GAS BENCHMARK: processReward() — AFTER Memory Refactor
 *
 * Captures receipt.gasUsed for 6 representative scenarios and appends results
 * to test/GasBenchmark/gasBaseline.json so they can be compared against the
 * pre-refactor numbers via compareGas.js.
 *
 * MUST be run AFTER TODO-4 (storage → memory refactor) is complete.
 *
 * Scenarios
 * ─────────
 *   A  20 sigs × 3 TPs — all 60 TP addresses unique
 *   B  20 sigs × 6 TPs — all 120 TP addresses unique   (max TP count per sig)
 *   C   7 sigs × 3 TPs — all 21 TP addresses unique    (mid-range normal batch)
 *   D   7 sigs × 3 TPs — 3 fixed TPs repeated          (deduplication path)
 *   E  50 sigs × 3 TPs — all 150 TP addresses unique   (governance max batch, all unique)
 *   F  50 sigs × 3 TPs — 3 fixed TPs repeated          (deduplication at scale)
 */

const { ethers }      = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { mine }        = require('@nomicfoundation/hardhat-network-helpers')
const fs              = require('fs')
const path            = require('path')

const { deployDiamond } = require('../../scripts/deploy.js')
const gate = require('../helpers/signatureGate.js')

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SIGNING_PRIVATE_KEY  = ethers.Wallet.createRandom().privateKey
const BASELINE_FILE        = path.join(__dirname, 'gasBaseline.json')
const CODE_STATE           = 'AFTER_MEMORY_REFACTOR'
const POLYGON_GAS_LIMIT    = 30_000_000n
const HARDHAT_GAS_LIMIT    = 50_000_000n

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function advanceBlocks (n = 15) {
  await mine(n)
}

function generateDeterministicAddress (seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`gas-benchmark-tp-${seed}`))
  return ethers.getAddress('0x' + hash.slice(-40))
}

function recordGas (entry) {
  let data = []
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
    }
  } catch (_) {}

  const gasVal = entry.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT'
    ? entry.gasUsed
    : BigInt(entry.gasUsed)

  data.push({
    ...entry,
    timestamp:           new Date().toISOString(),
    codeState:           CODE_STATE,
    polygonGasLimit:     POLYGON_GAS_LIMIT.toString(),
    hardhatGasLimit:     HARDHAT_GAS_LIMIT.toString(),
    exceedsPolygonLimit: typeof gasVal === 'bigint' ? gasVal > POLYGON_GAS_LIMIT : 'N/A',
    exceedsHardhatLimit: entry.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT'
  })

  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2))

  const exceedsTag = typeof gasVal === 'bigint' && gasVal > POLYGON_GAS_LIMIT
    ? ' ⚠️  EXCEEDS POLYGON 30M'
    : ' ✅ within Polygon limit'
  const gasStr = entry.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT'
    ? '💥 EXCEEDED HARDHAT 50M BLOCK GAS LIMIT'
    : BigInt(entry.gasUsed).toLocaleString() + exceedsTag

  console.log(`\n   📊  ${entry.scenario} | gas=${gasStr}`)
}

async function createSignature (chainId, diamondAddress, signingWallet, viewerAddress, blockNumber, verificationData, tpAddresses, advertBounty) {
  const tpCount    = BigInt(tpAddresses.length)
  const paddedHex  = tpAddresses.map(a => ethers.zeroPadValue(a, 32)).join('').replace(/0x/g, '')
  const tpHash     = ethers.keccak256('0x' + paddedHex)

  const messageHash = ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'uint256'],
    [
      chainId,
      diamondAddress,
      viewerAddress,
      BigInt(blockNumber),
      BigInt(verificationData.nonce),
      verificationData.affiliateReceivingAddress,
      verificationData.advertismentContractAddress,
      tpCount,
      tpHash,
      advertBounty
    ]
  )
  return signingWallet.signMessage(ethers.getBytes(messageHash))
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture factory
// ─────────────────────────────────────────────────────────────────────────────

async function deployGasFixture (mockProviderContractName) {
  const signers     = await ethers.getSigners()
  const owner       = signers[0]
  const advertiser  = signers[1]
  const affiliate   = signers[2]
  const user        = signers[3]
  const voter1      = signers[4]
  const voter2      = signers[5]
  const voter3      = signers[6]
  const signerPool  = signers.slice(7)  // 193 entries

  const signingWallet = new ethers.Wallet(SIGNING_PRIVATE_KEY, ethers.provider)

  await owner.sendTransaction({ to: signingWallet.address, value: ethers.parseEther('10') })

  const deployedAddresses = await deployDiamond()
  const diamondAddress    = deployedAddresses.diamond

  const tokenFacet         = await ethers.getContractAt('OpenAdvertsTokenFacet',            diamondAddress)
  const affiliatesFacet    = await ethers.getContractAt('OpenAdvertsAffiliatesFacet',        diamondAddress)
  const affiliateVoteFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet',  diamondAddress)
  const advertVoteFacet    = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
  const polFactoryFacet    = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet',  diamondAddress)
  const payoutFacet        = await ethers.getContractAt('OpenAdvertsPayoutFacet',             diamondAddress)

  const MockProvider    = await ethers.getContractFactory(mockProviderContractName)
  const mockProvider    = await MockProvider.deploy()
  await mockProvider.waitForDeployment()
  const mockProviderAddress = await mockProvider.getAddress()

  const voterTokens = ethers.parseEther('5000000')
  await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)

  await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingWallet.address)
  await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
    affiliate.address,
    mockProviderAddress,
    signingWallet.address,
    'gas-benchmark-affiliate',
    ...(await gate.affiliate(signingWallet, diamondAddress, affiliate.address)))
  await advanceBlocks(15)
  await affiliateVoteFacet.connect(voter1).voteOnAffiliate(affiliate.address, true)
  await affiliateVoteFacet.connect(voter2).voteOnAffiliate(affiliate.address, true)
  await affiliateVoteFacet.connect(voter3).voteOnAffiliate(affiliate.address, true)

  // Ensure the protocol signer matches the wallet used to produce test signatures.
  await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingWallet.address)
  const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
  const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

  const advertBounty   = ethers.parseEther('1')
  const fundingAmount  = ethers.parseEther('3000')

  const createTx      = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
    'gas-benchmark-advert',
    advertBounty,
    1,
    designatedAffiliateAddress,
    ...(await gate.pol(signingWallet, diamondAddress, advertiser.address)),
    { value: fundingAmount }
  )
  const createReceipt = await createTx.wait()

  const createEvent = createReceipt.logs.find(log => {
    try { return polFactoryFacet.interface.parseLog(log).name === 'POLAdvertisementCreatedAndValidated' }
    catch (_) { return false }
  })
  const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvent).args.advertContract

  await advanceBlocks(15)
  await advertVoteFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true)
  await advertVoteFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true)
  await advertVoteFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true)

  const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', polAdvertAddress)

  return {
    diamondAddress,
    polContract,
    polAdvertAddress,
    owner, advertiser, affiliate, user,
    designatedAffiliateAddress,
    voter1, voter2, voter3,
    signingWallet,
    signerPool,
    advertBounty,
    mockProvider,
    mockProviderAddress
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario runner
// ─────────────────────────────────────────────────────────────────────────────

async function runScenario (fixture, sigCount, tpSets, scenario, scenarioDesc) {
  const { polContract, polAdvertAddress, designatedAffiliateAddress, user, signingWallet, advertBounty, mockProviderAddress, diamondAddress } = fixture

  console.log(`\n   ▶  Scenario ${scenario}: ${scenarioDesc}`)

  const nonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)

  let preMineBlock = await ethers.provider.getBlockNumber()
  if (preMineBlock <= sigCount + 5) {
    const needed = sigCount + 10 - preMineBlock
    console.log(`\n   ⛏️  Mining ${needed} extra blocks to ensure ${sigCount} historical blocks available`)
    await mine(needed)
  }

  const verificationData = {
    affiliateReceivingAddress:  designatedAffiliateAddress,
    affiliateClaimInfoAddress:  mockProviderAddress,
    affiliateSigningAddress:    signingWallet.address,
    advertismentContractAddress: polAdvertAddress,
    nonce:                      Number(nonce),
    viewerAddress:              ethers.ZeroAddress  // overwritten by processReward to msg.sender
  }

  const currentBlock = await ethers.provider.getBlockNumber()
  const signatures   = []
  const blockNumbers = []
  const chainId      = (await ethers.provider.getNetwork()).chainId

  for (let i = 0; i < sigCount; i++) {
    const blockNumber = currentBlock - (sigCount - i)
    blockNumbers.push(blockNumber)
    const sig = await createSignature(
      chainId,
      diamondAddress,
      signingWallet,
      user.address,
      blockNumber,
      verificationData,
      tpSets[i],
      advertBounty
    )
    signatures.push(sig)
  }

  const thirdPartyAddrs = tpSets.map(tps => ({ thirdPartyAddresses: tps }))

  try {
    const tx      = await polContract.connect(user).processReward(
      signatures,
      blockNumbers,
      verificationData,
      thirdPartyAddrs
    )
    const receipt = await tx.wait()
    const gasUsed = receipt.gasUsed

    recordGas({
      scenario:    scenario,
      description: scenarioDesc,
      sigCount:    sigCount,
      tpsPerSig:   tpSets[0].length,
      uniqueTPs:   new Set(tpSets.flat()).size,
      gasUsed:     gasUsed.toString()
    })

    return gasUsed

  } catch (err) {
    const reason = err.message || String(err)
    console.log(`\n   💥  Scenario ${scenario} REVERTED: ${reason.slice(0, 120)}`)

    recordGas({
      scenario:    scenario,
      description: scenarioDesc,
      sigCount:    sigCount,
      tpsPerSig:   tpSets[0].length,
      uniqueTPs:   new Set(tpSets.flat()).size,
      gasUsed:     'EXCEEDED_BLOCK_GAS_LIMIT',
      error:       reason.slice(0, 200)
    })

    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function deployBaseFixture () {
  return deployGasFixture(
    'contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider'
  )
}

async function deploy6TPFixture () {
  return deployGasFixture(
    'contracts/MockClaimPercentagesProviderWith6TPs.sol:MockClaimPercentagesProviderWith6TPs'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('GAS POST-REFACTOR: processReward() — AFTER Memory Refactor', function () {
  this.timeout(600000) // 10 minutes

  before(function () {
    if (fs.existsSync(BASELINE_FILE)) {
      try {
        let data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
        const before = data.length
        data = data.filter(e => e.codeState !== CODE_STATE)
        fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2))
        console.log(`\n📝  Cleared ${before - data.length} previous ${CODE_STATE} entries from gasBaseline.json`)
      } catch (_) {}
    }
    console.log('🟢  Running gas benchmark — AFTER memory refactor\n')
  })

  after(function () {
    if (fs.existsSync(BASELINE_FILE)) {
      console.log(`\n✅  Post-refactor gas results written to: ${BASELINE_FILE}`)
      console.log('    Run:  node test/GasBenchmark/compareGas.js  to see the savings.\n')
    }
  })

  it('Scenario A: 20 sigs × 3 TPs, all unique (60 unique TPs)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT  = 20
    const TPS_PER_SIG = 3
    const tpSets = Array.from({ length: SIG_COUNT }, (_, i) => [
      f.signerPool[i * TPS_PER_SIG + 0].address,
      f.signerPool[i * TPS_PER_SIG + 1].address,
      f.signerPool[i * TPS_PER_SIG + 2].address
    ])
    await runScenario(f, SIG_COUNT, tpSets, 'A', '20 sigs × 3 TPs, all unique (60 unique TPs)')
  })

  it('Scenario B: 20 sigs × 6 TPs, all unique (120 unique TPs)', async function () {
    const f = await loadFixture(deploy6TPFixture)
    const SIG_COUNT   = 20
    const TPS_PER_SIG = 6
    const tpSets = Array.from({ length: SIG_COUNT }, (_, i) => [
      f.signerPool[i * TPS_PER_SIG + 0].address,
      f.signerPool[i * TPS_PER_SIG + 1].address,
      f.signerPool[i * TPS_PER_SIG + 2].address,
      f.signerPool[i * TPS_PER_SIG + 3].address,
      f.signerPool[i * TPS_PER_SIG + 4].address,
      f.signerPool[i * TPS_PER_SIG + 5].address
    ])
    await runScenario(f, SIG_COUNT, tpSets, 'B', '20 sigs × 6 TPs, all unique (120 unique TPs)')
  })

  it('Scenario C: 7 sigs × 3 TPs, all unique (21 unique TPs)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT   = 7
    const TPS_PER_SIG = 3
    const tpSets = Array.from({ length: SIG_COUNT }, (_, i) => [
      f.signerPool[i * TPS_PER_SIG + 0].address,
      f.signerPool[i * TPS_PER_SIG + 1].address,
      f.signerPool[i * TPS_PER_SIG + 2].address
    ])
    await runScenario(f, SIG_COUNT, tpSets, 'C', '7 sigs × 3 TPs, all unique (21 unique TPs)')
  })

  it('Scenario D: 7 sigs × 3 TPs, fixed TPs repeated (deduplication path)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT = 7
    const fixedTPs = [
      f.signerPool[0].address,
      f.signerPool[1].address,
      f.signerPool[2].address
    ]
    const tpSets = Array.from({ length: SIG_COUNT }, () => [...fixedTPs])
    await runScenario(f, SIG_COUNT, tpSets, 'D', '7 sigs × 3 TPs, 3 fixed TPs deduplicated across all 7 sigs')
  })

  it('Scenario E: 50 sigs × 3 TPs, all unique (150 unique TPs — governance max batch)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT   = 50
    const TPS_PER_SIG = 3
    const TOTAL_TPS   = SIG_COUNT * TPS_PER_SIG // 150

    // 150 unique TPs fit within the ~193-address signer pool; no generated addresses needed.
    const allTPAddresses = f.signerPool.map(s => s.address)

    const tpSets = Array.from({ length: SIG_COUNT }, (_, i) => [
      allTPAddresses[i * TPS_PER_SIG + 0],
      allTPAddresses[i * TPS_PER_SIG + 1],
      allTPAddresses[i * TPS_PER_SIG + 2]
    ])

    await runScenario(f, SIG_COUNT, tpSets, 'E', '50 sigs × 3 TPs, all unique (150 unique TPs — governance max batch)')
  })

  it('Scenario F: 50 sigs × 3 TPs, fixed TPs repeated at scale (deduplication)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT = 50
    const fixedTPs = [
      f.signerPool[0].address,
      f.signerPool[1].address,
      f.signerPool[2].address
    ]
    const tpSets = Array.from({ length: SIG_COUNT }, () => [...fixedTPs])

    console.log(`\n   ℹ️  Scenario F: same 3 TPs across 50 sigs — only 3 unique TP recipients in payout data`)

    await runScenario(f, SIG_COUNT, tpSets, 'F', '50 sigs × 3 TPs, 3 fixed TPs deduplicated across 50 sigs')
  })
})
