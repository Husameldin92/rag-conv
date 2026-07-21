/**
 * RAW answer-stream capture for the dev-kiosk prompt-coverage suite.
 *
 * The answer streams as SSE (`text/event-stream`) from
 *   concord.sandsmedia.com/discover/<session>/<ragId>/<JWT>
 * as a `fetch` GET. The DOM renders markers (markdown-citations) into pills, so the
 * RAW generated text (markers intact) is only observable on the wire.
 *
 * Proven approach (spike v6): `res.clone()` + read the clone to completion, POLLING
 * until `done` (the clone delivers its buffered body at stream close, not
 * incrementally — a fixed short wait misses it). We return the ORIGINAL response to
 * the app untouched, so streaming/rendering is unaffected.
 *
 * SSE shape (one physical line per event, data is a JSON-encoded string):
 *   data: "Keyword: {...} Question topics:... Synthesised question:..."   <- meta[0]
 *   data: "| Stage | Timestamp | Delta (ms) |\n|---|...| **Total** | | **N ms** |"  <- meta[1] (stage table md)
 *   data: "Unit"   data: " tests"   ...                                    <- answer tokens
 *   data: " [📷 <title> - <brand>](<24hex>?poc=<24hex>){.markdown-citation style=\"...\"}."  <- citation marker
 *   data: "Follow-up questions\n- ...\n- ...\n- ..."                        <- follow-up block
 *   data: ""                                                               <- end
 */

const STREAM_RE = /concord\.sandsmedia\.com\/discover\//i

/**
 * Install the fetch tap on an AUT window. Register from a spec via:
 *   Cypress.on('window:before:load', installFetchTap)
 * Accumulates each answer stream into win.__rawCap.streams (newest last).
 */
function installFetchTap(win) {
  if (!win.__rawCap) win.__rawCap = { streams: [] }
  if (win.__rawCapInstalled) return
  win.__rawCapInstalled = true

  const origFetch = win.fetch
  if (!origFetch) return
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (!STREAM_RE.test(String(url))) return origFetch.apply(this, arguments)
    return origFetch.apply(this, arguments).then((res) => {
      const rec = { url: String(url), status: res.status, buf: '', done: false, err: null }
      win.__rawCap.streams.push(rec)
      try {
        const clone = res.clone()
        if (clone.body && clone.body.getReader) {
          const reader = clone.body.getReader()
          const decoder = new TextDecoder()
          const pump = () =>
            reader.read().then(({ done, value }) => {
              if (value && value.byteLength) rec.buf += decoder.decode(value, { stream: true })
              if (done) { rec.buf += decoder.decode(); rec.done = true }
              if (!done) return pump()
            }).catch((e) => { rec.err = String(e); rec.done = true })
          pump()
        } else {
          rec.err = 'no clone.body.getReader'
          rec.done = true
        }
      } catch (e) { rec.err = String(e); rec.done = true }
      return res // app gets the untouched original
    })
  }
}

/**
 * Parse a raw SSE buffer into structured pieces.
 * @returns {{ payloads: string[], keyword: string, stageTableMd: string, rawAnswer: string }}
 */
function parseSSE(buf) {
  const payloads = []
  const lines = String(buf || '').split(/\r?\n/)
  for (const line of lines) {
    if (line.indexOf('data:') !== 0) continue
    let raw = line.slice(5)
    if (raw[0] === ' ') raw = raw.slice(1)
    if (raw === '') { payloads.push(''); continue }
    try { payloads.push(JSON.parse(raw)) } catch (e) { payloads.push(raw) }
  }

  // Identify the meta events: keyword (starts with "Keyword:") and the stage-table
  // markdown block (contains "| Stage |" and "**Total**"). The answer is everything
  // AFTER the stage-table event.
  let keyword = ''
  let stageIdx = -1
  let stageTableMd = ''
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i]
    if (typeof p !== 'string') continue
    if (!keyword && /^Keyword:/.test(p)) keyword = p
    if (stageIdx === -1 && /\|\s*Stage\s*\|/i.test(p) && /\*\*Total\*\*|Total\b/i.test(p)) {
      stageIdx = i
      stageTableMd = p
    }
  }

  let answerParts
  if (stageIdx >= 0) {
    answerParts = payloads.slice(stageIdx + 1)
  } else {
    // Fallback: drop a leading keyword event if present, keep the rest.
    answerParts = payloads.filter((p, i) => !(i === 0 && /^Keyword:/.test(String(p))))
  }
  const rawAnswer = answerParts.map((p) => (typeof p === 'string' ? p : '')).join('')

  return { payloads, keyword, stageTableMd, rawAnswer }
}

module.exports = { STREAM_RE, installFetchTap, parseSSE }
