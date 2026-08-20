/** Compaction checkpoints and fork lineage as episode nodes. Not recalled by find. */

import { EDGE_LABELS, nowIso } from "./schema.js";
import { ensureLink, findByType, findByUri, insertNode, updateNode } from "./store.js";

const FALLBACK_SUMMARY = "已压缩";
const TAIL_SUMMARY = "当前";
const FORK_SUMMARY = "分叉";

/** Auto titles. A hand-set name that is not one of these is the box title. */
export const GENERIC_EPISODE_NAMES = Object.freeze([TAIL_SUMMARY, FALLBACK_SUMMARY, FORK_SUMMARY]);

export function isGenericEpisodeName(name) {
  const n = String(name || "").trim();
  return !n || GENERIC_EPISODE_NAMES.includes(n);
}

function genericNameOf(kind) {
  if (kind === "tail") return TAIL_SUMMARY;
  if (kind === "fork") return FORK_SUMMARY;
  return FALLBACK_SUMMARY;
}

export function episodeUri(sessionId, atSeq) {
  return `ctx://episode/${sessionId}/${atSeq}`;
}

export function tailUri(sessionId) {
  return `ctx://episode/${sessionId}/tail`;
}

function sessionOf(payload) {
  return String(payload?.sessionId || "");
}

export function listEpisodeRecords(db, sessionId) {
  const want = sessionId == null || sessionId === "" ? null : String(sessionId);
  const rows = [];
  const fromIndex = findByType(db, "episode");
  const ids = fromIndex.length
    ? fromIndex.map((n) => n.id)
    : db.allNodeIds?.() || [];
  const seen = new Set();
  for (const raw of ids) {
    const id = Number(raw?.id ?? raw);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const node = db.get(id);
    const payload = node?.payload || {};
    if (payload.type !== "episode" || payload.status === "archived") continue;
    if (want && sessionOf(payload) !== want) continue;
    rows.push(recordOf(id, payload, node?.edges || []));
  }
  return rows.sort((a, b) => (a.atSeq || 0) - (b.atSeq || 0) || a.id - b.id);
}

function recordOf(id, payload, edges) {
  const summary = String(payload.summary || payload.text || "").trim();
  return {
    id: Number(id),
    type: "episode",
    sessionId: sessionOf(payload),
    kind: payload.kind || "checkpoint",
    atSeq: Number.isFinite(Number(payload.atSeq)) ? Number(payload.atSeq) : 0,
    summary,
    compactionId: payload.compactionId || "",
    status: payload.status || "active",
    createdAt: payload.createdAt || "",
    updatedAt: payload.updatedAt || "",
    uri: payload.uri || "",
    name: payload.name || "",
    text: payload.text || summary,
    edges,
  };
}

function upsertEpisode(db, payload) {
  const uri = String(payload.uri || "").trim();
  let id = uri ? findByUri(db, uri) : null;
  if (id == null && payload.kind === "tail" && payload.sessionId) {
    const existing = listEpisodeRecords(db, payload.sessionId).find((e) => e.kind === "tail");
    if (existing) id = existing.id;
  }
  const body = {
    type: "episode",
    kind: payload.kind,
    sessionId: String(payload.sessionId || ""),
    atSeq: Number.isFinite(Number(payload.atSeq)) ? Number(payload.atSeq) : 0,
    summary: String(payload.summary || payload.text || "").trim(),
    compactionId: payload.compactionId || undefined,
    uri,
    name: payload.name || genericNameOf(payload.kind),
    text: String(payload.summary || payload.text || "").trim(),
    status: "active",
    updatedAt: nowIso(),
  };
  if (id != null) {
    const old = db.get(Number(id))?.payload || {};
    const next = {
      ...old,
      ...body,
      name: old.name || body.name,
      kind: old.kind === "checkpoint" ? "checkpoint" : body.kind,
      createdAt: old.createdAt || nowIso(),
    };
    if (payload.kind === "checkpoint") next.kind = "checkpoint";
    db.updatePayload(Number(id), next);
    db.flush();
    return Number(id);
  }
  return insertNode(db, { ...body, createdAt: nowIso() });
}

function linkChain(db, sessionId) {
  const rows = listEpisodeRecords(db, sessionId);
  const checks = rows
    .filter((e) => e.kind === "checkpoint" || e.kind === "fork")
    .sort((a, b) => (a.atSeq || 0) - (b.atSeq || 0) || a.id - b.id);
  const tail = rows.find((e) => e.kind === "tail");
  for (let i = 0; i < checks.length - 1; i += 1) {
    ensureLink(db, checks[i].id, checks[i + 1].id, EDGE_LABELS.continues);
  }
  if (tail && checks.length) {
    ensureLink(db, checks[checks.length - 1].id, tail.id, EDGE_LABELS.continues);
  }
}

