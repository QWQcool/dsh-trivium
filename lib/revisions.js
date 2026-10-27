/**
 * Revision relations between decisions.
 *
 * A decision does not expire when a newer one replaces it — it becomes
 * historical. That is a separate axis from `until`, so it gets its own edge
 * label and its own resolver instead of overloading `include_stale`.
 *
 * First version is a linear chain: one direct predecessor and one direct
 * successor per node, confirmed by a human in the management UI. The edge is
 * `successor --supersedes--> predecessor`, and it is never part of the default
 * business-edge expansion, or every recall would drag the whole history along.
 */

import { createHash } from "node:crypto";
import { EDGE_LABELS, REVISION_EDGES } from "./schema.js";
import { incomingLabeled } from "./store.js";
import { isStalePayload } from "./until.js";
import { provenanceOf } from "./provenance.js";

/** Hard cap on how far a chain walk may travel before refusing. */
export const REVISION_WALK_LIMIT = 32;

const SUPERSEDES = EDGE_LABELS.supersedes;

/** Reason text shown to the model when it tries to write a revision relation. */
export function refuseModelRevisionLabel(label) {
  const value = String(label || "");
  if (!REVISION_EDGES.includes(value)) return "";
  return `Refused: "${value}" is confirmed by the user in the dsh-trivium management UI, not by a tool call. Ask the user to link the two decisions there.`;
}

function outgoingOf(db, id, label) {
  const node = db.get(Number(id));
  return (node?.edges || [])
    .filter((e) => String(e.label) === label)
    .map((e) => Number(e.targetId ?? e.target_id))
    .filter((n) => Number.isFinite(n));
}

/** The node that supersedes this one (the newer decision), or null. */
export function successorOf(db, id) {
  const rows = incomingLabeled(db, Number(id), [SUPERSEDES]);
  return rows.length ? Number(rows[0].from) : null;
}

/** The node this one supersedes (the older decision), or null. */
export function predecessorOf(db, id) {
  const rows = outgoingOf(db, id, SUPERSEDES);
  return rows.length ? rows[0] : null;
}

/**
 * Walk forward to the current head.
 *
 * Returns `{ok:false, reason}` instead of a partial answer when the walk hits a
 * cycle or exceeds the hop limit — an incomplete "current version" is worse
 * than an explicit refusal.
 */
export function currentHeadOf(db, id, limit = REVISION_WALK_LIMIT) {
  let current = Number(id);
  const seen = new Set();
  for (let hops = 0; hops < limit; hops += 1) {
    if (seen.has(current)) return { ok: false, reason: "cycle", id: null, hops };
    seen.add(current);
    const next = successorOf(db, current);
    if (next == null) return { ok: true, id: current, hops };
    current = next;
  }
  return { ok: false, reason: "too-long", id: null, hops: limit };
}

/**
 * Revision state for one node.
 *
 * `current` and `superseded` are independent of `expired`: the UI shows them as
 * two labels and the user filters them separately.
 */
export function revisionStateOf(db, id) {
  const head = currentHeadOf(db, id);
  if (!head.ok) {
    return { ok: false, reason: head.reason, currentId: null, superseded: null, hops: head.hops };
  }
  return {
    ok: true,
    currentId: head.id,
    superseded: head.id !== Number(id),
    hops: head.hops,
  };
}

/**
 * Resolver for context selection.
 *
 * Returns `{currentId, archived, stale}` for the head of this node's chain, or
 * null when the chain cannot be resolved — selection then drops the candidate
 * rather than injecting a guess.
 */
export function makeRevisionResolver(db) {
  return (id) => {
    const state = revisionStateOf(db, id);
    if (!state.ok) return null;
    const payload = db.get(state.currentId)?.payload || {};
    return {
      currentId: state.currentId,
      archived: payload.status === "archived",
      stale: isStalePayload(payload),
    };
  };
}

/**
 * Opaque entity tag over the content and the revision neighbours.
 *
 * Two browser windows that both edited through this value cannot silently
 * overwrite each other: the second request re-reads inside the workspace queue
 * and compares.
 */
