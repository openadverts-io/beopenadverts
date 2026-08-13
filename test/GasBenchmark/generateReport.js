#!/usr/bin/env node
/**
 * generateReport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads test/GasBenchmark/bcv2Baseline.json and writes a self-contained
 * bcv2Report.html to the same directory.
 *
 * The HTML file contains embedded Chart.js (CDN) charts. No npm install needed
 * beyond Node.js itself.
 *
 * USAGE:
 *   node test/GasBenchmark/generateReport.js
 *
 * REQUIREMENTS:
 *   bcv2Baseline.json must exist (populated by running BusinessCaseV2.js).
 *
 * CHARTS GENERATED:
 *   1. Gas per signature — TP configuration comparison (bar chart)
 *   2. Batch-size scaling — gas/sig by batch size (line chart)
 *   3. Profitability matrix — breakeven heatmap for GDN bounty (table grid)
 *   4. POL vs USDC gas comparison (horizontal bar)
 *   5. POL price sensitivity — viewer net profit/sig across scenarios (grouped bar)
 *   6. Lifecycle cost waterfall — one-time setup vs reward gas (stacked bar)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict'

const fs   = require('fs')
const path = require('path')

const INPUT_FILE  = path.join(__dirname, 'bcv2Baseline.json')
const OUTPUT_FILE = path.join(__dirname, 'bcv2Report.html')

// ── Protocol constants (must match CONFIG in BusinessCaseV2.js) ──────────────
// POL_PRICES / GAS_PRICES_GWEI are intentionally duplicated from
// CONFIG.polPricesUSD / CONFIG.gasPricesGwei so this generator has zero runtime deps
// on the test module — keep the two in sync when either changes.
const COMMISSION_PCT  = 5     // openAdvertsCommission
const POL_PRICES      = [0.08, 0.10, 0.25, 0.50, 1.00]
const GAS_PRICES_GWEI = [1, 30, 100, 200, 500]

// ── Load data ────────────────────────────────────────────────────────────────
if (!fs.existsSync(INPUT_FILE)) {
  console.error(`\n❌  ${INPUT_FILE} not found.`)
  console.error('    Run: npx hardhat test test/PreLaunchTesting/BusinessCaseV2.js\n')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'))

// Separate BCv1 (BEFORE/AFTER_MEMORY_REFACTOR) and BCv2 entries
const bcv1Before = data.filter(r => r.codeState === 'BEFORE_MEMORY_REFACTOR')
const bcv1After  = data.filter(r => r.codeState === 'AFTER_MEMORY_REFACTOR')
const bcv2       = data.filter(r => r.codeState === 'BCv2')

const processReward = bcv2.filter(r => r.type === 'processReward')
const lifecycle     = bcv2.filter(r => r.type === 'lifecycle')

if (processReward.length === 0) {
  console.error('\n❌  No BCv2 processReward entries found in bcv2Baseline.json.')
  console.error('    Run: npx hardhat test test/PreLaunchTesting/BusinessCaseV2.js\n')
  process.exit(1)
}

console.log(`\n📊 Loaded ${data.length} total entries (${processReward.length} processReward, ${lifecycle.length} lifecycle)`)

// ── Helper: compute net breakeven % grid ─────────────────────────────────────
function computeBreakevenGrid(grossBountyUSD, gasPerSig) {
  const grid = {}
  for (const polUSD of POL_PRICES) {
    grid[polUSD] = {}
    for (const gwei of GAS_PRICES_GWEI) {
      const gasCostUSD   = Number(gasPerSig) * gwei * 1e-9 * polUSD
      const netBountyUSD = grossBountyUSD * (1 - COMMISSION_PCT / 100)
      const breakevenPct = netBountyUSD > 0 ? (gasCostUSD / netBountyUSD) * 100 : Infinity
      grid[polUSD][gwei] = { gasCostUSD, breakevenPct }
    }
  }
  return grid
}

// ── Build chart data objects ──────────────────────────────────────────────────

// Chart 1: Gas/sig by TP configuration (20-sig batch)
const tpConfigs   = ['BCv2-POL-0TP-20', 'BCv2-POL-3U-20', 'BCv2-POL-3D-20', 'BCv2-POL-6U-20']
const tpLabels    = ['0-TP (floor)', '3-TP unique', '3-TP deduped', '6-TP unique']
const tpGasPerSig = tpConfigs.map(lbl => {
  const r = processReward.find(x => x.label === lbl)
  return r ? Number(r.gasPerSig) : null
})

// Chart 2: Batch-size scaling (3-TP unique)
const scalingEntries = processReward
  .filter(r => r.scenario && r.scenario.startsWith('3-TP-unique') && r.currency === 'POL')
  .sort((a, b) => a.sigCount - b.sigCount)
const scalingLabels   = scalingEntries.map(r => `${r.sigCount} sigs`)
const scalingGasPerSig = scalingEntries.map(r => Number(r.gasPerSig))
const scalingTotalGas  = scalingEntries.map(r => Number(r.gasUsed))

// Chart 3: POL vs USDC gas comparison
const polRef  = processReward.find(r => r.label === 'BCv2-POL-3U-20')
const usdcRef = processReward.find(r => r.label === 'BCv2-USDC-3U-20')

// Chart 4: POL price sensitivity — viewer profit/sig across POL prices
// Uses 3-TP-unique-20 as reference; viewer=50% (p3TP provider)
const VIEWER_PCT = 50
const BOUNTY_USD_AT_025 = 0.0025  // GDN level
function viewerNetProfitAtPolPrice(polUSD, gwei, gasPerSig) {
  const grossRev     = BOUNTY_USD_AT_025 * (polUSD / 0.25) * VIEWER_PCT / 100
  const gasCostUSD   = Number(gasPerSig) * gwei * 1e-9 * polUSD
  const commission   = BOUNTY_USD_AT_025 * (polUSD / 0.25) * COMMISSION_PCT / 100
  return grossRev - commission - gasCostUSD
}

const polSensData = {}
const refGasPerSig = polRef ? Number(polRef.gasPerSig) : 80_738
for (const gwei of GAS_PRICES_GWEI) {
  polSensData[gwei] = POL_PRICES.map(p => viewerNetProfitAtPolPrice(p, gwei, refGasPerSig))
}

// Chart 5 (Lifecycle): total setup gas vs reward gas per sig
const lifecycleData = lifecycle.map(l => ({ label: l.label, gas: Number(l.gasUsed) }))
const lifecycleTotalGas = lifecycle.reduce((s, l) => s + Number(l.gasUsed), 0)

// BCv1 vs BCv2 comparison (scenarios A & F for context)
const bcv1ABefore = bcv1Before.find(r => r.scenario === 'A')
const bcv1AAfter  = bcv1After.find(r => r.scenario === 'A')
const bcv1FBefore = bcv1Before.find(r => r.scenario === 'F')
const bcv1FAfter  = bcv1After.find(r => r.scenario === 'F')

// ── Breakeven heatmap data for GDN bounty ────────────────────────────────────
const heatmapGrid = polRef
  ? computeBreakevenGrid(BOUNTY_USD_AT_025, polRef.gasPerSig)
  : {}

// ── Build HTML ────────────────────────────────────────────────────────────────
function colorForBreakeven(pct) {
  if (pct === null || pct === Infinity) return '#e74c3c'
  if (pct < 20)  return '#27ae60'  // very profitable — green
  if (pct < 50)  return '#f39c12'  // marginal — orange
  if (pct < 100) return '#e67e22'  // tight
  return '#e74c3c'                  // unviable — red
}

// Safe JSON embedding
const safeJson = obj => JSON.stringify(obj).replace(/</g, '\\u003c')

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenAdverts Protocol — Business Case V2 Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #0f1117; color: #e2e8f0; padding: 24px; }
  h1   { font-size: 1.6rem; font-weight: 700; color: #a78bfa; margin-bottom: 4px; }
  h2   { font-size: 1.1rem; font-weight: 600; color: #7c3aed; margin: 32px 0 12px; letter-spacing:.04em; text-transform:uppercase; }
  h3   { font-size: .95rem; font-weight: 600; color: #94a3b8; margin-bottom: 8px; }
  .meta { font-size: .8rem; color: #64748b; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap: 24px; }
  .card { background: #1e2130; border-radius: 12px; padding: 20px; border: 1px solid #2d3148; }
  .card canvas { max-height: 320px; }
  .kpi-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .kpi { background: #1e2130; border-radius: 10px; padding: 16px 22px; border: 1px solid #2d3148; min-width: 160px; }
  .kpi-label { font-size: .72rem; color: #64748b; text-transform: uppercase; letter-spacing: .06em; }
  .kpi-value { font-size: 1.4rem; font-weight: 700; color: #a78bfa; margin-top: 4px; }
  .kpi-sub   { font-size: .75rem; color: #94a3b8; margin-top: 2px; }
  table  { border-collapse: collapse; font-size: .78rem; width: 100%; }
  th, td { padding: 7px 10px; text-align: right; border: 1px solid #2d3148; }
  th     { background: #262940; color: #94a3b8; font-weight: 600; text-align: center; }
  td.label { text-align: left; color: #94a3b8; font-weight: 500; }
  .tag-green  { background: #166534; color: #86efac; padding: 2px 8px; border-radius: 4px; font-size: .7rem; }
  .tag-orange { background: #78350f; color: #fcd34d; padding: 2px 8px; border-radius: 4px; font-size: .7rem; }
  .tag-red    { background: #7f1d1d; color: #fca5a5; padding: 2px 8px; border-radius: 4px; font-size: .7rem; }
  .note { font-size: .72rem; color: #64748b; margin-top: 10px; font-style: italic; }
  .section-sep { border: none; border-top: 1px solid #2d3148; margin: 36px 0; }
  footer { margin-top: 48px; font-size: .72rem; color: #475569; text-align: center; }
</style>
</head>
<body>

<h1>OpenAdverts Protocol — Business Case V2</h1>
<p class="meta">
  Generated: ${new Date().toISOString()} &nbsp;|&nbsp;
  Protocol commission: ${COMMISSION_PCT}% &nbsp;|&nbsp;
  Entries analysed: ${processReward.length} processReward + ${lifecycle.length} lifecycle
</p>

<!-- ── KPI row ─────────────────────────────────────────────────────────────── -->
<div class="kpi-row">
${polRef ? `
  <div class="kpi">
    <div class="kpi-label">Gas/sig (3-TP unique, 20 sigs)</div>
    <div class="kpi-value">${Number(polRef.gasPerSig).toLocaleString()}</div>
    <div class="kpi-sub">POL advert — post memory-refactor</div>
  </div>` : ''}
${usdcRef ? `
  <div class="kpi">
    <div class="kpi-label">Gas/sig (USDC, 3-TP unique)</div>
    <div class="kpi-value">${Number(usdcRef.gasPerSig).toLocaleString()}</div>
    <div class="kpi-sub">USDC advert vs POL: ${polRef ? (((Number(usdcRef.gasPerSig) - Number(polRef.gasPerSig)) / Number(polRef.gasPerSig) * 100).toFixed(1) + '% Δ') : '—'}</div>
  </div>` : ''}
${bcv1AAfter && bcv1ABefore ? `
  <div class="kpi">
    <div class="kpi-label">Memory refactor saving (20×3TP)</div>
    <div class="kpi-value">${((1 - Number(bcv1AAfter.gasUsed) / Number(bcv1ABefore.gasUsed)) * 100).toFixed(1)}%</div>
    <div class="kpi-sub">${Number(bcv1ABefore.gasUsed).toLocaleString()} → ${Number(bcv1AAfter.gasUsed).toLocaleString()}</div>
  </div>` : ''}
  <div class="kpi">
    <div class="kpi-label">Lifecycle setup gas</div>
    <div class="kpi-value">${lifecycleTotalGas.toLocaleString()}</div>
    <div class="kpi-sub">One-time per affiliate+advert pair</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Protocol commission</div>
    <div class="kpi-value">${COMMISSION_PCT}%</div>
    <div class="kpi-sub">Deducted from bounty before viewer revenue</div>
  </div>
</div>

<!-- ── Chart grid ──────────────────────────────────────────────────────────── -->
<h2>processReward Gas Analysis</h2>
<div class="grid">

  <!-- Chart 1: TP configuration comparison -->
  <div class="card">
    <h3>Gas per Signature — TP Configuration (20-sig batch, POL advert)</h3>
    <canvas id="chartTP"></canvas>
    <p class="note">Lower is better. Deduplication (shared TP addresses) achieves dramatic savings.</p>
  </div>

  <!-- Chart 2: Batch scaling -->
  <div class="card">
    <h3>Gas per Signature vs Batch Size (3-TP unique, POL advert)</h3>
    <canvas id="chartScaling"></canvas>
    <p class="note">Per-sig cost should remain roughly constant if batch overhead is well-amortised.</p>
  </div>

</div>

<div class="grid" style="margin-top:24px">

  <!-- Chart 3: POL vs USDC -->
  <div class="card">
    <h3>POL vs USDC processReward — Gas/sig (20 sigs × 3-TP unique)</h3>
    <canvas id="chartPOLvsUSDC"></canvas>
    <p class="note">USDC adds Chainlink oracle read + ERC-20 transfer overhead per signature.</p>
  </div>

  <!-- Chart 4: POL price sensitivity -->
  <div class="card">
    <h3>Viewer Net Profit/sig vs POL Price — GDN Bounty ($0.0025)</h3>
    <canvas id="chartPolSens"></canvas>
    <p class="note">Viewer claim=50%, commission=${COMMISSION_PCT}% deducted. Positive = profitable for viewer.</p>
  </div>

</div>

<!-- ── Profitability heatmap ───────────────────────────────────────────────── -->
<hr class="section-sep">
<h2>Profitability Heatmap — Breakeven Viewer Claim % (GDN Bounty, 3-TP unique)</h2>
<p class="note" style="margin-bottom:12px">
  Net breakeven = viewer claim % at which gas cost equals net bounty revenue (after ${COMMISSION_PCT}% commission).
  Green = any claim % profitable · Orange = need &gt;20% viewer claim · Red = unviable at that gas/POL price.
</p>

<div class="card" style="overflow-x:auto; margin-bottom:24px">
  <table>
    <thead>
      <tr>
        <th class="label">POL price ↓ &nbsp;/&nbsp; Gas price →</th>
        ${GAS_PRICES_GWEI.map(g => `<th>${g} gwei</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${POL_PRICES.map(p => {
        const row = heatmapGrid[p] || {}
        return `<tr>
          <td class="label">$${p.toFixed(2)} / POL</td>
          ${GAS_PRICES_GWEI.map(g => {
            const cell    = row[g] || {}
            const be      = cell.breakevenPct
            const beStr   = be === undefined  ? '—'
                          : be === Infinity   ? '∞'
                          : `${be.toFixed(1)}%`
            const tagCls  = be === undefined  ? ''
                          : be < 20           ? 'tag-green'
                          : be < 100          ? 'tag-orange'
                          : 'tag-red'
            const gasCost = cell.gasCostUSD !== undefined
              ? `$${cell.gasCostUSD.toFixed(5)}/sig` : ''
            return `<td title="${gasCost}"><span class="${tagCls}">${beStr}</span></td>`
          }).join('')}
        </tr>`
      }).join('')}
    </tbody>
  </table>
  <p class="note" style="margin-top:8px">Gas/sig reference: ${polRef ? Number(polRef.gasPerSig).toLocaleString() : 'N/A'} (BCv2-POL-3U-20). Hover for gas cost USD per sig.</p>
</div>

<!-- ── Lifecycle cost breakdown ────────────────────────────────────────────── -->
<hr class="section-sep">
<h2>Lifecycle Setup Cost — One-Time Gas per Affiliate + Advert Pair</h2>
<div class="grid">
  <div class="card">
    <h3>Setup Gas by Operation</h3>
    <canvas id="chartLifecycle"></canvas>
    <p class="note">
      Total setup: ${lifecycleTotalGas.toLocaleString()} gas.
      ${polRef ? `Amortised over 200 reward sigs: ${((lifecycleTotalGas + Number(polRef.gasPerSig) * 200) / 200).toFixed(0)} effective gas/sig.` : ''}
    </p>
  </div>
  <div class="card">
    <h3>Setup Gas Amortisation — Breakeven Sigs Required</h3>
    <canvas id="chartAmortise"></canvas>
    <p class="note">How many processReward signatures fully amortise the setup gas cost.</p>
  </div>
</div>

<!-- ── BCv1 comparison ─────────────────────────────────────────────────────── -->
${(bcv1ABefore && bcv1AAfter) ? `
<hr class="section-sep">
<h2>Historical Comparison — Memory Refactor Impact (BCv1 Benchmark)</h2>
<div class="card" style="overflow-x:auto; max-width:700px">
  <table>
    <thead>
      <tr><th>Scenario</th><th>Description</th><th>Before refactor</th><th>After refactor</th><th>Saving</th></tr>
    </thead>
    <tbody>
      ${['A','B','C','D','F'].map(s => {
        const b = bcv1Before.find(r => r.scenario === s)
        const a = bcv1After.find(r => r.scenario === s)
        if (!b || !a) return ''
        const bGas = b.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT' ? 'OOG' : Number(b.gasUsed).toLocaleString()
        const aGas = a.gasUsed === 'EXCEEDED_BLOCK_GAS_LIMIT' ? 'OOG' : Number(a.gasUsed).toLocaleString()
        let saving = '—'
        if (b.gasUsed !== 'EXCEEDED_BLOCK_GAS_LIMIT' && a.gasUsed !== 'EXCEEDED_BLOCK_GAS_LIMIT') {
          saving = ((1 - Number(a.gasUsed) / Number(b.gasUsed)) * 100).toFixed(1) + '%'
        }
        return `<tr>
          <td class="label">${s}</td>
          <td class="label" style="font-size:.72rem">${b.description}</td>
          <td>${bGas}</td><td>${aGas}</td>
          <td style="color:#86efac;font-weight:600">${saving}</td>
        </tr>`
      }).join('')}
    </tbody>
  </table>
</div>` : ''}

<footer>
  OpenAdverts Protocol — Business Case V2 Report &nbsp;|&nbsp;
  Generated by test/GasBenchmark/generateReport.js &nbsp;|&nbsp;
  Data source: bcv2Baseline.json
</footer>

<script>
// ── Shared chart defaults ─────────────────────────────────────────────────────
Chart.defaults.color          = '#94a3b8'
Chart.defaults.borderColor    = '#2d3148'
Chart.defaults.font.family    = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
Chart.defaults.font.size      = 12

const PURPLE = 'rgba(124,58,237,0.85)'
const VIOLET = 'rgba(167,139,250,0.85)'
const TEAL   = 'rgba(45,212,191,0.85)'
const AMBER  = 'rgba(251,191,36,0.85)'
const RED    = 'rgba(239,68,68,0.85)'
const SLATE  = 'rgba(100,116,139,0.5)'

// Chart 1 – TP configuration
new Chart(document.getElementById('chartTP'), {
  type: 'bar',
  data: {
    labels: ${safeJson(tpLabels)},
    datasets: [{
      label: 'Gas per signature',
      data: ${safeJson(tpGasPerSig)},
      backgroundColor: [TEAL, PURPLE, VIOLET, AMBER],
      borderRadius: 6,
    }]
  },
  options: {
    plugins: { legend: { display: false } },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'Gas units' } },
      x: { title: { display: true, text: 'TP configuration (20-sig batch)' } }
    }
  }
})

// Chart 2 – Batch scaling
new Chart(document.getElementById('chartScaling'), {
  type: 'line',
  data: {
    labels: ${safeJson(scalingLabels)},
    datasets: [
      {
        label: 'Gas per signature',
        data: ${safeJson(scalingGasPerSig)},
        borderColor: PURPLE, backgroundColor: 'rgba(124,58,237,0.15)',
        tension: 0.3, pointRadius: 5, yAxisID: 'y',
      },
      {
        label: 'Total gas',
        data: ${safeJson(scalingTotalGas)},
        borderColor: AMBER, backgroundColor: 'rgba(251,191,36,0.08)',
        tension: 0.3, pointRadius: 5, borderDash: [5,3], yAxisID: 'y2',
      }
    ]
  },
  options: {
    scales: {
      y:  { beginAtZero: false, title: { display: true, text: 'Gas / sig' }, position: 'left' },
      y2: { beginAtZero: false, title: { display: true, text: 'Total gas' }, position: 'right', grid: { drawOnChartArea: false } }
    }
  }
})

// Chart 3 – POL vs USDC
${(polRef && usdcRef) ? `
new Chart(document.getElementById('chartPOLvsUSDC'), {
  type: 'bar',
  data: {
    labels: ['POL advert', 'USDC advert'],
    datasets: [{
      label: 'Gas per signature (20 sigs × 3-TP unique)',
      data: [${Number(polRef.gasPerSig)}, ${Number(usdcRef.gasPerSig)}],
      backgroundColor: [PURPLE, TEAL],
      borderRadius: 6,
    }]
  },
  options: {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { beginAtZero: true, title: { display: true, text: 'Gas per signature' } } }
  }
})` : `document.getElementById('chartPOLvsUSDC').parentElement.style.opacity='0.4'`}

// Chart 4 – POL sensitivity
new Chart(document.getElementById('chartPolSens'), {
  type: 'bar',
  data: {
    labels: ${safeJson(POL_PRICES.map(p => '$' + p.toFixed(2)))},
    datasets: ${safeJson(GAS_PRICES_GWEI.map((gwei, i) => ({
      label: `@${gwei} gwei`,
      data: POL_PRICES.map(p => {
        const gross   = BOUNTY_USD_AT_025 * (p / 0.25) * VIEWER_PCT / 100
        const gasCost = refGasPerSig * gwei * 1e-9 * p
        const comm    = BOUNTY_USD_AT_025 * (p / 0.25) * COMMISSION_PCT / 100
        return +(gross - comm - gasCost).toFixed(6)
      }),
      backgroundColor: ['rgba(45,212,191,0.8)', 'rgba(124,58,237,0.8)', 'rgba(251,191,36,0.8)', 'rgba(239,68,68,0.8)'][i],
      borderRadius: 4,
    })))},
  },
  options: {
    scales: {
      y: { title: { display: true, text: 'Net profit/sig (USD)' } },
      x: { title: { display: true, text: 'POL price (USD)' } }
    }
  }
})

// Chart 5 – Lifecycle
${lifecycle.length > 0 ? `
const lifecycleLabels = ${safeJson(lifecycleData.map(l => l.label.replace(/_/g,' ')))};
const lifecycleGas    = ${safeJson(lifecycleData.map(l => l.gas))};
new Chart(document.getElementById('chartLifecycle'), {
  type: 'bar',
  data: {
    labels: lifecycleLabels,
    datasets: [{
      label: 'Gas used',
      data: lifecycleGas,
      backgroundColor: VIOLET,
      borderRadius: 6,
    }]
  },
  options: {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { beginAtZero: true, title: { display: true, text: 'Gas units' } } }
  }
})

// Chart 6 – Amortisation
const rewardGasPerSig = ${polRef ? Number(polRef.gasPerSig) : 80738}
const totalSetup      = ${lifecycleTotalGas}
const amortSigCounts  = [1, 5, 10, 20, 50, 100, 200]
new Chart(document.getElementById('chartAmortise'), {
  type: 'line',
  data: {
    labels: amortSigCounts.map(n => n + ' sigs'),
    datasets: [
      {
        label: 'Effective gas/sig (incl. setup)',
        data: amortSigCounts.map(n => Math.round((totalSetup + rewardGasPerSig * n) / n)),
        borderColor: PURPLE, backgroundColor: 'rgba(124,58,237,0.12)',
        tension: 0.4, pointRadius: 4,
      },
      {
        label: 'processReward gas/sig only',
        data: amortSigCounts.map(() => rewardGasPerSig),
        borderColor: TEAL, borderDash: [5,3],
        tension: 0, pointRadius: 0,
      }
    ]
  },
  options: {
    scales: {
      y: { beginAtZero: false, title: { display: true, text: 'Effective gas / sig' } }
    }
  }
})` : `
document.getElementById('chartLifecycle').parentElement.style.opacity='0.3'
document.getElementById('chartAmortise').parentElement.style.opacity='0.3'
`}

</script>
</body>
</html>`

fs.writeFileSync(OUTPUT_FILE, html, 'utf8')
console.log(`\n✅ Report written to: ${OUTPUT_FILE}`)
console.log('   Open in a browser — no server needed, all data is embedded inline.\n')
