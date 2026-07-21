/**
 * Compare two regraded coverage runs per group/question.
 * Usage: node scripts/coverage-compare.js <baseline.regraded.json> <new.regraded.json>
 *
 * Matches questions by index (both runs use the same STEPS order). For each check it
 * reports flips: FAIL->PASS (fixed), PASS->FAIL (regression), and any other verdict
 * change. Summarizes per group and highlights G6 language flip-rate delta.
 */
const fs = require('fs')
const base = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const neu = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))

const bById = {}
for (const r of base.results) bById[r.index] = r

const order = ['1-preamble', '2-nomatch', '3-clarify', '4-secrecy', '5-markers', '6-language', '7-followup', '8-usercontext', '9-hallucination', '10-multiturn']
const rank = (g) => { const i = order.indexOf(g); return i < 0 ? 99 : i }

const rows = []          // {group, index, question, check, from, to, kind}
for (const n of neu.results) {
  const b = bById[n.index]
  if (!b) { rows.push({ group: n.group, index: n.index, question: n.question, check: '(no baseline)', from: '-', to: '-', kind: 'new' }); continue }
  const checks = new Set([...Object.keys(b.checks || {}), ...Object.keys(n.checks || {})])
  for (const c of checks) {
    const from = (b.checks || {})[c] || 'MISSING'
    const to = (n.checks || {})[c] || 'MISSING'
    if (from === to) continue
    let kind = 'changed'
    if (from === 'FAIL' && to === 'PASS') kind = 'FIXED'
    else if (from === 'PASS' && to === 'FAIL') kind = 'REGRESSED'
    rows.push({ group: n.group, index: n.index, question: n.question, check: c, from, to, kind })
  }
}

// Per-group summary
const groups = {}
for (const n of neu.results) {
  const g = (groups[n.group] = groups[n.group] || { fixed: 0, regressed: 0, changed: 0, nQ: 0 })
  g.nQ += 1
}
for (const r of rows) {
  const g = groups[r.group]; if (!g) continue
  if (r.kind === 'FIXED') g.fixed += 1
  else if (r.kind === 'REGRESSED') g.regressed += 1
  else g.changed += 1
}

console.log('BASELINE:', base.meta.user, base.meta.timestamp, '  vs  NEW:', neu.meta.user, neu.meta.timestamp)
console.log('='.repeat(80))
for (const g of Object.keys(groups).sort((a, b) => rank(a) - rank(b))) {
  const s = groups[g]
  const tag = s.fixed || s.regressed || s.changed ? `  fixed:${s.fixed} regressed:${s.regressed} other:${s.changed}` : '  (no change)'
  console.log(`\n### ${g} (n=${s.nQ})${tag}`)
  for (const r of rows.filter((x) => x.group === g)) {
    const mark = r.kind === 'FIXED' ? '✅ FIXED' : r.kind === 'REGRESSED' ? '❌ REGRESSED' : '· changed'
    console.log(`   ${mark}  #${r.index} ${r.check}: ${r.from} -> ${r.to}`)
    console.log(`        "${(r.question || '').slice(0, 60).replace(/\n/g, ' ')}"`)
  }
}

// G6 language flip-rate delta
function flipRate(run) {
  const g6 = run.results.filter((r) => r.group === '6-language')
  const nonDe = g6.filter((r) => (r.checks || {}).languageMatches !== 'PASS').length
  return { nonDe, n: g6.length, langs: g6.map((r) => r.lang || ((r.checks || {}).languageMatches === 'PASS' ? 'de' : '?')) }
}
const bf = flipRate(base), nf = flipRate(neu)
console.log('\n' + '='.repeat(80))
console.log(`G6 language flip: baseline ${bf.nonDe}/${bf.n} (${bf.langs.join(',')})  ->  v2 ${nf.nonDe}/${nf.n} (${nf.langs.join(',')})`)

const totalFixed = rows.filter((r) => r.kind === 'FIXED').length
const totalReg = rows.filter((r) => r.kind === 'REGRESSED').length
console.log(`\nTOTAL check-level: FIXED=${totalFixed}  REGRESSED=${totalReg}  other-changes=${rows.filter((r) => r.kind === 'changed').length}`)
