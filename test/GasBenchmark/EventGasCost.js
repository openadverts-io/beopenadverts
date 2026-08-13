// Event gas-cost measurement for the per-payout PayoutManifest audit log.
//
// Purpose: isolate the EXACT gas added by `emit PayoutManifest(...)` (a single
// array event carrying the full (recipients[], amounts[]) allocation) in the POL
// processReward path, for a batch of 20 valid signatures, at 0 / 3 / 6 third
// parties per signature.
//
// Why this file exists (and why cross-run BusinessCaseV2 diffs are NOT valid):
//   processReward gas depends on the concrete addresses/nonces involved, so
//   diffing gasUsed across two *different* full-suite runs is contaminated by
//   address-context differences. Here we use loadFixture, so the ON build and
//   the OFF build execute byte-identical transactions — the only difference is
//   whether the emit is compiled in. We also read the manifest's recipients[]
//   length so cost-per-recipient = (gasUsed_on - gasUsed_off) / recipients.
//
// Procedure to measure:
//   1. npx hardhat test test/GasBenchmark/EventGasCost.js         (event ON)
//        -> records gasUsed + recipient count per scenario to eventGasCost.json
//   2. Remove the two `emit PayoutManifest(...)` lines, `npx hardhat compile`
//   3. npx hardhat test test/GasBenchmark/EventGasCost.js         (event OFF)
//   4. Diff gasUsed by scenario; divide by the ON-run recipient count.
//   5. Restore the emits and recompile.

const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture, mine } = require('@nomicfoundation/hardhat-network-helpers')
const fs = require('fs')
const path = require('path')

const { deployDiamond } = require('../../scripts/deploy.js')
const gate = require('../helpers/signatureGate.js')

const OUTPUT_FILE = path.join(__dirname, 'eventGasCost.json')
const SIGNING_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey

async function buildScenario(mockFqName, tpPerSig) {
  const signers = await ethers.getSigners()
  const [owner, advertiser, affiliate, user, voter1, voter2, voter3, ...thirdParties] = signers

  const needed = tpPerSig * 20
  if (thirdParties.length < needed) {
    throw new Error(`Need ${needed} third-party signers, have ${thirdParties.length}`)
  }

  const signingAddress = new ethers.Wallet(SIGNING_PRIVATE_KEY, ethers.provider)

  const diamondAddress = (await deployDiamond()).diamond
  const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
  const affiliatesFacet = await ethers.getContractAt('OpenAdvertsAffiliatesFacet', diamondAddress)
  const affiliateVotingFacet = await ethers.getContractAt('OpenAdvertsAffiliatesVotingFacet', diamondAddress)
  const advertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress)
  const advertVotingFacet = await ethers.getContractAt('OpenAdvertsAdvertisersVotingFacet', diamondAddress)
  const polFactoryFacet = await ethers.getContractAt('OpenAdvertsAdvertPOLFactoryFacet', diamondAddress)
  const payoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress)

  await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(signingAddress.address)

  const MockClaim = await ethers.getContractFactory(mockFqName)
  const mockClaim = await MockClaim.deploy()
  await mockClaim.waitForDeployment()
  const mockClaimAddress = await mockClaim.getAddress()

  const voterTokens = ethers.parseEther('5000000')
  await tokenFacet.connect(owner).transfer(voter1.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter2.address, voterTokens)
  await tokenFacet.connect(owner).transfer(voter3.address, voterTokens)

  await affiliatesFacet.connect(affiliate).createProspectAffiliateContract(
    affiliate.address, mockClaimAddress, signingAddress.address, 'event-gas-affiliate',
    ...(await gate.affiliate(signingAddress, diamondAddress, affiliate.address)))
  await mine(15)
  await affiliateVotingFacet.connect(voter1).voteOnAffiliate(affiliate.address, true)
  await affiliateVotingFacet.connect(voter2).voteOnAffiliate(affiliate.address, true)
  await affiliateVotingFacet.connect(voter3).voteOnAffiliate(affiliate.address, true)

  const advertBounty = ethers.parseEther('1')
  const fundingAmount = ethers.parseEther('200')
  const tx = await polFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
    'event-gas-advert', advertBounty, 1, affiliate.address,
    ...(await gate.pol(signingAddress, diamondAddress, advertiser.address)),
    { value: fundingAmount })
  const rc = await tx.wait()
  const createEvt = rc.logs.find((l) => {
    try { return polFactoryFacet.interface.parseLog(l).name === 'POLAdvertisementCreatedAndValidated' } catch { return false }
  })
  const polAdvertAddress = polFactoryFacet.interface.parseLog(createEvt).args.advertContract

  await mine(15)
  await advertVotingFacet.connect(voter1).voteOnAdvert(polAdvertAddress, true)
  await advertVotingFacet.connect(voter2).voteOnAdvert(polAdvertAddress, true)
  await advertVotingFacet.connect(voter3).voteOnAdvert(polAdvertAddress, true)

  const polContract = await ethers.getContractAt('OpenAdvertsAdvertPOL', polAdvertAddress)

  // Build 20 signatures, each carrying `tpPerSig` unique third-party addresses.
  const thirdPartySets = []
  for (let i = 0; i < 20; i++) {
    const addrs = []
    for (let j = 0; j < tpPerSig; j++) addrs.push(thirdParties[i * tpPerSig + j].address)
    thirdPartySets.push({ thirdPartyAddresses: addrs })
  }

  const currentNonce = await polContract.connect(user).getUserNonceOfAffiliate(affiliate.address)
  const verificationData = {
    affiliateReceivingAddress: affiliate.address,
    affiliateClaimInfoAddress: mockClaimAddress,
    affiliateSigningAddress: signingAddress.address,
    advertismentContractAddress: polAdvertAddress,
    nonce: Number(currentNonce),
    viewerAddress: user.address,
  }

  const signatures = []
  const blockNumbers = []
  const baseBlock = await ethers.provider.getBlockNumber()
  const wallet = new ethers.Wallet(signingAddress.privateKey)
  for (let i = 0; i < 20; i++) {
    const blockNumber = baseBlock + i * 2
    blockNumbers.push(blockNumber)
    const tpAddrs = thirdPartySets[i].thirdPartyAddresses
    const tpHash = ethers.keccak256(ethers.solidityPacked(['address[]'], [tpAddrs]))
    const msgHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'bytes32', 'uint256'],
      [user.address, BigInt(blockNumber), BigInt(verificationData.nonce),
        verificationData.affiliateReceivingAddress, polAdvertAddress, BigInt(tpAddrs.length), tpHash, advertBounty])
    signatures.push(await wallet.signMessage(ethers.getBytes(msgHash)))
  }

  const highest = blockNumbers[blockNumbers.length - 1]
  const latest = await ethers.provider.getBlockNumber()
  if (latest < highest) await mine(highest - latest)

  return { polContract, signatures, blockNumbers, verificationData, thirdPartySets, user }
}

