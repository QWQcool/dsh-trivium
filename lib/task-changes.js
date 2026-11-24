import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { captureTaskChangeScope } from "./entity-search.js";
import { isStalePayload } from "./until.js";

export const TASK_CHANGE_LIMITS = Object.freeze({ facts: 128, checkpoints: 32, bytes: 2 * 1024 * 1024 });
const FILE = "trivium.task-checkpoints.json";
const HASH = /^[a-f0-9]{64}$/;

function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function invalid(message) { fail(400, "TASK_CHANGES_INVALID", message); }
function unreadable() { fail(409, "TASK_CHANGES_CHECKPOINT_UNREADABLE", "The saved checkpoint cannot be read. It was not replaced."); }
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = id => Number.isSafeInteger(id) && id > 0;
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const short = (value, max) => Array.from(String(value ?? "")).slice(0, max).join("");
const identity = payload => payload && (
  typeof payload.uri === "string" && payload.uri.trim() ? hash(["uri", payload.type, payload.uri])
    : validDate(payload.createdAt) ? hash(["created", payload.type, payload.createdAt]) : null
);

export function taskChangeCheckpointPath(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) invalid("Choose an explicit workspace.");
  return join(resolve(cwd), ".dsh", FILE);
}

export function assertTaskCheckpointStorage(cwd) {
  const file = taskChangeCheckpointPath(cwd);
  try {
    const dir = lstatSync(dirname(file), { throwIfNoEntry: false });
    if (!dir?.isDirectory()) unreadable(); // Do not follow a .dsh symlink/junction.
    return file;
  } catch { unreadable(); }
}

function readCheckpointBytes(file, stat) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > TASK_CHANGE_LIMITS.bytes) unreadable();
    // Read through the already checked descriptor and deliberately cap the
    // number of bytes read, even if an outside process grows the file.
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const received = readSync(fd, buffer, size, buffer.length - size, null);
      if (!received) break;
      size += received;
    }
    if (size !== opened.size) unreadable();
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}

function load(cwd) {
  const file = assertTaskCheckpointStorage(cwd);
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { file, entries: [] };
    if (!stat.isFile() || stat.size > TASK_CHANGE_LIMITS.bytes) unreadable();
    const value = JSON.parse(readCheckpointBytes(file, stat).toString("utf8"));
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > TASK_CHANGE_LIMITS.checkpoints) unreadable();
    const used = new Set();
    for (const entry of value.entries) {
      if (!entry || !validId(entry.entityId) || used.has(entry.entityId) || !HASH.test(entry.anchor)
          || !validDate(entry.at) || typeof entry.revision !== "string" || !/^[a-f0-9-]{36}$/.test(entry.revision)
          || !Array.isArray(entry.items) || entry.items.length > TASK_CHANGE_LIMITS.facts) unreadable();
      used.add(entry.entityId);
      const usedItems = new Set();
      for (const item of entry.items) {
        if (!item || !validId(item.id) || usedItems.has(item.id) || !HASH.test(item.identity) || !HASH.test(item.fingerprint)) unreadable();
        usedItems.add(item.id);
      }
      if (!entry.items.some(item => item.id === entry.entityId && item.identity === entry.anchor)) unreadable();
    }
    return { file, entries: value.entries };
  } catch (error) {
    if (error?.code === "TASK_CHANGES_CHECKPOINT_UNREADABLE") throw error;
    unreadable();
  }
}

function fingerprint(payload, path) {
  // Hash only user-visible fact and relationship fields, not provider or embedding state.
  return hash([payload.type, payload.name, payload.text, payload.status, payload.review,
    payload.fail, payload.fix, payload.until, payload.untilAt, payload.aliases, path]);
}

function summary(id, payload) {
  return { id, type: payload.type, name: short(payload.name, 120), text: short(payload.text, 240) };
}

async function currentScope(db, entityId, { isCurrent, timeNow } = {}) {
  if (!validId(entityId)) invalid("entityId must be a positive safe integer.");
  const scope = await captureTaskChangeScope(db, entityId, { isCurrent, timeNow });
  if (scope.eligible.length > TASK_CHANGE_LIMITS.facts) {
    fail(422, "TASK_CHANGES_SCOPE_LIMIT", "Too many current facts for a complete checkpoint. Choose a smaller entity scope.");
  }
  const anchor = identity(scope.anchor);
  if (!anchor) fail(409, "TASK_CHANGES_IDENTITY_UNAVAILABLE", "This entity lacks a stable stored identity.");
  const items = [];
  for (const id of scope.eligible) {
    const payload = scope.payloads.get(id);
    const key = identity(payload);
    if (!key) fail(409, "TASK_CHANGES_IDENTITY_UNAVAILABLE", "A fact in this scope lacks a stable stored identity.");
    items.push({ id, identity: key, fingerprint: fingerprint(payload, scope.paths.get(id)) });
  }
  return { scope, items, anchor };
}

