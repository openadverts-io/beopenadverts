/**
 * debugProcessReward.js
 *
 * Drop-in helper to call processReward and get full visibility into:
 *   - Whether signatures were accepted or rejected (and why)
 *   - Exact funds sent to each recipient
 *   - Contract balance before/after
 *   - Any on-chain revert reason if the tx fails
 *
 * Usage in any test:
 *   const { debugProcessReward } = require('../../helpers/debugProcessReward')
 *   const result = await debugProcessReward(polContract, user, signatures, blockNumbers, verificationData, thirdPartyAddresses)
 */

const { ethers } = require('hardhat')

/**
 * Attempts processReward and prints a full diagnostic report regardless of
 * success or failure.
 *
 * @param {ethers.Contract}  polContract          - OpenAdvertsAdvertPOL contract instance
 * @param {ethers.Signer}    caller               - The signer that will send the tx (viewer / user)
 * @param {string[]}         signatures           - Array of hex signatures
 * @param {number[]}         blockNumbers         - Array of block numbers (one per signature)
 * @param {object}           verificationData     - VerificationDataStruct fields as a plain object
 * @param {object[]}         thirdPartyAddresses  - Array of ThirdPartyAddressStruct objects
 * @param {object}           [opts]               - Optional overrides
 * @param {boolean}          [opts.expectRevert]  - Set true if you expect the call to revert
 * @returns {object}  result object with { receipt, payoutCompleted, polTransfers, balanceDiff }
 */
