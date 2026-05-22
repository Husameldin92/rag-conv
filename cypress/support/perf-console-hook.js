/**
 * Intercept AUT `console.log` for staging performance CSV.
 *
 * Timing objects and standalone `… at:` lines fill gaps when DOM text is incomplete.
 *
 * **`Received token: { time }`** entries are appended to **`allReceivedTokenTimes`** only if tooling still reads logs;
 * the staging perf spec uses **DOM-only** CSV capture (`parsePerformanceFromMergedPageDOM`).
 */

const CLK_CAPTURE = '(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}|\\d{2}:\\d{2}\\.\\d{3})'

/** @param {string} labelPattern regex **source** before `:`, e.g. `Discovery\\s+response\\s+at` */
function extractLabeledClock(labelPattern, args, lineFull) {
  const stringArgs = args.filter((a) => typeof a === 'string')
  const joined = stringArgs.join(' ')
  const reDirect = new RegExp(`${labelPattern}\\s*:\\s*(${CLK_CAPTURE})\\b`, 'i')
  let m = joined.match(reDirect)
  if (m) return m[1]

  const reAfterId = new RegExp(`${labelPattern}\\s*:\\s*\\S+\\s+(${CLK_CAPTURE})\\b`, 'i')
  m = joined.match(reAfterId)
  if (m) return m[1]

  if (lineFull) {
    const reJson = new RegExp(`${labelPattern}\\s*:\\s*\\{\\s*"time"\\s*:\\s*"(${CLK_CAPTURE})"`, 'i')
    m = lineFull.match(reJson)
    if (m) return m[1]
  }

  const labelHead = new RegExp(`${labelPattern}\\s*:`, 'i')
  const ix = args.findIndex((a) => typeof a === 'string' && labelHead.test(a.trim()))
  if (ix !== -1) {
    for (let j = ix + 1; j < Math.min(ix + 10, args.length); j++) {
      const a = args[j]
      if (typeof a === 'string') {
        const tm = a.trim().match(new RegExp(`^${CLK_CAPTURE}$`))
        if (tm) return tm[1]
        const em = a.match(new RegExp(`\\b(${CLK_CAPTURE})\\b`))
        if (em) return em[1]
      }
      if (a && typeof a === 'object' && !Array.isArray(a) && a.time != null) {
        const ts = String(a.time).trim()
        const tm = ts.match(new RegExp(`^${CLK_CAPTURE}$`))
        if (tm) return tm[1]
      }
    }
  }
  return null
}

function resetPerfTimingBucket(bucket) {
  bucket.completeTiming = null
  bucket.incrementalTiming = null
  bucket.preDiscoveryResponseAt = null
  bucket.discoveryResponseAt = null
  bucket.streamRequestedAt = null
  bucket.allReceivedTokenTimes = []
  bucket.fallbackLines = []
}

const ORIG_KEY = '__origConsoleLogPerfStaging'
const BUCKET_PROP = '__perfStagingTimingBucket'

/**
 * Patch `console.log` at most once per `window`. Each turn: {@link resetPerfTimingBucket}.
 *
 * @param {Window} win
 * @param {{
 *   completeTiming: object | null,
 *   incrementalTiming: object | null,
 *   preDiscoveryResponseAt: string | null,
 *   discoveryResponseAt: string | null,
 *   streamRequestedAt: string | null,
 *   allReceivedTokenTimes: string[],
 *   fallbackLines: string[]
 * }} bucket
 */
