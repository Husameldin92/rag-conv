/**
 * BACKEND-1602 QA — Round 2, focused (read-only, PRODUCTION).
 *
 * Round 1 (advanced-retrieval-test.js) revealed: taxonomy is L0 "Filter" (activity+contentType),
 * L1 "Brand" (single-select), L2 "Series" (per brand, split by year); item labels live in
 * nameEn/nameDe (plain `name`/`title` come back null); isSelected was null on every selected item;
 * and Round-1 selection scenarios all picked the FIRST L0 item which is "Attended" (a user-activity
 * filter) → contaminated the result-narrowing tests with 0s.
 *
 * Round 2 fixes that and answers the open questions cleanly:
 *   - locale: does an Accept-Language header populate the null `name`/`title`?
 *   - select CONTENT facets (contentType "Conference"/"Tutorial") → do results narrow to that type?
 *   - select a Brand only (no activity) → results, isSelected, does L2 appear?
 *   - drill Brand → Series → does a 4th level (L3) appear, and what does it hold?
 *   - L1 canMultiSelect:false with 2 ids → what happens?
 *   - is the 3-brand set fixed regardless of question? (scoping check)
 *
 * Selects facets by LABEL (nameEn) resolved live, so it never hard-codes synthetic ids.
 * New file for BACKEND-1602. Native fetch. access-token from .env. Usage: node src/advanced-retrieval-test2.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 1500, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(lang) {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  if (lang) h['accept-language'] = lang;
  return h;
}

const LEVEL_GROUP_FIELDS = `level _id title titleEn titleDe canMultiSelect brandComplexId genre`;
const ITEM_FIELDS = `_id name nameEn nameDe type level order parentItemId seriesIds brandComplexId colorHexCode year contentTypes genre isSelected`;
const RESULT_FIELDS = `_id title parentName parentGenre brandName brandId type contentType score`;

function buildQuery({ question, filter }) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  if (filter) {
    const parts = [];
    for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`);
    args.push(`filter: { ${parts.join(' ')} }`);
  }
  const argStr = args.length ? `(\n    ${args.join('\n    ')}\n  )` : '';
  return `query {
  advancedRetrieval${argStr} {
    categories contentTypes years designations parentIds
    filter { levels { ${LEVEL_GROUP_FIELDS} items { ${ITEM_FIELDS} } } }
    results { ${RESULT_FIELDS} }
  }
}`;
}

async function call(label, { question, filter, lang }) {
  const query = buildQuery({ question, filter });
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(lang), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    const data = j?.data?.advancedRetrieval ?? null;
    return {
      label, input: { question, filter, lang }, httpStatus: r.status, ms: Date.now() - t0,
      gqlErrors: j?.errors ?? null,
      facets: data ? { categories: data.categories, contentTypes: data.contentTypes, years: data.years, designations: data.designations, parentIds: data.parentIds } : null,
      levels: data?.filter?.levels ?? null,
      results: data?.results ?? null,
      resultCount: Array.isArray(data?.results) ? data.results.length : null,
    };
  } catch (e) {
    return { label, input: { question, filter, lang }, httpStatus: null, ms: Date.now() - t0, transportError: e.message };
  } finally { clearTimeout(t); }
}

const findLevel = (rec, lvl) => (rec.levels || []).find((x) => x.level === lvl);
const findItem = (rec, lvl, nameEn) => (findLevel(rec, lvl)?.items || []).find((i) => i.nameEn === nameEn);

function printLevels(rec) {
  for (const lv of (rec.levels || [])) {
    const sel = (lv.items || []).filter((i) => i.isSelected);
    console.log(`   L${lv.level} "${lv.titleEn}" multi=${lv.canMultiSelect} items=${(lv.items||[]).length}${sel.length ? `  isSelected→[${sel.map(i=>i.nameEn).join(', ')}]` : '  (no isSelected=true)'}`);
  }
}
function printResultsBrief(rec, n = 6) {
  const rs = rec.results || [];
  for (const r of rs.slice(0, n)) console.log(`        • ${r.contentType ?? r.type ?? '?'} | ${JSON.stringify(r.title)} | brand=${r.brandName ?? r.parentName ?? '-'}`);
}

(async () => {
  console.log(`📡 ${ENDPOINT}\n🔐 ${process.env.AUTH_TOKEN ? 'auth set' : 'NONE'}`);
  const report = { ticket: 'BACKEND-1602', round: 2, capturedAt: new Date().toISOString(), endpoint: ENDPOINT, calls: {} };
  const rec = async (key, label, input) => { const r = await call(label, input); report.calls[key] = r; console.log(`\n━━━ [${label}] HTTP ${r.httpStatus} (${r.ms}ms) results=${r.resultCount}${r.gqlErrors?' GQL-ERR '+JSON.stringify(r.gqlErrors).slice(0,200):''}`); if(!r.transportError) printLevels(r); else console.log('   TRANSPORT-ERR '+r.transportError); await sleep(DELAY); return r; };

  // ---- 1. LOCALE: does Accept-Language populate the null name/title? ----
  console.log('\n########## 1. LOCALE TEST ##########');
  const baseEn = await rec('locale_en', 'question="java", accept-language=en', { question: 'java', lang: 'en' });
  const baseDe = await rec('locale_de', 'question="java", accept-language=de', { question: 'java', lang: 'de' });
  for (const [k, r] of [['en', baseEn], ['de', baseDe]]) {
    const l0 = findLevel(r, 0);
    const it = (l0?.items || [])[0];
    console.log(`   [${k}] L0 title(plain)=${JSON.stringify(l0?.title)} | item0 name(plain)=${JSON.stringify(it?.name)} nameEn=${JSON.stringify(it?.nameEn)} nameDe=${JSON.stringify(it?.nameDe)}`);
  }

  // ---- 2. BRAND-SET STABILITY across questions (scoping check) ----
  console.log('\n########## 2. BRAND SET ACROSS QUESTIONS ##########');
  for (const q of ['java', 'kubernetes', 'security', 'rust', '']) {
    const r = await rec(`brands_${q || 'empty'}`, `brand set for question="${q}"`, { question: q });
    const brands = (findLevel(r, 1)?.items || []).map((i) => `${i.type}:${i.nameEn}`);
    console.log(`   brands(L1) = [${brands.join(', ')}]  (complexId=${(findLevel(r,1)?.items||[])[0]?.brandComplexId})`);
  }

  // ---- 3. CLEAN CONTENT-FACET SELECTION (L0 contentType) ----
  console.log('\n########## 3. CONTENT-FACET SELECTION (L0 contentType) ##########');
  const baseline = baseEn; // reuse
  const confItem = findItem(baseline, 0, 'Conference');
  const tutItem = findItem(baseline, 0, 'Tutorial');
  if (confItem) {
    const r = await rec('sel_conference', `select L0 "Conference" (id ${confItem._id}) + question="java"`, { question: 'java', lang: 'en', filter: { level0: [confItem._id] } });
    const selBack = findItem(r, 0, 'Conference');
    console.log(`   >>> "Conference" isSelected back = ${selBack?.isSelected}  | result contentTypes seen: ${JSON.stringify([...new Set((r.results||[]).map(x=>x.contentType))])}`);
    printResultsBrief(r);
  }
  if (tutItem) {
    const r = await rec('sel_tutorial', `select L0 "Tutorial" (id ${tutItem._id}) + question="java"`, { question: 'java', lang: 'en', filter: { level0: [tutItem._id] } });
    const selBack = findItem(r, 0, 'Tutorial');
    console.log(`   >>> "Tutorial" isSelected back = ${selBack?.isSelected}  | result contentTypes seen: ${JSON.stringify([...new Set((r.results||[]).map(x=>x.contentType))])}`);
    printResultsBrief(r);
  }
  // multi-select two contentTypes on L0 (canMultiSelect=true)
  if (confItem && tutItem) {
    const r = await rec('sel_multi_l0', `select L0 ["Conference","Tutorial"] (multi=true) + question="java"`, { question: 'java', lang: 'en', filter: { level0: [confItem._id, tutItem._id] } });
    const sel = (findLevel(r, 0)?.items || []).filter(i=>i.isSelected).map(i=>i.nameEn);
    console.log(`   >>> isSelected back = [${sel.join(', ')}] (expect both)`);
  }

  // ---- 4. BRAND-ONLY SELECTION (L1) + drill to L2/L3 ----
  console.log('\n########## 4. BRAND SELECTION + DRILL ##########');
  const brandItem = findItem(baseline, 1, 'BASTA!') || (findLevel(baseline,1)?.items||[]).find(i=>i.type==='BRAND');
  if (brandItem) {
    const rB = await rec('sel_brand', `select L1 brand "${brandItem.nameEn}" (id ${brandItem._id}) + question="java"`, { question: 'java', lang: 'en', filter: { level1: [brandItem._id] } });
    const selBack = findItem(rB, 1, brandItem.nameEn);
    console.log(`   >>> brand "${brandItem.nameEn}" isSelected back = ${selBack?.isSelected}  | parentIds=${(rB.facets?.parentIds||[]).length}`);
    printResultsBrief(rB);
    // now drill: brand + first series (L2)
    const seriesItem = (findLevel(rB, 2)?.items || [])[0];
    if (seriesItem) {
      const rS = await rec('sel_brand_series', `select L1 brand + L2 series "${seriesItem.nameEn}" (id ${seriesItem._id})`, { question: 'java', lang: 'en', filter: { level1: [brandItem._id], level2: [seriesItem._id] } });
      console.log(`   >>> after brand+series: levels present = [${(rS.levels||[]).map(l=>'L'+l.level).join(', ')}]  parentIds=${(rS.facets?.parentIds||[]).length}`);
      const l3 = findLevel(rS, 3);
      if (l3) { console.log(`   >>> L3 "${l3.titleEn}" multi=${l3.canMultiSelect} items=${(l3.items||[]).length}:`); for (const it of (l3.items||[]).slice(0,8)) console.log(`        L3 item _id=${it._id} type=${it.type} nameEn=${JSON.stringify(it.nameEn)} parentItemId=${it.parentItemId}`); }
      else console.log('   >>> NO L3 level returned even after brand+series selection.');
      const selSeries = findItem(rS, 2, seriesItem.nameEn);
      console.log(`   >>> series "${seriesItem.nameEn}" isSelected back = ${selSeries?.isSelected}`);
    }
  }

  // ---- 5. L1 canMultiSelect:false with 2 brand ids ----
  console.log('\n########## 5. SINGLE-SELECT LEVEL (L1) WITH 2 IDS ##########');
  const brands = (findLevel(baseline, 1)?.items || []).filter(i=>i.type==='BRAND');
  if (brands.length >= 2) {
    const r = await rec('l1_two_ids', `L1 (canMultiSelect=false) pass 2 brand ids: ["${brands[0].nameEn}","${brands[1].nameEn}"]`, { question: 'java', lang: 'en', filter: { level1: [brands[0]._id, brands[1]._id] } });
    const sel = (findLevel(r, 1)?.items || []).filter(i=>i.isSelected).map(i=>i.nameEn);
    console.log(`   >>> isSelected back = [${sel.join(', ')}]  resultCount=${r.resultCount}  (does it reject/take-first/honor-both/error?)`);
  }

  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-test2-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  console.log(`\n💾 Saved: ${p}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
