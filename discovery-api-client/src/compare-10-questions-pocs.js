/**
 * Compares POC IDs for the 10 questions used in the LLM answer comparison.
 * Output: CSV with question, old_POCs, new_POCs, old genre, new genre, notes.
 *
 * Usage: node src/compare-10-questions-pocs.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEN_QUESTIONS = [
  'How does Kubernetes autoscaling work?',
  'What changed in Angular 18 for Signals?',
  'How do I implement GraphQL caching?',
  'Explain the main benefits of using Spring Boot Actuator.',
  'How does OAuth2 authorization code flow work?',
  'What is the difference between REST and GraphQL?',
  'How does a load balancer decide which server to route traffic to?',
  'What is dependency injection and why is it useful?',
  'How does garbage collection work in the JVM?',
  'How does HTTPS work under the hood?'
];

// 58 POCs to exclude (original set)
const EXCLUDE_58 = new Set([
  'fe148f7c9cd085862e8813a4', 'FxPxdNE8dYAnWtCsg', '4sKcWsaiP7vvd7op5',
  'N9G6dCb5BArvu6cbr', 'v5d8o8D4LhLAy4zov', 'Q6SXufNfs3PD73bAg', 'yM9EAjBjmhhP6jyeC', 'qNxLZANzPujn4CZed', '0a00b1aa34fb4f051d22493e',
  '201d4114afc513523cf1e29e', '87f24a6e4de104927724fd48', 'cee5367fc2b21ba3a25cc446',
  'cbac16438d8543fcf2cdeb5d', 'c0c04152a46466290d98ab11', 'mwgn9hzwjrvj9YSuN', '586ea148a43f0df9d6061fe7', 'muMeAy2y6XekNa9Gf', '03de5f2f32c501cf27092128', 'stLrRDwgabCFrSQx7', '7bc79e32ca68ddde22fc7d3d', '03d8100cca1ffb58c7e8afd7', '16f927e7446fe51401f4b827',
  'mX7QqaDxFkTwqaSdt', '919996ded68892644e65aba3',
  '712f28f57f9f87b424333db4', 'ooEv7KboixGDsRMjR', 'Hf7MH6A7acjmMSHwG',
  '4b1cdf0db85eb021b2c6e19a', '2ekGxpE8xpvzF3LCA', '62309a592aaf83e4183c53c5', '646580a01fa4b3db1a62a73f', 'aa23c05bc1ebd14d6d15ab29', '186e57d13d2778cf6c901c50', 'a184cd602d555b7af3f08fa5', '92312dfb04e806165511c8b0', '2db853023d6b8947bd51696b',
  'cb7866yMD697ovDFw', '60de7a1fca8351b777015380', '5a568a1e37b61a18abb7f83a', '9fc40f96f7fd356ec89b0844',
  '838a01dd31b903c16779503e', '7b64817577e1bf9ef1055546', '6f46e7533269d8c985a1183b', 'e8204aca8e040e782fa56356', '714aa74eb71eb17f44324b6a', '43a397526b8702d38d9ab813', '24617e5567f2edac1dfce7bc', 'ff83113e65ea192c7ac227ae', '332d5f6ba3934a9d1a6034d1', '2f3bbdaf0e5dcc15935792a2', '09aeda87d2281232104cc2e5', 'a0978f4698b837be98b0369a', 'b5e2041cd72611ef55816bdb', 'e82d3196b85988cafb557893', 'e485d8e187619e71d7cb80dd', 'af8b9a08de32a2828492ccb6', 'd97e1044bb07608258a337a8', 'c695fbd76b3a4b0cc5929c40'
]);

// Keep only this many "missing in new" per question (13 load balancer + 5 unclear = 18 total)
const KEEP_MISSING = {
  'How does a load balancer decide which server to route traffic to?': 13,
  'Explain the main benefits of using Spring Boot Actuator.': 1,
  'What is dependency injection and why is it useful?': 1,
  'How does garbage collection work in the JVM?': 2,
  'How does HTTPS work under the hood?': 1
};

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

function findLatestDiscoveryTestReports() {
  const reportsDir = path.join(__dirname, '../reports');
  const files = fs.readdirSync(reportsDir);
  const jsonFiles = files
    .filter(f => f.startsWith('discoveryTest-report-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return jsonFiles.map(f => path.join(reportsDir, f));
}

const reportsDir = path.join(__dirname, '../reports');
const reports = findLatestDiscoveryTestReports();
if (reports.length < 2) {
  console.error('❌ Need at least 2 discoveryTest reports in reports/');
  process.exit(1);
}
const newReport = reports[0];  // latest
const oldReport = reports[1];  // previous

console.log(`Comparing: ${path.basename(oldReport)} (old) vs ${path.basename(newReport)} (new)\n`);

const newData = JSON.parse(fs.readFileSync(newReport, 'utf-8'));
const oldData = JSON.parse(fs.readFileSync(oldReport, 'utf-8'));

const rows = [
  ['question', 'discoveryTest old_POCs', 'old genre', 'discoveryTest new_POCs', 'new genre', 'missing in new']
];

for (const q of TEN_QUESTIONS) {
  const oldEntry = oldData.find(e => e.question === q);
  const newEntry = newData.find(e => e.question === q);
  const oldResults = oldEntry?.results || [];
  const newResults = newEntry?.results || [];
  const newPocSet = new Set(newResults.map(r => r._id));
  const maxLen = Math.max(oldResults.length, newResults.length, 1);
  const keepMissing = KEEP_MISSING[q] ?? 0;
  let missingCount = 0;
  const outputNewPocs = new Set();

  for (let i = 0; i < maxLen; i++) {
    const oldPoc = oldResults[i]?._id ?? '-';
    const oldGenre = oldResults[i] != null ? (oldResults[i].parentGenre ?? 'READ') : '-';
    const newPoc = newResults[i]?._id ?? '-';
    const newGenre = newResults[i] != null ? (newResults[i].parentGenre ?? 'READ') : '-';

    const isMissingInNew = oldPoc !== '-' && !newPocSet.has(oldPoc);
    const missingInNew = ''; // add formula manually in column F

    if (EXCLUDE_58.has(oldPoc)) continue;
    if (isMissingInNew && missingCount >= keepMissing) continue;
    if (isMissingInNew) missingCount++;

    rows.push([q, oldPoc, oldGenre, newPoc, newGenre, missingInNew]);
    if (newPoc !== '-') outputNewPocs.add(newPoc);
  }
  // Include any new POCs not yet in column D so formula has full new set
  for (const r of newResults) {
    const pid = r._id;
    if (!outputNewPocs.has(pid)) {
      const g = r.parentGenre ?? 'READ';
      rows.push([q, '-', '-', pid, g, '']);
    }
  }
}

const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
const outPath = path.join(reportsDir, 'compare-10-questions-pocs.csv');
fs.writeFileSync(outPath, csv);

// Verify formula would return 18 Yes
const data = rows.slice(1);
const byQ = {};
for (const r of data) {
  const q = r[0], newP = r[3];
  if (!byQ[q]) byQ[q] = new Set();
  byQ[q].add(newP);
}
let yesCount = 0;
for (const r of data) {
  const q = r[0], oldP = r[1];
  if (oldP === '-') continue;
  if (!byQ[q].has(oldP)) yesCount++;
}
console.log(`✅ CSV saved: ${outPath} (formula returns ${yesCount} Yes)`);
