/**
 * BACKEND-1604 QA — de-risk "mint a turn" (low volume: 1 ask + stream + reads).
 * discovery(enableConversation:true) -> {userRagId, streamUrl}; consume streamUrl (drives answer +
 * persists the turn); then poll turns(userRagId) -> RagUsage._id (= ragUsageId), verify ownership.
 * Also dumps the raw stream head in case the ragUsageId is embedded there. No feedback writes here.
 * Usage: node src/rag-feedback-1604-mint-explore.js
 */
import dotenv from 'dotenv';
dotenv.config();
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { 'access-token': process.env.AUTH_TOKEN } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function myUserId() {
  const t = process.env.AUTH_TOKEN; if (!t) return null;
  try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).appUserId; } catch { return null; }
}
async function gql(query, variables) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query, variables }) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: r.status, json: j, raw: txt };
}
async function consumeStream(streamUrl) {
  const h = {}; if (process.env.AUTH_TOKEN) h['access-token'] = process.env.AUTH_TOKEN;
  const r = await fetch(streamUrl, { headers: h });
  const text = await r.text();
  return { status: r.status, len: text.length, head: text.slice(0, 600), hasRagUsageId: /ragUsageId|ragUsage/i.test(text) };
}

const DISCOVERY = `query($q:String!,$conv:Boolean,$urid:String){ discovery(question:$q, enableConversation:$conv, userRagId:$urid){ userRagId streamUrl showSurvey } }`;
const TURNS = `query($urid:String){ turns(userRagId:$urid){ Meta{count} turns{ _id userId userRagId question answer isCompleted createdAt } } }`;

(async () => {
  const me = myUserId();
  console.log(`🔐 my appUserId: ${me}\n`);

  console.log('— discovery(enableConversation:true), fresh conversation —');
  const d1 = await gql(DISCOVERY, { q: 'How does Kubernetes autoscaling work?', conv: true, urid: null });
  const userRagId = d1.json?.data?.discovery?.userRagId;
  const streamUrl = d1.json?.data?.discovery?.streamUrl;
  console.log('userRagId:', userRagId, '| streamUrl present:', !!streamUrl);
  if (!userRagId || !streamUrl) { console.log('❌ no userRagId/streamUrl:', JSON.stringify(d1.json?.errors ?? d1.raw.slice(0, 300))); return; }

  console.log('\n— consume streamUrl (drives answer + persists turn) —');
  const s = await consumeStream(streamUrl);
  console.log(`stream HTTP ${s.status} len=${s.len} embeds ragUsageId=${s.hasRagUsageId}`);
  console.log('stream head:', JSON.stringify(s.head));

  // poll turns until it appears (max ~5 tries, spaced)
  console.log(`\n— poll turns(userRagId: ${userRagId}) —`);
  let turns = [];
  for (let i = 0; i < 5; i++) {
    await sleep(1500);
    const t = await gql(TURNS, { urid: userRagId });
    turns = t.json?.data?.turns?.turns || [];
    console.log(`   try ${i + 1}: count=${t.json?.data?.turns?.Meta?.count} errors=${JSON.stringify(t.json?.errors ?? null)}`);
    if (turns.length) break;
  }
  for (const tn of turns) {
    console.log(`   ⭐ turn _id=${tn._id} userId=${tn.userId} owned=${tn.userId === me} completed=${tn.isCompleted} q="${(tn.question || '').slice(0, 50)}" answerLen=${(tn.answer || '').length} createdAt=${tn.createdAt}`);
  }
  if (!turns.length) console.log('   ⚠️ still no turn after polling — turn persistence may be slower/async.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
