/**
 * Staging — frontend vs backend performance tables → CSV (same layout as performance_comparison_round4.csv).
 *
 * Host: https://staging.entwickler.de
 * Login: cy.authLogin() + cy.userLogin() (HTTP Basic + app form — see cypress/support/login.js / cypress.env.json).
 *
 * **Capture:** After the composer reports idle, we **once** programmatically scroll the **chat scroll container**
 * (`pickScrollContainerForPerf`) to **bottom**, take full **plain text**, then step **only that scroller upward**
 * (typically post-stream we're at bottom; PM rows 5–9 sit above the fold). No whole-page jerks (`window`
 * scroll is only a fallback if there is no inner thread scroller).
 *
 * **Backend** uses `parseBackendTable` on the **full** merge; **frontend** uses `parseFrontendSteps` on the slice from
 * the last “Performance Metrics” anchor.
 *
 * Env:
 *   CYPRESS_PERF_QUESTION — optional override (full question string).
 *   CYPRESS_PERF_REPEAT_COUNT — how many turns (default: 10). Quick check: `npm run test:staging-performance:chrome:one`.
 *   CYPRESS_PERF_SAME_CHAT — if "true" / "1", do not open a new chat between turns (stacked perf panels;
 *     parsers use last-match). Default: start a **new chat** before each turn after the first.
 *   CYPRESS_PERF_NEW_CHAT_PAGE_RELOAD — if "true" / "1", reload `/reader/intelligence` instead of the
 *     new-chat UI (fallback if selectors change).
 *   CYPRESS_PERF_DEBUG — if "true" / "1", merge / failure artifacts and timing key summary.
 *   CYPRESS_PERF_PANEL_TIMEOUT — ms to retry full scans until perf text is complete (default: 80000).
 *   CYPRESS_PERF_SCROLL_STEP_PX — chat-thread step upward when merging text (default: 260).
 *   CYPRESS_PERF_VIEWPORT — optional `WxH` or `W,H` (default: `1920x1080`).
 *
 * Shell vars are copied into `Cypress.env('PERF_*')` in `cypress.config.js` (browser `process.env` is unreliable).
 * npm run test:staging-performance (Electron, headless — not the same engine as your desktop Chrome)
 * npm run test:staging-performance:chrome — **prefer this** if you compare to a normal Chrome session.
 * npm run test:staging-performance:open — interactive runner.
 */
const STAGING_ORIGIN = 'https://staging.entwickler.de'

const { readPerfEnv, perfEnvFlag } = require('../support/perf-cypress-env')

const perfDebug = perfEnvFlag('PERF_DEBUG')

/** Substring around first case-insensitive occurrence (for Cypress Command Log). */
function snippetAround(pageText, needle, before = 50, after = 100) {
  if (!pageText || !needle) return ''
  const hay = String(pageText)
  const i = hay.toLowerCase().indexOf(needle.toLowerCase())
  if (i === -1) return `(not found: "${needle}")`
  return hay.substring(Math.max(0, i - before), Math.min(hay.length, i + needle.length + after))
}

const DEFAULT_PERF_QUESTION = 'Wie funktioniert das Routing in Angular?'
const DEFAULT_PERF_REPEATS = 10

const perfQuestion = readPerfEnv('PERF_QUESTION') || DEFAULT_PERF_QUESTION
const repeatCountRaw = readPerfEnv('PERF_REPEAT_COUNT')
const repeatCount = Math.min(
  100,
  Math.max(
    1,
    repeatCountRaw != null && repeatCountRaw !== ''
      ? parseInt(String(repeatCountRaw), 10) || DEFAULT_PERF_REPEATS
      : DEFAULT_PERF_REPEATS
  )
)

const runList = Array.from({ length: repeatCount }, () => perfQuestion)

const sameChatMode = perfEnvFlag('PERF_SAME_CHAT')

const newChatByPageReload = perfEnvFlag('PERF_NEW_CHAT_PAGE_RELOAD')

