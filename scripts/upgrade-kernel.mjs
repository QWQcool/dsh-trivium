#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, copyFileSync, createReadStream, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "../lib/atomic.js";
import { DIM } from "../lib/schema.js";
import { readUpgradeState, upgradeDirectory, upgradeStatePath, workspaceIdentity } from "../lib/upgrade-state.js";
import { acquireWorkspaceLock } from "../lib/workspace-lock.js";

const require = createRequire(import.meta.url);
const databaseName = "trivium.tdb";
const targetFormat = 15;
const options = { dim: DIM, accessMode: "readOnly" };
const isDatabaseFile = name => name === databaseName || name.startsWith(databaseName + ".");
const sidecar = name => !isDatabaseFile(name);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function entry(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function directory(path) {
  const stat = entry(path);
  if (stat && !stat.isDirectory()) fail("UPGRADE_PATH_INVALID", `Expected a regular directory at ${path}`);
  return !!stat;
}

function format(dir) {
  if (!directory(dir)) return null;
  const file = join(dir, databaseName);
  const stat = entry(file);
  if (!stat) return null;
  if (!stat.isFile()) fail("UPGRADE_PATH_INVALID", `Expected a regular database file at ${file}`);
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(6);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 4) !== "TVDB")
      fail("UPGRADE_INVALID_HEADER", `Invalid TDB header at ${file}`);
    return header.readUInt16LE(4);
  } finally { closeSync(fd); }
}

function *walk(root, prefix = "") {
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = join(prefix, name), stat = lstatSync(join(root, path));
    if (!stat.isDirectory() && !stat.isFile()) fail("UPGRADE_PATH_INVALID", `Unsupported entry at ${join(root, path)}`);
    yield { path, directory: stat.isDirectory() };
    if (stat.isDirectory()) yield *walk(root, path);
  }
}

async function fingerprint(path, include = () => true) {
  if (!directory(path)) fail("UPGRADE_LAYOUT_CONFLICT", `Missing directory at ${path}`);
  const digest = createHash("sha256");
  for (const item of walk(path)) {
    if (!include(item.path.split(sep)[0])) continue;
    if (item.path === databaseName + ".lock" && !item.directory) continue;
    if (item.directory) digest.update(JSON.stringify([item.path, "directory"]));
    else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(path, item.path))) hash.update(chunk);
      digest.update(JSON.stringify([item.path, hash.digest("hex")]));
    }
  }
  return digest.digest("hex");
}

async function verify(path, expected) {
  if (await fingerprint(path) !== expected)
    fail("UPGRADE_DATA_CHANGED", `Files changed at ${path}. Keep both copies and inspect the upgrade state.`);
}

function copyTree(source, destination, include = () => true) {
  mkdirSync(destination, { mode: 0o700 });
  for (const item of walk(source)) {
    if (!include(item.path.split(sep)[0])) continue;
    const target = join(destination, item.path);
    if (item.directory) mkdirSync(target, { mode: 0o700 });
    else copyFileSync(join(source, item.path), target, constants.COPYFILE_EXCL);
  }
}

function move(cwd, from, to) {
  const inside = path => {
    const tail = relative(cwd, path);
    return tail && !isAbsolute(tail) && tail.split(sep)[0] !== "..";
  };
  if (!directory(from) || !inside(realpathSync(from)) || !inside(join(realpathSync(dirname(to)), basename(to))) || entry(to))
    fail("UPGRADE_LAYOUT_CONFLICT", `Cannot safely move ${from} to ${to}`);
  renameSync(from, to);
}

// The journal is persisted before either rename. These are the only three
// layouts owned by this operation, including a crash between the renames.
async function exchange(cwd, { live, saved, incoming, outgoingDigest, incomingDigest }) {
  const hasLive = directory(live), hasSaved = directory(saved), hasIncoming = directory(incoming);
  if (hasLive && !hasSaved && hasIncoming) {
    await verify(live, outgoingDigest);
    await verify(incoming, incomingDigest);
    move(cwd, live, saved);
  } else if (hasLive && hasSaved && !hasIncoming) {
    await verify(saved, outgoingDigest);
    await verify(live, incomingDigest);
    return;
  } else if (!hasLive && hasSaved && hasIncoming) {
    await verify(saved, outgoingDigest);
    await verify(incoming, incomingDigest);
  } else fail("UPGRADE_LAYOUT_CONFLICT", "Unexpected workspace layout. All directories were retained for inspection.");
  move(cwd, incoming, live);
}

