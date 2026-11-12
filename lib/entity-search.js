/** Explicit, read-only entity search. Never called by tools or automatic recall. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BUSINESS_EDGES, EDGE_LABELS, DIM } from "./schema.js";
import { currentHeadOf, makePayloadTextScorer } from "./store.js";
import { isStalePayload } from "./until.js";
import { payloadLooksDirty } from "./hygiene.js";
import { embedText, embeddingEnabled, embeddingRevision, normalizeVector } from "./embed.js";

export const ENTITY_SEARCH_LIMITS = Object.freeze({ nodes: 1000, edges: 10000, payloadBytes: 512 * 1024,
  responseBytes: 512 * 1024, cpuMs: 150, totalMs: 15000, queryBytes: 4096, limit: 20 });
const TYPES = new Set(["entity", "preference", "decision", "experience"]);
const SUPERSEDES = EDGE_LABELS.supersedes;

export function entitySearchError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function invalid(message) { throw entitySearchError(400, "ENTITY_SEARCH_INVALID", message); }

export function validateEntitySearch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) invalid("Expected a JSON object.");
  const allowed = new Set(["entityId", "query", "limit", "semantic"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid("Unknown entity search field: " + key);
  if (!Number.isSafeInteger(body.entityId) || body.entityId <= 0) invalid("entityId must be a positive safe integer.");
  if (typeof body.query !== "string" || !body.query.trim() || Buffer.byteLength(body.query, "utf8") > ENTITY_SEARCH_LIMITS.queryBytes) invalid("query must be non-empty text of at most 4096 UTF-8 bytes.");
  const limit = body.limit === undefined ? 5 : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENTITY_SEARCH_LIMITS.limit) invalid("limit must be 1..20 per channel.");
  if (Object.hasOwn(body, "semantic") && typeof body.semantic !== "boolean") invalid("semantic must be boolean.");
  return { entityId: body.entityId, query: body.query.trim(), limit, semantic: body.semantic === true };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function abortError() { return entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Entity search was cancelled."); }
function configError() { return entitySearchError(409, "ENTITY_SEARCH_EMBEDDING_CHANGED", "Embedding configuration changed; retry explicitly."); }
function nativeVector(value) {
  const vector = normalizeVector(value);
  return vector && vector.every(n => Number.isFinite(Math.fround(n))) && vector.some(n => Math.fround(n) !== 0) ? vector : null;
}

async function boundedEmbedding(provider, query, { signal, timeoutMs }) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timer, abort;
  try {
    const cancelled = new Promise((_resolve, reject) => { abort = () => { controller.abort(); reject(abortError()); }; signal?.addEventListener("abort", abort, { once: true }); });
    const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: "timeout", reason: "embedding_deadline", calls: 1 }); }, timeoutMs); });
    try { return await Promise.race([Promise.resolve().then(() => provider(query, { signal: controller.signal, timeoutMs })), timeout, cancelled]); }
    catch (error) {
      if (signal?.aborted || String(error?.code || "").startsWith("ENTITY_SEARCH_")) throw error;
      return { status: "failed", reason: "embedding_unavailable", calls: 1 };
    }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
}

/** One query only; explicit caller opt-in is checked by searchEntity(). */
export async function entityQueryEmbedding(query, { signal, timeoutMs = 15000, expectedRevision = embeddingRevision() } = {}) {
  if (signal?.aborted) throw abortError();
  if (embeddingRevision() !== expectedRevision) throw configError();
  if (!embeddingEnabled()) return { status: "disabled", reason: "embedding_disabled", calls: 0 };
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let timedOut = false;
    const timeout = new Promise(resolve => { timer = setTimeout(() => {
      timedOut = true; controller.abort(); resolve(null);
    }, Math.max(1, Math.min(15000, timeoutMs))); });
    const cancelled = new Promise(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const vector = await Promise.race([embedText(query, { query: true, signal: controller.signal, timeoutMs, maxResponseBytes: 65536 }), timeout, cancelled]);
    if (signal?.aborted) throw abortError();
    if (embeddingRevision() !== expectedRevision) throw configError();
    if (timedOut) return { status: "timeout", reason: "embedding_deadline", calls: 1 };
    const valid = nativeVector(vector);
    return valid ? { status: "ran", vector: valid, calls: 1 } : { status: "failed", reason: "embedding_unavailable_or_invalid", calls: 1 };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
}

function normalise(error) {
  if (String(error?.code || "").startsWith("ENTITY_SEARCH_")) return error;
  if (["TDB_DATABASE_CLOSED", "TDB_SHUTDOWN", "TDB_CONSOLE_SESSION_CLOSED"].includes(error?.code)) return entitySearchError(409, "ENTITY_SEARCH_UNAVAILABLE", "The selected database closed; retry explicitly.");
  if (["TDB_QUERY_BUDGET", "TDB_TRAVERSAL_BUDGET_EXCEEDED", "QueueFull"].includes(error?.code)) return entitySearchError(422, "ENTITY_SEARCH_WORK_LIMIT", "Entity search exceeded its work budget.");
  if (error?.code === "TDB_QUERY_CANCELLED") return entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Entity search exceeded its deadline.");
  return entitySearchError(500, "ENTITY_SEARCH_FAILED", "Entity search could not be completed.");
}

/** Options are host-owned dependencies. HTTP callers cannot override budgets. */
export async function searchEntity(db, body, options = {}) {
  const query = validateEntitySearch(body);
  const expectedEmbeddingRevision = embeddingRevision();
  const embedding = options.embedding || ((text, context) => entityQueryEmbedding(text, { ...context, expectedRevision: expectedEmbeddingRevision }));
  const clock = options.clock || (() => performance.now());
  const started = clock();
  const limits = Object.fromEntries(Object.entries(ENTITY_SEARCH_LIMITS).map(([key, value]) =>
    [key, Math.min(value, options.limits?.[key] ?? value)]));
  const totalMs = Math.min(limits.totalMs, options.remainingMs ?? limits.totalMs);
  const source = options.source || "live";
  const timeBasis = source === "snapshot" ? "snapshot-capture" : "query-time";
  const referenceTime = () => source === "snapshot" ? new Date(options.asOf) : (options.timeNow?.() || new Date());
  const seen = new Set();
  // cpuMs names the cooperative active-read wall window, not OS CPU accounting.
  const work = { examinedNodes: 0, payloadReads: 0, payloadBytes: 0, examinedEdges: 0, cpuMs: 0, embeddingCalls: 0 };
  let paused = 0;
  const check = () => {
    if (options.signal?.aborted) throw abortError();
    if (options.isCurrent && !options.isCurrent()) throw entitySearchError(409, "ENTITY_SEARCH_SOURCE_CHANGED", "The selected database instance changed; retry explicitly.");
    const elapsed = clock() - started;
    work.cpuMs = elapsed - paused;
    if (elapsed >= totalMs || work.cpuMs > limits.cpuMs) throw entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Entity search exceeded its execution window.");
  };
  const budget = () => { throw entitySearchError(422, "ENTITY_SEARCH_WORK_LIMIT", "Entity search exceeded its shared node, edge or payload budget."); };
  const visit = id => {
    if (!Number.isSafeInteger(id) || id <= 0) budget();
    seen.add(id); work.examinedNodes = seen.size;
    if (seen.size > limits.nodes) budget();
  };
  const edgeProbe = () => { if (++work.examinedEdges > limits.edges) budget(); check(); };
  const build = () => {
    check();
    const at = referenceTime();
    if (!Number.isFinite(at.getTime())) invalid("Invalid snapshot capture time.");
    const payloads = new Map(), revisions = new Map();
    const payloadOf = id => {
      visit(id); check();
      if (!payloads.has(id)) {
        const payload = db.getPayload(id);
        work.payloadReads++;
        work.payloadBytes += Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
        if (work.payloadBytes > limits.payloadBytes) budget();
        payloads.set(id, payload);
      }
      return payloads.get(id);
    };
    const traverse = (id, labels, direction, revision = false) => {
      check();
      const remaining = limits.edges - work.examinedEdges;
      if (remaining <= 0) budget();
      const output = db.reachableDetailed(id, { minDepth: 1, maxDepth: 1, direction, labels,
        maxVisitedNodes: limits.nodes + 1, maxResults: revision ? 2 : limits.nodes, maxEdges: remaining });
      check();
      if (!Array.isArray(output.results) || !Number.isSafeInteger(output.traversedEdges) || output.traversedEdges < 0 || output.traversedEdges > remaining) budget();
      work.examinedEdges += output.traversedEdges;
      if (output.truncated && !(revision && output.results.length >= 2)) budget();
      for (const row of output.results) visit(row.targetId);
      return output.results;
    };
    const links = (id, direction) => {
      const key = id + ":" + direction;
      if (!revisions.has(key)) {
        const ids = traverse(id, [SUPERSEDES], direction, true).map(row => row.targetId);
        edgeProbe(); if (db.getEdge(id, id, SUPERSEDES)) ids.push(id);
        revisions.set(key, ids);
      }
      return revisions.get(key);
    };
    const revisionDb = {
      get(id) { const payload = payloadOf(id); return payload ? { payload, edges: links(id, "outgoing").map(targetId => ({ targetId, label: SUPERSEDES })) } : null; },
      getIncomingEdges(id) { return links(id, "incoming").map(sourceId => ({ sourceId, targetId: id, label: SUPERSEDES })); },
      allNodeIds() { budget(); },
    };
    const anchor = payloadOf(query.entityId);
    if (!anchor) throw entitySearchError(404, "ENTITY_SEARCH_ENTITY_NOT_FOUND", "The selected entity does not exist.");
    if (anchor.type !== "entity") invalid("entityId must identify an entity.");
    if (anchor.status === "archived" || isStalePayload(anchor, at) || payloadLooksDirty(anchor)) throw entitySearchError(409, "ENTITY_SEARCH_ENTITY_UNAVAILABLE", "The selected entity is not currently available.");
    const paths = new Map([[query.entityId, { nodes: [String(query.entityId)], edges: [] }]]);
    const rows = traverse(query.entityId, [...BUSINESS_EDGES], "both");
    for (const row of rows) paths.set(row.targetId, { nodes: row.path.map(String), edges: row.steps.map(step => ({ from: String(step.from), to: String(step.to), label: step.label })) });
    const ids = [...paths.keys()].sort((a, b) => a - b);
    const raw = new Set(ids), eligible = new Set(), gaps = [];
    for (const id of ids) {
      const payload = payloadOf(id);
      if (!payload || !TYPES.has(payload.type) || payload.status === "archived" || isStalePayload(payload, at) || payloadLooksDirty(payload)) continue;
      const head = currentHeadOf(revisionDb, id);
      if (!head.ok) throw entitySearchError(422, "ENTITY_SEARCH_REVISION_INVALID", "The scope contains a revision chain requiring integrity review: " + head.reason);
      if (!raw.has(head.id)) { gaps.push({ code: "CURRENT_OUTSIDE_SCOPE", matchedId: String(id), currentId: String(head.id) }); continue; }
      const current = payloadOf(head.id);
      if (current && TYPES.has(current.type) && current.status !== "archived" && !isStalePayload(current, at) && !payloadLooksDirty(current)) eligible.add(head.id);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ ids, eligible: [...eligible].sort((a, b) => a - b),
      payloads: [...payloads].sort((a, b) => a[0] - b[0]), paths: [...paths].sort((a, b) => a[0] - b[0]), revisions: [...revisions].sort(), gaps }))).digest("hex");
    check();
    return { at, anchor, ids, eligible: [...eligible].sort((a, b) => a - b), paths, payloads, gaps, fingerprint };
  };
  try {
    const first = build();
    let semantic = { status: "not_requested", calls: 0 };
    const anchorOnly = first.eligible.length === 1 && first.eligible[0] === query.entityId;
    if (query.semantic && db.dim() !== DIM) semantic = { status: "failed", reason: "database_dimension_mismatch", calls: 0 };
    else if (query.semantic && first.eligible.length && !(anchorOnly && !String(first.anchor.text || "").trim())) {
      const remaining = Math.floor(totalMs - (clock() - started) - 300);
      if (remaining <= 0) throw entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Insufficient time remains for a semantic request.");
      const waiting = clock();
      try { semantic = await boundedEmbedding(embedding, query.query, { signal: options.signal, timeoutMs: remaining }); }
      finally { paused += clock() - waiting; }
    } else if (query.semantic) semantic = { status: "skipped", reason: "scope_anchor_only_or_empty", calls: 0 };
    if (!semantic || !["not_requested", "skipped", "disabled", "ran", "failed", "timeout", "configuration_changed"].includes(semantic.status)) semantic = { status: "failed", reason: "invalid_provider_result", calls: 1 };
    check();
    if (semantic.status === "configuration_changed") throw configError();
    // Rebuild after every asynchronous boundary; the first read never authorizes
    // late bodies, new relations, a replacement handle, or reused node IDs.
    let current;
    try { current = build(); }
    catch (error) {
      if (["ENTITY_SEARCH_ENTITY_NOT_FOUND", "ENTITY_SEARCH_ENTITY_UNAVAILABLE", "ENTITY_SEARCH_INVALID"].includes(error.code)) {
        throw entitySearchError(409, "ENTITY_SEARCH_SCOPE_CHANGED", "The selected entity changed while waiting; retry explicitly.");
      }
      throw error;
    }
    if (current.fingerprint !== first.fingerprint) throw entitySearchError(409, "ENTITY_SEARCH_SCOPE_CHANGED", "Entity scope or related content changed; retry explicitly.");
    work.embeddingCalls = semantic.calls || 0;
    const score = makePayloadTextScorer(query.query, current.at);
    const lexical = current.eligible.map(id => { check(); return { id, score: score(current.payloads.get(id)) }; })
      .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id - b.id);
    let semanticHits = [];
    if (semantic.status === "ran") {
      const vector = nativeVector(semantic.vector);
      if (!vector) semantic = { status: "failed", reason: "invalid_query_vector", calls: work.embeddingCalls };
      else if (current.eligible.length) {
        check();
        const hits = db.searchGraphFirst(vector, current.eligible, Math.min(query.limit + 1, current.eligible.length), limits.nodes);
        check();
        semanticHits = hits.filter(hit => Number.isFinite(hit.score) && hit.score >= .01);
        if (semanticHits.some(hit => !current.eligible.includes(hit.id))) throw entitySearchError(500, "ENTITY_SEARCH_SCOPE_VIOLATION", "Native results escaped the admitted scope.");
      }
    }
    const summary = (hit, kind) => {
      const payload = current.payloads.get(hit.id);
      return { id: String(hit.id), type: payload.type, name: payload.name || "", text: payload.text || "",
        until: payload.until || payload.untilAt || "", review: payload.review || "", score: hit.score, scoreKind: kind, path: current.paths.get(hit.id) };
    };
    const result = { ok: true, source, asOf: current.at.toISOString(), timeBasis, entityId: query.entityId,
      state: anchorOnly ? "scope_anchor_only" : lexical.length || semanticHits.length ? "candidates" : "no_candidates",
      answerability: "not_assessed", expanded: false,
      scope: { entityId: query.entityId, name: current.anchor.name || "", depth: 1, direction: "both", labels: [...BUSINESS_EDGES],
        rawCount: current.ids.length, eligibleCount: current.eligible.length, complete: true, coverage: "recorded_business_relations", fingerprint: current.fingerprint },
      textCandidates: lexical.slice(0, query.limit).map(hit => summary(hit, "lexical")),
      semanticCandidates: semanticHits.slice(0, query.limit).map(hit => summary(hit, "cosine")),
      channels: { text: { status: "ran", method: "payload-lexical", truncated: lexical.length > query.limit },
        semantic: { status: semantic.status, ...(semantic.reason ? { reason: semantic.reason } : {}), truncated: semanticHits.length > query.limit } },
      degraded: query.semantic && ["disabled", "failed", "timeout"].includes(semantic.status), warnings: current.gaps,
      limit: query.limit, work: { ...work, limits: { nodes: limits.nodes, edges: limits.edges, payloadBytes: limits.payloadBytes, cpuMs: limits.cpuMs } } };
    check(); result.work.cpuMs = work.cpuMs;
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.responseBytes) throw entitySearchError(413, "ENTITY_SEARCH_RESPONSE_TOO_LARGE", "Entity search response exceeded its byte budget.");
    check(); result.work.cpuMs = work.cpuMs;
    return result;
  } catch (error) {
    const failure = normalise(error);
    if (["ENTITY_SEARCH_WORK_LIMIT", "ENTITY_SEARCH_TIMEOUT", "ENTITY_SEARCH_RESPONSE_TOO_LARGE"].includes(failure.code)) failure.work = { ...work,
      limits: { nodes: limits.nodes, edges: limits.edges, payloadBytes: limits.payloadBytes, cpuMs: limits.cpuMs } };
    throw failure;
  }
}
