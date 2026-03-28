/**
 * Compare latest discovery vs discoveryTest CSV reports (auto-picks newest files in reports/).
 *
 * Output: comparison-report-{timestamp}.csv — POC alignment per question.
 * Prereq: you have run both npm run discovery and npm run discoveryTest (or equivalent CSVs exist).
 *
 * See README.md → "Compare latest batch reports".
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findLatestReport(queryType) {
  const reportsDir = path.join(__dirname, '../reports');
  const files = fs.readdirSync(reportsDir);
  const csvFiles = files
    .filter(file => file.startsWith(`${queryType}-report-`) && file.endsWith('.csv'))
    .sort()
    .reverse();
  if (csvFiles.length === 0) return null;
  return path.join(reportsDir, csvFiles[0]);
}

function loadCSVReport(csvFilePath) {
  if (!fs.existsSync(csvFilePath)) return null;
  const content = fs.readFileSync(csvFilePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const headerValues = parseCSVLine(lines[0]);
  const headers = headerValues.map(h => h.trim());
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    data.push(row);
  }
  return data;
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function parseResultsJSON(jsonString) {
  if (!jsonString || jsonString.trim() === '') return [];
  try {
    let cleaned = jsonString.trim();
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    cleaned = cleaned.replace(/""/g, '"');
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function formatGenre(genre) {
  if (genre === null || genre === undefined) return 'READ';
  return String(genre);
}

async function compareReports() {
  console.log('🔍 Finding latest reports...\n');

  const discoveryCsv = findLatestReport('discovery');
  const discoveryTestCsv = findLatestReport('discoveryTest');

  if (!discoveryCsv) {
    console.error('❌ No discovery report found');
    process.exit(1);
  }
  if (!discoveryTestCsv) {
    console.error('❌ No discoveryTest report found');
    process.exit(1);
  }

  const discoveryData = loadCSVReport(discoveryCsv);
  const discoveryTestData = loadCSVReport(discoveryTestCsv);

  if (!discoveryData || !discoveryTestData) {
    console.error('❌ Could not load CSV reports');
    process.exit(1);
  }

  console.log(`📊 Comparing ${discoveryTestData.length} questions...\n`);

  const rows = [];

  for (let i = 0; i < discoveryTestData.length; i++) {
    const discoveryTest = discoveryTestData[i];
    const discovery = discoveryData[i] || {};

    const discoveryTestResults = parseResultsJSON(discoveryTest['Results (JSON)'] || '[]');
    const discoveryResults = parseResultsJSON(discovery['Results (JSON)'] || '[]');

    const question = discoveryTest['Question'] || discovery['Question'] || '';
    const maxOrder = Math.max(discoveryResults.length, discoveryTestResults.length);

    for (let order = 0; order < maxOrder; order++) {
      const discoveryPoc = discoveryResults[order];
      const discoveryTestPoc = discoveryTestResults[order];

      const discoveryPocId = discoveryPoc?._id ?? '-';
      const discoveryGenre = discoveryPoc ? formatGenre(discoveryPoc.parentGenre) : '-';
      const discoveryTestPocId = discoveryTestPoc?._id ?? '-';
      const discoveryTestGenre = discoveryTestPoc ? formatGenre(discoveryTestPoc.parentGenre) : '-';

      let result;
      if (!discoveryPoc && !discoveryTestPoc) {
        result = '-';
      } else if (!discoveryPoc) {
        result = 'no more POCs for discovery';
      } else if (!discoveryTestPoc) {
        result = 'no more POCs for discoveryTest';
      } else if (discoveryPoc._id === discoveryTestPoc._id) {
        result = 'match';
      } else {
        result = 'different';
      }

      rows.push({
        question,
        order,
        discovery_POCs: discoveryPocId,
        discovery_genre: discoveryGenre,
        discoveryTest: discoveryTestPocId,
        discoveryTest_genre: discoveryTestGenre,
        Result: result
      });
    }
  }

  const reportsDir = path.join(__dirname, '../reports');
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const csvFile = path.join(reportsDir, `comparison-report-${timestamp}.csv`);

  const quoteField = (value) => {
    if (!value) return value || '-';
    if (String(value).includes(',') || String(value).includes('"')) {
      return `"${String(value).replace(/"/g, '""')}"`;
    }
    return value;
  };

  const headers = ['question', 'order', 'discovery_POCs', 'discovery_genre', 'discoveryTest', 'discoveryTest_genre', 'Result'];

  const csvRows = rows.map(r => [
    `"${(r.question || '').replace(/"/g, '""')}"`,
    r.order,
    quoteField(r.discovery_POCs),
    quoteField(r.discovery_genre),
    quoteField(r.discoveryTest),
    quoteField(r.discoveryTest_genre),
    quoteField(r.Result)
  ].join(','));

  const csvContent = [headers.join(','), ...csvRows].join('\n');
  fs.writeFileSync(csvFile, csvContent);

  console.log(`✅ Comparison report saved: ${csvFile}`);
  console.log(`📋 Format: One row per question per POC position. "-" = empty. Result: match | different | no more POCs for {queryType}`);
}

compareReports().catch(console.error);
