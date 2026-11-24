/** Explicit document evidence. Keep original citations while comparing later revisions. */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,opendirSync,readSync,realpathSync,statSync} from 'node:fs';
import {extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {zeroVector} from './schema.js';
import {sanitizeForWrite,payloadLooksDirty} from './hygiene.js';
import {estimateTokens} from './tokens.js';
import {readDerived,writeDerived} from './derived-cache.js';
import {cwdForDb} from './store.js';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const call=(db,request)=>JSON.parse(db.documentRequest(JSON.stringify(request)));
const sourceIdOk=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id);
const SOURCE_BYTES = 64 * 1024;
const BLOCK_BYTES = 768;
const DOCUMENT_SOURCE_TYPE = 'trivium-document-source';
const DOCUMENT_LINK_TYPE = 'trivium-document-evidence';
const MAX_SCOPED_ROWS = 10000;
const LINK_RESPONSE_BYTES = 256 * 1024;
const CATALOG_KEY = 'document-evidence:sources';
export const EVIDENCE_PAGE_SIZE = 20;
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

function uniqueQuoteStart(content, quote) {
  if (typeof quote !== 'string' || !quote) return -1;
  const start = content.indexOf(quote);
  return start >= 0 && content.indexOf(quote, start + 1) < 0 ? start : -1;
}

// Ignore byte shifts and line-ending changes outside the quoted text. Keep the
// full enclosing lines and their Markdown heading path, including qualifiers.
function documentContext(document) {
  const bytes = Buffer.from(document.content, 'utf8');
  const lines = [], headings = [];
  let offset = 0, section = '';
  for (const [raw] of document.content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    const text = raw.replace(/[\r\n]+$/u, '');
    const heading = text.match(/^ {0,3}(#{1,6})[ \t]+(\S.*)$/u);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings.at(-1)[0] >= level) headings.pop();
      headings.push([level, heading[2]]);
      section = digest(JSON.stringify(headings));
    }
    lines.push({offset, text, section});
    offset += Buffer.byteLength(raw, 'utf8');
  }
  const lineAt = value => {
    let low = 0, high = lines.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lines[mid].offset > value) high = mid;
      else low = mid;
    }
    return low;
  };
  const hashRange = (start, end) => {
    const first = lineAt(start), last = lineAt(end - 1);
    return digest(JSON.stringify([lines[first].section, lines.slice(first, last + 1).map(line => line.text)]));
  };
  return {bytes, hashRange};
}

function originalContextHash(document, context, reference, quote) {
  const exact = uniqueQuoteStart(document.content, quote);
  if (exact < 0) return null;
  const start = Buffer.byteLength(document.content.slice(0, exact), 'utf8');
  const end = start + Buffer.byteLength(quote, 'utf8');
  return start === reference.start_byte && end === reference.end_byte ? context.hashRange(start, end) : null;
}

function preserveLegacyContexts(db, document) {
  const ids = scopedIds(db, {type: DOCUMENT_LINK_TYPE, sourceId: document.source_id});
  const updates = [];
  let context;
  for (const id of ids) {
    const link = db.getPayload(id);
    if (!link || link.excerptContextHash !== undefined || link.reference?.document_id !== document.document_id
      || link.reference.revision !== document.revision || link.contentHash !== document.content_hash
      || !db.getEdge(id, Number(document.document_id), 'trivium.evidence.document')) continue;
    context ??= documentContext(document);
    const excerptContextHash = originalContextHash(document, context, link.reference, link.quote);
    updates.push({type:'updatePayload', id, payload:{...link, excerptContextHash}});
  }
  // Captures only the verified outgoing revision. It is safe if put fails
  // after this transaction, and safe to retry against the same revision.
  if (updates.length) db.commitTransaction(updates);
}

