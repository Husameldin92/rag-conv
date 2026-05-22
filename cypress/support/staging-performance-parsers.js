/**
 * Parse staging performance UI: backend STAGE/TIMESTAMP table + frontend numbered steps.
 * Display times: MM:SS.mmm (hour ignored for cross-clock comparison, matching manual reports).
 *
 * **Source of truth:** the same English strings you used for the manual export
 * **`performance_comparison_round4.csv`**: Stage keys like `preDiscovery:start`, `service:firstToken`,
 * **Performance Metrics** with **Pre-Discovery Request**, **Stream Requested**, **Token received**, **Total … ms**.
 * Automation only extracts plain text from the page and maps it into that CSV shape.
 *
 * **Optional fallbacks:** if the app is localized (e.g. German on staging) or labels break across lines, we also
 * match alternate spellings and numbered steps (`5.` / `6.`). That is **not** the primary model — English + your
 * reference layout is.
 *
 * Real DOM text is often multi-line (label and timestamp in different nodes). Regexes allow newlines between
 * "Total" and "21395 ms", or between "Token received:" and the clock time.
 *
 * **Layout / timing note:** flattened text is often: Performance Metrics steps **1–4** → **Stage table** →
 * **stream tail** (steps 5–8). Wait until the merged text contains the full chain before capturing.
 * When multiple assistant bubbles exist (**same-chat** stacking), parsers must ignore earlier turns — use
 * `parsePerformanceFromMergedPage` so only the slice from the **last** `"Performance Metrics"` is fed into
 * `parseBackendTable` / `parseFrontendSteps` (avoids pairing the wrong Stage rows across turns).
 *
 * **first_token row — CSV columns (same as performance_comparison_round4.csv):**
 *
 * 1. **backend LLM until the first token arrive** — `service:firstToken − discovery:ragServiceCall`
 *    (time in the RAG/LLM window after the rag service call until the first backend token).
 *
 * 2. **frontend LLM until the first token arrive** — `Token received − Stream Requested`
 *    (frontend step that corresponds to the stream URL / stream request through first token in the UI).
 *
 * 3. **Backend_total_to_first_token** — `service:firstToken − preDiscovery:start`
 *    (full backend pipeline from the first backend stage through first token; matches the Stage table
 *    **Total … ms** when parsing is complete).
 *
 * 4. **Frontend_total_to_first_token** — `Token received − Pre-Discovery Request`
 *    (full client path from the first Performance Metrics step — “search start” — until first token;
 *    matches **Time taken from search start until the first token is received** when present).
 *
 * Parsed “Total” / “Time taken” strings from the page are fallbacks only if timestamps are missing.
 *
 * **Capture path:** **`parsePerformanceFromMergedPageDOM`** — backend **Stage** from the **full** merged viewport
 * string (`parseBackendTable`); frontend **Performance Metrics** from **`sliceFromLastPerformanceMetricsBlock`**
 * + **`parseFrontendSteps`** (steps **5–9** often require multiple upward scroll merges — see Cypress spec).
 *
 * **`perfPanelsReadyDiagnostics(text)`**: DOM-only — **`hasBackendRows`** and **`hasFrontendCsv`** mirror what
 * **`turnRowsComplete`** needs (no `completeTiming` / console).
 */

function normalizePerfText(s) {
  return String(s).replace(/\u200b|\ufeff/g, '')
}

/** "14:40:06.370" or "40:06.370" → display "40:06.370" */
function toDisplayMmSsFff(s) {
  if (!s || typeof s !== 'string') return ''
  const t = s.trim()
  const full = t.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (full) {
    return `${full[2]}:${full[3]}.${full[4]}`
  }
  const short = t.match(/^(\d{2}):(\d{2})\.(\d{3})$/)
  if (short) {
    return `${short[1]}:${short[2]}.${short[3]}`
  }
  return t
}

/** "14:40:06.370" → ms from start of day fragment (for diffs on same clock) */
function fullHmsToMs(s) {
  const m = String(s).trim().match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const sec = parseInt(m[3], 10)
  const ms = parseInt(m[4], 10)
  return (((h * 60 + min) * 60 + sec) * 1000 + ms)
}

/** "40:06.370" (MM:SS.mmm) → ms within hour */
function mmSsFffToMs(s) {
  const m = String(s).trim().match(/^(\d{2}):(\d{2})\.(\d{3})$/)
  if (!m) return null
  const min = parseInt(m[1], 10)
  const sec = parseInt(m[2], 10)
  const frac = parseInt(m[3], 10)
  return (min * 60 + sec) * 1000 + frac
}

function diffHmsMs(endFull, startFull) {
  if (!endFull || !startFull) return null
  const a = fullHmsToMs(endFull)
  const b = fullHmsToMs(startFull)
  if (a == null || b == null) return null
  const d = a - b
  return d >= 0 ? Math.round(d) : null
}

/** Same-wall-clock delta: full `HH:MM:SS.mmm` first; fallback to MM:SS.mmm parsed as display clocks (short spans). */
function diffPerfClockMs(endStr, startStr) {
  const dStrict = diffHmsMs(endStr, startStr)
  if (dStrict != null) return dStrict
  if (!endStr || !startStr) return null
  const e = mmSsFffToMs(toDisplayMmSsFff(endStr))
  const s = mmSsFffToMs(toDisplayMmSsFff(startStr))
  if (e == null || s == null) return null
  const d = e - s
  return d >= 0 ? Math.round(d) : null
}

/** Normalise a timing field from console (string or `{ time: '…' }`). */
function normalizeConsoleTimingScalar(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const t = v.trim()
    return t || null
  }
  if (typeof v === 'object' && v !== null && 'time' in v) {
    return normalizeConsoleTimingScalar(v.time)
  }
  return null
}

function pickFromTimingObject(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const s = normalizeConsoleTimingScalar(obj[k])
    if (s) return s
  }
  return null
}

const CLK = '(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}|\\d{2}:\\d{2}\\.\\d{3})'

function extractFirstClockFromBlob(blob, pattern) {
  if (!blob) return null
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const m = re.exec(blob)
  return m ? m[1] : null
}

/**
 * Frontend CSV from **`Complete timing data for session`** (preferred), or incremental timing object fallback.
 *
 * Per production console instructor:
 * - `preDiscovery_start` → `requestSent` on timing object.
 * - `preDiscovery_end` → **first** standalone `Pre-discovery response at:` (extra bucket), then object keys.
 * - `discovery_start` → `discoveryRequest` on timing object.
 * - `discovery_end` → **first** `Discovery response at:`, then object.
 * - `stream_requested` → **first** `Stream requested at:`, then object.
 * - **`first_token`** (console merge): **`secondTokenReceived`** / **`second_token_received`**; capture phase may replace with
 *   closest **`Received token`** time vs backend `service:firstToken` (see `applyClosestReceivedTokenAsFirstToken`).
 */
