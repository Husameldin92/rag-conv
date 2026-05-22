/**
 * Read the backend Stage table straight from the DOM (cells → CSV rows).
 * No regex on merged page text — same values you see in the table.
 */

const { textFromNodeDeep, querySelectorAllDeep } = require('./perf-shadow-text')

const STAGE_CELL_RE = /^[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z0-9+]+)+$/
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

  const textAfterTable = fullText.slice(lastTotalMatch.index + lastTotalMatch[0].length).trim()
  if (!textAfterTable) return ''

  // Trim any Performance Metrics section that may follow the answer (if present in innerText)
  const perfRe = /Performance\s+Metrics|Leistungsmetriken|Leistungs\s*metriken/gi
  const pmMatch = perfRe.exec(textAfterTable)
  if (pmMatch) {
    return textAfterTable.slice(0, pmMatch.index).trim()
  }

  return textAfterTable
}

module.exports = {
  extractBackendStageTableFromDom,
  findBackendStageTableElement,
  backendStageTableDomReady,
  extractLlmAnswerText
}
