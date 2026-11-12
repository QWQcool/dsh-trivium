/** Bounded, named reads on a handle already owned by the host. */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { BUSINESS_EDGES, NODE_TYPES, EDGE_LABELS } from "./schema.js";

import { currentHeadOf } from "./store.js";
import { isStalePayload } from "./until.js";

const require = createRequire(import.meta.url);

export const READ_QUERY_DEFAULT_LIMIT = 200;
export const READ_QUERY_MAX_LIMIT = 1000;
export const READ_QUERY_MAX_NODES = 1000;
export const READ_QUERY_MAX_EDGES = 10000;
export const READ_QUERY_MAX_RESPONSE_BYTES = 512 * 1024;
export const READ_QUERY_NATIVE_TIMEOUT_MS = 50;
const REQUEST_TIMEOUT_MS = 150;
const REQUEST_BYTES = 64 * 1024;
const KINDS = new Set(["nodes", "currentFacts", "neighbors", "orphanEntities"]);
const TYPES = new Set(NODE_TYPES);
const FACT_TYPES = new Set(["entity", "preference", "decision", "experience"]);
const LABELS = new Set(BUSINESS_EDGES);
const PROJECTION = "n.id AS id, n.type AS type, n.name AS name, n.text AS text, n.status AS status, n.uri AS uri, n.until AS until, n.aliases AS aliases";

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function invalid(message) {
  throw failure(400, "READ_QUERY_INVALID_INPUT", message);
}

function workLimit() {
  return failure(422, "READ_QUERY_WORK_LIMIT", "The named read work budget was exceeded. Narrow the name or relationship scope; snapshots retain these limits.");
}

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    invalid("The query body must be an object.");
  }
  if (!KINDS.has(body.kind)) invalid("kind must be currentFacts, nodes, neighbors or orphanEntities.");
  const allowed = new Set(["kind", "limit", ...(["nodes", "currentFacts"].includes(body.kind) ? ["type", "name"]
    : body.kind === "neighbors" ? ["id", "direction", "label"] : ["name", "currentOnly"])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`Unknown query field: ${key}.`);
  const has = (key) => Object.hasOwn(body, key);
  const limit = has("limit") ? body.limit : READ_QUERY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_QUERY_MAX_LIMIT) {
    invalid(`limit must be an integer between 1 and ${READ_QUERY_MAX_LIMIT}.`);
  }
  if (["nodes", "currentFacts", "orphanEntities"].includes(body.kind)) {
    if (has("type") && !(body.kind === "currentFacts" ? FACT_TYPES : TYPES).has(body.type)) invalid("type must be a supported node type.");
    if (has("name") && (typeof body.name !== "string" || !body.name.trim()
        || Buffer.byteLength(body.name, "utf8") > 512)) {
      invalid("name must be non-empty text of at most 512 UTF-8 bytes.");
    }
  }
  if (has("currentOnly") && typeof body.currentOnly !== "boolean") invalid("currentOnly must be boolean.");
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
 * Raw nodes retain the legacy whole-store bound. Named business selectors use
 * payload projections, bounded candidates and native one-hop traversal so a
 * small neighbourhood is usable in a larger workspace. Native queries retain
 * their deadline; candidate visits do not measure internal engine scan work.
 * An incomplete orphan check is an error, never a complete-looking empty list.
 */
export function validateReadQuery(body) { return validate(body); }

