/** Pending replay status through the registered HTTP handler; controlled model, no network model. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "trivium-p60-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const { savePending, loadPending } = await import("../lib/extract.js");
const { changesPath } = await import("../lib/change-log.js");
const { acquireWorkspaceLock } = await import("../lib/workspace-lock.js");
const store = await import("../lib/store.js");
const { apply } = await import("../lib/index.js");
const handlers = new Map();
let httpHandler, calls = 0, release;
const gate = new Promise((resolveGate) => { release = resolveGate; });
const ctx = {
  llm: { async *stream() { calls++; await gate; throw new Error("controlled failure"); } },
  logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
  inject(_deps, fn) { fn(ctx); },
  on(name, fn) { handlers.set(name, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },
  tools: { register() { return () => {}; } },
  webServer: { register(def) { httpHandler = def.handler; return () => {}; } },
};
apply(ctx, {});
const server = http.createServer((req, res) => httpHandler(req, res));
const cwd = join(root, "workspace"), other = join(root, "other");
const agent = (id, workspace = cwd) => ({ session: { id, header: { cwd: workspace }, requestHeader: () => ({ config: { provider: "stub", model: "stub" } }) }, inject() {} });
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log(`ok ${message}`); }

try {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-trivium/status?cwd=`;
  const status = async (workspace) => {
    const res = await fetch(base + encodeURIComponent(workspace));
    assert.equal(res.status, 200);
    return res.json();
  };
  const state = async (workspace) => (await status(workspace)).recovery;
  mkdirSync(cwd, { recursive: true });
  await store.openWorkspaceDb(cwd);
  await store.openWorkspaceDb(other);
  check(await state(cwd) === null && await state(other) === null, "no observed replay is unknown in each workspace");
  await savePending(cwd, { sessionId: "old-session", turns: [{ role: "user", text: "以后发布前必须先人工确认。", messageId: "one", seq: 1 }] });
  const start = handlers.get("agent/created");
  const first = start({ agent: agent("one") });
  const deadline = Date.now() + 3_000;
  while (!calls && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  check(calls === 1 && (await state(cwd)).state === "running", "running replay is visible while the model is blocked");
  check(await state(other) === null, "recovery status remains scoped to its workspace");
  await first;
  check((await state(cwd)).state === "running-timed-out" && !!loadPending(cwd), "eight-second timeout leaves pending and reports background work");
  await start({ agent: agent("two", `${cwd}${sep}.`) });
  check(calls === 1, "a second session using an equivalent path does not claim the still-running replay");
  release();
  const failureDeadline = Date.now() + 3_000;
  while ((await state(cwd)).state !== "failed" && Date.now() < failureDeadline) await new Promise((done) => setTimeout(done, 10));
  check((await state(cwd)).state === "failed" && !!loadPending(cwd), "background failure becomes visible and preserves pending");
  ctx.llm = null;
  await start({ agent: agent("three") });
  check((await state(cwd)).state === "succeeded" && loadPending(cwd) === null, "later session retries successfully and consumes pending");

  let releaseSuccess;
  const successGate = new Promise((done) => { releaseSuccess = done; });
  ctx.llm = { async *stream() { await successGate; yield { type: "text-delta", index: 0, text: '{"candidates":[]}' }; } };
  await savePending(other, { sessionId: "old-other", turns: [{ role: "user", text: "以后上线前必须先进行确认。", messageId: "other-one", seq: 1 }] });
  const slowSuccess = start({ agent: agent("success-after-timeout", other) });
  await slowSuccess;
  check((await state(other)).state === "running-timed-out" && !!loadPending(other), "another timed-out replay remains running");
  releaseSuccess();
  const successDeadline = Date.now() + 3_000;
  while ((await state(other)).state !== "succeeded" && Date.now() < successDeadline) await new Promise((done) => setTimeout(done, 10));
  check((await state(other)).state === "succeeded" && loadPending(other) === null, "a timed-out replay can finish successfully in the background");

  ctx.llm = null;
  const auditLock = acquireWorkspaceLock(cwd, { file: `${changesPath(cwd)}.lock` });
  check(auditLock.ok, "test acquires the independent audit lock");
  try {
    const s = agent("audit-failure").session;
    const onEvent = handlers.get("session/event");
    onEvent(s, { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "记住，以后部署之前必须人工核对。" }], turn: 1 } });
    onEvent(s, { type: "compaction/end", seq: 2, data: {} });
    const auditDeadline = Date.now() + 3_000;
    while (!(await status(cwd)).audit.incomplete && Date.now() < auditDeadline) await new Promise((done) => setTimeout(done, 10));
    const audit = (await status(cwd)).audit;
    check(audit.incomplete && !!audit.lastErrorAt && !JSON.stringify(audit).includes(root), "audit contention is visible per workspace without local paths");
    check(!(await status(other)).audit.incomplete, "audit failure does not contaminate another workspace");
  } finally { auditLock.release(); }

  store.closeAll();
  const childSource = `
    import { apply } from './lib/index.js';
    import { openWorkspaceDb, closeAll } from './lib/store.js';
    let handler;
    const ctx = { logger: () => ({warn(){},info(){},error(){},debug(){}}), inject(_d,fn){fn(ctx)}, on(){}, effect(fn){fn()}, tools:{register(){}}, webServer:{register(def){handler=def.handler}} };
    apply(ctx, {});
    await openWorkspaceDb(process.argv[1]);
    let output = '';
    await handler({method:'GET',url:'/api/dsh-trivium/status?cwd='+encodeURIComponent(process.argv[1]),headers:{},socket:{remoteAddress:'127.0.0.1'}}, {writeHead(){},end(body){output=String(body)}});
    const data = JSON.parse(output);
    closeAll();
    if (data.recovery !== null || data.audit.incomplete) process.exit(1);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, cwd], { encoding: "utf8", env: process.env });
  check(child.status === 0, "a fresh process does not invent a recovery result or retain live audit state");
  console.log(`P60: ${checks}/${checks}`);
} finally {
  release();
  await new Promise((done) => server.close(done));
  store.closeAll();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
