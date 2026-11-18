/** Five-item regression, run only after the complete implementation. No paid/model requests. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export const cases=Object.freeze({p107,p108,p109,p110,p111});
const reportDir=resolve('.tmp/next-memory-20261117');
async function environment(fn) {
  const root=mkdtempSync(join(tmpdir(),'trivium-next-'));
  process.env.DSH_HOME=join(root,'home');process.env.DSH_TRIVIUM_SETTINGS=join(root,'settings.json');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(url,...args)=>{if(new URL(typeof url==='string'?url:url.url).hostname!=='127.0.0.1')throw Error('Unexpected external request');return originalFetch(url,...args);};
  const s=await import('../lib/store.js');const {configureEmbedding}=await import('../lib/embed.js');configureEmbedding({embeddingEnabled:false});
  let count=0;
  const check=async(label,test)=>{await test();console.log('ok '+label);count++;};
  try{await fn({root,s,check});console.log(`checks: ${count}/${count}`);}
  finally{s.closeAll();globalThis.fetch=originalFetch;assert.ok(realpathSync(root).startsWith(realpathSync(tmpdir()))&&basename(root).startsWith('trivium-next-'));rmSync(root,{recursive:true,force:true});}
}
const report=(file,value)=>{mkdirSync(reportDir,{recursive:true});writeFileSync(join(reportDir,file),JSON.stringify(value,null,2)+'\n');};
async function seedScope(s,cwd,scenario) {
  const {zeroVector}=await import('../lib/schema.js');const db=await s.openWorkspaceDb(cwd);
  const put=(id,type,name,text)=>db.insertWithId(id,zeroVector(),{type,name,text,status:'active',createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'});
  put(101,'entity',scenario.entity,scenario.entity+' entity.');put(201,'decision','configuration',scenario.fact);put(202,'decision','other',scenario.distractor);
  put(301,'entity','OtherWorkspaceEntity','Unrelated entity.');put(302,'decision','foreign',scenario.fact);
  db.link(201,101,'about');db.link(202,101,'about');db.link(302,301,'about');db.flush();return db;
}
async function p107(){await environment(async({root,s,check})=>{
  const {searchEntity}=await import('../lib/entity-search.js');
  const raw=readFileSync(new URL('./fixtures/memory-retrieval-v2.json',import.meta.url));const fixture=JSON.parse(raw),rows=[];
  await check('independent frozen corpus is split, scored, and cannot escape the entity scope',async()=>{
    assert.equal(fixture.scenarios.length,16);assert.equal(fixture.scenarios.filter(r=>r.split==='holdout').length,8);
    for(const row of fixture.scenarios){
      const db=await seedScope(s,join(root,row.id),row),result=await searchEntity(db,{entityId:101,query:row.question,limit:5,packTokens:600});
      const ids=result.textCandidates.map(r=>Number(r.id));assert.ok(!ids.includes(302),row.id+' leaked an unrelated fact');
      if(row.answerable===false)assert.equal(ids.length,0,row.id+' should have no lexical evidence');
      if(row.split==='dev')assert.equal(ids[0],201,row.id+' missed the development fact');
      rows.push({id:row.id,split:row.split,answerable:row.answerable!==false,top1:ids[0]===201,top5:ids.includes(201),ids,
        packHit:result.memoryPack.facts.some(f=>f.id==='201'),embeddingCalls:result.work.embeddingCalls});
      assert.equal(result.work.embeddingCalls,0);
    }
  });
  await check('unchanged F2/F5 and real-evaluation L11/L12 questions retrieve the recorded fact',async()=>{
    const old=JSON.parse(readFileSync(new URL('./fixtures/memory-eval-v1.json',import.meta.url)));
    const live=JSON.parse(readFileSync(new URL('./fixtures/memory-live-v1.json',import.meta.url)));
    const questions=[...old.scenarios.filter(r=>['F2','F5'].includes(r.id)).map(r=>({id:r.id,entity:r.seed.nodes[0].name,fact:r.seed.nodes[1].text,question:r.retrieval.question})),
      ...live.scenarios.filter(r=>['L11','L12'].includes(r.id)).map(r=>({id:r.id,entity:r.entity,fact:r.fact,question:r.question}))];
    assert.equal(questions.length,4);
    for(const row of questions){const db=await seedScope(s,join(root,row.id),{...row,distractor:'Nothing else is configured.'});const result=await searchEntity(db,{entityId:101,query:row.question,packTokens:600});
      assert.equal(result.textCandidates[0]?.id,'201',row.id);assert.ok(result.memoryPack.facts.some(f=>f.id==='201'),row.id+' pack miss');}
  });
  const split=name=>{const items=rows.filter(r=>r.split===name&&r.answerable);return {n:items.length,top1:items.filter(r=>r.top1).length,top5:items.filter(r=>r.top5).length};};
  await check('concept words inside compound identifiers cannot expand or match a longer identifier',async()=>{
    const good={type:'decision',name:'header',text:'Use X-Backup-Id for tracing.'},wrong={...good,text:'Use X-Backup-Mode for tracing.'},longer={...good,text:'Use Z-X-Backup-Id for tracing.'};
    for(const q of ['X-Backup-Id','Which header is X-Backup-Id?']){const score=s.makePayloadTextScorer(q);assert.ok(score(good)>0);assert.equal(score(wrong),0);assert.equal(score(longer),0);}
    const db=await seedScope(s,join(root,'atomic'),{entity:'Headers',fact:good.text,distractor:wrong.text});
    assert.ok(!s.searchNodes(db,'Which header is X-Backup-Id?',{expandDepth:0}).some(r=>r.id===202));
    const comparison=s.searchNodes(db,'Compare X-Backup-Id and X-Backup-Mode',{expandDepth:0}).map(r=>r.id);
    assert.ok(comparison.includes(201)&&comparison.includes(202),'multi-target lookup lost an independent code identity');
  });
  report('retrieval-results.json',{fixtureHash:createHash('sha256').update(raw).digest('hex'),dev:split('dev'),holdout:split('holdout'),rows,modelCalls:0,embeddingCalls:0,finalAnswerAccuracy:'not measured'});
});}
async function p108(){await environment(async({root,s,check})=>{
  const e=await import('../lib/extract.js'),{reviewPending}=await import('../lib/pending-review.js');
  const cwd=join(root,'review'),other=join(root,'other'),db=await s.openWorkspaceDb(cwd),dbB=await s.openWorkspaceDb(other);
  const candidate={type:'decision',name:'保留期',text:'备份保留 21 天。',quote:'保留多久？'},turns=[{role:'user',text:'保留多久？',seq:1,recorded:true}];
  const save=()=>e.savePending(cwd,{sessionId:'ticket-1',turns,unverified:[candidate],sourceReviewKey:e.sourceReviewKey(turns)});
  const request=()=>{const row=e.pendingSummary(cwd).windows[0];return {sessionId:row.sessionId,candidateId:row.unverified[0].id,etag:row.etag,action:'dismiss'};};
  await save();const req=request(),before=db.allNodeIds().length;
  await check('dismiss retains candidate/source, writes no fact and retries idempotently',async()=>{
    const r=await reviewPending(cwd,db,req);assert.equal(r.nodeId,null);assert.equal(db.allNodeIds().length,before);
    assert.equal(e.pendingSummary(cwd).windows.length,0);
    const history=e.pendingReviewHistory(cwd);assert.equal(history.total,1);assert.deepEqual(history.entries[0].candidate,candidate);assert.equal(history.entries[0].sourceTurns[0].text,turns[0].text);
    const compatible=JSON.parse(readFileSync(e.pendingPath(cwd),'utf8'));
    assert.deepEqual(compatible.reviews,[]);assert.deepEqual(compatible.windows[0].turns,turns);
    assert.equal(JSON.parse(readFileSync(e.pendingReviewPath(cwd),'utf8')).reviews[0].action,'dismiss');
    assert.equal((await reviewPending(cwd,db,req)).replayed,true);assert.equal(e.pendingReviewHistory(cwd).total,1);
    await assert.rejects(reviewPending(other,dbB,req),r=>r.status===409);
  });
  await check('stale scheduler data cannot resurrect a dismissal; new evidence is not vetoed',async()=>{
    await save();assert.equal(e.pendingSummary(cwd).windows.length,0);
    assert.deepEqual(e.reviewedCandidateIds(cwd,'ticket-1',turns),[e.pendingCandidateId(candidate)]);
    const fresh=[...turns,{role:'user',text:'现在确认：备份保留 21 天。',seq:2,recorded:true}];
    assert.deepEqual(e.reviewedCandidateIds(cwd,'ticket-1',fresh),[]);
    await e.savePending(cwd,{sessionId:'ticket-1',turns:fresh,unverified:[candidate]});assert.equal(e.pendingSummary(cwd).windows[0].unverified.length,1);
  });
  await check('exact existing text is a hint, with no implicit merge across types',async()=>{
    const id=s.insertNode(db,{type:'preference',text:candidate.text,name:'手动事实'});const p=db.getPayload(id);
    const summary=e.pendingSummary(cwd);assert.equal(summary.windows[0].unverified[0].existingFacts[0].id,id);assert.deepEqual(db.getPayload(id),p);
  });
  await check('history paginates without dropping old receipts beyond the former 1024 cap',async()=>{
    const original=e.pendingReviewHistory(cwd).entries[0];
    await e.updatePendingWindows(cwd,state=>({...state,reviews:[...Array.from({length:1030},(_,i)=>({...state.reviews[0],sessionId:'old-'+i})),...state.reviews]}));
    const page=e.pendingReviewHistory(cwd,{offset:1025,limit:5});assert.equal(page.total,1031);assert.equal(page.entries.length,5);assert.equal(e.pendingReviewHistory(cwd,{offset:1030,limit:1}).entries[0].sessionId,'old-0');
    assert.equal(e.pendingReviewHistory(cwd).entries[0].candidateId,original.candidateId);
    assert.throws(()=>e.pendingReviewHistory(cwd,{offset:-1}),r=>r.status===400);
  });
  await check('a durable review survives a stale pending projection or a queue clear',async()=>{
    const archived=readFileSync(e.pendingReviewPath(cwd),'utf8'),before=e.pendingReviewHistory(cwd).total;
    const original={sessionId:'ticket-1',turns,unverified:[candidate],sourceReviewKey:e.sourceReviewKey(turns)};
    writeFileSync(e.pendingPath(cwd),JSON.stringify({windows:[original],acknowledged:[],reviews:[]}));
    assert.equal(e.pendingSummary(cwd).windows.length,0);
    assert.equal((await reviewPending(cwd,db,req)).replayed,true);
    assert.deepEqual(JSON.parse(readFileSync(e.pendingPath(cwd),'utf8')).windows[0].unverified,[]);
    e.clearPending(cwd);
    assert.equal(e.pendingReviewHistory(cwd).total,before);
    assert.equal(readFileSync(e.pendingReviewPath(cwd),'utf8'),archived);
  });
  await check('a mixed receipt file from the interim build is rewritten without losing its history',async()=>{
    const state=JSON.parse(readFileSync(e.pendingReviewPath(cwd),'utf8'));
    const receipt={...state.reviews.at(-1),sessionId:'interim'};
    writeFileSync(e.pendingPath(cwd),JSON.stringify({windows:[],acknowledged:[],reviews:[receipt]}));
    await e.updatePendingWindows(cwd,current=>current);
    assert.equal(e.pendingReviewHistory(cwd).entries[0].sessionId,'interim');
    assert.equal(JSON.parse(readFileSync(e.pendingReviewPath(cwd),'utf8')).reviews.at(-1).sessionId,'interim');
    assert.equal(e.loadPendingWindows(cwd).length,0);
  });
});}
async function p109(){await environment(async({root,s,check})=>{
  const {searchEntity}=await import('../lib/entity-search.js'),{derivedCacheStats,readDerived,writeDerived}=await import('../lib/derived-cache.js');
  const db=await seedScope(s,join(root,'cache'),{entity:'Vault',fact:'Vault backups are retained for 21 days.',distractor:'Vault port is 8349.'});
  const body={entityId:101,query:'backup retention',packTokens:600};let payloadReads=0;const get=db.getPayload.bind(db);db.getPayload=(...a)=>{payloadReads++;return get(...a);};
  let coldReads=0,warmReads=0;
  await check('repeated scoped reads avoid DB reads and isolate caller mutations',async()=>{
    let n=payloadReads;const a=await searchEntity(db,body);coldReads=payloadReads-n;n=payloadReads;
    const b=await searchEntity(db,body);warmReads=payloadReads-n;assert.ok(coldReads>0);assert.equal(warmReads,0);assert.equal(b.work.cache.status,'hit');
    assert.deepEqual(a.textCandidates,b.textCandidates);b.textCandidates[0].text='tampered';assert.notEqual((await searchEntity(db,body)).textCandidates[0].text,'tampered');
  });
  await check('body-only native edits, edge changes, delete/ID reuse invalidate cached scope',async()=>{
    const old=db.getPayload(201);db.updatePayload(201,{...old,text:'Vault backups are retained for 34 days.'});
    const changed=await searchEntity(db,body);assert.equal(changed.work.cache.status,'miss');assert.ok(changed.textCandidates[0].text.includes('34'));
    db.unlink(201,101,'about');assert.ok(!(await searchEntity(db,body)).textCandidates.some(r=>r.id==='201'));
    db.link(201,101,'about');db.delete(201);const {zeroVector}=await import('../lib/schema.js');db.insertWithId(201,zeroVector(),{...old,text:'Vault backup retention is 55 days.'});db.link(201,101,'about');
    assert.ok((await searchEntity(db,body)).textCandidates.some(r=>r.text.includes('55')));
  });
  await check('cache never hides cancellation, replaced sources or budget errors',async()=>{
    const controller=new AbortController();controller.abort();await assert.rejects(searchEntity(db,body,{signal:controller.signal}),e=>e.code==='ENTITY_SEARCH_CANCELLED');
    await assert.rejects(searchEntity(db,body,{isCurrent:()=>false}),e=>e.code==='ENTITY_SEARCH_SOURCE_CHANGED');
    for(let i=0;i<2;i++)await assert.rejects(searchEntity(db,body,{limits:{nodes:1}}),e=>e.code==='ENTITY_SEARCH_WORK_LIMIT');
    writeDerived(db,'future',{ok:true},{now:100,expiresAt:200});assert.equal(readDerived(db,'future',{now:99}).hit,false);
  });
  await check('expiry, workspace handles and closed/reopened databases are independent',async()=>{
    const dbB=await seedScope(s,join(root,'cache-b'),{entity:'Vault',fact:'Vault backup retention is 89 days.',distractor:'Unrelated.'});
    assert.ok((await searchEntity(dbB,body)).textCandidates[0].text.includes('89'));
    const old=db.getPayload(201);db.updatePayload(201,{...old,untilAt:'2030-01-01T00:00:01.000Z'});
    const before=await searchEntity(db,body,{timeNow:()=>new Date('2030-01-01T00:00:00.000Z')});assert.ok(before.textCandidates.some(r=>r.id==='201'));
    const after=await searchEntity(db,body,{timeNow:()=>new Date('2030-01-01T00:00:02.000Z')});assert.ok(!after.textCandidates.some(r=>r.id==='201'));
    dbB.close();await assert.rejects(searchEntity(dbB,body));
  });
  await check('map cache keeps identical injection decisions and skips repeated map DB queries',async()=>{
    let tql=0;const original=db.tql.bind(db);db.tql=(...a)=>{tql++;return original(...a);};
    const a=s.buildShortMapReport(db,400),cold=tql,beforeHits=derivedCacheStats(db).hits;tql=0;const b=s.buildShortMapReport(db,400);assert.ok(cold>0);assert.equal(tql,0);assert.equal(derivedCacheStats(db).hits,beforeHits+1);assert.deepEqual(a,b);
    const {planMapInjection}=await import('../lib/index.js');assert.equal(planMapInjection(a,b).mode,'skip');
    report('cache-results.json',{entityPayloadReads:{cold:coldReads,warm:warmReads},mapQueries:{cold,warm:tql},stats:derivedCacheStats(db),unchangedInjection:'skip',modelCalls:0,embeddingCalls:0,billedTokens:'not measured'});
  });
});}
async function p110(){await environment(async({root,s,check})=>{
  const h=await import('../lib/handoff.js');const cwd=join(root,'central');mkdirSync(cwd,{recursive:true});
  const assignments=[1,2,3].map(i=>({ticketId:'T-'+i,assignmentId:'A-'+i,workerId:'W-'+i}));
  await h.configureHandoff(cwd,{projectScopeId:'project-alpha',assignments});
  const envelope=i=>({version:1,projectScopeId:'project-alpha',...assignments[i-1],eventId:'event-'+i,sessionId:'session-'+i,
    sourceTurns:[{role:'user',text:`记住：Worker${i} 的端口是 ${7300+i}。`,seq:1,recorded:true}],candidates:[{type:'decision',name:'端口',text:`Worker${i} 的端口是 ${7300+i}。`,quote:`Worker${i} 的端口是 ${7300+i}。`}]});
  await check('three processes persist candidates while the router is offline, then exit',async()=>{
    const module=pathToFileURL(fileURLToPath(new URL('../lib/handoff.js',import.meta.url))).href;
    await Promise.all([1,2,3].map(i=>new Promise((done,reject)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',`import {submitHandoff} from ${JSON.stringify(module)}; const r=await submitHandoff(process.argv[1],JSON.parse(process.argv[2])); if(r.status!=='queued'||!r.durable)process.exitCode=2;`,cwd,JSON.stringify(envelope(i))],{env:process.env,stdio:['ignore','pipe','pipe']});
      let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error(error||'Worker exit '+code)));
    })));
    for(const i of [1,2,3])assert.equal(h.handoffReceipt(cwd,envelope(i)).status,'queued');
  });
  const db=await s.openWorkspaceDb(cwd);
  await check('central owner writes once, receipts survive restart and event conflicts are refused',async()=>{
    const before=db.nodeCount();assert.equal((await h.drainHandoff(cwd,db)).processed,3);assert.equal(db.nodeCount(),before+3);
    assert.equal((await h.submitHandoff(cwd,envelope(1))).replayed,true);assert.equal((await h.drainHandoff(cwd,db)).processed,0);
    await assert.rejects(h.submitHandoff(cwd,{...envelope(1),candidates:[{...envelope(1).candidates[0],text:'A different value.'}]}),e=>e.code==='HANDOFF_EVENT_CONFLICT');
    await assert.rejects(h.submitHandoff(cwd,{...envelope(1),projectScopeId:'other'}),e=>e.code==='HANDOFF_SCOPE_MISMATCH');
    assert.equal(db.getPayload(h.handoffReceipt(cwd,envelope(1)).outcomes[0].nodeId).text,envelope(1).candidates[0].text);
  });
  await check('source uncertainty and tool echoes stay durable without active writes',async()=>{
    const unsupported={...envelope(1),eventId:'unsupported',sourceTurns:[{role:'tool',toolName:'ctx_read',text:'Worker1 的端口是 7301。'}]};
    await h.submitHandoff(cwd,unsupported);const n=db.nodeCount();await h.drainHandoff(cwd,db);assert.equal(db.nodeCount(),n);assert.equal(h.handoffReceipt(cwd,unsupported).status,'needs_review');
    assert.ok(readFileSync(h.handoffPath(cwd),'utf8').includes('ctx_read'));
    const text='只改这个文件的端口。',oneShot={...envelope(2),eventId:'one-shot',sourceTurns:[{role:'user',text}],candidates:[{type:'preference',name:'临时操作',text,quote:text}]};
    await h.submitHandoff(cwd,oneShot);await h.drainHandoff(cwd,db);assert.equal(h.handoffReceipt(cwd,oneShot).status,'needs_review');assert.equal(db.nodeCount(),n);
  });
  await check('failed graph flush keeps queued candidates, retry recovers stable URI without duplication',async()=>{
    const row={...envelope(1),eventId:'flush-recovery'};await h.submitHandoff(cwd,row);const n=db.nodeCount(),flush=db.flush.bind(db);db.flush=()=>{throw Error('synthetic flush failure');};
    try{await assert.rejects(h.drainHandoff(cwd,db));assert.equal(h.handoffReceipt(cwd,row).status,'queued');}finally{db.flush=flush;}
    await h.drainHandoff(cwd,db);assert.equal(db.nodeCount(),n+1);assert.equal(h.handoffReceipt(cwd,row).status,'committed');
  });
  await check('the opt-in Router consumes centrally queued facts after owner restart',async()=>{
    s.closeAll();const row={...envelope(2),eventId:'after-owner-exit'};await h.submitHandoff(cwd,row);
    const {startRouter,createRouterClient}=await import('../lib/router.js');const router=await startRouter({cwd,allow:true,handoff:{projectScopeId:'project-alpha',assignments}});
    try{assert.equal(router.stats().handoff.enabled,true);assert.equal(h.handoffReceipt(cwd,row).status,'committed');
      const client=createRouterClient({cwd,allow:true});await client.ready;try{assert.ok((await client.map()).version);
        await assert.rejects(client.writer.insert({type:'decision',text:'Bypass'}),e=>e.code==='HANDOFF_ENVELOPE_REQUIRED');
      }finally{await client.close();}
    }finally{await router.close();}
    assert.equal(s.getOpenWorkspaceDb(cwd),null,'Router retained a closed workspace handle');
    const again=await startRouter({cwd,allow:true,handoff:{projectScopeId:'project-alpha',assignments}});
    try{assert.equal((await again.drainHandoff()).processed,0);assert.equal(h.handoffReceipt(cwd,row).status,'committed');}finally{await again.close();}
    assert.equal(h.handoffReceipt(cwd,envelope(1)).status,'committed');
  });
});}
async function p111(){await environment(async({root,s,check})=>{
  const d=await import('../lib/document-evidence.js');const cwd=join(root,'documents'),db=await s.openWorkspaceDb(cwd);
  const factId=s.insertNode(db,{type:'decision',name:'保留期',text:'备份保留 21 天。'}),fact=db.getPayload(factId);
  let doc;
  await check('native TDB source and UTF-8/CRLF excerpt links leave the memory fact unchanged',async()=>{
    const created=d.saveEvidenceDocument(db,{sourceId:'docs/storage.md',content:'说明🙂\r\n备份保留 21 天。\r\n'});doc=created.document;
    assert.equal(d.evidenceDocuments(db).length,1);const linked=d.attachDocumentEvidence(db,{factId,documentId:doc.document_id,revision:doc.revision,quote:'备份保留 21 天。'});
    assert.ok(linked.reference.start_byte>4);assert.equal(d.documentEvidenceStatus(db,{factId}).links[0].resolved.text,'备份保留 21 天。');assert.deepEqual(db.getPayload(factId),fact);
    assert.equal(d.attachDocumentEvidence(db,{factId,documentId:doc.document_id,revision:doc.revision,quote:'备份保留 21 天。'}).reused,true);
  });
  await check('source revisions require CAS, keep the original quote and request review',async()=>{
    assert.throws(()=>d.saveEvidenceDocument(db,{sourceId:'docs/storage.md',content:'备份保留 34 天。'}),e=>e.status===409);
    const next=d.saveEvidenceDocument(db,{sourceId:'docs/storage.md',content:'备份保留 34 天。',documentId:doc.document_id,expectedRevision:doc.revision}).document;
    const link=d.documentEvidenceStatus(db,{factId}).links[0];assert.equal(link.status,'source_changed');assert.equal(link.needsReview,true);assert.equal(link.quote,'备份保留 21 天。');assert.deepEqual(db.getPayload(factId),fact);
    assert.throws(()=>d.attachDocumentEvidence(db,{factId,documentId:doc.document_id,revision:doc.revision,quote:'备份保留 34 天。'}),e=>e.status===409);doc=next;
  });
  await check('deleting a source leaves the original fact and association reviewable after reopen',async()=>{
    JSON.parse(db.documentRequest(JSON.stringify({operation:'delete',document_id:doc.document_id,expected_revision:doc.revision})));db.flush();
    assert.equal(d.documentEvidenceStatus(db,{factId}).links[0].status,'source_missing');assert.deepEqual(db.getPayload(factId),fact);
    s.closeAll();const reopened=await s.openWorkspaceDb(cwd);assert.equal(d.documentEvidenceStatus(reopened,{factId}).needsReview,1);assert.deepEqual(reopened.getPayload(factId),fact);
  });
  await check('fact deletion/ID reuse does not inherit the deleted fact evidence',async()=>{
    const active=s.getOpenWorkspaceDb(cwd);active.delete(factId);const {zeroVector}=await import('../lib/schema.js');active.insertWithId(factId,zeroVector(),fact);
    assert.equal(d.documentEvidenceStatus(active,{factId}).links[0].status,'fact_missing');
  });
  await check('ambiguous quotes, oversized/secret text, and unrelated native roots are refused',async()=>{
    const active=s.getOpenWorkspaceDb(cwd),sample=d.saveEvidenceDocument(active,{sourceId:'docs/repeat.md',content:'重复片段。重复片段。'}).document;
    assert.throws(()=>d.attachDocumentEvidence(active,{factId,documentId:sample.document_id,revision:sample.revision,quote:'重复片段。'}),e=>e.status===422);
    assert.throws(()=>d.saveEvidenceDocument(active,{sourceId:'too-large',content:'x'.repeat(65537)}),e=>e.status===400);
    assert.throws(()=>d.saveEvidenceDocument(active,{sourceId:'secret',content:'api_key=sk-'+'z'.repeat(48)}),e=>e.status===422);
    assert.throws(()=>d.getEvidenceDocument(active,factId),e=>e.status===404);
  });
  await check('real HTTP API is scoped, origin-protected, bounded and participates in the write lock',async()=>{
    const {createServer}=await import('node:http'),{registerMemoryApi}=await import('../lib/server.js'),{acquireWorkspaceLock}=await import('../lib/workspace-lock.js');let handler;
    registerMemoryApi({webServer:{register:entry=>{handler=entry.handler;return ()=>{};}}},{liveOptions:()=>({}),status:{}});
    const server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
    try{const base=`http://127.0.0.1:${server.address().port}/api/dsh-trivium/document-evidence`;
      const post=(url,body,extra={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});
      const body={action:'save',sourceId:'docs/http.md',content:'HTTP 证据。'};assert.equal((await post(base,body)).status,400);
      const scoped=base+'?cwd='+encodeURIComponent(cwd);assert.equal((await post(scoped,body,{origin:'https://evil.invalid'})).status,403);
      const lock=acquireWorkspaceLock(cwd);try{assert.equal((await post(scoped,body)).status,409);}finally{lock.release();}
      const r=await post(scoped,body);assert.equal(r.status,200);assert.ok((await r.json()).document.revision);
      assert.equal((await post(scoped,{...body,unknown:true})).status,400);assert.equal((await post(scoped,{...body,content:'x'.repeat(200000)})).status,413);
      const get=await fetch(scoped);assert.equal(get.status,200);assert.ok((await get.json()).documents.some(r=>r.sourceId==='docs/http.md'));
    }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
  });
});}
