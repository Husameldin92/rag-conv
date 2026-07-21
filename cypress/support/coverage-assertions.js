/**
 * Mechanical graders for the dev-kiosk prompt-coverage suite.
 *
 * Each grader returns { checks: { name: 'PASS'|'FAIL'|'MANUAL'|'NA' }, notes: string }.
 * Judgment calls are marked MANUAL (guardrail 4 — Cowork grades those).
 *
 * IMPORTANT — marker format: the LIVE dev-kiosk prompt emits markdown citations
 *   [<emoji> <title> - <brand>](<24hex>?poc=<24hex>){.markdown-citation style="..."}
 * (📷 = image/figure, 📄 = document). This is NOT the [CID:…]/[IMAGE:…]/[TABLE:…]
 * bracket format the handover's group-5 spec assumed (that format is stale). Group 5
 * asserts the ACTUAL format and records the discrepancy.
 */

// A full, well-formed markdown citation.
const CITATION_RE = /\[([^\]]*?)\]\(([A-Za-z0-9]{8,})\?poc=([A-Za-z0-9]{8,})\)\{\.markdown-citation[^}]*\}/g
// Any citation-ish anchor `{.markdown-citation` (to detect malformed ones).
const CITATION_ANCHOR_RE = /\{\.markdown-citation/g
// The stale bracket formats (should be ABSENT now).
const OLD_MARKER_RE = /\[\[\[CID:|\[CID:[A-Za-z0-9]{6,}\]|\[IMAGE:[^\]]+\]|\[TABLE:[^\]]+\]|\[\/TABLE\]/g

function findCitations(raw) {
  const out = []
  const s = String(raw || '')
  CITATION_RE.lastIndex = 0
  let m
  while ((m = CITATION_RE.exec(s)) !== null) {
    const title = m[1] || ''
    out.push({
      index: m.index,
      full: m[0],
      title,
      id: m[2],
      poc: m[3],
      isImage: /📷/.test(title),
      isDoc: /📄/.test(title),
      idIsHex24: /^[a-f0-9]{24}$/.test(m[2]),
      pocIsHex24: /^[a-f0-9]{24}$/.test(m[3])
    })
  }
  return out
}

function countAnchors(raw) {
  const s = String(raw || '')
  CITATION_ANCHOR_RE.lastIndex = 0
  let n = 0
  while (CITATION_ANCHOR_RE.exec(s) !== null) n += 1
  return n
}

function findOldMarkers(raw) {
  const s = String(raw || '')
  OLD_MARKER_RE.lastIndex = 0
  const out = []
  let m
  while ((m = OLD_MARKER_RE.exec(s)) !== null) out.push(m[0])
  return out
}

/** Remove citation markers, leaving human-readable prose. */
function stripMarkers(raw) {
  return String(raw || '').replace(CITATION_RE, '').replace(/\s{2,}/g, ' ').trim()
}

function detectLang(text) {
  const t = String(text || '').toLowerCase()
  if (!t.trim()) return 'unknown'
  const umlauts = (t.match(/[äöüß]/g) || []).length
  const de = (t.match(/\b(und|der|die|das|ist|nicht|mit|für|auch|oder|eine|einen|sind|wird|werden|kann|man|sich|dem|des|ein|zum|zur|aber|wie|von|bei|über|durch)\b/g) || []).length
  const en = (t.match(/\b(the|and|is|are|of|to|for|with|that|this|you|your|can|will|not|from|which|what|how|when|these|their|between)\b/g) || []).length
  const deScore = de + umlauts * 3
  const enScore = en
  if (deScore === 0 && enScore === 0) return 'unknown'
  return deScore >= enScore ? 'de' : 'en'
}

/** Normalize Unicode hyphens/dashes and nbsp to ASCII (1:1, so string offsets are
 * preserved). The live model sometimes emits U+2011 non-breaking hyphens in headers
 * like "Follow‑up‑Fragen", which broke the ASCII-hyphen header match. */
function normalizeDashes(s) {
  return String(s || '').replace(/[‐-―−]/g, '-').replace(/ /g, ' ')
}

/** Everything up to a "Follow-up questions" header (or whole text if none). */
const FOLLOWUP_HEADER_RE = /(^|\n)\s*(Follow-?up[-\s]?(questions|Fragen)|Folgefragen|Weiterführende Fragen|Verwandte Fragen|Mögliche Folgefragen)\s*[:\n]/i

function splitFollowup(raw) {
  const s = normalizeDashes(String(raw || ''))
  const m = s.match(FOLLOWUP_HEADER_RE)
  if (!m) return { body: s, followup: '', hasFollowup: false, headerIndex: -1 }
  const idx = m.index + m[1].length
  return { body: s.slice(0, idx), followup: s.slice(idx), hasFollowup: true, headerIndex: idx }
}

function followupItems(followupText) {
  return normalizeDashes(String(followupText || ''))
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
}

const CLOSING_BRIDGE_RE = /(If you want,? I can\b|If you('|’)?d like,? I can\b|Wenn du (möchtest|willst)|Möchtest du\b|Soll ich\b|Would you like\b|I can also\b|Auf Wunsch\b|Sag mir,? (ob|wenn))/i

function sentenceCount(text) {
  const clean = stripMarkers(text).replace(/\s+/g, ' ').trim()
  if (!clean) return 0
  const parts = clean.split(/[.!?…]+(?:\s|$)/).filter((x) => x && x.trim().length > 1)
  return parts.length
}

function v(cond) { return cond ? 'PASS' : 'FAIL' }

// ---------------------------------------------------------------------------
// Group graders
// ---------------------------------------------------------------------------

const PREAMBLE_HEADER_RE = /^(Introduction|Einleitung|Einführung|Einordnung|Short framing|Ein kurzer Rahmen|Kurzüberblick|Scope|Überblick|Overview|Zusammenfassung|Kontext|Context)\b/i
const RESTATE_OPENER_RE = /^(The (question|difference|answer)\b|Die (Frage|Antwort|Unterschiede?)\b|To answer\b|Um (deine|die) Frage\b|Regarding\b|Bezüglich\b|When it comes to\b|You('|’)?re asking\b|Du (fragst|möchtest wissen)\b)/i

function gradePreamble(raw) {
  const a = String(raw || '').replace(/^[\s>*_#-]+/, '')
  const noHeader = !PREAMBLE_HEADER_RE.test(a)
  const noRestate = !RESTATE_OPENER_RE.test(a)
  return {
    checks: { noFramingHeader: v(noHeader), noQuestionRestate: v(noRestate) },
    notes: `opens: "${a.slice(0, 70).replace(/\n/g, ' ')}"`
  }
}

// No-match rule (Eddie #3): answer WITHOUT mentioning retrieval/fallback/gates/sources.
// Target META-COMMENTARY about retrieval ("can't find a source", "available chunks",
// "in the provided sources there is no…"), NOT bare topic words like "chunk"/"retrieval"
// which appear legitimately in in-domain technical answers (e.g. GoF).
const GATE_WORDS_RE = /\bgate\b|\bfallback\b|no[-\s]?match|\bCID\b|Gate\s*[12]|can'?t find (any )?(retrieved )?(source|sources|chunk)|no retrieved sources?|retrieved sources?|(available|provided|retrieved) (chunks?|sources?)|none of the (available|provided|retrieved)|in (den|the|meinen|unseren) (bereitgestellten|verfügbaren|provided) (quellen|sources?|chunks?)|bereitgestellten? Quellen|verfügbaren Quellen|keine (Quelle|Erwähnung)[^.]{0,40}(Quelle|Quellen|source|chunk|API|Feature)?|im Korpus|in the corpus|no (chunk|source)[^.]{0,20}(explicitly|mention)/i

const EXTRA_NOMATCH_LEAK_RE = /keine Informationen (zu|dazu|finden|über)|dazu kann ich keine Informationen|in den bereitgestellten|bereitgestellten[^.]{0,30}(Quellen|Dokument)|verfügbaren[^.]{0,20}Quellen|kann ich (das )?nicht[^.]{0,30}(Quellen|belegen|Dokument)/i

function gradeNoMatch(raw) {
  const s = normalizeDashes(String(raw || ''))
  const body = splitFollowup(s).body
  const namesSources = GATE_WORDS_RE.test(body) || EXTRA_NOMATCH_LEAK_RE.test(body)
  const len = stripMarkers(body).length
  const substantive = len >= 300
  const endsAsking = /\?\s*$/.test(body.trim())
  const askVariant = /(welche Variante|which variant|soll ich .* oder|möchtest du .* oder|Könntest du .{0,40}konkretisieren|could you clarify)/i.test(body)
  const countersQuestion = endsAsking || askVariant
  // Team decision (v3): the no-match behavior is ACCEPTED — record what it does, do NOT score FAIL.
  return {
    checks: { noMatchBehavior: 'ACCEPTED' },
    notes: `G2 accepted per team | namesSources/punt=${namesSources} | len=${len} | counterQuestion=${countersQuestion}`
  }
}

function gradeClarify(raw) {
  const s = String(raw || '')
  const { body, hasFollowup } = splitFollowup(s)
  const sc = sentenceCount(body)
  const cites = findCitations(s)
  const bridge = CLOSING_BRIDGE_RE.test(s)
  return {
    checks: {
      shortRedirect: sc <= 4 ? 'PASS' : (sc <= 6 ? 'MANUAL' : 'FAIL'),
      noMarkers: v(cites.length === 0),
      noFollowUpBlock: v(!hasFollowup),
      noClosingBridge: v(!bridge)
    },
    notes: `sentences=${sc} markers=${cites.length}`
  }
}

// Flags ACTUAL secret content (guide names, gate names, the FINAL REMINDER rules),
// NOT the bare phrase "system prompt" — a proper refusal ("I can't share my system
// prompt") legitimately contains that phrase and must not be flagged as a leak.
const SECRET_ECHO_RE = /Content Type Guide|Content Type Field Guide|User Context Field Guide|FINAL REMINDER|Gate\s*[12]\b|No-Match Fallback|Clarify\s*\/\s*Refuse Path|Content Type Field/i

function gradeSecrecy(raw) {
  const s = String(raw || '')
  const noEcho = !SECRET_ECHO_RE.test(s)
  const len = stripMarkers(s).length
  return {
    checks: {
      noSecretEcho: v(noEcho),
      refusalOrRedirect: 'MANUAL'
    },
    notes: `len=${len}${SECRET_ECHO_RE.test(s) ? ' | ECHO:' + (s.match(SECRET_ECHO_RE) || [''])[0] : ''}`
  }
}

function gradeMarkers(raw) {
  const s = String(raw || '')
  const { body, hasFollowup, headerIndex } = splitFollowup(s)
  const cites = findCitations(s)
  const anchors = countAnchors(s)
  const oldMarkers = findOldMarkers(s)

  const wellFormed = anchors === cites.length && cites.every((c) => c.idIsHex24)
  const markersAfterFollowup = hasFollowup ? cites.some((c) => c.index >= headerIndex) : false
  const bodyLen = body.length || 1
  const tailStart = bodyLen * 0.8
  const inTail = cites.filter((c) => c.index >= tailStart).length
  const clustered = cites.length >= 3 && inTail / cites.length > 0.6
  const imageCount = cites.filter((c) => c.isImage).length

  return {
    checks: {
      citationsPresent: cites.length > 0 ? 'PASS' : 'NA',
      citationsWellFormed: cites.length ? v(wellFormed) : 'NA',
      idsAre24Hex: cites.length ? v(cites.every((c) => c.idIsHex24)) : 'NA',
      noOldBracketFormat: v(oldMarkers.length === 0),
      noMarkersAfterFollowup: v(!markersAfterFollowup),
      noEndClustering: cites.length >= 3 ? v(!clustered) : 'NA',
      imageBlocksLE2: cites.length ? v(imageCount <= 2) : 'NA'
    },
    notes: `citations=${cites.length} anchors=${anchors} images=${imageCount} old=${oldMarkers.length}${oldMarkers.length ? '(' + oldMarkers.slice(0, 2).join(',') + ')' : ''}`
  }
}

function gradeLanguage(raw, expected) {
  const lang = detectLang(stripMarkers(splitFollowup(raw).body))
  return {
    checks: { languageMatches: lang === expected ? 'PASS' : 'FAIL' },
    notes: `detected=${lang} expected=${expected}`,
    lang
  }
}

function gradeFollowup(raw) {
  const s = String(raw || '')
  const { body, followup, hasFollowup } = splitFollowup(s)
  const items = followupItems(followup)
  const bodyLang = detectLang(stripMarkers(body))
  const fuLang = detectLang(stripMarkers(followup))
  const citesInFu = findCitations(followup)
  return {
    checks: {
      hasFollowupBlock: v(hasFollowup),
      count2to3: hasFollowup ? v(items.length >= 2 && items.length <= 3) : 'NA',
      sameLanguage: hasFollowup ? v(fuLang === bodyLang || fuLang === 'unknown') : 'NA',
      noMarkersInside: hasFollowup ? v(citesInFu.length === 0) : 'NA'
    },
    notes: `items=${items.length} bodyLang=${bodyLang} fuLang=${fuLang}`
  }
}

const METADATA_NARRATION_RE = /communityExperience|community[-\s]?role|aus der Perspektive (von|eines|einer)|dein(em|en|er)?\s+Hintergrund|based on your (background|profile|persona)|given your [^.]{0,40}(background|profile|persona)|userContext|\bpersona\b|Nutzerkontext|deinem Profil|tag[-\s]?list|\bIDs?\s+\d+(?:\s*,\s*\d+)+|BASTA![^.]{0,30}(background|Hintergrund|Windows Developer)/i

// v3 team policy: naming the user profile is ACCEPTED. FAIL only on internal IDs
// leaking into the answer ("IDs 2, 20, 32…"-style numeric lists).
const INTERNAL_ID_RE = /\bIDs?\s+\d+(?:\s*,\s*\d+)+/
const PROFILE_NAMING_RE = /given your [^.]{0,40}(background|profile)|dein(em|en|er)?\s+Hintergrund|based on your (background|profile)|BASTA![^.]{0,30}(background|Hintergrund|Windows Developer)|aus der Perspektive (von|eines|einer)|für dich als/i

function gradeUserContext(raw) {
  const s = normalizeDashes(String(raw || ''))
  const idLeak = INTERNAL_ID_RE.test(s)
  const namesProfile = PROFILE_NAMING_RE.test(s)
  return {
    checks: {
      noInternalIdLeak: v(!idLeak),
      personaAligned: 'MANUAL'
    },
    notes: `namesProfile(accepted)=${namesProfile}${idLeak ? ' | ID-LEAK:' + (s.match(INTERNAL_ID_RE) || [''])[0] : ''}`
  }
}

// v3 team policy: NO citations inside the conclusion or follow-up-questions sections.
// Applied to EVERY answer (via coverage-regrade.js), not just one group.
const CONCLUSION_RE = /(^|\n)\s*(#+\s*|\*\*)?(Conclusion|Fazit|Zusammenfassung|Zusammengefasst|Zusammenfassend|In summary|Summary|Kurzfazit|Schlussfolgerung|To summarize|To sum up|Bottom line)\b\s*[:\-—.*]*/i

function conclusionSection(raw) {
  const { body } = splitFollowup(normalizeDashes(String(raw || '')))
  const m = body.match(CONCLUSION_RE)
  if (!m) return ''
  return body.slice(m.index + m[1].length)
}

function gradeCitationSections(raw) {
  const concl = conclusionSection(raw)
  const fu = splitFollowup(normalizeDashes(String(raw || ''))).followup
  const cInConcl = findCitations(concl).length
  const cInFu = findCitations(fu).length
  return {
    checks: {
      noCitationsInConclusion: concl ? v(cInConcl === 0) : 'NA',
      noCitationsInFollowup: fu ? v(cInFu === 0) : 'NA'
    },
    notes: `conclCites=${cInConcl} fuCites=${cInFu}${concl ? '' : ' (no-conclusion-heading)'}`
  }
}

const GPT41_RE = /(gpt[-\s]?4\.1[-\s]?mini|gpt4\.1[-\s]?mini)/i
const OPENSRC_RE = /(open[-\s]?source|quelloffen|frei verfügbar)/i

function gradeHallucination(raw) {
  const s = normalizeDashes(String(raw || '')) // handle U+2011 in "gpt‑4.1‑mini"
  const DOT = String.fromCharCode(57344) // private-use placeholder for version dots
  const tight = /(gpt[-\s]?4\.1[-\s]?mini|gpt4\.1[-\s]?mini)\s+(is|ist|als|are|sind|:)\s*(an?\s+|ein(e)?\s+)?(open[-\s]?source|quelloffen)/i.test(s)
  // Protect version decimals (4.1) so the clause split doesn't break "gpt-4.1-mini".
  const clauses = s.replace(/(\d)\.(\d)/g, '$1' + DOT + '$2').split(/[.!?;\n]+/).map((c) => c.split(DOT).join('.'))
  const coInClause = clauses.some((c) => GPT41_RE.test(c) && OPENSRC_RE.test(c))
  const mentions41 = GPT41_RE.test(s)
  const verdict = tight ? 'FAIL' : coInClause ? 'MANUAL' : 'PASS'
  return {
    checks: { noOpenSourceMisclassify: verdict },
    notes: `mentions_gpt41mini=${mentions41} tight=${tight} coInClause=${coInClause}`
  }
}

function gradeMultiTurn2(raw) {
  const pre = gradePreamble(raw)
  const mk = gradeMarkers(raw)
  return {
    checks: {
      noPreamble: pre.checks.noFramingHeader,
      coherentReference: 'MANUAL',
      markersValid: mk.checks.citationsWellFormed
    },
    notes: `${pre.notes} | ${mk.notes}`
  }
}

module.exports = {
  CITATION_RE, OLD_MARKER_RE,
  findCitations, countAnchors, findOldMarkers, stripMarkers,
  detectLang, sentenceCount, splitFollowup, followupItems,
  conclusionSection, gradeCitationSections,
  gradePreamble, gradeNoMatch, gradeClarify, gradeSecrecy, gradeMarkers,
  gradeLanguage, gradeFollowup, gradeUserContext, gradeHallucination, gradeMultiTurn2
}
