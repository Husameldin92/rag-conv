const STAGING_ORIGIN = 'https://staging.entwickler.de'

// =============================================================================
// Change these before you run
// =============================================================================
const RUN_CONFIG = {
  /** Label for the CSV*/
  user: 'Short LLM Answer',

  /** Question sent on every run */
  question: 'Erkläre Reactive Programming mit RxJS in Angular: Observables, Subjects, Operators und Best Practices.',

  /** How many times to ask the same question*/
  runCount: 1
}
// npm run test:staging-backend-stage:chrome
// =============================================================================

const { extractBackendStageTableFromDom, backendStageTableDomReady, extractLlmAnswerText } = require('../support/staging-backend-stage-dom')
const { backendStageReportToCsv, slugForFilename } = require('../support/staging-backend-stage-parsers')

const REPORT_DIR = 'cypress/reports'

const runCount = Math.min(100, Math.max(1, parseInt(String(RUN_CONFIG.runCount), 10) || 1))

/** Wait for Stage table (slow accounts / long chat history may need longer). */
const TABLE_WAIT_MS = 120000

/** Set in `before()` — must live here so helpers outside `describe` can read it. */
let reportTimestamp = ''

function reportFilename() {
  return `backend-stage-${slugForFilename(RUN_CONFIG.user)}-${reportTimestamp}.csv`
}

/** Save CSV whenever we have at least one run (also after failures / partial progress). */
function persistReportCsv(runs) {
  if (!reportTimestamp || !runs.length) {
    return cy.wrap(null, { log: false })
  }
  const data = backendStageReportToCsv({
    user: RUN_CONFIG.user,
    question: RUN_CONFIG.question,
    runs
  })
  const filename = reportFilename()
  return cy
    .task('writeReport', { data, filename })
    .then(() => `${REPORT_DIR}/${filename}`)
}

describe('Staging — backend Stage table → CSV', { testIsolation: false, timeout: 7200000 }, () => {
  /** @type {Array<{ rows: Array<{ STAGE: string, TIMESTAMP: string, 'DELTA (MS)': string }> }>} */
  let runs = []

  before(() => {
    Cypress.config('baseUrl', STAGING_ORIGIN)
    Cypress.env('APP_ORIGIN', STAGING_ORIGIN)
    reportTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)

    cy.authLogin()
    cy.userLogin()
    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    cy.waitForComposerTextareaReady({ timeout: 30000 })
  })

  afterEach(function () {
    if (runs.length) {
      persistReportCsv(runs)
    }
  })

  after(() => {
    cy.then(() =>
      persistReportCsv(runs).then((csvPath) => {
        if (csvPath) {
          cy.log(
            `CSV: ${Cypress.config('projectRoot')}/${csvPath} | user=${RUN_CONFIG.user} | runs=${runs.length}`
          )
        }
      })
    )
  })

  for (let index = 0; index < runCount; index++) {
    it(`Run ${index + 1}/${runCount} — ${RUN_CONFIG.user}`, () => {
      if (runCount > 1 && index > 0) {
        cy.get('.new-file-open-icon', { timeout: 30000 }).should('be.visible').click()
        cy.get('.nav-text', { timeout: 15000 }).filter(':visible').first().should('be.visible').click()
        cy.waitForComposerTextareaReady({ timeout: 120000 })
      }

      cy.waitForComposerTextareaReady({ timeout: 180000 })
      cy.getChatInput().clear().type(RUN_CONFIG.question, { force: true })
      cy.waitForComposerSendEnabled()
      cy.getComposerSendButton().filter(':visible').first().click()
      cy.waitForComposerReadyForNewQuestion({ timeout: 600000 })

      cy.document({ timeout: TABLE_WAIT_MS }).should((doc) => {
        const check = backendStageTableDomReady(doc.body)
        if (!check.ready) {
          const stages = check.rows.map((r) => r.STAGE).join(' | ') || '(none)'
          throw new Error(
            `Run ${index + 1}: Stage table not ready after ${TABLE_WAIT_MS}ms — rows=${check.rowCount}; found: ${stages}`
          )
        }
      })

      cy.document().then((doc) => {
        const rows = extractBackendStageTableFromDom(doc.body)
        expect(rows.length, `Run ${index + 1}: row count`).to.be.greaterThan(0)
        const answerText = extractLlmAnswerText(doc.body)
        runs.push({ rows, answerLength: answerText.length })
        return persistReportCsv(runs)
      })
    })
  }
})
