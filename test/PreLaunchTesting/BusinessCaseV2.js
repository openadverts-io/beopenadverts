'use strict'

const gate = require('../helpers/signatureGate.js')
let _gateSigner, _gateDiamond

/**
 * BusinessCaseV2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Production-grade business case analysis for the OpenAdverts Diamond Protocol.
 * Builds directly on BusinessCase.js (v1) and addresses every structural gap
 * identified in the post-gas-refactor review:
 *
 *  Section 0  – Centralised CONFIG block (no more hard-coded assumptions)
 *  Section 1  – Shared helpers (TP matrix, signatures, net-breakeven maths)
 *  Section 2  – Governance initialiser (real commission rates, not 0)
 *  Section 3  – Shared fixture  (deploys diamond + all 4 mock providers)
 *  Section 4  – LIFECYCLE test  (setup cost amortisation – todo item 4.x)
 *  Section 5  – POL scenarios   (0-TP, 3-TP-unique, 3-TP-dedup, 6-TP-unique,
 *                                 50-sig scale, maxBatch scale)
 *  Section 6  – USDC scenario   (20 sigs, 3-TP-unique on USDC advert)
 *  Section 7  – after() hook    (consolidated matrix summary + JSON write)
 *
 * Output artifact: test/GasBenchmark/bcv2Baseline.json
 * Report generator: node test/GasBenchmark/generateReport.js  →  bcv2Report.html
 *
 * All planned tests are now implemented. MockV3Aggregator IS the oracle — no external feed needed.
 *   • BCv2-POL-0TP-MIN  – 0-TP at governance minAdvertBountyInPOLWei (reads live from finalQuotas)
 *   • BCv2-USDC-0TP-MIN – 0-TP USDC at oracle-derived governance minimum bounty
 *   • BCv2-USDC-SENS    – 4 bounty levels (2×/10×/50×/500× governance min) × full polPrice×gasPrice matrix
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { expect }      = require('chai')
const { ethers }      = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { mine }        = require('@nomicfoundation/hardhat-network-helpers')
const fs              = require('fs')
const path            = require('path')

const { deployDiamond } = require('../../scripts/deploy.js')

// =============================================================================
// ECONOMIC MODEL — HOW TO READ THIS REPORT  (self-contained)
//
// PURPOSE
//   Quantify, per single ad engagement ("impression"), how the viewer's reward and
//   the gas they pay to claim it move with three levers: POL price, gas price, and
//   the viewer's share of the bounty. This file is intended to stand on its own as
//   the canonical "reward-per-impression floor" document for the protocol.
//
// WHO PAYS GAS
//   processReward() is called by the reward recipient (the viewer in these tests);
//   that caller pays the transaction gas. Rewards are batched, so `gasPerSig` below
//   is the amortised per-signature gas (totalGas / sigCount).
//
// HOW A BOUNTY IS SPLIT (verified against contracts/OpenAdvertsAdvertPOL.sol)
//   * Per signature, `advertBounty` (POL wei) is split among viewer / affiliate /
//     third parties per the affiliate's claim-percentage provider. The viewer
//     receives  advertBounty x viewerPct/100.
//   * The 5% protocol commission is a SEPARATE one-time skim of the campaign funding
//     (processCommission -> Diamond), NOT a per-signature deduction from the viewer.
//     It shrinks how many signatures the pool can pay, not the per-sig viewer amount.
//
// TWO BOUNTY-DENOMINATION MODELS (they behave OPPOSITELY vs POL price)
//   * POL advert  -> bounty FIXED in POL. Reward USD AND gas USD both scale with POL
//     price, so whether a claim is profitable is POL-price-INVARIANT; POL price only
//     scales the magnitude. Viability depends purely on
//         advertBountyPOL x viewerPct/100   vs   gasPerSig x gwei x 1e-9   (both POL).
//   * USDC advert -> bounty FIXED in USD (uUSDC); gas is still paid in POL. Here a
//     LOWER POL price makes gas cheaper in USD and IMPROVES viability.
//
// TODAY'S ENVIRONMENT (why this revision exists)
//   POL ~ $0.08 (down from the $0.25 baseline) and Polygon base fee frequently sits
//   at 100-500 gwei (up from ~30). Both extremes are now in the sensitivity ranges;
//   the REWARD-PER-IMPRESSION FLOOR section focuses on {0.08,0.10,0.25} x {100,500}.
//
// READING THE TABLES
//   breakeven % = gas cost / viewer reward x 100. <100% means the reward covers gas.
//   For POL adverts the breakeven % is identical across POL-price rows (by the
//   invariant above); the gas/reward USD columns show how small the absolute numbers
//   get at $0.08 POL. A LOSS verdict means the viewer pays more gas than they receive.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 – CONFIGURATION
// All numeric assumptions are declared here. Change once, applies everywhere.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {

  // ── Economic sensitivity ranges ──────────────────────────────────────────
  // BCv1 used a single point (polPrice=0.25, gasPriceGwei=30).
  // BCv2 runs the full matrix.
  // 2025+ reality check: POL fell to ~$0.08 and Polygon base fee routinely spikes to
  // 100–500 gwei, so both extremes are included to capture "today's environment".
  // NOTE: these two arrays are duplicated in test/GasBenchmark/generateReport.js
  //       (POL_PRICES / GAS_PRICES_GWEI) — keep the two in sync.
  polPricesUSD:   [0.08, 0.10, 0.25, 0.50, 1.00],
  gasPricesGwei:  [1, 30, 100, 200, 500],

  // ── Batch sizes ───────────────────────────────────────────────────────────
  // maxBatch is added dynamically from governance inside the tests.
  batchSizes: [20, 50],

  // ── Bounty levels (POL, at $0.25 baseline) ───────────────────────────────
  bountyLevelsPOL: [
    { name: 'Min floor  ($0.0150)', polWei: ethers.parseEther('0.06'),  usdAt025: 0.0150 },
    { name: 'Mid        ($0.0300)', polWei: ethers.parseEther('0.12'),  usdAt025: 0.0300 },
    { name: 'High       ($0.0600)', polWei: ethers.parseEther('0.24'),  usdAt025: 0.0600 },
  ],

  // ── USDC bounty (microUSDC = 1e-6 USDC) ──────────────────────────────────
  // Must comfortably exceed the dynamic minimum derived from governance+oracle.
  usdcBountyMicro: 100_000n,   // $0.10 USDC per signature
  usdcFundingMicro: 5_000_000n, // $5.00 USDC total campaign funding

  // ── Viewer claim percentages to report on ────────────────────────────────
  viewerClaimPcts: [20, 50, 80],

  // ── "Today's environment" focus points for the reward-per-impression floor ───
  // Subset of the full ranges above, chosen to keep the floor table legible.
  todayPolPricesUSD:  [0.08, 0.10, 0.25],
  todayGasPricesGwei: [100, 500],

  // ── Gas regression ceilings (per-sig) ────────────────────────────────────
  // Intentionally ~2× post-refactor observed values.
  // Exceeding these fails the test, surfacing regressions before deployment.
  gasBudgets: {
    perSig_0TP:         65_000,
    perSig_3TP_uniq:   185_000,
    perSig_3TP_dedup:   50_000,
    perSig_6TP_uniq:   375_000,
    perSig_USDC_3TP:   220_000,
    perSig_USDC_0TP:   110_000,  // 0-TP USDC path — ERC-20 transfer overhead vs native POL
  },

  // ── Protocol commission rates (must match initializeGovernanceQuotas) ─────
  openAdvertsCommissionPct:            5,
  storageProviderCommissionPct:       2,
  adminCommissionPct:                 0,

  // ── Mock Chainlink price ($0.25 POL, 8 decimals) ─────────────────────────
  mockPOLPriceChainlink: 25_000_000,

  // ── Output artifact for generateReport.js ────────────────────────────────
  outputFile: path.join(__dirname, '../../test/GasBenchmark/bcv2Baseline.json'),

  // ── Known signing key (same as GasPostRefactor.js) ───────────────────────
  signingPrivateKey: ethers.Wallet.createRandom().privateKey,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 – MODULE-LEVEL RESULTS COLLECTOR
// Populated by each test; consumed by the after() hook.
// ─────────────────────────────────────────────────────────────────────────────

const RESULTS = []

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 – HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Advance N blocks to bypass flash-loan vote protection */
async function advanceBlocks(n = 15) { await mine(n) }

/**
 * Build the ThirdPartyAddressStruct array for a processReward batch.
 *
 * @param {number}  sigCount  Number of signatures in the batch
 * @param {number}  tpCount   Third-party addresses per signature (0, 3, or 6)
 * @param {boolean} dedup     If true all sigs share the same TP addresses
 * @returns {{ thirdPartyAddresses: string[] }[]}
 */
function buildTPMatrix(sigCount, tpCount, dedup) {
  if (tpCount === 0) {
    return Array.from({ length: sigCount }, () => ({ thirdPartyAddresses: [] }))
  }
  const fixedAddrs = Array.from({ length: tpCount }, (_, i) =>
    deterministicAddr(`fixed-tp-${i}`)
  )
  return Array.from({ length: sigCount }, (_, sigIdx) => {
    if (dedup) return { thirdPartyAddresses: [...fixedAddrs] }
    return {
      thirdPartyAddresses: Array.from({ length: tpCount }, (_, tpIdx) =>
        deterministicAddr(`uniq-sig${sigIdx}-tp${tpIdx}`)
      ),
    }
  })
}

/** Deterministic EVM address from a seed string (no private key needed) */
function deterministicAddr(seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`bcv2-${seed}`))
  return ethers.getAddress('0x' + hash.slice(-40))
}

