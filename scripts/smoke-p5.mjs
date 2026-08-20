/**
 * Settings kernel: edit/merge/export, named recall, recall-mode mutex,
 * remote-embed vector pad. No DSH process, no real embedding HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIM, EDGE_LABELS } from "../lib/schema.js";
import { recallModeOf, applyRecallMode } from "../lib/settings.js";
import { normalizeVector, setTestEmbed } from "../lib/embed.js";
import {
  closeAll,
  exportGraph,
  formatHit,
  importGraph,
  insertNode,
  listIncomingBusiness,
  mergeNodes,
  namedRecallHits,
  openWorkspaceDb,
  searchNodes,
  updateNode,
} from "../lib/store.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p5-"));
let importCwd = "";
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
  assert(recallModeOf({}) === "off", "default recall off");
  assert(recallModeOf({ autoRecall: true }) === "auto", "legacy autoRecall boolean");
  assert(recallModeOf({ anchorRecall: true }) === "anchor", "anchor boolean");
  assert(recallModeOf({ autoRecall: true, anchorRecall: true }) === "off", "both booleans → off");
  assert(recallModeOf({ recallMode: "anchor", autoRecall: true }) === "anchor", "recallMode wins");
  const mutex = applyRecallMode({}, "auto");
  assert(mutex.autoRecall === true && mutex.anchorRecall === false, "auto excludes anchor");
  applyRecallMode(mutex, "anchor");
  assert(mutex.autoRecall === false && mutex.anchorRecall === true, "anchor excludes auto");
  applyRecallMode(mutex, "off");
  assert(mutex.autoRecall === false && mutex.anchorRecall === false, "off clears both");

  const padded = normalizeVector([1, 2]);
  assert(padded.length === DIM && padded[0] === 1 && padded[2] === 0, "normalizeVector pads to DIM");

  const db = await openWorkspaceDb(cwd);
  const keep = insertNode(db, { type: "entity", name: "AuthGateway", text: "gateway" });
  const drop = insertNode(db, {
    type: "entity",
    name: "Auth GW",
    text: "alias entity",
    aliases: ["AGW"],
  });
  const pref = insertNode(db, { type: "preference", text: "日志走 header X。" });
  db.link(pref, drop, EDGE_LABELS.about, 1);

  const renamed = updateNode(db, keep, { name: "AuthGateway", text: "登录网关" });
  assert(renamed && renamed.text === "登录网关", "updateNode writes text");

  const merged = mergeNodes(db, keep, drop);
  assert(merged.ok === true, "mergeNodes ok");
  const dropNode = db.get(drop);
  assert(dropNode.payload.status === "archived", "dropped entity archived");
  const incoming = listIncomingBusiness(db, keep);
  assert(
    incoming.some((e) => e.from === pref && e.label === "about"),
    "merge rewires about edge onto keep",
  );
  const keepPayload = db.get(keep).payload;
  assert(keepPayload.text === "登录网关", "merge keeps the keep-node text");
  assert(
    (keepPayload.aliases || []).some((a) => /Auth GW|AGW/i.test(a)),
    "merge copies drop name/aliases",
  );

  const sameTypeFail = mergeNodes(db, keep, pref);
  assert(sameTypeFail.ok === false, "refuse merge across types");

  const graph = exportGraph(db, cwd);
  assert(graph.format === "dsh-trivium-graph" && graph.nodes.length >= 3, "export has nodes");
  assert(
    graph.edges.some((e) => e.from === pref && e.to === keep && e.label === "about"),
    "export includes rewired edge",
  );

  importCwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p5-in-"));
  const db2 = await openWorkspaceDb(importCwd);
  const imported = importGraph(db2, graph);
  assert(imported.ok === true && imported.created >= 2, "import creates nodes in a new workspace");
  assert(
    namedRecallHits(db2, "AuthGateway").some((h) => /header X/.test(h.payload?.text || "")),
    "import restores about-neighbor for AuthGateway",
  );
  const again = importGraph(db2, graph);
  assert(again.ok === true && again.created === 0, "re-import merges by uri instead of duplicating");

  const hits = namedRecallHits(db, "AuthGateway", { topK: 8 });
  const formatted = hits.map((h) => formatHit(db, h));
  assert(
    formatted.some((h) => h.id === keep),
    "named recall hits keep entity",
  );
  assert(
    formatted.some((h) => h.id === pref),
    "named recall expands about neighbor",
  );
  assert(namedRecallHits(db, "hello there").length === 0, "no entity name → no named recall");

  setTestEmbed(() => Array.from({ length: DIM }, (_, i) => (i === 0 ? 0.5 : 0)));
  const queryVector = await (await import("../lib/embed.js")).embedText("AuthGateway");
  assert(Array.isArray(queryVector) && queryVector[0] === 0.5, "test embed returns vector");
  const withVec = searchNodes(db, "AuthGateway", { topK: 8, queryVector });
  assert(
    withVec.some((h) => h.id === keep),
    "searchNodes still hits with queryVector",
  );
  setTestEmbed(null);
} catch (err) {
  failed += 1;
  console.error("FAIL exception " + (err && err.stack ? err.stack : err));
} finally {
  closeAll();
  setTestEmbed(null);
  try {
    rmSync(cwd, { recursive: true, force: true });
    if (importCwd) rmSync(importCwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p5 ok");
