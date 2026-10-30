/** Real processes contend on the independent change-log lock. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { auditGapPath, changesPath, noteChanges, readChanges } from "../lib/change-log.js";
import { acquireWorkspaceLock } from "../lib/workspace-lock.js";

if (process.argv[2] === "blocked") {
  const result = noteChanges(process.argv[3], [{ reason: "written", opId: "child", preview: "synthetic" }]);
  console.log(JSON.stringify({ ok: result.ok, code: result.code, gapMarked: result.gapMarked }));
  process.exit(0);
}
if (process.argv[2] === "reader") {
  const result = readChanges(process.argv[3]);
  console.log(JSON.stringify({ ok: result.ok, incomplete: result.incomplete, total: result.total }));
  process.exit(0);
}
if (process.argv[2] === "worker") {
  const cwd = process.argv[3], name = process.argv[4];
  for (let i = 0; i < 120; i++) {
    let done = false;
    for (let attempt = 0; attempt < 1000 && !done; attempt++) {
      const result = noteChanges(cwd, [{ reason: "written", opId: `${name}-${i}`, preview: `row ${i}` }]);
      if (result.ok) done = true;
      else if (result.code === "audit-lock-busy") await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
      else throw new Error("unexpected audit write failure");
    }
    if (!done) throw new Error("audit lock did not become available");
  }
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "trivium-p61-"));
const cwd = join(root, "workspace");
const file = `${changesPath(cwd)}.lock`;
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log(`ok ${label}`); }
function worker(name) {
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", cwd, name], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", (part) => { errors += part; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveWorker() : reject(new Error(`worker failed ${code}: ${errors}`)));
  });
}
function single(mode, workspace) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, workspace], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || "child process failed");
  return JSON.parse(child.stdout);
}

try {
  const lock = acquireWorkspaceLock(cwd, { file });
  check(lock.ok, "audit lock can be acquired independently");
  const blocked = noteChanges(cwd, [{ reason: "written", opId: "blocked", preview: "should wait" }]);
  check(!blocked.ok && blocked.code === "audit-lock-busy" && !existsSync(changesPath(cwd)), "contended audit write reports failure without writing");
  lock.release();
  await Promise.all([worker("one"), worker("two")]);
  const data = readChanges(cwd, { limit: 200 });
  check(data.ok && data.total === 200 && data.trimmed === 40, "concurrent processes preserve all rows or report exact trimming");
  check(new Set(data.entries.map((row) => row.opId)).size === 200, "retained rows remain distinct and readable");
  check(!existsSync(file), "audit lock is released after both writers finish");
  writeFileSync(file, JSON.stringify({ pid: 2147483647, nonce: "dead-owner" }), "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  check(noteChanges(cwd, [{ reason: "written", opId: "after-stale", preview: "recovered" }]).ok, "a stale dead-owner audit lock is recovered");
  check(readChanges(cwd).trimmed === 41 && !existsSync(file), "stale recovery keeps the trim count and releases the lock");
  const isolated = join(root, "isolated");
  check(readChanges(isolated).incomplete === false, "an unrelated workspace has no audit-gap marker");
  const cross = join(root, "cross-process");
  const crossLock = acquireWorkspaceLock(cross, { file: `${changesPath(cross)}.lock` });
  assert.equal(crossLock.ok, true);
  const lost = single("blocked", cross);
  check(lost.ok === false && lost.code === "audit-lock-busy" && lost.gapMarked === true, "a competing process records a durable audit gap");
  check(existsSync(auditGapPath(cross)) && statSync(auditGapPath(cross)).size === 0, "gap marker has fixed size and contains no event data");
  crossLock.release();
  const restarted = single("reader", cross);
  check(restarted.ok && restarted.incomplete === true && restarted.total === 0, "a fresh process sees the gap even when no log exists");
  check(noteChanges(cross, [{ reason: "written", opId: "later", preview: "later" }]).ok, "later writes can succeed");
  check(single("reader", cross).incomplete === true, "later success does not erase evidence of missing history");
  check(readChanges(isolated).incomplete === false, "the gap does not leak to another workspace");
  console.log(`P61: ${checks}/${checks}`);
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
