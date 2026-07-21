/**
 * Read the backend Stage table straight from the DOM (cells → CSV rows).
 * No regex on merged page text — same values you see in the table.
 */

const { textFromNodeDeep, querySelectorAllDeep, querySelectorDeep } = require('./perf-shadow-text')

// Stage name pattern. Allows the renamed-on-2026-05-28 stage
// "discovery:canUserAccessRag + vectorSearchResult" (spaces + plus signs)
// and the older "preDiscovery:shouldRetrieve+getKeywords" form.
const STAGE_CELL_RE = /^[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z0-9+ ]+)+$/
const HEADER_STAGE = /^stage$/i
const HEADER_TIMESTAMP = /^timestamp$/i

function cellText(el) {
  if (!el) return ''
  return String(el.innerText || el.textContent || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function isHeaderRow(texts) {
  return (
    texts.length >= 2 &&
    HEADER_STAGE.test(texts[0]) &&
    HEADER_TIMESTAMP.test(texts[1])
  )
}

function rowFromCellTexts(texts) {
  if (!texts.length) return null
  if (isHeaderRow(texts)) return null

  if (/^total$/i.test(texts[0])) {
    const delta = texts.length >= 3 ? texts[2] : texts[1]
    return {
      STAGE: 'Total',
      TIMESTAMP: texts.length >= 3 ? texts[1] : '',
      'DELTA (MS)': delta || ''
    }
  }

  if (texts.length < 3) return null
  if (!STAGE_CELL_RE.test(texts[0]) && !/^total$/i.test(texts[0])) return null

  return {
    STAGE: texts[0],
    TIMESTAMP: texts[1],
    'DELTA (MS)': texts[2]
  }
}

function extractRowsFromTableElement(table) {
  const rows = []
  const trs = table.querySelectorAll('tr')
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i]
    const cells = [...tr.querySelectorAll('th, td')]
    if (!cells.length) continue
    const texts = cells.map(cellText)
    const row = rowFromCellTexts(texts)
    if (row) rows.push(row)
  }
  return rows
}

function tableLooksLikeStageTable(table) {
  const t = (table.innerText || table.textContent || '').replace(/\s+/g, ' ')
  return /preDiscovery\s*:\s*start/i.test(t) && /service\s*:\s*firstToken/i.test(t)
}

function findStageTableElements(body) {
  const tables = querySelectorAllDeep(body, 'table').filter(tableLooksLikeStageTable)
  if (tables.length) return tables
  return querySelectorAllDeep(body, '[role="table"]').filter(tableLooksLikeStageTable)
}

/**
 * Last matching Stage `<table>` on the page (latest turn).
 * @param {HTMLElement} body
 */
function findBackendStageTableElement(body) {
  const tables = findStageTableElements(body)
  return tables.length ? tables[tables.length - 1] : null
}

/**
 * All `<tr>` rows in the document that look like Stage data rows; keep the last block (latest turn).
 */
function collectRowBlocksFromElements(elements, cellSelector) {
  const blocks = []
  let current = []

  const flush = () => {
    if (current.length) blocks.push(current)
    current = []
  }

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    const cells = cellSelector
      ? [...el.querySelectorAll(cellSelector)]
      : [...el.children]
    const texts = cells.map(cellText)
    const row = rowFromCellTexts(texts)
    if (row) {
      current.push(row)
    } else if (current.length) {
      flush()
    }
  }
  flush()
  return blocks
}

function extractRowsFromDocumentTrs(body) {
  const trs = querySelectorAllDeep(body, 'tr')
  const blocks = collectRowBlocksFromElements(trs, 'th, td')
  if (blocks.length) return blocks[blocks.length - 1]

  const roleRows = querySelectorAllDeep(body, '[role="row"]').filter(
    (el) => !/columnheader|header/i.test(el.getAttribute('role') || '')
  )
  const roleBlocks = collectRowBlocksFromElements(
    roleRows,
    '[role="cell"], [role="gridcell"], mat-cell, td, th'
  )
  if (roleBlocks.length) return roleBlocks[roleBlocks.length - 1]

  return []
}

/**
 * @param {HTMLElement} body
 * @returns {Array<{ STAGE: string, TIMESTAMP: string, 'DELTA (MS)': string }>}
 */
function extractBackendStageTableFromDom(body) {
  if (!body) return []

  const table = findBackendStageTableElement(body)
  if (table) {
    table.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const rows = extractRowsFromTableElement(table)
    if (rows.length) return rows
  }

  return extractRowsFromDocumentTrs(body)
}

function backendStageTableDomReady(body) {
  const rows = extractBackendStageTableFromDom(body)
  const hasStart = rows.some((r) => /preDiscovery\s*:\s*start/i.test(r.STAGE))
  const hasToken = rows.some((r) => /service\s*:\s*firstToken/i.test(r.STAGE))
  const hasTotal = rows.some((r) => /^total$/i.test(r.STAGE))
  return {
    ready: rows.length >= 3 && hasStart && hasToken,
    rowCount: rows.length,
    rows,
    hasTotal
  }
}

