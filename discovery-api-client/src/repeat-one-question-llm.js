/**
 * Run the **same** question many times against `discoveryTest`, fetch LLM text from `streamUrl`, write CSV.
 *
 * Defaults: https://concord.sandsmedia.com/graphql (override with GRAPHQL_ENDPOINT or `--graphql`).
 *
 * Usage:
 *   node src/repeat-one-question-llm.js --runs 100 "Your question?"
 *   node src/repeat-one-question-llm.js --from-file path/to/question.txt
 *   node src/repeat-one-question-llm.js --runs 10 --delay-ms 3000 "Your question?"
 *
 * Output: reports/repeat-one-question-llm-{timestamp}.csv
 *
 * CSV includes **TestTable**: the first markdown or HTML `<table>...</table>` block in the streamed
 * answer (typically the Concord “test table” emitted at the start of the reply).
 * npm run repeat-one-question-llm -- --runs 100 --delay-ms 5000 "What’s the difference between testing a component in isolation vs testing the full app with Cypress?"
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERY_TYPE = 'discoveryTest';
const DEFAULT_GRAPHQL = 'https://concord.sandsmedia.com/graphql';
const DEFAULT_RUNS = 100;
const DEFAULT_DELAY_MS = 2000;

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

async function callDiscovery(graphqlEndpoint, question) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) headers['access-token'] = process.env.AUTH_TOKEN;
  const response = await fetch(graphqlEndpoint, {
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
    return { ok: false, error: `No data.${QUERY_TYPE} in response` };
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

/** Markdown separator row e.g. | --- | :---: | ---: | */
function isMarkdownTableSeparatorLine(line) {
  const t = line.trim();
  if (!t.includes('|') || !/-/.test(t)) return false;
  const cells = t
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((c) => /^-{3,}$/.test(c) || /^-{3,}:$/.test(c) || /^:-{3,}$/.test(c) || /^:-{3,}:$/.test(c));
}

/** Row with pipe-delimited cells (GFM-style table row). */
function isMarkdownTableDataLine(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const pipes = (t.match(/\|/g) || []).length;
  if (pipes < 2) return false;
  if (isMarkdownTableSeparatorLine(line)) return true;
  return /^\|.+\|/.test(t) || (pipes >= 2 && t.split(/\|/).filter(Boolean).length >= 2);
}

/**
 * First contiguous markdown table in `text`, or null.
 */
function extractFirstMarkdownTable(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  // Optional short title line(s) before table (e.g. "Test table:") — skip non-pipe prose until we see a pipe row
  let start = -1;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    if (isMarkdownTableDataLine(raw)) {
      start = i;
      break;
    }
    // Prose before first table: allow only short label lines (e.g. "Test table:")
    if (t.length > 120 || /[.!?]\s*$/.test(t)) return null;
  }
  if (start < 0) return null;
  const out = [];
  for (let j = start; j < lines.length; j++) {
    const raw = lines[j];
    const t = raw.trim();
    if (!t) {
      if (out.length > 0) break;
      continue;
    }
    if (!isMarkdownTableDataLine(raw)) break;
    out.push(raw.trimEnd());
  }
  if (out.length === 0) return null;
  return out.join('\n');
}

function extractFirstHtmlTable(text) {
  const m = text.match(/<table\b[^>]*>[\s\S]*?<\/table>/i);
  return m ? m[0].trim() : null;
}

