// Run POC comparison + LLM for ONE question via API (no CSV input needed)
// Usage: node src/run-one-question.js "Your question here"

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY_MS = 5000;

function buildQuery(question, queryType) {
  const escapedQuestion = question.replace(/"/g, '\\"');
  return `query {
  ${queryType}(
    restriction: NONE
    question: "${escapedQuestion}"
    enableConversation: true
  ) {
    results { _id score parentGenre parentName parentId title sortDate }
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

function resultsToPocData(results) {
  const orderedPocs = [];
  const pocScores = new Map();
  for (const r of results || []) {
    const poc = r._id;
    const score = typeof r.score === 'number' ? r.score : null;
    if (poc) {
      orderedPocs.push(poc);
      if (score != null) pocScores.set(poc, score);
    }
  }
  return { orderedPocs, pocScores };
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const question = process.argv[2];
  if (!question) {
    console.error('Usage: node run-one-question.js "Your question here"');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '../reports/compare-1.5k-vs-3k');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log(`\n🔍 Question: "${question}"\n`);

  // --- Fetch 3K (discovery) ---
  console.log('[discovery / 3K] Calling API...');
  const { ok: ok3, body: body3 } = await callAPI(question, 'discovery');
  const payload3 = ok3 ? JSON.parse(body3)?.data?.discovery : null;
  const { orderedPocs: pocs3kOrdered, pocScores: scores3k } = resultsToPocData(payload3?.results);
  console.log(`   ✅ 3K: ${pocs3kOrdered.length} POCs`);

  await new Promise(r => setTimeout(r, DELAY_MS));

  // --- Fetch 1.5K (discoveryTest) ---
  console.log('[discoveryTest / 1.5K] Calling API...');
  const { ok: ok1, body: body1 } = await callAPI(question, 'discoveryTest');
  const payload1 = ok1 ? JSON.parse(body1)?.data?.discoveryTest : null;
  const { orderedPocs: pocs15kOrdered, pocScores: scores15k } = resultsToPocData(payload1?.results);
  console.log(`   ✅ 1.5K: ${pocs15kOrdered.length} POCs`);

  // --- POC comparison CSV ---
  const pocs15kSet = new Set(pocs15kOrdered);
  const maxLen = Math.max(pocs15kOrdered.length, pocs3kOrdered.length, 1);
  const pocRows = [['question', 'POC_3K', 'POC_1.5K', 'score_3K', 'score_1.5K', 'note']];
  for (let i = 0; i < maxLen; i++) {
    const poc3k = pocs3kOrdered[i] ?? '-';
    const poc15k = pocs15kOrdered[i] ?? '-';
    const s3 = poc3k !== '-' ? scores3k.get(poc3k) : null;
    const s15 = poc15k !== '-' ? scores15k.get(poc15k) : null;
    const note = poc3k !== '-' && !pocs15kSet.has(poc3k) ? 'in 3K, missing in 1.5K' : '';
    pocRows.push([
      question,
      poc3k,
      poc15k,
      s3 != null ? s3.toFixed(6) : '-',
      s15 != null ? s15.toFixed(6) : '-',
      note
    ]);
  }
  const pocCsvPath = path.join(outDir, `compare-pocs-1.5k-vs-3k-${timestamp}.csv`);
  fs.writeFileSync(pocCsvPath, pocRows.map(r => r.map(escapeCsv).join(',')).join('\n'));
  console.log(`\n✅ POC CSV: ${pocCsvPath}`);

  // --- Fetch LLM answers ---
  console.log(`\n📡 Fetching LLM answers...`);
  let ans3k = null;
  let ans15k = null;
  if (payload3?.streamUrl) {
    ans3k = await fetchStreamContent(payload3.streamUrl);
    if (typeof ans3k === 'string') console.log(`   ✅ 3K answer: ${ans3k.length} chars`);
    else ans3k = null;
  }
  await new Promise(r => setTimeout(r, DELAY_MS));
  if (payload1?.streamUrl) {
    ans15k = await fetchStreamContent(payload1.streamUrl);
    if (typeof ans15k === 'string') console.log(`   ✅ 1.5K answer: ${ans15k.length} chars`);
    else ans15k = null;
  }

  const llmCsvPath = path.join(outDir, `compare-llm-answers-${timestamp}.csv`);
  const llmRows = [
    'Question,Answer 3K,Answer 1.5K',
    `${escapeCsv(question)},${escapeCsv(typeof ans3k === 'string' ? ans3k : '')},${escapeCsv(typeof ans15k === 'string' ? ans15k : '')}`
  ];
  fs.writeFileSync(llmCsvPath, llmRows.join('\n'));
  console.log(`✅ LLM CSV: ${llmCsvPath}\n`);
}

main().catch(console.error);
