/**
 * Recall traces: why did this turn get these memories?
 *
 * Only stages the plugin actually walked are recorded. 0.8.11 does not give a
 * per-hit BM25/vector breakdown, so nothing here invents contribution
 * percentages or calls a fused score a confidence. The trace says "native
 * hybrid returned candidates" and leaves it at that.
 *
 * Retention is deliberately small and in-memory: 20 traces per
 * workspace+session, 10 minute TTL, 64 KiB per trace, 100 node summaries per
 * stage. When a cap cuts data the trace says `truncated` instead of pretending
 * the list was complete.
 */

export const TRACE_LIMIT = 20;
export const TRACE_TTL_MS = 10 * 60 * 1000;
export const TRACE_MAX_BYTES = 64 * 1024;
export const TRACE_STAGE_NODE_LIMIT = 100;

export const TRACE_STAGES = Object.freeze({
  nativeHybrid: "native-hybrid",
  keywordFallback: "keyword-fallback",
  entityAnchor: "entity-anchor",
  businessExpand: "business-expand",
  sameAsNormalize: "same-as-normalize",
  revisionNormalize: "revision-normalize",
  deadlineScan: "deadline-scan",
});

export const FILTER_REASONS = Object.freeze({
  stale: "stale",
  archived: "archived",
  hygiene: "hygiene",
  budget: "budget",
  duplicate: "duplicate",
  revision: "revision",
});

/** traceId -> trace; insertion order is used as the age order. */
const traces = new Map();
const byBucket = new Map();
let traceSeq = 0;

function bucketKey(cwd, sessionId) {
  return `${cwd || ""}\u0000${sessionId || ""}`;
}