const {
  buildComparisonRows,
  rowsToCsv,
  perfPanelsReadyDiagnostics,
  turnRowsComplete,
  turnRowsCompleteFailureDetail,
  parsePerformanceFromMergedPageWithBucket
} = require('../support/staging-performance-parsers')
const {
  textFromNodeDeep,
  pickScrollContainerForPerf
} = require('../support/perf-shadow-text')
const {
  resetPerfTimingBucket,
  ensurePerfConsoleTimingHook
} = require('../support/perf-console-hook')

/** Shared console timing bucket — reset before each turn, populated by the AUT's console.log. */
let perfBucket = {}
resetPerfTimingBucket(perfBucket)

/** Reports relative to repo root (same folder as cypress.config.js). */
const REPORT_DIR = 'cypress/reports'

const PERF_PANEL_WAIT_MS = (() => {
  const raw = readPerfEnv('PERF_PANEL_TIMEOUT')
  if (raw == null || raw === '') return 80000
  const n = parseInt(String(raw), 10)
  if (Number.isNaN(n)) return 80000
  return Math.min(120000, Math.max(5000, n))
})()

/** Upward scroll step after streaming (viewport reveals Stage + PM rows 5–9). Override: CYPRESS_PERF_SCROLL_STEP_PX */
const PERF_SCROLL_STEP_PX = (() => {
  const raw = readPerfEnv('PERF_SCROLL_STEP_PX')
  if (raw == null || raw === '') return 260
  const n = parseInt(String(raw), 10)
  if (Number.isNaN(n) || n < 80) return 260
  return Math.min(800, n)
})()

/**
 * Larger than Cypress default (~1000×660) so the perf card often shows steps 6–8 like a normal desktop session.
 * Override: `CYPRESS_PERF_VIEWPORT=1536x864` or `1536,864`.
 */
const PERF_VIEWPORT = (() => {
  const raw = readPerfEnv('PERF_VIEWPORT')
  if (!raw) return { width: 1920, height: 1080 }
  const m = raw.match(/^(\d+)\s*[x,]\s*(\d+)\s*$/i)
  if (!m) return { width: 1920, height: 1080 }
  const width = Math.min(3840, Math.max(900, parseInt(m[1], 10)))
  const height = Math.min(2160, Math.max(600, parseInt(m[2], 10)))
  if (Number.isNaN(width) || Number.isNaN(height)) return { width: 1920, height: 1080 }
  return { width, height }
})()

/**
 * Call at the start of each turn (and once in `before`) so size matches after full page reload / new-chat routes.
 * `cypress run` defaults to Electron; your manual session is usually Chrome — use `test:staging-performance:chrome`.
 */
function ensurePerfViewport() {
  cy.log(
    `[perf] viewport ${PERF_VIEWPORT.width}×${PERF_VIEWPORT.height} (env CYPRESS_PERF_VIEWPORT=WxH to override)`
  )
  cy.viewport(PERF_VIEWPORT.width, PERF_VIEWPORT.height)
}

/** `cy.document()` yields a native `Document`, not jQuery — use `.body` directly. */
function documentBodyFromSubject(subj) {
  if (!subj) return null
  if (subj.nodeType === 9 && subj.body) return subj.body
  const first = subj[0]
  if (first && first.nodeType === 9 && first.body) return first.body
  return null
}

function pageScrollHeight(win) {
  if (!win?.document) return 0
  return (
    win.document.documentElement?.scrollHeight ||
    win.document.body?.scrollHeight ||
    0
  )
}

function viewportBottomScrollY(win) {
  if (!win?.document) return 0
  const h = pageScrollHeight(win)
  const ih =
    win.innerHeight ||
    win.document.documentElement?.clientHeight ||
    win.document.body?.clientHeight ||
    0
  return Math.max(0, h - ih)
}

function elementMaxScrollTop(el) {
  if (!el) return 0
  return Math.max(0, el.scrollHeight - el.clientHeight)
}
/**
 * Minimal samples for CSV: if the chat scroller is at the **top**, step **down**; otherwise snap to **bottom** then
 * step **up** (post-stream path). Fallback: window scroll ↑ if there is no inner thread scroller.
 */
