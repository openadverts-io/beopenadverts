#!/usr/bin/env node
'use strict'
/**
 * minAdvertBountyAnalysis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Guidance tool: what should the MINIMUM advertBounty be?
 *
 * Scope (per product decision):
 *   • POL adverts only. Gas AND payout are both denominated in POL, so the viewer's
 *     gas-breakeven bounty is INVARIANT to the POL/USD price — USD price only matters
 *     when comparing the advertiser's cost to Google (a USD benchmark).
 *   • Fixed shape: 20 signatures per batch (costs amortised over 20 engagements — we
 *     never price against a single signature), viewer share = 70%, and all third-party
 *     addresses unique (the realistic worst-case gas path).
 *
 * Gas is read from test/GasBenchmark/bcv2Baseline.json (label BCv2-POL-3U-20), i.e.
 * the measured, 20-sig-amortised gas/sig for the 3-TP-unique path. Gas is invariant
 * to the split ratio (same 5 recipients / transfers at 50% or 70% viewer), so the
 * measurement is valid at viewer=70%.
 *
 * It answers, as advertBounty guidance (priced in POL and USD):
 *   1. Absolute minimum advertBounty so the VIEWER at least covers gas (per gas price).
 *   2. The advertBounty that matches Google's cheapest view / click / impression price.
 *   3. Whether we can BOTH cover viewer gas AND stay ≤ Google (feasibility).
 *   4. A recommended governance minAdvertBountyInPOLWei bandwidth.
 *   5. What advertBounty makes us cheaper than Google even if the viewer runs a loss.
 *
 * USAGE:  node test/GasBenchmark/minAdvertBountyAnalysis.js
 * OUTPUT: console tables + a self-contained test/GasBenchmark/minAdvertBountyReport.html
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs')
const path = require('path')

const BASELINE_FILE = path.join(__dirname, 'bcv2Baseline.json')
const OUTPUT_FILE   = path.join(__dirname, 'minAdvertBountyReport.html')

// ── Read the measured 20-sig, 3-TP-unique gas/sig (amortised) ────────────────
function measuredGasPerSig(label, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
    const rec  = data.filter(r => r.label === label && r.type === 'processReward').pop()
    if (rec && rec.gasPerSig) return { value: Number(rec.gasPerSig), source: `${BASELINE_FILE} (${label})` }
  } catch (_) { /* fall through */ }
  return { value: fallback, source: `fallback constant (${label} not found in baseline)` }
}

const GAS = measuredGasPerSig('BCv2-POL-3U-20', 90_067)

const CONFIG = {
  gasPerSig:      GAS.value,   // 20-sig amortised, 3-TP unique
  gasSource:      GAS.source,
  batchSize:      20,
  viewerPct:      70,          // viewer minimum share
  tpUnique:       true,
  gasPricesGwei:  [30, 100, 200, 500],
  polPricesUSD:   [0.08, 0.25],

  // ── Google cheapest-tier benchmarks (USD, per engagement). EDITABLE. ───────
  // Industry ranges (WordStream / Google Ads benchmarks; YouTube TrueView):
  //   • Display CPM  ~$0.50–$4.00 / 1000 impr  → cheapest ≈ $0.0005 / impression
  //   • YouTube CPV  ~$0.010–$0.030 / view      → cheapest ≈ $0.010 / view
  //   • Display CPC  ~$0.10–$0.63 / click       → cheapest ≈ $0.10 / click
  google: {
    impressionCPM_USD: 0.0005, // per single impression ($0.50 CPM)
    viewCPV_USD:       0.010,  // per single view (YouTube TrueView, cheap end)
    clickCPC_USD:      0.10,   // per single click (Display, cheap end)
  },
}

// ── Core maths ───────────────────────────────────────────────────────────────
const viewerFrac = CONFIG.viewerPct / 100

// Gas the viewer pays per signature, in POL (price-invariant in POL terms).
const gasPolPerSig = gwei => CONFIG.gasPerSig * gwei * 1e-9

// Absolute minimum advertBounty (POL) so viewer share covers gas: bounty*viewerFrac = gas.
const gasCoverBountyPOL = gwei => gasPolPerSig(gwei) / viewerFrac

// advertBounty (POL) whose USD value equals a target USD price at a given POL price.
const usdToPOL = (usd, polUSD) => usd / polUSD

const fmtPOL = n => `${n.toFixed(6)} POL`
const fmtUSD = n => `$${n.toFixed(6)}`
const pad    = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w)

