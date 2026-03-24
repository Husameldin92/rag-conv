// this is for the comparison of the POC IDs for the 10 questions used in the LLM answer comparison
// it will compare the POC IDs for the 10 questions and save the results to a CSV file
// it will save the results to a CSV file with the question, old_POCs, new_POCs, old genre, new genre, notes
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

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

const reportsDir = path.join(__dirname, '../reports');

// Old: 3K report (fixed filename)
const OLD_3K_REPORT = path.join(reportsDir, '3k-discoveryTest-report-2026-03-17T13-15-27.json');

// New: latest discoveryTest report (excluding 3k)
function findLatestDiscoveryTestReport() {
  const files = fs.readdirSync(reportsDir);
  const jsonFiles = files
    .filter(f => f.startsWith('discoveryTest-report-') && !f.startsWith('3k-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return jsonFiles.length > 0 ? path.join(reportsDir, jsonFiles[0]) : null;
}

const newReport = findLatestDiscoveryTestReport();
if (!newReport || !fs.existsSync(OLD_3K_REPORT)) {
  console.error('❌ Need 3k-discoveryTest-report-2026-03-17T13-15-27.json and at least one discoveryTest-report-*.json');
  process.exit(1);
}

console.log(`Comparing: ${path.basename(OLD_3K_REPORT)} (3K old) vs ${path.basename(newReport)} (1.5K new)\n`);

const newData = JSON.parse(fs.readFileSync(newReport, 'utf-8'));
const oldData = JSON.parse(fs.readFileSync(OLD_3K_REPORT, 'utf-8'));

const rows = [
  ['question', 'discoveryTest old_POCs', 'old genre', 'discoveryTest new_POCs', 'new genre', 'new score', 'notes']
];

for (const q of TEN_QUESTIONS) {
  const oldEntry = oldData.find(e => e.question === q);
  const newEntry = newData.find(e => e.question === q);
  const oldResults = oldEntry?.results || [];
  const newResults = newEntry?.results || [];
  const oldPocSet = new Set(oldResults.map(r => r._id));
  const newPocSet = new Set(newResults.map(r => r._id));
  const maxLen = Math.max(oldResults.length, newResults.length, 1);

  for (let i = 0; i < maxLen; i++) {
    const oldPoc = oldResults[i]?._id ?? '-';
    const oldGenre = oldResults[i] != null ? (oldResults[i].parentGenre ?? 'READ') : '-';
    const newPoc = newResults[i]?._id ?? '-';
    const newGenre = newResults[i] != null ? (newResults[i].parentGenre ?? 'READ') : '-';
    const newScore = newResults[i] != null && typeof newResults[i].score === 'number'
      ? newResults[i].score.toFixed(6) : '-';

    let note = '';
    if (oldPoc !== '-' && newPoc !== '-') {
      if (newPocSet.has(oldPoc) && oldPocSet.has(newPoc)) {
        note = 'in both';
      } else if (oldPoc !== '-' && !newPocSet.has(oldPoc)) {
        if (q.includes('load balancer') || newGenre === 'FLEX_CAMP' || newGenre === 'CAMP') {
          note = 'replaced by CAMP/FLEX_CAMP';
        }
      }
    }

    rows.push([q, oldPoc, oldGenre, newPoc, newGenre, newScore, note]);
  }
}

const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(reportsDir, `compare-10-questions-pocs-${timestamp}.csv`);
fs.writeFileSync(outPath, csv);
console.log(`✅ CSV saved: ${outPath}`);

// Vector score range from new run (0.xxx format only; index scores 100+ excluded; 3K has no score)
const vectorScores = [];
for (const entry of newData) {
  for (const r of entry.results || []) {
    if (typeof r.score === 'number' && r.score >= 0 && r.score <= 1) vectorScores.push(r.score);
  }
}
if (vectorScores.length > 0) {
  const min = Math.min(...vectorScores);
  const max = Math.max(...vectorScores);
  console.log(`\n📊 Vector score range (new 1.5K run): min=${min.toFixed(6)}, max=${max.toFixed(6)}, count=${vectorScores.length}`);
} else {
  console.log(`\n⚠️  No vector scores in new run (0.xxx format)`);
}