async function debugProcessReward(
  polContract,
  caller,
  signatures,
  blockNumbers,
  verificationData,
  thirdPartyAddresses,
  opts = {}
) {
  const contractAddress = await polContract.getAddress()

  // ─── 1. Capture pre-call state ────────────────────────────────────────────
  const balanceBefore = await ethers.provider.getBalance(contractAddress)
  const callerBalanceBefore = await ethers.provider.getBalance(caller.address)

  console.log('\n' + '═'.repeat(80))
  console.log('🔍  debugProcessReward  —  PRE-CALL SNAPSHOT')
  console.log('═'.repeat(80))
  console.log(`   Contract   : ${contractAddress}`)
  console.log(`   Caller     : ${caller.address}`)
  console.log(`   POL balance: ${ethers.formatEther(balanceBefore)} POL`)
  console.log(`   Signatures : ${signatures.length}`)
  console.log(`   Nonce (passed in verificationData): ${verificationData.nonce}`)
  console.log(`   Affiliate  : ${verificationData.affiliateReceivingAddress}`)

  // ─── 2. Static-call first so we can surface the revert reason cheaply ──────
  console.log('\n── Static-call dry run (checks require/revert without gas cost) ──')
  try {
    await polContract.connect(caller).processReward.staticCall(
      signatures,
      blockNumbers,
      verificationData,
      thirdPartyAddresses
    )
    console.log('   ✅  Static call PASSED — transaction should succeed')
  } catch (err) {
    const reason = extractRevertReason(err)
    console.log(`   ❌  Static call REVERTED: "${reason}"`)
    console.log('       Full error:', err.message)

    if (!opts.expectRevert) {
      throw new Error(`processReward would revert: ${reason}`)
    }
    console.log('   ⚠️   opts.expectRevert=true — continuing anyway\n')
    return { reverted: true, reason }
  }

  // ─── 3. Send the real tx ──────────────────────────────────────────────────
  console.log('\n── Sending real transaction ──')
  let receipt
  try {
    const tx = await polContract.connect(caller).processReward(
      signatures,
      blockNumbers,
      verificationData,
      thirdPartyAddresses
    )
    receipt = await tx.wait()
    console.log(`   ✅  Transaction mined  (hash: ${receipt.hash})`)
    console.log(`   ⛽  Gas used: ${receipt.gasUsed.toLocaleString()}`)
  } catch (err) {
    const reason = extractRevertReason(err)
    console.log(`   ❌  Transaction REVERTED: "${reason}"`)
    throw err
  }

  // ─── 4. Parse events ─────────────────────────────────────────────────────
  console.log('\n── Parsing events from receipt ──')

  const payoutCompleted = parseEvent(receipt, polContract.interface, 'PayoutCompleted')
  const polTransfers    = parseEvent(receipt, polContract.interface, 'POLTransfersCompleted')
  const advertExhausted = parseEvent(receipt, polContract.interface, 'AdvertExhausted')

  if (payoutCompleted) {
    const e = payoutCompleted
    console.log('\n   📣  PayoutCompleted event:')
    console.log(`       Affiliate                : ${e.affiliateReceivingAddress}`)
    console.log(`       Signatures offered       : ${e.signaturesOffered}`)
    console.log(`       Signatures accepted      : ${e.signaturesAccepted}`)
    console.log(`       Signatures rejected      : ${e.signaturesRejected}`)
    console.log(`       Viewer payout            : ${ethers.formatEther(e.viewerPayout)} POL`)
    console.log(`       Affiliate payout         : ${ethers.formatEther(e.affiliatePayout)} POL`)
    console.log(`       Third-party total payout : ${ethers.formatEther(e.thirdPartyTotalPayout)} POL`)
    console.log(`       Total payout             : ${ethers.formatEther(e.totalPayout)} POL`)

    if (e.rejectionReasons && e.rejectionReasons.length > 0) {
      console.log('\n   ⚠️   Rejection reasons:')
      e.rejectionReasons.forEach((r, i) => console.log(`       [${i}] ${r}`))
    } else {
      console.log('       Rejection reasons: none')
    }
  } else {
    console.log('   ⚠️   PayoutCompleted event NOT found in receipt')
  }

  if (polTransfers) {
    const e = polTransfers
    console.log('\n   📣  POLTransfersCompleted event:')
    console.log(`       Affiliate          : ${e.affiliateReceivingAddress}`)
    console.log(`       Signatures count   : ${e.processedSignaturesCount}`)
    console.log(`       Total transferred  : ${ethers.formatEther(e.totalTransferred)} POL`)
  } else {
    console.log('   ⚠️   POLTransfersCompleted event NOT found in receipt')
  }

  if (advertExhausted) {
    console.log('\n   🚨  AdvertExhausted event fired — contract marked as exhausted')
  }

  // ─── 5. Balance diff ─────────────────────────────────────────────────────
  const balanceAfter  = await ethers.provider.getBalance(contractAddress)
  const callerBalanceAfter = await ethers.provider.getBalance(caller.address)
  const gasCost = receipt.gasUsed * receipt.gasPrice

  const balanceDiff = {
    contractSpent : balanceBefore  - balanceAfter,
    callerNetGain : (callerBalanceAfter - callerBalanceBefore) + gasCost,  // adds back gas so we see pure transfer
    callerGasCost : gasCost,
  }

  console.log('\n── Balance changes ──')
  console.log(`   Contract POL spent : ${ethers.formatEther(balanceDiff.contractSpent)} POL`)
  console.log(`   Caller net gain    : ${ethers.formatEther(balanceDiff.callerNetGain)} POL (excl gas)`)
  console.log(`   Caller gas cost    : ${ethers.formatEther(balanceDiff.callerGasCost)} POL`)

  if (balanceDiff.contractSpent === 0n) {
    console.log('\n   🚨  CONTRACT SPENT ZERO — common causes:')
    console.log('       • payoutData.totalAmount was 0 (claimReward returned zero amounts)')
    console.log('       • All signatures were filtered out (signaturesAccepted == 0)')
    console.log('       • Check PayoutCompleted.signaturesAccepted and PayoutCompleted.totalPayout above')
  }

  console.log('═'.repeat(80) + '\n')

  return { receipt, payoutCompleted, polTransfers, balanceDiff, reverted: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds and decodes the first occurrence of eventName in a receipt.
 * Returns the decoded args as a plain object, or null if not found.
 */
function parseEvent(receipt, iface, eventName) {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data })
      if (parsed && parsed.name === eventName) {
        // Convert Result proxy to a plain object keyed by named args
        const obj = {}
        for (const key of Object.keys(parsed.args)) {
          if (isNaN(Number(key))) obj[key] = parsed.args[key]
        }
        return obj
      }
    } catch {
      // log belongs to a different contract — skip
    }
  }
  return null
}

/**
 * Extracts a human-readable revert reason from an ethers error object.
 */
function extractRevertReason(err) {
  // viem / hardhat-network style
  if (err?.reason)               return err.reason
  if (err?.data?.message)        return err.data.message
  if (err?.error?.message)       return err.error.message

  // parse "reverted with reason string 'X'" from message
  const m = err?.message?.match(/reverted with reason string '([^']+)'/)
  if (m) return m[1]

  // panic / custom error
  const p = err?.message?.match(/reverted with panic code (\w+)/)
  if (p) return `Panic(${p[1]})`

  return err?.message ?? 'unknown'
}

module.exports = { debugProcessReward, parseEvent, extractRevertReason }
