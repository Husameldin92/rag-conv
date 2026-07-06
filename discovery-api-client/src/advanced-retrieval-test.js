/**
 * BACKEND-1602 QA — `advancedRetrieval` faceted-filter battery (read-only, PRODUCTION).
 *
 * Maps the level0–level3 filter taxonomy and runs the ticket's scenario tests (a–g):
 * question-only, single-select, multi-select (canMultiSelect honored?), multi-level,
 * question+filter combined, empty/null arrays, and bad ids. Harvests real item ids from
 * the live baseline tree, then feeds them back in to test selection / isSelected / hierarchy.
 *
 * Saves one rich JSON report under reports/ and prints a readable digest.
 * New file for BACKEND-1602. Native fetch (node-fetch hangs on Node v26). access-token from .env.
 * Usage: node src/advanced-retrieval-test.js
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

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

// ---- query construction -------------------------------------------------
const LEVEL_GROUP_FIELDS = `level _id title titleEn titleDe canMultiSelect brandComplexId genre`;
const ITEM_FIELDS = `_id name nameEn nameDe type level order parentItemId seriesIds brandComplexId colorHexCode year contentTypes genre isSelected`;
const RESULT_FIELDS = `_id title parentName parentGenre brandName brandId type contentType score`;

function buildFilterArg(filter) {
  if (!filter) return '';
  // Only emit levels that are explicitly provided (so we can also test "omitted" vs "[]").
  const parts = [];
  for (const k of ['level0', 'level1', 'level2', 'level3']) {
    if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`);
  }
  return `filter: { ${parts.join(' ')} }`;
}

function buildQuery({ question, filter }) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  const f = buildFilterArg(filter);
  if (f) args.push(f);
  const argStr = args.length ? `(\n    ${args.join('\n    ')}\n  )` : '';
  return `query {
  advancedRetrieval${argStr} {
    categories contentTypes years designations parentIds
    filter {
      levels {
        ${LEVEL_GROUP_FIELDS}
        items { ${ITEM_FIELDS} }
      }
    }
    results { ${RESULT_FIELDS} }
  }
}`;
}

async function call(label, { question, filter }) {
  const query = buildQuery({ question, filter });
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  const t0 = Date.now();
  let rec;
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    const data = j?.data?.advancedRetrieval ?? null;
    rec = {
      label, input: { question, filter }, httpStatus: r.status, ms: Date.now() - t0,
      gqlErrors: j?.errors ?? null,
      facets: data ? { categories: data.categories, contentTypes: data.contentTypes, years: data.years, designations: data.designations, parentIds: data.parentIds } : null,
      levels: data?.filter?.levels ?? null,
      results: data?.results ?? null,
      resultCount: Array.isArray(data?.results) ? data.results.length : null,
    };
  } catch (e) {
    rec = { label, input: { question, filter }, httpStatus: null, ms: Date.now() - t0, transportError: e.message };
  } finally { clearTimeout(t); }
  return rec;
}

// ---- digest helpers -----------------------------------------------------
function levelSummary(levels) {
  if (!Array.isArray(levels)) return '(no levels)';
  return levels.map((lv) => {
    const items = lv.items || [];
    const sel = items.filter((i) => i.isSelected).map((i) => i.name);
    return `  L${lv.level} "${lv.title}" multiSelect=${lv.canMultiSelect} genre=${lv.genre ?? '-'} items=${items.length}` +
      (sel.length ? `  SELECTED=[${sel.join(', ')}]` : '');
  }).join('\n');
}

function printRec(rec) {
  console.log(`\n━━━ [${rec.label}] ━━━ HTTP ${rec.httpStatus} (${rec.ms}ms)`);
  if (rec.gqlErrors) console.log(`   GQL-ERRORS: ${JSON.stringify(rec.gqlErrors).slice(0, 400)}`);
  if (rec.transportError) { console.log(`   TRANSPORT-ERR: ${rec.transportError}`); return; }
  console.log(`   results: ${rec.resultCount}`);
  if (rec.facets) console.log(`   facets: categories=${(rec.facets.categories||[]).length} contentTypes=${JSON.stringify(rec.facets.contentTypes)} years=${(rec.facets.years||[]).length} designations=${JSON.stringify(rec.facets.designations)} parentIds=${(rec.facets.parentIds||[]).length}`);
  console.log(levelSummary(rec.levels));
}

// ---- main ---------------------------------------------------------------
(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token set' : 'NONE'}`);

  const report = { ticket: 'BACKEND-1602', capturedAt: new Date().toISOString(), endpoint: ENDPOINT, calls: {} };
  const record = async (key, label, input) => { const r = await call(label, input); report.calls[key] = r; printRec(r); await sleep(DELAY); return r; };

  // ====================================================================
  // TASK 2 — taxonomy baseline
  // ====================================================================
  console.log('\n\n########## TASK 2 — TAXONOMY BASELINE ##########');
  const baseJava = await record('baseline_java', 'baseline: question="java", no filter', { question: 'java' });
  const baseEmpty = await record('baseline_empty', 'baseline: empty question, no filter', { question: '' });
  const baseNoArgs = await record('baseline_noargs', 'baseline: no question, no filter (omit all)', {});

  // Harvest the taxonomy from the java baseline (richest).
  const tree = baseJava.levels || baseEmpty.levels || [];
  const byLevel = {};
  for (const lv of tree) byLevel[lv.level] = lv;
  const l0items = byLevel[0]?.items || [];
  console.log(`\n>>> level0 has ${l0items.length} items. First few:`);
  for (const it of l0items.slice(0, 8)) console.log(`      ${it._id}  type=${it.type}  "${it.name}"  seriesIds=${(it.seriesIds||[]).length}  parentItemId=${it.parentItemId ?? '-'}`);

  // pick ids for scenarios: first level0 item, plus two for multi-select
  const l0a = l0items[0];
  const l0b = l0items[1];
  report.harvest = {
    level0Count: l0items.length,
    level0Sample: l0items.slice(0, 12).map((i) => ({ _id: i._id, name: i.name, type: i.type, seriesIds: i.seriesIds, parentItemId: i.parentItemId, brandComplexId: i.brandComplexId })),
    multiSelectByLevel: tree.map((lv) => ({ level: lv.level, canMultiSelect: lv.canMultiSelect, title: lv.title })),
    chosen: { l0a: l0a ? { _id: l0a._id, name: l0a.name } : null, l0b: l0b ? { _id: l0b._id, name: l0b.name } : null },
  };

  // ====================================================================
  // TASK 3 — scenarios
  // ====================================================================
  console.log('\n\n########## TASK 3 — SCENARIOS ##########');

  // (a) question only — two different terms
  console.log('\n--- (a) question only: "java" vs "kubernetes" ---');
  await record('a_q_kubernetes', '(a) question="kubernetes", no filter', { question: 'kubernetes' });
  // (java baseline already captured above as baseline_java)

  let l1items = [];
  if (l0a) {
    // (b) single select level0
    console.log('\n--- (b) single-select level0 ---');
    const b = await record('b_single_l0', `(b) level0=["${l0a._id}"] ("${l0a.name}") + question="java"`, { question: 'java', filter: { level0: [l0a._id] } });
    // does the selected item report isSelected, and what does level1 become?
    const bL0 = (b.levels || []).find((lv) => lv.level === 0);
    const selOk = (bL0?.items || []).find((i) => i._id === l0a._id)?.isSelected;
    console.log(`   >>> level0 item "${l0a.name}" isSelected=${selOk}`);
    const bL1 = (b.levels || []).find((lv) => lv.level === 1);
    l1items = bL1?.items || [];
    console.log(`   >>> level1 now has ${l1items.length} items (after selecting the level0 brand). First few:`);
    for (const it of l1items.slice(0, 6)) console.log(`        ${it._id}  type=${it.type}  "${it.name}"  parentItemId=${it.parentItemId ?? '-'}`);
  }

  // (c) multi-select honored?
  console.log('\n--- (c) multi-select test ---');
  // find a level with canMultiSelect true and one with false (from baseline)
  if (l0a && l0b) {
    const l0 = byLevel[0];
    await record('c_multi_l0', `(c) level0 multi=[${l0.canMultiSelect}] pass 2 ids: "${l0a.name}" + "${l0b.name}"`, { question: 'java', filter: { level0: [l0a._id, l0b._id] } });
  }

  // (d) multi-level: level0 + level1 together
  if (l0a && l1items.length) {
    console.log('\n--- (d) multi-level: level0 + level1 ---');
    const l1a = l1items[0];
    const d = await record('d_multi_level', `(d) level0=["${l0a.name}"] + level1=["${l1a.name}"] + question="java"`, { question: 'java', filter: { level0: [l0a._id], level1: [l1a._id] } });
    const dL2 = (d.levels || []).find((lv) => lv.level === 2);
    console.log(`   >>> after level0+level1, level2 has ${(dL2?.items || []).length} items`);
    // stash for level2/level3 exploration
    report.harvest.chosen.l1a = { _id: l1a._id, name: l1a.name };
    const l2items = dL2?.items || [];
    if (l2items.length) {
      report.harvest.chosen.l2a = { _id: l2items[0]._id, name: l2items[0].name };
      console.log(`   >>> level2 first few:`);
      for (const it of l2items.slice(0, 6)) console.log(`        ${it._id}  type=${it.type}  "${it.name}"`);
    }
  }

  // (e) question + filter combined (AND)
  if (l0a) {
    console.log('\n--- (e) question + filter combined ---');
    await record('e_q_plus_filter', `(e) question="java" + level0=["${l0a.name}"]`, { question: 'java', filter: { level0: [l0a._id] } });
    // compare to a different question with same filter
    await record('e_q2_plus_filter', `(e) question="security" + level0=["${l0a.name}"]`, { question: 'security', filter: { level0: [l0a._id] } });
  }

  // (f) empty / null arrays
  console.log('\n--- (f) empty / null arrays ---');
  await record('f_all_empty', '(f) all levels = [] + question="java"', { question: 'java', filter: { level0: [], level1: [], level2: [], level3: [] } });
  await record('f_empty_filter_obj', '(f) filter:{} (no level keys) + question="java"', { question: 'java', filter: {} });

  // (g) bad id
  console.log('\n--- (g) bad id ---');
  await record('g_bad_id', '(g) level0=["NOT_A_REAL_ID_123"] + question="java"', { question: 'java', filter: { level0: ['NOT_A_REAL_ID_123'] } });

  // ---- save ----
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-test-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  console.log(`\n💾 Saved full report: ${p}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
