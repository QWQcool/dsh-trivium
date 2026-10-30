/**
 * Cross-process write lock for one workspace (F-W05, option A).
 *
 * Two host processes (desktop + CLI) on the same workspace both see the same
 * pending snapshot and both write it, which produced duplicate facts. The engine
 * is a native addon whose locking we cannot inspect, so the plugin serialises the
 * write itself.
 *
 * Scope, deliberately narrow: the lock is held for the extraction run and
 * released as soon as it ends. A process that cannot get it does NOT wait - it
 * leaves the window pending and records `lock-busy`, so the next event (or the
 * other process) still stores the fact. Waiting would make a 10-second model call
 * block a whole session behind another one.
 */

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** A lock older than this is assumed to be from a crashed process. */
export const LOCK_TTL_MS = 30_000;

export function lockPath(cwd) {
  return join(cwd, ".dsh", "trivium-write.lock");
}

function release(file, nonce) {
  try {
    // Only remove the lock we still own: a stale takeover may have replaced it.
    const owner = JSON.parse(readFileSync(file, "utf8"));
    if (owner?.nonce !== nonce) return false;
  } catch {
    return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to take the workspace lock once. Never throws, never waits.
 *
 * Returns `{ok, release, reason?, owner?}`; `release` is always callable so the
 * caller can use it unconditionally in a `finally`.
 */
export function acquireWorkspaceLock(cwd, { ttlMs = LOCK_TTL_MS, now = Date.now() } = {}) {
  const file = lockPath(cwd);
  const nonce = randomUUID();
  const noop = () => false;
  const payload = JSON.stringify({ pid: process.pid, nonce, at: new Date(now).toISOString() });

  const once = () => {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  };

  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // An existing directory is fine; a real problem surfaces on open below.
  }

  try {
    once();
    return { ok: true, file, nonce, release: () => release(file, nonce) };
  } catch (err) {
    if (err?.code !== "EEXIST") {
      return { ok: false, reason: "error", error: String(err?.message || err), release: noop };
    }
  }

  let owner = null;
  let stale = false;
  try {
    const stat = statSync(file);
    stale = now - stat.mtimeMs > ttlMs;
    owner = String(readFileSync(file, "utf8") || "").slice(0, 200);
  } catch {
    // The holder vanished between open and stat; retry once below.
    stale = true;
  }

  if (stale) {
    try {
      unlinkSync(file);
    } catch {
      // Someone else cleaned it first; the retry below decides the winner.
    }
    try {
      once();
      return { ok: true, file, nonce, release: () => release(file, nonce) };
    } catch {
      // Lost the race; fall through to busy.
    }
  }

  return { ok: false, reason: "busy", owner, release: noop };
}

/**
 * Run `fn` while holding the workspace write lock.
 *
 * The lock has to be taken *before* the database is opened: the engine refuses a
 * second writer outright ("already opened with an incompatible access mode"), so
 * a loser that opens first crashes instead of reporting back. Returns
 * `{locked:true}` without calling `fn` when another process holds the lock.
 */
export async function withWorkspaceLock(cwd, fn, { ttlMs = LOCK_TTL_MS, now } = {}) {
  const lock = acquireWorkspaceLock(cwd, { ttlMs, now });
  if (!lock.ok) return { locked: true, reason: lock.reason, owner: lock.owner ?? null, value: null };
  try {
    return { locked: false, value: await fn() };
  } finally {
    lock.release();
  }
}
