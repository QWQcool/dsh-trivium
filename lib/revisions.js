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

import { createHash, randomUUID } from "node:crypto";
import { EDGE_LABELS, REVISION_EDGES, nowIso, weightOf } from "./schema.js";
import {
  currentHeadOf,
  isRevisionLinked,
  persistAfterRevision,
  predecessorOf,
  revisionEdgeOf,
  successorOf,
  supersedesIn,
  supersedesOut,
  REVISION_WALK_LIMIT,
} from "./store.js";
import { isStalePayload } from "./until.js";
import { provenanceOf } from "./provenance.js";

/*
 * The graph predicates live in store.js: the write guards there need them, and
 * this module already imports from store.js, so defining them here would make
 * the dependency circular. They are re-exported so callers have one import.
 */
export { currentHeadOf, isRevisionLinked, predecessorOf, successorOf, REVISION_WALK_LIMIT };

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
    // Relation metadata lives on the supersedes edge (0.8.11 edges carry a
    // metadata bag), so payload.revision is only a legacy fallback.
    const edge = revisionEdgeOf(db, nodeId);
    const meta = edge?.metadata && typeof edge.metadata === "object" ? edge.metadata : revision;
    return {
      id: nodeId,
      type: payload.type || "unknown",
      name: String(payload.name || ""),
      l0: String(payload.text || payload.name || "").slice(0, 160),
      status: payload.status || "active",
      expiryState: expiryStateOf(payload),
      isCurrent: nodeId === head.id,
      isRequested: nodeId === Number(id),
      relation: edge
        ? {
            supersededBy: Number(edge.from),
            reason: String(meta?.reason || ""),
            at: String(meta?.at || ""),
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

/* ------------------------------------------------------------------ writes */

/** One in-process queue per workspace: read → validate → commit never interleaves. */
const queues = new Map();

/**
 * Serialize a write against everything else touching this workspace.
 *
 * The validation inside reads the graph again, so a decision taken on a stale
 * view can never be committed: the second caller either sees the new state and
 * refuses, or matches the ETag it was given.
 */
export function withWorkspaceQueue(cwd, fn) {
  const key = String(cwd || "");
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export const REVISION_CODES = Object.freeze({
  badInput: "bad-input",
  notFound: "not-found",
  self: "self",
  nonDecision: "non-decision",
  archived: "archived",
  alreadySuperseded: "already-superseded",
  successorHasPredecessor: "successor-has-predecessor",
  cycle: "cycle",
  tooLong: "too-long",
  etag: "etag",
  transactionFailed: "transaction-failed",
  noRelation: "no-relation",
  hasLaterVersion: "has-later-version",
  revisionLinked: "REVISION_LINKED",
});

function refuse(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

function reasonText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Walk backwards (older) looking for a node, bounded by the hop limit. */
function ancestorsOf(db, id, limit = REVISION_WALK_LIMIT) {
  const out = [];
  let current = predecessorOf(db, id);
  while (current != null && out.length < limit) {
    out.push(current);
    current = predecessorOf(db, current);
  }
  return { ids: out, overflow: current != null };
}

/**
 * Confirm `successorId --supersedes--> oldId`.
 *
 * Nothing is written until every check passed; the write itself is one native
 * transaction, so a failure leaves both ends exactly as they were.
 */
export function supersede(db, input = {}) {
  const oldId = Number(input.oldId);
  const successorId = Number(input.successorId);
  if (!Number.isFinite(oldId) || !Number.isFinite(successorId)) {
    return refuse(400, REVISION_CODES.badInput, "需要两个节点 id。");
  }
  if (oldId === successorId) {
    return refuse(409, REVISION_CODES.self, "不能把决策替代成它自己。");
  }
  const operationId = String(input.operationId || "").trim() || randomUUID();

  // Idempotency first: a lost response is retried with the same operationId,
  // and the edge metadata is the durable record that it already landed.
  const existing = revisionEdgeOf(db, oldId);
  if (existing && existing.metadata?.operationId === operationId) {
    return { ok: true, alreadyApplied: true, oldId, successorId: existing.from, operationId };
  }

  const oldNode = db.get(oldId);
  const newNode = db.get(successorId);
  if (!oldNode || !newNode) return refuse(404, REVISION_CODES.notFound, "节点不存在。");
  const oldPayload = oldNode.payload || {};
  const newPayload = newNode.payload || {};
  if (oldPayload.type !== "decision" || newPayload.type !== "decision") {
    return refuse(409, REVISION_CODES.nonDecision, "只有两条决策之间可以建立替代关系。");
  }
  if (oldPayload.status === "archived" || newPayload.status === "archived") {
    return refuse(409, REVISION_CODES.archived, "已归档的决策不能参与替代关系。");
  }
  if (existing && Number(existing.from) !== successorId) {
    return refuse(409, REVISION_CODES.alreadySuperseded, `#${oldId} 已被 #${existing.from} 替代。`, {
      currentId: Number(existing.from),
    });
  }
  if (existing && Number(existing.from) === successorId) {
    // Same pair, different operationId: the relation already exists. Report it
    // as applied rather than creating a parallel edge.
    return { ok: true, alreadyApplied: true, oldId, successorId, operationId: existing.metadata?.operationId || "" };
  }
  const successorPredecessor = predecessorOf(db, successorId);
  if (successorPredecessor != null) {
    return refuse(
      409,
      REVISION_CODES.successorHasPredecessor,
      `#${successorId} 已经替代了 #${successorPredecessor}，首版只支持线性链。`,
      { predecessorId: successorPredecessor },
    );
  }
  const forward = currentHeadOf(db, successorId);
  if (!forward.ok) {
    return refuse(409, forward.reason === "too-long" ? REVISION_CODES.tooLong : REVISION_CODES.cycle,
      forward.reason === "too-long" ? `版本链超过 ${REVISION_WALK_LIMIT} 跳，拒绝给出不完整的当前版本。` : "版本链存在循环。");
  }
  if (Number(forward.id) === oldId) {
    return refuse(409, REVISION_CODES.cycle, "这会形成循环替代。");
  }
  const ancestors = ancestorsOf(db, oldId);
  if (ancestors.overflow) {
    return refuse(409, REVISION_CODES.tooLong, `版本链超过 ${REVISION_WALK_LIMIT} 跳。`);
  }
  if (ancestors.ids.includes(successorId)) {
    return refuse(409, REVISION_CODES.cycle, "这会形成循环替代：新决策已经是旧决策的前身。");
  }

  const want = input.expectedEtags || {};
  const oldEtag = etagOf(db, oldId);
  const newEtag = etagOf(db, successorId);
  if (want.old !== undefined && String(want.old) !== oldEtag) {
    return refuse(409, REVISION_CODES.etag, "旧决策已在别处变更，请刷新后再确认。", { etag: { old: oldEtag, new: newEtag } });
  }
  if (want.new !== undefined && String(want.new) !== newEtag) {
    return refuse(409, REVISION_CODES.etag, "新决策已在别处变更，请刷新后再确认。", { etag: { old: oldEtag, new: newEtag } });
  }

  const at = nowIso();
  const metadata = { reason: reasonText(input.reason), at, operationId };
  try {
    db.commitTransaction([
      {
        type: "upsertEdge",
        src: successorId,
        dst: oldId,
        label: SUPERSEDES,
        weight: weightOf(SUPERSEDES),
        metadata,
      },
    ]);
  } catch (err) {
    // Native transaction failed: both ends untouched.
    return refuse(409, REVISION_CODES.transactionFailed, `关系写入失败，两端保持原状：${err.message}`);
  }
  persistAfterRevision(db);
  return {
    ok: true,
    oldId,
    successorId,
    operationId,
    at,
    reason: metadata.reason,
    etag: { old: etagOf(db, oldId), new: etagOf(db, successorId) },
  };
}

/**
 * Revoke the most recent supersession.
 *
 * Only the named edge is removed — other edges, including business edges
 * between the same two nodes, survive. A successor that has itself been
 * superseded is refused, because that chain would be split in the wrong place.
 */
export function revokeSupersession(db, input = {}) {
  const oldId = Number(input.oldId);
  const successorId = Number(input.successorId);
  if (!Number.isFinite(oldId) || !Number.isFinite(successorId)) {
    return refuse(400, REVISION_CODES.badInput, "需要两个节点 id。");
  }
  const existing = revisionEdgeOf(db, oldId);
  if (!existing || Number(existing.from) !== successorId) {
    return refuse(404, REVISION_CODES.noRelation, "没有找到这条替代关系。");
  }
  const later = successorOf(db, successorId);
  if (later != null) {
    return refuse(409, REVISION_CODES.hasLaterVersion,
      `#${successorId} 之后已有 #${later}，先处理更新的版本再撤销。`, { laterId: later });
  }
  const want = input.expectedEtags || {};
  const oldEtag = etagOf(db, oldId);
  const newEtag = etagOf(db, successorId);
  if (want.old !== undefined && String(want.old) !== oldEtag) {
    return refuse(409, REVISION_CODES.etag, "旧决策已在别处变更，请刷新后再撤销。", { etag: { old: oldEtag, new: newEtag } });
  }
  if (want.new !== undefined && String(want.new) !== newEtag) {
    return refuse(409, REVISION_CODES.etag, "新决策已在别处变更，请刷新后再撤销。", { etag: { old: oldEtag, new: newEtag } });
  }
  try {
    db.commitTransaction([
      { type: "unlinkLabel", src: successorId, dst: oldId, label: SUPERSEDES },
    ]);
  } catch (err) {
    return refuse(409, REVISION_CODES.transactionFailed, `撤销失败，关系仍在：${err.message}`);
  }
  persistAfterRevision(db);
  return { ok: true, oldId, successorId, etag: { old: etagOf(db, oldId), new: etagOf(db, successorId) } };
}

/** Human-readable refusal for the UI, without leaking workspace paths. */
export function revisionMessage(code) {
  const map = {
    [REVISION_CODES.badInput]: "输入不完整。",
    [REVISION_CODES.notFound]: "节点不存在。",
    [REVISION_CODES.self]: "不能把决策替代成它自己。",
    [REVISION_CODES.nonDecision]: "只有决策之间可以建立替代关系。",
    [REVISION_CODES.archived]: "已归档的决策不能参与替代关系。",
    [REVISION_CODES.alreadySuperseded]: "这条决策已经被替代。",
    [REVISION_CODES.successorHasPredecessor]: "首版只支持线性链。",
    [REVISION_CODES.cycle]: "会形成循环替代。",
    [REVISION_CODES.tooLong]: "版本链过长。",
    [REVISION_CODES.etag]: "内容已在别处变更，请刷新。",
    [REVISION_CODES.transactionFailed]: "写入失败，两端保持原状。",
    [REVISION_CODES.noRelation]: "没有这条替代关系。",
    [REVISION_CODES.hasLaterVersion]: "后面还有更新的版本。",
    [REVISION_CODES.revisionLinked]: "节点在替代链上，请先处理关系。",
  };
  return map[code] || "操作未完成。";
}
