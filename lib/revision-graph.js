/**
 * Structural checks for a set of supersedes edges.
 *
 * Pure: it never touches the database, so an import can validate a whole chain
 * before a single node is written. The ids are whatever the caller works with —
 * exported ids, remapped ids, or live ids.
 *
 * The first version is a linear chain: at most one direct successor and one
 * direct predecessor per node, no self loops, no cycles, and a bounded walk.
 */

import { REVISION_WALK_LIMIT } from "./schema.js";

export const REVISION_CONFLICTS = Object.freeze({
  invalidEdge: "invalid-edge",
  self: "self",
  missingNode: "missing-node",
  nonDecision: "non-decision",
  archived: "archived",
  forkSuccessor: "fork-successor",
  forkPredecessor: "fork-predecessor",
  cycle: "cycle",
  tooLong: "too-long",
});

/**
 * @param edges - `{from, to}` where `from` supersedes `to`.
 * @param payloadOf - `(id) => payload | null`; null means the node is absent.
 * @returns `{ok, conflicts}` — an empty conflict list is the only pass.
 */
export function validateRevisionStructure({
  edges = [],
  payloadOf = () => null,
  limit = REVISION_WALK_LIMIT,
} = {}) {
  const conflicts = [];
  const successor = new Map();
  const predecessors = new Map();
  const seenEdges = new Set();

  for (const edge of edges) {
    const from = Number(edge?.from);
    const to = Number(edge?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      conflicts.push({ code: REVISION_CONFLICTS.invalidEdge });
      continue;
    }
    if (from === to) {
      conflicts.push({ code: REVISION_CONFLICTS.self, id: from });
      continue;
    }
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const fromPayload = payloadOf(from);
    const toPayload = payloadOf(to);
    if (!fromPayload || !toPayload) {
      conflicts.push({ code: REVISION_CONFLICTS.missingNode, id: fromPayload ? to : from });
      continue;
    }
    if (fromPayload.type !== "decision" || toPayload.type !== "decision") {
      conflicts.push({ code: REVISION_CONFLICTS.nonDecision, id: fromPayload.type !== "decision" ? from : to });
      continue;
    }
    // Archiving hides a fact; it does not erase its confirmed history. This
    // checker validates stored/restored topology. Only supersede()'s new-write
    // gate requires active endpoints, so archived backups remain round-trippable.
    if (successor.has(from) && successor.get(from) !== to) {
      conflicts.push({ code: REVISION_CONFLICTS.forkSuccessor, id: from });
      continue;
    }
    successor.set(from, to);
    const list = predecessors.get(to) || [];
    if (!list.includes(from)) list.push(from);
    predecessors.set(to, list);
  }

  for (const [id, list] of predecessors) {
    if (list.length > 1) conflicts.push({ code: REVISION_CONFLICTS.forkPredecessor, id });
  }

  for (const start of successor.keys()) {
    const seen = new Set();
    let current = start;
    let hops = 0;
    while (successor.has(current)) {
      if (seen.has(current)) {
        conflicts.push({ code: REVISION_CONFLICTS.cycle, id: start });
        break;
      }
      seen.add(current);
      current = successor.get(current);
      hops += 1;
      if (hops > limit) {
        conflicts.push({ code: REVISION_CONFLICTS.tooLong, id: start });
        break;
      }
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}
