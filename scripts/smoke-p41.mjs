/** Offline integration: execute the actual experiment runners, never --run. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'trivium-bench-regression-'));
const repo=resolve(import.meta.dirname,'..');
const run=(script,args,out)=>{
  const p=spawnSync(process.execPath,[join(repo,'scripts',script),...args,`--out=${out}`],{cwd:repo,encoding:'utf8',timeout:60000,maxBuffer:2e6,env:{...process.env,DEEPSEEK_API_KEY:''}});
  assert.equal(p.status,0,p.stderr+p.stdout);return JSON.parse(readFileSync(out,'utf8'));
};
try {
  const args=['--arms=trivium-inject,trivium-tools','--scenarios=S01,S07'];
  const a=run('bench-c4.mjs',args,join(root,'forward.json')),b=run('bench-c4.mjs',[...args,'--reverse'],join(root,'reverse.json'));
  assert.equal(a.calls.length+b.calls.length,0);
  assert.equal(new Set(a.cells.map(c=>c.injection.cwd)).size,4);
  assert.equal(new Set(a.cells.map(c=>c.identity.sessionId)).size,4);
  for(const c of a.cells){const other=b.cells.find(d=>d.arm===c.arm&&d.scenario===c.scenario);assert.equal(c.context,other.context);assert.equal(c.injection.fixture.contentHash,other.injection.fixture.contentHash);assert.equal(c.injection.planted.ids[0],2);}
  const d=run('bench-d1.mjs',['--arms=trivium-compact'],join(root,'d1.json'));
  const t1=d.cells.find(c=>c.session==='s1'&&c.turn===1);assert.match(JSON.stringify(t1.requestMessages),/dsh-trivium memory map/);assert.match(JSON.stringify(t1.requestMessages),/autoRecall/);
  const t3=d.cells.find(c=>c.session==='s1'&&c.turn===3);assert.match(JSON.stringify(t3.requestMessages),/dsh-trivium memory map/);assert.ok(t3.requestMessages.every(m=>typeof m.content==='string'||(Array.isArray(m.content)&&m.content.every(b=>b.type==='text'&&typeof b.text==='string'))));
  const manifest=JSON.parse(readFileSync(join(repo,'docs/evidence/manifest.json'),'utf8'));
  for(const f of manifest.files)assert.equal(createHash('sha256').update(readFileSync(join(repo,'docs/evidence',f.name))).digest('hex'),f.sha256);
  const n=run('cost-normalize.mjs',manifest.files.filter(f=>f.calls>0).map(f=>join(repo,'docs/evidence',f.name)),join(root,'normalized.json'));
  assert.equal(n.grandTotal.calls,622);assert.ok(Math.abs(n.grandTotal.cnyOffpeak-0.17895998)<1e-10);
  const e=run('bench-extract-cost.mjs',[],join(root,'extract.json'));assert.equal(e.calls.length,0);assert.equal(e.rows.length,9);assert.ok(e.rows.every(r=>r.persisted.nodes&&r.grade.rubric==='source-grounded-v1'));
  console.log('P41 passed: actual C4 order/isolation, D1 persistent map/history, 9 immutable manifests, 622-call accounting and persisted extraction grading');
}finally{rmSync(root,{recursive:true,force:true});}
