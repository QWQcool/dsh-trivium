/** Git-friendly JSONL sidecar next to trivium.tdb. No embeddings, episodes, or chip pins. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { BUSINESS_EDGES, REVISION_EDGES } from "./schema.js";
import {
  gitSidecarEnabledOf,
  listedWorkspaces,
  readUiSettings,
  sidecarHashOf,
  writeSidecarHash,
} from "./settings.js";

export const SIDECAR_FORMAT = "dsh-trivium-jsonl";
/**
 * v2 adds revision relations with their edge metadata. A v1 file is still read:
 * it simply carries no supersedes rows. Downgrading is not supported in place —
 * restore the pre-upgrade file group (see README) rather than letting an older
 * build rewrite the chain away.
 */
export const SIDECAR_VERSION = 2;
export const SIDECAR_DEBOUNCE_MS = 1500;
export const BUSINESS_NODE_TYPES = Object.freeze(["entity", "preference", "decision", "experience"]);

const timers = new Map();
const memoryHash = new Map();
// A rejected pulled file is evidence, not an output to overwrite on dispose.
// Successful reconciliation or explicit "generate from database" clears this.
const rejectedInputs = new Map();

/**
 * Whether the derived JSONL file is currently in step with the graph.
 *
 * The graph is authoritative; this file is a projection written after the
 * fact. A failure here is reported rather than hidden, and the next open
 * (`syncSidecarOnOpen`) repairs it.
 */
const health = { ok: true, error: "", at: "" };
const workspaceHealth = new Map();

function noteSidecarError(err, cwd) {
  health.ok = false;
  health.error = String(err?.message || err || "sidecar write failed");
  health.at = new Date().toISOString();
  if (cwd) workspaceHealth.set(resolve(cwd), { ...health });
}

function noteSidecarOk(cwd) {
  health.ok = true;
  health.error = "";
  health.at = new Date().toISOString();
  if (cwd) workspaceHealth.set(resolve(cwd), { ...health });
}

export function sidecarHealth(cwd) {
  const key = cwd ? resolve(String(cwd)) : "";
  // Omitting cwd retains the legacy process-level probe used by maintenance
  // tests. UI/API callers always supply the workspace they are displaying.
  const state = cwd === undefined ? health : workspaceHealth.get(key) || { ok: true, error: "", at: "" };
  return { ...state, cwd: key, scope: cwd === undefined ? "process" : "workspace", enabled: gitSidecarEnabledOf(readUiSettings()) };
}

export function sidecarPath(cwd) {
  return join(resolve(cwd || ""), ".dsh", "trivium.jsonl");
}

