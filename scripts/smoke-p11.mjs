/**
 * Package removal preserves memory; only direct, explicit cleanup may erase it.
 * Uses a temp settings file so the live ~/.dsh/trivium.json is never touched.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listedWorkspaces, rememberWorkspace, readUiSettings, settingsFilePath, writeUiSettings } from "../lib/settings.js";
import {
  isTriviumArtifactName,
  runUninstallPurge,
  shouldWipeOnUninstall,
} from "../lib/purge.js";
import { closeAll, dbPathFor, insertNode, openWorkspaceDb } from "../lib/store.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p11-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "home", "trivium.json");
const cwd = join(root, "ws");
mkdirSync(cwd, { recursive: true });
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  assert(isTriviumArtifactName("trivium.tdb") === true, "tdb is an artifact");
  assert(isTriviumArtifactName("trivium.tdb.lock") === true, "tdb sidecar is an artifact");
  assert(isTriviumArtifactName("trivium-pending.json") === true, "pending is an artifact");
  assert(isTriviumArtifactName("trivium.jsonl") === true, "jsonl is an artifact");
  assert(isTriviumArtifactName("sessions.json") === false, "other .dsh files stay");

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert(!["preuninstall", "uninstall", "postuninstall"].some(name => pkg.scripts?.[name]), "package has no uninstall lifecycle hook");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "remove" }) === false, "pnpm remove retains data");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "uninstall" }) === false, "npm uninstall retains data");
  assert(shouldWipeOnUninstall({ npm_command: "remove" }, []) === false, "remove command alone never opts into deletion");
  assert(shouldWipeOnUninstall({ npm_config_argv: '{"cooked":["uninstall"]}' }, []) === false, "legacy uninstall arguments never opt into deletion");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "install" }) === false, "upgrade/install keeps data");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "add" }) === false, "pnpm add keeps data");
  assert(shouldWipeOnUninstall({}, []) === false, "bare node lib/purge.js does not wipe");
  assert(shouldWipeOnUninstall({}, ["node", "lib/purge.js", "--force-purge"]) === true, "--force-purge wipes");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall" }, ["node", "lib/purge.js", "--force-purge"]) === false, "even explicit cleanup is blocked inside a lifecycle event");

  const db = await openWorkspaceDb(cwd);
  const memoryId = insertNode(db, { type: "decision", name: "synthetic", text: "Retain this test memory." });
  writeFileSync(join(cwd, ".dsh", "keep-me.txt"), "dsh");
  writeFileSync(join(cwd, ".dsh", "trivium-pending.json"), '{"turns":[]}');
  writeFileSync(join(cwd, ".dsh", "trivium.jsonl"), '{"v":1,"format":"dsh-trivium-jsonl"}\n');
  closeAll();
  assert(existsSync(dbPathFor(cwd)), "tdb created");
  assert(
    listedWorkspaces().some((p) => resolve(p) === resolve(cwd)),
    "workspace remembered",
  );

  const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  const files = readdirSync(join(cwd, ".dsh")).sort().map(name => join(cwd, ".dsh", name));
  files.push(settingsFilePath());
  const before = files.map(hash);
  for (const command of ["install", "add", "remove", "uninstall"]) {
    const skipped = runUninstallPurge({ npm_command: command, npm_lifecycle_event: "preuninstall" }, [], { info() {}, warn() {} });
    assert(skipped.skipped === true, `${command} lifecycle skips cleanup`);
  }
  const purgeScript = fileURLToPath(new URL("../lib/purge.js", import.meta.url));
  const lifecycleEnv = { ...process.env, npm_command: "remove", npm_lifecycle_event: "preuninstall" };
  for (const args of [[], ["--force-purge"]]) {
    const child = spawnSync(process.execPath, [purgeScript, ...args], { env: lifecycleEnv, encoding: "utf8" });
    assert(child.status === 0, `lifecycle process exits successfully (${args.join(" ") || "default"})`);
  }
  assert(JSON.stringify(files.map(hash)) === JSON.stringify(before), "uninstall preserves every synthetic database, sidecar, pending and settings byte");
  const reopened = await openWorkspaceDb(cwd);
  assert(reopened.get(memoryId)?.payload?.text === "Retain this test memory.", "saved memory remains readable after uninstall lifecycle");
  closeAll();

  const manualEnv = { ...process.env };
  delete manualEnv.npm_lifecycle_event;
  delete manualEnv.npm_command;
  delete manualEnv.npm_config_argv;
  const manual = spawnSync(process.execPath, [purgeScript, "--force-purge"], { env: manualEnv, encoding: "utf8" });
  assert(manual.status === 0, "explicit direct cleanup reports ok");
  assert(existsSync(dbPathFor(cwd)) === false, "tdb deleted");
  assert(existsSync(join(cwd, ".dsh", "trivium-pending.json")) === false, "pending deleted");
  assert(existsSync(join(cwd, ".dsh", "trivium.jsonl")) === false, "jsonl deleted");
  assert(existsSync(join(cwd, ".dsh", "keep-me.txt")) === true, "unrelated .dsh file kept");
  assert(existsSync(settingsFilePath()) === false, "home trivium.json deleted");
  assert(rememberWorkspace(cwd).length >= 1, "can record again after wipe");

  writeUiSettings({ chipsEnabled: true, sessionLayerEnabled: true });
  writeUiSettings({ extractEnabled: false });
  assert(readUiSettings().chipsEnabled === true, "later settings save keeps chipsEnabled");
  assert(readUiSettings().sessionLayerEnabled === true, "later settings save keeps sessionLayerEnabled");
  rememberWorkspace(join(root, "ws2"));
  assert(readUiSettings().chipsEnabled === true, "rememberWorkspace does not drop chipsEnabled");
} finally {
  closeAll();
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside temp directory");
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p11 ok");
