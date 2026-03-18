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

function loadQuestions() {
  const p = path.join(__dirname, '../fixtures/questions.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

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

const questions = loadQuestions();
const newData = JSON.parse(fs.readFileSync(newReport, 'utf-8'));
const oldData = JSON.parse(fs.readFileSync(oldReport, 'utf-8'));

const rows = [
  ['question', 'discoveryTest old_POCs', 'old genre', 'discoveryTest new_POCs', 'new genre', 'notes']
];

for (const q of TEN_QUESTIONS) {
  const idx = questions.indexOf(q);
  if (idx < 0) {
    rows.push([q, '-', '-', '-', '-', 'not in questions']);
    continue;
  }
  const oldResults = oldData[idx]?.results || [];
  const newResults = newData[idx]?.results || [];
  const oldPocSet = new Set(oldResults.map(r => r._id));
  const newPocSet = new Set(newResults.map(r => r._id));
  const maxLen = Math.max(oldResults.length, newResults.length, 1);

  for (let i = 0; i < maxLen; i++) {
    const oldPoc = oldResults[i]?._id ?? '-';
    const oldGenre = oldResults[i] != null ? (oldResults[i].parentGenre ?? 'READ') : '-';
    const newPoc = newResults[i]?._id ?? '-';
    const newGenre = newResults[i] != null ? (newResults[i].parentGenre ?? 'READ') : '-';

    const oldInBoth = oldPoc === '-' || newPocSet.has(oldPoc);
    const newInBoth = newPoc === '-' || oldPocSet.has(newPoc);
    const note = (oldPoc === '-' && newPoc === '-') ? '' : (oldInBoth && newInBoth) ? 'in both' : '';

    rows.push([q, oldPoc, oldGenre, newPoc, newGenre, note]);
  }
}

const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
const outPath = path.join(reportsDir, 'compare-10-questions-pocs.csv');
fs.writeFileSync(outPath, csv);
console.log(`✅ CSV saved: ${outPath}`);
