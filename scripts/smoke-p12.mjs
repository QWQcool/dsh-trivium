/**
 * Git JSONL sidecar: write after mutate, import on clone / newer file.
 * Uses a temp settings file so the live ~/.dsh/trivium.json is never touched.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_LABELS } from "../lib/schema.js";
import { isTriviumArtifactName } from "../lib/purge.js";
import {
  gitSidecarEnabledOf,
  pluginLocaleOf,
  configPanelOpenOf,
  readUiSettings,
  writeUiSettings,
} from "../lib/settings.js";
import {
  flushSidecarNow,
  parseSidecar,
  sidecarPath,
  syncSidecarOnOpen,
} from "../lib/sidecar.js";
import { closeAll, deleteGitSidecars, ensureLink, generateSidecarFromDb, insertNode, listNodes, openWorkspaceDb } from "../lib/store.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p12-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "home-trivium.json");
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
  assert(gitSidecarEnabledOf({}) === false, "sidecar write defaults off when key missing");
  assert(gitSidecarEnabledOf({ gitSidecarEnabled: true }) === true, "sidecar write can be turned on");
  assert(pluginLocaleOf({}) === "host", "plugin locale follows host when missing");
  assert(configPanelOpenOf({}) === false, "config fold starts collapsed");
  assert(isTriviumArtifactName("trivium.jsonl") === true, "jsonl is an uninstall artifact");
  assert(isTriviumArtifactName("trivium.jsonl.tmp") === true, "jsonl tmp is an uninstall artifact");

  writeUiSettings({ gitSidecarEnabled: true });
  const db = await openWorkspaceDb(cwd);
  assert(existsSync(sidecarPath(cwd)) === true, "open bootstraps trivium.jsonl when sidecar is on");

  const entity = insertNode(db, { type: "entity", name: "AuthGateway", text: "gateway" });
  const pref = insertNode(db, {
    type: "preference",
    name: "header-x",
    text: "鉴权走 header X",
    uri: "ctx://preference/header-x",
  });
  ensureLink(db, pref, entity, EDGE_LABELS.about);

  const beforeFlush = readFileSync(sidecarPath(cwd), "utf8");
  assert(!beforeFlush.includes("鉴权走 header X"), "debounce has not written the new fact yet");
  flushSidecarNow(cwd, db);
  const written = readFileSync(sidecarPath(cwd), "utf8");
  const parsed = parseSidecar(written);
  assert(parsed.ok === true, "sidecar parses");
  assert(
    parsed.nodes.some((n) => n.uri === "ctx://preference/header-x" && n.text.includes("鉴权")),
    "jsonl has the preference uri",
  );
  assert(
    parsed.nodes.some((n) => n.type === "entity" && n.name === "AuthGateway" && n.uri),
    "jsonl minted a uri for the entity",
  );
  assert(
    parsed.edges.some((e) => e.type === "about" && e.from === "ctx://preference/header-x"),
    "jsonl has the about edge",
  );
  assert(!written.includes("in_workspace"), "workspace edges stay out of jsonl");
  assert(!/episode/.test(written), "episodes stay out of jsonl");

  const generated = generateSidecarFromDb(cwd, db);
  assert(generated.ok === true && generated.wrote === true, "generate overwrites from tdb");
  assert(existsSync(sidecarPath(cwd)) === true, "generate keeps the same jsonl path");
  assert(readFileSync(sidecarPath(cwd), "utf8").includes("鉴权走 header X"), "generated jsonl matches tdb");

  writeUiSettings({ gitSidecarEnabled: false });
  assert(existsSync(sidecarPath(cwd)) === true, "turning off does not delete jsonl");
  const refused = generateSidecarFromDb(cwd, db);
  assert(refused.ok === false, "generate refuses while sidecar is off");
  const deleted = deleteGitSidecars();
  assert(deleted.action === "delete", "delete reports delete");
  assert(existsSync(sidecarPath(cwd)) === false, "delete removes jsonl");
  assert(listNodes(db).some((n) => n.name === "header-x"), "delete keeps tdb facts");

  writeUiSettings({ gitSidecarEnabled: true });
  const restored = generateSidecarFromDb(cwd, db);
  assert(restored.ok === true, "generate after re-enable restores jsonl");
  assert(readFileSync(sidecarPath(cwd), "utf8").includes("鉴权走 header X"), "restored jsonl matches tdb");

  closeAll();

  const clone = join(root, "clone");
  mkdirSync(join(clone, ".dsh"), { recursive: true });
  copyFileSync(sidecarPath(cwd), sidecarPath(clone));
  const cloned = await openWorkspaceDb(clone);
  const clonedNodes = listNodes(cloned);
  assert(
    clonedNodes.some((n) => n.name === "header-x" && n.text.includes("鉴权")),
    "clone imports preference from jsonl",
  );
  assert(clonedNodes.some((n) => n.name === "AuthGateway"), "clone imports entity from jsonl");
  const header = clonedNodes.find((n) => n.name === "header-x");
  const gateway = clonedNodes.find((n) => n.name === "AuthGateway");
  assert(
    header && gateway && header.outgoing.some((e) => e.label === "about" && Number(e.to) === gateway.id),
    "clone restores about edge",
  );

  const extra = insertNode(cloned, { type: "entity", name: "LocalOnly", text: "not in git yet" });
  flushSidecarNow(clone, cloned);
  assert(
    readFileSync(sidecarPath(clone), "utf8").includes("LocalOnly"),
    "local edit is written to jsonl",
  );

  writeFileSync(sidecarPath(clone), written, "utf8");
  const pulled = await syncSidecarOnOpen(clone, cloned);
  assert(pulled.action === "import", "changed jsonl re-imports");
  const localOnly = listNodes(cloned, { includeArchived: true }).find((n) => n.name === "LocalOnly");
  assert(localOnly && localOnly.status === "archived", "node missing from git sidecar is archived");
  assert(listNodes(cloned).some((n) => n.name === "AuthGateway"), "git facts remain after import");
  assert(extra === localOnly.id, "archived row is the local-only node");

  writeFileSync(sidecarPath(clone), "{not jsonl\n", "utf8");
  const bad = await syncSidecarOnOpen(clone, cloned);
  assert(bad.action === "skip-invalid", "corrupt sidecar is not applied");
  assert(listNodes(cloned).some((n) => n.name === "AuthGateway"), "corrupt sidecar does not wipe the graph");
  closeAll();

  writeUiSettings({ gitSidecarEnabled: false });
  assert(readUiSettings().gitSidecarEnabled === false, "write switch persists off");
  const quiet = join(root, "quiet");
  mkdirSync(quiet, { recursive: true });
  const quietDb = await openWorkspaceDb(quiet);
  assert(existsSync(sidecarPath(quiet)) === false, "write-off does not bootstrap jsonl");
  insertNode(quietDb, { type: "entity", name: "QuietNode", text: "stays local" });
  flushSidecarNow(quiet, quietDb);
  assert(existsSync(sidecarPath(quiet)) === false, "write-off does not emit jsonl after mutate");

  mkdirSync(join(quiet, ".dsh"), { recursive: true });
  copyFileSync(sidecarPath(cwd), sidecarPath(quiet));
  const importedOff = await syncSidecarOnOpen(quiet, quietDb);
  assert(importedOff.action === "import", "write-off still imports a pulled jsonl");
  assert(listNodes(quietDb).some((n) => n.name === "header-x"), "imported facts land while write is off");
  closeAll();
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p12 ok");
