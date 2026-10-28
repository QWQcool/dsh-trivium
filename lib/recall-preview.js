/**
 * Read-only recall preview for the management UI.
 *
 * Answers "if this turn were injected now, what would be sent and why" without
 * writing to the database, running a tool, or asking for an embedding. With no
 * query vector the semantic channel is reported as `not_run` — it is never
 * simulated.
 */

import { formatHit, namedRecallHits, searchNodes } from "./store.js";
import { pinCandidates } from "./pins.js";
import { makeRevisionResolver } from "./revisions.js";
import {
  renderContextRecords,
  selectContextRecords,
  TURN_ADDITIONAL_BUDGET,
} from "./context-budget.js";
import { startTrace } from "./recall-trace.js";

/** A preview query is a probe, not a document. */
export const PREVIEW_QUERY_MAX = 500;

const FILTER_BY_DROP = {
  "over-budget": "budget",
  "duplicate-node": "duplicate",
  "duplicate-in-turn": "duplicate",
  "already-in-map": "duplicate",
  stale: "stale",
  archived: "archived",
  dirty: "hygiene",
  "no-current": "revision",
  empty: "hygiene",
};

function candidateOf(db, hit) {
  const row = formatHit(db, hit);
  return {
    id: row.id,
    type: row.type,
    l0: row.l0,
    until: row.until,
    stale: row.stale,
    path: row.path,
  };
}

function summaryNodes(db, ids) {
  return (ids || []).map((raw) => {
    const id = Number(raw);
    const payload = db.get(id)?.payload || {};
    return {
      id,
      type: payload.type || "unknown",
      l0: String(payload.text || payload.name || "").slice(0, 80),
    };
  });
}

/**
 * @returns `{ok:false, status, message}` for bad input, otherwise the plan, the
 *   real filter reasons and the exact text that would be sent.
 */
export function recallPreview(
  db,
  { cwd = "", sessionId = "", query = "", mode = "anchor", budget = TURN_ADDITIONAL_BUDGET } = {},
) {
  const text = String(query ?? "").trim();
  if (text.length > PREVIEW_QUERY_MAX) {
    return { ok: false, status: 400, message: `query must be <= ${PREVIEW_QUERY_MAX} characters` };
  }
  const trace = startTrace({ cwd, sessionId, query: text, mode, semantic: "not_run", source: "preview" });
  const onStage = (stage, ids) => trace.stage(stage, summaryNodes(db, ids));

  let hits = [];
  if (text) {
    hits =
      mode === "anchor"
        ? namedRecallHits(db, text, { topK: 8, onStage }).slice(0, 8)
        : searchNodes(db, text, { topK: 3, expandDepth: 1, includeStale: false, onStage }).slice(0, 3);
  }
  const resolveCurrent = makeRevisionResolver(db);
  const pins = sessionId ? pinCandidates(db, sessionId, { resolveRevision: resolveCurrent }) : [];
  const form = mode === "anchor" ? "anchorRecall" : "autoRecall";
  const plan = selectContextRecords({
    pins,
    recall: hits.map((hit) => candidateOf(db, hit)),
    // Passed through untouched: an explicit 0 is a real budget, not "use 300".
    budget,
    form,
    resolveCurrent,
  });
  for (const [dropReason, filterReason] of Object.entries(FILTER_BY_DROP)) {
    const ids = plan.dropped.filter((d) => d.reason === dropReason).map((d) => d.id);
    if (ids.length) trace.filter(filterReason, summaryNodes(db, ids));
  }
  trace.selected({ ids: plan.records.map((r) => r.id), budget: plan.budget, tokens: plan.tokens, deferred: plan.deferred });
  const recorded = trace.finish({ semantic: "not_run" });
  const rendered = renderContextRecords(plan, { form });

  return {
    ok: true,
    query: text,
    mode,
    // Honest label: the preview never requested a query vector.
    semantic: "not_run",
    traceId: recorded?.traceId || "",
    budget: plan.budget,
    tokens: plan.tokens,
    estimatedTokens: plan.tokens,
    candidates: hits.map((hit) => candidateOf(db, hit)),
    records: plan.records.map((r) => ({
      id: r.id,
      channel: r.channel,
      channels: r.channels,
      type: r.type,
      l0: r.l0,
      historical: r.historical === true,
      matchedHistory: r.matchedHistory || null,
      tokens: Number(r.tokens) || 0,
    })),
    dropped: plan.dropped,
    deferred: plan.deferred,
    text: {
      pins: rendered.pins.text,
      recall: rendered.recall.text,
      total: rendered.total,
    },
  };
}
