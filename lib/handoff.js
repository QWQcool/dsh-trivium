/** Opt-in local Super Agent handoff. Workers persist candidates; only the owner opens TDB. */
import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteFile} from './atomic.js';
import {acquireWorkspaceLock,withWorkspaceQueue,withWorkspaceLock} from './workspace-lock.js';
import {filterCandidates,pendingReviewEtag,sourceReviewKey} from './extract.js';
import {validatePendingReviewRequest} from './pending-review.js';
import {currentHeadOf,findByUri,insertNode,cwdForDb} from './store.js';
import {buildSource,candidateEvidence,matchQuote} from './source-events.js';
import {sanitizeForWrite} from './hygiene.js';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value)&&sanitizeForWrite(value).ok;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const physical=cwd=>{const p=realpathSync(resolve(cwd));return process.platform==='win32'?p.toLowerCase():p;};
export const handoffPath=cwd=>join(resolve(cwd),'.dsh','trivium-handoff.json');
function readState(cwd) {
  try {
    const state=JSON.parse(readFileSync(handoffPath(cwd),'utf8'));
    if(state.version!==1||state.workspace!==physical(cwd)||!id(state.projectScopeId)||!Array.isArray(state.assignments)||!Array.isArray(state.entries))throw Error();
    return state;
  }catch(e){if(e.code==='ENOENT')return null;fail('HANDOFF_UNREADABLE','Handoff state is unavailable; existing data was not replaced.');}
}
function writeState(cwd,state) {
  atomicWriteFile(handoffPath(cwd),JSON.stringify(state,null,2)+'\n',{mode:0o600});
}
async function update(cwd,fn) {
  return withWorkspaceQueue(handoffPath(cwd),async()=>{
    const deadline=Date.now()+2000;
    for(;;){
      const lock=acquireWorkspaceLock(cwd,{file:handoffPath(cwd)+'.lock'});
      if(lock.ok){try{return await fn(readState(cwd));}finally{lock.release();}}
      if(lock.reason!=='busy'||Date.now()>=deadline)fail('HANDOFF_BUSY','The central inbox is busy; retain and retry the original envelope.');
      await new Promise(done=>setTimeout(done,20));
    }
  });
}
/** Host-owned registration, separate from untrusted envelope text. Never derives a scope from cwd parents. */
export async function configureHandoff(cwd,{projectScopeId,assignments=[]}={}) {
  /*
   * Read and write are granted separately. A worker that may submit candidates
   * does not automatically get to read the central inbox back, and a reader does
   * not get to write. Entries without the flags keep the old both-allowed
   * behaviour so existing state files stay valid.
   */
  const flag = value => value === undefined ? true : value === true;
  if(!id(projectScopeId)||!Array.isArray(assignments)||assignments.length>256||assignments.some(a=>!a||Object.keys(a).some(k=>!['ticketId','assignmentId','workerId','canRead','canWrite'].includes(k))
    ||!['ticketId','assignmentId','workerId'].every(k=>id(a[k]))
    ||['canRead','canWrite'].some(k=>a[k]!==undefined&&typeof a[k]!=='boolean')
    ||!flag(a.canRead)&&!flag(a.canWrite)))
    fail('HANDOFF_INVALID','Explicit project and assignment identities are required.');
  return update(cwd,state=>{
    state??={version:1,workspace:physical(cwd),projectScopeId,assignments:[],entries:[]};
    if(state.projectScopeId!==projectScopeId)fail('HANDOFF_SCOPE_MISMATCH','The central workspace belongs to a different project scope.');
    for(const a of assignments){
      const prior=state.assignments.find(p=>p.assignmentId===a.assignmentId);
      if(prior&&hash(prior)!==hash(a))fail('HANDOFF_ASSIGNMENT_CONFLICT','An assignment identity cannot be reassigned.');
      if(!prior)state.assignments.push(structuredClone(a));
    }
    writeState(cwd,state);return {ok:true,projectScopeId,assignments:state.assignments.length};
  });
}
export function validateHandoffEnvelope(envelope) {
  if(!envelope||Array.isArray(envelope)||Object.keys(envelope).some(k=>!['version','projectScopeId','ticketId','assignmentId','workerId','eventId','sessionId','sourceTurns','candidates'].includes(k))
    ||envelope.version!==1||!['projectScopeId','ticketId','assignmentId','workerId','eventId','sessionId'].every(k=>id(envelope[k]))
    ||!Array.isArray(envelope.candidates)||!envelope.candidates.length||envelope.candidates.length>24
    ||!Array.isArray(envelope.sourceTurns)||!envelope.sourceTurns.length||envelope.sourceTurns.length>16||Buffer.byteLength(JSON.stringify(envelope),'utf8')>128*1024)
    fail('HANDOFF_INVALID','Invalid or oversized candidate envelope.');
  for(const c of envelope.candidates) {
    if(!c||Object.keys(c).some(k=>!['type','name','text','quote','aliases'].includes(k))||!['preference','entity','decision','experience'].includes(c.type)
      ||typeof c.text!=='string'||!c.text.trim()||c.text.length>240||c.name!==undefined&&(typeof c.name!=='string'||c.name.length>80)
      ||c.quote!==undefined&&(typeof c.quote!=='string'||c.quote.length>2000)
      ||c.aliases!==undefined&&(!Array.isArray(c.aliases)||c.aliases.length>8||c.aliases.some(v=>typeof v!=='string'||v.length>80)))fail('HANDOFF_INVALID','Invalid candidate fields.');
    for(const value of [c.text,c.name,c.quote,...(c.aliases||[])].filter(Boolean))if(!sanitizeForWrite(value).ok)fail('HANDOFF_DIRTY','Candidate rejected by the existing write guard.');
  }
  for(const t of envelope.sourceTurns) {
    if(!t||Object.keys(t).some(k=>!['role','text','at','messageId','seq','recorded','toolName','sourceSessionId'].includes(k))||!['user','tool'].includes(t.role)||typeof t.text!=='string'||!t.text.trim()||t.text.length>10000||!sanitizeForWrite(t.text).ok
      ||t.seq!==undefined&&(!Number.isSafeInteger(t.seq)||t.seq<0)||t.recorded!==undefined&&typeof t.recorded!=='boolean'
      ||t.sourceSessionId!==undefined&&!id(t.sourceSessionId)
      ||['at','messageId','toolName'].some(k=>t[k]!==undefined&&(typeof t[k]!=='string'||t[k].length>200)))fail('HANDOFF_INVALID','Invalid source turns.');
  }
  return structuredClone(envelope);
}
const eventKey=e=>hash([e.projectScopeId,e.ticketId,e.assignmentId,e.eventId]);
function authorised(state,e,mode='write') {
  if(!e||!['projectScopeId','ticketId','assignmentId','workerId','eventId'].every(k=>id(e[k]))||!state||state.projectScopeId!==e.projectScopeId)
    fail('HANDOFF_SCOPE_MISMATCH','The host has not registered this project/ticket/assignment/worker mapping.');
  const grant=state.assignments.find(a=>a.ticketId===e.ticketId&&a.assignmentId===e.assignmentId&&a.workerId===e.workerId);
  if(!grant)fail('HANDOFF_SCOPE_MISMATCH','The host has not registered this project/ticket/assignment/worker mapping.');
  const allowed=mode==='read'?grant.canRead!==false:grant.canWrite!==false;
  if(!allowed)fail(mode==='read'?'HANDOFF_READ_NOT_AUTHORIZED':'HANDOFF_WRITE_NOT_AUTHORIZED',
    mode==='read'?'This worker may write candidates but may not read the central inbox.':'This worker may read the central inbox but may not submit candidates.');
}
function receipt(entry) {
  return {ok:true,version:1,key:entry.key,eventId:entry.envelope.eventId,status:entry.status,acceptedAt:entry.acceptedAt,
    completedAt:entry.completedAt||null,outcomes:structuredClone(entry.outcomes||[]),durable:true};
}
/** Safe while the router is offline: receipt means centrally persisted, not yet an active memory. */
export async function submitHandoff(cwd,input) {
  const envelope=validateHandoffEnvelope(input),key=eventKey(envelope),digest=hash(envelope);
  return update(cwd,state=>{
    authorised(state,envelope,'write');
    const prior=state.entries.find(e=>e.key===key);
    if(prior){if(prior.digest!==digest)fail('HANDOFF_EVENT_CONFLICT','An event ID was reused with different content.');return {...receipt(prior),replayed:true};}
    if(state.entries.length>=4096)fail('HANDOFF_CAPACITY','Central history reached its limit; retain the envelope for explicit maintenance.');
    const entry={key,digest,envelope,acceptedAt:new Date().toISOString(),status:'queued',outcomes:[]};
    state.entries.push(entry);writeState(cwd,state);return receipt(entry);
  });
}
export function handoffReceipt(cwd,identity) {
  const state=readState(cwd);authorised(state,identity,'read');
  const entry=state.entries.find(e=>e.key===eventKey(identity));return entry?receipt(entry):null;
}

