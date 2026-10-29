/** C-review P0: an exact, current name must survive top-K independently of degree. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p30-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const store = await import("../lib/store.js");
const { registerTools } = await import("../lib/tools.js");
const registered = new Map();
registerTools({ effect: (fn) => fn(), tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } }, on() {} }, {});
let checks = 0, failed = 0;
function check(value, label) { checks++; if (value) console.log("ok  " + label); else { failed++; console.error("FAIL " + label); } }

try {
  const cwd = join(root, "rank");
  let db = await store.openWorkspaceDb(cwd);
  const target = store.insertNode(db, { type: "entity", name: "revision note 2", text: "Exact isolated target marker RANK_TARGET.", uri: "test://rank/exact" });
  const hub = store.insertNode(db, { type: "entity", name: "BusinessHub", text: "Business relation endpoint." });
  for (let i = 0; i < 12; i++) {
    const id = store.insertNode(db, { type: "entity", name: `revision note 2${i + 10}`, text: `A weaker name match ${i}.` });
    assert.equal(store.ensureLink(db, id, hub, "about"), true);
  }
  const query = "revision note 2";
  const stages = {};
  const before = store.searchNodes(db, query, { topK: 8, expandDepth: 0, onStage: (name, ids) => { stages[name] = ids; } });
  check(stages["entity-anchor"].includes(target), "RANK-30 exact target really entered the candidate pipeline");
  check(before[0]?.id === target, "RANK-30 exact unlinked name outranks twelve connected partial names");
  check(before.length <= 8, "RANK-30 top-K remains bounded");
  store.ensureLink(db, target, hub, "about");
  check(store.searchNodes(db, query, { topK: 8, expandDepth: 0 })[0]?.id === target, "RANK-30 adding a target edge cannot change its exact-match rank");
  store.dropLink(db, target, hub, "about");
  check(store.searchNodes(db, "  REVISION NOTE 2  ", { topK: 8 })[0]?.id === target, "RANK-30 case/whitespace normalization preserves the exact hit");

  const native = db.searchHybrid;
  db.searchHybrid = () => [];
  try { check(store.searchNodes(db, query, { topK: 8 })[0]?.id === target, "RANK-30 exact target also survives the lexical fallback"); }
  finally { db.searchHybrid = native; }
  const output = await registered.get("ctx_find").execute({ query }, { agent: { session: { id: "rank", header: { cwd } } } });
  check(String(output).includes("RANK_TARGET"), "RANK-30 the public find tool returns the target body");
  store.closeAll();
  db = await store.openWorkspaceDb(cwd);
  check(store.searchNodes(db, query, { topK: 8 })[0]?.id === target, "RANK-30 reopening keeps exact-name recall");

  const expiryDb = await store.openWorkspaceDb(join(root, "expiry"));
  const stale = store.insertNode(expiryDb, { type: "decision", name: "ReleaseGuard", text: "Historical release policy.", until: "2000-01-01" });
  const live = store.insertNode(expiryDb, { type: "decision", name: "ReleaseGuard current", text: "Current release policy." });
  const ordered = store.searchNodes(expiryDb, "ReleaseGuard", { topK: 8, expandDepth: 0 });
  check(ordered.findIndex((hit) => hit.id === live) < ordered.findIndex((hit) => hit.id === stale), "RANK-30 exact-name priority cannot promote stale history above a live match");
  check(store.formatHit(expiryDb, ordered.find((hit) => hit.id === stale)).stale, "RANK-30 explicit historical search retains the stale label");
  check(!store.searchNodes(expiryDb, "ReleaseGuard", { includeStale: false }).some((hit) => hit.id === stale), "RANK-30 current-only filtering stays unchanged");
} finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
console.log(`P30 exact-name recall: ${checks - failed}/${checks}`);
if (failed) process.exitCode = 1;
