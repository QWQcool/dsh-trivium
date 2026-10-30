/**
 * p43 — a tool-driving sentence must not swallow the fact in the same turn.
 *
 * Regression for the R3 F1 finding: `distillableTurns()` used to drop the whole
 * user turn when it matched a tool-driving cue, so "按顺序调用工具，生产端口是 9443。"
 * was consumed without rule extraction, model extraction, or pending retention.
 *
 * Direction of the fix: only a turn whose EVERY sentence is a pure operation
 * instruction may be dropped. Anything that cannot be proven empty goes to the
 * existing extraction path. Over-calling is acceptable; losing a fact is not.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p43-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}
const callOf = (text) => extract.shouldExtractBatch([{ role: 'user', text }]);

try {
  // 1. the reported failure: cue sentence plus a real fact in the same turn
  for (const text of [
    '按顺序调用工具，生产端口是 9443。',
    '只用 ctx_find，负责人是张三。',
    '贴工具原文：预算上限改成 5000 元。',
    '按顺序调用工具。生产端口是 9443。',
    '只用 ctx_read 读一下，别再推荐看过的视频。',
  ]) {
    check(() => assert.equal(callOf(text).call, true), 'mixed tool cue keeps the fact: ' + text);
  }

  // 2. a fact that only looks numeric must survive too
  check(() => assert.equal(callOf('按顺序调用工具，重试次数改为 5 次。').call, true), 'count fact survives the cue');

  // 3. a genuinely pure operation instruction may still be skipped
  for (const text of ['只用 ctx_find。', '按顺序调用工具。', '贴工具原文']) {
    check(() => assert.equal(callOf(text).call, false), 'pure operation wording may skip: ' + text);
  }

  // 4. whole-window rule still holds: a pure operation user turn + assistant fact
  check(
    () => assert.equal(extract.shouldExtractBatch([{ role: 'user', text: '按顺序调用工具。' }, { role: 'assistant', text: '采用方案 CedarPlan，发布前需要执行验收。' }]).call, true),
    'assistant fact still opens the window',
  );

  // 5. rule extraction sees the fact, not just the gate
  const rule = extract.ruleCandidates([{ role: 'user', text: '记住：按顺序调用工具，视频偏好是有实拍演示。' }]);
  check(() => assert.equal(rule.length >= 1, true), 'rule candidate still produced for a mixed turn');

  // 6. end to end: the model is actually asked, and the prompt carries the fact
  const cwd = join(root, 'ws');
  const db = await store.openWorkspaceDb(cwd);
  let prompt = '';
  const result = await extract.distill({
    db,
    turns: [{ role: 'user', text: '按顺序调用工具，生产端口是 9443。' }],
    sessionId: 'p43',
    llmCall: async (p) => {
      prompt = p;
      return JSON.stringify({ candidates: [{ type: 'decision', name: '生产端口', text: '生产端口是 9443。' }] });
    },
  });
  check(() => assert.match(prompt, /生产端口是 9443/), 'extraction prompt carries the fact text');
  check(() => assert.equal(result.gate.skipped, false), 'gate does not report a skip for a mixed turn');
  check(() => assert.equal(result.applied.length, 1), 'extracted fact is applied to the database');
  check(() => assert.equal(result.llmFailed, false), 'no extraction failure');

  // 7. and it is visible to a later session
  const hits = db.allNodeIds().map((id) => db.get(id)?.payload).filter((p) => String(p?.text || '').includes('9443'));
  check(() => assert.equal(hits.length >= 1, true), 'fact is readable back from the workspace database');

  // 8. the pending window is not consumed when the only content is operation wording
  const empty = await extract.distill({ db, turns: [{ role: 'user', text: '只用 ctx_find。' }], sessionId: 'p43', llmCall: async () => { throw new Error('must not be called'); } });
  check(() => assert.equal(empty.applied.length, 0), 'pure operation turn applies nothing');
  store.closeAll();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P43: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