function nextIds(db,count) {
  const ids=db.allNodeIds();if(ids.length>10000)fail(422,'DOCUMENT_WORK_LIMIT','Evidence inspection exceeds its node budget.');
  const max=Math.max(0,...ids.map(Number));
  if(!Number.isSafeInteger(max)||!Number.isSafeInteger(max+count))fail(422,'DOCUMENT_ID_LIMIT','Document IDs exceed the supported range.');
  return Array.from({length:count},(_,i)=>max+i+1);
}
function scopedIds(db, filters) {
  try {
    // The link retains its filter fields even when the fact or document is
    // deleted. Index the existing payloads without rewriting those links.
    if (cwdForDb(db)) {
      const indexed = new Set(db.indexInfo().filter(index => index.kind === 'hash').map(index => index.field));
      for (const field of Object.keys(filters)) if (!indexed.has(field)) db.createIndex(field);
      return db.indexedLookup(filters, MAX_SCOPED_ROWS).sort((a, b) => a - b);
    }
    // Public read helpers also accept a read-only TDB handle. Its existing
    // indexes, if any, can still serve this projection without creating one.
    const rows = db.tql(`FIND ${JSON.stringify(filters)} RETURN _.id AS id ORDER BY _.id LIMIT ${MAX_SCOPED_ROWS + 1}`);
    if (rows.length <= MAX_SCOPED_ROWS) return rows.map(row => row.id);
  } catch (error) {
    if (error.code !== 'TDB_QUERY_BUDGET') throw error;
  }
  fail(422,'DOCUMENT_WORK_LIMIT','Too many evidence associations. Narrow to a fact or source.');
}

function sourceCatalog(db) {
  const cached = readDerived(db, CATALOG_KEY);
  if (cached.hit) return cached.value;
  // TDB 0.9.1 stores the managed-source marker in nested data. Project only
  // that metadata, then keep the resulting catalog on the live handle.
  const rows = db.tql(`FIND {_tdb_document: {$exists: true}} RETURN _.id AS id, _.data AS data ORDER BY _.id LIMIT ${MAX_SCOPED_ROWS + 1}`);
  if (rows.length > MAX_SCOPED_ROWS) fail(422,'DOCUMENT_WORK_LIMIT','The document catalog exceeds its metadata budget.');
  const roots = rows.filter(row => row.data?.type === DOCUMENT_SOURCE_TYPE)
    .map(row => ({id: Number(row.id), sourceId: row.data.sourceId}));
  writeDerived(db, CATALOG_KEY, roots);
  return roots;
}

