/**
 * Analyse multi-run output for ONE question: POC scores side-by-side across runs.
 *
 * Prereq: reports/multi-run-* from npm run run-multi-api-test.
 * Edit QUESTION in this file to match the question you want to analyse.
 *
 * Alias: npm run compare-one-question → same script (legacy name).
 *
 * See README.md → "analyze-multi-run-one-question".
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUESTION = 'What is the difference between REST and GraphQL?';

function escapeCsv(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

function getQuestionData(data, q) {
  const entry = data.find(e => e.question === q);
  return new Map((entry?.results || []).map(r => [r._id, r.score]));
}

function main() {
  const runDir = process.argv[2] || (() => {
    const reportsDir = path.join(__dirname, '../reports');
    const dirs = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('multi-run-'))
      .sort()
      .reverse();
    return dirs.length ? path.join(reportsDir, dirs[0]) : null;
  })();

  if (!runDir || !fs.existsSync(runDir)) {
    console.error('❌ No multi-run folder found. Run: npm run run-multi-api-test');
    process.exit(1);
  }

  const origPath = path.join(runDir, 'run-original.json');
  const origPathAlt = path.join(runDir, 'run-1.json');
  const origFile = fs.existsSync(origPath) ? origPath : (fs.existsSync(origPathAlt) ? origPathAlt : null);
  if (!origFile) {
    console.error(`❌ No run-original.json or run-1.json in ${runDir}. Run: npm run run-multi-api-test`);
    process.exit(1);
  }

  const runFiles = [];
  for (let i = 2; i <= 4; i++) {
    const p = path.join(runDir, `run-${i}.json`);
    if (fs.existsSync(p)) runFiles.push({ name: `run-${i}`, path: p });
  }
  if (runFiles.length === 0) {
    console.error(`❌ No run-2.json, run-3.json, or run-4.json in ${runDir}. Run: npm run run-multi-api-test`);
    process.exit(1);
  }

  const original = JSON.parse(fs.readFileSync(origFile, 'utf-8'));
  const origMap = getQuestionData(original, QUESTION);
  const runMaps = runFiles.map(({ path: p }) => getQuestionData(JSON.parse(fs.readFileSync(p, 'utf-8')), QUESTION));

  const allPocs = new Set([...origMap.keys(), ...runMaps.flatMap(m => [...m.keys()])]);

  const headers = ['POC', 'score_original', ...runFiles.map(r => `score_${r.name}`), 'notes'];
  const rows = [headers];
  const MIN_DIFF = 0.001;
  const isChanged = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) >= MIN_DIFF;

  for (const poc of [...allPocs].sort()) {
    const s0 = origMap.get(poc);
    const runScores = runMaps.map(m => m.get(poc));
    const scores = [s0, ...runScores];
    const has = scores.map(s => s !== undefined);
    const notes = [];

    if (!has[0]) notes.push(`added_in_${runFiles[0]?.name || 'run2'}`);
    else if (has.slice(1).every(h => !h)) notes.push('removed_in_all');
    else runFiles.forEach((r, i) => { if (!has[i + 1]) notes.push(`removed_${r.name}`); });

    runFiles.forEach((r, i) => {
      if (has[0] && has[i + 1] && isChanged(s0, runScores[i])) notes.push(`score_changed_${r.name}`);
    });

    const fmt = s => (typeof s === 'number' ? s.toFixed(5) : '-');
    rows.push([poc, fmt(s0), ...runScores.map(fmt), notes.join('; ')]);
  }

  const slug = QUESTION.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const csvPath = path.join(runDir, `compare-${slug}-pocs.csv`);
  fs.writeFileSync(csvPath, rows.map(r => r.map(escapeCsv).join(',')).join('\n'));

  console.log(`\n✅ CSV saved: ${csvPath}`);
  console.log(`   Question: ${QUESTION}`);
  console.log(`   ${rows.length - 1} POCs compared\n`);
}

main();
