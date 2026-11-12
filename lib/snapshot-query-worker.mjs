// One request per process. Native parsing/query work never runs on the host's
// event loop; the parent can terminate this process even during a native call.
import engine from "triviumdb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeReadQuery } from "./read-query.js";

const { TriviumDB, ConsoleSession, ResourceRuntime, verifySnapshot } = engine;
let db;
let session;
let result;
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const runtime = new ResourceRuntime({ memoryLimitMb: 256, maxThreads: 2, maxActiveTasks: 1 });
  const manifest = verifySnapshot(request.directory, runtime);
  const dtype = manifest.dtype === "half::binary16::f16" ? "f16" : manifest.dtype;
  db = new TriviumDB(join(request.directory, "database.tdb"), {
    dim: manifest.dim,
    dtype,
    accessMode: "immutable",
    autoBuildQuiver: false,
    maxQueryRows: 1000,
    rowOverflow: "throw",
    runtime,
    memoryLimitMb: 128,
    payloadCacheMb: 16,
  });
  if (request.kind) {
    const { directory, asOf, timeBasis, timeoutMs, ...query } = request;
    result = { ...executeReadQuery(db, query, { source: "snapshot", asOf, timeBasis }),
      generationId: manifest.generation_id, timeoutMs };
  } else {
    session = new ConsoleSession(JSON.stringify({
      readOnly: true,
      features: ["query"],
      maxRequestBytes: 65536,
      maxResponseBytes: 500000,
      maxOperations: 1000,
      queryTimeoutMs: request.timeoutMs,
    }));
    const response = JSON.parse(db.consoleRequest(session, JSON.stringify({
      version: 1,
      requestId: "snapshot-query",
      command: { operation: "query", query: request.tql, parameters: request.params },
    })));
    const data = response.data;
    if (!data || !Array.isArray(data.rows)) throw new Error("Snapshot query returned no row data");
    result = {
      ok: true,
      source: "snapshot",
      generationId: manifest.generation_id,
      rows: data.rows.slice(0, request.limit),
      columns: data.columns,
      truncated: data.rows.length > request.limit,
      limit: request.limit,
      timeoutMs: request.timeoutMs,
    };
  }
} catch (err) {
  const code = err.code || "SNAPSHOT_QUERY_FAILED";
  result = {
    ok: false,
    code,
    message: String(err.message || err),
    status: err.status || (code === "TDB_CONSOLE_RESPONSE_TOO_LARGE" ? 413 : 400),
  };
} finally {
  try { session?.detach(); } catch {}
  try { db?.close(); } catch {}
}
const encoded = JSON.stringify(result);
if (Buffer.byteLength(encoded) > 524288) {
  process.stdout.write(JSON.stringify({ ok: false, code: "QUERY_RESPONSE_TOO_LARGE", message: "Snapshot query response is too large", status: 413 }));
} else process.stdout.write(encoded);