function parseFrontendFromConsoleTiming(timingData, extra = {}) {
  const fallbackBlob = [
    ...(extra.fallbackLines || []),
    extra.pageTextFallback || ''
  ].join('\n')

  const td = timingData && typeof timingData === 'object' ? timingData : null

  let preDiscovery_start = td
    ? pickFromTimingObject(td, [
        'requestSent',
        'request_sent',
        'preDiscoveryRequest',
        'preDiscoveryRequestAt'
      ])
    : null

  /** Standalone FIRST (hook) overrides object ordering per instructor. */
  let preDiscovery_end =
    extra.preDiscoveryResponseAt ||
    pickFromTimingObject(td, ['preDiscoveryResponse', 'pre_discovery_response']) ||
    extractFirstClockFromBlob(
      fallbackBlob,
      new RegExp(`Pre-discovery\\s+response\\s+at:\\s*${CLK}`, 'i')
    )

  let discovery_start = td
    ? pickFromTimingObject(td, ['discoveryRequest', 'discovery_request'])
    : null

  let discovery_end =
    extra.discoveryResponseAt ||
    pickFromTimingObject(td, ['discoveryResponse', 'discovery_response', 'discoveryResponded']) ||
    extractFirstClockFromBlob(
      fallbackBlob,
      new RegExp(`Discovery\\s+response\\s+at:\\s*${CLK}`, 'i')
    ) ||
    extractFirstClockFromBlob(
      fallbackBlob,
      new RegExp(`Discovery\\s+response\\s+received:\\s*${CLK}`, 'i')
    )

  let stream_requested =
    extra.streamRequestedAt ||
    pickFromTimingObject(td, [
      'streamRequested',
      'stream_requested',
      'streamRequestAt',
      'streamRequestedAt'
    ]) ||
    extractFirstClockFromBlob(
      fallbackBlob,
      new RegExp(`Stream\\s+requested\\s+at:\\s*${CLK}`, 'i')
    ) ||
    extractFirstClockFromBlob(
      fallbackBlob,
      new RegExp(`Stream\\s+requested\\s+for\\s+session:\\s*\\S+\\s+${CLK}`, 'i')
    )

  let first_token =
    pickFromTimingObject(td, ['secondTokenReceived', 'second_token_received']) || null

  const refFull =
    [preDiscovery_start, preDiscovery_end, discovery_start, discovery_end, stream_requested, first_token].find(
      (t) => Boolean(t && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(t).trim()))
    ) || null
  if (refFull) {
    if (stream_requested) stream_requested = coerceToFullHms(stream_requested, refFull)
    if (first_token) first_token = coerceToFullHms(first_token, refFull)
    if (preDiscovery_start) preDiscovery_start = coerceToFullHms(preDiscovery_start, refFull)
    if (preDiscovery_end) preDiscovery_end = coerceToFullHms(preDiscovery_end, refFull)
    if (discovery_start) discovery_start = coerceToFullHms(discovery_start, refFull)
    if (discovery_end) discovery_end = coerceToFullHms(discovery_end, refFull)
  }

  let frontendLlmWaitMs = diffPerfClockMs(first_token, stream_requested)

  let frontendTotalToFirstMs = null
  if (preDiscovery_start && first_token) {
    const d = diffPerfClockMs(first_token, preDiscovery_start)
    if (d != null) frontendTotalToFirstMs = d
  }

  return {
    preDiscovery_start,
    preDiscovery_end,
    discovery_start,
    discovery_end,
    stream_requested,
    first_token,
    frontendLlmWaitMs,
    frontendTotalToFirstMs
  }
}

/** True when parsed **Performance Metrics** (DOM) has every clock + derived ms for the CSV frontend columns. */
function isConsoleFrontendCsvReady(parsedFrontend) {
  const f = parsedFrontend
  if (!f) return false
  if (
    !String(f.preDiscovery_start || '').trim() ||
    !String(f.preDiscovery_end || '').trim() ||
    !String(f.discovery_start || '').trim() ||
    !String(f.discovery_end || '').trim() ||
    !String(f.stream_requested || '').trim() ||
    !String(f.first_token || '').trim()
  ) {
    return false
  }
  if (f.frontendLlmWaitMs == null) return false
  // frontendTotalToFirstMs may be null when the "Time taken from search start…" label is absent
  // from the UI — fall back to computing it from timestamps (same as buildComparisonRows does).
  const totalFirst =
    f.frontendTotalToFirstMs != null
      ? f.frontendTotalToFirstMs
      : diffPerfClockMs(f.first_token, f.preDiscovery_start)
  if (totalFirst == null) return false
  return true
}

function diffMsDisplay(backendTimeStr, frontendTimeStr) {
  const bDisp = toDisplayMmSsFff(backendTimeStr)
  const fDisp = toDisplayMmSsFff(frontendTimeStr)
  const b = mmSsFffToMs(bDisp)
  const f = mmSsFffToMs(fDisp)
  if (b == null || f == null) return ''
  const d = b - f
  if (d === 0) return '0ms'
  if (d > 0) return `backend +${d}ms`
  return `frontend +${-d}ms`
}

/**
 * Backend Stage row: label then timestamp within a generous window (tabs / wrapped cells / two-line rows).
 * Latest match wins for stacked chats. Timestamps are always full `HH:MM:SS.mmm` in this table.
 */
function grabStageTime(text, stageLabel) {
  const escaped = stageLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /** Stage sometimes omits hour in flattened text (`MM:SS.mmm` — same clock as CSV display). */
  const re = new RegExp(
    `${escaped}[\\s\\S]{0,900}?(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}|\\d{2}:\\d{2}\\.\\d{3})`,
    'g'
  )
  let last = null
  let m
  while ((m = re.exec(text)) !== null) {
    last = m[1]
  }
  return last
}

function normalizeStageClocksRelatively(stages) {
  const keys = ['preDiscovery_start', 'preDiscovery_end', 'discovery_start', 'discovery_end', 'first_token']
  const vals = keys.map((k) => stages[k]).filter(Boolean)
  const ref = vals.find((v) => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(v).trim()))
  if (!ref) return stages
  const out = { ...stages }
  for (const k of keys) {
    const v = out[k]
    if (!v || /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(v).trim())) continue
    const c = coerceToFullHms(String(v).trim(), ref)
    if (c) out[k] = c
  }
  return out
}

/**
 * Indices of perf card titles in merged page text (EN / DE — same CSV panel).
 */