function changesSince(previous, current) {
  const old = new Map(previous.items.map(item => [item.id, item]));
  const next = new Map(current.items.map(item => [item.id, item]));
  const replaced = new Set();
  const changes = [];
  for (const item of previous.items) {
    const currentItem = next.get(item.id);
    if (currentItem?.identity === item.identity) {
      if (currentItem.fingerprint !== item.fingerprint) changes.push({ kind: "updated", ...summary(item.id, current.scope.payloads.get(item.id)) });
      continue;
    }
    const payload = current.scope.payloads.get(item.id);
    if (identity(payload) === item.identity && payload.status === "archived") {
      changes.push({ kind: "archived", id: item.id });
    } else if (identity(payload) === item.identity && isStalePayload(payload, current.scope.at)) {
      changes.push({ kind: "expired", id: item.id });
    } else {
      const head = current.scope.heads.get(item.id);
      if (identity(payload) === item.identity && head !== undefined && head !== item.id && next.has(head)) {
        replaced.add(head);
        changes.push({ kind: "replaced", id: item.id, replacement: summary(head, current.scope.payloads.get(head)) });
      } else {
        // A detached, deleted, reused or otherwise excluded identity cannot be
        // proven deleted or replaced from within this bounded inspection.
        changes.push({ kind: "left_scope", id: item.id });
      }
    }
  }
  for (const item of current.items) {
    if (!replaced.has(item.id) && old.get(item.id)?.identity !== item.identity) {
      changes.push({ kind: "added", ...summary(item.id, current.scope.payloads.get(item.id)) });
    }
  }
  return changes;
}

function removalRevision(cwd, entry) {
  return hash(["forget", resolve(cwd), entry.entityId, entry.revision]);
}

export function listTaskCheckpoints(cwd) {
  const { entries } = load(cwd);
  return { ok: true, checkpoints: entries.map(entry => ({
    entityId: entry.entityId, savedAt: entry.at, forgetRevision: removalRevision(cwd, entry),
  })) };
}

function view(cwd, entityId, stored, current) {
  const previous = stored.entries.find(entry => entry.entityId === entityId);
  const sameAnchor = previous?.anchor === current.anchor;
  const changes = sameAnchor ? changesSince(previous, current) : [];
  const state = !previous ? "no_checkpoint" : !sameAnchor ? "anchor_replaced" : changes.length ? "changed" : "unchanged";
  return {
    ok: true, state, scope: { entityId, name: short(current.scope.anchor.name, 120) },
    asOf: current.scope.at.toISOString(), checkpointAt: previous?.at ?? null, currentFacts: current.items.length,
    coverage: "net-current-scoped", scopeGaps: current.scope.gaps.length, changes,
    ...(previous ? { forgetRevision: removalRevision(cwd, previous) } : {}),
    viewRevision: hash([resolve(cwd), entityId, previous?.revision ?? null, current.anchor, current.scope.fingerprint]),
  };
}

export async function previewTaskChanges(cwd, db, entityId, options = {}) {
  const current = await currentScope(db, entityId, options);
  if (options.isCurrent && !options.isCurrent()) fail(409, "TASK_CHANGES_PREVIEW_CHANGED", "The selected workspace changed. Check again.");
  return view(cwd, entityId, load(cwd), current);
}

function persist(file, entries) {
  const encoded = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(encoded) + 1 > TASK_CHANGE_LIMITS.bytes) fail(422, "TASK_CHANGES_CHECKPOINT_LIMIT", "The checkpoint is too large.");
  try { atomicWriteFile(file, encoded + "\n", { mode: 0o600 }); }
  catch { fail(409, "TASK_CHANGES_CHECKPOINT_WRITE_FAILED", "The checkpoint could not be saved. The last saved view is unchanged."); }
}

/** The host must serialize this with other writes in the same workspace. */
export async function saveTaskCheckpoint(cwd, db, request, options = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !["entityId", "viewRevision", "action"].includes(key))
      || !validId(request.entityId) || typeof request.viewRevision !== "string" || !HASH.test(request.viewRevision)
      || (request.action !== undefined && !["remember", "forget"].includes(request.action))) invalid("Preview the current task changes first.");
  const { entityId, action = "remember" } = request;
  if (action === "forget") {
    const { file, entries } = load(cwd);
    const entry = entries.find(item => item.entityId === entityId);
    if (!entry || request.viewRevision !== removalRevision(cwd, entry) || (options.isCurrent && !options.isCurrent())) {
      fail(409, "TASK_CHANGES_PREVIEW_CHANGED", "The saved checkpoint changed. Reload the checkpoint list.");
    }
    persist(file, entries.filter(item => item.entityId !== entityId));
    return { ok: true, receipt: { action: "forgotten", entityId } };
  }
  const current = await currentScope(db, entityId, options);
  const stored = load(cwd);
  const seen = view(cwd, entityId, stored, current);
  if (request.viewRevision !== seen.viewRevision || (options.isCurrent && !options.isCurrent())) {
    fail(409, "TASK_CHANGES_PREVIEW_CHANGED", "The scope or checkpoint changed after preview. Review the new changes first.");
  }
  const entries = stored.entries.filter(entry => entry.entityId !== entityId);
  if (entries.length >= TASK_CHANGE_LIMITS.checkpoints) fail(422, "TASK_CHANGES_CHECKPOINT_LIMIT", "Forget another checkpoint before saving this one.");
  entries.push({ entityId, anchor: current.anchor, at: current.scope.at.toISOString(), revision: randomUUID(), items: current.items });
  persist(stored.file, entries);
  return { ...view(cwd, entityId, { entries }, current), receipt: { action: "remembered", entityId } };
}
