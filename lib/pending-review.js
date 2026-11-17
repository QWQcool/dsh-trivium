/** Explicit source review. Insert-only: confirmation never retires, merges or deletes existing facts. */
import { createHash } from 'node:crypto';
import { pendingCandidateId, pendingReviewEtag, sourceReviewKey, updatePendingWindows } from './extract.js';
import { candidateEvidence, buildSource } from './source-events.js';
import { sanitizeForWrite } from './hygiene.js';
import { findByUri } from './store.js';
import { memoryWriterFor } from './memory-writer.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };
export async function reviewPending(cwd, db, request, {writer} = {}) {
  if (!request || Array.isArray(request) || Object.keys(request).some(k=>!['action','sessionId','candidateId','etag','evidence'].includes(k))
    || !['verify','confirm'].includes(request.action) || typeof request.sessionId !== 'string'
    || request.sessionId.length > 200 || !/^[a-f0-9]{64}$/.test(request.candidateId || '') || !/^[a-f0-9]{64}$/.test(request.etag || ''))
    fail(400,'PENDING_REVIEW_INVALID','Invalid review request.');
  const evidence = request.evidence === undefined ? '' : request.evidence;
  if (typeof evidence !== 'string' || evidence.length > 2000 || (request.action === 'verify' && !evidence.trim()))
    fail(400,'PENDING_REVIEW_EVIDENCE_REQUIRED','Add supporting evidence before checking.');
  if (evidence && !sanitizeForWrite(evidence).ok) fail(422,'PENDING_REVIEW_SECRET','Evidence contains a secret or unsupported content.');
  let result;
  await updatePendingWindows(cwd, async state => {
    const row = state.windows.find(w => String(w.sessionId || '') === request.sessionId);
    if (!row || pendingReviewEtag(cwd, row) !== request.etag) fail(409,'PENDING_REVIEW_STALE','This source window changed. Refresh before reviewing.');
    const candidate = row.unverified?.find(c => pendingCandidateId(c) === request.candidateId);
    if (!candidate) fail(409,'PENDING_REVIEW_STALE','This candidate is no longer pending.');
    if (!row.turns.some(turn=>turn.producer !== 'pending-review')) fail(422,'PENDING_REVIEW_SOURCE_MISSING','The original source window is missing; inspect it before confirming.');
    if (!['preference','entity','decision','experience'].includes(candidate.type) || !String(candidate.text || '').trim()
      || String(candidate.text).length > 240 || !sanitizeForWrite(JSON.stringify(candidate)).ok)
      fail(422,'PENDING_REVIEW_INVALID_CANDIDATE','The stored candidate cannot be confirmed safely.');
    const at = new Date().toISOString();
    const previouslyChecked = row.sourceReviewKey === sourceReviewKey(row.turns);
    const turn = {role:'user',text:request.action === 'verify' ? evidence.trim() : candidate.text, at, recorded:false,
      pendingEventId:`review-${request.candidateId}-${sourceReviewKey([evidence])}`, producer:'pending-review'};
    const turns = [...row.turns, turn];
    const checked = request.action === 'verify' ? candidateEvidence({...candidate,quote:evidence.trim()},[turn]) : null;
    if (checked && !checked.supported) {
      result={ok:true,settled:false,code:'SOURCE_STILL_UNVERIFIED'};
      return {...state,windows:state.windows.map(w => w === row ? {...row,turns,sourceReviewKey:previouslyChecked ? sourceReviewKey(turns) : null,reviewComplete:false} : w)};
    }
    // Stable URI survives a crash after the graph commit but before the pending-file rename.
    const op = createHash('sha256').update(JSON.stringify([request.sessionId,request.candidateId,sourceReviewKey(row.turns.filter(t => t.producer !== 'pending-review'))])).digest('hex');
    const uri=`trivium:pending-review:${op}`;
    const existing = findByUri(db,uri);
    let nodeId=existing;
    if (nodeId === null) {
      const source={...buildSource({quote:turn.text,turns:[turn],sessionId:request.sessionId,via:'manual',kind:'manual'}),
        capturedAt:at,reviewAction:request.action,reviewOperation:op,evidenceKind:request.action === 'confirm' ? 'user-confirmation' : 'user-supplement'};
      nodeId=await memoryWriterFor(db,writer).insert({type:candidate.type,name:candidate.name || undefined,text:candidate.text,
        fail:candidate.fail || undefined,fix:candidate.fix || undefined,source,uri});
    } else {
      const payload=db.get(nodeId)?.payload;
      if (!payload || payload.type !== candidate.type || payload.text !== candidate.text || payload.status !== 'active')
        fail(409,'PENDING_REVIEW_NODE_CHANGED','A previously confirmed node changed; manual inspection is needed.');
    }
    // A prior flush may have failed after inserting in the live engine. Never
    // acknowledge a URI found only in that engine until it is durable again.
    db.flush();
    const unverified=row.unverified.filter(c => pendingCandidateId(c) !== request.candidateId);
    const receipt={sessionId:request.sessionId,candidateId:request.candidateId,sourceKeys:row.turns.filter(t=>t.producer !== 'pending-review').map(t=>sourceReviewKey([t])),nodeId,action:request.action,at};
    result={ok:true,settled:true,nodeId,action:request.action,reused:existing !== null};
    return {...state,reviews:[...state.reviews,receipt].slice(-1024),windows:state.windows.map(w=>w===row ? {...row,turns,unverified,
      sourceReviewKey:previouslyChecked ? sourceReviewKey(turns) : null,reviewComplete:previouslyChecked && !unverified.length,error:unverified.length ? 'source-unverified' : undefined} : w)};
  });
  return result;
}
