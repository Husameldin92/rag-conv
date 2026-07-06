/**
 * BACKEND-1603 QA — schema introspection (read-only).
 *
 * Introspects the PROD GraphQL schema for the `preDiscovery` and `discovery`
 * Query fields, every argument (name / type / required), and the `restriction`
 * enum's values. Confirms whether POC_ONLY / pocIds / preDiscovery actually
 * exist on prod before we run any live queries.
 *
 * New file added for the BACKEND-1603 verification — does not touch existing scripts.
 * Reuses index.js's fetch + `access-token` header pattern.
 *
 * Usage: node src/poc-introspect.js
 */
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

async function gql(query) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.substring(0, 400)}`);
  }
  return res.json();
}

// Render a GraphQL type ref (handles NON_NULL / LIST wrappers) into SDL-ish text.
function typeStr(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeStr(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeStr(t.ofType)}]`;
  return t.name;
}

function isRequired(t) {
  return t && t.kind === 'NON_NULL';
}

const FIELD_INTROSPECTION = `
query IntrospectQueryFields {
  __schema {
    queryType { name }
  }
  __type(name: "Query") {
    fields {
      name
      description
      args {
        name
        description
        defaultValue
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      type { kind name ofType { kind name ofType { kind name } } }
    }
  }
}`;

function enumIntrospection(name) {
  return `
query IntrospectEnum {
  __type(name: "${name}") {
    name
    kind
    enumValues(includeDeprecated: true) { name description isDeprecated }
  }
}`;
}

(async () => {
  console.log(`📡 Endpoint: ${GRAPHQL_ENDPOINT}`);
  console.log(`🔐 Auth: ${process.env.AUTH_TOKEN ? 'access-token header set' : 'NONE'}\n`);

  const out = { endpoint: GRAPHQL_ENDPOINT, capturedAt: new Date().toISOString(), fields: {}, enums: {}, errors: [] };

  // 1. Query-type fields
  const fieldsResp = await gql(FIELD_INTROSPECTION);
  if (fieldsResp.errors) {
    console.error('GraphQL errors on field introspection:', JSON.stringify(fieldsResp.errors, null, 2));
    out.errors.push({ stage: 'fields', errors: fieldsResp.errors });
  }
  const queryFields = fieldsResp.data?.__type?.fields || [];
  const targets = ['preDiscovery', 'discovery', 'discoveryTest', 'preDiscoveryTest', 'chunks'];

  for (const fname of targets) {
    const f = queryFields.find((x) => x.name === fname);
    if (!f) {
      console.log(`❌ Query.${fname} — NOT FOUND on prod schema`);
      out.fields[fname] = { present: false };
      continue;
    }
    console.log(`\n✅ Query.${fname}: ${typeStr(f.type)}`);
    const args = (f.args || []).map((a) => ({
      name: a.name,
      type: typeStr(a.type),
      required: isRequired(a.type),
      defaultValue: a.defaultValue ?? null,
    }));
    for (const a of args) {
      console.log(`     - ${a.name}: ${a.type}${a.required ? '  (REQUIRED)' : ''}${a.defaultValue != null ? `  = ${a.defaultValue}` : ''}`);
    }
    out.fields[fname] = { present: true, returnType: typeStr(f.type), args };
  }

  // 2. Find the restriction enum type name from any target field's `restriction` arg.
  let restrictionEnumName = null;
  for (const fname of targets) {
    const f = queryFields.find((x) => x.name === fname);
    const ra = f?.args?.find((a) => a.name === 'restriction');
    if (ra) {
      // unwrap NON_NULL/LIST to find the named enum
      let t = ra.type;
      while (t && !t.name && t.ofType) t = t.ofType;
      restrictionEnumName = t?.name || null;
      if (restrictionEnumName) break;
    }
  }

  if (restrictionEnumName) {
    const enumResp = await gql(enumIntrospection(restrictionEnumName));
    const vals = enumResp.data?.__type?.enumValues || [];
    console.log(`\n🎚  restriction enum (${restrictionEnumName}) values: ${vals.map((v) => v.name).join(', ')}`);
    out.enums[restrictionEnumName] = vals.map((v) => v.name);
    out.restrictionEnumName = restrictionEnumName;
  } else {
    console.log('\n⚠️  Could not locate a `restriction` argument on any target field.');
  }

  // 3. Save raw introspection report
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `poc-introspect-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary: out, raw: { fields: fieldsResp.data } }, null, 2));
  console.log(`\n💾 Saved: ${outPath}`);

  // 4. Verdict on the three open unknowns
  console.log('\n=== GATE CHECK ===');
  const pre = out.fields.preDiscovery;
  const disc = out.fields.discovery;
  const hasPocOnly = restrictionEnumName && (out.enums[restrictionEnumName] || []).includes('POC_ONLY');
  const preHasPocIds = pre?.present && pre.args?.some((a) => a.name === 'pocIds');
  const discHasPocIds = disc?.present && disc.args?.some((a) => a.name === 'pocIds');
  console.log(`preDiscovery present:        ${pre?.present ? 'YES' : 'NO'}`);
  console.log(`discovery present:           ${disc?.present ? 'YES' : 'NO'}`);
  console.log(`POC_ONLY enum value:         ${hasPocOnly ? 'YES' : 'NO'}`);
  console.log(`preDiscovery has pocIds arg: ${preHasPocIds ? 'YES' : 'NO'}`);
  console.log(`discovery has pocIds arg:    ${discHasPocIds ? 'YES' : 'NO'}`);
  if (!(pre?.present && hasPocOnly && (preHasPocIds || discHasPocIds))) {
    console.log('\n🛑 GATE FAILED — PR feature surface not fully present on prod. STOP and report.');
  } else {
    console.log('\n🟢 GATE PASSED — feature surface present on prod. Proceed to live queries.');
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
