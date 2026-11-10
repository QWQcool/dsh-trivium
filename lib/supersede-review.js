/**
 * P route: a replacement is a *proposal* until a person confirms it.
 *
 * Until 0.8.6 the extraction wrote a `supersedes` edge whenever the wording
 * looked like a correction. Four review rounds showed that wording is not
 * authorisation: the model could retire a decision the sentence never dropped.
 * Under P the automatic path only records an intent on the new node
 *
 *     review: "supersede-proposed"
 *     proposedSupersedes: [<target id>, ...]
 *
 * and a hard edge is created only by a person: the panel, or an API caller that
 * has the node id. The model has no confirm path at all — not a narrow one, and
 * not an id parameter on `ctx_remember`.
 *
 * Consequences to keep in mind:
 *   - the old decision stays current, and both facts stay eligible for the short
 *     map on purpose. Eligibility is not a promise that both fit: the map has
 *     eight named slots and a token budget, so during a proposal either fact may
 *     be the one that gets a row;
 *   - a proposal is carried by the node, not by a side file, so it survives a
 *     restart and cannot drift away from the fact it belongs to;
 *   - rejecting leaves a tombstone (`rejectedSupersedes`). Rejecting is not
 *     deleting: the node is a real fact the user said, only the retirement is
 *     refused, and a stale page must not be able to write the refused edge.
 */
import { createHash } from "node:crypto";
import { supersedesIn, supersedesOut, updateNode } from "./store.js";
import { etagOf, supersede as supersedeRevision } from "./revisions.js";
import { SUPERSEDE_PROPOSED } from "./review-marks.js";

export { SUPERSEDE_PROPOSED };

export const PROPOSAL_CODES = Object.freeze({
  notFound: "proposal-not-found",
  notProposed: "proposal-not-pending",
  targetNotListed: "proposal-target-not-listed",
  targetNotLive: "proposal-target-not-live",
  alreadyConfirmed: "proposal-already-confirmed",
  stale: "proposal-stale",
  rejected: "proposal-rejected",
  requiresConfirm: "proposal-requires-confirm",
});

function refusal(code, message) {
  return { ok: false, code, message };
}

