/**
 * Single-question LLM comparison: discovery (3K) vs discoveryTest (1.5K) stream answers.
 *
 * Edit DEFAULT_QUESTION in this file, or pass: node src/compare-llm-single-question.js "Question?"
 * Fetches streamUrl for both queries, writes CSV with both answers. API-only (no chunk CSVs).
 *
 * Output: reports/compare-llm-single-question-answers-{timestamp}.csv
 * Alias: npm run quick-test → same script (legacy name).
 *
 * See README.md → "compare-llm-single-question".
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const DELAY_MS = 5000;

const DEFAULT_QUESTION = 'How does Kubernetes autoscaling work?';

function buildQuery(question, queryType) {
  const escapedQuestion = question.replace(/"/g, '\\"');
  return `query {
  ${queryType}(
    restriction: NONE
    question: "${escapedQuestion}"
    enableConversation: true
  ) {
    results {
      _id
      parentGenre
      parentName
      parentId
      title
      sortDate
    }
    streamUrl
    userRagId
  }
}`;
}

async function callAPI(question, queryType) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) {
    headers['access-token'] = process.env.AUTH_TOKEN;
  }

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
  if (process.env.AUTH_TOKEN) {
    headers['access-token'] = process.env.AUTH_TOKEN;
  }

  try {
    const response = await fetch(streamUrl, { headers });
    const text = await response.text();

    if (!response.ok) {
      return { error: text };
    }

    try {
      const json = JSON.parse(text);
      if (json.error) return { error: json.error };
      const content = json.content ?? json.text ?? json.data ?? json.message ?? json.answer;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(c => c.text ?? c.content ?? c).join('\n');
      if (content && typeof content === 'object') return JSON.stringify(content);
    } catch (_) {
      // Not JSON
    }

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
        } catch (_) {
          chunks.push(chunk);
        }
      }
    }
    if (chunks.length > 0) return chunks.join('');

    return text.trim() || null;
  } catch (e) {
    return { error: e.message };
  }
}

function escapeCsv(value) {
  if (value == null) return '""';
  const s = String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

async function main() {
  const question = process.argv[2] || DEFAULT_QUESTION;
  console.log(`\n📋 Compare LLM (single question): discovery vs discoveryTest\n`);
  console.log(`   Question: "${question}"\n`);

  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];

  let discoveryAnswer = null;
  let discoveryTestAnswer = null;

  console.log(`[discovery] Calling API...`);
  const { status: s1, ok: ok1, body: body1 } = await callAPI(question, 'discovery');
  if (ok1) {
    const payload = JSON.parse(body1)?.data?.discovery;
    const streamUrl = payload?.streamUrl;
    console.log(`[discovery] Fetching stream...`);
    discoveryAnswer = await fetchStreamContent(streamUrl);
    if (discoveryAnswer && typeof discoveryAnswer === 'object' && discoveryAnswer.error) {
      console.log(`   ⚠️  Stream: ${discoveryAnswer.error}`);
      discoveryAnswer = null;
    } else if (discoveryAnswer) {
      console.log(`   ✅ Got ${discoveryAnswer.length} chars`);
    }
  } else {
    console.log(`   ❌ HTTP ${s1}`);
  }

  await new Promise(r => setTimeout(r, DELAY_MS));

  console.log(`\n[discoveryTest] Calling API...`);
  const { status: s2, ok: ok2, body: body2 } = await callAPI(question, 'discoveryTest');
  if (ok2) {
    const payload = JSON.parse(body2)?.data?.discoveryTest;
    const streamUrl = payload?.streamUrl;
    console.log(`[discoveryTest] Fetching stream...`);
    discoveryTestAnswer = await fetchStreamContent(streamUrl);
    if (discoveryTestAnswer && typeof discoveryTestAnswer === 'object' && discoveryTestAnswer.error) {
      console.log(`   ⚠️  Stream: ${discoveryTestAnswer.error}`);
      discoveryTestAnswer = null;
    } else if (discoveryTestAnswer) {
      console.log(`   ✅ Got ${discoveryTestAnswer.length} chars`);
    }
  } else {
    console.log(`   ❌ HTTP ${s2}`);
  }

  const csvPath = path.join(reportsDir, `compare-llm-single-question-answers-${timestamp}.csv`);
  const d = typeof discoveryAnswer === 'string' ? discoveryAnswer : '';
  const t = typeof discoveryTestAnswer === 'string' ? discoveryTestAnswer : '';
  const csvRows = [
    'Question,Discovery Answer,DiscoveryTest Answer',
    `${escapeCsv(question)},${escapeCsv(d)},${escapeCsv(t)}`
  ];
  fs.writeFileSync(csvPath, csvRows.join('\n'));

  console.log(`\n✅ CSV saved: ${csvPath}\n`);
}

main().catch(console.error);
