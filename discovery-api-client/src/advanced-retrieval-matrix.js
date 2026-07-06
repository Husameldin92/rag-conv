/**
 * BACKEND-1602 QA — FULL FILTER MATRIX runner (read-only, PRODUCTION).
 *
 * Runs every row of `[C] BACKEND-1602 — Full Filter Matrix.md` against the live
 * `advancedRetrieval` query, auto-asserting the [CC] rows and reporting raw output for the
 * [HU] activity rows. Verifies the two reopened bugs:
 *   BUG 1 — content-type multi-select / 10-POC cap: does a combined selection surface every
 *           selected genre once paginated, and is totalCount the true combined total (not 10)?
 *   BUG 2 — documented fields null: name / colorHexCode / isSelected / level title / results.score.
 *
 * SCHEMA-ADAPTIVE: the ticket claims a *new* schema (`page` + `totalCount`); the 06-29 baseline
 * showed `PAGE`/`PAGE_SIZE` and no `totalCount`. So this introspects ONCE up front and builds
 * every query from what is actually live (pagination arg name/case, totalCount presence, and
 * whether the documented item/level/result fields even exist in the schema).
 *
 * IDs are synthetic & session-scoped, so ids are harvested LIVE by nameEn label from the baseline
 * tree — never hard-coded — and compared against the matrix's documented ids as a bonus check.
 *
 * New file for BACKEND-1602. Native fetch (node-fetch hangs on Node v26). access-token from .env.
 * Read-only, low + spaced volume. Usage: node src/advanced-retrieval-matrix.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 1100, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

async function gql(query) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { httpStatus: r.status, json: j, ms: Date.now() - t0 };
  } catch (e) {
    return { httpStatus: null, json: null, transportError: e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(t); }
}

// ============================================================ SCHEMA PROFILE
async function introspect() {
  const q = `query {
    q:   __type(name:"Query"){ fields{ name args{ name type{ kind name ofType{ kind name ofType{ kind name } } } } } }
    ret: __type(name:"RETRIEVAL"){ fields{ name } }
    fin: __type(name:"RetrievalFilterInput"){ inputFields{ name } }
    item:__type(name:"RetrievalFilterLevelItem"){ fields{ name } }
    grp: __type(name:"RetrievalFilterLevelGroup"){ fields{ name } }
    poc: __type(name:"PieceOfContent"){ fields{ name } }
  }`;
  const { json } = await gql(q);
  const d = json?.data || {};
  const names = (arr) => new Set((arr || []).map((f) => f.name));
  const retF = names(d.ret?.fields);
  const finF = (d.fin?.inputFields || []).map((f) => f.name);
  const itemF = names(d.item?.fields);
  const grpF = names(d.grp?.fields);
  const pocF = names(d.poc?.fields);
  const arField = (d.q?.fields || []).find((f) => f.name === 'advancedRetrieval');
  const arArgs = (arField?.args || []).map((a) => a.name);
  // pagination arg: prefer exact `page`, else `PAGE`, else any /page/i not a page-size arg
  const pageArg = arArgs.find((a) => a === 'page') || arArgs.find((a) => a === 'PAGE')
    || arArgs.find((a) => /page/i.test(a) && !/size/i.test(a)) || null;
  const pageSizeArg = arArgs.find((a) => /page.?size/i.test(a)) || null;
  return {
    present: !!arField,
    args: arArgs,
    filterLevels: finF,
    pageArg, pageSizeArg,
    hasTotalCount: retF.has('totalCount'),
    retrievalFields: [...retF],
    item: { name: itemF.has('name'), colorHexCode: itemF.has('colorHexCode'), isSelected: itemF.has('isSelected'),
            nameEn: itemF.has('nameEn'), type: itemF.has('type'), contentTypes: itemF.has('contentTypes'), year: itemF.has('year') },
    level: { title: grpF.has('title'), titleEn: grpF.has('titleEn'), canMultiSelect: grpF.has('canMultiSelect') },
    result: { score: pocF.has('score'), parentGenre: pocF.has('parentGenre'), contentType: pocF.has('contentType'),
              title: pocF.has('title'), brandName: pocF.has('brandName') },
  };
}

// ============================================================ QUERY BUILDER (adaptive)
function buildQuery({ question, filter, page }, P) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  if (filter) {
    const parts = [];
    for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`);
    args.push(`filter: { ${parts.join(' ')} }`);
  }
  if (page !== undefined && P.pageArg) args.push(`${P.pageArg}: ${page}`);
  const argStr = args.length ? `(${args.join(', ')})` : '';

  const itemSel = ['_id'];
  if (P.item.nameEn) itemSel.push('nameEn');
  if (P.item.name) itemSel.push('name');
  if (P.item.type) itemSel.push('type');
  if (P.item.colorHexCode) itemSel.push('colorHexCode');
  if (P.item.isSelected) itemSel.push('isSelected');
  if (P.item.contentTypes) itemSel.push('contentTypes');
  if (P.item.year) itemSel.push('year');

  const grpSel = ['level'];
  if (P.level.titleEn) grpSel.push('titleEn');
  if (P.level.title) grpSel.push('title');
  if (P.level.canMultiSelect) grpSel.push('canMultiSelect');

  const resSel = ['_id'];
  if (P.result.parentGenre) resSel.push('parentGenre');
  if (P.result.contentType) resSel.push('contentType');
  if (P.result.title) resSel.push('title');
  if (P.result.brandName) resSel.push('brandName');
  if (P.result.score) resSel.push('score');

  const top = ['contentTypes', 'parentIds', 'years'];
  if (P.hasTotalCount) top.unshift('totalCount');

  return `query {
  advancedRetrieval${argStr} {
    ${top.join(' ')}
    results { ${resSel.join(' ')} }
    filter { levels { ${grpSel.join(' ')} items { ${itemSel.join(' ')} } } }
  }
}`;
}

async function call(input, P) {
  const query = buildQuery(input, P);
  const r = await gql(query);
  const data = r.json?.data?.advancedRetrieval ?? null;
  return {
    input, httpStatus: r.httpStatus, ms: r.ms, transportError: r.transportError,
    gqlErrors: r.json?.errors ?? null,
    totalCount: data?.totalCount ?? null,
    contentTypes: data?.contentTypes ?? null,
    parentIds: data?.parentIds ?? null,
    years: data?.years ?? null,
    levels: data?.filter?.levels ?? null,
    results: data?.results ?? null,
    resultCount: Array.isArray(data?.results) ? data.results.length : null,
  };
}

// ============================================================ helpers
const findLevel = (rec, lvl) => (rec.levels || []).find((x) => x.level === lvl);
const findItem = (rec, lvl, nameEn) => (findLevel(rec, lvl)?.items || []).find((i) => i.nameEn === nameEn);
const genresOf = (rec) => [...new Set((rec.results || []).map((r) => r.parentGenre))];
const idsOf = (rec) => (rec.results || []).map((r) => r._id);
const scoresOf = (rec) => (rec.results || []).map((r) => r.score);

// Walk pages 1..maxPages, collecting union of ids & genres. Stops early when a page returns
// <pageSize results (last page), when all needGenres are seen, or when page*10 >= totalCount.
async function walkPages({ question, filter }, P, { maxPages = 8, needGenres = null } = {}) {
  const pages = []; const unionIds = new Set(); const unionGenres = new Set();
  let totalCount = null; let page = 1; let cappedAt = null;
  while (page <= maxPages) {
    const r = await call({ question, filter, page }, P);
    const rc = r.resultCount || 0;
    totalCount = r.totalCount ?? totalCount;
    for (const id of idsOf(r)) unionIds.add(id);
    for (const g of genresOf(r)) unionGenres.add(g);
    pages.push({ page, resultCount: rc, totalCount: r.totalCount, genres: genresOf(r), firstIds: idsOf(r).slice(0, 3), gqlErrors: r.gqlErrors });
    await sleep(DELAY);
    if (rc < 10) break; // last page
    if (needGenres && needGenres.every((g) => unionGenres.has(g))) break;
    if (totalCount != null && page * 10 >= totalCount) break;
    if (page === maxPages) cappedAt = maxPages;
    page++;
  }
  return { pages, unionIds: [...unionIds], unionGenres: [...unionGenres], totalCount, cappedAt, pagesWalked: pages.length };
}

// ============================================================ MAIN
(async () => {
  console.log(`\n📡 ${ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token header set' : 'NONE — will fail'}\n`);

  const R = { ticket: 'BACKEND-1602', kind: 'full-matrix', capturedAt: new Date().toISOString(), endpoint: ENDPOINT, node: process.version, schema: null, rows: {}, harvest: {} };

  // ---------- SCHEMA (introspect once) ----------
  console.log('########## SCHEMA INTROSPECTION (once) ##########');
  const P = await introspect(); R.schema = P; await sleep(DELAY);
  console.log(`advancedRetrieval present : ${P.present}`);
  console.log(`args                      : ${P.args.join(', ')}`);
  console.log(`filter input levels       : ${P.filterLevels.join(', ')}`);
  console.log(`pagination arg            : ${P.pageArg || '(none)'}   pageSize arg: ${P.pageSizeArg || '(none)'}`);
  console.log(`totalCount on RETRIEVAL   : ${P.hasTotalCount}`);
  console.log(`item.name/color/isSelected: ${P.item.name}/${P.item.colorHexCode}/${P.item.isSelected}`);
  console.log(`level.title               : ${P.level.title}`);
  console.log(`result.score/parentGenre  : ${P.result.score}/${P.result.parentGenre}`);
  if (!P.present) { console.log('🛑 advancedRetrieval not present — aborting.'); process.exit(1); }

  const GENRE = { Conference: ['RHEINGOLD'], Tutorial: ['TUTORIAL'], 'Live Event': ['FSLE'], Camp: ['CAMP', 'FLEX_CAMP'], Article: [null] };
  const rec = (id, obj) => { R.rows[id] = obj; const s = obj.status || '·'; console.log(`  [${id}] ${s}  ${obj.note || ''}`); };

  // ---------- A1 baseline / harvest ----------
  console.log('\n########## A — Baseline & question-optional ##########');
  const base = await call({ question: 'java' }, P); await sleep(DELAY);
  const l0items = (findLevel(base, 0)?.items || []);
  const l1items = (findLevel(base, 1)?.items || []);
  R.harvest.level0 = l0items.map((i) => ({ _id: i._id, nameEn: i.nameEn, type: i.type }));
  R.harvest.level1 = l1items.map((i) => ({ _id: i._id, nameEn: i.nameEn, type: i.type }));
  // compare live L0 ids vs matrix documented ids
  const DOC = { Attended: '6a3da3aea4413bbb376c7600', Favorited: '6a3da3aea4413bbb376c7601', Continue: '6a3da3aea4413bbb376c7602', Article: '6a3da3aea4413bbb376c7603', Tutorial: '6a3da3aea4413bbb376c7604', 'Live Event': '6a3da3aea4413bbb376c7605', Camp: '6a3da3aea4413bbb376c7606', Conference: '6a3da3aea4413bbb376c7607' };
  R.harvest.idCompare = Object.entries(DOC).map(([nm, docId]) => { const live = (l0items.find((i) => i.nameEn === nm) || {})._id || null; return { name: nm, documented: docId, live, match: live === docId }; });
  console.log('  L0 id documented-vs-live:');
  for (const c of R.harvest.idCompare) console.log(`    ${c.name.padEnd(11)} doc=${c.documented} live=${c.live} ${c.match ? '✓' : '✗ (harvesting live)'}`);

  const id = (nm, lvl = 0) => (findItem(base, lvl, nm) || {})._id;
  const A1pass = Array.isArray(base.results) && base.results.length <= 10 && (P.hasTotalCount ? Number.isInteger(base.totalCount) : true) && l0items.length > 0 && l1items.length > 0;
  rec('A1', { status: A1pass ? '✅' : '⚠️', totalCount: base.totalCount, resultCount: base.resultCount, levels: (base.levels || []).map((l) => l.level), note: `tree L0(${l0items.length})+L1(${l1items.length}); totalCount=${base.totalCount}; results=${base.resultCount}` });

  const a2 = await call({ filter: undefined }, P); await sleep(DELAY); // omit question entirely
  const a2NoErr = !a2.gqlErrors && !a2.transportError; const a2Tree = (a2.levels || []).length > 0;
  rec('A2', { status: a2NoErr && a2Tree ? '✅' : '✖', totalCount: a2.totalCount, resultCount: a2.resultCount, note: `question omitted → tree builds=${a2Tree}, results=${a2.resultCount}, errors=${a2.gqlErrors ? JSON.stringify(a2.gqlErrors).slice(0, 120) : 'none'}` });

  const a3 = await call({ question: '' }, P); await sleep(DELAY);
  const a3Match = (!a3.gqlErrors) && ((a3.levels || []).length > 0);
  rec('A3', { status: a3Match ? '✅' : '✖', totalCount: a3.totalCount, resultCount: a3.resultCount, note: `question:"" → tree builds=${(a3.levels || []).length > 0}, results=${a3.resultCount} (A2 results=${a2.resultCount})` });

  const bastaId = id('BASTA!', 1) || (l1items.find((i) => i.type === 'BRAND') || {})._id;
  const a4 = await call({ filter: { level1: [bastaId] } }, P); await sleep(DELAY); // brand filter, NO question
  const a4NoErr = !a4.gqlErrors && !a4.transportError;
  rec('A4', { status: a4NoErr && (a4.levels || []).length > 0 ? '✅' : '✖', totalCount: a4.totalCount, resultCount: a4.resultCount, parentIds: (a4.parentIds || []).length, note: `brand filter w/o question → results=${a4.resultCount}, parentIds=${(a4.parentIds || []).length}, errors=${a4.gqlErrors ? 'YES' : 'none'}` });

  // ---------- B — single content-type correctness ----------
  console.log('\n########## B — Single content-type correctness ##########');
  const CTYPES = [['B1', 'Conference'], ['B2', 'Tutorial'], ['B3', 'Article'], ['B4', 'Live Event'], ['B5', 'Camp']];
  for (const [row, nm] of CTYPES) {
    const cid = id(nm); if (!cid) { rec(row, { status: '⚠️', note: `${nm} not found in L0` }); continue; }
    const withQ = await call({ question: 'java', filter: { level0: [cid] } }, P); await sleep(DELAY);
    const noQ = await call({ filter: { level0: [cid] } }, P); await sleep(DELAY);
    const exp = GENRE[nm]; const gW = genresOf(withQ); const gN = genresOf(noQ);
    const okGenres = (gs) => gs.length === 0 ? 'empty' : gs.every((g) => exp.includes(g));
    const wOk = okGenres(gW), nOk = okGenres(gN);
    // Article special: report exactly what parentGenre comes back
    let status, note;
    if (nm === 'Article') {
      status = '⚠️';
      note = `Article → parentGenre(withQ)=${JSON.stringify(gW)} (noQ)=${JSON.stringify(gN)}; contentTypes facet withQ=${JSON.stringify(withQ.contentTypes)}; results w/${withQ.resultCount} n/${noQ.resultCount} → EXPECT null (verify null vs READ)`;
    } else {
      const pass = (wOk === true || wOk === 'empty') && (nOk === true || nOk === 'empty') && !(wOk === 'empty' && nOk === 'empty');
      status = pass ? '✅' : '✖';
      note = `${nm}: withQ genres=${JSON.stringify(gW)} (${wOk}); noQ genres=${JSON.stringify(gN)} (${nOk}); facet=${JSON.stringify(withQ.contentTypes)}; totalCount w/${withQ.totalCount} n/${noQ.totalCount}`;
    }
    rec(row, { status, expected: exp, withQ: { genres: gW, contentTypes: withQ.contentTypes, totalCount: withQ.totalCount, resultCount: withQ.resultCount }, noQ: { genres: gN, contentTypes: noQ.contentTypes, totalCount: noQ.totalCount, resultCount: noQ.resultCount }, note });
  }

  // ---------- C — multi-select + pagination (BUG 1) ----------
  console.log('\n########## C — Content-type multi-select + pagination (BUG 1) ##########');
  const confId = id('Conference'), tutId = id('Tutorial'), artId = id('Article'), liveId = id('Live Event'), campId = id('Camp');
  // baselines for combine comparison
  const confAlone = await call({ question: 'java', filter: { level0: [confId] } }, P); await sleep(DELAY);
  const tutAlone = await call({ question: 'java', filter: { level0: [tutId] } }, P); await sleep(DELAY);

  const c1 = await call({ question: 'java', filter: { level0: [confId, tutId] }, page: 1 }, P); await sleep(DELAY);
  const c1FacetOk = Array.isArray(c1.contentTypes) && ['RHEINGOLD', 'TUTORIAL'].every((g) => (c1.contentTypes || []).includes(g));
  const c1TotalOk = P.hasTotalCount ? (c1.totalCount > 10) : null;
  rec('C1', { status: (c1FacetOk && (c1TotalOk !== false)) ? '✅' : '✖', contentTypes: c1.contentTypes, totalCount: c1.totalCount, note: `Conf+Tut page1: facet=${JSON.stringify(c1.contentTypes)} (both regd=${c1FacetOk}); totalCount=${c1.totalCount} (>10=${c1TotalOk}); conf-alone total=${confAlone.totalCount}, tut-alone total=${tutAlone.totalCount}` });

  const c2 = await walkPages({ question: 'java', filter: { level0: [confId, tutId] } }, P, { maxPages: 8, needGenres: ['RHEINGOLD', 'TUTORIAL'] });
  const c2BothSurface = ['RHEINGOLD', 'TUTORIAL'].every((g) => c2.unionGenres.includes(g));
  const c2TotalTrue = P.hasTotalCount ? (c2.totalCount != null && c2.totalCount !== confAlone.totalCount && c2.totalCount > 10) : null;
  rec('C2', { status: c2BothSurface ? '✅' : '✖', unionGenres: c2.unionGenres, totalCount: c2.totalCount, pagesWalked: c2.pagesWalked, cappedAt: c2.cappedAt, note: `BUG1 core: union genres across ${c2.pagesWalked} pages = ${JSON.stringify(c2.unionGenres)} (both surface=${c2BothSurface}); totalCount=${c2.totalCount} vs conf-alone=${confAlone.totalCount} (true combined=${c2TotalTrue}); cappedAt=${c2.cappedAt}` });

  const c3 = await walkPages({ question: 'java', filter: { level0: [confId, tutId, artId] } }, P, { maxPages: 8, needGenres: ['RHEINGOLD', 'TUTORIAL'] });
  rec('C3', { status: (['RHEINGOLD', 'TUTORIAL'].every((g) => c3.unionGenres.includes(g))) ? '✅' : '⚠️', unionGenres: c3.unionGenres, totalCount: c3.totalCount, pagesWalked: c3.pagesWalked, note: `Conf+Tut+Article union genres=${JSON.stringify(c3.unionGenres)} over ${c3.pagesWalked} pages; totalCount=${c3.totalCount}` });

  const allIds = [confId, tutId, artId, liveId, campId].filter(Boolean);
  const c4 = await walkPages({ question: 'java', filter: { level0: allIds } }, P, { maxPages: 10 });
  rec('C4', { status: c4.unionGenres.length >= 2 ? '⚠️' : '✖', unionGenres: c4.unionGenres, totalCount: c4.totalCount, pagesWalked: c4.pagesWalked, cappedAt: c4.cappedAt, note: `ALL 5 types: union genres over ${c4.pagesWalked} pages (cap ${c4.cappedAt || 'none'}) = ${JSON.stringify(c4.unionGenres)}; totalCount=${c4.totalCount}` });

  // ---------- D — activity filters [HU] (run, don't judge) ----------
  console.log('\n########## D — Activity filters [HU] (raw output only) ##########');
  const ACT = [['D1', ['Attended']], ['D2', ['Favorited']], ['D3', ['Continue']], ['D4', ['Attended', 'Conference']], ['D5', ['Favorited', 'Tutorial']]];
  for (const [row, names] of ACT) {
    const ids = names.map((n) => id(n)).filter(Boolean);
    const r = await call({ question: 'java', filter: { level0: ids } }, P); await sleep(DELAY);
    rec(row, { status: 'HU', filter: names, ids, totalCount: r.totalCount, resultCount: r.resultCount, genres: genresOf(r), contentTypes: r.contentTypes, parentIds: (r.parentIds || []).length, sampleTitles: (r.results || []).slice(0, 5).map((x) => x.title), gqlErrors: r.gqlErrors, note: `[HU] ${names.join('+')} → results=${r.resultCount}, totalCount=${r.totalCount}, genres=${JSON.stringify(genresOf(r))}, parentIds=${(r.parentIds || []).length}` });
  }

  // ---------- E — Brand ----------
  console.log('\n########## E — Brand (L1) single + combine attempt ##########');
  const brands = l1items.filter((i) => i.type === 'BRAND');
  R.harvest.brands = brands.map((b) => ({ _id: b._id, nameEn: b.nameEn }));
  // E1 each brand: L2 opens, parentIds ⊆ brand
  const e1out = [];
  for (const b of brands) {
    const r = await call({ question: 'java', filter: { level1: [b._id] } }, P); await sleep(DELAY);
    const l2 = findLevel(r, 2); const l2n = (l2?.items || []).length;
    e1out.push({ brand: b.nameEn, l2Items: l2n, parentIds: (r.parentIds || []).length, resultCount: r.resultCount });
  }
  const e1Pass = e1out.every((x) => x.l2Items > 0);
  rec('E1', { status: e1Pass ? '✅' : '⚠️', detail: e1out, note: `each brand opens L2: ${e1out.map((x) => `${x.brand}(L2=${x.l2Items},pid=${x.parentIds})`).join(' · ')}` });

  if (brands.length >= 2) {
    const e2 = await call({ question: 'java', filter: { level1: [brands[0]._id, brands[1]._id] } }, P); await sleep(DELAY);
    const sel = (findLevel(e2, 1)?.items || []).filter((i) => i.isSelected).map((i) => i.nameEn);
    const behavior = e2.gqlErrors ? 'ERROR' : (sel.length === 2 ? 'combine(both isSelected)' : sel.length === 1 ? `first-only(${sel[0]})` : 'neither-echoed(isSelected null)');
    rec('E2', { status: e2.gqlErrors ? '✖' : '✅', selectedBack: sel, resultCount: e2.resultCount, note: `2 ids into canMultiSelect:false L1 → ${behavior}; no crash=${!e2.gqlErrors && !e2.transportError}; results=${e2.resultCount}` });
  } else rec('E2', { status: '⚠️', note: 'fewer than 2 brands to combine' });

  const e3 = await call({ question: 'java', filter: { level0: [confId], level1: [bastaId] } }, P); await sleep(DELAY);
  const e3Genres = genresOf(e3);
  const e3Pass = e3Genres.length === 0 ? 'empty' : e3Genres.every((g) => g === 'RHEINGOLD');
  rec('E3', { status: e3Pass === true ? '✅' : (e3Pass === 'empty' ? '⚠️' : '✖'), genres: e3Genres, parentIds: (e3.parentIds || []).length, resultCount: e3.resultCount, note: `Conference ∧ BASTA! → genres=${JSON.stringify(e3Genres)} (all RHEINGOLD=${e3Pass}); results=${e3.resultCount}, parentIds=${(e3.parentIds || []).length}` });

  // ---------- F — Series (L2) ----------
  console.log('\n########## F — Series (L2) multi-select ##########');
  const brandForSeries = await call({ question: 'java', filter: { level1: [bastaId] } }, P); await sleep(DELAY);
  const seriesItems = (findLevel(brandForSeries, 2)?.items || []);
  R.harvest.bastaSeries = seriesItems.map((s) => ({ _id: s._id, nameEn: s.nameEn, year: s.year }));
  if (seriesItems.length >= 1) {
    const f1 = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id] } }, P); await sleep(DELAY);
    const l3 = findLevel(f1, 3);
    rec('F1', { status: (f1.parentIds && f1.parentIds.length >= 1) || l3 ? '✅' : '⚠️', parentIds: (f1.parentIds || []).length, l3Present: !!l3, note: `series "${seriesItems[0].nameEn}" → parentIds=${(f1.parentIds || []).length}, L3 opens=${!!l3}` });
  } else rec('F1', { status: '⚠️', note: 'no series for BASTA!' });

  if (seriesItems.length >= 2) {
    const one = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id] } }, P); await sleep(DELAY);
    const two = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id, seriesItems[1]._id] } }, P); await sleep(DELAY);
    const grew = (two.parentIds || []).length >= (one.parentIds || []).length;
    rec('F2', { status: grew ? '✅' : '⚠️', onePid: (one.parentIds || []).length, twoPid: (two.parentIds || []).length, note: `1 series pid=${(one.parentIds || []).length} → 2 series pid=${(two.parentIds || []).length} (grew/equal=${grew})` });
    // F3: two different years if available
    const years = [...new Set(seriesItems.map((s) => s.year).filter(Boolean))];
    if (years.length >= 2) {
      const y0 = seriesItems.find((s) => s.year === years[0]); const y1 = seriesItems.find((s) => s.year === years[1]);
      const f3 = await call({ question: 'java', filter: { level1: [bastaId], level2: [y0._id, y1._id] } }, P); await sleep(DELAY);
      rec('F3', { status: '✅', years, parentIds: (f3.parentIds || []).length, yearsFacet: f3.years, note: `cross-year ${years[0]}+${years[1]} → parentIds=${(f3.parentIds || []).length}, years facet=${JSON.stringify(f3.years)}` });
    } else rec('F3', { status: '⚠️', note: `only one year present in series: ${JSON.stringify(years)}` });
  } else { rec('F2', { status: '⚠️', note: 'fewer than 2 series' }); rec('F3', { status: '⚠️', note: 'fewer than 2 series' }); }

  if (seriesItems.length >= 1) {
    const allSeries = seriesItems.map((s) => s._id);
    const f4 = await call({ question: 'java', filter: { level1: [bastaId], level2: allSeries } }, P); await sleep(DELAY);
    const brandLevel = brandForSeries; // parentIds at brand-level
    rec('F4', { status: '✅', allSeriesPid: (f4.parentIds || []).length, brandPid: (brandLevel.parentIds || []).length, note: `all ${allSeries.length} series → parentIds=${(f4.parentIds || []).length} vs brand-level parentIds=${(brandLevel.parentIds || []).length}` });
  } else rec('F4', { status: '⚠️', note: 'no series' });

  // ---------- G — Track (L3) ----------
  console.log('\n########## G — Track (L3) multi-select ##########');
  let trackItems = [];
  if (seriesItems.length >= 1) {
    const withSeries = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id] } }, P); await sleep(DELAY);
    trackItems = (findLevel(withSeries, 3)?.items || []);
    R.harvest.tracks = trackItems.slice(0, 10).map((t) => ({ _id: t._id, nameEn: t.nameEn }));
  }
  if (trackItems.length >= 1) {
    const g1 = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id], level3: [trackItems[0]._id] } }, P); await sleep(DELAY);
    rec('G1', { status: '✅', parentIds: (g1.parentIds || []).length, resultCount: g1.resultCount, note: `1 track "${trackItems[0].nameEn}" → parentIds=${(g1.parentIds || []).length}, results=${g1.resultCount}` });
    if (trackItems.length >= 2) {
      const one = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id], level3: [trackItems[0]._id] } }, P); await sleep(DELAY);
      const two = await call({ question: 'java', filter: { level1: [bastaId], level2: [seriesItems[0]._id], level3: [trackItems[0]._id, trackItems[1]._id] } }, P); await sleep(DELAY);
      const union = (two.parentIds || []).length >= (one.parentIds || []).length;
      rec('G2', { status: union ? '✅' : '⚠️', onePid: (one.parentIds || []).length, twoPid: (two.parentIds || []).length, note: `1 track pid=${(one.parentIds || []).length} → 2 tracks pid=${(two.parentIds || []).length} (union/equal=${union})` });
    } else rec('G2', { status: '⚠️', note: 'fewer than 2 tracks' });
  } else { rec('G1', { status: '⚠️', note: 'no L3 tracks harvested' }); rec('G2', { status: '⚠️', note: 'no L3 tracks harvested' }); }

  // ---------- H — Pagination ----------
  console.log('\n########## H — Pagination ##########');
  const h1 = await call({ question: 'java', page: 1 }, P); await sleep(DELAY);
  const h1Pass = P.hasTotalCount ? (h1.totalCount > 10 && h1.resultCount === 10) : (h1.resultCount === 10);
  rec('H1', { status: h1Pass ? '✅' : '⚠️', totalCount: h1.totalCount, resultCount: h1.resultCount, note: `broad "java" p1: totalCount=${h1.totalCount} (>10), results=${h1.resultCount} (==10)` });

  const h2p1 = await call({ question: 'java', page: 1 }, P); await sleep(DELAY);
  const h2p2 = await call({ question: 'java', page: 2 }, P); await sleep(DELAY);
  const s1 = new Set(idsOf(h2p1)); const overlap = idsOf(h2p2).filter((x) => s1.has(x));
  rec('H2', { status: overlap.length === 0 && h2p2.resultCount > 0 ? '✅' : '✖', p1: idsOf(h2p1).length, p2: idsOf(h2p2).length, overlap: overlap.length, note: `page1 ids=${idsOf(h2p1).length}, page2 ids=${idsOf(h2p2).length}, overlap=${overlap.length} (expect 0)` });

  if (P.hasTotalCount && Number.isInteger(h1.totalCount) && h1.totalCount > 0) {
    const lastPage = Math.ceil(h1.totalCount / 10);
    const expectedLast = h1.totalCount % 10 === 0 ? 10 : h1.totalCount % 10;
    const hl = await call({ question: 'java', page: lastPage }, P); await sleep(DELAY);
    rec('H3', { status: hl.resultCount === expectedLast ? '✅' : '⚠️', lastPage, totalCount: h1.totalCount, expectedLast, actual: hl.resultCount, note: `last page ${lastPage}: expected ${expectedLast}, got ${hl.resultCount}` });
    const beyond = await call({ question: 'java', page: lastPage + 5 }, P); await sleep(DELAY);
    rec('H4', { status: (!beyond.gqlErrors && beyond.resultCount === 0) ? '✅' : '⚠️', page: lastPage + 5, resultCount: beyond.resultCount, totalCount: beyond.totalCount, note: `page ${lastPage + 5} (beyond last): results=${beyond.resultCount} (expect 0), totalCount=${beyond.totalCount}, errors=${beyond.gqlErrors ? 'YES' : 'none'}` });
  } else { rec('H3', { status: '⚠️', note: 'no totalCount → cannot compute last page' }); rec('H4', { status: '⚠️', note: 'no totalCount → cannot compute beyond-last' }); }

  // ---------- I — Documented fields (BUG 2) ----------
  console.log('\n########## I — Documented fields (BUG 2) ##########');
  const iBase = await call({ question: 'java' }, P); await sleep(DELAY);
  const anyItem = (iBase.levels || []).flatMap((l) => l.items || []);
  const nameNulls = P.item.name ? anyItem.filter((i) => i.name == null).length : null;
  const colorPresent = P.item.colorHexCode ? anyItem.filter((i) => i.colorHexCode != null).length : null;
  const isSelPresent = P.item.isSelected ? anyItem.filter((i) => i.isSelected != null).length : null;
  const titleNulls = P.level.title ? (iBase.levels || []).filter((l) => l.title == null).length : null;
  const totalItems = anyItem.length; const totalLevels = (iBase.levels || []).length;
  const i1Fixed = (P.item.name && nameNulls === 0) && (P.item.colorHexCode && colorPresent > 0) && (P.level.title && titleNulls === 0);
  rec('I1', { status: i1Fixed ? '✅' : '✖', detail: { totalItems, nameNulls, colorPresent, isSelNonNull: isSelPresent, titleNulls, totalLevels }, note: `BUG2: name null ${nameNulls}/${totalItems}; colorHexCode present ${colorPresent}/${totalItems}; level title null ${titleNulls}/${totalLevels}; isSelected non-null ${isSelPresent}/${totalItems} → fixed=${i1Fixed}` });

  // I2 select an item → its isSelected true, others false
  if (confId && P.item.isSelected) {
    const i2 = await call({ question: 'java', filter: { level0: [confId] } }, P); await sleep(DELAY);
    const selBack = findItem(i2, 0, 'Conference');
    const l0 = findLevel(i2, 0); const others = (l0?.items || []).filter((i) => i._id !== confId);
    const selTrue = selBack?.isSelected === true; const othersFalse = others.every((i) => i.isSelected === false);
    rec('I2', { status: (selTrue && othersFalse) ? '✅' : '✖', selectedIsSelected: selBack?.isSelected, othersAllFalse: othersFalse, note: `select Conference → its isSelected=${selBack?.isSelected} (expect true); others all false=${othersFalse}` });
  } else rec('I2', { status: '⚠️', note: 'isSelected not in schema or no Conference id' });

  const i3Scores = P.result.score ? scoresOf(iBase) : null;
  const i3NonNull = i3Scores ? i3Scores.filter((s) => s != null).length : null;
  rec('I3', { status: (P.result.score && i3NonNull === (iBase.results || []).length && (iBase.results || []).length > 0) ? '✅' : '✖', scoresNonNull: i3NonNull, resultCount: (iBase.results || []).length, sample: (i3Scores || []).slice(0, 5), note: `results[].score non-null ${i3NonNull}/${(iBase.results || []).length}; sample=${JSON.stringify((i3Scores || []).slice(0, 5))}` });

  // ---------- J — Edges ----------
  console.log('\n########## J — Edge / invalid ##########');
  const j1 = await call({ filter: {} }, P); await sleep(DELAY);
  rec('J1', { status: (!j1.gqlErrors && (j1.levels || []).length > 0) ? '✅' : '✖', note: `empty filter {} + no question → tree builds=${(j1.levels || []).length > 0}, errors=${j1.gqlErrors ? 'YES' : 'none'}` });
  const j2 = await call({ question: 'java', filter: { level0: [] } }, P); await sleep(DELAY);
  rec('J2', { status: (!j2.gqlErrors && (j2.levels || []).length > 0) ? '✅' : '✖', resultCount: j2.resultCount, note: `level0:[] → treated as no selection, results=${j2.resultCount}, errors=${j2.gqlErrors ? 'YES' : 'none'}` });
  const j3 = await call({ question: 'java', filter: { level0: ['NOT_A_REAL_ID_xyz'] } }, P); await sleep(DELAY);
  rec('J3', { status: (!j3.gqlErrors && !j3.transportError) ? '✅' : '✖', resultCount: j3.resultCount, note: `bad id → graceful=${!j3.gqlErrors && !j3.transportError}, results=${j3.resultCount}, errors=${j3.gqlErrors ? JSON.stringify(j3.gqlErrors).slice(0, 100) : 'none'}` });
  const j4a = await call({ question: 'java', page: 0 }, P); await sleep(DELAY);
  const j4b = await call({ question: 'java', page: -1 }, P); await sleep(DELAY);
  const j4c = await call({ question: 'java', page: 999999 }, P); await sleep(DELAY);
  rec('J4', { status: (!j4a.transportError && !j4b.transportError && !j4c.transportError) ? '✅' : '⚠️', note: `page:0 → results=${j4a.resultCount} err=${j4a.gqlErrors ? 'Y' : 'n'}; page:-1 → results=${j4b.resultCount} err=${j4b.gqlErrors ? 'Y' : 'n'}; page:999999 → results=${j4c.resultCount} err=${j4c.gqlErrors ? 'Y' : 'n'}` });

  // ---------- K — Cross-level ----------
  console.log('\n########## K — Cross-level ##########');
  if (seriesItems.length >= 1) {
    const k1 = await call({ question: 'java', filter: { level0: [confId], level1: [bastaId], level2: [seriesItems[0]._id] } }, P); await sleep(DELAY);
    const k1Genres = genresOf(k1);
    rec('K1', { status: (!k1.gqlErrors && (k1.levels || []).length > 0) ? '✅' : '✖', genres: k1Genres, parentIds: (k1.parentIds || []).length, resultCount: k1.resultCount, note: `Conf+BASTA!+series → genres=${JSON.stringify(k1Genres)}, parentIds=${(k1.parentIds || []).length}, tree valid=${(k1.levels || []).length > 0}` });
  } else rec('K1', { status: '⚠️', note: 'no series for K1' });
  const attId = id('Attended');
  const k2 = await call({ question: 'java', filter: { level0: [attId, confId], level1: [bastaId] } }, P); await sleep(DELAY);
  rec('K2', { status: 'HU', totalCount: k2.totalCount, resultCount: k2.resultCount, genres: genresOf(k2), parentIds: (k2.parentIds || []).length, note: `[HU] Attended+Conference+BASTA! → results=${k2.resultCount}, genres=${JSON.stringify(genresOf(k2))}, parentIds=${(k2.parentIds || []).length}` });

  // ---------- SAVE ----------
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-matrix-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(R, null, 2));
  console.log(`\n💾 Saved full matrix report: ${p}`);

  // ---------- ROLL-UP ----------
  console.log('\n================= ROLL-UP =================');
  const ccRows = Object.entries(R.rows).filter(([, v]) => v.status !== 'HU');
  const pass = ccRows.filter(([, v]) => v.status === '✅').length;
  const fail = ccRows.filter(([, v]) => v.status === '✖').length;
  const part = ccRows.filter(([, v]) => v.status === '⚠️').length;
  console.log(`[CC] rows: ${pass} ✅  ${fail} ✖  ${part} ⚠️  (of ${ccRows.length})`);
  console.log(`BUG 1 (C2 both genres surface): ${R.rows.C2.status === '✅' ? 'FIXED ✅' : 'NOT FIXED ✖'}  — ${R.rows.C2.note}`);
  console.log(`BUG 2 (I1 fields populated):    ${R.rows.I1.status === '✅' ? 'FIXED ✅' : 'NOT FIXED ✖'}  — ${R.rows.I1.note}`);
  console.log('\nFAILING [CC] rows:');
  for (const [k, v] of ccRows) if (v.status === '✖') console.log(`  ✖ ${k}: ${v.note}`);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
