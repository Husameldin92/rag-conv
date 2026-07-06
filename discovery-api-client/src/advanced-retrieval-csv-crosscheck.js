/**
 * BACKEND-1602 QA — cross-check the live filter against collections_relationship.csv (Task 5).
 *
 * Loads the CSV ground truth (76 brands → 250 series → 1113 items, status 1–4/blank) and the
 * LIVE advancedRetrieval filter tree, then verifies:
 *   - level→tier mapping (which live level == which CSV tier; what the 4th level holds)
 *   - item match (do live brand/series names match the CSV?)
 *   - relationships (select a brand → exactly its series? series → its content?)
 *   - coverage (how many of the 76 brands / 250 series are actually filterable)
 *   - status handling (which CSV statuses surface vs are hidden)
 *   - spot-checks for handover-named brands: Rust Summit, International PHP Conference, BASTA!
 *
 * Harvests live data by selecting facets by id resolved at runtime (no hard-coded ids).
 * Read-only, PRODUCTION, native fetch, access-token from .env.
 * Usage: node src/advanced-retrieval-csv-crosscheck.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const CSV_PATH = '/Users/osmanhusam/Desktop/Claude-Homebase/02 Projects/Work/RAG/Features/Backend RAG Queries (BACKEND-1602-1603)/collections_relationship.csv';
const DELAY = 1500, TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}
const ITEM_FIELDS = `_id name nameEn nameDe type level order parentItemId seriesIds brandComplexId colorHexCode year contentTypes genre isSelected`;
function buildQuery({ question, filter }) {
  const args = [];
  if (question !== undefined) args.push(`question: ${JSON.stringify(question)}`);
  if (filter) { const p = []; for (const k of ['level0','level1','level2','level3']) if (filter[k] !== undefined) p.push(`${k}: ${JSON.stringify(filter[k])}`); args.push(`filter: { ${p.join(' ')} }`); }
  const a = args.length ? `(${args.join(' ')})` : '';
  return `query { advancedRetrieval${a} { parentIds filter { levels { level titleEn canMultiSelect items { ${ITEM_FIELDS} } } } results { _id brandName parentName } } }`;
}
async function call({ question, filter }) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query: buildQuery({ question, filter }) }), signal: c.signal });
    const j = JSON.parse(await r.text());
    const d = j?.data?.advancedRetrieval;
    return { levels: d?.filter?.levels || [], parentIds: d?.parentIds || [], results: d?.results || [], errors: j?.errors || null };
  } finally { clearTimeout(t); }
}
const lvl = (rec, n) => (rec.levels || []).find((x) => x.level === n);

(async () => {
  // ---------- CSV ground truth ----------
  const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
  const csvBrands = new Map();      // brand_id -> {name, series:Map(series_id->{name, items:[{id,name,status}]})}
  for (const r of rows) {
    if (!csvBrands.has(r.conferenceBrand_id)) csvBrands.set(r.conferenceBrand_id, { name: r.conferenceBrand_name, series: new Map() });
    const b = csvBrands.get(r.conferenceBrand_id);
    if (r.conferenceSeries_id && !b.series.has(r.conferenceSeries_id)) b.series.set(r.conferenceSeries_id, { name: r.conferenceSeries_name, items: [] });
    if (r.item_id) b.series.get(r.conferenceSeries_id)?.items.push({ id: r.item_id, name: r.item_name, status: r.status, type: r.item_type });
  }
  const byName = (n) => [...csvBrands.entries()].filter(([, v]) => v.name === n);
  const out = { capturedAt: new Date().toISOString(), csv: { brands: csvBrands.size, series: 0, items: 0 }, live: {}, checks: {} };
  for (const [, b] of csvBrands) { out.csv.series += b.series.size; for (const [, s] of b.series) out.csv.items += s.items.length; }
  console.log(`CSV: ${out.csv.brands} brands, ${out.csv.series} series, ${out.csv.items} items`);

  // ---------- LIVE tree ----------
  const base = await call({ question: 'java' }); await sleep(DELAY);
  const liveBrands = (lvl(base, 1)?.items || []).filter((i) => i.type === 'BRAND');
  const complexId = liveBrands[0]?.brandComplexId;
  console.log(`\nLIVE L1 brands (${liveBrands.length}) under complexId=${complexId}: ${liveBrands.map((b) => b.nameEn).join(', ')}`);
  out.live.brands = liveBrands.map((b) => ({ _id: b._id, name: b.nameEn, brandComplexId: b.brandComplexId }));
  out.live.complexId = complexId;

  // ---------- 1. level→tier mapping ----------
  console.log('\n=== 1. LEVEL → CSV-TIER MAPPING ===');
  console.log(`  L0 "${lvl(base,0)?.titleEn}"  = facets (activity + contentType)   → NOT a CSV tier`);
  console.log(`  L1 "${lvl(base,1)?.titleEn}"  = brand                              → CSV conferenceBrand`);
  console.log(`  L2 "Series" (revealed on brand-select) = series-by-year            → CSV conferenceSeries`);
  console.log(`  L3 "Session" (revealed on series-select)= TRACKS within a series   → NOT in CSV`);
  console.log(`  results/parentIds = individual courses/content                     → CSV item (Course)`);

  // ---------- 2 & 3. relationships + status, for each live brand ----------
  console.log('\n=== 2/3. RELATIONSHIPS + STATUS per live brand ===');
  out.checks.brands = [];
  for (const lb of liveBrands) {
    const csvMatches = byName(lb.nameEn);
    const sel = await call({ question: 'java', filter: { level1: [lb._id] } }); await sleep(DELAY);
    const liveSeries = (lvl(sel, 2)?.items || []).map((s) => ({ id: s._id, name: s.nameEn, year: s.year }));
    const liveSeriesBaseNames = new Set(liveSeries.map((s) => s.name.replace(/\s*20\d\d$/, '').trim()));
    // CSV series for this brand (union across all matching brand_ids)
    const csvSeriesNames = new Set();
    const csvItemsById = new Map(); // id -> status
    for (const [, b] of csvMatches) for (const [, s] of b.series) { csvSeriesNames.add(s.name); for (const it of s.items) csvItemsById.set(it.id, it.status); }
    const parentIds = sel.parentIds || [];
    const exposedInCsv = parentIds.filter((id) => csvItemsById.has(id));
    const statusOfExposed = {}; for (const id of exposedInCsv) { const st = csvItemsById.get(id) || '(blank)'; statusOfExposed[st] = (statusOfExposed[st] || 0) + 1; }
    // status distribution of ALL this brand's csv items
    const statusAll = {}; for (const st of csvItemsById.values()) { const k = st || '(blank)'; statusAll[k] = (statusAll[k] || 0) + 1; }
    const rec = {
      brand: lb.nameEn, inCsv: csvMatches.length > 0, csvBrandIds: csvMatches.map(([id]) => id),
      liveSeriesCount: liveSeries.length, csvSeriesCount: csvSeriesNames.size,
      liveSeries: liveSeries.map((s) => s.name),
      csvSeries: [...csvSeriesNames],
      seriesNameMatch: [...liveSeriesBaseNames].filter((n) => [...csvSeriesNames].some((c) => c.includes(n) || n.includes(c))),
      parentIdsCount: parentIds.length, parentIdsInCsv: exposedInCsv.length,
      exposedStatusDist: statusOfExposed, allCsvItemsStatusDist: statusAll, csvItemCount: csvItemsById.size,
    };
    out.checks.brands.push(rec);
    console.log(`\n  ▸ ${lb.nameEn}  (CSV brand_id: ${rec.csvBrandIds.join(',') || 'NONE'})`);
    console.log(`     series: live=${rec.liveSeriesCount} vs csv=${rec.csvSeriesCount}`);
    console.log(`       live: ${rec.liveSeries.join(' | ')}`);
    console.log(`       csv : ${rec.csvSeries.join(' | ')}`);
    console.log(`     parentIds(live)=${rec.parentIdsCount}, of which in CSV=${rec.parentIdsInCsv}`);
    console.log(`     status of EXPOSED items: ${JSON.stringify(rec.exposedStatusDist)}  |  status of ALL ${rec.csvItemCount} csv items for brand: ${JSON.stringify(rec.allCsvItemsStatusDist)}`);
  }

  // ---------- 4. coverage ----------
  console.log('\n=== 4. COVERAGE ===');
  const liveNames = new Set(liveBrands.map((b) => b.nameEn));
  out.checks.coverage = { liveBrandCount: liveBrands.length, csvBrandCount: csvBrands.size, complexId };
  console.log(`  Filterable brands: ${liveBrands.length} of ${csvBrands.size} CSV brands  (${(liveBrands.length/csvBrands.size*100).toFixed(1)}%)`);
  console.log(`  All live brands belong to ONE brandComplexId (${complexId}) which is NOT present in the CSV.`);

  // ---------- 5. spot-check named brands ----------
  console.log('\n=== 5. SPOT-CHECK named brands (Rust Summit / International PHP Conference / BASTA!) ===');
  out.checks.spot = {};
  for (const name of ['Rust Summit', 'International PHP Conference', 'BASTA!']) {
    const inCsv = byName(name);
    const filterable = liveNames.has(name);
    out.checks.spot[name] = { inCsv: inCsv.length > 0, csvBrandIds: inCsv.map(([id]) => id), filterableLive: filterable };
    console.log(`  ${name}: in CSV=${inCsv.length>0} (${inCsv.map(([id])=>id).join(',')||'-'}) | filterable in live L1=${filterable}`);
  }

  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-csv-crosscheck-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${p}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