function validatePage(afterId, limit) {
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPED_ROWS) {
    fail(400,'DOCUMENT_PAGE_INVALID','Choose a valid evidence page cursor and limit.');
  }
}
export function getEvidenceDocument(db,documentId) {
  const id=Number(documentId);
  if(!Number.isSafeInteger(id)||id<=0)fail(400,'DOCUMENT_INVALID','Document ID must be a positive safe integer.');
  const p=db.getPayload(id);
  if(!p?._tdb_document||p.data?.type!==DOCUMENT_SOURCE_TYPE)fail(404,'DOCUMENT_NOT_FOUND','This document is not managed by the evidence feature.');
  return call(db,{operation:'get',document_id:String(id)});
}
export function evidenceDocuments(db, {sourceId, afterId = 0, limit = MAX_SCOPED_ROWS} = {}) {
  if (sourceId !== undefined && !sourceIdOk(sourceId)) fail(400,'DOCUMENT_INVALID','Invalid source ID.');
  validatePage(afterId, limit);
  return sourceCatalog(db).filter(row => row.id > afterId && (sourceId === undefined || row.sourceId === sourceId))
    .slice(0, limit).map(({id}) => {
      const document = db.getPayload(id)._tdb_document;
      return {documentId: document.document_id, sourceId: document.source_id, revision: document.revision, contentHash: document.content_hash};
    });
}
export function saveEvidenceDocument(db,request) {
  if(!request||Array.isArray(request)||Object.keys(request).some(k=>!['sourceId','content','documentId','expectedRevision'].includes(k))||!sourceIdOk(request.sourceId)
    ||typeof request.content!=='string'||!request.content.trim()||Buffer.byteLength(request.content,'utf8')>SOURCE_BYTES
    ||request.expectedRevision!==undefined&&(typeof request.expectedRevision!=='string'||request.expectedRevision.length>160))fail(400,'DOCUMENT_INVALID','Provide a source ID and at most 64 KiB of explicit text.');
  if(!sanitizeForWrite(request.content).ok||!sanitizeForWrite(request.sourceId).ok)fail(422,'DOCUMENT_DIRTY','Source rejected by the existing content guard.');
  let previous=request.documentId===undefined?null:getEvidenceDocument(db,request.documentId);
  if(!previous) {
    const existing=sourceCatalog(db).find(d=>d.sourceId===request.sourceId);
    if(existing)previous=getEvidenceDocument(db,existing.id);
  }
  if(previous&&previous.source_id!==request.sourceId)fail(409,'DOCUMENT_SOURCE_MISMATCH','A source identity cannot be changed in place.');
  if(previous&&request.expectedRevision!==undefined&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_CHANGED','The source changed. Reload before replacing it.');
  if(previous&&previous.content===request.content){db.flush();return {ok:true,reused:true,document:previous};}
  if(previous&&request.expectedRevision!==previous.revision)fail(409,'DOCUMENT_REVISION_REQUIRED','Replacing a source requires its current revision.');
  const bytes=Buffer.from(request.content,'utf8'),ranges=blockRanges(bytes),ids=nextIds(db,ranges.length+(previous?0:1));
  const rootId=previous?Number(previous.document_id):ids.shift(),vector=zeroVector();
  const document={source_id:request.sourceId,source_revision:'sha256:'+digest(bytes),parser_id:'dsh-explicit-blocks-v2',content:request.content,
    root:{id:String(rootId),vector,payload:{type:DOCUMENT_SOURCE_TYPE,sourceId:request.sourceId}},
    blocks:ranges.map((range,index)=>({key:'excerpt-'+index,kind:'body',...range,
      node:{id:String(ids[index]),vector,payload:{type:'trivium-document-fragment'}}}))};
  if (previous) preserveLegacyContexts(db, previous);
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
  const result=runEvidenceSearch(db,{text:query.trim(),level:'block',document_ids:[String(documentId)],source_ids:[document.source_id],
    expected_revisions:{[documentId]:revision},max_documents:1,hits_per_document:limit,...(legacy?{include_matches:true}:{})});
  const fragments=[],lines=[],ranges=new Set();let omitted=0;
  for(const group of result.groups || []) for (const hit of group.hits || []) {
    const reference=fragmentReference(document,bytes,hit);
    if (!reference) {omitted++;continue;}
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

function runEvidenceSearch(db,query) {
  try { return call(db,{operation:'search',query:{...query,limits:SEARCH_LIMITS}}); }
  catch(error) {
    if (error.code==='TDB_DOCUMENT_REVISION_MISMATCH') fail(409,'DOCUMENT_REVISION_CHANGED','Reload the changed source before searching.');
    if (/QUEUE_?FULL|BUDGET/i.test(String(error.code)) || error.resource) fail(422,'DOCUMENT_WORK_LIMIT','Document search exceeded its work budget.');
    if (/CANCELLED|DEADLINE/i.test(String(error.code))) fail(408,'DOCUMENT_SEARCH_TIMEOUT','Document search did not finish.');
    throw error;
  }
}

function fragmentReference(document,bytes,hit) {
  const whole=checkedReference(document,bytes,hit.evidence?.reference);
  if (whole.end_byte-whole.start_byte<=BLOCK_BYTES) return whole;
  const match=hit.matches?.[0]?.evidence?.reference;
  if (!match) return null;
  const around=checkedReference(document,bytes,match);
  if(around.start_byte<whole.start_byte || around.end_byte>whole.end_byte)
    fail(500,'DOCUMENT_SEARCH_SCOPE_VIOLATION','Native match escaped its evidence block.');
  return referenceFor(document,byteBoundary(bytes,Math.max(whole.start_byte,around.start_byte-160)),
    byteBoundary(bytes,Math.min(whole.end_byte,around.end_byte+384)));
}

const searchId=id=>typeof id==='number' || typeof id==='string' && /^[1-9][0-9]*$/u.test(id) ? Number(id) : NaN;
const orderedString=(a,b)=>a<b?-1:a>b?1:0;

/** Search only explicitly selected saved source revisions on this database handle. */
export function searchEvidenceSources(db, request={}) {
  const invalid=()=>fail(400,'DOCUMENT_SEARCH_INVALID','Select 1-8 saved source revisions, a short query and a budget of 64-1200.');
  if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!['sources','query','limit','budgetTokens'].includes(k))) invalid();
  const {sources,query,limit=8,budgetTokens=600}=request;
  if(!Array.isArray(sources)||sources.length<1||sources.length>8||typeof query!=='string'||!query.trim()||Buffer.byteLength(query,'utf8')>1024
    ||!Number.isSafeInteger(limit)||limit<1||limit>8||!Number.isSafeInteger(budgetTokens)||budgetTokens<64||budgetTokens>1200) invalid();
  const selected=new Map(), sourceIds=new Set(); let totalBytes=0, legacy=false;
  for(const selection of sources) {
    if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).length!==3
      ||!sourceIdOk(selection.sourceId)||typeof selection.revision!=='string'||!selection.revision||selection.revision.length>160) invalid();
    const id=searchId(selection.documentId);
    if(!Number.isSafeInteger(id)||id<=0||selected.has(String(id))||sourceIds.has(selection.sourceId)) invalid();
    const document=getEvidenceDocument(db,id), bytes=Buffer.from(document.content,'utf8');
    if(document.document_id!==String(id)||document.source_id!==selection.sourceId)
      fail(404,'DOCUMENT_NOT_FOUND','The selected source is not available in this workspace.');
    if(document.revision!==selection.revision) fail(409,'DOCUMENT_REVISION_CHANGED','Reload the changed source before searching.');
    totalBytes+=bytes.length;
    if(bytes.length>SOURCE_BYTES||totalBytes>8*SOURCE_BYTES||!sanitizeForWrite(document.content).ok)
      fail(422,'DOCUMENT_WORK_LIMIT','The selected sources exceed the supported inspection limits.');
    legacy ||= document.blocks.some(block=>block.node_id && block.end_byte-block.start_byte>BLOCK_BYTES);
    const scope={sourceId:document.source_id,documentId:document.document_id,revision:document.revision};
    selected.set(String(id),{document,bytes,scope}); sourceIds.add(scope.sourceId);
  }
  const records=[...selected.values()].sort((a,b)=>orderedString(a.scope.sourceId,b.scope.sourceId));
  const scopes=records.map(record=>record.scope);
  const result=runEvidenceSearch(db,{text:query.trim(),level:'block',document_ids:scopes.map(row=>row.documentId),
    source_ids:scopes.map(row=>row.sourceId),expected_revisions:Object.fromEntries(scopes.map(row=>[row.documentId,row.revision])),
    max_documents:scopes.length,hits_per_document:limit,...(legacy?{include_matches:true}:{})});
  const candidates=[],ranges=new Set(); let omitted=0, received=0;
  for(const group of result.groups || []) for(const hit of group.hits || []) {
    received++;
    const record=selected.get(hit.evidence?.reference?.document_id);
    if(!record) fail(500,'DOCUMENT_SEARCH_SCOPE_VIOLATION','Native results escaped the selected sources.');
    const {document,bytes,scope}=record;
    const reference=fragmentReference(document,bytes,hit);
    if(!reference) {omitted++;continue;}
    candidates.push({...scope,...describeExcerpt(document,bytes,reference),blockKey:hit.block_key,score:hit.score});
  }
  candidates.sort((a,b)=>(b.score??0)-(a.score??0)||orderedString(a.sourceId,b.sourceId)||
    a.reference.start_byte-b.reference.start_byte||a.reference.end_byte-b.reference.end_byte||orderedString(a.blockKey,b.blockKey));
  const fragments=[],lines=[];
  for(const fragment of candidates) {
    const {reference}=fragment, key=JSON.stringify([fragment.sourceId,reference.document_id,reference.revision,reference.start_byte,reference.end_byte]);
    if(ranges.has(key)) continue;
    ranges.add(key);
    const block=fragment.sourceId+':'+fragment.start.line+'-'+fragment.end.line+'\n'+fragment.text;
    if(fragments.length===limit||estimateTokens([...lines,block].join('\n\n'))>budgetTokens) {omitted++;continue;}
    fragments.push(fragment); lines.push(block);
  }
  const context=lines.join('\n\n'), matchedUnits=result.matched_units;
  return {ok:true,sources:scopes,fragments,context,budgetTokens,estimatedTokens:estimateTokens(context),
    matchedUnits,omitted,truncated:omitted>0||matchedUnits>received,answerability:'not_assessed'};
}

