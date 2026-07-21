/**
 * STEP 0 — dev-kiosk prompt-live smoke check (Mono V2 coverage suite handover).
 *
 * Purpose: verify Eddie's updated §1 prompt is LIVE on dev-kiosk BEFORE running the
 * full prompt-coverage suite. Asks the 2 known preamble-prone battery questions and
 * captures the raw answer opening. Grading (does it still open with a framing
 * preamble?) is done outside Cypress from the answers JSON this writes.
 *
 * Reuses the proven dev-kiosk harness from staging-backend-stage-table-20q.cy.js:
 * login + Basic Auth, ORIGIN env handling, Stage-table answer extraction
 * (extractLlmAnswerText), placeholder guard, TABLE_WAIT_MS, page-reload between Qs.
 * The existing 20q spec is left untouched (guardrail 2).
 *
 * Run (dev-kiosk):
 *   env -u ELECTRON_RUN_AS_NODE \
 *     CYPRESS_BASE_URL=https://dev-kiosk.entwickler.de \
 *     CYPRESS_LOGIN_URL=https://dev-kiosk.entwickler.de/login/ \
 *     CYPRESS_APP_ORIGIN=https://dev-kiosk.entwickler.de \
 *     CYPRESS_USE_BASIC_AUTH=true CYPRESS_AUTH_USERNAME=tester CYPRESS_AUTH_PASSWORD=thisissandstesting \
 *     CYPRESS_RUN_USER=step0-smoke \
 *     ./node_modules/.bin/cypress run --browser chrome --spec 'cypress/e2e/dev-kiosk-step0-smoke.cy.js'
 */

const ORIGIN = String(
  Cypress.env('APP_ORIGIN') || Cypress.config('baseUrl') || 'https://dev-kiosk.entwickler.de'
).replace(/\/$/, '')

const RUN_CONFIG = {
  user: Cypress.env('RUN_USER') || 'step0-smoke',
  // The 2 known preamble-prone questions, VERBATIM (guardrail 3 — typos incl. the
  // doubled "What is What is"). Q01 opened "Introduction —" and Q13 opened
  // "Einleitung —" on the 2026-07-07 pre-fix rerank run; if Eddie's §1 edit is live,
  // both should now start with the direct answer.
  questions: [
    'What is What is the difference between unit, integration, and end-to-end tests?',
    'Erkläre alle wichtigen Design Patterns aus dem Gang-of-Four-Buch mit Beispielen in Java oder TypeScript.'
  ]
}

const {
  extractBackendStageTableFromDom,
  backendStageTableDomReady,
  extractLlmAnswerText,
  getConversationDisplayText,
  conversationAnswerPending,
  extractAnswerFromConversation
} = require('../support/staging-backend-stage-dom')
const { slugForFilename } = require('../support/staging-backend-stage-parsers')

const REPORT_DIR = 'cypress/reports'

const TABLE_WAIT_MS = (() => {
  const raw = Cypress.env('TABLE_WAIT_MS')
  const n = raw != null && raw !== '' ? parseInt(String(raw), 10) : NaN
  return !Number.isNaN(n) && n > 0 ? n : 300000
})()

let reportTimestamp = ''

function answersFilename() {
  return `step0-smoke-${slugForFilename(RUN_CONFIG.user)}-${reportTimestamp}.json`
}

function persistAnswersJson(runs) {
  if (!reportTimestamp || !runs.length) return cy.wrap(null, { log: false })
  const payload = {
    meta: {
      purpose: 'STEP 0 — verify Eddie §1 prompt live on dev-kiosk (preamble gate)',
      user: RUN_CONFIG.user,
      origin: ORIGIN,
      timestamp: reportTimestamp,
      count: runs.length
    },
    answers: runs.map((entry, i) => ({
      index: i + 1,
      question: entry.question,
      answerText: entry.answerText != null ? entry.answerText : '',
      answerLength: entry.answerLength,
      stageRows: entry.rows ? entry.rows.length : 0
    }))
  }
  const data = JSON.stringify(payload, null, 2) + '\n'
  const filename = answersFilename()
  return cy.task('writeReport', { data, filename }).then(() => `${REPORT_DIR}/${filename}`)
}