function checkedEnvelope(state, entry) {
  const envelope = validateHandoffEnvelope(entry.envelope);
  authorised(state,envelope);
  if (entry.key !== eventKey(envelope) || entry.digest !== hash(envelope))
    fail('HANDOFF_UNREADABLE','Stored event identity or contents changed.');
  return envelope;
}

const factFields = candidate => [candidate.type, (candidate.name || '').trim(), candidate.text.trim()];
function sourceFactKey(envelope, candidate, turn) {
  if (turn?.recorded !== true) return null;
  const locator = turn.messageId?.trim() ? ['message', turn.sourceSessionId || '', turn.messageId]
    : Number.isSafeInteger(turn.seq) ? ['sequence', turn.sourceSessionId || envelope.sessionId, turn.seq] : null;
  if (!locator) return null;
  return hash([envelope.projectScopeId, locator, turn.role, turn.toolName || '', turn.text, ...factFields(candidate)]);
}

function admitCandidate(envelope, candidate) {
  const sourceTurns = envelope.sourceTurns.filter(turn => turn.role === 'user');
  let reason;
  // A tool echo alone cannot independently support a write.
  const [fact] = filterCandidates([{...candidate,via:'model'}], {
    requireSource:true, sourceTurns, sourceText:sourceTurns.map(turn => turn.text).join('\n'),
    onSkip:row => { reason = row.reason; }, onAdjust:row => { reason = row.reason; },
  });
  return fact && !reason ? {fact} : {reason:reason || 'candidate-needs-review'};
}