export {groupDocumentEvidenceLinks} from './document-citation-groups.js';

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
    const start=uniqueQuoteStart(document.content,request.quote);
    if(start<0)fail(422,'DOCUMENT_QUOTE_AMBIGUOUS','The quote must occur exactly once in the source. Include more context.');
    reference=referenceFor(document,Buffer.byteLength(document.content.slice(0,start),'utf8'),Buffer.byteLength(document.content.slice(0,start+request.quote.length),'utf8'));
  }
  const evidence=call(db,{operation:'resolve',reference});
  if(evidence.text!==request.quote)fail(422,'DOCUMENT_QUOTE_INVALID','The resolved text differs from the requested quote.');
  const uri='trivium:evidence:'+digest(JSON.stringify([request.factId,factHash(fact),reference]));
  for(const id of scopedIds(db, {type: DOCUMENT_LINK_TYPE, factId: request.factId, sourceId: document.source_id})) {
    const p=db.getPayload(id);
    if(p?.uri===uri) {
      if(!db.getEdge(id,request.factId,'trivium.evidence.fact')||!db.getEdge(id,Number(document.document_id),'trivium.evidence.document'))
        fail(409,'DOCUMENT_LINK_CHANGED','The old association changed; inspect it before relinking.');
      db.flush();return {ok:true,reused:true,evidenceId:id,reference};
    }
  }
  const [id]=nextIds(db,1);
  const excerptContextHash=originalContextHash(document,documentContext(document),reference,request.quote);
  db.commitTransaction([{type:'insertWithId',id,vector:zeroVector(),payload:{type:DOCUMENT_LINK_TYPE,uri,factId:request.factId,factHash:factHash(fact),reference,
    quote:request.quote,sourceId:document.source_id,contentHash:document.content_hash,excerptContextHash,
    location:{start:sourceLocation(bytes,reference.start_byte),end:sourceLocation(bytes,reference.end_byte)},createdAt:new Date().toISOString()}},
    {type:'link',src:id,dst:request.factId,label:'trivium.evidence.fact',weight:1},
    {type:'link',src:id,dst:Number(document.document_id),label:'trivium.evidence.document',weight:1}]);
  db.flush();return {ok:true,reused:false,evidenceId:id,reference};
}
function compareSourceRevision(document,context,link) {
  const {bytes,hashRange}=context;
  const exact=uniqueQuoteStart(document.content,link.quote);
  const same=exact>=0;
  const start=same?Buffer.byteLength(document.content.slice(0,exact),'utf8'):
    byteBoundary(bytes,Math.max(0,Math.min(link.reference.start_byte,bytes.length)-160));
  const end=byteBoundary(bytes,Math.min(bytes.length,start+(same?Buffer.byteLength(link.quote,'utf8'):384)));
  return {previous:{revision:link.reference.revision,text:link.quote,location:link.location || null},
    current:{...describeExcerpt(document,bytes,referenceFor(document,start,end)),match:same?'same-excerpt':'near-previous-byte'},
    contextUnchanged:Boolean(same && link.excerptContextHash && link.excerptContextHash===hashRange(start,end))};
}

