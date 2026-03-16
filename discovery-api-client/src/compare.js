import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find latest report file by timestamp
function findLatestReport(queryType) {
  const reportsDir = path.join(__dirname, '../reports');
  const files = fs.readdirSync(reportsDir);

  const csvFiles = files
    .filter(file => file.startsWith(`${queryType}-report-`) && file.endsWith('.csv'))
    .sort()
    .reverse();

  if (csvFiles.length === 0) {
    return null;
  }

  return path.join(reportsDir, csvFiles[0]);
}

// Load CSV report from file path
function loadCSVReport(csvFilePath) {
  if (!fs.existsSync(csvFilePath)) {
    return null;
  }

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

// Parse CSV line handling quoted fields
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

// Parse JSON results from CSV
function parseResultsJSON(jsonString) {
  if (!jsonString || jsonString.trim() === '') {
    return [];
  }

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

// Format POCs with order numbers: "0: id1, 1: id2, 2: id3, ..." or null
function formatPOCsWithOrder(results) {
  if (!results || !Array.isArray(results) || results.length === 0) {
    return 'null';
  }
  return results.map((r, index) => `${index}: ${r._id}`).join(', ');
}

// Main comparison function
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

  const comparisons = [];

  for (let i = 0; i < discoveryTestData.length; i++) {
    const discoveryTest = discoveryTestData[i];
    const discovery = discoveryData[i] || {};

    const discoveryTestResults = parseResultsJSON(discoveryTest['Results (JSON)'] || '[]');
    const discoveryResults = parseResultsJSON(discovery['Results (JSON)'] || '[]');

    const question = discoveryTest['Question'] || discovery['Question'] || '';
    const discoveryTestPOCs = formatPOCsWithOrder(discoveryTestResults);
    const discoveryPOCs = formatPOCsWithOrder(discoveryResults);

    comparisons.push({
      questionNumber: discoveryTest['Question Number'] || i + 1,
      question,
      discoveryTestPOCs,
      discoveryPOCs
    });
  }

  // Generate CSV report
  const reportsDir = path.join(__dirname, '../reports');
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const csvFile = path.join(reportsDir, `comparison-report-${timestamp}.csv`);

  const quoteField = (value) => {
    if (!value || value === 'null') return value || 'null';
    if (value.includes(',') || value.includes('"')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const headers = ['Question Number', 'Question', 'DiscoveryTest POCs (0, 1, 2, ...)', 'Discovery POCs (0, 1, 2, ...)'];

  const rows = comparisons.map(comp => {
    return [
      comp.questionNumber,
      `"${(comp.question || '').replace(/"/g, '""')}"`,
      quoteField(comp.discoveryTestPOCs),
      quoteField(comp.discoveryPOCs)
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(csvFile, csvContent);

  console.log(`✅ Comparison report saved: ${csvFile}`);
  console.log(`\n📋 Format: Each POC has order number (0, 1, 2, ...). "null" = no results for that query.`);
}

compareReports().catch(console.error);