function pruneExpired(now = Date.now()) {
  for (const [id, trace] of traces) {
    if (now - trace.atMs > TRACE_TTL_MS) {
      traces.delete(id);
      const bucket = byBucket.get(trace.bucket);
      if (bucket) {
        bucket.delete(id);
        if (!bucket.size) byBucket.delete(trace.bucket);
      }
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function shorten(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Keep a stage's node list inside the per-stage cap. */
function capNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const mapped = list.slice(0, TRACE_STAGE_NODE_LIMIT).map((n) => ({
    id: Number(n.id ?? n),
    type: shorten(n.type ?? "", 24),
    l0: shorten(n.l0 ?? "", 80),
  }));
  return { nodes: mapped, truncated: list.length > TRACE_STAGE_NODE_LIMIT, total: list.length };
}

/**
 * Collect one recall decision. Call `finish()` once; it returns the stored trace
 * or null when there was nothing worth keeping.
 */
export function startTrace({ cwd = "", sessionId = "", query = "", mode = "auto", semantic = "not_run", source = "pre-step" } = {}) {
  const stages = [];
  const filters = [];
  let selection = { ids: [], budget: 0, tokens: 0, deferred: [] };
  let done = false;

  return {
    /** Record that a pipeline branch produced candidates. */
    stage(name, nodes) {
      if (!name) return;
      const existing = stages.find((s) => s.stage === name);
      const capped = capNodes(nodes);
      if (existing) {
        const merged = [...existing.nodes, ...capped.nodes].slice(0, TRACE_STAGE_NODE_LIMIT);
        existing.truncated = existing.truncated || capped.truncated || merged.length < existing.nodes.length + capped.nodes.length;
        existing.nodes = merged;
        existing.candidates = existing.nodes.length;
        return;
      }
      stages.push({
        stage: shorten(name, 40),
        candidates: capped.nodes.length,
        nodes: capped.nodes,
        truncated: capped.truncated,
        total: capped.total,
      });
    },

    /** Record nodes that were candidates and then excluded, with a real reason. */
    filter(reason, nodes) {
      if (!reason) return;
      const capped = capNodes(nodes);
      if (!capped.nodes.length) return;
      const existing = filters.find((f) => f.reason === reason);
      if (existing) {
        existing.nodes = [...existing.nodes, ...capped.nodes].slice(0, TRACE_STAGE_NODE_LIMIT);
        existing.truncated = existing.truncated || capped.truncated || existing.nodes.length < existing.total + capped.total;
        existing.total += capped.total;
        return;
      }
      filters.push({
        reason: shorten(reason, 40),
        nodes: capped.nodes,
        truncated: capped.truncated,
        total: capped.total,
      });
    },

    /** Record the final selection, including budget and deferrals. */
    selected({ ids = [], budget = 0, tokens = 0, deferred = [] } = {}) {
      selection = { ids: [...ids], budget: Number(budget) || 0, tokens: Number(tokens) || 0, deferred: [...deferred] };
    },

    /**
     * Store the trace. `semantic` may be settled only after the search ran, so
     * finish() accepts the final answer instead of trusting the constructor.
     */
    finish({ semantic: finalSemantic = semantic } = {}) {
      if (done) return null;
      done = true;
      return recordTrace({
        cwd,
        sessionId,
        query,
        mode,
        semantic: finalSemantic,
        source,
        stages,
        filters,
        selection,
      });
    },
  };
}

function recordTrace({ cwd, sessionId, query, mode, semantic, source, stages, filters, selection }) {
  pruneExpired();
  const bucket = bucketKey(cwd, sessionId);
  traceSeq += 1;
  const trace = {
    traceId: `t${Date.now().toString(36)}-${traceSeq.toString(36)}`,
    // Ties inside one millisecond are broken by insertion order, so "newest
    // first" stays deterministic even for a burst.
    seq: traceSeq,
    atMs: Date.now(),
    at: new Date().toISOString(),
    bucket,
    cwd: String(cwd || ""),
    sessionId: String(sessionId || ""),
    source: shorten(source, 24),
    mode: shorten(mode, 24),
    // No query vector means the semantic channel did not run; never imply it did.
    semantic: semantic === "ran" ? "ran" : "not_run",
    query: shorten(query, 500),
    stages,
    filters,
    selected: selection.ids,
    budget: selection.budget,
    tokens: selection.tokens,
    deferred: selection.deferred,
    truncated: stages.some((s) => s.truncated) || filters.some((f) => f.truncated),
  };

  // Shrink to the byte cap rather than dropping the trace: the reason codes are
  // the point, so drop the longest node lists first.
  let guard = 0;
  while (byteLength(trace) > TRACE_MAX_BYTES && guard < 20) {
    guard += 1;
    const stage = [...trace.stages].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    const filter = [...trace.filters].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    if (stage && stage.nodes.length > (filter?.nodes.length || 0)) {
      stage.nodes = stage.nodes.slice(0, Math.max(0, stage.nodes.length - 10));
      stage.candidates = stage.nodes.length;
      stage.truncated = true;
    } else if (filter && filter.nodes.length) {
      filter.nodes = filter.nodes.slice(0, Math.max(0, filter.nodes.length - 10));
      filter.truncated = true;
    } else {
      trace.query = shorten(trace.query, 80);
      trace.truncated = true;
    }
  }
  trace.bytes = byteLength(trace);

  traces.set(trace.traceId, trace);
  const bucketSet = byBucket.get(bucket) || new Set();
  bucketSet.add(trace.traceId);
  byBucket.set(bucket, bucketSet);
  while (bucketSet.size > TRACE_LIMIT) {
    const oldest = bucketSet.values().next().value;
    bucketSet.delete(oldest);
    traces.delete(oldest);
  }
  return trace;
}

/** Newest first, scoped to one workspace+session. */
export function listTraces({ cwd = "", sessionId = "", limit = TRACE_LIMIT } = {}) {
  pruneExpired();
  const ids = byBucket.get(bucketKey(cwd, sessionId));
  if (!ids) return [];
  const rows = [...ids]
    .map((id) => traces.get(id))
    .filter(Boolean)
    .sort((a, b) => b.atMs - a.atMs || b.seq - a.seq)
    .slice(0, Math.max(1, Math.min(TRACE_LIMIT, Number(limit) || TRACE_LIMIT)));
  return rows.map(summaryOf);
}

/**
 * Every trace for one workspace, newest first.
 *
 * Session isolation still holds: this only widens the query to "all sessions of
 * the same workspace", which is the one boundary the settings panel can name.
 */
export function listTracesForCwd({ cwd = "", limit = TRACE_LIMIT } = {}) {
  pruneExpired();
  const prefix = `${cwd || ""}\u0000`;
  const rows = [...traces.values()]
    .filter((trace) => trace.bucket.startsWith(prefix))
    .sort((a, b) => b.atMs - a.atMs || b.seq - a.seq)
    .slice(0, Math.max(1, Math.min(TRACE_LIMIT, Number(limit) || TRACE_LIMIT)));
  return rows.map(summaryOf);
}

/**
 * Fetch one trace. A trace from another workspace or session is reported as
 * missing, never returned — isolation does not depend on the caller's cwd.
 */
export function getTrace(traceId, { cwd = "", sessionId = "" } = {}) {
  pruneExpired();
  const trace = traces.get(String(traceId || ""));
  if (!trace) return { ok: false, status: 410, message: "trace expired or unknown" };
  if (trace.bucket !== bucketKey(cwd, sessionId)) {
    return { ok: false, status: 404, message: "not found" };
  }
  return { ok: true, trace };
}

function summaryOf(trace) {
  return {
    traceId: trace.traceId,
    at: trace.at,
    sessionId: trace.sessionId,
    source: trace.source,
    mode: trace.mode,
    semantic: trace.semantic,
    query: trace.query,
    stages: trace.stages.map((s) => ({ stage: s.stage, candidates: s.candidates, truncated: s.truncated })),
    filters: trace.filters.map((f) => ({ reason: f.reason, total: f.total, truncated: f.truncated })),
    selected: trace.selected,
    budget: trace.budget,
    tokens: trace.tokens,
    truncated: trace.truncated,
  };
}

export function resetTraces() {
  traces.clear();
  byBucket.clear();
}