const GOOGLE_ROWS = [
  { key: 'view',       label: 'View  (YouTube CPV)',      usd: CONFIG.google.viewCPV_USD },
  { key: 'click',      label: 'Click (Display CPC)',      usd: CONFIG.google.clickCPC_USD },
  { key: 'impression', label: 'Impression (Display CPM)', usd: CONFIG.google.impressionCPM_USD },
]

// ── Console report ───────────────────────────────────────────────────────────
function printConsole() {
  const line = '─'.repeat(92)
  console.log('\n' + '═'.repeat(92))
  console.log('  MINIMUM advertBounty GUIDANCE — POL advert | 20-sig batch | viewer 70% | 3-TP unique')
  console.log('═'.repeat(92))
  console.log(`  gas/sig (amortised over ${CONFIG.batchSize} sigs): ${CONFIG.gasPerSig.toLocaleString()}  [${CONFIG.gasSource}]`)
  console.log(`  batch total gas: ${(CONFIG.gasPerSig * CONFIG.batchSize).toLocaleString()} (paid once by the viewer for ${CONFIG.batchSize} engagements)`)
  console.log('  POL price is IRRELEVANT to the viewer gas-breakeven bounty (both sides are POL);')
  console.log('  it only matters when comparing the advertiser cost to Google (a USD price).')

  // 1) Absolute minimum advertBounty to cover viewer gas
  console.log('\n' + line)
  console.log('  1) ABSOLUTE MINIMUM advertBounty TO COVER VIEWER GAS (viewer 70%)')
  console.log(line)
  console.log('  ' + pad('gas price', 12) + pad('min bounty (POL)', 20, true) + pad('= USD @$0.08', 16, true) + pad('= USD @$0.25', 16, true))
  for (const gwei of CONFIG.gasPricesGwei) {
    const pol = gasCoverBountyPOL(gwei)
    console.log('  ' + pad(`${gwei} gwei`, 12) + pad(pol.toFixed(6), 20, true) +
      pad(fmtUSD(pol * 0.08), 16, true) + pad(fmtUSD(pol * 0.25), 16, true))
  }

  // 2) advertBounty to match Google (USD → POL)
  console.log('\n' + line)
  console.log('  2) advertBounty TO MATCH GOOGLE CHEAPEST (advertiser cost parity)')
  console.log(line)
  console.log('  ' + pad('Google format', 26) + pad('price USD', 12, true) + pad('bounty POL @$0.08', 20, true) + pad('bounty POL @$0.25', 20, true))
  for (const g of GOOGLE_ROWS) {
    console.log('  ' + pad(g.label, 26) + pad(fmtUSD(g.usd), 12, true) +
      pad(usdToPOL(g.usd, 0.08).toFixed(6), 20, true) + pad(usdToPOL(g.usd, 0.25).toFixed(6), 20, true))
  }

  // 3) Feasibility: cover gas AND ≤ Google
  console.log('\n' + line)
  console.log('  3) FEASIBILITY — can we cover viewer gas AND stay ≤ Google price?')
  console.log('     (viewer gas-cover bounty USD  vs  Google price; ✅ = feasible, ❌ = gas exceeds Google)')
  console.log(line)
  for (const polUSD of CONFIG.polPricesUSD) {
    console.log(`  POL = $${polUSD.toFixed(2)}`)
    console.log('    ' + pad('gas price', 12) + pad('gasCover USD', 16, true) + GOOGLE_ROWS.map(g => pad(g.key, 14, true)).join(''))
    for (const gwei of CONFIG.gasPricesGwei) {
      const coverUSD = gasCoverBountyPOL(gwei) * polUSD
      const cells = GOOGLE_ROWS.map(g => pad(coverUSD <= g.usd ? '✅' : '❌', 14, true)).join('')
      console.log('    ' + pad(`${gwei} gwei`, 12) + pad(fmtUSD(coverUSD), 16, true) + cells)
    }
  }

  // 4) Recommended governance min bandwidth
  console.log('\n' + line)
  console.log('  4) RECOMMENDED governance minAdvertBountyInPOLWei BANDWIDTH (viewer 70%)')
  console.log(line)
  for (const gwei of [100, 200, 500]) {
    const pol = gasCoverBountyPOL(gwei)
    console.log(`  resilient to ${String(gwei).padStart(3)} gwei → ≥ ${pol.toFixed(6)} POL  (= ${fmtUSD(pol * 0.08)} @$0.08 / ${fmtUSD(pol * 0.25)} @$0.25)`)
  }

  console.log('\n📄 HTML written to: ' + path.relative(process.cwd(), OUTPUT_FILE) + '\n')
}

// ── HTML report ──────────────────────────────────────────────────────────────
function verdictTag(ok) {
  return ok ? `<span class="tag-green">feasible</span>` : `<span class="tag-red">gas &gt; Google</span>`
}

