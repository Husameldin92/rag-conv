/**
 * Discovery spike v6 — decisive: does a clone() branch EVER get SSE data, and when?
 *
 * Returns the ORIGINAL response to the app (keeps streaming working, unlike v5's
 * reconstructed Response), clones it, and incrementally reads the clone with per-chunk
 * timestamps. Waits up to 45s after the answer completes. Tells us definitively whether
 * the clone delivers incrementally, only at stream close, or never.
 *
 * Writes cypress/debug/rawcapture-spike.json. Throwaway.
 */

const ORIGIN = 'https://dev-kiosk.entwickler.de'
const STREAM_RE = /concord\.sandsmedia\.com\/discover\//i

Cypress.on('window:before:load', (win) => {
  const store = { fetchStream: [] }
  win.__rawCap = store
  const t0 = () => (win.performance && win.performance.now ? Math.round(win.performance.now()) : -1)

  const origFetch = win.fetch
  if (origFetch) {
    win.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (!STREAM_RE.test(String(url))) return origFetch.apply(this, arguments)
      return origFetch.apply(this, arguments).then((res) => {
        const rec = {
          url: String(url), status: res.status, ct: res.headers.get('content-type'),
          startedAtMs: t0(), chunks: 0, chunkTimesMs: [], len: 0, done: false, doneAtMs: null, head: '', tail: '', err: null
        }
        store.fetchStream.push(rec)
        try {
          const clone = res.clone()
          const reader = clone.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          const pump = () =>
            reader.read().then(({ done, value }) => {
              if (value && value.byteLength) {
                rec.chunks += 1
                if (rec.chunkTimesMs.length < 20) rec.chunkTimesMs.push(t0())
                buf += decoder.decode(value, { stream: true })
              }
              if (done) { buf += decoder.decode(); rec.done = true; rec.doneAtMs = t0() }
              rec.len = buf.length
              rec.head = buf.slice(0, 3500)
              rec.tail = buf.slice(-2500)
              if (!done) return pump()
            }).catch((e) => { rec.err = String(e) })
          pump()
        } catch (e) { rec.err = 'clone/read: ' + e }
        return res // app gets the untouched original — streaming keeps working
      })
    }
  }
})

describe('rawcapture spike v6', { testIsolation: false, timeout: 1200000 }, () => {
  before(() => {
    Cypress.config('baseUrl', ORIGIN)
    Cypress.env('APP_ORIGIN', ORIGIN)
    cy.authLogin()
    cy.userLogin()
    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    cy.waitForComposerTextareaReady({ timeout: 30000 })
  })

  it('asks one question; reads clone incrementally with 45s post-answer wait', () => {
    const question = 'What is What is the difference between unit, integration, and end-to-end tests?'
    cy.waitForComposerTextareaReady({ timeout: 180000 })
    cy.getChatInput().clear().type(question, { force: true })
    cy.waitForComposerSendEnabled()
    cy.getComposerSendButton().filter(':visible').first().click()
    cy.waitForComposerReadyForNewQuestion({ timeout: 600000 })

    // Poll the capture for up to 45s: stop early once done or data present + stable.
    const deadline = Date.now() + 45000
    let lastLen = -1
    let stable = 0
    const poll = () =>
      cy.window({ log: false }).then((win) => {
        const rec = (win.__rawCap.fetchStream || [])[0] || {}
        if (rec.done) return
        if (rec.len === lastLen && rec.len > 0) stable += 1
        else stable = 0
        lastLen = rec.len
        if (stable >= 3 && rec.len > 0) return // streamed + stable
        if (Date.now() > deadline) return
        return cy.wait(2000, { log: false }).then(poll)
      })
    cy.then(poll)

    cy.window().then((win) => {
      const s = win.__rawCap || {}
      const out = { note: 'spike v6 — clone incremental + 45s wait', fetchStream: s.fetchStream || [] }
      cy.task('writeDebug', { data: JSON.stringify(out, null, 2), filename: 'rawcapture-spike.json' })
    })
  })
})