function collectPerfMergedPlainTextOnce() {
  const stepPx = PERF_SCROLL_STEP_PX
  const pauseMs = 120

  return cy.wait(260, { log: false }).then(() =>
    cy.window({ log: false }).then((win) => {
      const body = win.document.body
      const inner = pickScrollContainerForPerf(body)

      if (inner && inner.scrollHeight > inner.clientHeight + 40) {
        const maxTop = elementMaxScrollTop(inner)
        const slack = 8
        const before = inner.scrollTop

        /**
         * Rare: viewport at **top** of thread → step **down**. Otherwise snap to **bottom** (usual post-stream) then
         * step **up** so perf rows above the fold are sampled.
         */
        if (before <= slack && maxTop > slack + stepPx) {
          inner.scrollTop = 0
          let merged = textFromNodeDeep(body)
          let y = 0
          const stepDown = () => {
            if (y >= maxTop - slack) {
              return cy.wrap(merged)
            }
            y = Math.min(maxTop, y + stepPx)
            inner.scrollTop = y
            return cy.wait(pauseMs, { log: false }).then(() => {
              merged += '\n' + textFromNodeDeep(body)
              return stepDown()
            })
          }
          return stepDown()
        }

        inner.scrollTop = maxTop
        let merged = textFromNodeDeep(body)
        let y = maxTop
        const stepUpFromBottom = () => {
          if (y <= 0) {
            return cy.wrap(merged)
          }
          y = Math.max(0, y - stepPx)
          inner.scrollTop = y
          return cy.wait(pauseMs, { log: false }).then(() => {
            merged += '\n' + textFromNodeDeep(body)
            return stepUpFromBottom()
          })
        }
        return stepUpFromBottom()
      }

      const bottom = viewportBottomScrollY(win)
      win.scrollTo({ top: bottom, left: 0, behavior: 'instant' })
      let merged = textFromNodeDeep(body)
      let wy = bottom
      const stepWindowUp = () => {
        if (wy <= 0) return cy.wrap(merged)
        wy = Math.max(0, wy - stepPx)
        win.scrollTo({ top: wy, left: 0, behavior: 'instant' })
        return cy.wait(pauseMs, { log: false }).then(() => {
          merged += '\n' + textFromNodeDeep(body)
          return stepWindowUp()
        })
      }
      return stepWindowUp()
    })
  )
}

/** Wait for perf UI + parser readiness with **one** directional chat scroll sample per attempt (no repeated bottom clicks). */
function waitForPerfTextReady() {
  const start = Date.now()
  const loop = () =>
    cy
      .wait(450, { log: false })
      .then(() => collectPerfMergedPlainTextOnce())
      .then((pageText) => {
        const diag = perfPanelsReadyDiagnostics(pageText)
        if (diag.ready) {
          return cy.log(`[perf] Perf panels ready (DOM; textLen=${diag.length})`)
        }
        if (Date.now() - start >= PERF_PANEL_WAIT_MS) {
          const pt = String(pageText)
          const pmIdx = pt.search(/Performance\s+Metrics|Leistungsmetriken|Leistungs\s*metriken/i)
          const sec1 = pmIdx >= 0 ? pt.slice(pmIdx, pmIdx + 6000) : ''
          const sec2 = pt.slice(Math.max(0, pt.length - 4000))
          const dumpText = [
            '=== FROM LAST PERF-METRICS ANCHOR ===',
            sec1,
            '=== LAST 4000 CHARS OF MERGED TEXT ===',
            sec2
          ].join('\n')
          return cy
            .writeFile(`${REPORT_DIR}/perf-readiness-debug.txt`, dumpText, 'utf8')
            .then(() => {
              expect(
                diag.ready,
                `perf panels (DOM-only): ${JSON.stringify(diag.checks)} textLen=${diag.length}`
              ).to.be.true
            })
        }
        const missing = Object.entries(diag.checks)
          .flatMap(([k, v]) => {
            if (k === 'feFields' && typeof v === 'object' && v !== null) {
              return Object.entries(v).filter(([, bv]) => !bv).map(([bk]) => `fe.${bk}`)
            }
            return !v ? [k] : []
          })
        return cy
          .log(`[perf] rescan… not ready (${missing.join(', ')})`)
          .wait(900, { log: false })
          .then(loop)
      })
  return loop()
}

