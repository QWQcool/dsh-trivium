import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellIdentity, prepareCell, assertInside, fixtureReceipt } from './experiment-support.mjs';
import { createModelLedger, validUsage } from './model-ledger.mjs';
const root=mkdtempSync(join(tmpdir(),'trivium-r2-'));
try {
  assert.equal(validUsage({prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:2}),false);
  assert.equal(validUsage({prompt_tokens:1}),false);
  const paths = ['trivium-inject','trivium-tools','goodmemory-256','goodmemory-300','dsmmemory-800','dsmmemory-800-min0'].flatMap(a=>[0,1].flatMap(r=>['S01','S07'].map(s=>cellIdentity(root,a,r,s))));
  assert.equal(new Set(paths.map(x=>x.cell)).size,24);assert.equal(new Set(paths.map(x=>x.sessionId)).size,24);
  prepareCell(root,'a',0,'S01');assert.throws(()=>prepareCell(root,'a',0,'S01'));assert.throws(()=>assertInside(root,root+'-escape'));assert.throws(()=>cellIdentity(root,'../escape',0,'S01'));
  const f=[{text:'事实甲'},{text:'事实乙'}];assert.equal(fixtureReceipt(f,['事实乙','事实甲']).count,2);assert.throws(()=>fixtureReceipt(f,['事实甲','事实甲']));
  for(const mode of ['success','missing','http','timeout','price']) {
    const report={calls:[]}; let network=0,savedBefore=false;
    const req=createModelLedger({report,save:()=>{},budget:1,model:'deepseek-flash',fetchImpl:async()=>{network++;savedBefore=report.calls[0].state==='reserved'&&report.reservedOrChargedCny>0;if(mode==='timeout')throw Error('timeout');return {ok:mode!=='http',status:500,json:async()=>({model:mode==='price'?'unknown':'deepseek-flash',usage:mode==='missing'?undefined:{prompt_tokens:100,completion_tokens:4},choices:[{message:{content:'{}'}}]})};}});
    const body={model:'deepseek-flash',messages:[],max_tokens:400};
    if(mode==='success'){await req(body,'a');assert.equal(report.calls[0].state,'complete');}
    else{await assert.rejects(req(body,'a'));assert.equal(report.reservedOrChargedCny,report.calls[0].reservedCny);await assert.rejects(req(body,'b'));assert.equal(network,1);}
    assert.equal(savedBefore,true);
  }
  let called=false;const noBudget=createModelLedger({report:{},save:()=>{},budget:0.00001,model:'deepseek-flash',fetchImpl:async()=>{called=true;}});await assert.rejects(noBudget({model:'deepseek-flash',messages:[],max_tokens:600},'x'));assert.equal(called,false);
  console.log('P39 passed: isolated identities, fixture checks, pre-request reservation, failure latch, unknown usage/price and budget stop');
}finally{rmSync(root,{recursive:true,force:true});}
