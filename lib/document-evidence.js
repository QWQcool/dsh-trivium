/** Explicit TDB 0.9.1 evidence. Source changes mark links for review; facts are never rewritten. */
import {createHash} from 'node:crypto';
import {zeroVector} from './schema.js';
import {sanitizeForWrite,payloadLooksDirty} from './hygiene.js';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const call=(db,request)=>JSON.parse(db.documentRequest(JSON.stringify(request)));
const sourceIdOk=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id);
function nextIds(db,count) {
  const ids=db.allNodeIds();if(ids.length>10000)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its node budget.');
  const max=Math.max(0,...ids.map(Number));
  if(!Number.isSafeInteger(max)||!Number.isSafeInteger(max+count))fail(422,'DOCUMENT_ID_LIMIT','Document IDs exceed the supported range.');
  return Array.from({length:count},(_,i)=>max+i+1);
}
function ownedRoots(db) {
  const ids=db.allNodeIds();if(ids.length>10000)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its node budget.');
  let bytes=0;const roots=[];
  for(const id of ids) {
    const p=db.getPayload(id);bytes+=Buffer.byteLength(JSON.stringify(p??null),'utf8');
    if(bytes>2*1024*1024)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its payload budget.');
    if(p?._tdb_document&&p.data?.type==='trivium-document-source')roots.push({id:Number(id),payload:p});
  }
  return roots;
}
export function getEvidenceDocument(db,documentId) {
  const id=Number(documentId);
  if(!Number.isSafeInteger(id)||id<=0)fail(400,'DOCUMENT_INVALID','Document ID must be a positive safe integer.');
  const p=db.getPayload(id);
  if(!p?._tdb_document||p.data?.type!=='trivium-document-source')fail(404,'DOCUMENT_NOT_FOUND','This document is not managed by the evidence feature.');
  return call(db,{operation:'get',document_id:String(id)});
}
export function evidenceDocuments(db) {
  return ownedRoots(db).map(({id})=>{const d=getEvidenceDocument(db,id);return {documentId:d.document_id,sourceId:d.source_id,revision:d.revision,contentHash:d.content_hash};});
}
export function saveEvidenceDocument(db,request) {
  if(!request||Array.isArray(request)||Object.keys(request).some(k=>!['sourceId','content','documentId','expectedRevision'].includes(k))||!sourceIdOk(request.sourceId)
    ||typeof request.content!=='string'||!request.content.trim()||Buffer.byteLength(request.content,'utf8')>65536
    ||request.expectedRevision!==undefined&&(typeof request.expectedRevision!=='string'||request.expectedRevision.length>160))fail(400,'DOCUMENT_INVALID','Provide a source ID and at most 64 KiB of explicit text.');
  if(!sanitizeForWrite(request.content).ok||!sanitizeForWrite(request.sourceId).ok)fail(422,'DOCUMENT_DIRTY','Source rejected by the existing content guard.');
  let previous=request.documentId===undefined?null:getEvidenceDocument(db,request.documentId);
  if(!previous) {
    const existing=evidenceDocuments(db).find(d=>d.sourceId===request.sourceId);
    if(existing)previous=getEvidenceDocument(db,existing.documentId);
  }
  if(previous&&previous.source_id!==request.sourceId)fail(409,'DOCUMENT_SOURCE_MISMATCH','A source identity cannot be changed in place.');
  if(previous&&request.expectedRevision!==undefined&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_CHANGED','The source changed. Reload before replacing it.');
  if(previous&&previous.content===request.content){db.flush();return {ok:true,reused:true,document:previous};}
  if(previous&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_REQUIRED','Replacing a source requires its current revision.');
  const ids=nextIds(db,previous?1:2),rootId=previous?Number(previous.document_id):ids[0],blockId=previous?ids[0]:ids[1];
  const contentHash=digest(Buffer.from(request.content,'utf8'));
  const document={source_id:request.sourceId,source_revision:'sha256:'+contentHash,parser_id:'dsh-explicit-text-v1',content:request.content,
    root:{id:String(rootId),vector:zeroVector(),payload:{type:'trivium-document-source',sourceId:request.sourceId}},
    blocks:[{key:'body',kind:'body',start_byte:0,end_byte:Buffer.byteLength(request.content,'utf8'),node:{id:String(blockId),vector:zeroVector(),payload:{type:'trivium-document-fragment'}}}]};
  const saved=call(db,{operation:'put',document,...(previous?{expected_revision:previous.revision}:{})});
  db.flush();return {ok:true,reused:false,document:saved};
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const factHash=p=>digest(JSON.stringify(canonical(p)));
export function attachDocumentEvidence(db,request) {
  if(!request||Array.isArray(request)||Object.keys(request).some(k=>!['factId','documentId','revision','quote'].includes(k))||!Number.isSafeInteger(request.factId)||request.factId<=0
    ||typeof request.revision!=='string'||request.revision.length>160||typeof request.quote!=='string'||!request.quote.trim()||request.quote.length>2000)fail(400,'DOCUMENT_INVALID','Choose a fact, current source revision and an exact quote.');
  if(!sanitizeForWrite(request.quote).ok)fail(422,'DOCUMENT_DIRTY','Quote rejected by the existing content guard.');
  const fact=db.getPayload(request.factId);
  if(!['entity','preference','decision','experience'].includes(fact?.type)||payloadLooksDirty(fact))fail(404,'DOCUMENT_FACT_NOT_FOUND','The selected memory fact is unavailable.');
  const document=getEvidenceDocument(db,request.documentId);
  if(document.revision!==request.revision)fail(409,'DOCUMENT_REVISION_CHANGED','The source changed. Reload before linking.');
  const start=document.content.indexOf(request.quote);
  if(start<0||document.content.indexOf(request.quote,start+1)>=0)fail(422,'DOCUMENT_QUOTE_AMBIGUOUS','The quote must occur exactly once in the source. Include more context.');
  const reference={document_id:document.document_id,revision:document.revision,start_byte:Buffer.byteLength(document.content.slice(0,start),'utf8'),end_byte:Buffer.byteLength(document.content.slice(0,start+request.quote.length),'utf8')};
  const evidence=call(db,{operation:'resolve',reference});
  if(evidence.text!==request.quote)fail(422,'DOCUMENT_QUOTE_INVALID','The resolved text differs from the requested quote.');
  const uri='trivium:evidence:'+digest(JSON.stringify([request.factId,factHash(fact),reference]));
  for(const id of db.allNodeIds()) {
    const p=db.getPayload(id);
    if(p?.uri===uri) {
      if(!db.getEdge(id,request.factId,'trivium.evidence.fact')||!db.getEdge(id,Number(document.document_id),'trivium.evidence.document'))
        fail(409,'DOCUMENT_LINK_CHANGED','The old association changed; inspect it before relinking.');
      db.flush();return {ok:true,reused:true,evidenceId:id,reference};
    }
  }
  const [id]=nextIds(db,1);
  db.commitTransaction([{type:'insertWithId',id,vector:zeroVector(),payload:{type:'trivium-document-evidence',uri,factId:request.factId,factHash:factHash(fact),reference,
    quote:request.quote,sourceId:document.source_id,contentHash:document.content_hash,createdAt:new Date().toISOString()}},
    {type:'link',src:id,dst:request.factId,label:'trivium.evidence.fact',weight:1},
    {type:'link',src:id,dst:Number(document.document_id),label:'trivium.evidence.document',weight:1}]);
  db.flush();return {ok:true,reused:false,evidenceId:id,reference};
}
export function documentEvidenceStatus(db,{factId}={}) {
  if(factId!==undefined&&(!Number.isSafeInteger(factId)||factId<=0))fail(400,'DOCUMENT_INVALID','Invalid fact ID.');
  const ids=db.allNodeIds();if(ids.length>10000)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its node budget.');
  const links=[];let bytes=0;
  for(const id of ids) {
    const p=db.getPayload(id);bytes+=Buffer.byteLength(JSON.stringify(p??null),'utf8');
    if(bytes>2*1024*1024)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its payload budget.');
    if(p?.type!=='trivium-document-evidence'||factId!==undefined&&p.factId!==factId)continue;
    let status='current',resolved=null,errorCode=null;
    const fact=db.getPayload(p.factId);
    if(!fact||!db.getEdge(id,p.factId,'trivium.evidence.fact'))status='fact_missing';
    else if(factHash(fact)!==p.factHash)status='fact_changed';
    else try {
      resolved=call(db,{operation:'resolve',reference:p.reference});
      if(!db.getEdge(id,Number(p.reference.document_id),'trivium.evidence.document'))status='source_missing';
    }catch(error){errorCode=error.code||'DOCUMENT_UNAVAILABLE';status=error.code==='TDB_DOCUMENT_REVISION_MISMATCH'?'source_changed':error.code==='TDB_NODE_NOT_FOUND'?'source_missing':'reference_unavailable';}
    links.push({evidenceId:id,factId:p.factId,sourceId:p.sourceId,reference:p.reference,quote:p.quote,createdAt:p.createdAt,status,needsReview:status!=='current',verification:'manual-link-not-entailed',
      ...(resolved?{resolved}:{}),...(errorCode?{errorCode}:{})});
  }
  if(Buffer.byteLength(JSON.stringify(links),'utf8')>256*1024)fail(413,'DOCUMENT_RESPONSE_LIMIT','Narrow the evidence view to one fact.');
  return {ok:true,links,needsReview:links.filter(l=>l.needsReview).length};
}
