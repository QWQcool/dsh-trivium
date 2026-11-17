/** Write-quality, manual review and paid-evaluator safety. Tests never call a model. */
export const cases=Object.freeze({p105,p106});
async function p105() {
  const assert=(await import('node:assert/strict')).default;
  const fs=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const root=fs.mkdtempSync(join(tmpdir(),'trivium-quality-'));
  process.env.DSH_TRIVIUM_SETTINGS=join(root,'settings.json');process.env.DSH_HOME=join(root,'home');
  const e=await import('../lib/extract.js'),s=await import('../lib/store.js');
  const {reviewPending}=await import('../lib/pending-review.js');
  const {registerMemoryApi}=await import('../lib/server.js');
  const {createServer}=await import('node:http');
  let server,checks=0;
  const check=async(name,fn)=>{await fn();checks++;console.log('ok '+name);};
  const cand=(text='导出格式固定为 XLSX。')=>({type:'decision',name:'导出格式',text,quote:'导出格式是什么？',reason:'source-unverified'});
  const turns=[{role:'user',text:'导出格式是什么？',seq:11,recorded:true,messageId:'q-11'}];
  const save=async(cwd,id='proof',items=[cand()])=>e.savePending(cwd,{sessionId:id,turns,unverified:items,sourceReviewKey:e.sourceReviewKey(turns)});
  const request=(cwd,action='confirm',extra={})=>{const win=e.pendingSummary(cwd).windows[0];return {sessionId:win.sessionId,candidateId:win.unverified[0].id,etag:win.etag,action,...extra};};
  const cwd=join(root,'a'),other=join(root,'b');
  try {
    const db=await s.openWorkspaceDb(cwd),dbB=await s.openWorkspaceDb(other);
    await check('only complete admitted facts suppress instruction copies',async()=>{
      const rule={via:'rule',type:'preference',text:'另外记住：端口是 8443。'};
      const model={via:'model',type:'decision',text:'端口是 8443。'};
      assert.deepEqual(e.coalesceRuleCopies([rule,model]),[model]);
      for(const alternative of [{...model,text:'端口是 8444。'},{...model,text:'端口不是 8443。'},{...model,text:'端口是'},{...model,via:'rule'}])
        assert.ok(e.coalesceRuleCopies([rule,alternative]).includes(rule));
      for(const text of ['以后都用中文。','记住：端口是 8443，超时是 30 秒。'])
        assert.ok(e.coalesceRuleCopies([{...rule,text},model]).some(c=>c.text===text));
      const entityFact=e.coalesceRuleCopies([rule,{...model,type:'entity',name:'端口设置'}]);
      assert.equal(entityFact.length,1);assert.equal(entityFact[0].type,'preference');
      assert.equal(e.coalesceRuleCopies([{...rule,text:'记住：端口设置。'},{...model,type:'entity',name:'端口设置',text:'端口设置。'}]).length,2);
    });
    await check('model failures, empty/invalid/unsupported output preserve rule fallback',async()=>{
      for(const [index,raw] of ['', '{broken','{"candidates":[]}',JSON.stringify({candidates:[{type:'decision',text:'端口是 9555。'}]})].entries()) {
        const d=await s.openWorkspaceDb(join(root,'fallback'+index));
        const r=await e.distill({db:d,sessionId:'r',turns:[{role:'user',text:'记住：端口是 8443。'}],llmCall:async()=>raw});
        assert.ok(r.applied.some(row=>row.text.includes('8443')));
      }
    });
    await check('asserted read permissions are facts; reading requests are not new evidence',async()=>{
      const {candidateEvidence}=await import('../lib/source-events.js');
      const fact={text:'FirLedger 允许读取但不允许删除。'};
      assert.equal(candidateEvidence(fact,[{role:'user',text:'记住：FirLedger 允许读取但不允许删除。'}]).supported,true);
      for(const text of ['请读取 FirLedger 允许读取但不允许删除。','现在读取 FirLedger 允许读取但不允许删除。','FirLedger 允许读取但不允许删除吗？'])
        assert.equal(candidateEvidence(fact,[{role:'user',text}]).supported,false,text);
      for(const text of ['不允许读取。','允许读取。'])
        assert.equal(candidateEvidence({text},[{role:'user',text:text==='允许读取。'?'不允许读取。':'允许读取。'}]).supported,false);
    });
    const old=s.insertNode(db,{type:'decision',name:'导出格式',text:'导出格式固定为 CSV。'}),oldPayload=db.getPayload(old);
    await save(cwd,'proof',[cand(),cand('导出格式固定为 PDF。')]);await save(other,'proof',[cand(),cand('导出格式固定为 PDF。')]);
    await check('ETag binds identical source and candidate IDs to a physical workspace',async()=>{
      const a=request(cwd),b=request(other);assert.equal(a.candidateId,b.candidateId);assert.notEqual(a.etag,b.etag);
      await assert.rejects(reviewPending(other,dbB,a),err=>err.status===409);assert.equal(e.pendingSummary(other).windows[0].unverified.length,2);
    });
    await check('unsupported supplements remain pending with refreshed source and etag',async()=>{
      const before=request(cwd,'verify',{evidence:'格式还未确定。'});
      const result=await reviewPending(cwd,db,before);assert.equal(result.settled,false);
      assert.equal(e.pendingSummary(cwd).windows[0].unverified.length,2);assert.notEqual(request(cwd).etag,before.etag);
      assert.equal(e.pendingNeedsExtraction(e.loadPending(cwd)),false);
      await assert.rejects(reviewPending(cwd,db,before),err=>err.status===409);
    });
    await check('supplement is attributed to the panel and writes only its confirmed content',async()=>{
      const r=await reviewPending(cwd,db,request(cwd,'verify',{evidence:'确认：导出格式固定为 XLSX。'}));assert.equal(r.settled,true);
      const p=db.getPayload(r.nodeId);assert.equal(p.source.kind,'manual');assert.equal(p.source.recorded,false);
      assert.equal(p.source.messageId,null);assert.equal(p.source.evidenceKind,'user-supplement');
      assert.deepEqual(db.getPayload(old),oldPayload);assert.equal(e.pendingSummary(cwd).windows[0].unverified.length,1);
    });
    await check('manual confirmation retains source, does not supersede or merge old facts',async()=>{
      const r=await reviewPending(cwd,db,request(cwd));assert.equal(r.settled,true);
      assert.equal(db.getPayload(r.nodeId).source.evidenceKind,'user-confirmation');
      assert.equal(e.pendingSummary(cwd).windows.length,0);assert.equal(e.loadPending(cwd).turns.length,4);
      assert.deepEqual(db.getPayload(old),oldPayload);assert.equal(e.pendingNeedsExtraction(e.loadPending(cwd)),false);
      assert.equal(e.reviewedCandidateIds(cwd,'proof',turns).length,2);
      const replay=await e.distill({db,turns,sessionId:'proof',reviewedIds:e.reviewedCandidateIds(cwd,'proof',turns),heldCandidates:[cand()],llmCall:async()=>JSON.stringify({candidates:[cand()]})});
      assert.equal(replay.unverified.length,0);assert.equal(replay.applied.length,0);
    });
    await check('stale buffers cannot resurrect reviewed candidates or consume new facts',async()=>{
      await save(cwd,'proof');assert.equal(e.pendingSummary(cwd).windows.length,0);
      const fresh={role:'user',text:'记住：并发上限是 13。',seq:12,recorded:true,messageId:'new-12'};
      await e.savePending(cwd,{sessionId:'proof',turns:[...turns,fresh],unverified:[cand()]});
      assert.equal(e.pendingNeedsExtraction(e.loadPending(cwd)),true);
      assert.equal(e.pendingSummary(cwd).windows[0].unverified.length,0);
    });
    await check('secret evidence and forged candidate content are refused without writes',async()=>{
      const b=request(other);const n=dbB.allNodeIds().length;
      await assert.rejects(reviewPending(other,dbB,{...b,text:'override'}),err=>err.status===400);
      await assert.rejects(reviewPending(other,dbB,{...b,action:'verify',evidence:'sk-'+'x'.repeat(40)}),err=>err.status===422);
      assert.equal(dbB.allNodeIds().length,n);
    });
    await check('interrupted pending commit retries reuse the already persisted URI',async()=>{
      const req=request(other),original=fs.readFileSync(e.pendingPath(other));
      const first=await reviewPending(other,dbB,req),count=dbB.allNodeIds().length;
      // Simulate a crash after the TDB commit, before the pending-file rename.
      fs.writeFileSync(e.pendingPath(other),original);
      const retry=await reviewPending(other,dbB,req);assert.equal(retry.reused,true);assert.equal(retry.nodeId,first.nodeId);assert.equal(dbB.allNodeIds().length,count);
    });
    await check('a failed writer leaves pending candidates and unrelated windows untouched',async()=>{
      const req=request(other),original=fs.readFileSync(e.pendingPath(other),'utf8');
      const writer={insert(){throw Error('disk failed');},merge(){throw Error('merge forbidden');},link(){throw Error('link forbidden');},update(){throw Error('update forbidden');}};
      await assert.rejects(reviewPending(other,dbB,req,{writer}),/disk failed/);assert.equal(fs.readFileSync(e.pendingPath(other),'utf8'),original);
    });
    let handler;registerMemoryApi({webServer:{register(x){handler=x.handler;return()=>{};}}},{liveOptions:()=>({}),status:{}});
    server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const base=`http://127.0.0.1:${server.address().port}/api/dsh-trivium/pending/review`;
    const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
    await check('real HTTP route requires explicit known cwd and rejects hostile origin/schema/oversize',async()=>{
      assert.equal((await post(base,request(other))).status,400);
      assert.equal((await post(base+'?cwd='+encodeURIComponent(join(root,'unknown')),request(other))).status,400);
      assert.equal((await post(base+'?cwd='+encodeURIComponent(other),request(other),{origin:'https://evil.invalid'})).status,403);
      assert.equal((await post(base+'?cwd='+encodeURIComponent(other),'x'.repeat(17000))).status,413);
      assert.equal((await post(base+'?cwd='+encodeURIComponent(other),'{broken')).status,400);
    });
    await check('real HTTP route participates in workspace locking and records success',async()=>{
      const {acquireWorkspaceLock}=await import('../lib/workspace-lock.js');
      const lock=acquireWorkspaceLock(other);assert.equal(lock.ok,true);
      try {assert.equal((await post(base+'?cwd='+encodeURIComponent(other),request(other))).status,409);}finally{lock.release();}
      const r=await post(base+'?cwd='+encodeURIComponent(other),request(other));assert.equal(r.status,200);assert.equal((await r.json()).settled,true);
      const {readChanges}=await import('../lib/change-log.js');
      const entry=readChanges(other).entries.find(r=>r.reason==='source-reviewed');assert.ok(entry);
      assert.ok(entry.nodeId>0);assert.equal(entry.byId,null);assert.equal(entry.source.seq,null);
    });
    console.log(`P105: ${checks}/${checks}`);
  } finally {if(server) await new Promise(done=>server.close(done));s.closeAll();fs.rmSync(root,{recursive:true,force:true});}
}
async function p106() {
  const assert=(await import('node:assert/strict')).default;
  const {readFileSync,mkdtempSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path'),{tmpdir}=await import('node:os');
  const {scoreLiveWrite,scoreLiveAnswer,usageOf,legacyContext,LIVE_FIXTURE,runLiveEvaluation,prepareEvalBridge}=await import('./memory-eval-live.mjs');
  const fixture=JSON.parse(readFileSync(LIVE_FIXTURE));assert.equal(fixture.scenarios.length,12);
  assert.equal(fixture.scenarios.filter(s=>s.split==='holdout').length,4);
  const scenario={fact:'端口是 8443。',answer:'8443'};
  assert.equal(scoreLiveWrite(scenario,[{id:1,type:'preference',text:'记住：端口是 8443。'}],[]).correct,true);
  assert.equal(scoreLiveWrite(scenario,[],[{text:'端口是 8443。'}]).pending,1);
  assert.equal(scoreLiveWrite({fact:null},[{id:2,type:'decision',text:'未知值'}],[]).unsourced.length,1);
  assert.equal(scoreLiveAnswer(scenario,'{"status":"answered","value":"8443","ids":[3]}',[3],[3]).correct,true);
  assert.equal(scoreLiveAnswer(scenario,'{"status":"answered","value":"8443","ids":[999]}',[3],[3]).correct,false);
  assert.equal(scoreLiveAnswer(scenario,'{"status":"answered","value":"8443","ids":[3,4]}',[3,4],[3]).correct,false);
  assert.equal(scoreLiveAnswer({answer:null},'{"status":"unknown","value":null,"ids":"[]"}',[],[]).correct,false);
  assert.equal(scoreLiveAnswer(scenario,'{"status":"unknown","value":null,"ids":[]}',[3],[3]).correct,false);
  assert.equal(scoreLiveAnswer({answer:null},'{"status":"unknown","value":null,"ids":[]}',[],[]).correct,true);
  assert.equal(scoreLiveAnswer(scenario,'no JSON',[],[]).correct,false);
  assert.equal(usageOf({usage:[]}),null);
  assert.equal(usageOf({usage:[{inputTokens:10,outputTokens:1},{inputTokens:20,outputTokens:4,cacheReadTokens:8}]}).aggregateInputTokens,28);
  const details={records:[{id:3,l0:'端口是 8443。'}],text:{pins:'',recall:'[decision#3] 端口是 8443。',total:42}};
  assert.equal(legacyContext(details),details.text.recall);
  assert.throws(()=>legacyContext({...details,text:{total:42}}),/missing selected/);
  await assert.rejects(runLiveEvaluation({}),/Require/);
  await assert.rejects(runLiveEvaluation({out:'unused',bridge:'https://external.invalid',tokenFile:'unused'}),/local HTTP/);
  const root=mkdtempSync(join(tmpdir(),'trivium-bridge-')),priorToken=process.env.TRIVIUM_EVAL_TOKEN;
  const {createServer}=await import('node:http');let server;
  try {
    const generated=prepareEvalBridge(join(root,'adapter'));assert.equal(readFileSync(generated.tokenFile,'utf8').length,64);
    assert.throws(()=>prepareEvalBridge(generated.directory),/new bridge/);
    const {apply}=await import('./eval-host-bridge.mjs');let handler,calls=0;
    process.env.TRIVIUM_EVAL_TOKEN='synthetic-test-token';
    await apply({webServer:{register(entry){handler=entry.handler;}},llm:{listModels:async()=>[{id:'test-model'}],async *stream(options){
      calls++;assert.equal(options.maxTokens,32);assert.equal(options.reasoningEffort,'off');assert.ok(options.signal);
      yield {type:'text-delta',index:0,text:'READY'};
      yield {type:'usage',usage:{inputTokens:5,outputTokens:1,cacheReadTokens:3,totalTokens:9}};
      yield {type:'finish',reason:{kind:'stop'}};
    }}});
    server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const url=`http://127.0.0.1:${server.address().port}/api/trivium-quality-eval`;
    const request={provider:'deepseek-account',model:'deepseek-flash',prompt:'Test synthetic data',maxTokens:32};
    const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'x-eval-token':process.env.TRIVIUM_EVAL_TOKEN,'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
    assert.equal((await post(request,{'x-eval-token':'wrong'})).status,403);
    assert.equal((await post(request,{origin:'https://evil.invalid'})).status,403);
    assert.equal((await post({...request,maxTokens:901})).status,400);
    assert.equal((await post({...request,provider:'other'})).status,400);
    assert.equal((await post('x'.repeat(32769))).status,413);assert.equal(calls,0);
    for(let i=0;i<48;i++) {const response=await post(request);assert.equal(response.status,200);const row=await response.json();assert.equal(row.text,'READY');assert.equal(row.usage[0].totalTokens,9);}
    assert.equal((await post(request)).status,429);assert.equal(calls,48);
  } finally {if(server)await new Promise(done=>server.close(done));rmSync(root,{recursive:true,force:true});if(priorToken===undefined)delete process.env.TRIVIUM_EVAL_TOKEN;else process.env.TRIVIUM_EVAL_TOKEN=priorToken;}
  console.log('P106: rubric, factual/citation scoring, usage counters, actual legacy text and bounded loopback adapter; no real-model or external-provider calls');
}
