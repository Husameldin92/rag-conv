/**
 * BACKEND-1603 QA — POC restriction verification (read-only, PRODUCTION).
 *
 * Verifies the new POC restriction surface on `preDiscovery` / `discovery`:
 *   - pocIds: [String]  argument
 *   - restriction: POC_ONLY  enum value
 *   - userRagId handoff  preDiscovery -> discovery
 *
 * Flow (low volume, calls spaced ~3s apart):
 *   0. BASELINE  preDiscovery(NONE, question)              -> broad set, harvest pocIds (top 2)
 *   1. Q1-lit    preDiscovery(NONE, pocIds)        no Q    [ticket query #1 verbatim]
 *   2. Q1-q      preDiscovery(NONE, question, pocIds)      -> userRagId_none
 *   3. Q2-lit    preDiscovery(POC_ONLY, pocIds)    no Q    [ticket query #2 verbatim]
 *   4. Q2-q      preDiscovery(POC_ONLY, question, pocIds)  -> userRagId_poc
 *   5. Q3        discovery(userRagId_none, NONE, pocIds)   [ticket query #3]
 *   6. Q4        discovery(userRagId_poc, POC_ONLY, pocIds)[ticket query #4]
 *
 * New file for BACKEND-1603 — does not touch existing scripts.
 * Uses native fetch (undici) because node-fetch hangs under node v26 in this env;
 * request shape (POST JSON + `access-token` header) is identical to index.js.
 *
 * Usage: node src/poc-restriction-test.js ["optional question"]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY_MS = 3000;
const REQ_TIMEOUT_MS = 20000;
const DEFAULT_QUESTION = 'How does Kubernetes autoscaling work?';

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a GraphQL string for preDiscovery/discovery from an args object.
// Only includes provided args, so we can faithfully reproduce the ticket's
// "no question" snippets as well as the practical "with question" variants.
function buildQuery(field, args, selection) {
  const parts = [];
  if (args.question !== undefined) parts.push(`question: ${JSON.stringify(args.question)}`);
  if (args.userRagId !== undefined) parts.push(`userRagId: ${JSON.stringify(args.userRagId)}`);
  if (args.restriction !== undefined) parts.push(`restriction: ${args.restriction}`); // enum, unquoted
  if (args.pocIds !== undefined) parts.push(`pocIds: ${JSON.stringify(args.pocIds)}`);
  if (args.enableConversation !== undefined) parts.push(`enableConversation: ${args.enableConversation}`);
  return `query {\n  ${field}(\n    ${parts.join('\n    ')}\n  ) {\n    ${selection}\n  }\n}`;
}

async function callGraphQL(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* keep raw */ }
    return {
      httpStatus: res.status,
      ok: res.ok,
      ms: Date.now() - started,
      json,
      rawText: json ? undefined : text.slice(0, 1000),
    };
  } catch (e) {
    return { httpStatus: null, ok: false, ms: Date.now() - started, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// Run one labelled step against preDiscovery/discovery and capture everything.
async function step(label, field, args, selection) {
  const query = buildQuery(field, args, selection);
  const resp = await callGraphQL(query);
  const payload = resp.json?.data?.[field] ?? null;
  const gqlErrors = resp.json?.errors ?? null;
  const results = payload?.results ?? null;
  const ids = Array.isArray(results) ? results.map((r) => r?._id).filter(Boolean) : null;
  const rec = {
    label,
    field,
    argsSent: args,
    query,
    httpStatus: resp.httpStatus,
    ms: resp.ms,
    gqlErrors,
    transportError: resp.error ?? null,
    userRagId: payload?.userRagId ?? null,
    resultCount: ids ? ids.length : null,
    resultIds: ids,
    results, // full result objects (incl. title/parentName when selected)
    rawResponse: resp.json ?? resp.rawText ?? null,
  };
  const status = resp.error
    ? `TRANSPORT-ERR ${resp.error}`
    : gqlErrors
    ? `GQL-ERR ${JSON.stringify(gqlErrors).slice(0, 160)}`
    : `ok results=${rec.resultCount} userRagId=${rec.userRagId ? rec.userRagId.slice(0, 8) + '…' : 'null'}`;
  console.log(`[${label}] ${field} (${resp.ms}ms, HTTP ${resp.httpStatus}) -> ${status}`);
  return rec;
}

const SEL_FULL = 'userRagId\n    results { _id title parentName parentGenre score }';
const SEL_TICKET_PRE = 'userRagId\n    results { _id }';
const SEL_TICKET_DISC = 'results { _id }';

(async () => {
  const question = process.argv[2] || DEFAULT_QUESTION;
  console.log(`📡 Endpoint: ${GRAPHQL_ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token header set' : 'NONE'}`);
  console.log(`❓ Question: "${question}"\n`);

  const run = { capturedAt: new Date().toISOString(), endpoint: GRAPHQL_ENDPOINT, question, steps: {} };

  // 0. BASELINE — broad preDiscovery NONE set (no pocIds). Harvest pocIds from top results.
  const baseline = await step('BASELINE preDiscovery NONE (no pocIds)', 'preDiscovery',
    { question, restriction: 'NONE' }, SEL_FULL);
  run.steps.baseline = baseline;

  const baseIds = baseline.resultIds || [];
  if (baseIds.length < 1) {
    console.error('\n🛑 Baseline returned no results — cannot harvest pocIds. Aborting.');
    run.aborted = 'baseline empty';
    saveReport(run);
    process.exit(1);
  }
  // Harvest up to 2 pocIds from the TOP of the broad set (most relevant -> most likely to
  // survive vector ranking in discovery, so the POC_ONLY discovery test is meaningful).
  const pocIds = baseIds.slice(0, Math.min(2, baseIds.length));
  run.pocIds = pocIds;
  run.pocIdMeta = pocIds.map((id) => {
    const r = (baseline.results || []).find((x) => x._id === id) || {};
    return { _id: id, title: r.title ?? null, parentName: r.parentName ?? null, parentGenre: r.parentGenre ?? null, score: r.score ?? null };
  });
  console.log(`\n🎯 Harvested pocIds (top ${pocIds.length} of ${baseIds.length} baseline results):`);
  for (const m of run.pocIdMeta) console.log(`     ${m._id}  |  ${m.parentGenre} | ${m.parentName} | ${m.title}`);
  console.log(`\n📊 Baseline broad set size: ${baseIds.length}\n`);

  await sleep(DELAY_MS);

  // 1. Q1-lit — ticket query #1 verbatim (no question)
  run.steps.q1_literal = await step('Q1-lit preDiscovery NONE + pocIds (NO question) [ticket #1]', 'preDiscovery',
    { restriction: 'NONE', pocIds }, SEL_TICKET_PRE);
  await sleep(DELAY_MS);

  // 2. Q1-q — practical NONE with question + pocIds -> userRagId for discovery NONE
  run.steps.q1_question = await step('Q1-q  preDiscovery NONE + question + pocIds', 'preDiscovery',
    { question, restriction: 'NONE', pocIds }, SEL_FULL);
  await sleep(DELAY_MS);

  // 3. Q2-lit — ticket query #2 verbatim (no question)
  run.steps.q2_literal = await step('Q2-lit preDiscovery POC_ONLY + pocIds (NO question) [ticket #2]', 'preDiscovery',
    { restriction: 'POC_ONLY', pocIds }, SEL_TICKET_PRE);
  await sleep(DELAY_MS);

  // 4. Q2-q — practical POC_ONLY with question + pocIds -> userRagId for discovery POC_ONLY
  run.steps.q2_question = await step('Q2-q  preDiscovery POC_ONLY + question + pocIds', 'preDiscovery',
    { question, restriction: 'POC_ONLY', pocIds }, SEL_FULL);
  await sleep(DELAY_MS);

  const userRagIdNone = run.steps.q1_question.userRagId;
  const userRagIdPoc = run.steps.q2_question.userRagId;

  // 5. Q3 — discovery NONE using NONE preDiscovery's userRagId [ticket #3]
  run.steps.q3 = await step('Q3    discovery NONE + userRagId(none) + pocIds [ticket #3]', 'discovery',
    { userRagId: userRagIdNone, restriction: 'NONE', pocIds }, SEL_TICKET_DISC);
  await sleep(DELAY_MS);

  // 6. Q4 — discovery POC_ONLY using POC_ONLY preDiscovery's userRagId [ticket #4]
  run.steps.q4 = await step('Q4    discovery POC_ONLY + userRagId(poc) + pocIds [ticket #4]', 'discovery',
    { userRagId: userRagIdPoc, restriction: 'POC_ONLY', pocIds }, SEL_TICKET_DISC);

  // ---- Evaluation ----
  const pocSet = new Set(pocIds);
  const baseSet = new Set(baseIds);
  const subsetOf = (ids, set) => Array.isArray(ids) && ids.every((id) => set.has(id));
  const idsOutside = (ids, set) => (Array.isArray(ids) ? ids.filter((id) => !set.has(id)) : null);

  const ev = {};
  // preDiscovery POC_ONLY restricts to pocIds?
  ev.preDiscovery_POC_ONLY_restricts = run.steps.q2_question.resultIds
    ? { resultIds: run.steps.q2_question.resultIds, subsetOfPocIds: subsetOf(run.steps.q2_question.resultIds, pocSet), leakedIds: idsOutside(run.steps.q2_question.resultIds, pocSet) }
    : { error: run.steps.q2_question.gqlErrors || run.steps.q2_question.transportError };
  // preDiscovery NONE ignores pocIds (Q1-q == baseline)?
  ev.preDiscovery_NONE_ignores_pocIds = run.steps.q1_question.resultIds
    ? { q1Count: run.steps.q1_question.resultCount, baselineCount: baseIds.length, sameAsBaseline: JSON.stringify(run.steps.q1_question.resultIds) === JSON.stringify(baseIds), q1IdsNotInBaseline: idsOutside(run.steps.q1_question.resultIds, baseSet) }
    : { error: run.steps.q1_question.gqlErrors || run.steps.q1_question.transportError };
  // discovery POC_ONLY restricts to pocIds?
  ev.discovery_POC_ONLY_restricts = run.steps.q4.resultIds
    ? { resultIds: run.steps.q4.resultIds, subsetOfPocIds: subsetOf(run.steps.q4.resultIds, pocSet), leakedIds: idsOutside(run.steps.q4.resultIds, pocSet) }
    : { error: run.steps.q4.gqlErrors || run.steps.q4.transportError };
  // discovery NONE broad (superset of discovery POC_ONLY)?
  ev.discovery_NONE_broad = run.steps.q3.resultIds
    ? { resultCount: run.steps.q3.resultCount, resultIds: run.steps.q3.resultIds, supersetOfQ4: subsetOf(run.steps.q4.resultIds || [], new Set(run.steps.q3.resultIds || [])) }
    : { error: run.steps.q3.gqlErrors || run.steps.q3.transportError };
  // ticket-literal (no-question) behavior
  ev.ticket_literal_noQuestion = {
    q1_literal: { httpStatus: run.steps.q1_literal.httpStatus, resultCount: run.steps.q1_literal.resultCount, gqlErrors: run.steps.q1_literal.gqlErrors },
    q2_literal: { httpStatus: run.steps.q2_literal.httpStatus, resultCount: run.steps.q2_literal.resultCount, gqlErrors: run.steps.q2_literal.gqlErrors },
  };
  // userRagId handoff
  ev.userRagId_handoff = {
    none_preDiscovery: userRagIdNone,
    poc_preDiscovery: userRagIdPoc,
    accepted_by_discovery_none: run.steps.q3.httpStatus === 200 && !run.steps.q3.gqlErrors,
    accepted_by_discovery_poc: run.steps.q4.httpStatus === 200 && !run.steps.q4.gqlErrors,
  };
  run.evaluation = ev;

  console.log('\n=== EVALUATION ===');
  console.log(JSON.stringify(ev, null, 2));

  saveReport(run);
})().catch((e) => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});

function saveReport(run) {
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `poc-restriction-test-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2));
  console.log(`\n💾 Saved full report: ${outPath}`);
}