function buildHtml() {
  const gasCoverRows = CONFIG.gasPricesGwei.map(gwei => {
    const pol = gasCoverBountyPOL(gwei)
    return `<tr><td class="label">${gwei} gwei</td><td>${pol.toFixed(6)}</td><td>${fmtUSD(pol * 0.08)}</td><td>${fmtUSD(pol * 0.25)}</td></tr>`
  }).join('')

  const googleRows = GOOGLE_ROWS.map(g =>
    `<tr><td class="label">${g.label}</td><td>${fmtUSD(g.usd)}</td><td>${usdToPOL(g.usd, 0.08).toFixed(6)}</td><td>${usdToPOL(g.usd, 0.25).toFixed(6)}</td></tr>`
  ).join('')

  const feasBlocks = CONFIG.polPricesUSD.map(polUSD => {
    const rows = CONFIG.gasPricesGwei.map(gwei => {
      const coverUSD = gasCoverBountyPOL(gwei) * polUSD
      const cells = GOOGLE_ROWS.map(g => `<td>${verdictTag(coverUSD <= g.usd)}</td>`).join('')
      return `<tr><td class="label">${gwei} gwei</td><td>${fmtUSD(coverUSD)}</td>${cells}</tr>`
    }).join('')
    return `
      <h3>POL = $${polUSD.toFixed(2)}</h3>
      <table>
        <thead><tr><th>gas price</th><th>viewer gas-cover (USD)</th>
        ${GOOGLE_ROWS.map(g => `<th>${g.label}<br><span class="sub">${fmtUSD(g.usd)}</span></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }).join('')

  const bandRows = [100, 200, 500].map(gwei => {
    const pol = gasCoverBountyPOL(gwei)
    // Positioning vs Google at $0.25
    const usd25 = pol * 0.25
    let pos
    if (usd25 <= CONFIG.google.impressionCPM_USD) pos = 'cheaper than cheapest display CPM'
    else if (usd25 <= CONFIG.google.viewCPV_USD)  pos = '≤ YouTube CPV; far below CPC'
    else if (usd25 <= CONFIG.google.clickCPC_USD) pos = 'above CPV, below CPC'
    else pos = 'above Google CPC'
    return `<tr><td class="label">resilient to ${gwei} gwei</td><td>${pol.toFixed(6)}</td><td>${fmtUSD(pol * 0.08)}</td><td>${fmtUSD(usd25)}</td><td>${pos}</td></tr>`
  }).join('')

  // 5) Cheaper-than-Google-even-at-viewer-loss: viewer net if advertBounty == Google price
  const lossBlocks = CONFIG.polPricesUSD.map(polUSD => {
    const rows = GOOGLE_ROWS.map(g => {
      const cells = CONFIG.gasPricesGwei.map(gwei => {
        const viewerRewardUSD = g.usd * viewerFrac        // 70% of a Google-priced bounty
        const gasUSD          = gasPolPerSig(gwei) * polUSD
        const net             = viewerRewardUSD - gasUSD
        const cls             = net >= 0 ? 'pos' : 'neg'
        return `<td class="${cls}">${fmtUSD(net)}</td>`
      }).join('')
      return `<tr><td class="label">${g.label} (${fmtUSD(g.usd)})</td>${cells}</tr>`
    }).join('')
    return `
      <h3>POL = $${polUSD.toFixed(2)} — viewer net/sig if advertBounty = Google price</h3>
      <table>
        <thead><tr><th>Google format (= advertBounty)</th>${CONFIG.gasPricesGwei.map(g => `<th>${g} gwei</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAdverts — Minimum advertBounty Guidance</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0f1117; color:#e2e8f0; padding:28px; line-height:1.5; }
  h1 { font-size:1.5rem; color:#a78bfa; margin-bottom:6px; }
  h2 { font-size:1.05rem; color:#7c3aed; margin:30px 0 10px; text-transform:uppercase; letter-spacing:.04em; }
  h3 { font-size:.9rem; color:#94a3b8; margin:16px 0 6px; }
  p, li { font-size:.85rem; color:#cbd5e1; max-width:1000px; }
  .meta { font-size:.78rem; color:#64748b; margin-bottom:18px; }
  .box { background:#1e2130; border:1px solid #2d3148; border-radius:10px; padding:16px 20px; margin:14px 0; max-width:1000px; }
  table { border-collapse:collapse; font-size:.8rem; margin:6px 0 4px; }
  th,td { padding:7px 12px; border:1px solid #2d3148; text-align:right; }
  th { background:#262940; color:#94a3b8; text-align:center; }
  td.label { text-align:left; color:#94a3b8; }
  .sub { font-size:.7rem; color:#64748b; }
  .tag-green { background:#166534; color:#86efac; padding:2px 8px; border-radius:4px; font-size:.72rem; }
  .tag-red { background:#7f1d1d; color:#fca5a5; padding:2px 8px; border-radius:4px; font-size:.72rem; }
  td.pos { color:#86efac; } td.neg { color:#fca5a5; }
  code { background:#262940; padding:1px 6px; border-radius:4px; color:#a5b4fc; }
  footer { margin-top:40px; font-size:.72rem; color:#475569; }
</style></head><body>

<h1>OpenAdverts — Minimum <code>advertBounty</code> Guidance</h1>
<p class="meta">Generated ${new Date().toISOString()} · POL advert · 20-sig batch · viewer 70% · 3-TP unique · gas/sig ${CONFIG.gasPerSig.toLocaleString()} (amortised over ${CONFIG.batchSize} sigs)</p>

<div class="box">
  <strong>Model &amp; scope.</strong>
  <ul>
    <li>Both the payout and the gas are in <strong>POL</strong>, so the viewer's gas-breakeven <code>advertBounty</code> is <strong>invariant to the POL/USD price</strong> — price only scales the magnitude. USD price matters <em>only</em> when comparing the advertiser's cost to Google (a USD benchmark).</li>
    <li>Costs are amortised over a <strong>20-signature batch</strong> (never a single signature). The viewer pays <strong>${(CONFIG.gasPerSig * CONFIG.batchSize).toLocaleString()} gas once</strong> for 20 engagements; ${CONFIG.gasPerSig.toLocaleString()} is the per-engagement share.</li>
    <li>Viewer receives <strong>70%</strong> of the bounty; all third-party addresses unique (worst-case gas path). Gas is split-ratio-invariant (same recipients at 50% or 70%).</li>
    <li>Google benchmarks are editable constants in the script — currently CPV <code>${fmtUSD(CONFIG.google.viewCPV_USD)}</code>/view, CPC <code>${fmtUSD(CONFIG.google.clickCPC_USD)}</code>/click, CPM <code>${fmtUSD(CONFIG.google.impressionCPM_USD)}</code>/impression.</li>
  </ul>
</div>

<h2>1 · Absolute minimum <code>advertBounty</code> to cover viewer gas</h2>
<p>The floor: below this the viewer's 70% share does not even repay the gas they spend to claim. POL column is the real constraint (price-invariant); USD columns are for context.</p>
<table>
  <thead><tr><th>gas price</th><th>min advertBounty (POL)</th><th>= USD @ $0.08</th><th>= USD @ $0.25</th></tr></thead>
  <tbody>${gasCoverRows}</tbody>
</table>

<h2>2 · <code>advertBounty</code> to match Google's cheapest price</h2>
<p>What the advertiser would pay per engagement to be <em>at parity</em> with Google. Same USD price converts to different POL amounts as POL moves.</p>
<table>
  <thead><tr><th>Google format</th><th>price USD</th><th>advertBounty POL @ $0.08</th><th>advertBounty POL @ $0.25</th></tr></thead>
  <tbody>${googleRows}</tbody>
</table>

<h2>3 · Feasibility — cover viewer gas <em>and</em> stay ≤ Google</h2>
<p>Feasible when the viewer gas-cover bounty (in USD) is ≤ Google's price. Note a <strong>lower POL price makes this easier</strong> (gas is cheaper in USD), so USD price is <em>not</em> irrelevant for the Google comparison.</p>
${feasBlocks}

<h2>4 · Recommended governance <code>minAdvertBountyInPOLWei</code> bandwidth</h2>
<p>Set the floor by the gas price you want viewers to stay whole at. Positioning is vs Google at $0.25/POL.</p>
<table>
  <thead><tr><th>resilience target</th><th>min bounty (POL)</th><th>= USD @ $0.08</th><th>= USD @ $0.25</th><th>vs Google</th></tr></thead>
  <tbody>${bandRows}</tbody>
</table>

<h2>5 · Cheaper than Google even if the viewer runs a loss</h2>
<p>If you set <code>advertBounty = Google's price</code> (so the advertiser is at parity or below), this is the viewer's net per engagement. Red = the viewer loses money claiming and would need a sponsor/relayer to pay gas.</p>
${lossBlocks}

<footer>Editable inputs live in test/GasBenchmark/minAdvertBountyAnalysis.js (gas read from bcv2Baseline.json · Google benchmarks in CONFIG.google).</footer>
</body></html>`
}

// ── Run ──────────────────────────────────────────────────────────────────────
printConsole()
fs.writeFileSync(OUTPUT_FILE, buildHtml())
