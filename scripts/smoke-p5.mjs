/**
 * Settings kernel: edit/merge/export, named recall, recall-mode mutex,
 * embedding contract and asynchronous derived writes. No real embedding HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIM, EDGE_LABELS } from "../lib/schema.js";
import { recallModeOf, applyRecallMode } from "../lib/settings.js";
import { configureEmbedding, embedText, normalizeVector, setTestEmbed } from "../lib/embed.js";
import { acquireWorkspaceLock } from "../lib/workspace-lock.js";
import {
  closeAll,
  backfillEmbeddings,
  deleteNode,
  embedQueryVector,
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
let asyncCwd = "";
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

  assert(normalizeVector([1, 2]) === null, "wrong-dimensional vectors are rejected");
  assert(normalizeVector(Array(DIM).fill(0)) === null, "zero vectors are rejected");
  assert(normalizeVector(Array(DIM).fill(NaN)) === null, "non-finite vectors are rejected");

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

  const unit = (axis) => Array.from({ length: DIM }, (_, i) => i === axis ? 1 : 0);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const inputs = [];
  configureEmbedding({ embeddingQueryPrefix: "Instruct: retrieve facts\nQuery: " });
  setTestEmbed(text => { inputs.push(text); return unit(0); });
  await embedText("document passage");
  await embedQueryVector("retrieval question");
  assert(inputs[0] === "document passage" && inputs[1] === "Instruct: retrieve facts\nQuery: retrieval question",
    "query instructions never contaminate document embeddings");
  setTestEmbed(null);
  configureEmbedding({});

  const nativeFetch = globalThis.fetch;
  const previousKey = process.env.DSH_TRIVIUM_EMBED_KEY;
  const transport = [];
  let responseVector = unit(0), responseOk = true;
  process.env.DSH_TRIVIUM_EMBED_KEY = "controlled-test-credential";
  globalThis.fetch = async (url, options) => {
    transport.push(options);
    return { ok: responseOk, json: async () => ({ data: [{ embedding: responseVector }] }) };
  };
  try {
    configureEmbedding({ embeddingEnabled: true, embeddingUrl: "http://127.0.0.1:1/v1/embeddings", embeddingApiKey: "", embeddingQueryPrefix: "Task\nQuery: " });
    await embedText("document");
    await embedQueryVector("question");
    assert(transport.every(request => !request.headers.authorization)
      && JSON.parse(transport[0].body).input === "document"
      && JSON.parse(transport[1].body).input === "Task\nQuery: question",
      "explicit empty credentials suppress inherited keys and HTTP prefixes are query-only");
    responseVector = [1, 2];
    assert(await embedText("wrong dimension") === null, "a provider's short vector degrades to keyword retrieval");
    responseOk = false;
    assert(await embedText("provider rejection") === null, "HTTP provider failure degrades without throwing");
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousKey === undefined) delete process.env.DSH_TRIVIUM_EMBED_KEY;
    else process.env.DSH_TRIVIUM_EMBED_KEY = previousKey;
    configureEmbedding({});
  }

  asyncCwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p5-async-"));
  const asyncDb = await openWorkspaceDb(asyncCwd);
  let requests = [];
  setTestEmbed(text => new Promise(resolve => requests.push({ text, resolve })));
  const changed = insertNode(asyncDb, { type: "preference", text: "first embedding body" });
  updateNode(asyncDb, changed, { text: "latest embedding body" });
  assert(requests.length === 2, "each changed fact reserves a separate embedding job");
  requests[1].resolve(unit(1));
  await settle();
  requests[0].resolve(unit(0));
  await settle();
  assert(asyncDb.get(changed).vector[1] === 1 && asyncDb.get(changed).vector[0] === 0,
    "an older HTTP completion cannot overwrite the latest text vector");

  requests = [];
  const removed = insertNode(asyncDb, { type: "preference", text: "removed before completion" });
  deleteNode(asyncDb, removed);
  requests[0].resolve(unit(2));
  await settle();
  assert(asyncDb.getPayload(removed) == null, "late embedding does not resurrect a deleted fact");

  requests = [];
  const oldConfig = insertNode(asyncDb, { type: "preference", text: "old model request" });
  configureEmbedding({ embeddingModel: "replacement-model" });
  requests[0].resolve(unit(2));
  await settle();
  assert(asyncDb.get(oldConfig).vector.every(n => n === 0), "configuration revision invalidates old-model completions");

  requests = [];
  const lock = acquireWorkspaceLock(asyncCwd);
  try {
    assert(lock.ok, "embedding lock fixture owns the workspace");
    const held = insertNode(asyncDb, { type: "preference", text: "held write lock" });
    requests[0].resolve(unit(2));
    await settle();
    assert(asyncDb.get(held).vector.every(n => n === 0), "derived vector writes respect the workspace lock");
  } finally { lock.release(); }

  requests = [];
  const closedId = insertNode(asyncDb, { type: "preference", text: "closed handle pending" });
  closeAll();
  requests[0].resolve(unit(2));
  await settle();
  setTestEmbed(null);
  const reopened = await openWorkspaceDb(asyncCwd);
  assert(reopened.get(closedId).vector.every(n => n === 0), "closed handles invalidate pending embedding jobs");

  const batchCwd = join(asyncCwd, "batch");
  const batch = await openWorkspaceDb(batchCwd);
  for (let i = 0; i < 34; i++) insertNode(batch, { type: "preference", text: "batch fact " + i });
  insertNode(batch, { type: "episode", text: "session metadata must not be embedded" });
  let flushes = 0, vectors = 0;
  const flush = batch.flush.bind(batch), update = batch.updateVector.bind(batch);
  batch.flush = (...args) => { flushes++; return flush(...args); };
  batch.updateVector = (...args) => { vectors++; return update(...args); };
  setTestEmbed(() => unit(3));
  const filled = await backfillEmbeddings(batch);
  assert(filled.embedded === 34 && filled.failed === 0 && filled.skipped === 0 && vectors === 34 && flushes === 3,
    "34 business embeddings use three durable batches; workspace and episode metadata are excluded");
  closeAll();
  setTestEmbed(null);
  const durable = await openWorkspaceDb(batchCwd);
  assert(durable.allNodeIds().filter(id => durable.getPayload(id)?.type === "preference")
    .every(id => durable.get(id).vector[3] === 1), "batched vectors survive database reopen");
} catch (err) {
  failed += 1;
  console.error("FAIL exception " + (err && err.stack ? err.stack : err));
} finally {
  closeAll();
  setTestEmbed(null);
  configureEmbedding({});
  try {
    rmSync(cwd, { recursive: true, force: true });
    if (importCwd) rmSync(importCwd, { recursive: true, force: true });
    if (asyncCwd) rmSync(asyncCwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p5 ok");
