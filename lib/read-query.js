/** Bounded, named reads on a handle already owned by the host. */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { BUSINESS_EDGES, NODE_TYPES } from "./schema.js";

const require = createRequire(import.meta.url);

export const READ_QUERY_DEFAULT_LIMIT = 200;
export const READ_QUERY_MAX_LIMIT = 1000;
export const READ_QUERY_MAX_NODES = 1000;
export const READ_QUERY_MAX_EDGES = 10000;
export const READ_QUERY_MAX_RESPONSE_BYTES = 512 * 1024;
export const READ_QUERY_NATIVE_TIMEOUT_MS = 50;
const REQUEST_TIMEOUT_MS = 150;
const REQUEST_BYTES = 64 * 1024;
const KINDS = new Set(["nodes", "neighbors", "orphanEntities"]);
const TYPES = new Set(NODE_TYPES);
const LABELS = new Set(BUSINESS_EDGES);
const PROJECTION = "n.id AS id, n.type AS type, n.name AS name, n.text AS text, n.status AS status, n.uri AS uri, n.until AS until, n.aliases AS aliases";

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function invalid(message) {
  throw failure(400, "READ_QUERY_INVALID_INPUT", message);
}

function workLimit() {
  return failure(422, "READ_QUERY_WORK_LIMIT", "The live read work budget was exceeded. Query an independent snapshot instead.");
}

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    invalid("The query body must be an object.");
  }
  if (!KINDS.has(body.kind)) invalid("kind must be nodes, neighbors or orphanEntities.");
  const allowed = new Set(["kind", "limit", ...(body.kind === "nodes" ? ["type", "name"]
    : body.kind === "neighbors" ? ["id", "direction", "label"] : [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`Unknown query field: ${key}.`);
  const has = (key) => Object.hasOwn(body, key);
  const limit = has("limit") ? body.limit : READ_QUERY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_QUERY_MAX_LIMIT) {
    invalid(`limit must be an integer between 1 and ${READ_QUERY_MAX_LIMIT}.`);
  }
  if (body.kind === "nodes") {
    if (has("type") && !TYPES.has(body.type)) invalid("type must be a supported node type.");
    if (has("name") && (typeof body.name !== "string" || !body.name.trim()
        || Buffer.byteLength(body.name, "utf8") > 512)) {
      invalid("name must be non-empty text of at most 512 UTF-8 bytes.");
    }
  }
  if (body.kind === "neighbors") {
    if (!Number.isSafeInteger(body.id) || body.id <= 0) invalid("id must be a positive safe integer.");
    if (has("direction") && !["both", "incoming", "outgoing"].includes(body.direction)) {
      invalid("direction must be both, incoming or outgoing.");
    }
    if (has("label") && !LABELS.has(body.label)) invalid("label must be a business edge label.");
  }
  return { ...body, limit };
}

function normaliseError(error) {
  if (error?.status && String(error.code || "").startsWith("READ_QUERY_")) return error;
  if (error?.code === "TDB_QUERY_CANCELLED") {
    return failure(408, "READ_QUERY_TIMEOUT", "The live read exceeded its native deadline.");
  }
  if (["TDB_QUERY_BUDGET", "TDB_TRAVERSAL_BUDGET_EXCEEDED", "QueueFull"].includes(error?.code)) {
    return workLimit();
  }
  if (error?.code === "TDB_CONSOLE_RESPONSE_TOO_LARGE") {
    return failure(413, "READ_QUERY_RESPONSE_TOO_LARGE", "The live query response exceeds 512 KiB. Use a smaller limit or a snapshot.");
  }
  if (["TDB_DATABASE_CLOSED", "TDB_SHUTDOWN", "TDB_CONSOLE_SESSION_CLOSED"].includes(error?.code)) {
    return failure(409, "READ_QUERY_UNAVAILABLE", "The host database is unavailable for this read.");
  }
  return failure(500, "READ_QUERY_FAILED", "The live query could not be completed.");
}

/**
 * No arbitrary TQL, index creation, lazy database open, usage update or model call.
 *
 * A full-store node admission bound is deliberate: LIMIT only caps output in
 * triviumdb 0.9.0, and can override its default row budget. The fixed templates
 * below therefore run only after bounding the entire possible scan. Traversals
 * additionally have a shared edge budget; an incomplete orphan check is an
 * error, never an apparently complete list of isolated entities.
 */
export function executeReadQuery(db, body) {
  const query = validate(body);
  const started = performance.now();
  let session;
  try {
    if (!db || typeof db.nodeCount !== "function" || typeof db.consoleRequest !== "function") {
      throw failure(409, "READ_QUERY_UNAVAILABLE", "An already-open host database is required.");
    }
    const nodeCount = db.nodeCount();
    if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || nodeCount > READ_QUERY_MAX_NODES) throw workLimit();
    const { ConsoleSession } = require("triviumdb");
    session = new ConsoleSession(JSON.stringify({
      readOnly: true,
      features: ["query"],
      maxOperations: READ_QUERY_MAX_NODES,
      maxRequestBytes: REQUEST_BYTES,
      maxResponseBytes: READ_QUERY_MAX_RESPONSE_BYTES,
      queryTimeoutMs: READ_QUERY_NATIVE_TIMEOUT_MS,
    }));
    let requests = 0;
    let examinedEdges = 0;
    const checkTime = () => {
      if (performance.now() - started > REQUEST_TIMEOUT_MS) {
        throw failure(408, "READ_QUERY_TIMEOUT", "The live read exceeded its bounded execution window.");
      }
    };
    const read = (text, parameters = {}) => {
      checkTime();
      const raw = db.consoleRequest(session, JSON.stringify({
        version: 1,
        requestId: `read-${++requests}`,
        command: { operation: "query", query: text, parameters },
      }));
      checkTime();
      const rows = JSON.parse(raw)?.data?.rows;
      if (!Array.isArray(rows)) throw new Error("Invalid native query response");
      return rows;
    };
    const traverse = (id, { direction = "both", labels = BUSINESS_EDGES, firstOnly = false } = {}) => {
      checkTime();
      const remaining = READ_QUERY_MAX_EDGES - examinedEdges;
      if (remaining <= 0) throw workLimit();
      const output = db.reachableDetailed(id, {
        minDepth: 1,
        maxDepth: 1,
        direction,
        labels,
        maxVisitedNodes: READ_QUERY_MAX_NODES + 1,
        maxResults: firstOnly ? 1 : READ_QUERY_MAX_NODES,
        maxEdges: remaining,
      });
      checkTime();
      if (!Array.isArray(output.results) || !Number.isSafeInteger(output.traversedEdges)
          || output.traversedEdges < 0 || output.traversedEdges > remaining) throw workLimit();
      examinedEdges += output.traversedEdges;
      // Finding one neighbour proves non-isolation even if a result cap stopped
      // this probe; finding none proves isolation only after a complete probe.
      if (output.truncated && !(firstOnly && output.results.length > 0)) throw workLimit();
      return output.results.map((row) => row.targetId);
    };
    const readIds = (ids) => {
      if (!ids.length) return [];
      // The complete graph probe above establishes truncation/isolated status.
      // Only then read the payload projection we can actually return. Keep
      // expression depth and aggregate response allocation bounded as well.
      const wanted = ids.slice(0, query.limit + 1);
      const rows = [];
      let bytes = 0;
      for (let offset = 0; offset < wanted.length; offset += 64) {
        const parameters = {};
        const where = wanted.slice(offset, offset + 64).map((id, index) => {
          if (!Number.isSafeInteger(id) || id <= 0) throw workLimit();
          parameters[`id${index}`] = id;
          return `n.id == $id${index}`;
        }).join(" OR ");
        const batch = read(`MATCH (n) WHERE ${where} RETURN ${PROJECTION}`, parameters);
        bytes += Buffer.byteLength(JSON.stringify(batch), "utf8");
        if (bytes > READ_QUERY_MAX_RESPONSE_BYTES) {
          throw failure(413, "READ_QUERY_RESPONSE_TOO_LARGE", "The live query response exceeds 512 KiB. Use a smaller limit or a snapshot.");
        }
        rows.push(...batch);
      }
      return rows;
    };
    let candidates;
    const extra = {};
    if (query.kind === "nodes") {
      const conditions = [];
      const parameters = {};
      for (const field of ["type", "name"]) {
        if (Object.hasOwn(query, field)) {
          conditions.push(`n.${field} == $${field}`);
          parameters[field] = query[field];
        }
      }
      const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
      const count = Math.min(query.limit + 1, READ_QUERY_MAX_NODES);
      candidates = read(`MATCH (n)${where} RETURN ${PROJECTION} LIMIT ${count}`, parameters);
    } else if (query.kind === "neighbors") {
      if (!read("MATCH (n) WHERE n.id == $id RETURN n.id AS id", { id: query.id }).length) {
        throw failure(404, "READ_QUERY_NODE_NOT_FOUND", "The requested node does not exist.");
      }
      const direction = query.direction || "both";
      const labels = query.label ? [query.label] : BUSINESS_EDGES;
      const ids = traverse(query.id, { direction, labels });
      candidates = readIds(ids);
      Object.assign(extra, { id: query.id, direction, labels: [...labels] });
    } else {
      const entities = read("MATCH (n) WHERE n.type == $type RETURN n.id AS id", { type: "entity" });
      const isolated = [];
      for (const entity of entities) {
        const id = Number(entity.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw workLimit();
        checkTime();
        let hasSelfLink = false;
        for (const label of BUSINESS_EDGES) {
          if (++examinedEdges > READ_QUERY_MAX_EDGES) throw workLimit();
          if (db.getEdge(id, id, label)) { hasSelfLink = true; break; }
        }
        if (!hasSelfLink && traverse(id, { firstOnly: true }).length === 0) isolated.push(id);
      }
      candidates = readIds(isolated);
      extra.scannedEntities = entities.length;
      extra.completeScan = true;
    }
    checkTime();
    const result = {
      ok: true,
      source: "live",
      kind: query.kind,
      rows: candidates.slice(0, query.limit),
      truncated: candidates.length > query.limit,
      limit: query.limit,
      ...extra,
      work: { nodeCount, maxNodes: READ_QUERY_MAX_NODES, examinedEdges, maxEdges: READ_QUERY_MAX_EDGES },
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > READ_QUERY_MAX_RESPONSE_BYTES) {
      throw failure(413, "READ_QUERY_RESPONSE_TOO_LARGE", "The live query response exceeds 512 KiB. Use a smaller limit or a snapshot.");
    }
    return result;
  } catch (error) {
    throw normaliseError(error);
  } finally {
    session?.detach();
  }
}
