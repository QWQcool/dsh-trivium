/** Git-friendly JSONL sidecar next to trivium.tdb. No embeddings, episodes, or chip pins. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUSINESS_EDGES } from "./schema.js";
import {
  gitSidecarEnabledOf,
  listedWorkspaces,
  readUiSettings,
  sidecarHashOf,
  writeSidecarHash,
} from "./settings.js";

export const SIDECAR_FORMAT = "dsh-trivium-jsonl";
export const SIDECAR_VERSION = 1;
export const SIDECAR_DEBOUNCE_MS = 1500;
export const BUSINESS_NODE_TYPES = Object.freeze(["entity", "preference", "decision", "experience"]);

const timers = new Map();
const memoryHash = new Map();

export function sidecarPath(cwd) {
  return join(resolve(cwd || ""), ".dsh", "trivium.jsonl");
}

export function hashText(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function isBusinessType(type) {
  return BUSINESS_NODE_TYPES.includes(String(type || ""));
}

function payloadOf(db, id) {
  return db.get(Number(id))?.payload || {};
}

function edgeTarget(e) {
  return Number(e?.targetId ?? e?.target_id);
}

function mintUri(payload) {
  const h = createHash("sha256")
    .update(
      [payload.type || "", payload.name || "", payload.text || "", payload.createdAt || ""].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `ctx://${payload.type}/${h}`;
}

function nodeRecord(payload) {
  const rec = {
    op: "node",
    uri: payload.uri,
    type: payload.type,
    name: payload.name || "",
    text: payload.text || "",
    status: payload.status || "active",
  };
  const aliases = Array.isArray(payload.aliases)
    ? payload.aliases.map((a) => String(a || "").trim()).filter(Boolean)
    : [];
  if (aliases.length) rec.aliases = aliases;
  if (payload.until) rec.until = payload.until;
  if (payload.untilAt) rec.untilAt = payload.untilAt;
  if (payload.fail) rec.fail = payload.fail;
  if (payload.fix) rec.fix = payload.fix;
  if (payload.createdAt) rec.createdAt = payload.createdAt;
  if (payload.updatedAt) rec.updatedAt = payload.updatedAt;
  return rec;
}

/** Assign stable uris on business nodes that still lack one. Flushes the db; does not schedule a sidecar write. */
export function ensureBusinessUris(db) {
  let changed = 0;
  const used = new Set();
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    if (!isBusinessType(payload.type)) continue;
    const uri = String(payload.uri || "").trim();
    if (uri) used.add(uri);
  }
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    if (!isBusinessType(payload.type) || payload.status === "archived") continue;
    if (String(payload.uri || "").trim()) continue;
    let uri = mintUri(payload);
    let n = 0;
    while (used.has(uri)) {
      n += 1;
      uri = `${mintUri(payload)}-${n}`;
    }
    used.add(uri);
    db.updatePayload(Number(id), { ...payload, uri });
    changed += 1;
  }
  if (changed) db.flush();
  return changed;
}

