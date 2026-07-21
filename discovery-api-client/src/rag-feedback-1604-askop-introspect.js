/**
 * BACKEND-1604 QA — pinpoint the RAG-ask op that mints a turn + returns a ragUsageId (READ-ONLY).
 * Dumps args + full return-type fields for candidate ops, and the AccessRagResponse shape.
 * Usage: node src/rag-feedback-1604-askop-introspect.js
 */
import dotenv from 'dotenv';
dotenv.config();
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { 'access-token': process.env.AUTH_TOKEN } : {}) });
async function gql(query) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query }) });
  return JSON.parse(await r.text());
}
const typeStr = (t) => !t ? '?' : t.kind === 'NON_NULL' ? `${typeStr(t.ofType)}!` : t.kind === 'LIST' ? `[${typeStr(t.ofType)}]` : t.name;
const namedType = (t) => { let x = t; while (x && !x.name && x.ofType) x = x.ofType; return x?.name || null; };

const CANDIDATE_OPS = ['AskFrankBot', 'askFrankSearch', 'advancedRetrieval', 'retrieval', 'elevateRetrieval', 'discover', 'discovery', 'preDiscovery', 'userRagAccess', 'userRags', 'turns'];
const RESULT_TYPES = ['AskFrankBotResult', 'AskFrankSearchResult', 'AccessRagResponse'];

const TYPEREF = `kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;
const OP_Q = `query { __type(name: "Query") { fields { name args { name type { ${TYPEREF} } } type { ${TYPEREF} } } } }`;
const objQ = (n) => `query { __type(name: "${n}") { name kind fields { name type { ${TYPEREF} } } inputFields { name type { ${TYPEREF} } } enumValues { name } } }`;

(async () => {
  const qfields = (await gql(OP_Q)).data.__type.fields;
  console.log('=== candidate op signatures ===');
  const found = {};
  for (const opName of CANDIDATE_OPS) {
    const f = qfields.find((x) => x.name === opName);
    if (!f) { console.log(`   ${opName}: (not on Query)`); continue; }
    const args = (f.args || []).map((a) => `${a.name}: ${typeStr(a.type)}`);
    console.log(`\n   ${opName}(${args.join(', ')}): ${typeStr(f.type)}`);
    found[opName] = namedType(f.type);
  }

  // dump each op's return object fields + explicitly named result types, hunting for a ragUsageId / RagUsage / _id turn.
  const seen = new Set();
  const dumpType = async (name, why) => {
    if (!name || seen.has(name)) return; seen.add(name);
    const t = (await gql(objQ(name))).data?.__type;
    if (!t) return;
    console.log(`\n--- ${name} (${t.kind})${why ? ' ['+why+']' : ''} ---`);
    for (const of of t.fields || []) {
      const flag = /ragusage|usageid/i.test(of.name) || /ragusage/i.test(namedType(of.type) || '') ? '   ⭐ ID-BEARING' : '';
      console.log(`   out ${of.name}: ${typeStr(of.type)}${flag}`);
    }
    for (const inf of t.inputFields || []) console.log(`   in  ${inf.name}: ${typeStr(inf.type)}`);
    if (t.enumValues?.length) console.log(`   enum: ${t.enumValues.map((v) => v.name).join(', ')}`);
  };

  console.log('\n\n=== return-type shapes ===');
  for (const name of new Set([...Object.values(found), ...RESULT_TYPES])) await dumpType(name, 'return');
  // one level deeper for nested object fields that might carry the id
  for (const name of [...seen]) {
    const t = (await gql(objQ(name))).data?.__type;
    for (const of of t?.fields || []) {
      const nm = namedType(of.type);
      if (nm && !seen.has(nm) && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(nm)) await dumpType(nm, `nested under ${name}.${of.name}`);
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
