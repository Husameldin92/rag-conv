/**
 * CSV export for the backend Stage table (rows come from {@link ./staging-backend-stage-dom.js}).
 */

const BACKEND_STAGE_CSV_HEADER = 'STAGE,TIMESTAMP,DELTA (MS)'

function escapeCsv(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * @param {Array<{ STAGE: string, TIMESTAMP: string, 'DELTA (MS)': string }>} rows
 */
function backendStageRowsToCsv(rows) {
  const lines = [BACKEND_STAGE_CSV_HEADER]
  for (const r of rows) {
    lines.push(
      [escapeCsv(r.STAGE), escapeCsv(r.TIMESTAMP), escapeCsv(r['DELTA (MS)'])].join(',')
    )
  }
  return lines.join('\n')
}

/**
 * Full report: user + question + Run 1 / Run 2 / … each with the Stage table.
 * @param {{ user: string, question: string, runs: Array<{ rows: Array<{ STAGE: string, TIMESTAMP: string, 'DELTA (MS)': string }> }> }} report
 */
function backendStageReportToCsv(report) {
  const lines = [
    `User,${escapeCsv(report.user)}`,
    `Question,${escapeCsv(report.question)}`,
    ''
  ]

  report.runs.forEach((run, index) => {
    if (index > 0) lines.push('')
    lines.push(`Run ${index + 1}`)
    if (run.answerLength != null) {
      lines.push(`Answer Length,${escapeCsv(String(run.answerLength))}`)
    }
    lines.push(BACKEND_STAGE_CSV_HEADER)
    for (const r of run.rows) {
      lines.push(
        [escapeCsv(r.STAGE), escapeCsv(r.TIMESTAMP), escapeCsv(r['DELTA (MS)'])].join(',')
      )
    }
  })

  return lines.join('\n')
}

function slugForFilename(value) {
  const s = String(value || 'user')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'user'
}

module.exports = {
  backendStageRowsToCsv,
  backendStageReportToCsv,
  slugForFilename,
  BACKEND_STAGE_CSV_HEADER
}
