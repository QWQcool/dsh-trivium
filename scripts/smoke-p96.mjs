/** Issue #5: real HTTP clients borrow the writer; unopened paths stay untouched. */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "dsh-p96-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
process.env.DSH_HOME = join(root, "home");
const store = await import("../lib/store.js");
const { registerMemoryApi } = await import("../lib/server.js");
const { readUiSettings } = await import("../lib/settings.js");
const { acquireWorkspaceLock } = await import("../lib/workspace-lock.js");
let handler;
registerMemoryApi({ webServer: { register(entry) { handler = entry.handler; return () => {}; } } }, {
  liveOptions: readUiSettings, status: {},
});
const server = http.createServer((req, res) => handler(req, res));
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log("ok " + label); };
try {
  const cwd = join(root, "open");
  const unopened = join(root, "unopened");
  const db = await store.openWorkspaceDb(cwd);
  const hub = store.insertNode(db, { type: "entity", name: "AuthGateway", text: "Authentication entry" });
  const orphan = store.insertNode(db, { type: "entity", name: "Detached", text: "Detached entity" });
  const fact = store.insertNode(db, { type: "decision", name: "Header", text: "Use header X" });
  store.ensureLink(db, fact, hub, "about");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ workspaces: [cwd, unopened] }));
  const settingsBefore = readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8");
  const fingerprint = store.dbFingerprint(db);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-trivium`;
  const request = async (path, body, workspace = cwd) => {
    const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(workspace)}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let result = await request("/query", { kind: "nodes", type: "entity" });
  check(result.status === 200 && result.body.source === "live" && result.body.rows.length === 2, "live nodes query works with the writer open");
  result = await request("/query", { kind: "neighbors", id: hub });
  check(result.status === 200 && JSON.stringify(result.body.rows).includes("Header"), "a live query finds the one-hop business neighbor");
  result = await request("/query", { kind: "orphanEntities" });
  check(result.status === 200 && JSON.stringify(result.body.rows).includes("Detached") && !JSON.stringify(result.body.rows).includes("AuthGateway"), "orphan query ignores workspace membership but respects business links");
  result = await request("/query", { kind: "nodes", type: "entity", limit: 1 });
  check(result.status === 200 && result.body.rows.length === 1 && result.body.truncated === true, "a result cap explicitly reports truncation");
  result = await request("/query", { tql: "CREATE (n {name:'unsafe'})" });
  check(result.status === 400, "arbitrary TQL is rejected on the live path");
  for (const workspace of [unopened, join(root, "unknown")]) {
    result = await request("/query", { kind: "nodes" }, workspace);
    check(result.status === 409 && result.body.code === "WORKSPACE_NOT_OPEN" && !existsSync(workspace), "an unopened workspace is rejected without creating it");
  }
  check(store.dbFingerprint(db) === fingerprint, "live queries leave facts and links unchanged");
  check(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8") === settingsBefore, "live queries do not rewrite workspace settings");
  let response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "nodes", padding: "x".repeat(17000) }),
  });
  check(response.status === 413, "request bytes are bounded before native execution");
  response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://outside.example" }, body: '{"kind":"nodes"}',
  });
  check(response.status === 403, "the new endpoint retains the existing origin guard");
  response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: '{"kind":"nodes"}',
  });
  check(response.status === 415, "read API requires JSON content type");
  const lock = acquireWorkspaceLock(cwd);
  check(lock.ok, "test holds the workspace operation lock");
  try {
    result = await request("/snapshots", {});
    check(result.status === 409 && result.body.code === "WORKSPACE_WRITE_BUSY", "snapshot capture respects ongoing writer work");
  } finally { lock.release(); }
  result = await request("/snapshots", {});
  check(result.status === 200 && result.body.snapshotId && result.body.directory, "the writer publishes an independent snapshot");
  const captured = result.body;
  result = await request("/snapshots");
  check(result.status === 200 && result.body.snapshotId === captured.snapshotId
    && result.body.integrity === "verified-at-capture", "latest returns publication metadata without claiming a fresh health check");
  store.insertNode(db, { type: "entity", name: "AfterSnapshot", text: "Later source write" });
  result = await request("/query", {
    snapshotId: captured.snapshotId, tql: 'MATCH (n) WHERE n.name == $name RETURN n', params: { name: "AfterSnapshot" },
  });
  check(result.status === 200 && result.body.source === "snapshot" && result.body.rows.length === 0, "snapshot queries retain the captured source version after further writes");
  result = await request("/query", { kind: "nodes", name: "AfterSnapshot" });
  check(result.status === 200 && result.body.rows.length === 1, "the live path sees the newer fact");
  result = await request("/query", { snapshotId: captured.snapshotId, tql: 'FIND {type: "entity"} RETURN * LIMIT 100', limit: 1 });
  check(result.status === 200 && result.body.rows.length === 1 && result.body.truncated === true, "isolated TQL explicitly caps output despite a larger native LIMIT");
  result = await request("/query", { snapshotId: "../outside", tql: "MATCH (n) RETURN n" });
  check(result.status >= 400 && result.status < 500, "HTTP cannot escape the workspace snapshot directory");
  result = await request("/query", { snapshotId: captured.snapshotId, tql: "CREATE (n {name:'unsafe'})" });
  check(result.status >= 400, "snapshot queries reject mutation syntax");
  // A separate client process proves the service path, not a second reader handle.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const response = await fetch(process.argv[1], {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'nodes',name:'AfterSnapshot'})});
    const data = await response.json();
    if (!response.ok || data.rows.length !== 1) process.exit(1);
  `, `${base}/query?cwd=${encodeURIComponent(cwd)}`], { stdio: "pipe", windowsHide: true });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk; });
  const childStatus = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  check(childStatus === 0, "a separate client can query while the host owns the writer: " + childError);
  const slow = http.request(`${base}/query?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
  const slowResult = new Promise((done, reject) => { slow.once("response", (res) => { res.resume(); done(res.statusCode); }); slow.once("error", reject); });
  slow.write('{"kind":');
  await new Promise((done) => setTimeout(done, 30));
  result = await request("/query", { kind: "nodes" });
  check(result.status === 429, "read admission rejects concurrent work instead of accumulating a queue");
  check(await slowResult === 408, "an unfinished request releases admission at its body deadline");
  slow.destroy();
  result = await request("/query", { kind: "nodes", name: "AfterSnapshot" });
  check(result.status === 200, "body timeout releases capacity for the next query");
  console.log(`P96 HTTP read path: ${checks}/${checks}`);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  store.closeAll();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