function allPerformanceMetricsAnchorStarts(blob) {
  const anchorRes = [
    /\bPerformance\s+Metrics\b/gi,
    /\bLeistungsmetriken\b/gi,
    /\bLeistungs\s*metriken\b/gi,
    /\bLeistungs\s*kennzahlen\b/gi,
    /\bPerformance[\s\-]*Metriken\b/gi
  ]
  const set = new Set()
  for (const re of anchorRes) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(blob)) !== null) {
      set.add(m.index)
    }
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * One assistant reply worth of flattened text — best "Performance Metrics" anchor onward.
 *
 * **Merged Cypress text** appends snapshots as the scroller steps **up**, so the **globally last**
 * title match can sit in a **narrow viewport** fragment (only the card header visible). Taking
 * `slice(lastIdx)` then **drops earlier chunks** that still held `Token received` below the Stage
 * table → `hasToken` / `first_token` false while `service:firstToken` stays true.
 *
 * Collect every title offset, then take **slice(start)** for the **largest** `start` where
 * `parseFrontendSteps` still extracts `first_token`. That is usually the **latest** turn’s panel chunk
 * that actually includes the numbered step / clock, not a cropped header-only viewport at the very
 * end of the merged string. If no anchor works, return **full blob** so earlier merge chunks are not
 * discarded.
 */
function sliceFromLastPerformanceMetricsBlock(text) {
  const blob = normalizePerfText(text).replace(/\r\n/g, '\n')
  const starts = allPerformanceMetricsAnchorStarts(blob)
  if (!starts.length) return blob
  let bestStart = null
  for (const idx of starts) {
    const ft = parseFrontendSteps(blob.slice(idx)).first_token
    if (ft && String(ft).trim()) bestStart = idx
  }
  if (bestStart != null) return blob.slice(bestStart)
  return blob
}

/**
 * Extract "HH:MM:SS.mmm" after a Performance Metrics step label. Handles:
 * - "1. Pre-Discovery Request: 16:41:04.542" (dot after step number, as in the UI)
 * - "1Pre-Discovery Request:" (no space / no dot — older layout)
 * - Multiple steps in one string (no newlines) when the DOM flattens text.
 * - Unicode / circled step numbers (❻, ⑥) — patterns that require ASCII `\d+` before the label
 *   will not match; the bare-label pattern handles "Token received: 16:40:27.189" with no digit prefix.
 */
function extractFrontendStepTime(fullText, labelLiteral) {
  const escaped = labelLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tsFull = '\\d{2}:\\d{2}:\\d{2}\\.\\d{3}'
  const tsShort = '\\d{2}:\\d{2}\\.\\d{3}'
  const ts = `(${tsFull}|${tsShort})`
  const patterns = [
    new RegExp(`\\d+\\.\\s*${escaped}\\s*:\\s*${ts}`, 'gi'),
    new RegExp(`\\d+\\s+${escaped}\\s*:\\s*${ts}`, 'gi'),
    new RegExp(`\\d+${escaped}\\s*:\\s*${ts}`, 'gi'),
    // Timestamp on next line after the label (common with flex/grid UI)
    new RegExp(`\\d+\\.?\\s*${escaped}\\s*:?\\s*\\n\\s*${ts}`, 'gi'),
    new RegExp(`\\d+\\.?\\s*${escaped}\\s*:?\\s*${ts}`, 'gim'),
    new RegExp(`${escaped}\\s*:?\\s*\\n\\s*${ts}`, 'gim'),
    // No step number — bare label then timestamp (also matches normal layout; last match wins)
    new RegExp(`${escaped}\\s*:?\\s*${ts}`, 'gim')
  ]
  const t = fullText.replace(/\r\n/g, '\n')
  let last = null
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(t)) !== null) {
      last = m[1]
    }
  }
  return last
}

/** Last-resort token time when labels are split or localized (English patterns tried first in readiness). */
function extractTokenReceivedLoose(blob) {
  const hmsFull = '\\d{2}:\\d{2}:\\d{2}\\.\\d{3}'
  const msShort = '\\d{2}:\\d{2}\\.\\d{3}'
  const clk = `(?:${hmsFull}|${msShort})`
  const patterns = [
    new RegExp(`Token\\s+received[\\s\\S]{0,120}?(${clk})`, 'gi'),
    new RegExp(`Token\\s+empfangen[\\s\\S]{0,120}?(${clk})`, 'gi'),
    new RegExp(`Token\\s+erhalten[\\s\\S]{0,120}?(${clk})`, 'gi'),
    new RegExp(`Erster\\s+Token[\\s\\S]{0,120}?(${clk})`, 'gi'),
    /** DE marketing copy sometimes uses genitive/stacked lines */
    new RegExp(`Empfangenen\\s+Token[\\s\\S]{0,120}?(${clk})`, 'gi')
  ]
  let last = null
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(blob)) !== null) {
      last = m[1]
    }
  }
  return last
}

function extractFrontendStepTimeLastAcrossAliases(fullText, labelLiterals) {
  let last = null
  for (const lit of labelLiterals) {
    const t = extractFrontendStepTime(fullText, lit)
    if (t) last = t
  }
  return last
}

/**
 * Parse "N. [any label]: HH:MM:SS.mmm" in the Performance Metrics block (fixed order: 5≈stream, 6≈token).
 * Use when English/German label text or Unicode bullets break label-only regexes but step numbers remain.
 */
function extractNumberedPerformanceMetricsSteps(section) {
  const map = new Map()
  if (!section) return map
  /** After `:` clock may be full `HH:MM:SS.mmm` or display `MM:SS.mmm` (hour omitted). */
  const re =
    /(?:^|\n)\s*(\d+)\s*[\.\)]\s*([\s\S]{1,600}?):\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/gim
  let m
  while ((m = re.exec(section)) !== null) {
    const n = parseInt(m[1], 10)
    if (n >= 1 && n <= 20) {
      map.set(n, m[3])
    }
  }
  const anyFull = [...map.values()].find((v) => v && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(v).trim()))
  if (anyFull) {
    for (const [k, v] of [...map.entries()]) {
      if (v && !/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(v).trim())) {
        map.set(k, coerceToFullHms(v, anyFull))
      }
    }
  }
  return map
}

/** End offset after last `service:firstToken` row (wider gap for table layout). */
function indexAfterLastServiceFirstTokenRow(text) {
  const re =
    /service\s*:\s*firstToken[\s\S]{0,900}?(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/gi
  let lastEnd = -1
  let m
  while ((m = re.exec(text)) !== null) {
    lastEnd = m.index + m[0].length
  }
  return lastEnd
}

/**
 * If `t` is `MM:SS.mmm` only, prepend hour from any full `referenceFull` `HH:MM:SS.mmm` on the same panel.
 */
function coerceToFullHms(t, referenceFull) {
  if (!t || !referenceFull) return t
  if (/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(t).trim())) return String(t).trim()
  const short = String(t).trim().match(/^(\d{2}):(\d{2})\.(\d{3})$/)
  const refH = String(referenceFull).trim().match(/^(\d{2}):/)
  if (short && refH) {
    return `${refH[1]}:${short[1]}:${short[2]}.${short[3]}`
  }
  return t
}