/**
 * Create a full batch of processReward signatures.
 *
 * @param {bigint}        chainId         Active chain id (binds signature to chain)
 * @param {string}        diamondAddress  Diamond address (delegatecall context in the on-chain hash)
 * @param {ethers.Wallet} wallet          Signing wallet
 * @param {object}        verificationData  VerificationDataStruct fields
 * @param {Array}         tpMatrix        Output of buildTPMatrix
 * @param {number}        startBlock      Current block; each sig uses a past block
 * @param {BigInt}        bountyWei       Bounty stored in the advert contract
 * @returns {{ signatures: string[], blockNumbers: number[] }}
 */
async function createSignaturesBatch(chainId, diamondAddress, wallet, verificationData, tpMatrix, startBlock, bountyWei) {
  const signatures   = []
  const blockNumbers = []

  for (let i = 0; i < tpMatrix.length; i++) {
    const blockNumber = startBlock - (tpMatrix.length - i)
    blockNumbers.push(blockNumber)

    const tpAddrs = tpMatrix[i].thirdPartyAddresses
    const tpCount = BigInt(tpAddrs.length)

    let tpHash
    if (tpAddrs.length === 0) {
      tpHash = ethers.keccak256('0x')
    } else {
      const paddedHex = tpAddrs.map(a => ethers.zeroPadValue(a, 32)).join('').replace(/0x/g, '')
      tpHash = ethers.keccak256('0x' + paddedHex)
    }

    const msgHash = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'uint256'],
      [
        chainId,
        diamondAddress,
        verificationData.viewerAddress,
        BigInt(blockNumber),
        BigInt(verificationData.nonce),
        verificationData.affiliateReceivingAddress,
        verificationData.advertismentContractAddress,
        tpCount,
        tpHash,
        bountyWei,
      ]
    )
    signatures.push(await wallet.signMessage(ethers.getBytes(msgHash)))
  }
  return { signatures, blockNumbers }
}

/**
 * Calculate net breakeven viewer-claim % for every (polPrice, gasPrice) combo.
 *
 * IMPORTANT — POL-denominated bounty model:
 *   On-chain a POL advert stores a FIXED POL bounty (advertBounty, in wei), so its
 *   USD value scales with the POL price. `grossBountyUSDAt025` is quoted at the $0.25
 *   baseline and is rescaled here by (polUSD / 0.25). Because gas is ALSO paid in POL,
 *   the breakeven % is mathematically INVARIANT to POL price — POL price only changes
 *   the absolute USD magnitudes, never whether a claim is profitable. (Contrast: a
 *   USDC advert has a fixed-USD bounty, so there POL price DOES move the breakeven —
 *   see the reward-per-impression floor section and the header notes.)
 *
 *   Commission is the protocol's separate one-time skim of the funding pool
 *   (processCommission), not a per-signature deduction from the viewer's share; it is
 *   applied here only as a conservative haircut on the advertiser-funded bounty.
 *
 * @param {number} grossBountyUSDAt025  Gross bounty USD value quoted at $0.25/POL
 * @param {number|BigInt} gasPerSig     Gas units consumed per signature
 * @returns {Array<{polUSD, gwei, gasCostUSD, netBountyUSD, breakevenPct, twoXPct}>}
 */
function calculateNetBreakeven(grossBountyUSDAt025, gasPerSig) {
  const comm = CONFIG.openAdvertsCommissionPct
  const rows = []
  for (const polUSD of CONFIG.polPricesUSD) {
    for (const gwei of CONFIG.gasPricesGwei) {
      const gasCostUSD   = Number(gasPerSig) * gwei * 1e-9 * polUSD
      const grossScaled  = grossBountyUSDAt025 * (polUSD / 0.25)
      const netBountyUSD = grossScaled * (1 - comm / 100)
      const breakevenPct = netBountyUSD > 0 ? (gasCostUSD / netBountyUSD) * 100 : Infinity
      rows.push({ polUSD, gwei, gasCostUSD, netBountyUSD, breakevenPct, twoXPct: breakevenPct * 2 })
    }
  }
  return rows
}

/** Append a scenario record to bcv2Baseline.json */
function recordScenario(entry) {
  let data = []
  try {
    if (fs.existsSync(CONFIG.outputFile))
      data = JSON.parse(fs.readFileSync(CONFIG.outputFile, 'utf8'))
  } catch (_) { /* fresh file */ }

  const rec = {
    ...entry,
    timestamp:      new Date().toISOString(),
    codeState:      'BCv2',
    polygonLimit:   30_000_000,
    withinPolygon:  typeof entry.gasUsed === 'bigint'
                    ? entry.gasUsed <= 30_000_000n
                    : entry.gasUsed !== 'EXCEEDED',
  }
  const safe = JSON.parse(JSON.stringify(rec, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  ))
  data.push(safe)
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true })
  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(data, null, 2))
  return safe
}

/* ── ASCII table helpers ── */
function pad(s, w, right = false) {
  const str = String(s)
  return right ? str.padStart(w) : str.padEnd(w)
}
function fmtGas(n) {
  if (n === 'EXCEEDED') return '💥 OOG'
  return typeof n === 'bigint' ? n.toLocaleString() : Number(n).toLocaleString()
}
function fmtUSD(n) { return `$${Number(n).toFixed(6)}` }

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 – GOVERNANCE INITIALISER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set deterministic governance quotas with known commission rates.
 * Idempotent — skips if already initialised.
 * minAdvertBountyInPOLWei is set to 0.005 POL to support BCv1-sized bounties
 * ($0.00125 at $0.25) while still enforcing a meaningful floor.
 */
