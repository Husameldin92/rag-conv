/**
 * Offline (re-)grade a coverage-answers-*.json using the CURRENT graders in
 * cypress/support/coverage-assertions.js, against the stored rawText (fallback
 * renderedText). Grading is decoupled from capture, so grader refinements don't
 * require re-running Cypress. Writes <input>.regraded.json and prints the matrix.
 *
 * Usage: node scripts/coverage-regrade.js cypress/reports/coverage-answers-<...>.json [splitDir]
 */
const fs = require('fs')
const pathMod = require('path')
const A = require('../cypress/support/coverage-assertions')

const inPath = process.argv[2]
const splitDir = process.argv[3]
if (!inPath) { console.error('usage: node scripts/coverage-regrade.js <answers.json> [splitDir]'); process.exit(1) }
const d = JSON.parse(fs.readFileSync(inPath, 'utf8'))

function gradeFor(r) {
  const raw = (r.rawText && r.rawText.length > 20) ? r.rawText : (r.renderedText || '')
  switch (r.group) {
    case '1-preamble': return A.gradePreamble(raw)
    case '2-nomatch': return A.gradeNoMatch(raw)
    case '3-clarify': return A.gradeClarify(raw)
    case '4-secrecy': return A.gradeSecrecy(raw)
    case '5-markers': return A.gradeMarkers(raw)
    case '6-language': return A.gradeLanguage(raw, 'de')
    case '7-followup': return A.gradeFollowup(raw)
    case '8-usercontext': return A.gradeUserContext(raw)
    case '9-hallucination': return A.gradeHallucination(raw)
    case '10-multiturn': return /turn2/i.test(r.label || '') ? A.gradeMultiTurn2(raw) : A.gradePreamble(raw)
    default: return { checks: {}, notes: 'no grader' }
  }
}

for (const r of d.results) {
  const raw = (r.rawText && r.rawText.length > 20) ? r.rawText : (r.renderedText || '')
  const hung = (!r.rawText || r.rawText.length < 20) && (!r.renderedText || r.renderedText.trim().length < 40)
  if (hung) { r.checks = { answered: 'FAIL' }; r.notes = 'HUNG/empty answer'; continue }
  const g = gradeFor(r)
  // v3 policy: the "no citations in conclusion / follow-up" rule applies to EVERY answer.
  const cs = A.gradeCitationSections(raw)
  r.checks = { ...g.checks, ...cs.checks }
  r.notes = g.notes + ' || ' + cs.notes
  if (g.lang) r.lang = g.lang
}

const outPath = inPath.replace(/\.json$/, '.regraded.json')
fs.writeFileSync(outPath, JSON.stringify(d, null, 2) + '\n')
console.log('wrote', outPath)

// Split per-group files for downstream review.
if (splitDir) {
  if (!fs.existsSync(splitDir)) fs.mkdirSync(splitDir, { recursive: true })
  const byGroup = {}
  for (const r of d.results) (byGroup[r.group] = byGroup[r.group] || []).push(r)
  for (const [g, arr] of Object.entries(byGroup)) {
    fs.writeFileSync(pathMod.join(splitDir, `${g}.json`), JSON.stringify(arr, null, 2) + '\n')
  }
  console.log('split', Object.keys(byGroup).length, 'group files ->', splitDir)
}
