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

// Load CSV report
function loadCSVReport(queryType, timestamp) {
  const reportsDir = path.join(__dirname, '../reports');
  const csvFile = path.join(reportsDir, `${queryType}-report-${timestamp}.csv`);
  
  if (!fs.existsSync(csvFile)) {
    return null;
  }
  
  const content = fs.readFileSync(csvFile, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  // Parse headers using the same CSV parsing logic
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
        i++; // Skip next quote
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
  values.push(current); // Add last value
  return values;
}

// Parse JSON results from CSV
function parseResultsJSON(jsonString) {
  if (!jsonString || jsonString.trim() === '') {
    return [];
  }
  
  try {
    // Remove surrounding quotes if present and unescape CSV double quotes
    let cleaned = jsonString.trim();
    
    // Remove outer quotes if the entire string is quoted
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    
    // Replace CSV double-escaped quotes with single quotes
    cleaned = cleaned.replace(/""/g, '"');
    
    const parsed = JSON.parse(cleaned);
    
    // Ensure we have an array
    if (!Array.isArray(parsed)) {
      console.warn('⚠️  Parsed JSON is not an array:', typeof parsed);
      return [];
    }
    
    return parsed;
  } catch (e) {
    // Silently return empty array if parsing fails
    // (This can happen if the field is empty or malformed)
    return [];
  }
}

// Compare order of IDs and provide detailed information
function compareIdsOrder(discoveryTestIds, discoveryIds) {
  // Same length and same order
  if (discoveryTestIds.length === discoveryIds.length && 
      discoveryTestIds.every((id, index) => id === discoveryIds[index])) {
    return 'Yes - Same order';
  }
  
  // Different lengths
  if (discoveryTestIds.length !== discoveryIds.length) {
    return `No - Different lengths (DiscoveryTest: ${discoveryTestIds.length}, Discovery: ${discoveryIds.length})`;
  }
  
  // Same length but different order - find differences
  const differences = [];
  const maxDifferencesToShow = 5;
  
  for (let i = 0; i < discoveryTestIds.length; i++) {
    if (discoveryTestIds[i] !== discoveryIds[i]) {
      differences.push({
        position: i + 1,
        discoveryTestId: discoveryTestIds[i],
        discoveryId: discoveryIds[i]
      });
      
      if (differences.length >= maxDifferencesToShow) {
        break;
      }
    }
  }
  
  if (differences.length === 0) {
    return 'Yes - Same order';
  }
  
  // Build description of differences
  const diffCount = discoveryTestIds.filter((id, index) => id !== discoveryIds[index]).length;
  let description = `No - ${diffCount} position(s) differ`;
  
  if (differences.length > 0) {
    const examples = differences.map(d => 
      `Pos ${d.position}: DiscoveryTest="${d.discoveryTestId.substring(0, 12)}..." vs Discovery="${d.discoveryId.substring(0, 12)}..."`
    ).join('; ');
    description += ` (e.g., ${examples})`;
    
    if (diffCount > maxDifferencesToShow) {
      description += ` ... and ${diffCount - maxDifferencesToShow} more`;
    }
  }
  
  return description;
}

// Main comparison function
async function compareReports() {
  console.log('🔍 Finding latest reports...\n');
  
  // Find latest CSV files to get timestamps
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
  
  // Extract timestamps from filenames
  const discoveryTimestamp = discoveryCsv.match(/discovery-report-(.+)\.csv$/)[1];
  const discoveryTestTimestamp = discoveryTestCsv.match(/discoveryTest-report-(.+)\.csv$/)[1];
  
  console.log(`📄 Discovery report: ${discoveryTimestamp}`);
  console.log(`📄 DiscoveryTest report: ${discoveryTestTimestamp}\n`);
  
  // Load CSV reports
  const discoveryData = loadCSVReport('discovery', discoveryTimestamp);
  const discoveryTestData = loadCSVReport('discoveryTest', discoveryTestTimestamp);
  
  if (!discoveryData || !discoveryTestData) {
    console.error('❌ Could not load CSV reports');
    process.exit(1);
  }
  
  console.log(`📊 Comparing ${discoveryTestData.length} questions...\n`);
  
  const comparisons = [];
  
  // Compare each question
  for (let i = 0; i < discoveryTestData.length; i++) {
    const discoveryTest = discoveryTestData[i];
    const discovery = discoveryData[i] || {};
    
    // Parse results JSON from CSV
    const discoveryTestResults = parseResultsJSON(discoveryTest['Results (JSON)'] || '[]');
    const discoveryResults = parseResultsJSON(discovery['Results (JSON)'] || '[]');
    
    const discoveryTestResultsCount = discoveryTestResults.length;
    const discoveryResultsCount = discoveryResults.length;
    
    // Extract IDs in order
    const discoveryTestIds = discoveryTestResults.map(r => r._id);
    const discoveryIds = discoveryResults.map(r => r._id);
    
    // Check if results are null (empty)
    const discoveryTestIsNull = discoveryTestResultsCount === 0;
    const discoveryIsNull = discoveryResultsCount === 0;
    
    // Check IDs ordering with detailed comparison
    const idsOrderComparison = compareIdsOrder(discoveryTestIds, discoveryIds);
    
    // Extract parentGenre info
    const discoveryTestReadIds = [];
    const discoveryTestRheingoldIds = [];
    const discoveryReadIds = [];
    const discoveryRheingoldIds = [];
    
    discoveryTestResults.forEach(result => {
      if (result.parentGenre === null || result.parentGenre === undefined) {
        discoveryTestReadIds.push(result._id);
      } else if (String(result.parentGenre).toUpperCase() === 'RHEINGOLD') {
        discoveryTestRheingoldIds.push(result._id);
      }
    });
    
    discoveryResults.forEach(result => {
      if (result.parentGenre === null || result.parentGenre === undefined) {
        discoveryReadIds.push(result._id);
      } else if (String(result.parentGenre).toUpperCase() === 'RHEINGOLD') {
        discoveryRheingoldIds.push(result._id);
      }
    });
    
    comparisons.push({
      questionNumber: discoveryTest['Question Number'] || i + 1,
      question: discoveryTest['Question'] || '',
      discoveryTestIsNull,
      discoveryIsNull,
      discoveryTestResultsCount,
      discoveryResultsCount,
      discoveryTestIds: discoveryTestIds.join(','),
      discoveryIds: discoveryIds.join(','),
      idsOrderComparison,
      discoveryTestReadIds: discoveryTestReadIds.join(','),
      discoveryTestRheingoldIds: discoveryTestRheingoldIds.join(','),
      discoveryReadIds: discoveryReadIds.join(','),
      discoveryRheingoldIds: discoveryRheingoldIds.join(',')
    });
  }
  
  // Generate CSV report
  const reportsDir = path.join(__dirname, '../reports');
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const csvFile = path.join(reportsDir, `comparison-report-${timestamp}.csv`);
  
  const headers = [
    'Question Number',
    'Question',
    'DiscoveryTest Is Null',
    'Discovery Is Null',
    'DiscoveryTest Results Count',
    'Discovery Results Count',
    'DiscoveryTest IDs (in order)',
    'Discovery IDs (in order)',
    'IDs Same Order',
    'DiscoveryTest READ IDs',
    'Discovery READ IDs',
    'DiscoveryTest Rheingold IDs',
    'Discovery Rheingold IDs'
  ];
  
  // Helper function to quote CSV fields that contain commas
  const quoteField = (value) => {
    if (!value || value === 'None') return value || 'None';
    // If field contains comma, quote it and escape internal quotes
    if (value.includes(',')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };
  
  const rows = comparisons.map(comp => {
    return [
      comp.questionNumber,
      `"${(comp.question || '').replace(/"/g, '""')}"`,
      comp.discoveryTestIsNull ? 'Yes' : 'No',
      comp.discoveryIsNull ? 'Yes' : 'No',
      comp.discoveryTestResultsCount,
      comp.discoveryResultsCount,
      quoteField(comp.discoveryTestIds || 'None'),
      quoteField(comp.discoveryIds || 'None'),
      `"${(comp.idsOrderComparison || '').replace(/"/g, '""')}"`,
      quoteField(comp.discoveryTestReadIds || 'None'),
      quoteField(comp.discoveryReadIds || 'None'),
      quoteField(comp.discoveryTestRheingoldIds || 'None'),
      quoteField(comp.discoveryRheingoldIds || 'None')
    ].join(',');
  });
  
  const csvContent = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(csvFile, csvContent);
  
  // Summary statistics
  const summary = {
    totalQuestions: comparisons.length,
    idsSameOrder: comparisons.filter(c => c.idsOrderComparison && c.idsOrderComparison.startsWith('Yes')).length,
    discoveryNullResults: comparisons.filter(c => c.discoveryIsNull).length,
    discoveryTestNullResults: comparisons.filter(c => c.discoveryTestIsNull).length,
    bothNull: comparisons.filter(c => c.discoveryIsNull && c.discoveryTestIsNull).length,
    oneNullOtherNot: comparisons.filter(c => 
      (c.discoveryIsNull && !c.discoveryTestIsNull) || 
      (!c.discoveryIsNull && c.discoveryTestIsNull)
    ).length
  };
  
  console.log('\n📊 Summary:');
  console.log(`Total Questions: ${summary.totalQuestions}`);
  console.log(`IDs Same Order: ${summary.idsSameOrder}/${summary.totalQuestions}`);
  console.log(`Discovery Null Results: ${summary.discoveryNullResults}`);
  console.log(`DiscoveryTest Null Results: ${summary.discoveryTestNullResults}`);
  console.log(`Both Null: ${summary.bothNull}`);
  console.log(`One Null, Other Not: ${summary.oneNullOtherNot}`);
  console.log(`\n✅ Comparison report saved: ${csvFile}`);
}

// Run comparison
compareReports().catch(console.error);
