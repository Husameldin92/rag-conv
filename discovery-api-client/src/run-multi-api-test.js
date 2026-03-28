/**
 * Repeat discoveryTest over 10 fixed questions, save each full run under reports/multi-run-{timestamp}/.
 *
 * Used to measure score stability / non-determinism across API calls.
 *
 * See README.md → "run-multi-api-test".
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

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

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY_MS = 3000;

function buildQuery(question) {
  const escaped = question.replace(/"/g, '\\"');
  return `query { discoveryTest(restriction: NONE, question: "${escaped}", enableConversation: true) { results { _id score parentGenre } } }`;
}

async function callAPI(question) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: buildQuery(question) })
  });
  const data = await res.json();
  return data?.data?.discoveryTest?.results || [];
}

async function runOne(questions) {
  const results = [];
  for (const q of questions) {
    const results_ = await callAPI(q);
    results.push({ question: q, results: results_ });
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  return results;
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Compare POC set + scores only (order ignored)
function compareRuns(runA, runB) {
  const diffs = [];
  for (let i = 0; i < runA.length; i++) {
    const a = runA[i];
    const b = runB.find(e => e.question === a.question);
    if (!b) continue;
    const aMap = new Map((a.results || []).map(r => [r._id, r.score]));
    const bMap = new Map((b.results || []).map(r => [r._id, r.score]));
    const aPocSet = new Set(aMap.keys());
    const bPocSet = new Set(bMap.keys());
    const pocsRemoved = [...aPocSet].filter(id => !bPocSet.has(id));
    const pocsAdded = [...bPocSet].filter(id => !aPocSet.has(id));
    const scoreChanges = [];
    for (const id of aPocSet) {
      if (!bPocSet.has(id)) continue;
      const sa = aMap.get(id);
      const sb = bMap.get(id);
      if (typeof sa === 'number' && typeof sb === 'number' && Math.abs(sa - sb) >= 1e-6) {
        scoreChanges.push(`${id}: ${sa.toFixed(4)}->${sb.toFixed(4)}`);
      }
    }
    if (pocsRemoved.length || pocsAdded.length || scoreChanges.length) {
      diffs.push({
        question: a.question,
        pocsRemoved,
        pocsAdded,
        scoreChanges
      });
    }
  }
  return { diffCount: diffs.length, total: runA.length, diffs };
}

async function main() {
  const numExtraRuns = parseInt(process.argv[2], 10) || 3;
  const reportsDir = path.join(__dirname, '../reports');
  const runDir = path.join(reportsDir, `multi-run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`\n🔄 Run 1 (original/baseline)...`);
  const original = await runOne(TEN_QUESTIONS);
  fs.writeFileSync(path.join(runDir, 'run-original.json'), JSON.stringify(original, null, 2));
  console.log(`   ✅ Saved run-original.json\n`);

  console.log(`🔄 Running ${numExtraRuns} more times to compare...\n`);
  const runs = [];
  for (let r = 1; r <= numExtraRuns; r++) {
    console.log(`   Run ${r + 1}/${numExtraRuns + 1}...`);
    const data = await runOne(TEN_QUESTIONS);
    fs.writeFileSync(path.join(runDir, `run-${r + 1}.json`), JSON.stringify(data, null, 2));
    runs.push(data);
    console.log(`   ✅ Saved run-${r + 1}.json`);
  }

  console.log(`\n📊 Comparing each run vs original (POC set + scores, order ignored)...\n`);

  const csvRows = [['question', 'run', 'pocs_removed', 'pocs_added', 'score_changes']];
  let runsWithDiff = 0;

  for (let i = 0; i < runs.length; i++) {
    const { diffCount, total, diffs } = compareRuns(original, runs[i]);
    const pct = total ? ((diffCount / total) * 100).toFixed(0) : 0;
    const hasDiff = diffCount > 0;
    if (hasDiff) runsWithDiff++;

    for (const d of diffs) {
      csvRows.push([
        d.question,
        `run-${i + 2}`,
        d.pocsRemoved.join(';'),
        d.pocsAdded.join(';'),
        d.scoreChanges.join('; ')
      ]);
    }

    console.log(`   Run ${i + 2} vs Original: ${diffCount}/${total} questions differed (${pct}%) ${hasDiff ? '⚠️' : '✓'}`);
  }

  const csvPath = path.join(runDir, 'comparison-diffs.csv');
  fs.writeFileSync(csvPath, csvRows.map(r => r.map(escapeCsv).join(',')).join('\n'));

  const pctRuns = runs.length ? ((runsWithDiff / runs.length) * 100).toFixed(0) : 0;
  console.log(`\n📈 Summary: ${runsWithDiff}/${runs.length} runs differed from original (${pctRuns}%)`);
  console.log(`   CSV: ${csvPath}`);
  console.log(`   Results: ${runDir}\n`);
}

main().catch(console.error);
