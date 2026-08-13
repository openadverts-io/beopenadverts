/**
 * compareGas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads gasBaseline.json and prints a before/after comparison table showing
 * the gas savings achieved by the memory refactor of OpenAdvertsPayoutFacet.
 *
 * USAGE:
 *   node test/GasBenchmark/compareGas.js
 *
 * REQUIREMENTS:
 *   - gasBaseline.json must contain at least one BEFORE_MEMORY_REFACTOR entry.
 *   - gasBaseline.json must contain at least one AFTER_MEMORY_REFACTOR entry
 *     (populated by running GasPostRefactor.js after TODO-4 is complete).
 */

const fs   = require('fs')
const path = require('path')

const BASELINE_FILE    = path.join(__dirname, 'gasBaseline.json')
const POLYGON_GAS_LIMIT = 30_000_000n

// ─────────────────────────────────────────────────────────────────────────────
// Load data
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`\n❌  ${BASELINE_FILE} not found.`)
  console.error('    Run GasBaseline.js first:')
  console.error('      npx hardhat test "test/GasBenchmark/GasBaseline.js"\n')
  process.exit(1)
}

const data   = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
const before = {}
const after  = {}

for (const entry of data) {
  if (entry.codeState === 'BEFORE_MEMORY_REFACTOR') before[entry.scenario] = entry
  if (entry.codeState === 'AFTER_MEMORY_REFACTOR')  after[entry.scenario]  = entry
}

const scenarios = ['A', 'B', 'C', 'D', 'E', 'F']

// ─────────────────────────────────────────────────────────────────────────────
// Print table
// ─────────────────────────────────────────────────────────────────────────────

const COL = {
  scenario:   10,
  desc:       55,
  before:     18,
  after:      18,
  saving:     16,
  pct:        9,
  polygon:    10
}

function pad (s, n, right = false) {
  const str = String(s)
  if (right) return str.padStart(n)
  return str.padEnd(n)
}

function fmt (gasStr) {
  if (!gasStr || gasStr === 'EXCEEDED_BLOCK_GAS_LIMIT') return '💥 OOG'
  return BigInt(gasStr).toLocaleString()
}

function polygonTag (gasStr) {
  if (!gasStr || gasStr === 'EXCEEDED_BLOCK_GAS_LIMIT') return '> 50M'
  const g = BigInt(gasStr)
  return g > POLYGON_GAS_LIMIT ? '⚠️ >30M' : '✅ ok'
}

const SEP = '─'.repeat(COL.scenario + COL.desc + COL.before + COL.after + COL.saving + COL.pct + COL.polygon + 7)

console.log('\n' + SEP)
console.log(
  pad('Scenario', COL.scenario) + ' ' +
  pad('Description', COL.desc) + ' ' +
  pad('Before (gas)', COL.before, true) + ' ' +
  pad('After (gas)', COL.after, true) + ' ' +
  pad('Saved', COL.saving, true) + ' ' +
  pad('% saved', COL.pct, true) + ' ' +
  pad('Polygon', COL.polygon, true)
)
console.log(SEP)

let anyMissing = false

for (const sc of scenarios) {
  const b = before[sc]
  const a = after[sc]

  if (!b) {
    console.log(pad(sc, COL.scenario) + ' BEFORE data missing — run GasBaseline.js')
    anyMissing = true
    continue
  }

  const beforeGas = b.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT' ? null : BigInt(b.gasUsed)

  let savingStr = '—'
  let pctStr    = '—'

  if (a) {
    const afterGas = a.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT' ? null : BigInt(a.gasUsed)
    if (beforeGas !== null && afterGas !== null) {
      const saved = beforeGas - afterGas
      const pct   = Number((saved * 10000n) / beforeGas) / 100
      savingStr   = saved.toLocaleString()
      pctStr      = pct.toFixed(1) + '%'
    } else if (beforeGas === null && afterGas !== null) {
      savingStr = 'from OOG → ' + afterGas.toLocaleString()
    }
  } else {
    anyMissing = true
  }

  const desc = b.description ? b.description.slice(0, COL.desc - 1) : `${b.sigCount} sigs × ${b.tpsPerSig} TPs`

  console.log(
    pad(sc, COL.scenario) + ' ' +
    pad(desc, COL.desc) + ' ' +
    pad(fmt(b.gasUsed), COL.before, true) + ' ' +
    pad(a ? fmt(a.gasUsed) : '(pending)', COL.after, true) + ' ' +
    pad(savingStr, COL.saving, true) + ' ' +
    pad(pctStr, COL.pct, true) + ' ' +
    pad(polygonTag(b.gasUsed), COL.polygon, true)
  )
}

console.log(SEP)

if (anyMissing) {
  console.log('\nℹ️  Some AFTER_MEMORY_REFACTOR entries are missing.')
  console.log('   Complete TODO-4 then run: npx hardhat test "test/GasBenchmark/GasPostRefactor.js"\n')
} else {
  console.log('\n✅  Complete before/after comparison available.\n')
}
