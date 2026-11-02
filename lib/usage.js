/**
 * Which facts were actually used (B2, map hotness).
 *
 * This is a *derived* signal, so it lives beside the database instead of in it:
 *
 *   - it is written to `.dsh/trivium-usage.json`, not through the graph, so a
 *     reference counter can never take part in a fact transaction or change the
 *     database schema (`DIM`, node payloads and the `.tdb` format stay as they
 *     were);
 *   - writes are throttled to at most one per workspace per 60 s. A tool loop
 *     can reference twenty nodes in one second; rewriting the file each time
 *     would turn a read path into a write amplifier. The first reference writes
 *     immediately (so a single-shot process still records it) and later ones
 *     are coalesced into memory and flushed when the window closes;
 *   - a corrupt or unreadable file degrades to "no heat" instead of failing a
 *     tool call. Heat is an optimisation: losing it costs ranking quality, not
 *     facts.
 *
 * The numbers are per workspace and never leave it.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.js";

/** At most one rewrite per workspace in this window. */
export const USAGE_WRITE_THROTTLE_MS = 60_000;

/** Oldest entries are dropped past this; the map only ever shows eight names. */
export const USAGE_MAX_ENTRIES = 2000;

export const USAGE_FORMAT = "dsh-trivium-usage";
export const USAGE_VERSION = 1;

/** cwd -> { nodes: Map<string, {count, lastUsedAt}>, lastWriteAt, dirty, timer, writes } */
const cache = new Map();

export function usagePath(cwd) {
  return join(resolve(String(cwd || "")), ".dsh", "trivium-usage.json");
}

function emptyState() {
  return { nodes: new Map(), lastWriteAt: -Infinity, dirty: false, timer: null, writes: 0 };
}

function normalizeEntry(raw) {
  const count = Number(raw?.count);
  const lastUsedAt = typeof raw?.lastUsedAt === "string" ? raw.lastUsedAt : "";
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count: Math.floor(count), lastUsedAt };
}

/**
 * Load (once) the sidecar for a workspace. A file from a future version is
 * treated as unreadable rather than guessed at; a broken line is ignored.
 */
function stateOf(cwd) {
  const key = resolve(String(cwd || ""));
  if (cache.has(key)) return cache.get(key);
  const state = emptyState();
  cache.set(key, state);
  const file = usagePath(key);
  if (!existsSync(file)) return state;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || data.version !== USAGE_VERSION) return state;
    for (const [id, raw] of Object.entries(data.nodes || {})) {
      const entry = normalizeEntry(raw);
      if (entry) state.nodes.set(String(id), entry);
    }
    state.lastWriteAt = Number(data.updatedAtMs) || 0;
  } catch {
    // Fail open: no heat is better than a broken read path.
    state.nodes.clear();
  }
  return state;
}

/** Prune by last use, then by count, so a long-lived workspace stays bounded. */
function prune(state) {
  if (state.nodes.size <= USAGE_MAX_ENTRIES) return 0;
  const rows = [...state.nodes.entries()].sort((a, b) => {
    const byTime = String(b[1].lastUsedAt).localeCompare(String(a[1].lastUsedAt));
    if (byTime !== 0) return byTime;
    return b[1].count - a[1].count;
  });
  const keep = new Set(rows.slice(0, USAGE_MAX_ENTRIES).map(([id]) => id));
  let dropped = 0;
  for (const id of [...state.nodes.keys()]) {
    if (keep.has(id)) continue;
    state.nodes.delete(id);
    dropped += 1;
  }
  return dropped;
}

function writeNow(key, state, now) {
  try {
    mkdirSync(dirname(usagePath(key)), { recursive: true });
    const nodes = {};
    for (const [id, entry] of state.nodes) nodes[id] = entry;
    atomicWriteFile(
      usagePath(key),
      `${JSON.stringify({ format: USAGE_FORMAT, version: USAGE_VERSION, updatedAt: new Date(now).toISOString(), updatedAtMs: now, nodes }, null, 0)}\n`,
    );
    state.lastWriteAt = now;
    state.dirty = false;
    state.writes += 1;
    return true;
  } catch {
    // An unwritable sidecar must not break ctx_find / ctx_read.
    return false;
  }
}

function scheduleFlush(key, state, now) {
  if (state.timer) return;
  const delay = Math.max(250, USAGE_WRITE_THROTTLE_MS - (now - state.lastWriteAt));
  const timer = setTimeout(() => {
    state.timer = null;
    if (state.dirty) writeNow(key, state, Date.now());
  }, delay);
  timer?.unref?.();
  state.timer = timer;
}

/**
 * Record one or more node references.
 *
 * Returns `{ written, throttled, ids }`: `written` says whether the sidecar hit
 * the disk on this call, which is what the throttle is verified against.
 */
export function noteNodeUse(cwd, ids, { now = Date.now() } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((id) => Number.isFinite(id) && id > 0);
  if (!cwd || !list.length) return { written: false, throttled: false, ids: [] };
  const key = resolve(String(cwd));
  const state = stateOf(key);
  const at = new Date(now).toISOString();
  for (const id of list) {
    const entry = state.nodes.get(String(id)) || { count: 0, lastUsedAt: "" };
    entry.count += 1;
    entry.lastUsedAt = at;
    state.nodes.set(String(id), entry);
  }
  prune(state);
  state.dirty = true;
  if (now - state.lastWriteAt >= USAGE_WRITE_THROTTLE_MS) {
    return { written: writeNow(key, state, now), throttled: false, ids: list };
  }
  scheduleFlush(key, state, now);
  return { written: false, throttled: true, ids: list };
}

/** Force the pending write out. Used by closeAll and by tests. */
export function flushUsage(cwd, { now = Date.now() } = {}) {
  if (!cwd) return false;
  const key = resolve(String(cwd));
  const state = cache.get(key);
  if (!state || !state.dirty) return false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  return writeNow(key, state, now);
}

export function flushAllUsage({ now = Date.now() } = {}) {
  let written = 0;
  for (const key of cache.keys()) {
    if (flushUsage(key, { now })) written += 1;
  }
  return written;
}

/** Read-only view for the short map: `{ [id]: {count, lastUsedAt} }`. */
export function usageFor(cwd) {
  if (!cwd) return {};
  const state = stateOf(cwd);
  const out = {};
  for (const [id, entry] of state.nodes) out[id] = { ...entry };
  return out;
}

/** Diagnostics for tests and the status document. Never exposes fact text. */
export function usageStats(cwd, { now = Date.now() } = {}) {
  if (!cwd) return { entries: 0, writes: 0, throttled: false, lastWriteAt: null, file: "" };
  const key = resolve(String(cwd));
  const state = stateOf(key);
  let file = "";
  let mtimeMs = null;
  try {
    file = usagePath(key);
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // no file yet
  }
  return {
    entries: state.nodes.size,
    writes: state.writes,
    throttled: state.dirty && now - state.lastWriteAt < USAGE_WRITE_THROTTLE_MS,
    lastWriteAt: Number.isFinite(state.lastWriteAt) && state.lastWriteAt > 0 ? new Date(state.lastWriteAt).toISOString() : null,
    file,
    mtimeMs,
  };
}

/** Forget cached state (tests and explicit workspace teardown). */
export function resetUsageCache(cwd) {
  if (!cwd) {
    for (const state of cache.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    cache.clear();
    return;
  }
  const key = resolve(String(cwd));
  const state = cache.get(key);
  if (state?.timer) clearTimeout(state.timer);
  cache.delete(key);
}
