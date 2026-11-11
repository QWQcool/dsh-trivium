/** Issue #5: explicit immutable-snapshot integrity checks while a writer lives.
 * All databases, settings and subprocess working directories are isolated.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import engine from "triviumdb";

const { TriviumDB } = engine;

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p95-"));
const script = fileURLToPath(new URL("./check-integrity.mjs", import.meta.url));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, '{"testMarker":"p95"}\n');
const settingsBefore = readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8");
let checks = 0;
let writer;
let legacy;
let damaged;
let halfPrecision;

function check(fn, message) {
  fn();
  checks += 1;
  console.log("ok  " + message);
}

function run(args, expected = 0, cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd, env: process.env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `exit ${result.status}: ${result.stderr}\n${result.stdout}`);
  return result;
}

function digest(directory) {
  const hash = createHash("sha256");
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const info = lstatSync(path);
      hash.update(relative(directory, path));
      if (info.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  }
  visit(directory);
  return hash.digest("hex");
}

try {
  check(() => {
    const absent = join(root, "not-created");
    const result = run(["--snapshot", absent, "--help"]);
    assert.match(result.stdout, /--snapshot <directory>/);
    assert.equal(existsSync(absent), false);
    assert.equal(existsSync(process.env.DSH_HOME), false);
  }, "snapshot help describes the mode without opening or creating anything");

  for (const args of [
    ["--snapshot"], ["--snapshot", "--json"],
    ["--snapshot", root, root], [root, "--snapshot", root],
    ["--snapshot", root, "--snapshot", root], ["--unknown-option"],
  ]) {
    check(() => assert.match(run(args, 1).stderr, /invalid arguments:/),
      `invalid CLI arguments are rejected: ${JSON.stringify(args)}`);
  }

  writer = new TriviumDB(join(root, "live.tdb"), { dim: 2 });
  writer.insert([1, 0], { type: "decision", text: "Authentication uses header A.", uri: "ctx://p95/a" });
  writer.insert([0, 1], { type: "decision", text: "Deployments require a reviewer.", uri: "ctx://p95/b" });
  const snapshot = join(root, "snapshot-1");
  const manifest = writer.createSnapshot(snapshot, "p95-generation-1");
  assert.equal(manifest.node_count, 2);
  const before = digest(snapshot);

  check(() => {
    const output = JSON.parse(run(["--snapshot", snapshot, "--json"]).stdout);
    assert.equal(output.ok, true);
    assert.equal(output.source, "snapshot");
    assert.equal(output.snapshotDirectory, snapshot);
    assert.equal(output.generationId, "p95-generation-1");
    assert.equal(output.file, join(snapshot, "database.tdb"));
    assert.equal(output.nodes, 2);
    assert.equal(digest(snapshot), before);
  }, "a separate CLI verifies an immutable snapshot while its source writer remains open");

  writer.insert([1, 1], { type: "decision", text: "The live graph has changed.", uri: "ctx://p95/c" });
  writer.flush();
  check(() => {
    const output = JSON.parse(run(["--json", "--snapshot", snapshot]).stdout);
    assert.equal(writer.nodeCount(), 3);
    assert.equal(output.nodes, 2);
    assert.equal(digest(snapshot), before);
  }, "later source writes leave the captured generation and its bytes unchanged");

  check(() => {
    const text = run(["--snapshot", snapshot]).stdout;
    assert.match(text, /generation: p95-generation-1/);
    assert.match(text, /integrity: ok/);
  }, "text output labels the snapshot generation and integrity result");

  writer.close();
  writer = null;
  check(() => {
    assert.equal(JSON.parse(run(["--snapshot", snapshot, "--json"]).stdout).nodes, 2);
    assert.equal(digest(snapshot), before);
  }, "a snapshot remains checkable after the source host closes");

  const bad = join(root, "corrupt-snapshot");
  cpSync(snapshot, bad, { recursive: true });
  appendFileSync(join(bad, "database.tdb"), Buffer.from([1]));
  const badBefore = digest(bad);
  check(() => {
    assert.match(run(["--snapshot", bad, "--json"], 1).stderr, /cannot open snapshot:/);
    assert.equal(digest(bad), badBefore);
  }, "a corrupt snapshot fails verification without repairing or changing it");

  const alias = join(root, "snapshot-alias");
  try {
    symlinkSync(snapshot, alias, process.platform === "win32" ? "junction" : "dir");
    check(() => assert.match(run(["--snapshot", alias], 1).stderr, /symbolic links/),
      "a snapshot directory symlink or junction is refused");
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) throw err;
    console.log("skip directory symlink check: " + err.code);
  }

  check(() => {
    const absent = join(root, "missing-snapshot");
    assert.match(run(["--snapshot", absent], 1).stderr, /cannot open snapshot:/);
    assert.equal(existsSync(absent), false);
  }, "a missing snapshot is reported without creating a replacement");

  const dirtySnapshot = join(root, "duplicate-uri-snapshot");
  damaged = new TriviumDB(join(root, "duplicates.tdb"), { dim: 2 });
  damaged.insert([1, 0], { type: "decision", uri: "ctx://p95/duplicate", text: "First fact." });
  damaged.insert([0, 1], { type: "decision", uri: "ctx://p95/duplicate", text: "Second fact." });
  damaged.createSnapshot(dirtySnapshot, "p95-invalid-revisions");
  check(() => {
    const output = JSON.parse(run(["--snapshot", dirtySnapshot, "--json"], 2).stdout);
    assert.equal(output.ok, false);
    assert.ok(output.issues.some((issue) => issue.code === "duplicate-uri"));
  }, "snapshot integrity findings preserve the existing exit code 2");
  damaged.close();
  damaged = null;

  const halfSnapshot = join(root, "half-snapshot");
  halfPrecision = new TriviumDB(join(root, "half.tdb"), { dim: 2, dtype: "f16" });
  halfPrecision.insert([0.25, 0.5], { type: "decision", text: "Half precision snapshot." });
  halfPrecision.createSnapshot(halfSnapshot, "p95-half-precision");
  check(() => {
    const output = JSON.parse(run(["--snapshot", halfSnapshot, "--json"]).stdout);
    assert.equal(output.ok, true);
    assert.equal(output.generationId, "p95-half-precision");
    assert.equal(output.nodes, 1);
  }, "the checker maps the native f16 manifest type to the Node constructor dtype");
  halfPrecision.close();
  halfPrecision = null;

  const workspace = join(root, "legacy-workspace");
  mkdirSync(join(workspace, ".dsh"), { recursive: true });
  legacy = new TriviumDB(join(workspace, ".dsh", "trivium.tdb"), { dim: 1536 });
  legacy.insert(new Array(1536).fill(0), { type: "decision", text: "Legacy workspace check." });
  check(() => assert.match(run([workspace, "--json"], 1).stderr, /cannot open read-only/),
    "workspace mode still reports a live writer lock rather than bypassing it");
  legacy.close();
  legacy = null;
  const legacyBefore = digest(workspace);
  check(() => {
    const output = JSON.parse(run([workspace, "--json"]).stdout);
    assert.equal(output.cwd, workspace);
    assert.equal(output.file, join(workspace, ".dsh", "trivium.tdb"));
    assert.equal(output.ok, true);
    assert.equal(output.nodes, 1);
    assert.equal(output.source, undefined);
    assert.equal(digest(workspace), legacyBefore);
  }, "the existing positional workspace command and JSON shape remain compatible");
  check(() => assert.equal(JSON.parse(run(["--json"], 0, workspace).stdout).cwd, workspace),
    "the existing default-current-workspace command remains compatible");
  check(() => {
    const absent = join(root, "unopened-workspace");
    assert.match(run([absent], 1).stderr, /no memory database/);
    assert.equal(existsSync(absent), false);
    assert.equal(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"), settingsBefore);
  }, "read-only checks do not create workspaces or modify UI settings");
} finally {
  for (const db of [writer, legacy, damaged, halfPrecision]) {
    try { db?.close(); } catch { /* release on assertion failure */ }
  }
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`P95 snapshot integrity passed (${checks} checks)`);
