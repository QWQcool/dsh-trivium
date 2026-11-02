/**
 * p64 — a merge keeps the body it replaces (option B: node-level history).
 *
 * Zep closes a validity window rather than deleting; Mem0 writes old_memory /
 * new_memory into a side table. Here the node keeps its last three bodies, so
 * "what did this say before" survives without a schema migration and without
 * copying anything that would be refused today.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p64-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const base = (text, extra = {}) => ({
  type: 'decision',
  name: '上线方案',
  text,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  source: { role: 'user', seq: 3, messageId: 'm-3' },
  ...extra,
});

try {
  // 1. the replaced body is kept, with the time it was written
  const merged = store.mergePayload(base('按方案 A 走'), base('按方案 A 走，随后改 B'));
  check(() => assert.equal(merged.text, '按方案 A 走，随后改 B'), 'the live text is the new one');
  check(() => assert.equal(merged.history?.length, 1), 'one previous body is kept');
  check(() => assert.equal(merged.history[0].text, '按方案 A 走'), 'the previous body is the old text');
  check(() => assert.equal(merged.history[0].at, '2026-11-01T09:00:00.000Z'), 'the previous body keeps its own timestamp');
  check(() => assert.equal(merged.history[0].source?.seq, 3), 'the previous body keeps its source locator');

  // 2. several merges stack newest-first and stop at three
  let node = base('v1');
  for (const next of ['v2', 'v3', 'v4', 'v5']) node = store.mergePayload(node, base(next));
  check(() => assert.equal(node.text, 'v5'), 'the live text follows the newest merge');
  check(() => assert.equal(node.history.length, store.MAX_MERGE_HISTORY), 'history is capped');
  check(() => assert.deepEqual(node.history.map((row) => row.text), ['v4', 'v3', 'v2']), 'the newest replaced body comes first');

  // 3. an identical merge adds nothing
  const same = store.mergePayload(base('没变化'), base('没变化'));
  check(() => assert.equal(same.history, undefined), 'merging identical text records no history');

  // 4. a body that would be refused today is not copied back in
  // The merge keeps the longer body, so the incoming text must be the longer one
  // for the credential-shaped body to be the one that gets replaced.
  const secret = store.mergePayload(
    base('部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    base('部署已经改用 KMS 托管，原来那个密钥不再使用，等待完成轮换后再清理旧配置，这条只记录运维结论'),
  );
  check(() => assert.equal(secret.history?.[0]?.text, '<redacted>'), 'a credential-shaped previous body is redacted');
  check(() => assert.doesNotMatch(JSON.stringify(secret.history), /ghp_/), 'the credential never reaches history');

  // 5. it survives a real write, and a replacement (which never merges) has none
  const db = await store.openWorkspaceDb(join(root, 'ws'));
  const id = store.insertNode(db, { type: 'decision', name: '发布窗口', text: '发布窗口是周五' });
  store.mergeInto(db, id, { type: 'decision', name: '发布窗口', text: '发布窗口是周五下午' });
  const stored = db.get(id)?.payload || {};
  check(() => assert.equal(stored.text, '发布窗口是周五下午'), 'the merge updated the stored body');
  check(() => assert.equal(stored.history?.[0]?.text, '发布窗口是周五'), 'the stored node kept the previous body');
  const fresh = store.insertNode(db, { type: 'decision', name: '新决定', text: '改用方案 B' });
  check(() => assert.equal(db.get(fresh)?.payload?.history, undefined), 'a new node has no history');

  // 6. the panel can show it without a second request
  const rows = store.listNodes(db, {});
  const mergedRow = rows.find((row) => row.id === Number(id));
  check(() => assert.equal(mergedRow?.history?.[0]?.text, '发布窗口是周五'), 'the node list exposes the previous body');
  check(() => assert.equal(mergedRow?.historyCount, 1), 'the node list counts the previous bodies');
  const plainRow = rows.find((row) => row.id === Number(fresh));
  check(() => assert.equal(plainRow?.historyCount, 0), 'an unmerged node reports zero');
  store.closeAll();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P64: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
