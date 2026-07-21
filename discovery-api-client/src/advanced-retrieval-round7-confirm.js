/**
 * BACKEND-1602 QA — ROUND 7 CONFIRM (read-only, PRODUCTION).
 * Determinism + exact genre tally for the 4 with-question level-0 combines.
 * Re-measures each combine (forward) and, for Tutorial+Attended, pages the FULL set counting how
 * many items carry each genre — to decide whether the lone TUTORIAL that surfaced is a real union
 * of the 97-tutorial set or a stray leak on top of an Attended-collapse.
 * New file — modifies nothing. Native fetch. access-token from .env. Usage: node src/advanced-retrieval-round7-confirm.js
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
const PAGE = 'PAGE';
function q({ question, ids, page }) {
  const a = [];
  if (question !== undefined) a.push(`question: ${JSON.stringify(question)}`);
  a.push(`filter: { level0: ${JSON.stringify(ids)} }`);
  if (page !== undefined) a.push(`${PAGE}: ${page}`);
  return `query { advancedRetrieval(${a.join(', ')}) { totalCount results { _id parentGenre } filter { levels { level items { _id nameEn } } } } }`;
}
async function call({ question, ids, page }) { CALLS++; const { json } = await gql(q({ question, ids, page })); await sleep(DELAY); const d = json?.data?.advancedRetrieval; return { tc: d?.totalCount ?? null, results: d?.results ?? [], levels: d?.filter?.levels ?? [] }; }
const normG = (g) => (g === null ? 'null(Article)' : g);

(async () => {
  console.log(`📡 ${ENDPOINT}\n🔐 ${process.env.AUTH_TOKEN ? 'auth set' : 'NO AUTH'}\n`);
  // harvest ids
  const base = await call({ question: 'java', ids: [] });
  const l0 = (base.levels.find((x) => x.level === 0)?.items || []);
  const idOf = (nm) => (l0.find((i) => (i.nameEn || '').includes(nm)) || {})._id;
  const ID = { Conference: idOf('Conference'), Tutorial: idOf('Tutorial'), Article: idOf('Article'), 'Live Event': idOf('Live Event'), Camp: idOf('Camp'), Attended: idOf('Attended'), Favorited: idOf('Favorited') };
  console.log('ids:', Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, v ? 'ok' : 'MISSING'])), '\n');

  // singles twice (determinism)
  const twice = async (nm) => { const a = await call({ question: 'java', ids: [ID[nm]] }); const b = await call({ question: 'java', ids: [ID[nm]] }); return [a.tc, b.tc]; };
  const cf = await twice('Conference'), tu = await twice('Tutorial'), at = await twice('Attended');
  console.log(`SINGLES (x2 withQ): Conference=${cf}  Tutorial=${tu}  Attended=${at}\n`);

  // combine determinism (x2 each)
  const combos = [
    { key: 'Conf+Tut', ids: [ID.Conference, ID.Tutorial] },
    { key: 'Tut+Attended', ids: [ID.Tutorial, ID.Attended] },
    { key: 'Fav+Tut', ids: [ID.Favorited, ID.Tutorial] },
    { key: 'all-5', ids: [ID.Conference, ID.Tutorial, ID.Article, ID['Live Event'], ID.Camp] },
  ];
  console.log('COMBINE determinism (withQ, x2):');
  for (const c of combos) { const a = await call({ question: 'java', ids: c.ids }); const b = await call({ question: 'java', ids: c.ids }); console.log(`  ${c.key.padEnd(13)} tc=${a.tc} , ${b.tc}`); }
  console.log('');

  // FULL genre tally for Tut+Attended (page to end)
  console.log('Tut+Attended FULL page-walk — genre tally per item:');
  const tally = {}; const ids = new Set(); let page = 1, tc = null;
  while (page <= 20) {
    const r = await call({ question: 'java', ids: [ID.Tutorial, ID.Attended], page });
    tc = r.tc ?? tc;
    for (const x of r.results) { tally[normG(x.parentGenre)] = (tally[normG(x.parentGenre)] || 0) + 1; ids.add(x._id); }
    if ((r.results?.length || 0) < 10) break;
    if (tc != null && page * 10 >= tc) break;
    page++;
  }
  console.log(`  totalCount=${tc}  distinct ids paged=${ids.size}  genre tally=${JSON.stringify(tally)}`);
  const attSet = await (async () => { const s = new Set(); for (let p = 1; p <= 5; p++) { const r = await call({ question: 'java', ids: [ID.Attended], page: p }); for (const x of r.results) s.add(x._id); if ((r.results?.length || 0) < 10) break; } return s; })();
  const attInCombine = [...attSet].filter((id) => ids.has(id)).length;
  const tutCount = tally['TUTORIAL'] || 0;
  console.log(`  Attended-alone ids=${attSet.size}; of those present in combine=${attInCombine}; TUTORIAL items in combine=${tutCount}`);
  console.log(`  → interpretation: combine ⊇ Attended(${attInCombine}) + ${tutCount} tutorial(s). A real union would carry ~${tu[0]} tutorials.`);
  console.log(`\n📞 total live calls: ${CALLS}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
