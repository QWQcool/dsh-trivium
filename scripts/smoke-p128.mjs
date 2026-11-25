/** #9: two native dimensions through the plugin and its local HTTP/worker path. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "trivium-dimensions-web-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ embeddingApiKey: "" }));
const [store, { registerMemoryApi }, settings, embed, { EDGE_LABELS }] = await Promise.all([
  import("../lib/store.js"), import("../lib/server.js"), import("../lib/settings.js"),
  import("../lib/embed.js"), import("../lib/schema.js"),
]);

const unit = n => { const values = new Array(n).fill(0); values[n - 1] = 1; return values; };
const calls = [];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
};
let mode = "strict";
let entered = deferred(), release = deferred(), sent = deferred();
const provider = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    const at = mode;
    if (at === "late") { entered.resolve(); await release.promise; }
    if (at === "strict" && Object.hasOwn(body, "dimensions")) {
      res.writeHead(400).end("This compatible service rejects the optional field.");
      return;
    }
    const width = at === "wrong" || at === "strict" ? 1024 : body.dimensions;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ embedding: unit(width) }] }));
    if (at === "late") sent.resolve();
  } catch { res.writeHead(500).end(); }
});
let web;
function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
async function bounded(promise) {
  const timer = new AbortController();
  try { return await Promise.race([promise, wait(5000, null, { signal: timer.signal }).then(() => { throw Error("fixture wait exceeded 5 seconds"); })]); }
  finally { timer.abort(); }
}
let count = 0;
async function check(label, fn) {
  await fn();
  ++count;
  console.log("ok " + label);
}
try {
  const endpoint = (await listen(provider)) + "/v1/embeddings";
  const options = { embeddingEnabled: false, embeddingUrl: endpoint, embeddingModel: "synthetic", embeddingApiKey: "" };
  const use = patch => embed.configureEmbedding(settings.writeUiSettings({ ...options, ...patch }));
  use({ embeddingDimensions: 1024 });
  const smallCwd = join(root, "small");
  const small = await store.openWorkspaceDb(smallCwd);
  use({ embeddingDimensions: 1536 });
  const largeCwd = join(root, "large");
  const large = await store.openWorkspaceDb(largeCwd);
  const seed = (db, suffix) => {
    const id = store.insertNode(db, { type: "entity", name: "Archive " + suffix, text: "Synthetic entity for " + suffix });
    const fact = store.insertNode(db, { type: "decision", name: "Archive window " + suffix, text: "The archive window uses cobalt in " + suffix });
    assert.equal(store.ensureLink(db, fact, id, EDGE_LABELS.about), true);
    db.flush();
    return { id, fact };
  };
  const sm = seed(small, "small");
  const lg = seed(large, "large");
  const req = (row, query = "cobalt") => ({ entityId: row.id, query, semantic: true });
  assert.equal(small.dim(), 1024);
  assert.equal(large.dim(), 1536);

  let handler;
  registerMemoryApi({ webServer: { register(config) { handler = config.handler; return () => {}; } } },
    { liveOptions() { const options = settings.readUiSettings(); embed.configureEmbedding(options); return options; }, status: {} });
  web = createServer((request, response) => handler(request, response));
  const base = (await listen(web)) + "/api/dsh-trivium";
  const request = async (route, cwd, body) => {
    const response = await fetch(base + route + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""),
      body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, result: await response.json() };
  };

  await check("real Web status distinguishes each active native dimension from the new-library default", async () => {
    const a = await request("/status", smallCwd), b = await request("/status", largeCwd);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.result.databaseDimensions, 1024); assert.equal(b.result.databaseDimensions, 1536);
    assert.equal(a.result.embeddingDimensions, 1536);
    assert.equal(a.result.embeddingRequestDimensions, false);
    const bad = await request("/settings", null, { embeddingDimensions: "1024" });
    assert.equal(bad.status, 400);
    assert.equal(bad.result.code, "DB_DIMENSION_INVALID");
    assert.equal(settings.readUiSettings().embeddingDimensions, 1536);
  });

  await check("a strict OpenAI-compatible endpoint still works with the 1024 width and no optional field", async () => {
    use({ embeddingEnabled: true });
    const start = calls.length;
    const v = await store.embedQueryVector("strict query", small);
    assert.deepEqual(v, unit(1024));
    assert.equal(Object.hasOwn(calls[start], "dimensions"), false);
    assert.equal(await store.embedQueryVector("same endpoint, other library", large), null);
    assert.equal(Object.hasOwn(calls[start + 1], "dimensions"), false);
  });

  await check("explicitly dimensional requests backfill the right vectors concurrently in each database", async () => {
    mode = "normal";
    const saved = await request("/settings", null, { embeddingRequestDimensions: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.result.embeddingRequestDimensions, true);
    embed.configureEmbedding(settings.readUiSettings());
    const start = calls.length;
    const [a, b] = await Promise.all([store.backfillEmbeddings(small), store.backfillEmbeddings(large)]);
    assert.deepEqual([a.embedded, a.failed, b.embedded, b.failed], [2, 0, 2, 0]);
    assert.deepEqual(calls.slice(start).map(c => c.dimensions).sort((x, y) => x - y), [1024, 1024, 1536, 1536]);
    assert.equal(small.get(sm.fact).vector.at(-1), 1);
    assert.equal(large.get(lg.fact).vector.at(-1), 1);
  });

  await check("live and verified snapshot entity routes use their own width, even with the other cwd active", async () => {
    const snapA = await request("/snapshots", smallCwd, {}), snapB = await request("/snapshots", largeCwd, {});
    assert.equal(snapA.status, 200); assert.equal(snapB.status, 200);
    assert.equal(snapA.result.dim, 1024); assert.equal(snapB.result.dim, 1536);
    for (const [cwd, other, row, snap, width] of [
      [smallCwd, largeCwd, sm, snapA.result, 1024], [largeCwd, smallCwd, lg, snapB.result, 1536],
    ]) {
      store.setActiveCwd(other);
      for (const snapshotId of [undefined, snap.snapshotId]) {
        const result = await request("/entity-search", cwd, { ...req(row), ...(snapshotId ? { snapshotId } : {}) });
        assert.equal(result.status, 200);
        assert.equal(result.result.channels.semantic.status, "ran");
        assert.ok(result.result.semanticCandidates.some(candidate => candidate.id === String(row.fact)));
        assert.equal(result.result.source, snapshotId ? "snapshot" : "live");
        assert.equal(calls.at(-1).dimensions, width);
      }
    }
  });

  await check("a provider returning the other width cannot corrupt storage or bypass lexical fallback", async () => {
    mode = "wrong";
    const before = [...large.get(lg.fact).vector];
    const r = await request("/entity-search", largeCwd, req(lg));
    assert.equal(r.status, 200);
    assert.equal(r.result.channels.semantic.reason, "database_dimension_mismatch");
    assert.deepEqual(r.result.semanticCandidates, []);
    assert.equal(r.result.textCandidates[0].id, String(lg.fact));
    const backfill = await store.backfillEmbeddings(large);
    assert.deepEqual([backfill.embedded, backfill.failed], [0, 2]);
    assert.deepEqual([...large.get(lg.fact).vector], before);
    mode = "normal";
  });

  await check("snapshot publication width is checked against verified native manifest before any provider call", async () => {
    const snap = await request("/snapshots", smallCwd, {});
    assert.equal(snap.status, 200);
    const file = join(snap.result.directory, "..", snap.result.snapshotId + ".json");
    const previous = readFileSync(file);
    const n = calls.length;
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(previous), dim: 1536 }));
      const response = await request("/entity-search", smallCwd, { ...req(sm), snapshotId: snap.result.snapshotId });
      assert.equal(response.status, 409);
      assert.equal(response.result.code, "ENTITY_SEARCH_SNAPSHOT_CHANGED");
      assert.equal(calls.length, n);
    } finally { writeFileSync(file, previous); }
  });

  await check("a late query after configuration changes yields no vector", async () => {
    mode = "late";
    const old = store.embedQueryVector("old generation", small);
    await bounded(entered.promise);
    embed.configureEmbedding({ ...settings.readUiSettings(), embeddingModel: "new-synthetic-model" });
    release.resolve();
    assert.equal(await bounded(old), null);
    await bounded(sent.promise);
    mode = "normal";
  });

  await check("a late background response cannot land in a reopened handle or previous content", async () => {
    use({ embeddingEnabled: true });
    entered = deferred(); release = deferred(); sent = deferred();
    mode = "late";
    const pending = store.insertNode(small, { type: "decision", name: "Pending late", text: "Payload before reopening" });
    await bounded(entered.promise);
    store.closeWorkspaceDb(smallCwd, small);
    assert.equal(store.getOpenWorkspaceDb(smallCwd), null);
    const reopened = await store.openWorkspaceDb(smallCwd);
    assert.equal(reopened.dim(), 1024);
    assert.notEqual(reopened, small);
    // Keep the same provider revision: only the handle can fence the old write.
    reopened.updatePayload(pending, { ...reopened.getPayload(pending), text: "Payload after reopening" });
    reopened.flush();
    release.resolve();
    await bounded(sent.promise);
    await wait(50);
    assert.match(reopened.getPayload(pending).text, /after reopening/);
    assert.ok(reopened.get(pending).vector.every(value => value === 0));
    mode = "normal";
  });
  console.log("P128: " + count + "/" + count);
} finally {
  release.resolve();
  embed.configureEmbedding({ embeddingEnabled: false, embeddingApiKey: "" });
  await close(web); await close(provider);
  store.closeAll();
  rmSync(root, { force: true, recursive: true });
}
