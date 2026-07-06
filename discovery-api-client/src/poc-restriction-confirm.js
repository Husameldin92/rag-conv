/**
 * BACKEND-1603 QA — confirmatory probe (read-only, PRODUCTION).
 *
 * Nails down the discovery POC_ONLY = 0 finding: restrict BOTH preDiscovery and discovery
 * to pocIds drawn from discovery's OWN unrestricted (NONE) result set, so a 0 on discovery
 * cannot be explained by "those POCs aren't retrievable for this question".
 *
 * New file for BACKEND-1603 — does not touch existing scripts. Native fetch.
 * Usage: node src/poc-restriction-confirm.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };
function q(field, args, sel) {
  const p = [];
  if (args.question !== undefined) p.push(`question: ${JSON.stringify(args.question)}`);
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
  const query = q(field, args, 'results { _id }');
  const resp = await call(query);
  const payload = resp.json?.data?.[field] ?? null;
  const errs = resp.json?.errors ?? null;
  const ids = Array.isArray(payload?.results) ? payload.results.map((r) => r._id) : null;
  console.log(`[${label}] (${resp.ms}ms,HTTP ${resp.status}) results=${ids ? ids.length : (errs ? 'GQL-ERR' : 'null')}${errs ? ' ' + JSON.stringify(errs).slice(0, 140) : ''}`);
  return { label, field, args, query, status: resp.status, ms: resp.ms, errors: errs, transportError: resp.error ?? null, count: ids ? ids.length : null, ids, rawResponse: resp.json ?? resp.raw ?? null };
}
(async () => {
  const out = { capturedAt: new Date().toISOString(), endpoint: ENDPOINT, question: QUESTION, steps: {} };
  // Seed discovery NONE to get pocIds straight from discovery's own result set.
  out.steps.seed = await step('SEED discovery NONE + question', 'discovery', { question: QUESTION, restriction: 'NONE' });
  const ids = out.steps.seed.ids || [];
  const hex = ids.filter((id) => /^[0-9a-f]{24}$/.test(id));
  const top4 = hex.slice(0, 4);
  const single = hex.slice(0, 1);
  out.pocIds_top4 = top4; out.pocIds_single = single;
  console.log(`\n🎯 pocIds from discovery's OWN NONE set — top4: ${top4.join(', ')} | single: ${single.join(', ')}\n`);
  if (!top4.length) { console.error('no hex ids in seed'); save(out); process.exit(1); }
  await sleep(DELAY);

  out.steps.pre_poc_top4 = await step('preDiscovery POC_ONLY + top4 (expect ⊆ top4)', 'preDiscovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: top4 }); await sleep(DELAY);
  out.steps.disc_poc_top4 = await step('discovery   POC_ONLY + top4 (BUG if 0)', 'discovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: top4 }); await sleep(DELAY);
  out.steps.disc_poc_single = await step('discovery   POC_ONLY + single (BUG if 0)', 'discovery', { question: QUESTION, restriction: 'POC_ONLY', pocIds: single }); await sleep(DELAY);
  out.steps.disc_none_top4 = await step('discovery   NONE + top4 (control, expect broad)', 'discovery', { question: QUESTION, restriction: 'NONE', pocIds: top4 });

  const inSet = (arr, s) => (arr || []).every((x) => s.has(x));
  const seedSet = new Set(ids);
  out.evaluation = {
    pre_POC_ONLY_top4: { count: out.steps.pre_poc_top4.count, ids: out.steps.pre_poc_top4.ids, subsetOfTop4: inSet(out.steps.pre_poc_top4.ids, new Set(top4)) },
    disc_POC_ONLY_top4: { count: out.steps.disc_poc_top4.count, ids: out.steps.disc_poc_top4.ids, allTop4InDiscoveryNONE: inSet(top4, seedSet) },
    disc_POC_ONLY_single: { count: out.steps.disc_poc_single.count, ids: out.steps.disc_poc_single.ids, singleInDiscoveryNONE: inSet(single, seedSet) },
    disc_NONE_top4_control: { count: out.steps.disc_none_top4.count },
    VERDICT_discovery_POC_ONLY_broken: (out.steps.disc_poc_top4.count === 0 && inSet(top4, seedSet)) && (out.steps.disc_poc_single.count === 0 && inSet(single, seedSet)),
  };
  console.log('\n=== CONFIRM EVALUATION ===');
  console.log(JSON.stringify(out.evaluation, null, 2));
  save(out);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
function save(o) { const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); const p = path.join(dir, `poc-restriction-confirm-${stamp}.json`); fs.writeFileSync(p, JSON.stringify(o, null, 2)); console.log(`\n💾 Saved: ${p}`); }