export function etagOf(db, id) {
  const node = db.get(Number(id));
  if (!node) return "";
  const payload = node.payload || {};
  const parts = [
    Number(id),
    payload.type,
    payload.name,
    payload.text,
    payload.until,
    payload.untilAt,
    payload.status,
    successorOf(db, id) ?? "",
    predecessorOf(db, id) ?? "",
  ];
  return createHash("sha1").update(parts.map((v) => String(v ?? "")).join("\u0000")).digest("hex").slice(0, 16);
}

/** Expiry is its own axis: `expired`, `active` (has a deadline), or `none`. */export function expiryStateOf(payload, now) {
  if (!payload?.until && !payload?.untilAt) return "none";
  return isStalePayload(payload, now instanceof Date ? now : undefined) ? "expired" : "active";
}

/**
 * `GET /nodes/:id/detail` payload.
 *
 * Full bodies, quotes and history stay behind their own endpoints; this is the
 * small header the list and the detail pane need.
 */
export function nodeDetail(db, id) {
  const node = db.get(Number(id));
  if (!node) return null;
  const payload = node.payload || {};
  const revision = revisionStateOf(db, id);
  const source = provenanceOf(db, id);
  return {
    ok: true,
    id: Number(id),
    summary: {
      type: payload.type || "unknown",
      name: String(payload.name || ""),
      l0: String(payload.text || payload.name || "").slice(0, 200),
      status: payload.status || "active",
    },
    expiryState: expiryStateOf(payload),
    // `unresolved` means the chain did not resolve; the UI must not claim a
    // current version in that case.
    revisionState: revision.ok ? (revision.superseded ? "superseded" : "current") : "unresolved",
    revisionError: revision.ok ? "" : revision.reason,
    currentId: revision.ok ? revision.currentId : null,
    sourceAvailable: source?.status === "recorded",
    sourceStatus: source?.status || "missing",
    etag: etagOf(db, id),
  };
}

/**
 * `GET /nodes/:id/history` payload.
 *
 * Newest first, one page at a time, and short summaries only — the full body of
 * an old version is fetched by reading that node. `relation` carries the reason
 * and time recorded when the link was confirmed, which lives on the successor
 * payload because 0.8.11 edges have no property bag.
 */
export function historyOf(db, id, { limit = 20, cursor = "" } = {}) {
  const head = currentHeadOf(db, id);
  if (!head.ok) {
    return { ok: false, reason: head.reason, nodes: [], nextCursor: null, truncated: false };
  }
  const order = [];
  const seen = new Set();
  let current = head.id;
  while (current != null && !seen.has(current) && order.length < REVISION_WALK_LIMIT) {
    seen.add(current);
    order.push(current);
    current = predecessorOf(db, current);
  }
  const size = Math.max(1, Math.min(50, Number(limit) || 20));
  const offset = Math.max(0, Number(cursor) || 0);
  const page = order.slice(offset, offset + size);
  const nodes = page.map((nodeId) => {
    const payload = db.get(nodeId)?.payload || {};
    const revision = payload.revision && typeof payload.revision === "object" ? payload.revision : null;
    return {
      id: nodeId,
      type: payload.type || "unknown",
      name: String(payload.name || ""),
      l0: String(payload.text || payload.name || "").slice(0, 160),
      status: payload.status || "active",
      expiryState: expiryStateOf(payload),
      isCurrent: nodeId === head.id,
      isRequested: nodeId === Number(id),
      relation: revision
        ? {
            supersedes: Number(revision.supersedes) || null,
            reason: String(revision.reason || ""),
            at: String(revision.at || ""),
          }
        : null,
    };
  });
  return {
    ok: true,
    requestedId: Number(id),
    currentId: head.id,
    nodes,
    nextCursor: offset + size < order.length ? String(offset + size) : null,
    truncated: order.length >= REVISION_WALK_LIMIT,
    total: order.length,
  };
}
