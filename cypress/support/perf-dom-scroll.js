/**
 * Shared DOM scroll + plain-text merge for staging perf specs (chat thread scroller only).
 */

const { readPerfEnv } = require('./perf-cypress-env')
const { textFromNodeDeep, pickScrollContainerForPerf } = require('./perf-shadow-text')

const PERF_SCROLL_STEP_PX = (() => {
  const raw = readPerfEnv('PERF_SCROLL_STEP_PX')
  if (raw == null || raw === '') return 260
  const n = parseInt(String(raw), 10)
  if (Number.isNaN(n) || n < 80) return 260
  return Math.min(800, n)
})()

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
 * One pass: read chat position → if at top step **down**, else snap **bottom** then step **up**.
 * @param {{ stepPx?: number, pauseMs?: number, initialWaitMs?: number }} [options]
 */
function collectPerfMergedPlainTextOnce(options = {}) {
  const stepPx = options.stepPx != null ? options.stepPx : PERF_SCROLL_STEP_PX
  const pauseMs = options.pauseMs != null ? options.pauseMs : 120
  const initialWaitMs = options.initialWaitMs != null ? options.initialWaitMs : 260

  return cy.wait(initialWaitMs, { log: false }).then(() =>
    cy.window({ log: false }).then((win) => {
      const body = win.document.body
      const inner = pickScrollContainerForPerf(body)

      if (inner && inner.scrollHeight > inner.clientHeight + 40) {
        const maxTop = elementMaxScrollTop(inner)
        const slack = 8
        const before = inner.scrollTop

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

module.exports = {
  PERF_SCROLL_STEP_PX,
  collectPerfMergedPlainTextOnce
}
