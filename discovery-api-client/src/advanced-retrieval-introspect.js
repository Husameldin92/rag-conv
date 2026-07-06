/**
 * BACKEND-1602 QA — schema introspection for `advancedRetrieval` (read-only, PRODUCTION).
 *
 * Introspects the Query field `advancedRetrieval`: every argument (name / type / required),
 * the `filter` INPUT_OBJECT type and its level0–level3 fields, and the full return type tree
 * (results, filter.levels[].items shape). Confirms field names match the ticket before any
 * live faceted queries are run (Task 1 / gate).
 *
 * New file for BACKEND-1602. Native fetch (node-fetch hangs on Node v26). access-token from .env.
 * Usage: node src/advanced-retrieval-introspect.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const TIMEOUT = 20000;

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

async function gql(query) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: c.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { httpStatus: r.status, json: j, raw: txt };
  } finally { clearTimeout(t); }
}

// Render a GraphQL type ref (handles NON_NULL / LIST wrappers) into SDL-ish text.
function typeStr(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeStr(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeStr(t.ofType)}]`;
  return t.name;
}
function isRequired(t) { return t && t.kind === 'NON_NULL'; }
// unwrap NON_NULL/LIST to find the underlying named type
function namedType(t) { let x = t; while (x && !x.name && x.ofType) x = x.ofType; return x?.name || null; }

const QUERY_FIELDS = `
query {
  __type(name: "Query") {
    fields {
      name
      args {
        name
        defaultValue
        type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      }
      type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
    }
  }
}`;

function typeIntrospection(name) {
  return `
query {
  __type(name: "${name}") {
    name
    kind
    description
    inputFields {
      name
      defaultValue
      type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
    }
    fields {
      name
      args { name type { kind name ofType { kind name ofType { kind name } } } }
      type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }
}`;
}

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token header set' : 'NONE'}\n`);

  const out = { endpoint: ENDPOINT, capturedAt: new Date().toISOString(), field: null, types: {}, errors: [] };

  // 1. advancedRetrieval Query field
  const fr = await gql(QUERY_FIELDS);
  if (fr.json?.errors) { out.errors.push({ stage: 'fields', errors: fr.json.errors }); console.error('GQL errors:', JSON.stringify(fr.json.errors).slice(0, 300)); }
  const fields = fr.json?.data?.__type?.fields || [];
  const ar = fields.find((x) => x.name === 'advancedRetrieval');
  if (!ar) {
    console.log('❌ Query.advancedRetrieval — NOT FOUND on prod schema');
    out.field = { present: false };
  } else {
    console.log(`✅ Query.advancedRetrieval: ${typeStr(ar.type)}`);
    const args = (ar.args || []).map((a) => ({ name: a.name, type: typeStr(a.type), required: isRequired(a.type), namedType: namedType(a.type), defaultValue: a.defaultValue ?? null }));
    for (const a of args) console.log(`     - ${a.name}: ${a.type}${a.required ? '  (REQUIRED)' : ''}`);
    out.field = { present: true, returnType: typeStr(ar.type), returnNamedType: namedType(ar.type), args };

    // 2. Drill into the named types we care about: the filter input, the return type, and nested types.
    const toIntrospect = new Set();
    for (const a of args) if (a.namedType) toIntrospect.add(a.namedType);
    if (out.field.returnNamedType) toIntrospect.add(out.field.returnNamedType);

    // BFS one extra level deep through input/output object fields so we capture
    // the filter input, the levels type, and the items type.
    const seen = new Set();
    const queue = [...toIntrospect];
    const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
    while (queue.length) {
      const tname = queue.shift();
      if (!tname || seen.has(tname) || SCALARS.has(tname)) continue;
      seen.add(tname);
      const tr = await gql(typeIntrospection(tname));
      const td = tr.json?.data?.__type;
      if (!td) continue;
      const rec = { kind: td.kind, description: td.description || null, inputFields: null, fields: null };
      if (td.inputFields) rec.inputFields = td.inputFields.map((f) => ({ name: f.name, type: typeStr(f.type), namedType: namedType(f.type), defaultValue: f.defaultValue ?? null }));
      if (td.fields) rec.fields = td.fields.map((f) => ({ name: f.name, type: typeStr(f.type), namedType: namedType(f.type) }));
      out.types[tname] = rec;
      // enqueue child named types (depth-limited by `seen`)
      for (const f of (rec.inputFields || [])) if (f.namedType) queue.push(f.namedType);
      for (const f of (rec.fields || [])) if (f.namedType) queue.push(f.namedType);
    }
  }

  // 3. Print the shapes we most care about
  console.log('\n=== KEY TYPE SHAPES ===');
  for (const [name, rec] of Object.entries(out.types)) {
    if (rec.inputFields) {
      console.log(`\ninput ${name} {`);
      for (const f of rec.inputFields) console.log(`  ${f.name}: ${f.type}`);
      console.log('}');
    } else if (rec.fields) {
      console.log(`\ntype ${name} {`);
      for (const f of rec.fields) console.log(`  ${f.name}: ${f.type}`);
      console.log('}');
    }
  }

  // 4. Save
  const dir = path.join(__dirname, '../reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(dir, `advanced-retrieval-introspect-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${p}`);

  // 5. Gate check — does the ticket's surface exist?
  console.log('\n=== GATE CHECK ===');
  const present = out.field?.present;
  const filterArg = out.field?.args?.find((a) => a.name === 'filter');
  const questionArg = out.field?.args?.find((a) => a.name === 'question');
  const filterType = filterArg ? out.types[filterArg.namedType] : null;
  const filterLevels = filterType?.inputFields?.map((f) => f.name) || [];
  console.log(`advancedRetrieval present:        ${present ? 'YES' : 'NO'}`);
  console.log(`question arg present:             ${questionArg ? 'YES (' + questionArg.type + ')' : 'NO'}`);
  console.log(`filter arg present:               ${filterArg ? 'YES (' + filterArg.type + ')' : 'NO'}`);
  console.log(`filter input fields:              ${filterLevels.join(', ') || '(none)'}`);
  const hasLevels = ['level0', 'level1', 'level2', 'level3'].every((l) => filterLevels.includes(l));
  console.log(`level0–level3 all present:        ${hasLevels ? 'YES' : 'NO'}`);
  if (present && questionArg && filterArg && hasLevels) console.log('\n🟢 GATE PASSED — advancedRetrieval surface present on prod. Proceed.');
  else console.log('\n🛑 GATE — surface differs from ticket. Review the type dump above.');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
