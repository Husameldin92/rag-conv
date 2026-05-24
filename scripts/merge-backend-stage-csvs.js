/**
 * Merges all backend-stage-*.csv files in cypress/reports/ into one file.
 *
 * Usage:
 *   node scripts/merge-backend-stage-csvs.js
 *
 * Output: cypress/reports/backend-stage-MERGED-<timestamp>.csv
 *
 * Nothing is deleted or modified — source files are left untouched.
 */

const fs = require('fs')
const path = require('path')

const REPORTS_DIR = path.join(__dirname, '..', 'cypress', 'reports')
const MERGED_PREFIX = 'backend-stage-MERGED-'

// Find all backend-stage CSVs, excluding previously merged files, sorted by filename (= chronological)
const files = fs
  .readdirSync(REPORTS_DIR)
  .filter((f) => f.startsWith('backend-stage-') && f.endsWith('.csv') && !f.startsWith(MERGED_PREFIX))
  .sort()

if (!files.length) {
  console.error('No backend-stage-*.csv files found in', REPORTS_DIR)
  process.exit(1)
}

console.log(`Found ${files.length} file(s) to merge:`)
files.forEach((f) => console.log(' •', f))

const sections = files.map((f) => fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8').trimEnd())

const merged = sections.join('\n\n') + '\n'

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
const outFile = path.join(REPORTS_DIR, `${MERGED_PREFIX}${timestamp}.csv`)

fs.writeFileSync(outFile, merged, 'utf8')

console.log(`\nMerged into: ${outFile}`)
console.log(`Total size: ${merged.length} characters`)
