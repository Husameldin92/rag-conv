/**
 * dev-kiosk — G8 userContext REPEATS (extra samples for the ID-leak question).
 *
 * The internal-ID leak in the userContext answers was non-deterministic (1 of 2 in v2),
 * so this runs the two G8 questions 3 more times EACH (6 answers), labeled
 * g8-repeat-1/2/3, to get enough samples to call the leak fixed or not. Reuses the same
 * capture (coverage-capture) and harness as dev-kiosk-prompt-coverage.cy.js; that main
 * spec is left unchanged.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE CYPRESS_BASE_URL=... CYPRESS_APP_ORIGIN=... \
 *   CYPRESS_USE_BASIC_AUTH=true CYPRESS_AUTH_USERNAME=tester CYPRESS_AUTH_PASSWORD=thisissandstesting \
 *   CYPRESS_RUN_USER=v3-g8repeat ./node_modules/.bin/cypress run --browser chrome \
 *   --spec 'cypress/e2e/dev-kiosk-g8-repeat.cy.js'
 */

const ORIGIN = String(
  Cypress.env('APP_ORIGIN') || Cypress.config('baseUrl') || 'https://dev-kiosk.entwickler.de'
).replace(/\/$/, '')
const RUN_USER = Cypress.env('RUN_USER') || 'v3-g8repeat'

const { installFetchTap, parseSSE } = require('../support/coverage-capture')
const {
  extractBackendStageTableFromDom,
  backendStageTableDomReady,
  extractLlmAnswerText,
  getConversationDisplayText,
  conversationAnswerPending,
  extractAnswerFromConversation
} = require('../support/staging-backend-stage-dom')
const { slugForFilename } = require('../support/staging-backend-stage-parsers')

Cypress.on('window:before:load', installFetchTap)

const REPORT_DIR = 'cypress/reports'
const TABLE_WAIT_MS = 300000

const G8_QUESTIONS = [
  'Ich bin Backend-Entwickler. Zeig mir passende Tutorials.',
  "I'm a backend developer. Show me relevant tutorials."
]
// 2 questions × 3 repeats, labeled g8-repeat-1/2/3.
const STEPS = []
for (const q of G8_QUESTIONS) {
  for (let n = 1; n <= 3; n++) STEPS.push({ group: '8-usercontext', q, label: `g8-repeat-${n}` })
}

let reportTimestamp = ''
const results = []

function persistJson() {
  if (!reportTimestamp || !results.length) return cy.wrap(null, { log: false })
  const payload = {
    meta: { suite: 'dev-kiosk-g8-repeat', user: RUN_USER, origin: ORIGIN, timestamp: reportTimestamp, count: results.length },
    results
  }
  const filename = `coverage-answers-${slugForFilename(RUN_USER)}-${reportTimestamp}.json`
  return cy.task('writeReport', { data: JSON.stringify(payload, null, 2) + '\n', filename }).then(() => `${REPORT_DIR}/${filename}`)
}

describe('dev-kiosk — G8 userContext repeats', { testIsolation: false, timeout: 7200000 }, () => {
  before(() => {
    Cypress.config('baseUrl', ORIGIN)
    Cypress.env('APP_ORIGIN', ORIGIN)
    reportTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    cy.authLogin()
    cy.userLogin()
    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    cy.waitForComposerTextareaReady({ timeout: 30000 })
  })

  after(() => {
    cy.then(() => persistJson().then((p) => { if (p) cy.log(`G8-REPEAT JSON: ${Cypress.config('projectRoot')}/${p}`) }))
  })

  STEPS.forEach((step, index) => {
    const shortQ = step.q.length > 40 ? step.q.slice(0, 37) + '…' : step.q
    it(`${String(index + 1).padStart(2, '0')}/${STEPS.length} ${step.label} — ${shortQ}`, () => {
      cy.visitWithAuth(`${ORIGIN}/reader/intelligence`)
      cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
      cy.waitForComposerTextareaReady({ timeout: 120000 })

      cy.window({ log: false }).then((win) => {
        win.__stepStreamBefore = (win.__rawCap && win.__rawCap.streams && win.__rawCap.streams.length) || 0
      })

      cy.waitForComposerTextareaReady({ timeout: 180000 })
      cy.getChatInput().clear().type(step.q, { force: true })
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
      cy.then(pollAnswerReady)

      const rawDeadline = Date.now() + 40000
      const pollRaw = () =>
        cy.window({ log: false }).then((win) => {
          const streams = (win.__rawCap && win.__rawCap.streams) || []
          const rec = streams[streams.length - 1]
          if (streams.length > (win.__stepStreamBefore || 0) && rec && rec.done) return
          if (Date.now() > rawDeadline) return
          return cy.wait(1500, { log: false }).then(pollRaw)
        })
      cy.then(pollRaw)

      cy.document().then((doc) => {
        const rows = extractBackendStageTableFromDom(doc.body)
        const renderedText = rows.length > 0 ? extractLlmAnswerText(doc.body) : extractAnswerFromConversation(doc.body, step.q)
        cy.window({ log: false }).then((win) => {
          const streams = (win.__rawCap && win.__rawCap.streams) || []
          const rec = streams.length > (win.__stepStreamBefore || 0) ? streams[streams.length - 1] : null
          const parsed = parseSSE(rec ? rec.buf : '')
          const rawAnswer = parsed.rawAnswer || ''
          results.push({
            index: index + 1,
            group: step.group,
            label: step.label,
            question: step.q,
            rawText: rawAnswer,
            renderedText: renderedText || '',
            stageTableMd: parsed.stageTableMd || '',
            rawLen: rawAnswer.length,
            renderedLen: (renderedText || '').length,
            streamDone: rec ? !!rec.done : false
          })
          return persistJson()
        })
      })
    })
  })
})