/** Latest Performance Metrics panel slice → frontend step clocks (DOM only). */
function parseFrontendPerfFromMergedDom(mergedPlainText) {
  const blob = normalizePerfText(mergedPlainText).replace(/\r\n/g, '\n')
  const slice = sliceFromLastPerformanceMetricsBlock(blob)
  return parseFrontendSteps(slice.length > 0 ? slice : blob)
}

/** True when **`parseBackendTable`** output satisfies backend columns on the CSV / **`turnRowsComplete`** (DOM). */
function isBackendStagingRowComplete(backendParsed) {
  if (!backendParsed?.stages) return false
  const bs = backendParsed.stages
  const keys = [
    'preDiscovery_start',
    'preDiscovery_end',
    'discovery_start',
    'discovery_end',
    'first_token'
  ]
  for (const k of keys) {
    if (!String(bs[k] || '').trim()) return false
  }
  if (backendParsed.backendLlmWaitMs == null || !Number.isFinite(backendParsed.backendLlmWaitMs)) return false
  const backendTotalToFirstMs = diffPerfClockMs(bs.first_token, bs.preDiscovery_start)
  if (backendTotalToFirstMs != null && Number.isFinite(backendTotalToFirstMs)) return true
  return backendParsed.totalMs != null && Number.isFinite(backendParsed.totalMs)
}

/**
 * DOM-only readiness: **`parseBackendTable`** over the full merged blob + **`parseFrontendPerfFromMergedDom`**.
 * Aligns with **`turnRowsComplete`** (no console timing).
 */
function perfPanelsReadyDiagnostics(text) {
  if (!text || typeof text !== 'string') {
    return {
      ready: false,
      checks: {},
      length: 0
    }
  }

  const blob = normalizePerfText(text).replace(/\r\n/g, '\n')
  const backendParsed = parseBackendTable(blob)
  let frontendParsed = parseFrontendPerfFromMergedDom(blob)
  if (frontendParsed && !String(frontendParsed.first_token || '').trim()) {
    frontendParsed = applyBackendClockInferenceForFrontend(frontendParsed, backendParsed)
  }

  const hasPerfBlock =
    /Performance\s+Metrics/i.test(blob) ||
    /Leistungsmetriken/i.test(blob) ||
    /Leistungs\s*metriken/i.test(blob) ||
    /Performance[\s\-]*Metriken/i.test(blob) ||
    /access_time/i.test(blob) ||
    (/Stage/i.test(blob) && (/Timestamp/i.test(blob) || /DELTA/i.test(blob)))
  const hasCompleteOrTable =
    /\d+\.?\s*Complete\s*:/i.test(blob) ||
    /\d*Complete\s*:/i.test(blob) ||
    /\bTotal\b[\s\S]{0,120}?\d+\s*ms/i.test(blob)

  const hasBackendRows = isBackendStagingRowComplete(backendParsed)
  const hasFrontendCsv = isConsoleFrontendCsvReady(frontendParsed)

  const feFields = {
    pd_start: Boolean(String(frontendParsed?.preDiscovery_start || '').trim()),
    pd_end: Boolean(String(frontendParsed?.preDiscovery_end || '').trim()),
    disc_start: Boolean(String(frontendParsed?.discovery_start || '').trim()),
    disc_end: Boolean(String(frontendParsed?.discovery_end || '').trim()),
    stream: Boolean(String(frontendParsed?.stream_requested || '').trim()),
    token: Boolean(String(frontendParsed?.first_token || '').trim()),
    llm_ms: frontendParsed?.frontendLlmWaitMs != null
  }

  const checks = {
    hasBackendRows,
    hasFrontendCsv,
    hasPerfBlock,
    hasCompleteOrTable,
    feFields
  }
  const ready = Boolean(hasPerfBlock && hasCompleteOrTable && hasBackendRows && hasFrontendCsv)
  return { ready, checks, length: text.length, frontendParsed }
}

function perfPanelsReadyForCapture(text) {
  return perfPanelsReadyDiagnostics(text).ready
}

function parseBackendTable(text) {
  const t = normalizePerfText(text)
  const stages = {}
  stages.preDiscovery_start = grabStageTime(t, 'preDiscovery:start')
  stages.preDiscovery_end = grabStageTime(t, 'preDiscovery:resolved')
  stages.discovery_start = grabStageTime(t, 'discovery:start')
  stages.discovery_end = grabStageTime(t, 'discovery:ragServiceCall')
  stages.first_token = grabStageTime(t, 'service:firstToken')
  Object.assign(stages, normalizeStageClocksRelatively(stages))

  let totalMs = null
  // "Total" and "21395 ms" may be on separate lines in the Stage table
  const totalRe = /\bTotal\b[\s\S]{0,80}?(\d+)\s*ms/gi
  let tm
  while ((tm = totalRe.exec(t)) !== null) {
    totalMs = parseInt(tm[1], 10)
  }

  const rag = stages.discovery_end /** discovery:ragServiceCall */
  const ft = stages.first_token /** service:firstToken */
  /** Column “backend LLM until …”: RAG service call → first token (not the full pipeline). */
  const backendLlmWaitMs = diffPerfClockMs(ft, rag)

  return { stages, totalMs, backendLlmWaitMs }
}

function timingObjectFieldBag(td) {
  if (!td || typeof td !== 'object') return {}
  const bag = {}
  const nestKeys = ['stages', 'stageTimings', 'backendStages', 'performance', 'timing']
  for (const nk of nestKeys) {
    const sub = td[nk]
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) Object.assign(bag, sub)
  }
  Object.assign(bag, td)
  return bag
}

function fillBackendStagesFromTextBlob(stages, blob) {
  const b = blob && String(blob).trim() ? String(blob) : ''
  if (!b) return
  if (!String(stages.preDiscovery_start || '').trim()) {
    stages.preDiscovery_start = grabStageTime(b, 'preDiscovery:start')
  }
  if (!String(stages.preDiscovery_end || '').trim()) {
    stages.preDiscovery_end = grabStageTime(b, 'preDiscovery:resolved')
  }
  if (!String(stages.discovery_start || '').trim()) {
    stages.discovery_start = grabStageTime(b, 'discovery:start')
  }
  if (!String(stages.discovery_end || '').trim()) {
    stages.discovery_end = grabStageTime(b, 'discovery:ragServiceCall')
  }
  if (!String(stages.first_token || '').trim()) {
    stages.first_token = grabStageTime(b, 'service:firstToken')
  }
}

