/**
 * BACKEND-1604 QA — schema introspection (READ-ONLY, no writes).
 *
 * Goal: understand the `submitRagUsageFeedback` mutation before we submit anything.
 *   - the mutation's input shape (ragUsageId / rating enum / comment) + return type
 *   - whether the input carries a reason / reasons / reasonChips field (story §5 chips)
 *   - the RAG-ask op that CREATES a turn and returns a `ragUsageId`
 *     (discovery/advancedRetrieval return POC results but no turn id)
 *   - any read-back query to read a stored rating/comment (persistence check)
 *
 * Native fetch (Node v26 — node-fetch hangs here). `.env` AUTH_TOKEN -> `access-token` header.
 * Usage: node src/rag-feedback-1604-introspect.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  return h;
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (_) {}
  return { status: res.status, json: j, raw: txt };
}

// Unwrap NON_NULL/LIST wrappers to SDL-ish text.
function typeStr(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeStr(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeStr(t.ofType)}]`;
  return t.name;
}
function namedType(t) {
  let x = t;
  while (x && !x.name && x.ofType) x = x.ofType;
  return x?.name || null;
}

// Full introspection query (standard shape, trimmed to what we need).
const FULL = `
query FullIntrospect {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args { name description defaultValue type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields {
        name
        description
        defaultValue
        type { ...TypeRef }
      }
      enumValues(includeDeprecated: true) { name description isDeprecated }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

function printField(f, indent = '     ') {
  const args = (f.args || []).map((a) => `${a.name}: ${typeStr(a.type)}${a.defaultValue != null ? ` = ${a.defaultValue}` : ''}`);
  console.log(`${indent}${f.name}(${args.join(', ')}): ${typeStr(f.type)}`);
}

(async () => {
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 access-token: ${process.env.AUTH_TOKEN ? 'set' : 'NONE'}\n`);

  const { status, json, raw } = await gql(FULL);
  if (!json?.data?.__schema) {
    console.error(`Introspection failed. HTTP ${status}. Raw: ${raw.slice(0, 500)}`);
    process.exit(1);
  }
  const schema = json.data.__schema;
  const types = schema.types;
  const byName = Object.fromEntries(types.map((t) => [t.name, t]));
  const queryType = byName[schema.queryType?.name];
  const mutationType = byName[schema.mutationType?.name];

  const out = {
    capturedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    queryTypeName: schema.queryType?.name,
    mutationTypeName: schema.mutationType?.name,
    submitMutation: null,
    inputType: null,
    ratingEnum: null,
    reasonChipsField: null,
    askOpsThatYieldRagUsageId: [],
    readBackPaths: [],
    relatedTypes: [],
  };

  // 1) The submit mutation
  console.log('=== 1) Mutation.submitRagUsageFeedback ===');
  const submit = (mutationType?.fields || []).find((f) => f.name === 'submitRagUsageFeedback');
  if (!submit) {
    console.log('❌ submitRagUsageFeedback NOT found on Mutation.');
  } else {
    printField(submit, '   ');
    out.submitMutation = {
      name: submit.name,
      returnType: typeStr(submit.type),
      args: (submit.args || []).map((a) => ({ name: a.name, type: typeStr(a.type), inputTypeName: namedType(a.type) })),
    };
    // input object of the (likely single) `feedback` arg
    for (const a of submit.args || []) {
      const inName = namedType(a.type);
      const inType = byName[inName];
      if (inType?.inputFields?.length) {
        console.log(`\n   input arg "${a.name}" -> input object ${inName}:`);
        const fields = inType.inputFields.map((inf) => ({
          name: inf.name, type: typeStr(inf.type), required: inf.type?.kind === 'NON_NULL',
          enumName: byName[namedType(inf.type)]?.kind === 'ENUM' ? namedType(inf.type) : null,
        }));
        for (const inf of fields) console.log(`      - ${inf.name}: ${inf.type}${inf.required ? '  (REQUIRED)' : ''}`);
        out.inputType = { name: inName, fields };
        // reason chips?
        const chip = fields.find((x) => /reason|chip/i.test(x.name));
        out.reasonChipsField = chip || null;
        // rating enum values
        const ratingField = fields.find((x) => /rating/i.test(x.name));
        const ratingEnumName = ratingField ? namedType(inType.inputFields.find((z) => z.name === ratingField.name).type) : null;
        const ratingEnumType = ratingEnumName ? byName[ratingEnumName] : null;
        if (ratingEnumType?.enumValues) {
          out.ratingEnum = { name: ratingEnumName, values: ratingEnumType.enumValues.map((v) => v.name) };
          console.log(`\n   rating enum ${ratingEnumName}: ${out.ratingEnum.values.join(', ')}`);
        }
      }
    }
    // return type payload shape
    const retName = namedType(submit.type);
    const retType = byName[retName];
    if (retType?.fields?.length) {
      console.log(`\n   return type ${retName} fields:`);
      for (const rf of retType.fields) console.log(`      - ${rf.name}: ${typeStr(rf.type)}`);
      out.submitMutation.returnFields = retType.fields.map((rf) => ({ name: rf.name, type: typeStr(rf.type) }));
    }
  }

  // 2) reason chips verdict
  console.log('\n=== 2) reason-chips gap ===');
  if (out.reasonChipsField) console.log(`   ✅ input has a reason/chip field: ${out.reasonChipsField.name}: ${out.reasonChipsField.type}`);
  else console.log('   ⚠️  NO reason/reasons/reasonChips field on the mutation input — comment only. FLAG for dev.');

  // 3) Ask ops that yield a ragUsageId — scan Query + Mutation fields whose return object exposes a
  //    ragUsage-ish id field, or whose own name is chat/ask/rag-ish.
  console.log('\n=== 3) RAG-ask op(s) that could yield a ragUsageId ===');
  const idRe = /ragusage|usageid|raguse/i;
  function returnExposesRagUsageId(f) {
    const rt = byName[namedType(f.type)];
    if (!rt?.fields) return null;
    const hit = rt.fields.find((sf) => idRe.test(sf.name) || /ragusage/i.test(namedType(sf.type) || ''));
    return hit ? { onType: rt.name, viaField: hit.name, fieldType: typeStr(hit.type) } : null;
  }
  for (const [holderName, holder] of [['Query', queryType], ['Mutation', mutationType]]) {
    for (const f of holder?.fields || []) {
      const nameHit = /(^|[^a-z])(ask|chat|rag|answer|conversation|converse|message|prompt)/i.test(f.name);
      const retHit = returnExposesRagUsageId(f);
      if (nameHit || retHit) {
        printField(f, `   [${holderName}] `);
        if (retHit) {
          console.log(`        ↳ return ${retHit.onType} exposes id via: ${retHit.viaField}: ${retHit.fieldType}`);
        }
        out.askOpsThatYieldRagUsageId.push({
          holder: holderName, name: f.name, returnType: typeStr(f.type),
          args: (f.args || []).map((a) => ({ name: a.name, type: typeStr(a.type), required: a.type?.kind === 'NON_NULL' })),
          exposesRagUsageId: retHit,
        });
      }
    }
  }
  if (!out.askOpsThatYieldRagUsageId.length) console.log('   (none matched — will widen search below via related types)');

  // 4) Read-back paths — any Query field returning a RagUsage-ish type, or a type that has rating/comment fields.
  console.log('\n=== 4) read-back path(s) for stored rating/comment ===');
  for (const f of queryType?.fields || []) {
    const rtName = namedType(f.type);
    const rt = byName[rtName];
    const typeNameHit = /ragusage|feedback/i.test(rtName || '');
    const fieldHit = rt?.fields?.some((sf) => /^rating$|^comment$|feedback/i.test(sf.name));
    if (typeNameHit || fieldHit) {
      printField(f, '   [Query] ');
      out.readBackPaths.push({ name: f.name, returnType: typeStr(f.type), returnTypeName: rtName });
    }
  }
  if (!out.readBackPaths.length) console.log('   ⚠️  No obvious read-back query — persistence may be write-only via API.');

  // 5) Related types (name contains ragusage/feedback/rating/turn) — dump their shape for the handback.
  console.log('\n=== 5) related types ===');
  const relRe = /rag ?usage|feedback|rating|(^|[^a-z])turn/i;
  for (const t of types) {
    if (!t.name || t.name.startsWith('__')) continue;
    if (!relRe.test(t.name)) continue;
    out.relatedTypes.push(t.name);
    const kind = t.kind;
    console.log(`   • ${t.name} (${kind})`);
    if (t.inputFields?.length) for (const inf of t.inputFields) console.log(`        in  ${inf.name}: ${typeStr(inf.type)}`);
    if (t.fields?.length) for (const of of t.fields) console.log(`        out ${of.name}: ${typeStr(of.type)}`);
    if (t.enumValues?.length) console.log(`        enum: ${t.enumValues.map((v) => v.name).join(', ')}`);
  }

  // save raw + summary
  const dir = path.join(__dirname, '../reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(dir, `rag-feedback-1604-introspect-${stamp}.json`),
    JSON.stringify({ summary: out, rawTypes: types.filter((t) => out.relatedTypes.includes(t.name)) }, null, 2));
  // also dump the FULL schema type list (names only) to help widen search if needed
  fs.writeFileSync(path.join(dir, `rag-feedback-1604-typenames-${stamp}.json`),
    JSON.stringify({ query: (queryType?.fields || []).map((f) => f.name), mutation: (mutationType?.fields || []).map((f) => f.name), allTypeNames: types.map((t) => t.name) }, null, 2));
  console.log(`\n💾 Saved introspection reports to ../reports/ (stamp ${stamp})`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
