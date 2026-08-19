import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EDGE_LABELS, indexTextFor, nowIso, zeroVector } from "./schema.js";

let TriviumDB = null;
let loadError = null;

async function loadEngine() {
  if (TriviumDB) return TriviumDB;
  if (loadError) throw loadError;
  try {
    const mod = await import("triviumdb");
    TriviumDB = mod.TriviumDB || mod.default?.TriviumDB || mod.default;
    if (!TriviumDB) throw new Error("triviumdb export TriviumDB not found");
    return TriviumDB;
  } catch (err) {
    loadError = err;
    throw err;
  }
}

const dbs = new Map();

export function dbPathFor(cwd) {
  return join(cwd, ".dsh", "trivium.tdb");
}

export async function openWorkspaceDb(cwd) {
  const key = cwd;
  if (dbs.has(key)) return dbs.get(key);
  mkdirSync(join(cwd, ".dsh"), { recursive: true });
  const Engine = await loadEngine();
  const db = new Engine(dbPathFor(cwd));
  try {
    db.createIndex("type");
    db.createIndex("status");
  } catch {
    // indexes may already exist
  }
  ensureWorkspaceRoot(db, cwd);
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
  try {
    db.indexText(id, indexTextFor(payload));
    db.buildTextIndex();
  } catch {
    // text index is optional in P0
  }
  return id;
}

export function workspaceId(db) {
  return findByType(db, "workspace")[0]?.id ?? null;
}

export function findByType(db, type) {
  try {
    const rows = db.tql(`FIND {type: ${JSON.stringify(type)}, status: "active"} RETURN *`);
    return normalizeTql(rows);
  } catch {
    return [];
  }
}

function normalizeTql(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const node = row?.["*"] || row?.a || Object.values(row || {})[0];
      if (!node || typeof node.id !== "number") return null;
      return { id: node.id, payload: node.payload || {} };
    })
    .filter(Boolean);
}

export function insertNode(db, payload, { linkToWorkspace = true } = {}) {
  const body = {
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...payload,
  };
  const id = db.insert(zeroVector(), body);
  try {
    db.indexText(id, indexTextFor(body));
    db.buildTextIndex();
  } catch {
    // optional
  }
  if (linkToWorkspace && body.type !== "workspace") {
    const root = workspaceId(db);
    if (root != null) db.link(id, root, EDGE_LABELS.inWorkspace, 1);
  }
  db.flush();
  return id;
}

export function searchNodes(db, query, { topK = 8, expandDepth = 1 } = {}) {
  const text = String(query || "").trim();
  if (!text) return [];
  try {
    const hits = db.searchHybrid(zeroVector(), text, topK, expandDepth, 0.01, 0.3);
    return (hits || []).filter((h) => h?.payload?.status !== "archived");
  } catch {
    return keywordFallback(db, text, topK);
  }
}

function keywordFallback(db, text, topK) {
  const q = text.toLowerCase();
  const ids = db.allNodeIds?.() || [];
  const hits = [];
  for (const id of ids) {
    const node = db.get(id);
    if (!node || node.payload?.status === "archived") continue;
    const hay = indexTextFor(node.payload || {}).toLowerCase();
    if (!hay.includes(q)) continue;
    hits.push({ id, score: 1, payload: node.payload, edges: node.edges || [] });
    if (hits.length >= topK) break;
  }
  return hits;
}

export function formatHit(db, hit) {
  const node = db.get(hit.id) || { payload: hit.payload, edges: [] };
  const payload = node.payload || {};
  const edges = (node.edges || []).map((e) => `${e.label}->${e.targetId}`);
  const l0 = payload.text || payload.name || "";
  return {
    id: hit.id,
    type: payload.type || "unknown",
    score: Number(hit.score || 0),
    l0: l0.slice(0, 200),
    path: edges.slice(0, 8),
  };
}

export function buildShortMap(db, budgetChars = 1600) {
  const counts = { entity: 0, preference: 0, decision: 0, experience: 0 };
  const names = [];
  for (const type of Object.keys(counts)) {
    const nodes = findByType(db, type);
    counts[type] = nodes.length;
    for (const n of nodes) {
      if (names.length >= 8) break;
      const label = n.payload?.name || n.payload?.text;
      if (label) names.push(`${type}:${String(label).slice(0, 40)}`);
    }
  }
  const lines = [
    "dsh-trivium memory map (use ctx_find to expand, ctx_read for full text).",
    `entities=${counts.entity} preferences=${counts.preference} decisions=${counts.decision} experiences=${counts.experience}`,
  ];
  if (names.length) lines.push(`named: ${names.join("; ")}`);
  let text = lines.join("\n");
  if (text.length > budgetChars) text = `${text.slice(0, budgetChars - 1)}…`;
  return text;
}