/**
 * No scrolling — only full plain text of `body` (shadow included). Wait until the first perf block is present
 * (typically the Performance Metrics card — see file header) before `waitForPerfTextReady` / step-up merges so we
 * do not sweep an empty thread while the model has not emitted any perf UI yet. We also match early PM row labels
 * (`Pre-Discovery Request`, `Stream Requested`) in case plain-text order surfaces those before the “Performance Metrics” title.
 */
function perfUiMarkersPresent(pageText) {
  if (!pageText || typeof pageText !== 'string') return false
  return (
    /Performance\s+Metrics/i.test(pageText) ||
    /Leistungsmetriken/i.test(pageText) ||
    /Leistungs\s*metriken/i.test(pageText) ||
    /Performance[\s\-]*Metriken/i.test(pageText) ||
    /Pre-Discovery\s+Request/i.test(pageText) ||
    /Stream\s+Requested/i.test(pageText) ||
    /preDiscovery\s*:\s*start/i.test(pageText) ||
    /service\s*:\s*firstToken/i.test(pageText) ||
    (/Stage/i.test(pageText) && (/Timestamp/i.test(pageText) || /\bDELTA\b/i.test(pageText)))
  )
}

function waitUntilPerfTablesStarted() {
  return cy.document({ log: false, timeout: PERF_PANEL_WAIT_MS }).should(($doc) => {
    const body = documentBodyFromSubject($doc)
    if (!body) {
      throw new Error('document has body')
    }
    const t = textFromNodeDeep(body)
    if (!perfUiMarkersPresent(t)) {
      throw new Error(
        `perf UI visible (non-scroll read; expect Performance Metrics card or Stage), textLen=${t.length}`
      )
    }
  })
}

/** One chat-directional text sample per attempt; parse until CSV complete. */
function captureTurnUntilCsvComplete(turnIndex) {
  const start = Date.now()
  const loop = () =>
    cy
      .wait(450, { log: false })
      .then(() => collectPerfMergedPlainTextOnce())
      .then((pageText) => {
        const analyze = () => {
          const { backendParsed, frontendParsed } = parsePerformanceFromMergedPageWithBucket(pageText, perfBucket)
          const rows = buildComparisonRows(turnIndex, backendParsed, frontendParsed)
          if (turnRowsComplete(rows)) {
            return cy
              .log(
                `Parsed Turn ${turnIndex}: backend LLM wait ${backendParsed.backendLlmWaitMs ?? 'n/a'} ms, frontend LLM wait ${frontendParsed.frontendLlmWaitMs ?? 'n/a'} ms`
              )
              .then(() => rows)
          }
          if (Date.now() - start >= PERF_PANEL_WAIT_MS) {
            const detail = turnRowsCompleteFailureDetail(rows)
            const failMsg = `Turn ${turnIndex}: CSV incomplete after ${PERF_PANEL_WAIT_MS}ms. first_token needs LLM + total columns filled. incompleteRow=${detail}`
            if (perfDebug) {
              return cy
                .writeFile(
                  `${REPORT_DIR}/perf-failed-merge-turn-${turnIndex}.txt`,
                  String(pageText).slice(-20000),
                  'utf8'
                )
                .then(() => {
                  expect(turnRowsComplete(rows), failMsg).to.be.true
                  return rows
                })
            }
            expect(turnRowsComplete(rows), failMsg).to.be.true
            return rows
          }
          return cy
            .log('[perf] rows incomplete vs parser — rescan after wait')
            .wait(900, { log: false })
            .then(loop)
        }

        if (perfDebug) {
          return cy.log(`[perf] DOM merge pass (textLen=${String(pageText).length})`).then(analyze)
        }
        return analyze()
      })
  return loop()
}