function finalizeParsedBackendStages(stages, tdForTotalMs) {
  if (!Object.values(stages).some((v) => v != null && String(v).trim())) return null
  Object.assign(stages, normalizeStageClocksRelatively(stages))

  let totalMs = null
  if (tdForTotalMs && typeof tdForTotalMs === 'object') {
    for (const k of ['totalMs', 'total_pipeline_ms', 'pipelineTotalMs']) {
      const n = Number(tdForTotalMs[k])
      if (Number.isFinite(n)) {
        totalMs = Math.round(n)
        break
      }
    }
  }

  const rag = stages.discovery_end
  const ft = stages.first_token
  const backendLlmWaitMs = diffPerfClockMs(ft, rag)

  return { stages, totalMs, backendLlmWaitMs }
}

/**
 * Same five Stage rows as {@link parseBackendTable}, from the AUT timing object + optional hook buffer (`fallbackLines`).
 * Aligns camelCase **`completeTiming`** (e.g. `requestSent`) to Stage semantics when colon-keys are absent.
 */
function parseBackendFromTimingObject(td, supplementalBlob = '') {
  if (!td || typeof td !== 'object') {
    const stagesOnly = {}
    fillBackendStagesFromTextBlob(stagesOnly, supplementalBlob)
    return finalizeParsedBackendStages(stagesOnly, null)
  }

  const bag = timingObjectFieldBag(td)

  const stages = {}
  stages.preDiscovery_start = pickFromTimingObject(bag, [
    'preDiscovery:start',
    'preDiscoveryStart',
    /** Same instant as Performance Metrics “start” — often the only populated anchor in `completeTiming`. */
    'requestSent',
    'request_sent',
    'preDiscoveryRequestAt'
  ])
  stages.preDiscovery_end = pickFromTimingObject(bag, [
    'preDiscovery:resolved',
    'preDiscoveryResolved',
    'preDiscoveryComplete',
    'preDiscoveryResponse',
    'pre_discovery_response'
  ])
  stages.discovery_start = pickFromTimingObject(bag, ['discovery:start', 'discoveryStart', 'discoveryRequest'])
  stages.discovery_end = pickFromTimingObject(bag, [
    'discovery:ragServiceCall',
    'discoveryRagServiceCall',
    'ragServiceCall',
    'ragCallStart',
    'discoveryRAGServiceCall'
  ])
  stages.first_token = pickFromTimingObject(bag, ['service:firstToken', 'serviceFirstToken'])

  const jsonBlob = td ? JSON.stringify(td) : ''
  const megaBlob = [supplementalBlob, jsonBlob].filter(Boolean).join('\n')
  fillBackendStagesFromTextBlob(stages, megaBlob)

  if (!Object.values(stages).some((v) => v != null && String(v).trim())) return null
  return finalizeParsedBackendStages(stages, td)
}

/** Prefer DOM table; fill any missing Stage row from **`completeTiming`** (+ hook **`fallbackLines`**). */
function mergeBackendTableWithTimingObject(domParsed, timingData, fallbackLines) {
  if (!domParsed) return domParsed
  const blob = Array.isArray(fallbackLines) ? fallbackLines.join('\n') : String(fallbackLines || '')
  const fromTiming = parseBackendFromTimingObject(timingData, blob)
  if (!fromTiming) return domParsed

  const keys = [
    'preDiscovery_start',
    'preDiscovery_end',
    'discovery_start',
    'discovery_end',
    'first_token'
  ]
  const merged = { ...domParsed.stages }
  for (const k of keys) {
    const v = merged[k]
    if (v == null || !String(v).trim()) {
      const t = fromTiming.stages[k]
      if (t != null && String(t).trim()) merged[k] = t
    }
  }
  Object.assign(merged, normalizeStageClocksRelatively(merged))

  const totalMs = domParsed.totalMs != null ? domParsed.totalMs : fromTiming.totalMs
  const rag = merged.discovery_end
  const ft = merged.first_token
  const backendLlmWaitMs = diffPerfClockMs(ft, rag)

  return { stages: merged, totalMs, backendLlmWaitMs }
}

/**
 * Performance Metrics list (screenshot): numbered steps with wall-clock times; optional steps 6–8.
 */
