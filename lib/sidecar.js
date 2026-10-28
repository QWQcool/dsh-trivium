/** Git-friendly JSONL sidecar next to trivium.tdb. No embeddings, episodes, or chip pins. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { BUSINESS_EDGES, REVISION_EDGES, nowIso, weightOf } from "./schema.js";
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

/**
 * Whether the derived JSONL file is currently in step with the graph.
 *
 * The graph is authoritative; this file is a projection written after the
 * fact. A failure here is reported rather than hidden, and the next open
 * (`syncSidecarOnOpen`) repairs it.
 */
const health = { ok: true, error: "", at: "" };

function noteSidecarError(err) {
  health.ok = false;
  health.error = String(err?.message || err || "sidecar write failed");
  health.at = new Date().toISOString();
}

function noteSidecarOk() {
  health.ok = true;
  health.error = "";
  health.at = new Date().toISOString();
}

export function sidecarHealth() {
  return { ...health, enabled: gitSidecarEnabledOf(readUiSettings()) };
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
    noteSidecarOk();
    return { path: file, hash, wrote: false };
  }
  atomicWriteFile(file, text);
  rememberHash(cwd, hash);
  noteSidecarOk();
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
      noteSidecarOk();
    } catch (err) {
      // Disk errors are non-fatal, but they are visible: status reports them and
      // reopening the workspace retries the sync.
      noteSidecarError(err);
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
  const conflicts = [];
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
      // Keep the empty label as an explicit clear when reconciling a snapshot.
      if (!payload.untilAt) delete payload.untilAt;
      if (!payload.fail) delete payload.fail;
      if (!payload.fix) delete payload.fix;
      /*
       * URI identity only. A JSONL row always carries a URI (parseSidecar
       * rejects rows without one), so a missing local URI means a new node.
       * Falling back to text similarity here merged two versions of the same
       * decision into one identity and lost the older body — the same P1-3
       * defect the JSON import path had.
       */
      const dest = store.findByUri(db, uri);
      if (dest != null) {
        try {
          store.mergeInto(db, dest, payload);
          idByUri.set(uri, dest);
        } catch (err) {
          // The file wants to rewrite a body that is confirmed history. Keep the
          // live text, keep the store usable, and report the conflict.
          if (err?.code === "REVISION_PROTECTED") {
            conflicts.push({ code: "chain-body", uri });
            idByUri.set(uri, dest);
          } else {
            throw err;
          }
        }
      } else {
        idByUri.set(uri, store.insertNode(db, payload));
      }
    }
    const wantEdges = new Set();
    const wantRevision = new Set();
    const revisionOps = [];
    for (const e of parsed.edges) {
      const from = idByUri.get(e.from) ?? store.findByUri(db, e.from);
      const to = idByUri.get(e.to) ?? store.findByUri(db, e.to);
      const revision = REVISION_EDGES.includes(e.type);
      if (revision) wantRevision.add(`${e.from}\0${e.to}\0${e.type}`);
      if (from == null || to == null || from === to) {
        if (revision) conflicts.push({ code: "unmapped-relation", from: e.from, to: e.to });
        continue;
      }
      if (revision) {
        revisionOps.push({
          type: "upsertEdge",
          src: from,
          dst: to,
          label: e.type,
          weight: weightOf(e.type),
          metadata: e.meta || { at: nowIso(), reason: "", source: "sidecar" },
        });
        continue;
      }
      store.ensureLink(db, from, to, e.type);
      wantEdges.add(`${e.from}\0${e.to}\0${e.type}`);
    }
    if (revisionOps.length) {
      try {
        db.commitTransaction(revisionOps);
      } catch (err) {
        conflicts.push({ code: "relation-transaction-failed", message: String(err.message || err) });
      }
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
    /*
     * A relation that exists locally but is absent from the file is NOT removed.
     * Deleting a chain from a pull is a semantic change a snapshot cannot prove,
     * so it is reported as a conflict and the user revokes it explicitly.
     */
    for (const id of db.allNodeIds?.() || []) {
      const node = db.get(Number(id));
      const fromUri = uriById.get(Number(id));
      for (const edge of node?.edges || []) {
        if (!REVISION_EDGES.includes(String(edge.label))) continue;
        const toUri = uriById.get(edgeTarget(edge));
        if (!fromUri || !toUri) continue;
        if (wantRevision.has(`${fromUri}\0${toUri}\0${edge.label}`)) continue;
        conflicts.push({ code: "relation-missing-in-file", from: fromUri, to: toUri });
      }
    }
    for (const id of db.allNodeIds?.() || []) {
      const payload = payloadOf(db, id);
      if (!isBusinessType(payload.type) || payload.status === "archived") continue;
      const uri = String(payload.uri || "").trim();
      if (!uri || !uriSet.has(uri)) store.archiveNode(db, id);
    }
  });
  return { conflicts };
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
  const applied = await applySidecar(db, parsed);
  rememberHash(key, fileHash);
  return {
    action: "import",
    hash: fileHash,
    nodes: parsed.nodes.length,
    edges: parsed.edges.length,
    version: Number(parsed.header?.v) || 1,
    // Conflicts are visible; the store stays usable and nothing is half-applied.
    conflicts: applied?.conflicts || [],
  };
}
