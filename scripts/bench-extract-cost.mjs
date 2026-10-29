#!/usr/bin/env node
/** D2-R2: actual distill + persisted store, source-grounded rubric. Default is offline. */
import assert from "node:assert/strict";
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {createModelLedger} from "./model-ledger.mjs";
import {scoreExtraction} from "./extraction-rubric.mjs";
const args=new Map(process.argv.slice(2).map(s=>{const i=s.indexOf("=");return i<0?[s,true]:[s.slice(0,i),s.slice(i+1)];}));
const RUN=args.has("--run"),MODEL=String(args.get("--model")||"deepseek-flash"),BUDGET=Number(args.get("--budget")||2);
assert.ok(BUDGET>0&&BUDGET<=2);
const out=resolve(String(args.get("--out")||`.tmp/c4/extract-r2-${RUN?"online":"audit"}.json`));
assert.equal(existsSync(out),false,"Never overwrite evidence");mkdirSync(dirname(out),{recursive:true});
if(RUN)assert.ok(process.env.DEEPSEEK_API_KEY,"Missing model credential");
const root=mkdtempSync(join(tmpdir(),"extract-r2-"));process.env.DSH_HOME=join(root,"home");process.env.DSH_TRIVIUM_SETTINGS=join(root,"settings.json");
const extract=await import("../lib/extract.js"),store=await import("../lib/store.js");
const SESSIONS = [
  { id: "s1", facts: ["技术视频首选标签为 DEMO-71。", "发布前必须执行 CHECK-71 校验。", "本工作区通道为 A-71。"], codes: ["DEMO-71", "CHECK-71", "A-71"] },
  { id: "s2", facts: ["订单号前缀固定为 ORD-42。", "退款必须走 RMA-42 流程。", "客服邮箱是 help42@example.com。"], codes: ["ORD-42", "RMA-42", "help42@example.com"] },
  { id: "s3", facts: ["默认超时设为 45 秒。", "重试次数上限为 3 次。", "降级开关名为 SAFE-45。"], codes: ["45", "3", "SAFE-45"] },
];

/** Same five-user-turn shape as D1, so the extraction prompt sees a realistic transcript. */
const transcriptOf = (s) => [
  { role: "user", text: `先记三条约定：${s.facts.join(" ")} 收到回 ok 即可。`, turn: 0 },
  { role: "assistant", text: "ok", turn: 0 },
  { role: "user", text: "先别管这些，把今天的进度用一句话整理一下。", turn: 1 },
  { role: "assistant", text: "今天推进了约定确认与进度整理。", turn: 1 },
  { role: "user", text: "继续推进第 1 项，回一句当前状态即可。", turn: 2 },
  { role: "assistant", text: "第 1 项进行中。", turn: 2 },
  { role: "user", text: "继续推进第 2 项，回一句当前状态即可。", turn: 3 },
  { role: "assistant", text: "第 2 项进行中。", turn: 3 },
  { role: "user", text: "继续推进第 3 项，回一句当前状态即可。", turn: 4 },
  { role: "assistant", text: "第 3 项进行中。", turn: 4 },
];

const report={protocol:"D2-R2",mode:RUN?"paid":"offline-rules-only",model:MODEL,budgetCny:BUDGET,calls:[],rows:[],status:"running",estimatedCny:0,reservedOrChargedCny:0};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+"\n","utf8");
const request=createModelLedger({report,save,budget:BUDGET,model:MODEL});
try {
  for(const s of SESSIONS) for(const strategy of ["perTurn","batch","rules"]){
    const cwd=join(root,strategy,s.id),db=await store.openWorkspaceDb(cwd),turns=transcriptOf(s);
    const windows=strategy==="perTurn"?turns.filter(t=>t.role==="user").map(t=>turns.filter(x=>x.turn===t.turn)):[turns];
    const row={session:s.id,strategy,source:turns,goldFacts:s.facts,windows:[]};
    report.rows.push(row); save();
    for(const [i,window] of windows.entries()){
      const result={input:window};
      const llmCall=RUN&&strategy!=="rules"?async prompt=>{
        const r=await request({model:MODEL,messages:[{role:"user",content:prompt}],temperature:0,max_tokens:400,thinking:{type:"disabled"},stream:false},`${strategy}/${s.id}/w${i}`);
        result.rawResponse=r.message.content||"";
        result.parsedCandidates=extract.parseModelJson(result.rawResponse);
        result.filteredCandidates=extract.filterCandidates(result.parsedCandidates,{});
        return result.rawResponse;
      }:undefined;
      result.distill=await extract.distill({db,turns:window,sessionId:`${strategy}/${s.id}`,llmCall});
      row.windows.push(result); save();
      // distill catches LLM errors for production durability; a benchmark must stop.
      if(result.distill.llmFailed || report.status==="stopped")throw Error("Extraction failed; stop experiment, preserve reserved charge");
    }
    row.persisted=store.exportGraph(db,cwd);
    row.grade=scoreExtraction(row.persisted.nodes.map(n=>n.payload).filter(p=>p.type!=="workspace"),s.facts);
    save();store.closeAll();
    console.log(`${strategy}/${s.id}: matched=${row.grade.matched.length}/${s.facts.length}, unsupported=${row.grade.unsupported.length}, mode=${report.mode}`);
  }
  report.status=RUN?"complete":"audit-complete";save();
}catch(err){report.status="stopped";report.error=err.message;save();throw err;}
finally{store.closeAll();rmSync(root,{recursive:true,force:true});}