// The inbox also records completed writes whose nodes were subsequently
// edited or deleted. Keeping those identities prevents a retry resurrecting them.
function committedFacts(state) {
  const facts = new Map();
  for (const entry of state.entries) {
    for (const outcome of entry.outcomes || []) {
      if (outcome.status !== 'committed') continue;
      let factKey = outcome.factKey;
      if (factKey === undefined) {
        // Before cross-Worker deduplication, receipts had only the delivery URI.
        const candidate = entry.envelope.candidates[outcome.index];
        const {fact} = admitCandidate(entry.envelope,candidate);
        factKey = fact && sourceFactKey(entry.envelope,candidate,fact.evidenceTurn);
      }
      if (factKey && !facts.has(factKey)) facts.set(factKey,{entry,outcome});
    }
  }
  return facts;
}

const deliveryUri = (entry, index) => `trivium:handoff:${entry.key}:${index}`;
const factUri = factKey => `trivium:handoff:fact:${factKey}`;

function locateMemory(db, entry, index, candidate, factKey, facts) {
  const prior = facts.get(factKey);
  const localUri = deliveryUri(entry,index);
  const sharedUri = factKey ? factUri(factKey) : localUri;
  const nodeId = prior ? prior.outcome.nodeId
    : findByUri(db,sharedUri) ?? (sharedUri !== localUri ? findByUri(db,localUri) : null);
  if (nodeId === null) return {nodeId,uri:sharedUri,changed:false};
  const payload = db.get(nodeId)?.payload;
  const metadata = payload?.source?.handoff;
  const legacyOwner = prior?.entry || entry;
  const legacyIndex = prior?.outcome.index ?? index;
  const owned = (factKey && metadata?.factKey === factKey && payload?.uri === sharedUri)
    || (metadata?.key === legacyOwner.key && payload?.uri === deliveryUri(legacyOwner,legacyIndex));
  const changed = !owned || payload.status !== 'active' || payload.type !== candidate.type
    || (payload.name || '').trim() !== (candidate.name || '').trim() || payload.text !== candidate.text.trim()
    || (payload.type === 'decision' && currentHeadOf(db,nodeId).id !== nodeId);
  return {nodeId,uri:sharedUri,changed,metadata};
}

function handoffSource(entry, index, factKey, source, reviewOperation) {
  const {projectScopeId,ticketId,assignmentId,workerId,eventId} = entry.envelope;
  return {...source,handoff:{key:entry.key,index,projectScopeId,ticketId,assignmentId,workerId,eventId,factKey,reviewOperation}};
}

function finishEntry(entry, at) {
  entry.status = entry.outcomes.some(row => row.status === 'needs_review') ? 'needs_review'
    : entry.outcomes.some(row => row.status === 'dismissed') ? 'reviewed' : 'committed';
  entry.completedAt = at;
}

