/**
 * BACKEND-1602 ROUND 6 — determinism CONFIRM pass (read-only, PROD).
 * Independently re-measures the singles + combine totalCounts a SECOND time and checks the
 * exact-sum union relation, to prove the round-6 verdicts aren't a nondeterministic fluke
 * (withQ totalCount is known to drift ±3). Page-1 totalCount only — lean call budget.
 * New file; modifies nothing. Usage: node src/advanced-retrieval-round6-confirm.js
 */
import dotenv from 'dotenv';
dotenv.config();
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY = 700, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => { const h = { 'Content-Type': 'application/json' }; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN; return h; };
async function gql(query) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
  try { const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {} return j; }
  finally { clearTimeout(t); }
}
const P = {};
async function introspect() {
  const j = await gql(`query{ q:__type(name:"Query"){fields{name args{name}}} }`);
  const ar = (j?.data?.q?.fields || []).find((f) => f.name === 'advancedRetrieval');
  const args = (ar?.args || []).map((a) => a.name);
  P.pageArg = args.find((a) => a === 'page') || args.find((a) => a === 'PAGE') || 'PAGE';
}
function build({ question, filter }) {
  const a = [];
  if (question !== undefined) a.push(`question:${JSON.stringify(question)}`);
  if (filter) { const parts = []; for (const k of ['level0', 'level1', 'level2', 'level3']) if (filter[k] !== undefined) parts.push(`${k}:${JSON.stringify(filter[k])}`); a.push(`filter:{${parts.join(' ')}}`); }
  return `query{ advancedRetrieval${a.length ? `(${a.join(',')})` : ''}{ totalCount results{ _id parentGenre } filter{ levels{ level items{ _id nameEn type } } } } }`;
}
async function tc(input) { const j = await gql(build(input)); await sleep(DELAY); const d = j?.data?.advancedRetrieval; return { tc: d?.totalCount ?? null, genres: [...new Set((d?.results || []).map((x) => x.parentGenre === null ? 'null' : x.parentGenre))], levels: d?.filter?.levels }; }

(async () => {
  await introspect(); await sleep(DELAY);
  const base = await tc({ question: 'java' });
  const L0 = (base.levels || []).find((l) => l.level === 0)?.items || [];
  const id = (nm) => (L0.find((i) => (i.nameEn || '').includes(nm)) || {})._id;
  const ID = {}; for (const nm of ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp', 'Attended', 'Favorited']) ID[nm] = id(nm);

  const S = {};
  for (const mode of ['withQ', 'noQ']) {
    const q = mode === 'withQ' ? { question: 'java' } : {};
    for (const nm of ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp', 'Attended', 'Favorited']) {
      const r = await tc({ ...q, filter: { level0: [ID[nm]] } });
      S[`${nm}__${mode}`] = r.tc;
    }
  }
  const combos = [
    ['Conf+Tut', ['Conference', 'Tutorial']],
    ['Tut+Attended', ['Tutorial', 'Attended']],
    ['Fav+Tut', ['Favorited', 'Tutorial']],
    ['all-5', ['Conference', 'Tutorial', 'Article', 'Live Event', 'Camp']],
  ];
  console.log('=== CONFIRM PASS (2nd measurement) ===');
  for (const mode of ['withQ', 'noQ']) {
    const q = mode === 'withQ' ? { question: 'java' } : {};
    console.log(`\n-- ${mode} --`);
    for (const [name, parts] of combos) {
      const r = await tc({ ...q, filter: { level0: parts.map((p) => ID[p]) } });
      const singles = parts.map((p) => S[`${p}__${mode}`]);
      const sum = singles.reduce((a, b) => a + b, 0);
      const larger = Math.max(...singles);
      const isSum = r.tc === sum;
      const relation = isSum ? 'EXACT SUM (union ✅)' : r.tc > larger + 5 ? `> larger (${larger}) but ≠ sum(${sum})` : `≈ one single → collapsed (broken ✖)`;
      console.log(`  ${name.padEnd(13)} combined=${String(r.tc).padStart(6)}  singles=[${singles.join(',')}] sum=${sum} larger=${larger}  genres=${JSON.stringify(r.genres)}  → ${relation}`);
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
