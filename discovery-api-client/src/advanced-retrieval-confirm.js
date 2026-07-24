/**
 * BACKEND-1602 QA — confirmations (read-only, PRODUCTION).
 * Hardens two findings before the handback:
 *  A. multi-select honored? L0 [Conference,Tutorial] vs swapped order; L2 two series (union vs first).
 *  B. characterize Windows Developer's 19 live parentIds vs the CSV (staleness vs mis-assignment).
 * Native fetch, access-token from .env. Usage: node src/advanced-retrieval-confirm.js
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
// Drive path is the default; override with CSV_PATH env var or a CLI arg so this survives the next move.
const CSV_PATH = process.env.CSV_PATH || process.argv[2] || '/Users/osmanhusam/Library/CloudStorage/GoogleDrive-hossamossman92@gmail.com/Meine Ablage/Claude-Homebase/02 Projects/Work/RAG/Features/Backend RAG Queries (BACKEND-1602-1603)/collections_relationship.csv';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };
function q({ question, filter }) {
  const a = []; if (question !== undefined) a.push(`question: ${JSON.stringify(question)}`);
  if (filter) { const p = []; for (const k of ['level0','level1','level2','level3']) if (filter[k] !== undefined) p.push(`${k}: ${JSON.stringify(filter[k])}`); a.push(`filter:{${p.join(' ')}}`); }
  return `query { advancedRetrieval(${a.join(' ')}) { parentIds filter { levels { level titleEn items { _id nameEn type contentTypes year } } } results { _id contentType title brandName } } }`;
}
async function call(input) { const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query: q(input) }) }); const j = JSON.parse(await r.text()); const d = j?.data?.advancedRetrieval; return { levels: d?.filter?.levels || [], parentIds: d?.parentIds || [], results: d?.results || [], errors: j?.errors }; }
const lvl = (r, n) => (r.levels || []).find((x) => x.level === n);
const item = (r, n, name) => (lvl(r, n)?.items || []).find((i) => i.nameEn === name);
const cts = (r) => [...new Set((r.results || []).map((x) => x.contentType))];

(async () => {
  const base = await call({ question: 'java' }); await sleep(1200);
  const conf = item(base, 0, 'Conference'), tut = item(base, 0, 'Tutorial');

  console.log('=== A. MULTI-SELECT (L0 contentType, canMultiSelect=true) ===');
  const a1 = await call({ question: 'java', filter: { level0: [conf._id, tut._id] } }); await sleep(1200);
  console.log(`  [Conference, Tutorial] -> contentTypes in results: ${JSON.stringify(cts(a1))}  (expect both RHEINGOLD+TUTORIAL if multi honored)`);
  const a2 = await call({ question: 'java', filter: { level0: [tut._id, conf._id] } }); await sleep(1200);
  console.log(`  [Tutorial, Conference] (swapped) -> contentTypes: ${JSON.stringify(cts(a2))}  (if it follows first id -> order-dependent = first-only)`);

  // L2: pick BASTA! and two of its series
  const basta = (lvl(base, 1)?.items || []).find((i) => i.nameEn === 'BASTA!');
  const sel = await call({ question: 'java', filter: { level1: [basta._id] } }); await sleep(1200);
  const series = (lvl(sel, 2)?.items || []);
  const s1 = series[0], s2 = series[2]; // two different series (Spring 2026, Herbst 2026)
  console.log('\n=== A2. MULTI-SELECT (L2 Series, canMultiSelect=true) ===');
  const one = await call({ question: 'java', filter: { level1: [basta._id], level2: [s1._id] } }); await sleep(1200);
  const two = await call({ question: 'java', filter: { level1: [basta._id], level2: [s1._id, s2._id] } }); await sleep(1200);
  console.log(`  series "${s1.nameEn}" alone -> parentIds=${one.parentIds.length}, results=${one.results.length}`);
  console.log(`  series ["${s1.nameEn}","${s2.nameEn}"] -> parentIds=${two.parentIds.length}, results=${two.results.length}  (if > single, union honored)`);

  console.log('\n=== B. Windows Developer 19 parentIds vs CSV ===');
  const wd = (lvl(base, 1)?.items || []).find((i) => i.nameEn === 'Windows Developer');
  const wdSel = await call({ question: 'java', filter: { level1: [wd._id] } });
  const pid = wdSel.parentIds || [];
  const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
  const csvItemIndex = new Map(); for (const r of rows) if (r.item_id) csvItemIndex.set(r.item_id, { brand: r.conferenceBrand_name, name: r.item_name, status: r.status });
  const hex24 = pid.filter((id) => /^[a-f0-9]{24}$/.test(id)).length;
  console.log(`  Windows Developer parentIds=${pid.length}, 24-hex=${hex24}`);
  console.log(`  sample ids: ${pid.slice(0, 5).join(', ')}`);
  const anywhere = pid.filter((id) => csvItemIndex.has(id)).map((id) => `${id}->${csvItemIndex.get(id).brand}`);
  console.log(`  found ANYWHERE in CSV (any brand): ${anywhere.length ? anywhere.join(', ') : 'NONE — these ids are absent from the CSV entirely (CSV snapshot likely stale for this brand)'}`);
})().catch((e) => console.error('FATAL', e.message));