const reviewCandidateId = (entry,index) => hash([entry.key,index]);
const reviewEtag = (cwd,entry) => pendingReviewEtag(cwd,[entry.key,entry.digest,entry.outcomes]);
const handoffLabel = entry => {
  const {ticketId,assignmentId,workerId,eventId} = entry.envelope;
  return {ticketId,assignmentId,workerId,eventId};
};

/** A read view of the central inbox. No handoff data enters extraction replay. */
export function handoffReviewSummary(cwd, offset = 0) {
  const state = readState(cwd);
  if (!state) return {};
  const pending = state.entries.filter(entry => entry.status === 'needs_review');
  const limit = 12;
  offset = Math.min(offset,pending.length ? Math.floor((pending.length - 1) / limit) * limit : 0);
  const windows = pending.slice(offset,offset + limit).map(entry => {
    const envelope = checkedEnvelope(state,entry);
    return {
      sessionId:entry.key, etag:reviewEtag(cwd,entry), handoff:handoffLabel(entry), turns:envelope.sourceTurns.length,
      unverified:entry.outcomes.filter(row => row.status === 'needs_review').map(({index,reason}) => ({
        ...envelope.candidates[index], id:reviewCandidateId(entry,index), reason,
      })),
      evidence:envelope.sourceTurns.slice(-6).map(({role,text,at,recorded}) => ({role,text:text.slice(0,360),at:at || null,recorded:recorded === true})),
      preview:envelope.sourceTurns[0].text.replace(/\s+/g,' ').slice(0,80),
    };
  });
  const reviews = [];
  for (const entry of state.entries) {
    for (const outcome of entry.outcomes || []) {
      if (!outcome.review) continue;
      const {action,at,evidence} = outcome.review;
      reviews.push({sessionId:entry.key,candidateId:reviewCandidateId(entry,outcome.index),nodeId:outcome.nodeId,
        action,at,evidence,handoff:handoffLabel(entry),reused:outcome.reused,
        candidate:entry.envelope.candidates[outcome.index],sourceTurns:entry.envelope.sourceTurns});
    }
  }
  return {windows,reviews,page:{offset,limit,total:pending.length}};
}

function reviewFactKey(envelope, candidate) {
  const proof = candidateEvidence(candidate,envelope.sourceTurns.filter(turn => turn.role === 'user'));
  if (proof.supported) return sourceFactKey(envelope,candidate,proof.turn);
  // Explicit human acceptance can preserve a recorded but unverified origin.
  // A quote that matches several independent turns cannot identify that origin.
  const matches = envelope.sourceTurns.filter(turn => matchQuote(candidate.quote,[turn],{roles:['user','tool']}));
  const keys = new Set(matches.map(turn => sourceFactKey(envelope,candidate,turn)));
  return keys.size === 1 ? keys.values().next().value : null;
}

const reviewConflict = (code,message) => { throw Object.assign(new Error(message),{status:409,code}); };