export function documentEvidenceStatus(db, {factId, sourceId, afterId = 0, limit = MAX_SCOPED_ROWS} = {}) {
  if(factId!==undefined&&(!Number.isSafeInteger(factId)||factId<=0))fail(400,'DOCUMENT_INVALID','Invalid fact ID.');
  if(sourceId!==undefined&&!sourceIdOk(sourceId))fail(400,'DOCUMENT_INVALID','Invalid source ID.');
  validatePage(afterId, limit);
  const filters = {type: DOCUMENT_LINK_TYPE};
  if (factId !== undefined) filters.factId = factId;
  if (sourceId !== undefined) filters.sourceId = sourceId;
  const ids = scopedIds(db, filters).filter(id => id > afterId);
  const links=[],currentDocuments=new Map();let bytes=2;
  for(const id of ids.slice(0, limit)) {
    const p=db.getPayload(id);
    let status='current',resolved=null,errorCode=null;
    const fact=db.getPayload(p.factId);
    const documentId=Number(p.reference?.document_id);
    if(!fact||!db.getEdge(id,p.factId,'trivium.evidence.fact'))status='fact_missing';
    else if(factHash(fact)!==p.factHash)status='fact_changed';
    else if(!p.reference || !db.getEdge(id,documentId,'trivium.evidence.document'))status='source_missing';
    else try {
      resolved=call(db,{operation:'resolve',reference:p.reference});
    }catch(error){errorCode=error.code||'DOCUMENT_UNAVAILABLE';status=error.code==='TDB_DOCUMENT_REVISION_MISMATCH'?'source_changed':error.code==='TDB_NODE_NOT_FOUND'?'source_missing':'reference_unavailable';}
    let comparison;
    if(status==='source_changed') {
      try {
        if(!currentDocuments.has(documentId)) {
          const document=getEvidenceDocument(db,documentId);
          currentDocuments.set(documentId,{document,context:documentContext(document)});
        }
        const {document,context}=currentDocuments.get(documentId);
        comparison=compareSourceRevision(document,context,p);
        if(comparison.contextUnchanged) {status='source_unchanged';errorCode=null;}
      } catch { /* The old quote remains available without a comparison. */ }
    }
    const link = {evidenceId:id,factId:p.factId,sourceId:p.sourceId,reference:p.reference,quote:p.quote,location:p.location || null,createdAt:p.createdAt,status,
      needsReview:status!=='current' && status!=='source_unchanged',verification:'manual-link-not-entailed',
      ...(comparison?{comparison}:{}),
      ...(resolved?{resolved}:{}),...(errorCode?{errorCode}:{})};
    const linkBytes = Buffer.byteLength(JSON.stringify(link), 'utf8') + 1;
    if (bytes + linkBytes > LINK_RESPONSE_BYTES) {
      if (!links.length) fail(413,'DOCUMENT_RESPONSE_LIMIT','One evidence association exceeds the response budget.');
      break;
    }
    links.push(link);
    bytes += linkBytes;
  }
  const reviews=links.filter(link=>link.needsReview);
  return {ok:true,links,needsReview:reviews.length,reviewFactIds:[...new Set(reviews.map(link=>link.factId))],
    nextEvidenceAfter: ids.length > links.length ? links.at(-1).evidenceId : null};
}

