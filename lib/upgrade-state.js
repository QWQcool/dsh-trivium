import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.js";

const require = createRequire(import.meta.url);
export const KERNEL_VERSION = require("../package.json").dependencies.triviumdb;
export const DATABASE_FORMAT = 15;
export const KERNEL_MARKER_NAME = "trivium-kernel";
const databaseName = "trivium.tdb";
const markerContent = KERNEL_VERSION + "\n";
const kernelMarker = cwd => join(cwd, ".dsh", KERNEL_MARKER_NAME);

export const upgradeDirectory = cwd => join(resolve(cwd), ".dsh-trivium-upgrade");
export const upgradeStatePath = cwd => join(upgradeDirectory(cwd), "state.json");
export const upgradingPhases = new Set(["preparing", "activating", "rolling-back"]);

export function workspaceIdentity(cwd) {
  const path = realpathSync(resolve(cwd));
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function entry(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function readDatabaseFormat(path) {
  const stat = entry(path);
  if (!stat) return null;
  if (!stat.isFile())
    throw Object.assign(new Error(`Expected a regular database file at ${path}`), { code: "UPGRADE_PATH_INVALID" });
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(6);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 4) !== "TVDB")
      throw Object.assign(new Error(`Invalid TDB header at ${path}`), { code: "UPGRADE_INVALID_HEADER" });
    return header.readUInt16LE(4);
  } finally { closeSync(fd); }
}

export function readUpgradeState(cwd) {
  const invalid = () => Object.assign(new Error("The workspace upgrade record is unreadable. Keep both database copies for inspection."), {
    status: 409, code: "WORKSPACE_UPGRADE_UNREADABLE",
  });
  try {
    if (!lstatSync(upgradeDirectory(cwd)).isDirectory() || !lstatSync(upgradeStatePath(cwd)).isFile()) throw invalid();
    const state = JSON.parse(readFileSync(upgradeStatePath(cwd), "utf8"));
    const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (state?.version !== 1 || state.workspace !== workspaceIdentity(cwd) ||
        typeof state.attempt !== "string" || !/^[0-9a-f-]{36}$/.test(state.attempt) ||
        !["preparing", "activating", "active", "rolling-back", "rolled-back"].includes(state.phase) ||
        (state.mode !== undefined && !["direct", "migration"].includes(state.mode)) ||
        (state.mode === "direct" && (state.phase === "activating" || (state.source !== undefined && !digest(state.source)))) ||
        (["activating", "active", "rolling-back"].includes(state.phase) && (!digest(state.source) || !digest(state.target))) ||
        (state.phase === "rolling-back" && (!digest(state.rollbackSource) ||
          typeof state.restore !== "string" || !/^restore-[0-9a-f-]{36}$/.test(state.restore)))) throw invalid();
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw invalid();
  }
}

export function assertWorkspaceUpgradeIdle(cwd) {
  const state = readUpgradeState(cwd);
  if (upgradingPhases.has(state?.phase)) {
    throw Object.assign(new Error("Workspace upgrade operation is incomplete. Use dsh-trivium-upgrade status, then resume the operation."), {
      status: 409, code: "WORKSPACE_UPGRADE_IN_PROGRESS",
    });
  }
  return state;
}

/** Check before constructing a writable native handle, which may itself change the file group. */
export function needsWorkspaceKernelMarker(cwd, state) {
  const marker = kernelMarker(cwd);
  const markerStat = entry(marker);
  if (markerStat?.isFile() && markerStat.size === markerContent.length && readFileSync(marker, "utf8") === markerContent)
    return false;

  const file = join(cwd, ".dsh", databaseName);
  const format = readDatabaseFormat(file);
  if (format === null) {
    // A missing main file with remaining native artifacts is not a new store.
    const names = entry(dirname(file)) ? readdirSync(dirname(file)) : [];
    if (names.some(name => name.startsWith(databaseName + ".") && name !== databaseName + ".lock"))
      throw Object.assign(new Error("The database file is missing. Restore the complete workspace library before opening it."), { code: "TDB_CORRUPTED_FILE" });
    return true;
  }
  if (format < DATABASE_FORMAT)
    throw Object.assign(new Error("Run the offline dsh-trivium-upgrade migration for this workspace first."), { status: 409, code: "TDB_MIGRATION_REQUIRED" });
  if (format > DATABASE_FORMAT)
    throw Object.assign(new Error("The workspace database requires a newer TriviumDB kernel."), { code: "TDB_UNSUPPORTED_DATABASE_VERSION" });

  if (state?.phase === "active" && state.targetKernel === KERNEL_VERSION) {
    const before = join(upgradeDirectory(cwd), state.attempt, "before");
    if (entry(before)?.isDirectory() && entry(join(before, databaseName))?.isFile()) return true;
  }
  throw Object.assign(new Error("Stop the hosts using this workspace and run the dsh-trivium-upgrade prepare command from the new plugin package before opening it for writing."),
    { status: 409, code: "WORKSPACE_UPGRADE_PREPARE_REQUIRED" });
}

export function markWorkspaceKernel(cwd) {
  atomicWriteFile(kernelMarker(cwd), markerContent, { mode: 0o600 });
}
