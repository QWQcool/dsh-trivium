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
 * and a hard edge is created only by `confirmSupersede` (the panel / API) or by
 * a caller that passes an explicit target id to `ctx_remember`.
 *
 * Consequences to keep in mind:
 *   - the old decision stays live and stays in the short map on purpose; the map
 *     is what the model reads, so hiding it while nobody confirmed the
 *     replacement would answer with the new value before it was authorised;
 *   - a proposal is carried by the node, not by a side file, so it survives a
 *     restart and cannot drift away from the fact it belongs to;
 *   - `rejectSupersede` leaves both facts current. Rejecting is not deleting:
 *     the node is a real fact the user said, only the retirement is refused.
 */
import { ensureLink, supersedesIn, supersedesOut, updateNode } from "./store.js";
import { SUPERSEDE_PROPOSED } from "./review-marks.js";

export { SUPERSEDE_PROPOSED };

/** Every unconfirmed proposal, newest last. Read-only: never repairs in place. */
export function listSupersedeProposals(db) {
  const out = [];
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    const payload = db.get(id)?.payload;
    if (!payload || payload.review !== SUPERSEDE_PROPOSED) continue;
    if (supersedesOut(db, id).length) continue;
    const targets = (Array.isArray(payload.proposedSupersedes) ? payload.proposedSupersedes : [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value !== id)
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
    });
  }
  return out;
}

function refusal(code, message) {
  return { ok: false, code, message };
}

/**
 * Drop the proposal mark once the edge exists.
 *
 * Confirmation goes through the existing revision endpoint (`supersede`), which
 * knows nothing about proposals; this keeps the node from staying in the
 * "waiting for you" list after a person already said yes.
 */
export function clearProposalMarker(db, successorId, oldId) {
  const id = Number(successorId);
  const payload = db.get(id)?.payload;
  if (!payload || payload.review !== SUPERSEDE_PROPOSED) return false;
  const proposed = (Array.isArray(payload.proposedSupersedes) ? payload.proposedSupersedes : []).map(Number);
  if (Number.isFinite(Number(oldId)) && proposed.length && !proposed.includes(Number(oldId))) return false;
  updateNode(db, id, { review: "", proposedSupersedes: [] });
  return true;
}

/**
 * Confirm one proposal against one target. The caller supplies the target so an
 * ambiguous proposal cannot be resolved by guessing; every other live candidate
 * stays current.
 */
export function confirmSupersede(db, id, targetId, { by = "user" } = {}) {
  const nodeId = Number(id);
  const target = Number(targetId);
  const payload = db.get(nodeId)?.payload;
  if (!payload) return refusal("no-node", "没有这个节点");
  if (payload.review !== SUPERSEDE_PROPOSED) return refusal("not-proposed", "这个节点不是待确认替代");
  const proposed = (Array.isArray(payload.proposedSupersedes) ? payload.proposedSupersedes : []).map(Number);
  if (!Number.isFinite(target) || !proposed.includes(target)) {
    return refusal("target-not-proposed", "目标不在本次提案里");
  }
  if (target === nodeId) return refusal("self", "不能替代自己");
  const targetPayload = db.get(target)?.payload;
  if (!targetPayload) return refusal("no-target", "目标节点不存在");
  if (targetPayload.status === "archived") return refusal("target-archived", "目标已归档");
  if (supersedesIn(db, target).length) return refusal("target-not-live", "目标已经被替代");
  if (supersedesOut(db, nodeId).length) return refusal("already-confirmed", "这个节点已经确认过替代");
  ensureLink(db, nodeId, target, "supersedes");
  updateNode(db, nodeId, {
    review: "",
    proposedSupersedes: [],
    supersedeConfirmedBy: String(by || "user"),
    supersedeConfirmedAt: new Date().toISOString(),
  });
  return { ok: true, id: nodeId, targetId: target, by: String(by || "user") };
}

/** Refuse the retirement. Both facts stay current; nothing is deleted. */
export function rejectSupersede(db, id, { by = "user" } = {}) {
  const nodeId = Number(id);
  const payload = db.get(nodeId)?.payload;
  if (!payload) return refusal("no-node", "没有这个节点");
  if (payload.review !== SUPERSEDE_PROPOSED) return refusal("not-proposed", "这个节点不是待确认替代");
  updateNode(db, nodeId, {
    review: "",
    proposedSupersedes: [],
    supersedeRejectedBy: String(by || "user"),
    supersedeRejectedAt: new Date().toISOString(),
  });
  return { ok: true, id: nodeId, by: String(by || "user") };
}
