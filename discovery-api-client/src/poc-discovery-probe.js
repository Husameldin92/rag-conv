/**
 * BACKEND-1603 QA — discovery() probe (read-only, PRODUCTION).
 *
 * The ticket's discovery queries use (userRagId + restriction + pocIds) with NO question
 * and returned `results: null` in the main test. discovery() in the repo's existing scripts
 * is always called WITH a question, so this probe characterizes discovery() across arg
 * combinations to find the form that actually retrieves, and whether POC_ONLY restricts it.
 *
 * Calls (fresh preDiscovery first to seed a live userRagId, then 6 discovery variants, spaced):
 *   S  preDiscovery(NONE, question)              -> fresh userRagId + broad set, harvest pocIds
 *   D1 discovery(question, NONE, pocIds)              no userRagId
 *   D2 discovery(question, POC_ONLY, pocIds)          no userRagId
 *   D3 discovery(userRagId, question, NONE, pocIds)
 *   D4 discovery(userRagId, question, POC_ONLY, pocIds)
 *   D5 discovery(userRagId, NONE, pocIds)             no question  [ticket #3 verbatim]
 *   D6 discovery(userRagId, POC_ONLY, pocIds)         no question  [ticket #4 verbatim]
 *
 * New file for BACKEND-1603 — does not touch existing scripts. Native fetch (node-fetch hangs on node v26).
 * Usage: node src/poc-discovery-probe.js ["optional question"]
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}
function buildQuery(field, args, selection) {
  const parts = [];
  if (args.question !== undefined) parts.push(`question: ${JSON.stringify(args.question)}`);
  if (args.userRagId !== undefined) parts.push(`userRagId: ${JSON.stringify(args.userRagId)}`);
  if (args.restriction !== undefined) parts.push(`restriction: ${args.restriction}`);
  if (args.pocIds !== undefined) parts.push(`pocIds: ${JSON.stringify(args.pocIds)}`);
  if (args.enableConversation !== undefined) parts.push(`enableConversation: ${args.enableConversation}`);
  return `query {\n  ${field}(\n    ${parts.join('\n    ')}\n  ) {\n    ${selection}\n  }\n}`;
}
async function callGraphQL(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ query }), signal: ctrl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { httpStatus: res.status, ok: res.ok, ms: Date.now() - started, json, rawText: json ? undefined : text.slice(0, 800) };
  } catch (e) {
    return { httpStatus: null, ok: false, ms: Date.now() - started, error: e.message };
  } finally { clearTimeout(t); }
}
async function step(label, field, args, selection) {
  const query = buildQuery(field, args, selection);
  const resp = await callGraphQL(query);
  const payload = resp.json?.data?.[field] ?? null;
  const gqlErrors = resp.json?.errors ?? null;
  const results = payload?.results ?? null;
  const ids = Array.isArray(results) ? results.map((r) => r?._id).filter(Boolean) : null;
  const rec = { label, field, argsSent: args, query, httpStatus: resp.httpStatus, ms: resp.ms, gqlErrors, transportError: resp.error ?? null, userRagId: payload?.userRagId ?? null, resultCount: ids ? ids.length : null, resultIds: ids, results, rawResponse: resp.json ?? resp.rawText ?? null };
  const status = resp.error ? `TRANSPORT-ERR ${resp.error}` : gqlErrors ? `GQL-ERR ${JSON.stringify(gqlErrors).slice(0, 160)}` : `results=${rec.resultCount} userRagId=${rec.userRagId ? rec.userRagId.slice(0, 8) + '…' : 'null'}`;
  console.log(`[${label}] ${field} (${resp.ms}ms, HTTP ${resp.httpStatus}) -> ${status}`);
  return rec;
}

const SEL_PRE = 'userRagId\n    results { _id title parentName parentGenre score }';
const SEL_DISC = 'userRagId\n    results { _id title parentName parentGenre score }';

(async () => {
  const question = process.argv[2] || DEFAULT_QUESTION;
  console.log(`📡 ${GRAPHQL_ENDPOINT}\n❓ "${question}"\n`);
  const run = { capturedAt: new Date().toISOString(), endpoint: GRAPHQL_ENDPOINT, question, steps: {} };

  const seed = await step('S  preDiscovery NONE + question (seed)', 'preDiscovery', { question, restriction: 'NONE' }, SEL_PRE);
  run.steps.seed = seed;
  const baseIds = seed.resultIds || [];
  if (!baseIds.length) { console.error('🛑 seed empty'); run.aborted = 'seed empty'; save(run); process.exit(1); }
  const pocIds = baseIds.slice(0, Math.min(2, baseIds.length));
  run.pocIds = pocIds;
  run.pocIdMeta = pocIds.map((id) => { const r = (seed.results || []).find((x) => x._id === id) || {}; return { _id: id, title: r.title ?? null, parentName: r.parentName ?? null, parentGenre: r.parentGenre ?? null }; });
  const userRagId = seed.userRagId;
  console.log(`🎯 pocIds: ${pocIds.join(', ')}\n   seed broad set: ${baseIds.length}, userRagId: ${userRagId}\n`);
  await sleep(DELAY_MS);

  run.steps.d1 = await step('D1 discovery question + NONE + pocIds (no userRagId)', 'discovery', { question, restriction: 'NONE', pocIds }, SEL_DISC); await sleep(DELAY_MS);
  run.steps.d2 = await step('D2 discovery question + POC_ONLY + pocIds (no userRagId)', 'discovery', { question, restriction: 'POC_ONLY', pocIds }, SEL_DISC); await sleep(DELAY_MS);
  run.steps.d3 = await step('D3 discovery userRagId + question + NONE + pocIds', 'discovery', { userRagId, question, restriction: 'NONE', pocIds }, SEL_DISC); await sleep(DELAY_MS);
  run.steps.d4 = await step('D4 discovery userRagId + question + POC_ONLY + pocIds', 'discovery', { userRagId, question, restriction: 'POC_ONLY', pocIds }, SEL_DISC); await sleep(DELAY_MS);
  run.steps.d5 = await step('D5 discovery userRagId + NONE + pocIds (no question) [ticket #3]', 'discovery', { userRagId, restriction: 'NONE', pocIds }, SEL_DISC); await sleep(DELAY_MS);
  run.steps.d6 = await step('D6 discovery userRagId + POC_ONLY + pocIds (no question) [ticket #4]', 'discovery', { userRagId, restriction: 'POC_ONLY', pocIds }, SEL_DISC);

  // Evaluation
  const pocSet = new Set(pocIds);
  const subsetOf = (ids) => Array.isArray(ids) && ids.length > 0 && ids.every((id) => pocSet.has(id));
  const leak = (ids) => (Array.isArray(ids) ? ids.filter((id) => !pocSet.has(id)) : null);
  run.evaluation = {
    pocIds,
    d1_NONE_withQ: { count: run.steps.d1.resultCount, ids: run.steps.d1.resultIds },
    d2_POC_ONLY_withQ: { count: run.steps.d2.resultCount, ids: run.steps.d2.resultIds, subsetOfPocIds: subsetOf(run.steps.d2.resultIds), leaked: leak(run.steps.d2.resultIds) },
    d3_userRagId_NONE_withQ: { count: run.steps.d3.resultCount, ids: run.steps.d3.resultIds },
    d4_userRagId_POC_ONLY_withQ: { count: run.steps.d4.resultCount, ids: run.steps.d4.resultIds, subsetOfPocIds: subsetOf(run.steps.d4.resultIds), leaked: leak(run.steps.d4.resultIds) },
    d5_ticket3_noQ: { count: run.steps.d5.resultCount, ids: run.steps.d5.resultIds },
    d6_ticket4_noQ: { count: run.steps.d6.resultCount, ids: run.steps.d6.resultIds },
  };
  console.log('\n=== DISCOVERY EVALUATION ===');
  console.log(JSON.stringify(run.evaluation, null, 2));
  save(run);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });

function save(run) {
  const dir = path.join(__dirname, '../reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, `poc-discovery-probe-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(run, null, 2));
  console.log(`\n💾 Saved: ${out}`);
}
