/**
 * Builds fixtures/questions-multilang.json from:
 *   - fixtures/questions.json (English, 103 lines)
 *   - fixtures/de.txt (German, 103 lines — same order)
 *   - fixtures/nl.txt (Dutch, 103 lines — same order)
 *
 * Output: each row i uses lang = en|de|nl in rotation and text from the matching language line.
 *
 * Usage: node scripts/compose-multilang.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readLines(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

const en = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/questions.json'), 'utf-8'));
const de = readLines(path.join(root, 'fixtures/de.txt'));
const nl = readLines(path.join(root, 'fixtures/nl.txt'));

if (de.length !== en.length || nl.length !== en.length) {
  console.error(`Line count mismatch: en=${en.length} de=${de.length} nl=${nl.length}`);
  process.exit(1);
}

const langs = ['en', 'de', 'nl'];
const out = en.map((_, i) => {
  const lang = langs[i % 3];
  const text = lang === 'en' ? en[i] : lang === 'de' ? de[i] : nl[i];
  return { lang, text };
});

const outPath = path.join(root, 'fixtures/questions-multilang.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.log(`Wrote ${out.length} rows → ${outPath}`);