function save(cwd, state, phase, extra = {}) {
  const next = { ...state, ...extra, phase };
  atomicWriteFile(upgradeStatePath(cwd), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

function paths(cwd, state) {
  const run = join(upgradeDirectory(cwd), state.attempt);
  if (!directory(run)) fail("UPGRADE_LAYOUT_CONFLICT", `Missing upgrade directory at ${run}`);
  return { live: join(cwd, ".dsh"), run, old: join(run, "before"), newer: join(run, "after"), ready: join(run, "ready") };
}

function official({ upstream, tool, python }, source, destination, execute) {
  if (!upstream) fail("UPGRADE_TOOL_REQUIRED", "Pass --upstream with a TriviumDB v0.9.2 checkout and its built migration tool.");
  const script = join(resolve(upstream), "scripts", "migrate.py");
  const args = [script, "--source", source, "--destination", destination, execute ? "--execute" : "--check", "--storage", "mmap"];
  if (tool) args.push("--tool", resolve(tool));
  const result = spawnSync(python || (process.platform === "win32" ? "python" : "python3"), args,
    { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  if (result.error) throw result.error;
  if (result.status !== 0) fail("UPGRADE_TOOL_FAILED", result.stderr.trim() || result.stdout.trim() || "The official migrator failed.");
  const report = JSON.parse(result.stdout);
  if (report.tool !== "tdb-migrate-2" || report.protocol !== 1 || !report.checked ||
      report.committed !== execute || report.target_format !== targetFormat || report.facts?.dimension !== DIM ||
      !Number.isSafeInteger(report.facts?.nodes)) fail("UPGRADE_TOOL_RESULT", "The official migration receipt did not match the workspace contract.");
  return report;
}

function readDatabase(path) {
  return new (require("triviumdb").TriviumDB)(join(path, databaseName), options);
}

function checkDatabaseIdle(path) {
  const file = join(path, databaseName);
  const stat = entry(file);
  if (!stat) return;
  if (!stat.isFile()) fail("UPGRADE_PATH_INVALID", `Expected a regular database file at ${file}`);
  try { readDatabase(path).close(); }
  catch (error) {
    // A damaged upgraded library must still be eligible for rollback.
    if (!["TDB_MIGRATION_REQUIRED", "TDB_CORRUPTED_FILE", "TDB_UNSUPPORTED_DATABASE_VERSION"].includes(error.code)) throw error;
  }
}

function checkApplicationIdle(cwd) {
  const lock = acquireWorkspaceLock(cwd, { maintenance: true });
  if (!lock.ok) fail("UPGRADE_BUSY", "Stop the workspace host and wait for any pending write to finish.");
  lock.release();
}

function requireLegacy(path) {
  const version = format(path);
  if (version === null || version < 5 || version >= targetFormat)
    fail("UPGRADE_SOURCE_FORMAT", "Choose an existing legacy .dsh/trivium.tdb created by your previous TDB version.");
  return version;
}

async function activate(cwd, state) {
  const { live, old, ready } = paths(cwd, state);
  if (directory(live) && !directory(old)) {
    checkApplicationIdle(cwd);
    checkDatabaseIdle(live);
  }
  await exchange(cwd, { live, saved: old, incoming: ready, outgoingDigest: state.source, incomingDigest: state.target });
  return save(cwd, state, "active");
}

async function migrate(cwd, state, args) {
  if (state?.phase === "active") {
    if (format(paths(cwd, state).live) !== targetFormat) fail("UPGRADE_LAYOUT_CONFLICT", "The active library differs from its upgrade record.");
    return state;
  }
  if (state?.phase === "activating") return activate(cwd, state);
  if (state?.phase === "rolling-back") fail("UPGRADE_ROLLBACK_PENDING", "Resume rollback before starting an upgrade.");
  const live = join(cwd, ".dsh");
  const sourceFormat = requireLegacy(live);
  if (!args.upstream) fail("UPGRADE_TOOL_REQUIRED", "Pass --upstream with the official TriviumDB v0.9.2 migration checkout.");
  if (require("triviumdb/package.json").version !== "0.9.2") fail("UPGRADE_KERNEL_REQUIRED", "Install the TDB 0.9.2 dependencies before migrating.");
  checkApplicationIdle(cwd);
  state = save(cwd, { version: 1, workspace: workspaceIdentity(cwd), attempt: randomUUID(), sourceFormat }, "preparing");
  const run = join(upgradeDirectory(cwd), state.attempt);
  mkdirSync(run, { mode: 0o700 });
  const source = await fingerprint(live);
  const native = join(run, "native"), ready = join(run, "ready");
  const report = official(args, join(live, databaseName), native, true);
  if (report.source_format !== sourceFormat) fail("UPGRADE_SOURCE_FORMAT", "The source format changed while the migrator was running.");
  if (!directory(native)) fail("UPGRADE_TOOL_RESULT", "The official migrator did not publish a directory.");
  await verify(live, source);
  copyTree(live, ready, sidecar);
  if (await fingerprint(live, sidecar) !== await fingerprint(ready, sidecar))
    fail("UPGRADE_DATA_CHANGED", "The pending and workspace files changed during staging.");
  for (const name of readdirSync(native).filter(name => name === "database.tdb" || name.startsWith("database.tdb."))) {
    const path = join(native, name);
    if (!entry(path)?.isFile() || name === "database.tdb.migration") fail("UPGRADE_TOOL_RESULT", `Unverified migration output at ${path}`);
    copyFileSync(path, join(ready, databaseName + name.slice("database.tdb".length)), constants.COPYFILE_EXCL);
  }
  if (format(ready) !== targetFormat) fail("UPGRADE_TOOL_RESULT", "The staged database format is invalid.");
  const db = readDatabase(ready);
  try {
    if (db.nodeCount() !== report.facts.nodes) fail("UPGRADE_TOOL_RESULT", "The staged database differs from the conversion receipt.");
  } finally { db.close(); }
  state = save(cwd, state, "activating", { source, target: await fingerprint(ready), facts: report.facts });
  return activate(cwd, state);
}

async function rollback(cwd, state) {
  if (!state) fail("UPGRADE_NO_ROLLBACK", "This workspace has no recorded upgrade.");
  if (state.phase === "rolled-back") return state;
  if (state.phase === "preparing") {
    requireLegacy(join(cwd, ".dsh"));
    return save(cwd, state, "rolled-back");
  }
  const { live, old, newer, run } = paths(cwd, state);
  if (state.phase === "activating") {
    if (!directory(live)) {
      await verify(old, state.source);
      move(cwd, old, live);
      return save(cwd, state, "rolled-back");
    }
    if (!directory(old)) {
      await verify(live, state.source);
      return save(cwd, state, "rolled-back");
    }
    state = await activate(cwd, state);
  }
  if (state.phase === "active") {
    if (!directory(live) || entry(newer)) fail("UPGRADE_LAYOUT_CONFLICT", "The active upgrade layout changed.");
    checkApplicationIdle(cwd);
    checkDatabaseIdle(live);
    await verify(old, state.source);
    const restore = "restore-" + randomUUID();
    copyTree(old, join(run, restore));
    await verify(join(run, restore), state.source);
    state = save(cwd, state, "rolling-back", { restore, rollbackSource: await fingerprint(live) });
  }
  await exchange(cwd, { live, saved: newer, incoming: join(run, state.restore), outgoingDigest: state.rollbackSource, incomingDigest: state.source });
  return save(cwd, state, "rolled-back");
}

const help = `Usage: dsh-trivium-upgrade <status|check|migrate|rollback> <workspace> [--upstream <checkout>] [--tool <executable>] [--python <command>]
Stop all workspace hosts first. The tool preserves the complete original .dsh directory.
For an interrupted switch, rerun migrate or rollback according to status.`;

async function run(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(help); return; }
  const [command, workspace, ...rest] = argv;
  if (!["status", "check", "migrate", "rollback"].includes(command) || !workspace || workspace.startsWith("-"))
    fail("UPGRADE_ARGUMENTS", help);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2), value = rest[i + 1];
    if (!["--upstream", "--tool", "--python"].includes(rest[i]) || !value || value.startsWith("--") || args[key])
      fail("UPGRADE_ARGUMENTS", help);
    args[key] = value;
  }
  const cwd = realpathSync(resolve(workspace)), base = upgradeDirectory(cwd);
  if (!directory(cwd)) fail("UPGRADE_PATH_INVALID", "Choose an existing workspace directory.");
  if (command === "status") {
    const state = readUpgradeState(cwd);
    const layout = state && directory(join(base, state.attempt)) ? paths(cwd, state) : null;
    const live = join(cwd, ".dsh");
    let activeFormat;
    try { activeFormat = format(live); } catch (error) { activeFormat = error.code || "unreadable"; }
    console.log(JSON.stringify({ workspace: cwd, phase: state?.phase || "none", activeFormat,
      before: layout && directory(layout.old) ? layout.old : null, after: layout && directory(layout.newer) ? layout.newer : null }, null, 2));
    return;
  }
  const live = join(cwd, ".dsh");
  const hostHomes = [join(homedir(), ".dsh"), process.env.DSH_HOME].filter(Boolean);
  const liveIdentity = directory(live) ? workspaceIdentity(live) : null;
  if (hostHomes.some(path => entry(path) && workspaceIdentity(path) === liveIdentity))
    fail("UPGRADE_PATH_INVALID", "Choose a workspace library. The global DeepSeek Harness profile cannot be switched.");
  if (!directory(base)) mkdirSync(base, { mode: 0o700 });
  const lockFile = join(base, "operation.lock");
  if (entry(lockFile) && !entry(lockFile).isFile()) fail("UPGRADE_PATH_INVALID", `Invalid lock at ${lockFile}`);
  const lock = acquireWorkspaceLock(cwd, { file: lockFile, maintenance: true });
  if (!lock.ok) fail("UPGRADE_BUSY", "Another upgrade operation owns the workspace.");
  try {
    const state = readUpgradeState(cwd);
    let result;
    if (command === "check") {
      requireLegacy(live);
      result = official(args, join(live, databaseName), join(base, "check-" + randomUUID()), false);
    } else result = await (command === "migrate" ? migrate(cwd, state, args) : rollback(cwd, state));
    console.log(JSON.stringify(result, null, 2));
  } finally { lock.release(); }
}

try { await run(process.argv.slice(2)); }
catch (error) {
  console.error(`${error.code || "UPGRADE_FAILED"}: ${error.message}`);
  process.exitCode = 1;
}
