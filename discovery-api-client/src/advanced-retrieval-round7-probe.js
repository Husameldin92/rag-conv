/**
 * BACKEND-1602 QA — ROUND 7 probe (read-only, PRODUCTION).
 *
 * Round 6 pinned BUG 1's last head to the WITH-QUESTION (semantic) path:
 *   no-question level-0 multi-select unions correctly (exact-sum totals in all 4 combines),
 *   but WITH a question 3 of 4 combines collapse to a single facet
 *   (Conf+Tut→53=Conf-alone; Tutorial+Attended→25=Attended-alone; all-5→65=Article-alone);
 *   only Favorited+Tutorial unioned. The dev was asked to MIRROR the browse-path union fix onto
 *   the semantic query and has moved the ticket back to To Verify.
 *
 * THE CHECK (Round 7): does the WITH-QUESTION path now UNION?
 *   Re-run each with-question:"java" combine vs its singles, ORDER-INDEPENDENT (both id orders):
 *     Conf+Tut · Tutorial+Attended · all-5 · Favorited+Tutorial (regression guard).
 *   FIXED iff combinedTc > larger single (noise margin) AND both facets' genres surface across pages.
 *
 * NO-REGRESSION: no-Q union must still be EXACT-SUM in all 4 combines; activity-alone still distinct;
 *   L3 track still unions; BUG 2 null fields still fixed; results[].score still null (open Q).
 *   Also re-measure the R6 ~5× no-Q single-total jump (Conf-alone 2920 / Article 2423 / Attended 1275).
 *
 * Verdict method — GENRE + COUNT (robust; result ids are synthetic/session-scoped):
 *   Disjoint genres per facet — Conference→RHEINGOLD, Tutorial→TUTORIAL, Live Event→FSLE, Camp→CAMP,
 *   Article→null; measured Attended→RHEINGOLD / Favorited→FSLE. A facet "appears" iff its genre
 *   surfaces in the combined result. Personal facets (Attended/Favorited) ALSO checked by result-id
 *   membership as corroboration.
 *
 * New file for ROUND 7 — does NOT modify any existing script. Native fetch (node-fetch hangs on v26).
 * access-token header from .env AUTH_TOKEN. Read-only, low + spaced volume.
 * Usage: node src/advanced-retrieval-round7-probe.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 750, TIMEOUT = 30000, NOISE = 5, MAXP = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };

// R6 no-Q single-total baseline (for the ~5× jump re-measure)
const R6_NOQ = { Conference: 2920, Tutorial: 78, Article: 2423, 'Live Event': 152, Camp: 721, Attended: 1275, Favorited: 2, Continue: 10 };
const R6_WITHQ = { Conference: 53, Tutorial: 95, Article: 65, 'Live Event': 70, Camp: 117, Attended: 25, Favorited: 1, Continue: 1 };

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
    ret:__type(name:"RETRIEVAL"){ fields{ name } }
    fin:__type(name:"RetrievalFilterInput"){ inputFields{ name } }
    item:__type(name:"RetrievalFilterLevelItem"){ fields{ name } }
    grp:__type(name:"RetrievalFilterLevelGroup"){ fields{ name } }
    poc:__type(name:"PieceOfContent"){ fields{ name } }
  }`;
  const { json } = await gql(q); const d = json?.data || {};
  const set = (a) => new Set((a || []).map((f) => f.name));
  const ar = (d.q?.fields || []).find((f) => f.name === 'advancedRetrieval');
  const args = (ar?.args || []).map((a) => a.name);
  P.present = !!ar;
  P.args = args;
  P.retFields = [...set(d.ret?.fields)];
  P.filterInputFields = (d.fin?.inputFields || []).map((f) => f.name);
  P.pageArg = args.find((a) => a === 'page') || args.find((a) => a === 'PAGE') || args.find((a) => /page/i.test(a) && !/size/i.test(a)) || null;
  const it = set(d.item?.fields), gr = set(d.grp?.fields), pc = set(d.poc?.fields);
  P.item = { name: it.has('name'), nameEn: it.has('nameEn'), isSelected: it.has('isSelected') };
  P.level = { title: gr.has('title'), canMultiSelect: gr.has('canMultiSelect') };
  P.result = { parentGenre: pc.has('parentGenre'), contentType: pc.has('contentType'), score: pc.has('score'), name: pc.has('name') };
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

const OUT = { capturedAt: new Date().toISOString(), endpoint: ENDPOINT, round: 7, schema: null, harvest: null, singles: {}, combines: {}, regression: {}, totalsJump: {}, calls: 0 };

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token set' : 'NONE'}\n`);
  await introspect(); await sleep(DELAY);
  if (!P.present) { console.log('🛑 advancedRetrieval not present — abort'); process.exit(1); }
  OUT.schema = { args: P.args, pageArg: P.pageArg, retFields: P.retFields, filterInputFields: P.filterInputFields, item: P.item, level: P.level, result: P.result };
  console.log('=== SCHEMA ===');
  console.log('  advancedRetrieval args:', P.args.join(', '));
  console.log('  RETRIEVAL fields:', P.retFields.join(' '));
  console.log('  filter input fields:', P.filterInputFields.join(' '));
  console.log('  PieceOfContent has score?', P.result.score, ' parentGenre?', P.result.parentGenre, '\n');

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
  OUT.harvest = { l0count: l0items.length, l0items, brand: brand?.nameEn || brand?.name, brandId };

  // ---- SINGLES: withQ (fullWalk personal facets for ids), noQ (single call for tc+genre) ----
  console.log('=== SINGLES (withQ "java" | no-Q) ===');
  const fullWalkWithQ = new Set(['Attended', 'Favorited', 'Continue', 'Tutorial']);
  for (const nm of NAMES) {
    for (const mode of ['withQ', 'noQ']) {
      const q = mode === 'withQ' ? { question: 'java' } : {};
      const input = { ...q, filter: { level0: [ID[nm]] } };
      let rec;
      if (mode === 'withQ' && fullWalkWithQ.has(nm)) {
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

  // ---- COMBINE CASES — with-question UNION check, ORDER-INDEPENDENT ----
  const single = (nm, mode) => OUT.singles[`${nm}__${mode}`] || { tc: 0, ids: [] };
  const combineCases = [
    { key: 'Conf+Tut', names: ['Conference', 'Tutorial'], facets: [
        { name: 'Conference', present: (g) => g.has('RHEINGOLD') },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL'), second: true },
      ] },
    { key: 'Tut+Attended', names: ['Tutorial', 'Attended'], facets: [
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
        { name: 'Attended', personal: 'Attended', present: (g) => [...g].some((x) => x !== 'TUTORIAL'), second: true },
      ] },
    { key: 'Fav+Tut', names: ['Favorited', 'Tutorial'], facets: [
        { name: 'Favorited', personal: 'Favorited', present: (g) => [...g].some((x) => x !== 'TUTORIAL'), second: true },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
      ] },
    { key: 'all-5', names: ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp'], facets: [
        { name: 'Conference', present: (g) => g.has('RHEINGOLD') },
        { name: 'Tutorial', present: (g) => g.has('TUTORIAL') },
        { name: 'Live Event', present: (g) => g.has('FSLE') },
        { name: 'Camp', present: (g) => g.has('CAMP') || g.has('FLEX_CAMP') },
        { name: 'Article', present: (g) => g.has('null(Article)'), second: true },
      ] },
  ];
  const idsFor = (names) => names.map((n) => ID[n]);

  console.log('=== COMBINE MATRIX (order-independent) ===');
  for (const c of combineCases) {
    const singleTcsW = c.names.map((nm) => single(nm, 'withQ').tc || 0);
    const singleTcsN = c.names.map((nm) => single(nm, 'noQ').tc || 0);
    const largerW = Math.max(...singleTcsW), sumW = singleTcsW.reduce((a, b) => a + b, 0);
    const largerN = Math.max(...singleTcsN), sumN = singleTcsN.reduce((a, b) => a + b, 0);

    // orderings: forward + reversed (order-independence)
    const orderings = { forward: idsFor(c.names), reversed: idsFor([...c.names].reverse()) };
    const rec = { names: c.names, singleTcsW: Object.fromEntries(c.names.map((n, i) => [n, singleTcsW[i]])), singleTcsN: Object.fromEntries(c.names.map((n, i) => [n, singleTcsN[i]])), largerW, sumW, largerN, sumN, runs: {} };

    for (const [ord, ids] of Object.entries(orderings)) {
      for (const mode of ['withQ', 'noQ']) {
        // for reversed we only need withQ (order-independence check); noQ forward is enough for exact-sum
        if (ord === 'reversed' && mode === 'noQ') continue;
        const q = mode === 'withQ' ? { question: 'java' } : {};
        const stopWhen = ({ genres }) => c.facets.every((f) => f.present(genres));
        const w = await walk({ ...q, filter: { level0: ids } }, { maxPages: MAXP, stopWhen });
        const g = new Set(w.genres);
        const facetStatus = c.facets.map((f) => {
          let appears = f.present(g), idHit = null;
          if (f.personal) { const pids = new Set(single(f.personal, mode).ids || []); idHit = [...pids].filter((id) => w.idSet.has(id)).length; if (idHit > 0) appears = true; }
          return { facet: f.name, second: !!f.second, appears, idHit };
        });
        const presentCount = facetStatus.filter((s) => s.appears).length;
        const larger = mode === 'withQ' ? largerW : largerN;
        const sum = mode === 'withQ' ? sumW : sumN;
        const countUnion = w.tc > larger + NOISE;
        const exactSum = Math.abs(w.tc - sum) <= NOISE;
        let verdict;
        if (mode === 'noQ') {
          verdict = exactSum ? 'UNION ✅ (exact-sum)' : (countUnion ? 'UNION by count ⚠️' : 'BROKEN ✖');
        } else if (c.key === 'all-5') {
          verdict = (presentCount >= 4 && countUnion) ? 'UNION ✅' : (countUnion ? 'UNION by count ⚠️' : 'BROKEN ✖ (collapsed)');
        } else {
          const allAppear = facetStatus.every((s) => s.appears);
          verdict = allAppear && countUnion ? 'UNION ✅' : (allAppear ? 'UNION (genres, count≈single) ⚠️' : (countUnion ? 'UNION by count ⚠️' : 'BROKEN ✖ (collapsed)'));
        }
        rec.runs[`${ord}__${mode}`] = { combinedTc: w.tc, genres: w.genres, facetStatus, presentCount, countUnion, exactSum, verdict, pagesWalked: w.pagesWalked, reachedEnd: w.reachedEnd };
        console.log(`  ${c.key.padEnd(13)} ${ord.padEnd(8)} ${mode.padEnd(6)} tc=${String(w.tc).padStart(6)}  larger=${larger} sum=${sum}`);
        console.log(`  ${''.padEnd(29)} genres=${JSON.stringify(w.genres)}`);
        console.log(`  ${''.padEnd(29)} facets: ${facetStatus.map((s) => `${s.facet}${s.second ? '*' : ''}=${s.appears ? 'YES' : 'no'}${s.idHit != null ? `(id ${s.idHit})` : ''}`).join('  ')}`);
        console.log(`  ${''.padEnd(29)} → ${verdict}  [${w.pagesWalked}p end=${w.reachedEnd}]\n`);
      }
    }
    // order-independence flag (withQ forward vs reversed)
    const fwd = rec.runs['forward__withQ'], rev = rec.runs['reversed__withQ'];
    rec.orderIndependentWithQ = fwd && rev ? (Math.abs(fwd.combinedTc - rev.combinedTc) <= NOISE + 3 && fwd.verdict.startsWith(rev.verdict.slice(0, 5))) : null;
    OUT.combines[c.key] = rec;
  }

  // ---- NO-REGRESSION: activity-alone distinct ----
  console.log('=== NO-REGRESSION ===');
  const A = (nm, m) => single(nm, m);
  const dW = new Set([A('Attended', 'withQ').tc, A('Favorited', 'withQ').tc, A('Continue', 'withQ').tc]);
  const dN = new Set([A('Attended', 'noQ').tc, A('Favorited', 'noQ').tc, A('Continue', 'noQ').tc]);
  OUT.regression.activityDistinct = {
    withQ: { Attended: A('Attended', 'withQ').tc, Favorited: A('Favorited', 'withQ').tc, Continue: A('Continue', 'withQ').tc, distinct: dW.size >= 2 },
    noQ: { Attended: A('Attended', 'noQ').tc, Favorited: A('Favorited', 'noQ').tc, Continue: A('Continue', 'noQ').tc, distinct: dN.size >= 2 },
  };
  console.log(`  activity-alone distinct  withQ A/F/C=${A('Attended', 'withQ').tc}/${A('Favorited', 'withQ').tc}/${A('Continue', 'withQ').tc} (distinct=${dW.size >= 2})  |  noQ=${A('Attended', 'noQ').tc}/${A('Favorited', 'noQ').tc}/${A('Continue', 'noQ').tc} (distinct=${dN.size >= 2})`);

  // ---- NO-REGRESSION: L3 track union ----
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
  OUT.regression.trackUnion = { verdict: trackVerdict, ...trackRec };

  // ---- NO-REGRESSION: BUG 2 null fields + results[].score ----
  // Hand-written query (Conference alone, withQ) requesting name/title/isSelected + score
  const bug2Q = `query { advancedRetrieval(question: "java", filter: { level0: ${JSON.stringify([ID.Conference])} }, ${P.pageArg}: 1) {
    results { _id ${P.result.name ? 'name' : ''} ${P.result.parentGenre ? 'parentGenre' : ''} ${P.result.score ? 'score' : ''} }
    filter { levels { level ${P.level.title ? 'title' : ''} ${P.level.canMultiSelect ? 'canMultiSelect' : ''} items { _id ${P.item.name ? 'name' : ''} ${P.item.nameEn ? 'nameEn' : ''} ${P.item.isSelected ? 'isSelected' : ''} } } }
  } }`;
  CALLS++;
  const { json: b2 } = await gql(bug2Q); await sleep(DELAY);
  const b2d = b2?.data?.advancedRetrieval;
  const b2results = b2d?.results || [];
  const b2levels = b2d?.filter?.levels || [];
  const l0 = b2levels.find((x) => x.level === 0);
  const nameNulls = b2results.filter((r) => r.name == null).length;
  const scoreNulls = P.result.score ? b2results.filter((r) => r.score == null).length : 'n/a';
  const titlePop = b2levels.every((x) => x.title != null && x.title !== '');
  const confItem = (l0?.items || []).find((i) => (i.nameEn || i.name || '').includes('Conference'));
  const isSelReflects = confItem ? confItem.isSelected === true : null;
  OUT.regression.bug2 = {
    resultsChecked: b2results.length, nameNulls, scoreNulls, titlePopulated: titlePop,
    isSelectedReflectsSelection: isSelReflects, gqlErrors: b2?.errors ?? null,
  };
  console.log(`  BUG2 null-fields  results=${b2results.length} name-nulls=${nameNulls} title-populated=${titlePop} isSelected(Conf)=${isSelReflects}  |  score-nulls=${scoreNulls}${P.result.score ? `/${b2results.length}` : ''}`);

  // ---- ~5× no-Q totals jump re-measure ----
  console.log('\n=== ~5× NO-Q TOTALS RE-MEASURE (vs R6) ===');
  for (const nm of NAMES) {
    const now = A(nm, 'noQ').tc, r6 = R6_NOQ[nm];
    const ratio = r6 ? (now / r6) : null;
    OUT.totalsJump[nm] = { noQ_now: now, noQ_R6: r6, ratio: ratio ? +ratio.toFixed(2) : null, withQ_now: A(nm, 'withQ').tc, withQ_R6: R6_WITHQ[nm] };
    console.log(`  ${nm.padEnd(11)} noQ now=${String(now).padStart(6)}  R6=${String(r6).padStart(6)}  ratio=${ratio ? ratio.toFixed(2) + '×' : 'n/a'}   |  withQ now=${A(nm, 'withQ').tc} (R6 ${R6_WITHQ[nm]})`);
  }

  // ---- save ----
  OUT.calls = CALLS;
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-round7-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(OUT, null, 2));
  console.log(`\n💾 Saved: ${p}`);
  console.log(`📞 total live calls: ${CALLS}`);

  console.log('\n=== HEADLINE: does the WITH-QUESTION path now UNION? ===');
  for (const c of combineCases) {
    const rec = OUT.combines[c.key];
    const fwd = rec.runs['forward__withQ'], rev = rec.runs['reversed__withQ'], noq = rec.runs['forward__noQ'];
    console.log(`  ${c.key.padEnd(13)} withQ[fwd]: ${(fwd?.verdict || '?').padEnd(26)} withQ[rev]: ${(rev?.verdict || '?').padEnd(26)} | noQ: ${noq?.verdict || '?'}  (order-indep=${rec.orderIndependentWithQ})`);
  }
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
