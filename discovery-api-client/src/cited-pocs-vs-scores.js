// Cross-reference LLM cited POCs with discoveryTest scores
// Answers: "Was that chunk actually useful? Did the citation make sense?"
// Input: quick-test-answers CSV (DiscoveryTest Answer) + discoveryTest report JSON

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const reportsDir = path.join(__dirname, '../reports');

// Extract cited POC IDs from LLM answer (markdown citation format: ](POC_ID){)
function extractCitedPocs(answerText) {
  if (!answerText || typeof answerText !== 'string') return [];
  const re = /\]\(([a-zA-Z0-9]{16,24})\)\{/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(answerText)) !== null) ids.add(m[1]);
  return [...ids];
}

// Parse CSV with quoted fields (handles embedded commas and newlines)
function parseCsvRow(str, startIdx) {
  const fields = [];
  let i = startIdx;
  while (i < str.length) {
    if (str[i] === '"') {
      let field = '';
      i++;
      while (i < str.length) {
        if (str[i] === '"' && str[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (str[i] === '"') {
          i++;
          break;
        } else {
          field += str[i];
          i++;
        }
      }
      fields.push(field);
      if (str[i] === ',') i++;
    } else {
      let field = '';
      while (i < str.length && str[i] !== ',') {
        field += str[i];
        i++;
      }
      fields.push(field);
      if (str[i] === ',') i++;
    }
  }
  return fields;
}

function findLatestDiscoveryTestReport() {
  const files = fs.readdirSync(reportsDir);
  const jsonFiles = files
    .filter(f => f.startsWith('discoveryTest-report-') && !f.startsWith('3k-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return jsonFiles.length > 0 ? path.join(reportsDir, jsonFiles[0]) : null;
}

function findLatestQuickTestAnswers() {
  const files = fs.readdirSync(reportsDir);
  const csvFiles = files
    .filter(f => f.startsWith('quick-test-answers-') && f.endsWith('.csv'))
    .sort()
    .reverse();
  return csvFiles.length > 0 ? path.join(reportsDir, csvFiles[0]) : null;
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const quickTestPath = process.argv[2] || findLatestQuickTestAnswers();
  const discoveryTestPath = process.argv[3] || findLatestDiscoveryTestReport();

  if (!quickTestPath || !fs.existsSync(quickTestPath)) {
    console.error('❌ No quick-test-answers CSV found. Run: npm run quick-test');
    process.exit(1);
  }
  if (!discoveryTestPath || !fs.existsSync(discoveryTestPath)) {
    console.error('❌ No discoveryTest report JSON found. Run: npm run discoveryTest');
    process.exit(1);
  }

  console.log(`\n📋 Cited POCs vs discoveryTest scores`);
  console.log(`   LLM answers: ${path.basename(quickTestPath)}`);
  console.log(`   discoveryTest: ${path.basename(discoveryTestPath)}\n`);

  const csvContent = fs.readFileSync(quickTestPath, 'utf-8');
  const discoveryData = JSON.parse(fs.readFileSync(discoveryTestPath, 'utf-8'));

  // Parse CSV: skip header, get first row (question, discovery answer, discoveryTest answer)
  const headerEnd = csvContent.indexOf('\n');
  const dataStart = headerEnd + 1;
  const fields = parseCsvRow(csvContent, dataStart);

  const question = fields[0]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
  const discoveryTestAnswer = fields[2]?.replace(/""/g, '"') || '';

  const citedPocs = extractCitedPocs(discoveryTestAnswer);
  if (citedPocs.length === 0) {
    console.log('⚠️  No citations found in DiscoveryTest Answer');
    process.exit(0);
  }

  // Build lookup: question -> { _id -> { score, title, parentName } }
  const questionToResults = new Map();
  for (const entry of discoveryData) {
    const q = entry.question;
    const map = new Map();
    for (const r of entry.results || []) {
      map.set(r._id, { score: r.score, title: r.title, parentName: r.parentName });
    }
    questionToResults.set(q, map);
  }

  // Find matching question (exact or partial)
  let resultsMap = questionToResults.get(question);
  if (!resultsMap) {
    const partial = [...questionToResults.keys()].find(k => question.includes(k) || k.includes(question));
    resultsMap = partial ? questionToResults.get(partial) : null;
  }
  if (!resultsMap) {
    console.log(`⚠️  Question "${question.slice(0, 50)}..." not found in discoveryTest report`);
    process.exit(0);
  }

  const rows = [
    ['question', 'cited_POC', 'score', 'is_vector', 'title', 'parentName', 'low_vector_note']
  ];

  const LOW_VECTOR_THRESHOLD = 0.7;

  for (const pocId of citedPocs) {
    const info = resultsMap.get(pocId);
    const score = info?.score;
    const isVector = typeof score === 'number' && score >= 0 && score <= 1;
    const lowNote = isVector && score < LOW_VECTOR_THRESHOLD ? `vector < ${LOW_VECTOR_THRESHOLD}` : '';

    rows.push([
      question.slice(0, 80),
      pocId,
      typeof score === 'number' ? score.toFixed(6) : '-',
      isVector ? 'yes' : 'no',
      info?.title ?? '-',
      info?.parentName ?? '-',
      lowNote
    ]);
  }

  const outCsv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `cited-pocs-vs-scores-${timestamp}.csv`);
  fs.writeFileSync(outPath, outCsv);

  console.log(`✅ Saved: ${outPath}\n`);

  const lowVectorCount = rows.slice(1).filter(r => r[6]).length;
  if (lowVectorCount > 0) {
    console.log(`📊 ${lowVectorCount} cited POC(s) have vector score < ${LOW_VECTOR_THRESHOLD}`);
    console.log(`   Review these in the CSV: did the citation make sense?\n`);
  }
}

main().catch(console.error);
