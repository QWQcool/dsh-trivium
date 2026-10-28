/** 0.7.0 audit regressions. Real temporary databases; no host or user settings. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveNode, closeAll, currentHeadOf, exportGraph, findByUri, importGraph, insertNode, openWorkspaceDb, openWorkspaceDbReadOnly,
  successorOf, updateNode,
} from "../lib/store.js";
import { historyOf, makeRevisionResolver, revokeSupersession, supersede } from "../lib/revisions.js";
import { checkRevisionIntegrity } from "../lib/integrity.js";
import { selectContextRecords } from "../lib/context-budget.js";
import {
  commit, deliveredOf, pendingCorrections, reserve, resetAll, setSessionWorkspace,
} from "../lib/turn-ledger.js";
import { flushSidecarNow, serializeGraph, sidecarHealth, sidecarPath, syncSidecarOnOpen } from "../lib/sidecar.js";
import { sidecarHashOf, writeUiSettings } from "../lib/settings.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p23-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
let checks = 0;
let failed = 0;
function check(value, message, detail = "") {
  checks += 1;
  if (value) console.log(`ok  ${message}`);
  else { failed += 1; console.error(`FAIL ${message}${detail ? `: ${detail}` : ""}`); }
}
function snapshot(db) {
  return JSON.stringify(db.allNodeIds().map(Number).sort((a, b) => a - b).map((id) => db.get(id)));
}
function node(uri, text) {
  return { op: "node", uri, type: "decision", text, status: "active" };
}
function jsonl(nodes, edges = []) {
  return [{ v: 2, format: "dsh-trivium-jsonl" }, ...nodes, ...edges].map(JSON.stringify).join("\n") + "\n";
}
function deliveredFact(db, cwd, id, session = "audit-session", turn = "uid:audit-turn") {
  setSessionWorkspace(session, cwd);
  const p = db.get(id).payload;
  const plan = selectContextRecords({ pins: [{ id, type: p.type, l0: p.text }] });
  commit(reserve(session, turn, plan.records, { totalTokens: plan.tokens }));
  return { session, turn };
}

try {
  // A valid file can close a cycle against the live graph. Nothing may land.
  const cwd = join(root, "sidecar-cycle");
  const db = await openWorkspaceDb(cwd);
  const a = insertNode(db, { type: "decision", uri: "ctx://audit/a", text: "认证继续使用当前请求头。" });
  const b = insertNode(db, { type: "decision", uri: "ctx://audit/b", text: "认证切换为新的请求头。" });
  assert.equal(supersede(db, { oldId: a, successorId: b }).ok, true);
  const before = snapshot(db);
  const badFile = jsonl([
    node("ctx://audit/a", db.get(a).payload.text), node("ctx://audit/b", db.get(b).payload.text),
    node("ctx://audit/new", "这个节点不能在失败后残留。"),
  ], [{ op: "edge", from: "ctx://audit/a", to: "ctx://audit/b", type: "supersedes" }]);
  writeFileSync(sidecarPath(cwd), badFile, "utf8");
  const result = await syncSidecarOnOpen(cwd, db);
  check(result.action === "import-rejected", "IO-23-01 JSONL rejects a cycle against the live graph", JSON.stringify(result));
  check(snapshot(db) === before, "IO-23-01 rejected JSONL leaves the entire graph unchanged");
  check(sidecarHashOf(cwd) === "", "IO-23-01 a rejected input is not marked synchronized");
  check(sidecarHealth().ok === false, "IO-23-01 a rejected import is visible in health");
  writeUiSettings({ gitSidecarEnabled: true });
  try { flushSidecarNow(cwd, db); } catch { /* rejected input must remain for recovery */ }
  check(readFileSync(sidecarPath(cwd), "utf8") === badFile, "IO-23-01 automatic flush preserves the rejected input");
  rmSync(sidecarPath(cwd));
  const regenerated = await syncSidecarOnOpen(cwd, db);
  check(regenerated.action === "bootstrap-write" && regenerated.hash, "IO-23-04 removing rejected input allows a real bootstrap write");
  let goodFile = "";
  try { goodFile = readFileSync(sidecarPath(cwd), "utf8"); } catch { /* assert below */ }
  check(goodFile.includes("ctx://audit/a"), "IO-23-04 bootstrap actually restores the valid database snapshot");
  const revertCwd = join(root, "sidecar-revert");
  const revertDb = await openWorkspaceDb(revertCwd);
  const previousGoodFile = readFileSync(sidecarPath(revertCwd), "utf8");
  writeFileSync(sidecarPath(revertCwd), "{invalid jsonl\n", "utf8");
  assert.equal((await syncSidecarOnOpen(revertCwd, revertDb)).action, "skip-invalid");
  writeFileSync(sidecarPath(revertCwd), previousGoodFile, "utf8");
  const reverted = await syncSidecarOnOpen(revertCwd, revertDb);
  check(reverted.action === "skip" && sidecarHealth().ok, "IO-23-04 reverting to the last synchronized file clears rejection");
  insertNode(revertDb, { type: "preference", text: "恢复后仍然可以派生旁路文件。", uri: "ctx://audit/recovered" });
  check(flushSidecarNow(revertCwd, revertDb)?.wrote === true, "IO-23-04 automatic writes resume after restoring a valid input");
  writeUiSettings({ gitSidecarEnabled: false });

  // If the native transaction fails, updates/new rows/archives/edges are atomic.
  const txCwd = join(root, "sidecar-transaction");
  const txDb = await openWorkspaceDb(txCwd);
  const live = insertNode(txDb, { type: "decision", uri: "ctx://tx/live", text: "原始事实保持不变。" });
  insertNode(txDb, { type: "entity", uri: "ctx://tx/omitted", name: "KeepUntilCommit" });
  const txBefore = snapshot(txDb);
  const txFile = jsonl([
    node("ctx://tx/live", "修改后的事实在事务失败时不能保留。"),
    node("ctx://tx/new", "新增事实也不能在事务失败时留下。"),
  ], [{ op: "edge", from: "ctx://tx/new", to: "ctx://tx/live", type: "supersedes" }]);
  writeFileSync(sidecarPath(txCwd), txFile, "utf8");
  const nativeCommit = txDb.commitTransaction;
  txDb.commitTransaction = () => { throw new Error("audit injected transaction failure"); };
  let txResult;
  try { txResult = await syncSidecarOnOpen(txCwd, txDb); }
  finally { txDb.commitTransaction = nativeCommit; }
  check(txResult.action === "import-rejected", "IO-23-02 a native JSONL transaction failure is rejected", JSON.stringify(txResult));
  check(snapshot(txDb) === txBefore, "IO-23-02 failed JSONL writes no payload, node, edge or archive");
  check(sidecarHashOf(txCwd) === "", "IO-23-02 failed JSONL can retry the same file");
  const retry = await syncSidecarOnOpen(txCwd, txDb);
  check(retry.action === "import", "IO-23-02 unchanged input retries successfully after the failure clears");
  const current = findByUri(txDb, "ctx://tx/new");
  check(current != null && successorOf(txDb, live) === current, "IO-23-02 the retry commits the intended revision");
  check(checkRevisionIntegrity(txDb).ok, "IO-23-02 the successful retry has a healthy chain");
  check(txDb.get(findByUri(txDb, "ctx://tx/omitted")).payload.status === "archived", "IO-23-02 snapshot removals commit with the successful retry");

  // Duplicate URI and missing version endpoints are rejected before any write.
  const validSnapshot = snapshot(txDb);
  writeFileSync(sidecarPath(txCwd), jsonl([
    node("ctx://dup/same", "重复身份第一条。"), node("ctx://dup/same", "重复身份第二条。"),
  ]), "utf8");
  const duplicate = await syncSidecarOnOpen(txCwd, txDb);
  check(duplicate.action === "import-rejected" && snapshot(txDb) === validSnapshot, "IO-23-03 duplicate JSONL identities leave the graph unchanged");
  writeFileSync(sidecarPath(txCwd), jsonl([node("ctx://missing/a", "缺失端点输入。")], [
    { op: "edge", from: "ctx://missing/a", to: "ctx://missing/b", type: "supersedes" },
  ]), "utf8");
  const missing = await syncSidecarOnOpen(txCwd, txDb);
  check(missing.action === "import-rejected" && snapshot(txDb) === validSnapshot, "IO-23-03 a missing JSONL version endpoint leaves the graph unchanged");

  // Supersede followed by revoke before delivery must not send the stale notice.
  resetAll();
  const corCwd = join(root, "corrections");
  const corDb = await openWorkspaceDb(corCwd);
  const old = insertNode(corDb, { type: "decision", text: "缓存请求使用方案甲。" });
  const next = insertNode(corDb, { type: "decision", text: "缓存请求改用方案乙。" });
  const { session, turn } = deliveredFact(corDb, corCwd, old);
  assert.equal(supersede(corDb, { oldId: old, successorId: next }).ok, true);
  assert.equal(revokeSupersession(corDb, { oldId: old, successorId: next }).ok, true);
  const pending = pendingCorrections(session);
  check(pending.length === 1 && pending[0].l0.includes("已撤销"), "CTX-23-01 pending correction reflects the latest state", JSON.stringify(pending));

  // Two writes with the same UI notice are distinct changes, even in one turn.
  resetAll();
  deliveredFact(corDb, corCwd, old, session, turn);
  updateNode(corDb, old, { text: "缓存请求改用方案丙。" });
  const first = selectContextRecords({ corrections: pendingCorrections(session), delivered: deliveredOf(session, turn) });
  commit(reserve(session, turn, first.records, { totalTokens: first.tokens }));
  updateNode(corDb, old, { text: "缓存请求改用方案丁。" });
  const second = selectContextRecords({ corrections: pendingCorrections(session), delivered: deliveredOf(session, turn) });
  check(second.records.length === 1, "CTX-23-02 a later change is not suppressed as an already-delivered notice", JSON.stringify(second.dropped));
  const inFlight = reserve(session, turn, second.records, { totalTokens: second.tokens });
  updateNode(corDb, old, { text: "缓存请求再改用方案戊。" });
  const latestKey = pendingCorrections(session)[0].changeKey;
  commit(inFlight);
  check(pendingCorrections(session)[0]?.changeKey === latestKey, "CTX-23-02 committing an older notice cannot consume a later pending change");

  // Reprojection must filter stale current nodes too, not only remapped ids.
  const staleId = insertNode(corDb, { type: "decision", text: "已经过期的限时安排。", until: "2000-01-01" });
  const stalePlan = selectContextRecords({
    recall: [{ id: staleId, type: "decision", l0: "候选采集时的旧状态。" }],
    resolveCurrent: makeRevisionResolver(corDb),
  });
  check(stalePlan.records.length === 0 && stalePlan.dropped.some((r) => r.reason === "stale"), "CTX-23-03 a stale same-id projection is excluded from automatic context");

  // Exactly 32 edges is supported; edge 33 must be refused before it is written.
  const chainCwd = join(root, "chain-boundary");
  const chainDb = await openWorkspaceDb(chainCwd);
  let head = insertNode(chainDb, { type: "decision", text: "版本边界起点。" });
  const oldest = head;
  for (let i = 1; i <= 32; i += 1) {
    const newer = insertNode(chainDb, { type: "decision", text: `版本边界第 ${i} 次确认。` });
    assert.equal(supersede(chainDb, { oldId: head, successorId: newer }).ok, true);
    head = newer;
  }
  const resolved = currentHeadOf(chainDb, oldest);
  check(resolved.ok && resolved.id === head && resolved.hops === 32, "REV-23-01 a 32-hop chain resolves consistently", JSON.stringify(resolved));
  const history = historyOf(chainDb, oldest, { limit: 50 });
  check(history.nodes.length === 33 && history.total === 33 && !history.truncated, "REV-23-01 all 33 nodes of the 32-hop history are readable");
  const overflow = insertNode(chainDb, { type: "decision", text: "第三十三跳必须拒绝。" });
  const rejected = supersede(chainDb, { oldId: head, successorId: overflow });
  check(!rejected.ok && rejected.code === "too-long", "REV-23-01 the 33rd edge is rejected", JSON.stringify(rejected));
  check(successorOf(chainDb, head) === null, "REV-23-01 rejecting overflow leaves the head unchanged");

  // Linking two individually valid chains must validate their combined length.
  const newTail = insertNode(chainDb, { type: "decision", text: "另一条链的旧端点。" });
  const newHead = insertNode(chainDb, { type: "decision", text: "另一条链的新端点。" });
  assert.equal(supersede(chainDb, { oldId: newTail, successorId: newHead }).ok, true);
  const joined = supersede(chainDb, { oldId: head, successorId: newTail });
  check(!joined.ok && joined.code === "too-long", "REV-23-02 joining chains cannot exceed the combined hop limit");

  // Archiving preserves a valid history; restoring it must not revive an old
  // decision. Creating a NEW replacement with archived endpoints stays banned.
  for (const archiveHead of [false, true]) {
    const label = archiveHead ? "head" : "history";
    const archiveCwd = join(root, `archived-${label}`);
    const sourceDb = await openWorkspaceDb(archiveCwd);
    const past = insertNode(sourceDb, { type: "decision", uri: `ctx://archive/${label}/past`, text: "历史方案使用甲。" });
    const present = insertNode(sourceDb, { type: "decision", uri: `ctx://archive/${label}/present`, text: "当前方案使用乙。" });
    assert.equal(supersede(sourceDb, { oldId: past, successorId: present }).ok, true);
    const jsonDb = await openWorkspaceDb(join(root, `archived-${label}-json`));
    assert.equal(importGraph(jsonDb, exportGraph(sourceDb)).ok, true);
    archiveNode(sourceDb, archiveHead ? present : past);
    check(checkRevisionIntegrity(sourceDb).ok, `REV-23-03 archived ${label} is valid retained history`);
    const imported = importGraph(jsonDb, exportGraph(sourceDb));
    check(imported.ok, `REV-23-03 JSON round-trips archived ${label}`, JSON.stringify(imported));
    const jsonArchived = findByUri(jsonDb, `ctx://archive/${label}/${archiveHead ? "present" : "past"}`);
    check(jsonArchived != null && jsonDb.get(jsonArchived)?.payload.status === "archived", `REV-23-03 JSON retains the archived ${label} state`);

    const cloneCwd = join(root, `archived-${label}-jsonl`);
    const cloneDb = await openWorkspaceDb(cloneCwd);
    writeFileSync(sidecarPath(cloneCwd), serializeGraph(sourceDb), "utf8");
    const sync = await syncSidecarOnOpen(cloneCwd, cloneDb);
    const clonedPast = findByUri(cloneDb, `ctx://archive/${label}/past`);
    const clonedPresent = findByUri(cloneDb, `ctx://archive/${label}/present`);
    check(sync.action === "import" && clonedPast != null && clonedPresent != null && successorOf(cloneDb, clonedPast) === clonedPresent,
      `REV-23-03 JSONL keeps both ends and the relation with archived ${label}`);
    const clonedArchived = archiveHead ? clonedPresent : clonedPast;
    check(clonedArchived != null && cloneDb.get(clonedArchived)?.payload.status === "archived", `REV-23-03 JSONL retains the archived ${label} state`);
    const restoredPlan = selectContextRecords({
      recall: [{ id: clonedPast, type: "decision", l0: "历史方案使用甲。" }],
      resolveCurrent: makeRevisionResolver(cloneDb),
    });
    check(archiveHead ? restoredPlan.records.length === 0 : restoredPlan.records[0]?.id === clonedPresent,
      `REV-23-03 restored ${label} respects current-state automatic injection`);
    const fresh = insertNode(sourceDb, { type: "decision", text: "尚未建立关系的新方案。" });
    const forbidden = supersede(sourceDb, { oldId: fresh, successorId: archiveHead ? present : past });
    check(!forbidden.ok && forbidden.code === "archived", `REV-23-03 new replacements still reject archived ${label}`);
  }

  // Default CLI listing must not reconcile a changed JSONL, rebuild indexes or
  // register settings. Drive the actual executable in a fresh process.
  const cliCwd = join(root, "cli-readonly");
  const cliDb = await openWorkspaceDb(cliCwd);
  insertNode(cliDb, { type: "decision", uri: "ctx://cli/original", text: "2020-01-01 已完成的旧事项。", until: "2020-01-01" });
  const cliBefore = snapshot(cliDb);
  closeAll();
  const cliInput = jsonl([node("ctx://cli/replacement", "只读检查不能导入这条替换事实。")]);
  writeFileSync(sidecarPath(cliCwd), cliInput, "utf8");
  const fileHashes = () => Object.fromEntries(readdirSync(join(cliCwd, ".dsh")).sort().map((name) => [
    name, createHash("sha256").update(readFileSync(join(cliCwd, ".dsh", name))).digest("hex"),
  ]));
  const cliFilesBefore = JSON.stringify(fileHashes());
  const settingsBefore = readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8");
  const runCli = (name, args) => spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, DSH_HOME: join(root, "cli-home") },
  });
  const dryRun = runCli("clear-expired-until.mjs", [cliCwd, "--json"]);
  check(dryRun.status === 0 && JSON.parse(dryRun.stdout).staleDecisions === 1, "CLI-23-01 dry-run lists the existing database without applying changed JSONL");
  const readOnlyDb = openWorkspaceDbReadOnly(cliCwd);
  try { check(snapshot(readOnlyDb) === cliBefore, "CLI-23-01 dry-run leaves facts and relations unchanged"); }
  finally { readOnlyDb.close(); }
  check(JSON.stringify(fileHashes()) === cliFilesBefore, "CLI-23-01 dry-run leaves all database and sidecar file bytes unchanged");
  check(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8") === settingsBefore, "CLI-23-01 dry-run does not register workspaces or sync hashes");
  for (const cli of ["clear-expired-until.mjs", "check-integrity.mjs"]) {
    const absent = join(root, `missing-${cli}`);
    const help = runCli(cli, [absent, "--help"]);
    check(help.status === 0 && /usage:/i.test(help.stdout) && !existsSync(absent), `CLI-23-02 ${cli} --help succeeds without accessing a database`);
  }

  console.log(`\nP23 audit: ${checks - failed}/${checks} checks passed`);
  if (failed) process.exitCode = 1;
} finally {
  writeUiSettings({ gitSidecarEnabled: false });
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
