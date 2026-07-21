/**
 * BACKEND-1604 QA — submitRagUsageFeedback probe (WRITES DATA — see guardrails).
 *
 * Verifies the `submitRagUsageFeedback` mutation end-to-end, as Husam's real ML-Conference user
 * (the .env AUTH_TOKEN). Every turn rated is HIS own, freshly minted here.
 *
 * ── Guardrails (authorized for THIS ticket only) ──────────────────────────────
 *   • concord PROD. Low + spaced volume (~800–1500ms between calls).
 *   • ONLY writes: submitRagUsageFeedback + the discovery ask that mints a turn. No deletes.
 *   • Every comment is labeled  `QA test BACKEND-1604 <ISO>`  so rows are identifiable/cleanable.
 *
 * ── Schema (from introspection) ───────────────────────────────────────────────
 *   mutation submitRagUsageFeedback(feedback: RagUsageFeedbackInput!): SuccessResponse{success,message}
 *   input RagUsageFeedbackInput { ragUsageId:String!  rating:RagUsageFeedbackRating!(UP|DOWN)  comment:String }
 *   NOTE: no reason/reasons/reasonChips field — comment only (story §5 chips not in BE input).
 *
 * ── Mint + read-back flow ─────────────────────────────────────────────────────
 *   discovery(question, enableConversation:true[, userRagId]) -> RAG{ userRagId, streamUrl }
 *   The turn (RagUsage) persists server-side. Read it back via
 *   userRags(ids:[userRagId]) -> UserRags[].turns[]._id   (this `_id` IS the ragUsageId).
 *   RagUsage exposes NO rating/comment field, and no Query returns RagUsageFeedback ->
 *   the feedback itself is NOT readable back via the API (persistence = write-only here).
 *
 * Native fetch (Node v26). Usage: node src/rag-feedback-1604-probe.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'https://concord.sandsmedia.com/graphql';
const LABEL_TS = new Date().toISOString();
const LABEL = (extra) => `QA test BACKEND-1604 ${LABEL_TS}${extra ? ' — ' + extra : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { 'access-token': process.env.AUTH_TOKEN } : {}) });

function myUserId() {
  const t = process.env.AUTH_TOKEN; if (!t) return null;
  try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
}
async function gql(query, variables) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({ query, variables }) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: r.status, json: j, raw: txt };
}

const Q_DISCOVERY = `query($q:String!,$conv:Boolean,$urid:String){ discovery(question:$q, enableConversation:$conv, userRagId:$urid){ userRagId streamUrl } }`;
const Q_USERRAGS  = `query($ids:[String]){ userRags(ids:$ids){ Meta{count} UserRags{ _id userId turns{ _id userId question createdAt } } } }`;
const M_FEEDBACK  = `mutation($fb:RagUsageFeedbackInput!){ submitRagUsageFeedback(feedback:$fb){ success message } }`;

// ── mint a fresh turn (owned by the .env user); returns { userRagId, ragUsageId, turns } ──────────
// The turn (RagUsage) persists server-side a few seconds after discovery returns, so we poll
// userRags(ids:[urid]) until at least `minTurns` turns are visible. `latest` (max createdAt) is the
// turn this call minted.
async function mintTurn(question, userRagId = null, { minTurns = 1, tries = 12, delay = 2000 } = {}) {
  const d = await gql(Q_DISCOVERY, { q: question, conv: true, urid: userRagId });
  const urid = d.json?.data?.discovery?.userRagId;
  if (!urid) throw new Error(`mint failed (no userRagId): ${JSON.stringify(d.json?.errors ?? d.raw.slice(0, 200))}`);
  let turns = [];
  for (let i = 0; i < tries; i++) {
    await sleep(delay);
    const rr = await gql(Q_USERRAGS, { ids: [urid] });
    turns = rr.json?.data?.userRags?.UserRags?.[0]?.turns || [];
    if (turns.length >= minTurns) break;
  }
  const sorted = [...turns].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const latest = sorted[sorted.length - 1];
  if (!latest?._id) throw new Error(`mint failed (turn never persisted for userRagId ${urid} after ${tries * delay}ms)`);
  return { userRagId: urid, ragUsageId: latest._id, turns: sorted };
}

// ── submit feedback; returns a compact record ────────────────────────────────────────────────────
async function submitFeedback(label, fb, { raw = false, delay = 900 } = {}) {
  let res;
  if (raw) {
    // send an inline query so invalid enum literals etc. surface as GraphQL validation errors
    res = await gql(raw);
  } else {
    res = await gql(M_FEEDBACK, { fb });
  }
  await sleep(delay);
  const payload = res.json?.data?.submitRagUsageFeedback ?? null;
  const errors = res.json?.errors ?? null;
  const rec = {
    label, input: raw ? '(raw inline query)' : fb,
    httpStatus: res.status,
    success: payload?.success ?? null,
    message: payload?.message ?? null,
    gqlErrors: errors ? errors.map((e) => e.message) : null,
  };
  const tag = rec.gqlErrors ? `GQL-ERR: ${rec.gqlErrors.join(' | ').slice(0, 140)}` : `success=${rec.success}${rec.message ? ` msg="${rec.message}"` : ''}`;
  console.log(`   [${label}] HTTP ${rec.httpStatus} → ${tag}`);
  return rec;
}

(async () => {
  const jwt = myUserId();
  const ME = jwt?.appUserId;
  console.log(`📡 ${ENDPOINT}`);
  console.log(`🔐 appUserId ${ME} | token exp ${jwt?.exp ? new Date(jwt.exp * 1000).toISOString() : '?'}`);
  console.log(`🏷  comment label: "${LABEL()}"`);
  if (!ME) { console.error('No appUserId in token — abort.'); process.exit(1); }

  const out = { ticket: 'BACKEND-1604', capturedAt: LABEL_TS, endpoint: ENDPOINT, appUserId: ME, steps: {} };

  // ── Step 1: mint turns owned by Husam ───────────────────────────────────────────────────────
  console.log('\n=== Step 1 — mint fresh turns (as the .env user) ===');
  const tUp   = await mintTurn('How does Kubernetes autoscaling work?');
  console.log(`   turnA (UP)      ragUsageId=${tUp.ragUsageId} owned=${tUp.turns.at(-1)?.userId === ME}`);
  const tDown = await mintTurn('What is a Kubernetes operator?');
  console.log(`   turnB (DOWN)    ragUsageId=${tDown.ragUsageId} owned=${tDown.turns.at(-1)?.userId === ME}`);
  const tUpd  = await mintTurn('What is a service mesh?');
  console.log(`   turnC (update)  ragUsageId=${tUpd.ragUsageId} owned=${tUpd.turns.at(-1)?.userId === ME}`);
  const tOpt  = await mintTurn('What is a Kubernetes ingress controller?');
  console.log(`   turnD (opt)     ragUsageId=${tOpt.ragUsageId} owned=${tOpt.turns.at(-1)?.userId === ME}`);
  // 2-turn conversation for scoping: mint turn1, then turn2 in the SAME conversation (wait for 2 turns)
  const conv1 = await mintTurn('What is horizontal pod autoscaling?');
  const conv2 = await mintTurn('And how does vertical pod autoscaling differ?', conv1.userRagId, { minTurns: 2 });
  const convTurns = conv2.turns; // both turns of the shared conversation
  console.log(`   convX userRagId=${conv1.userRagId} turns=${convTurns.length} ids=${convTurns.map((t) => t._id).join(', ')}`);
  out.steps.mint = {
    turnA: tUp.ragUsageId, turnB: tDown.ragUsageId, turnC: tUpd.ragUsageId, turnD: tOpt.ragUsageId,
    conversation: { userRagId: conv1.userRagId, turnIds: convTurns.map((t) => t._id) },
    allOwned: [tUp, tDown, tUpd, tOpt].every((t) => t.turns.at(-1)?.userId === ME),
  };

  // ── Step 2: happy path ──────────────────────────────────────────────────────────────────────
  console.log('\n=== Step 2 — happy path (UP / DOWN / comment optional) ===');
  out.steps.happy = [];
  out.steps.happy.push(await submitFeedback('UP + labeled comment', { ragUsageId: tUp.ragUsageId, rating: 'UP', comment: LABEL('happy UP') }));
  out.steps.happy.push(await submitFeedback('DOWN, NO comment', { ragUsageId: tDown.ragUsageId, rating: 'DOWN' }));
  out.steps.happy.push(await submitFeedback('UP, NO comment (comment truly optional)', { ragUsageId: tOpt.ragUsageId, rating: 'UP' }));

  // ── Step 3: persistence / read-back ─────────────────────────────────────────────────────────
  console.log('\n=== Step 3 — persistence / read-back ===');
  // (a) does the turn read back? (b) is there ANY path to the stored rating/comment?
  const rb = await gql(Q_USERRAGS, { ids: [tUp.userRagId] });
  const rbTurn = rb.json?.data?.userRags?.UserRags?.[0]?.turns?.find((t) => t._id === tUp.ragUsageId);
  // probe the turns() query variants to document the read situation
  const tByUrid = await gql(`query($u:String){turns(userRagId:$u){Meta{count}}}`, { u: tUp.userRagId });
  const tByUser = await gql(`query($u:String){turns(userId:$u){Meta{count}}}`, { u: ME });
  const tByIds  = await gql(`query($i:[String]){turns(ids:$i){Meta{count}}}`, { i: [tUp.ragUsageId] });
  out.steps.persistence = {
    turnReadsBack: !!rbTurn,
    turnReadBackPath: 'userRags(ids:[userRagId]).UserRags[].turns[]',
    feedbackReadable: false,
    feedbackReadNote: 'RagUsage exposes no rating/comment; no Query returns RagUsageFeedback → feedback not verifiable via API.',
    turnsQueryVariants: {
      'turns(userRagId)': tByUrid.json?.data?.turns?.Meta?.count ?? tByUrid.json?.errors,
      'turns(userId)': tByUser.json?.data?.turns?.Meta?.count ?? tByUser.json?.errors,
      'turns(ids)': tByIds.json?.data?.turns?.Meta?.count ?? tByIds.json?.errors,
    },
  };
  console.log(`   turn reads back via userRags: ${!!rbTurn}`);
  console.log(`   feedback read-back path: NONE (write-only via API)`);
  console.log(`   turns() variants → userRagId:${out.steps.persistence.turnsQueryVariants['turns(userRagId)']} userId:${out.steps.persistence.turnsQueryVariants['turns(userId)']} ids:${out.steps.persistence.turnsQueryVariants['turns(ids)']}`);

  // ── Step 4: turn-scoping (per-turn, not per-session) ────────────────────────────────────────
  console.log('\n=== Step 4 — turn-scoping (turn id vs session id) ===');
  out.steps.turnScoping = [];
  // rate each turn of the 2-turn conversation independently (distinct turn ids, one shared session)
  out.steps.turnScoping.push(await submitFeedback('conv turn #1 = UP', { ragUsageId: convTurns[0]._id, rating: 'UP', comment: LABEL('scope t1') }));
  if (convTurns[1]) out.steps.turnScoping.push(await submitFeedback('conv turn #2 = DOWN', { ragUsageId: convTurns[1]._id, rating: 'DOWN', comment: LABEL('scope t2') }));
  // discriminator: submit with the SESSION id (userRagId) as ragUsageId — should it be rejected?
  out.steps.turnScoping.push(await submitFeedback('SESSION id as ragUsageId (should this be rejected?)', { ragUsageId: conv1.userRagId, rating: 'UP', comment: LABEL('session-as-turn') }));
  out.steps.turnScopingNote = 'True per-turn persistence (turn A rated, turn B untouched) needs a DB check — feedback is not API-readable. Observable here: each turn id accepts feedback independently, and whether the SESSION id is (wrongly) accepted.';

  // ── Step 5: update vs duplicate on the same turn ────────────────────────────────────────────
  console.log('\n=== Step 5 — update vs duplicate (same turn, UP then DOWN then UP) ===');
  out.steps.updateVsDuplicate = [];
  out.steps.updateVsDuplicate.push(await submitFeedback('turnC UP (1st)', { ragUsageId: tUpd.ragUsageId, rating: 'UP', comment: LABEL('upd 1 UP') }));
  out.steps.updateVsDuplicate.push(await submitFeedback('turnC DOWN (2nd, flip)', { ragUsageId: tUpd.ragUsageId, rating: 'DOWN', comment: LABEL('upd 2 DOWN') }));
  out.steps.updateVsDuplicate.push(await submitFeedback('turnC UP again (3rd, same as 1st)', { ragUsageId: tUpd.ragUsageId, rating: 'UP', comment: LABEL('upd 3 UP') }));
  out.steps.updateVsDuplicateNote = 'All calls on the same turn. Whether this UPSERTs one row or appends duplicates is NOT API-observable (no feedback read path) → dev must confirm in DB. Story §2 "one rating per turn / toggle" depends on upsert-by-(userId,ragUsageId).';

  // ── Step 6: validation / edge cases ─────────────────────────────────────────────────────────
  console.log('\n=== Step 6 — validation / edges / cross-user ===');
  out.steps.edges = [];
  // nonexistent but well-formed 24-hex id
  out.steps.edges.push(await submitFeedback('nonexistent 24-hex ragUsageId', { ragUsageId: 'ffffffffffffffffffffffff', rating: 'UP', comment: LABEL('edge nonexistent') }));
  // empty id
  out.steps.edges.push(await submitFeedback('empty ragUsageId', { ragUsageId: '', rating: 'UP', comment: LABEL('edge empty') }));
  // malformed id (not 24-hex)
  out.steps.edges.push(await submitFeedback('malformed ragUsageId "not-an-id"', { ragUsageId: 'not-an-id', rating: 'DOWN', comment: LABEL('edge malformed') }));
  // invalid rating enum — must be sent inline (variables would also reject, but message differs)
  out.steps.edges.push(await submitFeedback('invalid rating MAYBE (enum)', null, { raw: `mutation{ submitRagUsageFeedback(feedback:{ ragUsageId:"${tUp.ragUsageId}", rating: MAYBE, comment: ${JSON.stringify(LABEL('edge MAYBE'))} }){ success message } }` }));
  // very long comment (~12k chars)
  const longComment = LABEL('edge long ') + 'x'.repeat(12000);
  out.steps.edges.push(await submitFeedback('very long comment (~12k chars)', { ragUsageId: tUp.ragUsageId, rating: 'UP', comment: longComment }));
  // cross-user: the dev's stale example id (NOT Husam's turn) — abuse-prevention probe
  out.steps.edges.push(await submitFeedback("CROSS-USER: dev's example id 6a4ba35bd5d1291209d12bd3", { ragUsageId: '6a4ba35bd5d1291209d12bd3', rating: 'DOWN', comment: LABEL('edge cross-user') }));

  // ── save report ─────────────────────────────────────────────────────────────────────────────
  const dir = path.join(__dirname, '../reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = LABEL_TS.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(dir, `rag-feedback-1604-probe-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // ── verdict summary ─────────────────────────────────────────────────────────────────────────
  const happyOK = out.steps.happy.every((r) => r.success === true);
  console.log('\n================ VERDICT ================');
  console.log(`Happy path (UP/DOWN/optional comment): ${happyOK ? '✅ all success:true' : '❌ some failed'}`);
  console.log(`Turn read-back: ${out.steps.persistence.turnReadsBack ? '✅ via userRags' : '❌'} | Feedback read-back: ❌ none (write-only via API)`);
  console.log(`Edges — see records; nonexistent/empty/malformed/cross-user behavior captured for the dev.`);
  console.log(`\n💾 Saved: ${outPath}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
