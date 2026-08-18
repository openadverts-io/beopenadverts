/**
 * GasBaseline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GAS BENCHMARK: processReward() — BEFORE Memory Refactor
 *
 * Captures receipt.gasUsed for 6 representative scenarios and writes results
 * to test/GasBenchmark/gasBaseline.json so they can be compared against the
 * post-refactor numbers later.
 *
 * MUST be run BEFORE any code changes are made to OpenAdvertsPayoutFacet.
 *
 * Scenarios
 * ─────────
 *   A  20 sigs × 3 TPs — all 60 TP addresses unique
 *   B  20 sigs × 6 TPs — all 120 TP addresses unique   (max TP count per sig)
 *   C   7 sigs × 3 TPs — all 21 TP addresses unique    (mid-range normal batch)
 *   D   7 sigs × 3 TPs — 3 fixed TPs repeated          (deduplication path)
 *   E  50 sigs × 3 TPs — all 150 TP addresses unique   (governance max batch, all unique)
 *   F  50 sigs × 3 TPs — 3 fixed TPs repeated          (deduplication at scale)
 *
 * Notes on scenario E / F
 * ───────────────────────
 * Scenarios E and F each need 50 sigs (the governance maxSignaturesPerBatch).
 * Scenario E's 150 unique TP addresses fit within the ~193 Hardhat signer
 * addresses (signers[7..199]), so no generated addresses are required.
 * Polygon production gas limit reference: 30,000,000
 * Hardhat block gas limit:                50,000,000
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
const CODE_STATE           = 'BEFORE_MEMORY_REFACTOR'
const POLYGON_GAS_LIMIT    = 30_000_000n
const HARDHAT_GAS_LIMIT    = 50_000_000n

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function advanceBlocks (n = 15) {
  await mine(n)
}

/**
 * Generate a deterministic, valid Ethereum address from an integer seed.
 * These addresses can receive POL on Hardhat without being controlled signers.
 */
function generateDeterministicAddress (seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`gas-benchmark-tp-${seed}`))
  return ethers.getAddress('0x' + hash.slice(-40))
}

/**
 * Append one gas result entry to gasBaseline.json.
 * Creates the file / directory if they do not exist.
 */
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

/**
 * Build and sign one signature entry.
 * Signs the same hash format that OpenAdvertsPayoutFacet._verifySignatures expects.
 */
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

/**
 * @param {string} mockProviderContractName  Hardhat contract path:Name string
 *
 * Deploys a full diamond, approves one affiliate using the given mock claim
 * percentages provider, and creates + approves one funded POL advertisement.
 *
 * Account layout (200 Hardhat accounts):
 *   signers[0]      = owner
 *   signers[1]      = advertiser
 *   signers[2]      = affiliate
 *   signers[3]      = user  (the viewer — calls processReward, acts as tx.origin)
 *   signers[4-6]    = voter1, voter2, voter3
 *   signers[7-199]  = 193 addresses available as TP recipients
 */
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

  // Give the signing wallet a little ETH so it could pay gas if ever called directly
  await owner.sendTransaction({ to: signingWallet.address, value: ethers.parseEther('10') })

  // ── Deploy diamond ───────────────────────────────────────────────────────
  const deployedAddresses = await deployDiamond()
  const diamondAddress    = deployedAddresses.diamond

  // ── Facet interfaces ─────────────────────────────────────────────────────
  const tokenFacet         = await ethers.getContractAt('OpenAdvertsTokenFacet',            diamondAddress)
  const affiliatesFacet    = await ethers.getContractAt('OpenAdvertsAffiliatesFacet',        diamondAddress)
  const affiliateVoteFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet',  diamondAddress)
  const advertVoteFacet    = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
  const polFactoryFacet    = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet',  diamondAddress)
  const payoutFacet        = await ethers.getContractAt('OpenAdvertsPayoutFacet',             diamondAddress)

  // ── Mock claim percentages provider ──────────────────────────────────────
  const MockProvider    = await ethers.getContractFactory(mockProviderContractName)
  const mockProvider    = await MockProvider.deploy()
  await mockProvider.waitForDeployment()
  const mockProviderAddress = await mockProvider.getAddress()

  // ── Distribute voting tokens ──────────────────────────────────────────────
  const voterTokens = ethers.parseEther('5000000')
  await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)

  // ── Create + approve affiliate ────────────────────────────────────────────
  // Register protocol signer up-front so the website signature gate accepts creates.
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

  // ── Create + approve POL advertisement ───────────────────────────────────
  //    Fund with 3000 POL — more than sufficient for all scenarios.
  //    minPOLRequiredforAdvertInWei = 200 POL (governance default).
  //    advertBounty = 1 POL per sig.
  //    Worst case payout: 200 sigs × 1 POL = 200 POL (well under 3000).
  const advertBounty   = ethers.parseEther('1')
  const fundingAmount  = ethers.parseEther('3000')

  const createTx      = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
    'gas-benchmark-advert',
    advertBounty,
    1,   // minBlockSeparation = 1
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
    signerPool,       // 193 addresses (signers[7..199])
    advertBounty,
    mockProvider,
    mockProviderAddress
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds signatures, calls processReward, records gas.
 * Wraps the call in try/catch so an out-of-gas revert records cleanly rather
 * than failing the whole test suite.
 *
 * @param {object}   fixture       Return value from deployGasFixture
 * @param {number}   sigCount      Number of signatures to submit
 * @param {string[][]} tpSets      Array[sigCount] of address arrays, one per sig
 * @param {string}   scenario      Short label  e.g. 'A'
 * @param {string}   scenarioDesc  Human-readable description
 */