/** Called by the review endpoint while holding the central workspace write lock. */
export function reviewHandoff(cwd, db, request) {
  const evidence = validatePendingReviewRequest(request);
  const {sessionId,candidateId,etag,action} = request;
  if (!cwdForDb(db) || physical(cwdForDb(db)) !== physical(cwd))
    fail('HANDOFF_SCOPE_MISMATCH','The reviewer must own the registered central workspace handle.');
  return update(cwd,state => {
    const entry = state?.entries.find(row => row.key === sessionId);
    const index = entry?.outcomes.findIndex(row => reviewCandidateId(entry,row.index) === candidateId) ?? -1;
    if (index < 0) reviewConflict('PENDING_REVIEW_STALE','This handoff candidate is no longer pending. Refresh before reviewing.');
    const envelope = checkedEnvelope(state,entry);
    const outcome = entry.outcomes[index];
    const evidenceHash = sourceReviewKey([evidence]);
    const result = {ok:true,settled:true,action};
    const prior = outcome.review;
    if (prior?.requestEtag === etag && prior.action === action && prior.evidenceHash === evidenceHash)
      return {...result,nodeId:outcome.nodeId,reused:outcome.reused,replayed:true};
    if (outcome.status !== 'needs_review' || reviewEtag(cwd,entry) !== etag)
      reviewConflict('PENDING_REVIEW_STALE','This handoff candidate changed. Refresh before reviewing.');

    const candidate = envelope.candidates[outcome.index];
    const at = new Date().toISOString();
    const turn = {role:'user',text:action === 'verify' ? evidence.trim() : candidate.text,at,recorded:false};
    const factKey = outcome.factKey || reviewFactKey(envelope,candidate);
    const memory = locateMemory(db,entry,outcome.index,candidate,factKey,committedFacts(state));
    const operation = hash([action,evidenceHash]);
    const ownInterruptedWrite = memory.metadata?.key === entry.key && memory.metadata.index === outcome.index
      && memory.metadata.reviewOperation;
    if (ownInterruptedWrite && memory.metadata.reviewOperation !== operation)
      reviewConflict('PENDING_REVIEW_ALREADY_WRITTEN','An earlier confirmation already created a memory. Retry that action or inspect the memory.');

    let nodeId = null;
    if (action !== 'dismiss') {
      if (memory.changed) reviewConflict('PENDING_REVIEW_NODE_CHANGED','The previously written memory changed. Inspect it before accepting this candidate.');
      if (action === 'verify' && !candidateEvidence({...candidate,quote:turn.text},[turn]).supported)
        return {ok:true,settled:false,code:'SOURCE_STILL_UNVERIFIED'};
      nodeId = memory.nodeId;
      if (nodeId === null) {
        const source = handoffSource(entry,outcome.index,factKey,{
          ...buildSource({quote:turn.text,turns:[turn],sessionId:envelope.sessionId,via:'manual',kind:'manual'}),
          capturedAt:at,reviewAction:action,evidenceKind:action === 'confirm' ? 'user-confirmation' : 'user-supplement',
        },operation);
        nodeId = insertNode(db,{type:candidate.type,name:candidate.name,text:candidate.text.trim(),aliases:candidate.aliases,source,uri:memory.uri});
      }
      db.flush();
    }
    const reused = nodeId !== null && memory.nodeId !== null && !ownInterruptedWrite;
    entry.outcomes[index] = {index:outcome.index,status:action === 'dismiss' ? 'dismissed' : 'committed',nodeId,reused,factKey,
      review:{action,at,requestEtag:etag,evidenceHash,evidence:evidence.trim()}};
    finishEntry(entry,at);
    writeState(cwd,state);
    return {...result,nodeId,reused};
  });
}

/** One owner handle. All graph changes are insert-only; ambiguous candidates remain in the central record. */
export async function drainHandoff(cwd,db,{limit=16}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('HANDOFF_INVALID','Drain limit must be 1..64.');
  if(!cwdForDb(db)||physical(cwdForDb(db))!==physical(cwd))fail('HANDOFF_SCOPE_MISMATCH','The writer must own the registered central workspace handle.');
  const locked=await withWorkspaceLock(cwd,()=>update(cwd,state=>{
    if(!state)return {ok:true,processed:0};
    const queued = state.entries.filter(entry => entry.status === 'queued').slice(0,limit);
    const facts = queued.length ? committedFacts(state) : new Map();
    const done=[];
    for(const entry of queued) {
      const envelope = checkedEnvelope(state,entry);
      const outcomes=[];
      for(const [index,candidate] of envelope.candidates.entries()) {
        const {fact,reason} = admitCandidate(envelope,candidate);
        const turn = fact?.evidenceTurn;
        const factKey = fact ? sourceFactKey(envelope,candidate,turn) : null;
        const memory = locateMemory(db,entry,index,candidate,factKey,facts);
        if (memory.changed || (!fact && memory.nodeId === null)) {
          outcomes.push({index,status:'needs_review',reason:memory.changed ? 'previous-memory-changed' : reason,factKey});
          continue;
        }
        let nodeId = memory.nodeId;
        if (nodeId === null) {
          const original = buildSource({quote:fact.quote,turns:turn ? [turn] : [],
            sessionId:turn?.sourceSessionId || envelope.sessionId,via:'handoff'});
          const source = handoffSource(entry,index,factKey,{...original,recorded:original.recorded && turn?.recorded === true});
          nodeId = insertNode(db,{type:fact.type,name:fact.name,text:fact.text,aliases:fact.aliases,source,uri:memory.uri});
        }
        const outcome = {index,status:'committed',nodeId,reused:memory.nodeId !== null,factKey};
        if (factKey && !facts.has(factKey)) facts.set(factKey,{entry,outcome});
        outcomes.push(outcome);
      }
      // Also flush recovered URI hits: an earlier flush may have failed after
      // changing the live engine. No terminal receipt precedes durability.
      db.flush();
      entry.outcomes = outcomes;
      finishEntry(entry,new Date().toISOString());
      writeState(cwd,state);done.push(receipt(entry));
    }
    return {ok:true,processed:done.length,receipts:done};
  }));
  if(locked.locked)return {ok:false,code:'HANDOFF_WRITE_BUSY',processed:0};
  return locked.value;
}