describe(
  'STEP 0 — dev-kiosk prompt-live smoke (2 preamble-prone questions)',
  { testIsolation: false, timeout: 3600000 },
  () => {
    /** @type {Array<{question: string, rows: Array, answerLength: number, answerText: string}>} */
    const runs = []

    before(() => {
      Cypress.config('baseUrl', ORIGIN)
      Cypress.env('APP_ORIGIN', ORIGIN)
      reportTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
      cy.log(`STEP 0 origin: ${ORIGIN} | user: ${RUN_CONFIG.user} | questions: ${RUN_CONFIG.questions.length}`)
      cy.authLogin()
      cy.userLogin()
      cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
      cy.waitForComposerTextareaReady({ timeout: 30000 })
    })

    after(() => {
      cy.then(() =>
        persistAnswersJson(runs).then((p) => {
          if (p) cy.log(`STEP0 ANSWERS: ${Cypress.config('projectRoot')}/${p}`)
        })
      )
    })

    RUN_CONFIG.questions.forEach((question, index) => {
      const labelShort = question.length > 60 ? question.slice(0, 57) + '…' : question
      it(`Q${String(index + 1).padStart(2, '0')}/${RUN_CONFIG.questions.length} — ${labelShort}`, () => {
        // Full page reload between questions (not the new-chat UI click) — isolates each
        // question, same as the 20q spec.
        if (index > 0) {
          cy.visitWithAuth(`${ORIGIN}/reader/intelligence`)
          cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
          cy.waitForComposerTextareaReady({ timeout: 120000 })
        }

        cy.waitForComposerTextareaReady({ timeout: 180000 })
        cy.getChatInput().clear().type(question, { force: true })
        cy.waitForComposerSendEnabled()
        cy.getComposerSendButton().filter(':visible').first().click()
        cy.waitForComposerReadyForNewQuestion({ timeout: 600000 })

        const answerDeadline = Date.now() + TABLE_WAIT_MS
        let lastConv = ''
        let stableTicks = 0
        const pollAnswerReady = () =>
          cy.document({ log: false }).then((doc) => {
            if (backendStageTableDomReady(doc.body).ready) return 'stage'
            const conv = getConversationDisplayText(doc.body)
            const streaming = conversationAnswerPending(doc.body)
            if (!streaming && conv.length > 50 && conv === lastConv) stableTicks += 1
            else stableTicks = 0
            lastConv = conv
            if (!streaming && stableTicks >= 3) return 'conversation'
            if (Date.now() > answerDeadline) return 'timeout'
            return cy.wait(2000, { log: false }).then(pollAnswerReady)
          })

        cy.then(pollAnswerReady).then((mode) => {
          cy.document().then((doc) => {
            const rows = extractBackendStageTableFromDom(doc.body)
            const answerText =
              rows.length > 0
                ? extractLlmAnswerText(doc.body)
                : extractAnswerFromConversation(doc.body, question)
            const trimmed = (answerText || '').trim()
            const placeholderOnly =
              trimmed.length < 40 || /^(Denke nach|Formuliere Antwort)/i.test(trimmed)
            if (placeholderOnly) {
              throw new Error(
                `Q${index + 1}: answer not ready / placeholder only (mode=${mode}, stageRows=${rows.length}, len=${trimmed.length})`
              )
            }
            // eslint-disable-next-line no-console
            cy.log(`Q${index + 1} opening: ${trimmed.slice(0, 120)}`)
            runs.push({ question, rows, answerLength: answerText.length, answerText })
            return persistAnswersJson(runs)
          })
        })
      })
    })
  }
)
