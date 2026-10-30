/**
 * p47 — the consumer (or the user before a task) can check what is actually on disk.
 *
 * verifyFiles answers four questions without trusting the hosting process:
 * is this the snapshot that was approved (digest), for this consumer, still
 * unexpired, and does the text on disk still carry every approved fact?
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p47-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const prefs = await import('../lib/consumer-preferences.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}
const rowOf = (result, name) => result.checks.find((c) => c.name === name);

const ws = join(root, 'ws');
const persona = join(root, 'persona.md');
writeFileSync(persona, '你是「测试鲸」，只做只读筛选。\n', 'utf8');

try {
  const db = await store.openWorkspaceDb(ws);
  const a = store.insertNode(db, { type: 'preference', name: '口味', text: '偏爱有实拍的演示。' });
  const b = store.insertNode(db, { type: 'decision', name: '范围', text: '教程和演示都可以。' });
  const binding = prefs.makeBinding({ workspace: ws, consumer: 'bili-duty', purpose: 'video-curation', allow: [{ ref: String(a), strength: 'soft' }, { ref: String(b), strength: 'hard' }] });
  mkdirSync(prefs.dirFor(ws), { recursive: true });
  writeFileSync(prefs.bindingPath(ws), JSON.stringify(binding, null, 2) + '\n', 'utf8');
  const built = prefs.buildSnapshot(db, binding);
  assert.equal(built.ok, true);
  prefs.writeSnapshotFiles(ws, built.snapshot, { personaFile: persona });
  store.closeAll();

  // 1. a healthy export verifies
  const good = prefs.verifyFiles(ws, { personaFile: prefs.personaPath(ws) });
  check(() => assert.equal(good.ok, true, JSON.stringify(good.checks.filter((c) => !c.ok))), 'a healthy export verifies');
  check(() => assert.equal(rowOf(good, 'digest matches the machine layer').ok, true), 'digest is recomputed and matches');
  check(() => assert.equal(rowOf(good, 'consumer matches the binding').ok, true), 'consumer is checked against the binding');
  check(() => assert.equal(rowOf(good, 'every approved fact is in the block').ok, true), 'every fact is present in the block');

  // 2. an expired snapshot is refused, and can be inspected explicitly
  const late = new Date(Date.now() + 48 * 3600 * 1000);
  const expired = prefs.verifyFiles(ws, { now: late });
  check(() => assert.equal(expired.ok, false), 'an expired snapshot fails verification');
  check(() => assert.equal(rowOf(expired, 'not expired').ok, false), 'expiry names itself');
  const allowed = prefs.verifyFiles(ws, { now: late, allowExpired: true });
  check(() => assert.equal(rowOf(allowed, 'not expired').ok, true), '--allow-expired is explicit, not silent');

  // 3. tampering with the block is caught
  writeFileSync(prefs.blockPath(ws), '假的偏好\n', 'utf8');
  const tamperedBlock = prefs.verifyFiles(ws);
  check(() => assert.equal(tamperedBlock.ok, false), 'a tampered block fails');
  check(() => assert.equal(rowOf(tamperedBlock, 'every approved fact is in the block').ok, false), 'the missing fact is named');

  // restore, then tamper with the digest instead
  writeFileSync(prefs.blockPath(ws), built.snapshot.block + '\n', 'utf8');
  const snapshot = JSON.parse(JSON.stringify(prefs.readSnapshot(ws)));
  const original = snapshot.digest;
  snapshot.digest = 'sha256:deadbeef';
  writeFileSync(prefs.snapshotPath(ws), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  const badDigest = prefs.verifyFiles(ws);
  check(() => assert.equal(rowOf(badDigest, 'digest matches the machine layer').ok, false), 'a forged digest fails');
  snapshot.digest = original;
  writeFileSync(prefs.snapshotPath(ws), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  check(() => assert.equal(prefs.verifyFiles(ws).ok, true), 'restoring the digest restores the verdict');

  // 4. a revoked binding is refused even if the block still looks fine
  const revoked = JSON.parse(JSON.stringify(binding));
  revoked.status = 'revoked';
  writeFileSync(prefs.bindingPath(ws), JSON.stringify(revoked, null, 2) + '\n', 'utf8');
  const refused = prefs.verifyFiles(ws);
  check(() => assert.equal(rowOf(refused, 'binding is active').ok, false), 'a revoked binding fails');
  writeFileSync(prefs.bindingPath(ws), JSON.stringify(binding, null, 2) + '\n', 'utf8');

  // 5. the consumer file must still carry the block
  writeFileSync(prefs.personaPath(ws), '只剩人设，没有偏好。\n', 'utf8');
  const lostBlock = prefs.verifyFiles(ws, { personaFile: prefs.personaPath(ws) });
  check(() => assert.equal(rowOf(lostBlock, 'consumer file carries the block').ok, false), 'a consumer file without the block fails');
  prefs.writeSnapshotFiles(ws, built.snapshot, { personaFile: persona });

  // 6. the CLI exposes the same verdict through its exit code
  const cli = (args) => spawnSync(process.execPath, [resolve(import.meta.dirname, 'prefs-export.mjs'), ...args], { encoding: 'utf8', env: process.env });
  const okRun = cli(['verify', '--workspace', ws, '--persona', prefs.personaPath(ws)]);
  check(() => assert.equal(okRun.status, 0), `verify exits 0 on a healthy export (got ${okRun.status})`);
  check(() => assert.match(okRun.stdout, /"ok": true/), 'verify prints a machine-readable verdict');
  writeFileSync(prefs.blockPath(ws), '假的偏好\n', 'utf8');
  const badRun = cli(['verify', '--workspace', ws]);
  check(() => assert.equal(badRun.status, 3), `verify exits 3 on failure (got ${badRun.status})`);
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P47: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
