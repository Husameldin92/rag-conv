import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const NUM_QUESTIONS = 2;
const DELAY_MS = 10000; // 10 seconds between questions

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

function loadQuestions() {
  const questionsPath = path.join(__dirname, '../fixtures/questions.json');
  return JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
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

async function runQuickTest() {
  const allQuestions = loadQuestions();
  const questions = [allQuestions[0], 'Is there a JAX in the next month?'];

  console.log(`\n🧪 Quick test: ${NUM_QUESTIONS} questions, ${DELAY_MS / 1000}s between each\n`);

  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];

  for (const queryType of ['discoveryTest', 'discovery']) {
    const results = [];
    const output = {
      timestamp: new Date().toISOString(),
      queryType,
      config: { numQuestions: NUM_QUESTIONS, delaySeconds: DELAY_MS / 1000 },
      results
    };

    console.log(`\n--- ${queryType} ---\n`);

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`[${i + 1}/${NUM_QUESTIONS}] "${q.substring(0, 50)}..."`);

      const { status, ok, body } = await callAPI(q, queryType);

      const entry = {
        questionNumber: i + 1,
        question: q,
        status,
        success: ok,
        resultsCount: null,
        error: null,
        data: null
      };

      if (status === 429) {
        console.log(`   ❌ 429 Rate limit exceeded!`);
        console.log(`   Body: ${body.substring(0, 150)}...`);
        entry.error = '429 Rate limit exceeded';
        entry.data = { bodyPreview: body.substring(0, 300) };
      } else if (ok) {
        try {
          const data = JSON.parse(body);
          const payload = data?.data?.[queryType];
          const count = payload?.results?.length ?? 0;
          console.log(`   ✅ Success - ${count} results`);
          entry.resultsCount = count;
          entry.data = payload;
        } catch (e) {
          entry.error = `Parse error: ${e.message}`;
          entry.data = { bodyPreview: body.substring(0, 300) };
        }
      } else {
        console.log(`   ❌ HTTP ${status}`);
        console.log(`   Body: ${body.substring(0, 150)}...`);
        entry.error = `HTTP ${status}`;
        entry.data = { bodyPreview: body.substring(0, 300) };
      }

      results.push(entry);

      if (i < questions.length - 1) {
        console.log(`   ⏳ Waiting ${DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }

    const jsonPath = path.join(reportsDir, `quick-test-${queryType}-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    console.log(`   📄 Saved: ${jsonPath}`);
  }

  console.log('\n✅ Quick test done.\n');
}

runQuickTest().catch(console.error);
