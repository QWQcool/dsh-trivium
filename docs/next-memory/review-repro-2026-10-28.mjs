import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root=process.argv[2] || fileURLToPath(new URL('../../',import.meta.url));
const load=name=>import(pathToFileURL(join(root,'lib',name)).href);
const workspace=mkdtempSync(join(tmpdir(),'trivium-review-repro-'));
process.env.DSH_TRIVIUM_SETTINGS=join(workspace,'settings.json');
const {selectContextRecords,renderContextRecords}=await load('context-budget.js');
const ledger=await load('turn-ledger.js');
const store=await load('store.js');
const {supersede,etagOf,makeRevisionResolver}=await load('revisions.js');
const {recallPreview}=await load('recall-preview.js');
const findings={};
try {
  ledger.resetAll();
  const pins=[1,2,3].map(id=>({id,type:'decision',l0:`约定${id}：`+'这是需要保留的项目约定。'.repeat(18)}));
  let total=0;const steps=[];
  for(let step=1;step<=3;step++){
    const remaining=ledger.remainingOf('session','uid:one-turn',300);
    const plan=selectContextRecords({pins,budget:remaining,delivered:ledger.deliveredOf('session','uid:one-turn')});
    const text=renderContextRecords(plan);total+=text.total;
    ledger.commit(ledger.reserve('session','uid:one-turn',plan.records));
    steps.push({step,ids:plan.records.map(r=>r.id),actualEstimatedTokens:text.total,ledgerSpent:ledger.spentOf('session','uid:one-turn'),remainingNext:ledger.remainingOf('session','uid:one-turn',300)});
  }
  findings.turnBudget={steps,totalEstimatedTokens:total,cap:300};
  const db=await store.openWorkspaceDb(join(workspace,'revision'));
  const oldId=store.insertNode(db,{type:'decision',name:'旧鉴权',text:'CookieLegacy 是旧鉴权方案。',uri:'ctx://decision/old'});
  const newId=store.insertNode(db,{type:'decision',name:'新鉴权',text:'HeaderCurrent 是新的唯一鉴权方案。',uri:'ctx://decision/new'});
  const changed=supersede(db,{oldId,successorId:newId,operationId:'review-op',expectedEtags:{old:etagOf(db,oldId),new:etagOf(db,newId)}});
  const preview=recallPreview(db,{query:'CookieLegacy',mode:'auto',cwd:join(workspace,'revision')});
  findings.versionProjection={oldId,newId,changed,preview};
  const target=await store.openWorkspaceDb(join(workspace,'import'));
  const imported=store.importGraph(target,{format:'dsh-trivium-graph',version:2,nodes:[
    {id:100,payload:{type:'decision',name:'鉴权约定',text:'鉴权统一使用请求头携带会话凭据。',uri:'ctx://decision/rev100',status:'active'}},
    {id:200,payload:{type:'decision',name:'鉴权约定',text:'鉴权统一使用请求头携带会话凭据。所有请求还必须校验签名。',uri:'ctx://decision/rev200',status:'active'}}
  ],edges:[{from:200,to:100,label:'supersedes',metadata:{reason:'新版取代旧版'}}]});
  findings.importContainedText={result:imported,graph:store.exportGraph(target),heads:target.allNodeIds().map(id=>({id,head:store.currentHeadOf(target,id)}))};
} finally {store.closeAll()}
writeFileSync(join(tmpdir(),'dsh-next-review-repro.json'),JSON.stringify(findings,null,2));
console.log(JSON.stringify({turnBudget:findings.turnBudget,versionProjection:{oldId:findings.versionProjection.oldId,newId:findings.versionProjection.newId,preview:findings.versionProjection.preview.rendered??findings.versionProjection.preview},importSameName:findings.importSameName,evidence:join(tmpdir(),'dsh-next-review-repro.json')},null,2));