function ensurePerfConsoleTimingHook(win, bucket) {
  win[BUCKET_PROP] = bucket

  if (win[`${ORIG_KEY}__wrapped`]) {
    return
  }

  const key = ORIG_KEY
  if (!win[key]) {
    win[key] = win.console.log.bind(win.console)
  }
  const orig = win[key]

  win.console.log = (...args) => {
    const b = win[BUCKET_PROP] || bucket

    const stringJoin = args
      .map((a) => (typeof a === 'string' ? a : ''))
      .join(' ')
    const lineForFallback =
      typeof args[0] === 'string'
        ? args[0]
        : args.map((a) => (typeof a === 'string' ? a : '')).join(' ')
    /** Include JSON payloads so `Received token {"time":"…"}` is searchable if needed */
    let lineFull = lineForFallback
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        try {
          lineFull += ` ${JSON.stringify(a)}`
        } catch {
          lineFull += ` ${String(a)}`
        }
      }
    }

    const timingShape = (x) =>
      x &&
      typeof x === 'object' &&
      !Array.isArray(x) &&
      (Object.prototype.hasOwnProperty.call(x, 'requestSent') ||
        Object.prototype.hasOwnProperty.call(x, 'sessionId') ||
        Object.prototype.hasOwnProperty.call(x, 'preDiscoveryResponse'))

    const cloneObj = (obj) => {
      try {
        return JSON.parse(JSON.stringify(obj))
      } catch {
        try {
          return { ...obj }
        } catch {
          return obj
        }
      }
    }

    /** Final summary — prefer for token / stream keys (fires once per turn). */
    if (/Complete\s+timing\s+data\s+for\s+session/i.test(stringJoin)) {
      const obj = args.find((a) => timingShape(a))
      if (obj) {
        b.completeTiming = cloneObj(obj)
      }
    }

    if (/Timing\s+data\s+updated\s+at/i.test(stringJoin) || /\bTiming\s+data\s+updated\s+at\b/i.test(lineForFallback)) {
      const obj = args.find((a) => timingShape(a))
      if (obj) {
        b.incrementalTiming = cloneObj(obj)
      }
    }

    if (!b.preDiscoveryResponseAt) {
      const c = extractLabeledClock('Pre-discovery\\s+response\\s+at', args, lineFull)
      if (c) b.preDiscoveryResponseAt = c
    }
    if (!b.discoveryResponseAt) {
      let c = extractLabeledClock('Discovery\\s+response\\s+at', args, lineFull)
      if (!c) c = extractLabeledClock('Discovery\\s+response\\s+received', args, lineFull)
      if (c) b.discoveryResponseAt = c
    }
    if (!b.streamRequestedAt) {
      let c = extractLabeledClock('Stream\\s+requested\\s+at', args, lineFull)
      if (!c) c = extractLabeledClock('Stream\\s+requested\\s+for\\s+session', args, lineFull)
      if (!c && /Starting\s+stream\s+with\s+URL/i.test(stringJoin)) {
        const ix = args.findIndex((a) => typeof a === 'string' && /Starting\s+stream\s+with\s+URL/i.test(a))
        if (ix !== -1) {
          for (let j = ix + 1; j < Math.min(ix + 6, args.length); j++) {
            const a = args[j]
            if (a && typeof a === 'object' && !Array.isArray(a) && a.time != null) {
              const ts = String(a.time).trim().match(new RegExp(`^${CLK_CAPTURE}$`))
              if (ts) {
                c = ts[1]
                break
              }
            }
          }
        }
      }
      if (c) b.streamRequestedAt = c
    }

    if (/Received\s+token/i.test(stringJoin)) {
      const payload = args.find(
        (a) =>
          a &&
          typeof a === 'object' &&
          !Array.isArray(a) &&
          typeof a.time === 'string' &&
          new RegExp(`^${CLK_CAPTURE}$`).test(String(a.time).trim()) &&
          !timingShape(a)
      )
      if (payload) {
        const t = String(payload.time).trim()
        if (!Array.isArray(b.allReceivedTokenTimes)) b.allReceivedTokenTimes = []
        b.allReceivedTokenTimes.push(t)
      }
    }

    /** Optional retained buffer — key timing lines (not every Received token chunk). */
    if (
      /Pre-discovery\s+response\s+at:/i.test(lineForFallback) ||
      /Discovery\s+response\s+at:/i.test(lineForFallback) ||
      /Discovery\s+response\s+received:/i.test(lineForFallback) ||
      /Stream\s+requested\s+at:/i.test(lineForFallback) ||
      /Stream\s+requested\s+for\s+session:/i.test(lineForFallback) ||
      /First\s+token\s+received\s+at:/i.test(lineForFallback) ||
      /First\s+token\s+received\s+for\s+session:/i.test(lineForFallback) ||
      /Complete\s+timing\s+data/i.test(lineForFallback) ||
      /\bpreDiscovery\s*:/i.test(lineFull) ||
      /\bdiscovery\s*:/i.test(lineFull) ||
      /\bservice\s*:\s*firstToken\b/i.test(lineFull)
    ) {
      if (lineFull.trim()) {
        b.fallbackLines.push(lineFull.trim())
        while (b.fallbackLines.length > 200) b.fallbackLines.shift()
      }
    }

    orig(...args)
  }
  win[`${ORIG_KEY}__wrapped`] = true
}

module.exports = {
  resetPerfTimingBucket,
  ensurePerfConsoleTimingHook
}
