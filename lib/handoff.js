/** Opt-in local Super Agent handoff. Workers persist candidates; only the owner opens TDB. */
import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireWorkspaceLock,withWorkspaceQueue,withWorkspaceLock} from './workspace-lock.js';
import {filterCandidates} from './extract.js';
import {findByUri,insertNode,cwdForDb} from './store.js';
import {buildSource} from './source-events.js';
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
  const file=handoffPath(cwd),tmp=`${file}.${randomUUID()}.tmp`;mkdirSync(dirname(file),{recursive:true});
  try{writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{encoding:'utf8',flush:true});renameSync(tmp,file);}
  finally{try{unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
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
  if(!id(projectScopeId)||!Array.isArray(assignments)||assignments.length>256||assignments.some(a=>!a||Object.keys(a).some(k=>!['ticketId','assignmentId','workerId'].includes(k))||!['ticketId','assignmentId','workerId'].every(k=>id(a[k]))))
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
    if(!t||Object.keys(t).some(k=>!['role','text','at','messageId','seq','recorded','toolName'].includes(k))||!['user','tool'].includes(t.role)||typeof t.text!=='string'||!t.text.trim()||t.text.length>10000||!sanitizeForWrite(t.text).ok
      ||t.seq!==undefined&&(!Number.isSafeInteger(t.seq)||t.seq<0)||t.recorded!==undefined&&typeof t.recorded!=='boolean'
      ||['at','messageId','toolName'].some(k=>t[k]!==undefined&&(typeof t[k]!=='string'||t[k].length>200)))fail('HANDOFF_INVALID','Invalid source turns.');
  }
  return structuredClone(envelope);
}
const eventKey=e=>hash([e.projectScopeId,e.ticketId,e.assignmentId,e.eventId]);
function authorised(state,e) {
  if(!e||!['projectScopeId','ticketId','assignmentId','workerId','eventId'].every(k=>id(e[k]))||!state||state.projectScopeId!==e.projectScopeId||!state.assignments.some(a=>a.ticketId===e.ticketId&&a.assignmentId===e.assignmentId&&a.workerId===e.workerId))
    fail('HANDOFF_SCOPE_MISMATCH','The host has not registered this project/ticket/assignment/worker mapping.');
}
function receipt(entry) {
  return {ok:true,version:1,key:entry.key,eventId:entry.envelope.eventId,status:entry.status,acceptedAt:entry.acceptedAt,
    completedAt:entry.completedAt||null,outcomes:structuredClone(entry.outcomes||[]),durable:true};
}
/** Safe while the router is offline: receipt means centrally persisted, not yet an active memory. */
export async function submitHandoff(cwd,input) {
  const envelope=validateHandoffEnvelope(input),key=eventKey(envelope),digest=hash(envelope);
  return update(cwd,state=>{
    authorised(state,envelope);
    const prior=state.entries.find(e=>e.key===key);
    if(prior){if(prior.digest!==digest)fail('HANDOFF_EVENT_CONFLICT','An event ID was reused with different content.');return {...receipt(prior),replayed:true};}
    if(state.entries.length>=4096)fail('HANDOFF_CAPACITY','Central history reached its limit; retain the envelope for explicit maintenance.');
    const entry={key,digest,envelope,acceptedAt:new Date().toISOString(),status:'queued',outcomes:[]};
    state.entries.push(entry);writeState(cwd,state);return receipt(entry);
  });
}
export function handoffReceipt(cwd,identity) {
  const state=readState(cwd);authorised(state,identity);
  const entry=state.entries.find(e=>e.key===eventKey(identity));return entry?receipt(entry):null;
}
/** One owner handle. All graph changes are insert-only; ambiguous candidates remain in the central record. */
export async function drainHandoff(cwd,db,{limit=16}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('HANDOFF_INVALID','Drain limit must be 1..64.');
  if(!cwdForDb(db)||physical(cwdForDb(db))!==physical(cwd))fail('HANDOFF_SCOPE_MISMATCH','The writer must own the registered central workspace handle.');
  const locked=await withWorkspaceLock(cwd,()=>update(cwd,state=>{
    if(!state)return {ok:true,processed:0};
    const done=[];
    for(const entry of state.entries.filter(e=>e.status==='queued').slice(0,limit)) {
      const envelope=validateHandoffEnvelope(entry.envelope);authorised(state,envelope);
      if(entry.key!==eventKey(envelope)||entry.digest!==hash(envelope))fail('HANDOFF_UNREADABLE','Stored event identity or contents changed.');
      const outcomes=[];
      for(const [i,candidate] of envelope.candidates.entries()) {
        const uri=`trivium:handoff:${entry.key}:${i}`;
        const existing=findByUri(db,uri);
        if(existing!==null) {
          const p=db.getPayload(existing);
          if(p.type!==candidate.type||p.text!==candidate.text.trim()||p.status!=='active'||p.source?.handoff?.key!==entry.key) {
            outcomes.push({index:i,status:'needs_review',reason:'previous-memory-changed'});continue;
          }
          outcomes.push({index:i,status:'committed',nodeId:existing,reused:true});continue;
        }
        const skips=[],adjusted=[];
        // Tool-only assertions are retained for review. This prevents a worker's
        // memory-tool echo from becoming an independent source of new facts.
        const admitted=filterCandidates([{...candidate,via:'model'}],{requireSource:true,
          sourceTurns:envelope.sourceTurns.filter(t=>t.role==='user'),sourceText:envelope.sourceTurns.filter(t=>t.role==='user').map(t=>t.text).join('\n'),
          onSkip:r=>skips.push(r.reason),onAdjust:r=>adjusted.push(r.reason)});
        if(admitted.length!==1||adjusted.length){outcomes.push({index:i,status:'needs_review',reason:adjusted[0]||skips[0]||'candidate-needs-review'});continue;}
        const c=admitted[0];
        const source={...buildSource({quote:c.quote,turns:envelope.sourceTurns,sessionId:envelope.sessionId,via:'handoff'}),
          handoff:{key:entry.key,projectScopeId:envelope.projectScopeId,ticketId:envelope.ticketId,assignmentId:envelope.assignmentId,workerId:envelope.workerId,eventId:envelope.eventId}};
        const nodeId=insertNode(db,{type:c.type,name:c.name,text:c.text,aliases:c.aliases,source,uri});
        outcomes.push({index:i,status:'committed',nodeId,reused:false});
      }
      // Also flush recovered URI hits: an earlier flush may have failed after
      // changing the live engine. No terminal receipt precedes durability.
      db.flush();
      entry.outcomes=outcomes;entry.status=outcomes.some(o=>o.status==='needs_review')?'needs_review':'committed';entry.completedAt=new Date().toISOString();
      writeState(cwd,state);done.push(receipt(entry));
    }
    return {ok:true,processed:done.length,receipts:done};
  }));
  if(locked.locked)return {ok:false,code:'HANDOFF_WRITE_BUSY',processed:0};
  return locked.value;
}