function parseFrontendSteps(text) {
  const blob = normalizePerfText(text).replace(/\r\n/g, '\n')

  const preReq = extractFrontendStepTime(
    blob,
    'Pre-Discovery Request'
  )
  const preRes = extractFrontendStepTime(blob, 'Pre-Discovery response')
  const discReq = extractFrontendStepTime(blob, 'Discovery request')
  const discRes = extractFrontendStepTime(blob, 'Discovery response')
  let stream = extractFrontendStepTimeLastAcrossAliases(blob, [
    'Stream Requested',
    'Stream requested',
    'Stream angefordert',
    'Stream URL'
  ])
  let firstTok = extractFrontendStepTimeLastAcrossAliases(blob, [
    'Token received',
    'Token Received',
    'Token empfangen',
    'Erster Token'
  ])
  if (!firstTok) {
    firstTok = extractTokenReceivedLoose(blob)
  }

  const pmIdx = blob.search(
    /Performance\s+Metrics|Leistungsmetriken|Leistungs\s*metriken|Performance[\s\-]*Metriken/i
  )
  /** Long slice from PM header (backend table can be huge). */
  const pmSection =
    pmIdx === -1 ? '' : blob.slice(pmIdx, Math.min(pmIdx + 2000000, blob.length))

  const afterFt = indexAfterLastServiceFirstTokenRow(blob)
  const sectionAfterBackend =
    afterFt >= 0 && afterFt < blob.length
      ? blob.slice(afterFt, Math.min(afterFt + 2000000, blob.length))
      : ''

  /** Full `blob` — shadow/text order may interleave PM and Stage unlike the screen; never rely on slice-after-anchor alone. */
  const stepMapFull = extractNumberedPerformanceMetricsSteps(blob)
  const stepMapPm = extractNumberedPerformanceMetricsSteps(pmSection)
  const stepMapAfterBackend = extractNumberedPerformanceMetricsSteps(sectionAfterBackend)

  if (!stream) {
    stream =
      stepMapFull.get(5) ||
      stepMapAfterBackend.get(5) ||
      stepMapPm.get(5) ||
      null
  }
  if (!firstTok) {
    firstTok =
      stepMapFull.get(6) ||
      stepMapAfterBackend.get(6) ||
      stepMapPm.get(6) ||
      null
  }

  /** Re-run label matchers on text after the Stage table (stream lines follow backend in DOM order). */
  if (!stream || !firstTok) {
    const tail = sectionAfterBackend || blob
    if (!stream) {
      stream =
        extractFrontendStepTimeLastAcrossAliases(tail, [
          'Stream Requested',
          'Stream requested',
          'Stream angefordert',
          'Stream URL'
        ]) || stream
    }
    if (!firstTok) {
      firstTok =
        extractFrontendStepTimeLastAcrossAliases(tail, [
          'Token received',
          'Token Received',
          'Token empfangen',
          'Erster Token'
        ]) ||
        extractTokenReceivedLoose(tail) ||
        firstTok
    }
  }

  if (!firstTok) {
    firstTok =
      stepMapFull.get(7) ||
      stepMapAfterBackend.get(7) ||
      stepMapPm.get(7) ||
      stepMapFull.get(8) ||
      stepMapAfterBackend.get(8) ||
      stepMapPm.get(8) ||
      null
  }

  const refFull =
    [
      preReq, preRes, discReq, discRes,
      stepMapFull.get(1), stepMapFull.get(2), stepMapAfterBackend.get(1), stepMapAfterBackend.get(2),
      stepMapPm.get(1), stepMapPm.get(2),
      stream, firstTok
    ].find((t) =>
      Boolean(t && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(t).trim()))
    ) || null
  if (refFull) {
    if (stream) stream = coerceToFullHms(stream, refFull)
    if (firstTok) firstTok = coerceToFullHms(firstTok, refFull)
  }

  // Steps 1–4: English label match is primary; numbered-step map is fallback for localized UIs (e.g. German staging).
  const out = {
    preDiscovery_start: preReq || stepMapFull.get(1) || stepMapAfterBackend.get(1) || stepMapPm.get(1) || null,
    preDiscovery_end: preRes || stepMapFull.get(2) || stepMapAfterBackend.get(2) || stepMapPm.get(2) || null,
    discovery_start: discReq || stepMapFull.get(3) || stepMapAfterBackend.get(3) || stepMapPm.get(3) || null,
    discovery_end: discRes || stepMapFull.get(4) || stepMapAfterBackend.get(4) || stepMapPm.get(4) || null,
    stream_requested: stream,
    first_token: firstTok
  }

  /** Column “frontend LLM until …”: Stream Requested → Token received. */
  let frontendLlmWaitMs = diffPerfClockMs(out.first_token, out.stream_requested)
  /** Fallback only: UI step “Difference in response time for stream” (same window as above). */
  if (frontendLlmWaitMs == null) {
    const diffBlobs = [sectionAfterBackend, blob].filter(Boolean)
    const diffRes = [
      /Difference in response time for stream\s*:\s*([\d.]+)\s*s/gi,
      /Unterschied[^\n]{0,60}Stream[^\n]{0,40}:\s*([\d.]+)\s*s/gi,
      /Antwortzeit[^\n]{0,40}Stream[^\n]{0,40}:\s*([\d.]+)\s*s/gi
    ]
    outer: for (const b of diffBlobs) {
      for (const pattern of diffRes) {
        const re = new RegExp(pattern.source, pattern.flags)
        let m
        let lastDiff = null
        while ((m = re.exec(b)) !== null) {
          lastDiff = m[1]
        }
        if (lastDiff != null) {
          const sec = parseFloat(lastDiff, 10)
          if (!Number.isNaN(sec)) {
            frontendLlmWaitMs = Math.round(sec * 1000)
            break outer
          }
        }
      }
    }
  }

  let frontendTotalToFirstMs = null
  /** Fallback: parse “Time taken from search start until the first token … Xs” if timestamps missing. */
  const secPatterns = [
    /Time taken from search start until the first token is received\s*:\s*([\d.]+)\s*s\b/gi,
    /Time taken from search start until the first token[^\d]*([\d.]+)\s*s\b/gi,
    // Label and value split across lines (same as screenshot layout variants)
    /Time taken from search start until the first token is received[\s\S]{0,120}?([\d.]+)\s*s\b/gi,
    // German UI (staging)
    /Zeit[^.\d\n]{0,120}ersten\s+Token[^.\d\n]{0,120}([\d.]+)\s*s\b/gi,
    /von\s+der\s+Suche[^.\d\n]{0,120}ersten\s+Token[^.\d\n]{0,120}([\d.]+)\s*s\b/gi
  ]
  const timeBlobs = [sectionAfterBackend, blob].filter(Boolean)
  outerTime: for (const tb of timeBlobs) {
    for (const pattern of secPatterns) {
      const re = new RegExp(pattern.source, pattern.flags)
      let secMatch
      let lastSec = null
      while ((secMatch = re.exec(tb)) !== null) {
        lastSec = secMatch[1]
      }
      if (lastSec != null) {
        frontendTotalToFirstMs = Math.round(parseFloat(lastSec, 10) * 1000)
        break outerTime
      }
    }
  }

  return { ...out, frontendLlmWaitMs, frontendTotalToFirstMs }
}

/** Non-empty trimmed string helper for merge picks. */
function pickFrontendClock(domVal, consoleVal) {
  const ds = domVal != null && String(domVal).trim() !== '' ? domVal : null
  if (ds) return ds
  const cs = consoleVal != null && String(consoleVal).trim() !== '' ? consoleVal : null
  return cs
}

/**
 * Same workflow as manual `performance_comparison_round4.csv`: **Performance Metrics DOM** is authoritative.
 * Cypress console capture fills **only** fields the merged page text did not expose (e.g. missing steps 6–8).
 */
function mergeDomManualPrimaryWithConsoleFallback(domFe, consoleFe) {
  const d = domFe || {}
  const c = consoleFe || {}

  const out = {
    preDiscovery_start: pickFrontendClock(d.preDiscovery_start, c.preDiscovery_start),
    preDiscovery_end: pickFrontendClock(d.preDiscovery_end, c.preDiscovery_end),
    discovery_start: pickFrontendClock(d.discovery_start, c.discovery_start),
    discovery_end: pickFrontendClock(d.discovery_end, c.discovery_end),
    stream_requested: pickFrontendClock(d.stream_requested, c.stream_requested),
    first_token: pickFrontendClock(d.first_token, c.first_token)
  }

  let frontendLlmWaitMs = diffPerfClockMs(out.first_token, out.stream_requested)
  if (frontendLlmWaitMs == null && d.frontendLlmWaitMs != null && Number.isFinite(d.frontendLlmWaitMs)) {
    frontendLlmWaitMs = d.frontendLlmWaitMs
  }
  if (frontendLlmWaitMs == null && c.frontendLlmWaitMs != null && Number.isFinite(c.frontendLlmWaitMs)) {
    frontendLlmWaitMs = c.frontendLlmWaitMs
  }

  let frontendTotalToFirstMs = null
  if (out.preDiscovery_start && out.first_token) {
    frontendTotalToFirstMs = diffPerfClockMs(out.first_token, out.preDiscovery_start)
  }
  if (frontendTotalToFirstMs == null) {
    if (d.frontendTotalToFirstMs != null) frontendTotalToFirstMs = d.frontendTotalToFirstMs
    else if (c.frontendTotalToFirstMs != null) frontendTotalToFirstMs = c.frontendTotalToFirstMs
  }

  return { ...out, frontendLlmWaitMs, frontendTotalToFirstMs }
}