describe(
  'Staging — frontend vs backend performance',
  { testIsolation: false, timeout: 7200000 },
  () => {
    let allCsvRows = []
    let reportTimestamp = ''

    before(() => {
      Cypress.config('baseUrl', STAGING_ORIGIN)
      Cypress.env('APP_ORIGIN', STAGING_ORIGIN)

      const now = new Date()
      reportTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5)

      cy.authLogin()
      cy.userLogin()

      ensurePerfViewport()

      cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
      cy.waitForComposerTextareaReady({ timeout: 30000 })

      cy.window().then((win) => {
        resetPerfTimingBucket(perfBucket)
        ensurePerfConsoleTimingHook(win, perfBucket)
      })
    })

    after(() => {
      cy.then(() => {
        const csvFilename = `performance-comparison-${reportTimestamp}.csv`
        const jsonFilename = `performance-comparison-${reportTimestamp}.json`
        const csvPath = `${REPORT_DIR}/${csvFilename}`
        const jsonPath = `${REPORT_DIR}/${jsonFilename}`
        const csvContent = rowsToCsv(allCsvRows)
        const root = Cypress.config('projectRoot')
        return cy
          .writeFile(csvPath, csvContent, 'utf8')
          .writeFile(jsonPath, JSON.stringify(allCsvRows, null, 2), 'utf8')
          .then(() =>
            cy.log(`Reports: ${root}/${csvPath}`).then(() => cy.log(`Reports: ${root}/${jsonPath}`))
          )
      })
    })

    runList.forEach((question, index) => {
      it(`Turn ${index + 1}/${repeatCount}: ${question.substring(0, 60)}…`, () => {
        ensurePerfViewport()

        // Turns run in order: the previous it() already waited for the answer to finish
        // (waitForComposerReadyForNewQuestion + parse). Before we ask again, only open a new chat when
        // repeatCount > 1 — and only after the composer is idle (not still streaming).
        // Reset the console timing bucket before each turn so token events from the previous turn
        // don't bleed into the current one.
        cy.window().then((win) => {
          resetPerfTimingBucket(perfBucket)
          ensurePerfConsoleTimingHook(win, perfBucket)
        })

        if (!sameChatMode && repeatCount > 1 && index > 0) {
          cy.waitForComposerTextareaReady({ timeout: 180000 })

          if (newChatByPageReload) {
            cy.visitWithAuth(`${STAGING_ORIGIN}/reader/intelligence`)
            cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
            // Page reload creates a new window — reinstall the hook on it.
            cy.window().then((win) => ensurePerfConsoleTimingHook(win, perfBucket))
          } else {
            cy.get('.new-file-open-icon', { timeout: 30000 }).should('be.visible').click()
            cy.get('.nav-text', { timeout: 15000 }).filter(':visible').first().should('be.visible').click()
          }

          cy.waitForComposerTextareaReady({ timeout: 120000 })
        }

        cy.waitForComposerTextareaReady({ timeout: 180000 })

        cy.getChatInput().clear().type(question, { force: true })
        cy.waitForComposerSendEnabled()
        cy.getComposerSendButton().filter(':visible').first().click()

        cy.waitForComposerReadyForNewQuestion({ timeout: 600000 })

        /** Brief settle after the turn completes (composer ready is the gate for “stream done” in this UI). */
        cy.wait(500, { log: false })

        waitUntilPerfTablesStarted()
          .then(() => waitForPerfTextReady())

        cy.wait(400, { log: false })

        captureTurnUntilCsvComplete(index + 1).then((rows) => {
          allCsvRows = allCsvRows.concat(rows)

          const csvContent = rowsToCsv(allCsvRows)
          const csvFilename = `performance-comparison-${reportTimestamp}.csv`
          const csvPath = `${REPORT_DIR}/${csvFilename}`

          cy.log(
            `Turn ${index + 1} written: ${rows.length} row(s) (all columns filled per turnRowsComplete)`
          )
          return cy.writeFile(csvPath, csvContent, 'utf8')
        })
      })
    })
  }
)
