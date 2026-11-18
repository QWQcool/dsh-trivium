/** Explicit TDB 0.9.1 evidence. Source changes mark links for review; facts are never rewritten. */
import {createHash} from 'node:crypto';
import {zeroVector} from './schema.js';
import {sanitizeForWrite,payloadLooksDirty} from './hygiene.js';
import {estimateTokens} from './tokens.js';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const call=(db,request)=>JSON.parse(db.documentRequest(JSON.stringify(request)));
const sourceIdOk=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id);
const SOURCE_BYTES = 64 * 1024;
const BLOCK_BYTES = 768;
const SEARCH_LIMITS = Object.freeze({max_scan_nodes:12000,max_payload_bytes:16*1024*1024,max_text_bytes:2*1024*1024,
  max_edges:40000,max_postings:50000,max_candidates:512,max_return_bytes:256*1024,max_query_terms:96,max_matches:512,
  max_positions:400000,max_position_visits:100000});

function byteBoundary(bytes,offset) {
  while (offset > 0 && (bytes[offset] & 0xc0) === 0x80) offset--;
  return offset;
}

function blockRanges(bytes) {
  const ranges=[];
  for (let start=0;start<bytes.length;) {
    let end=byteBoundary(bytes,Math.min(start+BLOCK_BYTES,bytes.length));
    const lineEnd=bytes.lastIndexOf(10,end-1);
    const boundary=end<bytes.length ? (lineEnd>=start+BLOCK_BYTES/2?lineEnd:bytes.lastIndexOf(32,end-1)) : end-1;
    const natural=boundary>=start+BLOCK_BYTES/2 || end===bytes.length;
    if (natural && end<bytes.length) end=boundary+1;
    if (bytes.subarray(start,end).toString('utf8').trim()) ranges.push({start_byte:start,end_byte:end});
    start=natural?end:byteBoundary(bytes,end-64);
  }
  return ranges;
}

function sourceLocation(bytes,offset) {
  const lines=bytes.subarray(0,offset).toString('utf8').split(/\r\n|\r|\n/u);
  return {line:lines.length,column:[...lines.at(-1)].length+1};
}

function referenceFor(document,start,end) {
  return {document_id:document.document_id,revision:document.revision,start_byte:start,end_byte:end};
}

function describeExcerpt(document,bytes,reference) {
  return {reference,text:bytes.subarray(reference.start_byte,reference.end_byte).toString('utf8'),
    start:sourceLocation(bytes,reference.start_byte),end:sourceLocation(bytes,reference.end_byte)};
}