export function serializeGraph(db) {
  const nodes = [];
  const uriOf = new Map();
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    if (!isBusinessType(payload.type) || payload.status === "archived") continue;
    const uri = String(payload.uri || "").trim();
    if (!uri) continue;
    uriOf.set(Number(id), uri);
    nodes.push(nodeRecord(payload));
  }
  nodes.sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  const edges = [];
  const seen = new Set();
  const want = new Set(BUSINESS_EDGES);
  for (const id of db.allNodeIds?.() || []) {
    const fromUri = uriOf.get(Number(id));
    if (!fromUri) continue;
    const node = db.get(Number(id));
    for (const e of node?.edges || []) {
      const label = e.label || "";
      if (!want.has(label)) continue;
      const toUri = uriOf.get(edgeTarget(e));
      if (!toUri || toUri === fromUri) continue;
      const key = `${fromUri}\0${toUri}\0${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ op: "edge", from: fromUri, to: toUri, type: label });
    }
  }
  edges.sort((a, b) => {
    const x = String(a.from).localeCompare(String(b.from));
    if (x) return x;
    const y = String(a.to).localeCompare(String(b.to));
    if (y) return y;
    return String(a.type).localeCompare(String(b.type));
  });
  const header = { v: SIDECAR_VERSION, format: SIDECAR_FORMAT };
  return [header, ...nodes, ...edges].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export function parseSidecar(text) {
  const lines = String(text || "").split(/\r?\n/);
  const nodes = [];
  const edges = [];
  let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { ok: false, message: "invalid jsonl" };
    }
    if (!row || typeof row !== "object") return { ok: false, message: "invalid jsonl" };
    if (row.format === SIDECAR_FORMAT || (row.v && !row.op && !row.uri)) {
      if (header) return { ok: false, message: "duplicate header" };
      header = row;
      continue;
    }
    const op = row.op || (row.uri && row.type ? "node" : row.from && row.to ? "edge" : "");
    if (op === "node") {
      if (!isBusinessType(row.type) || !String(row.uri || "").trim()) {
        return { ok: false, message: "invalid node" };
      }
      nodes.push(row);
      continue;
    }
    if (op === "edge") {
      const label = row.type || row.label || "";
      if (!BUSINESS_EDGES.includes(label) || !row.from || !row.to) {
        return { ok: false, message: "invalid edge" };
      }
      edges.push({ from: row.from, to: row.to, type: label });
      continue;
    }
    return { ok: false, message: "unknown jsonl row" };
  }
  if (!header || header.format !== SIDECAR_FORMAT) {
    return { ok: false, message: "missing sidecar header" };
  }
  return { ok: true, header, nodes, edges };
}

function readSidecarFile(cwd) {
  const file = sidecarPath(cwd);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(file);
    } catch {
      // dest may not exist
    }
    renameSync(tmp, file);
  }
}

function rememberHash(cwd, hash) {
  const key = resolve(cwd);
  memoryHash.set(key, hash);
  try {
    writeSidecarHash(key, hash);
  } catch {
    // home settings write is best-effort
  }
}

function knownHash(cwd) {
  const key = resolve(cwd);
  return memoryHash.get(key) || sidecarHashOf(key) || "";
}

function unlinkIfExists(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function clearSidecarState(cwd) {
  const key = resolve(cwd || "");
  const prev = timers.get(key);
  if (prev) {
    clearTimeout(prev);
    timers.delete(key);
  }
  memoryHash.delete(key);
  try {
    writeSidecarHash(key, "");
  } catch {
    // home settings write is best-effort
  }
}

export function deleteSidecarAt(cwd) {
  const key = resolve(cwd || "");
  if (!key) return { path: "", deleted: false };
  clearSidecarState(key);
  const file = sidecarPath(key);
  const deletedFile = unlinkIfExists(file);
  const deletedTmp = unlinkIfExists(`${file}.tmp`);
  return { path: file, deleted: deletedFile || deletedTmp };
}

export function deleteKnownSidecars(extraCwds = []) {
  const seen = new Set();
  const files = [];
  const add = (cwd) => {
    const key = String(cwd || "").trim();
    if (!key) return;
    const resolved = resolve(key);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const result = deleteSidecarAt(resolved);
    if (result.deleted) files.push(result.path);
  };
  try {
    for (const cwd of listedWorkspaces()) add(cwd);
  } catch {
    // listing is best-effort
  }
  for (const cwd of extraCwds) add(cwd);
  return files;
}

export function writeSidecarNow(cwd, db, { force = false } = {}) {
  if (!cwd || !db) return null;
  if (!gitSidecarEnabledOf(readUiSettings())) return null;
  ensureBusinessUris(db);
  const text = serializeGraph(db);
  const hash = hashText(text);
  const file = sidecarPath(cwd);
  if (!force && hash === knownHash(cwd) && existsSync(file)) {
    return { path: file, hash, wrote: false };
  }
  atomicWrite(file, text);
  rememberHash(cwd, hash);
  return { path: file, hash, wrote: true };
}

export function scheduleSidecarWrite(cwd, db) {
  if (!cwd || !db) return;
  if (!gitSidecarEnabledOf(readUiSettings())) return;
  const key = resolve(cwd);
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    timers.delete(key);
    try {
      writeSidecarNow(key, db);
    } catch {
      // disk errors are non-fatal
    }
  }, SIDECAR_DEBOUNCE_MS);
  timers.set(key, timer);
}

export function flushSidecarNow(cwd, db) {
  const key = resolve(cwd || "");
  const prev = timers.get(key);
  if (prev) {
    clearTimeout(prev);
    timers.delete(key);
  }
  if (!cwd || !db) return null;
  return writeSidecarNow(key, db);
}

async function applySidecar(db, parsed) {
  const store = await import("./store.js");
  const uriSet = new Set();
  store.runWithoutSidecar(() => {
    const idByUri = new Map();
    for (const row of parsed.nodes) {
      const uri = String(row.uri || "").trim();
      uriSet.add(uri);
      const payload = {
        type: row.type,
        name: row.name || "",
        text: row.text || "",
        uri,
        status: row.status && row.status !== "archived" ? row.status : "active",
        aliases: Array.isArray(row.aliases) ? row.aliases : [],
        until: row.until || "",
        untilAt: row.untilAt || "",
        fail: row.fail || "",
        fix: row.fix || "",
        createdAt: row.createdAt || "",
        updatedAt: row.updatedAt || "",
      };
      if (!payload.until) delete payload.until;
      if (!payload.untilAt) delete payload.untilAt;
      if (!payload.fail) delete payload.fail;
      if (!payload.fix) delete payload.fix;
      let dest = store.findByUri(db, uri);
      if (dest == null) dest = store.findMergeTarget(db, payload);
      if (dest != null) {
        store.mergeInto(db, dest, payload);
        idByUri.set(uri, dest);
      } else {
        idByUri.set(uri, store.insertNode(db, payload));
      }
    }
    const wantEdges = new Set();
    for (const e of parsed.edges) {
      const from = idByUri.get(e.from) ?? store.findByUri(db, e.from);
      const to = idByUri.get(e.to) ?? store.findByUri(db, e.to);
      if (from == null || to == null || from === to) continue;
      store.ensureLink(db, from, to, e.type);
      wantEdges.add(`${e.from}\0${e.to}\0${e.type}`);
    }
    const uriById = new Map();
    for (const id of db.allNodeIds?.() || []) {
      const payload = payloadOf(db, id);
      if (!isBusinessType(payload.type)) continue;
      const uri = String(payload.uri || "").trim();
      if (uri) uriById.set(Number(id), uri);
    }
    for (const id of db.allNodeIds?.() || []) {
      const fromUri = uriById.get(Number(id));
      if (!fromUri) continue;
      const node = db.get(Number(id));
      for (const e of node?.edges || []) {
        const label = e.label || "";
        if (!BUSINESS_EDGES.includes(label)) continue;
        const toUri = uriById.get(edgeTarget(e));
        if (!toUri) continue;
        if (!wantEdges.has(`${fromUri}\0${toUri}\0${label}`)) {
          store.dropLink(db, id, edgeTarget(e), label);
        }
      }
    }
    for (const id of db.allNodeIds?.() || []) {
      const payload = payloadOf(db, id);
      if (!isBusinessType(payload.type) || payload.status === "archived") continue;
      const uri = String(payload.uri || "").trim();
      if (!uri || !uriSet.has(uri)) store.archiveNode(db, id);
    }
  });
}

/**
 * Import when the sidecar changed outside this process (clone / git pull).
 * Write is skipped when the switch is off; import still runs.
 */
export async function syncSidecarOnOpen(cwd, db) {
  if (!cwd || !db) return { action: "skip" };
  const key = resolve(cwd);
  const text = readSidecarFile(key);
  if (text == null) {
    if (!gitSidecarEnabledOf(readUiSettings())) return { action: "skip" };
    const wrote = writeSidecarNow(key, db);
    return { action: "bootstrap-write", hash: wrote?.hash || "" };
  }
  const fileHash = hashText(text);
  if (fileHash === knownHash(key)) return { action: "skip" };
  const parsed = parseSidecar(text);
  if (!parsed.ok) return { action: "skip-invalid", message: parsed.message };
  await applySidecar(db, parsed);
  rememberHash(key, fileHash);
  return { action: "import", hash: fileHash, nodes: parsed.nodes.length, edges: parsed.edges.length };
}
