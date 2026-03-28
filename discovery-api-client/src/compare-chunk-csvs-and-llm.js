/**
 * Chunk CSV diff (1.5K vs 3K) + LLM answers for one question.
 *
 * Usage: node src/compare-chunk-csvs-and-llm.js <1.5k.csv> <3k.csv> [question]
 * Input CSVs: rows with chunk_id, poc_id, score (chunker exports).
 * Outputs under reports/compare-1.5k-vs-3k/: compare-chunks-*.csv + compare-llm-answers-*.csv
 *
 * Alias: npm run compare-pocs-and-llm → same script (legacy name).
 *
 * See README.md → "compare-chunk-csvs-and-llm".
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_QUESTION = 'How does Kubernetes autoscaling work?';
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY_MS = 5000;

function parseChunkCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true });
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => (h || '').trim().toLowerCase());
  const pocIdx = headers.findIndex(h => h === 'poc_id' || h === 'poc' || h === '_id');
  const chunkIdx = headers.findIndex(h => h === 'chunk_id' || h === 'chunk');
  const scoreIdx = headers.findIndex(h => h === 'score');
  const chunks = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const poc = pocIdx >= 0 ? (row[pocIdx] || '').trim() : '';
    const chunkId = chunkIdx >= 0 ? (row[chunkIdx] || '').trim() : '';
    const score = scoreIdx >= 0 ? parseFloat(row[scoreIdx]) : NaN;
    if (chunkId) {
      chunks.push({ chunkId, poc, score: isNaN(score) ? null : score });
    }
  }
  return chunks;
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildQuery(question, queryType) {
  const escapedQuestion = question.replace(/"/g, '\\"');
  return `query {
  ${queryType}(
    restriction: NONE
    question: "${escapedQuestion}"
    enableConversation: true
  ) {
    results { _id parentGenre parentName parentId title sortDate }
    streamUrl
    userRagId
  }
}`;
}

async function callAPI(question, queryType) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: buildQuery(question, queryType) })
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
}

async function fetchStreamContent(streamUrl) {
  if (!streamUrl) return null;
  const headers = {};
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  try {
    const response = await fetch(streamUrl, { headers });
    const text = await response.text();
    if (!response.ok) return { error: text };
    try {
      const json = JSON.parse(text);
      if (json.error) return { error: json.error };
      const content = json.content ?? json.text ?? json.data ?? json.message ?? json.answer;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(c => c.text ?? c.content ?? c).join('\n');
      if (content && typeof content === 'object') return JSON.stringify(content);
    } catch (_) {}
    const lines = text.split('\n');
    const chunks = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const chunk = line.slice(6);
        if (chunk === '[DONE]') break;
        try {
          const parsed = JSON.parse(chunk);
          const delta = parsed.choices?.[0]?.delta?.content ?? parsed.content ?? parsed.text ?? parsed;
          if (delta) chunks.push(typeof delta === 'string' ? delta : JSON.stringify(delta));
        } catch (_) { chunks.push(chunk); }
      }
    }
    return chunks.length > 0 ? chunks.join('') : text.trim() || null;
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const file15k = process.argv[2];
  const file3k = process.argv[3];
  const question = process.argv[4] || DEFAULT_QUESTION;

  if (!file15k || !file3k) {
    console.error('Usage: node src/compare-chunk-csvs-and-llm.js <1.5k.csv> <3k.csv> [question]');
    process.exit(1);
  }
  if (!fs.existsSync(file15k) || !fs.existsSync(file3k)) {
    console.error('File not found');
    process.exit(1);
  }

  const reportsDir = path.join(__dirname, '../reports');
  const outDir = path.join(reportsDir, 'compare-1.5k-vs-3k');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const chunks15k = parseChunkCsv(file15k);
  const chunks3k = parseChunkCsv(file3k);
  const chunkIds15k = new Set(chunks15k.map(c => c.chunkId));
  const maxLen = Math.max(chunks15k.length, chunks3k.length, 1);

  const rows = [['question', 'chunk_id_3K', 'chunk_id_1.5K', 'poc_id_3K', 'poc_id_1.5K', 'score_3K', 'score_1.5K', 'note']];
  for (let i = 0; i < maxLen; i++) {
    const c3 = chunks3k[i];
    const c15 = chunks15k[i];
    const chunk3k = c3?.chunkId ?? '-';
    const chunk15k = c15?.chunkId ?? '-';
    const poc3k = c3?.poc ?? '-';
    const poc15k = c15?.poc ?? '-';
    const s3 = c3?.score ?? null;
    const s15 = c15?.score ?? null;
    const note = chunk3k !== '-' && !chunkIds15k.has(chunk3k) ? 'in 3K, missing in 1.5K' : '';
    rows.push([
      question,
      chunk3k,
      chunk15k,
      poc3k,
      poc15k,
      s3 != null ? s3.toFixed(6) : '-',
      s15 != null ? s15.toFixed(6) : '-',
      note
    ]);
  }

  const csvPath = path.join(outDir, `compare-chunks-1.5k-vs-3k-${timestamp}.csv`);
  fs.writeFileSync(csvPath, rows.map(r => r.map(escapeCsv).join(',')).join('\n'));
  const onlyIn3k = chunks3k.filter(c => !chunkIds15k.has(c.chunkId)).length;
  console.log(`\n✅ Chunk comparison CSV: ${csvPath}`);
  console.log(`   Chunks: 1.5K=${chunks15k.length}, 3K=${chunks3k.length}`);
  console.log(`   In 3K but missing in 1.5K: ${onlyIn3k}`);

  console.log(`\n📡 Fetching LLM answers for: "${question}"`);
  let discoveryAnswer = null;
  let discoveryTestAnswer = null;

  console.log('   [discovery] Calling API...');
  const { ok: ok1, body: body1 } = await callAPI(question, 'discovery');
  if (ok1) {
    const payload = JSON.parse(body1)?.data?.discovery;
    const streamUrl = payload?.streamUrl;
    if (streamUrl) {
      discoveryAnswer = await fetchStreamContent(streamUrl);
      if (discoveryAnswer && typeof discoveryAnswer === 'object' && discoveryAnswer.error) {
        console.log(`   ⚠️  Stream: ${discoveryAnswer.error}`);
        discoveryAnswer = null;
      } else if (typeof discoveryAnswer === 'string') {
        console.log(`   ✅ Discovery (3K): ${discoveryAnswer.length} chars`);
      }
    }
  }

  await new Promise(r => setTimeout(r, DELAY_MS));

  console.log('   [discoveryTest] Calling API...');
  const { ok: ok2, body: body2 } = await callAPI(question, 'discoveryTest');
  if (ok2) {
    const payload = JSON.parse(body2)?.data?.discoveryTest;
    const streamUrl = payload?.streamUrl;
    if (streamUrl) {
      discoveryTestAnswer = await fetchStreamContent(streamUrl);
      if (discoveryTestAnswer && typeof discoveryTestAnswer === 'object' && discoveryTestAnswer.error) {
        console.log(`   ⚠️  Stream: ${discoveryTestAnswer.error}`);
        discoveryTestAnswer = null;
      } else if (typeof discoveryTestAnswer === 'string') {
        console.log(`   ✅ DiscoveryTest (1.5K): ${discoveryTestAnswer.length} chars`);
      }
    }
  }

  const d = typeof discoveryAnswer === 'string' ? discoveryAnswer : '';
  const t = typeof discoveryTestAnswer === 'string' ? discoveryTestAnswer : '';
  const llmCsvPath = path.join(outDir, `compare-llm-answers-${timestamp}.csv`);
  const llmRows = [
    'Question,Discovery Answer (3K),DiscoveryTest Answer (1.5K)',
    `${escapeCsv(question)},${escapeCsv(d)},${escapeCsv(t)}`
  ];
  fs.writeFileSync(llmCsvPath, llmRows.join('\n'));
  console.log(`\n✅ LLM answer report: ${llmCsvPath}`);
  console.log('');
}

main().catch(console.error);
