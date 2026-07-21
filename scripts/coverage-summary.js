/**
 * Summarize a coverage-answers-*.json into a per-group pass/fail matrix.
 * Usage: node scripts/coverage-summary.js cypress/reports/coverage-answers-<...>.json
 *
 * Prints, per group: total questions, and for each check name the PASS/FAIL/MANUAL/NA
 * tally. Then a flat per-question verdict list. Group 6 also reports the language
 * flip rate (how many of the 10 runs were NOT German).
 */
const fs = require('fs')
const path = process.argv[2]
if (!path) { console.error('usage: node scripts/coverage-summary.js <coverage-answers.json>'); process.exit(1) }
const d = JSON.parse(fs.readFileSync(path, 'utf8'))
const results = d.results || []

// Group → check → {PASS,FAIL,MANUAL,NA}
const groups = {}
for (const r of results) {
  const g = (groups[r.group] = groups[r.group] || { n: 0, checks: {}, questions: [] })
  g.n += 1
  g.questions.push(r)
  for (const [k, val] of Object.entries(r.checks || {})) {
    const c = (g.checks[k] = g.checks[k] || { PASS: 0, FAIL: 0, MANUAL: 0, NA: 0 })
    if (c[val] == null) c[val] = 0
    c[val] += 1
  }
}

console.log('meta:', JSON.stringify(d.meta))
console.log('total questions:', results.length)
console.log('='.repeat(78))

const order = ['1-preamble', '2-nomatch', '3-clarify', '4-secrecy', '5-markers', '6-language', '7-followup', '8-usercontext', '9-hallucination', '10-multiturn']
const groupNames = Object.keys(groups).sort((a, b) => (order.indexOf(a) - order.indexOf(b)))

let overallFail = 0
for (const gn of groupNames) {
  const g = groups[gn]
  console.log(`\n### ${gn}  (n=${g.n})`)
  for (const [check, c] of Object.entries(g.checks)) {
    const parts = ['PASS', 'FAIL', 'MANUAL', 'NA'].filter((k) => c[k]).map((k) => `${k}:${c[k]}`)
    const flag = c.FAIL ? '  <-- FAIL' : ''
    overallFail += c.FAIL || 0
    console.log(`   ${check.padEnd(26)} ${parts.join('  ')}${flag}`)
  }
  // per-question one-liners
  for (const r of g.questions) {
    const verd = Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(' ')
    const q = (r.question || '').slice(0, 46).replace(/\n/g, ' ')
    console.log(`     - "${q}${r.question.length > 46 ? '…' : ''}"  [${verd}]  ${r.notes ? '(' + r.notes.slice(0, 60) + ')' : ''}`)
  }
}

// Group 6 language flip rate
const g6 = groups['6-language']
if (g6) {
  const langs = g6.questions.map((r) => r.lang || (r.checks.languageMatches === 'PASS' ? 'de' : '?'))
  const nonDe = g6.questions.filter((r) => r.checks.languageMatches !== 'PASS').length
  console.log(`\n### 6-language flip rate: ${nonDe}/${g6.n} runs NOT German  (langs: ${langs.join(',')})`)
}

console.log('\n' + '='.repeat(78))
console.log(`OVERALL mechanical FAILs across all groups: ${overallFail}`)
console.log('(MANUAL = Cowork grades; NA = check not applicable to that answer)')