const IMPORT_EXTENSIONS=new Set(['.md','.txt']);
const IMPORT_SKIP_DIRS=new Set(['node_modules','.git','.dsh','dist','coverage','.tmp']);
const IMPORT_SCAN_LIMIT=512;
const skipDirectory=name=>name.startsWith('.')||IMPORT_SKIP_DIRS.has(name.toLowerCase());
const relativeLabel=(base,path)=>relative(base,path).split(sep).join('/')||'.';
const inside=(base,path)=>{
  const tail=relative(base,path);
  return !isAbsolute(tail)&&tail.split(sep)[0]!=='..';
};

function directoryRoot(dir,workspace) {
  if(typeof dir!=='string'||!dir.trim()||dir.length>1024||/[\x00-\x1f]/.test(dir))fail(400,'DOCUMENT_INVALID','Provide a directory path to import.');
  const outside=()=>fail(400,'DOCUMENT_DIRECTORY_SCOPE','Choose a regular directory inside this workspace.');
  const base=workspace?realpathSync.native(workspace):null;
  const requested=base?resolve(base,dir):resolve(dir);
  if(base) {
    if(isAbsolute(dir)||/^[a-z]:/i.test(dir)||!inside(base,requested))outside();
    let parent=base;
    for(const part of relative(base,requested).split(sep).filter(Boolean)) {
      if(skipDirectory(part))outside();
      parent=join(parent,part);
      const entry=lstatSync(parent,{throwIfNoEntry:false});
      if(entry?.isSymbolicLink())outside();
      if(!entry?.isDirectory())break;
    }
  }
  let stat;
  try{stat=(base?lstatSync:statSync)(requested,{throwIfNoEntry:false});}
  catch(error){if(error.code!=='ENOTDIR')throw error;}
  if(!stat)fail(404,'DOCUMENT_DIRECTORY_NOT_FOUND','The directory does not exist.');
  if(!stat.isDirectory())fail(400,'DOCUMENT_INVALID','Provide a directory, not a file or link.');
  const root=realpathSync.native(requested);
  if(base&&(!inside(base,root)||relative(base,root).split(sep).some(skipDirectory)))outside();
  return {root,directory:base?relativeLabel(base,root):root};
}

