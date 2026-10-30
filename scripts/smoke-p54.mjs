/**
 * p54 (F-W05 A) — one writer per workspace, and the loser never waits.
 *
 * Two host processes on the same workspace used to replay the same pending
 * snapshot and write the fact twice (W5 measured copies=2). The lock is taken for
 * the extraction run only; a process that cannot take it keeps the window pending
 * and records `lock-busy` instead of blocking behind a model call.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p54-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const lockMod = await import('../lib/workspace-lock.js');
const logMod = await import('../lib/change-log.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
try {
  // 1. first taker wins, second is told busy without waiting
  const first = lockMod.acquireWorkspaceLock(ws);
  check(() => assert.equal(first.ok, true), 'the first process takes the lock');
  check(() => assert.ok(existsSync(lockMod.lockPath(ws))), 'the lock file exists while held');
  const startedAt = Date.now();
  const second = lockMod.acquireWorkspaceLock(ws);
  check(() => assert.equal(second.ok, false), 'the second process does not get the lock');
  check(() => assert.equal(second.reason, 'busy'), 'the second process is told it is busy');
  check(() => assert.ok(Date.now() - startedAt < 200), 'taking the lock never waits');
  check(() => assert.match(String(second.owner || ''), /pid/), 'the holder is described without failing');

  // 2. release is idempotent and removes the file
  first.release();
  check(() => assert.equal(existsSync(lockMod.lockPath(ws)), false), 'release removes the lock file');
  first.release();
  check(() => assert.equal(existsSync(lockMod.lockPath(ws)), false), 'a second release is harmless');

  // 3. a crashed holder is recovered after the TTL
  writeFileSync(lockMod.lockPath(ws), JSON.stringify({ pid: 999999, nonce: 'dead', at: '2026-10-30T00:00:00.000Z' }), 'utf8');
  const old = new Date(Date.now() - lockMod.LOCK_TTL_MS - 5000);
  utimesSync(lockMod.lockPath(ws), old, old);
  const recovered = lockMod.acquireWorkspaceLock(ws);
  check(() => assert.equal(recovered.ok, true), 'a lock older than the TTL is taken over');
  recovered.release();

  // 4. a live lock is not stolen just because it is old-ish
  writeFileSync(lockMod.lockPath(ws), JSON.stringify({ pid: process.pid, nonce: 'fresh' }), 'utf8');
  const notStale = lockMod.acquireWorkspaceLock(ws, { ttlMs: lockMod.LOCK_TTL_MS });
  check(() => assert.equal(notStale.ok, false), 'a fresh lock is respected');
  rmSync(lockMod.lockPath(ws), { force: true });

  // 5. releasing must not delete somebody else's lock
  const mine = lockMod.acquireWorkspaceLock(ws);
  writeFileSync(lockMod.lockPath(ws), JSON.stringify({ pid: 4242, nonce: 'someone-else' }), 'utf8');
  const released = mine.release();
  check(() => assert.equal(released, false), 'release refuses a lock it no longer owns');
  check(() => assert.equal(existsSync(lockMod.lockPath(ws)), true), 'the other holder keeps its lock');
  rmSync(lockMod.lockPath(ws), { force: true });

  // 6. the audit knows the new outcome and can display it
  check(() => assert.equal(logMod.CHANGE_REASONS.lockBusy, 'lock-busy'), 'the reason code exists');
  check(() => assert.ok(logMod.CHANGE_LABELS['lock-busy']?.en && logMod.CHANGE_LABELS['lock-busy']?.zh), 'the reason has bilingual labels');
  logMod.noteChanges(ws, [{ reason: logMod.CHANGE_REASONS.lockBusy, opId: 's1:lock:1', detail: 'busy' }]);
  const rows = logMod.readChanges(ws);
  check(() => assert.equal(rows.entries[0].reason, 'lock-busy'), 'a busy outcome is recorded, not dropped');

  // 7. a lock file left behind does not block a later run forever
  writeFileSync(lockMod.lockPath(ws), JSON.stringify({ pid: 1, nonce: 'x' }), 'utf8');
  utimesSync(lockMod.lockPath(ws), old, old);
  const later = lockMod.acquireWorkspaceLock(ws);
  check(() => assert.equal(later.ok, true), 'a leftover lock is eventually reclaimed');
  check(() => assert.match(readFileSync(lockMod.lockPath(ws), 'utf8'), new RegExp(String(process.pid))), 'the new holder owns the file');
  later.release();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P54: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