function checkedReference(document,bytes,reference) {
  const start=reference?.start_byte,end=reference?.end_byte;
  if (!reference || Object.keys(reference).length !== 4 || reference.document_id !== document.document_id || reference.revision !== document.revision
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<=start || end>bytes.length
    || byteBoundary(bytes,start)!==start || byteBoundary(bytes,end)!==end)
    fail(400,'DOCUMENT_REFERENCE_INVALID','Choose a valid UTF-8 excerpt from the loaded revision.');
  return referenceFor(document,start,end);
}
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
    ||typeof request.content!=='string'||!request.content.trim()||Buffer.byteLength(request.content,'utf8')>SOURCE_BYTES
    ||request.expectedRevision!==undefined&&(typeof request.expectedRevision!=='string'||request.expectedRevision.length>160))fail(400,'DOCUMENT_INVALID','Provide a source ID and at most 64 KiB of explicit text.');
  if(!sanitizeForWrite(request.content).ok||!sanitizeForWrite(request.sourceId).ok)fail(422,'DOCUMENT_DIRTY','Source rejected by the existing content guard.');
  let previous=request.documentId===undefined?null:getEvidenceDocument(db,request.documentId);
  if(!previous) {
    const existing=ownedRoots(db).find(d=>d.payload.data.sourceId===request.sourceId);
    if(existing)previous=getEvidenceDocument(db,existing.id);
  }
  if(previous&&previous.source_id!==request.sourceId)fail(409,'DOCUMENT_SOURCE_MISMATCH','A source identity cannot be changed in place.');
  if(previous&&request.expectedRevision!==undefined&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_CHANGED','The source changed. Reload before replacing it.');
  if(previous&&previous.content===request.content){db.flush();return {ok:true,reused:true,document:previous};}
  if(previous&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_REQUIRED','Replacing a source requires its current revision.');
  const bytes=Buffer.from(request.content,'utf8'),ranges=blockRanges(bytes),ids=nextIds(db,ranges.length+(previous?0:1));
  const rootId=previous?Number(previous.document_id):ids.shift(),vector=zeroVector();
  const document={source_id:request.sourceId,source_revision:'sha256:'+digest(bytes),parser_id:'dsh-explicit-blocks-v2',content:request.content,
    root:{id:String(rootId),vector,payload:{type:'trivium-document-source',sourceId:request.sourceId}},
    blocks:ranges.map((range,index)=>({key:'excerpt-'+index,kind:'body',...range,
      node:{id:String(ids[index]),vector,payload:{type:'trivium-document-fragment'}}}))};
  const saved=call(db,{operation:'put',document,...(previous?{expected_revision:previous.revision}:{})});
  db.flush();return {ok:true,reused:false,document:saved};
}

export function searchEvidenceFragments(db,{documentId,revision,query,limit=4,budgetTokens=300}={}) {
  if (!Number.isSafeInteger(documentId) || documentId<=0 || typeof revision!=='string' || !revision || revision.length>160
    || typeof query!=='string' || !query.trim() || Buffer.byteLength(query,'utf8')>1024
    || !Number.isSafeInteger(limit) || limit<1 || limit>8 || !Number.isSafeInteger(budgetTokens) || budgetTokens<64 || budgetTokens>1200)
    fail(400,'DOCUMENT_SEARCH_INVALID','Choose a loaded source, a short query and a budget of 64–1200.');
  const document=getEvidenceDocument(db,documentId),bytes=Buffer.from(document.content,'utf8');
  if (document.revision!==revision) fail(409,'DOCUMENT_REVISION_CHANGED','Reload the changed source before searching.');
  if (bytes.length>SOURCE_BYTES || !sanitizeForWrite(document.content).ok) fail(422,'DOCUMENT_WORK_LIMIT','The source exceeds the supported inspection limits.');
  const legacy=document.blocks.some(block=>block.node_id && block.end_byte-block.start_byte>BLOCK_BYTES);
  let result;
  try {
    result=call(db,{operation:'search',query:{text:query.trim(),level:'block',document_ids:[String(documentId)],source_ids:[document.source_id],
      expected_revisions:{[documentId]:revision},max_documents:1,hits_per_document:limit,
      ...(legacy?{include_matches:true}:{}),limits:SEARCH_LIMITS}});
  } catch(error) {
    if (error.code==='TDB_DOCUMENT_REVISION_MISMATCH') fail(409,'DOCUMENT_REVISION_CHANGED','Reload the changed source before searching.');
    if (/QUEUE_?FULL|BUDGET/i.test(String(error.code)) || error.resource) fail(422,'DOCUMENT_WORK_LIMIT','Document search exceeded its work budget.');
    if (/CANCELLED|DEADLINE/i.test(String(error.code))) fail(408,'DOCUMENT_SEARCH_TIMEOUT','Document search did not finish.');
    throw error;
  }
  const fragments=[],lines=[],ranges=new Set();let omitted=0;
  for(const group of result.groups || []) for (const hit of group.hits || []) {
    const whole=checkedReference(document,bytes,hit.evidence?.reference);
    let reference=whole;
    if (whole.end_byte-whole.start_byte>BLOCK_BYTES) {
      const match=hit.matches?.[0]?.evidence?.reference;
      if (!match) {omitted++;continue;}
      const around=checkedReference(document,bytes,match);
      reference=referenceFor(document,byteBoundary(bytes,Math.max(whole.start_byte,around.start_byte-160)),
        byteBoundary(bytes,Math.min(whole.end_byte,around.end_byte+384)));
    }
    const key=reference.start_byte+':'+reference.end_byte;
    if (ranges.has(key)) continue;
    ranges.add(key);
    const excerpt=describeExcerpt(document,bytes,reference);
    const label=`${document.source_id}:${excerpt.start.line}-${excerpt.end.line}`;
    const block=`${label}\n${excerpt.text}`;
    const attempt=[...lines,block].join('\n\n');
    if (estimateTokens(attempt)>budgetTokens) {omitted++;continue;}
    lines.push(block);fragments.push({...excerpt,blockKey:hit.block_key,score:hit.score});
  }
  const context=lines.join('\n\n');
  return {ok:true,sourceId:document.source_id,documentId:document.document_id,revision,fragments,context,budgetTokens,
    estimatedTokens:estimateTokens(context),matchedUnits:result.matched_units,omitted,truncated:result.matched_units>limit,answerability:'not_assessed'};
}

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const factHash=p=>digest(JSON.stringify(canonical(p)));
export function attachDocumentEvidence(db,request) {
  if(!request||Array.isArray(request)||Object.keys(request).some(k=>!['factId','documentId','revision','quote','reference'].includes(k))||!Number.isSafeInteger(request.factId)||request.factId<=0
    ||typeof request.revision!=='string'||request.revision.length>160||typeof request.quote!=='string'||!request.quote.trim()||request.quote.length>2000)fail(400,'DOCUMENT_INVALID','Choose a fact, current source revision and an exact quote.');
  if(!sanitizeForWrite(request.quote).ok)fail(422,'DOCUMENT_DIRTY','Quote rejected by the existing content guard.');
  const fact=db.getPayload(request.factId);
  if(!['entity','preference','decision','experience'].includes(fact?.type)||payloadLooksDirty(fact))fail(404,'DOCUMENT_FACT_NOT_FOUND','The selected memory fact is unavailable.');
  const document=getEvidenceDocument(db,request.documentId);
  if(document.revision!==request.revision)fail(409,'DOCUMENT_REVISION_CHANGED','The source changed. Reload before linking.');
  const bytes=Buffer.from(document.content,'utf8');
  let reference;
  if (request.reference!==undefined) reference=checkedReference(document,bytes,request.reference);
  else {
    const start=document.content.indexOf(request.quote);
    if(start<0||document.content.indexOf(request.quote,start+1)>=0)fail(422,'DOCUMENT_QUOTE_AMBIGUOUS','The quote must occur exactly once in the source. Include more context.');
    reference=referenceFor(document,Buffer.byteLength(document.content.slice(0,start),'utf8'),Buffer.byteLength(document.content.slice(0,start+request.quote.length),'utf8'));
  }
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
    quote:request.quote,sourceId:document.source_id,contentHash:document.content_hash,location:{start:sourceLocation(bytes,reference.start_byte),end:sourceLocation(bytes,reference.end_byte)},createdAt:new Date().toISOString()}},
    {type:'link',src:id,dst:request.factId,label:'trivium.evidence.fact',weight:1},
    {type:'link',src:id,dst:Number(document.document_id),label:'trivium.evidence.document',weight:1}]);
  db.flush();return {ok:true,reused:false,evidenceId:id,reference};
}
function compareSourceRevision(document,link) {
  const bytes=Buffer.from(document.content,'utf8');
  const exact=document.content.indexOf(link.quote);
  const same=exact>=0 && document.content.indexOf(link.quote,exact+1)<0;
  const start=same?Buffer.byteLength(document.content.slice(0,exact),'utf8'):
    byteBoundary(bytes,Math.max(0,Math.min(link.reference.start_byte,bytes.length)-160));
  const end=byteBoundary(bytes,Math.min(bytes.length,start+(same?Buffer.byteLength(link.quote,'utf8'):384)));
  return {previous:{revision:link.reference.revision,text:link.quote,location:link.location || null},
    current:{...describeExcerpt(document,bytes,referenceFor(document,start,end)),match:same?'same-excerpt':'near-previous-byte'}};
}