function readDirectoryFile(root,file,maxBytes) {
  const entry=lstatSync(file);
  if(!entry.isFile()||!inside(root,realpathSync.native(file)))return {reason:'link'};
  if(entry.size>maxBytes)return {reason:'too-large'};
  const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.dev!==entry.dev||opened.ino!==entry.ino||!inside(root,realpathSync.native(file)))return {reason:'link'};
    if(opened.size>maxBytes)return {reason:'too-large'};
    const bytes=Buffer.allocUnsafe(maxBytes+1);
    let offset=0;
    while(offset<bytes.length) {
      const count=readSync(fd,bytes,offset,bytes.length-offset,null);
      if(!count)break;
      offset+=count;
    }
    if(offset>maxBytes)return {reason:'too-large'};
    let content;
    try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,offset));}
    catch{return {reason:'invalid-text'};}
    if(!content.trim())return {reason:'empty'};
    return sanitizeForWrite(content).ok?{content}:{reason:'dirty'};
  } finally {closeSync(fd);}
}

function directoryPlan(db,{dir,workspace,limit=32,maxFileBytes=SOURCE_BYTES,maxDepth=3}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail(400,'DOCUMENT_INVALID','The import limit must be 1–64 files.');
  if(!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1024||maxFileBytes>SOURCE_BYTES)fail(400,'DOCUMENT_INVALID','The per-file byte limit is out of range.');
  if(!Number.isSafeInteger(maxDepth)||maxDepth<0||maxDepth>3)fail(400,'DOCUMENT_INVALID','The directory depth must be 0–3.');
  const {root,directory}=directoryRoot(dir,workspace);
  const prefix='directory:'+digest(root)+'/';
  const found=[],skipped=[];
  let scanned=0,truncated=false;
  const walk=(folder,depth)=>{
    const entries=[];
    let handle;
    try {
      if(!lstatSync(folder).isDirectory()||!inside(root,realpathSync.native(folder))) {
        skipped.push({path:relativeLabel(root,folder),reason:'link'});
        return;
      }
      handle=opendirSync(folder);
      for(let entry;(entry=handle.readSync());) {
        if(scanned===IMPORT_SCAN_LIMIT){truncated=true;break;}
        scanned++;
        entries.push(entry);
      }
    }catch{skipped.push({path:relativeLabel(root,folder),reason:'unreadable'});return;}
    finally{handle?.closeSync();}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const full=join(folder,entry.name),path=relativeLabel(root,full);
      if(entry.isDirectory()){
        if(depth>=maxDepth||skipDirectory(entry.name))skipped.push({path,reason:'directory'});
        else if(scanned<IMPORT_SCAN_LIMIT)walk(full,depth+1);
        else truncated=true;
      } else if(!entry.isFile())skipped.push({path,reason:'link'});
      else if(!IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase()))skipped.push({path,reason:'extension'});
      else found.push({full,path});
    }
  };
  walk(root,0);
  const files=[];
  for(const {full,path} of found.slice(0,limit)) {
    const visibleId=prefix+path;
    const sourceId=sourceIdOk(visibleId)?visibleId:prefix+digest(path)+'/'+path.split('/').at(-1).slice(-160);
    if(!sourceIdOk(sourceId)||!sanitizeForWrite(sourceId).ok){skipped.push({path,reason:'dirty'});continue;}
    let reading;
    try{reading=readDirectoryFile(root,full,maxFileBytes);}
    catch{reading={reason:'unreadable'};}
    if(reading.reason){skipped.push({path,reason:reading.reason});continue;}
    const {content}=reading;
    const contentHash='sha256:'+digest(content);
    const existing=evidenceDocuments(db,{sourceId,limit:1})[0];
    const action=!existing?'add':existing.contentHash===contentHash?'unchanged':'update';
    files.push({path,sourceId,content,contentHash,existing,action});
  }
  for(const {path} of found.slice(limit))skipped.push({path,reason:'limit'});
  if(truncated)skipped.push({path:'.',reason:'scan-limit'});
  const previewId=digest(JSON.stringify([workspace?resolve(workspace):null,root,limit,maxFileBytes,maxDepth,scanned,skipped,
    files.map(({path,sourceId,contentHash,existing,action})=>[path,sourceId,contentHash,existing,action])]));
  return {root,directory,scanned,limit,files,skipped,previewId};
}

