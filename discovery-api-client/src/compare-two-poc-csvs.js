// Compare two POC CSVs (1.5K vs 3K) for the same question + optional LLM answers
// Usage: node src/compare-two-poc-csvs.js <file-1.5k.csv> <file-3k.csv> [answer-1.5k.txt] [answer-3k.txt]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCsvLine(line) {
  const vals = [];
  let cur = '';
  let inQuote = false;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) { vals.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else cur += c;
  }
  vals.push(cur.trim().replace(/^"|"$/g, ''));
  return vals;
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function extractCitedPocs(text) {
  if (!text) return [];
  const re = /\]\(([a-zA-Z0-9]{16,24})\)\{/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

function getPocScoreMap(rows, headers) {
  const map = new Map();
  const pocCol = headers.find(h => /^poc$|^_id$|^id$/i.test(h)) || headers[0];
  const scoreCol = headers.find(h => /score_original|^score$/i.test(h)) || headers.find(h => /score/i.test(h)) || headers[1];
  for (const row of rows) {
    const poc = row[pocCol];
    const score = parseFloat(row[scoreCol]);
    if (poc) map.set(poc, isNaN(score) ? null : score);
  }
  return map;
}

function main() {
  const file1 = process.argv[2];
  const file2 = process.argv[3];
  if (!file1 || !file2) {
    console.error('Usage: node compare-two-poc-csvs.js <1.5k.csv> <3k.csv> [answer-1.5k.txt] [answer-3k.txt]');
    process.exit(1);
  }
  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    console.error('File not found');
    process.exit(1);
  }

  const { headers: h1, rows: rows1 } = parseCsv(file1);
  const { headers: h2, rows: rows2 } = parseCsv(file2);
  const map1 = getPocScoreMap(rows1, h1);
  const map2 = getPocScoreMap(rows2, h2);

  const pocs1 = new Set(map1.keys());
  const pocs2 = new Set(map2.keys());
  const inBoth = [...pocs1].filter(p => pocs2.has(p));
  const only1 = [...pocs1].filter(p => !pocs2.has(p));
  const only2 = [...pocs2].filter(p => !pocs1.has(p));

  const MIN_DIFF = 0.001;
  const scoreDiffs = inBoth
    .filter(p => map1.get(p) != null && map2.get(p) != null)
    .map(p => ({ poc: p, s1: map1.get(p), s2: map2.get(p), diff: Math.abs(map1.get(p) - map2.get(p)) }))
    .filter(d => d.diff >= MIN_DIFF)
    .sort((a, b) => b.diff - a.diff);

  const vec1 = [...map1.values()].filter(v => v != null && v >= 0 && v <= 1);
  const vec2 = [...map2.values()].filter(v => v != null && v >= 0 && v <= 1);
  const range1 = vec1.length ? { min: Math.min(...vec1), max: Math.max(...vec1) } : null;
  const range2 = vec2.length ? { min: Math.min(...vec2), max: Math.max(...vec2) } : null;

  console.log('\n=== 1.5K vs 3K POC Comparison ===\n');
  console.log('1.5K: ' + path.basename(file1));
  console.log('3K:   ' + path.basename(file2));
  console.log('');
  console.log('POC counts: 1.5K=' + pocs1.size + ', 3K=' + pocs2.size);
  console.log('In both: ' + inBoth.length);
  console.log('Only in 1.5K: ' + only1.length);
  console.log('Only in 3K: ' + only2.length);
  console.log('');
  if (range1) console.log('1.5K vector score range: min=' + range1.min.toFixed(4) + ', max=' + range1.max.toFixed(4));
  if (range2) console.log('3K vector score range:   min=' + range2.min.toFixed(4) + ', max=' + range2.max.toFixed(4));
  console.log('');
  if (scoreDiffs.length > 0) {
    console.log('POCs with score diff >= 0.001 (' + scoreDiffs.length + '):');
    scoreDiffs.slice(0, 15).forEach(d => {
      console.log('  ' + d.poc + '  1.5K=' + d.s1.toFixed(4) + '  3K=' + d.s2.toFixed(4) + '  diff=' + d.diff.toFixed(4));
    });
    if (scoreDiffs.length > 15) console.log('  ... and ' + (scoreDiffs.length - 15) + ' more');
  } else {
    console.log('No POCs with score diff >= 0.001');
  }
  if (only2.length > 0) {
    console.log('');
    console.log('Only in 3K (' + only2.length + '): ' + only2.slice(0, 5).join(', ') + (only2.length > 5 ? '...' : ''));
  }
  if (only1.length > 0) {
    console.log('');
    console.log('Only in 1.5K (' + only1.length + '): ' + only1.slice(0, 5).join(', ') + (only1.length > 5 ? '...' : ''));
  }

  const outDir = path.join(__dirname, '../reports');
  const outPath = path.join(outDir, 'compare-1.5k-vs-3k-' + Date.now() + '.csv');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outRows = [['POC', 'score_1.5K', 'score_3K', 'diff', 'note']];
  const allPocs = new Set([...map1.keys(), ...map2.keys()]);
  for (const p of [...allPocs].sort()) {
    const s1 = map1.get(p);
    const s2 = map2.get(p);
    const d = (s1 != null && s2 != null) ? Math.abs(s1 - s2) : null;
    let note = '';
    if (!pocs2.has(p)) note = 'only_1.5K';
    else if (!pocs1.has(p)) note = 'only_3K';
    else if (d != null && d >= MIN_DIFF) note = 'score_diff';
    outRows.push([p, s1 != null ? s1.toFixed(5) : '-', s2 != null ? s2.toFixed(5) : '-', d != null ? d.toFixed(5) : '-', note]);
  }
  fs.writeFileSync(outPath, outRows.map(r => r.join(',')).join('\n'));
  console.log('');
  console.log('CSV saved: ' + outPath);

  const ans15kFile = process.argv[4];
  const ans3kFile = process.argv[5];
  if (ans15kFile && ans3kFile && fs.existsSync(ans15kFile) && fs.existsSync(ans3kFile)) {
    const ans15k = fs.readFileSync(ans15kFile, 'utf-8');
    const ans3k = fs.readFileSync(ans3kFile, 'utf-8');
    const cited15k = extractCitedPocs(ans15k);
    const cited3k = extractCitedPocs(ans3k);
    const citedBoth = cited15k.filter(p => cited3k.includes(p));
    const only15k = cited15k.filter(p => !cited3k.includes(p));
    const only3k = cited3k.filter(p => !cited15k.includes(p));
    console.log('\n=== LLM Answer Comparison ===\n');
    console.log('1.5K answer: ' + path.basename(ans15kFile) + ' (' + ans15k.length + ' chars)');
    console.log('3K answer:   ' + path.basename(ans3kFile) + ' (' + ans3k.length + ' chars)');
    console.log('Cited POCs: 1.5K=' + cited15k.length + ', 3K=' + cited3k.length);
    console.log('Cited in both: ' + citedBoth.length);
    console.log('Cited only in 1.5K: ' + only15k.length + (only15k.length ? ' (' + only15k.slice(0, 5).join(', ') + (only15k.length > 5 ? '...' : '') + ')' : ''));
    console.log('Cited only in 3K: ' + only3k.length + (only3k.length ? ' (' + only3k.slice(0, 5).join(', ') + (only3k.length > 5 ? '...' : '') + ')' : ''));
    const ansOutPath = path.join(outDir, 'compare-1.5k-vs-3k-answers-' + Date.now() + '.txt');
    fs.writeFileSync(ansOutPath, '=== 1.5K ANSWER ===\n\n' + ans15k.slice(0, 4000) + (ans15k.length > 4000 ? '\n\n[... truncated]' : '') + '\n\n=== 3K ANSWER ===\n\n' + ans3k.slice(0, 4000) + (ans3k.length > 4000 ? '\n\n[... truncated]' : ''));
    console.log('\nAnswers saved: ' + ansOutPath);
  }
  console.log('');
}

main();
