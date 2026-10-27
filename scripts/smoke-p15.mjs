/** Issue #3: explicit expiry, searchable history, and native/lexical recall.
 * Uses a real native engine and isolated settings; no network or performance test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { distill, ruleCandidates } from "../lib/extract.js";
import { parseWorkbuddyMarkdown } from "../lib/markdown.js";
import { addChipsFromText, setSessionPins } from "../lib/pins.js";
import { zeroVector, EDGE_LABELS } from "../lib/schema.js";
import { isStalePayload } from "../lib/until.js";
import {
  openWorkspaceDb, closeAll, insertNode, updateNode, mergeInto, mergeNodes,
  searchNodes, namedRecallHits, formatHit, listNodes, buildShortMapReport,
  exportGraph, importGraph,
} from "../lib/store.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p15-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const now = new Date("2026-10-27T12:00:00Z");
let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}
const found = (db, id, query, options = {}) => searchNodes(db, query, { topK: 20, now, ...options }).some(h => h.id === id);

try {
  const db = await openWorkspaceDb(join(root, "workspace"));
  const history = "2025-01-01 复盘后决定，服务接口统一采用会话凭据。";
  const id = insertNode(db, { type: "decision", name: "认证方式", text: history });
  check(!db.get(id).payload.until && !db.get(id).payload.untilAt, "a historical ISO date does not set expiry");
  check(found(db, id, "认证方式"), "the historical-date decision is searchable by name");
  for (const date of ["下周", "周五", "11月09日"]) {
    const node = insertNode(db, { type: "decision", text: `已核实对方在${date}上线，我们决定保留兼容接口。` });
    check(!db.get(node).payload.untilAt && !db.get(node).payload.until, `${date} is an event date, not an expiry`);
  }
  const rules = ruleCandidates([{role:"user",text:"采用方案 A，2025-01-01 已核实旧版本行为。"}]).filter(x => x.type === "decision");
  check(rules.length > 0 && rules.every(x => !x.until), "rule extraction does not infer expiry");
  const markdown = parseWorkbuddyMarkdown("# 项目约定\n- 采用方案 A，2025-01-01 已核实旧版本行为。");
  check(markdown.candidates.some(x => x.type === "decision") && markdown.candidates.every(x => !x.until), "Markdown import does not infer expiry");
  const chip = addChipsFromText(db, "采用方案 A，2025-01-01 已核实旧版本行为。", { sessionId: "issue3" });
  check(chip.ok, "chip with a historical date is accepted");
  check(chip.ids.some(id => db.get(id).payload.type === "decision") && chip.ids.every(id => !db.get(id).payload.until), "chip writes do not infer expiry");
  await distill({ db, turns:[{role:"user",text:"采用只读缓存，2025-01-01 核实过。"}], llmCall: async () => JSON.stringify({candidates:[{type:"decision",name:"缓存期限回归",text:"采用只读缓存，2025-01-01 核实过。",until:"2025-01-01"}]}) });
  const modelRows = listNodes(db, {includeStale:true}).filter(x => /只读缓存/.test(x.text));
  check(modelRows.length > 0 && modelRows.every(x => !x.until), "model output cannot assign inferred expiry");

  // Simulate an old, contaminated payload without mutating any user's data.
  updateNode(db, id, { until: "2025-01-01" });
  check(isStalePayload(db.get(id).payload, now), "explicit past expiry is recognized");
  const past = searchNodes(db, "认证方式", {now}).find(h => h.id === id);
  check(past && formatHit(db,past).stale, "legacy expiry stays searchable and marked stale");
  check(!found(db,id,"认证方式",{includeStale:false}), "current-only search excludes stale history");
  check(!listNodes(db).some(x => x.id === id) && listNodes(db,{includeStale:true}).some(x => x.id === id), "existing settings expiry toggle still reveals the node");
  updateNode(db,id,{until:""});
  updateNode(db,id,{text:history + " 今后继续使用。"});
  check(!db.get(id).payload.until && !db.get(id).payload.untilAt, "cleared expiry stays cleared after editing dated prose");
  updateNode(db,id,{until:"2025-01-01"});
  updateNode(db,id,{until:"未确定"});
  check(db.get(id).payload.until === "未确定" && !db.get(id).payload.untilAt, "an unresolved label cannot keep the old expiry timestamp");
  updateNode(db,id,{until:"下周"});
  check(Date.parse(db.get(id).payload.untilAt) > Date.now(), "a newly edited relative expiry is anchored to the edit");
  const relativeAt = db.get(id).payload.untilAt;
  updateNode(db,id,{text:history,until:"下周"});
  check(db.get(id).payload.untilAt === relativeAt, "saving an unchanged label does not extend expiry");
  mergeInto(db,id,{text:history,until:undefined});
  check(db.get(id).payload.untilAt === relativeAt, "automatic merge without expiry preserves the explicit deadline");
  mergeInto(db,id,{until:"2024-01-01"});
  check(db.get(id).payload.untilAt === "2024-01-01T23:59:59.000Z", "merge changes the label and instant together");
  mergeInto(db,id,{until:""});
  check(!db.get(id).payload.untilAt && !db.get(id).payload.until, "merge can explicitly clear expiry");

  const entity = insertNode(db,{type:"entity",name:"缓存",text:"缓存组件"});
  const expired = insertNode(db,{type:"decision",name:"缓存旧策略",text:"旧策略仅作为历史记录。",until:"2020-01-01"});
  const live = insertNode(db,{type:"decision",name:"缓存新策略",text:"当前采用只读缓存。"});
  db.link(expired,entity,EDGE_LABELS.decided,1);
  db.link(live,entity,EDGE_LABELS.decided,1);
  const both = searchNodes(db,"缓存有哪些约定",{now,topK:20});
  check(both.some(x=>x.id===entity) && both.some(x=>x.id===live), "two-Han-character entities anchor natural-language queries");
  check(both.some(x=>x.id===expired), "entity search can retrieve connected historical decisions");
  check(both.findIndex(x=>x.id===live) < both.findIndex(x=>x.id===expired), "live decisions rank ahead of stale decisions");
  const path = formatHit(db,both.find(x=>x.id===entity)).path.join("|");
  check(path.includes(`<-decided-${expired}`), "explicit search explains the historical relation");
  const activeEntity = searchNodes(db,"缓存",{now,includeStale:false}).find(x=>x.id===entity);
  check(!formatHit(db,activeEntity).path.some(p=>p.includes(`<-decided-${expired}`)), "current-only paths do not leak expired decisions");
  check(!namedRecallHits(db,"缓存 周五",{now}).some(x=>x.id===expired), "automatic anchor recall excludes expired decisions even for date queries");
  check(!buildShortMapReport(db,400).text.includes("缓存旧策略"), "the automatic short map excludes expired decisions");
  check(setSessionPins(db,"history-pin",[expired]).text.includes("stale until=2020-01-01"), "an explicitly pinned historical decision is labeled stale");

  const pref = insertNode(db,{type:"preference",name:"上线规范",text:"发布前先检查测试结果，再执行上线流程。",aliases:["上线前核对"]});
  const native = db.searchHybrid(zeroVector(),"发布前 检查",16,0,0.01,0.2);
  check(native.some(x=>x.id===pref), "the native text channel recalls the multiword query");
  check(found(db,pref,"发布前 检查"), "the plugin keeps the native multiword candidate");
  check(found(db,pref,"上线前核对"), "aliases are searchable for non-entity memories");
  const english = insertNode(db,{type:"experience",name:"deploy checklist",text:"Run deployment checks before release."});
  const fallback = new Proxy(db,{get(target,key){ if(key === "searchHybrid") return () => {throw new Error("simulate unavailable text index")}; const v=target[key];return typeof v==="function" ? v.bind(target) : v; }});
  check(found(fallback,pref,"发布前 检查"), "Chinese multiword fallback works when native retrieval fails");
  check(found(fallback,english,"deployment release"), "Latin word fallback works without a contiguous phrase");
  check(!found(fallback,english,"unrelated unicorn"), "fallback rejects unrelated words");
  const vec = zeroVector(); vec[0]=1;
  db.updateVector(pref,vec);
  const query = "deployment preflight";
  check(db.searchHybrid(vec,query,16,0,0.01,0.2).some(x=>x.id===pref), "native vector candidate exists without lexical overlap");
  check(found(db,pref,query,{queryVector:vec}), "the plugin retains a vector-only candidate");
  const archived = insertNode(db,{type:"preference",text:"deployment preflight archived fact",status:"archived"});
  const dirty = insertNode(db,{type:"preference",text:"api_key=sk-fake123test"});
  db.updateVector(archived,vec); db.updateVector(dirty,vec);
  const safe = searchNodes(db,query,{now,queryVector:vec,topK:20});
  check(!safe.some(x=>x.id===archived || x.id===dirty), "native recall does not bypass archive or write-hygiene filters");
  const header = insertNode(db,{type:"preference",text:"鉴权走 header X。"});
  insertNode(db,{type:"entity",name:"X-Request-Id",text:"X-Request-Id"});
  check(!found(db,header,"X-Request-Id"), "identifier search does not accept a partial X token");
  const renamed = insertNode(db,{type:"entity",name:"OrionLaunchCode",text:"OrionLaunchCode"});
  updateNode(db,renamed,{name:"VegaLandingCode",text:"VegaLandingCode"});
  check(!found(db,renamed,"OrionLaunchCode"), "obsolete native keywords cannot revive a removed name");
  check(found(db,renamed,"VegaLandingCode"), "the replacement name remains searchable");

  const target = await openWorkspaceDb(join(root,"import"));
  check(importGraph(target,exportGraph(db)).ok, "explicit deadlines round-trip through JSON export/import");
  const importedPast = listNodes(target,{includeStale:true}).find(x=>x.name==="缓存旧策略");
  check(importedPast?.stale && importedPast.until==="2020-01-01", "import preserves explicit historical expiry");
  const importedClear = listNodes(target,{includeStale:true}).find(x=>x.name==="认证方式");
  updateNode(target,importedClear.id,{until:"2024-01-01"});
  importGraph(target,exportGraph(db));
  check(!target.get(importedClear.id).payload.untilAt && !target.get(importedClear.id).payload.until, "re-importing a cleared deadline clears the existing destination deadline");
  const keep = insertNode(db,{type:"decision",name:"待确认期限",text:"采用方案 MergeExpiry。",until:"未确定"});
  const drop = insertNode(db,{type:"decision",name:"已过期期限",text:"采用方案 MergeExpiry。",until:"2020-01-01"});
  check(mergeNodes(db,keep,drop).ok && !db.get(keep).payload.untilAt, "merging nodes never combines one label with another node's timestamp");
  closeAll();
  const reopened = await openWorkspaceDb(join(root,"workspace"));
  check(!reopened.get(id).payload.untilAt && !reopened.get(id).payload.until, "cleared expiry survives reopening");
  check(found(reopened,pref,"发布前 检查"), "multiword recall survives reopening");
  check(found(reopened,expired,"缓存旧策略"), "legacy historical memory remains discoverable after reopening");
  console.log(`P15 issue #3 regressions passed (${checks} checks)`);
} finally {
  closeAll();
  rmSync(root,{recursive:true,force:true});
}
