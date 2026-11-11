/** Issue #5: real native, bounded live reads never mutate the host's facts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  executeReadQuery,
  READ_QUERY_DEFAULT_LIMIT,
  READ_QUERY_MAX_NODES,
  READ_QUERY_MAX_RESPONSE_BYTES,
} from "../lib/read-query.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb");
const root = mkdtempSync(join(tmpdir(), "trivium-p93-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const handles = [];
const open = (name) => {
  const db = new TriviumDB(join(root, `${name}.tdb`), { dim: 2, autoBuildQuiver: false, syncMode: "off" });
  handles.push(db);
  return db;
};
let checks = 0;
let failures = 0;
function check(label, fn) {
  checks++;
  try { fn(); console.log(`ok ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error.stack || error.message}`); }
}
function rejects(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && error.code === code);
}
const ids = (result) => result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
const facts = (db) => JSON.stringify(db.allNodeIds().sort((a, b) => a - b).map((id) => db.get(id)));
const disk = () => Object.fromEntries(readdirSync(root).filter((name) => name.startsWith("main.tdb"))
  .sort().map((name) => {
    const path = join(root, name);
    // Windows may deny reading the writer's locked byte range. Its metadata is
    // still observable while the host retains the handle; unlocked files get a
    // full byte digest as well.
    const stat = statSync(path);
    let hash = null;
    try { hash = createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch (error) { if (error.code !== "EBUSY") throw error; }
    return [name, { size: stat.size, mtimeMs: stat.mtimeMs, hash }];
  }));

try {
  const db = open("main");
  const injectedName = 'x"} RETURN *; CREATE (n {name: "injected"})';
  const rows = [
    [1, "workspace", "workspace"],
    [2, "entity", "AuthGateway"],
    [3, "entity", "Policy"],
    [4, "entity", "OnlyWorkspace"],
    [5, "decision", "AuthHeader"],
    [6, "preference", "Language"],
    [7, "experience", "Retry"],
    [8, "entity", "OnlyNonBusiness"],
    [9, "entity", "SelfLinked"],
    [10, "entity", injectedName],
    [11, "decision", "TwoHopsAway"],
  ];
  for (const [id, type, name] of rows) {
    db.insertWithId(id, [1, 0], { type, name, text: `${name}: durable fact`, status: "active" });
    if (id !== 1) db.link(id, 1, "in_workspace", 1);
  }
  db.link(2, 3, "decided", 1);
  db.link(5, 2, "about", 1);
  db.link(7, 2, "fixed", 1);
  db.link(8, 3, "supersedes", 1);
  db.link(9, 9, "about", 1);
  db.link(3, 11, "about", 1);
  db.flush();
  const before = facts(db);
  const filesBefore = disk();

  check("default nodes query identifies live source, result limit and complete output", () => {
    const result = executeReadQuery(db, { kind: "nodes" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "live");
    assert.equal(result.kind, "nodes");
    assert.equal(result.limit, READ_QUERY_DEFAULT_LIMIT);
    assert.equal(result.rows.length, rows.length);
    assert.equal(result.truncated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_QUERY_MAX_RESPONSE_BYTES);
    assert.ok(result.rows.every((row) => !Object.hasOwn(row, "vector") && !Object.hasOwn(row, "edges")));
  });
  check("a requested result limit reports truncation", () => {
    const result = executeReadQuery(db, { kind: "nodes", limit: 2 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, true);
  });
  check("type and name are exact, bound query parameters", () => {
    assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", type: "entity", name: "AuthGateway" })), [2]);
    assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", type: "decision", name: "AuthGateway" })), []);
    assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", name: injectedName })), [10]);
    assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", name: 'missing" OR true RETURN n' })), []);
  });
  check("neighbors honor outgoing, incoming and both directions at exactly one hop", () => {
    assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, direction: "outgoing" })), [3]);
    assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, direction: "incoming" })), [5, 7]);
    assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2 })), [3, 5, 7]);
  });
  check("a business label narrows neighbors and result truncation stays explicit", () => {
    assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, label: "about" })), [5]);
    const limited = executeReadQuery(db, { kind: "neighbors", id: 2, limit: 1 });
    assert.equal(limited.rows.length, 1);
    assert.equal(limited.truncated, true);
  });
  check("orphan checks ignore workspace/revision edges and recognize self-links", () => {
    const result = executeReadQuery(db, { kind: "orphanEntities" });
    assert.deepEqual(ids(result), [4, 8, 10]);
    assert.equal(result.completeScan, true);
    assert.equal(result.scannedEntities, 6);
    assert.equal(result.truncated, false);
    const limited = executeReadQuery(db, { kind: "orphanEntities", limit: 1 });
    assert.equal(limited.rows.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal(limited.completeScan, true);
    assert.equal(limited.scannedEntities, 6);
  });
  check("a missing neighbor anchor is reported explicitly", () => {
    rejects(() => executeReadQuery(db, { kind: "neighbors", id: 9999 }), 404, "READ_QUERY_NODE_NOT_FOUND");
  });

  const invalidBodies = [
    null, [], "query", {}, { kind: "query" }, { kind: "mutate" },
    { kind: "nodes", query: "MATCH (n) RETURN n LIMIT 999999" },
    { kind: "nodes", tql: "CREATE (n {name: 'bad'})" },
    { kind: "nodes", parameters: {} }, { kind: "nodes", extra: true },
    { kind: "nodes", type: "unsupported" }, { kind: "nodes", type: null },
    { kind: "nodes", name: "" }, { kind: "nodes", name: {} },
    { kind: "nodes", name: "x".repeat(513) },
    { kind: "nodes", limit: 0 }, { kind: "nodes", limit: 1001 },
    { kind: "nodes", limit: "2" }, { kind: "nodes", limit: 1.5 },
    { kind: "neighbors", id: 0 }, { kind: "neighbors", id: -1 },
    { kind: "neighbors", id: "2" }, { kind: "neighbors", id: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "neighbors", id: 2, direction: "sideways" },
    { kind: "neighbors", id: 2, label: "in_workspace" },
    { kind: "neighbors", id: 2, label: "about]->(x) DELETE x" },
    { kind: "orphanEntities", type: "entity" },
    JSON.parse('{"kind":"nodes","__proto__":{}}'),
  ];
  check("invalid input, arbitrary TQL, writes and unknown fields are rejected", () => {
    for (const body of invalidBodies) {
      rejects(() => executeReadQuery(db, body), 400, "READ_QUERY_INVALID_INPUT");
    }
  });
  check("live reads preserve facts, relations and persisted file state", () => {
    assert.equal(facts(db), before);
    assert.deepEqual(disk(), filesBefore);
    assert.equal(readdirSync(root).some((name) => /usage|settings|home/.test(name)), false);
  });
  check("no handle and closed handles are explicit failures", () => {
    rejects(() => executeReadQuery(null, { kind: "nodes" }), 409, "READ_QUERY_UNAVAILABLE");
    const closed = open("closed");
    closed.close();
    rejects(() => executeReadQuery(closed, { kind: "nodes" }), 409, "READ_QUERY_UNAVAILABLE");
  });

  const large = open("large");
  for (let id = 1; id <= READ_QUERY_MAX_NODES + 1; id++) {
    large.insertWithId(id, [1, 0], { type: "entity", name: `entity-${id}` });
  }
  check("a large store is refused before a tiny result limit can hide its scan cost", () => {
    for (const body of [{ kind: "nodes", limit: 1 }, { kind: "neighbors", id: 1, limit: 1 }, { kind: "orphanEntities", limit: 1 }]) {
      rejects(() => executeReadQuery(large, body), 422, "READ_QUERY_WORK_LIMIT");
    }
    assert.equal(large.nodeCount(), READ_QUERY_MAX_NODES + 1);
  });
  check("native response budgeting rejects oversized payload output", () => {
    const big = open("big-response");
    big.insertWithId(1, [1, 0], { type: "entity", name: "large", text: "x".repeat(READ_QUERY_MAX_RESPONSE_BYTES + 1) });
    rejects(() => executeReadQuery(big, { kind: "nodes", limit: 1 }), 413, "READ_QUERY_RESPONSE_TOO_LARGE");
    assert.equal(big.nodeCount(), 1);
  });
  check("orphan projections span multiple bounded batches without losing truncation", () => {
    const batched = open("batched-orphans");
    for (let id = 1; id <= 130; id++) batched.insertWithId(id, [1, 0], { type: "entity", name: `orphan-${id}` });
    const result = executeReadQuery(batched, { kind: "orphanEntities", limit: 65 });
    assert.equal(result.rows.length, 65);
    assert.equal(new Set(result.rows.map((row) => row.id)).size, 65);
    assert.equal(result.scannedEntities, 130);
    assert.equal(result.completeScan, true);
    assert.equal(result.truncated, true);
  });
} finally {
  for (const db of handles) { try { db.close(); } catch { /* already closed */ } }
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nP93: ${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
