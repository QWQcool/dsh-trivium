import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import tdb from 'triviumdb';
import {DIM,zeroVector} from '../lib/schema.js';
import {attachDocumentEvidence,documentEvidenceStatus,evidenceDocuments,groupDocumentEvidenceLinks,
  saveEvidenceDocument,searchEvidenceFragments,searchEvidenceSources} from '../lib/document-evidence.js';

const {TriviumDB}=tdb, temp=realpathSync(tmpdir()), prefix='trivium-evidence-search-';
const root=realpathSync(mkdtempSync(join(temp,prefix))), handles=[];
const open=name=>{
  const db=new TriviumDB(join(root,name+'.tdb'),{dim:DIM,autoBuildQuiver:false,syncMode:'off'});
  handles.push(db);return db;
};
const code=name=>error=>error.code===name;
const source=(db,sourceId,content)=>{
  const {document:d}=saveEvidenceDocument(db,{sourceId,content});
  return {documentId:d.document_id,revision:d.revision,sourceId};
};
const common='# Deployment\nPelorus marker: retain the exact evidence.\n';
try {
  const db=open('workspace-a'), other=open('workspace-b');
  const alphaText='日志😀\r\n'+common, betaText='另一个😀\n'+common, outsideText=common.repeat(5);
  const alpha=source(db,'team/a/README.md',alphaText);
  const beta=source(db,'team/b/README.md',betaText);
  const outside=source(db,'team/c/README.md',outsideText);
  const foreign=source(other,'foreign/README.md',alphaText);
  assert.equal(foreign.documentId,alpha.documentId,'test cross-workspace ID collision');
  assert.equal(evidenceDocuments(db).length,3);

  const request={sources:[beta,alpha],query:'Pelorus marker',budgetTokens:600};
  const found=searchEvidenceSources(db,request);
  assert.equal(found.answerability,'not_assessed');
  assert.deepEqual(found.sources,[alpha,beta]);
  assert.deepEqual(new Set(found.fragments.map(fragment=>fragment.sourceId)),new Set([alpha.sourceId,beta.sourceId]));
  assert.ok(!found.context.includes(outside.sourceId));
  assert.deepEqual(found,searchEvidenceSources(db,{...request,sources:[alpha,beta]}),'independent of selection order');
  for(const f of found.fragments) {
    const expected=f.sourceId===alpha.sourceId?alphaText:betaText;
    assert.equal(f.text,Buffer.from(expected).subarray(f.reference.start_byte,f.reference.end_byte).toString('utf8'));
    assert.equal(f.reference.document_id,f.documentId);
    assert.equal(f.reference.revision,f.revision);
  }
  const limited=searchEvidenceSources(db,{...request,limit:1});
  assert.equal(limited.fragments.length,1); assert.ok(limited.truncated);
  const tight=searchEvidenceSources(db,{...request,budgetTokens:64});
  assert.ok(tight.estimatedTokens<=64);
  assert.throws(()=>searchEvidenceSources(db,{...request,sources:[foreign,alpha]}),code('DOCUMENT_NOT_FOUND'));
  assert.throws(()=>searchEvidenceSources(db,{...request,sources:[alpha,alpha]}),code('DOCUMENT_SEARCH_INVALID'));
  assert.throws(()=>searchEvidenceSources(db,{...request,sources:[{...alpha,documentId:true}]}),code('DOCUMENT_SEARCH_INVALID'));
  assert.throws(()=>searchEvidenceSources(db,{...request,sources:[{...alpha,revision:'old'},beta]}),code('DOCUMENT_REVISION_CHANGED'));
  assert.ok(searchEvidenceFragments(db,{documentId:Number(beta.documentId),revision:beta.revision,query:'Pelorus marker'}).fragments.length);

  const ids=[101,102];
  ids.forEach(id=>db.insertWithId(id,zeroVector(),{type:'decision',name:'Synthetic '+id,text:'Retain evidence',status:'active'}));
  const first=found.fragments.find(f=>f.documentId===alpha.documentId);
  const second=found.fragments.find(f=>f.documentId===beta.documentId);
  for(const factId of ids) attachDocumentEvidence(db,{factId,documentId:Number(first.documentId),revision:first.revision,reference:first.reference,quote:first.text});
  attachDocumentEvidence(db,{factId:ids[0],documentId:Number(second.documentId),revision:second.revision,reference:second.reference,quote:second.text});
  let flat=documentEvidenceStatus(db).links;
  assert.equal(flat.length,3);
  let grouped=groupDocumentEvidenceLinks(flat);
  assert.equal(grouped.length,2);
  assert.deepEqual(grouped[0].links.map(l=>l.factId),ids);
  assert.equal(grouped[1].sourceId,beta.sourceId);
  const shifted={...flat[0],reference:{...flat[0].reference,start_byte:flat[0].reference.start_byte+1,end_byte:flat[0].reference.end_byte+1}};
  assert.equal(groupDocumentEvidenceLinks([flat[0],shifted]).length,2,'same text, different offsets');
  db.updatePayload(ids[0],{type:'decision',name:'Updated fact',text:'Still linked',status:'active'});
  flat=documentEvidenceStatus(db).links;
  grouped=groupDocumentEvidenceLinks(flat);
  assert.deepEqual(grouped[0].links.map(l=>l.status),['fact_changed','current']);
  saveEvidenceDocument(db,{sourceId:alpha.sourceId,content:'Changed\n'+alphaText,expectedRevision:alpha.revision,
    documentId:Number(alpha.documentId)});
  assert.throws(()=>searchEvidenceSources(db,request),code('DOCUMENT_REVISION_CHANGED'));
  console.log('Document evidence source search: scoped retrieval, UTF-8 provenance, caps, stale and foreign tuples, citation identities and statuses passed.');
} finally {
  for(const db of handles.reverse()) db.close();
  if(dirname(root)===temp&&basename(root).startsWith(prefix)) rmSync(root,{recursive:true,force:true});
}
