/** Wipe plugin files on real uninstall. Never run this on dsh web restart. */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listedWorkspaces, settingsFilePath } from "./settings.js";
import { closeAll, listOpenWorkspaces } from "./store.js";

export function isTriviumArtifactName(name) {
  const n = String(name || "");
  return n === "trivium-pending.json" || n === "trivium.tdb" || n.startsWith("trivium.tdb");
}

/**
 * `dsh plugin remove` / `pnpm remove` should wipe.
 * `pnpm add` / update / ci reinstall the same package and must keep memory.
 */
export function shouldWipeOnUninstall(env = process.env, argv = process.argv) {
  if (argv.includes("--force-purge")) return true;
  const event = String(env.npm_lifecycle_event || "").toLowerCase();
  if (event && event !== "preuninstall" && event !== "uninstall") return false;

  const cmd = String(env.npm_command || "").toLowerCase();
  if (cmd === "remove" || cmd === "uninstall") return true;
  if (cmd === "install" || cmd === "add" || cmd === "update" || cmd === "upgrade" || cmd === "ci" || cmd === "dedupe") {
    return false;
  }

  const cooked = String(env.npm_config_argv || "").toLowerCase();
  if (/\b(remove|uninstall)\b/.test(cooked) && !/\b(install|add|update|upgrade)\b/.test(cooked)) return true;
  if (/\b(install|add|update|upgrade|ci)\b/.test(cooked)) return false;

  // Unknown command: keep memory. Upgrades must never delete the store.
  return false;
}

export function collectPurgeCwds(extraCwds = []) {
  const seen = new Set();
  const out = [];
  const add = (cwd) => {
    const key = String(cwd || "").trim();
    if (!key) return;
    const resolved = resolve(key);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  for (const cwd of listedWorkspaces()) add(cwd);
  for (const row of listOpenWorkspaces()) add(row.cwd);
  for (const cwd of extraCwds) add(cwd);
  return out;
}

function unlinkQuiet(path, files, errors) {
  try {
    unlinkSync(path);
    files.push(path);
  } catch (err) {
    if (err && err.code !== "ENOENT") errors.push({ path, message: String(err.message || err) });
  }
}

export function purgeWorkspaceArtifacts(cwd, files, errors) {
  const dir = join(resolve(cwd), ".dsh");
  if (!existsSync(dir)) return;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    errors.push({ path: dir, message: String(err.message || err) });
    return;
  }
  for (const name of names) {
    if (!isTriviumArtifactName(name)) continue;
    unlinkQuiet(join(dir, name), files, errors);
  }
}

/** Delete known workspace traces and ~/.dsh/trivium.json. Leaves other .dsh files alone. */
export function purgeAllTraces({ extraCwds = [], close = closeAll } = {}) {
  const settingsFile = settingsFilePath();
  const workspaces = collectPurgeCwds(extraCwds);
  try {
    close();
  } catch {
    // ignore
  }
  const files = [];
  const errors = [];
  for (const cwd of workspaces) purgeWorkspaceArtifacts(cwd, files, errors);
  unlinkQuiet(settingsFile, files, errors);
  return { ok: errors.length === 0, workspaces, files, errors, settingsFile };
}

function shouldRunCli() {
  return basename(String(process.argv[1] || "")) === "purge.js";
}

export function runUninstallPurge(env = process.env, argv = process.argv, log = console) {
  if (!shouldWipeOnUninstall(env, argv)) {
    log.info?.("[dsh-trivium] skip data wipe (install/update, not remove)");
    return { skipped: true };
  }
  const result = purgeAllTraces();
  const n = result.files.length;
  log.info?.(`[dsh-trivium] removed ${n} plugin file${n === 1 ? "" : "s"} from ${result.workspaces.length} workspace(s)`);
  if (result.errors.length) {
    log.warn?.("[dsh-trivium] some files could not be deleted (stop dsh web and delete leftovers):");
    for (const err of result.errors) log.warn?.(`  ${err.path}: ${err.message}`);
  }
  return result;
}

if (shouldRunCli()) {
  const result = runUninstallPurge();
  if (result?.errors?.length) process.exitCode = 1;
}
