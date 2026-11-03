/**
 * p76 — B5 stuck detection and self-healing (S0-4).
 *
 * Covers:
 *   1. raceWithTimeout: a run that never returns is reported as timed out after
 *      the budget, a normal run and a throwing run keep their own shape, and a
 *      late rejection is absorbed instead of becoming an unhandled rejection;
 *   2. createStuckMonitor: one row per kind per session, `recovered` only after
 *      a matching `stuck`, afterMs recorded, status carries both;
 *   3. a real change log round-trip: stuck -> recovered rows, and the log seeds
 *      the next session so a *later* process closes a row opened by an earlier
 *      one;
 *   4. staleLockInfo: missing / fresh / dead owner / live owner / corrupt file;
 *   5. the lock TTL default is unchanged.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p76-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const plugin = await import('../lib/index.js');
const log = await import('../lib/change-log.js');
const locks = await import('../lib/workspace-lock.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

try {
  // 1) Timeout race. A fake timer fires synchronously, so "30 seconds" costs
  // nothing and the test stays deterministic.
  const never = new Promise(() => {});
  const timed = await plugin.raceWithTimeout(never, 30_000, {
    setTimer: (fn) => { fn(); return 1; },
    clearTimer: () => {},
  });
  await check(() => assert.equal(timed.timedOut, true), 'a run that never returns is reported as timed out');
  await check(() => assert.equal(plugin.EXTRACT_TIMEOUT_MS, 30_000), 'the extraction budget is 30 seconds');
  const fine = await plugin.raceWithTimeout(Promise.resolve({ applied: [] }), 30_000, { setTimer: () => 1, clearTimer: () => {} });
  await check(() => {
    assert.equal(fine.timedOut, false);
    assert.deepEqual(fine.value, { applied: [] });
  }, 'a normal run keeps its value');
  const broken = await plugin.raceWithTimeout(Promise.reject(new Error('boom')), 30_000, { setTimer: () => 1, clearTimer: () => {} });
  await check(() => assert.equal(broken.error.message, 'boom'), 'a throwing run keeps its error instead of looking like a timeout');
  await check(async () => {
    let rejected = false;
    process.once('unhandledRejection', () => { rejected = true; });
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 5));
    await plugin.raceWithTimeout(late, 1, { setTimer: (fn) => setTimeout(fn, 1), clearTimer: (id) => clearTimeout(id) });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rejected, false);
  }, 'a rejection that arrives after the timeout is absorbed');

  // 2) The monitor itself.
  const status = {};
  const rows = [];
  let clock = Date.parse('2026-11-02T10:00:00.000Z');
  const monitor = plugin.createStuckMonitor({
    cwd: join(root, 'ws-monitor'),
    sessionId: 'sess-76',
    status,
    record: (row) => rows.push(row),
    now: () => new Date(clock),
  });
  await check(() => assert.equal(monitor.mark('extract-timeout', '>30000ms'), true), 'the first stuck mark is accepted');
  await check(() => assert.equal(status.stuck.kind, 'extract-timeout'), 'status carries the stuck kind');
  await check(() => assert.equal(status.stuck.sessionId, 'sess-76'), 'status says which session is stuck');
  await check(() => assert.equal(rows.filter((row) => row.reason === log.CHANGE_REASONS.stuck).length, 1), 'one stuck row is written');
  await check(() => assert.equal(monitor.mark('extract-timeout', 'again'), false), 'the same kind is recorded once per session');
  await check(() => assert.equal(rows.filter((row) => row.reason === log.CHANGE_REASONS.stuck).length, 1), 'the second mark writes nothing');
  await check(() => assert.equal(monitor.recover('lock-stale'), false), 'recovering a kind that was never open writes nothing');
  clock += 5000;
  await check(() => assert.equal(monitor.recover('extract-timeout', 'next run succeeded'), true), 'a successful run recovers the open kind');
  await check(() => assert.equal(status.recovered.kind, 'extract-timeout'), 'status carries the recovered kind');
  await check(() => assert.equal(status.recovered.afterMs, 5000), 'the recovery records how long it was stuck');
  await check(() => assert.deepEqual(status.recovered.open, []), 'the open set is empty after recovery');
  await check(
    () => assert.equal(rows.filter((row) => row.reason === log.CHANGE_REASONS.recovered).length, 1),
    'exactly one recovered row is written',
  );
  await check(() => assert.notEqual(rows[0].opId, rows[rows.length - 1].opId), 'stuck and recovered rows have different opIds');
  await check(() => assert.equal(log.CHANGE_LABELS.stuck.zh, '卡住'), 'the stuck reason has a bilingual label');
  await check(() => assert.equal(log.CHANGE_LABELS.recovered.zh, '已自愈'), 'the recovered reason has a bilingual label');

  // 3) Change-log round trip + seeding for the next session.
  const ws = join(root, 'ws-log');
  mkdirSync(join(ws, '.dsh'), { recursive: true });
  const real = plugin.createStuckMonitor({
    cwd: ws,
    sessionId: 'sess-a',
    status: {},
    record: (row) => log.noteChanges(ws, [row]),
    now: () => new Date('2026-11-02T11:00:00.000Z'),
  });
  real.mark(plugin.STUCK_KINDS.replayTimeout, '>8000ms');
  real.mark(plugin.STUCK_KINDS.lockStale, 'age=120s pid=4242');
  await check(() => {
    const entries = log.readChanges(ws, { limit: 20 }).entries;
    assert.equal(entries.filter((row) => row.reason === 'stuck').length, 2);
  }, 'the change log really receives both stuck rows');
  await check(() => {
    const kinds = plugin.openStuckKinds(log.readChanges(ws, { limit: 20 }).entries);
    assert.deepEqual(kinds.sort(), [plugin.STUCK_KINDS.lockStale, plugin.STUCK_KINDS.replayTimeout].sort());
  }, 'the log says both kinds are still open');

  const nextStatus = {};
  const next = plugin.createStuckMonitor({ cwd: ws, sessionId: 'sess-b', status: nextStatus, record: (row) => log.noteChanges(ws, [row]), now: () => new Date('2026-11-02T12:00:00.000Z') });
  await check(() => {
    next.seed(plugin.openStuckKinds(log.readChanges(ws, { limit: 20 }).entries));
    assert.equal(nextStatus.stuck.kind, plugin.STUCK_KINDS.lockStale);
    assert.equal(nextStatus.stuck.detail, 'seeded from change log');
  }, 'a later session inherits the open kinds from the log');
  await check(() => assert.equal(next.recover(plugin.STUCK_KINDS.lockStale, 'lock reclaimed'), true), 'the later session can close an inherited kind');
  await check(() => assert.equal(next.recover(plugin.STUCK_KINDS.lockStale), false), 'closing it twice is a no-op');
  await check(() => {
    const kinds = plugin.openStuckKinds(log.readChanges(ws, { limit: 20 }).entries);
    assert.deepEqual(kinds, [plugin.STUCK_KINDS.replayTimeout]);
  }, 'the newest row per kind decides what is still open');

  // 4) Lock staleness probe.
  const lockDir = join(root, 'ws-lock');
  mkdirSync(join(lockDir, '.dsh'), { recursive: true });
  const lockFile = locks.lockPath(lockDir);
  const now = Date.parse('2026-11-02T13:00:00.000Z');
  /* Write first, then stamp the mtime: writeFileSync resets it to the wall clock,
     which would make "old" depend on the day the suite happens to run. */
  const stampLock = (body, mtime) => {
    writeFileSync(lockFile, body);
    utimesSync(lockFile, new Date(mtime), new Date(mtime));
  };
  await check(() => assert.equal(plugin.staleLockInfo(lockDir, { now }), null), 'no lock file means nothing to say');
  stampLock(JSON.stringify({ pid: process.pid, nonce: 'n', at: 'x' }), Date.now());
  await check(() => assert.equal(plugin.staleLockInfo(lockDir, { now: Date.now() }).stale, false), 'a fresh lock is never stale');
  const old = now - locks.LOCK_TTL_MS - 1000;
  stampLock(JSON.stringify({ pid: process.pid, nonce: 'n', at: 'x' }), old);
  await check(() => {
    const info = plugin.staleLockInfo(lockDir, { now: now + 120_000 });
    assert.equal(info.stale, false, 'the live owner (this process) keeps the lock valid');
    assert.equal(info.alive, true);
  }, 'an old lock held by a live process is not stale');
  await check(() => {
    stampLock(JSON.stringify({ pid: 999_999, nonce: 'n', at: 'x' }), old);
    const info = plugin.staleLockInfo(lockDir, { now });
    assert.equal(info.stale, true);
    assert.equal(info.pid, 999_999);
    assert.equal(info.alive, false);
  }, 'an old lock whose owner is gone is stale');
  await check(() => {
    stampLock('{not json', old);
    assert.equal(plugin.staleLockInfo(lockDir, { now }).stale, true);
  }, 'an unreadable lock file counts as a dead owner');
  await check(() => assert.equal(locks.LOCK_TTL_MS, 30_000), 'the lock TTL default is untouched');
  await check(async () => {
    const info = plugin.staleLockInfo(lockDir, { now });
    const { acquireWorkspaceLock } = locks;
    stampLock(JSON.stringify({ pid: 999_999, nonce: 'old', at: 'x' }), old);
    const taken = acquireWorkspaceLock(lockDir, { now });
    assert.equal(taken.ok, true);
    taken.release();
    return info;
  }, 'the existing reclaim path still takes a stale lock');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P76: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
