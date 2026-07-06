/**
 * BACKEND-1603 QA — fully-chained pipeline probe (read-only, PRODUCTION).
 *
 * Tests the intended pipeline end-to-end so a discovery POC_ONLY=0 cannot be dismissed
 * as "wrong usage": preDiscovery POC_ONLY -> reuse its userRagId on discovery POC_ONLY.
 *
 *   S1 preDiscovery NONE + question                      -> broad, harvest top2 pocIds, userRagId_none
 *   S2 preDiscovery POC_ONLY + question + pocIds         -> userRagId_poc (expect the 2 pocIds)
 *   S3 discovery POC_ONLY + userRagId_poc + question + pocIds   [chained intended path; BUG if 0]
 *   S4 discovery POC_ONLY + userRagId_poc + question     (no pocIds; does session carry restriction?)
 *   S5 discovery NONE     + userRagId_poc + question     (control; expect broad)
 *
 * New file for BACKEND-1603. Native fetch. Usage: node src/poc-chained-probe.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 3000, TIMEOUT = 20000, QUESTION = 'How does Kubernetes autoscaling work?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };
function q(field, args, sel) {
  const p = [];
  if (args.question !== undefined) p.push(`question: ${JSON.stringify(args.question)}`);
  if (args.userRagId !== undefined) p.push(`userRagId: ${JSON.stringify(args.userRagId)}`);
  if (args.restriction !== undefined) p.push(`restriction: ${args.restriction}`);
  if (args.pocIds !== undefined) p.push(`pocIds: ${JSON.stringify(args.pocIds)}`);
  return `query {\n  ${field}(\n    ${p.join('\n    ')}\n  ) {\n    ${sel}\n  }\n}`;
}
async function call(query) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT); const t0 = Date.now();
  try { const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {} return { status: r.status, ms: Date.now() - t0, json: j, raw: j ? undefined : txt.slice(0, 600) }; }
  catch (e) { return { status: null, ms: Date.now() - t0, error: e.message }; }
  finally { clearTimeout(t); }
}
async function step(label, field, args) {
  const query = q(field, args, 'userRagId\n    results { _id }');
  const resp = await call(query);
  const payload = resp.json?.data?.[field] ?? null;
  const errs = resp.json?.errors ?? null;
  const ids = Array.isArray(payload?.results) ? payload.results.map((r) => r._id) : null;
  console.log(`[${label}] (${resp.ms}ms,HTTP ${resp.status}) results=${ids ? ids.length : (errs ? 'GQL-ERR' : 'null')} userRagId=${payload?.userRagId ? payload.userRagId.slice(0, 8) + '…' : 'null'}${errs ? ' ' + JSON.stringify(errs).slice(0, 140) : ''}`);
  return { label, field, args, query, status: resp.status, ms: resp.ms, errors: errs, transportError: resp.error ?? null, userRagId: payload?.userRagId ?? null, count: ids ? ids.length : null, ids, rawResponse: resp.json ?? resp.raw ?? null };
}
(async () => {
  const out = { capturedAt: new Date().toISOString(), endpoint: ENDPOINT, question: QUESTION, steps: {} };
  out.steps.s1 = await step('S1 preDiscovery NONE + question', 'preDiscovery', { question: QUESTION, restriction: 'NONE' });
  const baseIds = out.steps.s1.ids || [];
  const pocIds = baseIds.slice(0, 2);
  out.pocIds = pocIds;
  console.log(`🎯 pocIds: ${pocIds.join(', ')} | broad=${baseIds.length}\n`);
  await sleep(DELAY);

  out.steps.s2 = await step('S2 preDiscovery POC_ONLY + question + pocIds', 'preDiscovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds }); await sleep(DELAY);
  const userRagIdPoc = out.steps.s2.userRagId;

  out.steps.s3 = await step('S3 discovery POC_ONLY + userRagId_poc + question + pocIds [chained; BUG if 0]', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'POC_ONLY', pocIds }); await sleep(DELAY);
  out.steps.s4 = await step('S4 discovery POC_ONLY + userRagId_poc + question (no pocIds)', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'POC_ONLY' }); await sleep(DELAY);
  out.steps.s5 = await step('S5 discovery NONE + userRagId_poc + question (control)', 'discovery', { userRagId: userRagIdPoc, question: QUESTION, restriction: 'NONE' });

  const pocSet = new Set(pocIds);
  out.evaluation = {
    pocIds,
    s2_pre_POC_ONLY: { count: out.steps.s2.count, ids: out.steps.s2.ids, subsetOfPocIds: (out.steps.s2.ids || []).length > 0 && (out.steps.s2.ids || []).every((x) => pocSet.has(x)) },
    s3_disc_POC_ONLY_chained: { count: out.steps.s3.count, ids: out.steps.s3.ids },
    s4_disc_POC_ONLY_noPocIds: { count: out.steps.s4.count, ids: out.steps.s4.ids },
    s5_disc_NONE_control: { count: out.steps.s5.count },
    VERDICT_discovery_POC_ONLY_zero_even_when_chained: out.steps.s3.count === 0,
  };
  console.log('\n=== CHAINED EVALUATION ===');
  console.log(JSON.stringify(out.evaluation, null, 2));
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `poc-chained-probe-${stamp}.json`); fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${p}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
