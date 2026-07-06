/**
 * BACKEND-1603 QA — round 2: explicit chained flow (read-only, PRODUCTION).
 *
 * Runs the ticket pipeline literally and on its own: preDiscovery FIRST, take the userRagId it
 * returns, pass THAT exact userRagId into discovery. Same question + same pocIds throughout.
 *
 *   1a preDiscovery POC_ONLY + question + pocIds        -> userRagId_poc, results
 *   1b discovery   userRagId_poc + question + POC_ONLY + pocIds         [chained POC_ONLY]
 *   2a preDiscovery NONE + question + pocIds            -> userRagId_none, results
 *   2b discovery   userRagId_none + question + NONE + pocIds            [chained NONE control]
 *   3a discovery   userRagId_poc + question + POC_ONLY  (NO pocIds)     [isolation: pocIds removed]
 *   3b discovery   userRagId_poc + question + NONE      (NO pocIds)     [isolation control: enum effect]
 *
 * 1b vs 3a  -> same userRagId, same restriction, ONLY pocIds differs  => isolates the pocIds arg.
 * 3a vs 3b  -> same userRagId, same (no) pocIds, ONLY restriction differs => shows whether the
 *              discovery restriction enum does anything, or the session pool drives the result.
 *
 * New file for BACKEND-1603 round 2 — does not touch existing scripts. Native fetch
 * (node-fetch hangs under node v26 in this env); request shape identical to index.js.
 *
 * Usage: node src/poc-chained-flow-round2.js ["optional question"]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 3000, TIMEOUT = 20000;
const QUESTION = process.argv[2] || 'How does Kubernetes autoscaling work?';
const POC_IDS = ['aa2f041628d5afd0809c5629', '28ac79f6b9210c49fa6d8fa3'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };

function buildQuery(field, args, selection) {
  const parts = [];
  if (args.question !== undefined) parts.push(`question: ${JSON.stringify(args.question)}`);
  if (args.userRagId !== undefined) parts.push(`userRagId: ${JSON.stringify(args.userRagId)}`);
  if (args.restriction !== undefined) parts.push(`restriction: ${args.restriction}`); // enum, unquoted
  if (args.pocIds !== undefined) parts.push(`pocIds: ${JSON.stringify(args.pocIds)}`);
  return `query {\n  ${field}(\n    ${parts.join('\n    ')}\n  ) {\n    ${selection}\n  }\n}`;
}
async function call(query) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT); const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { httpStatus: r.status, ms: Date.now() - t0, json: j, rawText: j ? undefined : txt.slice(0, 800) };
  } catch (e) { return { httpStatus: null, ms: Date.now() - t0, error: e.message }; }
  finally { clearTimeout(t); }
}
async function step(label, field, args, selection) {
  const query = buildQuery(field, args, selection);
  const resp = await call(query);
  const payload = resp.json?.data?.[field] ?? null;
  const errs = resp.json?.errors ?? null;
  const results = payload?.results ?? null;
  const ids = Array.isArray(results) ? results.map((r) => r?._id).filter(Boolean) : null;
  const rec = {
    label, field, argsSent: args, userRagIdPassed: args.userRagId ?? null, query,
    httpStatus: resp.httpStatus, ms: resp.ms, gqlErrors: errs, transportError: resp.error ?? null,
    userRagIdReturned: payload?.userRagId ?? null,
    resultCount: ids ? ids.length : null, resultIds: ids,
    rawResponse: resp.json ?? resp.rawText ?? null,
  };
  const r = resp.error ? `TRANSPORT-ERR ${resp.error}` : errs ? `GQL-ERR ${JSON.stringify(errs).slice(0, 140)}` : `results=${rec.resultCount}`;
  console.log(`[${label}] ${field} (${resp.ms}ms,HTTP ${resp.httpStatus}) passedUserRagId=${args.userRagId ? args.userRagId : '—'} -> ${r}${rec.userRagIdReturned ? ' returnedUserRagId=' + rec.userRagIdReturned : ''}`);
  return rec;
}

const SEL_PRE = 'userRagId\n    results { _id }';
const SEL_DISC = 'results { _id }';

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`❓ question: "${QUESTION}"`);
  console.log(`🎯 pocIds: ${JSON.stringify(POC_IDS)}\n`);
  const out = { round: 2, capturedAt: new Date().toISOString(), endpoint: ENDPOINT, question: QUESTION, pocIds: POC_IDS, steps: {} };

  // 1. Chained POC_ONLY
  out.steps['1a_pre_POC_ONLY'] = await step('1a preDiscovery POC_ONLY + question + pocIds', 'preDiscovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: POC_IDS }, SEL_PRE);
  const userRagIdPoc = out.steps['1a_pre_POC_ONLY'].userRagIdReturned;
  await sleep(DELAY);
  out.steps['1b_disc_POC_ONLY_chained'] = await step('1b discovery POC_ONLY + userRagId(poc) + question + pocIds', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'POC_ONLY', pocIds: POC_IDS }, SEL_DISC);
  await sleep(DELAY);

  // 2. Chained NONE (control)
  out.steps['2a_pre_NONE'] = await step('2a preDiscovery NONE + question + pocIds', 'preDiscovery', { question: QUESTION, restriction: 'NONE', pocIds: POC_IDS }, SEL_PRE);
  const userRagIdNone = out.steps['2a_pre_NONE'].userRagIdReturned;
  await sleep(DELAY);
  out.steps['2b_disc_NONE_chained'] = await step('2b discovery NONE + userRagId(none) + question + pocIds', 'discovery', { userRagId: userRagIdNone, question: QUESTION, restriction: 'NONE', pocIds: POC_IDS }, SEL_DISC);
  await sleep(DELAY);

  // 3. Isolation — same userRagId as step 1, pocIds removed
  out.steps['3a_disc_POC_ONLY_noPocIds'] = await step('3a discovery POC_ONLY + userRagId(poc) + question  (NO pocIds)', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'POC_ONLY' }, SEL_DISC);
  await sleep(DELAY);
  out.steps['3b_disc_NONE_noPocIds'] = await step('3b discovery NONE + userRagId(poc) + question  (NO pocIds, enum-effect control)', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'NONE' }, SEL_DISC);

  // ---- Evaluation ----
  const pocSet = new Set(POC_IDS);
  const exactSet = (ids) => Array.isArray(ids) && ids.length === pocSet.size && ids.every((x) => pocSet.has(x));
  const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const s = out.steps;
  out.evaluation = {
    userRagId_poc: userRagIdPoc,
    userRagId_none: userRagIdNone,
    chained_POC_ONLY: { preCount: s['1a_pre_POC_ONLY'].resultCount, preIds: s['1a_pre_POC_ONLY'].resultIds, discCount: s['1b_disc_POC_ONLY_chained'].resultCount, discIds: s['1b_disc_POC_ONLY_chained'].resultIds, discEmptied: s['1b_disc_POC_ONLY_chained'].resultCount === 0 },
    chained_NONE: { preCount: s['2a_pre_NONE'].resultCount, discCount: s['2b_disc_NONE_chained'].resultCount },
    isolation_pocIds_arg: {
      with_pocIds_1b: s['1b_disc_POC_ONLY_chained'].resultCount,
      without_pocIds_3a: s['3a_disc_POC_ONLY_noPocIds'].resultCount,
      without_pocIds_3a_ids: s['3a_disc_POC_ONLY_noPocIds'].resultIds,
      without_pocIds_3a_isExactlyPocs: exactSet(s['3a_disc_POC_ONLY_noPocIds'].resultIds),
      conclusion_emptyCausedByPocIdsArg: s['1b_disc_POC_ONLY_chained'].resultCount === 0 && s['3a_disc_POC_ONLY_noPocIds'].resultCount > 0,
    },
    isolation_restriction_enum: {
      POC_ONLY_noPocIds_3a: s['3a_disc_POC_ONLY_noPocIds'].resultCount,
      NONE_noPocIds_3b: s['3b_disc_NONE_noPocIds'].resultCount,
      identical_3a_3b: sameIds(s['3a_disc_POC_ONLY_noPocIds'].resultIds, s['3b_disc_NONE_noPocIds'].resultIds),
      conclusion_enumNoEffectOnSession: sameIds(s['3a_disc_POC_ONLY_noPocIds'].resultIds, s['3b_disc_NONE_noPocIds'].resultIds),
    },
  };
  console.log('\n=== ROUND 2 EVALUATION ===');
  console.log(JSON.stringify(out.evaluation, null, 2));

  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `poc-chained-flow-round2-${stamp}.json`); fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${p}`);
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