async function initializeGovernanceQuotas(governanceFacet, owner) {
  const q = await governanceFacet.getAllCurrentQuotas()
  if (q.minPOLRequiredforAdvertInWei > 0n) {
    console.log('   ✅ Governance already initialized')
    return
  }
  console.log('   🏛️  Setting governance quotas…')
  await governanceFacet.connect(owner).createProposal(0, {
    proposedQuotaProposalQuorum:               51,
    proposedMinQuotaProposalDuration:          300,
    proposedMaxQuotaProposalDuration:          86400,
    proposedOpenAdvertsCommission:              CONFIG.openAdvertsCommissionPct,       // 5 %
    proposedStorageProviderCommissionFromADVC: CONFIG.storageProviderCommissionPct,  // 2 %
    proposedAdminCommissionFromADVC:           CONFIG.adminCommissionPct,            // 0 %
    proposedPolBlocksPerHour:                  1800,
    proposedMinPOLRequiredforAdvertInWei:      ethers.parseEther('0.1'),
    proposedMinAdvertBountyInPOLWei:           ethers.parseEther('0.005'),
    proposedUSDCCurrencyPremiumInPCT:          10,
    proposedAdvertApprovalDenialQuorum:        51,
    proposedAdvertApprovalThreshold:           60,
    proposedAdvertDenialThreshold:             40,
    proposedMaxBlockSeparationAdvertisement:   1000,
    proposedAffiliateApprovalDenialQuorum:     51,
    proposedAffiliateApprovalThreshold:        60,
    proposedAffiliateDenialThreshold:          40,
    proposedFacetProposalQuorum:               67,
    proposedMinFacetProposalDuration:          300,
    proposedMaxFacetProposalDuration:          86400,
    proposedOpenAdvertsAdminChangeQuorum:       67,
    proposedAdminApplicantFeeInPolWei:         ethers.parseEther('1.0'),
    proposedAdminVoteDeadlineInBlocks:         7200,
    proposedAdvertPauseCooldownBlocks:         7200,
    proposedMaxSignaturesPerBatch:             50,
    proposedMinViewerClaimPct:                 70,
  }, 300, [])
  await mine(301)
  await governanceFacet.connect(owner).ratifyUpgrade()
  console.log(`   ✅ Governance set — commission=${CONFIG.openAdvertsCommissionPct}%, ` +
              `storageProvider=${CONFIG.storageProviderCommissionPct}%, maxSigs=200`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 – SHARED FIXTURE
// Deploys once per top-level snapshot; each test restores to this point.
// ─────────────────────────────────────────────────────────────────────────────

async function deployBCv2Fixture() {
  const signers    = await ethers.getSigners()
  const owner      = signers[0]
  const advertiser = signers[1]
  const affiliate  = signers[2]
  const viewer     = signers[3]
  const voter1     = signers[4]
  const voter2     = signers[5]
  const voter3     = signers[6]

  // Fund signing wallet with ETH for transactions
  const signingWallet = new ethers.Wallet(CONFIG.signingPrivateKey, ethers.provider)
  await owner.sendTransaction({ to: signingWallet.address, value: ethers.parseEther('10') })

  console.log('\n📍 BCv2 FIXTURE – DEPLOYING DIAMOND')
  const deployed     = await deployDiamond()
  const diamondAddress = deployed.diamond

  // ── Contract interfaces ──────────────────────────────────────────────────
  const govFacet          = await ethers.getContractAt('OpenAdvertsGovernanceFacet',        diamondAddress)
  const tokenFacet        = await ethers.getContractAt('OpenAdvertsTokenFacet',             diamondAddress)
  const affiliatesFacet   = await ethers.getContractAt('OpenAdvertsAffiliatesFacet',        diamondAddress)
  const affiliateVote     = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet',  diamondAddress)
  const advertisersFacet  = await ethers.getContractAt('OpenAdvertsAdvertisersFacet',       diamondAddress)
  const advertVote        = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
  const polFactory        = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet',  diamondAddress)
  const usdcFactory       = await ethers.getContractAt('OpenAdvertsAdvertUSDCFactoryFacet', diamondAddress)
  const usdcPriceFacet    = await ethers.getContractAt('OpenAdvertsAdvertUSDCPriceFacet',   diamondAddress)
  const payoutFacet       = await ethers.getContractAt('OpenAdvertsPayoutFacet',            diamondAddress)

  // Keep protocol signer deterministic for BCv2 signatures regardless of env config.
  await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingWallet.address)
  _gateSigner = signingWallet
  _gateDiamond = diamondAddress

  // ── USDC / price feed mocks ──────────────────────────────────────────────
  const usdcAddr         = await advertisersFacet.getUSDCTokenAddress()
  const priceFeedAddr    = await advertisersFacet.getPriceFeedAddress()
  const mockUSDC         = await ethers.getContractAt('MockUSDC',          usdcAddr)
  const mockPriceFeed    = await ethers.getContractAt('MockV3Aggregator',  priceFeedAddr)

  // Set price to $0.25 / POL for consistent BCv2 baseline
  await mockPriceFeed.updateAnswer(CONFIG.mockPOLPriceChainlink)
  console.log(`   ✅ POL price set to $${CONFIG.mockPOLPriceChainlink / 1e8} (mock Chainlink)`)

  // ── Governance ───────────────────────────────────────────────────────────
  await initializeGovernanceQuotas(govFacet, owner)
  const finalQuotas = await govFacet.getAllCurrentQuotas()

  // ── Governance tokens ────────────────────────────────────────────────────
  const voterTokens = ethers.parseEther('5000000')
  await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)
  await tokenFacet.connect(owner).transfer(advertiser.address, voterTokens)
  console.log('   ✅ Governance tokens distributed')

  // ── USDC for advertiser ──────────────────────────────────────────────────
  // deploy.js already mints for accounts 0-4; top up to ensure sufficient balance
  await mockUSDC.connect(owner).mint(advertiser.address, ethers.parseUnits('50000', 6))
  console.log('   ✅ USDC minted to advertiser (50,000 USDC)')

  // ── Deploy all mock claim providers ─────────────────────────────────────
  // Factory pattern mirrors MockClaimPercentagesProviderAt50.sol convention
  const providerAt0TPs = await (
    await ethers.getContractFactory('contracts/MockClaimPercentagesProviderAt0TPs.sol:MockClaimPercentagesProvider')
  ).deploy().then(c => c.waitForDeployment().then(() => c))

  const providerAt3TPs = await (
    await ethers.getContractFactory('contracts/MockClaimPercentagesProviderAt75.sol:MockClaimPercentagesProvider')
  ).deploy().then(c => c.waitForDeployment().then(() => c))

  const providerAt6TPs = await (
    await ethers.getContractFactory('contracts/MockClaimPercentagesProviderWith6TPs.sol:MockClaimPercentagesProviderWith6TPs')
  ).deploy().then(c => c.waitForDeployment().then(() => c))

  // Standard 20/20/20×3 provider — used for USDC path (matches existing USDC tests)
  const providerStandard = await (
    await ethers.getContractFactory('contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider')
  ).deploy().then(c => c.waitForDeployment().then(() => c))

  console.log('   ✅ All 4 mock claim providers deployed')
  console.log(`      0-TP  provider: ${await providerAt0TPs.getAddress()}`)
  console.log(`      3-TP  provider: ${await providerAt3TPs.getAddress()} (50% viewer)`)
  console.log(`      6-TP  provider: ${await providerAt6TPs.getAddress()} (20% viewer)`)
  console.log(`      std   provider: ${await providerStandard.getAddress()} (20% viewer)`)

  return {
    diamondAddress,
    govFacet, tokenFacet, affiliatesFacet, affiliateVote,
    advertisersFacet, advertVote, polFactory, usdcFactory,
    usdcPriceFacet, payoutFacet,
    mockUSDC, mockPriceFeed,
    owner, advertiser, affiliate, viewer,
    voter1, voter2, voter3,
    signingWallet,
    finalQuotas,
    providers: {
      p0TP:       providerAt0TPs,
      p3TP:       providerAt3TPs,
      p6TP:       providerAt6TPs,
      pStandard:  providerStandard,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER – FULL POL SCENARIO RUNNER
// Called by every POL processReward test with a different TP configuration.
// ─────────────────────────────────────────────────────────────────────────────

async function runPOLScenario({
  label,
  sigCount,
  tpCount,
  dedup,
  provider,       // mock claim provider contract
  bountyPOLWei,
  gasBudgetPerSig,
  fixture,
}) {
  const {
    diamondAddress, polFactory, advertVote, affiliatesFacet, affiliateVote,
    affiliate, advertiser, viewer, voter1, voter2, voter3, signingWallet,
  } = fixture

  const claimProviderAddr = await provider.getAddress()
  const affiliateLabel    = `${label}-aff`
  const advertLabel       = `${label}-adv`

  // ── 1. Create & approve affiliate ───────────────────────────────────────
  await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
    affiliate.address,
    claimProviderAddr,
    signingWallet.address,
    affiliateLabel,
    ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
  await advanceBlocks(15)
  await affiliateVote.connect(voter1).voteOnAffiliate(affiliate.address, true)
  await affiliateVote.connect(voter2).voteOnAffiliate(affiliate.address, true)
  await affiliateVote.connect(voter3).voteOnAffiliate(affiliate.address, true)

  const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
  const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

  // ── 2. Create & approve POL advert ──────────────────────────────────────
  const fundingAmount = ethers.parseEther('3000')
  const createTx      = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
    advertLabel,
    bountyPOLWei,
    1,
    designatedAffiliateAddress,
    ...(await gate.pol(_gateSigner, _gateDiamond, advertiser.address)),
    { value: fundingAmount }
  )
  const createReceipt = await createTx.wait()
  const createEvent   = createReceipt.logs.find(log => {
    try { return polFactory.interface.parseLog(log).name === 'POLAdvertisementCreatedAndValidated' }
    catch (_) { return false }
  })
  const advertAddr = polFactory.interface.parseLog(createEvent).args.advertContract
  const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', advertAddr)

  await advanceBlocks(15)
  await advertVote.connect(voter1).voteOnAdvert(advertAddr, true)
  await advertVote.connect(voter2).voteOnAdvert(advertAddr, true)
  await advertVote.connect(voter3).voteOnAdvert(advertAddr, true)

  // ── 3. Build TP matrix & signatures ─────────────────────────────────────
  // Mine sigCount+50 blocks so that createSignaturesBatch always has enough
  // historical blocks available (curBlock - sigCount must be positive).
  await mine(sigCount + 50)
  const nonce    = await polContract.getUserNonceOfAffiliate(designatedAffiliateAddress)
  const curBlock = await ethers.provider.getBlockNumber()
  const tpMatrix = buildTPMatrix(sigCount, tpCount, dedup)

  const verificationData = {
    affiliateReceivingAddress:    designatedAffiliateAddress,
    affiliateClaimInfoAddress:    claimProviderAddr,
    affiliateSigningAddress:      signingWallet.address,
    advertismentContractAddress:  advertAddr,
    nonce:                        Number(nonce),
    viewerAddress:                viewer.address,
  }

  const chainId = (await ethers.provider.getNetwork()).chainId
  const { signatures, blockNumbers } = await createSignaturesBatch(
    chainId, _gateDiamond, signingWallet, verificationData, tpMatrix, curBlock, bountyPOLWei
  )

  // ── 4. Execute processReward ─────────────────────────────────────────────
  const tx      = await polContract.connect(viewer).processReward(signatures, blockNumbers, verificationData, tpMatrix)
  const receipt = await tx.wait()

  // ── 5. Analyse & assert ───────────────────────────────────────────────────
  const gasUsed   = receipt.gasUsed
  const gasPerSig = gasUsed / BigInt(sigCount)

  expect(gasPerSig).to.be.lessThan(
    BigInt(gasBudgetPerSig),
    `REGRESSION: ${label} gas/sig ${gasPerSig} exceeds budget ${gasBudgetPerSig}`
  )

  return { gasUsed, gasPerSig }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 – TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe('Business Case V2 — Gas Costs, Profitability & Lifecycle Accounting', function () {

  // ── after() hook – consolidated matrix output & JSON write ───────────────
  // Defined first so Mocha registers it before any tests run.
  after(function () {
    if (RESULTS.length === 0) {
      console.log('\n⚠️  No BCv2 results collected — did tests pass?')
      return
    }

    const SEP = '─'.repeat(115)
    console.log('\n\n' + '═'.repeat(115))
    console.log('  BCv2 CONSOLIDATED RESULTS MATRIX')
    console.log('═'.repeat(115))

    // ── Per-scenario gas summary ─────────────────────────────────────────
    console.log('\n' + SEP)
    console.log(
      pad('Scenario', 22) + ' ' +
      pad('Sigs', 5, true) + ' ' +
      pad('TPs', 3, true) + ' ' +
      pad('Ded', 3) + ' ' +
      pad('Total Gas', 13, true) + ' ' +
      pad('Gas/sig', 10, true) + ' ' +
      pad('≤30M?', 7) + ' ' +
      pad('Currency', 8) + ' ' +
      pad('Bounty/sig', 11, true)
    )
    console.log(SEP)

    for (const r of RESULTS) {
      if (r.type !== 'processReward') continue
      const gasUsedBN = r.gasUsed != null ? BigInt(r.gasUsed) : null
      const gasPerSigBN = r.gasPerSig != null ? BigInt(r.gasPerSig) : null
      const withinLimit = gasUsedBN !== null && gasUsedBN <= 30_000_000n
      console.log(
        pad(r.label || r.scenario, 22) + ' ' +
        pad(r.sigCount, 5, true) + ' ' +
        pad(r.tpCount, 3, true) + ' ' +
        pad(r.dedup ? '✓' : ' ', 3) + ' ' +
        pad(gasUsedBN !== null ? fmtGas(gasUsedBN) : '> CEILING', 13, true) + ' ' +
        pad(gasPerSigBN !== null ? fmtGas(gasPerSigBN) : '—', 10, true) + ' ' +
        pad(gasUsedBN === null ? '⛔' : withinLimit ? '✅' : '⚠️', 7) + ' ' +
        pad(r.currency || 'POL', 8) + ' ' +
        pad(r.bountyUSD ? fmtUSD(r.bountyUSD) : '—', 11, true)
      )
    }
    console.log(SEP)

    // ── Profitability matrix (Scenario A equivalent: 20 sigs, 3-TP unique) ─
    const refPOL = RESULTS.find(r => r.label === 'BCv2-POL-3U-20' && r.type === 'processReward')
    if (refPOL) {
      console.log('\n┌─ PROFITABILITY MATRIX (ref: BCv2-POL-3U-20 | 20sigs × 3-TP-unique) ─')
      console.log(`│  Gas/sig: ${Number(refPOL.gasPerSig).toLocaleString()}  |  Commission: ${CONFIG.openAdvertsCommissionPct}% deducted from gross`)
      console.log('│')
      console.log('│  ' + pad('POL $', 7) + pad('Gwei', 6, true) + pad('Gas cost/sig', 15, true) +
                  pad('Net bounty (GDN)', 18, true) + pad('Breakeven %', 13, true) + '  Verdict')
      console.log('│  ' + '─'.repeat(75))

      for (const { polUSD, gwei, gasCostUSD, netBountyUSD, breakevenPct } of
           calculateNetBreakeven(CONFIG.bountyLevelsPOL[0].usdAt025, refPOL.gasPerSig)) {
        const verdict = breakevenPct < 20
          ? '✅ profitable at any claim %'
          : breakevenPct < 100
          ? `⚠️  need >${breakevenPct.toFixed(1)}% viewer claim`
          : '❌ unviable at this gas/price'
        console.log('│  ' +
          pad(`$${polUSD.toFixed(2)}`, 7) +
          pad(`${gwei}`, 6, true) +
          pad(fmtUSD(gasCostUSD), 15, true) +
          pad(fmtUSD(netBountyUSD), 18, true) +
          pad(breakevenPct === Infinity ? 'N/A' : `${breakevenPct.toFixed(2)}%`, 13, true) +
          `  ${verdict}`
        )
      }
      console.log('└' + '─'.repeat(88))
    }

    // ── POL vs USDC gas comparison ──────────────────────────────────────────
    const polRef  = RESULTS.find(r => r.label === 'BCv2-POL-3U-20'  && r.type === 'processReward')
    const usdcRef = RESULTS.find(r => r.label === 'BCv2-USDC-3U-20' && r.type === 'processReward')
    if (polRef && usdcRef) {
      const delta    = BigInt(usdcRef.gasPerSig) - BigInt(polRef.gasPerSig)
      const deltaSign = delta >= 0n ? '+' : ''
      console.log('\n┌─ POL vs USDC GAS COMPARISON (20 sigs × 3-TP-unique) ──────────')
      console.log(`│  POL   processReward: ${Number(polRef.gasPerSig).toLocaleString().padStart(10)} gas/sig`)
      console.log(`│  USDC  processReward: ${Number(usdcRef.gasPerSig).toLocaleString().padStart(10)} gas/sig`)
      console.log(`│  Delta (USDC - POL):  ${(deltaSign + delta.toString()).padStart(10)} gas/sig`)
      console.log('└' + '─'.repeat(65))
    }

    // ── Lifecycle cost summary ────────────────────────────────────────────
    const lifecycle = RESULTS.filter(r => r.type === 'lifecycle')
    if (lifecycle.length > 0) {
      console.log('\n┌─ LIFECYCLE GAS (one-time setup costs per campaign) ───────────')
      for (const l of lifecycle) {
        console.log(`│  ${pad(l.label, 40)} ${fmtGas(BigInt(l.gasUsed)).padStart(12)} gas`)
      }
      const totalSetup = lifecycle.reduce((s, l) => s + BigInt(l.gasUsed), 0n)
      console.log(`│  ${'─'.repeat(57)}`)
      console.log(`│  ${'Total setup gas'.padEnd(40)} ${fmtGas(totalSetup).padStart(12)} gas`)
      // Amortised over 20/50/200 sigs
      if (polRef) {
        const perSigReward = BigInt(polRef.gasPerSig)
        for (const n of [20, 50, 200]) {
          const totalGas = totalSetup + perSigReward * BigInt(n)
          console.log(`│  Total incl ${n} reward sigs:              ${fmtGas(totalGas).padStart(12)} gas`)
        }
      }
      console.log('└' + '─'.repeat(65))
    }

    // ── Reward-per-impression floor (today's environment) ──────────────────
    const floorProfiles = [
      { label: '0-TP floor',  gasPerSig: RESULTS.find(r => r.label === 'BCv2-POL-0TP-20')?.gasPerSig },
      { label: '3-TP unique', gasPerSig: RESULTS.find(r => r.label === 'BCv2-POL-3U-20')?.gasPerSig },
    ].filter(p => p.gasPerSig != null)
    if (floorProfiles.length > 0) {
      console.log('\n\n' + '═'.repeat(115))
      console.log('  REWARD-PER-IMPRESSION FLOOR — POL price × gas price × viewer share (TODAY: POL≈$0.08, gas 100–500 gwei)')
      console.log('═'.repeat(115))
      printRewardPerImpressionFloor(floorProfiles)
    }

    console.log('\n📄 Results written to: ' + path.relative(process.cwd(), CONFIG.outputFile))
    console.log('   Run: node test/GasBenchmark/generateReport.js  →  bcv2Report.html\n')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // BCv2-LIFECYCLE – Setup cost measurement (todo items 4.1, 4.2, 4.3)
  // ───────────────────────────────────────────────────────────────────────────
  describe('BCv2-LIFECYCLE: Setup Cost Amortisation', function () {

    it('BCv2-LIFECYCLE-1: Should measure gas for affiliate creation', async function () {
      const { diamondAddress, affiliatesFacet, providers, affiliate, signingWallet } =
        await loadFixture(deployBCv2Fixture)

      const claimAddr = await providers.p3TP.getAddress()
      const tx        = await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
        affiliate.address,
        claimAddr,
        signingWallet.address,
        'lifecycle-affiliate',
        ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
      const receipt = await tx.wait()
      const gasUsed = receipt.gasUsed

      console.log(`\n📋 BCv2-LIFECYCLE-1: createProspectAffiliateContract`)
      console.log(`   Gas: ${gasUsed.toLocaleString()}`)

      const rec = recordScenario({
        type: 'lifecycle', label: 'createProspectAffiliateContract',
        gasUsed, gasPerSig: gasUsed, sigCount: 1,
      })
      RESULTS.push({ ...rec, type: 'lifecycle', label: 'createProspectAffiliateContract', gasUsed })
    })

    it('BCv2-LIFECYCLE-2: Should measure gas for governance votes on affiliate', async function () {
      const { affiliatesFacet, affiliateVote, providers, affiliate, signingWallet, voter1, voter2, voter3 } =
        await loadFixture(deployBCv2Fixture)

      const claimAddr = await providers.p3TP.getAddress()
      await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
        affiliate.address, claimAddr, signingWallet.address, 'lc-aff-2',
        ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
      await advanceBlocks(15)

      const v1tx = await affiliateVote.connect(voter1).voteOnAffiliate(affiliate.address, true)
      const v2tx = await affiliateVote.connect(voter2).voteOnAffiliate(affiliate.address, true)
      const v3tx = await affiliateVote.connect(voter3).voteOnAffiliate(affiliate.address, true)
      const [r1, r2, r3] = await Promise.all([v1tx.wait(), v2tx.wait(), v3tx.wait()])
      const totalVoteGas = r1.gasUsed + r2.gasUsed + r3.gasUsed

      console.log(`\n📋 BCv2-LIFECYCLE-2: 3× voteOnAffiliate`)
      console.log(`   Gas total: ${totalVoteGas.toLocaleString()}  (avg/voter: ${(totalVoteGas / 3n).toLocaleString()})`)

      const rec = recordScenario({
        type: 'lifecycle', label: '3x_voteOnAffiliate (governance cost)',
        gasUsed: totalVoteGas, gasPerSig: totalVoteGas / 3n, sigCount: 3,
      })
      RESULTS.push({ ...rec, type: 'lifecycle', label: '3x_voteOnAffiliate_total', gasUsed: totalVoteGas })
    })

    it('BCv2-LIFECYCLE-3: Should measure gas for POL advert creation', async function () {
      const { polFactory, advertiser } = await loadFixture(deployBCv2Fixture)
      const bounty = CONFIG.bountyLevelsPOL[0].polWei // 0.01 POL

      const tx      = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
        'lifecycle-advert', bounty, 1, ethers.ZeroAddress, ...(await gate.pol(_gateSigner, _gateDiamond, advertiser.address)), { value: ethers.parseEther('3000') }
      )
      const receipt = await tx.wait()
      const gasUsed = receipt.gasUsed

      console.log(`\n📋 BCv2-LIFECYCLE-3: createNewProspectPOLAdvertContract`)
      console.log(`   Gas: ${gasUsed.toLocaleString()}`)

      const rec = recordScenario({
        type: 'lifecycle', label: 'createNewProspectPOLAdvertContract',
        gasUsed, gasPerSig: gasUsed, sigCount: 1,
      })
      RESULTS.push({ ...rec, type: 'lifecycle', label: 'createNewProspectPOLAdvertContract', gasUsed })
    })

    it('BCv2-LIFECYCLE-4: Should measure gas for governance votes on advert', async function () {
      const { polFactory, advertVote, advertiser, voter1, voter2, voter3 } =
        await loadFixture(deployBCv2Fixture)
      const bounty = CONFIG.bountyLevelsPOL[0].polWei

      const createTx   = await polFactory.connect(advertiser).createNewProspectPOLAdvertContract(
        'lc-adv-4', bounty, 1, ethers.ZeroAddress, ...(await gate.pol(_gateSigner, _gateDiamond, advertiser.address)), { value: ethers.parseEther('3000') }
      )
      const createReceipt = await createTx.wait()
      const createEvent   = createReceipt.logs.find(log => {
        try { return polFactory.interface.parseLog(log).name === 'POLAdvertisementCreatedAndValidated' }
        catch (_) { return false }
      })
      const advertAddr = polFactory.interface.parseLog(createEvent).args.advertContract
      await advanceBlocks(15)

      const v1tx = await advertVote.connect(voter1).voteOnAdvert(advertAddr, true)
      const v2tx = await advertVote.connect(voter2).voteOnAdvert(advertAddr, true)
      const v3tx = await advertVote.connect(voter3).voteOnAdvert(advertAddr, true)
      const [r1, r2, r3] = await Promise.all([v1tx.wait(), v2tx.wait(), v3tx.wait()])
      const totalVoteGas = r1.gasUsed + r2.gasUsed + r3.gasUsed

      console.log(`\n📋 BCv2-LIFECYCLE-4: 3× voteOnAdvert`)
      console.log(`   Gas total: ${totalVoteGas.toLocaleString()}`)

      const rec = recordScenario({
        type: 'lifecycle', label: '3x_voteOnAdvert (governance cost)',
        gasUsed: totalVoteGas, gasPerSig: totalVoteGas / 3n, sigCount: 3,
      })
      RESULTS.push({ ...rec, type: 'lifecycle', label: '3x_voteOnAdvert_total', gasUsed: totalVoteGas })
    })

  }) // BCv2-LIFECYCLE

  // ───────────────────────────────────────────────────────────────────────────
  // BCv2-POL – processReward on POL advert across TP configurations
  // ───────────────────────────────────────────────────────────────────────────
  describe('BCv2-POL: processReward — POL Advert Scenarios', function () {

    const BOUNTY = CONFIG.bountyLevelsPOL[0]  // reference bounty for all POL scenarios

    // ── 0-TP (Gas floor) ──────────────────────────────────────────────────
    it('BCv2-POL-0TP-20: 20 sigs × 0 TPs — gas floor baseline', async function () {
      const fixture = await loadFixture(deployBCv2Fixture)
      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-0TP-20', sigCount: 20, tpCount: 0, dedup: false,
        provider: fixture.providers.p0TP, bountyPOLWei: BOUNTY.polWei,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_0TP, fixture,
      })

      console.log(`\n📊 BCv2-POL-0TP-20 | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-0TP-20', currency: 'POL',
        scenario: '0-TP', sigCount: 20, tpCount: 0, dedup: false,
        gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 0-TP at governance minimum POL bounty ─────────────────────────────
    it('BCv2-POL-0TP-MIN: 20 sigs × 0 TPs at governance minAdvertBountyInPOLWei', async function () {
      const fixture         = await loadFixture(deployBCv2Fixture)
      const minBountyPOL    = fixture.finalQuotas.minAdvertBountyInPOLWei
      const polFormatted    = ethers.formatEther(minBountyPOL)
      const bountyUSD       = Number(polFormatted) * 0.25
      console.log(`\n📋 BCv2-POL-0TP-MIN: minAdvertBountyInPOLWei = ${polFormatted} POL ($${bountyUSD.toFixed(6)} @ $0.25)`)

      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-0TP-MIN', sigCount: 20, tpCount: 0, dedup: false,
        provider: fixture.providers.p0TP, bountyPOLWei: minBountyPOL,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_0TP, fixture,
      })

      console.log(`\n📊 BCv2-POL-0TP-MIN | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)
      console.log(`   Min bounty at $0.25/POL → $${bountyUSD.toFixed(6)} USD`)
      for (const polUSD of CONFIG.polPricesUSD) {
        for (const gwei of [30, 100]) {
          const gasCostUSD   = Number(gasPerSig) * gwei * 1e-9 * polUSD
          const viewerRevUSD = bountyUSD * polUSD / 0.25 * 0.80  // 80% viewer at 0-TP, adjust for POL price
          const profitUSD    = viewerRevUSD - gasCostUSD
          console.log(`     $${polUSD.toFixed(2)}/POL @${String(gwei).padStart(4)}gwei: gas=$${gasCostUSD.toFixed(6)}  viewer=$${viewerRevUSD.toFixed(6)}  profit=$${profitUSD.toFixed(6)}  ${profitUSD > 0 ? '✅' : '❌'}`)
        }
      }

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-0TP-MIN', currency: 'POL',
        scenario: '0-TP-min-bounty', sigCount: 20, tpCount: 0, dedup: false,
        gasUsed, gasPerSig, bountyUSD,
        metadata: { minBountyPOLWei: minBountyPOL.toString() },
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 3-TP unique (all-unique addresses per sig — worst-case dedup path) ─
    it('BCv2-POL-3U-20: 20 sigs × 3-TP unique — primary reference scenario', async function () {
      const fixture = await loadFixture(deployBCv2Fixture)
      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-3U-20', sigCount: 20, tpCount: 3, dedup: false,
        provider: fixture.providers.p3TP, bountyPOLWei: BOUNTY.polWei,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_3TP_uniq, fixture,
      })

      console.log(`\n📊 BCv2-POL-3U-20  | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)
      printBreakevenTable('BCv2-POL-3U-20', gasPerSig, BOUNTY.usdAt025)

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-3U-20', currency: 'POL',
        scenario: '3-TP-unique', sigCount: 20, tpCount: 3, dedup: false,
        gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 3-TP deduped (shared TPs — best-case dedup path) ─────────────────
    it('BCv2-POL-3D-20: 20 sigs × 3-TP deduped — deduplication path', async function () {
      const fixture = await loadFixture(deployBCv2Fixture)
      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-3D-20', sigCount: 20, tpCount: 3, dedup: true,
        provider: fixture.providers.p3TP, bountyPOLWei: BOUNTY.polWei,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_3TP_dedup, fixture,
      })

      console.log(`\n📊 BCv2-POL-3D-20  | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-3D-20', currency: 'POL',
        scenario: '3-TP-deduped', sigCount: 20, tpCount: 3, dedup: true,
        gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 6-TP unique (max TP count per sig) ───────────────────────────────
    it('BCv2-POL-6U-20: 20 sigs × 6-TP unique — maximum TP count scenario', async function () {
      const fixture = await loadFixture(deployBCv2Fixture)
      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-6U-20', sigCount: 20, tpCount: 6, dedup: false,
        provider: fixture.providers.p6TP, bountyPOLWei: BOUNTY.polWei,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_6TP_uniq, fixture,
      })

      console.log(`\n📊 BCv2-POL-6U-20  | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-6U-20', currency: 'POL',
        scenario: '6-TP-unique', sigCount: 20, tpCount: 6, dedup: false,
        gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 3-TP unique at scale (50 sigs) ────────────────────────────────────
    it('BCv2-POL-3U-50: 50 sigs × 3-TP unique — scaling test', async function () {
      const fixture = await loadFixture(deployBCv2Fixture)
      const { gasUsed, gasPerSig } = await runPOLScenario({
        label: 'BCv2-POL-3U-50', sigCount: 50, tpCount: 3, dedup: false,
        provider: fixture.providers.p3TP, bountyPOLWei: BOUNTY.polWei,
        gasBudgetPerSig: CONFIG.gasBudgets.perSig_3TP_uniq, fixture,
      })

      console.log(`\n📊 BCv2-POL-3U-50  | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-POL-3U-50', currency: 'POL',
        scenario: '3-TP-unique-50', sigCount: 50, tpCount: 3, dedup: false,
        gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── maxSignaturesPerBatch (governance ceiling) ────────────────────────
    it('BCv2-POL-3U-MAX: maxSignaturesPerBatch sigs × 3-TP unique — governance ceiling', async function () {
      const fixture      = await loadFixture(deployBCv2Fixture)
      const maxBatch     = Number(fixture.finalQuotas.maxSignaturesPerBatch)

      console.log(`\n📋 maxSignaturesPerBatch = ${maxBatch} (read from governance)`)
      console.log(`   Estimated gas at 185k/sig: ~${(maxBatch * 185_000).toLocaleString()} gas`)
      console.log(`   Polygon 30M block limit: ${maxBatch * 185_000 > 30_000_000 ? '⚠️  LIKELY EXCEEDS' : '✅ likely within'}`)

      let gasUsed   = 0n
      let gasPerSig = 0n
      let exceeded  = false

      try {
        // Use the shared runPOLScenario helper — gasBudget is set high (informational only).
        // If the EVM cannot fit all sigs in one block, this will throw; we catch and report.
        const result = await runPOLScenario({
          label: 'BCv2-POL-3U-MAX', sigCount: maxBatch, tpCount: 3, dedup: false,
          provider: fixture.providers.p3TP, bountyPOLWei: BOUNTY.polWei,
          gasBudgetPerSig: Number.MAX_SAFE_INTEGER,  // ← no budget cap; we only report
          fixture,
        })
        gasUsed   = result.gasUsed
        gasPerSig = result.gasPerSig
      } catch (e) {
        const msg = e.message || ''
        if (msg.includes('out of gas') || msg.includes('ran out of gas') || msg.includes('gas')) {
          exceeded = true
          console.log(`\n⚠️  BCv2-POL-3U-MAX: processReward(${maxBatch} sigs, 3-TP-unique) EXCEEDS block gas ceiling`)
          console.log(`   est. total ≈ ${maxBatch} × 175,000 = ${(maxBatch * 175_000).toLocaleString()} gas`)
          console.log(`   GOVERNANCE ACTION: reduce maxSignaturesPerBatch to ≤${Math.floor(30_000_000 / 175_000)} for 30M ceiling`)
        } else {
          throw e  // re-throw unexpected errors
        }
      }

      if (!exceeded) {
        console.log(`\n📊 BCv2-POL-3U-MAX (${maxBatch} sigs) | Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)
        const exceedsPolygon = gasUsed > 30_000_000n
        console.log(`   Polygon 30M limit: ${exceedsPolygon ? '⚠️  EXCEEDS' : '✅ within'}`)

        const rec = recordScenario({
          type: 'processReward', label: 'BCv2-POL-3U-MAX', currency: 'POL',
          scenario: `3-TP-unique-${maxBatch}`, sigCount: maxBatch, tpCount: 3, dedup: false,
          gasUsed, gasPerSig, bountyUSD: BOUNTY.usdAt025,
          metadata: { exceedsPolygon30M: exceedsPolygon },
        })
        RESULTS.push(rec)
      } else {
        // Still record the scenario as informational even though tx failed
        const rec = recordScenario({
          type: 'processReward', label: 'BCv2-POL-3U-MAX', currency: 'POL',
          scenario: `3-TP-unique-${maxBatch}`, sigCount: maxBatch, tpCount: 3, dedup: false,
          gasUsed: null, gasPerSig: null, bountyUSD: BOUNTY.usdAt025,
          metadata: { exceededBlockGasCeiling: true, estGas: maxBatch * 175_000 },
        })
        RESULTS.push(rec)
      }
    }).timeout(600_000)

  }) // BCv2-POL

  // ───────────────────────────────────────────────────────────────────────────
  // BCv2-USDC – processReward on USDC advert (todo items 5.1 – 5.3)
  // ───────────────────────────────────────────────────────────────────────────
  describe('BCv2-USDC: processReward — USDC Advert Scenarios', function () {

    it('BCv2-USDC-3U-20: 20 sigs × 3-TP unique on USDC advert', async function () {
      const {
        diamondAddress, usdcFactory, usdcPriceFacet, advertVote,
        affiliatesFacet, affiliateVote, govFacet,
        affiliate, advertiser, viewer,
        voter1, voter2, voter3,
        signingWallet, mockUSDC, providers,
        finalQuotas,
      } = await loadFixture(deployBCv2Fixture)

      const SIG_COUNT  = 20
      const TP_COUNT   = 3
      const claimAddr  = await providers.pStandard.getAddress()

      // Derive minimum bounty and funding from the live mock oracle ($0.25/POL gov defaults).
      // The governance defaults (minPOLRequiredforAdvertInWei=200 POL, USDCPremium=50%) translate
      // to minFundingUSDC ≈ $150.  CONFIG.usdcFundingMicro ($5) is too low — use oracle-derived values.
      const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
        finalQuotas.minAdvertBountyInPOLWei,
        finalQuotas.minPOLRequiredforAdvertInWei,
        finalQuotas.USDCCurrencyPremiumInPCT
      )
      // Use 10× min bounty ($0.0375 → $0.375) so economics are clearly visible,
      // and 2× min funding ($150 → $300) to comfortably cover the governance floor.
      const bountyMicro  = minBountyUSDC * 10n
      const batchCost    = bountyMicro * BigInt(SIG_COUNT)
      const fundingMicro = (minFundingUSDC > batchCost ? minFundingUSDC : batchCost) * 2n

      console.log(`\n📋 BCv2-USDC-3U-20  minBountyUSDC=${minBountyUSDC} minFundingUSDC=${minFundingUSDC}`)
      console.log(`   bountyMicro=${bountyMicro} ($${(Number(bountyMicro)/1e6).toFixed(4)})  fundingMicro=${fundingMicro} ($${(Number(fundingMicro)/1e6).toFixed(2)})`)

      // ── 1. Create & approve affiliate ──────────────────────────────────
      const affiliateTx = await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
        affiliate.address, claimAddr, signingWallet.address,
        'usdc-bcv2-aff',
        ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
      await affiliateTx.wait()
      await advanceBlocks(15)
      await affiliateVote.connect(voter1).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter2).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter3).voteOnAffiliate(affiliate.address, true)

      const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
      const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

      // ── 2. Approve USDC spend & create USDC advert ─────────────────────
      await mockUSDC.connect(advertiser).approve(diamondAddress, fundingMicro)

      const createTx    = await usdcFactory.connect(advertiser).createNewProspectUSDCAdvertContract(
        'usdc-bcv2-adv', bountyMicro, 1, designatedAffiliateAddress, fundingMicro,
        ...(await gate.usdc(_gateSigner, _gateDiamond, advertiser.address)))
      const createReceipt = await createTx.wait()

      const createEvent = createReceipt.logs.find(log => {
        try { return usdcFactory.interface.parseLog(log).name === 'USDCAdvertCreated' }
        catch (_) { return false }
      })
      const usdcAdvertAddr = usdcFactory.interface.parseLog(createEvent).args.advert
      const usdcContract   = await ethers.getContractAt('OpenAdvertsAdvertUSDC', usdcAdvertAddr)

      await advanceBlocks(15)
      await advertVote.connect(voter1).voteOnAdvert(usdcAdvertAddr, true)
      await advertVote.connect(voter2).voteOnAdvert(usdcAdvertAddr, true)
      await advertVote.connect(voter3).voteOnAdvert(usdcAdvertAddr, true)

      // ── 3. Build TP matrix & signatures ────────────────────────────────
      const nonce    = await usdcContract.getUserNonceOfAffiliate(designatedAffiliateAddress)
      const curBlock = await ethers.provider.getBlockNumber()
      const tpMatrix = buildTPMatrix(SIG_COUNT, TP_COUNT, false)

      const verificationData = {
        affiliateReceivingAddress:    designatedAffiliateAddress,
        affiliateClaimInfoAddress:    claimAddr,
        affiliateSigningAddress:      signingWallet.address,
        advertismentContractAddress:  usdcAdvertAddr,
        nonce:                        Number(nonce),
        viewerAddress:                viewer.address,
      }

      const chainId = (await ethers.provider.getNetwork()).chainId
      const { signatures, blockNumbers } = await createSignaturesBatch(
        chainId, _gateDiamond, signingWallet, verificationData, tpMatrix, curBlock, bountyMicro
      )

      // ── 4. Execute processReward ────────────────────────────────────────
      const tx      = await usdcContract.connect(viewer).processReward(signatures, blockNumbers, verificationData, tpMatrix)
      const receipt = await tx.wait()

      const gasUsed   = receipt.gasUsed
      const gasPerSig = gasUsed / BigInt(SIG_COUNT)

      // ── 5. Derive USDC economics using POL price from oracle ───────────
      const bountyUSDC = Number(bountyMicro) / 1e6            // $0.10 USDC
      const viewerPct  = 20                                    // pStandard viewer=20%
      const viewerRev  = bountyUSDC * viewerPct / 100          // $0.02
      console.log(`\n📊 BCv2-USDC-3U-20`)
      console.log(`   Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)
      console.log(`   Bounty: $${bountyUSDC.toFixed(4)} USDC | Viewer (${viewerPct}%): $${viewerRev.toFixed(6)} USDC`)

      // Gas cost still paid in POL — use CONFIG polPricesUSD for sensitivity
      console.log(`\n   Gas cost per sig @ $0.25/POL:`)
      for (const gwei of CONFIG.gasPricesGwei) {
        const gasCostUSD  = Number(gasPerSig) * gwei * 1e-9 * 0.25
        const profit      = viewerRev - gasCostUSD
        const mark        = profit > 0 ? '✅' : '❌'
        console.log(`     @${String(gwei).padStart(4)} gwei: gas=$${gasCostUSD.toFixed(6)}  profit=$${profit.toFixed(6)}  ${mark}`)
      }

      // ── 6. Assert gas budget ────────────────────────────────────────────
      expect(gasPerSig).to.be.lessThan(
        BigInt(CONFIG.gasBudgets.perSig_USDC_3TP),
        `REGRESSION: USDC gas/sig ${gasPerSig} exceeds budget ${CONFIG.gasBudgets.perSig_USDC_3TP}`
      )

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-USDC-3U-20', currency: 'USDC',
        scenario: '3-TP-unique', sigCount: SIG_COUNT, tpCount: TP_COUNT, dedup: false,
        gasUsed, gasPerSig, bountyUSD: bountyUSDC,
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── 0-TP at oracle-derived governance minimum USDC bounty ─────────────
    // Uses MockV3Aggregator — already set to $0.25/POL in the fixture.
    // calculateMinimumUSDCRequirements reads the live mock oracle; no external
    // feed is required. This test was previously deferred pending oracle clarity.
    it('BCv2-USDC-0TP-MIN: 20 sigs × 0 TPs at oracle-derived governance minimum USDC bounty', async function () {
      const {
        diamondAddress, usdcFactory, usdcPriceFacet, advertVote,
        affiliatesFacet, affiliateVote,
        affiliate, advertiser, viewer, owner,
        voter1, voter2, voter3,
        signingWallet, mockUSDC, providers,
        finalQuotas,
      } = await loadFixture(deployBCv2Fixture)

      // Query oracle-derived minimum — MockV3Aggregator IS the oracle here.
      const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
        finalQuotas.minAdvertBountyInPOLWei,
        finalQuotas.minPOLRequiredforAdvertInWei,
        finalQuotas.USDCCurrencyPremiumInPCT
      )
      console.log(`\n📋 BCv2-USDC-0TP-MIN`)
      console.log(`   Oracle POL price: $${CONFIG.mockPOLPriceChainlink / 1e8}`)
      console.log(`   minAdvertBountyInPOLWei: ${ethers.formatEther(finalQuotas.minAdvertBountyInPOLWei)} POL`)
      console.log(`   USDCCurrencyPremiumInPCT: ${finalQuotas.USDCCurrencyPremiumInPCT}%`)
      console.log(`   Derived minBountyUSDC:  ${minBountyUSDC} µUSDC = $${(Number(minBountyUSDC) / 1e6).toFixed(6)}`)
      console.log(`   Derived minFundingUSDC: ${minFundingUSDC} µUSDC = $${(Number(minFundingUSDC) / 1e6).toFixed(4)}`)

      const SIG_COUNT  = 20
      const TP_COUNT   = 0
      const claimAddr  = await providers.p0TP.getAddress()

      // Funding must cover at least: protocol minimum AND full batch cost
      const batchCost    = minBountyUSDC * BigInt(SIG_COUNT)
      const fundingMicro = (minFundingUSDC > batchCost ? minFundingUSDC : batchCost) * 10n

      // Top up advertiser USDC if needed
      const advBalance = await mockUSDC.balanceOf(advertiser.address)
      if (advBalance < fundingMicro) {
        await mockUSDC.connect(owner).mint(advertiser.address, fundingMicro)
      }

      // Create & approve affiliate (0-TP provider)
      await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
        affiliate.address, claimAddr, signingWallet.address,
        'usdc-0tp-min-aff',
        ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
      await advanceBlocks(15)
      await affiliateVote.connect(voter1).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter2).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter3).voteOnAffiliate(affiliate.address, true)

      const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
      const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

      // Approve & create USDC advert at exactly the oracle-derived minimum bounty
      await mockUSDC.connect(advertiser).approve(diamondAddress, fundingMicro)
      const createTx = await usdcFactory.connect(advertiser).createNewProspectUSDCAdvertContract(
        'usdc-0tp-min-adv', minBountyUSDC, 1, designatedAffiliateAddress, fundingMicro,
        ...(await gate.usdc(_gateSigner, _gateDiamond, advertiser.address)))
      const createReceipt = await createTx.wait()
      const createEvent   = createReceipt.logs.find(log => {
        try { return usdcFactory.interface.parseLog(log).name === 'USDCAdvertCreated' }
        catch (_) { return false }
      })
      const usdcAdvertAddr = usdcFactory.interface.parseLog(createEvent).args.advert
      const usdcContract   = await ethers.getContractAt('OpenAdvertsAdvertUSDC', usdcAdvertAddr)

      await advanceBlocks(15)
      await advertVote.connect(voter1).voteOnAdvert(usdcAdvertAddr, true)
      await advertVote.connect(voter2).voteOnAdvert(usdcAdvertAddr, true)
      await advertVote.connect(voter3).voteOnAdvert(usdcAdvertAddr, true)

      // Build 0-TP signatures
      const nonce    = await usdcContract.getUserNonceOfAffiliate(designatedAffiliateAddress)
      const curBlock = await ethers.provider.getBlockNumber()
      const tpMatrix = buildTPMatrix(SIG_COUNT, TP_COUNT, false)

      const verificationData = {
        affiliateReceivingAddress:    designatedAffiliateAddress,
        affiliateClaimInfoAddress:    claimAddr,
        affiliateSigningAddress:      signingWallet.address,
        advertismentContractAddress:  usdcAdvertAddr,
        nonce:                        Number(nonce),
        viewerAddress:                viewer.address,
      }

      const chainId = (await ethers.provider.getNetwork()).chainId
      const { signatures, blockNumbers } = await createSignaturesBatch(
        chainId, _gateDiamond, signingWallet, verificationData, tpMatrix, curBlock, minBountyUSDC
      )

      const tx      = await usdcContract.connect(viewer).processReward(signatures, blockNumbers, verificationData, tpMatrix)
      const receipt = await tx.wait()
      const gasUsed   = receipt.gasUsed
      const gasPerSig = gasUsed / BigInt(SIG_COUNT)

      expect(gasPerSig).to.be.lessThan(
        BigInt(CONFIG.gasBudgets.perSig_USDC_0TP),
        `REGRESSION: USDC 0-TP gas/sig ${gasPerSig} exceeds budget ${CONFIG.gasBudgets.perSig_USDC_0TP}`
      )

      const bountyUSDC = Number(minBountyUSDC) / 1e6
      const viewerPct  = 80  // p0TP: affiliate=20%, viewer=80%
      const viewerRev  = bountyUSDC * viewerPct / 100
      console.log(`\n📊 BCv2-USDC-0TP-MIN`)
      console.log(`   Gas: ${gasUsed.toLocaleString()} | /sig: ${gasPerSig.toLocaleString()}`)
      console.log(`   Bounty: $${bountyUSDC.toFixed(6)} USDC (governance floor) | Viewer (${viewerPct}%): $${viewerRev.toFixed(6)}`)
      console.log(`   Gas economics @ $0.25/POL:`)
      for (const gwei of CONFIG.gasPricesGwei) {
        const gasCostUSD = Number(gasPerSig) * gwei * 1e-9 * 0.25
        const profit     = viewerRev - gasCostUSD
        console.log(`     @${String(gwei).padStart(4)} gwei: gas=$${gasCostUSD.toFixed(6)}  profit=$${profit.toFixed(6)}  ${profit > 0 ? '✅' : '❌'}`)
      }

      const rec = recordScenario({
        type: 'processReward', label: 'BCv2-USDC-0TP-MIN', currency: 'USDC',
        scenario: '0-TP-min-bounty', sigCount: SIG_COUNT, tpCount: TP_COUNT, dedup: false,
        gasUsed, gasPerSig, bountyUSD: bountyUSDC,
        metadata: { minBountyMicroUSDC: minBountyUSDC.toString(), oraclePricePOLUSD: CONFIG.mockPOLPriceChainlink / 1e8 },
      })
      RESULTS.push(rec)
    }).timeout(300_000)

    // ── USDC bounty sensitivity — 4 levels across full price matrix ───────
    // Defines levels as multiples of the oracle-derived governance minimum.
    // This makes the test oracle-invariant: change the MockV3Aggregator price
    // and the levels scale automatically. Gas cost (in USD) is then printed
    // for every [polPrice × gasPrice] combination in CONFIG.
    it('BCv2-USDC-SENS: 4 bounty levels × full polPrice×gasPrice sensitivity matrix', async function () {
      const {
        diamondAddress, usdcFactory, usdcPriceFacet, advertVote,
        affiliatesFacet, affiliateVote,
        affiliate, advertiser, viewer, owner,
        voter1, voter2, voter3,
        signingWallet, mockUSDC, providers,
        finalQuotas,
      } = await loadFixture(deployBCv2Fixture)

      // Derive governance minimum from live mock oracle
      const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
        finalQuotas.minAdvertBountyInPOLWei,
        finalQuotas.minPOLRequiredforAdvertInWei,
        finalQuotas.USDCCurrencyPremiumInPCT
      )
      console.log(`\n📋 BCv2-USDC-SENS — oracle min bounty: ${minBountyUSDC} µUSDC = $${(Number(minBountyUSDC)/1e6).toFixed(6)}`)

      // Four levels defined as multiples of the governance minimum.
      // Level labels are oracle-invariant; bountyMicro scales with POL price.
      const SENS_LEVELS = [
        { label: '2×min',   multiplier: 2n   },
        { label: '10×min',  multiplier: 10n  },
        { label: '50×min',  multiplier: 50n  },
        { label: '500×min', multiplier: 500n },
      ]

      const SIG_COUNT = 20
      const TP_COUNT  = 3
      const claimAddr = await providers.pStandard.getAddress()
      const viewerPct = 20  // pStandard: affiliate=20%, viewer=20%, 3×TP=20% each

      // Create & approve one affiliate — reused across all bounty levels
      await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
        affiliate.address, claimAddr, signingWallet.address,
        'usdc-sens-aff',
        ...(await gate.affiliate(_gateSigner, _gateDiamond, affiliate.address)))
      await advanceBlocks(15)
      await affiliateVote.connect(voter1).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter2).voteOnAffiliate(affiliate.address, true)
      await affiliateVote.connect(voter3).voteOnAffiliate(affiliate.address, true)

      const [affiliateDetails] = await affiliatesFacet.getAffiliateDetailsAndStatus(affiliate.address)
      const designatedAffiliateAddress = affiliateDetails.affiliateContractAddress

      const sensResults = []

      for (const level of SENS_LEVELS) {
        const bountyMicro  = minBountyUSDC * level.multiplier
        const batchCost    = bountyMicro * BigInt(SIG_COUNT)
        // Fund with generous headroom: max(protocol min, batch cost) × 4
        const fundingMicro = (minFundingUSDC > batchCost ? minFundingUSDC : batchCost) * 4n

        // Top up USDC if advertiser balance is insufficient
        const balance = await mockUSDC.balanceOf(advertiser.address)
        if (balance < fundingMicro) {
          await mockUSDC.connect(owner).mint(advertiser.address, fundingMicro)
        }

        await mockUSDC.connect(advertiser).approve(diamondAddress, fundingMicro)

        const createTx = await usdcFactory.connect(advertiser).createNewProspectUSDCAdvertContract(
          `usdc-sens-${level.label}`, bountyMicro, 1, designatedAffiliateAddress, fundingMicro,
          ...(await gate.usdc(_gateSigner, _gateDiamond, advertiser.address)))
        const createReceipt = await createTx.wait()
        const createEvent   = createReceipt.logs.find(log => {
          try { return usdcFactory.interface.parseLog(log).name === 'USDCAdvertCreated' }
          catch (_) { return false }
        })
        const usdcAdvertAddr = usdcFactory.interface.parseLog(createEvent).args.advert
        const usdcContract   = await ethers.getContractAt('OpenAdvertsAdvertUSDC', usdcAdvertAddr)

        await advanceBlocks(15)
        await advertVote.connect(voter1).voteOnAdvert(usdcAdvertAddr, true)
        await advertVote.connect(voter2).voteOnAdvert(usdcAdvertAddr, true)
        await advertVote.connect(voter3).voteOnAdvert(usdcAdvertAddr, true)

        // Re-read nonce for each advert iteration.
        // Advance past per-(viewer, advertContract, affiliateSigningAddress) cooldown
        // (maxBlockSeparationAdvertisement = 21600 blocks) so the same viewer address
        // can be reused across sensitivity-level iterations for this advert/affiliate pair.
        await mine(21601)
        const nonce    = await usdcContract.getUserNonceOfAffiliate(designatedAffiliateAddress)
        const curBlock = await ethers.provider.getBlockNumber()
        const tpMatrix = buildTPMatrix(SIG_COUNT, TP_COUNT, false)

        const verificationData = {
          affiliateReceivingAddress:    designatedAffiliateAddress,
          affiliateClaimInfoAddress:    claimAddr,
          affiliateSigningAddress:      signingWallet.address,
          advertismentContractAddress:  usdcAdvertAddr,
          nonce:                        Number(nonce),
          viewerAddress:                viewer.address,
        }

        const chainId = (await ethers.provider.getNetwork()).chainId
        const { signatures, blockNumbers } = await createSignaturesBatch(
          chainId, _gateDiamond, signingWallet, verificationData, tpMatrix, curBlock, bountyMicro
        )

        const tx      = await usdcContract.connect(viewer).processReward(signatures, blockNumbers, verificationData, tpMatrix)
        const receipt = await tx.wait()
        const gasUsed   = receipt.gasUsed
        const gasPerSig = gasUsed / BigInt(SIG_COUNT)

        expect(gasPerSig).to.be.lessThan(
          BigInt(CONFIG.gasBudgets.perSig_USDC_3TP),
          `REGRESSION: USDC-SENS-${level.label} gas/sig ${gasPerSig} exceeds budget`
        )

        sensResults.push({ level: level.label, bountyMicro, gasUsed, gasPerSig })

        const bountyUSD = Number(bountyMicro) / 1e6
        const rec = recordScenario({
          type: 'processReward', label: `BCv2-USDC-SENS-${level.label}`, currency: 'USDC',
          scenario: `3-TP-unique-sens-${level.label}`, sigCount: SIG_COUNT, tpCount: TP_COUNT, dedup: false,
          gasUsed, gasPerSig, bountyUSD,
          metadata: { multiplierOfMin: level.multiplier.toString(), minBountyMicroUSDC: minBountyUSDC.toString() },
        })
        RESULTS.push(rec)
      }

      // ── Print full sensitivity matrix ────────────────────────────────────
      const LINE = '─'.repeat(105)
      console.log('\n')
      console.log('  ┌─ BCv2-USDC-SENS — BOUNTY LEVEL × GAS-PRICE × POL-PRICE MATRIX ────────────────────────────────────────')
      console.log('  │  Gas paid in POL; viewer share = 20% of USDC bounty; breakeven = gas_cost_USD / viewer_revenue_USD × 100%')
      console.log('  │')
      for (const { level, bountyMicro, gasPerSig } of sensResults) {
        const bountyUSDC    = Number(bountyMicro) / 1e6
        const viewerRevUSDC = bountyUSDC * viewerPct / 100
        console.log(`  │  ── ${level} bounty = $${bountyUSDC.toFixed(4)} USDC  |  viewer share = $${viewerRevUSDC.toFixed(6)}  |  gas/sig = ${gasPerSig.toLocaleString()}`)
        console.log(`  │     ${pad('POL $', 8)}${pad('gwei', 7, true)}  ${pad('gas USD/sig', 14, true)}  ${pad('viewer rev', 13, true)}  ${pad('profit', 13, true)}  ${pad('breakeven%', 12, true)}  verdict`)
        console.log(`  │     ${LINE.slice(0,80)}`)
        for (const polUSD of CONFIG.polPricesUSD) {
          for (const gwei of CONFIG.gasPricesGwei) {
            const gasCostUSD   = Number(gasPerSig) * gwei * 1e-9 * polUSD
            const profit       = viewerRevUSDC - gasCostUSD
            const bePct        = viewerRevUSDC > 0 ? (gasCostUSD / viewerRevUSDC) * 100 : Infinity
            const beStr        = bePct === Infinity ? '   N/A%' : `${bePct.toFixed(1).padStart(7)}%`
            const verdict      = bePct < 20 ? '✅ any%' : bePct < 100 ? `⚠️  >${bePct.toFixed(0)}%` : '❌ n/a'
            console.log(`  │     $${polUSD.toFixed(2)}  ${String(gwei).padStart(4)} gwei  ` +
              `${fmtUSD(gasCostUSD).padStart(14)}  ${fmtUSD(viewerRevUSDC).padStart(13)}  ` +
              `${fmtUSD(profit).padStart(13)}  ${beStr}  ${verdict}`)
          }
        }
        console.log('  │')
      }
      console.log('  └' + LINE.slice(0,63))
    }).timeout(600_000)

  }) // BCv2-USDC

}) // Business Case V2

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE HELPER – compact breakeven table (printed inline per test)
// ─────────────────────────────────────────────────────────────────────────────

function printBreakevenTable(label, gasPerSig, grossBountyUSD) {
  const rows = calculateNetBreakeven(grossBountyUSD, gasPerSig)
  console.log(`\n   📈 NET BREAKEVEN — ${label} (commission=${CONFIG.openAdvertsCommissionPct}% deducted)`)
  console.log(`   Gas Price │ POL Price │ Gas/sig USD  │ Net Bounty   │ Breakeven %  │ Verdict`)
  console.log(`   ──────────┼───────────┼──────────────┼──────────────┼──────────────┼─────────────────`)
  for (const r of rows) {
    const be      = r.breakevenPct === Infinity ? '   N/A  ' : `${r.breakevenPct.toFixed(2).padStart(7)}%`
    const verdict = r.breakevenPct < 20    ? '✅ any claim %'
                  : r.breakevenPct < 100   ? `⚠️  >${r.breakevenPct.toFixed(0)}%`
                  : '❌ unviable'
    console.log(
      `   ${String(r.gwei).padStart(4)} gwei │  $${r.polUSD.toFixed(2)}     │  ${fmtUSD(r.gasCostUSD).padStart(10)}  │  ${fmtUSD(r.netBountyUSD).padStart(10)}  │  ${be}  │ ${verdict}`
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// STANDALONE HELPER – REWARD-PER-IMPRESSION FLOOR (self-contained analysis)
//
// Answers: "How small does the viewer's per-impression reward get, and when does
// claiming it actually LOSE money, across POL price × gas price × viewer share?"
//
// Model (POL advert — fixed-POL bounty; the caller/viewer pays gas):
//   viewer reward /sig (USD) = bountyPOL × viewerPct/100 × polUSD
//   viewer gas    /sig (USD) = gasPerSig × gwei × 1e-9   × polUSD
//   viewer net    /sig (USD) = reward − gas
//
// KEY INVARIANT: net = polUSD × (bountyPOL×viewerPct/100 − gasPerSig×gwei×1e-9).
//   The SIGN of the net is independent of POL price — a claim that loses money at
//   $0.25 also loses at $0.08; POL price only scales the magnitude. Profitability is
//   governed entirely by (bountyPOL, viewerPct) vs (gasPerSig, gwei).
// ─────────────────────────────────────────────────────────────────────────────────────
function printRewardPerImpressionFloor(gasProfiles) {
  const P = CONFIG.todayPolPricesUSD
  const G = CONFIG.todayGasPricesGwei
  for (const { label, gasPerSig } of gasProfiles) {
    if (gasPerSig == null) continue
    const gps = Number(gasPerSig)
    for (const b of CONFIG.bountyLevelsPOL) {
      const bountyPOL = Number(ethers.formatEther(b.polWei))
      console.log(`\n  ┌─ REWARD FLOOR — ${label} (${gps.toLocaleString()} gas/sig) | bounty ${bountyPOL} POL (${b.name.trim()}) ─`)
      console.log('  │  POL-invariant rule: viewer profits iff  bountyPOL×viewer% > gasPerSig×gwei×1e-9')
      for (const viewerPct of CONFIG.viewerClaimPcts) {
        const rewardPOL = bountyPOL * viewerPct / 100
        const maxGwei   = rewardPOL / (gps * 1e-9)   // gas price (gwei) at which net = 0
        const maxGweiStr = maxGwei >= 1e6 ? '>1,000,000' : Math.floor(maxGwei).toLocaleString()
        console.log('  │')
        console.log(`  │  viewer ${String(viewerPct).padStart(2)}%  → reward ${rewardPOL.toFixed(6)} POL/sig  | breakeven gas ≈ ${maxGweiStr} gwei`)
        console.log(`  │     ${pad('POL $',7)}${pad('gwei',7,true)}  ${pad('reward USD',13,true)}  ${pad('gas USD',13,true)}  ${pad('net USD',13,true)}  verdict`)
        for (const polUSD of P) {
          for (const gwei of G) {
            const rewardUSD = bountyPOL * viewerPct / 100 * polUSD
            const gasUSD    = gps * gwei * 1e-9 * polUSD
            const netUSD    = rewardUSD - gasUSD
            const verdict   = netUSD > 0 ? '✅ profit' : netUSD === 0 ? '➖ breakeven' : '❌ LOSS (viewer pays to claim)'
            console.log(`  │     $${polUSD.toFixed(2)}  ${String(gwei).padStart(4)} gwei  ${fmtUSD(rewardUSD).padStart(13)}  ${fmtUSD(gasUSD).padStart(13)}  ${fmtUSD(netUSD).padStart(13)}  ${verdict}`)
          }
        }
      }
      console.log('  └' + '─'.repeat(96))
    }
  }
}
