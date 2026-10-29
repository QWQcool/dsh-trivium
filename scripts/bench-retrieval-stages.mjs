#!/usr/bin/env node
/** Bounded stage/call-count diagnosis, not a 50k benchmark or model experiment. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const size = Number(args.get("nodes") || 1000);
assert.ok(Number.isInteger(size) && size >= 100 && size <= 10000, "use a bounded 100..10000 node diagnosis");
const root = mkdtempSync(join(tmpdir(), "dsh-stage-profile-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const { TriviumDB } = createRequire(import.meta.url)("triviumdb");
const store = await import("../lib/store.js");
const { DIM, zeroVector } = await import("../lib/schema.js");
const original = new Map();
const calls = {};
for (const name of ["get", "getPayload", "allNodeIds", "indexText", "indexKeyword", "buildTextIndex", "searchHybrid", "getIncomingEdges", "neighbors", "tql"]) {
  const fn = TriviumDB.prototype[name];
  if (typeof fn !== "function") continue;
  original.set(name, fn);
  TriviumDB.prototype[name] = function (...params) { calls[name] = (calls[name] || 0) + 1; return fn.apply(this, params); };
}
const reset = () => { for (const key of Object.keys(calls)) delete calls[key]; };
const elapsed = (start) => +(performance.now() - start).toFixed(2);
let native;
try {
  let db = await store.openWorkspaceDb(root);
  const nodes = [], edges = [];
  for (let i = 1; i <= size; i++) {
    nodes.push({ id: i, payload: { type: "entity", uri: `test://stage/${i}`, name: `revision note ${i}`, text: `Synthetic retrieval body ${i} with marker m${i}.`, status: "active" } });
    if (i > 3) edges.push({ from: i, to: i - 1, label: "about" });
  }
  reset(); let start = performance.now();
  const imported = store.importGraph(db, { format: "dsh-trivium-graph", version: 2, nodes, edges });
  assert.equal(imported.ok, true);
  const importProfile = { ms: elapsed(start), calls: { ...calls } };
  store.closeAll();
  reset(); start = performance.now();
  db = await store.openWorkspaceDb(root);
  const reopen = { ms: elapsed(start), calls: { ...calls } };
  const queries = [];
  for (const query of ["revision note 2", `marker m${size - 1}`, "absent-identifier-xyz"]) {
    reset(); const began = performance.now(); let previous = began;
    const stages = [];
    const hits = store.searchNodes(db, query, { topK: 8, onStage: (stage, ids) => {
      const current = performance.now();
      stages.push({ stage, msSincePreviousStage: +(current - previous).toFixed(2), candidates: ids.length, cumulativeCalls: { ...calls } });
      previous = current;
    } });
    stages.push({ stage: "final-filter-sort", msSincePreviousStage: +(performance.now() - previous).toFixed(2), cumulativeCalls: { ...calls } });
    queries.push({ query, totalMs: elapsed(began), stages, topUris: hits.map((hit) => hit.payload.uri) });
  }
  store.closeAll();
  reset(); start = performance.now();
  native = new TriviumDB(store.dbPathFor(root), { dim: DIM, loadTextIndex: true });
  const nativeLoad = { openMs: elapsed(start), callsBeforeQuery: { ...calls } };
  nativeLoad.textHits = native.searchHybrid(zeroVector(), "revision note 2", 8, 0, 0.01, 0.2).length;
  native.close(); native = null;
  const report = {
    generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    size, semantic: "off", modelCalls: 0,
    caveat: "One synthetic store, instrumented native call counts; stage timings include observer overhead. Native load bypasses store initialization and is a diagnostic only, not an accepted replacement or speedup claim.",
    importProfile, reopen, queries, nativeLoad,
  };
  if (args.get("out")) { mkdirSync(dirname(args.get("out")), { recursive: true }); writeFileSync(args.get("out"), JSON.stringify(report, null, 2) + "\n", "utf8"); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  native?.close(); store.closeAll();
  for (const [name, fn] of original) TriviumDB.prototype[name] = fn;
  rmSync(root, { recursive: true, force: true });
}