export function executeReadQuery(db, body, { source = "live", asOf = new Date().toISOString(), timeBasis = "query-time" } = {}) {
  const query = validate(body);
  const now = new Date(asOf);
  if (!Number.isFinite(now.getTime())) invalid("Invalid query reference time.");
  const started = performance.now();
  let session;
  try {
    if (!db || typeof db.nodeCount !== "function" || typeof db.consoleRequest !== "function") {
      throw failure(409, "READ_QUERY_UNAVAILABLE", "An already-open host database is required.");
    }
    const nodeCount = db.nodeCount();
    if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || (query.kind === "nodes" && nodeCount > READ_QUERY_MAX_NODES)) throw workLimit();
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
    const visited = new Set();
    const payloads = new Map();
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
    const traverse = (id, { direction = "both", labels = BUSINESS_EDGES, firstOnly = false, revision = false } = {}) => {
      checkTime();
      const remaining = READ_QUERY_MAX_EDGES - examinedEdges;
      if (remaining <= 0) throw workLimit();
      const output = db.reachableDetailed(id, {
        minDepth: 1,
        maxDepth: 1,
        direction,
        labels,
        maxVisitedNodes: READ_QUERY_MAX_NODES + 1,
        maxResults: revision ? 2 : firstOnly ? 1 : READ_QUERY_MAX_NODES,
        maxEdges: remaining,
      });
      checkTime();
      if (!Array.isArray(output.results) || !Number.isSafeInteger(output.traversedEdges)
          || output.traversedEdges < 0 || output.traversedEdges > remaining) throw workLimit();
      examinedEdges += output.traversedEdges;
      // Finding one neighbour proves non-isolation even if a result cap stopped
      // this probe; finding none proves isolation only after a complete probe.
      if (output.truncated && !(firstOnly && output.results.length > 0) && !(revision && output.results.length >= 2)) throw workLimit();
      return output.results.map((row) => row.targetId);
    };
    const visit = (id) => {
      if (!Number.isSafeInteger(id) || id <= 0) throw workLimit();
      if (!visited.has(id) && visited.size >= READ_QUERY_MAX_NODES) throw workLimit();
      visited.add(id);
    };
    const payloadOf = (id) => {
      visit(id); checkTime();
      if (!payloads.has(id)) payloads.set(id, db.getPayload(id));
      return payloads.get(id);
    };
    const summary = (id) => {
      const payload = payloadOf(id);
      if (!payload) return null;
      return { id: String(id), type: payload.type ?? null, name: payload.name ?? null,
        text: payload.text ?? null, status: payload.status ?? null, uri: payload.uri ?? null,
        until: payload.until ?? null, aliases: payload.aliases ?? null };
    };
    const outgoing = new Map(), incoming = new Map();
    const revisionLinks = (id, direction) => {
      const cache = direction === "incoming" ? incoming : outgoing;
      if (!cache.has(id)) {
        const ids = traverse(id, { direction, labels: [EDGE_LABELS.supersedes], revision: true });
        if (++examinedEdges > READ_QUERY_MAX_EDGES) throw workLimit();
        // Native reachability excludes its source; a self-loop is still a
        // malformed revision chain and must reach currentHeadOf's cycle guard.
        if (db.getEdge(id, id, EDGE_LABELS.supersedes)) ids.push(id);
        cache.set(id, ids);
      }
      return cache.get(id);
    };
    const revisionDb = {
      get(id) {
        const payload = payloadOf(id);
        return payload ? { payload, edges: revisionLinks(id, "outgoing").map(targetId =>
          ({ label: EDGE_LABELS.supersedes, targetId })) } : null;
      },
      getIncomingEdges(id) {
        return revisionLinks(id, "incoming").map(sourceId => ({ sourceId, targetId: id, label: EDGE_LABELS.supersedes }));
      },
      allNodeIds() { throw workLimit(); },
    };
    const current = (id) => {
      const payload = payloadOf(id);
      if (!payload || !FACT_TYPES.has(payload.type) || payload.status === "archived" || isStalePayload(payload, now)) return false;
      const head = currentHeadOf(revisionDb, id);
      if (!head.ok) throw failure(422, "READ_QUERY_REVISION_INVALID", "The revision chain needs integrity review: " + head.reason);
      return head.id === id;
    };
    const readIds = (ids) => ids.slice(0, query.limit + 1).map(summary).filter(Boolean);
    let candidates;
    const extra = {};
    if (query.kind === "currentFacts") {
      const conditions = ["(" + [...FACT_TYPES].map((_, i) => "n.type == $type" + i).join(" OR ") + ")"];
      const parameters = Object.fromEntries([...FACT_TYPES].map((type, i) => ["type" + i, type]));
      for (const field of ["type", "name"]) if (Object.hasOwn(query, field)) {
        conditions.push("n." + field + " == $" + field); parameters[field] = query[field];
      }
      candidates = [];
      let offset = 0, complete = false;
      while (candidates.length <= query.limit) {
        const size = Math.min(64, READ_QUERY_MAX_NODES - visited.size);
        if (size <= 0) throw workLimit();
        const page = read("MATCH (n) WHERE " + conditions.join(" AND ") + " RETURN n.id AS id LIMIT " + size + " OFFSET " + offset, parameters);
        for (const row of page) visit(Number(row.id));
        for (const row of page) {
          const id = Number(row.id);
          if (current(id)) candidates.push({ ...summary(id), review: payloadOf(id).review || "" });
          if (candidates.length > query.limit) break;
        }
        offset += page.length;
        if (page.length < size) { complete = candidates.length <= query.limit; break; }
      }
      extra.completeScan = complete;
    } else if (query.kind === "nodes") {
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
      if (!payloadOf(query.id)) {
        throw failure(404, "READ_QUERY_NODE_NOT_FOUND", "The requested node does not exist.");
      }
      const direction = query.direction || "both";
      const labels = query.label ? [query.label] : BUSINESS_EDGES;
      const ids = traverse(query.id, { direction, labels });
      candidates = readIds(ids);
      for (const row of candidates) {
        row.relationships = [];
        for (const label of labels) {
          const pairs = direction === "outgoing" ? [[query.id, Number(row.id)]]
            : direction === "incoming" ? [[Number(row.id), query.id]] : [[query.id, Number(row.id)], [Number(row.id), query.id]];
          for (const [from, to] of pairs) {
            if (++examinedEdges > READ_QUERY_MAX_EDGES) throw workLimit();
            checkTime();
            if (db.getEdge(from, to, label)) row.relationships.push({ from: String(from), to: String(to), label });
          }
        }
      }
      Object.assign(extra, { id: query.id, direction, labels: [...labels] });
    } else {
      const params = { type: "entity" };
      const where = query.name ? " AND n.name == $name" : "";
      if (query.name) params.name = query.name;
      const entities = read("MATCH (n) WHERE n.type == $type" + where + " RETURN n.id AS id LIMIT " + (READ_QUERY_MAX_NODES + 1), params);
      if (entities.length > READ_QUERY_MAX_NODES) throw workLimit();
      const isolated = [];
      for (const entity of entities) {
        const id = Number(entity.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw workLimit();
        visit(id);
        if (query.currentOnly && !current(id)) continue;
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
      source,
      asOf: now.toISOString(),
      timeBasis,
      kind: query.kind,
      rows: candidates.slice(0, query.limit),
      truncated: candidates.length > query.limit,
      limit: query.limit,
      ...extra,
      work: { nodeCount, examinedNodes: visited.size, maxNodes: READ_QUERY_MAX_NODES, examinedEdges, maxEdges: READ_QUERY_MAX_EDGES },
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