function targetIdsOf(payload) {
  return (Array.isArray(payload?.proposedSupersedes) ? payload.proposedSupersedes : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

function rejectedIdsOf(payload) {
  return (Array.isArray(payload?.rejectedSupersedes) ? payload.rejectedSupersedes : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * The version a confirmation is allowed to act on.
 *
 * The proposal node's own ETag is not enough: a candidate that was edited (or
 * itself replaced) changes what "confirm this replacement" means, and the panel
 * would otherwise confirm a pair it never showed. So the token folds in every
 * target's ETag as well.
 */
export function proposalEtagOf(db, id) {
  const nodeId = Number(id);
  const payload = db.get(nodeId)?.payload;
  if (!payload) return "";
  const targets = targetIdsOf(payload).sort((a, b) => a - b);
  const parts = [etagOf(db, nodeId), ...targets.map((target) => `${target}:${etagOf(db, target)}`)];
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Every unconfirmed proposal, newest last. Read-only: never repairs in place. */
export function listSupersedeProposals(db) {
  const out = [];
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    const payload = db.get(id)?.payload;
    if (!payload || payload.review !== SUPERSEDE_PROPOSED) continue;
    if (supersedesOut(db, id).length) continue;
    const targets = targetIdsOf(payload)
      .filter((value) => value !== id)
      .map((value) => {
        const target = db.get(value)?.payload;
        return target
          ? { id: value, name: String(target.name || ""), text: String(target.text || "").slice(0, 160), live: supersedesIn(db, value).length === 0 }
          : { id: value, name: "", text: "", live: false };
      });
    out.push({
      id,
      type: String(payload.type || ""),
      name: String(payload.name || ""),
      text: String(payload.text || "").slice(0, 200),
      sentence: String(payload.source?.quote || ""),
      targets,
      at: String(payload.updatedAt || payload.createdAt || ""),
      // The panel sends this back with either action; the server compares it
      // inside the lock, so a page that loaded before a reject or before a
      // candidate changed cannot act.
      etag: proposalEtagOf(db, id),
    });
  }
  return out;
}

/**
 * Whether a confirmation may act, right now.
 *
 * Everything the decision depends on is re-read here: the proposal is still
 * pending, the target is still one of its candidates, that target is still live,
 * the pair has no edge yet, and — when the caller echoes one — the ETag has not
 * moved. A stale page therefore fails instead of writing an edge nobody wants.
 */
export function proposalVerdict(db, { proposalId, targetId, expectedEtag } = {}) {
  const id = Number(proposalId);
  const target = Number(targetId);
  const payload = db.get(id)?.payload;
  if (!payload) return refusal(PROPOSAL_CODES.notFound, "没有这个提案节点");
  if (rejectedIdsOf(payload).includes(target)) {
    return refusal(PROPOSAL_CODES.rejected, "这条提案已经被拒绝");
  }
  if (payload.review !== SUPERSEDE_PROPOSED) {
    return refusal(PROPOSAL_CODES.notProposed, "这个节点不是待确认替代");
  }
  if (!Number.isInteger(target) || target <= 0) return refusal(PROPOSAL_CODES.targetNotListed, "需要候选目标 id");
  if (!targetIdsOf(payload).includes(target)) {
    return refusal(PROPOSAL_CODES.targetNotListed, "目标不在本次提案里");
  }
  if (supersedesOut(db, id).length) {
    return refusal(PROPOSAL_CODES.alreadyConfirmed, "这个节点已经确认过替代");
  }
  const targetPayload = db.get(target)?.payload;
  if (!targetPayload) return refusal(PROPOSAL_CODES.targetNotLive, "目标节点不存在");
  if (targetPayload.status === "archived") return refusal(PROPOSAL_CODES.targetNotLive, "目标已归档");
  if (supersedesIn(db, target).length) return refusal(PROPOSAL_CODES.targetNotLive, "目标已经被替代");
  if (expectedEtag !== undefined && String(expectedEtag) !== proposalEtagOf(db, id)) {
    return refusal(PROPOSAL_CODES.stale, "提案在你确认之前已经变化，请刷新");
  }
  return { ok: true, id, targetId: target };
}

/**
 * Confirm one candidate. The caller supplies the target, so an ambiguous
 * proposal cannot be resolved by guessing; every other candidate stays current.
 *
 * The edge goes through `revisions.supersede`, the same validator the manual
 * revision dialog uses — cycle, self, archived, already-superseded and chain
 * length are therefore checked in one place, not two.
 */
export function confirmProposal(db, { proposalId, targetId, expectedEtag, source = "api", operationId } = {}) {
  const verdict = proposalVerdict(db, { proposalId, targetId, expectedEtag });
  if (!verdict.ok) return verdict;

  const created = supersedeRevision(db, {
    oldId: verdict.targetId,
    successorId: verdict.id,
    reason: "proposal-confirmed",
    operationId,
  });
  if (!created.ok) {
    return refusal(created.code || PROPOSAL_CODES.notProposed, created.message || "替代关系没有被建立");
  }

  const warning = finalizeConfirmed(db, { proposalId: verdict.id, source });
  return {
    ok: true,
    id: verdict.id,
    targetId: verdict.targetId,
    source: String(source || "api"),
    alreadyApplied: created.alreadyApplied === true,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Clear the pending mark after an edge exists.
 *
 * F87-03: the edge is the durable outcome; the mark only decides whether the
 * panel keeps offering it. If clearing fails we say so instead of answering 500 —
 * a 500 would tell the caller nothing happened while the edge exists, which is
 * the worst of both worlds. Returns "" on success, a warning string otherwise.
 */
export function finalizeConfirmed(db, { proposalId, source = "http" } = {}) {
  const id = Number(proposalId);
  const payload = db.get(id)?.payload;
  if (!payload || payload.review !== SUPERSEDE_PROPOSED) return "";
  try {
    updateNode(db, id, {
      review: "",
      proposedSupersedes: [],
      supersedeConfirmedAt: new Date().toISOString(),
      // Surface class, not identity: the request proves a human-driven caller,
      // never who that person was.
      supersedeConfirmedVia: String(source || "http"),
    });
    return "";
  } catch (err) {
    return `marker-not-cleared: ${String(err?.message || err)}`;
  }
}

/** Refuse the retirement. Both facts stay current; nothing is deleted. */
export function rejectSupersede(db, id, { source = "api", expectedEtag } = {}) {
  const nodeId = Number(id);
  const payload = db.get(nodeId)?.payload;
  if (!payload) return refusal(PROPOSAL_CODES.notFound, "没有这个节点");
  if (payload.review !== SUPERSEDE_PROPOSED) {
    return refusal(PROPOSAL_CODES.notProposed, "这个节点不是待确认替代");
  }
  /*
   * F87-02 (review round 2): the reject endpoint is not exempt. Without the
   * version check a page that loaded before a candidate was added could decline
   * a proposal it never showed — the same stale-page problem as confirming.
   */
  if (expectedEtag !== undefined && String(expectedEtag) !== proposalEtagOf(db, nodeId)) {
    return refusal(PROPOSAL_CODES.stale, "提案在你拒绝之前已经变化，请刷新");
  }
  const refused = targetIdsOf(payload);
  updateNode(db, nodeId, {
    review: "",
    proposedSupersedes: [],
    rejectedSupersedes: refused,
    supersedeRejectedAt: new Date().toISOString(),
    supersedeRejectedVia: String(source || "api"),
  });
  return { ok: true, id: nodeId, source: String(source || "api"), rejectedTargets: refused };
}

/**
 * Guard for the generic revision endpoint.
 *
 * `POST /nodes/<old>/supersede` is the manual-edit path and must keep working for
 * pairs that were never a proposal. It must *not* become a second way to confirm
 * something the panel already refused, so a tombstone blocks exactly that pair.
 */
export function supersedeBlockedByProposal(db, { oldId, successorId } = {}) {
  const successorIdNumber = Number(successorId);
  // An incomplete request is the revision validator's 400, not ours: never hand
  // `db.get` a non-integer id.
  if (!Number.isInteger(successorIdNumber) || successorIdNumber <= 0) return null;
  const successor = db.get(successorIdNumber)?.payload;
  if (!successor) return null;
  if (rejectedIdsOf(successor).includes(Number(oldId))) {
    return refusal(PROPOSAL_CODES.rejected, "这条替代已经被拒绝，不能再用旧页面确认");
  }
  if (successor.review === SUPERSEDE_PROPOSED) {
    /*
     * A pending proposal is confirmed only through the proposal endpoint, which
     * re-checks the target list and the ETag. Letting the generic route write the
     * edge would be the same confirmation without the version check.
     */
    return refusal(PROPOSAL_CODES.requiresConfirm, "这条替代要经提案确认接口处理");
  }
  return null;
}
