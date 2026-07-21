/**
 * BACKEND-1602 — `advancedRetrieval` CONTRACT / REGRESSION TEST (read-only, PRODUCTION).
 *
 * Encodes the [CC] assertions from `[C] BACKEND-1602 — Full Filter Matrix.md` as a Node built-in
 * test suite so the fixes can't silently regress. The reopened union bug is encoded as assertions
 * that express the *fixed* (union) expectation, so they are RED while the backend still drops one
 * value and FLIP GREEN once multi-select truly unions:
 *   • BUG 1 — content-type multi-select must UNION. Conf+Tut must return BOTH genres across pages
 *     and a combined totalCount that exceeds the LARGER single type (a union of two disjoint
 *     content types can't be smaller than either alone). Also asserted order-independent, and at
 *     L3 Session/Track (canMultiSelect:true). These express the FIXED behaviour, not the bug.
 * BUG 2 (round-1 headline — `name` / level `title` / `isSelected` / `colorHexCode` null) is FIXED;
 * those are asserted as GREEN guards so a regression is caught.
 * `results[].score` is null here but populated by discovery() — an OPEN QUESTION for the dev, so it
 * is marked `todo` (documents the expectation without red-flagging the suite as a product defect).
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────────────────────────
 *   2026-07-01 (round 1): 23 green · 3 red (BUG-1 union across its facets) · 1 todo (score).
 *   2026-07-02 (round 2 — re-verify after the dev's union fix): UNCHANGED. 23 green · 3 red · 1 todo.
 *     The union reds did NOT flip. Conf+Tut still = Conference-alone (53, both orders); 2 tracks
 *     (4 + 13) still combine to 4. Byte-identical to round 1 ⇒ the union fix did not take effect on
 *     this endpoint (concord/prod) — either not deployed here or ineffective. Kept RED as the
 *     standing contract; they flip green the moment the backend actually unions. L2 Series unions
 *     correctly (green guards below), which is why the L0/L3 failures read as a bug, not a design.
 *   2026-07-02 (round 3 — dev pushed back: "(1) totalCount now stable, (2) it's just ranking"):
 *     • Claim 1 CONFIRMED ✅ — totalCount is now constant across pages (Conf+Tut = 53 on p1..p6).
 *       New green guard `H5` locks this in.
 *     • Claim 2 DISPROVEN ✖ — union STILL broken. Paged the ENTIRE Conf+Tut set (6 pages): 100%
 *       RHEINGOLD, zero TUTORIAL, totalCount 53 < Tutorial-alone (99). A total below one type alone
 *       can't be a union; ranking cannot remove 99 tutorials from the count. Order-independent;
 *       all-5-types → 65 baseline; tracks 4+13 → 4. Union reds stay RED. → 24 green · 4 red · 1 todo.
 *     • The dev ALSO changed L0 labels (nameEn/name now emoji-prefixed) — the harvest is now
 *       substring-based + guarded so that change can't silently fake baseline results again.
 *   2026-07-02 (round 4 — full re-verify as Husam's REAL MLcon user; .env token now that user):
 *     • Context confirmed: L1 = "ML Conference" / "MLcon Magazin" (harvest generalized off the first
 *       BRAND, not BASTA!). Single-type correctness, pagination, null fields, edges all GREEN.
 *     • Union STILL broken under the real user: Conf+Tut=53=Conf-alone (0 tutorials, withQ);
 *       L3 tracks AI Developer Tools(3)+AI Platforms Day(6)→3 (dropped). L2 Series unions (3+1→4).
 *     • NEW decisive: ACTIVITY is DROPPED — Attended = Favorited = Continue = all-content (65/455),
 *       Favorited+Tutorial = Tutorial-alone. Encoded as two RED activity assertions. → 24 green ·
 *       6 red · 1 todo.
 *     • NEW: totalCount INFLATED in no-question mode — Conference-alone tc 536 vs 501 distinct _ids
 *       (dup ids across pages). Clean with a question (53 = 53 distinct). Documented; the suite runs
 *       with a question so its counts are the clean ones.
 *   2026-07-06 (round 5 — dev shipped a SILENT fix on 07-03, no comment; re-ran everything):
 *     • Schema unchanged (question, filter, PAGE, PAGE_SIZE → RETRIEVAL). RETRIEVAL now ALSO exposes
 *       `fallbackResults` — OUT OF SCOPE for 1602 (separate user story); not tested here.
 *     • TWO round-4 reds FLIPPED GREEN — genuine fixes, verified by raw numbers:
 *         – L3 TRACK multi-select now UNIONS: AI Agents(4) + AI Developer Tools(53) → 57 (> larger
 *           alone). Round 4 was 3+6→3 (2nd dropped).
 *         – ACTIVITY-alone now FILTERS: the 3 activities are DISTINCT personal subsets, not one
 *           identical all-content set — Attended 25 / Favorited 1 / Continue 1 withQ (no-Q 24/2/10).
 *           R4 had all three = 65 (withQ) / 455 (no-Q). Added a distinctness guard so the R4
 *           "all identical" regression can't silently return.
 *     • STILL RED (unchanged behaviour) — the bug is now ISOLATED TO LEVEL 0 multi-value combine:
 *         – content-type union: Conf+Tut=53=Conf-alone (0 TUTORIAL across all 6 pages; all-5=65).
 *         – activity × content-type: Favorited+Tutorial ≈ 95 ≈ Tutorial-alone (activity dropped);
 *           Attended+Conference=53=Conf-alone. REWROTE this assertion to bound against Favorited-ALONE
 *           (robust): the old `favTut < Tutorial-alone` FALSE-PASSED in R5 because withQ totalCount is
 *           NONDETERMINISTIC (Tutorial-alone drifts 94–97 call-to-call, so the `<` margin coin-flips).
 *       L2 Series (3+1→4) and L3 Track both union now ⇒ only L0-internal combine is still broken.
 *     • CHANGED: parentIds is now 0 for a TRACK selection (was ≥1 in R4). parentIds only populates for
 *       brand/series (container levels); L0 content-type + L3 track (leaf selections) return 0. The
 *       track FILTER still works (per-track tc narrows, results returned) — G rewritten to assert that
 *       real signal instead of the parentIds facet. parentIds-on-track flagged to the dev.
 *     • NEW observation (flagged, not asserted): L2∧L3 may not intersect — a track can return MORE than
 *       its parent series alone (track 53 vs series "Munich 2026" 6), i.e. the series constraint looks
 *       loosened when a track is added. Needs the dev's intended nesting semantics.
 *     • totalCount inflation (no-Q) IMPROVED but not gone: Conference-alone tc 543 vs 534 distinct
 *       (9 dup ids across pages, was 35 in R4). Documented; suite runs withQ (clean counts).
 *     → after this round's honest suite fixes: 32 tests, 27 green · 4 red · 1 todo (reds = 3
 *       content-type union + 1 activity×type; the R5 G false-red and activity×type false-green fixed).
 *   2026-07-07 (round 6 — dev says "fixed"; re-verified as the real MLcon user + two SPEC changes):
 *     • CORRECTED SPEC: level0 is a PURE UNION (OR/addition), ACTIVITIES INCLUDED — Tutorial+Attended =
 *       all tutorials ∪ all attended (NOT the intersection "my attended tutorials"). The round-4/5
 *       "activity × type INTERSECTS" assertion is REVERSED to a UNION check and moved into the new
 *       LEVEL-0-UNION block: Favorited+Tutorial must CONTAIN the favorited id (FSLE) and be ≥ Tutorial-alone.
 *     • WITH-Q vs NO-Q SPLIT (measured twice, deterministic): the NO-QUESTION (browse) path now UNIONS
 *       PERFECTLY — every combine's totalCount is the EXACT sum of its singles: Conf+Tut 2998=2920+78,
 *       Tutorial+Attended 1353=1275+78, Fav+Tut 80=78+2, all-5 6294=exact sum. This REVERSES round 4
 *       (no-Q Conf+Tut was 537≈536 = broken) ⇒ the deploy FIXED the browse path. The WITH-QUESTION
 *       (semantic) path still COLLAPSES a multi-select to one facet — Conf+Tut→Conf 53, Tut+Attended→
 *       Attended 24-25, all-5→Article 65 — EXCEPT Favorited+Tutorial (95-97 = Tutorial + the 1 favorited
 *       FSLE, id present), the lone with-Q combine that unions. ⇒ the union bug is now ISOLATED TO THE
 *       QUESTION PATH (Husam's hypothesis CONFIRMED).
 *     • NEW LEVEL-0-UNION block: 4 no-Q union GREEN guards + withQ Fav+Tut union GREEN + withQ
 *       Tut+Attended & withQ all-5 union RED (surviving question-path collapse). Removed the old
 *       activity×type-INTERSECT red (spec reversed). The 3 existing withQ content-type union reds stay.
 *     • Round-5 fixes still HOLD: activity-alone distinct (withQ 25/1/1, no-Q 1275/2/10); L3 track
 *       union (AI Agents 4 + AI Dev Tools 53 → 56 > 53). NOTE: no-Q single totals ballooned since R5
 *       (Conference-alone no-Q 543→2920) — the browse retrieval was re-scoped, flagged to the dev.
 *     → 38 tests, 32 green · 5 red · 1 todo (reds = 3 withQ content-type union + withQ Tut+Attended +
 *       withQ all-5 — all the surviving WITH-QUESTION multi-select collapse).
 *   2026-07-08 (round 7 — dev moved it BACK to To Verify, asked to mirror the browse fix onto the
 *     semantic query; re-verified as the real MLcon user, measured twice → deterministic):
 *     • WITH-QUESTION path UNCHANGED — the fix did NOT land on the semantic query. All 3 collapses
 *       persist, order-independent (forward = reversed): Conf+Tut → 52 = Conf-alone (0 TUTORIAL over
 *       6 pages to the end); Tutorial+Attended → 28 with genre tally {RHEINGOLD:27, TUTORIAL:1} = all
 *       27 attended + exactly 1 stray tutorial (a real union carries ~97) ⇒ collapsed to Attended;
 *       all-5 → 65 = Article-alone. Favorited+Tutorial STILL the lone with-Q union (97 = tutorials +
 *       the 1 favorited FSLE, id present). ⇒ ZERO of the 5 with-question reds flipped green. BUG 1's
 *       last head (the semantic path) is NOT fixed.
 *     • NO-REGRESSION all holds: no-Q union still EXACT-SUM in all 4 (Conf+Tut 3034=2956+78,
 *       Tut+Attended 1353=78+1275, Fav+Tut 80=78+2, all-5 6330=exact sum); activity-alone distinct
 *       (withQ 27/1/3, no-Q 1275/2/10); L3 track unions (AI Agents 4 + AI Dev Tools 54 → 56); BUG 2
 *       item name/title/isSelected populate; results[].score still 10/10 null (open Q, todo).
 *     • ~5× no-Q totals (R6 flag): STABLE, not fluctuating — R7 ≈ R6 (Conf-alone no-Q 2956 vs 2920,
 *       ratio ~1.0×). The R5→R6 browse re-scope has held; looks intended, still a dev confirm item.
 *     • SUITE FIX (nondeterminism, honest): rebased the withQ Fav+Tut GREEN guard OFF the fragile
 *       "tc ≥ Tutorial-alone − 3" count bound (it FALSE-FAILED in R7 when Tutorial-alone drifted to 103
 *       while Fav+Tut read 97) ONTO a genre/id-presence union proof (combined set must carry BOTH the
 *       TUTORIAL facet and the favorited item) — immune to the withQ ±6 count swing. Same fix pattern
 *       as R5's activity×type rebase. No product assertion weakened; the union is proven by set content.
 *     → 38 tests, 32 green · 5 red · 1 todo (reds UNCHANGED = 3 withQ content-type union + withQ
 *       Tut+Attended + withQ all-5). None flipped. The with-question collapse is the whole red set.
 *   2026-07-09 (round 8 — dev bounced it back a 2ND time; re-verified as the real MLcon user,
 *     measured 3× → deterministic): ✅ FIXED. The dev FINALLY mirrored the browse-path union onto the
 *     SEMANTIC (with-question) query. All 4 with-question level-0 combines now UNION, order-independent:
 *       Conf+Tut → 149-155 = 52+97 exact sum, both RHEINGOLD+TUTORIAL genres (R7 was 52 = Conf-alone);
 *       Tutorial+Attended → 121-130 = 97+24, both genres, [T,A] & [A,T] both union (R7 was 28 = Att+1);
 *       all-5 → 454-461 ≈ sum, ALL 5 genres present (R7 was 65 = Article-alone);
 *       Favorited+Tutorial → 98-104 = tutorials + the favorited FSLE (already unioned, still does).
 *     ⇒ ALL 5 with-question reds FLIP GREEN. BUG 1 is now FULLY fixed (browse + semantic paths union).
 *     • NO-REGRESSION all holds: no-Q union still EXACT-SUM (Conf+Tut 3042=2964+78, Tut+Attended
 *       1353=78+1275, Fav+Tut 80=78+2, all-5 6351=exact sum); activity-alone distinct (withQ 24/1/3,
 *       no-Q 1275/2/10); L3 track unions (AI Agents 4 + AI Dev Tools → BOTH max 61 > single max 59,
 *       re-measured ×3 — a single probe draw of 57<59 was nondeterminism, NOT a regression); BUG 2
 *       item name/title/isSelected populate; results[].score still 10/10 null (open Q, todo).
 *     • withQ nondeterminism persists (Tutorial-alone 97↔103, Attended 24↔27, Camp 89↔171) — the now-
 *       GREEN union assertions clear it with margin (e.g. Tut+Attended min 121 > Tutorial-alone max 103).
 *     • ~5× no-Q totals: STABLE (R8 ≈ R7, ratio ~1.0×) — the R5→R6 browse re-scope has held.
 *     → 38 tests, 37 green · 0 red · 1 todo. The 5 with-question reds all flipped; only the score
 *       open-question stays `todo`. NOTE: the RED-labelled assertions below now PASS — their titles/
 *       comments are kept but annotated "(GREEN R8)" so history reads straight.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ RUN BY EXPLICIT PATH ONLY — bare `node --test` would also sweep the sibling `*-test.js` probe
 *    scripts (advanced-retrieval-test.js, poc-restriction-test.js, …) and fire them at prod.
 *      node --test src/advanced-retrieval-regression.test.js
 *      npm run test:advanced-retrieval        # wired to the explicit path
 *
 * Native fetch (node-fetch hangs on Node v26). access-token from .env. IDs harvested live by label
 * (substring match — L0 labels carry an emoji prefix as of round 3).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 800, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };

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

// ---- schema profile (detect pagination arg name + totalCount + documented fields) ----
const P = { pageArg: 'PAGE', hasTotalCount: true, item: {}, level: {}, result: {} };
async function introspect() {
  const q = `query {
    q:__type(name:"Query"){ fields{ name args{ name } } }
    ret:__type(name:"RETRIEVAL"){ fields{ name } }
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
  P.hasTotalCount = set(d.ret?.fields).has('totalCount');
  const it = set(d.item?.fields), gr = set(d.grp?.fields), pc = set(d.poc?.fields);
  P.item = { name: it.has('name'), colorHexCode: it.has('colorHexCode'), isSelected: it.has('isSelected'), nameEn: it.has('nameEn') };
  P.level = { title: gr.has('title'), titleEn: gr.has('titleEn'), canMultiSelect: gr.has('canMultiSelect') };
  P.result = { score: pc.has('score'), parentGenre: pc.has('parentGenre'), contentType: pc.has('contentType') };
}

function buildQuery({ question, filter, page }) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  if (filter) { const parts = []; for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`); args.push(`filter: { ${parts.join(' ')} }`); }
  if (page !== undefined && P.pageArg) args.push(`${P.pageArg}: ${page}`);
  const itemSel = ['_id']; if (P.item.nameEn) itemSel.push('nameEn'); if (P.item.name) itemSel.push('name'); itemSel.push('type'); if (P.item.colorHexCode) itemSel.push('colorHexCode'); if (P.item.isSelected) itemSel.push('isSelected');
  const grpSel = ['level']; if (P.level.titleEn) grpSel.push('titleEn'); if (P.level.title) grpSel.push('title'); if (P.level.canMultiSelect) grpSel.push('canMultiSelect');
  const resSel = ['_id']; if (P.result.parentGenre) resSel.push('parentGenre'); if (P.result.contentType) resSel.push('contentType'); if (P.result.score) resSel.push('score');
  const top = ['contentTypes', 'parentIds', 'years']; if (P.hasTotalCount) top.unshift('totalCount');
  return `query { advancedRetrieval${args.length ? `(${args.join(', ')})` : ''} { ${top.join(' ')} results { ${resSel.join(' ')} } filter { levels { ${grpSel.join(' ')} items { ${itemSel.join(' ')} } } } } }`;
}
async function call(input) {
  const { json } = await gql(buildQuery(input)); await sleep(DELAY);
  const d = json?.data?.advancedRetrieval ?? null;
  return { gqlErrors: json?.errors ?? null, totalCount: d?.totalCount ?? null, contentTypes: d?.contentTypes ?? null, parentIds: d?.parentIds ?? null, years: d?.years ?? null, levels: d?.filter?.levels ?? null, results: d?.results ?? null, resultCount: Array.isArray(d?.results) ? d.results.length : null };
}
const level = (r, n) => (r.levels || []).find((x) => x.level === n);
// nameEn now carries an emoji prefix (e.g. "👥 Conference", "▶️ Tutorial", "📄 Article" — the dev added
// localized/emoji labels between round 2 and round 3). Match by SUBSTRING, not exact equality: an exact
// `=== 'Conference'` silently returns undefined → the filter is sent as [null] → every "filtered" call
// collapses to the unfiltered baseline, and green tests (B/I2) flip falsely red. See the harvest guard below.
const item = (r, n, nm) => (level(r, n)?.items || []).find((i) => (i.nameEn || '').includes(nm));
const genres = (r) => [...new Set((r.results || []).map((x) => x.parentGenre))];
const ids = (r) => (r.results || []).map((x) => x._id);
// Page-walk a query, gathering the distinct result-id set + genre set (Round 6 union checks). Used to
// detect whether a 2nd facet's items actually appear in a combined set (id-membership or a genre that
// can only come from that facet), without paging huge no-Q sets to the end.
async function collect(input, maxPages = 14) {
  const idSet = new Set(), gSet = new Set(); let page = 1, tc = null;
  while (page <= maxPages) {
    const r = await call({ ...input, page });
    tc = r.totalCount ?? tc;
    for (const x of (r.results || [])) { idSet.add(x._id); gSet.add(x.parentGenre === null ? 'null' : x.parentGenre); }
    if ((r.resultCount || 0) < 10) break;
    if (tc != null && page * 10 >= tc) break;
    page++;
  }
  return { idSet, gSet, tc };
}

// GENRE key for correctness (Camp emits CAMP or FLEX_CAMP; Article emits null)
const GENRE = { Conference: ['RHEINGOLD'], Tutorial: ['TUTORIAL'], 'Live Event': ['FSLE'], Camp: ['CAMP', 'FLEX_CAMP'] };

// ---- shared harvest ----
// S.brand.BASTA is the first available L1 BRAND — BASTA! under the legacy user, "ML Conference" under the
// MLcon user (round 4). Kept the property name for continuity; it just means "the brand under test".
const S = { base: null, id: {}, brand: {}, series: null, track: null, trackSeries: null };
before(async () => {
  await introspect(); await sleep(DELAY);
  assert.ok(P.present, 'advancedRetrieval must be present on prod');
  assert.ok(P.pageArg, 'a pagination arg (page/PAGE) must exist');
  S.base = await call({ question: 'java' });
  for (const nm of ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp', 'Attended', 'Favorited', 'Continue']) S.id[nm] = (item(S.base, 0, nm) || {})._id;
  const brand = (level(S.base, 1)?.items || []).find((i) => i.type === 'BRAND');
  S.brand.BASTA = brand?._id;
  // Fail LOUDLY at setup if the harvest broke (e.g. L0 labels changed again) — otherwise undefined ids
  // become [null] filters that quietly test the unfiltered baseline and mask real behaviour.
  assert.ok(S.id.Conference && S.id.Tutorial && S.id.Article && S.brand.BASTA,
    `harvest failed — L0/L1 labels may have changed. Got Conference=${S.id.Conference} Tutorial=${S.id.Tutorial} Article=${S.id.Article} brand=${S.brand.BASTA}`);
  const withBrand = await call({ question: 'java', filter: { level1: [S.brand.BASTA] } });
  S.series = (level(withBrand, 2)?.items || []);
  // Find a series that actually exposes L3 tracks. Under the MLcon user the FIRST series ("ML Conference
  // 2026") has none, but a later one ("…Munich 2026") carries 13 tracks — so scan, don't assume series[0].
  for (const s of S.series.slice(0, 6)) {
    const ws = await call({ question: 'java', filter: { level1: [S.brand.BASTA], level2: [s._id] } });
    const tr = level(ws, 3)?.items || [];
    if (tr.length) { S.trackSeries = s._id; S.track = tr; break; }
  }
});

// ============================================================ CONTRACT (green)
describe('schema contract', () => {
  it('level0–level3 filter, PAGE + totalCount are live', () => {
    assert.ok(P.present); assert.ok(P.pageArg, 'pagination arg present');
    assert.ok(P.hasTotalCount, 'totalCount present on RETRIEVAL');
    assert.ok(P.result.parentGenre, 'results.parentGenre present');
  });
  it('baseline tree builds: L0 + L1 present, results ≤ pageSize', () => {
    assert.ok(level(S.base, 0)?.items?.length > 0, 'L0 has items');
    assert.ok(level(S.base, 1)?.items?.length > 0, 'L1 has items');
    assert.ok(S.base.resultCount <= 10, 'page 1 ≤ 10 results');
    if (P.hasTotalCount) assert.ok(Number.isInteger(S.base.totalCount), 'totalCount is an Int');
  });
});

describe('A — question is optional', () => {
  it('question omitted → tree builds, no error', async () => {
    const r = await call({});
    assert.equal(r.gqlErrors, null, 'no GraphQL errors');
    assert.ok((r.levels || []).length > 0, 'filter tree builds without a question');
  });
  it('question "" → tree builds, no error', async () => {
    const r = await call({ question: '' });
    assert.equal(r.gqlErrors, null);
    assert.ok((r.levels || []).length > 0);
  });
  it('brand filter without a question still applies', async () => {
    const r = await call({ filter: { level1: [S.brand.BASTA] } });
    assert.equal(r.gqlErrors, null);
    assert.ok((r.parentIds || []).length > 0, 'brand parentIds returned without a question');
  });
});

describe('B — single content-type returns only that genre', () => {
  for (const nm of ['Conference', 'Tutorial', 'Live Event', 'Camp']) {
    it(`${nm} → only ${GENRE[nm].join('/')}`, async () => {
      const cid = S.id[nm]; assert.ok(cid, `${nm} id harvested`);
      const r = await call({ question: 'java', filter: { level0: [cid] } });
      const g = genres(r);
      assert.ok(g.length > 0, `${nm} returned results`);
      for (const genre of g) assert.ok(GENRE[nm].includes(genre), `unexpected genre ${genre} for ${nm} (expected ${GENRE[nm]})`);
    });
  }
  it('Article → parentGenre null (Husam’s rule: null genre = Article)', async () => {
    const r = await call({ question: 'java', filter: { level0: [S.id.Article] } });
    assert.ok((r.results || []).length > 0, 'Article returned results');
    for (const x of r.results) assert.equal(x.parentGenre, null, 'Article results carry null parentGenre');
    assert.ok((r.contentTypes || []).includes('READ'), 'Article registers as READ in the contentTypes facet');
  });
});

describe('E/F/G/K — brand → series → track hierarchy', () => {
  it('E1 selecting a brand opens the Series (L2) level', async () => {
    const r = await call({ question: 'java', filter: { level1: [S.brand.BASTA] } });
    assert.ok(level(r, 2)?.items?.length > 0, 'L2 Series appears after a brand');
  });
  it('E3 Conference ∧ brand → only RHEINGOLD, scoped to the brand', async () => {
    const r = await call({ question: 'java', filter: { level0: [S.id.Conference], level1: [S.brand.BASTA] } });
    for (const genre of genres(r)) assert.equal(genre, 'RHEINGOLD');
    assert.ok((r.parentIds || []).length > 0, 'brand parentIds present');
  });
  it('F series multi-select combines (2 series ≥ 1 series parentIds)', async (t) => {
    if ((S.series || []).length < 2) return t.skip('need ≥2 series');
    // Pick two series that each carry content (some future-dated series expose 0 parentIds).
    const withPid = [];
    for (const s of S.series.slice(0, 8)) {
      const r = await call({ question: 'java', filter: { level1: [S.brand.BASTA], level2: [s._id] } });
      if ((r.parentIds || []).length > 0) withPid.push({ id: s._id, pid: (r.parentIds || []).length });
      if (withPid.length >= 2) break;
    }
    if (withPid.length < 2) return t.skip('need ≥2 series with content');
    const [a, b] = withPid;
    const two = await call({ question: 'java', filter: { level1: [S.brand.BASTA], level2: [a.id, b.id] } });
    assert.ok((two.parentIds || []).length >= Math.max(a.pid, b.pid), 'combining 2 series does not shrink the set (series unions)');
  });
  it('G selecting a track (L3) is accepted and returns that track’s content', async (t) => {
    if (!S.track || !S.track.length || !S.trackSeries) return t.skip('no L3 tracks');
    // Scan for a NON-EMPTY track — some tracks (e.g. a future-dated "…Day") legitimately hold 0 content,
    // and the first track can be one of them (round 5: tracks[0] "AI Agents" had tc 4, but several had 0).
    const base = { level1: [S.brand.BASTA], level2: [S.trackSeries] };
    let r = null;
    for (const tr of S.track.slice(0, 8)) {
      const x = await call({ question: 'java', filter: { ...base, level3: [tr._id] } });
      if ((x.totalCount || 0) > 0) { r = x; break; }
    }
    if (!r) return t.skip('no non-empty track on this series');
    assert.equal(r.gqlErrors, null);
    // NOTE (R5 2026-07-06): parentIds is now 0 for a track selection — it was ≥1 in R4. parentIds only
    // populates for the CONTAINER levels (brand/series); the LEAF selections (L0 content-type, L3 track)
    // return parentIds:0 (content-type always has). So the real "the track filters" signal is a populated
    // totalCount + a non-empty results page, NOT parentIds. The parentIds-on-track change is an OPEN
    // QUESTION for the dev (see handback), not asserted red here since the track filter itself works.
    assert.ok(r.totalCount > 0, 'track selection yields a totalCount');
    assert.ok(r.resultCount > 0, 'track selection returns results');
  });
  it('K1 cross-level Conf + brand + series stays valid', async (t) => {
    if (!S.series || !S.series[0]) return t.skip('no series');
    const r = await call({ question: 'java', filter: { level0: [S.id.Conference], level1: [S.brand.BASTA], level2: [S.series[0]._id] } });
    assert.equal(r.gqlErrors, null);
    assert.ok((r.levels || []).length > 0, 'tree stays valid');
    for (const genre of genres(r)) assert.equal(genre, 'RHEINGOLD');
  });
});

describe('H — pagination', () => {
  it('H1 broad query: totalCount > 10, page 1 == 10', async () => {
    const r = await call({ question: 'java', page: 1 });
    if (P.hasTotalCount) assert.ok(r.totalCount > 10, 'totalCount reflects the real total');
    assert.equal(r.resultCount, 10, 'page size is 10');
  });
  it('H2 page 1 and page 2 do not overlap', async () => {
    const p1 = await call({ question: 'java', page: 1 });
    const p2 = await call({ question: 'java', page: 2 });
    const s1 = new Set(ids(p1));
    assert.ok(p2.resultCount > 0, 'page 2 has results');
    assert.equal(ids(p2).filter((x) => s1.has(x)).length, 0, 'no id overlap between page 1 and 2');
  });
  it('H4 page beyond the last returns empty, no error', async (t) => {
    if (!P.hasTotalCount) return t.skip('no totalCount to compute last page');
    const r = await call({ question: 'java', page: Math.ceil((S.base.totalCount || 10) / 10) + 5 });
    assert.equal(r.gqlErrors, null);
    assert.equal(r.resultCount, 0, 'beyond-last page is empty');
  });
  // Dev's round-3 fix #1: totalCount must be CONSTANT across pages of the same query (round-2 bug: it
  // drifted 55→50 page-to-page). Asserted on the Conf+Tut query — its total held at 53 on every page.
  it('H5 totalCount is stable across pages for the same query (dev fix, verified 2026-07-02 R3)', async (t) => {
    if (!P.hasTotalCount) return t.skip('no totalCount');
    if (!S.id.Conference || !S.id.Tutorial) return t.skip('content-type ids not harvested');
    const filter = { level0: [S.id.Conference, S.id.Tutorial] };
    const seen = [];
    for (const page of [1, 2, 3]) { const r = await call({ question: 'java', filter, page }); seen.push(r.totalCount); }
    assert.ok(seen.every((tc) => tc === seen[0]),
      `totalCount must be identical on every page of the same query; saw ${JSON.stringify(seen)} (round-2 bug: 55→50)`);
  });
});

describe('J — edges are graceful (no crash)', () => {
  it('J1 empty filter {} + no question', async () => { const r = await call({ filter: {} }); assert.equal(r.gqlErrors, null); assert.ok((r.levels || []).length > 0); });
  it('J2 a level = [] is treated as no selection', async () => { const r = await call({ question: 'java', filter: { level0: [] } }); assert.equal(r.gqlErrors, null); assert.ok(r.resultCount > 0); });
  it('J3 an unknown id is ignored, not an error', async () => { const r = await call({ question: 'java', filter: { level0: ['NOT_A_REAL_ID_xyz'] } }); assert.equal(r.gqlErrors, null); });
});

// ============================================================ BUG 2 — half fixed (green guards)
describe('BUG 2 — documented item/level fields populated (was null; now GREEN — guard against regression)', () => {
  it('item `name` and level `title` are populated (not null)', async () => {
    const r = await call({ question: 'java' });
    const items = (r.levels || []).flatMap((l) => l.items || []);
    if (P.item.name) assert.equal(items.filter((i) => i.name == null).length, 0, 'no item.name is null');
    if (P.level.title) assert.equal((r.levels || []).filter((l) => l.title == null).length, 0, 'no level.title is null');
  });
  it('isSelected reflects the selection (selected=true, others=false)', async (t) => {
    if (!P.item.isSelected) return t.skip('isSelected not in schema');
    const r = await call({ question: 'java', filter: { level0: [S.id.Conference] } });
    const selected = item(r, 0, 'Conference');
    assert.equal(selected?.isSelected, true, 'selected item echoes isSelected:true');
    const others = (level(r, 0)?.items || []).filter((i) => i._id !== S.id.Conference);
    assert.ok(others.every((i) => i.isSelected === false), 'unselected items are isSelected:false');
  });
});

// ============================================================ KNOWN BUGS — RED until backend fix
// OPEN QUESTION (not a bug): results[].score is null on advancedRetrieval under every condition,
// while discovery() populates it (same PieceOfContent type). score was NOT part of round-1 BUG-2
// (that was name/title/isSelected/colorHexCode — all now fixed). advancedRetrieval does perform
// semantic retrieval when given a question, so a relevance score would be reasonable — but whether
// it's meant to populate here is a dev decision. Marked `todo` so it documents the expectation
// without red-flagging the suite as a product defect; flips to a normal pass if the backend adds it.
// Round-2 re-confirm (2026-07-02): still 0/N non-null — unchanged, remains an open question.
describe('OPEN QUESTION — results[].score (todo: dev to confirm if score belongs on this endpoint)', () => {
  it('results[].score is populated (not null)', { todo: 'score is null on advancedRetrieval; discovery() populates it — confirm intended' }, async () => {
    const r = await call({ question: 'java' });
    assert.ok((r.results || []).length > 0, 'have results');
    const nulls = (r.results || []).filter((x) => x.score == null).length;
    assert.equal(nulls, 0, `results[].score is ${nulls}/${r.results.length} null on advancedRetrieval (discovery populates it) — open question`);
  });
});

describe('BUG 1 — content-type multi-select UNION, WITH-QUESTION path (GREEN R8 — semantic path now unions; was RED R2–R7)', () => {
  it('Conf+Tut totalCount exceeds the LARGER single type (a true union can’t be smaller than either alone)', async () => {
    const conf = await call({ question: 'java', filter: { level0: [S.id.Conference] } });
    const tut = await call({ question: 'java', filter: { level0: [S.id.Tutorial] } });
    const both = await call({ question: 'java', filter: { level0: [S.id.Conference, S.id.Tutorial] } });
    const floor = Math.max(conf.totalCount, tut.totalCount);
    // Conf and Tutorial are disjoint content types → a real union must be ≥ each, i.e. strictly
    // larger than the bigger of the two. `> conf-alone` alone was too weak (Conf is the SMALLER
    // set here), so a partial fix that collapsed to Tutorial-alone would have passed it falsely.
    assert.ok(both.totalCount > floor,
      `combined totalCount (${both.totalCount}) must exceed the larger single type (Conf ${conf.totalCount}, Tut ${tut.totalCount} → floor ${floor}); ` +
      `GREEN R8 (149-155 = 52+97 exact-sum union); would fail only if the semantic path regressed to collapse (R2-R7: 52 = Conf-alone)`);
  });
  it('union is order-independent: [Tutorial, Conference] must also union, not collapse to one type', async () => {
    const conf = await call({ question: 'java', filter: { level0: [S.id.Conference] } });
    const tut = await call({ question: 'java', filter: { level0: [S.id.Tutorial] } });
    const swapped = await call({ question: 'java', filter: { level0: [S.id.Tutorial, S.id.Conference] } });
    const floor = Math.max(conf.totalCount, tut.totalCount);
    assert.ok(swapped.totalCount > floor,
      `[Tutorial,Conference] combined totalCount (${swapped.totalCount}) must exceed the larger single type (floor ${floor}); ` +
      `GREEN R8 (both [Conf,Tut] & [Tut,Conf] union, ~149-155); would fail only if order-dependent collapse returned (R2-R7)`);
  });
  // The dev claimed the all-RHEINGOLD result was "just ranking — page further and tutorials show up".
  // Rebuttal encoded here: page the ENTIRE set (up to 20 pages, stopping only at the true last page),
  // not just the first few. TUTORIAL must appear SOMEWHERE across all pages. R3: it never does — 6 pages
  // (tc 53) are all RHEINGOLD. Ranking cannot explain a total (53) smaller than Tutorial-alone (99).
  it('both RHEINGOLD and TUTORIAL surface across ALL pages of Conf+Tut (ranking can\'t hide 99 tutorials)', async () => {
    const filter = { level0: [S.id.Conference, S.id.Tutorial] };
    const union = new Set(); let page = 1, tc = null, pagesWalked = 0;
    while (page <= 20) {
      const r = await call({ question: 'java', filter, page });
      tc = r.totalCount ?? tc; for (const g of genres(r)) union.add(g); pagesWalked = page;
      if ((r.resultCount || 0) < 10) break;
      if (['RHEINGOLD', 'TUTORIAL'].every((g) => union.has(g))) break;
      if (tc != null && page * 10 >= tc) break;
      page++;
    }
    assert.ok(union.has('RHEINGOLD') && union.has('TUTORIAL'),
      `both genres must surface across the whole set (walked ${pagesWalked} page(s), totalCount ${tc}); saw ${JSON.stringify([...union])} — GREEN R8 (both RHEINGOLD+TUTORIAL now surface; R2-R7 TUTORIAL never appeared ⇒ dropped)`);
  });
  // Same union defect verified at L3 (Session/Track), a canMultiSelect:true level. Two non-empty
  // tracks combined must exceed the larger alone; today it collapses to one track's set.
  it('L3 track multi-select unions (2 non-empty tracks > larger alone)', async (t) => {
    if (!S.track || S.track.length < 2 || !S.trackSeries) return t.skip('need ≥2 tracks');
    const base = { level1: [S.brand.BASTA], level2: [S.trackSeries] };
    const nonEmpty = [];
    for (const tr of S.track.slice(0, 6)) {
      const r = await call({ question: 'java', filter: { ...base, level3: [tr._id] } });
      if ((r.totalCount || 0) > 0) nonEmpty.push({ tr, tc: r.totalCount });
      if (nonEmpty.length >= 2) break;
    }
    if (nonEmpty.length < 2) return t.skip('could not find 2 non-empty tracks on this series');
    const [a, b] = nonEmpty;
    const both = await call({ question: 'java', filter: { ...base, level3: [a.tr._id, b.tr._id] } });
    assert.ok(both.totalCount > Math.max(a.tc, b.tc),
      `combined tracks totalCount (${both.totalCount}) must exceed the larger alone (max ${a.tc},${b.tc}); equal ⇒ 2nd track dropped (BUG-1 at L3, currently RED)`);
  });
});

// ============================================================ LEVEL 0 UNION — Round 6 (with-Q vs no-Q)
// Round 6 CORRECTED SPEC: level0 is a PURE UNION (OR/addition), ACTIVITIES INCLUDED — every selected
// item's set is OR'd (Tutorial+Attended = all tutorials ∪ all attended, NOT "my attended tutorials").
// Round 6 finding (real MLcon user, 2026-07-07, measured twice → deterministic):
//   • NO-QUESTION (browse) path UNIONS PERFECTLY — every combine totalCount = the EXACT sum of its
//     singles: Conf+Tut 2998=2920+78 · Tut+Attended 1353=1275+78 · Fav+Tut 80=78+2 · all-5 6294=sum.
//     This REVERSES round 4 (no-Q Conf+Tut 537≈536 = broken) ⇒ the deploy fixed the browse path.
//   • WITH-QUESTION (semantic) path still COLLAPSES a multi-select to one facet — Conf+Tut→Conf 53,
//     Tut+Attended→Attended 24-25, all-5→Article 65 — EXCEPT Favorited+Tutorial, which unions in BOTH
//     modes (withQ 95-97 = Tutorial + the 1 favorited FSLE item, id present). ⇒ the union bug is now
//     ISOLATED TO THE QUESTION PATH (Husam's hypothesis confirmed).
// GREEN = the no-question union fix (guarded) + Fav+Tut union. RED = surviving with-question collapse.
describe('LEVEL 0 UNION — corrected spec (pure UNION, activities included), with-Q vs no-Q (Round 6)', () => {
  // ---- NO-QUESTION (browse) path — FIXED, green guards ----
  it('no-Q: Conf+Tut UNIONS — combined > larger single (browse path fixed; R4 was broken)', async () => {
    const conf = await call({ filter: { level0: [S.id.Conference] } });
    const tut = await call({ filter: { level0: [S.id.Tutorial] } });
    const both = await call({ filter: { level0: [S.id.Conference, S.id.Tutorial] } });
    assert.ok(both.totalCount > Math.max(conf.totalCount, tut.totalCount),
      `no-question Conf+Tut (${both.totalCount}) must exceed the larger single (Conf ${conf.totalCount}, Tut ${tut.totalCount}); ` +
      `R6: 2998 = 2920+78 exact-sum union. R4 was 537≈Conf-alone (broken) ⇒ the deploy fixed the browse path.`);
  });
  it('no-Q: Tutorial+Attended UNIONS — activity+type ADD (corrected spec: NOT the "my attended tutorials" intersection)', async (t) => {
    if (!S.id.Attended) return t.skip('no Attended id');
    const tut = await call({ filter: { level0: [S.id.Tutorial] } });
    const att = await call({ filter: { level0: [S.id.Attended] } });
    const both = await call({ filter: { level0: [S.id.Tutorial, S.id.Attended] } });
    assert.ok(both.totalCount > Math.max(tut.totalCount, att.totalCount),
      `no-question Tutorial+Attended (${both.totalCount}) must exceed the larger single (Tut ${tut.totalCount}, Att ${att.totalCount}) — ` +
      `a UNION of all tutorials ∪ all attended, not an intersection. R6: 1353 = 78+1275 exact sum.`);
  });
  it('no-Q: Favorited+Tutorial UNIONS — contains the favorited item + tc ≥ Tutorial-alone (corrected spec)', async (t) => {
    if (!S.id.Favorited) return t.skip('no Favorited id');
    const favAlone = await call({ filter: { level0: [S.id.Favorited] } });
    const favIds = new Set((favAlone.results || []).map((x) => x._id));
    const tut = await call({ filter: { level0: [S.id.Tutorial] } });
    const both = await collect({ filter: { level0: [S.id.Favorited, S.id.Tutorial] } });
    // Under the UNION spec Fav+Tut = all tutorials ∪ my favorites → must CONTAIN the favorited item
    // (its id, or a genre that can only come from it since Tutorial→TUTORIAL) and be ≥ Tutorial-alone.
    const favPresent = [...favIds].some((id) => both.idSet.has(id)) || [...both.gSet].some((g) => g !== 'TUTORIAL');
    assert.ok(favPresent && both.tc >= tut.totalCount,
      `no-question Favorited+Tutorial (tc ${both.tc}) must be a UNION: contain the favorited item (favPresent=${favPresent}) AND be ≥ Tutorial-alone (${tut.totalCount}). R6: 80 = 78+2, both genres present.`);
  });
  it('no-Q: all-5 content-types UNION — combined exceeds the largest single', async () => {
    const cids = [S.id.Conference, S.id.Tutorial, S.id.Article, S.id['Live Event'], S.id.Camp];
    const singles = [];
    for (const cid of cids) singles.push((await call({ filter: { level0: [cid] } })).totalCount);
    const all = await call({ filter: { level0: cids } });
    assert.ok(all.totalCount > Math.max(...singles),
      `no-question all-5 (${all.totalCount}) must exceed the largest single (${Math.max(...singles)}); R6: 6294 = exact sum of all five.`);
  });

  // ---- WITH-QUESTION (semantic) path — Fav+Tut unions (GREEN); the rest still collapse (RED) ----
  // FLIPPED from the round-4/5 "activity × type INTERSECTS (Fav+Tut ⊆ Favorited)" assertion to the
  // corrected UNION spec. R6: this passes on the question path (97 = 96 tutorials + 1 favorited FSLE,
  // id present) — the lone with-question combine that unions, so it's a green guard, not a red.
  it('withQ: Favorited+Tutorial UNIONS — combined set carries BOTH facets (favorite + tutorials) (corrected spec; GREEN)', async (t) => {
    if (!S.id.Favorited) return t.skip('no Favorited id');
    const favAlone = await call({ question: 'java', filter: { level0: [S.id.Favorited] } });
    const favIds = new Set((favAlone.results || []).map((x) => x._id));
    const both = await collect({ question: 'java', filter: { level0: [S.id.Favorited, S.id.Tutorial] } });
    // Union proof IMMUNE to withQ count nondeterminism (Tutorial-alone drifts 97↔103, so an R6-style
    // "tc ≥ Tutorial-alone − 3" bound FALSE-FAILED in R7 when Fav+Tut read 97 against a 103 Tutorial-alone).
    // Instead assert the combined set carries BOTH facets by CONTENT: the Tutorial facet (genre TUTORIAL)
    // AND the Favorited facet (its result id, or its non-TUTORIAL genre — the favorited item is an FSLE
    // Live Event, so any non-TUTORIAL genre can only come from it). Both present ⇒ real union, not a collapse.
    const tutPresent = both.gSet.has('TUTORIAL');
    const favPresent = [...favIds].some((id) => both.idSet.has(id)) || [...both.gSet].some((g) => g !== 'TUTORIAL');
    assert.ok(tutPresent && favPresent,
      `with-question Favorited+Tutorial must UNION — combined set must carry both the Tutorial facet (tutPresent=${tutPresent}) and the favorited item (favPresent=${favPresent}); tc=${both.tc}, genres=${JSON.stringify([...both.gSet])}. R6/R7: 97 = tutorials + the 1 favorited FSLE ⇒ the lone with-question combine that unions.`);
  });
  it('withQ: Tutorial+Attended UNIONS (GREEN R8 — semantic path now adds the activity + type)', async (t) => {
    if (!S.id.Attended) return t.skip('no Attended id');
    const tut = await call({ question: 'java', filter: { level0: [S.id.Tutorial] } });
    const att = await call({ question: 'java', filter: { level0: [S.id.Attended] } });
    const both = await call({ question: 'java', filter: { level0: [S.id.Tutorial, S.id.Attended] } });
    // GREEN R8: Tutorial ∪ Attended (disjoint — TUTORIAL vs RHEINGOLD) = tut + att. R8 measured 121-130 =
    // 97+24, clears Tutorial-alone (≤103) with ~18 margin, so the withQ ±count drift can't false-fail it.
    assert.ok(both.totalCount > Math.max(tut.totalCount, att.totalCount),
      `with-question Tutorial+Attended (${both.totalCount}) must union > larger single (Tut ${tut.totalCount}, Att ${att.totalCount}); ` +
      `GREEN R8 (121-130 = tutorials ∪ attended); R2-R7 was 24-28 ≈ Attended-alone ⇒ Tutorial dropped.`);
  });
  it('withQ: all-5 content-types UNION (GREEN R8 — semantic path unions all five)', async () => {
    const cids = [S.id.Conference, S.id.Tutorial, S.id.Article, S.id['Live Event'], S.id.Camp];
    const singles = [];
    for (const cid of cids) singles.push((await call({ question: 'java', filter: { level0: [cid] } })).totalCount);
    const all = await call({ question: 'java', filter: { level0: cids } });
    assert.ok(all.totalCount > Math.max(...singles),
      `with-question all-5 (${all.totalCount}) must exceed the largest single (${Math.max(...singles)}); ` +
      `GREEN R8 (454-461 ≈ sum, all 5 genres present); R2-R7 was 65 = Article-alone ⇒ collapsed.`);
  });
});

// ============================================================ ACTIVITY — RED (dropped, round 4)
// Round 4 (real MLcon user) made the activity bug decisive: selecting an activity does NOT constrain to
// the user's own content. Attended / Favorited / Continue all return the SAME result set, and it equals
// the all-content-types set (65 with a question / 455 without) — i.e. "everything", not the user's items.
// A working activity filter is a PERSONAL SUBSET, strictly smaller than all-content. And activity × a
// content-type must INTERSECT (Favorited+Tutorial = the user's favorited tutorials), not return every
// tutorial. Both asserted as the FIXED behaviour → RED while the activity constraint is dropped.
// Round 5 (2026-07-06): activity-ALONE is now FIXED — the 3 activities return distinct personal subsets
// (Attended 25 / Favorited 1 / Continue 1 withQ), no longer one identical all-content set. The two
// activity-alone assertions below are now GREEN guards. Activity × content-type is STILL broken (the
// activity is dropped when combined at L0) — that assertion stays RED, rebased onto a nondeterminism-proof
// bound (see its comment).
describe('ACTIVITY — activity-alone must be a personal subset (FIXED R5/R6; activity×type UNION moved to the LEVEL 0 UNION block per the corrected spec)', () => {
  it('an activity-alone selection is a personal subset (Attended < all-content-types) — GREEN R5', async (t) => {
    if (!S.id.Attended) return t.skip('no Attended id');
    const attended = await call({ question: 'java', filter: { level0: [S.id.Attended] } });
    const allTypes = await call({ question: 'java', filter: { level0: [S.id.Conference, S.id.Tutorial, S.id.Article, S.id['Live Event'], S.id.Camp] } });
    assert.ok(attended.totalCount < allTypes.totalCount,
      `Attended (${attended.totalCount}) must be a personal subset, smaller than all-content-types (${allTypes.totalCount}); ` +
      `equal ⇒ the activity filter returns everything (dropped) — round 4 regression: Attended=Favorited=Continue=all-content`);
  });
  it('the 3 activities return DISTINCT personal sets (R4: all byte-identical = all-content) — GREEN R5', async (t) => {
    if (!S.id.Attended || !S.id.Favorited || !S.id.Continue) return t.skip('activity ids missing');
    const att = await call({ question: 'java', filter: { level0: [S.id.Attended] } });
    const fav = await call({ question: 'java', filter: { level0: [S.id.Favorited] } });
    const con = await call({ question: 'java', filter: { level0: [S.id.Continue] } });
    // R4 bug (dropped): Attended=Favorited=Continue=65 (all-content). R5 fix: 25 / 1 / 1 — distinct.
    const distinct = new Set([att.totalCount, fav.totalCount, con.totalCount]);
    assert.ok(distinct.size >= 2,
      `the activities must return different personal sets; got Attended=${att.totalCount} Favorited=${fav.totalCount} Continue=${con.totalCount} ` +
      `(all equal ⇒ activity dropped, the round-4 regression)`);
  });
  // NOTE (R6): the round-4/5 "activity × content-type INTERSECTS (Favorited+Tutorial ⊆ my Favorited
  // items)" assertion was REVERSED by the corrected spec (level0 is a pure UNION, activities included)
  // and moved to the LEVEL 0 UNION block as a union check (Fav+Tut must CONTAIN the favorited id and
  // exceed Tutorial-alone). It is not re-declared here.
});
