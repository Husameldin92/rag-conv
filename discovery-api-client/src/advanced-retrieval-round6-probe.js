/**
 * BACKEND-1602 QA — ROUND 6 probe (read-only, PRODUCTION).
 *
 * Tests the CORRECTED level-0 UNION spec + the with-Q vs no-Q hypothesis.
 *   ① Level 0 is a pure UNION (OR/addition), activities INCLUDED:
 *        Conf+Tut = all conferences ∪ all tutorials · Tut+Attended = all tutorials ∪ all attended
 *        Favorited+Tutorial = my favorites ∪ all tutorials (must CONTAIN the favorited id, the FSLE).
 *   ② Hypothesis (Husam, Insomnia): the union works WITHOUT a question and breaks WITH a question.
 *      TEST it — run every combine BOTH ways (question:"java" and no question).
 *
 * Verdict method — GENRE + COUNT (robust; avoids synthetic/session-scoped result ids):
 *   For THIS user every facet pair has a DISJOINT genre — Conference→RHEINGOLD, Tutorial→TUTORIAL,
 *   Live Event→FSLE, Camp→CAMP, Article→null, and (measured) Attended→RHEINGOLD / Favorited→FSLE.
 *   So a facet "appears" iff its own genre surfaces in the combined result. In a Tutorial+X combine,
 *   TUTORIAL comes only from the Tutorial facet, so ANY non-TUTORIAL genre proves X leaked in.
 *   • bothFacetsAppear = every facet's genre present → UNION ✅
 *   • else if combinedTc > largerSingle + 5 (noise margin) → UNION by count (facet genre not surfaced
 *     within the page cap — likely ranking/ordering) ⚠️
 *   • else → BROKEN ✖ (collapsed to one facet's set)
 *   Result-id membership is ALSO reported as secondary corroboration, not the basis of the verdict.
 *
 * New file for ROUND 6 — does NOT modify any existing script. Native fetch (node-fetch hangs on v26).
 * access-token from .env. Read-only, low + spaced volume. Usage: node src/advanced-retrieval-round6-probe.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 700, TIMEOUT = 30000, NOISE = 5, MAXP = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };

let CALLS = 0;
async function gql(query) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { httpStatus: r.status, json: j };
  } finally { clearTimeout(t); }
}

// ---- schema profile ----
const P = { pageArg: 'PAGE', item: {}, level: {}, result: {} };
async function introspect() {
  const q = `query {
    q:__type(name:"Query"){ fields{ name args{ name } } }
    item:__type(name:"RetrievalFilterLevelItem"){ fields{ name } }
    grp:__type(name:"RetrievalFilterLevelGroup"){ fields{ name } }
    poc:__type(name:"PieceOfContent"){ fields{ name } }
  }`;
  const { json } = await gql(q); const d = json?.data || {};
  const set = (a) => new Set((a || []).map((f) => f.name));
  const ar = (d.q?.fields || []).find((f) => f.name === 'advancedRetrieval');
  const args = (ar?.args || []).map((a) => a.name);
  P.present = !!ar;
  P.pageArg = args.find((a) => a === 'page') || args.find((a) => a === 'PAGE') || args.find((a) => /page/i.test(a) && !/size/i.test(a)) || null;
  const it = set(d.item?.fields), gr = set(d.grp?.fields), pc = set(d.poc?.fields);
  P.item = { name: it.has('name'), nameEn: it.has('nameEn'), isSelected: it.has('isSelected') };
  P.level = { title: gr.has('title'), canMultiSelect: gr.has('canMultiSelect') };
  P.result = { parentGenre: pc.has('parentGenre'), contentType: pc.has('contentType') };
}

function buildQuery({ question, filter, page }) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  if (filter) { const parts = []; for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`); args.push(`filter: { ${parts.join(' ')} }`); }
  if (page !== undefined && P.pageArg) args.push(`${P.pageArg}: ${page}`);
  const itemSel = ['_id']; if (P.item.nameEn) itemSel.push('nameEn'); if (P.item.name) itemSel.push('name'); itemSel.push('type'); if (P.item.isSelected) itemSel.push('isSelected');
  const grpSel = ['level']; if (P.level.title) grpSel.push('title'); if (P.level.canMultiSelect) grpSel.push('canMultiSelect');
  const resSel = ['_id']; if (P.result.parentGenre) resSel.push('parentGenre'); if (P.result.contentType) resSel.push('contentType');
  return `query { advancedRetrieval${args.length ? `(${args.join(', ')})` : ''} { totalCount contentTypes parentIds years results { ${resSel.join(' ')} } filter { levels { ${grpSel.join(' ')} items { ${itemSel.join(' ')} } } } } }`;
}
async function call(input) {
  CALLS++;
  const { json } = await gql(buildQuery(input)); await sleep(DELAY);
  const d = json?.data?.advancedRetrieval ?? null;
  return {
    gqlErrors: json?.errors ?? null,
    totalCount: d?.totalCount ?? null,
    contentTypes: d?.contentTypes ?? null,
    parentIds: (d?.parentIds ?? []).length,
    levels: d?.filter?.levels ?? null,
    results: d?.results ?? [],
    resultCount: Array.isArray(d?.results) ? d.results.length : 0,
  };
}
const level = (r, n) => (r.levels || []).find((x) => x.level === n);
const item = (r, n, nm) => (level(r, n)?.items || []).find((i) => (i.nameEn || '').includes(nm) || (i.name || '').includes(nm));
const normG = (g) => (g === null ? 'null(Article)' : g);
const pageGenres = (r) => [...new Set((r.results || []).map((x) => normG(x.parentGenre)))];

// Page-walk collecting genres + ids; early-stop when stopWhen(state) true.
async function walk(input, { maxPages = MAXP, stopWhen = () => false } = {}) {
  const genres = new Set(), idSet = new Set();
  let page = 1, tc = null, pagesWalked = 0, reachedEnd = false;
  while (page <= maxPages) {
    const r = await call({ ...input, page });
    tc = r.totalCount ?? tc; pagesWalked = page;
    for (const g of pageGenres(r)) genres.add(g);
    for (const x of r.results) idSet.add(x._id);
    if (r.resultCount < 10) { reachedEnd = true; break; }
    if (stopWhen({ tc, genres, idSet })) break;
    if (tc != null && page * 10 >= tc) { reachedEnd = true; break; }
    page++;
  }
  return { tc, genres: [...genres], idSet, pagesWalked, reachedEnd };
}

const OUT = { capturedAt: new Date().toISOString(), endpoint: ENDPOINT, harvest: null, singles: {}, combines: {}, round5fixes: {}, calls: 0 };

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token set' : 'NONE'}\n`);
  await introspect(); await sleep(DELAY);
  if (!P.present) { console.log('🛑 advancedRetrieval not present — abort'); process.exit(1); }

  // ---- harvest ----
  const base = await call({ question: 'java' });
  const NAMES = ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp', 'Attended', 'Favorited', 'Continue'];
  const ID = {};
  for (const nm of NAMES) ID[nm] = (item(base, 0, nm) || {})._id;
  const l0items = (level(base, 0)?.items || []).map((i) => i.nameEn || i.name);
  const brand = (level(base, 1)?.items || []).find((i) => i.type === 'BRAND');
  const brandId = brand?._id;
  console.log('=== HARVEST ===');
  console.log('L0 items (' + l0items.length + '):', l0items.join(' | '));
  console.log('L1 first BRAND:', brand?.nameEn || brand?.name, '\n');
  const missing = NAMES.filter((n) => !ID[n]);
  if (missing.length || !brandId) { console.log('🛑 HARVEST FAILED — missing:', missing.join(','), '| brand:', brandId); process.exit(1); }
  OUT.harvest = { l0count: l0items.length, l0items, brand: brand?.nameEn || brand?.name };

  // ---- SINGLES, both ways ----
  console.log('=== SINGLES (withQ "java" | no-Q) ===');
  const fullWalk = new Set(['Attended', 'Favorited', 'Continue', 'Tutorial']); // small/reference sets → gather ids+genres
  for (const nm of NAMES) {
    for (const mode of ['withQ', 'noQ']) {
      const q = mode === 'withQ' ? { question: 'java' } : {};
      const input = { ...q, filter: { level0: [ID[nm]] } };
      let rec;
      if (fullWalk.has(nm)) {
        const w = await walk(input, { maxPages: 15 });
        rec = { tc: w.tc, genres: w.genres, distinctIds: w.idSet.size, pagesWalked: w.pagesWalked, reachedEnd: w.reachedEnd, ids: [...w.idSet] };
      } else {
        const r = await call(input);
        rec = { tc: r.totalCount, genres: pageGenres(r), contentTypes: r.contentTypes };
      }
      OUT.singles[`${nm}__${mode}`] = rec;
      console.log(`  ${nm.padEnd(11)} ${mode.padEnd(6)} tc=${String(rec.tc).padStart(6)}  genres=${JSON.stringify(rec.genres)}${rec.distinctIds !== undefined ? `  idsSeen=${rec.distinctIds}${rec.reachedEnd ? '' : '(capped)'}` : ''}`);
    }
  }
  console.log('');

  // ---- COMBINE CASES (genre-based verdict) ----
  const single = (nm, mode) => OUT.singles[`${nm}__${mode}`] || { tc: 0, ids: [] };
  const combineCases = [
    { key: 'Conf+Tut', ids: () => [ID.Conference, ID.Tutorial], singles: ['Conference', 'Tutorial'], facets: [
        { name: 'Conference', present: (g) => g.has('RHEINGOLD') },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL'), second: true },
      ] },
    { key: 'Tut+Attended', ids: () => [ID.Tutorial, ID.Attended], singles: ['Tutorial', 'Attended'], facets: [
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
        { name: 'Attended', personal: 'Attended', present: (g) => [...g].some((x) => x !== 'TUTORIAL'), second: true },
      ] },
    { key: 'Fav+Tut', ids: () => [ID.Favorited, ID.Tutorial], singles: ['Favorited', 'Tutorial'], facets: [
        { name: 'Favorited', personal: 'Favorited', present: (g) => [...g].some((x) => x !== 'TUTORIAL'), second: true },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
      ] },
    { key: 'all-5', ids: () => [ID.Conference, ID.Tutorial, ID.Article, ID['Live Event'], ID.Camp], singles: ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp'], facets: [
        { name: 'Conference', present: (g) => g.has('RHEINGOLD') },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
        { name: 'Live Event', present: (g) => g.has('FSLE') },
        { name: 'Camp', present: (g) => g.has('CAMP') || g.has('FLEX_CAMP') },
        { name: 'Article', present: (g) => g.has('null(Article)'), second: true },
      ] },
  ];

  console.log('=== COMBINE MATRIX ===');
  for (const c of combineCases) {
    for (const mode of ['withQ', 'noQ']) {
      const q = mode === 'withQ' ? { question: 'java' } : {};
      const singleTcs = c.singles.map((nm) => single(nm, mode).tc || 0);
      const largerSingle = Math.max(...singleTcs);
      const sumSingles = singleTcs.reduce((a, b) => a + b, 0);
      // stop early once every facet genre has surfaced (union confirmed) — saves paging a working union
      const stopWhen = ({ genres }) => c.facets.every((f) => f.present(genres));
      const w = await walk({ ...q, filter: { level0: c.ids() } }, { maxPages: MAXP, stopWhen });
      const g = new Set(w.genres);
      const facetStatus = c.facets.map((f) => {
        let appears = f.present(g);
        let idHit = null;
        if (f.personal) { const pids = new Set(single(f.personal, mode).ids || []); idHit = [...pids].filter((id) => w.idSet.has(id)).length; if (idHit > 0) appears = true; }
        return { facet: f.name, second: !!f.second, appears, idHit };
      });
      const allAppear = facetStatus.every((s) => s.appears);
      const presentCount = facetStatus.filter((s) => s.appears).length;
      const countUnion = w.tc > largerSingle + NOISE;
      const second = facetStatus.find((s) => s.second);
      let verdict;
      if (c.key === 'all-5') {
        if (presentCount >= 4 && countUnion) verdict = 'UNION ✅';
        else if (countUnion) verdict = 'UNION by count ⚠️';
        else verdict = 'BROKEN ✖ (collapsed)';
      } else {
        if (allAppear) verdict = 'UNION ✅';
        else if (countUnion) verdict = 'UNION by count ⚠️';
        else verdict = 'BROKEN ✖ (collapsed)';
      }
      const rec = { mode, combinedTc: w.tc, singleTcs: Object.fromEntries(c.singles.map((n, i) => [n, singleTcs[i]])), largerSingle, sumSingles, genres: w.genres, facetStatus, presentCount, allAppear, countUnion, secondFacetAppears: second?.appears, verdict, pagesWalked: w.pagesWalked, reachedEnd: w.reachedEnd };
      OUT.combines[`${c.key}__${mode}`] = rec;
      console.log(`  ${c.key.padEnd(13)} ${mode.padEnd(6)} tc=${String(w.tc).padStart(6)}  singles=${JSON.stringify(rec.singleTcs)} larger=${largerSingle}`);
      console.log(`  ${''.padEnd(20)} genres=${JSON.stringify(w.genres)}`);
      console.log(`  ${''.padEnd(20)} facets: ${facetStatus.map((s) => `${s.facet}${s.second ? '*' : ''}=${s.appears ? 'YES' : 'no'}${s.idHit != null ? `(id ${s.idHit})` : ''}`).join('  ')}`);
      console.log(`  ${''.padEnd(20)} countUnion=${countUnion}  →  ${verdict}  [walked ${w.pagesWalked}p end=${w.reachedEnd}]\n`);
    }
  }

  // ---- STEP 2: Round-5 fixes ----
  console.log('=== ROUND-5 FIXES RE-CONFIRM ===');
  const A = (nm, m) => single(nm, m);
  const dW = new Set([A('Attended', 'withQ').tc, A('Favorited', 'withQ').tc, A('Continue', 'withQ').tc]);
  const dN = new Set([A('Attended', 'noQ').tc, A('Favorited', 'noQ').tc, A('Continue', 'noQ').tc]);
  OUT.round5fixes.activityDistinct = {
    withQ: { Attended: A('Attended', 'withQ').tc, Favorited: A('Favorited', 'withQ').tc, Continue: A('Continue', 'withQ').tc, distinct: dW.size >= 2 },
    noQ: { Attended: A('Attended', 'noQ').tc, Favorited: A('Favorited', 'noQ').tc, Continue: A('Continue', 'noQ').tc, distinct: dN.size >= 2 },
  };
  console.log(`  activity-alone distinct  withQ A/F/C=${A('Attended', 'withQ').tc}/${A('Favorited', 'withQ').tc}/${A('Continue', 'withQ').tc} (distinct=${dW.size >= 2})  |  noQ=${A('Attended', 'noQ').tc}/${A('Favorited', 'noQ').tc}/${A('Continue', 'noQ').tc} (distinct=${dN.size >= 2})`);

  // L3 track union
  let trackVerdict = 'skip', trackRec = {};
  const withBrand = await call({ question: 'java', filter: { level1: [brandId] } });
  const series = (level(withBrand, 2)?.items || []);
  let trackSeries = null, tracks = [];
  for (const s of series.slice(0, 6)) {
    const ws = await call({ question: 'java', filter: { level1: [brandId], level2: [s._id] } });
    const tr = level(ws, 3)?.items || [];
    if (tr.length >= 2) { trackSeries = s; tracks = tr; break; }
  }
  if (trackSeries) {
    const nonEmpty = [];
    for (const tr of tracks.slice(0, 8)) {
      const r = await call({ question: 'java', filter: { level1: [brandId], level2: [trackSeries._id], level3: [tr._id] } });
      if ((r.totalCount || 0) > 0) nonEmpty.push({ name: tr.nameEn || tr.name, id: tr._id, tc: r.totalCount });
      if (nonEmpty.length >= 2) break;
    }
    if (nonEmpty.length >= 2) {
      const [a, b] = nonEmpty;
      const both = await call({ question: 'java', filter: { level1: [brandId], level2: [trackSeries._id], level3: [a.id, b.id] } });
      const unions = both.totalCount > Math.max(a.tc, b.tc);
      trackVerdict = unions ? 'UNION ✅' : 'BROKEN ✖';
      trackRec = { series: trackSeries.nameEn || trackSeries.name, trackA: { name: a.name, tc: a.tc }, trackB: { name: b.name, tc: b.tc }, combinedTc: both.totalCount, unions };
      console.log(`  L3 track union  ${a.name}(${a.tc}) + ${b.name}(${b.tc}) → ${both.totalCount}  →  ${trackVerdict}`);
    } else console.log('  L3 track union  — <2 non-empty tracks (skip)');
  } else console.log('  L3 track union  — no series with ≥2 tracks (skip)');
  OUT.round5fixes.trackUnion = { verdict: trackVerdict, ...trackRec };

  // ---- save ----
  OUT.calls = CALLS;
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-round6-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(OUT, null, 2));
  console.log(`\n💾 Saved: ${p}`);
  console.log(`📞 total live calls: ${CALLS}`);

  console.log('\n=== HEADLINE: is the bug question-path-only? ===');
  for (const c of combineCases) {
    const w = OUT.combines[`${c.key}__withQ`], n = OUT.combines[`${c.key}__noQ`];
    console.log(`  ${c.key.padEnd(13)} withQ: ${w.verdict.padEnd(24)} | noQ: ${n.verdict}`);
  }
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