export function previewEvidenceDirectory(db,options={}) {
  const {directory,scanned,limit,files,skipped,previewId}=directoryPlan(db,options);
  return {ok:true,directory,scanned,limit,previewId,files:files.map(({path,sourceId,action})=>({path,sourceId,action})),skipped,
    counts:{added:files.filter(row=>row.action==='add').length,updated:files.filter(row=>row.action==='update').length,
      unchanged:files.filter(row=>row.action==='unchanged').length,skipped:skipped.length}};
}

/** Uses the exact bytes checked by the preview. Existing unqualified source IDs stay independent. */
export function importEvidenceDirectory(db,options={}) {
  const {root,directory,scanned,limit,files,skipped,previewId}=directoryPlan(db,options);
  if(options.previewId!==undefined&&options.previewId!==previewId)
    fail(409,'DOCUMENT_DIRECTORY_CHANGED','The files or document revisions changed. Preview the directory again.');
  const added=[],updated=[],unchanged=[];
  for(const {path,sourceId,content,existing,action} of files) {
    if(action==='unchanged'){unchanged.push(sourceId);continue;}
    let saved;
    try{saved=saveEvidenceDocument(db,{sourceId,content,...(existing?{documentId:existing.documentId,expectedRevision:existing.revision}:{})});}
    catch(error){skipped.push({path,reason:error.code==='DOCUMENT_REVISION_CHANGED'?'conflict':(error.code||'failed')});continue;}
    if(saved.reused){unchanged.push(sourceId);continue;}
    if(existing) {
      const entry={path,sourceId,revision:saved.document.revision,affectedFactIds:[],affectedLinks:0,moreLinks:false};
      try {
        const status=documentEvidenceStatus(db,{sourceId,limit:EVIDENCE_PAGE_SIZE});
        Object.assign(entry,{affectedFactIds:status.reviewFactIds,affectedLinks:status.needsReview,moreLinks:status.nextEvidenceAfter!==null});
      }catch{entry.reviewUnavailable=true;}
      updated.push(entry);
    } else added.push({path,sourceId,documentId:saved.document.document_id});
  }
  return {ok:true,...(!options.workspace?{root}:{}),directory,scanned,limit,added,updated,unchanged,skipped,
    counts:{added:added.length,updated:updated.length,unchanged:unchanged.length,skipped:skipped.length}};
}
