/** F-W05: long-lived owners, killed recovery process, concurrent stale reclaim. */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "trivium-p58-"));
const ws = join(root, "workspace");
const locks = await import("../lib/workspace-lock.js");
const file = locks.lockPath(ws);
const worker = join(root, "worker.mjs");
writeFileSync(worker, `
const locks=await import(${JSON.stringify(pathToFileURL(resolve("lib/workspace-lock.js")).href)});
const [cwd, mode]=process.argv.slice(2);
if(mode==='recovery-owner') {
  const fs=await import('node:fs');
  fs.writeFileSync(locks.lockPath(cwd)+'.recovery', JSON.stringify({pid:process.pid,nonce:'recovery-owner'}));
  process.send('ready');
  setInterval(()=>{},1000);
} else {
  const result=await locks.withWorkspaceLock(cwd, async()=>{await new Promise(r=>setTimeout(r,1000)); return true;});
  console.log('RESULT '+JSON.stringify({locked:result.locked}));
}
`);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`ok ${label}`); };
const old = new Date(Date.now() - locks.LOCK_TTL_MS - 5000);
let holder;
function startClaim() {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [worker, ws, "claim"], {stdio:["ignore","pipe","pipe"]});
    let out="", err="";
    child.stdout.on("data", (s) => { out += s; });
    child.stderr.on("data", (s) => { err += s; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `worker exit ${code}`));
      const line = out.split(/\r?\n/).find((s) => s.startsWith("RESULT "));
      if (!line) return reject(new Error("missing worker result"));
      done(JSON.parse(line.slice(7)));
    });
  });
}
try {
  const own = locks.acquireWorkspaceLock(ws);
  assert.equal(own.ok, true);
  utimesSync(file, old, old);
  const active = locks.acquireWorkspaceLock(ws);
  check(active.ok === false && active.reason === "busy", "an operation longer than the TTL keeps its live owner's lock");
  own.release();

  writeFileSync(file, JSON.stringify({pid:2147483647,nonce:"dead"}));
  utimesSync(file, old, old);
  holder = fork(worker, [ws, "recovery-owner"], {stdio:["ignore","ignore","pipe","ipc"]});
  await new Promise((done, reject) => { holder.once("message", done); holder.once("error", reject); });
  utimesSync(file + ".recovery", old, old);
  check(locks.acquireWorkspaceLock(ws).ok === false, "a live recovery owner is not displaced even after TTL");
  holder.kill();
  await new Promise((done) => holder.once("exit", done));
  holder = null;
  const recovered = locks.acquireWorkspaceLock(ws);
  check(recovered.ok, "a killed recovery owner and dead operation owner can be reclaimed");
  recovered.release();

  writeFileSync(file, JSON.stringify({pid:2147483647,nonce:"dead-again"}));
  utimesSync(file, old, old);
  const claims = await Promise.all(Array.from({length:6}, startClaim));
  check(claims.filter((x) => !x.locked).length === 1, "six concurrent processes produce one stale-lock winner");
  check(claims.filter((x) => x.locked).length === 5, "other reclaimers fail closed without opening a database");
  const later = locks.acquireWorkspaceLock(ws);
  check(later.ok, "a later operation succeeds after the winner releases");
  later.release();
  console.log(`P58: ${checks}/${checks}`);
} finally {
  if (holder) holder.kill();
  const target = resolve(root);
  const rel = relative(resolve(tmpdir()), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("refusing cleanup outside temp directory");
  rmSync(target, {recursive:true, force:true});
}

// smoke-p59 — retained checks
{
  /** Actual host event -> extraction -> audit -> pending consumption, no model. */
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync , writeFileSync} = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");

  const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p59-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ supersedeMode: "auto" }), "utf8");
  const cwd = join(root, "workspace");
  const store = await import("../lib/store.js");
  const { loadPending } = await import("../lib/extract.js");
  const { readChanges } = await import("../lib/change-log.js");
  const plugin = await import("../lib/index.js");
  const handlers = new Map();
  const warnings = [];
  const ctx = {
    logger: () => ({ warn: (msg) => warnings.push(String(msg)), info() {}, error() {}, debug() {} }),
    inject(_deps, fn) { fn(ctx); },
    on(event, fn) { handlers.set(event, fn); return () => {}; },
    effect(fn) { fn(); return () => {}; },
    tools: { register: () => () => {} },
  };

  try {
    plugin.apply(ctx, {});
    const onEvent = handlers.get("session/event");
    assert.equal(typeof onEvent, "function");
    const session = { id: "p59", header: { cwd } };
    onEvent(session, { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "记住，以后发布前必须先人工确认。" }], turn: 1 } });
    onEvent(session, { type: "compaction/end", seq: 2, data: {} });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !warnings.some((w) => w.includes("extract skipped"))) {
      if (readChanges(cwd).entries.some((row) => row.reason === "written") && !loadPending(cwd)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(!warnings.some((w) => w.includes("extract skipped")), `extraction must finish: ${warnings.join("; ")}`);
    const rows = readChanges(cwd).entries;
    assert.ok(rows.some((row) => row.reason === "written" && row.preview.includes("人工确认")), "a committed fact has a visible audit row");
    assert.equal(loadPending(cwd), null, "successful extraction consumes the pending window");
    const db = await store.openWorkspaceDb(cwd);
    assert.ok(store.searchNodes(db, "人工确认").length > 0, "the audited fact is persisted and searchable");
    console.log("P59: event extraction, audit and pending consumption passed");
  } finally {
    store.closeAll();
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
  }
}
