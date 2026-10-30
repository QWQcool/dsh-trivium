/**
 * Cross-process write lock for one workspace (F-W05, option A).
 *
 * The native engine rejects concurrent writers. This guard makes participating
 * writes report contention before opening it; the native lock remains authoritative.
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

/** A dead or unreadable owner may be reclaimed after this age. */
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

function ownerAlive(raw) {
  let pid;
  try { pid = JSON.parse(raw)?.pid; } catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to inspect a process must never count as proof it is dead.
    return err?.code === "EPERM";
  }
}

/**
 * Try to take the workspace lock once. Never throws, never waits.
 *
 * Returns `{ok, release, reason?, owner?}`; `release` is always callable so the
 * caller can use it unconditionally in a `finally`.
 */
export function acquireWorkspaceLock(cwd, { ttlMs = LOCK_TTL_MS, now = Date.now(), file = lockPath(cwd) } = {}) {
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
    owner = String(readFileSync(file, "utf8") || "").slice(0, 200);
    stale = now - stat.mtimeMs > ttlMs && !ownerAlive(owner);
  } catch {
    // The holder vanished between open and stat; retry once below.
    try {
      once();
      return { ok: true, file, nonce, release: () => release(file, nonce) };
    } catch { /* A new holder won the race. */ }
  }

  if (stale) {
    // Serialize stale recovery. Otherwise two reclaimers can both observe the
    // old file and one can unlink the other's newly-created lock.
    const recovery = `${file}.recovery`;
    let recoveryFd;
    try {
      try {
        recoveryFd = openSync(recovery, "wx");
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        // A process may be killed between creating and deleting this file.
        // Recover only after the same TTL and only when its owner is not alive.
        const recoveryStat = statSync(recovery);
        const recoveryOwner = String(readFileSync(recovery, "utf8") || "").slice(0, 200);
        if (now - recoveryStat.mtimeMs <= ttlMs || ownerAlive(recoveryOwner)) throw err;
        unlinkSync(recovery);
        recoveryFd = openSync(recovery, "wx");
      }
      writeSync(recoveryFd, payload);
      const stat = statSync(file);
      const current = String(readFileSync(file, "utf8") || "").slice(0, 200);
      if (now - stat.mtimeMs > ttlMs && !ownerAlive(current)) unlinkSync(file);
      once();
      return { ok: true, file, nonce, release: () => release(file, nonce) };
    } catch {
      // A live holder or another recovery wins; retry on a later event.
    } finally {
      if (recoveryFd !== undefined) {
        closeSync(recoveryFd);
        release(recovery, nonce);
      }
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
