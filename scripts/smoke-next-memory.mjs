/** Five-item regression, run only after the complete implementation. No paid/model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export const cases=Object.freeze({p107,p108,p109,p110,p111,p112,p113,p114,p115,p116,p121});
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
const cursorOf=output=>/^Cursor: ([\w-]{12})$/m.exec(output)?.[1];
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
    const row={...envelope(1),eventId:'flush-recovery',sourceTurns:[{...envelope(1).sourceTurns[0],seq:2}]};await h.submitHandoff(cwd,row);const n=db.nodeCount(),flush=db.flush.bind(db);db.flush=()=>{throw Error('synthetic flush failure');};
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
    assert.equal(link.comparison.previous.text,'备份保留 21 天。');assert.equal(link.comparison.previous.location.start.line,2);
    assert.equal(link.comparison.current.text,'备份保留 34 天。');assert.equal(link.comparison.current.match,'near-previous-byte');
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
    const width=Buffer.byteLength('重复片段。','utf8'),reference={document_id:sample.document_id,revision:sample.revision,start_byte:width,end_byte:width*2};
    const located=d.attachDocumentEvidence(active,{factId,documentId:sample.document_id,revision:sample.revision,quote:'重复片段。',reference});
    assert.equal(located.reference.start_byte,width);
    assert.throws(()=>d.attachDocumentEvidence(active,{factId,documentId:sample.document_id,revision:sample.revision,quote:'重复片段。',reference:{...reference,start_byte:width+1}}),e=>e.code==='DOCUMENT_REFERENCE_INVALID');
  });
  await check('native BM25 locates an exact bounded excerpt without returning the whole document or a different source',async()=>{
    const active=s.getOpenWorkspaceDb(cwd),{estimateTokens}=await import('../lib/tokens.js');
    const body=[...Array.from({length:36},(_,index)=>`## Note ${index}\r\nRoutine maintenance windows are scheduled locally.\r\n`),
      '## 部署计划🙂\r\nZephyrLatch 审批后冷却期为 19 分钟。\r\n'].join('\r\n');
    const {document}=d.saveEvidenceDocument(active,{sourceId:'docs/release.md',content:body});
    d.saveEvidenceDocument(active,{sourceId:'docs/sandbox.md',content:'ZephyrLatch 沙盒时长 99 分钟。'});
    const result=d.searchEvidenceFragments(active,{documentId:Number(document.document_id),revision:document.revision,query:'ZephyrLatch',budgetTokens:300});
    assert.ok(document.blocks.length>1);assert.ok(result.fragments.length>0);assert.match(result.context,/审批后冷却期为 19/);assert.doesNotMatch(result.context,/99 分钟/);
    assert.ok(result.estimatedTokens<=300&&result.estimatedTokens<estimateTokens(body));
    const fragment=result.fragments[0],resolved=JSON.parse(active.documentRequest(JSON.stringify({operation:'resolve',reference:fragment.reference})));
    assert.equal(resolved.text,fragment.text);assert.ok(fragment.start.line>1);
    assert.throws(()=>d.searchEvidenceFragments(active,{documentId:Number(document.document_id),revision:'stale',query:'ZephyrLatch'}),e=>e.status===409);
    const {zeroVector}=await import('../lib/schema.js'),legacyId=Math.max(...active.allNodeIds())+1;
    const v1=JSON.parse(active.documentRequest(JSON.stringify({operation:'put',document:{source_id:'docs/legacy.md',source_revision:'first',parser_id:'dsh-explicit-text-v1',
      content:body,root:{id:String(legacyId),vector:zeroVector(),payload:{type:'trivium-document-source',sourceId:'docs/legacy.md'}},
      blocks:[{key:'body',kind:'body',start_byte:0,end_byte:Buffer.byteLength(body,'utf8'),node:{id:String(legacyId+1),vector:zeroVector(),payload:{type:'trivium-document-fragment'}}}]}})));
    const legacy=d.searchEvidenceFragments(active,{documentId:legacyId,revision:v1.revision,query:'ZephyrLatch',budgetTokens:300});
    assert.match(legacy.context,/审批后冷却期为 19/);assert.ok(legacy.estimatedTokens<estimateTokens(body));assert.equal(d.getEvidenceDocument(active,legacyId).revision,v1.revision);
    console.log('document budget evidence '+JSON.stringify({whole:estimateTokens(body),excerpts:result.estimatedTokens,embeddingCalls:0}));
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
      const r=await post(scoped,body);assert.equal(r.status,200);const {document}=await r.json();assert.ok(document.revision);
      const query=scoped+'&'+new URLSearchParams({documentId:document.document_id,revision:document.revision,query:'HTTP'});
      const clips=await fetch(query);assert.equal(clips.status,200);const clipBody=await clips.json();assert.match(clipBody.context,/HTTP 证据/);
      assert.equal(clipBody.document,undefined);assert.equal(clipBody.answerability,'not_assessed');
      assert.equal((await post(scoped,{...body,unknown:true})).status,400);assert.equal((await post(scoped,{...body,content:'x'.repeat(200000)})).status,413);
      const get=await fetch(scoped);assert.equal(get.status,200);assert.ok((await get.json()).documents.some(r=>r.sourceId==='docs/http.md'));
    }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
  });
});}

async function p112(){await environment(async({root,s,check})=>{
  const {registerTools}=await import('../lib/tools.js'),{searchEntity}=await import('../lib/entity-search.js'),{estimateTokens}=await import('../lib/tokens.js');
  const cwd=join(root,'task-a'),other=join(root,'task-b'),tools=new Map();
  const makeExec=(dir,id)=>({agent:{session:{id,header:{cwd:dir}}}});
  const taskMemory=registerTools({effect:fn=>fn(),on(){},tools:{register(tool){tools.set(tool.name,tool);return ()=>{};}}},{});
  const find=tools.get('ctx_find'),exec=makeExec(cwd,'ticket'),args={query:'backup retention',entity_id:101,pack_tokens:300};
  const db=await seedScope(s,cwd,{entity:'QuartzVault',fact:'QuartzVault backup retention is 21 days.',distractor:'QuartzVault mirror backup retention is 9 days.'});
  db.updatePayload(202,{...db.getPayload(202),name:'mirror retention'});
  await seedScope(s,other,{entity:'OtherVault',fact:'OtherVault backup retention is 99 days.',distractor:'Unrelated port.'});
  let scoped,cursor,unchanged,delta,verbose;
  await check('real tool default is unchanged; opt-in packs contain full same-scope facts at lower estimated cost',async()=>{
    const legacy=await find.execute({query:args.query},exec);
    assert.match(legacy,/^\[[.\d]+\] id=/);assert.doesNotMatch(legacy,/Cursor:/);
    scoped=await find.execute(args,exec);cursor=cursorOf(scoped);
    assert.ok(cursor);assert.match(scoped,/21 days\./);assert.match(scoped,/9 days\./);assert.doesNotMatch(scoped,/id=302/);
    const full=await searchEntity(db,{entityId:101,query:args.query,packTokens:300});verbose=full.memoryPack.context;
    assert.deepEqual(full.memoryPack.facts.map(row=>row.id).sort(),['201','202']);
    assert.ok(estimateTokens(scoped)<estimateTokens(verbose));assert.ok(estimateTokens(scoped)<=300);
  });
  await check('unchanged and unrelated writes send no fact text; an edit sends only the changed fact',async()=>{
    const first=await find.execute({...args,since:cursor},exec);
    assert.match(first,/unchanged/);assert.doesNotMatch(first,/21 days|9 days/);
    db.updatePayload(302,{...db.getPayload(302),text:'Unrelated backup retention is 600 days.'});
    unchanged=await find.execute({...args,since:cursor},exec);assert.equal(unchanged,first);
    db.updatePayload(201,{...db.getPayload(201),text:'QuartzVault backup retention is 28 days.'});
    delta=await find.execute({...args,since:cursor},exec);
    assert.match(delta,/28 days/);assert.doesNotMatch(delta,/21 days|9 days|600 days/);assert.ok(cursorOf(delta)&&cursorOf(delta)!==cursor);
    assert.ok(estimateTokens(delta)<estimateTokens(scoped));
    db.unlink(201,101,'about');
    const removed=await find.execute({...args,since:cursorOf(delta)},exec);assert.match(removed,/No longer selected: #201/);assert.ok(db.getPayload(201));
  });
  await check('a receipt cannot cross a database, session, budget or changed query, and can be cleared',async()=>{
    for (const [changed,context] of [[{},makeExec(other,'ticket')],[{},makeExec(cwd,'foreign')],[{pack_tokens:200},exec],[{query:'new context'},exec]]) {
      const rejected=await find.execute({...args,since:cursor,...changed},context);assert.match(rejected,/cursor expired or belongs to another task/i);assert.doesNotMatch(rejected,/days/);
    }
    taskMemory.dropSession('ticket');assert.match(await find.execute({...args,since:cursor},exec),/Run ctx_find without since/);
    assert.match(await find.execute({query:args.query,pack_tokens:300},exec),/entityId must be/);
  });
  console.log('task budget evidence '+JSON.stringify({verbose:estimateTokens(verbose),initial:estimateTokens(scoped),unchanged:estimateTokens(unchanged),delta:estimateTokens(delta),embeddingCalls:0}));
});}

async function p121(){await environment(async({root,s,check})=>{
  const {searchEntity}=await import('../lib/entity-search.js');
  const {createTaskMemoryReader,scopedToolRequest}=await import('../lib/task-memory.js');
  const {estimateTokens}=await import('../lib/tokens.js');
  const cwd=join(root,'continued-task'),other=join(root,'other-task');
  const seed={entity:'Calla Archive',fact:'Calla Archive keeps query logs for 28 days.',distractor:'Calla Archive keeps billing logs for 220 days.'};
  const db=await seedScope(s,cwd,seed),dbB=await seedScope(s,other,seed);
  await check('bilingual body matching needs both concepts and preserves literal numbers, code identities and scope',async()=>{
    db.updatePayload(101,{...db.getPayload(101),aliases:['海芋归档','日志保留']});
    const search=(query,options={})=>searchEntity(db,{entityId:101,query,packTokens:300,...options});
    const both=await search('海芋归档的查询日志留存多久？');
    assert.deepEqual(both.memoryPack.facts.map(row=>row.id),['201']);
    assert.equal(both.work.embeddingCalls,0);
    for(const input of ['海芋归档的查询日志留存 2 天吗？','X-Archive-01的查询日志留存多久？','日志保留多久收集查询日志？']) {
      const result=await search(input);
      assert.ok(!result.memoryPack.facts.some(row=>['201','202','302'].includes(row.id)),input);
    }
  });

  const args={entity_id:101,query:'Calla Archive query logs',pack_tokens:300};
  const brief={...args,query:'Confirm the same retention again.'};
  const sessionId='ticket-A';
  let clock=1_000_000;
  const reader=createTaskMemoryReader({now:()=>clock});
  const read=(input,scope={})=>reader.read(scope.db || db,scopedToolRequest(input,scope.limit || 1),{sessionId:scope.sessionId ?? sessionId});
  const previous=async()=>{
    const output=await read(args),cursor=cursorOf(output);
    assert.ok(cursor);assert.match(output,/id=201/);assert.doesNotMatch(output,/id=202|id=302/);
    return cursor;
  };
  const mustRefresh=async(cursor,input={},scope={})=>{
    const output=await read({...brief,followup_cursor:cursor,...input},scope);
    assert.match(output,/prior scoped evidence is unavailable/i);
    assert.doesNotMatch(output,/id=|28 days|220 days/);
  };
  await check('abbreviated reads replay the preceding delivered facts with a fresh bounded cursor',async()=>{
    const cursor=await previous();
    db.updatePayload(302,{...db.getPayload(302),text:'Unrelated project retention is 999 days.'});
    const follow=await read({...brief,entity_name:'海芋归档',entity_id:undefined,followup_cursor:cursor});
    assert.match(follow,/id=201/);assert.match(follow,/28 days/);assert.doesNotMatch(follow,/id=202|id=302|999 days/);
    assert.ok(estimateTokens(follow)<=300);
    const next=cursorOf(follow);
    assert.ok(next && next!==cursor);
    const unchanged=await read({...brief,entity_name:'海芋归档',entity_id:undefined,since:next});
    assert.match(unchanged,/unchanged/);assert.doesNotMatch(unchanged,/28 days/);
    await mustRefresh(cursor);
  });
  await check('task, entity, handle, session, budget and expiry are independent reuse gates',async()=>{
    const cursor=await previous();
    await mustRefresh(cursor,{entity_id:301});
    await mustRefresh(cursor,{}, {db:dbB});
    await mustRefresh(cursor,{}, {sessionId:'ticket-B'});
    await mustRefresh(cursor,{pack_tokens:250});
    await mustRefresh(cursor,{}, {limit:2});
    await mustRefresh(cursor,{query:'What is the encryption key?'});
    assert.throws(()=>scopedToolRequest({...brief,followup_cursor:cursor,since:cursor},8),/either since or followup_cursor/);
    const unlinked=await read(brief);
    assert.doesNotMatch(unlinked,/28 days/);
    await mustRefresh(cursor);
    const expiring=await previous();
    clock+=5*60_000;
    await mustRefresh(expiring);
    const cleared=await previous();
    reader.dropSession(sessionId);
    await mustRefresh(cleared);
  });
  await check('edited, expired, archived and detached facts cannot be replayed from a prior cursor',async()=>{
    const fact=db.getPayload(201);
    for (const patch of [{text:'Calla Archive keeps query logs for 45 days.'},{untilAt:'2025-01-01T00:00:00.000Z'},{status:'archived'}]) {
      const cursor=await previous();
      db.updatePayload(201,{...fact,...patch});
      await mustRefresh(cursor);
      db.updatePayload(201,fact);
    }
    const cursor=await previous();
    db.unlink(201,101,'about');
    await mustRefresh(cursor);
  });
});}

async function p113(){await environment(async({root,s,check})=>{
  const e=await import('../lib/extract.js'),{turnFromEvent}=await import('../lib/source-events.js');
  const cwd=join(root,'attribution'),db=await s.openWorkspaceDb(cwd);
  const name='重试次数',oldText='NileWorker 的重试次数是 4 次。',fresh='NileWorker 的重试次数是 7 次。';
  const id=s.insertNode(db,{type:'decision',name,text:oldText}),old=db.getPayload(id);
  const tool=(toolName,text,seq)=>turnFromEvent({type:'tool/result',seq,data:{message:{id:'tool-'+seq,role:'tool',content:[{type:'text',text}],isError:false}}},{name:toolName});
  const recall=tool('ctx_read',JSON.stringify({id,payload:{name,type:'decision',text:oldText}}),2);
  const user=(text,seq)=>({role:'user',text,seq,messageId:'user-'+seq,recorded:true});
  const question=user('NileWorker 的重试次数是多少？',1);
  const paraphrase={type:'decision',name,text:'NileWorker 最多允许重试 4 次。',quote:oldText};
  const run=(turns,candidates,heldCandidates=[])=>e.distill({db,sessionId:'source-check',turns,heldCandidates,llmCall:async()=>JSON.stringify({candidates})});
  await check('a paraphrase grounded only in memory stays pending under its observed read ID',async()=>{
    const round=await run([question,recall,{role:'assistant',text:paraphrase.text}], [paraphrase]);
    assert.ok(!round.applied.some(row=>row.text===paraphrase.text));assert.equal(round.unverified[0].reason,'memory-read-unverified');
    assert.deepEqual(round.unverified[0].readIds,[id]);assert.deepEqual(db.getPayload(id),old);
    const turns=[question,recall];await e.savePending(cwd,{sessionId:'source-check',turns,unverified:round.unverified,sourceReviewKey:e.sourceReviewKey(turns)});
    assert.deepEqual(e.loadPending(cwd).unverified[0].readIds,[id]);
  });
  await check('an unrelated or unknown tool echo cannot supply a source, but a new user value can',async()=>{
    const unknown=await run([question,tool('tool',fresh,3)],[{type:'decision',name,text:fresh}]);
    assert.ok(unknown.unverified.some(row=>row.text===fresh));
    const round=await run([question,recall,user(fresh,4)],[{type:'decision',name,text:fresh,quote:fresh}],e.loadPending(cwd).unverified);
    const stored=round.applied.find(row=>row.text===fresh);assert.ok(stored);assert.equal(db.getPayload(stored.id).source.messageId,'user-4');
    assert.equal(round.unverified[0].text,paraphrase.text);assert.deepEqual(db.getPayload(id),old);
  });
  await check('the exact supporting external tool, rather than our read or an assistant, owns the source locator',async()=>{
    const value='NileWorker 的并发上限是 11。';
    const round=await run([question,recall,{role:'assistant',text:value},tool('config_read',value,5)],[{type:'decision',name:'并发上限',text:value,quote:value}]);
    const stored=round.applied.find(row=>row.text===value);assert.ok(stored);assert.equal(db.getPayload(stored.id).source.messageId,'tool-5');
    assert.equal(db.getPayload(stored.id).source.role,'tool');
  });
});}

async function p114() {
  await environment(async ({root, s, check}) => {
    const settings = await import('../lib/settings.js');
    const {atomicWriteFile} = await import('../lib/atomic.js');
    const documents = await import('../lib/document-evidence.js');
    const {zeroVector} = await import('../lib/schema.js');
    const {createServer} = await import('node:http');
    const {registerMemoryApi} = await import('../lib/server.js');
    const isolatedHome = join(root, 'home');
    const isolatedSettings = join(isolatedHome, 'trivium.json');
    const originalSettings = join(root, 'legacy.json');
    const good = join(root, 'healthy');
    const bad = join(root, 'damaged');

    await check('DSH_HOME isolates settings while the legacy file and explicit override still work', async () => {
      delete process.env.DSH_TRIVIUM_SETTINGS;
      delete process.env.DSH_HOME;
      assert.equal(settings.settingsFilePath(), settings.SETTINGS_FILE);
      process.env.DSH_HOME = isolatedHome;
      process.env.DSH_TRIVIUM_SETTINGS = originalSettings;
      writeFileSync(originalSettings, JSON.stringify({autoRecall: true, pinsBySession: {old: [3]}, legacyField: 'retain'}));
      assert.equal(settings.settingsFilePath(), originalSettings);
      assert.equal(settings.recallModeOf(settings.readUiSettings()), 'auto');
      settings.writeUiSettings({recallMode: 'anchor'});
      assert.deepEqual(settings.pinsOf('old'), [3]);
      assert.equal(settings.readUiSettings().legacyField, 'retain');
      const before = readFileSync(originalSettings);
      delete process.env.DSH_TRIVIUM_SETTINGS;
      assert.equal(settings.settingsFilePath(), isolatedSettings);
      assert.deepEqual(settings.readUiSettings(), {});
      settings.writeUiSettings({recallMode: 'off'});
      settings.rememberWorkspace(good);
      settings.rememberWorkspace(bad);
      assert.deepEqual(settings.listedWorkspaces(), [good, bad]);
      assert.deepEqual(readFileSync(originalSettings), before);
    });

    await check('a rename failure preserves settings and a partial write preserves the old sidecar', async () => {
      const before = readFileSync(isolatedSettings);
      const rename = fs.renameSync;
      let attempts = 0;
      fs.renameSync = (from, to) => {
        if (to !== isolatedSettings) return rename(from, to);
        attempts++;
        throw Object.assign(new Error('Synthetic replacement failure'), {code: 'EPERM'});
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => settings.writeUiSettings({recallMode: 'auto'}), {code: 'EPERM'});
      } finally {
        fs.renameSync = rename;
        syncBuiltinESMExports();
      }
      assert.equal(attempts, 1);
      assert.deepEqual(readFileSync(isolatedSettings), before);
      assert.deepEqual(fs.readdirSync(isolatedHome), ['trivium.json']);

      const sidecar = join(root, 'previous.jsonl');
      atomicWriteFile(sidecar, 'previous\n');
      const write = fs.writeFileSync;
      fs.writeFileSync = (target, data, ...args) => {
        if (data !== 'replacement\n') return write(target, data, ...args);
        write(target, 'incomplete', ...args);
        throw Object.assign(new Error('Synthetic partial write'), {code: 'EIO'});
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => atomicWriteFile(sidecar, 'replacement\n'), {code: 'EIO'});
      } finally {
        fs.writeFileSync = write;
        syncBuiltinESMExports();
      }
      assert.equal(readFileSync(sidecar, 'utf8'), 'previous\n');
      assert.ok(!fs.readdirSync(root).some(name => name.startsWith('previous.jsonl.')));
      atomicWriteFile(sidecar, 'retry\n');
      assert.equal(readFileSync(sidecar, 'utf8'), 'retry\n');
    });

    await check('unreadable settings survive a failed settings update', async () => {
      const broken = join(root, 'unreadable.json');
      writeFileSync(broken, '{incomplete');
      process.env.DSH_TRIVIUM_SETTINGS = broken;
      try {
        assert.throws(() => settings.writeUiSettings({recallMode: 'auto'}), SyntaxError);
        assert.equal(readFileSync(broken, 'utf8'), '{incomplete');
      } finally {
        delete process.env.DSH_TRIVIUM_SETTINGS;
      }
    });

    const db = await s.openWorkspaceDb(good);
    const factId = s.insertNode(db, {type: 'decision', name: 'Retention', text: 'Backup retention is 21 days.'});
    const otherFactId = s.insertNode(db, {type: 'decision', name: 'Secondary retention', text: 'Backup retention is 22 days.'});
    mkdirSync(join(bad, '.dsh'), {recursive: true});
    writeFileSync(s.dbPathFor(bad), 'synthetic damaged TDB header');
    const pending = join(bad, '.dsh', 'trivium-pending.json');
    writeFileSync(pending, '{"windows":[]}');
    s.setActiveCwd(bad);
    let handler;
    registerMemoryApi({webServer: {register(route) { handler = route.handler; }}}, {liveOptions: () => ({}), status: {}});
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const get = async (route, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-trivium/${route}?${new URLSearchParams(args)}`,
        {headers: {connection: 'close'}});
      return {status: response.status, ...await response.json()};
    };

    try {
      await check('a corrupt default library returns a scoped health state and leaves other libraries usable', async () => {
        const problem = await get('status');
        assert.equal(problem.status, 200);
        assert.equal(problem.cwd, bad);
        assert.equal(problem.dbHealth.state, 'corrupt');
        assert.equal(problem.dbHealth.code, 'DB_CORRUPTED');
        assert.equal(problem.nodeCount, null);
        assert.ok(problem.dbExists && problem.workspaces.some(row => row.cwd === good));
        assert.equal(s.getOpenWorkspaceDb(bad), null);
        const healthy = await get('status', {cwd: good});
        assert.deepEqual(healthy.dbHealth, {state: 'ready'});
        assert.equal(healthy.cwd, good);
        assert.ok((await get('nodes', {cwd: good})).nodes.some(row => row.id === factId));
        const unselected = await get('status', {cwd: join(root, 'unknown')});
        assert.equal(unselected.dbHealth.state, 'unselected');
        assert.equal(readFileSync(s.dbPathFor(bad), 'utf8'), 'synthetic damaged TDB header');
        assert.equal(readFileSync(pending, 'utf8'), '{"windows":[]}');
      });

      const pageSize = documents.EVIDENCE_PAGE_SIZE;
      const otherSource = `docs/test-${pageSize + 2}.md`;
      for (let i = 0; i <= pageSize + 2; i++) {
        const text = i === pageSize + 2 ? 'Backup retention is 22 days.' : 'Backup retention is 21 days.';
        const {document} = documents.saveEvidenceDocument(db, {sourceId: `docs/test-${i}.md`, content: text});
        documents.attachDocumentEvidence(db, {factId: i === pageSize + 2 ? otherFactId : factId,
          documentId: document.document_id, revision: document.revision, quote: text});
      }
      const vector = zeroVector();
      const firstUnrelatedId = 10000;
      const irrelevant = Array.from({length: 4096}, (_, i) => ({type: 'insertWithId', id: firstUnrelatedId + i, vector, payload: {
        type: 'decision', status: 'active', name: 'Unrelated decision ' + i,
        text: ('Maintenance investigation documented an independent observation in this unrelated fixture. ').repeat(3).slice(0, 237),
        createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z',
        source: {kind: 'message', role: 'user', sessionId: 'audit-workspace-session-' + i,
          messageId: 'message-sequence-audit-' + i, seq: 2, quoteMatch: 'exact', recorded: true},
        uri: 'trivium:audit:unrelated-decision:' + i,
      }}));
      assert.ok(irrelevant.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.payload)), 0) > 2 * 1024 * 1024);
      for (let i = 0; i < irrelevant.length; i += 128) db.commitTransaction(irrelevant.slice(i, i + 128));

      await check('document and fact pages read matching records in a large mixed library', async () => {
        const allNodeIds = db.allNodeIds;
        const getPayload = db.getPayload;
        const readIds = [];
        db.allNodeIds = () => assert.fail('Scoped evidence read enumerated all node IDs');
        db.getPayload = function (id) { readIds.push(id); return getPayload.call(this, id); };
        try {
          const overview = await get('document-evidence', {cwd: good});
          assert.equal(overview.status, 200);
          assert.equal(overview.documents.length, pageSize);
          assert.equal(overview.links.length, pageSize);
          assert.ok(overview.documents.every(row => !('content' in row)));
          const second = await get('document-evidence', {cwd: good, documentAfter: overview.nextDocumentAfter});
          assert.equal(second.status, 200);
          assert.equal(second.documents.length, 3);
          assert.equal(second.nextDocumentAfter, null);
          assert.ok(!('links' in second));
          assert.ok(second.documents.some(row => row.sourceId === otherSource));

          const fact = await get('document-evidence', {cwd: good, factId});
          assert.equal(fact.status, 200);
          assert.deepEqual(fact.documents, []);
          assert.ok(fact.links.every(row => row.factId === factId));
          const rest = await get('document-evidence', {cwd: good, factId, evidenceAfter: fact.nextEvidenceAfter});
          assert.equal(rest.status, 200);
          assert.equal(rest.links.length, 2);
          assert.equal(rest.nextEvidenceAfter, null);
          assert.ok(!('documents' in rest));
          assert.ok(rest.links.every(row => row.factId === factId && row.evidenceId > fact.nextEvidenceAfter));

          const exact = await get('document-evidence', {cwd: good, sourceId: otherSource});
          assert.equal(exact.status, 200);
          assert.equal(exact.document.content, 'Backup retention is 22 days.');
          assert.deepEqual(exact.documents.map(row => row.sourceId), [otherSource]);
          assert.equal(exact.links[0].factId, otherFactId);
          const intersection = await get('document-evidence', {cwd: good, sourceId: otherSource, factId});
          assert.deepEqual(intersection.links, []);
          const invalid = await get('document-evidence', {cwd: good, factId, documentAfter: overview.nextDocumentAfter});
          assert.equal(invalid.status, 400);
          assert.equal(invalid.code, 'DOCUMENT_PAGE_INVALID');
          assert.ok(readIds.length && readIds.every(id => id < firstUnrelatedId));
        } finally {
          db.allNodeIds = allNodeIds;
          db.getPayload = getPayload;
        }
      });

      await check('the same scoped links remain readable through an existing read-only handle', async () => {
        s.closeAll();
        const readonly = s.openWorkspaceDbReadOnly(good);
        try {
          const view = documents.documentEvidenceStatus(readonly, {factId: otherFactId, sourceId: otherSource});
          assert.equal(view.links.length, 1);
          assert.equal(view.links[0].status, 'current');
        } finally {
          readonly.close();
        }
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function p115() {
  await environment(async ({root, s, check}) => {
    const {searchEntity, validateEntitySearch} = await import('../lib/entity-search.js');
    const {searchEntitySnapshot} = await import('../lib/entity-search-snapshot.js');
    const {createReadSnapshot} = await import('../lib/read-snapshots.js');
    const {createTaskMemoryReader, scopedToolRequest} = await import('../lib/task-memory.js');
    const cwd = join(root, 'named'), other = join(root, 'other');
    const db = await seedScope(s, cwd, {entity:'Ridge Relay', fact:'Ridge Relay retry limit is 4 attempts.', distractor:'Ridge Relay runs on Tuesdays.'});
    const foreignDb = await seedScope(s, other, {entity:'Ridge Relay', fact:'Ridge Relay retry limit is 17 attempts.', distractor:'Ridge Relay runs on Sundays.'});
    const alias = (handle, id, aliases, status) => handle.updatePayload(id, {...handle.getPayload(id), aliases, ...(status ? {status} : {})});
    alias(db, 101, ['Relay', '山脊中继']);
    alias(foreignDb, 101, ['Relay']);
    const query = 'Ridge Relay retry limit attempts';
    const search = (handle, entityName, opts) => searchEntity(handle, {entityName, query, packTokens: 300}, opts);

    await check('exact names and aliases normalize case and width within the selected database', async () => {
      for (const name of ['ridge relay', ' ＲＥＬＡＹ ', '山脊中继']) {
        const result = await search(db, name);
        assert.equal(result.entityId, 101);
        assert.equal(result.work.embeddingCalls, 0);
        assert.match(result.memoryPack.context, /4 attempts/);
        assert.doesNotMatch(result.memoryPack.context, /17 attempts/);
      }
      assert.match((await search(foreignDb, 'Relay')).memoryPack.context, /17 attempts/);
      await assert.rejects(search(db, 'Ridg'), {code: 'ENTITY_SEARCH_NAME_NOT_FOUND'});
      assert.throws(() => validateEntitySearch({entityId:101, entityName:'Relay', query}), {code:'ENTITY_SEARCH_INVALID'});
      await assert.rejects(search(db, 'Relay', {limits: {nodes:1}}), {code:'ENTITY_SEARCH_WORK_LIMIT'});
    });

    await check('same-name conflicts expose choices without embedding and snapshots resolve their own names', async () => {
      const prior = createReadSnapshot(db, cwd);
      alias(db, 301, ['Relay']);
      let embeddingCalls = 0;
      await assert.rejects(searchEntity(db, {entityName:'Relay', query, semantic:true}, {embedding:async () => {embeddingCalls++;}}),
        error => error.code === 'ENTITY_SEARCH_NAME_AMBIGUOUS' && error.choiceCount === 2 && JSON.stringify(error.choices.map(row=>row.id)) === '[101,301]');
      assert.equal(embeddingCalls, 0);
      const frozen = await searchEntitySnapshot(cwd, prior.snapshotId, {entityName:'Relay', query, packTokens:300});
      assert.equal(frozen.entityId, 101);
      assert.equal(frozen.source, 'snapshot');
      const ambiguous = createReadSnapshot(db, cwd);
      await assert.rejects(searchEntitySnapshot(cwd, ambiguous.snapshotId, {entityName:'Relay', query}),
        error => error.code === 'ENTITY_SEARCH_NAME_AMBIGUOUS' && error.choices.length === 2);
      alias(db, 301, ['Relay'], 'archived');
      assert.equal((await search(db, 'Relay')).entityId, 101);
    });

    await check('named compact cursors cannot follow an alias reassigned to another entity', async () => {
      const reader = createTaskMemoryReader();
      const args = {entity_name:'Relay', query, pack_tokens:300};
      const read = (input) => reader.read(db, scopedToolRequest(input, 5), {sessionId:'same-task'});
      const before = await read(args);
      assert.match(before, /4 attempts/);
      const since = before.match(/^Cursor: (.+)$/m)?.[1];
      assert.ok(since);
      assert.match(await read({...args,since}), /facts unchanged/);
      alias(db, 101, ['山脊中继']);
      alias(db, 301, ['Relay'], 'active');
      assert.match(await read({...args,since}), /Run ctx_find without since/);
      assert.equal((await search(db,'Relay')).entityId, 301);
    });
  });
}

async function p116() {
  await environment(async ({root,s,check}) => {
    const h = await import('../lib/handoff.js');
    const {createServer} = await import('node:http');
    const {registerMemoryApi} = await import('../lib/server.js');
    const {pendingPath,savePending} = await import('../lib/extract.js');
    const cwd = join(root,'central'), other = join(root,'other');
    let db = await s.openWorkspaceDb(cwd);
    const otherDb = await s.openWorkspaceDb(other);
    const old = s.insertNode(db,{type:'decision',name:'旧记录',text:'审计日志保留 30 天。'});
    const oldPayload = db.getPayload(old);
    const assignments = ['A','B'].map(id => ({ticketId:'ticket-'+id,assignmentId:'assignment-'+id,workerId:'worker-'+id}));
    const projectScopeId = 'central-test';
    await h.configureHandoff(cwd,{projectScopeId,assignments});
    const envelope = (worker,eventId,value,turn={}) => {
      const text = `合成中继端口是 ${value}。`;
      return {version:1,projectScopeId,...assignments[worker],eventId,sessionId:'executor-'+worker,
        sourceTurns:[{role:'user',text:`记住：${text}`,messageId:'source-'+value,recorded:true,...turn}],
        candidates:[{type:'decision',name:'中继端口',text,quote:text}]};
    };
    const receipt = row => h.handoffReceipt(cwd,row);
    const outcome = row => receipt(row).outcomes[0];
    const submit = (...rows) => Promise.all(rows.map(row => h.submitHandoff(cwd,row)));
    const drain = () => h.drainHandoff(cwd,db);
    const ids = (...rows) => rows.map(row => outcome(row).nodeId);

    await check('two processes share one recorded fact and keep distinct durable receipts', async () => {
      const a = envelope(0,'same-a',7431), b = envelope(1,'same-b',7431);
      const module = new URL('../lib/handoff.js',import.meta.url).href;
      await Promise.all([a,b].map(row => new Promise((resolve,reject) => {
        const source = `import {submitHandoff} from ${JSON.stringify(module)}; await submitHandoff(process.argv[1],JSON.parse(process.argv[2]));`;
        const child = spawn(process.execPath,['--input-type=module','-e',source,cwd,JSON.stringify(row)],{stdio:['ignore','ignore','pipe']});
        let err = '';
        child.stderr.on('data',chunk => {err += chunk;});
        child.on('error',reject);
        child.on('exit',code => code === 0 ? resolve() : reject(Error(err || `Worker exit ${code}`)));
      })));
      const before = db.nodeCount();
      assert.equal((await drain()).processed,2);
      assert.equal(db.nodeCount(),before+1);
      assert.notEqual(receipt(a).key,receipt(b).key);
      assert.equal(outcome(a).nodeId,outcome(b).nodeId);
      assert.deepEqual([outcome(a).reused,outcome(b).reused].sort(),[false,true]);
      assert.ok(outcome(a).factKey && outcome(a).factKey === outcome(b).factKey);
      s.closeWorkspaceDb(cwd,db);
      db = await s.openWorkspaceDb(cwd);
      assert.equal(db.getPayload(outcome(a).nodeId).text,a.candidates[0].text);
      assert.deepEqual(await h.submitHandoff(cwd,b),{...receipt(b),replayed:true});
    });

    await check('only the same recorded source and exact fact share a node', async () => {
      const a = envelope(0,'seq-a',7432,{messageId:undefined,seq:7});
      const b = envelope(1,'seq-b',7432,{messageId:undefined,seq:7});
      const c = envelope(0,'origin-a',7433,{messageId:undefined,seq:7,sourceSessionId:'original-session'});
      const d = envelope(1,'origin-b',7433,{messageId:undefined,seq:7,sourceSessionId:'original-session'});
      const e = envelope(0,'independent',7431,{messageId:'separate-message'});
      const f = envelope(0,'unrecorded',7431,{recorded:false});
      const g = envelope(1,'changed-source',7431,{text:'现明确确认：合成中继端口是 7431。'});
      const x = envelope(0,'facts',7434,{text:'合成中继端口是 7434。合成中继端口是 7435。'});
      x.candidates.push(envelope(1,'irrelevant',7435).candidates[0]);
      await submit(a,b,c,d,e,f,g,x);
      await drain();
      assert.notEqual(outcome(a).nodeId,outcome(b).nodeId);
      assert.equal(outcome(c).nodeId,outcome(d).nodeId);
      assert.equal(new Set(ids(envelope(0,'same-a',7431),e,f,g)).size,4);
      assert.equal(new Set(receipt(x).outcomes.map(row => row.nodeId)).size,2);
      assert.equal(new Set(receipt(x).outcomes.map(row => row.factKey)).size,2);
    });

    await check('a pre-existing v1 receipt is reused without rewriting its memory', async () => {
      const a = envelope(0,'legacy',7436), b = envelope(1,'legacy-reuse',7436);
      const accepted = await h.submitHandoff(cwd,a);
      const legacy = s.insertNode(db,{...a.candidates[0],uri:`trivium:handoff:${accepted.key}:0`,source:{handoff:{key:accepted.key}}});
      const original = db.getPayload(legacy);
      const file = h.handoffPath(cwd), state = JSON.parse(readFileSync(file,'utf8'));
      const stored = state.entries.find(row => row.key === accepted.key);
      Object.assign(stored,{status:'committed',completedAt:accepted.acceptedAt,outcomes:[{index:0,status:'committed',nodeId:legacy,reused:false}]});
      fs.writeFileSync(file,JSON.stringify(state));
      await submit(b);
      await drain();
      assert.equal(outcome(b).nodeId,legacy);
      assert.equal(outcome(b).reused,true);
      assert.equal(outcome(a).factKey,undefined);
      assert.deepEqual(db.getPayload(legacy),original);
    });

    await check('a failed flush never advances either receipt and retries write the fact once', async () => {
      const a = envelope(0,'flush-a',7437), b = envelope(1,'flush-b',7437);
      const before = db.nodeCount(), flush = db.flush;
      await submit(a,b);
      try {
        db.flush = () => {throw Error('synthetic failure');};
        await assert.rejects(drain(),/synthetic failure/);
        assert.equal(receipt(a).status,'queued');
        assert.equal(receipt(b).status,'queued');
      } finally { db.flush = flush; }
      await drain();
      assert.equal(db.nodeCount(),before+1);
      assert.equal(outcome(a).nodeId,outcome(b).nodeId);
    });

    const archived = envelope(1,'archived-origin',7431);
    await check('archived facts are not resurrected and become reviewable', async () => {
      const oldHandoff = outcome(envelope(0,'same-a',7431)).nodeId;
      assert.ok(s.archiveNode(db,oldHandoff));
      const before = db.nodeCount();
      await submit(archived);
      await drain();
      assert.equal(db.nodeCount(),before);
      assert.equal(outcome(archived).reason,'previous-memory-changed');
      assert.equal(db.getPayload(oldHandoff).status,'archived');
    });

    const tool = (worker,eventId,value) => {
      const row = envelope(worker,eventId,value);
      Object.assign(row.sourceTurns[0],{role:'tool',toolName:'ctx_read',text:row.candidates[0].text});
      return row;
    };
    const first = tool(0,'review-one',7438), second = tool(1,'review-two',7438), ignore = tool(1,'review-ignore',7438);
    const recovery = tool(0,'review-recovery',7439);
    await submit(first,second,ignore,recovery);
    await drain();
    const extractionText = '普通抽取待核对。';
    await savePending(cwd,{sessionId:'regular-extraction',turns:[{role:'user',text:'普通对话。'}],
      unverified:[{type:'decision',name:'普通抽取',text:extractionText}]});
    const extractionBytes = readFileSync(pendingPath(cwd));
    const unrelatedCount = otherDb.nodeCount();
    let handler;
    registerMemoryApi({webServer:{register(route) {handler = route.handler;}}},{liveOptions:() => ({}),status:{}});
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const request = async (path,workspace=cwd,body,params={}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-trivium/pending${path}?${new URLSearchParams({cwd:workspace,...params})}`,{
        headers:{connection:'close','content-type':'application/json'},
        ...(body ? {method:'POST',body:JSON.stringify(body)} : {}),
      });
      return {status:response.status,data:await response.json()};
    };
    const readPanel = async params => (await request('',cwd,null,params)).data;
    const panelAction = async (eventId,action,evidence) => {
      const win = (await readPanel()).windows.find(row => row.handoff?.eventId === eventId);
      assert.ok(win,`missing ${eventId}`);
      return {origin:'handoff',sessionId:win.sessionId,candidateId:win.unverified[0].id,etag:win.etag,action,evidence};
    };
    const review = (body,workspace) => request('/review',workspace,body);
    try {
      await check('existing review API keeps original sources, evidence and independent handoff outcomes', async () => {
        const before = db.nodeCount();
        assert.ok((await readPanel()).windows.some(row => !row.handoff && row.unverified[0].text === extractionText));
        const accept = await panelAction(first.eventId,'confirm');
        assert.equal((await review(accept,other)).data.code,'PENDING_REVIEW_STALE');
        assert.equal((await review(accept)).status,200);
        assert.equal((await review(accept)).data.replayed,true);
        assert.equal((await review({...accept,action:'dismiss'})).status,409);
        const row = (await readPanel()).windows.find(row => row.handoff?.eventId === second.eventId);
        assert.equal(row.evidence[0].role,'tool');
        assert.equal(row.unverified[0].existingFacts[0].id,outcome(first).nodeId);
        assert.equal((await review(await panelAction(second.eventId,'verify','不相关的材料。'))).data.settled,false);
        const verified = await review(await panelAction(second.eventId,'verify',second.candidates[0].text));
        assert.equal(verified.data.reused,true);
        assert.equal(verified.data.nodeId,outcome(first).nodeId);
        const dismissed = await review(await panelAction(ignore.eventId,'dismiss'));
        assert.equal(dismissed.data.nodeId,null);
        assert.equal(receipt(ignore).status,'reviewed');
        assert.equal(outcome(ignore).status,'dismissed');
        assert.equal((await review(await panelAction(archived.eventId,'confirm'))).data.code,'PENDING_REVIEW_NODE_CHANGED');
        assert.equal(db.nodeCount(),before+1);
        const history = (await readPanel({reviewLimit:2})).history;
        assert.equal(history.total,3);
        assert.equal(history.entries.length,2);
        assert.equal((await readPanel({reviewLimit:2,reviewOffset:2})).history.entries[0].handoff.workerId,'worker-A');
        assert.deepEqual(readFileSync(pendingPath(cwd)),extractionBytes);
      });

      await check('a failed review receipt rename keeps the candidate and retries its original write only', async () => {
        const accept = await panelAction(recovery.eventId,'confirm');
        const before = db.nodeCount();
        const file = h.handoffPath(cwd), bytes = readFileSync(file), rename = fs.renameSync;
        try {
          fs.renameSync = (from,to) => {
            if (to === file) throw Error('synthetic rename failure');
            return rename(from,to);
          };
          syncBuiltinESMExports();
          assert.equal((await review(accept)).status,500);
          assert.deepEqual(readFileSync(file),bytes);
          assert.equal(receipt(recovery).status,'needs_review');
        } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
        assert.equal((await review({...accept,action:'dismiss'})).data.code,'PENDING_REVIEW_ALREADY_WRITTEN');
        assert.equal((await review(accept)).status,200);
        assert.equal((await review(accept)).data.replayed,true);
        assert.equal(db.nodeCount(),before+1);
        assert.equal(receipt(recovery).status,'committed');
      });

      await check('handoff paging keeps all candidates reachable and unreadable inboxes leave extraction visible', async () => {
        await submit(...Array.from({length:12},(_,i) => tool(0,`page-${i}`,7440+i)));
        await drain();
        const page = await readPanel({handoffOffset:12});
        assert.deepEqual(page.handoffPage,{offset:12,limit:12,total:13});
        assert.equal(page.windows.filter(row => row.handoff).length,1);
        assert.equal((await request('',other)).data.windows.length,0);
        const file = h.handoffPath(cwd), original = readFileSync(file);
        fs.writeFileSync(file,'{');
        try {
          const data = await readPanel();
          assert.equal(data.handoffError,'HANDOFF_UNREADABLE');
          assert.ok(data.windows.some(row => !row.handoff && row.unverified[0].text === extractionText));
        } finally { fs.writeFileSync(file,original); }
        assert.deepEqual(db.getPayload(old),oldPayload);
        assert.equal(otherDb.nodeCount(),unrelatedCount);
      });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
