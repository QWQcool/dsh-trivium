/**
 * p42 — consumer preference snapshots (E0).
 *
 * Covers: explicit scope, budget refusal without truncation, revision following,
 * update/withdraw, workspace/consumer binding checks, persona preservation, and
 * the digest contract. Reads only a temp workspace; no network, no model calls.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p42-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const rev = await import('../lib/revisions.js');
const prefs = await import('../lib/consumer-preferences.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try {
    fn();
    console.log('ok ' + label);
  } catch (e) {
    failures += 1;
    console.error('FAIL ' + label + ': ' + e.message);
  }
}

try {
  const ws = join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  const db = await store.openWorkspaceDb(ws);

  const style = store.insertNode(db, { type: 'preference', name: '视频口味', text: '技术视频更喜欢有实际演示。' });
  const oldPlan = store.insertNode(db, { type: 'decision', name: '教程范围', text: '只推荐入门教程。' });
  const seen = store.insertNode(db, { type: 'decision', name: '已看过的视频', text: '不要推荐已经看过的视频。' });
  const secretish = store.insertNode(db, { type: 'preference', name: 'token', text: 'api_key 是 sk-abcdef123456' });
  const stale = store.insertNode(db, { type: 'decision', name: '旧活动', text: '参与十月活动。', until: '2020-01-01' });
  const archived = store.insertNode(db, { type: 'decision', name: '作废约定', text: '每轮刷 50 条。' });
  store.archiveNode(db, archived);

  const binding = prefs.makeBinding({
    workspace: ws,
    consumer: 'bili-duty',
    purpose: 'video-curation',
    allow: [
      { ref: String(style), strength: 'soft' },
      { ref: String(oldPlan), strength: 'hard' },
      { ref: String(seen), strength: 'hard' },
      { ref: String(secretish), strength: 'soft' },
      { ref: String(stale), strength: 'hard' },
      { ref: String(archived), strength: 'soft' },
      { ref: 'ctx://does/not/exist', strength: 'soft' },
    ],
  });

  const first = prefs.buildSnapshot(db, binding);
  check(() => assert.equal(first.ok, true), 'export succeeds with approved scope');
  const facts = first.snapshot.facts;
  check(() => assert.equal(facts.length, 3), 'only exportable facts survive (3 of 7)');
  check(() => assert.ok(facts.every((f) => !/sk-/.test(f.text))), 'secret-looking fact is not exported');
  check(() => assert.ok(facts.every((f) => f.name !== '旧活动')), 'expired fact is not exported');
  check(() => assert.ok(facts.every((f) => f.name !== '作废约定')), 'archived fact is not exported');
  check(() => assert.equal(first.snapshot.skipped.length, 4), 'every skipped entry is reported');
  check(() => assert.ok(first.snapshot.blockTokens <= prefs.PREF_TOKEN_BUDGET), 'block stays inside the 300 token budget');
  check(() => assert.match(first.snapshot.block, /实际演示/), 'model block carries the approved text');
  check(() => assert.doesNotMatch(first.snapshot.block, /nodeId|contentHash|ctx:\/\/node\//), 'model block does not carry machine-layer ids');

  // digest is content-only: same facts -> same digest, new issue time -> new snapshot id
  const again = prefs.buildSnapshot(db, binding);
  check(() => assert.equal(again.snapshot.digest, first.snapshot.digest), 'same facts give the same digest');
  check(() => assert.notEqual(again.snapshot.snapshotId, first.snapshot.snapshotId), 'each run mints a new snapshot id');

  // budget refusal: many long facts must fail, not truncate
  const many = [];
  for (let i = 0; i < 8; i += 1) many.push({ ref: String(store.insertNode(db, { type: 'preference', name: '长偏好' + i, text: '这是一条很长的偏好说明'.repeat(6) + i })), strength: 'soft' });
  const fat = prefs.makeBinding({ workspace: ws, consumer: 'bili-duty', purpose: 'video-curation', allow: many });
  const overBudget = prefs.buildSnapshot(db, fat);
  check(() => assert.equal(overBudget.ok, false), 'over-budget export is refused');
  check(() => assert.equal(overBudget.code, prefs.PREF_CODES.budget), 'refusal names the budget code');
  check(() => assert.match(overBudget.message, /300/), 'refusal explains the limit');
  check(() => assert.ok(overBudget.preview && overBudget.preview.includes('这是一条很长的偏好说明')), 'refusal shows a preview, not a silent cut');

  // more than 8 approved entries is a binding error
  const tooMany = prefs.makeBinding({ workspace: ws, consumer: 'bili-duty', purpose: 'video-curation', allow: many.concat([{ ref: String(style) }]) });
  check(() => assert.equal(prefs.validateBinding(tooMany, { workspace: ws }).ok, false), 'binding over 8 entries is rejected');

  // update: successor replaces the old decision for the next task
  const newPlan = store.insertNode(db, { type: 'decision', name: '教程范围', text: '教程和实际演示都可以。' });
  const done = rev.supersede(db, { oldId: oldPlan, successorId: newPlan });
  check(() => assert.equal(done.ok, true), 'supersede lands');
  const afterUpdate = prefs.buildSnapshot(db, binding);
  check(() => assert.equal(afterUpdate.ok, true), 'export still succeeds after an update');
  check(() => assert.ok(afterUpdate.snapshot.facts.some((f) => f.text.includes('教程和实际演示都可以'))), 'new task sees the successor text');
  check(() => assert.ok(afterUpdate.snapshot.facts.every((f) => !f.text.includes('只推荐入门教程'))), 'old decision no longer appears as current');
  check(() => assert.notEqual(afterUpdate.snapshot.digest, first.snapshot.digest), 'digest changes with the content');
  check(() => assert.notEqual(afterUpdate.snapshot.sourceRevision, first.snapshot.sourceRevision), 'source revision changes with the store');

  // fork is not guessed. supersede() refuses a second successor, so build the fork
  // with a raw edge: currentHeadOf must report it instead of picking a branch.
  const f0 = store.insertNode(db, { type: 'decision', name: '分叉起点', text: '先按老办法。' });
  const f1 = store.insertNode(db, { type: 'decision', name: '分叉起点', text: '改成新办法甲。' });
  const f2 = store.insertNode(db, { type: 'decision', name: '分叉起点', text: '改成新办法乙。' });
  const firstEdge = rev.supersede(db, { oldId: f0, successorId: f1 });
  check(() => assert.equal(firstEdge.ok, true), 'fork fixture: first successor lands');
  store.ensureLink(db, f2, f0, 'supersedes');
  const forkBinding = prefs.makeBinding({ workspace: ws, consumer: 'bili-duty', purpose: 'video-curation', allow: [{ ref: String(f0), strength: 'hard' }] });
  const fork = prefs.buildSnapshot(db, forkBinding);
  const forkSkipped = fork.ok ? fork.snapshot.skipped : fork.skipped || [];
  check(() => assert.ok(forkSkipped.some((s) => s.reason === prefs.PREF_CODES.conflict)), 'a forked decision is reported as a conflict, not picked');
  check(() => assert.equal(fork.ok, false), 'a fork-only binding exports nothing');

  // scope checks
  const otherWs = join(root, 'other');
  mkdirSync(otherWs, { recursive: true });
  check(() => assert.equal(prefs.validateBinding(binding, { workspace: otherWs }).code, prefs.PREF_CODES.workspaceMismatch), 'binding is refused from another workspace');
  check(() => assert.equal(prefs.validateBinding(binding, { workspace: ws, consumer: 'other-consumer' }).code, prefs.PREF_CODES.consumerMismatch), 'binding is refused for another consumer');

  // files + persona
  const personaFile = join(root, 'persona.md');
  const personaText = '你是 B站 助手阿鲸。语气轻松，不刷屏。\n';
  writeFileSync(personaFile, personaText, 'utf8');
  const files = prefs.writeSnapshotFiles(ws, first.snapshot, { personaFile });
  const composed = readFileSync(files.personaFile, 'utf8');
  check(() => assert.equal(readFileSync(personaFile, 'utf8'), personaText), 'original persona file is untouched');
  check(() => assert.ok(composed.startsWith(personaText.trim().split('\n')[0]) === false && composed.includes('你是 B站 助手阿鲸')), 'composed file keeps the original persona');
  check(() => assert.ok(composed.includes('用户已确认的偏好')), 'composed file appends the preference block');
  const machine = JSON.parse(readFileSync(files.snapshotFile, 'utf8'));
  check(() => assert.equal(machine.schemaVersion, prefs.PREF_SCHEMA), 'machine layer declares the schema version');
  check(() => assert.equal(machine.facts.length, 3), 'machine layer lists the exported facts');
  check(() => assert.ok(machine.digest.startsWith('sha256:')), 'digest is an explicit sha256');

  // withdrawal must delete the shared text, not just stop refreshing
  const revoked = prefs.revokeFiles(ws, { personaFile });
  const revokedBlock = readFileSync(revoked.blockFile, 'utf8');
  const revokedComposed = readFileSync(revoked.personaFile, 'utf8');
  check(() => assert.doesNotMatch(revokedBlock, /实际演示/), 'revoked block contains no preference text');
  check(() => assert.doesNotMatch(revokedComposed, /实际演示/), 'revoked persona copy contains no preference text');
  check(() => assert.match(revokedComposed, /你是 B站 助手阿鲸/), 'revocation keeps the original persona');
  const revokedSnapshot = prefs.readSnapshot(ws);
  check(() => assert.equal(revokedSnapshot.status, 'revoked'), 'snapshot records the revocation');

  binding.status = 'revoked';
  check(() => assert.equal(prefs.validateBinding(binding, { workspace: ws }).code, prefs.PREF_CODES.bindingRevoked), 'revoked binding cannot export again');
} finally {
  try { store.closeAll(); } catch { /* read-only handles */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`P42: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
