/**
 * For each question in a JSON array file: call `discovery` only, fetch LLM text from streamUrl, write CSV.
 *
 * Usage:
 *   node src/batch-discovery-llm-answers.js
 *   node src/batch-discovery-llm-answers.js path/to/questions.json
 *   node src/batch-discovery-llm-answers.js --limit 50
 *   node src/batch-discovery-llm-answers.js fixtures/questions.json --limit 100
 *
 * Default questions file: fixtures/questions.json
 *
 * Multilingual file: array of `{ "lang": "en|de|nl|...", "text": "..." }` — one row per question
 * (each question asked in a single language; no duplicate topics). Optional `"id"` for your own tracking.
 * Plain string array still supported. Example: fixtures/questions-multilang.json
 *
 * Output: reports/discovery-llm-answers-{timestamp}.csv (rewritten after each question).
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
const QUERY_TYPE = 'discovery';
const DELAY_MS = 5000;

function buildQuery(question) {
  const escapedQuestion = question.replace(/"/g, '\\"');
  return `query {
  ${QUERY_TYPE}(
    restriction: NONE
    question: "${escapedQuestion}"
    enableConversation: true
  ) {
    results {
      _id
      score
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

async function callDiscovery(question) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: buildQuery(question) })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: `Invalid JSON: ${text.slice(0, 200)}` };
  }
  if (data.errors) {
    return { ok: false, error: JSON.stringify(data.errors) };
  }
  const payload = data?.data?.[QUERY_TYPE];
  if (!payload) {
    return { ok: false, error: 'No data.discovery in response' };
  }
  return { ok: true, payload };
}

async function fetchStreamContent(streamUrl) {
  if (!streamUrl) return { text: null, error: 'No streamUrl' };
  const headers = {};
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  try {
    const response = await fetch(streamUrl, { headers });
    const text = await response.text();
    if (!response.ok) return { text: null, error: text.slice(0, 500) };
    try {
      const json = JSON.parse(text);
      if (json.error) return { text: null, error: json.error };
      const content = json.content ?? json.text ?? json.data ?? json.message ?? json.answer;
      if (typeof content === 'string') return { text: content };
      if (Array.isArray(content)) return { text: content.map(c => c.text ?? c.content ?? c).join('\n') };
      if (content && typeof content === 'object') return { text: JSON.stringify(content) };
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
        } catch (_) {
          chunks.push(chunk);
        }
      }
    }
    if (chunks.length > 0) return { text: chunks.join('') };
    return { text: text.trim() || null };
  } catch (e) {
    return { text: null, error: e.message };
  }
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return '"' + s.replace(/"/g, '""') + '"';
}

function parseArgs(argv) {
  let file = path.join(__dirname, '../fixtures/questions.json');
  let limit = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
      if (Number.isNaN(limit) || limit < 1) limit = null;
      continue;
    }
    if (!a.startsWith('--')) {
      const resolved = path.isAbsolute(a) ? a : path.join(process.cwd(), a);
      if (fs.existsSync(resolved)) file = resolved;
    }
  }
  return { file, limit };
}

/**
 * @returns {{ lang: string, id: string, text: string }[]}
 */
function loadQuestions(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('Questions file must be a JSON array');

  const out = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push({ lang: '', id: '', text: t });
      continue;
    }
    if (item && typeof item === 'object') {
      const text = String(item.text ?? item.question ?? '').trim();
      if (!text) continue;
      const lang = String(item.lang ?? item.language ?? '').trim();
      const id = item.id !== undefined && item.id !== null ? String(item.id) : '';
      out.push({ lang, id, text });
    }
  }
  if (out.length === 0) throw new Error('No valid questions (use strings or { lang, text } objects)');
  return out;
}

function writeCsv(rows, outPath) {
  const header = 'QuestionNumber,Lang,QuestionId,Question,DiscoveryAnswer,Error';
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.questionNumber,
      escapeCsv(r.lang || ''),
      escapeCsv(r.questionId || ''),
      escapeCsv(r.question),
      escapeCsv(r.answer),
      escapeCsv(r.error || '')
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

async function main() {
  const { file, limit } = parseArgs(process.argv);
  if (!fs.existsSync(file)) {
    console.error(`❌ Questions file not found: ${file}`);
    process.exit(1);
  }

  let questions = loadQuestions(file);
  if (limit != null) questions = questions.slice(0, limit);

  console.log(`\n📋 Batch LLM answers via \`${QUERY_TYPE}\` (${questions.length} questions)`);
  console.log(`   File: ${file}`);
  console.log(`   Endpoint: ${GRAPHQL_ENDPOINT}\n`);

  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `discovery-llm-answers-${timestamp}.csv`);

  const rows = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const question = q.text;
    const lang = q.lang;
    const questionId = q.id;
    const questionNum = i + 1;
    const langTag = lang ? `[${lang}] ` : '';
    console.log(`[${questionNum}/${questions.length}] ${langTag}${question.slice(0, 72)}${question.length > 72 ? '…' : ''}`);

    const api = await callDiscovery(question);
    let answer = '';
    let err = '';

    if (!api.ok) {
      err = api.error || 'API failed';
      console.log(`   ❌ ${err.slice(0, 120)}`);
    } else {
      const streamUrl = api.payload?.streamUrl;
      const fetched = await fetchStreamContent(streamUrl);
      if (fetched.error && !fetched.text) {
        err = fetched.error;
        console.log(`   ⚠️ Stream: ${err.slice(0, 80)}`);
      } else {
        answer = fetched.text || '';
        console.log(`   ✅ ${answer.length} chars`);
      }
    }

    rows.push({
      questionNumber: questionNum,
      lang,
      questionId,
      question,
      answer,
      error: err
    });
    writeCsv(rows, outPath);
    console.log(`   💾 ${outPath}`);

    if (i < questions.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    console.log('');
  }

  console.log(`✨ Done. ${questions.length} rows → ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