function recordResult(entry) {
  let data = []
  if (fs.existsSync(OUTPUT_FILE)) {
    try { data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) } catch { data = [] }
  }
  // Overwrite any prior entry for the same scenario in this run's build.
  data = data.filter((e) => e.scenario !== entry.scenario)
  data.push(entry)
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2))
}

async function measure(polContract, args, scenario, tpPerSig) {
  const { signatures, blockNumbers, verificationData, thirdPartySets, user } = args
  const tx = await polContract.connect(user).processReward(signatures, blockNumbers, verificationData, thirdPartySets)
  const receipt = await tx.wait()

  let manifestRecipients = 0
  let payoutPendingCount = 0
  let manifestPresent = false
  for (const log of receipt.logs) {
    let parsed
    try { parsed = polContract.interface.parseLog(log) } catch { continue }
    if (!parsed) continue
    if (parsed.name === 'PayoutManifest') { manifestPresent = true; manifestRecipients = parsed.args.recipients.length }
    else if (parsed.name === 'PayoutPending') payoutPendingCount++
  }

  const gasUsed = receipt.gasUsed
  const result = {
    scenario,
    tpPerSig,
    sigCount: 20,
    recipients: manifestRecipients,
    payoutPendingCount,
    gasUsed: gasUsed.toString(),
    eventPresent: manifestPresent,
  }
  recordResult(result)

  console.log(
    `\n  [${scenario}] 20 sigs × ${tpPerSig} TP  |  gasUsed=${gasUsed.toString()}  |  ` +
    `PayoutManifest=${manifestPresent ? 1 : 0}  recipients=${manifestRecipients}  PayoutPending=${payoutPendingCount}`)

  return result
}

describe('Event gas cost — AccountPaid (20 valid signatures)', function () {
  function fixture0TP() { return buildScenario('contracts/MockClaimPercentagesProviderAt0TPs.sol:MockClaimPercentagesProvider', 0) }
  function fixture3TP() { return buildScenario('contracts/MockClaimPercentagesProvider.sol:MockClaimPercentagesProvider', 3) }
  function fixture6TP() { return buildScenario('contracts/MockClaimPercentagesProviderWith6TPs.sol:MockClaimPercentagesProviderWith6TPs', 6) }

  it('0 third parties (2 recipients: viewer + affiliate)', async function () {
    const args = await loadFixture(fixture0TP)
    const r = await measure(args.polContract, args, 'POL-0TP-20', 0)
    expect(r.recipients).to.equal(2)
  })

  it('3 unique third parties (62 recipients)', async function () {
    const args = await loadFixture(fixture3TP)
    const r = await measure(args.polContract, args, 'POL-3U-20', 3)
    expect(r.recipients).to.equal(62)
  })

  it('6 unique third parties (122 recipients)', async function () {
    const args = await loadFixture(fixture6TP)
    const r = await measure(args.polContract, args, 'POL-6U-20', 6)
    expect(r.recipients).to.equal(122)
  })
})
