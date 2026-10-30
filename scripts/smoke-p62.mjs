/** Overlapping sessions keep pending windows across failure and a real restart. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode === "writer") {
  const { savePending } = await import("../lib/extract.js");
  const workspace = process.argv[3], marker = process.argv[4];
  for (let i = 0; i < 20; i++) {
    await savePending(workspace, { sessionId: "shared", turns: [{ role: "user", messageId: `${marker}-${i}`, text: `${marker} ${i}` }] });
  }
  process.exit(0);
}
if (mode === "writer-seq") {
  const { savePending } = await import("../lib/extract.js");
  const workspace = process.argv[3], seq = Number(process.argv[4]);
  await savePending(workspace, { sessionId:"ordered", turns:[{role:"user",seq,recorded:true,messageId:`m-${seq}`,text:`event ${seq}`}] });
  process.exit(0);
}
if (mode === "recover") {
  const workspace = process.argv[3], unknownWorkspace = process.argv[4];
  const extract = await import("../lib/extract.js");
  const store = await import("../lib/store.js");
  const { apply } = await import("../lib/index.js");
  const handlers = new Map();
  const ctx = { logger: () => ({warn(){},info(){},error(){},debug(){}}), inject(_d,fn){fn(ctx)}, on(name,fn){handlers.set(name,fn)}, effect(fn){fn()}, tools:{register(){}} };
  apply(ctx, {});
  const start = handlers.get("agent/created");
  const agent = (id) => ({ session: { id, header: { cwd: workspace } }, inject() {} });
  assert.equal(extract.loadPendingWindows(workspace).length, 2);
  await start({ agent: agent("restart-a") });
  assert.equal(extract.loadPendingWindows(workspace).length, 0);
  await start({ agent: agent("restart-b") });
  assert.equal(extract.loadPendingWindows(workspace).length, 0);
  const db = await store.openWorkspaceDb(workspace);
  assert.ok(store.searchNodes(db, "人工确认").length > 0);
  assert.ok(store.searchNodes(db, "人工核对").length > 0);
  const payloads = db.allNodeIds().map((id) => db.get(id)?.payload).filter(Boolean);
  assert.equal(payloads.find((row) => String(row.text || "").includes("人工确认"))?.source?.sessionId, "old-a");
  assert.equal(payloads.find((row) => String(row.text || "").includes("人工核对"))?.source?.sessionId, "session-b");
  const unknownAgent = { session: { id:"restart-unknown", header:{cwd:unknownWorkspace} }, inject(){} };
  await start({ agent: unknownAgent });
  const unknownDb = await store.openWorkspaceDb(unknownWorkspace);
  const unknownRows = unknownDb.allNodeIds().map((id) => unknownDb.get(id)?.payload).filter(Boolean);
  assert.equal(unknownRows.find((row) => String(row.text || "").includes("人工复核"))?.source?.sessionId, "");
  store.closeAll();
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "trivium-p62-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const extract = await import("../lib/extract.js");
const store = await import("../lib/store.js");
const { apply } = await import("../lib/index.js");
const { acquireWorkspaceLock } = await import("../lib/workspace-lock.js");
const cwd = join(root, "workspace");
const handlers = new Map();
let httpHandler, release, calls = 0;
const gate = new Promise((done) => { release = done; });
const heartbeat = setInterval(() => {}, 1000);
const ctx = {
  llm: { async *stream() { calls++; await gate; throw new Error("controlled failure"); } },
  logger: () => ({warn(){},info(){},error(){},debug(){}}), inject(_d,fn){fn(ctx)},
  on(name,fn){handlers.set(name,fn)}, effect(fn){fn()}, tools:{register(){}},
  webServer: { register(def) { httpHandler = def.handler; } },
};
apply(ctx, {});
const agent = (id, workspace = cwd) => ({ session: { id, header: { cwd: workspace }, requestHeader: () => ({config:{provider:"stub",model:"stub"}}) }, inject() {} });
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log(`ok ${label}`); }
async function status(workspace) {
  let body = "", code;
  await httpHandler({ method:"GET", url:"/api/dsh-trivium/status?cwd="+encodeURIComponent(workspace), headers:{}, socket:{remoteAddress:"127.0.0.1"} }, {writeHead(value){code=value},end(data){body=String(data)}});
  assert.equal(code, 200);
  return JSON.parse(body);
}
function worker(workspace, marker) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer", workspace, marker], { stdio:["ignore","ignore","pipe"], env:process.env });
    let error = ""; child.stderr.on("data", (part) => { error += part; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? done() : reject(new Error(`writer ${code}: ${error}`)));
  });
}
function orderedWorker(workspace, seq) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer-seq", workspace, String(seq)], {stdio:["ignore","ignore","pipe"],env:process.env});
    let error = ""; child.stderr.on("data", (part) => { error += part; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? done() : reject(new Error(`writer ${code}: ${error}`)));
  });
}

try {
  const legacy = join(root, "legacy"), legacyFile = extract.pendingPath(legacy);
  mkdirSync(dirname(legacyFile), { recursive: true });
  const old = { sessionId:"old", turns:[{role:"user",text:"旧事实"}] };
  writeFileSync(legacyFile, JSON.stringify(old), "utf8");
  await extract.savePending(legacy, {sessionId:"new",turns:[{role:"user",text:"新事实"}]});
  check(extract.loadPendingWindows(legacy).length === 2 && extract.loadPending(legacy).turns[0].text === "旧事实", "legacy single-window data migrates without losing its first entry");

  const shared = join(root, "shared");
  await Promise.all([worker(shared,"one"),worker(shared,"two")]);
  const saved = extract.loadPendingWindows(shared);
  check(saved.length === 1 && saved[0].turns.length === 40 && new Set(saved[0].turns.map((turn) => turn.messageId)).size === 40, "two processes merge unique turns for the same session");
  const ordered = join(root,"ordered");
  await orderedWorker(ordered,2);
  await orderedWorker(ordered,1);
  check(extract.loadPending(ordered).turns.map((turn)=>turn.seq).join(",") === "1,2", "recorded host sequences are ordered even when processes write them backwards");
  const unknownOrder = join(root,"unknown-order");
  await extract.savePending(unknownOrder,{sessionId:"mixed",turns:[{role:"user",seq:2,recorded:true,text:"second"},{role:"user",text:"unknown"},{role:"user",seq:1,recorded:true,text:"first"}]});
  check(extract.loadPending(unknownOrder).turns.map((turn)=>turn.text).join(",") === "second,unknown,first", "unknown-locator turns remain barriers to inferred ordering");
  await extract.settlePending(shared, "shared", saved[0].turns.slice(0, 20), [], null);
  check(extract.loadPendingWindows(shared)[0].turns.length === 20, "success removes only the consumed turns of the shared session");
  await worker(shared, "one");
  check(extract.loadPendingWindows(shared)[0].turns.length === 20, "stale saves from another process cannot resurrect acknowledged event IDs");

  const queued = join(root, "queued"), queuedTurn = {role:"user",messageId:"queued-one",text:"first"};
  await extract.savePending(queued,{sessionId:"queued",turns:[queuedTurn]});
  const pendingLock = acquireWorkspaceLock(queued, {file:`${extract.pendingPath(queued)}.lock`});
  assert.ok(pendingLock.ok);
  const olderSave = extract.savePending(queued,{sessionId:"queued",turns:[queuedTurn]});
  const laterSettle = extract.settlePending(queued,"queued",[queuedTurn],[],null);
  await new Promise((done)=>setTimeout(done,80)); pendingLock.release();
  await Promise.all([olderSave,laterSettle]);
  check(extract.loadPending(queued) === null, "a blocked older save cannot run after a newer settlement in this process");
  const changedTurn = {...queuedTurn, text:"changed content with the same locator"};
  await extract.savePending(queued,{sessionId:"queued",turns:[changedTurn]});
  check(extract.loadPending(queued)?.turns[0]?.text === changedTurn.text, "changed content is not dropped when a locator is reused");

  const bad = join(root, "bad"), badFile = extract.pendingPath(bad), damaged = "{broken";
  mkdirSync(dirname(badFile), { recursive:true }); writeFileSync(badFile, damaged, "utf8");
  await assert.rejects(() => extract.savePending(bad, {sessionId:"new",turns:[{role:"user",text:"x"}]}));
  check(readFileSync(badFile,"utf8") === damaged, "a corrupt pending file is preserved instead of overwritten");
  await store.openWorkspaceDb(bad);
  await handlers.get("agent/created")({agent:agent("bad-session",bad)});
  const badStatus = await status(bad);
  check(badStatus.recovery?.state === "failed" && badStatus.pendingPersistence.incomplete, "unreadable pending data is visible to the workspace status");
  check(readFileSync(badFile,"utf8") === damaged, "failed startup leaves corrupt pending bytes intact");
  for (const [label, value] of [["windows", {windows:"invalid",turns:[]}],["acknowledged", {turns:[],acknowledged:[17]}]]) {
    const workspace = join(root, `bad-${label}`), file = extract.pendingPath(workspace), raw = JSON.stringify(value);
    mkdirSync(dirname(file), {recursive:true}); writeFileSync(file,raw,"utf8");
    await assert.rejects(() => extract.savePending(workspace,{sessionId:"new",turns:[{role:"user",text:"x"}]}));
    check(readFileSync(file,"utf8") === raw, `invalid ${label} metadata is not overwritten`);
  }

  const localEvents = join(root,"unlocated-events"), localSession = agent("unlocated",localEvents).session;
  const localEvent = handlers.get("session/event");
  for (let i=0;i<2;i++) localEvent(localSession,{type:"user/message",data:{source:{kind:"user"},content:[{type:"text",text:"相同内容"}],turn:1}});
  localEvent(localSession,{type:"turn/end",data:{}});
  const localDeadline = Date.now()+3000;
  while (!extract.loadPending(localEvents) && Date.now()<localDeadline) await new Promise((done)=>setTimeout(done,10));
  const localTurns = extract.loadPending(localEvents)?.turns || [];
  check(localTurns.length === 2 && localTurns[0].pendingEventId !== localTurns[1].pendingEventId && localTurns.every((turn)=>!turn.messageId && turn.seq == null), "distinct unlocated events get local identities without fabricated host locators");

  const reused = join(root,"reused-locator"), reusedSession = agent("reused",reused).session;
  const reusedEvent = (text) => ({type:"user/message",seq:12,data:{id:"same-message",source:{kind:"user"},content:[{type:"text",text}],turn:1}});
  localEvent(reusedSession,reusedEvent("first version"));
  localEvent(reusedSession,reusedEvent("updated version"));
  localEvent(reusedSession,reusedEvent("updated version"));
  localEvent(reusedSession,{type:"turn/end",data:{}});
  const reusedDeadline = Date.now()+3000;
  while (!extract.loadPending(reused) && Date.now()<reusedDeadline) await new Promise((done)=>setTimeout(done,10));
  check(extract.loadPending(reused)?.turns.map((turn)=>turn.text).join("|") === "first version|updated version", "real buffered events retain changed text for a reused locator and deduplicate an exact retry");

  const delayed = join(root, "delayed");
  await store.openWorkspaceDb(delayed);
  const held = acquireWorkspaceLock(delayed,{file:`${extract.pendingPath(delayed)}.lock`});
  assert.ok(held.ok);
  const delayedSession = agent("delayed-session",delayed).session;
  const delayedEvent = handlers.get("session/event");
  delayedEvent(delayedSession,{type:"user/message",seq:1,data:{source:{kind:"user"},content:[{type:"text",text:"记住，以后改动前必须人工复核。"}],turn:1}});
  delayedEvent(delayedSession,{type:"turn/end",seq:2,data:{}});
  const warningDeadline = Date.now()+4000;
  while (!(await status(delayed)).pendingPersistence.incomplete && Date.now()<warningDeadline) await new Promise((done)=>setTimeout(done,20));
  check((await status(delayed)).pendingPersistence.incomplete, "prolonged pending-lock contention is visible to the user");
  held.release();
  const retryDeadline = Date.now()+7000;
  while (!extract.loadPending(delayed) && Date.now()<retryDeadline) await new Promise((done)=>setTimeout(done,30));
  check(extract.loadPending(delayed)?.turns[0]?.text.includes("人工复核"), "the failed turn-end persistence retries after the lock is released");

  await extract.savePending(cwd, {sessionId:"old-a",turns:[{role:"user",messageId:"a",text:"记住，以后发布前必须先人工确认。"}]});
  const start = handlers.get("agent/created");
  const first = start({agent:agent("replayer")});
  const deadline = Date.now()+3000;
  while (!calls && Date.now()<deadline) await new Promise((done)=>setTimeout(done,10));
  check(calls === 1, "first recovery begins with a blocked controlled model");
  await first;
  check((await status(cwd)).recovery.state === "running-timed-out", "replay continues after its startup timeout");
  const b = agent("session-b");
  await start({agent:b});
  const onEvent = handlers.get("session/event");
  onEvent(b.session, {type:"user/message",seq:1,data:{source:{kind:"user"},content:[{type:"text",text:"记住，以后部署之前必须人工核对。"}],turn:1}});
  onEvent(b.session, {type:"turn/end",seq:2,data:{}});
  const saveDeadline = Date.now()+3000;
  while (extract.loadPendingWindows(cwd).length < 2 && Date.now()<saveDeadline) await new Promise((done)=>setTimeout(done,10));
  check(extract.loadPendingWindows(cwd).length === 2, "new session turn/end appends a second durable pending window");
  release();
  const failDeadline = Date.now()+3000;
  while ((await status(cwd)).recovery.state !== "failed" && Date.now()<failDeadline) await new Promise((done)=>setTimeout(done,10));
  const remaining = extract.loadPendingWindows(cwd);
  check(remaining.length === 2 && remaining.some((row)=>row.turns.some((turn)=>turn.text.includes("人工确认"))) && remaining.some((row)=>row.turns.some((turn)=>turn.text.includes("人工核对"))), "failed recovery and new session both retain their original facts");
  store.closeAll();
  const unknown = join(root,"unknown-source"), unknownFile = extract.pendingPath(unknown);
  mkdirSync(dirname(unknownFile),{recursive:true});
  writeFileSync(unknownFile,JSON.stringify({turns:[{role:"user",text:"记住，以后发布前必须人工复核。"}]}),"utf8");
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "recover", cwd, unknown], {env:process.env,encoding:"utf8"});
  check(child.status === 0, "fresh process restores both queued windows and can find both facts");
  console.log(`P62: ${checks}/${checks}`);
} finally {
  clearInterval(heartbeat); release(); store.closeAll();
  const rel = relative(resolve(tmpdir()),resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root,{recursive:true,force:true});
}