/**
 * After merge, set **`first_token`** to the **`Received token`** time whose clock is closest to backend
 * **`service:firstToken`** (when both sides are available).
 */
function applyClosestReceivedTokenAsFirstToken(frontendParsed, bucket, backendParsed) {
  if (!frontendParsed || !backendParsed?.stages) return
  const allTokens = bucket?.allReceivedTokenTimes || []
  const bft = backendParsed.stages.first_token
  if (!allTokens.length || !bft) return
  let frontendToken = null
  let bestDiff = Infinity
  for (const t of allTokens) {
    const d = Math.abs(diffPerfClockMs(t, bft) ?? Infinity)
    if (d < bestDiff) {
      bestDiff = d
      frontendToken = t
    }
  }
  if (frontendToken == null) return

  frontendParsed.first_token = frontendToken
  if (frontendParsed.stream_requested != null && String(frontendParsed.stream_requested).trim()) {
    frontendParsed.frontendLlmWaitMs = diffPerfClockMs(
      frontendToken,
      frontendParsed.stream_requested
    )
  }
  if (frontendParsed.preDiscovery_start != null && String(frontendParsed.preDiscovery_start).trim()) {
    frontendParsed.frontendTotalToFirstMs = diffPerfClockMs(
      frontendToken,
      frontendParsed.preDiscovery_start
    )
  }
}

/** DOM-primary + **`parseFrontendFromConsoleTiming`** merge (non-staging flows or custom tools that still attach a timing bucket). */
function mergedFrontendFromPageAndBucket(normalizedText, bucketOrNull) {
  const blob = normalizePerfText(normalizedText).replace(/\r\n/g, '\n')
  const bucket = bucketOrNull || {}
  const timingObj =
    bucket.completeTiming || bucket.incrementalTiming
      ? bucket.completeTiming || bucket.incrementalTiming
      : null

  const extra = {
    preDiscoveryResponseAt: bucket.preDiscoveryResponseAt ?? null,
    discoveryResponseAt: bucket.discoveryResponseAt ?? null,
    streamRequestedAt: bucket.streamRequestedAt ?? null,
    fallbackLines: bucket.fallbackLines || [],
    pageTextFallback: blob
  }

  const slice = sliceFromLastPerformanceMetricsBlock(blob)
  const domFe = parseFrontendSteps(slice.length > 0 ? slice : blob)
  const consoleFe = parseFrontendFromConsoleTiming(timingObj, extra)
  return mergeDomManualPrimaryWithConsoleFallback(domFe, consoleFe)
}

function metricRow(turnLabel, metricKey, backendFull, frontendFull) {
  const diff =
    backendFull && frontendFull ? diffMsDisplay(backendFull, frontendFull) : ''
  return {
    turn: turnLabel,
    metric: metricKey,
    backend: backendFull ? toDisplayMmSsFff(backendFull) : '',
    frontend: frontendFull ? toDisplayMmSsFff(frontendFull) : '',
    difference: diff,
    backendLlm: '',
    frontendLlm: '',
    backendTotalFirst: '',
    frontendTotalFirst: ''
  }
}

/**
 * Build rows matching performance_comparison_round4.csv shape.
 */
function buildComparisonRows(turnIndex, backendParsed, frontendParsed) {
  const turnLabel = `Turn ${turnIndex}`
  const bs = backendParsed.stages || {}
  const fs = frontendParsed

  const rows = []

  rows.push(
    metricRow(turnLabel, 'preDiscovery_start', bs.preDiscovery_start, fs.preDiscovery_start)
  )
  rows.push(metricRow(turnLabel, 'preDiscovery_end', bs.preDiscovery_end, fs.preDiscovery_end))
  rows.push(metricRow(turnLabel, 'discovery_start', bs.discovery_start, fs.discovery_start))
  rows.push(metricRow(turnLabel, 'discovery_end', bs.discovery_end, fs.discovery_end))

  const ftDiff =
    bs.first_token && fs.first_token
      ? diffMsDisplay(bs.first_token, fs.first_token)
      : ''

  const backendTotalToFirstMs = diffPerfClockMs(bs.first_token, bs.preDiscovery_start)
  const frontendTotalToFirstMsE2e = diffPerfClockMs(fs.first_token, fs.preDiscovery_start)

  rows.push({
    turn: turnLabel,
    metric: 'first_token',
    backend: bs.first_token ? toDisplayMmSsFff(bs.first_token) : '',
    frontend: fs.first_token ? toDisplayMmSsFff(fs.first_token) : '',
    difference: ftDiff,
    backendLlm:
      backendParsed.backendLlmWaitMs != null ? `${backendParsed.backendLlmWaitMs}ms` : '',
    frontendLlm:
      frontendParsed.frontendLlmWaitMs != null ? `${frontendParsed.frontendLlmWaitMs}ms` : '',
    backendTotalFirst:
      backendTotalToFirstMs != null
        ? `${backendTotalToFirstMs}ms`
        : backendParsed.totalMs != null
          ? `${backendParsed.totalMs}ms`
          : '',
    frontendTotalFirst:
      frontendTotalToFirstMsE2e != null
        ? `${frontendTotalToFirstMsE2e}ms`
        : frontendParsed.frontendTotalToFirstMs != null
          ? `${frontendParsed.frontendTotalToFirstMs}ms`
          : ''
  })

  return rows
}

function turnRowsComplete(rows) {
  if (!rows || !rows.length) return false
  for (const r of rows) {
    if (!String(r.backend || '').trim() || !String(r.frontend || '').trim()) return false
    if (r.metric === 'first_token') {
      if (
        !String(r.backendLlm || '').trim() ||
        !String(r.frontendLlm || '').trim() ||
        !String(r.backendTotalFirst || '').trim() ||
        !String(r.frontendTotalFirst || '').trim()
      ) {
        return false
      }
    }
  }
  return true
}

/** For assertion messages — `first_token` row is the only one with LLM/total columns. */
function turnRowsCompleteFailureDetail(rows) {
  if (!rows || !rows.length) return 'no rows'
  const bad = rows.find(
    (r) =>
      !String(r.backend || '').trim() ||
      !String(r.frontend || '').trim() ||
      (r.metric === 'first_token' &&
        (!String(r.backendLlm || '').trim() ||
          !String(r.frontendLlm || '').trim() ||
          !String(r.backendTotalFirst || '').trim() ||
          !String(r.frontendTotalFirst || '').trim()))
  )
  if (!bad) return 'unknown'
  return JSON.stringify(bad)
}

