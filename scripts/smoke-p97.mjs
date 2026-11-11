/** Native-validated live read caps preserve query semantics and explicit failures. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  executeLiveTql,
  LIVE_TQL_REQUEST_BYTES,
  LIVE_TQL_RESPONSE_BYTES,
} from "../lib/live-tql.js";

const require = createRequire(import.meta.url);
const { TriviumDB, ConsoleSession } = require("triviumdb");
const root = mkdtempSync(join(tmpdir(), "trivium-p97-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const handles = [];
const open = (name, options = {}) => {
  const db = new TriviumDB(join(root, `${name}.tdb`), { dim: 2, autoBuildQuiver: false, syncMode: "off", ...options });
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
const facts = (db) => JSON.stringify(db.allNodeIds().sort((a, b) => a - b).map((id) => db.get(id)));
function reference(db, tql, params = {}) {
  const session = new ConsoleSession(JSON.stringify({ readOnly: true, features: ["query"], maxOperations: 1000,
    maxResponseBytes: 32 * 1024 * 1024, queryTimeoutMs: 5000 }));
  try {
    return JSON.parse(db.consoleRequest(session, JSON.stringify({ version: 1, requestId: "reference",
      command: { operation: "query", query: tql, parameters: params } }))).data;
  } finally { session.detach(); }
}

try {
  const db = open("writer");
  const injection = 'literal" OR true RETURN n';
  for (const [id, type, name] of [
    [1, "entity", "AuthGateway"], [2, "entity", "RouteHub"], [3, "entity", "Isolated"],
    [4, "decision", "Header"], [5, "preference", "Locale"], [6, "decision", injection],
  ]) db.insertWithId(id, [1, 0], { type, name, rank: id });
  db.link(4, 1, "about", 1);
  db.link(1, 2, "about", 1);
  db.link(2, 1, "about", 1);

  check("the issue's original free JOIN runs on the writer with the default output contract", () => {
    const result = executeLiveTql(db, { tql: "MATCH (n)-[:about]->(hub) RETURN n, hub" });
    assert.equal(result.ok, true);
    assert.equal(result.source, "live");
    assert.equal(result.kind, "tql");
    assert.equal(result.limit, 200);
    assert.equal(result.timeoutMs, 25);
    assert.equal(result.rowCount, 3);
    assert.equal(Object.hasOwn(result, "nativeRowCount"), false);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.columns.map((column) => column.name), ["hub", "n"]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIVE_TQL_RESPONSE_BYTES);
  });
  check("native parameter binding preserves literal strings and supported scalar values", () => {
    const tql = "MATCH (n) WHERE n.name == $name RETURN n.id AS id";
    assert.deepEqual(executeLiveTql(db, { tql, params: { name: injection } }).rows, [{ id: 6 }]);
    assert.deepEqual(executeLiveTql(db, { tql, params: { name: 'missing" OR true RETURN n' } }).rows, []);
    for (const value of [null, true, "text", 2.5]) {
      const result = executeLiveTql(db, {
        tql: "MATCH (n) WHERE n.id == $id RETURN $value AS bound",
        params: { id: 1, value },
      });
      assert.deepEqual(result.rows, [{ bound: value }]);
    }
    rejects(() => executeLiveTql(db, { tql, params: { name: ["native binding rejects arrays"] } }),
      400, "LIVE_TQL_INVALID_INPUT");
  });
  check("aggregates consume complete native input even when the client wants one output row", () => {
    const result = executeLiveTql(db, { tql: "MATCH (n) RETURN COUNT(*) AS total", limit: 1 });
    assert.deepEqual(result.rows, [{ total: 6 }]);
    assert.equal(result.truncated, false);
    const grouped = executeLiveTql(db, {
      tql: "MATCH (n) RETURN n.type AS type, COUNT(*) AS total ORDER BY total DESC",
      limit: 1,
    });
    assert.deepEqual(grouped.rows, [{ total: 3, type: "entity" }]);
    assert.equal(grouped.truncated, true);
  });
  check("sorting finishes before client truncation and native LIMIT remains unchanged", () => {
    const sorted = executeLiveTql(db, { tql: "MATCH (n) RETURN n.id AS id ORDER BY id DESC", limit: 2 });
    assert.deepEqual(sorted.rows, [{ id: 6 }, { id: 5 }]);
    assert.equal(sorted.truncated, true);
    const explicit = executeLiveTql(db, { tql: "MATCH (n) RETURN n.id AS id LIMIT 1", limit: 5 });
    assert.equal(explicit.rows.length, 1);
    assert.equal(explicit.truncated, false);
  });
  check("documented native graph algorithms are accepted without a template allowlist", () => {
    const tql = 'FIND {type: "entity"} AS seed WITH seed K_CORE seed MODE INDUCED LABEL about AS scored WITH scored RETURN scored.name AS name, core_number(scored) AS core ORDER BY core DESC';
    const result = executeLiveTql(db, { tql, timeoutMs: 50 });
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows.find((row) => row.name === "AuthGateway").core, 1);
    assert.equal(result.rows.find((row) => row.name === "Isolated").core, 0);
  });
  check("write keywords inside a read literal do not trigger a hand-written filter", () => {
    const result = executeLiveTql(db, { tql: 'MATCH (n) WHERE n.id == 1 RETURN "CREATE SET DELETE DETACH" AS phrase' });
    assert.deepEqual(result.rows, [{ phrase: "CREATE SET DELETE DETACH" }]);
  });
  check("native-validated output caps match complete sorted, grouped, distinct and graph results", () => {
    const cases = [
      "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC",
      "MATCH (n) RETURN n.type AS type, COUNT(*) AS total ORDER BY total DESC, type ASC",
      "MATCH (n) RETURN DISTINCT n.type AS type ORDER BY type",
      'FIND {type: "entity"} AS seed WITH seed K_CORE seed MODE INDUCED LABEL about AS scored WITH scored RETURN scored.name AS name, core_number(scored) AS core ORDER BY core DESC, name ASC',
      "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC LIMIT 5 OFFSET 2",
      "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC OFFSET 2",
      "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC -- LIMIT 9999",
      "MATCH (n) -- LIMIT 9999\nRETURN n.rank AS rank ORDER BY rank DESC",
      "-- EXPLAIN LIMIT 9999\nMATCH (n) RETURN n.rank AS rank ORDER BY rank DESC",
      'MATCH (n) WHERE n.id == 1 RETURN "LIMIT 9999 -- is a literal" AS phrase',
    ];
    for (const tql of cases) {
      const expected = reference(db, tql).rows;
      const result = executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 });
      assert.deepEqual(result.rows, expected.slice(0, 1), tql);
      assert.equal(result.truncated, expected.length > 1, tql);
    }
  });
  check("EXPLAIN and EXPLAIN ANALYZE retain the original full-query plans", () => {
    for (const prefix of ["EXPLAIN", "-- a leading comment\nEXPLAIN"]) {
      const tql = `${prefix} MATCH (n) RETURN n.id AS id ORDER BY id DESC`;
      const expected = reference(db, tql);
      assert.deepEqual(executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 }).rows, expected.rows);
    }
    const tql = "EXPLAIN ANALYZE MATCH (n) RETURN n.id AS id ORDER BY id DESC";
    const result = executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 });
    const plan = JSON.stringify(result.rows);
    assert.equal(result.rowCount, 1);
    assert.equal(result.truncated, false);
    // Compare structural plans after dropping native timing measurements.
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/time|elapsed|duration/i.test(key)).map(([key, child]) => [key, stable(child)]));
      return value;
    };
    assert.deepEqual(stable(result.rows), stable(reference(db, tql).rows), plan);
  });
  check("invalid original syntax is rejected before any output-cap candidate can complete it", () => {
    for (const tql of ["MATCH (n) RETURN n LIMIT", "MATCH (n) RETURN n ORDER BY", "MATCH (n) -- RETURN n",
      "MATCH (n) RETURN n /* unsupported comment */", "MATCH (n) RETURN n RETURN n"]) {
      rejects(() => executeLiveTql(db, { tql, limit: 1 }), 400, "TDB_QUERY_PARSE");
    }
  });

  db.insertWithId(7, [1, 0], { type: "decision", name: "JustWritten", rank: 7 });
  const before = facts(db);
  check("the current writer's new fact is immediately visible without a snapshot", () => {
    const result = executeLiveTql(db, {
      tql: "MATCH (n) WHERE n.name == $name RETURN n.id AS id, n.name AS name",
      params: { name: "JustWritten" },
    });
    assert.deepEqual(result.rows, [{ id: 7, name: "JustWritten" }]);
  });
  check("native mutation syntax is rejected and the writer remains usable", () => {
    for (const tql of [
      'CREATE (n {name: "forbidden"})',
      'MATCH (n) SET n.name == "changed"',
      "MATCH (n) DELETE n",
      "MATCH (n) DETACH DELETE n",
      'MATCH (n) RETURN n; CREATE (m {name: "forbidden"})',
    ]) rejects(() => executeLiveTql(db, { tql }), 400, "TDB_QUERY_PARSE");
    assert.equal(facts(db), before);
    assert.equal(db.nodeCount(), 7);
  });
  check("unsupported request fields and invalid limits, deadlines and params fail explicitly", () => {
    const tql = "MATCH (n) RETURN n.id AS id";
    const circular = {}; circular.self = circular;
    for (const body of [
      null, [], {}, { tql: " " }, { tql: 5 }, { tql, kind: "nodes" }, { tql, query: "other" },
      { tql, operation: "mutate" }, { tql, params: [] }, { tql, params: null },
      { tql, params: { x: undefined } }, { tql, params: { x: NaN } },
      { tql, params: { x: Infinity } }, { tql, params: { x() {} } },
      { tql, params: { x: new Date() } }, { tql, params: circular },
      { tql, limit: 0 }, { tql, limit: 1001 }, { tql, limit: 1.5 }, { tql, limit: "1" },
      { tql, timeoutMs: 0 }, { tql, timeoutMs: 51 }, { tql, timeoutMs: 1.5 }, { tql, timeoutMs: "5" },
      JSON.parse('{"tql":"MATCH (n) RETURN n","__proto__":{}}'),
    ]) rejects(() => executeLiveTql(db, body), 400, "LIVE_TQL_INVALID_INPUT");
    const max = executeLiveTql(db, { tql, limit: 1000, timeoutMs: 50 });
    assert.equal(max.limit, 1000);
    assert.equal(max.timeoutMs, 50);
  });
  check("the entire JSON request has an inclusive 16 KiB byte cap", () => {
    const base = "MATCH (n) WHERE n.id == 1 RETURN n.id AS id";
    const spare = LIVE_TQL_REQUEST_BYTES - Buffer.byteLength(JSON.stringify({ tql: base }));
    const exact = { tql: base + " ".repeat(spare), timeoutMs: 50 };
    // The optional timeout also belongs to the cap.
    exact.tql = exact.tql.slice(0, exact.tql.length - (Buffer.byteLength(JSON.stringify(exact)) - LIVE_TQL_REQUEST_BYTES));
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), LIVE_TQL_REQUEST_BYTES);
    assert.deepEqual(executeLiveTql(db, exact).rows, [{ id: 1 }]);
    rejects(() => executeLiveTql(db, { ...exact, tql: exact.tql + " " }), 413, "LIVE_TQL_REQUEST_TOO_LARGE");
  });
  check("read execution and rejected requests leave all facts and edges unchanged", () => {
    assert.equal(facts(db), before);
  });
  check("missing and closed writers return explicit availability errors", () => {
    rejects(() => executeLiveTql(null, { tql: "MATCH (n) RETURN n" }), 409, "LIVE_TQL_UNAVAILABLE");
    const closed = open("closed"); closed.close();
    rejects(() => executeLiveTql(closed, { tql: "MATCH (n) RETURN n" }), 409, "TDB_DATABASE_CLOSED");
  });

  const large = open("large");
  for (let id = 1; id <= 2000; id++) large.insertWithId(id, [1, 0], { type: "entity", name: `node-${id}`, rank: id });
  check("native lookahead avoids the default row budget for a 2000-row unpaged read", () => {
    const result = executeLiveTql(large, { tql: "MATCH (n) RETURN n.id AS id", limit: 1, timeoutMs: 50 });
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.truncated, true);
  });
  check("a store over 1000 nodes has no admission gate and still supports bound point reads", () => {
    const result = executeLiveTql(large, {
      tql: "MATCH (n) WHERE n.name == $name RETURN n.id AS id",
      params: { name: "node-1100" },
      timeoutMs: 50,
    });
    assert.deepEqual(result.rows, [{ id: 1100 }]);
  });
  check("explicit native LIMIT cannot bypass the client's maximum 1000 returned rows", () => {
    const result = executeLiveTql(large, { tql: "MATCH (n) RETURN n.id AS id LIMIT 2000", limit: 1000, timeoutMs: 50 });
    assert.equal(result.rows.length, 1000);
    assert.equal(result.truncated, true);
  });
  check("a large full-input aggregate fails its native budget instead of returning a partial count", () => {
    rejects(() => executeLiveTql(large, {
      tql: "MATCH (n) RETURN COUNT(*) AS total LIMIT 1", limit: 1, timeoutMs: 50,
    }), 422, "TDB_QUERY_BUDGET");
    const result = executeLiveTql(large, {
      tql: "MATCH (n) WHERE n.rank > $min RETURN n.id AS id ORDER BY id DESC",
      params: { min: 1997 }, limit: 1, timeoutMs: 50,
    });
    assert.deepEqual(result.rows, [{ id: 2000 }]);
  });
  check("the native cooperative deadline is surfaced as an HTTP timeout", () => {
    const condition = Array.from({ length: 120 }, (_, index) => `n.rank == ${10000 + index}`).join(" OR ");
    assert.throws(() => executeLiveTql(large, { tql: `MATCH (n) WHERE ${condition} RETURN n.id AS id`, timeoutMs: 1 }),
      (error) => error.status === 408 && ["TDB_QUERY_CANCELLED", "LIVE_TQL_TIMEOUT"].includes(error.code));
  });
  check("completion checks reject a late synchronous result without pretending to interrupt it", () => {
    let returned = false;
    const slow = {
      prepareTql() {},
      consoleRequest() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        returned = true;
        return JSON.stringify({ version: 1, requestId: "live-tql", data: { rows: [], columns: [], rowCount: 0 } });
      },
    };
    rejects(() => executeLiveTql(slow, { tql: "MATCH (n) RETURN n", timeoutMs: 1 }), 408, "LIVE_TQL_TIMEOUT");
    assert.equal(returned, true, "the completion check runs after the synchronous operation returns");
  });
  check("native preparation time belongs to the total deadline", () => {
    let executed = false;
    const slowPrepare = {
      prepareTql() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); },
      consoleRequest() { executed = true; },
    };
    rejects(() => executeLiveTql(slowPrepare, { tql: "MATCH (n) RETURN n", timeoutMs: 1 }), 408, "LIVE_TQL_TIMEOUT");
    assert.equal(executed, false);
  });
  check("only a candidate parse failure may fall back, not resource or closed-instance errors", () => {
    for (const [code, status] of [["QueueFull", 429], ["TDB_DATABASE_CLOSED", 409]]) {
      let preparations = 0, executed = false;
      const unavailable = {
        prepareTql() { if (++preparations === 2) throw Object.assign(new Error(code), { code }); },
        consoleRequest() { executed = true; },
      };
      rejects(() => executeLiveTql(unavailable, { tql: "MATCH (n) RETURN n", timeoutMs: 50 }), status, code);
      assert.equal(executed, false);
    }
  });
  check("response-size retries are finite and other native errors are never retried", () => {
    for (const [code, status] of [["TDB_CONSOLE_RESPONSE_TOO_LARGE", 413], ["QueueFull", 429]]) {
      let executions = 0;
      const refused = {
        prepareTql() {},
        consoleRequest() { executions++; throw Object.assign(new Error(code), { code }); },
      };
      rejects(() => executeLiveTql(refused, { tql: "MATCH (n) RETURN n", limit: 1000, timeoutMs: 50 }), status, code);
      assert.ok(executions >= 1 && executions <= 6);
      if (code !== "TDB_CONSOLE_RESPONSE_TOO_LARGE") assert.equal(executions, 1);
    }
  });
  check("wide 585-node, 1536-dimension Issue JOIN works for small and default display limits", () => {
    const wide = open("wide", { dim: 1536 });
    const vector = new Array(1536).fill(0); vector[0] = 1;
    const hubs = [];
    for (let i = 0; i < 17; i++) hubs.push(wide.insert(vector, { type: "entity", name: `hub-${i}` }));
    for (let i = 0; i < 568; i++) {
      const id = wide.insert(vector, { type: "decision", name: `memory-${i}` });
      wide.link(id, hubs[i % hubs.length], "about");
    }
    const tql = "MATCH (n)-[:about]->(hub) RETURN n, hub";
    const expected = reference(wide, tql).rows;
    assert.equal(expected.length, 568);
    const small = executeLiveTql(wide, { tql, limit: 1, timeoutMs: 50 });
    assert.deepEqual(small.rows, expected.slice(0, 1));
    assert.equal(small.truncated, true);
    const usual = executeLiveTql(wide, { tql, limit: 200 });
    assert.ok(usual.rowCount > 0 && usual.rowCount <= 200);
    assert.deepEqual(usual.rows, expected.slice(0, usual.rowCount));
    assert.equal(usual.limit, 200);
    assert.equal(usual.truncated, true);
    assert.equal(usual.truncationReason, "response-byte-budget");
    const bytes = Buffer.byteLength(JSON.stringify(usual));
    assert.ok(bytes <= LIVE_TQL_RESPONSE_BYTES);
    console.log(`wide Issue JOIN: ${usual.rowCount} returned rows, ${bytes} bytes, limit ${usual.limit}`);
    assert.equal(wide.nodeCount(), 585);
  });

  check("native encoded-response budgeting rejects oversize results before any client slice", () => {
    const big = open("big-response");
    big.insertWithId(1, [1, 0], { type: "entity", text: "x".repeat(300000) });
    big.insertWithId(2, [1, 0], { type: "entity", text: "y".repeat(300000) });
    rejects(() => executeLiveTql(big, {
      tql: "MATCH (n) RETURN n.text AS text LIMIT 100", limit: 1, timeoutMs: 50,
    }), 413, "TDB_CONSOLE_RESPONSE_TOO_LARGE");
    const single = executeLiveTql(big, {
      tql: "MATCH (n) WHERE n.id == 1 RETURN n.text AS text", limit: 1, timeoutMs: 50,
    });
    assert.equal(single.rows[0].text.length, 300000);
    assert.ok(Buffer.byteLength(JSON.stringify(single)) <= LIVE_TQL_RESPONSE_BYTES);
    assert.equal(big.nodeCount(), 2);
  });
} finally {
  for (const db of handles) { try { db.close(); } catch { /* already closed */ } }
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}

console.log(`\nP97: ${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