export function documentEvidenceStatus(db,{factId,sourceId}={}) {
  if(factId!==undefined&&(!Number.isSafeInteger(factId)||factId<=0))fail(400,'DOCUMENT_INVALID','Invalid fact ID.');
  if(sourceId!==undefined&&!sourceIdOk(sourceId))fail(400,'DOCUMENT_INVALID','Invalid source ID.');
  const ids=db.allNodeIds();if(ids.length>10000)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its node budget.');
  const links=[],currentDocuments=new Map();let bytes=0;
  for(const id of ids) {
    const p=db.getPayload(id);bytes+=Buffer.byteLength(JSON.stringify(p??null),'utf8');
    if(bytes>2*1024*1024)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its payload budget.');
    if(p?.type!=='trivium-document-evidence'||factId!==undefined&&p.factId!==factId||sourceId!==undefined&&p.sourceId!==sourceId)continue;
    let status='current',resolved=null,errorCode=null;
    const fact=db.getPayload(p.factId);
    if(!fact||!db.getEdge(id,p.factId,'trivium.evidence.fact'))status='fact_missing';
    else if(factHash(fact)!==p.factHash)status='fact_changed';
    else try {
      resolved=call(db,{operation:'resolve',reference:p.reference});
      if(!db.getEdge(id,Number(p.reference.document_id),'trivium.evidence.document'))status='source_missing';
    }catch(error){errorCode=error.code||'DOCUMENT_UNAVAILABLE';status=error.code==='TDB_DOCUMENT_REVISION_MISMATCH'?'source_changed':error.code==='TDB_NODE_NOT_FOUND'?'source_missing':'reference_unavailable';}
    let comparison;
    if(status==='source_changed' && db.getEdge(id,Number(p.reference.document_id),'trivium.evidence.document')) {
      const key=p.reference.document_id;
      try {
        if(!currentDocuments.has(key))currentDocuments.set(key,getEvidenceDocument(db,key));
        comparison=compareSourceRevision(currentDocuments.get(key),p);
      } catch { /* The old quote remains available without a comparison. */ }
    }
    links.push({evidenceId:id,factId:p.factId,sourceId:p.sourceId,reference:p.reference,quote:p.quote,location:p.location || null,createdAt:p.createdAt,status,needsReview:status!=='current',verification:'manual-link-not-entailed',
      ...(comparison?{comparison}:{}),
      ...(resolved?{resolved}:{}),...(errorCode?{errorCode}:{})});
  }
  if(Buffer.byteLength(JSON.stringify(links),'utf8')>256*1024)fail(413,'DOCUMENT_RESPONSE_LIMIT','Narrow the evidence view to one fact.');
  return {ok:true,links,needsReview:links.filter(l=>l.needsReview).length};
}
