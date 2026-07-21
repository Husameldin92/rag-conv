/**
 * BACKEND-1602 QA — ROUND 8 VERIFY (read-only, PRODUCTION).
 * The R8 probe showed the WITH-QUESTION path now UNIONS in all 4 combines. Two things need a
 * repeated-measurement confirm to separate a real signal from the semantic layer's count drift:
 *   (1) Tut+Attended order-independence — probe read forward 121 vs reversed 130 (both union).
 *   (2) L3 track union — probe read AI Agents(4) + AI Dev Tools(59) → 57 (< 59 = looks BROKEN),
 *       but AI Dev Tools alone drifts (54 in R7, 59 now), so re-measure alone×3 + combined×3.
 * Also re-measures the 4 withQ combines ×3 each for union stability.
 * New file — modifies nothing. Native fetch. access-token from .env. Usage: node src/advanced-retrieval-round8-verify.js
 */
import dotenv from 'dotenv';
dotenv.config();
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 750, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };
let CALLS = 0;
async function gql(query) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
  try { const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {} return { json: j }; }
  finally { clearTimeout(t); }
}
function buildQ({ question, filter, page }) {
  const a = [];
  if (question !== undefined) a.push(`question: ${JSON.stringify(question)}`);
  if (filter) { const parts = []; for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}: ${JSON.stringify(filter[k])}`); a.push(`filter: { ${parts.join(' ')} }`); }
  if (page !== undefined) a.push(`PAGE: ${page}`);
  return `query { advancedRetrieval(${a.join(', ')}) { totalCount results { _id parentGenre } filter { levels { level items { _id nameEn type } } } } }`;
}
async function call({ question, filter, page }) { CALLS++; const { json } = await gql(buildQ({ question, filter, page })); await sleep(DELAY); const d = json?.data?.advancedRetrieval; return { tc: d?.totalCount ?? null, results: d?.results ?? [], levels: d?.filter?.levels ?? [] }; }
const level = (r, n) => (r.levels || []).find((x) => x.level === n);
const normG = (g) => (g === null ? 'null(Article)' : g);
// measure a filter N times → return [tc,...]
async function times(n, input) { const out = []; for (let i = 0; i < n; i++) out.push((await call(input)).tc); return out; }

(async () => {
  console.log(`📡 ${ENDPOINT}\n🔐 ${process.env.AUTH_TOKEN ? 'auth set' : 'NO AUTH'}\n`);
  const base = await call({ question: 'java' });
  const l0 = (level(base, 0)?.items || []);
  const idOf = (nm) => (l0.find((i) => (i.nameEn || '').includes(nm)) || {})._id;
  const ID = { Conference: idOf('Conference'), Tutorial: idOf('Tutorial'), Article: idOf('Article'), 'Live Event': idOf('Live Event'), Camp: idOf('Camp'), Attended: idOf('Attended'), Favorited: idOf('Favorited') };
  const brand = (level(base, 1)?.items || []).find((i) => i.type === 'BRAND');
  console.log('brand:', brand?.nameEn, '| ids ok:', Object.values(ID).every(Boolean), '\n');

  // ---- singles nondeterminism band (×3) ----
  const band = async (nm, ids) => { const t = await times(3, { question: 'java', filter: { level0: ids } }); console.log(`  ${nm.padEnd(12)} withQ ×3 = ${JSON.stringify(t)}`); return t; };
  console.log('SINGLES nondeterminism band (withQ ×3):');
  await band('Conference', [ID.Conference]);
  const tutBand = await band('Tutorial', [ID.Tutorial]);
  const attBand = await band('Attended', [ID.Attended]);
  console.log('');

  // ---- 4 combines ×3 (union stability), Tut+Attended BOTH orders ----
  console.log('COMBINES withQ ×3 (union = tc > larger single & ≈ sum):');
  const show = async (label, ids) => { const t = await times(3, { question: 'java', filter: { level0: ids } }); console.log(`  ${label.padEnd(26)} = ${JSON.stringify(t)}`); return t; };
  await show('Conf+Tut [C,T]', [ID.Conference, ID.Tutorial]);
  const ta1 = await show('Tut+Attended [T,A]', [ID.Tutorial, ID.Attended]);
  const ta2 = await show('Tut+Attended [A,T] (rev)', [ID.Attended, ID.Tutorial]);
  await show('Fav+Tut [F,T]', [ID.Favorited, ID.Tutorial]);
  const all5 = [ID.Conference, ID.Tutorial, ID.Article, ID['Live Event'], ID.Camp];
  await show('all-5 [C,T,Ar,L,Ca]', all5);
  await show('all-5 reversed', [...all5].reverse());
  // order-independence verdict: overlapping ranges ⇒ same population, difference is nondeterminism
  const rng = (a) => [Math.min(...a), Math.max(...a)];
  const [t1lo, t1hi] = rng(ta1), [t2lo, t2hi] = rng(ta2);
  const overlap = t1lo <= t2hi && t2lo <= t1hi;
  console.log(`  → Tut+Attended order test: [T,A]=${JSON.stringify(rng(ta1))} [A,T]=${JSON.stringify(rng(ta2))}  overlap=${overlap}  (both union: min ${Math.min(t1lo, t2lo)} > Tutorial-alone max ${Math.max(...tutBand)}? ${Math.min(t1lo, t2lo) > Math.max(...tutBand)})\n`);

  // ---- L3 track union re-measure (×3 each) ----
  console.log('L3 TRACK union re-measure (×3 each):');
  const withBrand = await call({ question: 'java', filter: { level1: [brand._id] } });
  const series = (level(withBrand, 2)?.items || []);
  let trackSeries = null, tracks = [];
  for (const s of series.slice(0, 6)) {
    const ws = await call({ question: 'java', filter: { level1: [brand._id], level2: [s._id] } });
    const tr = level(ws, 3)?.items || [];
    if (tr.length >= 2) { trackSeries = s; tracks = tr; break; }
  }
  if (!trackSeries) { console.log('  no series with ≥2 tracks (skip)'); }
  else {
    // pick 2 non-empty tracks
    const nonEmpty = [];
    for (const tr of tracks.slice(0, 8)) {
      const r = await call({ question: 'java', filter: { level1: [brand._id], level2: [trackSeries._id], level3: [tr._id] } });
      if ((r.tc || 0) > 0) nonEmpty.push({ name: tr.nameEn, id: tr._id });
      if (nonEmpty.length >= 2) break;
    }
    const [a, b] = nonEmpty;
    const baseF = { question: 'java', filter: { level1: [brand._id], level2: [trackSeries._id] } };
    const aB = await times(3, { ...baseF, filter: { ...baseF.filter, level3: [a.id] } });
    const bB = await times(3, { ...baseF, filter: { ...baseF.filter, level3: [b.id] } });
    const both = await times(3, { ...baseF, filter: { ...baseF.filter, level3: [a.id, b.id] } });
    const largerMax = Math.max(...aB, ...bB), bothMax = Math.max(...both), bothMin = Math.min(...both);
    console.log(`  series: ${trackSeries.nameEn}`);
    console.log(`  ${a.name} ×3 = ${JSON.stringify(aB)}`);
    console.log(`  ${b.name} ×3 = ${JSON.stringify(bB)}`);
    console.log(`  BOTH ×3 = ${JSON.stringify(both)}`);
    // union iff combined can exceed the larger single (accounting for drift: use max-of-both vs max-of-singles)
    const unionByMax = bothMax > largerMax;
    console.log(`  → larger-single max=${largerMax}, both max=${bothMax} min=${bothMin}; union(by max)=${unionByMax}  ${unionByMax ? '✅' : '⚠️ combined never exceeds larger single — inspect'}`);
  }
  console.log(`\n📞 total live calls: ${CALLS}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
