import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReadQuery } from "./read-query.js";

const require = createRequire(import.meta.url);
const WORKER = fileURLToPath(new URL("./snapshot-query-worker.mjs", import.meta.url));
const ID = /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 524288;
const MAX_REQUEST_BYTES = 65536;
let activeQueries = 0;

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function directory(path, { create = false } = {}) {
  if (create && !existsSync(path)) mkdirSync(path);
  let stat;
  try { stat = lstatSync(path); }
  catch (err) {
    if (err.code === "ENOENT") throw fail("SNAPSHOT_NOT_FOUND", "Read snapshot directory does not exist", 404);
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail("SNAPSHOT_PATH_INVALID", "Read snapshots must use real directories");
  for (let current = dirname(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw fail("SNAPSHOT_PATH_INVALID", "Snapshot paths must not contain symbolic links");
    if (dirname(current) === current) break;
  }
  return realpathSync(path);
}

function snapshotRoot(cwd, create = false) {
  const workspace = directory(resolve(cwd));
  const dsh = directory(join(workspace, ".dsh"), { create });
  return directory(join(dsh, "read-snapshots"), { create });
}

function jsonFile(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (err) {
    if (err.code === "ENOENT") throw fail("SNAPSHOT_NOT_FOUND", "Read snapshot is not published", 404);
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16384) {
    throw fail("SNAPSHOT_INVALID", "Invalid snapshot metadata", 409);
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected metadata object");
    return value;
  }
  catch { throw fail("SNAPSHOT_INVALID", "Invalid snapshot metadata JSON", 409); }
}

function publishJson(path, data) {
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Do not unlink an existing pointer on failure: the last valid publication
    // must survive a failed replacement, including on Windows.
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

/** Called under the host's workspace write-operation lock; never opens a writer. */
export function createReadSnapshot(db, cwd) {
  const root = snapshotRoot(cwd, true);
  const snapshotId = `snapshot-${randomUUID()}`;
  const target = join(root, snapshotId);
  db.createSnapshot(target, snapshotId);
  const { verifySnapshot } = require("triviumdb");
  const manifest = verifySnapshot(target);
  if (!manifest.complete || manifest.generation_id !== snapshotId) {
    throw fail("SNAPSHOT_INVALID", "Captured snapshot did not verify", 409);
  }
  const metadata = {
    snapshotId,
    generationId: manifest.generation_id,
    directory: target,
    createdAt: new Date().toISOString(),
    nodeCount: manifest.node_count,
    dim: manifest.dim,
    dtype: manifest.dtype,
  };
  publishJson(join(root, `${snapshotId}.json`), metadata);
  publishJson(join(root, "latest.json"), { snapshotId });
  return metadata;
}

/** Resolve only a published ID under this workspace, never a caller's path. */
export function getReadSnapshot(cwd, snapshotId = "latest") {
  const root = snapshotRoot(cwd);
  const id = snapshotId === "latest" ? jsonFile(join(root, "latest.json")).snapshotId : snapshotId;
  if (typeof id !== "string" || !ID.test(id)) throw fail("SNAPSHOT_ID_INVALID", "Invalid read snapshot ID");
  const metadata = jsonFile(join(root, `${id}.json`));
  if (metadata.snapshotId !== id || metadata.generationId !== id
    || !Number.isSafeInteger(metadata.nodeCount) || metadata.nodeCount < 0
    || typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt))) {
    throw fail("SNAPSHOT_INVALID", "Snapshot publication metadata does not match its ID", 409);
  }
  const target = directory(join(root, id));
  // Recompute the directory; serialized paths are never used for access.
  // This is a publication record, not a fresh CRC health check. Verification
  // before executing TQL belongs to the bounded worker, not the host thread.
  return { ...metadata, directory: target, integrity: "verified-at-capture" };
}

function integer(value, fallback, max, key) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw fail("QUERY_INVALID", `${key} must be an integer from 1 to ${max}`);
  }
  return value;
}

function queryBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (!Object.hasOwn(body, "kind") && (typeof body.tql !== "string" || !body.tql.trim() || Buffer.byteLength(body.tql) > 16384))) {
    throw fail("QUERY_INVALID", "Provide a named query or non-empty tql of at most 16384 bytes");
  }
  if (Object.hasOwn(body, "kind")) {
    const { timeoutMs, ...named } = body;
    return { ...validateReadQuery(named), timeoutMs: integer(timeoutMs, 2000, 10000, "timeoutMs") };
  }
  const allowed = new Set(["tql", "params", "limit", "timeoutMs"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw fail("QUERY_INVALID", "Unknown snapshot query field");
  const params = body.params === undefined ? {} : body.params;
  if (typeof params !== "object" || Array.isArray(params) || params === null) {
    throw fail("QUERY_INVALID", "params must be a JSON object");
  }
  const request = {
    tql: body.tql,
    params,
    limit: integer(body.limit, 200, 1000, "limit"),
    timeoutMs: integer(body.timeoutMs, 2000, 10000, "timeoutMs"),
  };
  let encoded;
  try { encoded = JSON.stringify(request); }
  catch { throw fail("QUERY_INVALID", "Query parameters must be JSON serializable"); }
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw fail("QUERY_TOO_LARGE", "Snapshot query request is too large", 413);
  return request;
}

/** Isolated query execution for an explicitly selected directory (also used by CLI). */
export async function querySnapshotDirectory(path, body, context = {}) {
  const request = queryBody(body);
  const target = directory(resolve(path));
  if (activeQueries >= 2) throw fail("QUERY_BUSY", "Snapshot query workers are busy; retry later", 429);
  activeQueries += 1;
  try {
    return await new Promise((done, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=256", WORKER], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let bytes = 0;
      let stderrBytes = 0;
      const chunks = [];
      let failure;
      const stop = (err) => {
        if (!failure) failure = err;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(fail("QUERY_TIMEOUT", "Snapshot query exceeded its wall-clock deadline", 504)), request.timeoutMs);
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) stop(fail("QUERY_RESPONSE_TOO_LARGE", "Snapshot query response is too large", 413));
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) stop(fail("QUERY_WORKER_FAILED", "Snapshot query worker emitted too much diagnostic output", 500));
      });
      child.on("error", (err) => { failure ||= fail("QUERY_WORKER_FAILED", err.message, 500); });
      child.stdin.on("error", () => {}); // Early rejection/timeout can close stdin.
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0) return reject(fail("QUERY_WORKER_FAILED", "Snapshot query worker terminated unexpectedly", 500));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!result.ok) return reject(fail(result.code || "QUERY_FAILED", result.message || "Snapshot query failed", result.status || 400));
          return done(result);
        } catch { return reject(fail("QUERY_WORKER_FAILED", "Invalid snapshot query worker response", 500)); }
      });
      child.stdin.end(JSON.stringify({ directory: target, ...request, asOf: context.asOf, timeBasis: context.timeBasis }));
    });
  } finally {
    activeQueries -= 1;
  }
}

export async function queryReadSnapshot(cwd, snapshotId = "latest", body) {
  const snapshot = getReadSnapshot(cwd, snapshotId);
  const result = await querySnapshotDirectory(snapshot.directory, body, { asOf: snapshot.createdAt, timeBasis: "snapshot-capture" });
  if (result.generationId !== snapshot.generationId) throw fail("SNAPSHOT_INVALID", "Snapshot generation does not match its publication", 409);
  return { ...result, snapshotId: snapshot.snapshotId, createdAt: snapshot.createdAt };
}
