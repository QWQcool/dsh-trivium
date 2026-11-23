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
import { assertWorkspaceUpgradeIdle, upgradeDirectory, upgradeStatePath, workspaceIdentity } from "../lib/upgrade-state.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb");
const cli = fileURLToPath(new URL("./upgrade-kernel.mjs", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "dsh-upgrade-p120-"));
const live = join(workspace, ".dsh");
const env = { ...process.env, DSH_HOME: join(workspace, "profile"), DSH_TRIVIUM_SETTINGS: join(workspace, "settings.json") };

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
    sourceFormat: 13, source: "a".repeat(64), target: "b".repeat(64) };
  const previousDir = join(upgradeDirectory(workspace), previous.attempt, "before");
  mkdirSync(previousDir, { recursive: true });
  writeFileSync(join(previousDir, "retained-legacy"), "older rollback group\n");
  writeFileSync(upgradeStatePath(workspace), JSON.stringify(previous));

  assert.equal(run("status").mode, "migration");
  assert.equal(run("check").source_format, 15);
  assert.deepEqual(files(live), original);
  const prepared = run("prepare");
  const status = run("status");
  assert.equal(status.mode, "direct");
  assert.equal(status.activeFormat, 15);
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

  const writer = new TriviumDB(dbPath, { dim: DIM });
  writer.updatePayload(id, { text: "newer checkpoint" });
  writer.flush();
  writer.close();
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
  console.log("ok rollback refuses drift and restores the original group while archiving the new checkpoint");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
