/** Format 15 preparation and rollback with an existing v1 migration record. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DIM } from "../lib/schema.js";
import { KERNEL_MARKER_NAME, KERNEL_VERSION, assertWorkspaceUpgradeIdle, upgradeDirectory, upgradeStatePath, workspaceIdentity } from "../lib/upgrade-state.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb");
const cli = fileURLToPath(new URL("./upgrade-kernel.mjs", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "dsh-upgrade-p120-"));
const live = join(workspace, ".dsh");
const env = { ...process.env, DSH_HOME: join(workspace, "profile"), DSH_TRIVIUM_SETTINGS: join(workspace, "settings.json") };
process.env.DSH_HOME = env.DSH_HOME;
process.env.DSH_TRIVIUM_SETTINGS = env.DSH_TRIVIUM_SETTINGS;
const store = await import("../lib/store.js");

function run(command, failure) {
  const child = spawnSync(process.execPath, [cli, command, workspace], { env, encoding: "utf8", windowsHide: true });
  if (child.error) throw child.error;
  if (failure) {
    assert.equal(child.status, 1);
    assert.match(child.stderr, failure);
    return;
  }
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function files(root, subdir = root) {
  return readdirSync(subdir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(subdir, entry.name);
    if (entry.isDirectory()) return files(root, path);
    return [[relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex")]];
  });
}

try {
  mkdirSync(live);
  const dbPath = join(live, "trivium.tdb");
  const db = new TriviumDB(dbPath, { dim: DIM });
  const id = db.insert(Array(DIM).fill(0), { text: "original" });
  db.flush();
  db.close();
  writeFileSync(join(live, "trivium-handoff.json"), "original receipt\n");
  mkdirSync(join(live, "read-snapshots"));
  writeFileSync(join(live, "read-snapshots", "sentinel"), "original snapshot\n");
  const original = files(live);
  const previous = { version: 1, workspace: workspaceIdentity(workspace), attempt: randomUUID(), phase: "active",
    sourceFormat: 13, targetKernel: "0.9.2", source: "a".repeat(64), target: "b".repeat(64) };
  const previousDir = join(upgradeDirectory(workspace), previous.attempt, "before");
  mkdirSync(previousDir, { recursive: true });
  writeFileSync(join(previousDir, "retained-legacy"), "older rollback group\n");
  writeFileSync(upgradeStatePath(workspace), JSON.stringify(previous));

  assert.equal(run("status").mode, "migration");
  assert.equal(run("status").prepareRequired, true);
  await assert.rejects(store.openWorkspaceDb(workspace), { code: "WORKSPACE_UPGRADE_PREPARE_REQUIRED" });
  writeFileSync(upgradeStatePath(workspace), JSON.stringify({ ...previous, targetKernel: KERNEL_VERSION, attempt: randomUUID() }));
  await assert.rejects(store.openWorkspaceDb(workspace), { code: "WORKSPACE_UPGRADE_PREPARE_REQUIRED" });
  writeFileSync(upgradeStatePath(workspace), JSON.stringify(previous));
  const reader = store.openWorkspaceDbReadOnly(workspace);
  try { assert.equal(reader.getPayload(id).text, "original"); }
  finally { reader.close(); }
  assert.equal(run("check").source_format, 15);
  assert.deepEqual(files(live), original);
  console.log("ok opening for write requires preparation for this kernel and a retained library, while read-only access leaves the files intact");

  const prepared = run("prepare");
  const status = run("status");
  assert.equal(status.mode, "direct");
  assert.equal(status.activeFormat, 15);
  assert.equal(status.targetKernel, KERNEL_VERSION);
  assert.equal(status.prepareRequired, false);
  assert.deepEqual(JSON.parse(readFileSync(status.previousRecord, "utf8")), previous);
  assert.ok(existsSync(join(previousDir, "retained-legacy")));
  assert.deepEqual(files(status.before), original);
  assert.deepEqual(files(live), original);
  console.log("ok direct check and complete preparation preserve the prior journal and both file groups");

  // The capture has been renamed into place but the last journal update did not run.
  const { target, ...interrupted } = prepared;
  writeFileSync(upgradeStatePath(workspace), JSON.stringify({ ...interrupted, phase: "preparing" }));
  assert.throws(() => assertWorkspaceUpgradeIdle(workspace), { code: "WORKSPACE_UPGRADE_IN_PROGRESS" });
  assert.deepEqual(run("prepare"), prepared);
  assert.deepEqual(files(status.before), original);
  console.log("ok preparation resumes using the verified complete copy");

  const writer = await store.openWorkspaceDb(workspace);
  writer.updatePayload(id, { text: "newer checkpoint" });
  writer.flush();
  store.closeAll();
  assert.equal(readFileSync(join(live, KERNEL_MARKER_NAME), "utf8"), KERNEL_VERSION + "\n");
  const reopened = await store.openWorkspaceDb(workspace);
  assert.equal(reopened.getPayload(id).text, "newer checkpoint");
  store.closeAll();
  const newer = files(live);
  assert.deepEqual(run("prepare"), prepared);
  const receipt = join(status.before, "trivium-handoff.json");
  writeFileSync(receipt, "changed before rollback\n");
  run("rollback", /UPGRADE_DATA_CHANGED/);
  assert.deepEqual(files(live), newer);
  writeFileSync(receipt, "original receipt\n");
  assert.equal(run("rollback").phase, "rolled-back");
  assert.deepEqual(files(live), original);
  assert.deepEqual(files(run("status").after), newer);
  assert.deepEqual(files(status.before), original);
  await assert.rejects(store.openWorkspaceDb(workspace), { code: "WORKSPACE_UPGRADE_PREPARE_REQUIRED" });
  assert.deepEqual(files(live), original);
  console.log("ok rollback refuses drift and restores the original group while archiving the new checkpoint");

  const fresh = join(workspace, "new-workspace");
  const newDb = await store.openWorkspaceDb(fresh);
  const newId = store.insertNode(newDb, { type: "decision", name: "fresh", text: "native 0.9.3 setup" });
  store.closeAll();
  assert.equal((await store.openWorkspaceDb(fresh)).getPayload(newId).text, "native 0.9.3 setup");
  console.log("ok a newly created library reopens without running prepare");
} finally {
  store.closeAll();
  rmSync(workspace, { recursive: true, force: true });
}
