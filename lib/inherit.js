/**
 * Stage 1, part A: a worker reads the library above it.
 *
 * A Super-agent gives every work item its own directory, so the facts that
 * matter to a worker (repo conventions, decisions taken by the orchestrator)
 * usually live one level up. This module is the read half of that: it opens the
 * **parent's** `.tdb` read-only, builds the same budgeted short map the local
 * session already gets, and hands it back.
 *
 * Deliberately read-only. Writing into the parent from N workers is exactly the
 * shape that the concurrency measurement
 * (`evidence-write-provenance/S1/CONCURRENCY-2026-11-03`) shows to be unsafe
 * without a central writer: at realistic extraction latency ~78% of attempts
 * lose the lock and are deferred, and a deferred write in a work-item directory
 * that is never opened again is a lost fact. Write-back therefore waits for the
 * router (part B).
 *
 * Nothing calls this yet: like `scope`, it is opt-in plumbing for the profile
 * that has parent/child directories. The local default is untouched.
 */

import { existsSync } from "node:fs";
import { MAP_TOKEN_BUDGET } from "./context-budget.js";
import { buildShortMapReport, openWorkspaceDbReadOnly, resolveScope } from "./store.js";

/**
 * Where the parent library would be, and whether it is actually there.
 *
 * `available` is about the file, not the layout: a worker in a fresh directory
 * tree has a parent path but nothing stored above it yet, and that is a normal
 * state, not an error.
 */
export function inheritedParent(cwd) {
  const resolved = resolveScope(cwd, "inherit");
  const parentPath = resolved.parentPath || null;
  return {
    cwd: resolved.cwd,
    writePath: resolved.path,
    parentCwd: resolved.parentCwd,
    parentPath,
    available: Boolean(parentPath) && existsSync(parentPath),
  };
}

/**
 * The parent's short map, read-only.
 *
 * Returns `{ ok, parentCwd, text, tokens, entries, version }` on success and
 * `{ ok: false, reason }` otherwise. `reason` is one of:
 *
 *   - `no-parent`     — the directory has no parent (a drive root);
 *   - `no-parent-db`  — there is a parent, nothing is stored there yet;
 *   - `unreadable`    — the parent file exists but cannot be opened (another
 *                       process holds it, permissions, a broken file). A worker
 *                       then simply has no inherited context this turn; it must
 *                       not fail its own turn over it.
 *
 * The handle is closed before returning: this is a read, not a second writer.
 *
 * When a router owns the parent library (the multi-worker shape), a read-only
 * open is refused by the engine — measured in p84: three workers, three
 * `unreadable`. The router is then the only process that can read it, so the
 * fallback asks the router for the same map. `via` says which path answered.
 *
 * @param cwd - the worker's directory
 * @param budget - estimated-token budget for the inherited map
 * @param openReadOnly - injection point for tests; defaults to the store opener
 * @param useRouter - false disables the fallback (used by the unit tests)
 */
export async function readInheritedMap(
  cwd,
  { budget = MAP_TOKEN_BUDGET, openReadOnly = openWorkspaceDbReadOnly, useRouter = true } = {},
) {
  const parent = inheritedParent(cwd);
  if (!parent.parentCwd) {
    return { ok: false, reason: "no-parent", parentCwd: null, text: "", tokens: 0, entries: [], version: "" };
  }
  if (!parent.available) {
    return { ok: false, reason: "no-parent-db", parentCwd: parent.parentCwd, text: "", tokens: 0, entries: [], version: "" };
  }
  let db;
  try {
    db = await openReadOnly(parent.parentCwd);
  } catch (err) {
    const viaRouter = useRouter ? await readViaRouter(parent.parentCwd, budget) : null;
    if (viaRouter) return viaRouter;
    return {
      ok: false,
      reason: "unreadable",
      parentCwd: parent.parentCwd,
      error: String(err?.message || err).slice(0, 200),
      text: "",
      tokens: 0,
      entries: [],
      version: "",
    };
  }
  try {
    const map = buildShortMapReport(db, budget);
    return {
      ok: true,
      via: "file",
      parentCwd: parent.parentCwd,
      text: map.text,
      tokens: map.tokens,
      entries: map.entries || [],
      version: map.version || "",
    };
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      parentCwd: parent.parentCwd,
      error: String(err?.message || err).slice(0, 200),
      text: "",
      tokens: 0,
      entries: [],
      version: "",
    };
  } finally {
    try {
      db.close?.();
    } catch {
      // Closing a read-only handle is best-effort; the process exits anyway.
    }
  }
}

/**
 * Ask the router that owns the parent library for the same map.
 *
 * Returns null when no router answers: "there is no central writer" is a normal
 * state for a single-process workspace, and the caller then reports the original
 * file error instead of inventing one.
 */
async function readViaRouter(parentCwd, budget) {
  let client = null;
  try {
    const { createRouterClient } = await import("./router.js");
    client = createRouterClient({ cwd: parentCwd });
    await client.ready;
    const map = await client.map(budget);
    if (!map || typeof map.text !== "string") return null;
    return {
      ok: true,
      via: "router",
      parentCwd,
      text: map.text,
      tokens: Number(map.tokens) || 0,
      entries: map.entries || [],
      version: map.version || "",
    };
  } catch {
    return null;
  } finally {
    try {
      await client?.close();
    } catch {
      // Best effort: the socket is per-call anyway.
    }
  }
}
