import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rememberWorkspace } from "./settings.js";
import {
  BUSINESS_NODE_TYPES,
  deleteKnownSidecars,
  flushSidecarNow,
  scheduleSidecarWrite,
  syncSidecarOnOpen,
  writeSidecarNow,
} from "./sidecar.js";
import {
  DIM,
  EDGE_LABELS,
  BUSINESS_EDGES,
  NODE_TYPES,
  REVISION_EDGES,
  REVISION_WALK_LIMIT,
  indexTextFor,
  nowIso,
  weightOf,
  zeroVector,
} from "./schema.js";
import { validateRevisionStructure } from "./revision-graph.js";
import { clipToTokenBudget, estimateTokens } from "./tokens.js";
import { isStalePayload, queryMentionsUntil, resolveUntilAt } from "./until.js";
import { embedText, embeddingEnabled } from "./embed.js";
import { payloadLooksDirty, sanitizeForWrite } from "./hygiene.js";
import { noteFactChanged } from "./turn-ledger.js";

const require = createRequire(fileURLToPath(import.meta.url));

/*
 * A workspace's `.tdb` is opened read-write under an exclusive lock. When the
 * desktop app and a web host (or two windows) point at the same workspace, the
 * second opener cannot proceed. That is a kernel-level single-writer contract,
 * not something this plugin can retry its way out of; the only honest handling
 * is to name the cause and the way out instead of pasting the raw TDB error.
 */
const DB_LOCK_HINTS = [
  /database is locked/i,
  /数据库已锁定/,
  /incompatible access mode/i,
  /already opened/i,
];

export function describeDbFailure(err) {
  const raw = String(err?.message || err || "");
  if (!DB_LOCK_HINTS.some((re) => re.test(raw))) return null;
  return {
    code: "DB_LOCKED",
    status: 409,
    message:
      "这个工作区的记忆库正被另一个 DeepSeek Harness 实例占用。同一个工作区同一时间只能有一个宿主写入；请关闭另一个窗口或桌面端，或切换到别的工作区后重试。",
    detail: raw,
  };
}

let TriviumDB = null;
let loadError = null;