/**
 * When the frontend Performance Metrics card renders steps 6–8 (Token received, etc.) inside a
 * **closed** shadow root, `textFromNodeDeep` cannot read them. In that case we infer `first_token`
 * from the backend `service:firstToken` timestamp plus the **measured clock offset** between the
 * two clocks (typically an integer number of hours = timezone difference, e.g. UTC vs CEST +2h).
 *
 * The offset is derived from the corresponding `preDiscovery_start` pair — the same physical event
 * logged by both sides — so the inferred timestamp is as accurate as the clock skew between the
 * two systems (typically < 200 ms). The method is skipped when the offset is not within 2 minutes
 * of an exact hour boundary (not a timezone offset) or when any anchor timestamp is missing.
 */
function applyBackendClockInferenceForFrontend(frontendParsed, backendParsed) {
  if (!frontendParsed || !backendParsed?.stages) return frontendParsed
  const feStart = fullHmsToMs(frontendParsed.preDiscovery_start)
  const beStart = fullHmsToMs(backendParsed.stages.preDiscovery_start)
  const beFirstToken = fullHmsToMs(backendParsed.stages.first_token)
  if (feStart == null || beStart == null || beFirstToken == null) return frontendParsed
  const offsetMs = feStart - beStart
  const hoursRounded = Math.round(offsetMs / 3600000)
  if (Math.abs(offsetMs - hoursRounded * 3600000) > 120000) return frontendParsed
  const feFirstTokenMs = beFirstToken + offsetMs
  if (feFirstTokenMs < 0 || feFirstTokenMs >= 86400000) return frontendParsed
  const h = Math.floor(feFirstTokenMs / 3600000)
  const rem = feFirstTokenMs % 3600000
  const m = Math.floor(rem / 60000)
  const s = Math.floor((rem % 60000) / 1000)
  const ms = rem % 1000
  const inferredToken = [
    String(h).padStart(2, '0'),
    ':',
    String(m).padStart(2, '0'),
    ':',
    String(s).padStart(2, '0'),
    '.',
    String(ms).padStart(3, '0')
  ].join('')
  const updated = { ...frontendParsed, first_token: inferredToken }
  updated.frontendLlmWaitMs = diffPerfClockMs(inferredToken, updated.stream_requested)
  if (updated.preDiscovery_start) {
    updated.frontendTotalToFirstMs = diffPerfClockMs(inferredToken, updated.preDiscovery_start)
  }
  return updated
}

/** Full merged DOM text → CSV-shaped backend + frontend parses (no console timing). */
function parsePerformanceFromMergedPageDOM(fullPageText) {
  const normalized = normalizePerfText(fullPageText).replace(/\r\n/g, '\n')
  const backendParsed = parseBackendTable(normalized)
  let frontendParsed = parseFrontendPerfFromMergedDom(normalized)
  if (frontendParsed && !String(frontendParsed.first_token || '').trim()) {
    frontendParsed = applyBackendClockInferenceForFrontend(frontendParsed, backendParsed)
  }
  return { backendParsed, frontendParsed }
}

/**
 * Full parse with console bucket: DOM is primary, console timing fills gaps (especially `first_token`
 * which lives in closed shadow DOM on staging). `allReceivedTokenTimes` → closest to backend
 * `service:firstToken` is used as the actual frontend token receipt time, giving a real
 * `Frontend_total_to_first_token` that differs from the backend total by network latency.
 * Falls back to backend clock inference only if the bucket has no token data.
 */
function parsePerformanceFromMergedPageWithBucket(fullPageText, bucket) {
  const normalized = normalizePerfText(fullPageText).replace(/\r\n/g, '\n')
  const backendParsed = parseBackendTable(normalized)
  let frontendParsed = mergedFrontendFromPageAndBucket(normalized, bucket || {})
  applyClosestReceivedTokenAsFirstToken(frontendParsed, bucket || {}, backendParsed)
  if (frontendParsed && !String(frontendParsed.first_token || '').trim()) {
    frontendParsed = applyBackendClockInferenceForFrontend(frontendParsed, backendParsed)
  }
  return { backendParsed, frontendParsed }
}

/** @deprecated Use {@link parsePerformanceFromMergedPageDOM}; **`bucket`** is ignored (DOM-only capture). */
function parsePerformanceFromMergedPageAndConsole(fullPageText, _bucket) {
  void _bucket
  return parsePerformanceFromMergedPageDOM(fullPageText)
}

function parsePerformanceFromMergedPage(fullPageText) {
  const normalized = normalizePerfText(fullPageText).replace(/\r\n/g, '\n')
  const slice = sliceFromLastPerformanceMetricsBlock(normalized)
  const parseChunk = (chunk) => ({
    backendParsed: parseBackendTable(chunk),
    frontendParsed: parseFrontendSteps(chunk)
  })
  const tryComplete = (chunk) => {
    if (!chunk || !String(chunk).trim()) return null
    const p = parseChunk(chunk)
    const rows = buildComparisonRows(1, p.backendParsed, p.frontendParsed)
    return turnRowsComplete(rows) ? p : null
  }
  const fromSlice = tryComplete(slice)
  if (fromSlice) return fromSlice
  if (slice.length < normalized.length) {
    const fromFull = tryComplete(normalized)
    if (fromFull) return fromFull
  }
  return parseChunk(slice)
}

function rowsToCsv(allRows) {
  const header =
    'Turn,Metric,Backend,Frontend,Difference,backend LLM until the first token arrive,frontend LLM until the first token arrive,Backend_total_to_first_token,Frontend_total_to_first_token'
  const lines = [header]
  for (const r of allRows) {
    lines.push(
      [
        escapeCsv(r.turn),
        escapeCsv(r.metric),
        escapeCsv(r.backend),
        escapeCsv(r.frontend),
        escapeCsv(r.difference),
        escapeCsv(r.backendLlm),
        escapeCsv(r.frontendLlm),
        escapeCsv(r.backendTotalFirst),
        escapeCsv(r.frontendTotalFirst)
      ].join(',')
    )
  }
  return lines.join('\n')
}

function escapeCsv(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

module.exports = {
  toDisplayMmSsFff,
  normalizePerfText,
  parseBackendTable,
  parseFrontendSteps,
  parseFrontendFromConsoleTiming,
  diffPerfClockMs,
  isConsoleFrontendCsvReady,
  buildComparisonRows,
  rowsToCsv,
  perfPanelsReadyForCapture,
  perfPanelsReadyDiagnostics,
  turnRowsComplete,
  turnRowsCompleteFailureDetail,
  sliceFromLastPerformanceMetricsBlock,
  parsePerformanceFromMergedPage,
  parsePerformanceFromMergedPageDOM,
  parsePerformanceFromMergedPageAndConsole,
  parseFrontendPerfFromMergedDom,
  isBackendStagingRowComplete,
  mergedFrontendFromPageAndBucket,
  applyBackendClockInferenceForFrontend,
  applyClosestReceivedTokenAsFirstToken,
  parsePerformanceFromMergedPageWithBucket
}