/** At most one tail episode per session. Stable uri so compaction can reuse the node. */
export function ensureTail(db, sessionId, { atSeq, summary } = {}) {
  const sid = String(sessionId || "");
  if (!sid) return null;
  const existing = listEpisodeRecords(db, sid).find((e) => e.kind === "tail");
  let text;
  if (summary === undefined) {
    text = existing && !isGenericEpisodeName(existing.summary) ? existing.summary : "";
  } else {
    text = String(summary || "").trim();
  }
  const id = upsertEpisode(db, {
    kind: "tail",
    sessionId: sid,
    atSeq: Number.isFinite(Number(atSeq)) ? Number(atSeq) : existing?.atSeq || 0,
    summary: text,
    uri: tailUri(sid),
    name: existing?.name || TAIL_SUMMARY,
  });
  linkChain(db, sid);
  return id;
}

export function recordCheckpoint(db, { sessionId, atSeq, compactionId, summary } = {}) {
  const sid = String(sessionId || "");
  const seq = Number(atSeq);
  if (!sid || !Number.isFinite(seq)) return null;
  const text = String(summary || "").trim() || FALLBACK_SUMMARY;
  const id = upsertEpisode(db, {
    kind: "checkpoint",
    sessionId: sid,
    atSeq: seq,
    compactionId: compactionId ? String(compactionId) : undefined,
    summary: text,
    uri: episodeUri(sid, seq),
  });
  ensureTail(db, sid, { atSeq: seq, summary: "" });
  return id;
}

/**
 * Project a native or canvas fork onto the graph.
 * Reuses a checkpoint at the same atSeq instead of writing a second fork node.
 */
export function syncForkLineage(db, { childSessionId, parentSessionId, atSeq } = {}) {
  const child = String(childSessionId || "");
  const parent = String(parentSessionId || "");
  if (!child || !parent) return null;
  const seq = Number.isFinite(Number(atSeq)) ? Number(atSeq) : null;
  let cutId = null;
  if (seq != null) {
    cutId = findByUri(db, episodeUri(parent, seq));
    if (cutId == null) {
      cutId = upsertEpisode(db, {
        kind: "fork",
        sessionId: parent,
        atSeq: seq,
        summary: FORK_SUMMARY,
        uri: episodeUri(parent, seq),
        name: FORK_SUMMARY,
      });
    }
  } else {
    const parentRows = listEpisodeRecords(db, parent);
    const last =
      [...parentRows].reverse().find((e) => e.kind === "checkpoint" || e.kind === "fork") ||
      parentRows.find((e) => e.kind === "tail");
    cutId = last?.id ?? null;
  }
  const childTail = ensureTail(db, child, { atSeq: seq ?? 0 });
  if (cutId != null && childTail != null) {
    ensureLink(db, childTail, cutId, EDGE_LABELS.forksFrom);
  }
  linkChain(db, parent);
  return { cutId, childTail };
}

export function sessionMapSnapshot(db, sessionId) {
  const sid = String(sessionId || "");
  const all = listEpisodeRecords(db);
  const mineIds = new Set(all.filter((n) => n.sessionId === sid).map((n) => n.id));
  const edges = [];
  for (const n of all) {
    const node = db.get(n.id);
    for (const e of node?.edges || []) {
      const label = e.label || "";
      if (label !== EDGE_LABELS.continues && label !== EDGE_LABELS.forksFrom) continue;
      const to = Number(e.targetId ?? e.target_id);
      if (!Number.isFinite(to)) continue;
      edges.push({ from: n.id, to, label });
    }
  }
  const related = new Set(mineIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (related.has(e.from) && !related.has(e.to)) {
        related.add(e.to);
        grew = true;
      }
      if (related.has(e.to) && !related.has(e.from)) {
        related.add(e.from);
        grew = true;
      }
    }
  }
  const nodes = all
    .filter((n) => related.has(n.id) || n.sessionId === sid)
    .map((n) => ({
      id: n.id,
      sessionId: n.sessionId,
      kind: n.kind,
      atSeq: n.atSeq,
      summary: n.summary,
      compactionId: n.compactionId,
      status: n.status,
      createdAt: n.createdAt,
      uri: n.uri,
      name: n.name || "",
      current: n.sessionId === sid && n.kind === "tail",
    }));
  return {
    sessionId: sid,
    nodes,
    edges: edges.filter((e) => related.has(e.from) && related.has(e.to)),
  };
}

/**
 * Hand-rename a box. Writes only `name`. Rejects non-episode ids.
 * Callers must not pass text/summary into updateNode.
 */
export function renameEpisode(db, id, name) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) return { ok: false, status: 400, message: "bad id" };
  const node = db.get(nid);
  if (!node) return { ok: false, status: 404, message: "not found" };
  const payload = node.payload || {};
  if (payload.type !== "episode") {
    return { ok: false, status: 400, message: "not an episode" };
  }
  const next = updateNode(db, nid, { name: String(name ?? "").trim() });
  return {
    ok: true,
    id: nid,
    name: next?.name || "",
    summary: String(next?.summary || payload.summary || payload.text || ""),
  };
}
