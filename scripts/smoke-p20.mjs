/**
 * M2 data compatibility: old data, JSON exchange, Git JSONL, conflict imports.
 *
 * Covers IO-01..IO-03 from docs/next-memory/ACCEPTANCE_CASES.json plus the v2
 * sidecar format. Real native engine, isolated settings, no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveNode,
  closeAll,
  exportGraph,
  findByUri,
  importGraph,
  insertNode,
  isRevisionLinked,
  listNodes,
  nodeCountOf,
  openWorkspaceDb,
  predecessorOf,
  successorOf,
} from "../lib/store.js";
import { etagOf, nodeDetail, revisionStateOf, supersede } from "../lib/revisions.js";
import { parseSidecar, serializeGraph, SIDECAR_VERSION, sidecarHealth } from "../lib/sidecar.js";
import { provenanceOf } from "../lib/provenance.js";
import { validateRevisionStructure } from "../lib/revision-graph.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p20-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const W1 = join(root, "ws-one");
const W2 = join(root, "ws-two");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}

try {
  const db1 = await openWorkspaceDb(W1);

  /* ---------------------------------------------------------------- IO-01 */
  // Exactly the 0.4.22 shape: no source, no revision, a plain until deadline.
  const legacy = insertNode(db1, {
    type: "decision",
    name: "旧决策",
    text: "旧版本写的决策，没有来源字段。",
    until: "2020-01-01",
  });
  const legacyPayload = db1.get(legacy).payload;
  check(legacyPayload.source === undefined, "IO-01 the legacy node really has no source");
  check(provenanceOf(db1, legacy).status === "missing", "IO-01 a legacy node reports a missing source");
  check(revisionStateOf(db1, legacy).superseded === false, "IO-01 a legacy node reads as its own current version");
  const legacyDetail = nodeDetail(db1, legacy);
  check(legacyDetail.expiryState === "expired", "IO-01 the legacy deadline is still honoured");
  check(legacyDetail.sourceStatus === "missing", "IO-01 detail does not invent a source");
  check(
    !listNodes(db1, { includeStale: true, includeSuperseded: true }).some((row) => row.revision === "superseded"),
    "IO-01 reading old data performs no migration",
  );
  check(
    db1.get(legacy).payload.until === "2020-01-01" && db1.get(legacy).payload.status === "active",
    "IO-01 the old node is not rewritten or archived by reading it",
  );

  /* ---------------------------------------------------------------- IO-02 */
  // Explicit URIs: that is the cross-store identity the plan specifies.
  const oldD = insertNode(db1, {
    type: "decision",
    name: "构建工具",
    text: "构建继续使用 webpack。",
    uri: "ctx://decision/build-old",
    source: { kind: "extract", sessionId: "sess-secret", quote: "QUOTE-MARKER-9f3" },
  });
  const newD = insertNode(db1, {
    type: "decision",
    name: "构建工具",
    text: "构建改用 vite。",
    uri: "ctx://decision/build-new",
  });
  supersede(db1, {
    oldId: oldD,
    successorId: newD,
    reason: "启动速度",
    expectedEtags: { old: etagOf(db1, oldD), new: etagOf(db1, newD) },
    operationId: "op-io02",
  });
  const exported = exportGraph(db1, W1);
  check(exported.version === 2, "IO-02 the export is version 2");
  check(exported.format === "dsh-trivium-graph", "IO-02 the export keeps its format marker");
  const exportedRevision = exported.edges.filter((edge) => edge.label === "supersedes");
  check(exportedRevision.length === 1, "IO-02 the revision edge is exported");
  check(exportedRevision[0].metadata?.reason === "启动速度", "IO-02 the relation reason travels with the edge");
  check(
    exported.nodes.some((row) => row.payload?.source?.sessionId === "sess-secret"),
    "IO-02 a full export keeps provenance (it is an explicit user action)",
  );

  const db2 = await openWorkspaceDb(W2);
  const imported = importGraph(db2, exported);
  check(imported.ok === true && imported.version === 2, "IO-02 the import accepts a v2 graph");
  check(imported.revisionLinked === 1, "IO-02 one revision edge was rebuilt");
  const uriOld = db1.get(oldD).payload.uri;
  const uriNew = db1.get(newD).payload.uri;
  const localOld = findByUri(db2, uriOld);
  const localNew = findByUri(db2, uriNew);
  check(localOld != null && localNew != null, "IO-02 URIs are the cross-store identity");

  // A legacy node without a URI still remaps, through the same text resolution
  // the import uses, so old exports keep working.
  const noUri = insertNode(db1, { type: "preference", text: "没有 uri 的旧偏好条目，用来验证回退。" });
  const exportedNoUri = exportGraph(db1, W1);
  check(exportedNoUri.nodes.some((row) => row.id === noUri && !row.payload?.uri), "IO-02 a legacy node can still have no URI");
  importGraph(db2, exportedNoUri);
  check(nodeCountOf(db2) >= 3, "IO-02 a graph with URI-less nodes still imports");
  check(successorOf(db2, localOld) === localNew, "IO-02 the direction survives the remap");
  check(predecessorOf(db2, localNew) === localOld, "IO-02 the reverse direction survives too");
  const importedEdge = db2.get(localNew).edges.find((edge) => edge.label === "supersedes");
  check(importedEdge?.metadata?.reason === "启动速度", "IO-02 the edge metadata survives");

  /* ------------------------------------------------------- Git JSONL (local) */
  const sidecar = serializeGraph(db1);
  check(SIDECAR_VERSION === 2, "the JSONL format is version 2");
  check(/^\{.*"v":2.*\}$/m.test(sidecar.split("\n")[0]), "the JSONL header announces v2");
  check(
    sidecar.includes('"type":"supersedes"'),
    "the JSONL carries revision relations",
  );
  check(sidecar.includes('"meta"') && sidecar.includes("启动速度"), "the JSONL carries the relation metadata");
  check(
    !sidecar.includes("sess-secret") && !sidecar.includes("QUOTE-MARKER-9f3"),
    "local provenance never enters the committable JSONL",
  );

  const parsedV2 = parseSidecar(sidecar);
  check(parsedV2.ok === true, "a v2 file parses");
  check(
    parsedV2.edges.some((edge) => edge.type === "supersedes" && edge.meta?.reason === "启动速度"),
    "the parsed v2 relation keeps its metadata",
  );

  // A v1 file stays readable: no revision rows, no metadata.
  const v1 = [
    JSON.stringify({ v: 1, format: "dsh-trivium-jsonl" }),
    JSON.stringify({ op: "node", uri: "ctx://decision/v1-a", type: "decision", name: "A", text: "旧文件节点 A。" }),
    JSON.stringify({ op: "node", uri: "ctx://decision/v1-b", type: "entity", name: "B", text: "旧文件节点 B。" }),
    JSON.stringify({ op: "edge", from: "ctx://decision/v1-a", to: "ctx://decision/v1-b", type: "about" }),
  ].join("\n");
  const parsedV1 = parseSidecar(v1);
  check(parsedV1.ok === true, "a v1 file is still readable");
  check(parsedV1.edges.length === 1 && parsedV1.edges[0].meta === null, "a v1 edge simply has no metadata");

  /* ---------------------------------------------------------------- IO-03 */
  const payloadOfMap = new Map([
    [1, { type: "decision", text: "X", status: "active" }],
    [2, { type: "decision", text: "Y", status: "active" }],
    [3, { type: "entity", text: "Z", status: "active" }],
    [4, { type: "decision", text: "W", status: "active" }],
  ]);
  const cycle = validateRevisionStructure({
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ],
    payloadOf: (id) => payloadOfMap.get(Number(id)) || null,
  });
  check(
    cycle.ok === false && cycle.conflicts.some((c) => c.code === "cycle" || c.code === "fork-successor"),
    "IO-03 a cyclic chain is rejected before any write",
  );
  const fork = validateRevisionStructure({
    edges: [
      { from: 1, to: 4 },
      { from: 2, to: 4 },
    ],
    payloadOf: (id) => payloadOfMap.get(Number(id)) || null,
  });
  check(fork.ok === false && fork.conflicts.some((c) => c.code === "fork-predecessor"), "IO-03 a fork is rejected");
  const nonDecision = validateRevisionStructure({
    edges: [{ from: 3, to: 1 }],
    payloadOf: (id) => payloadOfMap.get(Number(id)) || null,
  });
  check(
    nonDecision.ok === false && nonDecision.conflicts.some((c) => c.code === "non-decision"),
    "IO-03 a non-decision endpoint is rejected",
  );
  const missing = validateRevisionStructure({
    edges: [{ from: 1, to: 99 }],
    payloadOf: (id) => payloadOfMap.get(Number(id)) || null,
  });
  check(
    missing.ok === false && missing.conflicts.some((c) => c.code === "missing-node"),
    "IO-03 a missing middle node is rejected",
  );

  // A real import with a broken chain writes nothing at all.
  const before = nodeCountOf(db1);
  const brokenGraph = {
    format: "dsh-trivium-graph",
    version: 2,
    nodes: [
      { id: 1, payload: { type: "decision", uri: "ctx://decision/brk-1", text: "坏链 A。" } },
      { id: 2, payload: { type: "decision", uri: "ctx://decision/brk-2", text: "坏链 B。" } },
    ],
    edges: [
      { from: 1, to: 2, label: "supersedes" },
      { from: 2, to: 1, label: "supersedes" },
    ],
  };
  const broken = importGraph(db1, brokenGraph);
  check(broken.ok === false && broken.status === 409, "IO-03 a broken chain import is refused with 409");
  check(broken.code === "REVISION_LINKED", "IO-03 the refusal has a code the UI can show");
  check(nodeCountOf(db1) === before, "IO-03 a refused import writes nothing");
  check(findByUri(db1, "ctx://decision/brk-1") == null, "IO-03 no half-written node remains");

  // Overwriting a chain body through an import is refused, not applied.
  const bodyGraph = {
    format: "dsh-trivium-graph",
    version: 2,
    nodes: [
      { id: 1, payload: { ...db1.get(oldD).payload, text: "导入想覆盖历史正文。" } },
      { id: 2, payload: { ...db1.get(newD).payload } },
    ],
    edges: [{ from: 2, to: 1, label: "supersedes" }],
  };
  const bodyConflict = importGraph(db1, bodyGraph);
  check(bodyConflict.ok === false && bodyConflict.status === 409, "IO-03 overwriting a chain body is refused");
  check(
    bodyConflict.conflicts?.some((c) => c.code === "chain-body"),
    "IO-03 the conflict names the body overwrite",
  );
  check(db1.get(oldD).payload.text.includes("webpack"), "IO-03 the live chain body is unchanged");

  // A relation that the file drops is reported, not deleted.
  const dropGraph = {
    format: "dsh-trivium-graph",
    version: 2,
    nodes: [
      { id: 1, payload: { ...db1.get(oldD).payload } },
      { id: 2, payload: { ...db1.get(newD).payload } },
    ],
    edges: [],
  };
  const dropped = importGraph(db1, dropGraph);
  check(dropped.ok === true, "IO-03 a file without relations still imports the nodes");
  check(
    successorOf(db1, oldD) === newD,
    "IO-03 an import never silently revokes an existing relation",
  );

  // Archived endpoints cannot enter a chain, and archived chain heads do not
  // revive their predecessor.
  const archOld = insertNode(db1, { type: "decision", text: "归档旧。" });
  const archNew = insertNode(db1, { type: "decision", text: "归档新。" });
  archiveNode(db1, archNew);
  const archivedAttempt = supersede(db1, { oldId: archOld, successorId: archNew, operationId: "op-io-arch" });
  check(archivedAttempt.ok === false && archivedAttempt.code === "archived", "an archived endpoint is refused");
  check(!isRevisionLinked(db1, archOld), "the refusal leaves no relation behind");

  check(sidecarHealth().enabled === false, "the sidecar reports itself as disabled when the switch is off");

  console.log(`\nP20 data compatibility passed (${checks} checks)`);
} catch (err) {
  console.error("FAIL " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