/**
 * Extract the real LLM answer text from the last AI turn, excluding the
 * Performance Metrics card and Stage table.
 *
 * Strategy: find the last "Performance Metrics" heading in the merged page text —
 * everything before it is [prior turns] + [user question] + [answer].
 * Strip the user question (last occurrence) to isolate the answer.
 *
 * @param {HTMLElement} body
 * @param {string} [question] - The exact question string to strip from the result
 * @returns {string} Trimmed answer text (empty string if not detectable)
 */
function extractLlmAnswerText(body) {
  if (!body) return ''

  // body.innerText resolves from rendered layout and crosses ALL shadow roots in Chrome.
  // DOM order in the chat response: metadata → Stage table → LLM answer.
  // The answer starts immediately after the "Total … ms" row (last row of the Stage table).
  const fullText = String(body.innerText || textFromNodeDeep(body) || '')
  if (!fullText) return ''

  // Find the last "Total ... ms" line — marks the end of the Stage table
  const totalRowRe = /\bTotal\b[^\n]*\bms\b[^\n]*/gi
  let lastTotalMatch = null
  let m
  while ((m = totalRowRe.exec(fullText)) !== null) {
    lastTotalMatch = m
  }

  if (!lastTotalMatch) return ''

  let answer = fullText.slice(lastTotalMatch.index + lastTotalMatch[0].length).trim()
  if (!answer) return ''

  // Trim any Performance Metrics section that may follow the answer (if present in innerText)
  const perfRe = /Performance\s+Metrics|Leistungsmetriken|Leistungs\s*metriken/gi
  const pmMatch = perfRe.exec(answer)
  if (pmMatch) answer = answer.slice(0, pmMatch.index)

  // Trim trailing UI chrome that innerText picks up after the answer: the copy button
  // ("content_copy"), the sources footer, the composer placeholder, and the AI disclaimer.
  // (These sit after the answer + any suggested-follow-up prompts on dev-kiosk.)
  for (const marker of ['content_copy', 'entwickler intelligence nutzt KI']) {
    const ci = answer.indexOf(marker)
    if (ci >= 0) {
      answer = answer.slice(0, ci)
      break
    }
  }

  return answer.trim()
}

// =============================================================================
// Fallback answer capture for environments that DON'T render the backend Stage
// table (e.g. staging.entwickler.de as of 2026-07-06 — the normal `discovery`
// path emits no Stage table, so `extractLlmAnswerText` (which anchors on the
// "Total … ms" row) returns ''). Here we read the answer straight from the
// conversation component. dev-kiosk still renders the table, so it keeps using
// the Stage-table path — this is only a fallback when no table exists.
// =============================================================================

const CONVERSATION_SELECTOR = 'readerapp-ai-conversation-display'

// Placeholder text shown while the model is still working. Only the specific UI
// strings the app renders ("Denke nach…", "Formuliere Antwort…") — NOT generic
// words like "Thinking"/"Generating", which occur in real answers and would make
// a finished answer look like it is still streaming.
const ANSWER_PENDING_RE = /Denke nach|Formuliere Antwort/i

/** Raw deep text of the conversation component ('' if not present). */
function getConversationDisplayText(body) {
  if (!body) return ''
  const conv = querySelectorDeep(body, CONVERSATION_SELECTOR)
  return conv ? String(textFromNodeDeep(conv) || '').replace(/ /g, ' ').trim() : ''
}

/** True while the answer is still streaming / not yet started. */
function conversationAnswerPending(body) {
  const t = getConversationDisplayText(body)
  return !t || ANSWER_PENDING_RE.test(t)
}

/**
 * Extract just the answer from the conversation component: strip the leading
 * (echoed) question and the trailing copy/sources footer. Inline citation chips
 * stay in the text (that's what the user sees). Returns '' if nothing usable.
 *
 * @param {HTMLElement} body
 * @param {string} question exact question that was sent (to strip the echo)
 */
function extractAnswerFromConversation(body, question) {
  let text = getConversationDisplayText(body)
  if (!text) return ''

  // Cut the trailing footer (copy button + "Quellen"/sources list).
  for (const marker of ['content_copy', 'Quellenclose']) {
    const ci = text.indexOf(marker)
    if (ci >= 0) {
      text = text.slice(0, ci)
      break
    }
  }

  // Strip the echoed question prefix (exact match, then whitespace-insensitive).
  if (question) {
    const q = String(question).trim()
    const exact = text.indexOf(q)
    if (exact >= 0) {
      text = text.slice(exact + q.length)
    } else {
      const rx = new RegExp(
        q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
      )
      const m = rx.exec(text)
      if (m) text = text.slice(m.index + m[0].length)
    }
  }

  return text.trim()
}

module.exports = {
  extractBackendStageTableFromDom,
  findBackendStageTableElement,
  backendStageTableDomReady,
  extractLlmAnswerText,
  getConversationDisplayText,
  conversationAnswerPending,
  extractAnswerFromConversation
}
