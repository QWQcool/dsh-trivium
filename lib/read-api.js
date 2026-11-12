/** Bounded HTTP transport for live reads and explicitly captured snapshots. */
import { resolve } from "node:path";
import { getActiveCwd, getOpenWorkspaceDb } from "./store.js";
import { executeReadQuery, READ_QUERY_MAX_RESPONSE_BYTES } from "./read-query.js";
import { executeLiveTql } from "./live-tql.js";
import { createReadSnapshot, getReadSnapshot, queryReadSnapshot } from "./read-snapshots.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { performance } from "node:perf_hooks";
import { searchEntity, validateEntitySearch, entityQueryEmbedding, entitySearchError, ENTITY_SEARCH_LIMITS } from "./entity-search.js";
import { searchEntitySnapshot } from "./entity-search-snapshot.js";
import { embeddingRevision } from "./embed.js";

export const READ_REQUEST_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 2000;

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function readJson(req, signal) {
  if (String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    req.resume();
    return Promise.reject(failure(415, "READ_CONTENT_TYPE", "Use application/json."));
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
      signal?.removeEventListener("abort", cancelled);
    };
    const error = (err) => { cleanup(); reject(err); };
    const aborted = () => error(failure(400, "READ_ABORTED", "Request aborted."));
    const cancelled = () => { error(entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Entity search request cancelled.")); req.resume(); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > READ_REQUEST_BYTES) {
        error(failure(413, "READ_REQUEST_TOO_LARGE", `Request exceeds ${READ_REQUEST_BYTES} bytes.`));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
        resolveBody(body);
      } catch {
        reject(failure(400, "READ_BAD_JSON", "Expected a JSON object."));
      }
    };
    const timer = setTimeout(() => {
      error(failure(408, "READ_BODY_TIMEOUT", "Request body deadline exceeded."));
      req.resume();
    }, BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", aborted);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

export function createReadApi(sendJson, { prepareEntitySearch } = {}) {
  let admitted = 0;
  const busy = new Set();
  return async (req, res, url) => {
    const path = url.pathname.replace(/\/$/, "");
    const query = path === "/api/dsh-trivium/query" && req.method === "POST";
    const snapshot = path === "/api/dsh-trivium/snapshots" && ["GET", "POST"].includes(req.method);
    const entitySearch = path === "/api/dsh-trivium/entity-search" && req.method === "POST";
    if (!query && !snapshot && !entitySearch) return false;
    let key;
    let ownsAdmission = false;
    let controller, timer, disconnect, timedOut = false;
    const started = performance.now();
    try {
      if (entitySearch && !url.searchParams.get("cwd")) throw entitySearchError(400, "ENTITY_SEARCH_WORKSPACE_REQUIRED", "Entity search requires an explicit cwd.");
      const cwd = url.searchParams.get("cwd") || getActiveCwd();
      if (!cwd || !getOpenWorkspaceDb(cwd)) {
        throw failure(409, "WORKSPACE_NOT_OPEN", "Open this workspace in the host first; read requests never open a database.");
      }
      key = resolve(cwd);
      if (admitted >= 2 || busy.has(key)) throw failure(429, "READ_BUSY", "Read capacity is busy; retry later.");
      admitted++;
      busy.add(key);
      ownsAdmission = true;
      const admittedDb = getOpenWorkspaceDb(key);
      if (entitySearch) {
        controller = new AbortController();
        disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", disconnect);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, ENTITY_SEARCH_LIMITS.totalMs);
      }
      const body = req.method === "POST" ? await readJson(req, controller?.signal) : {};
      const db = getOpenWorkspaceDb(key);
      if (!db) throw failure(409, "WORKSPACE_NOT_OPEN", "The workspace closed before the read started.");
      let result;
      if (entitySearch) {
        if (db !== admittedDb) throw entitySearchError(409, "ENTITY_SEARCH_SOURCE_CHANGED", "The database instance changed while reading the request.");
        const { snapshotId, ...input } = body;
        if (Object.hasOwn(body, "snapshotId") && (typeof snapshotId !== "string" || !snapshotId)) throw entitySearchError(400, "ENTITY_SEARCH_INVALID", "snapshotId must be a non-empty string.");
        const validated = validateEntitySearch(input);
        if (validated.semantic) prepareEntitySearch?.();
        const revision = embeddingRevision();
        const context = { signal: controller.signal, remainingMs: ENTITY_SEARCH_LIMITS.totalMs - (performance.now() - started),
          isCurrent: () => getOpenWorkspaceDb(key) === db,
          embedding: (text, options) => entityQueryEmbedding(text, { ...options, expectedRevision: revision }) };
        result = snapshotId ? await searchEntitySnapshot(key, snapshotId, validated, context) : await searchEntity(db, validated, context);
        if (getOpenWorkspaceDb(key) !== db) throw entitySearchError(409, "ENTITY_SEARCH_SOURCE_CHANGED", "The selected database closed or reopened; retry explicitly.");
        if (validated.semantic && embeddingRevision() !== revision) throw entitySearchError(409, "ENTITY_SEARCH_EMBEDDING_CHANGED", "Embedding configuration changed; retry explicitly.");
        if (controller.signal.aborted || performance.now() - started >= ENTITY_SEARCH_LIMITS.totalMs) throw entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Entity search exceeded its total deadline.");
        if (Buffer.byteLength(JSON.stringify({ ...result, cwd: key }), "utf8") > ENTITY_SEARCH_LIMITS.responseBytes) throw entitySearchError(413, "ENTITY_SEARCH_RESPONSE_TOO_LARGE", "Entity search response exceeded its byte budget.");
      } else if (query) {
        if (Object.hasOwn(body, "snapshotId")) {
          if (typeof body.snapshotId !== "string" || !body.snapshotId) throw failure(400, "READ_BAD_REQUEST", "snapshotId must be a nonempty string.");
          const { snapshotId, ...options } = body;
          result = await queryReadSnapshot(key, snapshotId, options);
        } else if (Object.hasOwn(body, "tql")) {
          result = executeLiveTql(db, body);
        } else result = executeReadQuery(db, body);
      } else if (req.method === "POST") {
        if (Object.keys(body).length) throw failure(400, "READ_BAD_REQUEST", "Snapshot creation accepts an empty object; the host chooses the destination.");
        const captured = await withWorkspaceLock(key, () => createReadSnapshot(db, key));
        if (captured.locked) throw failure(409, "WORKSPACE_WRITE_BUSY", "Workspace is writing; retry snapshot capture later.");
        result = { ok: true, source: "snapshot", ...captured.value };
      } else {
        result = { ok: true, source: "snapshot", ...getReadSnapshot(key, url.searchParams.get("snapshotId") || "latest") };
      }
      sendJson(res, 200, { ...result, cwd: key }, query || entitySearch ? READ_QUERY_MAX_RESPONSE_BYTES : Infinity);
    } catch (err) {
      if (entitySearch && (res.destroyed || res.writableEnded)) return true;
      const error = timedOut ? entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Entity search exceeded its total deadline.") : err;
      sendJson(res, Number.isInteger(error.status) ? error.status : 500, {
        ok: false,
        code: error.code || "READ_FAILED",
        message: String(error.message || error).slice(0, 500),
        ...(entitySearch && error.work ? { work: error.work } : {}),
      });
    } finally {
      clearTimeout(timer);
      if (disconnect) res.off("close", disconnect);
      if (ownsAdmission) { admitted--; busy.delete(key); }
    }
    return true;
  };
}
