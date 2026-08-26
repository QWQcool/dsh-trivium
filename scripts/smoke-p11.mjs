/**
 * Uninstall wipe: remove known .tdb traces, skip on install/update.
 * Uses a temp settings file so the live ~/.dsh/trivium.json is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listedWorkspaces, rememberWorkspace, readUiSettings, settingsFilePath, writeUiSettings } from "../lib/settings.js";
import {
  isTriviumArtifactName,
  purgeAllTraces,
  runUninstallPurge,
  shouldWipeOnUninstall,
} from "../lib/purge.js";
import { closeAll, dbPathFor, openWorkspaceDb } from "../lib/store.js";

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

  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "remove" }) === true, "pnpm remove wipes");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "uninstall" }) === true, "npm uninstall wipes");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "install" }) === false, "upgrade/install keeps data");
  assert(shouldWipeOnUninstall({ npm_lifecycle_event: "preuninstall", npm_command: "add" }) === false, "pnpm add keeps data");
  assert(shouldWipeOnUninstall({}, []) === false, "bare node lib/purge.js does not wipe");
  assert(shouldWipeOnUninstall({}, ["node", "lib/purge.js", "--force-purge"]) === true, "--force-purge wipes");

  await openWorkspaceDb(cwd);
  writeFileSync(join(cwd, ".dsh", "keep-me.txt"), "dsh");
  writeFileSync(join(cwd, ".dsh", "trivium-pending.json"), '{"turns":[]}');
  writeFileSync(join(cwd, ".dsh", "trivium.jsonl"), '{"v":1,"format":"dsh-trivium-jsonl"}\n');
  closeAll();
  assert(existsSync(dbPathFor(cwd)), "tdb created");
  assert(
    listedWorkspaces().some((p) => resolve(p) === resolve(cwd)),
    "workspace remembered",
  );

  const skipped = runUninstallPurge({ npm_command: "install", npm_lifecycle_event: "preuninstall" }, [], {
    info() {},
    warn() {},
  });
  assert(skipped.skipped === true, "install lifecycle skips wipe");
  assert(existsSync(dbPathFor(cwd)), "tdb still there after skipped wipe");
  assert(existsSync(settingsFilePath()), "settings still there after skipped wipe");

  const result = purgeAllTraces();
  assert(result.ok === true, "purge reports ok");
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
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p11 ok");
