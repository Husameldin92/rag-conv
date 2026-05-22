/**
 * Plain text from a DOM subtree, including **open** shadow roots (same algorithm as the Cypress command).
 * Kept in a small module so specs can use it inside `cy.document().should(...)` (retrying assertions).
 */

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const DOCUMENT_FRAGMENT_NODE = 11

function textFromNodeDeep(node) {
  if (node == null) return ''
  if (node.nodeType === TEXT_NODE) return node.nodeValue || ''
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE || node.nodeType === ELEMENT_NODE) {
    let s = ''
    const ch = node.childNodes
    for (let i = 0; i < ch.length; i++) {
      s += textFromNodeDeep(ch[i])
    }
    if (node.nodeType === ELEMENT_NODE && node.shadowRoot) {
      s += textFromNodeDeep(node.shadowRoot)
    }
    return s
  }
  return ''
}

/**
 * `querySelector` only on the light tree — walk **open** shadow roots to match (same trees as `textFromNodeDeep`).
 * Use for controls like scroll-to-bottom inside web components.
 */
function querySelectorAllDeep(root, selector) {
  const out = []
  if (!root || !selector) return out
  const collect = (node) => {
    if (!node) return
    try {
      if (node.querySelectorAll) {
        node.querySelectorAll(selector).forEach((el) => out.push(el))
      }
    } catch {
      /* ignore */
    }
    if (node.nodeType === ELEMENT_NODE && node.shadowRoot) {
      collect(node.shadowRoot)
    }
    const ch = node.childNodes
    for (let i = 0; i < ch.length; i++) collect(ch[i])
  }
  collect(root)
  return out
}

function querySelectorDeep(root, selector) {
  if (!root || !selector) return null
  try {
    if (root.querySelector) {
      const hit = root.querySelector(selector)
      if (hit) return hit
    }
  } catch {
    return null
  }
  const walk = (node) => {
    if (!node) return null
    if (node.nodeType === ELEMENT_NODE && node.shadowRoot) {
      const inner = querySelectorDeep(node.shadowRoot, selector)
      if (inner) return inner
    }
    const ch = node.childNodes
    for (let i = 0; i < ch.length; i++) {
      const inner = walk(ch[i])
      if (inner) return inner
    }
    return null
  }
  if (root.nodeType === DOCUMENT_FRAGMENT_NODE || root.nodeType === ELEMENT_NODE) {
    const ch = root.childNodes
    for (let i = 0; i < ch.length; i++) {
      const inner = walk(ch[i])
      if (inner) return inner
    }
  }
  return null
}

/**
 * Chat / reader UI often scrolls inside `overflow: auto`, not `window`. Pick the element with the largest
 * `scrollHeight - clientHeight` so perf capture can move `scrollTop` (window-only scroll misses everything).
 */
function findLargestScrollableElement(root) {
  if (!root) return null
  let best = null
  let bestExcess = 0
  const consider = (el) => {
    if (!el || el.nodeType !== ELEMENT_NODE) return
    const sh = el.scrollHeight
    const ch = el.clientHeight
    if (sh > ch + 60 && sh - ch > bestExcess) {
      bestExcess = sh - ch
      best = el
    }
  }
  const visit = (node) => {
    if (!node) return
    if (node.nodeType === ELEMENT_NODE) {
      consider(node)
      if (node.shadowRoot) visit(node.shadowRoot)
      const ch = node.childNodes
      for (let i = 0; i < ch.length; i++) visit(ch[i])
    } else if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const ch = node.childNodes
      for (let i = 0; i < ch.length; i++) visit(ch[i])
    }
  }
  visit(root)
  return best
}

/**
 * Walk up from the scroll-to-bottom affordance (same subtree as chat chrome) and pick the ancestor with the
 * **largest** `scrollHeight - clientHeight`. The **first** scrollable parent can be an inner gutter; the thread
 * list is typically the wide region with maximum excess.
 */
function findBestChatScrollAncestor(body) {
  if (!body) return null
  const anchor =
    querySelectorDeep(body, '.scroll-to-bottom-wrapper') ||
    querySelectorDeep(body, '[class*="scroll-to-bottom"]')
  if (!anchor) return null
  let best = null
  let bestExcess = 0
  let el = anchor
  let hops = 0
  while (el && hops < 48) {
    if (el.nodeType === ELEMENT_NODE) {
      const sh = el.scrollHeight
      const ch = el.clientHeight
      if (sh > ch + 32) {
        const excess = sh - ch
        if (excess > bestExcess) {
          bestExcess = excess
          best = el
        }
      }
    }
    if (el.parentElement) el = el.parentElement
    else {
      const rn = el.getRootNode && el.getRootNode()
      if (rn && rn.nodeType === 11 && rn.host) el = rn.host
      else break
    }
    hops++
  }
  return best
}

/** Chat thread — **widest vertical scroll lane** anchored to chat chrome; avoids random side panels. */
function pickScrollContainerForPerf(body) {
  return findBestChatScrollAncestor(body) || findLargestScrollableElement(body)
}

module.exports = {
  textFromNodeDeep,
  querySelectorDeep,
  querySelectorAllDeep,
  findLargestScrollableElement,
  /** @deprecated Prefer {@link findBestChatScrollAncestor} — same heuristic, clearer name. */
  findChatThreadScrollContainer: findBestChatScrollAncestor,
  findBestChatScrollAncestor,
  pickScrollContainerForPerf
}
