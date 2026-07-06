/**
 * BACKEND-1603 QA — auth sanity check (read-only, PRODUCTION).
 *
 * Answers one question: is the `access-token` header actually sent on the `discovery` call too,
 * and could the "POC_ONLY + pocIds -> 0" result be an auth artifact rather than a real empty?
 *
 * For every request it PRINTS the header keys actually sent + a masked token fingerprint (never
 * the token itself), then contrasts auth-ON vs auth-OFF on the identical discovery query.
 *
 *   1 preDiscovery POC_ONLY + question + pocIds      AUTH ON   (expect 2 = the pocIds)
 *   2 discovery   POC_ONLY + question + pocIds       AUTH ON   (the 0 under scrutiny)
 *   3 discovery   POC_ONLY + question + pocIds       AUTH OFF  (what missing auth REALLY looks like)
 *   4 discovery   NONE     + question + pocIds       AUTH ON   (expect 45 -> proves discovery IS authed)
 *   5 discovery   NONE     + question + pocIds       AUTH OFF  (contrast)
 *
 * New file for BACKEND-1603. Native fetch. Usage: node src/poc-auth-verify.js
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
const QUESTION = 'How does Kubernetes autoscaling work?';
const POC_IDS = ['aa2f041628d5afd0809c5629', '28ac79f6b9210c49fa6d8fa3'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mask: prove a token is present without ever printing it.
function fingerprint(tok) {
  if (!tok) return 'NONE';
  return `present(len=${tok.length}, ${tok.slice(0, 6)}…${tok.slice(-4)})`;
}

function buildHeaders(withAuth) {
  const h = { 'Content-Type': 'application/json' };
  if (withAuth && process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

function buildQuery(field, args, sel) {
  const p = [];
  if (args.question !== undefined) p.push(`question: ${JSON.stringify(args.question)}`);
  if (args.restriction !== undefined) p.push(`restriction: ${args.restriction}`);
  if (args.pocIds !== undefined) p.push(`pocIds: ${JSON.stringify(args.pocIds)}`);
  return `query {\n  ${field}(\n    ${p.join('\n    ')}\n  ) {\n    ${sel}\n  }\n}`;
}

async function step(label, field, args, withAuth) {
  const headers = buildHeaders(withAuth);
  const query = buildQuery(field, args, field === 'preDiscovery' ? 'userRagId\n    results { _id }' : 'results { _id }');
  // PROOF of what is sent:
  console.log(`\n[${label}]`);
  console.log(`   headers sent: ${JSON.stringify(Object.keys(headers))}`);
  console.log(`   access-token: ${'access-token' in headers ? fingerprint(headers['access-token']) : 'ABSENT'}`);
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT); const t0 = Date.now();
  let rec;
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
    const payload = j?.data?.[field] ?? null;
    const errs = j?.errors ?? null;
    const ids = Array.isArray(payload?.results) ? payload.results.map((x) => x._id) : null;
    rec = { label, field, withAuth, headerKeys: Object.keys(headers), accessTokenSent: 'access-token' in headers,
      httpStatus: r.status, ms: Date.now() - t0, gqlErrors: errs, resultCount: ids ? ids.length : null, resultIds: ids,
      rawResponse: j ?? txt.slice(0, 400) };
    const summary = errs ? `GQL-ERR ${JSON.stringify(errs).slice(0, 160)}` : `results=${ids ? ids.length : 'null'}`;
    console.log(`   -> HTTP ${r.status} (${rec.ms}ms) ${summary}`);
    console.log(`   raw: ${JSON.stringify(rec.rawResponse).slice(0, 260)}`);
  } catch (e) {
    rec = { label, field, withAuth, headerKeys: Object.keys(headers), accessTokenSent: 'access-token' in headers,
      httpStatus: null, ms: Date.now() - t0, transportError: e.message };
    console.log(`   -> TRANSPORT-ERR ${e.message}`);
  } finally { clearTimeout(t); }
  return rec;
}

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 .env AUTH_TOKEN: ${fingerprint(process.env.AUTH_TOKEN)}`);
  console.log(`❓ "${QUESTION}"  🎯 pocIds=${JSON.stringify(POC_IDS)}`);
  const out = { capturedAt: new Date().toISOString(), endpoint: ENDPOINT, steps: [] };

  out.steps.push(await step('1 preDiscovery POC_ONLY + pocIds  [AUTH ON]', 'preDiscovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: POC_IDS }, true)); await sleep(DELAY);
  out.steps.push(await step('2 discovery   POC_ONLY + pocIds  [AUTH ON]  (the 0 under scrutiny)', 'discovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: POC_IDS }, true)); await sleep(DELAY);
  out.steps.push(await step('3 discovery   POC_ONLY + pocIds  [AUTH OFF] (what missing auth looks like)', 'discovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: POC_IDS }, false)); await sleep(DELAY);
  out.steps.push(await step('4 discovery   NONE     + pocIds  [AUTH ON]  (expect 45 -> discovery IS authed)', 'discovery', { question: QUESTION, restriction: 'NONE', pocIds: POC_IDS }, true)); await sleep(DELAY);
  out.steps.push(await step('5 discovery   NONE     + pocIds  [AUTH OFF] (contrast)', 'discovery', { question: QUESTION, restriction: 'NONE', pocIds: POC_IDS }, false));

  console.log('\n=== AUTH VERIFY SUMMARY ===');
  for (const s of out.steps) {
    console.log(`${s.accessTokenSent ? 'TOKEN-SENT ' : 'NO-TOKEN   '} | ${s.field.padEnd(12)} | HTTP ${s.httpStatus} | ${s.gqlErrors ? 'GQL-ERR' : 'results=' + s.resultCount} | ${s.label.split('  ')[0]}`);
  }
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `poc-auth-verify-${stamp}.json`); fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${p}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