/** Leading ``` fence that wraps early content (some streams wrap the opening table). */
function stripLeadingCodeFence(inner) {
  const t = inner.trimStart();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n```/);
  return m ? m[1] : inner;
}

/**
 * First table appearing in streamed LLM body: prefers earliest of HTML `<table>` vs markdown pipes.
 */
function extractFirstStreamTestTable(answer) {
  if (!answer || typeof answer !== 'string') return '';

  const candidates = [answer, stripLeadingCodeFence(answer)].filter(Boolean);
  let best = '';
  let bestPos = Infinity;

  for (const chunk of candidates) {
    const n = chunk.replace(/\r\n/g, '\n');
    const html = extractFirstHtmlTable(n);
    if (html) {
      const idx = n.indexOf(html);
      if (idx >= 0 && idx < bestPos) {
        bestPos = idx;
        best = html;
      }
    }
    const md = extractFirstMarkdownTable(n);
    if (md) {
      const idx = n.indexOf(md);
      if (idx >= 0 && idx < bestPos) {
        bestPos = idx;
        best = md;
      }
    }
  }

  return best || '';
}

function parseArgs(argv) {
  let runs = DEFAULT_RUNS;
  let delayMs = DEFAULT_DELAY_MS;
  let questionFile = null;
  let graphqlEndpoint = process.env.GRAPHQL_ENDPOINT || DEFAULT_GRAPHQL;
  const positionals = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' && argv[i + 1]) {
      runs = parseInt(argv[++i], 10);
      if (Number.isNaN(runs) || runs < 1) runs = DEFAULT_RUNS;
      continue;
    }
    if (a === '--delay-ms' && argv[i + 1]) {
      delayMs = parseInt(argv[++i], 10);
      if (Number.isNaN(delayMs) || delayMs < 0) delayMs = 0;
      continue;
    }
    if (a === '--from-file' && argv[i + 1]) {
      questionFile = argv[++i];
      continue;
    }
    if (a === '--graphql' && argv[i + 1]) {
      graphqlEndpoint = argv[++i];
      continue;
    }
    if (!a.startsWith('--')) positionals.push(a);
  }

  let question = positionals.join(' ').trim();
  if (questionFile) {
    const resolved = path.isAbsolute(questionFile) ? questionFile : path.join(process.cwd(), questionFile);
    if (!fs.existsSync(resolved)) {
      console.error(`❌ Question file not found: ${resolved}`);
      process.exit(1);
    }
    question = fs.readFileSync(resolved, 'utf-8').trim();
  }

  return { runs, delayMs, question, graphqlEndpoint };
}

function writeCsv(rows, outPath) {
  const header = 'RunNumber,StartedAtISO,Question,TestTable,LLMAnswer,AnswerChars,Error';
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        r.runNumber,
        escapeCsv(r.startedAt),
        escapeCsv(r.question),
        escapeCsv(r.testTable),
        escapeCsv(r.answer),
        r.answerChars,
        escapeCsv(r.error || '')
      ].join(',')
    );
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
}

async function main() {
  const { runs, delayMs, question, graphqlEndpoint } = parseArgs(process.argv);
  if (!question) {
    console.error(`Usage:
  node src/repeat-one-question-llm.js [--runs ${DEFAULT_RUNS}] [--delay-ms ${DEFAULT_DELAY_MS}] "Question text?"
  node src/repeat-one-question-llm.js --from-file path/to/question.txt [--runs N]
Optional: GRAPHQL_ENDPOINT env or --graphql URL (default: ${DEFAULT_GRAPHQL})`);
    process.exit(1);
  }

  console.log(`\n🔁 Repeat \`${QUERY_TYPE}\` (${runs} runs, same question)`);
  console.log(`   Endpoint: ${graphqlEndpoint}`);
  console.log(`   Delay between runs: ${delayMs} ms`);
  console.log(`   Question: ${question.slice(0, 120)}${question.length > 120 ? '…' : ''}\n`);

  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `repeat-one-question-llm-${timestamp}.csv`);

  const rows = [];

  for (let i = 0; i < runs; i++) {
    const runNumber = i + 1;
    const startedAt = new Date().toISOString();
    console.log(`[${runNumber}/${runs}] …`);

    const api = await callDiscovery(graphqlEndpoint, question);
    let answer = '';
    let testTable = '';
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
        testTable = extractFirstStreamTestTable(answer);
        const tableHint = testTable ? `, TestTable ${testTable.split('\n').length} lines` : '';
        console.log(`   ✅ ${answer.length} chars${tableHint}`);
      }
    }

    rows.push({
      runNumber,
      startedAt,
      question,
      testTable,
      answer,
      answerChars: answer.length,
      error: err
    });
    writeCsv(rows, outPath);
    console.log(`   💾 ${outPath}\n`);

    if (i < runs - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`✨ Done. ${runs} rows → ${outPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
