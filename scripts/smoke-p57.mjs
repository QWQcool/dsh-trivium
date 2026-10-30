/** F-W05: real processes, real tools and real loopback import routes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "trivium-p57-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const store = await import("../lib/store.js");
const { acquireWorkspaceLock } = await import("../lib/workspace-lock.js");
const ws = join(root, "workspace");
const worker = join(root, "worker.mjs");
const url = (name) => pathToFileURL(resolve("lib", name)).href;
writeFileSync(worker, `
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
const [cwd, from, to, expectedHome] = process.argv.slice(2);
if (process.platform === 'win32' && resolve(os.homedir()) !== resolve(expectedHome)) throw new Error('child home is not isolated');
// Stub the builtin before loading application modules: this does not alter the
// user's HOME environment variable and keeps discovery in the temporary root.
os.homedir = () => expectedHome;
let discoveryChecks = 0;
for (const method of ['existsSync', 'statSync', 'readFileSync']) {
  const original = fs[method];
  fs[method] = function (...args) {
    const path = args[0];
    if (typeof path === 'string') {
      const parts = resolve(path).split(sep);
      const curated = parts.some((part) => ['.workbuddy', '.claude', '.codex'].includes(part)) || ['CLAUDE.md', 'AGENTS.md'].includes(basename(path));
      if (curated) {
        discoveryChecks++;
        const rel = relative(resolve(expectedHome, '..'), resolve(path));
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('curated path escaped test root');
      }
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
if (resolve(os.homedir()) !== resolve(expectedHome)) throw new Error('homedir stub failed');
const store = await import(${JSON.stringify(url("store.js"))});
const { registerTools } = await import(${JSON.stringify(url("tools.js"))});
const { registerMemoryApi } = await import(${JSON.stringify(url("server.js"))});
const tools = new Map();
registerTools({effect: f => f(), tools: {register(t) {tools.set(t.name, t); return () => {}; }}, on() {}}, {});
const exec = {agent: {session: {header: {cwd, id: 'p57'}}}};
const remember = await tools.get('ctx_remember').execute({type:'preference', text:'A synthetic concurrent write.'}, exec);
const link = await tools.get('ctx_link').execute({from:Number(from), to:Number(to), label:'about'}, exec);
let handler;
registerMemoryApi({webServer:{register(x) {handler=x.handler; return () => {};}}}, {liveOptions:()=>({}), status:{}});
const server = http.createServer((req,res)=>handler(req,res));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const paths=['import','import-workbuddy','import-external'];
const responses=[];
for (const path of paths) {
  const graph={version:2,nodes:[{id:999,payload:{type:'preference',uri:'ctx://p57/imported',text:'Synthetic import fact.'}}],edges:[]};
  const input=path==='import'?{graph}:{ids:[path==='import-workbuddy'?'workspace':'claude-workspace']};
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/dsh-trivium/'+path+'?cwd='+encodeURIComponent(cwd), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  responses.push({status:res.status, body:await res.json()});
}
await new Promise(r=>server.close(r));
store.closeAll();
console.log('RESULT '+JSON.stringify({remember,link,responses,discoveryChecks}));
`, "utf8");
let checks = 0;
function check(ok, label) { assert.ok(ok, label); checks++; console.log(`ok ${label}`); }
function snapshot(db) {
  const { nodes, edges } = store.exportGraph(db);
  return JSON.stringify({ nodes, edges });
}
function run(from, to) {
  const childHome = join(root, "home");
  const env = process.platform === "win32"
    ? { ...process.env, USERPROFILE: childHome }
    : { ...process.env };
  const result = spawnSync(process.execPath, [worker, ws, String(from), String(to), childHome], { encoding: "utf8", timeout: 20000, env });
  assert.equal(result.status, 0, result.stderr || "worker failed");
  const line = result.stdout.split(/\r?\n/).find((s) => s.startsWith("RESULT "));
  assert.ok(line, "worker must return structured result");
  return JSON.parse(line.slice(7));
}
try {
  const db = await store.openWorkspaceDb(ws);
  const from = store.insertNode(db, { type: "preference", text: "Existing fact A.", uri: "ctx://p57/a" });
  const to = store.insertNode(db, { type: "entity", name: "Existing B", text: "Existing fact B.", uri: "ctx://p57/b" });
  const pending = join(ws, ".dsh", "trivium-pending.json");
  writeFileSync(pending, '{"pending":"preserve"}');
  const workbuddy = join(ws, ".workbuddy", "memory", "MEMORY.md");
  const claude = join(ws, "CLAUDE.md");
  const workbuddyText = "# Memory\n- Always use blue umbrellas for the synthetic WorkBuddy fixture.\n";
  const claudeText = "# Memory\n- Always require purple lanterns for the synthetic Claude fixture.\n";
  mkdirSync(join(ws, ".workbuddy", "memory"), { recursive: true });
  writeFileSync(workbuddy, workbuddyText);
  writeFileSync(claude, claudeText);
  const before = snapshot(db);
  const held = acquireWorkspaceLock(ws);
  assert.equal(held.ok, true);
  const busy = run(from, to);
  check(busy.remember.includes("workspace write busy"), "ctx_remember reports busy before opening the engine");
  check(busy.link.includes("workspace write busy"), "ctx_link reports busy before opening the engine");
  check(busy.responses.every((r) => r.status === 409 && r.body.code === "WORKSPACE_WRITE_BUSY"), "all three real HTTP import routes report busy");
  check(snapshot(db) === before, "busy attempts leave the graph unchanged");
  check(readFileSync(pending, "utf8") === '{"pending":"preserve"}', "busy attempts preserve pending data");
  check(readFileSync(workbuddy, "utf8") === workbuddyText && readFileSync(claude, "utf8") === claudeText, "busy imports preserve both source files");
  held.release();

  // The operation guard is free but the first host still owns a cached native
  // handle. The second host must not claim it can take over until this closes.
  const nativeBusy = run(from, to);
  check(nativeBusy.remember.includes("unavailable") && !nativeBusy.remember.startsWith("Remembered"), "cached native writer gives ctx_remember a recoverable error");
  check(nativeBusy.link.includes("unavailable") && !nativeBusy.link.startsWith("Linked"), "cached native writer gives ctx_link a recoverable error");
  check(nativeBusy.responses.every((r) => r.status === 409 && r.body.code === "DB_LOCKED"), "cached native writer gives all HTTP import routes DB_LOCKED");
  check(snapshot(db) === before, "native contention leaves the graph unchanged");
  store.closeAll();

  const recovered = run(from, to);
  check(recovered.remember.startsWith("Remembered id="), "ctx_remember succeeds after the other host closes");
  check(recovered.link.startsWith("Linked "), "ctx_link succeeds after the other host closes");
  check(recovered.responses.every((r) => r.status === 200 && r.body.ok), "all three import endpoints succeed after close");
  check(recovered.discoveryChecks > 0, "curated discovery probes only paths inside the test root");
  check(recovered.responses.slice(1).every((r) => r.body.created > 0), "both selected Markdown imports report new facts");
  const reopened = await store.openWorkspaceDb(ws);
  const graph = store.exportGraph(reopened);
  check(graph.nodes.some((n) => JSON.stringify(n).includes("Synthetic import fact")), "successful import persists its fact");
  check(graph.nodes.some((n) => JSON.stringify(n).includes("blue umbrellas")), "WorkBuddy fact persists after reopen");
  check(graph.nodes.some((n) => JSON.stringify(n).includes("purple lanterns")), "Claude fact persists after reopen");
  check(readFileSync(workbuddy, "utf8") === workbuddyText && readFileSync(claude, "utf8") === claudeText, "successful imports do not modify their source files");
  check(readFileSync(pending, "utf8") === '{"pending":"preserve"}', "successful retries do not consume extraction pending data");
  console.log(`P57: ${checks}/${checks}`);
} finally {
  store.closeAll();
  const target = resolve(root);
  const rel = relative(resolve(tmpdir()), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("refusing cleanup outside temp directory");
  rmSync(target, { recursive: true, force: true });
}
