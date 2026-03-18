//compare the latest discoveryTest runs
//and save the report to a file
//the report should include the following:
//- the latest run
//- the previous run
//- the genre distribution
//- the response time
//- the zero-result questions
//- the total POCs
//- the POCs per question
//- the per-question response time
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findLatestReports(queryType) {
  const reportsDir = path.join(__dirname, '../reports');
  const files = fs.readdirSync(reportsDir);
  const jsonFiles = files
    .filter(file => file.startsWith(`${queryType}-report-`) && file.endsWith('.json'))
    .sort()
    .reverse();
  return jsonFiles.map(f => path.join(reportsDir, f));
}

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getGenreDistribution(data) {
  const genres = {};
  data.forEach(r => {
    (r.results || []).forEach(p => {
      const g = p.parentGenre === null || p.parentGenre === undefined ? 'READ' : p.parentGenre;
      genres[g] = (genres[g] || 0) + 1;
    });
  });
  return genres;
}

async function compareDiscoveryTestRuns() {
  console.log('🔍 Comparing latest discoveryTest runs...\n');

  const reports = findLatestReports('discoveryTest');
  if (reports.length < 2) {
    console.error('❌ Need at least 2 discoveryTest reports');
    process.exit(1);
  }

  const latestPath = reports[0];
  const previousPath = reports[1];
  const latestName = path.basename(latestPath, '.json').replace('discoveryTest-report-', '');
  const previousName = path.basename(previousPath, '.json').replace('discoveryTest-report-', '');

  const latest = loadJSON(latestPath);
  const previous = loadJSON(previousPath);

  console.log(`Latest:  ${latestName}`);
  console.log(`Previous: ${previousName}\n`);

  // Genre distribution
  const latestGenres = getGenreDistribution(latest);
  const prevGenres = getGenreDistribution(previous);

  const allGenres = new Set([...Object.keys(latestGenres), ...Object.keys(prevGenres)]);

  // Response times
  const latestTimes = latest.map(r => r.responseTime || 0).filter(Boolean);
  const prevTimes = previous.map(r => r.responseTime || 0).filter(Boolean);
  const avgLatest = latestTimes.reduce((a, b) => a + b, 0) / latest.length;
  const avgPrev = prevTimes.reduce((a, b) => a + b, 0) / previous.length;

  // Zero-result
  const latestZero = latest.filter(r => !r.results || r.results.length === 0);
  const prevZero = previous.filter(r => !r.results || r.results.length === 0);

  // Total POCs
  const latestTotal = latest.reduce((s, r) => s + (r.results?.length || 0), 0);
  const prevTotal = previous.reduce((s, r) => s + (r.results?.length || 0), 0);

  // Per-question response times (matched by index)
  const perQuestionResponseTime = latest.map((r, i) => {
    const q = r.question || previous[i]?.question || `Question ${i + 1}`;
    const latestMs = r.responseTime ?? null;
    const prevMs = previous[i]?.responseTime ?? null;
    const change = (latestMs != null && prevMs != null) ? prevMs - latestMs : null;
    return {
      questionNumber: i + 1,
      question: q,
      responseTimeLatest: latestMs,
      responseTimePrevious: prevMs,
      change: change != null ? (change >= 0 ? `-${change}ms` : `+${-change}ms`) : null
    };
  });

  // Output report
  const report = {
    latest: latestName,
    previous: previousName,
    genreComparison: {},
    responseTime: {
      latest: { avg: Math.round(avgLatest), min: Math.min(...latestTimes), max: Math.max(...latestTimes) },
      previous: { avg: Math.round(avgPrev), min: Math.min(...prevTimes), max: Math.max(...prevTimes) },
      improvement: ((avgPrev - avgLatest) / avgPrev * 100).toFixed(1) + '%'
    },
    zeroResult: { latest: latestZero.length, previous: prevZero.length, latestQuestions: latestZero.map(r => r.question) },
    totalPOCs: { latest: latestTotal, previous: prevTotal },
    pocsPerQuestion: { latest: (latestTotal / latest.length).toFixed(1), previous: (prevTotal / previous.length).toFixed(1) },
    perQuestionResponseTime
  };

  for (const g of [...allGenres].sort()) {
    report.genreComparison[g] = {
      latest: latestGenres[g] || 0,
      previous: prevGenres[g] || 0
    };
  }

  const reportsDir = path.join(__dirname, '../reports');
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const jsonPath = path.join(reportsDir, `discoveryTest-comparison-${timestamp}.json`);
  const csvPath = path.join(reportsDir, `discoveryTest-comparison-${timestamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`✅ JSON saved: ${jsonPath}`);

  // CSV: summary rows
  const csvRows = [
    ['Metric', 'Latest', 'Previous', 'Change'],
    ['Latest run', report.latest, '', ''],
    ['Previous run', '', report.previous, ''],
    ['', '', '', ''],
    ['Response time avg (ms)', report.responseTime.latest.avg, report.responseTime.previous.avg, report.responseTime.improvement + ' faster'],
    ['Response time min (ms)', report.responseTime.latest.min, report.responseTime.previous.min, ''],
    ['Response time max (ms)', report.responseTime.latest.max, report.responseTime.previous.max, ''],
    ['', '', '', ''],
    ['Zero-result questions', report.zeroResult.latest, report.zeroResult.previous, ''],
    ['Total POCs', report.totalPOCs.latest, report.totalPOCs.previous, ''],
    ['POCs per question', report.pocsPerQuestion.latest, report.pocsPerQuestion.previous, ''],
    ['', '', '', ''],
    ['Genre', 'Latest', 'Previous', 'Change']
  ];
  for (const [g, v] of Object.entries(report.genreComparison)) {
    const change = v.latest - v.previous;
    csvRows.push([g, v.latest, v.previous, (change >= 0 ? '+' : '') + change]);
  }
  csvRows.push(['', '', '', '']);
  csvRows.push(['Question #', 'Question', 'Response Time Latest (ms)', 'Response Time Previous (ms)', 'Change']);
  for (const row of report.perQuestionResponseTime) {
    csvRows.push([row.questionNumber, row.question, row.responseTimeLatest ?? '', row.responseTimePrevious ?? '', row.change ?? '']);
  }
  const csvContent = csvRows.map(row => row.map(c => {
    const s = String(c ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  fs.writeFileSync(csvPath, csvContent);
  console.log(`✅ CSV saved: ${csvPath}\n`);

  // Console summary
  console.log('=== Genre distribution ===');
  for (const [g, v] of Object.entries(report.genreComparison)) {
    const change = (v.latest - v.previous);
    const sign = change > 0 ? '+' : '';
    console.log(`  ${g}: latest ${v.latest}, previous ${v.previous} (${sign}${change})`);
  }
  console.log('\n=== Response time ===');
  console.log(`  Latest avg: ${report.responseTime.latest.avg}ms`);
  console.log(`  Previous avg: ${report.responseTime.previous.avg}ms`);
  console.log(`  Improvement: ${report.responseTime.improvement} faster`);
  console.log('\n=== Zero-result questions ===');
  console.log(`  Latest: ${report.zeroResult.latest}`);
  console.log(`  Previous: ${report.zeroResult.previous}`);
  if (report.zeroResult.latestQuestions.length) {
    report.zeroResult.latestQuestions.forEach(q => console.log(`    - ${q}`));
  }
  console.log('\n=== POCs ===');
  console.log(`  Latest total: ${report.totalPOCs.latest} (${report.pocsPerQuestion.latest} avg/question)`);
  console.log(`  Previous total: ${report.totalPOCs.previous} (${report.pocsPerQuestion.previous} avg/question)`);

  return report;
}

compareDiscoveryTestRuns().catch(console.error);