export function hashText(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function isBusinessType(type) {
  return BUSINESS_NODE_TYPES.includes(String(type || ""));
}

function revisionNodeIds(db) {
  const ids = new Set();
  for (const raw of db.allNodeIds?.() || []) {
    const id = Number(raw);
    for (const edge of db.get(id)?.edges || []) {
      if (!REVISION_EDGES.includes(edge.label)) continue;
      ids.add(id);
      ids.add(edgeTarget(edge));
    }
  }
  return ids;
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
  const revisionIds = revisionNodeIds(db);
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    if (!isBusinessType(payload.type)) continue;
    const uri = String(payload.uri || "").trim();
    if (uri) used.add(uri);
  }
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    if (!isBusinessType(payload.type) || (payload.status === "archived" && !revisionIds.has(Number(id)))) continue;
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
  const revisionIds = revisionNodeIds(db);
  for (const id of db.allNodeIds?.() || []) {
    const payload = payloadOf(db, id);
    // Keep archived chain endpoints: dropping an archived head would make the
    // preceding active version look current in a clone of the JSONL snapshot.
    if (!isBusinessType(payload.type) || (payload.status === "archived" && !revisionIds.has(Number(id)))) continue;
    const uri = String(payload.uri || "").trim();
    if (!uri) continue;
    uriOf.set(Number(id), uri);
    nodes.push(nodeRecord(payload));
  }
  nodes.sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  const edges = [];
  const seen = new Set();
  // Business edges plus revision relations: a chain has to survive a clone, and
  // the relation reason lives in the edge metadata.
  const want = new Set([...BUSINESS_EDGES, ...REVISION_EDGES]);
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
      const row = { op: "edge", from: fromUri, to: toUri, type: label };
      if (e.metadata && typeof e.metadata === "object") row.meta = e.metadata;
      edges.push(row);
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
      if ((!BUSINESS_EDGES.includes(label) && !REVISION_EDGES.includes(label)) || !row.from || !row.to) {
        return { ok: false, message: "invalid edge" };
      }
      edges.push({
        from: row.from,
        to: row.to,
        type: label,
        meta: row.meta && typeof row.meta === "object" ? row.meta : null,
      });
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
  rejectedInputs.delete(key);
  workspaceHealth.delete(key);
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
  const key = resolve(cwd);
  if (!force && rejectedInputs.has(key)) {
    return { path: sidecarPath(key), hash: knownHash(key), wrote: false, blocked: true };
  }
  try {
    ensureBusinessUris(db);
    const text = serializeGraph(db);
    const hash = hashText(text);
    const file = sidecarPath(cwd);
    if (!force && hash === knownHash(cwd) && existsSync(file)) {
      noteSidecarOk(key);
      return { path: file, hash, wrote: false };
    }
    atomicWriteFile(file, text);
    rememberHash(cwd, hash);
    rejectedInputs.delete(key);
    noteSidecarOk(key);
    return { path: file, hash, wrote: true };
  } catch (err) {
    // Explicit Generate/bootstrap/flush callers need the same observable
    // failure as the scheduled writer, even when they handle the exception.
    noteSidecarError(err, key);
    throw err;
  }
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
    } catch (err) {
      // Disk errors are non-fatal, but they are visible: status reports them and
      // reopening the workspace retries the sync.
      noteSidecarError(err, key);
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
  const ids = new Map(parsed.nodes.map((row, index) => [String(row.uri).trim(), index + 1]));
  const nodes = parsed.nodes.map((row, index) => ({
    id: index + 1,
    payload: {
      type: row.type,
      name: row.name || "",
      text: row.text || "",
      uri: String(row.uri).trim(),
      status: row.status || "active",
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      until: row.until || "",
      untilAt: row.untilAt || "",
      fail: row.fail || "",
      fix: row.fix || "",
      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || "",
    },
  }));
  const edges = parsed.edges.map((edge) => ({
    from: ids.get(String(edge.from).trim()),
    to: ids.get(String(edge.to).trim()),
    label: edge.type,
    metadata: edge.meta,
  }));
  // Use the same URI mapping, combined-topology preflight and single native
  // transaction as JSON. Snapshot removals join that transaction too.
  return store.runWithoutSidecar(() => store.importGraph(db, {
    format: store.GRAPH_FORMAT,
    version: Number(parsed.header?.v) || 1,
    nodes,
    edges,
  }, { reconcileSnapshot: true }));
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
    if (existsSync(sidecarPath(key))) {
      const message = "cannot read sidecar input; preserved without overwriting";
      rejectedInputs.set(key, "unreadable");
      noteSidecarError(message, key);
      return { action: "import-rejected", message, conflicts: [] };
    }
    // Deleting the rejected input is an explicit recovery step. It must not
    // leave the write guard latched when we regenerate from the live graph.
    rejectedInputs.delete(key);
    if (!gitSidecarEnabledOf(readUiSettings())) {
      noteSidecarOk(key);
      return { action: "skip" };
    }
    const wrote = writeSidecarNow(key, db);
    return { action: "bootstrap-write", hash: wrote?.hash || "" };
  }
  const fileHash = hashText(text);
  if (fileHash === knownHash(key)) {
    // Reverting a failed pull to the last applied input also resolves it.
    rejectedInputs.delete(key);
    noteSidecarOk(key);
    return { action: "skip" };
  }
  const parsed = parseSidecar(text);
  if (!parsed.ok) {
    rejectedInputs.set(key, fileHash);
    noteSidecarError(parsed.message, key);
    return { action: "skip-invalid", message: parsed.message };
  }
  let applied;
  try {
    applied = await applySidecar(db, parsed);
  } catch (err) {
    rejectedInputs.set(key, fileHash);
    noteSidecarError(err, key);
    return { action: "import-rejected", message: String(err?.message || err), conflicts: [] };
  }
  if (!applied.ok) {
    rejectedInputs.set(key, fileHash);
    noteSidecarError(applied.message, key);
    return { ...applied, action: "import-rejected" };
  }
  rememberHash(key, fileHash);
  rejectedInputs.delete(key);
  noteSidecarOk(key);
  return {
    action: "import",
    hash: fileHash,
    nodes: parsed.nodes.length,
    edges: parsed.edges.length,
    version: Number(parsed.header?.v) || 1,
    // Conflicts are visible; the store stays usable and nothing is half-applied.
    conflicts: applied.revisionConflicts || [],
  };
}