function loadEngine() {
  if (TriviumDB) return TriviumDB;
  if (loadError) throw loadError;
  try {
    const mod = require("triviumdb");
    TriviumDB = mod.TriviumDB || mod.default?.TriviumDB || mod.default;
    if (typeof TriviumDB !== "function") {
      throw new Error("triviumdb export TriviumDB not found");
    }
    return TriviumDB;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

const dbs = new Map();
let activeCwd = null;
let sidecarPaused = false;

export function cwdForDb(db) {
  for (const [cwd, inst] of dbs) {
    if (inst === db) return cwd;
  }
  return "";
}

export function runWithoutSidecar(fn) {
  const prev = sidecarPaused;
  sidecarPaused = true;
  try {
    return fn();
  } finally {
    sidecarPaused = prev;
  }
}

function persist(db) {
  db.flush();
  if (sidecarPaused) return;
  const cwd = cwdForDb(db);
  if (cwd) scheduleSidecarWrite(cwd, db);
}

/**
 * Post-write hook for the revision path.
 *
 * The graph write is authoritative and already committed; this flushes it and
 * lets the JSONL sidecar catch up on its own timer. Cross-file atomicity is not
 * claimed, and a sidecar failure is reported through sidecarHealth().
 */
export function persistAfterRevision(db) {
  persist(db);
}

export function dbPathFor(cwd) {
  return join(resolve(cwd), ".dsh", "trivium.tdb");
}

export function setActiveCwd(cwd) {
  if (cwd) activeCwd = cwd;
  return activeCwd;
}

export function getActiveCwd() {
  return activeCwd;
}

export function listOpenWorkspaces() {
  return [...dbs.entries()].map(([cwd, db]) => ({
    cwd,
    path: dbPathFor(cwd),
    nodeCount: nodeCountOf(db),
  }));
}

/** Replace jsonl from the current .tdb. Overwrite in place (same path) so git diffs lines. */
export function generateSidecarFromDb(cwd, db) {
  const wrote = writeSidecarNow(cwd, db, { force: true });
  if (!wrote) return { ok: false, message: "git sidecar off" };
  return { ok: true, action: "generate", cwd, path: wrote.path, wrote: wrote.wrote };
}

/** Delete known workspace trivium.jsonl files. .tdb stays. */
export function deleteGitSidecars() {
  const files = deleteKnownSidecars([...dbs.keys(), activeCwd].filter(Boolean));
  return { ok: true, action: "delete", files };
}

export function nodeCountOf(db) {
  try {
    if (typeof db.nodeCount === "function") return db.nodeCount();
    return (db.allNodeIds?.() || []).length;
  } catch {
    return 0;
  }
}

export async function openWorkspaceDb(cwd) {
  const key = resolve(cwd);
  if (cwd) activeCwd = key;
  if (dbs.has(key)) return dbs.get(key);
  mkdirSync(join(key, ".dsh"), { recursive: true });
  const Engine = loadEngine();
  // triviumdb 0.8.3+ removed numeric positional constructor args
  // (TDB_API_MIGRATION_REQUIRED); dim now rides an options object.
  const db = new Engine(dbPathFor(key), { dim: DIM });
  try {
    db.createIndex("type");
    db.createIndex("status");
  } catch {
    // indexes may already exist
  }
  ensureWorkspaceRoot(db, cwd);
  // Do NOT remove. triviumdb opens with `loadTextIndex: false` by default, so
  // the persisted BM25 sidecar is not loaded and `searchHybrid`'s text channel
  // returns nothing after a reopen until the index is rebuilt here. `searchNodes`
  // cannot paper over the loss: its keyword fallback still scores, so a
  // regression is silent at the tool level. scripts/smoke-p0.mjs pins this.
  rebuildTextIndex(db);
  dbs.set(key, db);
  try {
    rememberWorkspace(key);
  } catch {
    // listing is best-effort; opening the store still succeeds
  }
  try {
    await syncSidecarOnOpen(key, db);
  } catch {
    // sidecar is best-effort; the .tdb still opens
  }
  return db;
}

/**
 * Open an existing workspace database without creating, indexing or repairing
 * anything. Used by the integrity checker: opening through openWorkspaceDb
 * would rebuild the text index and register the workspace, which is a write.
 */
export function openWorkspaceDbReadOnly(cwd) {
  const key = resolve(cwd);
  const Engine = loadEngine();
  return new Engine(dbPathFor(key), { dim: DIM, accessMode: "readOnly" });
}

export function closeAll() {
  for (const [cwd, db] of dbs) {
    try {
      flushSidecarNow(cwd, db);
    } catch {
      // ignore
    }
    try {
      db.flush();
      db.close();
    } catch {
      // ignore
    }
  }
  dbs.clear();
}

function ensureWorkspaceRoot(db, cwd) {
  const existing = findByType(db, "workspace")[0];
  if (existing) return existing.id;
  const payload = {
    type: "workspace",
    name: cwd,
    text: `workspace ${cwd}`,
    uri: "ctx://workspace",
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const id = db.insert(zeroVector(), payload);
  indexNode(db, id, payload);
  return id;
}

export function workspaceId(db) {
  return findByType(db, "workspace")[0]?.id ?? null;
}

export function findByType(db, type) {
  try {
    const rows = db.tql(
      `FIND {type: ${JSON.stringify(type)}, status: "active"} RETURN *`,
    );
    return normalizeTql(rows);
  } catch {
    return [];
  }
}

function normalizeTql(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const node = row?._ || row?.["*"] || row?.a || Object.values(row || {})[0];
      // triviumdb 0.8.x serializes TQL row ids as strings; coerce so the rest
      // of the plugin keeps comparing numbers.
      if (!node) return null;
      const id = Number(node.id);
      if (!Number.isFinite(id)) return null;
      return { id, payload: node.payload || {} };
    })
    .filter(Boolean);
}

function edgeTarget(e) {
  return Number(e?.targetId ?? e?.target_id);
}

function edgeSource(e) {
  return Number(e?.sourceId ?? e?.source_id ?? e?.fromId);
}

/** Native incoming edges when triviumdb >= 0.7.5; otherwise null so callers can scan. */
function nativeIncoming(db, id, label) {
  if (typeof db.getIncomingEdges !== "function") return null;
  try {
    const rows = label
      ? db.getIncomingEdges(Number(id), label)
      : db.getIncomingEdges(Number(id));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

function nativeLabeledNeighbors(db, id, labels) {
  if (typeof db.neighbors !== "function") return null;
  try {
    const rows = db.neighbors(Number(id), 1, [...labels]);
    return Array.isArray(rows) ? rows.map(Number).filter(Number.isFinite) : [];
  } catch {
    try {
      const rows = db.neighbors(Number(id), 1);
      return Array.isArray(rows) ? rows.map(Number).filter(Number.isFinite) : null;
    } catch {
      return null;
    }
  }
}

function indexNode(db, id, payload) {
  const text = indexTextFor(payload);
  try {
    if (text) db.indexText(id, text);
    if (payload?.name) db.indexKeyword(id, String(payload.name));
    db.buildTextIndex();
  } catch {
    // text index is optional if the native binding rejects a token
  }
}

function rebuildTextIndex(db) {
  try {
    for (const id of db.allNodeIds()) {
      const payload = db.getPayload(id);
      if (!payload) continue;
      const text = indexTextFor(payload);
      if (text) db.indexText(id, text);
      if (payload.name) db.indexKeyword(id, String(payload.name));
    }
    db.buildTextIndex();
  } catch {
    // keep the file usable even if sparse index rebuild fails
  }
}

export function findMergeTarget(db, candidate, { allowRevisionLinked = false } = {}) {
  const type = candidate?.type;
  if (!type || type === "episode") return null;
  const name = String(candidate.name || "").trim().toLowerCase();
  const text = String(candidate.text || "").trim().toLowerCase();
  for (const n of findByType(db, type)) {
    const payload = n.payload || {};
    // A node inside a revision chain is confirmed history: auto-extraction must
    // create a new decision instead of quietly folding new text into it.
    if (!allowRevisionLinked && isRevisionLinked(db, n.id)) continue;
    const nName = String(payload.name || "").trim().toLowerCase();
    const nText = String(payload.text || "").trim().toLowerCase();
    const aliases = (payload.aliases || []).map((a) => String(a).trim().toLowerCase());
    if (type === "entity") {
      if (name && (nName === name || aliases.includes(name))) return n.id;
      if (text && nName && nName === text) return n.id;
      continue;
    }
    if (text.length >= 8 && nText && (nText === text || nText.includes(text) || text.includes(nText))) {
      return n.id;
    }
  }
  return null;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const s = String(value || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Final payload for merging incoming fields into a live node.
 *
 * Pure so the import planner can compute the exact row it will commit inside a
 * transaction, instead of calling mergeInto (which writes immediately).
 */
export function mergePayload(old, incoming) {
  const aliases = uniqueStrings([
    ...(old.aliases || []),
    ...(incoming.aliases || []),
    incoming.name,
    old.name,
  ]).filter((a) => a !== (incoming.name || old.name));
  const deadlineChanged = incoming.until !== undefined && String(incoming.until || "").trim() !== String(old.until || "").trim();
  return decorateUntil({
    ...old,
    ...incoming,
    name: incoming.name || old.name,
    text: pickMergedText(old.text, incoming.text),
    aliases,
    createdAt: old.createdAt || incoming.createdAt || nowIso(),
    updatedAt: nowIso(),
    status: old.status || "active",
    source: incoming.source || old.source,
    // An omitted expiry must not erase an existing one or leave an orphaned
    // untilAt. A changed label must not inherit the previous absolute instant.
    until: incoming.until === undefined ? old.until : incoming.until,
    untilAt: incoming.untilAt || (deadlineChanged ? undefined : old.untilAt),
  }, deadlineChanged ? nowIso() : old.createdAt);
}

/**
 * Tell the delivery ledger that a fact changed, so sessions which were shown it
 * get a short correction. Best effort: a notification must never fail a write.
 */
/** Which workspace this handle belongs to; node ids are per database. */
export function cwdOfDb(db) {
  for (const [cwd, handle] of dbs) {
    if (handle === db) return cwd;
  }
  return "";
}

function announceFactChange(db, id, payload, note, extra = {}) {
  try {
    noteFactChanged(id, {
      cwd: cwdOfDb(db),
      type: payload?.type || "",
      l0: String(payload?.text || payload?.name || "").slice(0, 200),
      until: String(payload?.until || payload?.untilAt || ""),
      stale: payload ? isStalePayload(payload) : false,
      archived: payload?.status === "archived",
      note,
      ...extra,
    });
  } catch {
    // delivered-fact bookkeeping is not part of the write contract
  }
}

export function mergeInto(db, id, incoming) {
  const node = db.get(Number(id));
  if (!node) return insertNode(db, incoming);
  const old = node.payload || {};
  /*
   * A node in a revision chain holds confirmed history: new text becomes a new
   * decision that then supersedes it. Non-factual fields (aliases, deadlines,
   * source notes) may still be filled in.
   */
  if (isRevisionLinked(db, Number(id))) {
    const nextBody = pickMergedText(old.text, incoming.text);
    if (String(nextBody || "").trim() !== String(old.text || "").trim()) {
      const err = new Error("REVISION_PROTECTED");
      err.code = "REVISION_PROTECTED";
      err.status = 409;
      err.nodeId = Number(id);
      throw err;
    }
  }
  const next = mergePayload(old, incoming);
  db.updatePayload(Number(id), next);
  indexNode(db, Number(id), next);
  persist(db);
  queueEmbed(db, Number(id), next);
  announceFactChange(db, Number(id), next, "内容已合并更新。");
  return Number(id);
}

export function listNodes(
  db,
  {
    type,
    q,
    includeArchived = false,
    includeStale = false,
    // Superseded versions are hidden by default and revealed by their own
    // switch: "show expired" and "show replaced" are different questions.
    includeSuperseded = false,
    aboutId,
    includeEpisodes = false,
  } = {},
) {
  const rows = [];
  const needle = String(q || "").trim().toLowerCase();
  const about = aboutId == null || aboutId === "" ? null : Number(aboutId);
  const around =
    about != null && Number.isFinite(about)
      ? new Set([about, ...businessNeighborIds(db, about)])
      : null;
  for (const id of db.allNodeIds?.() || []) {
    const node = db.get(id);
    if (!node) continue;
    const payload = node.payload || {};
    if (!includeArchived && payload.status === "archived") continue;
    if (payload.type === "episode" && !includeEpisodes && type !== "episode") continue;
    if (type && payload.type !== type) continue;
    if (around && !around.has(Number(id))) continue;
    const successor = successorOf(db, id);
    if (!includeSuperseded && successor != null) continue;
    const stale = isStalePayload(payload);
    if (
      !includeStale &&
      payload.type === "decision" &&
      stale &&
      !queryMentionsUntil(needle, payload)
    ) {
      continue;
    }
    const path = edgePath(db, id, node.edges || [], {
      query: needle,
      hideStale: !includeStale,
    });
    if (needle) {
      const hay = [payload.type, payload.name, payload.text, payload.until, ...path]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    rows.push({
      id,
      type: payload.type || "unknown",
      name: payload.name || "",
      text: payload.text || "",
      aliases: payload.aliases || [],
      until: payload.until || "",
      stale,
      // Independent axes, reported independently.
      revision: successor != null ? "superseded" : "current",
      currentId: successor != null ? currentHeadOf(db, id).id ?? null : Number(id),
      // The two relation endpoints, so the panel can offer "view current" and
      // "undo the replacement" without a second request.
      supersededBy: successor != null ? Number(successor) : null,
      replacesId: predecessorOf(db, id),
      dirty: payloadLooksDirty(payload),
      status: payload.status || "active",
      edges: (node.edges || []).length,
      path,
      incoming: listIncomingBusiness(db, id, { query: needle, hideStale: !includeStale }),
      outgoing: listOutgoingBusiness(db, id),
      sourceSession: payload.source?.sessionId || "",
      createdAt: payload.createdAt || "",
      updatedAt: payload.updatedAt || "",
    });
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function archiveNode(db, id) {
  const node = db.get(Number(id));
  if (!node) return false;
  const payload = {
    ...(node.payload || {}),
    status: "archived",
    updatedAt: nowIso(),
  };
  db.updatePayload(Number(id), payload);
  rebuildTextIndex(db);
  persist(db);
  announceFactChange(db, Number(id), payload, "已归档，不再作为当前事实。");
  return true;
}

/** Expiry is one axis; revision history is another. Kept apart on purpose. */
const SUPERSEDES = EDGE_LABELS.supersedes;

export { REVISION_WALK_LIMIT };

/** Outgoing supersedes edges with their metadata. */
export function supersedesOut(db, id) {
  const node = db.get(Number(id));
  return (node?.edges || [])
    .filter((e) => String(e.label) === SUPERSEDES)
    .map((e) => ({ to: edgeTarget(e), metadata: e.metadata ?? null }));
}

/** Incoming supersedes edges: who claims to replace this node. */
export function supersedesIn(db, id) {
  const node = db.get(Number(id));
  const rows = incomingLabeled(db, id, [SUPERSEDES]);
  return rows.map((row) => {
    const from = db.get(Number(row.from));
    const edge = (from?.edges || []).find(
      (e) => String(e.label) === SUPERSEDES && edgeTarget(e) === Number(id),
    );
    return { from: Number(row.from), metadata: edge?.metadata ?? null };
  });
}

/** The node that replaces this one (newer), or null. */
export function successorOf(db, id) {
  const rows = supersedesIn(db, id);
  return rows.length ? Number(rows[0].from) : null;
}

/** The node this one replaces (older), or null. */
export function predecessorOf(db, id) {
  const rows = supersedesOut(db, id);
  return rows.length ? Number(rows[0].to) : null;
}

/** The supersedes edge this node is the target of, metadata included. */
export function revisionEdgeOf(db, id) {
  const rows = supersedesIn(db, id);
  return rows.length ? rows[0] : null;
}

/** Any relation at all, in either direction. */
export function isRevisionLinked(db, id) {
  return successorOf(db, id) != null || predecessorOf(db, id) != null;
}

/** Walk forward to the head of the chain, or report why we cannot. */
export function currentHeadOf(db, id, limit = REVISION_WALK_LIMIT) {
  let current = Number(id);
  const seen = new Set();
  for (let hops = 0; hops <= limit; hops += 1) {
    if (seen.has(current)) return { ok: false, reason: "cycle", id: null, hops };
    seen.add(current);
    const next = successorOf(db, current);
    if (next == null) return { ok: true, id: current, hops };
    if (hops === limit) break;
    current = next;
  }
  return { ok: false, reason: "too-long", id: null, hops: limit };
}

/** Error the HTTP layer turns into 409 REVISION_LINKED / REVISION_PROTECTED. */
function revisionGuardError(code, id, action) {
  const err = new Error(`#${id} is part of a decision revision chain; ${action} would break the recorded history.`);
  err.code = code;
  err.status = 409;
  err.nodeId = Number(id);
  return err;
}

/**
 * Chain bodies are confirmed history: a new fact is a new decision that then
 * supersedes the old one, never an in-place rewrite.
 */
export function assertBodyEditable(db, id) {
  if (isRevisionLinked(db, id)) throw revisionGuardError("REVISION_PROTECTED", id, "rewriting its body");
}

export function deleteNode(db, id) {
  const n = Number(id);
  if (!db.contains?.(n) && !db.get(n)) return false;
  if (isRevisionLinked(db, n)) throw revisionGuardError("REVISION_LINKED", n, "deleting it");
  const payload = db.get(n)?.payload || {};
  db.delete(n);
  rebuildTextIndex(db);
  persist(db);
  // `archived` is forced so the notice is queued even though the body is gone.
  announceFactChange(db, n, payload, "已删除，不再可用。", { archived: true });
  return true;
}

export function updateNode(db, id, patch = {}) {
  const nid = Number(id);
  const node = db.get(nid);
  if (!node) return null;
  const old = node.payload || {};
  if (old.type === "workspace") return null;
  const next = { ...old };
  if (patch.name !== undefined) next.name = String(patch.name || "").trim();
  if (patch.text !== undefined) {
    const body = String(patch.text || "").trim();
    // Only the body is protected: a renamed alias, a corrected deadline or an
    // extra source note does not change the fact being remembered.
    if (body !== String(old.text || "").trim()) assertBodyEditable(db, nid);
    next.text = body;
  }
  if (Array.isArray(patch.aliases)) {
    next.aliases = uniqueStrings(patch.aliases).filter((a) => a !== next.name);
  }
  let deadlineChanged = false;
  if (patch.until !== undefined) {
    const until = String(patch.until || "").trim();
    deadlineChanged = until !== String(old.until || "").trim();
    next.until = until;
    if (deadlineChanged || !until) {
      delete next.untilAt;
    }
  }
  const body = decorateUntil({
    ...next,
    type: old.type,
    createdAt: old.createdAt,
    status: old.status || "active",
    updatedAt: nowIso(),
  }, deadlineChanged ? nowIso() : old.createdAt);
  const gate = sanitizeForWrite([body.name, body.text, body.fail, body.fix].filter(Boolean).join("\n"));
  if (!gate.ok && gate.reason !== "empty") {
    const err = new Error(gate.reason);
    err.code = "DIRTY";
    throw err;
  }
  db.updatePayload(nid, body);
  indexNode(db, nid, body);
  persist(db);
  queueEmbed(db, nid, body);
  announceFactChange(db, nid, body, "内容或期限已更新。");
  return body;
}

/** Keep `keepId`, archive `dropId`, rewire edges, `same_as` drop → keep. Same type only. */
export function mergeNodes(db, keepId, dropId) {
  const keep = Number(keepId);
  const drop = Number(dropId);
  if (!Number.isFinite(keep) || !Number.isFinite(drop) || keep === drop) {
    return { ok: false, message: "need two different ids" };
  }
  const a = db.get(keep);
  const b = db.get(drop);
  if (!a || !b) return { ok: false, message: "not found" };
  const pa = a.payload || {};
  const pb = b.payload || {};
  if (pa.type === "workspace" || pb.type === "workspace") {
    return { ok: false, message: "cannot merge workspace" };
  }
  if (pa.type !== pb.type) return { ok: false, message: "type mismatch" };
  if (pa.status === "archived" || pb.status === "archived") {
    return { ok: false, message: "archived" };
  }
  // Merging either end of a revision chain would leave a dangling history or a
  // wrong "current version". The user has to undo the relation first.
  if (isRevisionLinked(db, keep) || isRevisionLinked(db, drop)) {
    return {
      ok: false,
      status: 409,
      code: "REVISION_LINKED",
      message: "节点在决策替代链上，请先处理替代关系再合并。",
    };
  }
  const inbound = nativeIncoming(db, drop);
  if (inbound) {
    for (const e of inbound) {
      const from = edgeSource(e);
      if (Number.isFinite(from) && from !== keep) ensureLink(db, from, keep, e.label);
    }
  } else {
    for (const other of db.allNodeIds?.() || []) {
      if (Number(other) === drop) continue;
      const n = db.get(other);
      for (const e of n?.edges || []) {
        if (edgeTarget(e) === drop) ensureLink(db, other, keep, e.label);
      }
    }
  }
  for (const e of b.edges || []) {
    const tid = Number(e.targetId ?? e.target_id);
    if (!Number.isFinite(tid) || tid === keep) continue;
    ensureLink(db, keep, tid, e.label);
  }
  mergeInto(db, keep, {
    type: pa.type,
    name: pa.name || pb.name,
    text: pa.text,
    aliases: [...(pa.aliases || []), ...(pb.aliases || []), pb.name],
    until: pa.until || pb.until,
    untilAt: pa.until ? pa.untilAt : pb.untilAt,
    source: pa.source || pb.source,
  });
  ensureLink(db, drop, keep, EDGE_LABELS.sameAs);
  archiveNode(db, drop);
  return { ok: true, keep, drop, type: pa.type };
}

export const GRAPH_FORMAT = "dsh-trivium-graph";

/**
 * v2 keeps the v1 node/edge shape and adds edge metadata, which is where a
 * revision relation stores its reason and confirmation time. A v1 reader that
 * ignores `metadata` still imports the graph; it just loses the reason text.
 */
export const GRAPH_VERSION = 2;

export function exportGraph(db, cwd = "") {
  const nodes = [];
  const edges = [];
  for (const id of db.allNodeIds?.() || []) {
    const node = db.get(id);
    if (!node) continue;
    nodes.push({ id: Number(id), payload: node.payload || {} });
    for (const e of node.edges || []) {
      const row = {
        from: Number(id),
        to: edgeTarget(e),
        label: e.label || "",
        weight: e.weight ?? null,
      };
      // Edge metadata is only written when present, so a graph without revision
      // relations stays byte-comparable with a v1 export.
      if (e.metadata && typeof e.metadata === "object") row.metadata = e.metadata;
      edges.push(row);
    }
  }
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    exportedAt: nowIso(),
    cwd: cwd || "",
    dim: DIM,
    nodes,
    edges,
  };
}

export function findByUri(db, uri) {
  const needle = String(uri || "").trim();
  if (!needle) return null;
  for (const id of db.allNodeIds?.() || []) {
    const payload = db.get(id)?.payload;
    if (payload?.uri === needle) return Number(id);
  }
  return null;
}

/**
 * Merge an exported graph into the open workspace. Remaps ids; skips extra
 * workspace roots.
 *
 * Revision edges are validated as a whole before anything is written, and
 * conflicts with the live chain are reported instead of applied: an import must
 * never resurrect an old version or half-build a chain.
 */
export function importGraph(db, graph, { reconcileSnapshot = false } = {}) {
  const body = graph?.graph && Array.isArray(graph.graph.nodes) ? graph.graph : graph;
  const nodes = Array.isArray(body?.nodes) ? body.nodes : null;
  if (!nodes) return { ok: false, message: "不是本插件导出的 JSON" };
  const edges = Array.isArray(body.edges) ? body.edges : [];
  const version = Number(body.version) || 1;

  const payloadByOldId = new Map();
  const duplicateIds = [];
  for (const row of nodes) {
    const oldId = Number(row?.id);
    if (!Number.isFinite(oldId)) continue;
    if (payloadByOldId.has(oldId)) {
      duplicateIds.push(oldId);
      continue;
    }
    payloadByOldId.set(oldId, row?.payload && typeof row.payload === "object" ? { ...row.payload } : null);
  }
  if (duplicateIds.length) {
    return {
      ok: false,
      status: 400,
      code: "DUPLICATE_ID",
      message: "导入文件包含重复的节点 id，未写入任何内容。",
      conflicts: duplicateIds.map((id) => ({ code: "duplicate-id", id })),
    };
  }

  const revisionEdges = edges
    .filter((e) => REVISION_EDGES.includes(String(e.label || "")))
    .map((e) => ({ from: Number(e.from), to: Number(e.to), metadata: e.metadata || null }));

  if (revisionEdges.length) {
    // Pure structural pass over the imported graph, before any write.
    const structure = validateRevisionStructure({
      edges: revisionEdges,
      payloadOf: (id) => payloadByOldId.get(Number(id)) || null,
    });
    if (!structure.ok) {
      return {
        ok: false,
        status: 409,
        code: "REVISION_LINKED",
        message: "导入的版本关系未通过校验，未写入任何内容。",
        conflicts: structure.conflicts,
      };
    }
  }

  // One stable URI may appear only once in a file: two nodes claiming the same
  // identity cannot be planned one-to-one.
  const uriOwner = new Map();
  for (const [oldId, payload] of payloadByOldId) {
    const uri = String(payload?.uri || "").trim();
    if (!uri) continue;
    if (uriOwner.has(uri)) {
      return {
        ok: false,
        status: 409,
        code: "DUPLICATE_URI",
        message: "导入文件里同一个 URI 对应了多个节点，未写入任何内容。",
        conflicts: [{ code: "duplicate-uri", uri }],
      };
    }
    uriOwner.set(uri, oldId);
  }

  const versionNodeIds = new Set();
  for (const edge of revisionEdges) {
    versionNodeIds.add(Number(edge.from));
    versionNodeIds.add(Number(edge.to));
  }

  const root = workspaceId(db);
  const idMap = new Map();
  const creates = [];
  const merges = [];
  for (const [oldId, payload] of payloadByOldId) {
    if (!payload) continue;
    const type = String(payload.type || "");
    if (type === "workspace") {
      if (root != null) idMap.set(oldId, root);
      continue;
    }
    if (!NODE_TYPES.includes(type)) continue;
    const uri = String(payload.uri || "").trim();
    let dest = null;
    if (uri) {
      /*
       * A stable URI is the only identity. Text similarity must never merge two
       * version nodes: that is what turned `new --supersedes--> old` into a
       * self loop when one body contained the other (REVIEW P1-3).
       */
      dest = findByUri(db, uri);
    } else if (versionNodeIds.has(oldId)) {
      return {
        ok: false,
        status: 409,
        code: "REVISION_LINKED",
        message: "版本链上的节点缺少稳定 URI，无法确定身份，未写入任何内容。",
        conflicts: [{ code: "ambiguous-identity", id: oldId }],
      };
    } else {
      // Legacy v1 exports have no URI; plain facts keep the text fallback.
      dest = findMergeTarget(db, payload, { allowRevisionLinked: true });
    }
    if (dest != null) {
      idMap.set(oldId, Number(dest));
      merges.push({ oldId, payload, dest: Number(dest) });
    } else {
      creates.push({ oldId, payload });
    }
  }

  // Pre-allocate ids so nodes and edges can be committed in one transaction.
  const usedIds = new Set((db.allNodeIds?.() || []).map(Number).filter((id) => Number.isFinite(id)));
  let nextId = usedIds.size ? Math.max(...usedIds) + 1 : 1;
  for (const row of creates) {
    while (usedIds.has(nextId)) nextId += 1;
    if (!Number.isSafeInteger(nextId)) {
      return { ok: false, status: 400, code: "ID_RANGE", message: "无法分配安全整数 id，未写入任何内容。" };
    }
    row.dest = nextId;
    usedIds.add(nextId);
    idMap.set(row.oldId, nextId);
    nextId += 1;
  }

  const mappedRevision = [];
  for (const edge of revisionEdges) {
    const from = idMap.get(Number(edge.from));
    const to = idMap.get(Number(edge.to));
    if (from == null || to == null) {
      return {
        ok: false,
        status: 409,
        code: "REVISION_LINKED",
        message: "导入的版本关系引用了文件里不存在的节点，未写入任何内容。",
        conflicts: [{ code: "unmapped", id: Number(edge.from) }],
      };
    }
    mappedRevision.push({ from: Number(from), to: Number(to), metadata: edge.metadata });
  }

  const conflicts = [];
  for (const row of merges) {
    const live = db.get(row.dest)?.payload || {};
    if (String(row.payload.text || "").trim() === String(live.text || "").trim()) continue;
    if (isRevisionLinked(db, row.dest)) conflicts.push({ code: "chain-body", id: row.dest });
  }
  for (const edge of mappedRevision) {
    const existing = successorOf(db, edge.to);
    if (existing != null && Number(existing) !== edge.from) {
      conflicts.push({ code: "already-superseded", id: edge.to });
    }
  }
  if (conflicts.length) {
    return {
      ok: false,
      status: 409,
      code: "REVISION_LINKED",
      message: "导入内容与现有的决策替代链冲突，未写入。",
      conflicts,
    };
  }

  /*
   * Validate the graph the import would leave behind — live edges plus the
   * mapped ones — not just the file. This catches a mapping that collapses two
   * identities into one, or closes a cycle against existing history.
   */
  const plannedPayloadByDest = new Map();
  for (const [oldId, payload] of payloadByOldId) {
    const dest = idMap.get(oldId);
    if (dest != null && payload) plannedPayloadByDest.set(Number(dest), payload);
  }
  // Validate the exact payloads to be committed, including snapshot removals.
  // JSON imports merge; Git JSONL additionally archives omitted business nodes.
  for (const row of merges) {
    const live = db.get(row.dest)?.payload || {};
    plannedPayloadByDest.set(row.dest, {
      ...mergePayload(live, { ...row.payload, until: row.payload.until ?? "" }),
      // Imports restore the explicit snapshot state; ordinary extraction merges
      // keep mergePayload's conservative treatment of local archived records.
      status: row.payload.status || live.status || "active",
    });
  }
  const archivedIds = [];
  if (reconcileSnapshot) {
    const present = new Set(idMap.values());
    for (const id of db.allNodeIds?.() || []) {
      const payload = db.get(Number(id))?.payload || {};
      if (present.has(Number(id)) || !BUSINESS_NODE_TYPES.includes(payload.type) || payload.status === "archived") continue;
      plannedPayloadByDest.set(Number(id), { ...payload, status: "archived", updatedAt: nowIso() });
      archivedIds.push(Number(id));
    }
  }
  const finalPayloadOf = (id) => plannedPayloadByDest.get(Number(id)) || db.get(Number(id))?.payload || null;
  const finalRevisionEdges = [];
  for (const id of db.allNodeIds?.() || []) {
    for (const e of db.get(id)?.edges || []) {
      if (String(e.label) === EDGE_LABELS.supersedes) {
        finalRevisionEdges.push({ from: Number(id), to: edgeTarget(e) });
      }
    }
  }
  for (const edge of mappedRevision) finalRevisionEdges.push({ from: edge.from, to: edge.to });
  const finalStructure = validateRevisionStructure({ edges: finalRevisionEdges, payloadOf: finalPayloadOf });
  if (!finalStructure.ok) {
    return {
      ok: false,
      status: 409,
      code: "REVISION_LINKED",
      message: "映射到本地节点后版本链不成立，未写入任何内容。",
      conflicts: finalStructure.conflicts,
    };
  }

  /*
   * Every fact operation goes into one native transaction: new nodes (with
   * pre-allocated ids), payload updates, workspace links, business edges and
   * revision edges. A failure therefore leaves the database logically untouched
   * instead of reporting ok with half a graph.
   */
  const ops = [];
  const createdPayloads = new Map();
  for (const row of creates) {
    const payload = decorateUntil({
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...row.payload,
    });
    createdPayloads.set(row.dest, payload);
    ops.push({ type: "insertWithId", id: row.dest, vector: zeroVector(), payload });
    if (root != null) {
      ops.push({
        type: "upsertEdge",
        src: row.dest,
        dst: root,
        label: EDGE_LABELS.inWorkspace,
        weight: weightOf(EDGE_LABELS.inWorkspace),
      });
    }
  }

  const updatedIds = [];
  for (const row of merges) {
    const node = db.get(row.dest);
    if (!node) continue;
    // An exported snapshot is authoritative, including a cleared deadline.
    const next = plannedPayloadByDest.get(row.dest);
    ops.push({ type: "updatePayload", id: row.dest, payload: next });
    updatedIds.push(row.dest);
  }
  for (const id of archivedIds) {
    ops.push({ type: "updatePayload", id, payload: plannedPayloadByDest.get(id) });
    updatedIds.push(id);
  }

  const revisionConflicts = [];
  if (reconcileSnapshot) {
    const want = new Set(edges.map((e) => `${idMap.get(Number(e.from))}\0${idMap.get(Number(e.to))}\0${e.label}`));
    for (const id of db.allNodeIds?.() || []) {
      const node = db.get(Number(id));
      if (!BUSINESS_NODE_TYPES.includes(node?.payload?.type)) continue;
      for (const edge of node.edges || []) {
        const target = edgeTarget(edge);
        if (!BUSINESS_NODE_TYPES.includes(db.get(target)?.payload?.type)) continue;
        if (want.has(`${Number(id)}\0${target}\0${edge.label}`)) continue;
        if (BUSINESS_EDGES.includes(edge.label)) {
          ops.push({ type: "unlinkLabel", src: Number(id), dst: target, label: edge.label });
        } else if (REVISION_EDGES.includes(edge.label)) {
          // A pulled file cannot silently revoke confirmed history.
          revisionConflicts.push({ code: "relation-missing-in-file", from: node.payload.uri, to: db.get(target)?.payload?.uri });
        }
      }
    }
  }

  let linked = 0;
  for (const e of edges) {
    const label = e.label || EDGE_LABELS.about;
    if (REVISION_EDGES.includes(String(label))) continue;
    const from = idMap.get(Number(e.from));
    const to = idMap.get(Number(e.to));
    if (from == null || to == null || from === to) continue;
    if (hasEdge(db, from, to, label)) continue;
    ops.push({ type: "upsertEdge", src: from, dst: to, label, weight: weightOf(label) });
    linked += 1;
  }

  let revisionLinked = 0;
  const seenPairs = new Set();
  for (const edge of mappedRevision) {
    const pair = `${edge.from}\u0000${edge.to}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    if (hasEdge(db, edge.from, edge.to, EDGE_LABELS.supersedes)) continue;
    ops.push({
      type: "upsertEdge",
      src: edge.from,
      dst: edge.to,
      label: EDGE_LABELS.supersedes,
      weight: weightOf(EDGE_LABELS.supersedes),
      metadata: edge.metadata || { at: nowIso() },
    });
    revisionLinked += 1;
  }

  try {
    if (ops.length) db.commitTransaction(ops);
  } catch (err) {
    return {
      ok: false,
      status: 409,
      code: "TRANSACTION_FAILED",
      message: `导入事务失败，未写入任何内容：${err.message}`,
      conflicts: [{ code: "transaction-failed", message: String(err.message || err) }],
    };
  }

  /*
   * Facts are committed. The text index and embeddings are derived data: they
   * are rebuilt after the transaction and cannot roll the graph back. A failure
   * here is visible on the next search rather than being reported as a failed
   * import that actually wrote rows.
   */
  for (const [id, payload] of createdPayloads) {
    indexNode(db, id, payload);
    queueEmbed(db, id, payload);
  }
  for (const id of updatedIds) {
    const payload = db.get(id)?.payload || {};
    indexNode(db, id, payload);
    queueEmbed(db, id, payload);
    announceFactChange(db, id, payload, "导入更新了这条事实。");
  }
  persist(db);

  return {
    ok: true,
    version,
    created: creates.length,
    merged: merges.length,
    linked,
    revisionLinked,
    revisionConflicts,
    nodes: idMap.size,
  };
}

export function hasEdge(db, from, to, label) {
  const node = db.get(Number(from));
  return (node?.edges || []).some(
    (e) => edgeTarget(e) === Number(to) && (!label || e.label === label),
  );
}

/** Link once for a (from, to, label) triple. */
export function ensureLink(db, from, to, label) {
  const src = Number(from);
  const dst = Number(to);
  if (!Number.isFinite(src) || !Number.isFinite(dst) || src === dst) return false;
  if (hasEdge(db, src, dst, label)) return false;
  db.link(src, dst, label, weightOf(label));
  persist(db);
  return true;
}

/** Drop one labeled edge when the engine supports unlink(src, dst, label). */
export function dropLink(db, from, to, label) {
  const src = Number(from);
  const dst = Number(to);
  if (!Number.isFinite(src) || !Number.isFinite(dst)) return false;
  if (!hasEdge(db, src, dst, label)) return false;
  try {
    if (label) db.unlink(src, dst, label);
    else db.unlink(src, dst);
    persist(db);
    return true;
  } catch {
    return false;
  }
}

function pickMergedText(oldText, incomingText) {
  const a = String(oldText || "").trim();
  const b = String(incomingText || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (b.length >= a.length && b.includes(a) && b.length > Math.max(80, a.length * 2)) return a;
  if (a.length >= b.length && a.includes(b) && a.length > Math.max(80, b.length * 2)) return b;
  return b.length >= a.length ? b : a;
}

function decorateUntil(payload, from = payload.createdAt) {
  const body = { ...payload };
  const until = String(body.until || "").trim();
  if (!until) {
    delete body.until;
    delete body.untilAt;
    return body;
  }
  body.until = until;
  if (!body.untilAt || !Number.isFinite(Date.parse(body.untilAt))) {
    delete body.untilAt;
    const untilAt = resolveUntilAt(until, from);
    if (untilAt) body.untilAt = untilAt;
  }
  return body;
}

export function insertNode(db, payload, { linkToWorkspace = true } = {}) {
  const body = decorateUntil({
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...payload,
  });
  const id = db.insert(zeroVector(), body);
  indexNode(db, id, body);
  if (linkToWorkspace && body.type !== "workspace") {
    const root = workspaceId(db);
    if (root != null) ensureLink(db, id, root, EDGE_LABELS.inWorkspace);
  }
  persist(db);
  queueEmbed(db, id, body);
  return id;
}

function persistVector(db, id, vec) {
  const fn = db.updateVector || db.update_vector;
  if (typeof fn !== "function" || !Array.isArray(vec)) return false;
  try {
    fn.call(db, Number(id), vec);
    db.flush();
    return true;
  } catch {
    return false;
  }
}

function queueEmbed(db, id, payload) {
  if (payload?.type === "episode") return;
  if (!embeddingEnabled()) return;
  const text = indexTextFor(payload);
  if (!text) return;
  embedText(text)
    .then((vec) => {
      if (vec) persistVector(db, id, vec);
    })
    .catch(() => {});
}

export async function embedQueryVector(text) {
  if (!embeddingEnabled()) return null;
  return embedText(text);
}

export async function backfillEmbeddings(db, { log } = {}) {
  if (!embeddingEnabled()) return { ok: false, message: "embedding off", embedded: 0, failed: 0 };
  let embedded = 0;
  let failed = 0;
  for (const id of db.allNodeIds?.() || []) {
    const node = db.get(id);
    const payload = node?.payload;
    if (!payload || payload.status === "archived" || payload.type === "episode") continue;
    const text = indexTextFor(payload);
    if (!text) continue;
    const vec = await embedText(text);
    if (!vec || !persistVector(db, id, vec)) {
      failed += 1;
      log?.warn?.(`[dsh-trivium] embed backfill failed id=${id}`);
    } else {
      embedded += 1;
    }
  }
  return { ok: true, embedded, failed };
}

/**
 * @param onStage - optional observer `(stageName, ids)` called once per pipeline
 *   branch that actually produced candidates. Used by the recall trace, which
 *   must not claim a branch ran when it did not.
 */
export function searchNodes(db, query, { topK = 8, expandDepth = 1, now, queryVector, includeStale = true, onStage } = {}) {
  const text = String(query || "").trim();
  if (!text) return [];
  const at = now instanceof Date ? now : new Date();
  const primary = new Map();
  const terms = queryTerms(text);
  const hasQueryVector = Array.isArray(queryVector) && queryVector.length === DIM &&
    queryVector.every(Number.isFinite) && queryVector.some((value) => value !== 0);
  const identifierQuery = /^[a-z0-9_]+(?:[-./:][a-z0-9_]+)+$/i.test(text);
  const consider = (id, nativeScore = 0) => {
    const rec = hitRecord(db, id);
    if (!rec) return;
    // A native BM25/vector hit is already a retrieval candidate. Lexical
    // evidence may boost it, but must never veto it with an exact-phrase gate.
    const lexical = primaryScore(rec.payload, text, at, terms);
    // Explicit keywords are additive in 0.8.x. A renamed node may still have
    // an old native keyword: require some current token evidence for text-only
    // hits, never the whole query phrase. Vector-only hits need no such overlap.
    const currentText = indexTextFor(rec.payload).toLowerCase();
    if (!hasQueryVector && lexical <= 0 && !terms.some((term) => currentText.includes(term))) return;
    // Keep code identifiers atomic: a sparse hit for just "X" must not turn
    // an exact X-Request-Id lookup into a hit on an unrelated header X fact.
    if (identifierQuery && !hasQueryVector && lexical <= 0) return;
    const score = Math.max(lexical, Number.isFinite(nativeScore) ? nativeScore : 0);
    if (score <= 0) return;
    rec.score = score;
    rec.query = text;
    rec.now = at;
    const prev = primary.get(rec.id);
    if (!prev || rec.score > prev.score) primary.set(rec.id, rec);
  };
  const report = (stage, ids) => {
    if (typeof onStage !== "function") return;
    try {
      onStage(stage, ids);
    } catch {
      // a broken observer must not break retrieval
    }
  };
  try {
    const vec =
      hasQueryVector ? queryVector : zeroVector();
    const hits = db.searchHybrid(vec, text, Math.max(topK, 16), 0, 0.01, 0.2, {
      type: { $in: ["entity", "decision", "preference", "experience"] },
      status: { $ne: "archived" },
    });
    report("native-hybrid", (hits || []).map((hit) => hit.id));
    for (const hit of hits || []) consider(hit.id, Number(hit.score));
  } catch {
    // fall through to keyword scan
  }
  const fallback = keywordFallback(db, text, 64, terms);
  report("keyword-fallback", fallback.map((hit) => hit.id));
  for (const hit of fallback) consider(hit.id);
  const anchors = entityAnchorIds(db, text);
  report("entity-anchor", anchors);
  for (const id of anchors) consider(id);
  if (queryMentionsUntil(text)) {
    for (const id of db.allNodeIds?.() || []) consider(id);
    report("deadline-scan", [...primary.keys()]);
  }

  const normalized = [];
  for (const hit of [...primary.values()]) {
    const dest = sameAsTarget(db, hit.id);
    if (dest == null || dest === hit.id || primary.has(dest)) continue;
    const rec = hitRecord(db, dest);
    if (!rec) continue;
    rec.score = Math.max(hit.score || 0, 1);
    rec.fromSameAs = true;
    rec.query = text;
    rec.now = at;
    primary.set(dest, rec);
    normalized.push(dest);
  }
  report("same-as-normalize", normalized);

  const out = new Map(primary);
  if (expandDepth > 0) {
    const expanded = [];
    for (const hit of primary.values()) {
      for (const nid of businessNeighborIds(db, hit.id)) {
        if (out.has(nid)) continue;
        const rec = hitRecord(db, nid);
        if (rec) {
          rec.score = 1;
          rec.fromExpand = true;
          rec.query = text;
          rec.now = at;
          out.set(nid, rec);
          expanded.push(nid);
        }
      }
    }
    report("business-expand", expanded);
  }
  const typeRank = { entity: 0, decision: 1, preference: 2, experience: 3 };
  return [...out.values()]
    .filter((hit) => includeStale || !isStalePayload(hit.payload, at))
    .map((hit) => ({ ...hit, includeStale }))
    .sort((a, b) => {
      const rb = rankBoost(db, b, text, at) - rankBoost(db, a, text, at);
      if (rb) return rb;
      const score = (b.score || 0) - (a.score || 0);
      if (score) return score;
      return (typeRank[a.payload?.type] ?? 9) - (typeRank[b.payload?.type] ?? 9);
    })
    .slice(0, topK);
}

/** Entity-name hit → that entity plus unexpired business-edge neighbors. Empty if query names none. */
export function namedRecallHits(db, query, { topK = 8, now, onStage } = {}) {
  const text = String(query || "").trim();
  const ids = entityAnchorIds(db, text);
  if (!ids.length) return [];
  const at = now instanceof Date ? now : new Date();
  const out = new Map();
  const report = (stage, list) => {
    if (typeof onStage !== "function") return;
    try {
      onStage(stage, list);
    } catch {
      // ignore a broken observer
    }
  };
  report("entity-anchor", ids);
  const expanded = [];
  for (const id of ids) {
    const rec = hitRecord(db, id);
    if (rec) {
      rec.score = 4;
      rec.query = text;
      rec.now = at;
      rec.fromAnchor = true;
      out.set(rec.id, rec);
    }
    for (const nid of businessNeighborIds(db, id)) {
      if (out.has(nid)) continue;
      const nrec = hitRecord(db, nid);
      if (!nrec) continue;
      nrec.score = 1;
      nrec.fromExpand = true;
      nrec.query = text;
      nrec.now = at;
      out.set(nid, nrec);
      expanded.push(nid);
    }
  }
  report("business-expand", expanded);
  return [...out.values()]
    .filter((hit) => !isStalePayload(hit.payload, at))
    .slice(0, topK);
}

function hasBusinessEdge(db, hit) {
  const want = new Set(BUSINESS_EDGES);
  if ((hit.edges || []).some((e) => want.has(e.label))) return true;
  return incomingBusinessEdges(db, hit.id).length > 0;
}

function rankBoost(db, hit, query, now) {
  let n = 0;
  if (hasBusinessEdge(db, hit)) n += 4;
  const stale = isStalePayload(hit.payload, now);
  if (stale) n -= 6;
  else if (hit.payload?.until) n += 1;
  if (stale && queryMentionsUntil(query, hit.payload)) n += 3;
  return n;
}

function hitRecord(db, id) {
  const node = db.get(Number(id));
  if (
    !node ||
    node.payload?.status === "archived" ||
    node.payload?.type === "workspace" ||
    node.payload?.type === "episode" ||
    payloadLooksDirty(node.payload)
  ) {
    return null;
  }
  return {
    id: Number(id),
    score: 0,
    payload: node.payload,
    edges: node.edges || [],
  };
}

const MIN_ENTITY_ANCHOR = 3;

function longEnoughAnchor(label) {
  return label.length >= MIN_ENTITY_ANCHOR || /^[\p{Script=Han}]{2}$/u.test(label);
}

function entityAnchorLabels(payload) {
  return uniqueStrings([payload?.name, ...(payload?.aliases || [])]).filter(
    longEnoughAnchor,
  );
}

function queryMentionsEntityName(queryLower, nameLower) {
  if (!queryLower || !nameLower || !longEnoughAnchor(nameLower)) return false;
  if (queryLower === nameLower) return true;
  if (/^[\x00-\x7f]+$/.test(nameLower)) {
    const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "i").test(queryLower);
  }
  return queryLower.includes(nameLower);
}

function entityAnchorScore(payload, queryLower) {
  if (payload?.type !== "entity") return 0;
  let best = 0;
  for (const label of entityAnchorLabels(payload)) {
    const name = label.toLowerCase();
    if (name === queryLower) best = Math.max(best, 4);
    else if (queryMentionsEntityName(queryLower, name)) best = Math.max(best, 3);
  }
  return best;
}

function entityAnchorIds(db, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const ids = [];
  for (const n of findByType(db, "entity")) {
    if (n.payload?.status === "archived") continue;
    if (entityAnchorScore(n.payload, q) > 0) ids.push(Number(n.id));
  }
  return ids;
}

const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const QUERY_STOP_WORDS = new Set(["的", "了", "是", "在", "有", "和", "与", "请", "什么", "哪些", "怎么", "如何", "一下", "这个", "我们", "the", "a", "an", "is", "are", "to", "of", "for", "and", "what", "how"]);

function queryTerms(query) {
  const chunks = query.toLowerCase().match(/[\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*/gu) || [];
  return [...new Set(chunks.flatMap((chunk) => /\p{Script=Han}/u.test(chunk)
    ? [...wordSegmenter.segment(chunk)].filter((part) => part.isWordLike).map((part) => part.segment)
    : [chunk])
    .filter((term) => !QUERY_STOP_WORDS.has(term) && (!/\p{Script=Han}/u.test(term) || term.length >= 2)))];
}

function lexicalScore(payload, query, terms = queryTerms(query)) {
  const hay = indexTextFor(payload).toLowerCase();
  if (hay.includes(query)) return 2;
  if (!terms.length) return 0;
  const matched = terms.filter((term) => {
    if (/\p{Script=Han}/u.test(term)) return hay.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "i").test(hay);
  }).length;
  const coverage = matched / terms.length;
  return coverage >= 0.5 ? coverage : 0;
}

function primaryScore(payload, query, now, terms) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const name = String(payload?.name || "").toLowerCase();
  const text = String(payload?.text || "").toLowerCase();
  const until = String(payload?.until || "").toLowerCase();
  let score = 0;
  if (name === q) score = 4;
  else if (name.includes(q)) score = 3;
  else if (text.includes(q) || until.includes(q)) score = 2;
  else score = lexicalScore(payload || {}, q, terms);
  if (
    payload?.type === "decision" &&
    isStalePayload(payload, now) &&
    queryMentionsUntil(query, payload)
  ) {
    score = Math.max(score, 2);
  }
  return Math.max(score, entityAnchorScore(payload, q));
}

function scanBusinessNeighbors(db, id) {
  const ids = new Set();
  const want = new Set(BUSINESS_EDGES);
  const nid = Number(id);
  const labeled = nativeLabeledNeighbors(db, nid, BUSINESS_EDGES);
  if (labeled) {
    for (const other of labeled) ids.add(other);
  } else {
    const node = db.get(nid);
    for (const e of node?.edges || []) {
      if (want.has(e.label)) ids.add(edgeTarget(e));
    }
  }
  const inbound = nativeIncoming(db, nid);
  if (inbound) {
    for (const e of inbound) {
      if (want.has(e.label)) ids.add(edgeSource(e));
    }
  } else {
    for (const other of db.allNodeIds?.() || []) {
      if (Number(other) === nid) continue;
      const n = db.get(other);
      for (const e of n?.edges || []) {
        if (want.has(e.label) && edgeTarget(e) === nid) ids.add(Number(other));
      }
    }
  }
  return ids;
}

export function businessNeighborIds(db, id) {
  const ids = scanBusinessNeighbors(db, id);
  if (typeof db.getIncomingEdges !== "function") {
    const viaTql = tqlBusinessNeighbors(db, id);
    if (viaTql) {
      for (const nid of viaTql) ids.add(Number(nid));
    }
  }
  return [...ids].filter((n) => Number.isFinite(n));
}

/** Chip suggestions: business-edge neighbors of entities named in `text`. Not written to pins. */
export function suggestedNeighborIds(db, text) {
  const ids = new Set();
  for (const eid of entityAnchorIds(db, text)) {
    for (const nid of businessNeighborIds(db, eid)) {
      if (Number(nid) !== Number(eid)) ids.add(Number(nid));
    }
  }
  return [...ids];
}

function tqlBusinessNeighbors(db, id) {
  if (typeof db.tql !== "function") return null;
  const nid = Number(id);
  const found = new Set();
  try {
    for (const label of BUSINESS_EDGES) {
      const outgoing = db.tql(`MATCH (a)-[:${label}]->(b) WHERE a.id == ${nid} RETURN b`);
      const incoming = db.tql(`MATCH (a)-[:${label}]->(b) WHERE b.id == ${nid} RETURN a`);
      for (const row of [...normalizeTql(outgoing), ...normalizeTql(incoming)]) {
        if (row.id !== nid) found.add(row.id);
      }
    }
    return [...found];
  } catch {
    return null;
  }
}

function keywordFallback(db, text, topK, terms) {
  const q = text.toLowerCase();
  const ids = db.allNodeIds?.() || [];
  const hits = [];
  for (const id of ids) {
    const node = db.get(id);
    if (
      !node ||
      node.payload?.status === "archived" ||
      node.payload?.type === "workspace" ||
      node.payload?.type === "episode"
    ) {
      continue;
    }
    const score = lexicalScore(node.payload || {}, q, terms);
    if (!score) continue;
    hits.push({
      id,
      score,
      payload: node.payload,
      edges: node.edges || [],
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

function nodeLabel(db, id) {
  const nid = Number(id);
  let label = String(nid);
  try {
    const payload = db.getPayload(nid) || db.get(nid)?.payload;
    const name = payload?.name || payload?.text;
    if (name) label = `${nid}(${String(name).slice(0, 24)})`;
  } catch {
    // keep numeric id
  }
  return label;
}

function sameAsTarget(db, id) {
  const node = db.get(Number(id));
  for (const e of node?.edges || []) {
    if (e.label === EDGE_LABELS.sameAs) return edgeTarget(e);
  }
  return null;
}

function incomingBusinessEdges(db, id, { query = "", now, hideStale = false } = {}) {
  const nid = Number(id);
  const want = new Set(BUSINESS_EDGES);
  const found = [];
  const seen = new Set();
  const at = now instanceof Date ? now : now ? new Date(now) : new Date();
  const add = (fromId, label) => {
    const src = Number(fromId);
    if (!Number.isFinite(src) || src === nid || !want.has(label)) return;
    const srcNode = db.get(src);
    if (!srcNode || srcNode.payload?.status === "archived") return;
    if (
      hideStale &&
      isStalePayload(srcNode.payload, at)
    ) {
      return;
    }
    const key = `${src}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ fromId: src, label, payload: srcNode.payload });
  };
  const inbound = nativeIncoming(db, nid);
  if (inbound) {
    for (const e of inbound) add(edgeSource(e), e.label);
    return found;
  }
  if (typeof db.tql === "function") {
    try {
      for (const label of BUSINESS_EDGES) {
        const incoming = db.tql(`MATCH (a)-[:${label}]->(b) WHERE b.id == ${nid} RETURN a`);
        for (const row of normalizeTql(incoming)) add(row.id, label);
      }
    } catch {
      // scan below
    }
  }
  for (const other of db.allNodeIds?.() || []) {
    if (Number(other) === nid) continue;
    const n = db.get(other);
    if (!n || n.payload?.status === "archived") continue;
    for (const e of n.edges || []) {
      if (want.has(e.label) && edgeTarget(e) === nid) add(other, e.label);
    }
  }
  return found;
}

function edgePath(db, nodeId, edges, { query = "", now, hideStale = true } = {}) {
  const priority = {
    about: 0,
    decided: 1,
    broke: 2,
    fixed: 3,
    same_as: 4,
    in_workspace: 9,
  };
  const parts = [];
  for (const e of incomingBusinessEdges(db, nodeId, { query, now, hideStale })) {
    parts.push({
      sort: priority[e.label] ?? 5,
      text: `<-${e.label}-${nodeLabel(db, e.fromId)}`,
    });
  }
  const seenOut = new Set();
  for (const e of edges || []) {
    const targetId = e.targetId ?? e.target_id;
    if (hideStale && isStalePayload(db.get(Number(targetId))?.payload, now)) continue;
    const key = `${e.label}->${targetId}`;
    if (seenOut.has(key)) continue;
    seenOut.add(key);
    parts.push({
      sort: priority[e.label] ?? 5,
      text: `${e.label}->${nodeLabel(db, targetId)}`,
    });
  }
  return parts
    .sort((a, b) => a.sort - b.sort)
    .slice(0, 8)
    .map((p) => p.text);
}

export function listOutgoingBusiness(db, id) {
  const want = new Set(BUSINESS_EDGES);
  const node = db.get(Number(id));
  const out = [];
  const seen = new Set();
  for (const e of node?.edges || []) {
    if (!want.has(e.label)) continue;
    const tid = edgeTarget(e);
    if (!Number.isFinite(tid)) continue;
    const key = `${e.label}:${tid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const payload = db.get(tid)?.payload;
    if (!payload || payload.status === "archived") continue;
    out.push({
      to: tid,
      label: e.label,
      type: payload.type || "unknown",
      l0: String(payload.text || payload.name || "").slice(0, 200),
    });
  }
  return out;
}

export function listIncomingBusiness(db, id, opts = {}) {
  return incomingBusinessEdges(db, id, opts).map((e) => ({
    from: e.fromId,
    label: e.label,
    type: e.payload?.type || "unknown",
    l0: String(e.payload?.text || e.payload?.name || "").slice(0, 200),
  }));
}

/**
 * Incoming edges for an arbitrary label set (revision edges are not business
 * edges, so they cannot go through incomingBusinessEdges).
 *
 * Uses the native incoming index when available and otherwise scans outgoing
 * edges. Only the management UI and the revision resolver call this, never the
 * hot retrieval path.
 */
export function incomingLabeled(db, id, labels) {
  const want = new Set([...(labels || [])].map(String));
  const target = Number(id);
  if (!want.size || !Number.isFinite(target)) return [];
  const found = [];
  const push = (from, label) => {
    if (!Number.isFinite(from) || !want.has(String(label))) return;
    if (found.some((row) => row.from === from && row.label === label)) return;
    found.push({ from, label: String(label) });
  };
  const native = nativeIncoming(db, target);
  if (Array.isArray(native)) {
    for (const e of native) push(edgeSource(e), e.label ?? e.edge_label);
    return found;
  }
  for (const raw of db.allNodeIds?.() || []) {
    const from = Number(raw);
    if (!Number.isFinite(from)) continue;
    const node = db.get(from);
    for (const e of node?.edges || []) {
      if (edgeTarget(e) !== target) continue;
      push(from, e.label);
    }
  }
  return found;
}

export function formatHit(db, hit, opts = {}) {
  const node = db.get(hit.id) || { payload: hit.payload, edges: [] };
  const payload = node.payload || {};
  const l0 = payload.text || payload.name || "";
  const query = opts.query ?? hit.query ?? "";
  const now = opts.now ?? hit.now;
  const stale = isStalePayload(payload, now instanceof Date ? now : undefined);
  return {
    id: hit.id,
    type: payload.type || "unknown",
    score: Number(hit.score || 0),
    l0: l0.slice(0, 200),
    until: payload.until || "",
    stale,
    path: edgePath(db, hit.id, node.edges || [], { query, now, hideStale: hit.includeStale !== true }),
  };
}

export function buildShortMapReport(db, budgetTokens = 400) {
  const counts = { entity: 0, preference: 0, decision: 0, experience: 0 };
  const buckets = { preference: [], decisionUntil: [], decision: [], entity: [], experience: [] };
  for (const type of ["preference", "decision", "entity", "experience"]) {
    const nodes = findByType(db, type);
    counts[type] = nodes.length;
    for (const n of nodes) {
      if (n.payload?.type === "episode") continue;
      if (payloadLooksDirty(n.payload)) continue;
      if (type === "decision" && isStalePayload(n.payload)) continue;
      let label = n.payload?.name || n.payload?.text;
      if (!label) continue;
      if (type === "decision" && n.payload?.until) {
        const core = String(label).replace(/\s+/g, " ").slice(0, 28);
        label = `${core} until ${n.payload.until}`;
        buckets.decisionUntil.push(`decision:${label}`);
      } else {
        buckets[type].push(`${type}:${String(label).slice(0, 40)}`);
      }
    }
  }
  const names = [];
  const take = (list, max) => {
    let n = max;
    while (list.length && n > 0 && names.length < 8) {
      names.push(list.shift());
      n -= 1;
    }
  };
  take(buckets.preference, 4);
  take(buckets.decisionUntil, 2);
  take(buckets.entity, 8);
  take(buckets.decision, 8);
  take(buckets.experience, 8);
  take(buckets.preference, 8);
  take(buckets.decisionUntil, 8);
  const lines = [
    "dsh-trivium memory map (use ctx_find naming an entity for unexpired neighbors; ctx_read for full text).",
    `entities=${counts.entity} preferences=${counts.preference} decisions=${counts.decision} experiences=${counts.experience}`,
  ];
  if (names.length) lines.push(`named: ${names.join("; ")}`);
  const text = clipToTokenBudget(lines.join("\n"), budgetTokens);
  return { text, tokens: estimateTokens(text), counts };
}

export function buildShortMap(db, budgetChars = 1600) {
  const tokens = Math.max(1, Math.floor(Number(budgetChars) / 4) || 400);
  return buildShortMapReport(db, tokens).text;
}