async function runScenario (fixture, sigCount, tpSets, scenario, scenarioDesc) {
  const { polContract, polAdvertAddress, designatedAffiliateAddress, user, signingWallet, advertBounty, mockProviderAddress, diamondAddress } = fixture

  console.log(`\n   ▶  Scenario ${scenario}: ${scenarioDesc}`)

  const nonce = await polContract.connect(user).getUserNonceOfAffiliate(designatedAffiliateAddress)

  // Ensure enough historical blocks exist so that historical block numbers
  // for all signatures are positive (and far enough in the past).
  // Each signature uses  currentBlock - (sigCount - i), so the earliest block
  // referenced is  currentBlock - sigCount.  We need currentBlock > sigCount + 5.
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

  // Build signatures — each with a strictly increasing block number that is
  // already in the past when processReward() is called.
  // Pattern: currentBlock - sigCount + i  (same as existing passing tests)
  const currentBlock = await ethers.provider.getBlockNumber()
  const chainId      = (await ethers.provider.getNetwork()).chainId
  const signatures   = []
  const blockNumbers = []

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

  // Call processReward and capture gas
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
    // Most likely: "Transaction ran out of gas" for large scenarios on Hardhat
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
  // 3 TPs per sig: affiliate 20%, viewer 20%, TP1/2/3 each 20%
  return deployGasFixture(
    'contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider'
  )
}

async function deploy6TPFixture () {
  // 6 TPs per sig: affiliate 20%, viewer 20%, TP1-6 each 10%
  return deployGasFixture(
    'contracts/MockClaimPercentagesProviderWith6TPs.sol:MockClaimPercentagesProviderWith6TPs'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('GAS BASELINE: processReward() — BEFORE Memory Refactor', function () {
  this.timeout(600000) // 10 minutes — large scenarios take time

  // Clear previous BEFORE_MEMORY_REFACTOR entries from the JSON file so each
  // full run of this file produces a clean, fresh set of baseline numbers.
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
    console.log('🔵  Running gas baseline — BEFORE memory refactor\n')
  })

  after(function () {
    if (fs.existsSync(BASELINE_FILE)) {
      console.log(`\n✅  Gas baseline written to: ${BASELINE_FILE}`)
      console.log('    Run test/GasBenchmark/compareGas.js after the refactor to see savings.\n')
    }
  })

  // ── Scenario A ─────────────────────────────────────────────────────────────
  it('Scenario A: 20 sigs × 3 TPs, all unique (60 unique TPs)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT  = 20
    const TPS_PER_SIG = 3
    // signerPool has 193 entries — 60 is well within range
    const tpSets = Array.from({ length: SIG_COUNT }, (_, i) => [
      f.signerPool[i * TPS_PER_SIG + 0].address,
      f.signerPool[i * TPS_PER_SIG + 1].address,
      f.signerPool[i * TPS_PER_SIG + 2].address
    ])
    await runScenario(f, SIG_COUNT, tpSets, 'A', '20 sigs × 3 TPs, all unique (60 unique TPs)')
  })

  // ── Scenario B ─────────────────────────────────────────────────────────────
  it('Scenario B: 20 sigs × 6 TPs, all unique (120 unique TPs)', async function () {
    const f = await loadFixture(deploy6TPFixture)
    const SIG_COUNT   = 20
    const TPS_PER_SIG = 6
    // 120 unique TPs needed — signerPool has 193, so all from pool
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

  // ── Scenario C ─────────────────────────────────────────────────────────────
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

  // ── Scenario D ─────────────────────────────────────────────────────────────
  it('Scenario D: 7 sigs × 3 TPs, fixed TPs repeated (deduplication path)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT = 7
    // Same 3 TP addresses repeat across every signature.
    // The _preparePayoutData addressAdded mapping should deduplicate them into
    // a single recipient entry each (3 total TP recipients, not 21).
    const fixedTPs = [
      f.signerPool[0].address,
      f.signerPool[1].address,
      f.signerPool[2].address
    ]
    const tpSets = Array.from({ length: SIG_COUNT }, () => [...fixedTPs])
    await runScenario(f, SIG_COUNT, tpSets, 'D', '7 sigs × 3 TPs, 3 fixed TPs deduplicated across all 7 sigs')
  })

  // ── Scenario E ─────────────────────────────────────────────────────────────
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

  // ── Scenario F ─────────────────────────────────────────────────────────────
  it('Scenario F: 50 sigs × 3 TPs, fixed TPs repeated at scale (deduplication)', async function () {
    const f = await loadFixture(deployBaseFixture)
    const SIG_COUNT = 50
    // 3 fixed TPs repeated 50 times.
    // Tests deduplication at the governance max batch size.
    // The payout data should only contain 3 TP recipient entries regardless.
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
