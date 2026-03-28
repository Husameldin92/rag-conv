/**
 * Batch Discovery API runner — all questions from fixtures/questions.json.
 *
 * Invoked as: node src/index.js [discovery|discoveryTest] (default: discoveryTest).
 * Writes timestamped JSON + CSV under reports/ after each question (incremental).
 *
 * See README.md → "Core — batch API runs".
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GraphQL endpoint
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';

// Generate GraphQL query with question embedded
function buildQuery(question, queryType) {
  // Escape quotes in question for GraphQL string
  const escapedQuestion = question.replace(/"/g, '\\"');
  
  return `query {
  ${queryType}(
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

// Load questions from the fixtures file
function loadQuestions() {
  const questionsPath = path.join(__dirname, '../fixtures/questions.json');
  const questionsData = fs.readFileSync(questionsPath, 'utf-8');
  return JSON.parse(questionsData);
}

// Call the discovery API
async function callDiscoveryAPI(question, queryType) {
  // Build query with question embedded
  const query = buildQuery(question, queryType);

  // Build headers
  const headers = {
    'Content-Type': 'application/json',
  };

  if (process.env.AUTH_TOKEN) {
    headers['access-token'] = process.env.AUTH_TOKEN;
  }

  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (${response.status}). The API may require authentication. Check your .env file for AUTH_TOKEN.`);
      }
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    // Check if data.data exists and has the query type
    if (!data.data || !data.data[queryType]) {
      console.warn(`⚠️  Unexpected response structure:`, JSON.stringify(data, null, 2));
      return null;
    }

    return data.data[queryType];
  } catch (error) {
    console.error(`Error calling API for question "${question.substring(0, 50)}...":`, error.message);
    return null;
  }
}

// Generate timestamp for report filenames
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/:/g, '-').split('.')[0];
}

// Save results to JSON
function saveJSONReport(results, filename) {
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  const filePath = path.join(reportsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  console.log(`✅ JSON report saved: ${filePath}`);
}

// Save results to CSV
function saveCSVReport(results, filename) {
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  const filePath = path.join(reportsDir, filename);
  
  // CSV header
  const headers = [
    'Question Number',
    'Question',
    'Results Count',
    'Response Time (ms)',
    'Stream URL',
    'User RAG ID',
    'Results (JSON)'
  ];
  
  const rows = results.map((result, index) => {
    const resultsJson = JSON.stringify(result.results || []);
    return [
      index + 1,
      `"${(result.question || '').replace(/"/g, '""')}"`,
      result.results?.length || 0,
      result.responseTime ?? '',
      result.streamUrl || '',
      result.userRagId || '',
      `"${resultsJson.replace(/"/g, '""')}"`
    ].join(',');
  });
  
  const csvContent = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(filePath, csvContent);
  console.log(`✅ CSV report saved: ${filePath}`);
}

// Main function
async function main() {
  // Get query type from command line argument or default to discoveryTest
  const queryType = process.argv[2] || 'discoveryTest';
  
  if (queryType !== 'discovery' && queryType !== 'discoveryTest') {
    console.error('❌ Invalid query type. Use "discovery" or "discoveryTest"');
    process.exit(1);
  }
  
  // Verify which query will be used
  console.log(`🚀 Starting ${queryType} API Client...\n`);
  console.log(`📡 GraphQL Endpoint: ${GRAPHQL_ENDPOINT}`);
  console.log(`🔍 Query Type: ${queryType} (will use ${queryType} query)\n`);
  
  // Check authentication
  if (process.env.AUTH_TOKEN) {
    console.log('🔐 Using access-token authentication\n');
  } else {
    console.log('⚠️  No authentication configured. If the API requires auth, add AUTH_TOKEN to your .env file\n');
  }
  
  // Load questions
  const questions = loadQuestions();
  console.log(`📋 Loaded ${questions.length} questions\n`);
  
  const results = [];
  const timestamp = getTimestamp();
  
  // Process each question
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const questionNum = i + 1;
    
    console.log(`[${questionNum}/${questions.length}] Processing: "${question.substring(0, 60)}${question.length > 60 ? '...' : ''}"`);
    
    const startTime = Date.now();
    const discoveryResult = await callDiscoveryAPI(question, queryType);
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    if (discoveryResult) {
      results.push({
        questionNumber: questionNum,
        question,
        responseTime,
        ...discoveryResult
      });
      console.log(`   ✅ Success (${responseTime}ms) - Results: ${discoveryResult.results?.length || 0}`);
    } else {
      results.push({
        questionNumber: questionNum,
        question,
        responseTime,
        error: 'API call failed'
      });
      console.log(`   ❌ Failed (${responseTime}ms)`);
    }
    
    // Save incrementally after each question
    const jsonFilename = `${queryType}-report-${timestamp}.json`;  
    const csvFilename = `${queryType}-report-${timestamp}.csv`;
    saveJSONReport(results, jsonFilename);
    saveCSVReport(results, csvFilename);
    
    // Small delay to avoid rate limiting
    if (i < questions.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds
    }
    
    console.log('');
  }
  
  console.log(`\n✨ Completed! Processed ${questions.length} questions`);
  console.log(`📊 Reports saved with timestamp: ${timestamp}`);
}

// Run the main function
main().catch(console.error);
