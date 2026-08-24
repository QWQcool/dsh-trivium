import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIM, EDGE_LABELS, BUSINESS_EDGES, NODE_TYPES, indexTextFor, nowIso, weightOf, zeroVector } from "./schema.js";
import { clipToTokenBudget, estimateTokens } from "./tokens.js";
import { isStalePayload, parseUntilFromText, queryMentionsUntil, resolveUntilAt } from "./until.js";
import { embedText, embeddingEnabled } from "./embed.js";
import { payloadLooksDirty, sanitizeForWrite } from "./hygiene.js";

const require = createRequire(fileURLToPath(import.meta.url));

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
  const db = new Engine(dbPathFor(key), DIM);
  try {
    db.createIndex("type");
    db.createIndex("status");
  } catch {
    // indexes may already exist
  }
  ensureWorkspaceRoot(db, cwd);
  rebuildTextIndex(db);
  dbs.set(key, db);
  return db;
}

export function closeAll() {
  for (const db of dbs.values()) {
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
      if (!node || typeof node.id !== "number") return null;
      return { id: node.id, payload: node.payload || {} };
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

export function findMergeTarget(db, candidate) {
  const type = candidate?.type;
  if (!type || type === "episode") return null;
  const name = String(candidate.name || "").trim().toLowerCase();
  const text = String(candidate.text || "").trim().toLowerCase();
  for (const n of findByType(db, type)) {
    const payload = n.payload || {};
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

export function mergeInto(db, id, incoming) {
  const node = db.get(Number(id));
  if (!node) return insertNode(db, incoming);
  const old = node.payload || {};
  const aliases = uniqueStrings([
    ...(old.aliases || []),
    ...(incoming.aliases || []),
    incoming.name,
    old.name,
  ]).filter((a) => a !== (incoming.name || old.name));
  const next = decorateUntil({
    ...old,
    ...incoming,
    name: incoming.name || old.name,
    text: pickMergedText(old.text, incoming.text),
    aliases,
    createdAt: old.createdAt || incoming.createdAt || nowIso(),
    updatedAt: nowIso(),
    status: old.status || "active",
    source: incoming.source || old.source,
  });
  db.updatePayload(Number(id), next);
  indexNode(db, Number(id), next);
  db.flush();
  queueEmbed(db, Number(id), next);
  return Number(id);
}

export function listNodes(
  db,
  { type, q, includeArchived = false, includeStale = false, aboutId, includeEpisodes = false } = {},
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
  db.flush();
  return true;
}

export function deleteNode(db, id) {
  const n = Number(id);
  if (!db.contains?.(n) && !db.get(n)) return false;
  db.delete(n);
  rebuildTextIndex(db);
  db.flush();
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
  if (patch.text !== undefined) next.text = String(patch.text || "").trim();
  if (Array.isArray(patch.aliases)) {
    next.aliases = uniqueStrings(patch.aliases).filter((a) => a !== next.name);
  }
  if (patch.until !== undefined) {
    const until = String(patch.until || "").trim();
    if (until) {
      next.until = until;
      const untilAt = resolveUntilAt(until, next.createdAt);
      if (untilAt) next.untilAt = untilAt;
    } else {
      delete next.until;
      delete next.untilAt;
    }
  }
  const body = decorateUntil({
    ...next,
    type: old.type,
    createdAt: old.createdAt,
    status: old.status || "active",
    updatedAt: nowIso(),
  });
  const gate = sanitizeForWrite([body.name, body.text, body.fail, body.fix].filter(Boolean).join("\n"));
  if (!gate.ok && gate.reason !== "empty") {
    const err = new Error(gate.reason);
    err.code = "DIRTY";
    throw err;
  }
  db.updatePayload(nid, body);
  indexNode(db, nid, body);
  db.flush();
  queueEmbed(db, nid, body);
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
    untilAt: pa.untilAt || pb.untilAt,
    source: pa.source || pb.source,
  });
  ensureLink(db, drop, keep, EDGE_LABELS.sameAs);
  archiveNode(db, drop);
  return { ok: true, keep, drop, type: pa.type };
}

export function exportGraph(db, cwd = "") {
  const nodes = [];
  const edges = [];
  for (const id of db.allNodeIds?.() || []) {
    const node = db.get(id);
    if (!node) continue;
    nodes.push({ id: Number(id), payload: node.payload || {} });
    for (const e of node.edges || []) {
      edges.push({
        from: Number(id),
        to: edgeTarget(e),
        label: e.label || "",
        weight: e.weight ?? null,
      });
    }
  }
  return {
    format: "dsh-trivium-graph",
    version: 1,
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

/** Merge an exported graph into the open workspace. Remaps ids; skips extra workspace roots. */
export function importGraph(db, graph) {
  const body = graph?.graph && Array.isArray(graph.graph.nodes) ? graph.graph : graph;
  const nodes = Array.isArray(body?.nodes) ? body.nodes : null;
  if (!nodes) return { ok: false, message: "不是本插件导出的 JSON" };
  const edges = Array.isArray(body.edges) ? body.edges : [];
  const idMap = new Map();
  const root = workspaceId(db);
  let created = 0;
  let merged = 0;
  let linked = 0;
  for (const row of nodes) {
    const oldId = Number(row?.id);
    const payload = row?.payload && typeof row.payload === "object" ? { ...row.payload } : null;
    if (!payload || !Number.isFinite(oldId)) continue;
    if (payload.type === "workspace") {
      if (root != null) idMap.set(oldId, root);
      continue;
    }
    if (!NODE_TYPES.includes(payload.type)) continue;
    let dest = findByUri(db, payload.uri);
    if (dest == null) dest = findMergeTarget(db, payload);
    if (dest != null) {
      mergeInto(db, dest, payload);
      idMap.set(oldId, dest);
      merged += 1;
    } else {
      const next = insertNode(db, payload);
      idMap.set(oldId, next);
      created += 1;
    }
  }
  for (const e of edges) {
    const from = idMap.get(Number(e.from));
    const to = idMap.get(Number(e.to));
    const label = e.label || EDGE_LABELS.about;
    if (from == null || to == null || from === to) continue;
    if (ensureLink(db, from, to, label)) linked += 1;
  }
  return { ok: true, created, merged, linked, nodes: idMap.size };
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
  db.flush();
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
    db.flush();
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

function decorateUntil(payload) {
  const body = { ...payload };
  if (body.type === "decision" && !body.until) {
    const until = parseUntilFromText(body.text);
    if (until) body.until = until;
  }
  if (body.until && !body.untilAt) {
    const untilAt = resolveUntilAt(body.until, body.createdAt);
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
  db.flush();
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

export function searchNodes(db, query, { topK = 8, expandDepth = 1, now, queryVector } = {}) {
  const text = String(query || "").trim();
  if (!text) return [];
  const at = now instanceof Date ? now : new Date();
  const primary = new Map();
  const consider = (id) => {
    const rec = hitRecord(db, id);
    if (!rec) return;
    const score = primaryScore(rec.payload, text, at);
    if (score <= 0) return;
    rec.score = score;
    rec.query = text;
    rec.now = at;
    const prev = primary.get(rec.id);
    if (!prev || rec.score > prev.score) primary.set(rec.id, rec);
  };
  try {
    const vec =
      Array.isArray(queryVector) && queryVector.length === DIM ? queryVector : zeroVector();
    const hits = db.searchHybrid(vec, text, Math.max(topK, 16), 0, 0.01, 0.2);
    for (const hit of hits || []) consider(hit.id);
  } catch {
    // fall through to keyword scan
  }
  for (const hit of keywordFallback(db, text, 64)) consider(hit.id);
  for (const id of entityAnchorIds(db, text)) consider(id);
  if (queryMentionsUntil(text)) {
    for (const id of db.allNodeIds?.() || []) consider(id);
  }

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
  }

  const out = new Map(primary);
  if (expandDepth > 0) {
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
        }
      }
    }
  }
  const typeRank = { entity: 0, decision: 1, preference: 2, experience: 3 };
  return [...out.values()]
    .filter((hit) => !shouldHideStale(hit, text, at))
    .sort((a, b) => {
      const rb = rankBoost(db, b, text, at) - rankBoost(db, a, text, at);
      if (rb) return rb;
      const td = (typeRank[a.payload?.type] ?? 9) - (typeRank[b.payload?.type] ?? 9);
      if (td) return td;
      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, topK);
}

/** Entity-name hit → that entity plus unexpired business-edge neighbors. Empty if query names none. */
export function namedRecallHits(db, query, { topK = 8, now } = {}) {
  const text = String(query || "").trim();
  const ids = entityAnchorIds(db, text);
  if (!ids.length) return [];
  const at = now instanceof Date ? now : new Date();
  const out = new Map();
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
    }
  }
  return [...out.values()]
    .filter((hit) => !shouldHideStale(hit, text, at))
    .slice(0, topK);
}

function hasBusinessEdge(db, hit) {
  const want = new Set(BUSINESS_EDGES);
  if ((hit.edges || []).some((e) => want.has(e.label))) return true;
  return incomingBusinessEdges(db, hit.id).length > 0;
}

function shouldHideStale(hit, query, now) {
  if (hit.payload?.type !== "decision") return false;
  if (!isStalePayload(hit.payload, now)) return false;
  return !queryMentionsUntil(query, hit.payload);
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

function entityAnchorLabels(payload) {
  return uniqueStrings([payload?.name, ...(payload?.aliases || [])]).filter(
    (s) => s.length >= MIN_ENTITY_ANCHOR,
  );
}

function queryMentionsEntityName(queryLower, nameLower) {
  if (!queryLower || !nameLower || nameLower.length < MIN_ENTITY_ANCHOR) return false;
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

function primaryScore(payload, query, now) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const name = String(payload?.name || "").toLowerCase();
  const text = String(payload?.text || "").toLowerCase();
  const until = String(payload?.until || "").toLowerCase();
  let score = 0;
  if (name === q) score = 4;
  else if (name.includes(q)) score = 3;
  else if (text.includes(q) || until.includes(q)) score = 2;
  else if (indexTextFor(payload || {}).toLowerCase().includes(q)) score = 2;
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

function keywordFallback(db, text, topK) {
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
    const hay = indexTextFor(node.payload || {}).toLowerCase();
    if (!hay.includes(q)) continue;
    hits.push({
      id,
      score: 1,
      payload: node.payload,
      edges: node.edges || [],
    });
    if (hits.length >= topK) break;
  }
  return hits;
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
      isStalePayload(srcNode.payload, at) &&
      !queryMentionsUntil(query, srcNode.payload)
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
    path: edgePath(db, hit.id, node.edges || [], { query, now }),
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
